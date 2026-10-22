"""One-attempt staff install/notification-help UI update; no delivery/auth changes.
Reuse the reviewed full-tree/CAS/one-layer guards; no schema, roles or business-row writes.
"""
import copy, hashlib, io, json, os, re, sqlite3, stat, subprocess, sys, time, urllib.request, zipfile
from pathlib import Path
sys.dont_write_bytecode = True
ROOT = Path('/opt/synapse/releases/palitra-app-20261015')
AREA = ROOT / 'palitra-staff-install-20261022-r1'
SELF = Path(__file__)
CONTENT, CRM = 'synapse-content-1', 'synapse-crm-1'
PARENT = Path('/tmp/pc-i4.py')
PARENT_SHA = '19d8c6ea00264dc276920b3a196df9c3931d4b2e22c63fbe171da6e13904d73c'
sha = lambda b: hashlib.sha256(b).hexdigest()
enc = lambda v: json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
def need(ok, code):
    if not ok: raise ValueError(code)

need(sha(PARENT.read_bytes()) == PARENT_SHA, 'EXACT_REVIEWED_GUARDS')
old = {'__name__': 'category_reviewed_primitives', '__file__': str(PARENT)}
exec(compile(PARENT.read_bytes(), str(PARENT), 'exec'), old)
read, write, load, run = (old[k] for k in ('read', 'write', 'load', 'run'))

def package():
    staged = load(AREA / 'stage.json')
    raw = read(AREA / 'manifest.json')
    need(sha(raw) == staged['bundleSha256'] and sha(read(SELF)) == staged['helperSha256'], 'PACKAGE_CHANGED')
    manifest = json.loads(raw)
    need(manifest['status'] == 'ROOT_REVIEW_READY_CODE_ONLY' and manifest['schemaWrites'] == 0, 'REVIEW_REQUIRED')
    rows = manifest['files']
    need({r['file'] for r in rows} == {'candidate/content/palitra-orders-public/shell.js', 'candidate/content/palitra-orders-public/workflow-ui.js', 'candidate/content/palitra-orders-public/cabinet.html', 'candidate/content/palitra-orders-public/shop.html', 'candidate/content/palitra-orders-public/telegram.html', 'candidate/content/palitra-review-public/palitra-chat.html', 'candidate/static/cabinet/palitra-orders/shell.js', 'candidate/static/cabinet/palitra-orders/workflow-ui.js', 'candidate/static/cabinet/palitra-orders/cabinet.html'} and len(rows) == 9, 'EXACT_DELIVERY_SCOPE')
    actual = {p.relative_to(AREA / 'code').as_posix() for p in (AREA / 'code').rglob('*') if p.is_file()}
    need(actual == {r['file'] for r in rows}, 'CLOSED_CODE')
    for row in rows:
        b = read(AREA / 'code' / row['file'])
        need(sha(b) == row['sha256'] and len(b) == row['bytes'], 'FILE_CHANGED')
    return staged, manifest, {'files': rows}

old.update(AREA=AREA, SELF=SELF, package=package)

def own_lease(native):
    locks = json.loads(run(['lslocks', '--json', '--output', 'PID,PATH']))['locks']
    matches = [r for r in locks if r.get('path') == str(native.LOCK)]
    need(len(matches) == 1, 'ONE_FRESH_LEASE')
    pid = int(matches[0]['pid'])
    parent, ancestors = os.getppid(), set()
    while parent > 1 and parent not in ancestors:
        ancestors.add(parent)
        raw = Path('/proc/' + str(parent) + '/stat').read_text()
        parent = int(raw[raw.rfind(')') + 2:].split()[1])
    need(pid in ancestors, 'OWN_ANCESTOR_LEASE_REQUIRED')
    raw = Path('/proc/' + str(pid) + '/stat').read_text()
    value = {'pid': pid, 'startTicks': raw[raw.rfind(')') + 2:].split()[19], 'path': str(native.LOCK)}
    native.Ticket.native_lease(value)
    return value

def stage(commit, pin):
    need(re.fullmatch('[a-f0-9]{40}', commit) and re.fullmatch('[a-f0-9]{64}', pin), 'EXACT_PUBLIC_PINS')
    need(not AREA.exists(), 'STAGE_EXISTS_INSPECT_ONLY')
    url = 'https://raw.githubusercontent.com/Elk0980/synapse-server/' + commit + '/ops/palitra-staff-install-20261022-r1/'
    raw = urllib.request.urlopen(url + 'manifest.json', timeout=30).read(128 * 1024)
    need(sha(raw) == pin, 'MANIFEST_PIN')
    manifest = json.loads(raw)
    z = urllib.request.urlopen(url + 'payload.zip', timeout=30).read(1024 * 1024)
    need(sha(z) == manifest['zipSha256'], 'ZIP_PIN')
    with zipfile.ZipFile(io.BytesIO(z)) as archive:
        names = archive.namelist()
        need(len(names) == 9 and set(names) == {r['file'] for r in manifest['files']}, 'ZIP_CLOSURE')
        payload = {name: archive.read(name) for name in names}
    AREA.mkdir(mode=0o700)
    (AREA / 'code').mkdir(mode=0o700)
    for name, value in payload.items():
        need(name.startswith(('candidate/content/', 'candidate/static/')) and '..' not in name and '\\' not in name, 'CODE_PATH')
        p = AREA / 'code' / name
        p.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        write(p, value)
    write(AREA / 'manifest.json', raw)
    write(AREA / 'stage.json', enc({'bundleSha256': pin, 'helperSha256': sha(read(SELF)), 'commit': commit}))
    package()
    print(json.dumps({'status': 'CODE_STAGED_NOT_APPLIED', 'files': 9}))

def prepare():
    staged, manifest, m = package()
    _, native, reader, contract = old['primitive']()
    lease = own_lease(native)
    need(not (AREA / 'action.json').exists(), 'ACTION_EXISTS_INSPECT_ONLY')
    current = old['content_snapshot'](native, reader, contract)
    crm = old['inspect'](CRM)
    crm_tree = old['tree'](CRM, reader)
    need(current['image'] == manifest['beforeImage'] and crm['Image'] == manifest['crmImage'], 'FRESH_INSTALLED_IMAGES_REQUIRED')
    need(old['image_tree'](current['image'], reader) == current['appTree'] and old['image_tree'](crm['Image'], reader) == crm_tree, 'CURRENT_IMAGE_TREE_EXACT')
    statics, overlays = {}, {CONTENT: {}, CRM: {}}
    for row in m['files']:
        if row['file'].startswith('candidate/content/'):
            rel = row['file'].removeprefix('candidate/content/')
            metadata = current['appTree'].get(rel)
            need((metadata is None if row['beforeSha256'] is None else metadata and metadata['type'] == 'file' and metadata['nlink'] == 1 and metadata['sha256'] == row['beforeSha256']), 'CONTENT_BEFORE_PIN')
            for parent in Path(rel).parents:
                if str(parent) != '.' and parent.as_posix() in current['appTree']:
                    need(current['appTree'][parent.as_posix()]['type'] == 'directory', 'CONTENT_PARENT_METADATA')
            overlays[CONTENT][rel] = row
        else:
            target = '/opt/synapse/sites/synapse/' + row['file'].removeprefix('candidate/static/')
            p = Path(target)
            need(sha(read(p)) == row['beforeSha256'], 'STATIC_BEFORE_PIN')
            info = p.stat()
            statics[target] = {'sha256': row['beforeSha256'], 'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid, 'file': row['file'], 'afterSha256': row['sha256']}
    crm_path = '/var/lib/docker/volumes/synapse_crm_data/_data/crm.sqlite'
    base = {'content': current, 'crm': crm, 'crmTree': crm_tree, 'crmDatabase': {'databasePath': crm_path, 'databaseIdentity': old['db_identity'](crm_path)}, 'statics': statics, 'overlays': overlays}
    write(AREA / 'base.json', enc(base))
    now = time.time()
    action = {'status': 'ROOT_AUTHORIZED_ONE_ATTEMPT', 'created': now, 'expires': now + 1800, 'lease': lease, 'baseSha256': sha(enc(base)), 'bundleSha256': staged['bundleSha256'], 'helperSha256': staged['helperSha256'], 'namespace': 'palitra-staff-install-r1-' + os.urandom(12).hex(), 'singleWriter': 'Root', 'userAuthorization': 'Direct request: restore dismissible staff/admin install guidance and always-accessible manual help; Root exact review and fresh target pins required before this installation'}
    write(AREA / 'action.json', enc(action))
    print(json.dumps({'status': 'FRESH_BASE_READY_NOT_APPLIED', 'lease': lease, 'runtimeFiles': 6, 'staticFiles': 3, 'schemaWrites': 0}))

class Apply(old['Apply']):
    def crm_guard(self, after):
        return super().crm_guard(False)
    def backup(self):
        self.guard()
        result = {}
        for label, source in [('content', self.base['content']['database']['path']), ('crm', self.base['crmDatabase']['databasePath'])]:
            destination = self.journal / (label + '.sqlite')
            write(destination, b'')
            src = sqlite3.connect(Path(source).as_uri() + '?mode=ro', uri=True, timeout=5)
            dst = sqlite3.connect(destination)
            try:
                src.execute('PRAGMA query_only=ON')
                need(src.execute('PRAGMA query_only').fetchone() == (1,), 'READ_ONLY_BACKUP_SOURCE')
                src.backup(dst)
                need(dst.execute('PRAGMA quick_check').fetchone() == ('ok',), 'BACKUP_QUICK_CHECK')
            finally: src.close(); dst.close()
            os.chmod(destination, 0o600)
            result[label] = {'sha256': sha(read(destination)), 'quickCheck': 'ok'}
        result['static'] = {}
        for i, (target, row) in enumerate(self.base['statics'].items()):
            raw = read(target)
            need(sha(raw) == row['sha256'], 'STATIC_BACKUP_CAS')
            write(self.journal / ('static-' + str(i)), raw)
            result['static'][target] = row['sha256']
        self.guard()
        return result
    def make_plan(self):
        self.guard()
        path = self.journal / 'content-overlay.json'
        write(path, enc({'services': {'content': {'image': self.children[CONTENT]['image']}}}))
        plan = copy.deepcopy(self.base['content']['compose'])
        plan['files'].append({'path': str(path), 'sha256': sha(read(path))})
        resolved = json.loads(run(old['compose_args'](plan) + ['config', '--format', 'json']))
        want = copy.deepcopy(plan['resolved'])
        want['services']['content']['image'] = self.children[CONTENT]['image']
        need(resolved == want, 'ONLY_CONTENT_IMAGE_MAY_CHANGE')
        plan['resolved'] = resolved
        self.plan = plan
        return {'composeFiles': plan['files']}
    def up(self):
        self.guard()
        need(json.loads(run(old['compose_args'](self.plan) + ['config', '--format', 'json'])) == self.plan['resolved'], 'LATE_COMPOSE_CAS')
        self.ticket()
        run(old['compose_args'](self.plan) + ['up', '--detach', '--no-build', '--pull', 'never', '--no-deps', 'content'], 180)
        deadline = time.monotonic() + 45
        while True:
            self.ticket(); state = old['inspect'](CONTENT)['State']
            if state['Running'] and not state['Restarting'] and not state['OOMKilled'] and state.get('Health', {}).get('Status') in (None, 'healthy'): break
            need(time.monotonic() < deadline, 'HEALTH_TIMEOUT_INSPECT_ONLY'); time.sleep(1)
        return {'commandReturned': True}
    def execute(self):
        self.guard(); self.journal.mkdir(mode=0o700)
        self.record('admission', 'PASS')
        backup = self.once('protected-backup', self.backup)
        self.once('build-one-content-layer', lambda: self.build(CONTENT))
        self.once('content-compose-plan', self.make_plan)
        self.once('content-up-once', self.up)
        self.guard(True)
        self.once('staff-install-static-cas', self.publish)
        observed = self.guard(True)
        result = {'status': 'INSTALLED_PENDING_ROOT_LIVE_ACCEPTANCE', 'images': self.children, 'plan': self.plan, 'backup': backup, 'snapshotSha256': observed, 'schemaWrites': 0, 'dataRestored': False}
        write(self.journal / 'result.json', enc(result)); write(AREA / 'installed.json', enc(result))
        print(json.dumps({'status': result['status'], 'resultSha256': sha(enc(result)), 'images': self.children, 'staticFiles': len(self.published)}))

def inspect_result():
    staged, manifest, m = package()
    product, native, reader, contract = old['primitive']()
    lease = own_lease(native)
    action, result = load(AREA / 'action.json'), load(AREA / 'installed.json')
    need(sha(read(AREA / 'base.json')) == action['baseSha256'], 'EXACT_INSTALLED_BASE')
    obj = object.__new__(Apply)
    obj.staged, obj.bundle, obj.m = staged, manifest, m
    obj.product, obj.native, obj.reader, obj.contract = product, native, reader, contract
    obj.action, obj.readLease, obj.base = action, lease, load(AREA / 'base.json')
    obj.children, obj.plan, obj.published = result['images'], result['plan'], set(obj.base['statics'])
    observed = obj.guard(True)
    need(observed == result['snapshotSha256'], 'INDEPENDENT_FULL_READBACK')
    report = {'status': 'ROOT_INDEPENDENT_NATIVE_READBACK_PASS', 'snapshotSha256': observed, 'image': result['images'][CONTENT]['image'], 'staticFiles': len(obj.published), 'schemaWrites': 0, 'businessRowsWritten': 0}
    write(AREA / ('readback-' + str(time.time_ns()) + '.json'), enc(report)); print(json.dumps(report))

if __name__ == '__main__':
    try:
        need(os.name == 'posix' and os.geteuid() == 0, 'LINUX_ROOT_ONLY')
        mode = sys.argv[1]
        if mode == 'stage': stage(sys.argv[2], sys.argv[3])
        elif mode == 'prepare': prepare()
        elif mode == 'apply': Apply().execute()
        elif mode == 'inspect': inspect_result()
        else: need(False, 'UNKNOWN_MODE')
    except Exception as error:
        code = str(error)
        print(json.dumps({'status': 'STOP_INSPECT_ONLY_NO_AUTOMATIC_RETRY', 'error': type(error).__name__, 'code': code if isinstance(error, ValueError) and re.fullmatch('[A-Z0-9_]{1,96}', code) else 'NATIVE_OPERATION_FAILED'}))
        raise SystemExit(2)
