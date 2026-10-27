"""Bounded CRM-only release candidate. Nothing runs on import; no automatic retry/rollback.

Reuses the pinned, reviewed full-tree/image/config/CAS primitives. This is not an
installation receipt. A root-reviewed merged immutable package and fresh own lease
are required on the native machine before prepare/apply.
"""
from pathlib import Path
from contextlib import contextmanager
import argparse, copy, hashlib, importlib.util, io, json, os, re, sqlite3, stat, subprocess, sys, time, urllib.request, zipfile

sys.dont_write_bytecode = True
NAME = 'avocado-multi-recipient-20261027-r3'
ROOT = Path('/opt/synapse')
AREA = ROOT / 'releases' / NAME
SELF = Path(__file__).resolve()
PARENT = Path('/tmp/pc-i4.py')
PARENT_SHA = '19d8c6ea00264dc276920b3a196df9c3931d4b2e22c63fbe171da6e13904d73c'
CRM, CONTENT = 'synapse-crm-1', 'synapse-content-1'
CONTAINERS = (CRM, CONTENT, 'synapse-hugh-runtime-1', 'synapse-chat-1', 'caddy')
RUNTIME = ('email-recipients.js', 'email-settings.js', 'email-notifications.js', 'email-outbox.js', 'email-diagnostics.js')
STATIC = ROOT / 'sites/synapse/cabinet/settings.js'
WORKER = 'synapse-chat-1'
WORKER_IMAGE = 'sha256:4d5b047dc76bae1d2b82067406f98c344eea4033f83f35a54cdef7cd355ed2ae'
WORKER_GRAPH_SHA = '2c859e48348fc2ceeb9e403497aa81158c013c0937b14c5e9e7026c6eade999d'
WORKER_TREE_SHA = 'af68e20caf2e12f700b9a24d0d369dc0fc42a88303728f353243050ea0c05f54'
READER_MANIFEST_SHA = 'eb045f2cd7cc17fa21ad0b02025468e6727727f758b8d2bdd90a7bbd51c04d31'
READER_ZIP_SHA = 'e1a2e601cf6a3577d7139c58f45c10ba1f58b4ab3e71b449795f4c1a16756531'
READER_ZIP_BYTES = 19357
READER_SPEC_SHA = '4d25df65502909d9ee4d25087c4c0b9b2ae24375017c7fc40179c86d9f3cbc75'
ORIGINAL_SPEC_SHA = '75c4ae329ba5deabc5b630c897fc3f7594f780b51d80d6a7ffd6a8f7eb6cd014'
ORIGINAL_READER_DIRECTORY = Path('/opt/synapse/releases/palitra-app-20261015/palitra-tg-root-reader-configsafe-r2')
READER_ENTRY = '/opt/synapse/releases/'+NAME+'/reader/reader.py'
READER_CODE_PINS = {
    'config-readiness.js':'7ee95102786a534a307096c2ece36a06dec7805be7cd6b7b4242d9703caf17bb',
    'reader.py':'96f607ba528241ada07a67be1e8a64817c532951e0a912b6c54314d7ce1108a2',
    'selected-env.js':'722c7471751bb526954296d8e7e4fd13da1686d013e6ae9a861a2b3673367fd4',
    'tree.js':'b42266cabbc9f063f3c9460ed1c4b486f90738cfb09147cd2f087c150bdf9729',
    'worker-graph.js':'8dcc2b1c4519dcc53521e077b16861f65258ba1e1e7eb6b60fe64d9e6bca956f',
}
WORKER_FILES = frozenset(('client-bot-bridge.js','client-bot-config.js','client-bot-registry.js','consent-texts.json','project-chat-bridge.js','quiet-hours.js','server.js','task-intake.js','telegram-binding.js','telegram-channel-stats.js'))
WORKER_COMPATIBILITY = {'image':WORKER_IMAGE,'graphSha256':WORKER_GRAPH_SHA,'treeSha256':WORKER_TREE_SHA,
                        'readerManifestSha256':READER_MANIFEST_SHA,'readerZipSha256':READER_ZIP_SHA,'readerZipBytes':READER_ZIP_BYTES}
KNOWN_IMAGES = {
    CRM: 'sha256:6c802ba7fb5014becb2cd2c6c1b17ef509e2f9cda6780a841080cc36451e60d9',
    CONTENT: 'sha256:9a1ab665339b10a49a49d8c605075ae701e4b28a9db1a3bb3ec49483fd8e6f44',
    'synapse-hugh-runtime-1': 'sha256:1d89b9652c514c238c7509bd0d81f7a0a4d198cf7cd9990c90c7e3e05b045018',
    'synapse-chat-1': 'sha256:4d5b047dc76bae1d2b82067406f98c344eea4033f83f35a54cdef7cd355ed2ae',
    'caddy': 'sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648',
}
SERVER_SHA = 'b0146b3c3a9bc4a8cea15171d6ebd46d178d83072dbf08945778d4be7a332248'
LEDGER = 'lead_email_recipients'
LEDGER_SQL = """CREATE TABLE lead_email_recipients (
 lead_id INTEGER NOT NULL REFERENCES lead_email_outbox(lead_id) ON DELETE CASCADE,
 recipient TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','withdrawn')),
 attempts INTEGER NOT NULL DEFAULT 0,
 last_attempt_at TEXT,
 last_error_code TEXT,
 accepted_at TEXT,
 PRIMARY KEY (lead_id, recipient)
)"""
HEX64 = re.compile(r'[a-f0-9]{64}')
sha = lambda raw: hashlib.sha256(raw).hexdigest()
enc = lambda value: json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()

def need(value, code):
    if not value: raise ValueError(code)

def native_only():
    need(os.name == 'posix' and os.geteuid() == 0, 'NATIVE_LINUX_ROOT_ONLY')
    os.umask(0o077)

def safe_read(path):
    path = Path(path)
    for part in (path, *path.parents): need(not part.is_symlink(), 'PATH_ALIAS')
    st = path.lstat()
    need(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_size <= 64*1024*1024, 'REGULAR_BOUNDED_FILE')
    if os.name == 'posix': need(st.st_uid == st.st_gid == 0, 'ROOT_OWNED_FILE')
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0) | getattr(os, 'O_BINARY', 0))
    try:
        with os.fdopen(fd, 'rb', closefd=False) as stream: raw = stream.read(64*1024*1024+1)
        fields = ('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns')
        need(len(raw) == st.st_size and all(getattr(st,k) == getattr(os.fstat(fd),k) == getattr(path.lstat(),k) for k in fields), 'STABLE_READ_REQUIRED')
        return raw
    finally: os.close(fd)

def write_new(path, raw):
    path = Path(path)
    for part in (path, *path.parents): need(not part.is_symlink(), 'WRITE_ALIAS')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())

def load(path): return json.loads(safe_read(path))

def validate_manifest(m):
    need(set(m) == {'schema','packageId','status','rootCompatibilityReview','helperSha256','zipSha256','zipBytes','expectedImages','runtime','static','unchangedRuntime','workerCompatibility'}, 'EXACT_MANIFEST_FIELDS')
    need(m['schema'] == 1 and m['packageId'] == NAME and m['status'] == 'EXACT_MERGED_REVIEW_READY' and m['rootCompatibilityReview'] == 'ACCEPTED', 'ROOT_REVIEW_REQUIRED')
    need(HEX64.fullmatch(m['helperSha256']) and HEX64.fullmatch(m['zipSha256']) and type(m['zipBytes']) is int and 0 < m['zipBytes'] <= 3*1024*1024, 'PACKAGE_PINS_REQUIRED')
    images = m['expectedImages']
    need(set(images) == set(CONTAINERS) and all(re.fullmatch('sha256:[a-f0-9]{64}', x) for x in images.values()), 'ALL_FIVE_IMAGE_PINS_REQUIRED')
    need(all(images[k] == v for k,v in KNOWN_IMAGES.items()), 'ACCEPTED_CURRENT_IMAGES_REQUIRED')
    need(m['unchangedRuntime'] == {'server.js': SERVER_SHA}, 'SERVER_MUST_REMAIN_EXACT')
    need(m['workerCompatibility'] == WORKER_COMPATIBILITY, 'EXACT_REVIEWED_WORKER_COMPATIBILITY')
    need(type(m['runtime']) is list and len(m['runtime']) == len(RUNTIME) and {r['file'] for r in m['runtime']} == {'candidate/crm/'+n for n in RUNTIME}, 'EXACT_FIVE_RUNTIME_FILES')
    need(type(m['static']) is list and len(m['static']) == 1 and m['static'][0]['file'] == 'candidate/static/settings.js', 'EXACT_ONE_STATIC_FILE')
    for row in m['runtime'] + m['static']:
        need(set(row) == {'file','beforeSha256','sha256','bytes'} and HEX64.fullmatch(row['sha256']) and type(row['bytes']) is int and 0 < row['bytes'] <= 1024*1024, 'EXACT_BOUNDED_ROW')
        if row['file'] == 'candidate/crm/email-recipients.js': need(row['beforeSha256'] is None, 'NEW_HELPER_MUST_BE_ABSENT')
        else: need(type(row['beforeSha256']) is str and HEX64.fullmatch(row['beforeSha256']), 'EXACT_BEFORE_PIN')
    return m

def unpack_payload(raw, m):
    need(len(raw) == m['zipBytes'] and sha(raw) == m['zipSha256'], 'ZIP_PIN')
    expected = {r['file']: r for r in m['runtime'] + m['static']}
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entries = archive.infolist()
        need(len(entries) == len(expected) and len({e.filename for e in entries}) == len(entries) and {e.filename for e in entries} == set(expected), 'ZIP_CLOSED_SIX_FILES')
        need(sum(e.file_size for e in entries) <= 6*1024*1024, 'ZIP_TOTAL_SIZE')
        result = {}
        for entry in entries:
            need(not entry.is_dir() and not stat.S_ISLNK(entry.external_attr >> 16), 'ZIP_LINK_OR_DIRECTORY')
            row = expected[entry.filename]; value = archive.read(entry)
            need(len(value) == row['bytes'] and sha(value) == row['sha256'], 'ZIP_FILE_PIN')
            result[entry.filename] = value
        return result

def package():
    staged, m = load(AREA/'stage.json'), validate_manifest(load(AREA/'manifest.json'))
    need(sha(safe_read(AREA/'manifest.json')) == staged['manifestSha256'] and sha(safe_read(SELF)) == staged['helperSha256'] == m['helperSha256'], 'STAGED_CODE_CHANGED')
    expected = {r['file'] for r in m['runtime'] + m['static']}
    need({p.relative_to(AREA/'code').as_posix() for p in (AREA/'code').rglob('*') if p.is_file()} == expected, 'CLOSED_STAGED_CODE')
    for row in m['runtime'] + m['static']:
        raw = safe_read(AREA/'code'/row['file'])
        need(len(raw) == row['bytes'] and sha(raw) == row['sha256'], 'STAGED_PAYLOAD_CHANGED')
    reader_package()
    return staged, m, {'files': m['runtime'] + m['static']}

def stage(commit, pin):
    need(re.fullmatch('[a-f0-9]{40}', commit) and HEX64.fullmatch(pin), 'IMMUTABLE_PUBLIC_PINS')
    need(not AREA.exists(), 'STAGE_EXISTS_INSPECT_ONLY')
    for part in (AREA.parent, *AREA.parent.parents):
        need(part.is_dir() and not part.is_symlink(), 'CANONICAL_RELEASE_PARENT')
    origin = 'https://raw.githubusercontent.com/Elk0980/synapse-server/'+commit+'/ops/'+NAME+'/'
    with urllib.request.urlopen(origin+'manifest.json', timeout=30) as response: raw = response.read(64001)
    need(len(raw) <= 64000 and sha(raw) == pin, 'MANIFEST_PIN')
    m = validate_manifest(json.loads(raw)); need(sha(safe_read(SELF)) == m['helperSha256'], 'HELPER_PIN')
    with urllib.request.urlopen(origin+'payload.zip', timeout=30) as response: payload = response.read(m['zipBytes']+1)
    files = unpack_payload(payload, m)
    with urllib.request.urlopen(origin+'reader.zip', timeout=30) as response: reader_raw = response.read(READER_ZIP_BYTES+1)
    reader_manifest_raw, reader_files = unpack_reader(reader_raw)
    AREA.mkdir(mode=0o700)
    for name, value in files.items():
        path = AREA/'code'/name; path.parent.mkdir(mode=0o700, parents=True, exist_ok=True); write_new(path, value)
    for name, value in reader_files.items():
        path = AREA/'reader'/name; path.parent.mkdir(mode=0o700, parents=True, exist_ok=True); write_new(path,value)
    write_new(AREA/'reader-manifest.json',reader_manifest_raw)
    write_new(AREA/'manifest.json', raw)
    write_new(AREA/'stage.json', enc({'commit':commit,'manifestSha256':pin,'helperSha256':m['helperSha256']}))
    package(); print('STAGED_SIX_PRODUCT_FILES_AND_EXACT_READER_R3_NOT_INSTALLED')

def assert_reader_rebase(original_spec, revised_spec):
    need(set(original_spec.get('workerGraphExpected',{})) == WORKER_FILES, 'ORIGINAL_CLOSED_TEN_WORKER_FILES')
    need(original_spec['workerGraphExpected']['client-bot-bridge.js'] == [34975,'ac3a139d9715036ce5a6966794b61d65e900b0deb2eb3cf6edcd108c643cf683'], 'EXACT_OLD_BRIDGE_PAIR')
    expected = copy.deepcopy(original_spec)
    expected['workerGraphExpected']['client-bot-bridge.js'] = [27676,'36b0bdc733ad4f4514635d0416867d5964fef4c82aeabe125f542a20969de0ee']
    need(revised_spec == expected, 'ONLY_REVIEWED_BRIDGE_METADATA_REBASE')

def validate_reader_manifest(manifest, old_contract=None):
    need(set(manifest) == {'entry','files','readOnly','readScriptScopes','readScriptSha256','schema'}, 'CLOSED_READ_CONTRACT')
    expected_files = {**READER_CODE_PINS,'spec.json':READER_SPEC_SHA}
    need(manifest['entry'] == READER_ENTRY and manifest['files'] == expected_files and manifest['readOnly'] is True and manifest['schema'] == 'palitra-tg-root-readonly/v1', 'EXACT_READER_R3_FILES')
    selected,config,graph,tree = (READER_CODE_PINS[n] for n in ('selected-env.js','config-readiness.js','worker-graph.js','tree.js'))
    scopes = {selected:{'containers':[CONTENT,WORKER],'images':False},config:{'containers':[CONTENT],'images':False},
              graph:{'containers':[WORKER],'images':False},tree:{'containers':[CONTENT],'images':True}}
    need(manifest['readScriptScopes'] == scopes and manifest['readScriptSha256'] == [selected,config,graph,tree], 'ORIGINAL_PROBE_SCOPES_UNCHANGED')
    if old_contract is not None:
        expected = copy.deepcopy(old_contract);expected['entry'] = READER_ENTRY;expected['files']['spec.json'] = READER_SPEC_SHA
        need(manifest == expected, 'ORIGINAL_READ_CONTRACT_UNCHANGED')
    return manifest

def unpack_reader(raw):
    need(len(raw) == READER_ZIP_BYTES and sha(raw) == READER_ZIP_SHA, 'READER_ZIP_PIN')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        names = {'reader-code/'+n for n in (*READER_CODE_PINS,'spec.json')}|{'reader-manifest.json'}
        entries = archive.infolist()
        need(len(entries) == len(names) and {e.filename for e in entries} == names and sum(e.file_size for e in entries) < 256*1024, 'READER_ZIP_CLOSURE')
        need(all(not e.is_dir() and not stat.S_ISLNK(e.external_attr>>16) for e in entries), 'READER_ZIP_FILE_BOUNDARY')
        raw_manifest = archive.read('reader-manifest.json');need(sha(raw_manifest) == READER_MANIFEST_SHA, 'READER_MANIFEST_PIN')
        manifest = validate_reader_manifest(json.loads(raw_manifest))
        files = {name:archive.read('reader-code/'+name) for name in manifest['files']}
        need(all(sha(value) == manifest['files'][name] for name,value in files.items()), 'READER_STREAM_PIN')
        return raw_manifest,files

def reader_package():
    raw = safe_read(AREA/'reader-manifest.json');need(sha(raw) == READER_MANIFEST_SHA, 'READER_MANIFEST_CHANGED')
    manifest = validate_reader_manifest(json.loads(raw))
    entries = list((AREA/'reader').rglob('*'))
    need(len(entries) == len(manifest['files']) and all(p.parent == AREA/'reader' and p.is_file() and not p.is_symlink() for p in entries) and {p.name for p in entries} == set(manifest['files']), 'READER_CLOSED_FILES')
    for name,pin in manifest['files'].items(): need(sha(safe_read(AREA/'reader'/name)) == pin, 'READER_FILE_CHANGED')
    return manifest

def primitives():
    raw = safe_read(PARENT); need(sha(raw) == PARENT_SHA, 'EXACT_REVIEWED_PRIMITIVES')
    old = {'__name__':'reviewed_crm_component_primitives','__file__':str(PARENT)}
    exec(compile(raw, str(PARENT), 'exec'), old)
    old.update(AREA=AREA, SELF=SELF, package=package)
    product, native, _original_reader, original_contract = old['primitive']()
    contract = reader_package();validate_reader_manifest(contract,original_contract)
    raw_spec = safe_read(ORIGINAL_READER_DIRECTORY/'spec.json');need(sha(raw_spec) == ORIGINAL_SPEC_SHA, 'ORIGINAL_SPEC_PIN')
    assert_reader_rebase(json.loads(raw_spec),load(AREA/'reader/spec.json'))
    module_spec = importlib.util.spec_from_file_location('accepted_avocado_reader_r3',AREA/'reader/reader.py')
    reader = importlib.util.module_from_spec(module_spec);module_spec.loader.exec_module(reader)
    return old, product, native, reader, contract

def validate_worker_observation(image_id, image_graph, actual_graph, image_tree, actual_tree):
    need(image_id == WORKER_IMAGE, 'EXACT_ACCEPTED_WORKER_IMAGE')
    need(type(image_graph) is dict and image_graph.get('schema') == 1 and type(image_graph.get('files')) is dict and set(image_graph['files']) == WORKER_FILES, 'CLOSED_IMMUTABLE_WORKER_GRAPH')
    need(sha(enc(image_graph)) == WORKER_GRAPH_SHA and image_graph == actual_graph, 'PINNED_WORKER_GRAPH_CHANGED')
    need(type(image_tree) is dict and len(image_tree) == 30 and sha(enc(image_tree)) == WORKER_TREE_SHA and image_tree == actual_tree, 'PINNED_WORKER_FULL_TREE_CHANGED')
    return {'image':WORKER_IMAGE,'graphSha256':WORKER_GRAPH_SHA,'treeSha256':WORKER_TREE_SHA,'graphFiles':10,'treeEntries':30}

def pinned_worker_probe(old, reader, snapshot):
    # Explicit additional Root-only proof. It does not widen Native.read_command,
    # its script scopes, its image allowlist or any existing reader startup gate.
    # The original snapshot must have passed before this function is called.
    observed = snapshot['invariants']['foreignContainers'][WORKER]
    before = old['inspect'](WORKER)
    need(before['Name'].lstrip('/') == WORKER and before['Image'] == WORKER_IMAGE and re.fullmatch('[a-f0-9]{64}',before['Id']) and reader.foreign(before) == observed, 'WORKER_IDENTITY_CHANGED_BEFORE_PROBE')
    image = old['image_info'](WORKER_IMAGE)
    need(image['Id'] == WORKER_IMAGE and image.get('Os') == 'linux' and image.get('Architecture') == 'amd64' and image.get('Variant','') == '', 'WORKER_IMAGE_PLATFORM')
    spec = load(AREA/'reader/spec.json');env = reader.env_map(image['Config'].get('Env',[]))
    options = env.get('NODE_OPTIONS','')
    need((not options or sha(options.encode()) == spec['workerNodeOptionsSha256']) and all(not env.get(k) for k in spec['workerHookNames'] if k != 'NODE_OPTIONS'), 'IMMUTABLE_IMAGE_NODE_PROFILE')
    need(image['Config']['WorkingDir'] == '/app' and image['Config']['Cmd'] == ['node','server.js'] and image['Config']['Entrypoint'] in (['docker-entrypoint.sh'],['/usr/local/bin/docker-entrypoint.sh']) and image['Config']['User'] in ('','root','0'), 'IMMUTABLE_IMAGE_STARTUP')
    def probe(script_name, immutable):
        need(script_name in ('worker-graph.js','tree.js') and type(immutable) is bool, 'CLOSED_ROOT_PROBE')
        script = safe_read(AREA/'reader'/script_name);need(sha(script) == READER_CODE_PINS[script_name], 'ROOT_PROBE_SCRIPT_PIN')
        if immutable:
            argv = ['docker','run','--rm','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint=node',WORKER_IMAGE,'-e',script.decode()]
        else:
            argv = ['docker','exec',before['Id'],'node','-e',script.decode()]
        result = subprocess.run(argv,stdin=subprocess.DEVNULL,capture_output=True,timeout=90)
        need(result.returncode == 0 and len(result.stdout) <= 32*1024*1024 and len(result.stderr) <= 1024*1024, 'ROOT_READONLY_WORKER_PROBE_FAILED')
        return reader.parse(result.stdout)
    image_graph,actual_graph = probe('worker-graph.js',True),probe('worker-graph.js',False)
    image_tree,actual_tree = probe('tree.js',True),probe('tree.js',False)
    proof = validate_worker_observation(before['Image'],image_graph,actual_graph,image_tree,actual_tree)
    after = old['inspect'](WORKER)
    need(reader.foreign(after) == observed and after['Id'] == before['Id'], 'WORKER_IDENTITY_CHANGED_DURING_PROBE')
    return {**proof,'containerId':before['Id'],'foreignSha256':sha(enc(observed))}

def own_lease(old, native):
    records = json.loads(old['run'](['lslocks','--json','--output','PID,PATH']))['locks']
    records = [r for r in records if r.get('path') == str(native.LOCK)]
    need(len(records) == 1, 'ONE_FRESH_LEASE_REQUIRED')
    pid = int(records[0]['pid']); parent = os.getppid(); ancestors = set()
    while parent > 1 and parent not in ancestors:
        ancestors.add(parent); raw = Path('/proc/'+str(parent)+'/stat').read_text(); parent = int(raw[raw.rfind(')')+2:].split()[1])
    need(pid in ancestors, 'OWN_ANCESTOR_LEASE_REQUIRED')
    raw = Path('/proc/'+str(pid)+'/stat').read_text()
    result = {'pid':pid,'startTicks':raw[raw.rfind(')')+2:].split()[19],'path':str(native.LOCK)}
    native.Ticket.native_lease(result); return result

def longest_chain(chains):
    need(chains and all(c and len(c) == len(set(c)) for c in chains), 'UNIQUE_COMPOSE_CHAINS')
    longest = max(chains, key=len)
    need(all(longest[:len(c)] == c for c in chains), 'DIVERGENT_ACTIVE_COMPOSE_CHAINS')
    return longest

def assert_image_delta(before, observed, image):
    expected = copy.deepcopy(before)
    expected['services']['crm']['image'] = image
    need(observed == expected, 'ONLY_CRM_IMAGE_MAY_CHANGE')

def effective_plan(old, expected):
    rows = {name:old['inspect'](name) for name in CONTAINERS}
    need(all(r['State']['Running'] and not r['State']['Restarting'] and r['Image'] == expected[name] for name,r in rows.items()), 'FRESH_EXPECTED_SERVICES_REQUIRED')
    labels = [r['Config']['Labels'] for r in rows.values()]
    need({l['com.docker.compose.project'] for l in labels} == {'synapse'}, 'ONE_CURRENT_PROJECT')
    directories = {l['com.docker.compose.project.working_dir'] for l in labels}; need(len(directories) == 1, 'ONE_PROJECT_DIRECTORY')
    chains = [l['com.docker.compose.project.config_files'].split(',') for l in labels]
    chain = longest_chain(chains)
    plan = {'project':'synapse','directory':directories.pop(),'files':[{'path':p,'sha256':sha(old['read'](p))} for p in chain]}
    plan['resolved'] = json.loads(old['run'](old['compose_args'](plan)+['config','--format','json']))
    for row in rows.values():
        service = row['Config']['Labels']['com.docker.compose.service']
        image = plan['resolved']['services'][service]['image']
        actual = old['run'](['docker','image','inspect','--format','{{.Id}}',image]).decode().strip()
        need(actual == row['Image'], 'GLOBAL_PLAN_MUST_MATCH_EVERY_ACTIVE_IMAGE')
    crm_labels = rows[CRM]['Config']['Labels']
    crm_plan = {**plan,'files':[{'path':p,'sha256':sha(old['read'](p))} for p in crm_labels['com.docker.compose.project.config_files'].split(',')]}
    actual_hash = old['run'](old['compose_args'](crm_plan)+['config','--hash','crm']).decode().strip()
    need(actual_hash == 'crm '+crm_labels['com.docker.compose.config-hash'], 'ACTUAL_CRM_CONFIG_LABEL_REQUIRED')
    return plan

def policy_state():
    result = {}
    for action, expected in [('is-active','inactive'),('is-enabled','disabled')]:
        run = subprocess.run(['systemctl',action,'synapse-sync.timer'], stdin=subprocess.DEVNULL, capture_output=True, timeout=20)
        value = run.stdout.decode().strip(); need(value == expected, 'LEGACY_SYNC_MUST_REMAIN_DISABLED'); result[action] = value
    for path in ['/etc/synapse/managed-release.json','/etc/systemd/system/synapse-sync.service.d/50-managed-release.conf','/usr/local/sbin/synapse-sync','/opt/synapse/ops/synapse-sync','/opt/synapse/caddy/Caddyfile']:
        result[path] = sha(safe_read(path))
    return result

def database_path(row):
    mounts = row['Mounts']; need(len(mounts) == 1 and mounts[0]['Destination'] == '/data' and mounts[0]['RW'], 'ONLY_EXISTING_CRM_DATA_MOUNT')
    entries = row['Config'].get('Env', []); names = [v.split('=',1)[0] for v in entries]
    need(len(names) == len(set(names)), 'DUPLICATE_ENVIRONMENT_KEYS')
    env = dict(v.split('=',1) for v in entries)
    name = env.get('DATABASE_PATH','/data/crm.sqlite')
    need(re.fullmatch(r'/data/[A-Za-z0-9_.-]+\.sqlite',name), 'EXACT_CRM_SQLITE_PATH')
    path = Path(mounts[0]['Source'])/Path(name).name
    need(path.resolve() == path, 'CANONICAL_DATABASE_PATH')
    return path

@contextmanager
def db_open(path):
    connection = sqlite3.connect(Path(path).as_uri()+'?mode=ro', uri=True, isolation_level=None, timeout=5)
    try:
        connection.execute('PRAGMA query_only=ON'); connection.execute('BEGIN')
        yield connection
    finally:
        if connection.in_transaction: connection.rollback()
        connection.close()

def quote(name): return '"'+name.replace('"','""')+'"'
def cell(value): return {'blob':value.hex()} if isinstance(value,bytes) else value
def sql_normal(value): return re.sub(r'\s+','',value)

def db_facts(connection):
    need(connection.execute('PRAGMA quick_check').fetchone() == ('ok',), 'CRM_QUICK_CHECK')
    schema = connection.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall()
    tables = {}
    for kind, name, _, sql in schema:
        if kind != 'table' or name == LEDGER: continue
        info = connection.execute('PRAGMA table_info('+quote(name)+')').fetchall()
        columns = [r[1] for r in info]; keys = [r[1] for r in sorted(info,key=lambda r:r[5]) if r[5]]
        columns_sql = ','.join(map(quote,columns))
        key_sql = ','.join(map(quote,keys)) if keys else 'rowid'
        rows = {}
        for values in connection.execute('SELECT '+key_sql+','+columns_sql+' FROM '+quote(name)):
            count = len(keys) if keys else 1
            identity = sha(enc([cell(v) for v in values[:count]]))
            need(identity not in rows, 'UNIQUE_OLD_ROW_IDENTITIES')
            rows[identity] = sha(enc([cell(v) for v in values[count:]]))
        tables[name] = {'columns':columns,'rows':rows}
    outstanding = connection.execute("SELECT count(*) FROM lead_email_outbox WHERE status <> 'sent'").fetchone()[0]
    maximum = connection.execute('SELECT COALESCE(MAX(id),0) FROM leads').fetchone()[0]
    return {'schema':schema,'tables':tables,'outstanding':outstanding,'maxLeadId':maximum}

def assert_database(connection, baseline, after):
    observed = db_facts(connection)
    old_schema = [tuple(row) for row in baseline['schema']]
    if after:
        additions = [r for r in observed['schema'] if r not in old_schema]
        need(len(additions) == 1 and additions[0][:3] == ('table',LEDGER,LEDGER) and sql_normal(additions[0][3]) == sql_normal(LEDGER_SQL), 'ONLY_EXACT_ADDITIVE_LEDGER')
        need(all(row in observed['schema'] for row in old_schema), 'OLD_SCHEMA_PRESERVED')
        need(connection.execute('SELECT count(*) FROM lead_email_recipients WHERE lead_id <= ?', (baseline['maxLeadId'],)).fetchone()[0] == 0, 'OLD_LEADS_MUST_NOT_BE_MASS_MAILED')
    else:
        need(observed['schema'] == old_schema and observed['outstanding'] == 0, 'FRESH_EMPTY_DELIVERY_QUEUE_REQUIRED')
    for name, old in baseline['tables'].items():
        current = observed['tables'].get(name)
        need(current is not None and current['columns'] == old['columns'] and all(current['rows'].get(k) == v for k,v in old['rows'].items()), 'OLD_CRM_ROWS_CHANGED_INSPECT_ONLY')
    need(connection.total_changes == 0, 'DATABASE_READ_ONLY')
    return {'oldTables':len(baseline['tables']),'oldRows':sum(len(v['rows']) for v in baseline['tables'].values()),'outstanding':observed['outstanding'],'quickCheck':'ok'}

def rollback_facts(connection, environment=()):
    # Diagnostic only: never changes configuration, data, images or lifecycle.
    pending = connection.execute("SELECT count(*) FROM lead_email_outbox WHERE status <> 'sent'").fetchone()[0]
    has_ledger = connection.execute("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name=?", (LEDGER,)).fetchone()[0]
    partial = connection.execute("SELECT count(*) FROM lead_email_recipients r JOIN lead_email_outbox o ON o.lead_id=r.lead_id WHERE o.status <> 'sent' AND (r.status='accepted' OR r.last_error_code='EMAIL_DELIVERY_UNCONFIRMED')").fetchone()[0] if has_ledger else 0
    multi = 0
    if connection.execute("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='company_email_recipients'").fetchone()[0]:
        multi += sum(',' in (value or '') or ';' in (value or '') or '\n' in (value or '') for (value,) in connection.execute('SELECT recipient FROM company_email_recipients'))
    for entry in environment:
        key, _, value = entry.partition('=')
        if key.startswith('LEADS_NOTIFY_EMAIL'): multi += int(',' in value or ';' in value or '\n' in value)
    return {'safeForSeparateReviewedLegacyRollback':not (pending or partial or multi),'outstanding':pending,'partialOrUnknown':partial,'multiConfigs':multi,'automaticRollback':False}

def create_backup(source, destination, baseline, guard, clock=time.monotonic):
    guard(); write_new(destination,b'')
    src = sqlite3.connect(Path(source).as_uri()+'?mode=ro',uri=True,timeout=5)
    dst = sqlite3.connect(destination)
    started = clock()
    def progress(status, remaining, total):
        need(clock()-started < 120, 'BACKUP_DEADLINE_INSPECT_ONLY'); guard()
    try:
        src.execute('PRAGMA query_only=ON')
        need(src.execute('PRAGMA query_only').fetchone() == (1,), 'READ_ONLY_BACKUP_SOURCE')
        src.backup(dst,pages=128,progress=progress)
        assert_database(dst,baseline,False)
    finally: src.close(); dst.close()
    os.chmod(destination,0o600); guard()
    return {'path':str(destination),'sha256':sha(safe_read(destination)),'quickCheck':'ok'}

def prepare():
    staged, m, _ = package(); old, _, native, reader, contract = primitives(); lease = own_lease(old,native)
    need(not (AREA/'base.json').exists() and not (AREA/'action.json').exists(), 'PREPARE_EXISTS_INSPECT_ONLY')
    content = old['content_snapshot'](native,reader,contract); crm = old['inspect'](CRM); tree = old['tree'](CRM,reader)
    worker_proof = pinned_worker_probe(old,reader,content)
    need(content['image'] == m['expectedImages'][CONTENT] and crm['Image'] == m['expectedImages'][CRM], 'FRESH_IMAGE_PINS')
    need(old['image_tree'](crm['Image'],reader) == tree and old['image_tree'](content['image'],reader) == content['appTree'], 'RUNNING_IMAGES_FULL_TREE_EXACT')
    for name, pin in m['unchangedRuntime'].items(): need(tree.get(name,{}).get('sha256') == pin, 'UNCHANGED_RUNTIME_PIN')
    overlays = {CONTENT:{},CRM:{}}
    for row in m['runtime']:
        name = Path(row['file']).name; before = tree.get(name)
        need((before is None if row['beforeSha256'] is None else before and before['type'] == 'file' and before['nlink'] == 1 and before['sha256'] == row['beforeSha256']), 'CRM_SOURCE_BEFORE_PIN')
        overlays[CRM][name] = row
    row = m['static'][0]; need(sha(safe_read(STATIC)) == row['beforeSha256'], 'STATIC_BEFORE_PIN')
    st = STATIC.lstat(); need(st.st_uid == st.st_gid == 0 and st.st_nlink == 1, 'STATIC_ROOT_BOUNDARY')
    path = database_path(crm); identity = old['db_identity'](path)
    with db_open(path) as connection: facts = db_facts(connection)
    need(facts['outstanding'] == 0 and not any(r[1] == LEDGER for r in facts['schema']), 'EMPTY_QUEUE_AND_NEW_LEDGER_REQUIRED')
    base = {'content':content,'workerProof':worker_proof,'crm':crm,'crmTree':tree,'crmDatabase':{'databasePath':str(path),'databaseIdentity':identity},'databaseFacts':facts,'overlays':overlays,
            'statics':{str(STATIC):{**row,'sha256':row['beforeSha256'],'afterSha256':row['sha256'],'mode':stat.S_IMODE(st.st_mode)}},
            'effectiveCompose':effective_plan(old,m['expectedImages']),'policy':policy_state()}
    write_new(AREA/'base.json',enc(base)); now = time.time()
    action = {'status':'ROOT_AUTHORIZED_ONE_ATTEMPT','created':now,'expires':now+1800,'lease':lease,'baseSha256':sha(enc(base)),
              'bundleSha256':staged['manifestSha256'],'helperSha256':staged['helperSha256'],'namespace':NAME+'-'+os.urandom(8).hex(),'singleWriter':'Root'}
    write_new(AREA/'action.json',enc(action)); print('FRESH_CRM_BASE_READY_NOT_APPLIED')

def driver(after=False):
    staged, m, _ = package(); old, product, native, reader, contract = primitives()
    class Apply(old['Apply']):
        def __init__(self):
            self.staged = {**staged,'bundleSha256':staged['manifestSha256']}; self.bundle = m; self.m = {'files':m['runtime']+m['static']}
            self.product,self.native,self.reader,self.contract = product,native,reader,contract
            self.action,self.base = load(AREA/'action.json'),load(AREA/'base.json'); self.readLease = own_lease(old,native)
            self.children,self.plan,self.published,self.seq = {},None,set(),0
            self.journal = AREA/'journal'
            if after:
                result = load(AREA/'installed.json'); self.children,self.plan = result['images'],result['plan']; self.published = set(self.base['statics'])
            self.ticket()
        def ticket(self):
            need(self.action['status'] == 'ROOT_AUTHORIZED_ONE_ATTEMPT' and self.action['singleWriter'] == 'Root' and self.action['namespace'].startswith(NAME+'-') and 0 < self.action['expires']-self.action['created'] <= 1800, 'EXACT_ROOT_ACTION')
            need(load(AREA/'action.json') == self.action and sha(safe_read(AREA/'base.json')) == self.action['baseSha256'], 'ACTION_OR_BASE_CHANGED')
            need(self.action['helperSha256'] == staged['helperSha256'] and self.action['bundleSha256'] == staged['manifestSha256'], 'ACTION_CODE_CHANGED')
            native.Ticket.native_lease(self.readLease)
            if not after:
                need(self.action['lease'] == self.readLease, 'ORIGINAL_OWN_LEASE_REQUIRED')
                need(self.action['created'] <= time.time() < self.action['expires'], 'FRESH_ACTION_REQUIRED')
        def guard(self, installed=False):
            self.ticket(); package(); actual_crm = self.crm_guard(installed)
            actual = old['content_snapshot'](native,reader,contract); expected = copy.deepcopy(self.base['content'])
            need(pinned_worker_probe(old,reader,actual) == self.base['workerProof'], 'BASE_WORKER_PROOF_CHANGED')
            if installed: expected['invariants']['foreignContainers'][CRM] = reader.foreign(actual_crm)
            for target in self.published:
                if target in expected['static']: expected['static'][target]['sha256'] = self.base['statics'][target]['afterSha256']
            need(actual == expected, 'FULL_UNCHANGED_CONTENT_AND_FOREIGN_STATE')
            for target,row in self.base['statics'].items():
                info = Path(target).lstat()
                need(info.st_uid == info.st_gid == 0 and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == row['mode'], 'STATIC_METADATA_CHANGED')
                need(sha(safe_read(target)) == (row['afterSha256'] if target in self.published else row['sha256']), 'STATIC_CAS')
            images = dict(m['expectedImages'])
            if installed: images[CRM] = self.children[CRM]['image']
            plan = effective_plan(old,images); need(plan == (self.plan if installed else self.base['effectiveCompose']), 'FULL_EFFECTIVE_COMPOSE_CHANGED')
            need(policy_state() == self.base['policy'], 'MANAGED_POLICY_OR_CADDY_CHANGED')
            with db_open(self.base['crmDatabase']['databasePath']) as connection: assert_database(connection,self.base['databaseFacts'],installed)
            return sha(enc(actual))
        def backup(self):
            self.guard(); result = {}
            destination = self.journal/'crm.sqlite'
            result['crm'] = create_backup(self.base['crmDatabase']['databasePath'],destination,self.base['databaseFacts'],self.ticket)
            for index,(name,row) in enumerate(self.base['statics'].items()):
                raw = safe_read(name); need(sha(raw) == row['sha256'], 'STATIC_BACKUP_PIN'); write_new(self.journal/('static-'+str(index)),raw)
            self.guard(); return result
        def make_plan(self):
            self.guard(); path = self.journal/'crm-image-only.json'
            old['write'](path,enc({'services':{'crm':{'image':self.children[CRM]['image']}}}))
            plan = copy.deepcopy(self.base['effectiveCompose']); plan['files'].append({'path':str(path),'sha256':sha(safe_read(path))})
            observed = json.loads(old['run'](old['compose_args'](plan)+['config','--format','json']))
            assert_image_delta(plan['resolved'],observed,self.children[CRM]['image']); plan['resolved'] = observed; self.plan = plan
            return {'files':len(plan['files']),'onlyCRMImageChanged':True}
        def up(self):
            self.guard(); need(json.loads(old['run'](old['compose_args'](self.plan)+['config','--format','json'])) == self.plan['resolved'], 'LATE_COMPOSE_CAS')
            with db_open(self.base['crmDatabase']['databasePath']) as connection: need(db_facts(connection)['outstanding'] == 0, 'NO_OUTSTANDING_BEFORE_RESTART')
            self.ticket(); old['run'](old['compose_args'](self.plan)+['up','--detach','--no-build','--pull','never','--no-deps','crm'],180)
            deadline = time.monotonic()+45
            while True:
                self.ticket(); state = old['inspect'](CRM)['State']
                if state['Running'] and not state['Restarting'] and not state['OOMKilled'] and state.get('Health',{}).get('Status') in (None,'healthy'): break
                need(time.monotonic() < deadline, 'HEALTH_TIMEOUT_INSPECT_ONLY'); time.sleep(1)
            return {'crmOnly':True,'requiresIndependentReadback':True}
        def execute(self):
            self.guard(); need(not self.journal.exists() and not (AREA/'installed.json').exists(), 'ONE_ATTEMPT_INSPECT_ONLY')
            self.journal.mkdir(mode=0o700); self.record('admission','PASS')
            backup = self.once('protected-crm-backup',self.backup)
            self.once('build-exact-one-crm-layer',lambda:self.build(CRM))
            self.once('crm-image-only-plan',self.make_plan)
            self.once('crm-up-once',self.up); self.guard(True)
            self.once('settings-static-cas',self.publish); observed = self.guard(True)
            result = {'status':'INSTALLED_PENDING_LIVE_ACCEPTANCE','images':self.children,'plan':self.plan,'backup':backup,'snapshotSha256':observed,
                      'runtimeFiles':5,'staticFiles':1,'businessRowsWritten':0,'automaticRollback':False,'dataRestored':False}
            write_new(AREA/'installed.json',enc(result)); print('CRM_COMPONENT_INSTALLED_REQUIRES_INDEPENDENT_INSPECT')
    return Apply()

def inspect_result():
    obj = driver(True); digest = obj.guard(True)
    with db_open(obj.base['crmDatabase']['databasePath']) as connection: rollback = rollback_facts(connection,old_environment(obj))
    report = {'status':'INDEPENDENT_NATIVE_READBACK_PASS','snapshotSha256':digest,'runtimeFiles':5,'staticFiles':1,'rollback':rollback,'inboxVerified':False,'physicalPhoneVerified':False}
    write_new(AREA/('inspect-'+str(time.time_ns())+'.json'),enc(report)); print(json.dumps(report))

def old_environment(obj): return obj.base['crm']['Config'].get('Env',[])

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=['stage','prepare','apply','inspect'])
    parser.add_argument('pins',nargs='*'); args = parser.parse_args(); native_only()
    if args.mode == 'stage': need(len(args.pins) == 2,'STAGE_COMMIT_AND_MANIFEST_PIN'); stage(*args.pins)
    elif args.mode == 'prepare': need(not args.pins,'NO_EXTRA_ARGUMENTS'); prepare()
    elif args.mode == 'apply': need(not args.pins,'NO_EXTRA_ARGUMENTS'); driver().execute()
    else: need(not args.pins,'NO_EXTRA_ARGUMENTS'); inspect_result()

if __name__ == '__main__':
    try: main()
    except Exception as error:
        code = str(error)
        print(json.dumps({'status':'STOP_INSPECT_ONLY_NO_AUTOMATIC_RETRY','code':code if type(error) is ValueError and re.fullmatch('[A-Z0-9_]{1,96}',code) else 'COMPONENT_OPERATION_FAILED','automaticRollback':False}))
        raise SystemExit(2)
