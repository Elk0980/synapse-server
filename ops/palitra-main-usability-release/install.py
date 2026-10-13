#!/usr/bin/env python3
"""Guarded, dependency-free installation of the Palitra 36/38 code package.

No shell, service restart, network request, data-file write or permission change
outside the listed code files. Root remains responsible for ownership and runtime.
"""
import argparse
import hashlib
import json
import os
import re
import stat
import sys
import tempfile
from pathlib import Path, PurePosixPath

ALLOWLIST = {
    "sites/synapse/cabinet/palitra-photo-model.js": "static",
    "sites/synapse/price-editor-palitra.html": "static",
    "sites/synapse/cabinet/site-photos.html": "static",
    "sites/synapse/cabinet/palitra-editor.html": "static",
}
SHA = re.compile(r"^[0-9a-f]{64}$")
PACKAGE_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")
STATES = {"pending", "installing", "installed", "restoring", "restored"}


class Refused(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(data):
    return json.dumps(data, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def relative(value):
    require(isinstance(value, str) and value and "\\" not in value
            and ":" not in value and not any(ord(c) < 32 for c in value),
            "Unsafe relative path")
    path = PurePosixPath(value)
    require(not path.is_absolute() and value == path.as_posix()
            and all(part not in {"", ".", ".."} for part in value.split("/")),
            "Non-canonical relative path: " + value)
    return path


def safe_chain(path):
    """Reject symlinks and Windows reparse points, including existing ancestors."""
    path = Path(path).absolute()
    for candidate in [*reversed(path.parents), path]:
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            continue
        require(not stat.S_ISLNK(info.st_mode)
                and not (getattr(info, "st_file_attributes", 0) & 0x400),
                "Symlink/reparse point refused: " + str(candidate))
        if candidate != path:
            require(stat.S_ISDIR(info.st_mode), "Ancestor is not a directory")
    return path


def contained(base, name):
    rel = relative(name)
    target = safe_chain(base.joinpath(*rel.parts))
    require(target.resolve(strict=False).is_relative_to(base.resolve()),
            "Path escapes its root")
    return target


def current_hash(path):
    safe_chain(path)
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    require(stat.S_ISREG(info.st_mode), "Target is not a regular file: " + str(path))
    return digest(path.read_bytes())


def read_json(path):
    safe_chain(path)
    require(path.is_file(), "Missing JSON file: " + str(path))
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate JSON key: " + key)
            result[key] = value
        return result
    try:
        return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    except (ValueError, UnicodeError) as exc:
        raise Refused("Invalid UTF-8 JSON: " + str(path)) from exc


def fsync_dir(path):
    # Windows does not provide portable directory fsync. File fsync and atomic
    # replacement still apply there; Linux server additionally syncs directories.
    if os.name != "nt":
        descriptor = os.open(str(path), os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def ensure_directory(path):
    safe_chain(path)
    path.mkdir(parents=True, exist_ok=True)
    safe_chain(path)
    require(path.is_dir(), "Not a directory: " + str(path))


def atomic_bytes(path, data, mode):
    safe_chain(path)
    ensure_directory(path.parent)
    handle, temporary = tempfile.mkstemp(prefix=".palitra-stage-", dir=str(path.parent))
    temporary = Path(temporary)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        safe_chain(path)
        os.replace(temporary, path)
        fsync_dir(path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()


def save_receipt(path, receipt):
    atomic_bytes(path, json.dumps(receipt, ensure_ascii=False, indent=2,
                                 sort_keys=True).encode("utf-8") + b"\n", 0o600)


class Package:
    def __init__(self, manifest_path, root, backup_dir):
        require(Path(root).is_absolute() and Path(backup_dir).is_absolute(),
                "--root and --backup-dir must be explicit absolute paths")
        self.manifest_path = safe_chain(Path(manifest_path).absolute())
        self.package_dir = safe_chain(self.manifest_path.parent)
        self.payload_dir = safe_chain(self.package_dir / "payload")
        self.root = safe_chain(Path(root).absolute())
        self.backup_dir = safe_chain(Path(backup_dir).absolute())
        require(self.root.is_dir(), "--root must be an existing directory")
        require(not self.backup_dir.resolve(strict=False).is_relative_to(self.root.resolve()),
                "--backup-dir must be outside --root")
        require(not self.backup_dir.resolve(strict=False).is_relative_to(self.package_dir.resolve()),
                "--backup-dir must be outside package directory")
        self.manifest = read_json(self.manifest_path)
        require(isinstance(self.manifest, dict)
                and set(self.manifest) == {"schema", "package_id", "targets"}
                and type(self.manifest["schema"]) is int
                and self.manifest["schema"] == 1, "Unsupported manifest schema")
        self.package_id = self.manifest["package_id"]
        require(isinstance(self.package_id, str) and PACKAGE_ID.fullmatch(self.package_id),
                "Invalid package_id")
        require(isinstance(self.manifest["targets"], list) and self.manifest["targets"],
                "Manifest has no approved targets")
        self.targets = self.manifest["targets"]
        seen = set()
        for entry in self.targets:
            require(isinstance(entry, dict) and set(entry) ==
                    {"group", "target", "source", "base_sha256", "sha256"},
                    "Invalid target entry")
            name = entry["target"]
            relative(name)
            require(name in ALLOWLIST and ALLOWLIST[name] == entry["group"],
                    "Target/group outside allowlist: " + name)
            require(name.casefold() not in seen, "Duplicate target: " + name)
            seen.add(name.casefold())
            source = relative(entry["source"])
            require(source.parts[0] == "payload" and len(source.parts) > 1,
                    "Source must be contained in payload/")
            require(isinstance(entry["sha256"], str) and SHA.fullmatch(entry["sha256"]),
                    "Invalid payload SHA256")
            require(entry["base_sha256"] is None or
                    (isinstance(entry["base_sha256"], str)
                     and SHA.fullmatch(entry["base_sha256"])), "Invalid base SHA256")
            require(entry["base_sha256"] != entry["sha256"], "No-op target refused")
        self.fingerprint = digest(canonical(self.manifest))
        self.package_backup = contained(self.backup_dir, self.package_id)
        resolved_backup = self.package_backup.resolve(strict=False)
        for protected in (self.root.resolve(), self.package_dir.resolve()):
            require(not resolved_backup.is_relative_to(protected)
                    and not protected.is_relative_to(resolved_backup),
                    "Package backup overlaps installation root/package")
        self.data = {}

    def target_path(self, entry):
        return contained(self.root, entry["target"])

    def receipt_path(self, group):
        return contained(self.package_backup, group + "/manifest.json")

    def entries_for(self, group):
        return [entry for entry in self.targets if entry["group"] == group]

    def payload_check(self):
        self.data = {}
        for entry in self.targets:
            path = contained(self.package_dir, entry["source"])
            require(path.resolve().is_relative_to(self.payload_dir.resolve()),
                    "Payload source escaped payload/")
            require(path.is_file(), "Missing payload: " + entry["source"])
            data = path.read_bytes()
            require(digest(data) == entry["sha256"], "Payload SHA mismatch: " + entry["source"])
            self.data[entry["target"]] = data

    def receipt_check(self, group, allowed_status=None):
        path = self.receipt_path(group)
        receipt = read_json(path)
        require(isinstance(receipt, dict) and type(receipt.get("schema")) is int
                and receipt.get("schema") == 1
                and receipt.get("package_id") == self.package_id
                and receipt.get("manifest_sha256") == self.fingerprint
                and receipt.get("root") == str(self.root.resolve())
                and receipt.get("group") == group, "Receipt does not belong to this package/root")
        if allowed_status:
            require(receipt.get("status") in allowed_status,
                    "Receipt state refused: " + str(receipt.get("status")))
        entries = receipt.get("entries")
        approved = self.entries_for(group)
        require(isinstance(entries, list) and len(entries) == len(approved),
                "Receipt target set mismatch")
        for saved, entry in zip(entries, approved):
            require(isinstance(saved, dict) and saved.get("target") == entry["target"]
                    and saved.get("base_sha256") == entry["base_sha256"]
                    and saved.get("sha256") == entry["sha256"]
                    and saved.get("original_present") == (entry["base_sha256"] is not None)
                    and saved.get("backup") == "originals/" + entry["target"]
                    and saved.get("state") in STATES
                    and isinstance(saved.get("backup_ready"), bool), "Receipt entry mismatch")
            mode = saved.get("mode")
            require(isinstance(mode, int) and not isinstance(mode, bool)
                    and 0 <= mode <= 0o7777, "Invalid saved file mode")
            if saved["backup_ready"] and saved["original_present"]:
                original = contained(path.parent, saved["backup"])
                require(current_hash(original) == entry["base_sha256"],
                        "Original backup SHA mismatch: " + entry["target"])
            if receipt.get("status") == "applied":
                require(saved["backup_ready"] and saved["state"] == "installed",
                        "Incomplete applied receipt")
        return receipt

    def preflight(self):
        """Read all payloads, receipts and all targets before any mutation."""
        self.payload_check()
        applied = {}
        for group in ("backend", "static"):
            receipt_path = self.receipt_path(group)
            if receipt_path.exists():
                receipt = self.receipt_check(group, {"applied"})
                applied[group] = receipt
            elif receipt_path.parent.exists():
                raise Refused("Existing group directory without completed own receipt: " + group)
        plan = []
        for entry in self.targets:
            expected = entry["sha256"] if entry["group"] in applied else entry["base_sha256"]
            path = self.target_path(entry)
            actual = current_hash(path)
            require(actual == expected, "Current base/installed SHA mismatch: " + entry["target"])
            plan.append({"target": entry["target"], "group": entry["group"],
                         "current_sha256": actual, "after_sha256": entry["sha256"],
                         "already_applied": entry["group"] in applied})
        return plan, applied

    def acquire_lock(self):
        ensure_directory(self.package_backup)
        lock = contained(self.package_backup, ".operation.lock")
        try:
            descriptor = os.open(str(lock), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError as exc:
            raise Refused("Another/unfinished own operation holds .operation.lock; inspect it first") from exc
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(("pid=" + str(os.getpid()) + "\n").encode("ascii"))
            stream.flush()
            os.fsync(stream.fileno())
        fsync_dir(lock.parent)
        return lock

    def apply(self, group):
        require(self.entries_for(group), "Package has no targets for group")
        _, applied = self.preflight()
        require(group not in applied, "Duplicate apply refused: " + group)
        require(group != "static" or not self.entries_for("backend") or "backend" in applied,
                "Static apply requires the completed own backend first")
        lock = self.acquire_lock()
        receipt = None
        receipt_path = self.receipt_path(group)
        try:
            # Recheck under the lock. Exclusive creation prevents duplicate apply.
            _, applied = self.preflight()
            require(group not in applied, "Duplicate apply refused: " + group)
            require(group != "static" or not self.entries_for("backend") or "backend" in applied,
                    "Static apply requires the completed own backend first")
            require(not receipt_path.parent.exists(), "Group backup already exists")
            receipt_path.parent.mkdir()
            fsync_dir(receipt_path.parent.parent)
            entries = []
            for entry in self.entries_for(group):
                path = self.target_path(entry)
                mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o644
                entries.append({"target": entry["target"],
                                "base_sha256": entry["base_sha256"], "sha256": entry["sha256"],
                                "original_present": entry["base_sha256"] is not None,
                                "backup": "originals/" + entry["target"], "mode": mode,
                                "backup_ready": False, "state": "pending"})
            receipt = {"schema": 1, "package_id": self.package_id,
                       "manifest_sha256": self.fingerprint, "root": str(self.root.resolve()),
                       "group": group, "status": "preparing", "entries": entries}
            save_receipt(receipt_path, receipt)
            # Finish every original backup before touching the first target.
            for saved, entry in zip(entries, self.entries_for(group)):
                path = self.target_path(entry)
                require(current_hash(path) == entry["base_sha256"], "Base changed during backup")
                if saved["original_present"]:
                    original = contained(receipt_path.parent, saved["backup"])
                    atomic_bytes(original, path.read_bytes(), saved["mode"])
                    require(current_hash(original) == entry["base_sha256"], "Backup readback mismatch")
                saved["backup_ready"] = True
                save_receipt(receipt_path, receipt)
            # One last all-target freshness check before first target replacement.
            for entry in self.targets:
                expected = entry["sha256"] if entry["group"] in applied else entry["base_sha256"]
                require(current_hash(self.target_path(entry)) == expected,
                        "Target changed after preflight: " + entry["target"])
            receipt["status"] = "applying"
            save_receipt(receipt_path, receipt)
            for saved, entry in zip(entries, self.entries_for(group)):
                path = self.target_path(entry)
                require(current_hash(path) == entry["base_sha256"], "Base changed before replacement")
                saved["state"] = "installing"
                save_receipt(receipt_path, receipt)
                atomic_bytes(path, self.data[entry["target"]], saved["mode"])
                require(current_hash(path) == entry["sha256"], "Installed readback mismatch")
                saved["state"] = "installed"
                save_receipt(receipt_path, receipt)
            receipt["status"] = "applied"
            save_receipt(receipt_path, receipt)
        except Exception as exc:
            if receipt is not None:
                receipt["status"] = "partial"
                receipt["error"] = str(exc)
                try:
                    save_receipt(receipt_path, receipt)
                except Exception:
                    pass  # Existing journal still identifies pending/installing entries.
            raise
        finally:
            lock.unlink()
            fsync_dir(lock.parent)

    def rollback_plan(self, group):
        # Payload SHA is checked too; an altered release is not an own-package rollback.
        self.payload_check()
        if group == "backend":
            static_path = self.receipt_path("static")
            if static_path.exists():
                static_receipt = self.receipt_check("static", {"rolled_back"})
                for saved, entry in zip(static_receipt["entries"], self.entries_for("static")):
                    require(saved["state"] == "restored"
                            and current_hash(self.target_path(entry)) == entry["base_sha256"],
                            "Backend rollback requires every static target already restored")
            else:
                require(not static_path.parent.exists(),
                        "Unfinished static directory blocks backend rollback")
        receipt = self.receipt_check(group, {"applied", "partial", "preparing", "applying",
                                              "rollback_partial", "rolling_back"})
        changes = []
        for saved, entry in zip(receipt["entries"], self.entries_for(group)):
            actual = current_hash(self.target_path(entry))
            old = entry["base_sha256"]
            new = entry["sha256"]
            state = saved["state"]
            if state in {"pending", "restored"}:
                require(actual == old, "Rollback refused: untouched/restored target changed")
                restore = False
            elif state == "installed":
                require(actual == new, "Rollback refused: installed target externally changed")
                restore = True
            else:
                require(actual in {old, new}, "Rollback refused: interrupted target externally changed")
                restore = actual == new
            if restore:
                require(saved["backup_ready"], "Required original backup was not completed")
            changes.append((saved, entry, restore))
        return receipt, changes

    def rollback(self, group):
        self.rollback_plan(group)  # Read-only validation before creating the lock.
        lock = self.acquire_lock()
        receipt = None
        path = self.receipt_path(group)
        try:
            receipt, changes = self.rollback_plan(group)
            receipt["status"] = "rolling_back"
            save_receipt(path, receipt)
            for saved, entry, restore in reversed(changes):
                if restore:
                    target = self.target_path(entry)
                    require(current_hash(target) == entry["sha256"], "Rollback current SHA changed")
                    saved["state"] = "restoring"
                    save_receipt(path, receipt)
                    if saved["original_present"]:
                        original = contained(path.parent, saved["backup"])
                        require(current_hash(original) == entry["base_sha256"], "Backup SHA changed")
                        atomic_bytes(target, original.read_bytes(), saved["mode"])
                    else:
                        safe_chain(target)
                        target.unlink()
                        fsync_dir(target.parent)
                    require(current_hash(target) == entry["base_sha256"], "Restore readback mismatch")
                saved["state"] = "restored"
                save_receipt(path, receipt)
            receipt["status"] = "rolled_back"
            save_receipt(path, receipt)
        except Exception as exc:
            if receipt is not None:
                receipt["status"] = "rollback_partial"
                receipt["error"] = str(exc)
                try:
                    save_receipt(path, receipt)
                except Exception:
                    pass
            raise
        finally:
            lock.unlink()
            fsync_dir(lock.parent)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--check", action="store_true", help="Read-only plan; no files/directories created")
    action.add_argument("--apply", action="store_true")
    action.add_argument("--rollback", action="store_true")
    parser.add_argument("--group", choices=("backend", "static"))
    parser.add_argument("--root", required=True, help="Explicit existing installation root")
    parser.add_argument("--backup-dir", required=True, help="Explicit backup directory outside root/package")
    parser.add_argument("--manifest", default=str(Path(__file__).with_name("manifest.json")))
    args = parser.parse_args(argv)
    if not args.check and not args.group:
        parser.error("--apply/--rollback requires --group")
    try:
        package = Package(args.manifest, args.root, args.backup_dir)
        if args.check:
            plan, _ = package.preflight()
            print(json.dumps({"package_id": package.package_id,
                              "manifest_sha256": package.fingerprint,
                              "mode": "read_only", "targets": plan}, ensure_ascii=False, indent=2))
        elif args.apply:
            package.apply(args.group)
            print("Applied own package group: " + args.group)
        else:
            package.rollback(args.group)
            print("Rolled back own package group: " + args.group)
        return 0
    except (Refused, OSError) as exc:
        print("REFUSED: " + str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
