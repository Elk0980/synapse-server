"""Task 58 candidate. Python 3.12+, age and OpenSSH. No credentials in argv/logs.

create is Linux-only and MUST NOT run before review. pull runs on Windows.
All subprocess arguments are arrays, never shell input. Archives are encrypted
before touching backup storage; only SQLite snapshots use private scratch space.
"""
import contextlib
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess as sp
import sys
import tarfile
import tempfile
import time
import board_report

ID = re.compile(r"synapse-\d{8}T\d{6}Z")
FILES = ("data.tar.age", "images.tar.age")


class BackupError(ValueError):
    pass


def completed(root):
    return sorted((p for p in root.iterdir() if ID.fullmatch(p.name) and not p.is_symlink()
                   and p.is_dir() and (p / "receipt.json").is_file()), reverse=True)


def cleanup_partial(root, now=None):
    now = time.time() if now is None else now
    for p in root.iterdir():
        if p.name.endswith(".partial") and ID.fullmatch(p.name[:-8]) and not p.is_symlink() and p.is_dir() and now - p.stat().st_mtime > 86400:
            shutil.rmtree(p)


def rotate_local(root):
    paths = completed(root)
    keep = keep_ids([p.name for p in paths], dt.datetime.now(dt.timezone.utc).date())
    for p in paths:
        if p.name not in keep:
            shutil.rmtree(p)


def validate_bundle(bundle):
    receipt = json.loads((bundle / "receipt.json").read_text())
    if receipt.get("id") != bundle.name or set(receipt.get("files", {})) != set(FILES):
        raise BackupError("BAD_RECEIPT")
    for f in FILES:
        info = receipt["files"][f]
        path = bundle / f
        if path.is_symlink() or path.stat().st_size != info["bytes"] or sha(path) != info["sha256"]:
            raise BackupError("BAD_SHA")
    return receipt


def rotate_server(root, count):
    paths = completed(root)
    if len(paths) > count:
        # Never delete a fallback unless the newest encrypted bundle is intact.
        validate_bundle(paths[0])
        for p in paths[count:]:
            shutil.rmtree(p)


def link_target(path, roots):
    raw = os.readlink(path)
    target = Path(os.path.normpath(raw if os.path.isabs(raw) else path.parent / raw))
    if not any(target.is_relative_to(root) for root in roots):
        raise BackupError("LINK_OUTSIDE_ROOTS")
    # Both map under rootfs; no absolute symlink enters the archive.
    return os.path.relpath(target, path.parent).replace(os.sep, "/")


def run(args, **kw):
    return sp.run(args, check=True, **kw)


def sha(path):
    with open(path, "rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def write_json(path, data):
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


@contextlib.contextmanager
def lock(path):
    # Kernel releases lock after crashes; no stale mkdir lock.
    with open(path, "a+b") as f:
        if os.name == "nt":
            import msvcrt
            f.seek(0)
            f.write(b"0")
            f.flush()
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def check_db(path):
    with contextlib.closing(sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)) as db:
        if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValueError("SQLite integrity failed")


def snapshot(source, target):
    with contextlib.closing(sqlite3.connect(Path(source).resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("VACUUM INTO ?", (str(target),))
    check_db(target)


def keep_ids(ids, today, days=14):
    parsed = sorted((x for x in ids if ID.fullmatch(x)), reverse=True)
    monthly = {}
    keep = set()
    for name in parsed:
        date = dt.datetime.strptime(name[8:16], "%Y%m%d").date()
        monthly.setdefault(date.strftime("%Y-%m"), name)
        if (today - date).days < days:
            keep.add(name)
    return keep | set(monthly.values())


def create(c):
    if c.get("transport") == "stream-v1":
        raise ValueError("Для потока нужен отдельный принятый root producer")
    if os.name == "nt" or not c.get("reviewed_inventory"):
        raise ValueError("Нужны Linux и принятая инвентаризация")
    os.umask(0o077)
    out = Path(c["output"]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    import grp
    gid = grp.getgrnam(c["reader_group"]).gr_gid
    os.chown(out, 0, gid)
    os.chmod(out, 0o750)
    with lock(out / ".writer.lock"):
        status = {"phase": "create", "result": "ERROR"}
        try:
            cleanup_partial(out)
            rotate_server(out, 1)  # latest + new partial: at most two bundles
            status.update(_create(c, out), result="OK")
        except BackupError as error:
            status["error"] = str(error)
            raise
        finally:
            status.setdefault("error", "CREATE_FAILED" if status["result"] == "ERROR" else "")
            try:
                write_json(out / "status.json", status)
            finally:
                status["board"] = "OK" if board_report.publish(c, out, status) else "PENDING"
            write_json(out / "status.json", status)
            if status["result"] == "OK" and status["board"] != "OK":
                raise BackupError("BOARD_REPORT_PENDING")


def _create(c, out):
    roots = [Path(p).resolve() for p in c["roots"]]
    if not roots or any(not p.is_dir() or p == Path("/") for p in roots):
        raise ValueError("Нужны существующие отдельные каталоги")
    if any(out.is_relative_to(p) or p.is_relative_to(out) for p in roots):
        raise ValueError("Архив нельзя включать в самого себя")
    if any(a != b and a.is_relative_to(b) for a in roots for b in roots):
        raise ValueError("Вложенные roots запрещены")
    # Explicit conservative upper bounds from inventory; fail rather than fill disk.
    bound = int(c["max_bundle_bytes"])
    scratch = int(c["max_sqlite_bytes"])
    if min(bound, scratch) <= 0 or shutil.disk_usage(out).free < bound + scratch + 2**30:
        raise BackupError("NO_SPACE_SERVER")
    ids = run(["docker", "ps", "-q"], capture_output=True, text=True).stdout.split()
    metadata = json.loads(run(["docker", "inspect", *ids], capture_output=True).stdout) if ids else []
    actual = {x["Name"].lstrip("/") for x in metadata}
    if actual != set(c["containers"]):
        raise ValueError("Состав запущенных контейнеров изменился: нужна новая инвентаризация")
    total = sum(p.stat().st_size for root in roots for p in root.rglob("*") if p.is_file() and not p.is_symlink())
    image_ids = sorted({x["Image"] for x in metadata})
    image_sizes = json.loads(run(["docker", "image", "inspect", *image_ids], capture_output=True).stdout) if image_ids else []
    total += sum(x["Size"] for x in image_sizes)
    if total * 1.1 > bound:
        raise ValueError("Размер данных/образов вышел за принятую оценку")
    for item in metadata:
        for mount in item["Mounts"]:
            source = Path(mount["Source"]).resolve()
            if mount["Type"] not in ("bind", "volume") or not any(source.is_relative_to(p) for p in roots):
                raise ValueError("Не все mount sources включены в roots")
    name = "synapse-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    partial = out / (name + ".partial")
    partial.mkdir()
    try:
        with tempfile.TemporaryDirectory(prefix=".sqlite-", dir=out) as tmp:
            tmp = Path(tmp)
            # Online per-database SQLite snapshots; never pause application writers.
            entries = []
            replacements = {}
            for root in roots:
                for path in sorted(root.rglob("*")):
                    if path.is_symlink() or not path.is_file():
                        continue
                    with path.open("rb") as f:
                        sqlite = f.read(16) == b"SQLite format 3\x00"
                    if sqlite:
                        target = tmp / str(len(replacements))
                        snapshot(path, target)
                        replacements[path] = target
                        if sum(p.stat().st_size for p in replacements.values()) > scratch:
                            raise ValueError("SQLite scratch превысил принятую оценку")
            for root in roots:
                for path in sorted(root.rglob("*")):
                    if path.is_symlink():
                        link_target(path, roots)  # fail before publishing a bad archive
                        entries.append((path, path))
                    elif path.is_dir() or path.is_file():
                        base = str(path)
                        if any(base == str(p) + suffix for p in replacements for suffix in ("-wal", "-shm", "-journal")):
                            continue
                        entries.append((path, replacements.get(path, path)))
            manifest = {"schema": 2, "created": name, "roots": [str(p) for p in roots], "files": {}, "sqlite": []}
            def stream_data(pipe):
                with tarfile.open(fileobj=pipe, mode="w|gz", dereference=False) as tar:
                    for original, source in entries:
                        arc = "rootfs/" + original.as_posix().lstrip("/")
                        if original in replacements:
                            manifest["sqlite"].append(arc)
                        info = tar.gettarinfo(source, arcname=arc)
                        if source.is_symlink():
                            info.linkname = link_target(original, roots)
                            tar.addfile(info)
                        elif source.is_file():
                            # Hash exactly the bytes sent to tar, not an earlier read.
                            with source.open("rb") as f:
                                before = os.fstat(f.fileno())
                                info.type, info.linkname = tarfile.REGTYPE, ""
                                info.size = before.st_size
                                reader = HashReader(f)
                                tar.addfile(info, reader)
                                after = os.fstat(f.fileno())
                                if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                                    raise BackupError("SOURCE_CHANGED")
                                manifest["files"][arc] = reader.digest.hexdigest()
                        else:
                            tar.addfile(info)
                    for arc, value in (("manifest.json", manifest), ("containers.json", metadata)):
                        data = json.dumps(value).encode()
                        info = tarfile.TarInfo(arc)
                        info.size, info.mode = len(data), 0o600
                        tar.addfile(info, io.BytesIO(data))
            encrypt(c, partial / FILES[0], stream_data)
            images = sorted({x["Image"] for x in metadata})
            if not images:
                raise ValueError("Нет образов для восстановления")
            def stream_images(pipe):
                run(["docker", "image", "save", *images], stdout=pipe)
            encrypt(c, partial / FILES[1], stream_images)
            receipt = {"schema": 2, "id": name, "restore_bytes": total * 3 + 2**30, "files": {f: {"sha256": sha(partial / f), "bytes": (partial / f).stat().st_size} for f in FILES}}
            write_json(partial / "receipt.json", receipt)
            import grp
            gid = grp.getgrnam(c["reader_group"]).gr_gid
            for file in (*FILES, "receipt.json"):
                os.chown(partial / file, 0, gid)
                os.chmod(partial / file, 0o640)
            os.chown(partial, 0, gid)
            os.chmod(partial, 0o750)
            os.rename(partial, out / name)
            rotate_server(out, 2)
            return {"id": name, "bytes": sum(x["bytes"] for x in receipt["files"].values()), "sha": "OK"}
    finally:
        if partial.exists():
            shutil.rmtree(partial)


class HashReader:
    def __init__(self, stream):
        self.stream, self.digest = stream, hashlib.sha256()

    def read(self, size=-1):
        data = self.stream.read(size)
        self.digest.update(data)
        return data


def prune(c):
    if c.get("transport") == "stream-v1":
        import backup_stream
        return backup_stream.prune(c)
    root = Path(c["output"]).resolve()
    with lock(root / ".writer.lock"):
        paths = completed(root)
        if paths and board_report.acknowledged(c, paths[0].name, sha(paths[0] / "receipt.json")):
            rotate_server(root, 1)


def encrypt(c, path, producer):
    with path.open("xb") as output:
        proc = sp.Popen([c.get("age", "age"), "-r", c["recipient"]], stdin=sp.PIPE, stdout=output)
        try:
            producer(proc.stdin)
        finally:
            proc.stdin.close()
            code = proc.wait()
        if code:
            raise ValueError("Шифрование age не завершено")


def serve(c):
    if c.get("transport") == "stream-v1":
        import backup_stream
        return backup_stream.serve(c)
    # authorized_keys: restrict,command="python3 ... serve /etc/.../reader.json"
    # Reader OS account has NO shell/sudo and read permission only on encrypted out.
    command = os.environ.get("SSH_ORIGINAL_COMMAND", "").split()
    root = Path(c["output"]).resolve()
    if command == ["list"]:
        items = [p.name for p in root.iterdir() if ID.fullmatch(p.name) and (p / "receipt.json").is_file()]
        sys.stdout.write(json.dumps(sorted(items)))
    elif len(command) == 3 and command[0] == "get" and ID.fullmatch(command[1]) and command[2] in (*FILES, "receipt.json"):
        path = root / command[1] / command[2]
        if path.is_symlink() or path.parent.is_symlink():
            raise ValueError("Ссылки запрещены")
        with path.open("rb") as f:
            shutil.copyfileobj(f, sys.stdout.buffer)
    else:
        raise ValueError("Разрешено только list/get")


def ssh(c, command, target):
    timeout = 3600 if command.startswith("get ") and not command.endswith("receipt.json") else 30
    run([c.get("ssh", "ssh"), "-T", "-oBatchMode=yes", "-oIdentitiesOnly=yes", "-oStrictHostKeyChecking=yes", "-oConnectTimeout=20", "-oServerAliveInterval=30", "-oServerAliveCountMax=3", "-oUserKnownHostsFile=" + c["known_hosts"], "-i", c["ssh_key"], c["host"], command], stdout=target, timeout=timeout)


def pull(c):
    if c.get("transport") == "stream-v1":
        import backup_stream
        backup_stream.checked_path(Path(c["destination"]).absolute())
    root = Path(c["destination"]).resolve()
    root.mkdir(parents=True, exist_ok=True)
    with lock(root / ".pull.lock"):
        state_path = root / "status.json"
        try:
            old = json.loads(state_path.read_text()) if state_path.exists() else {}
        except (ValueError, OSError):
            old = {}  # Corrupt previous status must not disable housekeeping.
        status = {"phase": "pull", "result": "ERROR", "sha": "UNKNOWN", "verified_at": old.get("verified_at", 0), "checked_at": time.time()}
        try:
            cleanup_partial(root)
            dest, receipt = download(c, root)
            status.update(id=dest.name, sha="OK", bytes=sum(x["bytes"] for x in receipt["files"].values()))
            if time.time() - status["verified_at"] >= 7 * 86400:
                weekly_verify(c, dest)
                status["verified_at"] = time.time()
            if c.get("transport") == "stream-v1":
                import backup_stream
                dest = backup_stream.promote(c, root, dest)
            status.update(result="OK", receipt_sha=sha(dest / "receipt.json"))
        except Exception as error:
            status["error"] = str(error) if isinstance(error, BackupError) else "PULL_OR_VERIFY_FAILED"
            raise
        finally:
            # Verification, download or network failure cannot bypass housekeeping.
            try:
                cleanup_partial(root)
                if c.get("transport") == "stream-v1":
                    import backup_stream
                    backup_stream.cleanup_local(root)
                rotate_local(root)
            finally:
                try:
                    write_json(state_path, status)
                finally:
                    status["board"] = "OK" if board_report.publish(c, root, status) else "PENDING"
                write_json(state_path, status)
        if status["board"] != "OK":
            raise BackupError("BOARD_REPORT_PENDING")
        print(json.dumps(status))


def download(c, root):
    if c.get("transport") == "stream-v1":
        import backup_stream
        return backup_stream.download(c, root)
    with tempfile.TemporaryFile() as f:
        ssh(c, "list", f)
        f.seek(0)
        ids = json.load(f)
    if not ids or any(not ID.fullmatch(x) for x in ids):
        raise BackupError("NO_BACKUP")
    name = max(ids)
    date = dt.datetime.strptime(name[8:16], "%Y%m%d").date()
    if (dt.datetime.now(dt.timezone.utc).date() - date).days > 1:
        raise BackupError("STALE_BACKUP")
    dest, pending = root / name, root / (name + ".partial")
    if dest.is_symlink() or pending.is_symlink():
        raise BackupError("UNSAFE_DESTINATION")
    pending.mkdir(exist_ok=True)
    with (pending / "receipt.json").open("wb") as f:
        ssh(c, f"get {name} receipt.json", f)
    receipt = json.loads((pending / "receipt.json").read_text())
    if receipt.get("id") != name or set(receipt.get("files", {})) != set(FILES):
        raise BackupError("BAD_RECEIPT")
    for file, info in receipt["files"].items():
        if not re.fullmatch("[0-9a-f]{64}", info["sha256"]) or not 0 < info["bytes"] <= c["max_bundle_bytes"]:
            raise BackupError("BAD_RECEIPT")
        path = (dest if dest.exists() else pending) / file
        if path.is_symlink():
            raise BackupError("UNSAFE_DESTINATION")
        if not path.exists() or path.stat().st_size != info["bytes"] or sha(path) != info["sha256"]:
            if dest.exists():
                raise BackupError("LOCAL_BACKUP_DAMAGED")
            if shutil.disk_usage(root).free < info["bytes"] + 2**30:
                raise BackupError("NO_SPACE_D")
            with path.open("wb") as f:
                ssh(c, f"get {name} {file}", f)
            if path.stat().st_size != info["bytes"] or sha(path) != info["sha256"]:
                raise BackupError("BAD_SHA")
    if not dest.exists():
        os.rename(pending, dest)
    else:
        shutil.rmtree(pending)
    validate_bundle(dest)
    return dest, receipt


def private_dir(path):
    if os.name == "nt":
        identity = run(["whoami", "/user", "/fo", "csv", "/nh"], capture_output=True, text=True).stdout
        sid = re.search(r"S-1-5-\d+(?:-\d+)+", identity).group()
        run(["icacls", str(path), "/inheritance:r", "/grant:r", f"*{sid}:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F"], stdout=sp.DEVNULL, stderr=sp.DEVNULL)
    else:
        path.chmod(0o700)


def restore_budget(c, bundle):
    receipt = json.loads((bundle / "receipt.json").read_text())
    amount = receipt.get("restore_bytes")
    if not isinstance(amount, int) or not 0 < amount <= c["max_restore_bytes"]:
        raise BackupError("RESTORE_BUDGET_INVALID")
    return amount


def temporary_parent(c, bundle):
    parent = Path(c.get("verify_temp_dir", tempfile.gettempdir())).resolve()
    if not parent.is_dir() or parent.is_relative_to(bundle.parent):
        raise BackupError("TEMP_MUST_BE_OUTSIDE_BACKUPS")
    identity = Path(c["identity"]).resolve()
    if identity.is_relative_to(bundle.parent):
        raise BackupError("IDENTITY_MUST_BE_OUTSIDE_BACKUPS")
    return parent


def weekly_verify(c, bundle):
    parent = temporary_parent(c, bundle)
    amount = restore_budget(c, bundle)
    if shutil.disk_usage(parent).free < amount:
        raise BackupError("NO_SPACE_TEMP")
    with tempfile.TemporaryDirectory(prefix="synapse-verify-", dir=parent) as tmp:
        private_dir(Path(tmp))
        restore(c, bundle, Path(tmp) / "restore")


def decrypt(c, encrypted, output, limit):
    proc = sp.Popen([c.get("age", "age"), "-d", "-i", c["identity"], str(encrypted)], stdout=sp.PIPE, stderr=sp.DEVNULL)
    count = 0
    try:
        with output.open("xb") as target:
            while data := proc.stdout.read(1024 * 1024):
                count += len(data)
                if count > limit:
                    raise BackupError("RESTORE_BUDGET_EXCEEDED")
                target.write(data)
        if proc.wait():
            raise BackupError("BAD_SHA")
    finally:
        proc.stdout.close()
        if proc.poll() is None:
            proc.kill()
        proc.wait()


def restore(c, bundle, target):
    bundle, target = Path(bundle).resolve(), Path(target).resolve()
    if target.exists():
        raise ValueError("Нужен новый каталог; существующие данные не перезаписываются")
    validate_bundle(bundle)
    parent = temporary_parent(c, bundle)
    amount = restore_budget(c, bundle)
    # Conservative budget checked on BOTH filesystems before plaintext is written.
    if not target.parent.is_dir() or min(shutil.disk_usage(parent).free, shutil.disk_usage(target.parent).free) < amount:
        raise BackupError("NO_SPACE_TEMP")
    with tempfile.TemporaryDirectory(prefix="synapse-decrypt-", dir=parent) as tmp:
        tmp = Path(tmp)
        private_dir(tmp)
        staged = tmp / "verified"
        staged.mkdir(mode=0o700)
        # Decrypt fully before extraction: age must authenticate the final chunk.
        for file in FILES:
            plain = tmp / (file + ".plain")
            decrypt(c, bundle / file, plain, amount)
            if file == FILES[0]:
                with tarfile.open(plain) as tar:
                    members = tar.getmembers()
                    if sum(x.size for x in members) > amount:
                        raise BackupError("RESTORE_BUDGET_EXCEEDED")
                    tar.extractall(staged, members=members, filter="data")
                plain.unlink()
            else:
                with tarfile.open(plain) as tar:
                    for member in tar:
                        if member.isfile():
                            with tar.extractfile(member) as source:
                                while source.read(1024 * 1024):
                                    pass
                plain.rename(staged / "images.tar")
        manifest = json.loads((staged / "manifest.json").read_text())
        for name, digest in manifest["files"].items():
            path = (staged / name).resolve()
            if not path.is_relative_to(staged) or sha(path) != digest:
                raise ValueError("Неверный внутренний SHA/путь")
        for name in manifest["sqlite"]:
            path = (staged / name).resolve()
            if not path.is_relative_to(staged):
                raise BackupError("UNSAFE_SQLITE_PATH")
            check_db(path)
        write_json(staged / "VERIFIED.json", {"schema": 2, "sqlite": len(manifest["sqlite"]), "files": len(manifest["files"]), "services_started": False})
        # Promote only authenticated, fully verified content; temporary plaintext
        # is deleted on every exit, including extraction/SQLite failures.
        target.mkdir(mode=0o700)
        try:
            private_dir(target)
            shutil.copytree(staged, target, symlinks=True, dirs_exist_ok=True)
        except BaseException:
            if target.exists():
                shutil.rmtree(target)
            raise


def main():
    def interrupted(signum, frame):
        raise InterruptedError("Остановка")
    signal.signal(signal.SIGTERM, interrupted)
    action, config, *args = sys.argv[1:]
    c = json.loads(Path(config).read_text(encoding="utf-8-sig"))
    if action == "create":
        create(c)
    elif action == "create-stream":
        import backup_stream
        try:
            backup_stream.produce(c)
        except backup_stream.ConfigurationError:
            print("STREAM_CONFIG_REVIEW_REQUIRED", file=sys.stderr)
            raise SystemExit(78)
    elif action == "serve":
        serve(c)
    elif action == "pull":
        pull(c)
    elif action == "prune":
        prune(c)
    elif action == "restore" and len(args) == 2:
        restore(c, *args)
    elif action == "restore-smoke" and len(args) == 2:
        restore(c, *args)
        import sandbox
        sandbox.main(args[1])
    else:
        raise ValueError("create|serve|pull config.json; restore config.json bundle new-folder")


if __name__ == "__main__":
    # The optional transport must share BackupError/locks with this entry point.
    sys.modules["backup_v2"] = sys.modules[__name__]
    try:
        main()
    except Exception:
        # Exception strings may include private paths, endpoints or subprocess args.
        print("ОШИБКА резервного копирования; проверьте доступ, место и целостность. Данные сохранены.", file=sys.stderr)
        sys.exit(1)
