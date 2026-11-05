"""One-attempt CAS release of nine explicitly named Palitra static files.

No runtime, Docker lifecycle, database, settings, credentials or Git writes.
No runtime paths, database access, lifecycle commands or rollback mode are present.
"""
from pathlib import Path
import hashlib, json, os, re, stat, subprocess, sys, time, urllib.request

NAME = 'palitra-content-native-static-20261029-r1'
ROOT = Path('/opt/synapse')
AREA = ROOT / 'releases' / NAME
LOCK = str(ROOT / '.palitra-app-release.lock')
PREFIX = 'sites/synapse/cabinet/palitra-orders/'
EXISTING = tuple(PREFIX + n for n in ('cabinet.html', 'native-host.js', 'shell.js', 'palitra-content-tasks-ui.js', 'palitra-publication-composer.js'))
NEW = tuple(PREFIX + n for n in ('palitra-content-material-ui.js', 'palitra-content-material-ui.css', 'palitra-content-plan-ui.js', 'palitra-content-plan-ui.css'))
SCOPE = EXISTING + NEW
SELF = Path(__file__).resolve()
CONTAINERS = ('synapse-content-1', 'synapse-crm-1', 'synapse-hugh-runtime-1', 'synapse-chat-1', 'caddy')
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

def sync_directory(path):
    descriptor = os.open(str(path), os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def command(argv):
    allowed = (('lslocks', '--json', '--output', 'PID,PATH'), ('docker', 'inspect', *CONTAINERS))
    need(type(argv) is list and tuple(argv) in allowed, 'READ_ONLY_COMMAND_ALLOWLIST')
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

def validate_manifest(manifest):
    need(set(manifest) == {'schema', 'packageId', 'status', 'helperSha256', 'expectedImages', 'targets'}, 'CLOSED_MANIFEST_REQUIRED')
    need(manifest['schema'] == 1 and manifest['status'] == 'ROOT_REVIEWED_CODE_ONLY', 'ROOT_REVIEW_REQUIRED')
    need(type(manifest['expectedImages']) is dict and set(manifest['expectedImages']) == set(CONTAINERS) and all(type(v) is str and re.fullmatch('sha256:[0-9a-f]{64}', v) for v in manifest['expectedImages'].values()), 'FRESH_FIVE_IMAGE_PINS_REQUIRED')
    need(manifest.get('packageId') == NAME and tuple(r.get('target') for r in manifest.get('targets', [])) == SCOPE, 'EXACT_NINE_FILES_REQUIRED')
    need(re.fullmatch('[0-9a-f]{64}', manifest.get('helperSha256', '')), 'HELPER_PIN_REQUIRED')
    for row in manifest['targets']:
        need(set(row) == {'target', 'beforeSha256', 'afterSha256'}, 'CLOSED_TARGET_SCHEMA_REQUIRED')
        need(re.fullmatch('[0-9a-f]{64}', row.get('afterSha256', '')), 'AFTER_PIN_REQUIRED')
        if row['target'] in NEW:
            need(row.get('beforeSha256') is None, 'NEW_TARGET_MUST_BE_ABSENT')
        else:
            need(isinstance(row.get('beforeSha256'), str) and re.fullmatch('[0-9a-f]{64}', row['beforeSha256']), 'EXISTING_BEFORE_PIN_REQUIRED')
    return manifest

def payload():
    staged = read_json(AREA/'stage.json')
    need(sha(SELF.read_bytes()) == staged['helperSha256'], 'HELPER_CHANGED')
    need(sha((AREA/'manifest.json').read_bytes()) == staged['manifestSha256'], 'MANIFEST_CHANGED')
    manifest = validate_manifest(read_json(AREA/'manifest.json'))
    need(manifest['helperSha256'] == staged['helperSha256'], 'HELPER_PIN')
    actual = {p.relative_to(AREA/'payload').as_posix() for p in (AREA/'payload').rglob('*') if p.is_file() or p.is_symlink()}
    need(actual == set(SCOPE), 'CLOSED_PAYLOAD_REQUIRED')
    for row in manifest['targets']:
        path = AREA/'payload'/row['target']
        need(path.resolve() == path and path.is_file() and not path.is_symlink(), 'CANONICAL_PAYLOAD_REQUIRED')
        need(sha(path.read_bytes()) == row['afterSha256'], 'PAYLOAD_MISMATCH')
    return staged, manifest

def stage(commit, manifest_pin):
    need(re.fullmatch('[0-9a-f]{40}', commit) and re.fullmatch('[0-9a-f]{64}', manifest_pin), 'IMMUTABLE_PINS_REQUIRED')
    need(not os.path.lexists(AREA), 'STAGE_EXISTS_INSPECT_ONLY')
    origin = 'https://raw.githubusercontent.com/Elk0980/synapse-server/' + commit + '/ops/' + NAME + '/'
    def fetch(name, limit):
        with urllib.request.urlopen(origin + name, timeout=30) as response:
            raw = response.read(limit + 1)
        need(len(raw) <= limit, 'PUBLIC_CODE_SIZE')
        return raw
    raw = fetch('manifest.json', 32000)
    need(sha(raw) == manifest_pin, 'MANIFEST_PIN')
    manifest = validate_manifest(json.loads(raw))
    need(manifest['helperSha256'] == sha(SELF.read_bytes()), 'HELPER_PIN')
    files = {r['target']: fetch('payload/' + r['target'], 512000) for r in manifest['targets']}
    need(all(sha(files[r['target']]) == r['afterSha256'] for r in manifest['targets']), 'PAYLOAD_PIN')
    need(AREA.parent.resolve() == AREA.parent and AREA.parent.is_dir(), 'CANONICAL_RELEASES_REQUIRED')
    AREA.mkdir(mode=0o700)
    for name, data in files.items():
        target = AREA/'payload'/name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        write_new(target, data)
    write_new(AREA/'manifest.json', raw)
    write_new(AREA/'stage.json', enc({'commit': commit, 'manifestSha256': manifest_pin, 'helperSha256': sha(SELF.read_bytes())}))
    payload()
    print('STAGED_EXACT_NINE_NOT_INSTALLED')

def metadata(path):
    need(path.resolve() == path and not path.is_symlink(), 'CANONICAL_TARGET_REQUIRED')
    value = path.stat()
    need(stat.S_ISREG(value.st_mode), 'REGULAR_TARGET_REQUIRED')
    need(value.st_nlink == 1 and value.st_uid == 0 and value.st_gid == 0, 'ROOT_SINGLE_LINK_REQUIRED')
    return {'mode': stat.S_IMODE(value.st_mode), 'uid': value.st_uid, 'gid': value.st_gid}

def parent_metadata(path):
    parent = path.parent
    need(parent.resolve() == parent and parent.is_dir() and not parent.is_symlink(), 'CANONICAL_PARENT_REQUIRED')
    value = parent.stat()
    need(value.st_uid == 0 and value.st_gid == 0 and not (value.st_mode & stat.S_IWOTH), 'ROOT_PARENT_REQUIRED')
    return {'mode': stat.S_IMODE(value.st_mode), 'uid': value.st_uid, 'gid': value.st_gid}

def before_state(row, metadata_expected=None):
    path = ROOT/row['target']
    parent_metadata(path)
    if row['beforeSha256'] is None:
        need(not os.path.lexists(path), 'NEW_TARGET_COLLISION')
    else:
        info = metadata(path)
        if metadata_expected is not None:
            need(info == metadata_expected, 'TARGET_METADATA_CHANGED')
        need(sha(path.read_bytes()) == row['beforeSha256'], 'CAS_TARGET_CHANGED')

def prepare():
    staged, manifest = payload()
    own, env = lease(), environment()
    need({name: row['image'] for name, row in env['containers'].items()} == manifest['expectedImages'], 'FRESH_FIVE_ACTUAL_IMAGES_REQUIRED')
    need(not (AREA/'base.json').exists() and not (AREA/'action.json').exists(), 'BASE_EXISTS_INSPECT_ONLY')
    before, parents = {}, {}
    for row in manifest['targets']:
        path = ROOT/row['target']
        before_state(row)
        before[row['target']] = metadata(path) if row['beforeSha256'] is not None else {'mode': 0o644, 'uid': 0, 'gid': 0}
        parents[row['target']] = parent_metadata(path)
    backup = AREA/'backup'
    backup.mkdir(mode=0o700)
    for row in manifest['targets']:
        before_state(row, before[row['target']])
        if row['beforeSha256'] is None:
            continue
        raw = (ROOT/row['target']).read_bytes()
        need(sha(raw) == row['beforeSha256'], 'TARGET_CHANGED_BEFORE_BACKUP')
        target = backup/row['target']
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        write_new(target, raw)
    base = {'lease': own, 'environment': env, 'metadata': before, 'parents': parents}
    write_new(AREA/'base.json', enc(base))
    write_new(AREA/'action.json', enc({'created': time.time(), 'expires': time.time()+900, 'baseSha256': sha(enc(base)), **staged}))
    print('FRESH_BASE_FIVE_BACKUPS_FOUR_ABSENT_READY')

def guard():
    staged, manifest = payload()
    action, base = read_json(AREA/'action.json'), read_json(AREA/'base.json')
    need(action['created'] <= time.time() < action['expires'], 'FRESH_ACTION_REQUIRED')
    need(sha((AREA/'base.json').read_bytes()) == action['baseSha256'], 'BASE_CHANGED')
    need(all(action[k] == v for k, v in staged.items()), 'STAGED_CODE_CHANGED')
    need(lease() == base['lease'], 'OWN_LEASE_CHANGED')
    need(environment() == base['environment'], 'ENVIRONMENT_OR_PRICE_CHANGED_INSPECT_ONLY')
    for row in manifest['targets']:
        path = ROOT/row['target']
        need(parent_metadata(path) == base['parents'][row['target']], 'TARGET_PARENT_CHANGED')
        if row['beforeSha256'] is None:
            need(not os.path.lexists(AREA/'backup'/row['target']), 'UNEXPECTED_NEW_TARGET_BACKUP')
        else:
            need(sha((AREA/'backup'/row['target']).read_bytes()) == row['beforeSha256'], 'BACKUP_CHANGED')
    return manifest, base

def after_state(row, base):
    path = ROOT/row['target']
    need(metadata(path) == base['metadata'][row['target']], 'TARGET_METADATA_CHANGED')
    need(sha(path.read_bytes()) == row['afterSha256'], 'INSTALLED_READBACK_FAILED')

def replace_existing(path, raw, info, check):
    temp = path.with_name('.'+path.name+'.'+NAME+'.tmp')
    write_new(temp, raw)
    os.chmod(temp, info['mode'])
    os.chown(temp, info['uid'], info['gid'])
    check()
    os.replace(temp, path)
    sync_directory(path.parent)

def apply_order(manifest):
    """Publish dependencies first and the HTML entrypoint last, without changing pins."""
    rows = {row['target']: row for row in manifest['targets']}
    names = NEW + tuple(name for name in EXISTING if name != PREFIX+'cabinet.html') + (PREFIX+'cabinet.html',)
    return [rows[name] for name in names]

def apply():
    manifest, base = guard()
    need(not (AREA/'apply-attempt.json').exists(), 'ONE_ATTEMPT_ONLY_INSPECT_RESULT')
    for row in manifest['targets']:
        before_state(row, base['metadata'][row['target']])
    write_new(AREA/'apply-attempt.json', enc({'at': time.time(), 'lease': base['lease']}))
    for row in apply_order(manifest):
        path = ROOT/row['target']
        before_state(row, base['metadata'][row['target']])
        raw = (AREA/'payload'/row['target']).read_bytes()
        info = base['metadata'][row['target']]
        if row['beforeSha256'] is not None:
            replace_existing(path, raw, info, lambda: before_state(row, info))
        else:
            temp = path.with_name('.'+path.name+'.'+NAME+'.tmp')
            write_new(temp, raw)
            os.chmod(temp, info['mode'])
            os.chown(temp, info['uid'], info['gid'])
            before_state(row)
            # Atomic no-clobber publication: an arriving path can never be replaced.
            os.link(temp, path)
            temp.unlink()
            sync_directory(path.parent)
        after_state(row, base)
    inspect()

def inspect():
    manifest, base = guard()
    need((AREA/'apply-attempt.json').is_file(), 'NO_APPLY_ATTEMPT')
    for row in manifest['targets']:
        after_state(row, base)
    result = {'status': 'STATIC_NINE_INSTALLED_READBACK_PASS', 'at': time.time(), 'files': len(SCOPE), 'newFiles': len(NEW),
              'priceVersion': base['environment']['priceVersion'], 'priceSha256': base['environment']['priceSha256'],
              'runtimeWrites': 0, 'databaseWrites': 0, 'serviceRestarts': 0, 'lease': base['lease']}
    write_new(AREA/('inspect-'+str(time.time_ns())+'.json'), enc(result))
    if not (AREA/'installed.json').exists():
        write_new(AREA/'installed.json', enc(result))
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
        print('REFUSED: '+type(error).__name__+': '+str(error), file=sys.stderr)
        sys.exit(2)
