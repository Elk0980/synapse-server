"""Небо · экскурсия «один свайп = видео до следующего блока» — выпуск на nebo-draft-1.

Запуск на сервере synapse-core (root), из каталога с этим файлом и tour-step.js:
  python3 install.py inspect    # только чтение: где лежит сайт, текущая ревизия, хеши
  python3 install.py apply      # бэкап базы → новая ревизия = текущая + tour-step.js → переключение
  python3 install.py verify     # живой сайт отдаёт скрипт и строку в index.html
  python3 install.py rollback   # вернуть прежнюю ревизию

Что меняется: ТОЛЬКО сайт с hostname nebo-draft-1.synapsebusiness.ru. Собранный бандл сайта,
другие сайты, Caddy, ключи и права не трогаются. Старая ревизия остаётся на диске как есть.
"""
from pathlib import Path
import hashlib, json, shutil, subprocess, sys, time, urllib.request

HOST = 'nebo-draft-1.synapsebusiness.ru'
CONTAINER = 'synapse-content-1'
HERE = Path(__file__).resolve().parent
SCRIPT = HERE / 'tour-step.js'
SCRIPT_SHA = '7c54297096f351ef5b8c892801322a3464760065bd4b6b4c02929714afd2e676'
INDEX_SHA_BEFORE = '68b61810105a2ef3901c793433d92de0a07b28f4ca96a5247f85e4eb85aa9087'  # index.html, снятый с живого сайта 08.11
ANCHOR = '<link rel="stylesheet" crossorigin href="/assets/index-DMNisL_8.css">'
TAG = '<script defer src="/assets/tour-step.js?v=20261108"></script>'
STATE = HERE / 'STATE.json'


def sha(b): return hashlib.sha256(b).hexdigest()
def run(*a): return subprocess.check_output(a, text=True).strip()


def data_root():
    row = json.loads(run('docker', 'inspect', CONTAINER))[0]
    return Path(next(m['Source'] for m in row['Mounts'] if m['Destination'] == '/data'))


def node(js, *args):
    """Запрос к content.sqlite внутри контейнера тем же node:sqlite, что и сервис."""
    return json.loads(run('docker', 'exec', CONTAINER, 'node', '-e', js, *args))


def site_row():
    rows = node(r"""
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/content.sqlite',{readOnly:true});
const cols=db.prepare("PRAGMA table_info(site_workspaces)").all().map(c=>c.name);
const rows=db.prepare("SELECT * FROM site_workspaces WHERE hostname=?").all(process.argv[1]);
console.log(JSON.stringify({cols,rows}));""", HOST)
    assert len(rows['rows']) == 1, 'ONE_SITE_ROW_REQUIRED'
    return rows['cols'], rows['rows'][0]


def version_dir(root, row, rev):
    hits = list((root / 'projects').glob(f"*/sites/{row['site_id']}/versions/{rev}"))
    assert len(hits) == 1, f'VERSION_DIR_NOT_FOUND {rev}'
    return hits[0]


def inspect():
    root = data_root(); cols, row = site_row()
    cur = version_dir(root, row, row['current_revision'])
    idx = (cur / 'index.html').read_bytes()
    facts = {
        'columns': cols, 'siteId': row['site_id'], 'revision': row['current_revision'], 'dir': str(cur),
        'files': sum(1 for p in cur.rglob('*') if p.is_file()),
        'indexSha': sha(idx), 'indexMatchesLive': sha(idx) == INDEX_SHA_BEFORE,
        'anchorFound': idx.decode().count(ANCHOR) == 1,
        'tourStepAlready': (cur / 'assets' / 'tour-step.js').exists(),
        'scriptSha': sha(SCRIPT.read_bytes()), 'scriptShaOk': sha(SCRIPT.read_bytes()) == SCRIPT_SHA,
        'workspaceExports': node(r"console.log(JSON.stringify(Object.keys(require('/app/site-workspaces'))))"),
    }
    print(json.dumps(facts, ensure_ascii=False, indent=2))
    return root, row, cur, facts


def apply():
    root, row, cur, f = inspect()
    assert f['scriptShaOk'] and f['anchorFound'] and not f['tourStepAlready'], 'PRECHECK_FAILED'
    assert not STATE.exists(), 'ALREADY_APPLIED_SEE_STATE_JSON'
    old = row['current_revision']; new = f'{old}-tourstep-20261108'
    dst = cur.parent / new; assert not dst.exists(), 'NEW_REVISION_DIR_EXISTS'
    # 1. бэкап базы средствами sqlite (консистентная копия)
    bak = f'/data/content-before-nebo-tourstep-{time.strftime("%Y%m%d-%H%M%S")}.sqlite'
    node(r"""
const {DatabaseSync,backup}=require('node:sqlite');const db=new DatabaseSync('/data/content.sqlite');
backup(db,process.argv[1]).then(()=>{require('node:fs').chmodSync(process.argv[1],0o600);console.log('{"ok":true}')});""", bak)
    # 2. новая ревизия = полная копия текущей + 2 изменения
    shutil.copytree(cur, dst, copy_function=shutil.copy2)
    (dst / 'assets').mkdir(exist_ok=True)
    shutil.copy2(SCRIPT, dst / 'assets' / 'tour-step.js')
    idx = (dst / 'index.html').read_text(encoding='utf-8')
    (dst / 'index.html').write_text(idx.replace(ANCHOR, ANCHOR + '\n  ' + TAG, 1), encoding='utf-8')
    shutil.chown(dst, user=cur.owner(), group=cur.group())
    for p in dst.rglob('*'): shutil.chown(p, user=cur.owner(), group=cur.group())
    # 3. переключение ревизии ровно этой строки, с проверкой прежнего значения
    STATE.write_text(json.dumps({'siteId': row['site_id'], 'old': old, 'new': new, 'backup': bak}, indent=2))
    out = node(r"""
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/content.sqlite');
const r=db.prepare("UPDATE site_workspaces SET current_revision=? WHERE site_id=? AND hostname=? AND current_revision=?").run(process.argv[1],process.argv[2],process.argv[3],process.argv[4]);
console.log(JSON.stringify({changes:Number(r.changes)}));""", new, row['site_id'], HOST, old)
    assert out['changes'] == 1, 'SWITCH_FAILED'
    print('APPLIED', json.dumps({'old': old, 'new': new, 'backup': bak}))
    print('Дальше: python3 install.py verify. Если сайт отдаёт старую ревизию — сервис кэширует её: перезапустить только content.')


def verify():
    ok = True
    for path, need in [('/', TAG), ('/assets/tour-step.js', 'neboTourStep')]:
        req = urllib.request.Request(f'https://{HOST}{path}?verify={int(time.time())}', headers={'Cache-Control': 'no-cache'})
        body = urllib.request.urlopen(req, timeout=20).read()
        hit = need.encode() in body
        ok &= hit
        print(path, 'OK' if hit else 'НЕТ', sha(body) if path.endswith('.js') else '')
    print('VERIFIED' if ok else 'NOT_LIVE_YET')


def rollback():
    s = json.loads(STATE.read_text())
    out = node(r"""
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/content.sqlite');
const r=db.prepare("UPDATE site_workspaces SET current_revision=? WHERE site_id=? AND hostname=? AND current_revision=?").run(process.argv[1],process.argv[2],process.argv[3],process.argv[4]);
console.log(JSON.stringify({changes:Number(r.changes)}));""", s['old'], s['siteId'], HOST, s['new'])
    assert out['changes'] == 1, 'ROLLBACK_FAILED'
    print('ROLLED_BACK to', s['old'])


if __name__ == '__main__':
    assert len(sys.argv) == 2 and sys.argv[1] in ('inspect', 'apply', 'verify', 'rollback'), __doc__
    {'inspect': inspect, 'apply': apply, 'verify': verify, 'rollback': rollback}[sys.argv[1]]()
