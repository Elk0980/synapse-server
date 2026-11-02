"""Single-attempt, CAS-checked installation of exactly two public editor files.

No Docker lifecycle commands, database writes, settings, credentials or Git resets.
The caller must hold the existing release flock in an ancestor shell.
"""
from pathlib import Path
import hashlib, importlib.util, json, os, re, stat, subprocess, sys, time, urllib.request

NAME = 'palitra-preview-masks-20261101-r1'
ROOT = Path('/opt/synapse')
AREA = ROOT / 'releases' / NAME
LOCK = str(ROOT / '.palitra-app-release.lock')
SCOPE = tuple('sites/synapse/cabinet/palitra-orders/' + n for n in ('palitra-platform-preview.css', 'palitra-platform-preview.js'))
SELF = Path(__file__).resolve()
# This static-only release snapshots all current runtime images/configuration.
# No runtime or lifecycle command is issued; any subsequent difference refuses apply.
CONTAINERS = ('synapse-content-1','synapse-crm-1','synapse-hugh-runtime-1','synapse-chat-1','caddy')
IMAGES = {
    'synapse-content-1':'sha256:53fcc6b81e2b68a782fdb58a0fa1a66e5ad3277dfc90fc08fd02cfb70ebfea26',
    'synapse-crm-1':'sha256:b74d9196617cd1ba4945d0b13b69a0648552c170c5c1680b76fab51cdb73b327',
    'synapse-hugh-runtime-1':'sha256:1d89b9652c514c238c7509bd0d81f7a0a4d198cf7cd9990c90c7e3e05b045018',
    'synapse-chat-1':'sha256:4d5b047dc76bae1d2b82067406f98c344eea4033f83f35a54cdef7cd355ed2ae',
    'caddy':'sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648'
}
sha = lambda raw: hashlib.sha256(raw).hexdigest()
enc = lambda value: (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()

def need(value, reason):
    if not value:
        raise ValueError(reason)

def read_json(path):
    return json.loads(Path(path).read_bytes())

def write_new(path, raw):
    with Path(path).open('xb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())

def command(argv):
    return subprocess.check_output(argv, timeout=45)

def mount_digest(mounts):
    # Docker may return these same mount objects in another order on each inspect.
    # Retain every field and value; only normalize the irrelevant list order.
    return sha(enc(sorted(mounts, key=enc)))

def lease():
    records = json.loads(command(['lslocks', '--json', '--output', 'PID,PATH']))['locks']
    records = [r for r in records if r.get('path') == LOCK]
    need(len(records) == 1, 'ONE_FRESH_LEASE_REQUIRED')
    pid = int(records[0]['pid'])
    ancestors, parent = set(), os.getppid()
    while parent > 1 and parent not in ancestors:
        ancestors.add(parent)
        text = Path('/proc/' + str(parent) + '/stat').read_text()
        parent = int(text[text.rfind(')') + 2:].split()[1])
    need(pid in ancestors, 'OWN_ANCESTOR_LEASE_REQUIRED')
    text = Path('/proc/' + str(pid) + '/stat').read_text()
    return {'pid': pid, 'startTicks': text[text.rfind(')') + 2:].split()[19]}

def environment():
    timer = subprocess.run(['systemctl', 'is-active', 'synapse-sync.timer'], capture_output=True, text=True)
    need(timer.stdout.strip() == 'inactive', 'LEGACY_SYNC_MUST_REMAIN_INACTIVE')
    need(Path('/etc/synapse/managed-release.json').is_file(), 'MANAGED_POLICY_REQUIRED')
    containers = json.loads(command(['docker', 'inspect', *CONTAINERS]))
    state = {}
    for row in containers:
        name = row['Name'].lstrip('/')
        need(name in IMAGES and name not in state and row['Image']==IMAGES[name], 'ACCEPTED_FIVE_IMAGES_REQUIRED')
        need(row['State']['Running'] and not any(row['State'].get(k) for k in ('Paused','Dead','Restarting','OOMKilled')) and row.get('RestartCount')==0 and row['State'].get('Health',{}).get('Status') in (None,'healthy'), 'SERVICE_NOT_STEADY')
        state[name] = {'id': row['Id'], 'image': row['Image'], 'config': sha(enc(row['Config'])),
                       'host': sha(enc(row['HostConfig'])), 'mounts': mount_digest(row['Mounts']),
                       'startedAt':row['State']['StartedAt'], 'restarts':row['RestartCount']}
    # Digest other static UI resources, not customer files or databases.
    static = {p.relative_to(ROOT).as_posix(): sha(p.read_bytes()) for p in (ROOT/'sites/synapse').rglob('*')
              if p.is_file() and not p.is_symlink() and p.suffix in ('.html', '.js', '.css') and p.relative_to(ROOT).as_posix() not in SCOPE}
    with urllib.request.urlopen('https://palitra-love.ru/data/price.json', timeout=30) as response:
        raw = response.read(4 * 1024 * 1024 + 1)
    need(len(raw) <= 4 * 1024 * 1024, 'PRICE_SIZE')
    price = json.loads(raw)
    need(set(state) == set(CONTAINERS), 'EXACT_FIVE_CONTAINERS_REQUIRED')
    need(state['synapse-content-1']['image'] == 'sha256:53fcc6b81e2b68a782fdb58a0fa1a66e5ad3277dfc90fc08fd02cfb70ebfea26', 'ACCEPTED_AUTH_CHAT_RUNTIME_REQUIRED')
    need(price.get('version') == 83 and sha(raw) == '47878c70b8e65e3612fb5953c6dabe2659d80c54ea9828941e6951deb934fc12', 'EXACT_ACCEPTED_PRICE83_REQUIRED')
    return {'managed338': managed_guard(), 'containers': state, 'unrelatedStatic': static, 'priceSha256': sha(raw), 'priceVersion': price['version'],
            'caddySha256': sha((ROOT/'caddy/Caddyfile').read_bytes()),
            'composeSha256': sha((ROOT/'docker-compose.yml').read_bytes()),
            'managedPolicySha256': sha(Path('/etc/synapse/managed-release.json').read_bytes())}


def managed_guard():
    # Reuse only immutable read-only schema/facts/tree primitives. The expired
    # earlier release permit is neither called nor re-anchored for this release.
    source=Path('/root/palitra-auth-chat-static-current-20261031-r1/verify.py')
    need(source.resolve()==source and not source.is_symlink() and sha(source.read_bytes())=='c90726c7965f3184be19dce2305236190c4654b29f347b636be79b2deb047549', 'EXACT_READONLY_SOURCE_REQUIRED')
    sys.dont_write_bytecode=True
    spec=importlib.util.spec_from_file_location('preview_managed_readonly',source);v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
    notes=sorted(v.AREA.glob('readback-*.json'));need(1<=len(notes)<=10,'BOUNDED_ACCEPTED_MANAGED_READBACK_REQUIRED')
    accepted=[v.parse(v.private_read(f)) for f in notes]
    accepted=[r for r in accepted if r.get('status')=='AFTER_INDEPENDENT_READBACK_PASS']
    need(len(accepted)==1,'ONE_ACCEPTED_MANAGED338_REFERENCE_REQUIRED');reference=accepted[0]['snapshot']
    need(reference['version']==338 and reference['siteId']==v.SITE and reference['companyCode']==v.COMPANY and len(reference['history'])==338 and reference['manifest'][v.TARGET]['sha256']==v.AFTER,'EXACT_ACCEPTED_MANAGED338_REFERENCE_REQUIRED')
    conn=v.open_db()
    try:
        state=v.bindings(conn);digest=v.binding_digest(state)
        need(state['revision']==reference['revision'] and state['managedRows']==reference['managedRows'] and state['price']==reference['price'] and state['updatedAt']==reference['targetUpdatedAt'],'CURRENT_MANAGED338_BINDINGS_CHANGED')
        versions=v.DATA/'projects'/v.COMPANY/'sites'/v.SITE/'versions';budget=[0,0,time.monotonic()];records={}
        for values in state['historyRows']:
            row=dict(zip(state['historyColumns'],values));revision=row['revision']
            need(type(revision)is str and v.HEX.fullmatch(revision) and revision not in records,'FIXED_HISTORICAL_REVISION_REQUIRED')
            physical=v.tree(versions/revision,budget)
            records[revision]={'version':row['version'],'rowSha256':v.sha(v.enc(v.cells(values))),'treeSha256':v.sha(v.enc(physical)),'manifestSha256':v.sha(row['manifest_json'].encode()),'createdAt':row['created_at']}
        need(records==reference['history'] and {f.name for f in versions.iterdir()}==set(records),'ALL338_PHYSICAL_HISTORY_CHANGED')
        need(conn.total_changes==0,'NO_DATABASE_WRITES');conn.rollback()
    finally:conn.close()
    fresh=v.open_db()
    try:need(v.binding_digest(v.bindings(fresh))==digest and fresh.total_changes==0,'MANAGED_CHANGED_DURING_HISTORY_READ');fresh.rollback()
    finally:fresh.close()
    return {'version':338,'revision':reference['revision'],'historySha256':sha(v.enc(records)),'bindingSha256':digest}


def payload():
    staged = read_json(AREA/'stage.json')
    need(sha(SELF.read_bytes()) == staged['helperSha256'], 'HELPER_CHANGED')
    need(sha((AREA/'manifest.json').read_bytes()) == staged['manifestSha256'], 'MANIFEST_CHANGED')
    manifest = read_json(AREA/'manifest.json')
    need(manifest['packageId'] == NAME and tuple(r['target'] for r in manifest['targets']) == SCOPE, 'EXACT_TWO_FILES_REQUIRED')
    actual = {p.relative_to(AREA/'payload').as_posix() for p in (AREA/'payload').rglob('*') if p.is_file()}
    need(actual == set(SCOPE), 'CLOSED_PAYLOAD_REQUIRED')
    for row in manifest['targets']:
        need(sha((AREA/'payload'/row['target']).read_bytes()) == row['afterSha256'], 'PAYLOAD_MISMATCH')
    return staged, manifest

def stage(commit, manifest_pin):
    need(re.fullmatch('[0-9a-f]{40}', commit) and re.fullmatch('[0-9a-f]{64}', manifest_pin), 'IMMUTABLE_PINS_REQUIRED')
    need(not AREA.exists(), 'STAGE_EXISTS_INSPECT_ONLY')
    origin = 'https://raw.githubusercontent.com/Elk0980/synapse-server/' + commit + '/ops/' + NAME + '/'
    def fetch(name, limit):
        with urllib.request.urlopen(origin + name, timeout=30) as response:
            raw = response.read(limit + 1)
        need(len(raw) <= limit, 'PUBLIC_CODE_SIZE')
        return raw
    raw = fetch('manifest.json', 32000)
    need(sha(raw) == manifest_pin, 'MANIFEST_PIN')
    manifest = json.loads(raw)
    need(manifest['packageId'] == NAME and tuple(r['target'] for r in manifest['targets']) == SCOPE, 'EXACT_TWO_FILES_REQUIRED')
    need(manifest['helperSha256'] == sha(SELF.read_bytes()), 'HELPER_PIN')
    files = {r['target']: fetch('payload/' + r['target'], 512000) for r in manifest['targets']}
    need(all(sha(files[r['target']]) == r['afterSha256'] for r in manifest['targets']), 'PAYLOAD_PIN')
    AREA.mkdir(mode=0o700)
    for name, data in files.items():
        target = AREA/'payload'/name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        write_new(target, data)
    write_new(AREA/'manifest.json', raw)
    write_new(AREA/'stage.json', enc({'commit': commit, 'manifestSha256': manifest_pin, 'helperSha256': sha(SELF.read_bytes())}))
    payload()
    print('STAGED_EXACT_TWO_NOT_INSTALLED')

def metadata(path):
    need(path.resolve() == path and not path.is_symlink(), 'CANONICAL_TARGET_REQUIRED')
    value = path.stat()
    need(value.st_nlink == 1 and value.st_uid == 0 and value.st_gid == 0, 'ROOT_SINGLE_LINK_REQUIRED')
    return {'mode': stat.S_IMODE(value.st_mode), 'uid': value.st_uid, 'gid': value.st_gid}

def prepare():
    staged, manifest = payload()
    own, env = lease(), environment()
    need(not (AREA/'base.json').exists() and not (AREA/'action.json').exists(), 'BASE_EXISTS_INSPECT_ONLY')
    before = {}
    for row in manifest['targets']:
        path = ROOT/row['target']
        need(sha(path.read_bytes()) == row['beforeSha256'], 'FRESH_TARGET_CHANGED')
        before[row['target']] = metadata(path)
    backup = AREA/'backup'
    backup.mkdir(mode=0o700)
    for row in manifest['targets']:
        raw = (ROOT/row['target']).read_bytes()
        need(sha(raw) == row['beforeSha256'], 'TARGET_CHANGED_BEFORE_BACKUP')
        target = backup/row['target']
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        write_new(target, raw)
    base = {'lease': own, 'environment': env, 'metadata': before}
    write_new(AREA/'base.json', enc(base))
    write_new(AREA/'action.json', enc({'created': time.time(), 'expires': time.time()+900, 'baseSha256': sha(enc(base)), **staged}))
    print('FRESH_BASE_AND_EXACT_BACKUP_READY')

def guard():
    staged, manifest = payload()
    action, base = read_json(AREA/'action.json'), read_json(AREA/'base.json')
    need(action['created'] <= time.time() < action['expires'], 'FRESH_ACTION_REQUIRED')
    need(sha((AREA/'base.json').read_bytes()) == action['baseSha256'], 'BASE_CHANGED')
    need(all(action[k] == v for k,v in staged.items()), 'STAGED_CODE_CHANGED')
    need(lease() == base['lease'], 'OWN_LEASE_CHANGED')
    need(environment() == base['environment'], 'ENVIRONMENT_OR_PRICE_CHANGED_INSPECT_ONLY')
    for row in manifest['targets']:
        need(metadata(ROOT/row['target']) == base['metadata'][row['target']], 'TARGET_METADATA_CHANGED')
        need(sha((AREA/'backup'/row['target']).read_bytes()) == row['beforeSha256'], 'BACKUP_CHANGED')
    return manifest, base

def apply():
    manifest, base = guard()
    need(not (AREA/'apply-attempt.json').exists(), 'ONE_ATTEMPT_ONLY_INSPECT_RESULT')
    for row in manifest['targets']:
        need(sha((ROOT/row['target']).read_bytes()) == row['beforeSha256'], 'CAS_TARGET_CHANGED')
    write_new(AREA/'apply-attempt.json', enc({'at':time.time(), 'lease':base['lease']}))
    for row in manifest['targets']:
        path = ROOT/row['target']
        need(sha(path.read_bytes()) == row['beforeSha256'], 'CAS_TARGET_CHANGED_DURING_APPLY')
        temp = path.with_name('.'+path.name+'.'+NAME+'.tmp')
        write_new(temp, (AREA/'payload'/row['target']).read_bytes())
        info = base['metadata'][row['target']]
        os.chmod(temp, info['mode']); os.chown(temp, info['uid'], info['gid'])
        need(sha(path.read_bytes()) == row['beforeSha256'], 'FINAL_CAS_TARGET_CHANGED')
        os.replace(temp, path)
        need(sha(path.read_bytes()) == row['afterSha256'], 'IMMEDIATE_READBACK_FAILED')
    inspect()

def inspect():
    manifest, base = guard()
    need((AREA/'apply-attempt.json').is_file(), 'NO_APPLY_ATTEMPT')
    for row in manifest['targets']:
        need(sha((ROOT/row['target']).read_bytes()) == row['afterSha256'], 'INSTALLED_READBACK_FAILED')
    result = {'status':'STATIC_TWO_INSTALLED_READBACK_PASS', 'at':time.time(), 'files':2,
              'priceVersion':base['environment']['priceVersion'], 'priceSha256':base['environment']['priceSha256'],
              'runtimeWrites':0, 'databaseWrites':0, 'serviceRestarts':0, 'lease':base['lease']}
    write_new(AREA/('inspect-'+str(time.time_ns())+'.json'), enc(result))
    if not (AREA/'installed.json').exists(): write_new(AREA/'installed.json', enc(result))
    print(json.dumps(result))

if __name__ == '__main__':
    try:
        need(os.name == 'posix' and os.geteuid() == 0, 'NATIVE_LINUX_ROOT_ONLY')
        os.umask(0o077)
        mode = sys.argv[1]
        if mode == 'stage': stage(sys.argv[2], sys.argv[3])
        elif mode == 'prepare': prepare()
        elif mode == 'apply': apply()
        elif mode == 'inspect': inspect()
        else: raise ValueError('KNOWN_MODE_REQUIRED')
    except Exception as error:
        print('REFUSED: ' + type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(2)
