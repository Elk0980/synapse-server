#!/usr/bin/env python3
"""Capture fixed Palitra source bytes; no install, DB, flags, shell or network."""
import argparse
import base64
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

CONTENT_IMAGE = "sha256:8a98cf8656cc139e6cbb842f81bc05e20c534065b2274063629b18c32db3fa72"
WORKER_IMAGE = "sha256:c5dd4502daf630afaac7415da5b19dc456c81a5f81626574f548adec04307cca"
CAPTURE_PARENT = Path("/opt/synapse/releases/palitra-app-20261015/capture")
CABINET_PARENT = Path("/opt/synapse/sites/synapse")
MAX_FILE = 16 * 1024 * 1024
SHA = re.compile(r"^[0-9a-f]{64}$")
IMAGE = re.compile(r"^sha256:[0-9a-f]{64}$")
EXISTING = ("server.js", "client-dialogs.js", "palitra-host-adapter.cjs")
PRESERVED = ("site-orders.js", "draft-account-service.cjs")
INGRESS = ("site-workspace-http.js", "site-workspace-feature.js")
ABSENT = ("customer-chat.js", "customer-chat-http.cjs", "customer-chat-native-adapter.cjs",
          "customer-chat-media.cjs", "customer-chat-upload.cjs",
          "palitra-review-public/palitra-chat.html", "palitra-review-public/palitra-chat.js",
          "palitra-review-public/palitra-chat.css")
CRM = tuple("palitra-crm/app/lib/" + name for name in (
    "api-routes.js", "crm-access.js", "crm-http.js", "email-address.js", "email-fallback.js",
    "email-transport.js", "host-integration.js", "instagram-hook.js", "team-notify.js",
    "telegram-team-transport.js", "workspace.js")) + tuple(
    "palitra-crm/app/public/" + name for name in ("app.css", "app.js", "crm-session.js", "miniapp.html", "site.html")) + (
    "palitra-crm/telegram-ingest/lib/telegram-ingest.js",)
CABINET = tuple("cabinet/palitra-work." + extension for extension in ("html", "js", "css"))
NAVIGATION = ("cabinet.html", "cabinet/menu-preferences.js", "cabinet/module-guide.js")
WORKER_FILE = "client-bot-bridge.js"
MANAGED_TARGET = "managed-site/assets/order.js"
MANAGED_BUILDER_BASE = "f3fb7853f8c3db9e2897bbfb497624ac18a6dad7df0bfbddc02e0c8586782173"

# Fixed program reads only one explicit allowlisted path, does not require project modules.
# Ancestor lstat and O_NOFOLLOW reject links; before/after stats detect a changed file.
NODE_READ = r"""'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const p=process.argv[1],limit=16*1024*1024;
const allowed=new Set(ALLOWLIST);
function refuse(){process.stderr.write('CAPTURE_READ_REFUSED\n');process.exit(31)}
try {
 if(!allowed.has(p)||!path.isAbsolute(p)||path.normalize(p)!==p)refuse();
 const parts=p.split('/').filter(Boolean);let current='';let missing=false;
 for(let i=0;i<parts.length;i++){
  current+='/'+parts[i];let s;
  try{s=fs.lstatSync(current)}catch(e){if(e.code==='ENOENT'){missing=true;break}throw e}
  if(s.isSymbolicLink()||(i<parts.length-1&&!s.isDirectory()))refuse();
 }
 if(missing){process.stdout.write(JSON.stringify({status:'absent'}));process.exit(0)}
 const fd=fs.openSync(p,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
 try {
  const before=fs.fstatSync(fd);if(!before.isFile()||before.size===0||before.size>limit)refuse();
  const data=fs.readFileSync(fd),after=fs.fstatSync(fd),named=fs.lstatSync(p);
  if(named.isSymbolicLink()||before.dev!==named.dev||before.ino!==named.ino||
     before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||
     before.mtimeMs!==after.mtimeMs||data.length!==before.size||fs.realpathSync(p)!==p)refuse();
  process.stdout.write(JSON.stringify({status:'file',bytes:data.length,
    sha256:crypto.createHash('sha256').update(data).digest('hex'),data:data.toString('base64')}));
 }finally{fs.closeSync(fd)}
}catch(e){refuse()}
"""


class Refused(Exception):
    pass


def need(condition, message):
    if not condition:
        raise Refused(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def safe_chain(path, leaf_required=True):
    path = Path(path)
    need(path.is_absolute() and ".." not in path.parts, "Нужен абсолютный путь без ..")
    for item in [*reversed(path.parents), path]:
        try:
            info = item.lstat()
        except FileNotFoundError:
            need(item == path and not leaf_required, "Отсутствует каталог/обязательный файл")
            continue
        need(not stat.S_ISLNK(info.st_mode) and not (getattr(info, "st_file_attributes", 0) & 0x400),
             "Symlink/reparse запрещён")
        if item != path:
            need(stat.S_ISDIR(info.st_mode), "Предок не является каталогом")
    return path


def read_host(path):
    path = safe_chain(path)
    info = path.lstat()
    need(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= MAX_FILE, "Неверный host source")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        before = os.fstat(fd)
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(MAX_FILE + 1)
        after = os.fstat(fd)
        named = safe_chain(path).lstat()
        need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
             (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), "Host source изменился")
        need((before.st_dev, before.st_ino) == (named.st_dev, named.st_ino) and
             len(data) == before.st_size and len(data) <= MAX_FILE, "Host source заменён")
        return data
    finally:
        os.close(fd)


def unique_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            need(key not in result, "Повтор JSON key")
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=pairs)
    except (ValueError, UnicodeError):
        raise Refused("Некорректный ответ capture") from None


class DockerReader:
    def __init__(self, runner=subprocess.run):
        self.runner = runner
        self.allowed = {"synapse-content-1": tuple("/app/" + p for p in EXISTING + PRESERVED + INGRESS + ABSENT + CRM),
                        "synapse-chat-1": ("/app/" + WORKER_FILE,)}

    def run(self, arguments):
        try:
            result = self.runner(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, check=False, timeout=45, shell=False)
        except (OSError, subprocess.TimeoutExpired):
            raise Refused("Штатное readonly Docker-чтение недоступно") from None
        need(result.returncode == 0, "Штатное readonly Docker-чтение отказало")
        need(isinstance(result.stdout, bytes), "Некорректный Docker stdout")
        return result.stdout

    def image(self, container):
        need(container in self.allowed, "Контейнер вне allowlist")
        raw = self.run(["docker", "inspect", "--format", "{{.Image}}", container])
        try:
            value = raw.decode("ascii").strip()
        except UnicodeError:
            raise Refused("Некорректный immutable image") from None
        need(IMAGE.fullmatch(value), "Нужен полный immutable image SHA")
        return value

    def read(self, container, relative):
        pathname = "/app/" + relative
        need(container in self.allowed and pathname in self.allowed[container], "Source вне allowlist")
        program = NODE_READ.replace("ALLOWLIST", json.dumps(self.allowed[container]))
        raw = self.run(["docker", "exec", container, "node", "-e", program, "--", pathname])
        need(len(raw) <= MAX_FILE * 4 // 3 + 4096, "Ответ Docker слишком большой")
        record = unique_json(raw)
        if record == {"status": "absent"}:
            return None
        need(isinstance(record, dict) and set(record) == {"status", "bytes", "sha256", "data"} and
             record["status"] == "file" and type(record["bytes"]) is int and
             0 < record["bytes"] <= MAX_FILE and isinstance(record["sha256"], str) and
             SHA.fullmatch(record["sha256"]) and isinstance(record["data"], str), "Неверная source запись")
        try:
            data = base64.b64decode(record["data"], validate=True)
        except ValueError:
            raise Refused("Неверные source bytes") from None
        need(len(data) == record["bytes"] and digest(data) == record["sha256"], "Source bytes/SHA mismatch")
        return data


def check_images(reader, expected_worker_image):
    need(expected_worker_image == WORKER_IMAGE, "Независимый worker image не совпал с Root proof")
    need(reader.image("synapse-content-1") == CONTENT_IMAGE, "Неожиданный content image")
    need(reader.image("synapse-chat-1") == expected_worker_image, "Неожиданный worker image")


def capture(*, output, expected_worker_image, managed_root=None, no_managed=False,
            root_approved=False, reader=None, capture_parent=CAPTURE_PARENT, cabinet_parent=CABINET_PARENT):
    """Injected roots/reader are for isolated tests; CLI has fixed native roots."""
    need((managed_root is not None) != bool(no_managed), "Укажите --managed-root или --no-managed")
    need(not root_approved or not no_managed, "Partial capture не является Root approval")
    reader = reader or DockerReader()
    parent = safe_chain(capture_parent)
    need(parent.is_dir(), "Capture parent отсутствует")
    output = safe_chain(output, leaf_required=False)
    need(output.parent == parent and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", output.name),
         "Output должен быть новым прямым дочерним каталогом capture")
    need(not output.exists(), "Existing output не перезаписывается")
    cabinet_parent = safe_chain(cabinet_parent)
    need(cabinet_parent.is_dir(), "Cabinet root отсутствует")
    if managed_root is not None:
        managed_root = safe_chain(managed_root)
        need(managed_root.is_dir() and managed_root != Path(managed_root.anchor), "Нужен explicit published root")
    check_images(reader, expected_worker_image)
    remote = {}
    for relative in EXISTING + PRESERVED + INGRESS + ABSENT + CRM:
        data = reader.read("synapse-content-1", relative)
        if relative in ABSENT:
            need(data is None, "Ожидаемый новый E target уже существует: " + relative)
        elif relative not in CRM:
            need(data is not None, "Обязательный content source отсутствует: " + relative)
        remote[("synapse-content-1", relative)] = data
    worker = reader.read("synapse-chat-1", WORKER_FILE)
    need(worker is not None, "Existing worker source отсутствует")
    remote[("synapse-chat-1", WORKER_FILE)] = worker
    host = {}
    for relative in CABINET + NAVIGATION:
        host[relative] = read_host(cabinet_parent / relative)
    managed = read_host(managed_root / "assets/order.js") if managed_root is not None else None
    # A second complete read, including absences, rejects a modified source/partial install.
    for (container, relative), data in remote.items():
        need(reader.read(container, relative) == data, "Runtime source изменился после чтения: " + relative)
    for relative, data in host.items():
        need(read_host(cabinet_parent / relative) == data, "Cabinet source изменился после чтения")
    if managed_root is not None:
        need(read_host(managed_root / "assets/order.js") == managed, "Managed source изменился после чтения")
    check_images(reader, expected_worker_image)
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    snapshots = {}
    inventory = []

    def row(target, source, data, include_bytes=False):
        item = {"target": target, "source": source, "sha256": None if data is None else digest(data)}
        if include_bytes:
            item["bytes"] = len(data) if data is not None else None
        if data is not None:
            snapshots[source] = data
        inventory.append({**item, "bytes": 0 if data is None else len(data), "absent": data is None})
        return item

    runtime_rows = [row("content/" + p, "runtime-snapshot/content/" + p,
                        remote[("synapse-content-1", p)]) for p in EXISTING + ABSENT]
    preserved_rows = [row("content/" + p, "runtime-snapshot/content/" + p,
                          remote[("synapse-content-1", p)]) for p in PRESERVED]
    for p in INGRESS + CRM:
        row("content/" + p, "extra-snapshot/content/" + p, remote[("synapse-content-1", p)])
    static_rows = [row("sites/synapse/" + p, "static-snapshot/sites/synapse/" + p, host[p]) for p in CABINET]
    for p in NAVIGATION:
        row("sites/synapse/" + p, "extra-snapshot/sites/synapse/" + p, host[p])
    if managed is not None:
        static_rows.append(row(MANAGED_TARGET, "static-snapshot/" + MANAGED_TARGET, managed))
    worker_rows = [row("ops/chat/" + WORKER_FILE, "worker-snapshot/ops/chat/" + WORKER_FILE, worker, True)]
    managed_pin_ok = managed is not None and digest(managed) == MANAGED_BUILDER_BASE
    need(not root_approved or managed_pin_ok, "Builder managed BASE pin не совпал; approval запрещён")
    common = {"schema": 1, "root_approved": bool(root_approved), "captured_at": stamp}
    manifests = {
        "runtime-base.json": {**common, "image_id": CONTENT_IMAGE, "targets": runtime_rows, "preserved": preserved_rows},
        "worker-base.json": {**common, "image_id": expected_worker_image, "targets": worker_rows},
    }
    if managed is not None:
        manifests["static-base.json"] = {**common, "targets": static_rows}
    else:
        manifests["cabinet-partial.json"] = {**common, "targets": static_rows}
    evidence = {"schema": 1, "status": "CAPTURE_ONLY", "captured_at": stamp,
                "content_image": CONTENT_IMAGE, "worker_image": expected_worker_image,
                "managed_root": str(managed_root) if managed_root is not None else None,
                "managed_pending": no_managed, "inventory": inventory,
                "absenceProof": {"twice_checked": True, "targets": ["content/" + p for p in ABSENT]},
                "compatibility": {"builder_manifest_shapes": not no_managed,
                                  "managed_builder_pin_matches": managed_pin_ok,
                                  "crm_present": sum(remote[("synapse-content-1", p)] is not None for p in CRM),
                                  "crm_expected": len(CRM), "native_lease_proof": False,
                                  "installed": False, "network_requests": 0}}
    manifests["capture-manifest.json"] = evidence
    for name, value in manifests.items():
        snapshots[name] = json_bytes(value)
    # No path is written before every required preflight/reread has passed.
    safe_chain(output, leaf_required=False)
    need(not output.exists(), "Output появился во время preflight")
    output.mkdir(mode=0o700)
    for relative, data in snapshots.items():
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        safe_chain(destination, leaf_required=False)
        with destination.open("xb") as stream:
            stream.write(data)
        if os.name == "posix":
            destination.chmod(0o600)
        need(read_host(destination) == data, "Capture output byte readback mismatch")
    return {"status": "CAPTURE_ONLY", "output": str(output), "files": len(snapshots),
            "capture_manifest_sha256": digest(snapshots["capture-manifest.json"]),
            "content_image": CONTENT_IMAGE, "worker_image": expected_worker_image,
            "managed_pending": no_managed, "root_approved": bool(root_approved)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--expected-worker-image", required=True)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--managed-root")
    group.add_argument("--no-managed", action="store_true")
    parser.add_argument("--root-approved", action="store_true",
                        help="Только после личного подтверждения Root; partial/pin mismatch откажут")
    args = parser.parse_args(argv)
    try:
        result = capture(output=Path(args.output), expected_worker_image=args.expected_worker_image,
                         managed_root=Path(args.managed_root) if args.managed_root else None,
                         no_managed=args.no_managed, root_approved=args.root_approved)
    except Refused as error:
        print(json.dumps({"status": "REFUSED", "reason": str(error)}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
