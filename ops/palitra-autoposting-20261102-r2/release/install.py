#!/usr/bin/env python3
"""Палитра r2 (02.11.2026): автопостинг пяти площадок, параметры Onlypult и форма публикации.

Режимы:  check             — только чтение, ничего не пишет;
         apply             — резервная копия, точечная установка, проверка, автооткат при сбое;
         rollback DIR      — вернуть всё из резервной копии DIR.
Отправка на площадки не включается и ничего не публикуется.
"""
import datetime, fcntl, hashlib, json, os, pathlib, re, shutil, subprocess, sys, time, urllib.request

HERE = pathlib.Path(__file__).resolve().parent
BUNDLE = json.loads((HERE / "bundle.json").read_text(encoding="utf-8"))
CONTAINER = "synapse-crm-1"
IMAGE_PREFIX = "sha256:b74d9196617c"
CORE_PREFIX = "caf1675a"
TRANSPORT = "c658463a093f9ffd9c45a3b2fdd8fce321b72bd3384d9bac7143963b0db396a7"
STAMP = "20261102-claude-r2"
PUBLIC = "https://synapse.synapsebusiness.ru/cabinet/palitra-orders/"
LOCK = "/opt/synapse/.palitra-app-release.lock"
SEARCH_ROOTS = ["/opt", "/srv", "/var/www", "/var/lib/docker/volumes", "/root", "/home"]
NEW_CSS = "palitra-content-layout.css"
LOG = []


class Refused(Exception):
    pass


def say(*parts):
    line = " ".join(str(p) for p in parts)
    LOG.append(line)
    print(line, flush=True)


def need(ok, code):
    if not ok:
        raise Refused(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def run(args, data=None, timeout=120):
    r = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    if r.returncode != 0:
        raise Refused("CMD_FAILED " + " ".join(args[:4]) + " :: " + r.stderr.decode("utf-8", "replace")[-200:].replace("\n", " "))
    return r.stdout


def patch(text, patches, label):
    out = text
    for p in patches:
        need(out.count(p["before"]) == 1, "CONTEXT_" + label)
        out = out.replace(p["before"], p["after"], 1)
    back = out
    for p in reversed(patches):
        need(back.count(p["after"]) == 1, "REVERSE_" + label)
        back = back.replace(p["after"], p["before"], 1)
    need(back == text, "UNRELATED_" + label)
    return out


TEST_PUBLIC = os.environ.get("PALITRA_R2_TEST_PUBLIC_DIR")  # только для локального прогона установщика


def fetch(url):
    if TEST_PUBLIC:
        return (pathlib.Path(TEST_PUBLIC) / url[len(PUBLIC):].split("?")[0]).read_bytes()
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache", "User-Agent": "palitra-r2-check"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


# ---------- статические файлы кабинета ----------
def static_names():
    return list(BUNDLE["static"].keys())


def find_static_dir():
    want = {name: spec["liveSha"] for name, spec in BUNDLE["static"].items()}
    found, partial = [], []
    for root in SEARCH_ROOTS:
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in ("node_modules", ".git", "overlay2", "proc") and not d.startswith("palitra-r2-backup-")]
            if "cabinet.html" not in filenames or "palitra-publication-composer.js" not in filenames:
                continue
            d = pathlib.Path(dirpath)
            okhtml = sha((d / "cabinet.html").read_bytes()) == BUNDLE["cabinetHtmlSha"]
            hits = sum(1 for n, s in want.items() if (d / n).is_file() and sha((d / n).read_bytes()) == s)
            (found if okhtml and hits == len(want) else partial).append((str(d), okhtml, hits))
    return found, partial


def check_public_live():
    bad = []
    html = fetch(PUBLIC + "cabinet.html")
    if sha(html) != BUNDLE["cabinetHtmlSha"]:
        bad.append("cabinet.html")
    for name, spec in BUNDLE["static"].items():
        if sha(fetch(PUBLIC + name + "?nocache=" + str(time.time()))) != spec["liveSha"]:
            bad.append(name)
    return bad


def new_cabinet_html(text):
    for name in static_names():
        rx = re.compile(r'((?:src|href)=")' + re.escape(name) + r'\?v=[^"]*"')
        need(len(rx.findall(text)) == 1, "HTML_REF_" + name)
        text = rx.sub(lambda m: m.group(1) + name + "?v=" + STAMP + '"', text, count=1)
    anchor = re.compile(r'(<link rel="stylesheet" href="palitra-content-plan-ui\.css\?v=[^"]*">\n)')
    need(len(anchor.findall(text)) == 1 and NEW_CSS not in text, "HTML_ANCHOR")
    return anchor.sub(lambda m: m.group(1) + '<link rel="stylesheet" href="' + NEW_CSS + "?v=" + STAMP + '">\n', text, count=1)


# ---------- CRM ----------
def container_identity():
    ident = run(["docker", "inspect", CONTAINER, "--format", "{{.Id}}|{{.Image}}|{{.State.Running}}|{{.RestartCount}}|{{.State.StartedAt}}"]).decode().strip().split("|")
    need(len(ident) == 5 and ident[1].startswith(IMAGE_PREFIX), "IMAGE_CHANGED")
    need(ident[2] == "true", "CRM_NOT_RUNNING")
    return ident


def app_file(name):
    return run(["docker", "exec", CONTAINER, "cat", "/app/" + name])


def app_stat(name):
    return run(["docker", "exec", CONTAINER, "stat", "-c", "%u:%g %a", "/app/" + name]).decode().split()


def node_check(data, label):
    run(["docker", "exec", "-i", CONTAINER, "node", "--check"], data)
    say("  синтаксис", label, "PASS")


SCHEMA_JS = r"""
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/data/crm.sqlite',{readOnly:true});
const owner=db.prepare('SELECT id FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get('palitra-love');
if(!owner)throw Error('COMPANY_SCOPE');
const ch=db.prepare('SELECT id,provider,enabled,status FROM autoposting_channels WHERE company_code=? COLLATE NOCASE ORDER BY id').all('palitra-love');
const st=db.prepare('SELECT status,count(*) n FROM autoposting_posts WHERE company_id=? GROUP BY status ORDER BY status').all(owner.id);
console.log(JSON.stringify({channels:ch.map(c=>c.id+':'+(c.provider||'direct')+':'+(c.enabled?'on':'off')+':'+c.status),statuses:st.map(s=>s.status+'='+s.n)}));
db.close();
"""


def plan():
    """Всё, что можно проверить без записи. Возвращает подготовленную установку."""
    need(os.geteuid() == 0, "ROOT_REQUIRED")
    say("1. Сервер и CRM")
    ident = container_identity()
    say("  контейнер", ident[0][:12], "образ", ident[1][7:19], "перезапусков", ident[3])
    core = app_file("autoposting.js")
    provider = app_file("onlypult-provider.js")
    transport = app_file("autoposting-transport.js")
    say("  ядро", sha(core)[:12], len(core), "B; провайдер", sha(provider)[:12], "; транспорт", sha(transport)[:12])
    need(sha(core).startswith(os.environ.get("PALITRA_R2_TEST_CORE_PREFIX") or CORE_PREFIX), "CORE_CHANGED")
    need(sha(provider) == BUNDLE["provider"]["liveSha"], "PROVIDER_CHANGED")
    need(sha(transport) == TRANSPORT, "TRANSPORT_CHANGED")
    text = core.decode("utf-8")
    text = patch(text, BUNDLE["core"]["r1"], "CORE_R1")
    text = patch(text, BUNDLE["core"]["r2"], "CORE_R2")
    need(re.search(r"\bPLAN_PLATFORMS\s*=", text) is not None, "PLAN_PLATFORMS_MISSING")
    need("function createPublishedCopy" in text or b"function createPublishedCopy" not in core, "PUBLISHED_COPY_LOST")
    new_core = text.encode("utf-8")
    new_provider = patch(provider.decode("utf-8"), BUNDLE["provider"]["patches"], "PROVIDER").encode("utf-8")
    need(sha(new_provider) == BUNDLE["provider"]["afterSha"], "PROVIDER_RESULT")
    node_check(new_core, "ядра")
    node_check(new_provider, "провайдера")
    say("  ядро после правок", sha(new_core)[:12], len(new_core), "B")
    stats = {n: app_stat(n) for n in ("autoposting.js", "onlypult-provider.js")}
    db = json.loads(run(["docker", "exec", "-i", CONTAINER, "node", "-"], SCHEMA_JS.encode()))
    say("  каналы Палитры:", " ".join(db["channels"]))
    say("  публикации Палитры:", " ".join(db["statuses"]) or "нет")

    say("2. Файлы кабинета")
    found, partial = find_static_dir()
    for p in partial[:4]:
        say("  похожий каталог (не совпал):", p[0], "html" if p[1] else "-", p[2])
    need(len(found) == 1, "STATIC_DIR_" + str(len(found)))
    sdir = pathlib.Path(found[0][0])
    say("  каталог:", sdir)
    bad = check_public_live()
    need(not bad, "PUBLIC_DIFFERS_" + ",".join(bad))
    say("  опубликованные файлы совпадают с каталогом: да")
    tracked = None
    try:
        rel = sdir.relative_to("/opt/synapse")
        r = subprocess.run(["git", "-C", "/opt/synapse", "ls-files", "--error-unmatch", str(rel / "cabinet.html")], capture_output=True)
        tracked = r.returncode == 0
    except ValueError:
        tracked = False
    timer = subprocess.run(["systemctl", "is-active", "synapse-sync.timer"], capture_output=True).stdout.decode().strip()
    say("  в git:", "да" if tracked else "нет", "; таймер synapse-sync:", timer or "?")
    need(not (tracked and timer == "active"), "STATIC_UNDER_ACTIVE_SYNC")
    new_static = {}
    for name, spec in BUNDLE["static"].items():
        data = patch((sdir / name).read_text(encoding="utf-8"), spec["patches"], name).encode("utf-8")
        need(sha(data) == spec["afterSha"], "RESULT_" + name)
        new_static[name] = data
    new_static[NEW_CSS] = BUNDLE["newStatic"][NEW_CSS].encode("utf-8")
    new_static["cabinet.html"] = new_cabinet_html((sdir / "cabinet.html").read_text(encoding="utf-8")).encode("utf-8")
    need(not (sdir / NEW_CSS).exists(), "NEW_CSS_EXISTS")
    say("  подготовлено файлов:", len(new_static))
    return {"ident": ident, "core": (core, new_core), "provider": (provider, new_provider), "stats": stats,
            "sdir": sdir, "new_static": new_static}


# ---------- запись ----------
def write_static(path, data, like):
    st = like.stat()
    tmp = path.with_name("." + path.name + ".r2tmp")
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.chown(tmp, st.st_uid, st.st_gid)
    os.chmod(tmp, st.st_mode & 0o7777)
    os.replace(tmp, path)


def write_app(name, data, stat):
    owner, mode = stat
    run(["docker", "exec", "-i", "-u", "0", CONTAINER, "sh", "-c", "cat > /app/." + name + ".r2tmp"], data)
    run(["docker", "exec", "-u", "0", CONTAINER, "sh", "-c",
         "chown " + owner + " /app/." + name + ".r2tmp && chmod " + mode + " /app/." + name + ".r2tmp && mv -f /app/." + name + ".r2tmp /app/" + name])
    need(sha(app_file(name)) == sha(data), "APP_READBACK_" + name)


def restart_and_watch(before_restarts):
    since = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    run(["docker", "restart", CONTAINER], timeout=180)
    time.sleep(20)
    ident = run(["docker", "inspect", CONTAINER, "--format", "{{.State.Running}}|{{.RestartCount}}|{{.State.Status}}"]).decode().strip().split("|")
    need(ident[0] == "true" and ident[2] == "running", "CRM_DOWN_AFTER_RESTART")
    need(ident[1] == before_restarts, "CRM_CRASH_LOOP")
    logs = subprocess.run(["docker", "logs", "--since", since, CONTAINER], capture_output=True, timeout=60)
    lines = (logs.stdout + logs.stderr).decode("utf-8", "replace").splitlines()
    errs = [l for l in lines if re.search(r"Error|ERR!|Uncaught|SyntaxError|ReferenceError", l)]
    say("  CRM работает; строк журнала", len(lines), "; ошибок", len(errs))
    for l in errs[:3]:
        say("   ", l[:160])
    need(not errs, "CRM_LOG_ERRORS")


def backup(p):
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S")
    bdir = pathlib.Path("/root/palitra-r2-backup-" + ts)
    os.mkdir(bdir, 0o700)
    (bdir / "static").mkdir()
    for name in list(BUNDLE["static"]) + ["cabinet.html"]:
        shutil.copy2(p["sdir"] / name, bdir / "static" / name)
    (bdir / "app-autoposting.js").write_bytes(p["core"][0])
    (bdir / "app-onlypult-provider.js").write_bytes(p["provider"][0])
    dbname = "palitra-r2-backup-" + ts + ".sqlite"
    run(["docker", "exec", "-i", CONTAINER, "node", "-"],
        ("const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/crm.sqlite',{readOnly:true});"
         "db.exec(\"VACUUM INTO '/data/" + dbname + "'\");db.close();").encode(), timeout=600)
    run(["docker", "cp", CONTAINER + ":/data/" + dbname, str(bdir / "crm.sqlite")], timeout=600)
    run(["docker", "exec", "-u", "0", CONTAINER, "rm", "-f", "/data/" + dbname])
    manifest = {"staticDir": str(p["sdir"]), "stats": p["stats"], "restarts": p["ident"][3],
                "static": {n: sha((bdir / "static" / n).read_bytes()) for n in os.listdir(bdir / "static")},
                "core": sha(p["core"][0]), "provider": sha(p["provider"][0]), "newCss": NEW_CSS}
    (bdir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    say("  резервная копия:", bdir, "; база", (bdir / "crm.sqlite").stat().st_size // 1024, "КБ")
    return bdir


def restore(bdir):
    bdir = pathlib.Path(bdir)
    m = json.loads((bdir / "manifest.json").read_text())
    sdir = pathlib.Path(m["staticDir"])
    for name in os.listdir(bdir / "static"):
        write_static(sdir / name, (bdir / "static" / name).read_bytes(), bdir / "static" / name if not (sdir / name).exists() else sdir / name)
    extra = sdir / m["newCss"]
    if extra.exists():
        extra.unlink()
    write_app("autoposting.js", (bdir / "app-autoposting.js").read_bytes(), m["stats"]["autoposting.js"])
    write_app("onlypult-provider.js", (bdir / "app-onlypult-provider.js").read_bytes(), m["stats"]["onlypult-provider.js"])
    run(["docker", "restart", CONTAINER], timeout=180)
    time.sleep(15)
    say("  откат выполнен из", bdir)


def apply():
    p = plan()
    say("3. Установка")
    lockf = open(LOCK, "r+")
    try:
        fcntl.flock(lockf, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        raise Refused("RELEASE_LOCK_BUSY")
    bdir = backup(p)
    try:
        sdir = p["sdir"]
        for name, data in p["new_static"].items():
            target = sdir / name
            write_static(target, data, target if target.exists() else sdir / "cabinet.html")
            need(sha(target.read_bytes()) == sha(data), "STATIC_READBACK_" + name)
        say("  файлы кабинета записаны:", len(p["new_static"]))
        write_app("onlypult-provider.js", p["provider"][1], p["stats"]["onlypult-provider.js"])
        write_app("autoposting.js", p["core"][1], p["stats"]["autoposting.js"])
        say("  файлы CRM записаны и прочитаны обратно")
        restart_and_watch(p["ident"][3])
        say("4. Проверка снаружи")
        for name, data in p["new_static"].items():
            got = fetch(PUBLIC + name + ("?v=" + STAMP if name != "cabinet.html" else "?nocache=" + str(time.time())))
            need(sha(got) == sha(data), "PUBLIC_READBACK_" + name)
        say("  все", len(p["new_static"]), "файлов отдаются сайтом в новой версии")
        for name in ("autoposting.js", "onlypult-provider.js"):
            need(sha(app_file(name)) == sha(p["core"][1] if name == "autoposting.js" else p["provider"][1]), "APP_FINAL_" + name)
    except BaseException as error:
        say("СБОЙ:", error, "— откатываю")
        try:
            restore(bdir)
        except BaseException as second:
            say("ОТКАТ НЕ ЗАВЕРШЁН:", second, "— данные в", bdir)
        raise
    finally:
        (bdir / "log.txt").write_text("\n".join(LOG))
    say("УСТАНОВЛЕНО. Отправка на площадки не включалась. Откат: python3", __file__, "rollback", bdir)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "check"
    try:
        if mode == "check":
            plan()
            say("ПРОВЕРКА ПРОЙДЕНА. Ничего не записано.")
        elif mode == "apply":
            apply()
        elif mode == "rollback" and len(sys.argv) == 3:
            need(os.geteuid() == 0, "ROOT_REQUIRED")
            restore(sys.argv[2])
        else:
            say("режимы: check | apply | rollback DIR")
            return 2
    except Refused as error:
        say("ОСТАНОВЛЕНО:", error)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
