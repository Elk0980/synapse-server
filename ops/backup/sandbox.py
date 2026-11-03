"""Offline smoke restore on a Linux Docker host. Never binds public ports.
Only use a disposable host with sufficient disk space. Does not switch production.
"""
import json
import os
from pathlib import Path
import subprocess as sp
import sys
import tempfile
import time
import uuid


def run(args, **kw):
    return sp.run(args, check=True, stdout=sp.DEVNULL, stderr=sp.DEVNULL, **kw)


def main(folder):
    root = Path(folder).resolve()
    if os.name == "nt" or not (root / "VERIFIED.json").is_file() or (root / "FAILED").exists():
        raise ValueError("Нужна проверенная копия на Linux")
    # Public ports, Docker socket, privileges, host network and restart policies
    # from production metadata are intentionally never replayed.
    items = json.loads((root / "containers.json").read_text())
    names = []
    checks = set()
    run(["docker", "load", "-i", str(root / "images.tar")])
    try:
        for item in items:
            original = item["Name"].lstrip("/")
            if not any(x in original for x in ("crm", "caddy")):
                continue
            name = "synapse-restore-" + uuid.uuid4().hex
            with tempfile.NamedTemporaryFile(mode="w", dir=root, delete=False) as env:
                os.chmod(env.name, 0o600)
                for value in item["Config"].get("Env") or []:
                    if "\n" in value or "\r" in value:
                        raise ValueError("Многострочный env требует отдельного reviewed recipe")
                    env.write(value + "\n")
            try:
                args = ["docker", "create", "--name", name, "--network", "none", "--restart", "no", "--env-file", env.name]
                for flag, key in (("--user", "User"), ("--workdir", "WorkingDir")):
                    if item["Config"].get(key):
                        args += [flag, item["Config"][key]]
                for mount in item["Mounts"]:
                    source = (root / "rootfs" / mount["Source"].lstrip("/")).resolve()
                    if not source.is_relative_to(root / "rootfs") or not source.exists() or "docker.sock" in str(source) or "," in str(source):
                        raise ValueError("Непереносимый mount")
                    args += ["--mount", f"type=bind,source={source},target={mount['Destination']}" + (",readonly" if not mount["RW"] else "")]
                entry = item["Config"].get("Entrypoint") or []
                if "caddy" in original:
                    site = os.environ["SYNAPSE_RESTORE_SITE_PATH"]
                    if not site or any(part in ("", ".", "..") for part in site.split("/")) or not all(ch.isalnum() or ch in "-_/" for ch in site):
                        raise ValueError("Нужен относительный каталог сайта")
                    args += ["--entrypoint", "caddy", item["Image"], "file-server", "--root", "/srv/sites", "--listen", ":8080"]
                elif entry:
                    args += ["--entrypoint", entry[0]]
                    args += [item["Image"], *entry[1:], *(item["Config"].get("Cmd") or [])]
                else:
                    args += [item["Image"], *(item["Config"].get("Cmd") or [])]
                run(args)
                names.append(name)
                run(["docker", "start", name])
                if "crm" in original:
                    probe = ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/catalog',{headers:{'x-api-key':process.env.API_KEY}}).then(async r=>{await r.json();process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"]
                    kind = "crm"
                else:
                    probe = ["wget", "-q", "--spider", "http://127.0.0.1:8080/" + site + "/"]
                    kind = "site"
                for attempt in range(30):
                    result = sp.run(["docker", "exec", name, *probe], stdout=sp.DEVNULL, stderr=sp.DEVNULL, timeout=5)
                    if result.returncode == 0:
                        checks.add(kind)
                        break
                    time.sleep(1)
                else:
                    raise ValueError("Сервис не прошёл health probe")
                if "caddy" in original:
                    cabinet = os.environ.get("SYNAPSE_RESTORE_CABINET_PATH", "synapse")
                    if not cabinet or any(part in ("", ".", "..") for part in cabinet.split("/")) or not all(ch.isalnum() or ch in "-_/" for ch in cabinet):
                        raise ValueError("Нужен относительный каталог кабинета")
                    for page in ("cabinet.html", "cabinet/common.css", "cabinet/account.js"):
                        run(["docker", "exec", name, "wget", "-q", "--spider", f"http://127.0.0.1:8080/{cabinet}/{page}"], timeout=10)
                    checks.add("cabinet")
            finally:
                Path(env.name).unlink()
        if checks != {"crm", "site", "cabinet"}:
            raise ValueError("CRM, кабинет и сайт не найдены в принятой инвентаризации")
        (root / "SANDBOX_OK.json").write_text(json.dumps({"crm": True, "site": True, "cabinet": True, "network": "none", "production": False}))
    finally:
        for name in names:
            run(["docker", "rm", "-f", "-v", name])


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except Exception:
        print("Проверка восстановления не завершена; рабочий сервер не переключён.", file=sys.stderr)
        sys.exit(1)
