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

ID = re.compile(r"synapse-\d{8}T\d{6}Z")
FILES = ("data.tar.age", "images.tar.age")


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
        if (out / ".paused.json").exists():
            raise ValueError("Есть незавершённый pause; сначала recover")
        _create(c, out)


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
        raise ValueError("Недостаточно места для новой копии без удаления старых")
    ids = run(["docker", "ps", "-q"], capture_output=True, text=True).stdout.split()
    metadata = json.loads(run(["docker", "inspect", *ids], capture_output=True).stdout) if ids else []
    if any(x["State"]["Paused"] for x in metadata):
        raise ValueError("Есть чужие приостановленные контейнеры")
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
    paused = []
    try:
        with tempfile.TemporaryDirectory(prefix=".sqlite-", dir=out) as tmp:
            tmp = Path(tmp)
            # All application writers must be containers; host writers must be
            # quiesced by an approved external maintenance window first.
            for item in metadata:
                # Journal BEFORE pause: ExecStopPost can resume after SIGKILL.
                write_json(out / ".paused.json", paused + [item["Id"]])
                run(["docker", "pause", item["Id"]], stdout=sp.DEVNULL)
                paused.append(item["Id"])
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
                        # Copying node_modules/.bin links is supported by tar's
                        # safe extraction filter; escaping links fail at restore.
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
                        if source.is_file() and not source.is_symlink():
                            manifest["files"][arc] = sha(source)
                        if original in replacements:
                            manifest["sqlite"].append(arc)
                        tar.add(source, arcname=arc, recursive=False)
                    for arc, value in (("manifest.json", manifest), ("containers.json", metadata)):
                        data = json.dumps(value).encode()
                        info = tarfile.TarInfo(arc)
                        info.size, info.mode = len(data), 0o600
                        tar.addfile(info, io.BytesIO(data))
            encrypt(c, partial / FILES[0], stream_data)
            # Consistent files + SQLite are now captured. Resume before image export.
            while paused:
                run(["docker", "unpause", paused[-1]], stdout=sp.DEVNULL)
                paused.pop()
                write_json(out / ".paused.json", paused)
            images = sorted({x["Image"] for x in metadata})
            if not images:
                raise ValueError("Нет образов для восстановления")
            def stream_images(pipe):
                run(["docker", "image", "save", *images], stdout=pipe)
            encrypt(c, partial / FILES[1], stream_images)
            receipt = {"schema": 2, "id": name, "files": {f: {"sha256": sha(partial / f), "bytes": (partial / f).stat().st_size} for f in FILES}}
            write_json(partial / "receipt.json", receipt)
            import grp
            gid = grp.getgrnam(c["reader_group"]).gr_gid
            for file in (*FILES, "receipt.json"):
                os.chown(partial / file, 0, gid)
                os.chmod(partial / file, 0o640)
            os.chown(partial, 0, gid)
            os.chmod(partial, 0o750)
            os.rename(partial, out / name)
            # Only completed v2 bundles; old backup.sh archives are untouched.
            completed = sorted((p for p in out.iterdir() if ID.fullmatch(p.name) and (p / "receipt.json").is_file()), reverse=True)
            for path in completed[3:]:
                shutil.rmtree(path)
    finally:
        recover({"output": str(out)})
        if partial.exists():
            shutil.rmtree(partial)


def recover(c):
    journal = Path(c["output"]) / ".paused.json"
    if not journal.exists():
        return
    remaining = []
    for container in json.loads(journal.read_text()):
        if not re.fullmatch("[0-9a-f]{64}", container):
            raise ValueError("Неверный pause journal")
        state = sp.run(["docker", "inspect", "-f", "{{.State.Paused}}", container], capture_output=True, text=True)
        if state.returncode or (state.stdout.strip() == "true" and sp.run(["docker", "unpause", container], stdout=sp.DEVNULL).returncode):
            remaining.append(container)
    if remaining:
        write_json(journal, remaining)
        raise ValueError("Не все контейнеры возобновлены")
    journal.unlink()


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
    run([c.get("ssh", "ssh"), "-T", "-oBatchMode=yes", "-oIdentitiesOnly=yes", "-oStrictHostKeyChecking=yes", "-oConnectTimeout=20", "-oServerAliveInterval=30", "-oServerAliveCountMax=3", "-oUserKnownHostsFile=" + c["known_hosts"], "-i", c["ssh_key"], c["host"], command], stdout=target, timeout=7200)


def pull(c):
    root = Path(c["destination"]).resolve()
    root.mkdir(parents=True, exist_ok=True)
    with lock(root / ".pull.lock"):
        with tempfile.TemporaryFile() as f:
            ssh(c, "list", f)
            f.seek(0)
            ids = json.load(f)
        if not ids or any(not ID.fullmatch(x) for x in ids):
            raise ValueError("Нет завершённой копии")
        name = max(ids)
        date = dt.datetime.strptime(name[8:16], "%Y%m%d").date()
        if (dt.datetime.now(dt.timezone.utc).date() - date).days > 1:
            raise ValueError("Копия сервера старше суток")
        dest = root / name
        pending = root / (name + ".partial")
        pending.mkdir(exist_ok=True)
        with (pending / "receipt.json").open("wb") as f:
            ssh(c, f"get {name} receipt.json", f)
        receipt = json.loads((pending / "receipt.json").read_text())
        if receipt.get("id") != name or set(receipt.get("files", {})) != set(FILES):
            raise ValueError("Неверный receipt")
        for file, info in receipt["files"].items():
            if not re.fullmatch("[0-9a-f]{64}", info["sha256"]) or not 0 < info["bytes"] <= c["max_bundle_bytes"]:
                raise ValueError("Неверный размер/SHA")
            path = pending / file
            if dest.exists():
                path = dest / file
            if not path.exists() or path.stat().st_size != info["bytes"] or sha(path) != info["sha256"]:
                if dest.exists():
                    raise ValueError("Ранее проверенная копия повреждена; не перезаписываю")
                if shutil.disk_usage(root).free < info["bytes"] + 2**30:
                    raise ValueError("Недостаточно места на D; старые копии сохранены")
                with path.open("wb") as f:
                    ssh(c, f"get {name} {file}", f)
                if path.stat().st_size != info["bytes"] or sha(path) != info["sha256"]:
                    raise ValueError("Загрузка: SHA/размер не совпал")
        if not dest.exists():
            os.rename(pending, dest)
        else:
            shutil.rmtree(pending)
        # Weekly authenticated decrypt + full manifest/SQLite verification, not just SHA.
        state_path = root / "status.json"
        old = json.loads(state_path.read_text()) if state_path.exists() else {}
        now = time.time()
        verified_at = old.get("verified_at", 0)
        if now - verified_at >= 7 * 86400:
            with tempfile.TemporaryDirectory(prefix=".verify-", dir=root) as tmp:
                restore(c, dest, Path(tmp) / "restore")
            verified_at = now
        write_json(state_path, {"id": name, "bytes": sum(x["bytes"] for x in receipt["files"].values()), "sha": "OK", "verified_at": verified_at, "checked_at": now})
        complete = [p for p in root.iterdir() if ID.fullmatch(p.name) and (p / "receipt.json").is_file()]
        keep = keep_ids([p.name for p in complete], dt.datetime.now(dt.timezone.utc).date())
        for path in complete:
            if path.name not in keep and not path.is_symlink():
                shutil.rmtree(path)
        print(json.dumps({"backup": name, "sha": "OK", "bytes": sum(x["bytes"] for x in receipt["files"].values())}))


def restore(c, bundle, target):
    bundle, target = Path(bundle).resolve(), Path(target).resolve()
    if target.exists():
        raise ValueError("Нужен новый каталог; существующие данные не перезаписываются")
    receipt = json.loads((bundle / "receipt.json").read_text())
    for name in FILES:
        if sha(bundle / name) != receipt["files"][name]["sha256"]:
            raise ValueError("SHA не совпал")
    target.mkdir(parents=True, mode=0o700)
    try:
        # Decrypt fully before extraction: age must authenticate the final chunk.
        for file in FILES:
            plain = target / (file + ".plain")
            with plain.open("xb") as f:
                run([c.get("age", "age"), "-d", "-i", c["identity"], str(bundle / file)], stdout=f)
            if file == FILES[0]:
                with tarfile.open(plain) as tar:
                    tar.extractall(target, filter="data")
                plain.unlink()
            else:
                plain.rename(target / "images.tar")
        manifest = json.loads((target / "manifest.json").read_text())
        for name, digest in manifest["files"].items():
            path = (target / name).resolve()
            if not path.is_relative_to(target) or sha(path) != digest:
                raise ValueError("Неверный внутренний SHA/путь")
        for name in manifest["sqlite"]:
            check_db(target / name)
        write_json(target / "VERIFIED.json", {"schema": 2, "sqlite": len(manifest["sqlite"]), "files": len(manifest["files"]), "services_started": False})
    except BaseException:
        # Preserve failed restore for investigation; never promote partial data.
        (target / "FAILED").touch()
        raise


def main():
    def interrupted(signum, frame):
        raise InterruptedError("Остановка")
    signal.signal(signal.SIGTERM, interrupted)
    action, config, *args = sys.argv[1:]
    c = json.loads(Path(config).read_text(encoding="utf-8-sig"))
    if action == "create":
        create(c)
    elif action == "serve":
        serve(c)
    elif action == "pull":
        pull(c)
    elif action == "recover":
        recover(c)
    elif action == "restore" and len(args) == 2:
        restore(c, *args)
    elif action == "restore-smoke" and len(args) == 2:
        restore(c, *args)
        import sandbox
        sandbox.main(args[1])
    else:
        raise ValueError("create|serve|pull config.json; restore config.json bundle new-folder")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Exception strings may include private paths, endpoints or subprocess args.
        print("ОШИБКА резервного копирования; проверьте доступ, место и целостность. Данные сохранены.", file=sys.stderr)
        sys.exit(1)
