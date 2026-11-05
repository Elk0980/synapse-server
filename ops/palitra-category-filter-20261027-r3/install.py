"""Single-attempt, CAS-checked installation of exactly three public editor files.

No Docker lifecycle commands, database writes, settings, credentials or Git resets.
The caller must hold the existing release flock in an ancestor shell.
"""
from pathlib import Path
import hashlib, json, os, re, stat, subprocess, sys, time, urllib.request

NAME = 'palitra-category-filter-20261027-r3'
ROOT = Path('/opt/synapse')
AREA = ROOT / 'releases' / NAME
LOCK = str(ROOT / '.palitra-app-release.lock')
SCOPE = tuple('sites/synapse/' + n for n in ('price-editor-palitra.html', 'palitra-editor.js', 'palitra-editor.css'))
SELF = Path(__file__).resolve()
EXPECTED_IMAGES = {
    'synapse-content-1': 'sha256:9a1ab665339b10a49a49d8c605075ae701e4b28a9db1a3bb3ec49483fd8e6f44',
    'synapse-crm-1': 'sha256:6c802ba7fb5014becb2cd2c6c1b17ef509e2f9cda6780a841080cc36451e60d9',
    'synapse-hugh-runtime-1': 'sha256:1d89b9652c514c238c7509bd0d81f7a0a4d198cf7cd9990c90c7e3e05b045018'
}
CONTAINERS = tuple(EXPECTED_IMAGES) + ('synapse-chat-1', 'caddy')
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
        need(row['State']['Running'], 'SERVICE_NOT_RUNNING')
        if name in EXPECTED_IMAGES:
            need(row['Image'] == EXPECTED_IMAGES[name], 'CURRENT_IMAGE_CHANGED_INSPECT_ONLY')
        state[name] = {'id': row['Id'], 'image': row['Image'], 'config': sha(enc(row['Config'])),
                       'host': sha(enc(row['HostConfig'])), 'mounts': mount_digest(row['Mounts'])}
    # Digest other static UI resources, not customer files or databases.
    static = {p.relative_to(ROOT).as_posix(): sha(p.read_bytes()) for p in (ROOT/'sites/synapse').rglob('*')
              if p.is_file() and not p.is_symlink() and p.suffix in ('.html', '.js', '.css') and p.relative_to(ROOT).as_posix() not in SCOPE}
    with urllib.request.urlopen('https://palitra-love.ru/data/price.json', timeout=30) as response:
        raw = response.read(4 * 1024 * 1024 + 1)
    need(len(raw) <= 4 * 1024 * 1024, 'PRICE_SIZE')
    price = json.loads(raw)
    return {'containers': state, 'unrelatedStatic': static, 'priceSha256': sha(raw), 'priceVersion': price['version'],
            'caddySha256': sha((ROOT/'caddy/Caddyfile').read_bytes()),
            'composeSha256': sha((ROOT/'docker-compose.yml').read_bytes()),
            'managedPolicySha256': sha(Path('/etc/synapse/managed-release.json').read_bytes())}

def payload():
    staged = read_json(AREA/'stage.json')
    need(sha(SELF.read_bytes()) == staged['helperSha256'], 'HELPER_CHANGED')
    need(sha((AREA/'manifest.json').read_bytes()) == staged['manifestSha256'], 'MANIFEST_CHANGED')
    manifest = read_json(AREA/'manifest.json')
    need(manifest['packageId'] == NAME and tuple(r['target'] for r in manifest['targets']) == SCOPE, 'EXACT_THREE_FILES_REQUIRED')
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
    need(manifest['packageId'] == NAME and tuple(r['target'] for r in manifest['targets']) == SCOPE, 'EXACT_THREE_FILES_REQUIRED')
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
    print('STAGED_EXACT_THREE_NOT_INSTALLED')

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
    result = {'status':'STATIC_THREE_INSTALLED_READBACK_PASS', 'at':time.time(), 'files':3,
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
