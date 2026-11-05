#!/usr/bin/env python3
"""Локальная exact-byte упаковка одобренных Root исходников Palitra. Не installer."""
import argparse
import hashlib
import json
import re
import stat
from datetime import datetime
from pathlib import Path, PurePosixPath

IMAGE_ID = "sha256:8a98cf8656cc139e6cbb842f81bc05e20c534065b2274063629b18c32db3fa72"
INSTALLER_SHA = "65cc42f09b44aa91f97ff5ac620ed758f31105f0c565c06484fa0838203a86f0"
ORDER_SHA = "230f1c13bf7a78bb4f0c6d19455d1dcad39384ad0d3b600c48ce43d2018b6553"
ORDER_BASE_SHA = "f3fb7853f8c3db9e2897bbfb497624ac18a6dad7df0bfbddc02e0c8586782173"
SHA = re.compile(r"^[0-9a-f]{64}$")
IMAGE_SHA = re.compile(r"^sha256:[0-9a-f]{64}$")
PACKAGE_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")
BACKEND = tuple("content/" + name for name in (
    "server.js", "client-dialogs.js", "palitra-host-adapter.cjs", "customer-chat.js",
    "customer-chat-http.cjs", "customer-chat-native-adapter.cjs", "customer-chat-media.cjs", "customer-chat-upload.cjs"))
PUBLIC = tuple("content/palitra-review-public/" + name for name in (
    "palitra-chat.html", "palitra-chat.js", "palitra-chat.css"))
CABINET = tuple("sites/synapse/cabinet/" + name for name in (
    "palitra-work.html", "palitra-work.js", "palitra-work.css"))
MANAGED = "managed-site/assets/order.js"
IMAGE_TARGETS = BACKEND + PUBLIC
WORKER_TARGETS = ("ops/chat/client-bot-bridge.js",)
TARGETS = IMAGE_TARGETS + WORKER_TARGETS + CABINET + (MANAGED,)
EXISTING_RUNTIME = {"content/server.js", "content/client-dialogs.js", "content/palitra-host-adapter.cjs"}
PRESERVED = {"content/site-orders.js", "content/draft-account-service.cjs"}
MAX_JSON = 256 * 1024
MAX_SOURCE = 16 * 1024 * 1024


class Refused(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_chain(path):
    path = Path(path)
    require(path.is_absolute(), "Нужен явный абсолютный путь")
    require(".." not in path.parts, "Путь содержит ..")
    for part in [*reversed(path.parents), path]:
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        require(not stat.S_ISLNK(info.st_mode) and not (getattr(info, "st_file_attributes", 0) & 0x400),
                "Symlink/reparse point запрещён")
        if part != path:
            require(stat.S_ISDIR(info.st_mode), "Предок не является каталогом")
    return path


def root_dir(path):
    path = safe_chain(path)
    require(path.is_dir(), "Исходный каталог отсутствует")
    return path.resolve()


def relative(value):
    require(isinstance(value, str) and value and "\\" not in value and ":" not in value
            and not any(ord(c) < 32 for c in value), "Неканонический relative path")
    path = PurePosixPath(value)
    require(not path.is_absolute() and str(path) == value
            and all(p not in {"", ".", ".."} for p in value.split("/")), "Путь выходит из source")
    return path


def contained(root, name):
    path = safe_chain(root.joinpath(*relative(name).parts))
    require(path.resolve(strict=False).is_relative_to(root), "Путь выходит из source root")
    return path


def input_file(root, path):
    path = safe_chain(path)
    require(path.resolve(strict=False).is_relative_to(root), "Manifest вне своего root")
    return path


def read_file(path, limit):
    path = safe_chain(path)
    try:
        info = path.lstat()
    except FileNotFoundError:
        raise Refused("Не найден обязательный входной файл") from None
    require(stat.S_ISREG(info.st_mode), "Вход не является regular file")
    require(info.st_size <= limit, "Размер входного файла превышает предел упаковщика")
    data = path.read_bytes()
    require(len(data) <= limit, "Размер входного файла изменился")
    return data


def keys(value, expected, message):
    require(isinstance(value, dict) and set(value) == set(expected), message)


def load_json(path, snapshots):
    data = read_file(path, MAX_JSON)
    snapshots[path] = digest(data)

    def unique(pairs):
        obj = {}
        for key, value in pairs:
            require(key not in obj, "Повтор JSON key")
            obj[key] = value
        return obj

    try:
        return json.loads(data.decode("utf-8-sig"), object_pairs_hook=unique)
    except (ValueError, UnicodeError):
        raise Refused("Некорректный UTF-8 JSON manifest") from None


def rows_by_target(rows, expected, row_keys):
    require(isinstance(rows, list) and len(rows) == len(expected), "Неполный/лишний target set")
    found = {}
    for row in rows:
        keys(row, row_keys, "Некорректная target entry")
        target = row["target"]
        require(isinstance(target, str) and target in expected and target not in found, "Target вне whitelist/дублирован")
        relative(row["source"])
        require(PurePosixPath(row["source"]).name == PurePosixPath(target).name, "Source basename не совпадает с target")
        found[target] = row
    require(set(found) == set(expected), "Manifest не задаёт exact target list")
    return found


def captured_at(value):
    require(isinstance(value, str), "Нужен Root timestamp BASE")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise Refused("Некорректный BASE timestamp") from None
    require(parsed.tzinfo is not None, "BASE timestamp без timezone")


def base_bytes(root, rows, snapshots, allow_absence):
    for target, row in rows.items():
        path = contained(root, row["source"])
        value = row["sha256"]
        if value is None:
            require(target in allow_absence, "Отсутствие допустимо только для новых image targets")
            require(not path.exists(), "Absence guard: BASE snapshot файл существует")
            snapshots[path] = None
        else:
            require(isinstance(value, str) and SHA.fullmatch(value), "Некорректный BASE SHA")
            data = read_file(path, MAX_SOURCE)
            require(digest(data) == value, "BASE bytes/SHA mismatch: " + target)
            if "bytes" in row:
                require(type(row["bytes"]) is int and 0 < row["bytes"] <= MAX_SOURCE
                        and len(data) == row["bytes"], "BASE bytes length mismatch: " + target)
            snapshots[path] = value


def write_json(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def prepare(source_root, source_manifest, base_root, runtime_manifest, static_manifest, installer, output,
            worker_base_manifest, expected_worker_image):
    source_root, base_root = root_dir(source_root), root_dir(base_root)
    require(not source_root.is_relative_to(base_root) and not base_root.is_relative_to(source_root), "SOURCE и BASE пересекаются")
    output = safe_chain(output)
    require(not output.exists(), "Выход уже существует; ничего не перезаписывается")
    require(output.parent.is_dir(), "Родитель OUTPUT должен существовать")
    for root in (source_root, base_root, Path(__file__).resolve().parent):
        require(not output.resolve(strict=False).is_relative_to(root)
                and not root.is_relative_to(output.resolve(strict=False)), "OUTPUT пересекается с входами/scaffold")
    source_manifest = input_file(source_root, source_manifest)
    runtime_manifest = input_file(base_root, runtime_manifest)
    static_manifest = input_file(base_root, static_manifest)
    worker_base_manifest = input_file(base_root, worker_base_manifest)
    installer = safe_chain(installer)
    require(not output.resolve(strict=False).is_relative_to(installer.parent.resolve()), "OUTPUT внутри installer reference")
    snapshots = {}
    source = load_json(source_manifest, snapshots)
    keys(source, {"schema", "package_id", "approved_finished", "targets"}, "Нужен явный Root finished-source manifest")
    require(type(source["schema"]) is int and source["schema"] == 1 and source["approved_finished"] is True,
            "Исходники не объявлены Root approved/finished")
    package_id = source["package_id"]
    require(isinstance(package_id, str) and PACKAGE_ID.fullmatch(package_id)
            and package_id != "palitra-app-workplace-20261013", "Нужен новый package_id")
    source_rows = rows_by_target(source["targets"], TARGETS, {"target", "source", "sha256", "bytes"})
    runtime = load_json(runtime_manifest, snapshots)
    keys(runtime, {"schema", "root_approved", "captured_at", "image_id", "targets", "preserved"}, "Некорректный runtime BASE manifest")
    require(type(runtime["schema"]) is int and runtime["schema"] == 1 and runtime["root_approved"] is True,
            "Runtime BASE не подтверждён Root")
    captured_at(runtime["captured_at"])
    require(runtime["image_id"] == IMAGE_ID, "Immutable image BASE не совпал с captured8a98cf")
    runtime_rows = rows_by_target(runtime["targets"], IMAGE_TARGETS, {"target", "source", "sha256"})
    require(all(runtime_rows[t]["sha256"] is not None for t in EXISTING_RUNTIME), "Потерян обязательный runtime BASE")
    require(all(runtime_rows[t]["sha256"] is None for t in set(IMAGE_TARGETS) - EXISTING_RUNTIME),
            "Новые image targets требуют явного absence proof этого BASE")
    preserved_rows = rows_by_target(runtime["preserved"], PRESERVED, {"target", "source", "sha256"})
    base_bytes(base_root, runtime_rows, snapshots, set(IMAGE_TARGETS) - EXISTING_RUNTIME)
    base_bytes(base_root, preserved_rows, snapshots, set())
    # Existing worker: Root передаёт fresh image отдельно от manifest; неизвестный image не угадывается.
    require(isinstance(expected_worker_image, str) and IMAGE_SHA.fullmatch(expected_worker_image),
            "Нужен полный trusted Root worker image SHA64")
    require(expected_worker_image != IMAGE_ID, "Content и worker BASE images должны быть раздельными")
    worker = load_json(worker_base_manifest, snapshots)
    keys(worker, {"schema", "root_approved", "captured_at", "image_id", "targets"},
         "Некорректный worker BASE manifest")
    require(type(worker["schema"]) is int and worker["schema"] == 1 and worker["root_approved"] is True,
            "Worker BASE не подтверждён Root")
    captured_at(worker["captured_at"])
    require(worker["image_id"] == expected_worker_image, "Worker image не совпал с отдельным trusted Root input")
    worker_rows = rows_by_target(worker["targets"], WORKER_TARGETS, {"target", "source", "sha256", "bytes"})
    require(all(row["sha256"] is not None for row in worker_rows.values()), "Existing worker BASE не может отсутствовать")
    base_bytes(base_root, worker_rows, snapshots, set())
    static = load_json(static_manifest, snapshots)
    keys(static, {"schema", "root_approved", "captured_at", "targets"}, "Некорректный static/managed BASE manifest")
    require(type(static["schema"]) is int and static["schema"] == 1 and static["root_approved"] is True,
            "Static BASE не подтверждён Root")
    captured_at(static["captured_at"])
    static_rows = rows_by_target(static["targets"], CABINET + (MANAGED,), {"target", "source", "sha256"})
    base_bytes(base_root, static_rows, snapshots, set())
    require(static_rows[MANAGED]["sha256"] == ORDER_BASE_SHA, "Managed order BASE не равен nativef3fb")
    payloads = {}
    used_sources = set()
    for target in TARGETS:
        row = source_rows[target]
        require(isinstance(row["sha256"], str) and SHA.fullmatch(row["sha256"]), "Некорректный source SHA")
        require(type(row["bytes"]) is int and 0 <= row["bytes"] <= MAX_SOURCE, "Некорректный source bytes")
        path = contained(source_root, row["source"])
        require(str(path).casefold() not in used_sources, "Повтор source path")
        used_sources.add(str(path).casefold())
        data = read_file(path, MAX_SOURCE)
        require(digest(data) == row["sha256"] and len(data) == row["bytes"], "Source bytes/SHA mismatch: " + target)
        payloads["payload/" + target] = data
        snapshots[path] = row["sha256"]
    require(source_rows[MANAGED]["sha256"] == ORDER_SHA, "Managed order кандидат не равен acceptedC230f")
    require(all(source_rows[t]["sha256"] != static_rows[t]["sha256"] for t in CABINET), "Cabinet no-op target запрещён helper")
    helper = read_file(installer, MAX_SOURCE)
    require(digest(helper) == INSTALLER_SHA, "Guarded installer reference SHA mismatch")
    snapshots[installer] = INSTALLER_SHA
    cabinet_manifest = {"schema": 1, "package_id": package_id, "targets": [
        {"group": "static", "target": t, "source": "payload/" + t,
         "base_sha256": static_rows[t]["sha256"], "sha256": source_rows[t]["sha256"]} for t in CABINET]}
    docker = "FROM " + IMAGE_ID + "\n" + "".join(
        "COPY payload/" + t + " /app/" + t.removeprefix("content/") + "\n" for t in IMAGE_TARGETS)
    worker_docker = "FROM " + expected_worker_image + "\nCOPY payload/ops/chat/client-bot-bridge.js /app/client-bot-bridge.js\n"
    managed = {"schema": 1, "package_id": package_id, "installation": "Root native owner/CAS only",
               "target": "assets/order.js", "source": "payload/" + MANAGED,
               "base_sha256": ORDER_BASE_SHA, "sha256": ORDER_SHA,
               "bytes": source_rows[MANAGED]["bytes"], "revision": "Root fresh257+ required"}
    payloads.update({"install.py": helper, "manifest.json": write_json(cabinet_manifest),
                      "Dockerfile": docker.encode("ascii"), "Dockerfile.worker": worker_docker.encode("ascii"),
                      "managed-site.json": write_json(managed), "worker-base.json": write_json(worker),
                      "runtime-base.json": write_json(runtime), "static-base.json": write_json(static)})
    index = {"schema": 1, "package_id": package_id, "kind": "local exact-byte bundle; Root review required",
              "base_image_id": IMAGE_ID, "worker_base_image_id": expected_worker_image,
              "dockerfiles": {"content": "Dockerfile", "worker": "Dockerfile.worker"}, "approved_input_sha256": {
                 "source_manifest": snapshots[source_manifest], "runtime_base_manifest": snapshots[runtime_manifest],
                  "static_base_manifest": snapshots[static_manifest], "worker_base_manifest": snapshots[worker_base_manifest]},
              "image_targets": list(IMAGE_TARGETS), "worker_targets": list(WORKER_TARGETS),
              "cabinet_targets": list(CABINET), "managed_target": MANAGED,
             "files": [{"path": name, "sha256": digest(data), "bytes": len(data)} for name, data in sorted(payloads.items())]}
    payloads["BUNDLE.json"] = write_json(index)
    return output, payloads, snapshots, package_id


def check_inputs(snapshots):
    for path, expected in snapshots.items():
        safe_chain(path)
        if expected is None:
            require(not path.exists(), "Absence guard изменился")
        else:
            require(digest(read_file(path, MAX_SOURCE)) == expected, "Вход изменился после preflight")


def assemble(*, source_root, source_manifest, base_root, runtime_manifest, static_manifest, installer, output,
             worker_base_manifest, expected_worker_image, check=False):
    output, payloads, snapshots, package_id = prepare(
        source_root, source_manifest, base_root, runtime_manifest, static_manifest, installer, output,
        worker_base_manifest, expected_worker_image)
    check_inputs(snapshots)
    if check:
        return {"package_id": package_id, "mode": "read_only", "image_targets": 11, "worker_targets": 1,
                "cabinet_targets": 3, "managed_targets": 1, "payload_targets": 16}
    # До mkdir все входы проверены. Существующий/partial OUTPUT никогда не заменяется.
    output.mkdir(exist_ok=False)
    try:
        for name, data in payloads.items():
            target = contained(output.resolve(), name)
            target.parent.mkdir(parents=True, exist_ok=True)
            safe_chain(target)
            with target.open("xb") as stream:
                stream.write(data)
            require(read_file(target, MAX_SOURCE) == data, "Output byte readback mismatch")
        check_inputs(snapshots)
    except BaseException:
        # Собственный partial OUTPUT оставлен для осмотра; нет удаления/неизвестного повторного apply.
        raise
    return {"package_id": package_id, "mode": "assembled_local", "image_targets": 11, "worker_targets": 1,
            "cabinet_targets": 3, "managed_targets": 1, "payload_targets": 16,
            "bundle_sha256": digest(payloads["BUNDLE.json"])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source-root", "source-manifest", "base-root", "runtime-manifest", "static-manifest", "worker-base-manifest", "installer", "output"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--expected-worker-image", required=True,
                        help="Отдельный trusted Root input sha256:<64 lowercase hex> из fresh native image proof")
    parser.add_argument("--check", action="store_true", help="Только локальный preflight; OUTPUT не создаётся")
    args = parser.parse_args()
    try:
        print(json.dumps(assemble(**vars(args)), ensure_ascii=False))
    except (Refused, OSError) as error:
        parser.exit(2, "REFUSED: " + str(error) + "\n")


if __name__ == "__main__":
    main()
