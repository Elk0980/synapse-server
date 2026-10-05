#!/usr/bin/env python3
"""Offline, non-privileged package preparation. This template never connects Eva.

The deterministic builder appends the three package constants and main invocation.
Only a fresh private directory is created; no installer or activation is included.
"""

import argparse
import base64
import binascii
import hashlib
import io
import os
import re
import stat
import sys
import zipfile


PACKAGE_METADATA = {}
PAYLOAD_B64 = ""
PAYLOAD_SHA256 = ""
MAX_ZIP_BYTES = 8 * 1024 * 1024
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 16 * 1024 * 1024
MAX_FILES = 64
COMPANY_CODES = ("alvi", "palitra-love", "synapse-business", "avokado", "novyi-etap", "taisabai")
SOURCE_REVISIONS = {
    "main_sha": "29c10c07f27cd0b1e60dcf4c87f61236228e5c03",
    "eva_sha": "1d7d0b5e4066de8a07cec5cd598d8af05b4cd98a",
    "integrated_sha": "32ef85a8df6f4b76ff3d0d7cc3270d983b44c425",
}
ALLOWED_FILES = frozenset({
    "ops/eva-tasks/.dockerignore", "ops/eva-tasks/audit-source-ref.test.js",
    "ops/eva-tasks/bot.js", "ops/eva-tasks/bot.test.js",
    "ops/eva-tasks/compose.eva-crm.example.yml", "ops/eva-tasks/compose.eva.yml",
    "ops/eva-tasks/demo.js", "ops/eva-tasks/Dockerfile", "ops/eva-tasks/README.md",
    "ops/eva-tasks/runtime.js", "ops/eva-tasks/runtime.test.js",
    "ops/eva-tasks/socket-source.js", "ops/eva-tasks/socket-source.test.js",
    "ops/eva-tasks/task-source.js", "ops/eva-tasks/task-source.test.js",
    "ops/eva-tasks/pairing.py", "ops/eva-tasks/pairing_test.py",
    "ops/eva-tasks/setup.py", "ops/eva-tasks/setup_test.py",
    "ops/crm/eva-task-reader.js", "integration.patch", "PACKAGE_README.md",
})
BLOCKED_STATUS = (
    "CONNECTION BLOCKED: PR443 must be merged, the compatible CRM task reader "
    "must be deployed, and an operator must configure its private socket. "
    "The owner must then personally complete hidden-token setup and one-time "
    "pairing before any bot activation. This command does none of those actions."
)


class PackageError(Exception):
    """Static error messages never echo file contents or operator inputs."""


def check_platform():
    if sys.platform != "linux" or sys.version_info < (3, 9):
        raise PackageError("Requires Linux and Python 3.9 or newer; nothing was written.")
    if not all(hasattr(os, name) for name in ("O_DIRECTORY", "O_NOFOLLOW", "getuid")):
        raise PackageError("Required Linux filesystem protections are unavailable.")


def _safe_name(name):
    if (not isinstance(name, str) or len(name) > 200 or not name
            or not re.fullmatch(r"[A-Za-z0-9_./-]+", name)
            or any(part in ("", ".", "..") for part in name.split("/"))
            or name.startswith("/") or name not in ALLOWED_FILES):
        raise PackageError("Package contains a forbidden or unsafe path.")
    return name


def _sha(value, length=64):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{%d}" % length, value) is not None


def validate_bundle(metadata, payload_b64, payload_sha256):
    """Validate every archive byte and file in memory before any filesystem write."""
    required_keys = {"schema", "main_sha", "eva_sha", "integrated_sha", "package_source_sha",
                     "file_sha256", "company_codes", "timezone", "expected_bot"}
    if (not isinstance(metadata, dict) or set(metadata) != required_keys
            or type(metadata.get("schema")) is not int or metadata.get("schema") != 1):
        raise PackageError("Unsupported package metadata schema.")
    for key, expected in SOURCE_REVISIONS.items():
        if metadata.get(key) != expected:
            raise PackageError("Package source revision metadata is invalid.")
    if not _sha(metadata.get("package_source_sha"), 40):
        raise PackageError("Package builder revision metadata is invalid.")
    if (metadata.get("company_codes") != list(COMPANY_CODES)
            or metadata.get("timezone") != "Etc/UTC"
            or metadata.get("expected_bot") != "SynapseBusinessEvaBot"):
        raise PackageError("Package company, timezone or bot identity metadata is invalid.")
    manifest = metadata.get("file_sha256")
    if not isinstance(manifest, dict) or set(manifest) != ALLOWED_FILES:
        raise PackageError("Package file manifest is invalid.")
    folded = set()
    for name, digest in manifest.items():
        _safe_name(name)
        if not _sha(digest) or name.casefold() in folded:
            raise PackageError("Package manifest has invalid hashes or colliding names.")
        folded.add(name.casefold())
    if (not _sha(payload_sha256) or not isinstance(payload_b64, str)
            or len(payload_b64) > ((MAX_ZIP_BYTES + 2) // 3) * 4):
        raise PackageError("Package payload encoding or size is invalid.")
    try:
        payload = base64.b64decode(payload_b64, validate=True)
    except (ValueError, binascii.Error):
        raise PackageError("Package payload encoding is invalid.") from None
    if len(payload) > MAX_ZIP_BYTES or hashlib.sha256(payload).hexdigest() != payload_sha256:
        raise PackageError("Package payload SHA256 verification failed.")
    result, seen, total = {}, set(), 0
    try:
        with zipfile.ZipFile(io.BytesIO(payload), "r") as archive:
            members = archive.infolist()
            if not 1 <= len(members) <= MAX_FILES:
                raise PackageError("Package archive file count is invalid.")
            for member in members:
                name = _safe_name(member.filename)
                # orig_filename preserves NUL bytes that ZipInfo.filename truncates.
                if member.orig_filename != name or name.casefold() in seen:
                    raise PackageError("Package archive contains duplicate or ambiguous paths.")
                seen.add(name.casefold())
                mode = member.external_attr >> 16
                if (member.is_dir() or stat.S_IFMT(mode) not in (0, stat.S_IFREG)
                        or member.flag_bits & 1
                        or member.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)):
                    raise PackageError("Package archive contains a non-regular or unsupported entry.")
                if name not in manifest:
                    raise PackageError("Package archive contains an unlisted file.")
                total += member.file_size
                if (member.file_size < 0 or member.file_size > MAX_FILE_BYTES
                        or total > MAX_TOTAL_BYTES
                        or member.file_size > max(member.compress_size, 1) * 200):
                    raise PackageError("Package archive exceeds safe extraction limits.")
                with archive.open(member, "r") as source:
                    data = source.read(MAX_FILE_BYTES + 1)
                if (len(data) != member.file_size
                        or hashlib.sha256(data).hexdigest() != manifest[name]):
                    raise PackageError("Package file SHA256 verification failed.")
                result[name] = data
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, EOFError, ValueError):
        raise PackageError("Package ZIP validation failed.") from None
    if set(result) != set(manifest):
        raise PackageError("Package archive and manifest do not match.")
    return result


def _identity(info):
    return info.st_dev, info.st_ino


def _file_state(info):
    return (info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_mode,
            info.st_uid, info.st_gid, info.st_nlink)


def _private_directory(fd):
    info = os.fstat(fd)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or info.st_mode & 0o022):
        raise PackageError("Run from a directory you own that others cannot modify.")
    return info


def _rollback(files, directories):
    """Only remove our unchanged inodes, then our empty directories; never recurse.

    Open directory descriptors prevent redirection through replaced path components.
    Changed/replaced files, new foreign files and nonempty directories are retained.
    """
    for entry in reversed(files):
        parent, name, fd, identity, expected, expected_state = entry
        try:
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            opened = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or _identity(info) != identity
                    or _identity(opened) != identity or opened.st_nlink != 1
                    or opened.st_size != len(expected) or _file_state(opened) != expected_state):
                continue
            os.lseek(fd, 0, os.SEEK_SET)
            content = bytearray()
            while len(content) <= len(expected):
                chunk = os.read(fd, min(65536, len(expected) + 1 - len(content)))
                if not chunk:
                    break
                content.extend(chunk)
            if bytes(content) == expected:
                os.unlink(name, dir_fd=parent)
        except OSError:
            pass  # Fail closed: a concurrent change is never an instruction to delete.
    for parent, name, fd, identity in reversed(directories):
        try:
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (stat.S_ISDIR(info.st_mode) and _identity(info) == identity
                    and stat.S_IMODE(info.st_mode) == 0o700 and info.st_uid == os.getuid()):
                os.rmdir(name, dir_fd=parent)
        except OSError:
            pass


def prepare_bundle(metadata, payload_b64, payload_sha256, directory=None):
    """Prepare in cwd (or a test directory). Never modify an existing destination."""
    check_platform()
    entries = validate_bundle(metadata, payload_b64, payload_sha256)
    name = "eva-prepared-" + payload_sha256[:16]
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    parent = os.open("." if directory is None else directory, flags)
    directories, files, descriptors = [], [], [parent]
    try:
        _private_directory(parent)
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError:
            raise PackageError("Prepared destination already exists; nothing was overwritten.") from None
        # Do not follow a substituted symlink even in a concurrent local operation.
        initial = os.stat(name, dir_fd=parent, follow_symlinks=False)
        directories.append((parent, name, None, _identity(initial)))
        root = os.open(name, flags, dir_fd=parent)
        descriptors.append(root)
        if _identity(_private_directory(root)) != _identity(initial):
            raise PackageError("Prepared destination changed during creation.")
        os.fchmod(root, 0o700)
        parents = {"": root}
        for path in sorted(entries):
            parts = path.split("/")
            relative = ""
            current = root
            for part in parts[:-1]:
                relative = part if not relative else relative + "/" + part
                if relative not in parents:
                    os.mkdir(part, 0o700, dir_fd=current)
                    created = os.stat(part, dir_fd=current, follow_symlinks=False)
                    directories.append((current, part, None, _identity(created)))
                    child = os.open(part, flags, dir_fd=current)
                    descriptors.append(child)
                    if _identity(_private_directory(child)) != _identity(created):
                        raise PackageError("Prepared subdirectory changed during creation.")
                    os.fchmod(child, 0o700)
                    parents[relative] = child
                current = parents[relative]
            fd = os.open(parts[-1], os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=current)
            descriptors.append(fd)
            opened = os.fstat(fd)
            record = [current, parts[-1], fd, _identity(opened), b"", _file_state(opened)]
            files.append(record)
            os.fchmod(fd, 0o600)
            record[5] = _file_state(os.fstat(fd))
            data, written = entries[path], 0
            while written < len(data):
                count = os.write(fd, data[written:])
                if count <= 0:
                    raise PackageError("Preparation could not finish writing a file.")
                written += count
                record[4] = data[:written]
                record[5] = _file_state(os.fstat(fd))
            os.fsync(fd)
        os.fsync(root)
        return name
    except BaseException:
        _rollback(files, directories)
        raise
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def main(argv=None, metadata=None, payload_b64=None, payload_sha256=None):
    parser = argparse.ArgumentParser(description="Verify or prepare Eva files offline; never connect or activate.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="verify Linux, Python and the complete embedded package without writing")
    mode.add_argument("--prepare", action="store_true", help="prepare a fresh private folder in the current directory (default)")
    args = parser.parse_args(argv)
    metadata = PACKAGE_METADATA if metadata is None else metadata
    payload_b64 = PAYLOAD_B64 if payload_b64 is None else payload_b64
    payload_sha256 = PAYLOAD_SHA256 if payload_sha256 is None else payload_sha256
    try:
        check_platform()
        if args.check:
            entries = validate_bundle(metadata, payload_b64, payload_sha256)
            print("CHECK OK: %d files verified; no filesystem writes." % len(entries))
        else:
            name = prepare_bundle(metadata, payload_b64, payload_sha256)
            print("PREPARED (not connected): " + name)
        print("Base main: " + metadata["main_sha"])
        print(BLOCKED_STATUS)
        return 0
    except PackageError as error:
        print("STOPPED: " + str(error), file=sys.stderr)
    except (OSError, ValueError, OverflowError, MemoryError):
        print("STOPPED: package preparation failed. Existing files were not overwritten; "
              "any changed or foreign files in a partial folder were preserved.", file=sys.stderr)
    return 1
