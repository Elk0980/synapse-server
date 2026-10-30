"""PRIVATE candidate only. Closed content-only durable image overlay, four runtime plus two separately delivered host paths.
Default native readiness remains fail-closed until exact economy/inventory/scoped-R2 proof.
No application imports, queue mutations, database restore or automatic write retry.
"""
from pathlib import Path
from contextlib import contextmanager
import ast,copy,hashlib,hmac,io,json,os,re,sqlite3,stat,subprocess,sys,tarfile,time,urllib.request
try:
 import resource
except ImportError:
 resource=None
from datetime import datetime,timezone,timedelta
sys.dont_write_bytecode=True
NAME='palitra-attention-durable-20261030-r12'
ROOT=Path('/opt/synapse');AREA=ROOT/'releases'/NAME;SELF=Path(__file__).resolve();LOCK=ROOT/'.palitra-app-release.lock'
CRM='synapse-crm-1';CONTENT='synapse-content-1';CONTAINERS=(CRM,CONTENT,'synapse-hugh-runtime-1','synapse-chat-1','caddy')
BASE_IMAGE='sha256:e22ca4d3892a01454d749fbef49c10c2a1a93f0a863d977914f32ae21455a343'
HEX=re.compile('[a-f0-9]{64}');IMAGE=re.compile('sha256:[a-f0-9]{64}')
LEGACY_SHA='91323f3430ee65b8df371c055d4fd1d3d7ff2762a09c5a379ee35263416cced7'
MAX_FILE=64*1024*1024;MAX_ARCHIVE=2*1024*1024*1024;PREPARE_TTL=900;APPLY_TTL=120;GRACE=60
sha=lambda raw:hashlib.sha256(raw).hexdigest()
enc=lambda v:(json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n').encode()
FILE_PINS={'/app/palitra-manager-attention.cjs': ('e950f9e4723a47abd8d5d2b039fe05d25a5ba13b362a46eac34c09004eb23b59', '6b8a661a60efd47a9d0bc1e5a3b2f343324e35c117170a20d1b90c0e2c79d649'), '/app/server.js': ('23c9664d8209ecf4aa4ce822a1a05a8cf0c2ee3fcb11afa93e396b1d5282d4ac', '183a0edd7559a7fa029c3b17e8931592133961f73454fb59afbcc8c6761b7713'), '/app/palitra-orders-public/native-host.js': ('697863cbd5ac96af57a58bcae84d4b0ba858b18d39a955c527463a6c4c756728', '0d5141c14c769cbd4dd4216e8983c742813877e5a225809f2113c1fbf559be7f'), '/app/palitra-orders-public/shell.js': ('b39d4cdb4d07673988249863d0ce4e767981565ed6f77350073aeff61ec273c9', 'b7efae7638e05351296d93243f771b2c7ca134672bda1abe348ac7912d3fab60')}
ACTIVE_DATABASE_PATHS=('/data/content.sqlite','/data/salon-reports.sqlite','/data/projects/palitra-love/sites/site-44bbe13f1bad5e005b2a/private/draft-accounts.sqlite')
OPAQUE_ARCHIVE_PATHS=('/data/nebo-project-20261020/content-before-site-r3.sqlite','/data/nebo-project-backup-20261020/content.sqlite','/data/nebo-project-backup-20261020/salon-reports.sqlite','/data/palitra-app-before-20261013.sqlite','/data/palitra-map-caption-20261019/content.sqlite','/data/palitra-production-before-20261013.sqlite','/data/palitra-unified-orders-20261021-r8-completion-c1-save/content.sqlite')
TARGETS=tuple(FILE_PINS)
STATIC_PINS={'/opt/synapse/sites/synapse/cabinet/palitra-orders/native-host.js': ('f27b5ae1f9c0899a7b99ed756730874238c94c15ebda3d2913bc88d62d2b4d80', 'c5bedcfb395719d4b9ffa16c0820801dcb04e7c87d308bcc1f70b6f1ac07e704'), '/opt/synapse/sites/synapse/cabinet/palitra-orders/shell.js': ('b40b738cab687e863fffc7e18486b068d5e2b21ed43bf5abfd230ae9d3244588', '1e770b202f0cfd129476d43e98ace02894665f0208ff059ecb5f8afd099fc796')}
STATIC_TARGETS=tuple(STATIC_PINS)
STATIC_NAMES={'/opt/synapse/sites/synapse/cabinet/palitra-orders/native-host.js': 'cab-native-host.js', '/opt/synapse/sites/synapse/cabinet/palitra-orders/shell.js': 'cab-shell.js'}
PRESERVED_R7={'/app/draft-account-service.cjs': '23a0d76ed2d5d2bef47ad49e5822829a088b6148ceeffae09731b6f499d34f26', '/app/customer-chat.js': '1a3927539386fe4e075bf9aa9ec7cfc995fe0b36787ebb67ad7898359058456e', '/app/customer-chat-native-adapter.cjs': 'a72732560bd9adb109080c09cf0ce3bd7774eb72614ea29073d301d44245037e', '/app/palitra-review-public/palitra-chat.js': '5752c762048c18aa01ccc52f503ef63230468d79ff7749895b6e4e0dd37d124b', '/app/site-workspace-feature.js': 'f36fe867ef6c5bf0f180ae3caec177f296503f365606c0d3e2b9cf262964ac5e'}
MANAGED_REV='245ca86f12e50e696ee39c5d6c3ab0f1924c05e933abbcc3ba249a20e6d8d9f8' # Root native readonly22:45Z
REVIEWED_DATA_PINS={'reviewed-sql.json': '410b03163c43b703212e212d47821d9f2c427b21ee5ac17013d08a54c0193ba5', 'reviewed-source-pins.json': 'd4de0c682d08f12764311754444501f7bcaf3ae40bc4fbc7c11903673bff964e', 'inventory-review.json': '3f7ff5bf0b12e647542d5cf2b24c756eb801a9a03a4a1f5cc5cd4a1f1ba94222', 'economy_projection.py': 'f320cb7299bdb75037272ae55e388e76697e6ce4d3a910eb1b5412eae3d3a283', 'vault_probe.cjs': '8714b8bc8cda5a6724227e31fdab4b37825b161026d9326d3c61296589263c13', 'image_archive_audit.py': 'f9af133089f08ab2876945a1dd5b4c5a225097e5fc6fd91f6ebbefaa60e1cd8a', 'diagnostic_preservation.py': '658ddfc204ba95c75889a5f0d9f73d9f5142a30261cac462e461cbd431747a70', 'managed_history.py': '9d00a086c983a0a7435cf6a6a2f726b570bc787bf52f56fc294ae03684aa640b', 'server_phase.py': '11d436096c1f56c7c4beccbbe18dd85c4dd875cb377ce1a4d412d0df4e492c10', 'host_static.py': '73b3c34e3d646e2b077b45b7fce84dfc3a480f39cf5dfbb5eeed8be4b94018f0', 'scope-review.json': 'fc42c9b9d51e9a06544f52162ba2e9c6dd38af09622a6606220f9312a3aafe73', 'source-proof/server-before.js': '23c9664d8209ecf4aa4ce822a1a05a8cf0c2ee3fcb11afa93e396b1d5282d4ac', 'managed-anchor.json': '974ed3ee63c85fa0c2505d6d8188a4da2c546fde19c356b0c55d12c350eba503'}
INVENTORY_REVIEW_SHA='3f7ff5bf0b12e647542d5cf2b24c756eb801a9a03a4a1f5cc5cd4a1f1ba94222'
def need(ok, reason):
    if not ok: raise ValueError(reason)

def safe_read(path):
    path=Path(path)
    for part in (path,*path.parents): need(not part.is_symlink(),'PATH_ALIAS')
    before=path.lstat()
    need(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_size<=MAX_FILE,'REGULAR_BOUNDED_FILE')
    if os.name=='posix': need(before.st_uid==before.st_gid==0,'ROOT_FILE_REQUIRED')
    fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0)|getattr(os,'O_BINARY',0))
    try:
        with os.fdopen(fd,'rb',closefd=False) as stream: raw=stream.read(MAX_FILE+1)
        keys=('st_dev','st_ino','st_size','st_mode','st_uid','st_gid','st_nlink','st_mtime_ns','st_ctime_ns')
        need(len(raw)==before.st_size and all(getattr(before,k)==getattr(os.fstat(fd),k)==getattr(path.lstat(),k) for k in keys),'STABLE_READ_REQUIRED')
        return raw
    finally: os.close(fd)

def write_new(path,raw,mode=0o600):
    path=Path(path)
    for part in (path,*path.parents): need(not part.is_symlink(),'WRITE_ALIAS')
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),mode)
    with os.fdopen(fd,'wb') as stream: stream.write(raw);stream.flush();os.fsync(stream.fileno())

def sync_dir(path):
    fd=os.open(str(path),os.O_RDONLY|getattr(os,'O_DIRECTORY',0))
    try: os.fsync(fd)
    finally: os.close(fd)

def load(path): return json.loads(safe_read(path))

def own_lease():
    rows=json.loads(run(['lslocks','--json','--output','PID,PATH']))['locks']
    rows=[row for row in rows if row.get('path')==str(LOCK)]
    need(len(rows)==1,'ONE_FRESH_LEASE_REQUIRED');pid=int(rows[0]['pid'])
    ancestors=set();parent=os.getppid()
    while parent>1 and parent not in ancestors:
        ancestors.add(parent);value=Path('/proc/'+str(parent)+'/stat').read_text();parent=int(value[value.rfind(')')+2:].split()[1])
    need(pid in ancestors,'OWN_ANCESTOR_LEASE_REQUIRED')
    value=Path('/proc/'+str(pid)+'/stat').read_text()
    return {'pid':pid,'startTicks':value[value.rfind(')')+2:].split()[19]}

def inspect_container(name):
    rows=json.loads(run(['docker','inspect',name]));need(len(rows)==1,'ONE_CONTAINER');row=rows[0]
    need(row['Name'].lstrip('/')==name and row['State']['Running'] and not row['State']['Restarting'] and not row['State']['OOMKilled'] and row['State'].get('Health',{}).get('Status') in (None,'healthy'),'RUNNING_HEALTHY_CONTAINER_REQUIRED')
    return row

def image_info(image):
    rows=json.loads(run(['docker','image','inspect',image]));need(len(rows)==1 and rows[0]['Id']==image,'EXACT_LOCAL_IMAGE');return rows[0]

TREE_JS=r"""'use strict';const fs=require('node:fs'),p=require('node:path'),h=require('node:crypto');const out={};let count=0;
function walk(base,rel){if(++count>50000)throw Error('TREE_BOUND');const at=p.join(base,rel),s=fs.lstatSync(at),mode=s.mode&4095,meta={uid:s.uid,gid:s.gid,mode};if(s.isSymbolicLink()){out[rel]={...meta,type:'symlink',target:fs.readlinkSync(at)};return;}if(s.isDirectory()){out[rel]={...meta,type:'directory'};for(const n of fs.readdirSync(at).sort())walk(base,rel?p.join(rel,n):n);return;}if(!s.isFile()||s.size>67108864)throw Error('TREE_FILE_BOUND');const fd=fs.openSync(at,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const raw=fs.readFileSync(fd),t=fs.fstatSync(fd),u=fs.lstatSync(at);for(const k of ['dev','ino','mode','uid','gid','nlink','size','mtimeMs','ctimeMs'])if(s[k]!==t[k]||s[k]!==u[k])throw Error('TREE_CHANGED');out[rel]={...meta,type:'file',nlink:s.nlink,bytes:raw.length,sha256:h.createHash('sha256').update(raw).digest('hex')};}finally{fs.closeSync(fd);}}
walk('/app','');process.stdout.write(JSON.stringify(out));"""

def probe_profile(config):
    need(config.get('WorkingDir')=='/app' and config.get('Cmd')==['node','server.js'] and config.get('Entrypoint') in (['docker-entrypoint.sh'],['/usr/local/bin/docker-entrypoint.sh']),'EXPECTED_NODE_STARTUP')
    need(config.get('User','') in ('','root','0'),'EXPECTED_ROOT_NODE_IMAGE')
    entries=config.get('Env',[]);keys=[v.split('=',1)[0] for v in entries];need(len(keys)==len(set(keys)),'DUPLICATE_ENVIRONMENT_KEYS')
    env=dict(v.split('=',1) for v in entries)
    need(not any(env.get(k) for k in ('NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH','NODE_REPL_EXTERNAL_MODULE','NODE_REPL_EXTERNAL_MODULE_PATH')),'READ_PROBE_HOOKS_NOT_ALLOWED')

def runtime_tree(container):
    probe_profile(container['Config'])
    return json.loads(run(['docker','exec',container['Id'],'node','-e',TREE_JS]))

_PASSIVE_CHAT_READS=set()
PASSIVE_TAR_LIMIT=512000

def passive_chat_source(container,wanted):
    # Passive archive read: never invokes Node or startup hooks in chat.
    need(HEX.fullmatch(wanted)and re.fullmatch('[a-f0-9]{64}',container['Id']),'PASSIVE_CHAT_SCOPE')
    need(foreign(inspect_container('synapse-chat-1'))==foreign(container),'PASSIVE_CHAT_IDENTITY_CHANGED')
    argv=['docker','cp',container['Id']+':/app/client-bot-bridge.js','-'];capability=tuple(argv)
    need(capability not in _PASSIVE_CHAT_READS,'PASSIVE_CHAT_READ_ALREADY_ACTIVE');_PASSIVE_CHAT_READS.add(capability)
    try:raw=run(argv,timeout=20)
    finally:_PASSIVE_CHAT_READS.remove(capability)
    need(len(raw)<=PASSIVE_TAR_LIMIT,'PASSIVE_CHAT_ARCHIVE_BOUND')
    with tarfile.open(fileobj=io.BytesIO(raw),mode='r:')as archive:
        members=archive.getmembers();need(len(members)==1,'PASSIVE_CHAT_SINGLE_FILE_REQUIRED');entry=members[0]
        need(entry.name=='client-bot-bridge.js'and entry.type in(tarfile.REGTYPE,tarfile.AREGTYPE)and entry.sparse is None and not entry.linkname and not entry.pax_headers and entry.offset==0 and 0<entry.size<=256000,'PASSIVE_CHAT_REGULAR_FILE_REQUIRED')
        end=entry.offset_data+((entry.size+511)//512)*512
        need(len(raw)>=end+1024 and len(raw)%512==0 and not any(raw[end:]),'PASSIVE_CHAT_TRAILING_DATA')
        stream=archive.extractfile(entry);need(stream is not None,'PASSIVE_CHAT_MEMBER_REQUIRED');value=stream.read(256001)
        need(len(value)==entry.size and sha(value)==wanted,'PASSIVE_CHAT_SOURCE_PIN_CHANGED')
    need(foreign(inspect_container('synapse-chat-1'))==foreign(container),'PASSIVE_CHAT_IDENTITY_CHANGED')
    return wanted


def image_tree(image):
    probe_profile(image_info(image)['Config'])
    return json.loads(run(['docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint=node',image,'-e',TREE_JS]))

def foreign(row):
    value={key:copy.deepcopy(row[key]) for key in ('Id','Image','Config','HostConfig','NetworkSettings')}
    value['Mounts']=sorted(copy.deepcopy(row['Mounts']),key=lambda v:v['Destination'])
    value['state']={key:row['State'].get(key) for key in ('Running','Paused','Restarting','OOMKilled','Dead','ExitCode','Error','StartedAt','FinishedAt')}
    value['restarts']=row.get('RestartCount');return value

def canonical_host(value):
    value=copy.deepcopy(value)
    if value.get('Binds') is not None:
        need(type(value['Binds']) is list and len(value['Binds'])==len(set(value['Binds'])),'UNIQUE_HOST_BINDS');value['Binds']=sorted(value['Binds'])
    return value

def own_network(row):
    value=copy.deepcopy(row['NetworkSettings']);cid=row['Id']
    for key in ('SandboxID','SandboxKey'):
        if key in value:value[key]='<own-recreated>'
    for facts in value['Networks'].values():
        for key in ('EndpointID','MacAddress'):facts[key]='<own-recreated>'
        requested=facts.get('IPAMConfig') or {}
        for key,request in (('IPAddress','IPv4Address'),('GlobalIPv6Address','IPv6Address')):
            if not requested.get(request):facts[key]='<docker-assigned>'
        for key in ('Aliases','DNSNames'):
            if isinstance(facts.get(key),list):facts[key]=sorted('<own-cid>' if v in (cid,cid[:12]) else v for v in facts[key])
    return value


def service_hash(plan,service):
    need(re.fullmatch('[A-Za-z0-9][A-Za-z0-9_-]{0,127}',service),'SAFE_SERVICE')
    value=run(compose_args(plan)+['config','--hash',service]).decode().strip();match=re.fullmatch(re.escape(service)+' ([a-f0-9]{64})',value)
    need(match is not None,'EXACT_SERVICE_HASH');return match.group(1)

def image_reference(plan,service):
    value=run(compose_args(plan)+['config','--images',service]).decode();value=value[:-2] if value.endswith('\r\n') else value[:-1] if value.endswith('\n') else value
    need(value and value.isascii() and not value.startswith('-') and not any(c.isspace() or ord(c)<32 or ord(c)==127 for c in value),'ONE_LOCAL_IMAGE_REFERENCE');return value

def longest_chain(chains):
    need(chains and all(c and len(c)==len(set(c)) for c in chains),'UNIQUE_COMPOSE_CHAINS')
    longest=max(chains,key=len);need(all(longest[:len(c)]==c for c in chains),'DIVERGENT_COMPOSE_CHAINS');return longest

def effective_plan(rows,expected):
    need(set(rows)==set(CONTAINERS) and all(rows[name]['Image']==expected[name] for name in CONTAINERS),'ALL_FIVE_ACTUAL_IMAGE_PINS')
    labels={name:row['Config']['Labels'] for name,row in rows.items()}
    need({v['com.docker.compose.project'] for v in labels.values()}=={'synapse'},'ONE_PROJECT')
    directories={v['com.docker.compose.project.working_dir'] for v in labels.values()};need(len(directories)==1,'ONE_PROJECT_DIRECTORY')
    chain=longest_chain([labels[name]['com.docker.compose.project.config_files'].split(',') for name in (CRM,CONTENT,'synapse-hugh-runtime-1')])
    def files(paths):
        need(paths and len(paths)==len(set(paths)) and all(Path(p).is_absolute() and str(Path(p).resolve())==p for p in paths),'CANONICAL_COMPOSE_FILES')
        return [{'path':p,'sha256':sha(safe_read(p))} for p in paths]
    plan={'project':'synapse','directory':directories.pop(),'files':files(chain)}
    need(plan['directory']==str(ROOT),'EXPECTED_PROJECT_DIRECTORY')
    plan['resolved']=json.loads(run(compose_args(plan)+['config','--format','json']))
    own={};seen=set()
    for name,row in rows.items():
        service=labels[name]['com.docker.compose.service'];need(service not in seen and service in plan['resolved']['services'],'UNIQUE_GLOBAL_SERVICE');seen.add(service)
        actual=run(['docker','image','inspect','--format','{{.Id}}',image_reference(plan,service)]).decode().strip()
        need(actual==row['Image'],'GLOBAL_PLAN_MATCHES_EVERY_ACTIVE_IMAGE')
        own_files=files(labels[name]['com.docker.compose.project.config_files'].split(','));own_plan={**plan,'files':own_files}
        pin=labels[name]['com.docker.compose.config-hash'];need(HEX.fullmatch(pin) and service_hash(plan,service)==service_hash(own_plan,service)==pin,'GLOBAL_OWN_ACTUAL_CONFIG_HASH')
        own[name]={'service':service,'files':own_files,'configHash':pin}
    need(own[CRM]['service']=='crm'and own[CONTENT]['service']=='content','EXACT_SERVICES_REQUIRED');plan['ownChains']=own;return plan


def db_identity(path):
    info=Path(path).lstat();need(not Path(path).is_symlink() and stat.S_ISREG(info.st_mode) and info.st_nlink==1,'DATABASE_IDENTITY');return [info.st_dev,info.st_ino]

@contextmanager
def db_open(path):
    connection=sqlite3.connect(Path(path).as_uri()+'?mode=ro',uri=True,isolation_level=None,timeout=5)
    try:
        connection.execute('PRAGMA query_only=ON');connection.execute('BEGIN');yield connection
    finally:
        if connection.in_transaction:connection.rollback()
        connection.close()

def quote(value):return '"'+value.replace('"','""')+'"'

def cell(value):return {'blob':value.hex()} if isinstance(value,bytes) else value

def price_pin():
    with urllib.request.urlopen('https://palitra-love.ru/data/price.json',timeout=30) as response:raw=response.read(4*1024*1024+1)
    need(len(raw)<=4*1024*1024,'PRICE_BOUND');value=json.loads(raw)
    return {'version':value['version'],'sha256':sha(raw)}


# All subprocess capabilities are closed here. No CLI accepts arbitrary commands.
_COMPOSE_PREFIXES=set()
def compose_args(plan):
    need(plan.get('project')=='synapse' and plan.get('directory')==str(ROOT),'CLOSED_COMPOSE_PROJECT')
    files=plan.get('files');need(type(files)is list and 1<=len(files)<=100,'BOUNDED_COMPOSE_CHAIN')
    paths=[r['path'] for r in files]
    need(len(paths)==len(set(paths)) and all(Path(v).is_absolute() and str(Path(v).resolve())==v for v in paths),'CANONICAL_COMPOSE_CHAIN')
    argv=['docker','compose','--project-name','synapse','--project-directory',str(ROOT)]+[x for path in paths for x in ('--file',path)]
    _COMPOSE_PREFIXES.add(tuple(argv));return argv

def allowed_command(argv):
    if type(argv)is not list or not all(type(v)is str and '\x00' not in v for v in argv):return False
    a=tuple(argv)
    if a==('lslocks','--json','--output','PID,PATH'):return True
    if len(a)==4 and a[:2]==('docker','cp'):return bool(re.fullmatch(r'[a-f0-9]{64}:/app/client-bot-bridge\.js',a[2])and a[3]=='-'and a in _PASSIVE_CHAT_READS)
    if len(a)==3 and a[:2]==('docker','inspect') and a[2]in CONTAINERS:return True
    if len(a)==4 and a[:3]==('docker','image','inspect') and IMAGE.fullmatch(a[3]):return True
    if len(a)==6 and a[:4]==('docker','image','inspect','--format') and a[4]=='{{.Id}}' and re.fullmatch('[A-Za-z0-9][A-Za-z0-9_./:@-]{0,255}',a[5]):return True
    if len(a)==6 and a[:3]==('docker','exec',a[2]) and re.fullmatch('[a-f0-9]{64}',a[2]) and a[3:]==('node','-e',TREE_JS):return True
    if len(a)==6 and a[:2]==('docker','exec')and re.fullmatch('[a-f0-9]{64}',a[2])and a[3:5]==('node','-e'):
        return False # R2 opaque proof requires exactly one fresh nonce argument
    if len(a)==7 and a[:2]==('docker','exec')and re.fullmatch('[a-f0-9]{64}',a[2])and a[3:5]==('node','-e')and HEX.fullmatch(a[6]):
        return a[5]==vault_code()
    if len(a)==12 and a[:9]==('docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint=node'):
        return bool(IMAGE.fullmatch(a[9]) and a[10:]==('-e',TREE_JS))
    if len(a)==5 and a[:3]==('docker','image','ls') and a[3]=='--quiet':return bool(re.fullmatch(re.escape(NAME)+'-[a-f0-9]{16}(?:-base)?:local',a[4]))
    if len(a)==5 and a[:3]==('docker','image','tag'):return bool(IMAGE.fullmatch(a[3]) and re.fullmatch(re.escape(NAME)+'-[a-f0-9]{16}-base:local',a[4]))
    if len(a)==9 and a[:4]==('docker','build','--network=none','--pull=false') and a[4]=='--tag' and re.fullmatch(re.escape(NAME)+'-[a-f0-9]{16}:local',a[5]) and a[6]=='--iidfile' and a[7]==str(AREA/'build/image.id') and a[8]==str(AREA/'build'):return True
    if len(a)==6 and a[:4]==('docker','image','save','--output') and a[4]==str(AREA/'build/child-image.tar') and IMAGE.fullmatch(a[5]):return True
    for prefix in _COMPOSE_PREFIXES:
        if a[:len(prefix)]==prefix:
            suffix=a[len(prefix):]
            if suffix==('config','--format','json'):return True
            if len(suffix)==3 and suffix[:2]==('config','--hash') and re.fullmatch('[A-Za-z0-9][A-Za-z0-9_-]{0,127}',suffix[2]):return True
            if len(suffix)==3 and suffix[:2]==('config','--images') and re.fullmatch('[A-Za-z0-9][A-Za-z0-9_-]{0,127}',suffix[2]):return True
            if suffix==('up','--detach','--no-build','--pull','never','--no-deps','content'):return True
    return False

def _process(argv,timeout,limit=MAX_FILE):
    allowed_system=argv in(['systemctl','is-active','synapse-sync.timer'],['systemctl','is-enabled','synapse-sync.timer'],['systemctl','show','synapse-sync.service','--property=ExecStart','--value'])
    need(allowed_system or allowed_command(argv),'CLOSED_COMMAND_CAPABILITY_REFUSED')
    need(type(timeout)is int and 0<timeout<=180 and limit in(MAX_FILE,MAX_ARCHIVE,PASSIVE_TAR_LIMIT)and(limit!=PASSIVE_TAR_LIMIT or argv[:2]==['docker','cp']),'PROCESS_DEFAULT_BOUNDS_REQUIRED')
    import tempfile
    need(resource is not None and os.name=='posix','NATIVE_BOUNDED_PROCESS_REQUIRED')
    def limits():resource.setrlimit(resource.RLIMIT_FSIZE,(limit,limit))
    with tempfile.TemporaryFile()as out,tempfile.TemporaryFile()as err:
        child=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=out,stderr=err,preexec_fn=limits)
        try:child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            child.kill();child.wait();raise ValueError('COMMAND_TIMEOUT_INSPECT_ONLY')
        need(out.tell()<=limit and err.tell()<=1024*1024,'COMMAND_OUTPUT_BOUND')
        out.seek(0);err.seek(0);return child.returncode,out.read(limit+1),err.read(1024*1024+1)

def run(argv,timeout=90):
    need(allowed_command(argv),'CLOSED_COMMAND_CAPABILITY_REFUSED')
    limit=PASSIVE_TAR_LIMIT if argv[:2]==['docker','cp']else MAX_ARCHIVE if argv[:4]==['docker','image','save','--output']else MAX_FILE
    code,out,err=_process(argv,timeout,limit)
    need(code==0,'COMMAND_FAILED_INSPECT_ONLY');return out

def policy_state():
    # Exact known policy reads, no mutating systemctl capability.
    result={}
    for action,want in [('is-active','inactive'),('is-enabled','disabled')]:
        argv=['systemctl',action,'synapse-sync.timer'];code,out,_=_process(argv,20)
        need(code in(0,1,3,4)and out.decode().strip()==want,'LEGACY_SYNC_MUST_REMAIN_DISABLED');result[action]=want
    code,out,_=_process(['systemctl','show','synapse-sync.service','--property=ExecStart','--value'],20)
    need(code==0 and re.findall(r'(?:^|[ {;])path=([^ ;}]+)',out.decode())==['/usr/local/bin/synapse-sync'],'EXACT_LEGACY_EXECSTART')
    need(not os.path.lexists('/usr/local/sbin/synapse-sync'),'LEGACY_SBIN_ABSENT')
    for p in ['/etc/synapse/managed-release.json','/etc/systemd/system/synapse-sync.service.d/50-managed-release.conf','/usr/local/bin/synapse-sync','/opt/synapse/ops/synapse-sync','/opt/synapse/caddy/Caddyfile','/opt/synapse/docker-compose.yml']:
        result[p]=sha(safe_read(p))
    need(result['/usr/local/bin/synapse-sync']==result['/opt/synapse/ops/synapse-sync']==LEGACY_SHA,'LEGACY_BLOCKED_SCRIPT_PIN')
    return result

def validate_manifest(value):
    need(set(value)=={'schema','packageId','status','helperSha256','expectedImages','files','staticFiles','databaseInventory'},'CLOSED_MANIFEST')
    need(value['schema']==1 and value['packageId']==NAME and value['status']=='ROOT_REVIEWED_CODE_ONLY','ROOT_REVIEW_REQUIRED')
    need(all(after is not None for before,after in FILE_PINS.values()),'SCOPED_R2_PINS_NOT_FROZEN')
    need(type(value['helperSha256'])is str and HEX.fullmatch(value['helperSha256']),'HELPER_PIN_REQUIRED')
    images=value['expectedImages'];need(type(images)is dict and set(images)==set(CONTAINERS) and all(type(v)is str and IMAGE.fullmatch(v)for v in images.values()),'FRESH_FIVE_IMAGES_REQUIRED')
    need(images[CONTENT]==BASE_IMAGE,'EXACT_ACTUAL_PARENT_REQUIRED')
    files=value['files'];need(type(files)is list and tuple(row.get('target')for row in files)==TARGETS,'EXACT_FOUR_RUNTIME_TARGETS_REQUIRED')
    for row in files:
        need(set(row)=={'target','beforeSha256','afterSha256','bytes'},'CLOSED_FILE_ROW')
        need((row['beforeSha256'],row['afterSha256'])==FILE_PINS[row['target']],'REVIEWED_SOURCE_PINS_REQUIRED')
        need(type(row['bytes'])is int and 0<row['bytes']<=512000,'BOUNDED_FILE_SIZE')
    hosts=value['staticFiles'];need(type(hosts)is list and tuple(r.get('target')for r in hosts)==STATIC_TARGETS,'EXACT_TWO_HOST_STATIC_TARGETS_REQUIRED')
    for row in hosts:
        need(set(row)=={'target','beforeSha256','afterSha256','bytes'}and(row['beforeSha256'],row['afterSha256'])==STATIC_PINS[row['target']],'HOST_STATIC_REVIEWED_PINS_REQUIRED')
        need(type(row['bytes'])is int and 0<row['bytes']<=512000,'HOST_STATIC_BOUNDED_BYTES')
    need(INVENTORY_REVIEW_SHA is not None,'PERSISTENT_DB_INVENTORY_NOT_FROZEN')
    inv=value['databaseInventory']
    need(type(inv)is dict and set(inv)=={'sourceReviewSha256','contentPaths','crmPaths'}and type(inv['sourceReviewSha256'])is str and HEX.fullmatch(inv['sourceReviewSha256']),'SOURCE_BASED_DATABASE_INVENTORY_REQUIRED')
    need(inv['sourceReviewSha256']==INVENTORY_REVIEW_SHA,'REVIEWED_DATABASE_INVENTORY_PIN_REQUIRED')
    for role in('content','crm'):
        paths=inv[role+'Paths'];need(type(paths)is list and paths and len(paths)<=100 and len(paths)==len(set(paths)),'CONFIRMED_PERSISTENT_DATABASE_LIST_REQUIRED')
        need(all(type(p)is str and re.fullmatch(r'/data/(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\.sqlite',p)and '..'not in Path(p).parts for p in paths),'CANONICAL_DATABASE_LIST_REQUIRED')
    need(set(inv['contentPaths'])==set(ACTIVE_DATABASE_PATHS+OPAQUE_ARCHIVE_PATHS)and inv['crmPaths']==['/data/crm.sqlite'],'EXACT_REVIEWED_DATABASES_REQUIRED')
    need(any(p.endswith('/sites/site-44bbe13f1bad5e005b2a/private/draft-accounts.sqlite')for p in inv['contentPaths']),'ACTUAL_ACCOUNT_DATABASE_REQUIRED')
    return value

def package():
    staged=load(AREA/'stage.json');raw=safe_read(AREA/'manifest.json')
    need(sha(safe_read(SELF))==staged['helperSha256']and sha(raw)==staged['manifestSha256'],'PINNED_PACKAGE_CHANGED')
    manifest=validate_manifest(json.loads(raw));need(manifest['helperSha256']==staged['helperSha256'],'HELPER_PIN')
    actual={p.relative_to(AREA/'payload').as_posix()for p in(AREA/'payload').rglob('*')if p.is_file()or p.is_symlink()}
    need(actual=={p.removeprefix('/app/')for p in TARGETS},'CLOSED_PAYLOAD')
    for row in manifest['files']:
        raw=safe_read(AREA/'payload'/row['target'].removeprefix('/app/'));need(len(raw)==row['bytes']and sha(raw)==row['afterSha256'],'PAYLOAD_PIN')
    hostfiles={f.name for f in(AREA/'static-payload').iterdir()if f.is_file()or f.is_symlink()};need(hostfiles==set(STATIC_NAMES.values()),'CLOSED_HOST_STATIC_PAYLOAD')
    for row in manifest['staticFiles']:
        raw=safe_read(AREA/'static-payload'/STATIC_NAMES[row['target']]);need(len(raw)==row['bytes']and sha(raw)==row['afterSha256'],'HOST_STATIC_PAYLOAD_PIN')
    module('server_phase.py').validate(safe_read(AREA/'source-proof/server-before.js'),safe_read(AREA/'payload/server.js'))
    anchor=load(AREA/'managed-anchor.json');need(anchor['revision']==MANAGED_REV and anchor['version']==334 and anchor['manifestFiles']==141 and anchor['historyRecords']==334 and anchor['canonicalHistoryDigestHardcoded']is False,'MANAGED334_REVIEW_ANCHOR_REQUIRED')
    for name in REVIEWED_DATA_PINS:
        need(sha(safe_read(AREA/name))==staged[name+'Sha256']==REVIEWED_DATA_PINS[name],'REVIEWED_GUARD_DATA_CHANGED')
    return staged,manifest

def stage(commit,pin):
    stage_lease=own_lease()
    need(re.fullmatch('[a-f0-9]{40}',commit)and HEX.fullmatch(pin),'IMMUTABLE_PINS_REQUIRED');need(not os.path.lexists(AREA),'STAGE_EXISTS_INSPECT_ONLY')
    base='https://raw.githubusercontent.com/Elk0980/synapse-server/'+commit+'/ops/'+NAME+'/'
    def fetch(name,limit):
        with urllib.request.urlopen(base+name,timeout=30)as response:raw=response.read(limit+1)
        need(len(raw)<=limit,'PUBLIC_CODE_BOUND');return raw
    raw=fetch('manifest.json',64000);need(sha(raw)==pin,'MANIFEST_PIN');manifest=validate_manifest(json.loads(raw));need(manifest['helperSha256']==sha(safe_read(SELF)),'HELPER_PIN')
    allfiles={r['target'].removeprefix('/app/'):fetch('payload/'+r['target'].removeprefix('/app/'),r['bytes'])for r in manifest['files']}
    for row in manifest['files']:need(sha(allfiles[row['target'].removeprefix('/app/')])==row['afterSha256'],'PAYLOAD_PIN')
    hosts={STATIC_NAMES[r['target']]:fetch('static-payload/'+STATIC_NAMES[r['target']],r['bytes'])for r in manifest['staticFiles']}
    for r in manifest['staticFiles']:need(sha(hosts[STATIC_NAMES[r['target']]])==r['afterSha256'],'HOST_STATIC_PAYLOAD_PIN')
    extras={name:fetch(name,256000)for name in REVIEWED_DATA_PINS}
    need(all(sha(raw)==REVIEWED_DATA_PINS[name]for name,raw in extras.items()),'REVIEWED_GUARD_DATA_PIN')
    need(AREA.parent.resolve()==AREA.parent and AREA.parent.is_dir(),'CANONICAL_RELEASES');AREA.mkdir(mode=0o700)
    for name,value in allfiles.items():
        dest=AREA/'payload'/name;dest.parent.mkdir(parents=True,exist_ok=True,mode=0o700);write_new(dest,value)
    (AREA/'static-payload').mkdir(mode=0o700)
    for name,value in hosts.items():write_new(AREA/'static-payload'/name,value)
    for name,value in extras.items():
        dest=AREA/name;dest.parent.mkdir(parents=True,exist_ok=True,mode=0o700);write_new(dest,value)
    write_new(AREA/'manifest.json',raw)
    write_new(AREA/'stage.json',enc({'commit':commit,'stageLease':stage_lease,'helperSha256':sha(safe_read(SELF)),'manifestSha256':pin,**{name+'Sha256':sha(value)for name,value in extras.items()}}));package();print('STAGED_NOT_INSTALLED')

def r7_plan_guard(plan):
    predecessor=ROOT/'releases/palitra-customer-content-durable-20261030-r7/content-image-only.json'
    need(len(plan['files'])==69 and plan['files'][-1]['path']==str(predecessor),'EXACT_R7_69_ORDERED_PREDECESSOR_REQUIRED')
    need(safe_read(predecessor)==enc({'services':{'content':{'image':BASE_IMAGE}}})and sha(safe_read(predecessor))==plan['files'][-1]['sha256'],'EXACT_R7_IMAGE_OVERLAY_REQUIRED')

def normalize_content(row):
    value=copy.deepcopy(row['Config']);value['Image']='<own-image>';value['Env']=sorted(value.get('Env',[]))
    if value.get('Hostname')==row['Id'][:12]:value['Hostname']='<own-hostname>'
    for key in('com.docker.compose.image','com.docker.compose.config-hash','com.docker.compose.project.config_files'):
        need(key in value.get('Labels',{}),'COMPOSE_LABEL_REQUIRED');value['Labels'][key]='<own-controlled>'
    return{'config':value,'host':canonical_host(row['HostConfig']),'mounts':sorted(row['Mounts'],key=lambda x:x['Destination']),'networks':own_network(row)}

def env_map(row):
    values=row['Config'].get('Env',[]);pairs=[v.split('=',1)for v in values];need(all(len(p)==2 for p in pairs),'ENVIRONMENT_FORMAT');need(len({p[0]for p in pairs})==len(pairs),'UNIQUE_ENVIRONMENT');return dict(pairs)

def full_static():
    result={}
    for path in(ROOT/'sites').rglob('*'):
        if path.is_file()and not path.is_symlink()and path.suffix in('.js','.html','.css','.json','.webmanifest'):
            result[path.relative_to(ROOT).as_posix()]=sha(safe_read(path))
    return result

def covering_mount(row,container_path):
    mounts=[v for v in row['Mounts']if container_path==v['Destination']or container_path.startswith(v['Destination'].rstrip('/')+'/')]
    need(mounts,'CONFIRMED_DATABASE_MOUNT_REQUIRED');m=max(mounts,key=lambda v:len(v['Destination']));need(m['RW']and m['Destination']=='/data','EXPECTED_PERSISTENT_DATA_MOUNT')
    return m

def account_database_path(database_path,company_code,site_id):
    from pathlib import PurePosixPath
    need(database_path=='/data/content.sqlite'and bool(re.fullmatch('[A-Za-z0-9_-]{1,80}',company_code))and bool(re.fullmatch('[A-Za-z0-9_-]{1,80}',site_id)),'INVENTORY_SCOPE_PATH_UNKNOWN')
    return str(PurePosixPath(database_path).parent/'projects'/company_code/'sites'/site_id/'private/draft-accounts.sqlite')

def database_paths(rows,manifest):
    review=load(AREA/'inventory-review.json');archives={r['containerPath']:r for r in review['archives']};need(set(archives)==set(OPAQUE_ARCHIVE_PATHS),'FIXED_ARCHIVE_REVIEW_REQUIRED')
    result={}
    for role,name in(('content',CONTENT),('crm',CRM)):
        row=rows[name];declared=manifest['databaseInventory'][role+'Paths'];env=env_map(row)
        need(env.get('DATABASE_PATH','/data/'+role+'.sqlite')=='/data/'+role+'.sqlite','ACTUAL_DATABASE_PATH_MISMATCH')
        mount=covering_mount(row,declared[0]);source=Path(mount['Source']);need(source.resolve()==source and source.is_dir()and not source.is_symlink(),'CANONICAL_DATA_SOURCE')
        discovered=set();count=0
        for directory,dirs,files in os.walk(source,followlinks=False):
            count+=len(dirs)+len(files);need(count<=200000,'DATA_INVENTORY_BOUND')
            need(not any((Path(directory)/d).is_symlink()for d in dirs),'DATA_INVENTORY_ALIAS')
            for file in files:
                if file.endswith('.sqlite'):
                    p=Path(directory)/file;db_identity(p);discovered.add('/data/'+p.relative_to(source).as_posix())
        need(discovered==set(declared),'UNCONFIRMED_PERSISTENT_DATABASE_INVENTORY')
        for target in declared:
            need(covering_mount(row,target)==mount,'NESTED_DATABASE_MOUNT_CHANGED');host=source/target.removeprefix('/data/');db_identity(host)
            info=host.stat();expected_mode=0o600 if target=='/data/salon-reports.sqlite'or target in OPAQUE_ARCHIVE_PATHS else 0o644
            if os.name=='posix':
                need(info.st_uid==info.st_gid==0 and not stat.S_IMODE(info.st_mode)&0o002,'DATABASE_ROOT_MODE_CHANGED')
                need(stat.S_IMODE(info.st_mode)==expected_mode,'DATABASE_REVIEWED_MODE_CHANGED')
            result[role+':'+target]={'preservation':'opaque'if role=='content'and target in OPAQUE_ARCHIVE_PATHS else'sqlite','role':role,'containerPath':target,'hostPath':str(host),'identity':db_identity(host),'metadata':{'mode':stat.S_IMODE(info.st_mode),'uid':info.st_uid,'gid':info.st_gid}}
            if target in OPAQUE_ARCHIVE_PATHS:archive_review_state(result[role+':'+target],archives[target])
    return result

def archive_review_state(row,review):
    need(row['containerPath']in OPAQUE_ARCHIVE_PATHS and review['containerPath']==row['containerPath']and review['role']=='opaque_retained_copy'and review['uid']==review['gid']==0 and review['mode']=='0600'and review['nlink']==1 and review['sameResolvedPath']and review['maxBytes']==MAX_FILE,'OPAQUE_ARCHIVE_REVIEW_UNKNOWN')
    need(set(review['sidecars'])=={'-wal','-shm'},'OPAQUE_SIDECAR_REVIEW_UNKNOWN')
    wanted={'':{'present':True,'bytes':review['observedBytes'],'mode':review['mode'],'uid':review['uid'],'gid':review['gid'],'nlink':review['nlink']},**review['sidecars']}
    for suffix,expected in wanted.items():
        path=Path(row['hostPath']+suffix);exists=os.path.lexists(path)
        need(type(expected['present'])is bool and exists==expected['present'],'OPAQUE_SIDECAR_PRESENCE_CHANGED')
        if not exists:continue
        db_identity(path);info=path.lstat();need(type(expected['bytes'])is int and 0<=expected['bytes']<=MAX_FILE and info.st_size==expected['bytes'],'OPAQUE_ARCHIVE_REVIEWED_SIZE_CHANGED')
        if os.name=='posix':need(info.st_uid==expected['uid']==0 and info.st_gid==expected['gid']==0 and stat.S_IMODE(info.st_mode)==int(expected['mode'],8)and info.st_nlink==expected['nlink']==1,'OPAQUE_ARCHIVE_REVIEWED_METADATA_CHANGED')

def opaque_archive_facts(row):
    need(row['role']=='content'and row['containerPath']in OPAQUE_ARCHIVE_PATHS and row.get('preservation')=='opaque','FIXED_OPAQUE_ARCHIVE_REQUIRED')
    files={}
    for suffix in('','-wal','-shm'):
        path=Path(row['hostPath']+suffix)
        if not os.path.lexists(path):
            need(suffix!='','OPAQUE_ARCHIVE_MISSING');files[suffix]=None;continue
        raw=safe_read(path);st=path.lstat()
        need(len(raw)<=MAX_FILE,'OPAQUE_ARCHIVE_BOUND')
        if suffix=='':need(raw.startswith(b'SQLite format 3\x00'),'OPAQUE_ARCHIVE_HEADER_CHANGED')
        files[suffix]={'sha256':sha(raw),'bytes':len(raw),'identity':[st.st_dev,st.st_ino],'metadata':{'mode':stat.S_IMODE(st.st_mode),'uid':st.st_uid,'gid':st.st_gid,'nlink':st.st_nlink,'mtimeNs':str(st.st_mtime_ns),'ctimeNs':str(st.st_ctime_ns)}}
    return {'preservation':'opaque','files':files}

def diagnostic_policy():
    import importlib.util
    path=AREA/'diagnostic_preservation.py';need(sha(safe_read(path))==REVIEWED_DATA_PINS[path.name],'DIAGNOSTIC_POLICY_PIN_CHANGED')
    spec=importlib.util.spec_from_file_location('reviewed_diagnostic_policy',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def diagnostic_clock():return {'utcMs':int(time.time()*1000),'monoNs':time.monotonic_ns()}

def diagnostic_main(row):return row['role']=='content'and row['containerPath']=='/data/content.sqlite'

def diagnostic_generation(base,rows,after,previous=None):
    old=base['rows'][CONTENT];row=rows[CONTENT]
    def identity(r):
        need(type(r['RestartCount'])is int and r['RestartCount']==0 and r['State']['Running']and not r['State']['Restarting']and not r['State']['OOMKilled'],'DIAGNOSTIC_RESTART_REFUSED')
        need(type(r['State']['StartedAt'])is str and bool(r['State']['StartedAt']),'DIAGNOSTIC_START_IDENTITY_REQUIRED')
        return {'id':r['Id'],'startedAt':r['State']['StartedAt'],'restartCount':r['RestartCount']}
    initial=identity(old);actual=identity(row)
    if after:need((AREA/'apply-intent.json').exists()and actual['id']!=initial['id'],'DIAGNOSTIC_ONE_OWN_RECREATE_REQUIRED')
    else:need(actual==initial,'DIAGNOSTIC_PARENT_GENERATION_CHANGED')
    result={'phase':'after'if after else'before','identity':actual,'count':2 if after else 1}
    if previous:
        need(previous['phase']=='before'or after,'DIAGNOSTIC_GENERATION_REGRESSION')
        if previous['phase']==result['phase']:need(previous==result,'DIAGNOSTIC_EXTRA_GENERATION_REFUSED')
    return result

def diagnostic_init(base,prepared_sha,static_layer=False):
    folder=(AREA/'static-layer'if static_layer else AREA)/'diagnostic-observations';folder.mkdir(mode=0o700)
    genesis={'baseSha256':prepared_sha,'previous':None,'observation':base['diagnosticBase'],'generation':diagnostic_generation(base,base['rows'],False)}
    raw=enc(genesis);write_new(folder/'000000.json',raw);head={'count':1,'lastSha256':sha(raw),'baseSha256':prepared_sha};write_new(folder/'head.json',enc(head));sync_dir(folder);return sha(raw)

def diagnostic_history(base,static_layer=False):
    layer=AREA/'static-layer'if static_layer else AREA;folder=layer/'diagnostic-observations';prepared=load(layer/'prepared.json');head=load(folder/'head.json');base_sha=sha(enc(base))
    need(head['baseSha256']==prepared['baseSha256']==base_sha and type(head['count'])is int and 1<=head['count']<=2048,'DIAGNOSTIC_HEAD_INVALID')
    need(set(x.name for x in folder.iterdir())=={'head.json'}|{str(i).zfill(6)+'.json'for i in range(head['count'])},'DIAGNOSTIC_JOURNAL_INCOMPLETE')
    previous=None;last=None;policy=diagnostic_policy()
    for i in range(head['count']):
        raw=safe_read(folder/(str(i).zfill(6)+'.json'));item=json.loads(raw)
        need(item['baseSha256']==base_sha and item['previous']==previous,'DIAGNOSTIC_CHAIN_CHANGED')
        if i==0:need(sha(raw)==prepared['diagnosticGenesisSha256']and item['observation']==base['diagnosticBase']and item['generation']==diagnostic_generation(base,base['rows'],False),'DIAGNOSTIC_GENESIS_CHANGED')
        else:
            obs=item['observation'];prior=last['observation'];gen=item['generation'];oldgen=last['generation']
            need(gen['count']in(1,2)and gen['phase']==('before'if gen['count']==1 else'after')and(oldgen==gen or oldgen['phase']=='before'and gen['phase']=='after'),'DIAGNOSTIC_GENERATION_CHAIN_CHANGED')
            need(obs['bridge']['payload']==base['diagnosticBase']['bridge']['payload']and obs['bridge']['key']==base['diagnosticBase']['bridge']['key'],'DIAGNOSTIC_HISTORY_PAYLOAD_CHANGED')
            need(policy.stamp(obs['bridge']['checkedAt'])>=policy.stamp(prior['bridge']['checkedAt'])and obs['sequence']['value']>=prior['sequence']['value']and obs['utcMs']>=prior['utcMs']and obs['monoNs']>=prior['monoNs'],'DIAGNOSTIC_HISTORY_HIGHWATER_CHANGED')
        previous=sha(raw);last=item
    need(previous==head['lastSha256'],'DIAGNOSTIC_HEAD_CHAIN_MISMATCH');return head,last

def diagnostic_observe(base,rows,after,full,observed,static_layer=False):
    policy=diagnostic_policy();head,last=diagnostic_history(base,static_layer);generation=diagnostic_generation(base,rows,after,last['generation'])
    policy.compare(base['databaseFacts']['content:/data/content.sqlite'],base['diagnosticBase'],full,observed,last['observation'],generation['count'])
    need(head['count']<2048,'DIAGNOSTIC_OBSERVATION_BOUND');folder=(AREA/'static-layer'if static_layer else AREA)/'diagnostic-observations'
    item={'baseSha256':head['baseSha256'],'previous':head['lastSha256'],'observation':observed,'generation':generation};raw=enc(item)
    write_new(folder/(str(head['count']).zfill(6)+'.json'),raw);sync_dir(folder)
    temp=folder/'head.next';write_new(temp,enc({**head,'count':head['count']+1,'lastSha256':sha(raw)}));os.replace(temp,folder/'head.json');sync_dir(folder)
    return full

def assert_preserved_path(row,before,base=None,rows=None,after=False,static_layer=False):
    need(db_identity(row['hostPath'])==row['identity'],'DATABASE_IDENTITY_CHANGED')
    if row.get('preservation')=='opaque':
        need(enc(opaque_archive_facts(row))==enc(before),'OPAQUE_ARCHIVE_OR_SIDECAR_CHANGED');return before
    need(row.get('preservation')=='sqlite','DATABASE_PRESERVATION_KIND_UNKNOWN')
    with db_open(row['hostPath'])as conn:
        if base is not None and diagnostic_main(row):
            anchor=diagnostic_clock();full=db_facts(conn);observed=diagnostic_policy().capture(conn,env_map(rows[CONTENT]),full,anchor=anchor)
        else:return assert_database(conn,before)
    return diagnostic_observe(base,rows,after,full,observed,static_layer)


def db_facts(connection):
    need(connection.execute('PRAGMA quick_check').fetchone()==('ok',),'DATABASE_QUICK_CHECK')
    schema=connection.execute('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').fetchall();need(len(schema)<=5000,'DATABASE_SCHEMA_BOUND');tables={};row_count=0
    for kind,name,_,sql in schema:
        if kind!='table':continue
        need(not re.match(r'\s*CREATE\s+VIRTUAL\s+TABLE',sql or'',re.I),'VIRTUAL_DATABASE_REQUIRES_REVIEW')
        cols=connection.execute('PRAGMA table_info('+quote(name)+')').fetchall();keys=[r[1]for r in sorted(cols,key=lambda r:r[5])if r[5]];names=[r[1]for r in cols];values={};n=len(keys)or 1
        for row in connection.execute('SELECT '+(','.join(map(quote,keys))if keys else'rowid')+','+','.join(map(quote,names))+' FROM '+quote(name)):
            row_count+=1;need(row_count<=500000,'DATABASE_ROW_BOUND');need(all(not isinstance(v,(bytes,str))or len(v)<=MAX_FILE for v in row),'DATABASE_CELL_BOUND')
            k=sha(enc([cell(v)for v in row[:n]]));need(k not in values,'UNIQUE_DATABASE_ROW_KEYS');values[k]=sha(enc([cell(v)for v in row[n:]]))
        tables[name]={'columns':names,'rows':values}
    need(connection.total_changes==0,'DATABASE_READONLY');return{'schema':schema,'tables':tables}

def assert_database(connection,before):
    actual=db_facts(connection);need(enc(actual)==enc(before),'DATABASE_SCHEMA_OR_ROWS_CHANGED_INSPECT_ONLY');return actual



def review_window_guard(env,now,end):
    if env.get('PALITRA_REVIEW_REMINDERS_ENABLED')!='true':return
    evening=env.get('PALITRA_REVIEW_REMINDER_EVENING','');morning=env.get('PALITRA_REVIEW_REMINDER_MORNING','')
    need(re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d',evening),'UNKNOWN_REVIEW_WINDOW_CONFIG')
    slots=[evening]+([morning]if morning else[])
    need(all(re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d',x)for x in slots),'UNKNOWN_REVIEW_WINDOW_CONFIG')
    need(end-now<=3600,'BOUNDED_REVIEW_WINDOW')
    first=datetime.fromtimestamp(now,timezone.utc).astimezone(timezone(timedelta(hours=3))).date()
    for day in(first,first+timedelta(days=1)):
        for slot in slots:
            h,m=map(int,slot.split(':'));start=datetime.combine(day,datetime.min.time(),tzinfo=timezone(timedelta(hours=3))).replace(hour=h,minute=m).timestamp()
            need(not(now<start+3600 and end>=start),'CURRENT_REVIEW_SLOT_REFUSED')

def vault_code():
    path=AREA/'vault_probe.cjs';raw=safe_read(path);need(sha(raw)==REVIEWED_DATA_PINS[path.name],'VAULT_PROBE_PIN_CHANGED')
    return raw.decode('utf8')+'\nmain();'

def vault_file_state(path):
    try:
        st=Path(path).lstat();need(not Path(path).is_symlink()and stat.S_ISREG(st.st_mode)and st.st_nlink==1,'VAULT_DATABASE_IDENTITY')
        return {'dev':str(st.st_dev),'ino':str(st.st_ino),'size':str(st.st_size),'mtimeNs':str(st.st_mtime_ns),'ctimeNs':str(st.st_ctime_ns)}
    except FileNotFoundError:return None

_VAULT_PROOFS={}
_USED_VAULT_NONCES=set()

def vault_file_identity(path):
    value=vault_file_state(path)
    return {k:value[k]for k in('dev','ino')}if value is not None else None

def opaque_vault_probe(rows,path):
    row=rows[CONTENT];probe_profile(row['Config']);before=[vault_file_identity(path),vault_file_identity(str(path)+'-wal')]
    need(before[0]is not None,'VAULT_DATABASE_MISSING');started=time.time()
    nonce=os.urandom(32).hex();need(nonce not in _USED_VAULT_NONCES,'VAULT_NONCE_REUSE');_USED_VAULT_NONCES.add(nonce)
    value=json.loads(run(['docker','exec',row['Id'],'node','-e',vault_code(),nonce],timeout=10))
    need(time.time()-started<=5 and set(value)=={'nonce','sourceSha256','settingsBinding','providers','canUseBalanceAccount','databasePath','files','asOfMs'},'VAULT_PROOF_FRESH_SHAPE')
    need(type(value['nonce'])is str and hmac.compare_digest(value['nonce'],nonce),'VAULT_NONCE_MISMATCH')
    need(value['sourceSha256']=='6464ac246aa197ef8f9f197a332eed5d2b27f0acda445b08f89192c660514141'and value['databasePath']=='/data/content.sqlite','VAULT_PROOF_SCOPE')
    need(type(value['settingsBinding'])is str and HEX.fullmatch(value['settingsBinding']),'VAULT_BINDING_FORMAT')
    need(type(value['asOfMs'])is int and started*1000-1000<=value['asOfMs']<=time.time()*1000+1000,'VAULT_PROOF_TIMESTAMP')
    need(value['files']==before==[vault_file_identity(path),vault_file_identity(str(path)+'-wal')],'VAULT_DATABASE_IDENTITY_CHANGED_DURING_PROBE')
    fresh=inspect_container(CONTENT);need(fresh['Id']==row['Id']and fresh['Image']==row['Image']and fresh['Config']==row['Config'],'VAULT_PARENT_CHANGED')
    _VAULT_PROOFS[nonce]={'proof':copy.deepcopy(value),'expiresAt':started+5,'parent':copy.deepcopy(row),'path':str(path)}
    return value

def settings_snapshot_binding(connection,nonce):
    columns=[r[1]for r in connection.execute('PRAGMA table_info(hugh_provider_settings)')];need('encrypted_key'in columns and len(columns)==len(set(columns)),'VAULT_SCHEMA_UNKNOWN')
    rows=[]
    for row in connection.execute('SELECT * FROM hugh_provider_settings ORDER BY name'):
        item=dict(zip(columns,row));need(all(v is None or type(v)is str or(type(v)is int and abs(v)<=9007199254740991)for v in item.values()),'VAULT_CANONICAL_SCALAR_UNKNOWN');rows.append(item)
    need(len(rows)<=7,'VAULT_ROW_BOUND')
    raw=json.dumps(rows,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
    binding=hmac.new(bytes.fromhex(nonce),b'palitra-vault-snapshot/v2\n'+raw,hashlib.sha256).hexdigest()
    return binding

def economy_guard(connection,env,end,proof=None,path=None):
    import importlib.util
    module_path=AREA/'economy_projection.py';need(sha(safe_read(module_path))==REVIEWED_DATA_PINS[module_path.name],'ECONOMY_PROJECTION_PIN_CHANGED')
    need(proof is not None and path is not None,'FRESH_OPAQUE_VAULT_PROOF_REQUIRED')
    need(type(proof)is dict and type(proof.get('nonce'))is str,'FRESH_OPAQUE_VAULT_PROOF_REQUIRED')
    issued=_VAULT_PROOFS.pop(proof['nonce'],None)
    need(issued is not None and issued['proof']==proof and issued['path']==str(path),'VAULT_PROOF_NOT_ISSUED_OR_REPLAYED')
    need(time.time()<=issued['expiresAt'],'VAULT_PROOF_EXPIRED')
    fresh=inspect_container(CONTENT);parent=issued['parent']
    need(fresh['Id']==parent['Id']and fresh['Image']==parent['Image']and fresh['Config']==parent['Config']and env==env_map(fresh),'VAULT_PARENT_OR_ENV_CHANGED')
    need(proof['files']==[vault_file_identity(path),vault_file_identity(str(path)+'-wal')],'VAULT_DATABASE_IDENTITY_CHANGED_BEFORE_PROJECTION')
    binding=settings_snapshot_binding(connection,proof['nonce'])
    need(hmac.compare_digest(binding,proof['settingsBinding']),'VAULT_SQLITE_SNAPSHOT_MISMATCH')
    spec=importlib.util.spec_from_file_location('reviewed_economy_projection',module_path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    value=module.verify(connection,env,int(time.time()*1000),int(end*1000),{k:proof[k]for k in('providers','canUseBalanceAccount')})
    need(proof['files']==[vault_file_identity(path),vault_file_identity(str(path)+'-wal')],'VAULT_DATABASE_IDENTITY_CHANGED_AFTER_PROJECTION')
    fresh=inspect_container(CONTENT);need(fresh['Id']==parent['Id']and fresh['Image']==parent['Image']and fresh['Config']==parent['Config']and env==env_map(fresh),'VAULT_PARENT_OR_ENV_CHANGED')
    with db_open(path)as latest:
        need(hmac.compare_digest(settings_snapshot_binding(latest,proof['nonce']),proof['settingsBinding']),'VAULT_SETTINGS_CHANGED_AFTER_PROJECTION')
    need(time.time()<=issued['expiresAt'],'VAULT_PROOF_EXPIRED')
    return value

def query_metadata(connection,required,queries,params):
    for table,columns in required.items():
        actual={r[1]for r in connection.execute('PRAGMA table_info('+quote(table)+')')}
        need(set(columns)<=actual,'STARTUP_QUEUE_SCHEMA_MISMATCH:'+table)
    values={}
    for name,sql in queries.items():
        cursor=connection.execute(sql,params);cols=[v[0]for v in cursor.description];values[name]=[dict(zip(cols,row))for row in cursor]
    need(connection.total_changes==0,'QUEUE_READONLY');return values

def zero(rows,columns,reason):
    need(all(type(r.get(c))in(int,float)and r[c]==0 for r in rows for c in columns),reason)

def startup_guard(paths,rows,end):
    data=load(AREA/'reviewed-sql.json');now=time.time()
    env=env_map(rows[CONTENT]);review_window_guard(env,now,end)
    need(not env.get('HUGH_LOCAL_WORKER_KEY_SHA256')and env.get('HUGH_FALLBACK_LOCAL_OFFLINE_MINUTES','0')=='0','LOCAL_TAKEOVER_PROFILE_CHANGED')
    iso=lambda x:datetime.fromtimestamp(x,timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
    params={'as_of':iso(now),'margin_end':iso(end),'sixty_seconds_before':iso(now-60),'fifteen_minutes_before':iso(now-900),
            'yesterday_msk':(datetime.fromtimestamp(now,timezone.utc).astimezone(timezone(timedelta(hours=3))).date()-timedelta(days=1)).isoformat(),
            'as_of_ms':int(now*1000),'margin_end_ms':int(end*1000),'stale_reservation_cutoff':iso(now-900),'stale_reservation_cutoff_window':iso(end-900)}
    content_path=paths['content:/data/content.sqlite']['hostPath'];vault=opaque_vault_probe(rows,content_path)
    with db_open(content_path)as conn:
        c=query_metadata(conn,data['content_queue_required'],data['content_queue_queries'],params)
        zero(c['ai_eligibility'],['eligible_in_window','startup_requeues'],'AI_ELIGIBLE_OR_STARTUP_REQUEUE')
        for state,attempts,assistant,next_at,missing in conn.execute('SELECT status,attempts,api_assistant,next_attempt_at,reply_message_id IS NULL FROM project_chat_ai_jobs'):
            need(state in('pending','error','blocked','running','done')and type(attempts)is int and attempts>=0 and assistant in(0,1),'AI_STATE_OR_METADATA_UNKNOWN')
            if state in('pending','error')and missing and attempts<3:
                try:
                    parsed=datetime.fromisoformat(str(next_at).replace('Z','+00:00'));need(parsed.tzinfo is not None,'AI_QUEUE_TIMESTAMP_UNKNOWN')
                except(ValueError,TypeError,OverflowError):raise ValueError('AI_QUEUE_TIMESTAMP_UNKNOWN')

        zero(c['delivery_alert_events'],['missing_events'],'MISSING_DELIVERY_ALERT_EVENT')
        for name in('potential_delay_effects','active_mirror_tasks','stale_task_alerts'):zero(c[name],['n'],'AUTOMATIC_ALERT_MIRROR_EFFECT:'+name)
        need(all(r['status']in('sent','uncertain')for r in c['owner_alerts']),'OWNER_ALERT_ACTIVE_OR_UNKNOWN')
        for name in('client_bot_outbox','site_order_outbox'):
            need(all(r['status']in('sent','uncertain','error','failed','stopped','cancelled')and r['claimed']==0 for r in c[name]),'CLIENT_OUTBOX_ACTIVE_OR_UNKNOWN')
        final=query_metadata(conn,data['final_content_required'],data['final_content_queries'],params)
        zero(final['budget_recovery'],['startup_recover_writes','may_recover_in_window'],'BUDGET_RECOVERY_EFFECT')
        need(all(r['state']in('kept','settled','released')for r in final['budget_recovery']),'BUDGET_STATE_ACTIVE_OR_UNKNOWN')
        need(final['economy_meta']==[{'existing_singleton':1}],'EXISTING_ECONOMY_META_REQUIRED')
        zero(final['push_envelopes'],['active_envelopes','invalid_metadata'],'PUSH_ENVELOPE_ACTIVE_OR_UNKNOWN')
        for table in('project_chat_outbox','project_chat_message_edits','project_chat_scheduled'):
            # Conservative empty-active policy: no past/future pending jobs, so
            # expiration/claim/recovery writes cannot hide behind a distant date.
            columns={r[1]for r in conn.execute('PRAGMA table_info('+quote(table)+')')};need('status'in columns,'STARTUP_QUEUE_SCHEMA_MISMATCH:'+table)
            states=[r[0]for r in conn.execute('SELECT DISTINCT status FROM '+quote(table))]
            need(all(s in('sent','done','uncertain','error','failed','stopped','cancelled')for s in states),'PROJECT_OUTBOX_ACTIVE_OR_UNKNOWN')
            if 'claimed_at'in columns:need(conn.execute('SELECT count(*) FROM '+quote(table)+' WHERE claimed_at IS NOT NULL').fetchone()[0]==0,'PROJECT_OUTBOX_CLAIMED')
        follow=conn.execute("WITH latest AS(SELECT key,MAX(version)version FROM documents WHERE key LIKE 'palitra-love/order-contact-followup/v1/%' GROUP BY key) SELECT COALESCE(SUM(CASE WHEN json_valid(d.body) THEN CASE WHEN json_extract(d.body,'$.state') IN('emitted','answered','stopped') THEN 0 ELSE 1 END ELSE 1 END),0) FROM documents d JOIN latest v ON d.key=v.key AND d.version=v.version").fetchone()[0]
        need(follow==0,'FOLLOWUP_ACTIVE_OR_UNKNOWN')
        need(conn.total_changes==0,'QUEUE_READONLY')
        economy_guard(conn,env,end,vault,content_path) # fixed opaque proof + pure readonly projection
    with db_open(paths['crm:/data/crm.sqlite']['hostPath'])as conn:
        cr=query_metadata(conn,data['final_crm_required'],data['final_crm_queries'],params)
        need(all(r['state']in('done','cancelled','review','needs_input','blocked','awaiting_executor')for r in cr['dispatch_states']),'CRM_DISPATCH_ACTIVE_OR_UNKNOWN')
        need(not cr['reconcile_cancellations'],'CRM_RECONCILIATION_EFFECT')
        need(all(r['handed_off']==1 for r in cr['dispatch_alerts']),'CRM_UNHANDED_ALERT')
    return{'status':'EXACT_STARTUP_GUARD_PASS','asOf':iso(now),'marginEnd':iso(end),'contentDigest':sha(enc(c)),'finalContentDigest':sha(enc(final)),'crmDigest':sha(enc(cr))}

def source_review_guard(rows,tree,after=False):
    source_phase_tree(tree,after)
    inventory=load(AREA/'inventory-review.json');need({r['containerPath']for r in inventory['activeDatabases']}==set(ACTIVE_DATABASE_PATHS)and {r['containerPath']for r in inventory['archives']}==set(OPAQUE_ARCHIVE_PATHS),'EXACT_ACTIVE_AND_OPAQUE_REVIEW_REQUIRED');fixed=account_database_path(inventory['databasePathEnv'],'palitra-love','site-44bbe13f1bad5e005b2a');need(fixed in{r['containerPath']for r in inventory['activeDatabases']},'INVENTORY_ACCOUNT_FORMULA_CHANGED');need(inventory['sourcePins']['server.js']==FILE_PINS['/app/server.js'][0]and tree.get('server.js',{}).get('sha256')==FILE_PINS['/app/server.js'][1 if after else 0]and inventory['sourcePins']['site-workspace-feature.js']==tree.get('site-workspace-feature.js',{}).get('sha256'),'INVENTORY_SOURCE_TREE_CHANGED')
    need(covering_mount(rows[CONTENT],'/data/content.sqlite')['Source']==inventory['dataMount'],'INVENTORY_DATA_MOUNT_CHANGED')
    for key,want in load(AREA/'reviewed-source-pins.json').items():
        role,name=key.split('/',1)
        if role=='content':
            expected=FILE_PINS['/app/server.js'][1 if after else 0]if name=='server.js'else want
            need(tree.get(name,{}).get('sha256')==expected,'STARTUP_SOURCE_PIN_CHANGED:'+name)
        elif role=='chat':
            need(name=='client-bot-bridge.js','PASSIVE_CHAT_EXACT_SOURCE_REQUIRED');passive_chat_source(rows['synapse-chat-1'],want)
        else:
            need(role=='crm','UNKNOWN_REVIEWED_SOURCE_ROLE')
            # Existing CRM Node profile guard remains mandatory and unchanged.
            other=runtime_tree(rows[CRM]);need(other.get(name,{}).get('sha256')==want,'CRM_DISPATCH_SOURCE_PIN_CHANGED')

def module(name):
    import importlib.util
    need(name in REVIEWED_DATA_PINS and name.endswith('.py'),'CLOSED_SUPPORT_MODULE');path=AREA/name;need(sha(safe_read(path))==REVIEWED_DATA_PINS[name],'SUPPORT_MODULE_PIN_CHANGED')
    spec=importlib.util.spec_from_file_location('reviewed_'+name.replace('.','_'),path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def host_static_path(target):
    need(target in STATIC_PINS and target.startswith('/opt/synapse/sites/synapse/cabinet/palitra-orders/'),'CLOSED_HOST_STATIC_PATH')
    path=ROOT/target.removeprefix('/opt/synapse/');need(path.resolve()==path and not path.is_symlink(),'HOST_STATIC_CANONICAL_PATH');return path

def source_phase_tree(tree,after):
    need(tree.get('server.js',{}).get('sha256')==FILE_PINS['/app/server.js'][1 if after else 0],'SERVER_EXACT_PHASE_REQUIRED')
    need(all(tree.get(t.removeprefix('/app/'),{}).get('sha256')==pin for t,pin in PRESERVED_R7.items()),'R7_PROTECTED_PAYLOAD_CHANGED')

def history_capture(paths,full,expected=None):
    path=paths['content:/data/content.sqlite']['hostPath'];data=Path(path).parent
    with db_open(path)as conn:return module('managed_history.py').scan(conn,data,db_facts(conn),MANAGED_REV,full,expected)

def history_witness():
    ready=load(AREA/'history-ready.json');raw=safe_read(AREA/'history-witness.json');need(sha(raw)==ready['witnessSha256']and ready['helperSha256']==sha(safe_read(SELF)),'HISTORY_WITNESS_PIN_CHANGED');return json.loads(raw)

def managed_guard(paths,full=False):
    witness=history_witness();history_capture(paths,full,witness['managed']);return {'witnessSha256':sha(safe_read(AREA/'history-witness.json')),'version':334,'revision':MANAGED_REV}

def prehistory():
    staged,manifest=package();need(not(AREA/'history-witness.json').exists()and not(AREA/'history-ready.json').exists()and not(AREA/'base.json').exists(),'HISTORY_WITNESS_EXISTS_INSPECT_ONLY');lease=own_lease();rows={n:inspect_container(n)for n in CONTAINERS}
    need(all(rows[n]['Image']==manifest['expectedImages'][n]for n in CONTAINERS),'HISTORY_FRESH_IMAGES_REQUIRED');tree=runtime_tree(rows[CONTENT]);need(tree==image_tree(BASE_IMAGE),'HISTORY_PARENT_TREE_REQUIRED');source_review_guard(rows,tree)
    for row in manifest['files']:
        item=tree.get(row['target'].removeprefix('/app/'));need(item and item['type']=='file'and item['nlink']==1 and item['sha256']==row['beforeSha256'],'PREHISTORY_FOUR_FRESH_BEFORE_PINS')
    r7_plan_guard(effective_plan(rows,manifest['expectedImages']));paths=database_paths(rows,manifest);hosts=module('host_static.py').current(sys.modules[__name__]);need(all(hosts[t]['sha256']==STATIC_PINS[t][0]for t in STATIC_TARGETS),'HISTORY_HOST_BEFORE_REQUIRED')
    managed=history_capture(paths,True);history_capture(paths,False,managed)
    need(all(foreign(inspect_container(n))==foreign(rows[n])for n in CONTAINERS),'HISTORY_IMAGES_CHANGED_DURING_SCAN');need(module('host_static.py').current(sys.modules[__name__])==hosts,'HISTORY_HOST_CHANGED_DURING_SCAN')
    witness={'managed':managed,'identities':{n:sha(enc(foreign(r)))for n,r in rows.items()},'images':{n:r['Image']for n,r in rows.items()},'hostBefore':hosts,'sourceTreeSha256':sha(enc(tree)),'manifestSha256':staged['manifestSha256'],'helperSha256':staged['helperSha256'],'lease':lease,'at':time.time()}
    raw=enc(witness);write_new(AREA/'history-witness.json',raw);write_new(AREA/'history-ready.json',enc({'witnessSha256':sha(raw),'helperSha256':sha(safe_read(SELF))}));sync_dir(AREA);print('PREHISTORY_PROTECTED_NOT_BASE_OR_PERMIT')


def snapshot_databases(paths,diagnostic_out=None,env=None):
    result={}
    for name,row in paths.items():
        need(db_identity(row['hostPath'])==row['identity'],'DATABASE_IDENTITY_CHANGED')
        if row.get('preservation')=='opaque':result[name]=opaque_archive_facts(row)
        else:
            need(row.get('preservation')=='sqlite','DATABASE_PRESERVATION_KIND_UNKNOWN')
            with db_open(row['hostPath'])as conn:
                anchor=diagnostic_clock();result[name]=db_facts(conn)
                if diagnostic_out is not None and diagnostic_main(row):diagnostic_out.update(diagnostic_policy().capture(conn,env,result[name],anchor=anchor))
    return result

def prepare():
    staged,manifest=package();need(not(AREA/'base.json').exists()and not(AREA/'apply-intent.json').exists(),'PREPARE_EXISTS_INSPECT_ONLY')
    lease=own_lease();rows={n:inspect_container(n)for n in CONTAINERS};need(all(rows[n]['Image']==manifest['expectedImages'][n]for n in CONTAINERS),'FRESH_FIVE_IMAGES_REQUIRED')
    need(rows[CONTENT]['Image']==BASE_IMAGE,'EXACT_ACTUAL_PARENT_REQUIRED')
    need(not any(m['Destination']=='/app'or m['Destination'].startswith('/app/')for m in rows[CONTENT]['Mounts']),'APP_MOUNT_REFUSED')
    tree=runtime_tree(rows[CONTENT]);need(tree==image_tree(BASE_IMAGE),'COMPLETE_PARENT_RUNTIME_MISMATCH')
    for row in manifest['files']:
        item=tree.get(row['target'].removeprefix('/app/'));need(item and item['type']=='file'and item['nlink']==1 and item['sha256']==row['beforeSha256'],'FOUR_BEFORE_SOURCE_PINS')
    witness=history_witness();need(witness['manifestSha256']==staged['manifestSha256']and witness['images']==manifest['expectedImages']and witness['sourceTreeSha256']==sha(enc(tree))and all(sha(enc(foreign(rows[n])))==witness['identities'][n]for n in CONTAINERS),'PREHISTORY_FRESH_BINDING_CHANGED')
    source_review_guard(rows,tree);paths=database_paths(rows,manifest);need(module('host_static.py').current(sys.modules[__name__])==witness['hostBefore'],'PREHISTORY_HOST_BINDING_CHANGED');managed_guard(paths);queues=startup_guard(paths,rows,time.time()+APPLY_TTL+GRACE)
    diagnostic={};facts=snapshot_databases(paths,diagnostic,env_map(rows[CONTENT]))
    base={'lease':lease,'created':time.time(),'expires':time.time()+PREPARE_TTL,'rows':rows,'tree':tree,'databases':paths,'databaseFacts':facts,'diagnosticBase':diagnostic,'plan':effective_plan(rows,manifest['expectedImages']),
          'hostStatic':module('host_static.py').protect_before(sys.modules[__name__]),'policy':policy_state(),'static':full_static(),'price':price_pin(),'managed':managed_guard(paths),'queueProof':queues}
    r7_plan_guard(base['plan']);base_sha=sha(enc(base));write_new(AREA/'base.json',enc(base));genesis=diagnostic_init(base,base_sha);write_new(AREA/'prepared.json',enc({**staged,'baseSha256':base_sha,'lease':lease,'diagnosticGenesisSha256':genesis}))
    print('PREPARED_PRIVATE_BASE_NOT_INSTALLED')

def base_guard(after=False,readback=False,history_full=False):
    staged,manifest=package();base=load(AREA/'base.json');prepared=load(AREA/'prepared.json')
    need(sha(safe_read(AREA/'base.json'))==prepared['baseSha256']and all(prepared[k]==v for k,v in staged.items()),'BASE_PACKAGE_PIN_CHANGED')
    lease=own_lease();need(readback or lease==base['lease'],'FRESH_OWN_LEASE_REQUIRED');need(readback or base['created']<=time.time()<base['expires'],'PREPARE_EXPIRED')
    rows={n:inspect_container(n)for n in CONTAINERS}
    for name in CONTAINERS:
        if name!=CONTENT:need(foreign(rows[name])==foreign(base['rows'][name]),'FOREIGN_CONTAINER_CHANGED')
    child=load(AREA/'child.json')if after else None;expected=child['image']if after else BASE_IMAGE
    if after:built_image_guard(base,manifest,child)
    need(rows[CONTENT]['Image']==expected,'CONTENT_IMAGE_CHANGED');need(normalize_content(rows[CONTENT])==normalize_content(base['rows'][CONTENT]),'CONTENT_CONFIG_CHANGED')
    want=expected_tree(base,manifest)if after else base['tree'];actual_tree=runtime_tree(rows[CONTENT]);source_phase_tree(actual_tree,after);need(actual_tree==want and image_tree(expected)==want,'COMPLETE_APP_TREE_CHANGED')
    images=dict(manifest['expectedImages']);images[CONTENT]=expected;plan=effective_plan(rows,images)
    need(plan==(validated_plan(base,child)if after else base['plan']),'EFFECTIVE_COMPOSE_CHANGED')
    need(policy_state()==base['policy']and full_static()==base['static']and price_pin()==base['price'],'POLICY_PRICE_STATIC_CHANGED')
    paths=database_paths(rows,manifest);need(paths==base['databases'],'DATABASE_PATH_IDENTITY_CHANGED')
    need(managed_guard(paths,history_full)==base['managed'],'MANAGED_REVISION_CHANGED');module('host_static.py').expect(sys.modules[__name__],base,0)
    for name,row in paths.items():
        assert_preserved_path(row,base['databaseFacts'][name],base,rows,after)
    margin=time.time()+APPLY_TTL+GRACE
    if(AREA/'apply-permit.json').exists():
        permit=load(AREA/'apply-permit.json');margin=max(time.time(),permit['expires'])+GRACE
        if not readback:need(permit['created']<=time.time()<permit['expires'],'APPLY_PERMIT_EXPIRED')
    startup_guard(paths,rows,margin)
    # R2 tolerant RO-binding must not replace the independent wholeDB fence.
    for name,row in paths.items():
        need(db_identity(row['hostPath'])==row['identity'],'DATABASE_IDENTITY_CHANGED_AFTER_STARTUP_GUARD')
        assert_preserved_path(row,base['databaseFacts'][name],base,rows,after)
    module('host_static.py').expect(sys.modules[__name__],base,0)
    need(all(foreign(inspect_container(n))==foreign(rows[n])for n in CONTAINERS),'CONTAINER_CHANGED_DURING_GUARD')
    return staged,manifest,base,rows

def backup_databases(base):
    need(not(AREA/'backups').exists(),'BACKUPS_EXIST_INSPECT_ONLY');(AREA/'backups').mkdir(mode=0o700)
    result={}
    for index,(name,row)in enumerate(base['databases'].items()):
        checked=base_guard()
        if row.get('preservation')=='opaque':
            started=time.monotonic();assert_preserved_path(row,base['databaseFacts'][name])
            for suffix,fact in base['databaseFacts'][name]['files'].items():
                if fact is None:continue
                target=AREA/'backups'/('archive-'+str(index)+('-main'if not suffix else suffix)+'.raw')
                raw=safe_read(row['hostPath']+suffix);need(sha(raw)==fact['sha256']and len(raw)==fact['bytes'],'OPAQUE_ARCHIVE_COPY_SOURCE_CHANGED')
                need(time.monotonic()-started<120 and own_lease()==base['lease']and time.time()<base['expires'],'BACKUP_LEASE_TIME_GUARD')
                write_new(target,raw);result[name+suffix]={'path':str(target),'sha256':sha(safe_read(target))}
                need(result[name+suffix]['sha256']==fact['sha256'],'OPAQUE_ARCHIVE_BACKUP_MISMATCH')
            assert_preserved_path(row,base['databaseFacts'][name]);need(time.monotonic()-started<120,'BACKUP_LEASE_TIME_GUARD');base_guard();continue
        need(row.get('preservation')=='sqlite','DATABASE_PRESERVATION_KIND_UNKNOWN');current_rows=checked[3]
        target=AREA/'backups'/('db-'+str(index)+'.sqlite');write_new(target,b'')
        source=sqlite3.connect(Path(row['hostPath']).as_uri()+'?mode=ro',uri=True,timeout=5);destination=sqlite3.connect(target);started=time.monotonic()
        def progress(status,remaining,total):
            need(time.monotonic()-started<120 and own_lease()==base['lease']and time.time()<base['expires'],'BACKUP_LEASE_TIME_GUARD')
        try:
            source.execute('PRAGMA query_only=ON');need(source.execute('PRAGMA query_only').fetchone()==(1,),'BACKUP_READONLY_SOURCE');source.execute('BEGIN');anchor=diagnostic_clock();captured=db_facts(source)
            if diagnostic_main(row):
                observed=diagnostic_policy().capture(source,env_map(current_rows[CONTENT]),captured,anchor=anchor);diagnostic_observe(base,current_rows,False,captured,observed)
            else:need(enc(captured)==enc(base['databaseFacts'][name]),'DATABASE_SCHEMA_OR_ROWS_CHANGED_INSPECT_ONLY')
            source.backup(destination,pages=128,progress=progress);assert_database(destination,captured);need(source.total_changes==0,'BACKUP_SOURCE_CHANGED')
        finally:source.close();destination.close()
        os.chmod(target,0o600);result[name]={'path':str(target),'sha256':sha(safe_read(target))}
        base_guard()
    write_new(AREA/'backups.json',enc(result));return result

def expected_tree(base,manifest):
    tree=copy.deepcopy(base['tree'])
    for row in manifest['files']:
        key=row['target'].removeprefix('/app/');tree[key]={**tree[key],'sha256':row['afterSha256'],'bytes':row['bytes']}
    return tree

def tar_members(raw,base,manifest):
    expected={row['target'].removeprefix('/'):row for row in manifest['files']};seen=set()
    with tarfile.open(fileobj=io.BytesIO(raw),mode='r:')as archive:
        for info in archive:
            name=info.name.rstrip('/');need(not name.startswith('/')and '..'not in name.split('/')and not any(v.startswith('.wh.')for v in name.split('/')),'LAYER_PATH_REFUSED')
            need(name not in seen,'DUPLICATE_LAYER_MEMBER');seen.add(name)
            if info.isdir():
                relative=name.removeprefix('app/');key=''if name=='app'else relative
                need((name=='app'or name.startswith('app/'))and any(target.startswith(name+'/')for target in expected),'FOREIGN_LAYER_DIRECTORY')
                prior=base['tree'].get(key);need(prior and prior['type']=='directory'and(info.mode,info.uid,info.gid)==(prior['mode'],prior['uid'],prior['gid']),'DIRECTORY_METADATA_CHANGED');continue
            need(info.isfile()and name in expected,'FOREIGN_OR_NONREGULAR_LAYER_FILE')
            row=expected[name];prior=base['tree'][name.removeprefix('app/')];need(info.size==row['bytes']and(info.mode,info.uid,info.gid)==(prior['mode'],prior['uid'],prior['gid']),'LAYER_FILE_METADATA_CHANGED')
            member=archive.extractfile(info);need(member is not None and sha(member.read(512001))==row['afterSha256'],'LAYER_FILE_CONTENT_CHANGED')
    need(expected.keys()<=seen,'MISSING_LAYER_FILE')

def audit_saved_layer(path,base,manifest,child_info):
    import importlib.util
    code=AREA/'image_archive_audit.py';need(sha(safe_read(code))==REVIEWED_DATA_PINS[code.name],'IMAGE_ARCHIVE_AUDITOR_PIN_CHANGED')
    spec=importlib.util.spec_from_file_location('reviewed_image_archive_audit',code);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.audit(path,base,manifest,child_info,tar_members)

def build():
    need(not(AREA/'build-intent.json').exists(),'ONE_BUILD_ATTEMPT_INSPECT_ONLY');_,manifest,base,_=base_guard()
    write_new(AREA/'build-intent.json',enc({'at':time.time(),'lease':base['lease']}));backups=backup_databases(base)
    folder=AREA/'build';folder.mkdir(mode=0o700);stream=io.BytesIO()
    with tarfile.open(fileobj=stream,mode='w',format=tarfile.USTAR_FORMAT)as archive:
        for row in manifest['files']:
            key=row['target'].removeprefix('/app/');raw=safe_read(AREA/'payload'/key);before=base['tree'][key];info=tarfile.TarInfo(key);info.size=len(raw);info.mode=before['mode'];info.uid=before['uid'];info.gid=before['gid'];info.mtime=0;archive.addfile(info,io.BytesIO(raw))
    payload=stream.getvalue();write_new(folder/'payload.tar',payload)
    token=os.urandom(8).hex();alias=NAME+'-'+token+'-base:local';tag=NAME+'-'+token+':local'
    need(not run(['docker','image','ls','--quiet',alias]).strip()and not run(['docker','image','ls','--quiet',tag]).strip(),'UNIQUE_LOCAL_IMAGE_TAGS')
    dockerfile=('FROM '+alias+'\nADD payload.tar /app/\n').encode();write_new(folder/'Dockerfile',dockerfile)
    need({p.name for p in folder.iterdir()}=={'payload.tar','Dockerfile'},'CLOSED_BUILD_CONTEXT')
    base_guard();run(['docker','image','tag',BASE_IMAGE,alias]);need(run(['docker','image','inspect','--format','{{.Id}}',alias]).decode().strip()==BASE_IMAGE,'LOCAL_PARENT_ALIAS_PIN')
    need(safe_read(folder/'payload.tar')==payload and safe_read(folder/'Dockerfile')==dockerfile,'BUILD_CONTEXT_CHANGED')
    run(['docker','build','--network=none','--pull=false','--tag',tag,'--iidfile',str(folder/'image.id'),str(folder)],180)
    image=safe_read(folder/'image.id').decode().strip();need(IMAGE.fullmatch(image),'CHILD_IMAGE_ID_REQUIRED');parent_info=image_info(BASE_IMAGE);child_info=image_info(image)
    need(child_info['RootFS']['Layers'][:-1]==parent_info['RootFS']['Layers']and len(child_info['RootFS']['Layers'])==len(parent_info['RootFS']['Layers'])+1 and child_info['Config']==parent_info['Config'],'ONE_INHERITED_CONTENT_LAYER')
    need(image_tree(image)==expected_tree(base,manifest),'FULL_CHILD_TREE_CHANGED')
    # Export is a bounded private code artifact; never run the default app command.
    run(['docker','image','save','--output',str(folder/'child-image.tar'),image],180)
    audit_saved_layer(folder/'child-image.tar',base,manifest,child_info);base_guard()
    child={'image':image,'parent':BASE_IMAGE,'imageConfigSha256':sha(enc(child_info['Config'])),'lastDiffId':child_info['RootFS']['Layers'][-1]}
    write_new(AREA/'child.json',enc(child));make_plan(base,child)
    print('BUILT_NOT_APPLIED')

def make_plan(base,child):
    overlay=AREA/'content-image-only.json';write_new(overlay,enc({'services':{'content':{'image':child['image']}}}))
    plan=copy.deepcopy(base['plan']);plan['files'].append({'path':str(overlay),'sha256':sha(safe_read(overlay))});observed=json.loads(run(compose_args(plan)+['config','--format','json']))
    want=copy.deepcopy(base['plan']['resolved']);want['services']['content']['image']=child['image'];need(observed==want,'ONLY_CONTENT_IMAGE_DELTA')
    plan['resolved']=observed
    for name,own in plan['ownChains'].items():
        pin=service_hash(plan,own['service'])
        if name==CONTENT:need(own['service']=='content','CONTENT_SERVICE_REQUIRED');own.update(files=copy.deepcopy(plan['files']),configHash=pin)
        else:need(pin==own['configHash'],'FOREIGN_SERVICE_HASH_CHANGED')
    write_new(AREA/'forward-plan.json',enc(plan));return plan

def backup_guard():
    backups=load(AREA/'backups.json')
    for row in backups.values():need(sha(safe_read(row['path']))==row['sha256'],'PROTECTED_BACKUP_CHANGED')


def built_image_guard(base,manifest,child):
    need(set(child)=={'image','parent','imageConfigSha256','lastDiffId'}and IMAGE.fullmatch(child['image'])and child['parent']==BASE_IMAGE and child['image']!=BASE_IMAGE,'EXACT_CHILD_RECEIPT_REQUIRED')
    before=image_info(BASE_IMAGE);after=image_info(child['image'])
    need(after['Config']==before['Config']and sha(enc(after['Config']))==child['imageConfigSha256'],'CHILD_IMAGE_CONFIG_CHANGED')
    need(after['RootFS']['Layers'][:-1]==before['RootFS']['Layers']and len(after['RootFS']['Layers'])==len(before['RootFS']['Layers'])+1 and after['RootFS']['Layers'][-1]==child['lastDiffId'],'CHILD_LAYER_ANCESTRY_CHANGED')
    audit_saved_layer(AREA/'build/child-image.tar',base,manifest,after)

def validated_plan(base,child):
    overlay=AREA/'content-image-only.json';need(safe_read(overlay)==enc({'services':{'content':{'image':child['image']}}}),'IMAGE_ONLY_OVERLAY_CHANGED')
    expected=copy.deepcopy(base['plan']);expected['files'].append({'path':str(overlay),'sha256':sha(safe_read(overlay))});expected['resolved']['services']['content']['image']=child['image']
    actual=json.loads(run(compose_args(expected)+['config','--format','json']));need(actual==expected['resolved'],'ONLY_CONTENT_IMAGE_DELTA')
    for name,own in expected['ownChains'].items():
        value=service_hash(expected,own['service'])
        if name==CONTENT:need(own['service']=='content','CONTENT_SERVICE_REQUIRED');own.update(files=copy.deepcopy(expected['files']),configHash=value)
        else:need(value==own['configHash'],'FOREIGN_SERVICE_HASH_CHANGED')
    need(load(AREA/'forward-plan.json')==expected,'FORWARD_PLAN_PIN_CHANGED');return expected

def apply():
    need(not(AREA/'apply-intent.json').exists()and not(AREA/'apply-permit.json').exists(),'ONE_APPLY_ATTEMPT_INSPECT_ONLY');_,manifest,base,_=base_guard();child=load(AREA/'child.json');plan=load(AREA/'forward-plan.json');backup_guard()
    built_image_guard(base,manifest,child)
    need(plan==validated_plan(base,child),'BUILT_FORWARD_PLAN_CHANGED')
    need(image_tree(child['image'])==expected_tree(base,manifest),'BUILT_CHILD_CHANGED')
    need(json.loads(run(compose_args(plan)+['config','--format','json']))==plan['resolved'],'LATE_COMPOSE_CAS')
    now=time.time();write_new(AREA/'apply-permit.json',enc({'created':now,'expires':now+APPLY_TTL,'baseSha256':sha(safe_read(AREA/'base.json'))}))
    base_guard();write_new(AREA/'apply-intent.json',enc({'at':time.time(),'image':child['image'],'lease':base['lease']}))
    # Any error/timeout leaves this journal sealed. No second up is performed.
    run(compose_args(plan)+['up','--detach','--no-build','--pull','never','--no-deps','content'],120)
    write_new(AREA/'up-returned.json',enc({'at':time.time(),'image':child['image']}))
    base_guard(after=True);write_new(AREA/'installed.json',enc({'status':'APPLIED_REQUIRES_INDEPENDENT_INSPECT','image':child['image'],'at':time.time()}))
    print('APPLIED_REQUIRES_INDEPENDENT_INSPECT')

def inspect_result():
    # This path does not require installed.json: unknown up can have succeeded.
    package();own_lease();need((AREA/'base.json').exists(),'BASE_REQUIRED');base=load(AREA/'base.json')
    actual=inspect_container(CONTENT);intent=(AREA/'apply-intent.json').exists();child=load(AREA/'child.json')if(AREA/'child.json').exists()else None
    if actual['Image']==BASE_IMAGE:
        base_guard(readback=True);status='BEFORE_NO_REPLAY'if intent else'BEFORE_NOT_APPLIED'
    elif child and actual['Image']==child['image']:
        need(intent,'CHILD_WITHOUT_APPLY_INTENT');_,_,_,accepted_rows=base_guard(after=True,readback=True,history_full=True);backup_guard();status='AFTER_INDEPENDENT_READBACK_PASS'
        if not(AREA/'runtime-accepted.json').exists():write_new(AREA/'runtime-accepted.json',enc({'status':status,'childSha256':sha(safe_read(AREA/'child.json')),'baseSha256':sha(safe_read(AREA/'base.json')),'historyWitnessSha256':sha(safe_read(AREA/'history-witness.json')),'identities':{n:sha(enc(foreign(r)))for n,r in accepted_rows.items()},'at':time.time()}))
    else:raise ValueError('UNEXPECTED_RUNNING_IMAGE_INSPECT_ONLY')
    result={'status':status,'at':time.time(),'contentRecreationsObserved':int(status.startswith('AFTER')),'otherServiceRestarts':0,'directDatabaseWrites':0,'databaseRestored':False,'automaticReplay':False}
    write_new(AREA/('inspect-'+str(time.time_ns())+'.json'),enc(result));print(json.dumps(result));return result

def static_runtime_envelope(runtime_base,manifest,rows,accepted):
    need(accepted['status']=='AFTER_INDEPENDENT_READBACK_PASS'and accepted['baseSha256']==sha(safe_read(AREA/'base.json'))and accepted['childSha256']==sha(safe_read(AREA/'child.json'))and accepted['historyWitnessSha256']==sha(safe_read(AREA/'history-witness.json')),'STATIC_RUNTIME_ACCEPTANCE_PIN_CHANGED')
    need(all(sha(enc(foreign(rows[n])))==accepted['identities'][n]for n in CONTAINERS),'STATIC_ACCEPTED_CONTAINER_IDENTITY_CHANGED')
    child=load(AREA/'child.json');built_image_guard(runtime_base,manifest,child);want=expected_tree(runtime_base,manifest);actual=runtime_tree(rows[CONTENT]);source_phase_tree(actual,True)
    need(actual==want and image_tree(child['image'])==want,'STATIC_COMPLETE_RUNTIME_TREE_CHANGED');need(rows[CONTENT]['Image']==child['image'],'STATIC_ACCEPTED_CHILD_REQUIRED')
    for n in CONTAINERS:
        if n!=CONTENT:need(foreign(rows[n])==foreign(runtime_base['rows'][n]),'STATIC_FOREIGN_CONTAINER_CHANGED')
    need(normalize_content(rows[CONTENT])==normalize_content(runtime_base['rows'][CONTENT]),'STATIC_RUNTIME_CONFIG_CHANGED')
    images=dict(manifest['expectedImages']);images[CONTENT]=child['image'];plan=effective_plan(rows,images);need(plan==validated_plan(runtime_base,child),'STATIC_EFFECTIVE_PLAN_CHANGED')
    need(policy_state()==runtime_base['policy']and price_pin()==runtime_base['price'],'STATIC_POLICY_PRICE_CHANGED');return want,plan

def static_prepare():
    staged,manifest=package();own_lease();need((AREA/'runtime-accepted.json').exists(),'STATIC_INDEPENDENT_RUNTIME_ACCEPTANCE_REQUIRED');need(not(AREA/'static-base.json').exists()and not(AREA/'static-layer').exists(),'STATIC_ANCHOR_EXISTS_INSPECT_ONLY')
    runtime_base=load(AREA/'base.json');accepted=load(AREA/'runtime-accepted.json');rows={n:inspect_container(n)for n in CONTAINERS};tree,plan=static_runtime_envelope(runtime_base,manifest,rows,accepted);source_review_guard(rows,tree,True)
    module('host_static.py').expect(sys.modules[__name__],runtime_base,0);backup_guard();paths=database_paths(rows,manifest);need(paths==runtime_base['databases'],'STATIC_DATABASE_PATHS_CHANGED');managed=managed_guard(paths)
    queues=startup_guard(paths,rows,time.time()+APPLY_TTL+GRACE);diagnostic={};facts=snapshot_databases(paths,diagnostic,env_map(rows[CONTENT]))
    base={'lease':own_lease(),'created':time.time(),'expires':time.time()+PREPARE_TTL,'rows':rows,'tree':tree,'databases':paths,'databaseFacts':facts,'diagnosticBase':diagnostic,'hostStatic':runtime_base['hostStatic'],'static':runtime_base['static'],'plan':plan,'managed':managed,'policy':runtime_base['policy'],'price':runtime_base['price'],'queueProof':queues,'runtimeAcceptedSha256':sha(safe_read(AREA/'runtime-accepted.json')),'runtimeBaseSha256':sha(safe_read(AREA/'base.json'))}
    (AREA/'static-layer').mkdir(mode=0o700);raw=enc(base);write_new(AREA/'static-base.json',raw);genesis=diagnostic_init(base,sha(raw),True);write_new(AREA/'static-layer/prepared.json',enc({'baseSha256':sha(raw),'diagnosticGenesisSha256':genesis,'stageManifestSha256':staged['manifestSha256']}));sync_dir(AREA/'static-layer');sync_dir(AREA);print('STATIC_ANCHOR_CREATED_NO_APP_RESTART')

def static_guard(phase,readback=False,history_full=False):
    staged,manifest=package();need(type(phase)is int and phase in(0,1,2),'STATIC_CLOSED_PHASE');own=own_lease();base=load(AREA/'static-base.json');prepared=load(AREA/'static-layer/prepared.json')
    need(sha(safe_read(AREA/'static-base.json'))==prepared['baseSha256']and staged['manifestSha256']==prepared['stageManifestSha256'],'STATIC_ANCHOR_PIN_CHANGED')
    need(readback or own==base['lease'],'STATIC_FRESH_OWN_LEASE_REQUIRED');need(readback or base['created']<=time.time()<base['expires'],'STATIC_ANCHOR_EXPIRED')
    need(sha(safe_read(AREA/'runtime-accepted.json'))==base['runtimeAcceptedSha256']and sha(safe_read(AREA/'base.json'))==base['runtimeBaseSha256'],'STATIC_RUNTIME_RECEIPT_CHANGED')
    rows={n:inspect_container(n)for n in CONTAINERS};runtime_base=load(AREA/'base.json');accepted=load(AREA/'runtime-accepted.json');tree,plan=static_runtime_envelope(runtime_base,manifest,rows,accepted)
    need(tree==base['tree']and plan==base['plan'],'STATIC_CODE_PLAN_CHANGED');module('host_static.py').expect(sys.modules[__name__],base,phase);backup_guard()
    paths=database_paths(rows,manifest);need(paths==base['databases'],'STATIC_DATABASE_PATHS_CHANGED');need(managed_guard(paths,history_full)==base['managed'],'STATIC_MANAGED_WITNESS_CHANGED')
    for name,row in paths.items():assert_preserved_path(row,base['databaseFacts'][name],base,rows,False,True)
    startup_guard(paths,rows,time.time()+APPLY_TTL+GRACE)
    for name,row in paths.items():assert_preserved_path(row,base['databaseFacts'][name],base,rows,False,True)
    module('host_static.py').expect(sys.modules[__name__],base,phase)
    need(all(foreign(inspect_container(n))==foreign(rows[n])for n in CONTAINERS),'STATIC_CONTAINER_CHANGED_DURING_GUARD')
    return base


if __name__=='__main__':
    try:
        need(os.name=='posix'and os.geteuid()==0,'NATIVE_LINUX_ROOT_ONLY');os.umask(0o077)
        mode=sys.argv[1]
        if mode=='stage':stage(sys.argv[2],sys.argv[3])
        elif mode=='prehistory':prehistory()
        elif mode=='prepare':prepare()
        elif mode=='build':build()
        elif mode=='apply':apply()
        elif mode=='inspect':inspect_result()
        elif mode=='static-prepare':static_prepare()
        elif mode=='static-host':print(json.dumps(module('host_static.py').write_one(sys.modules[__name__],0)))
        elif mode=='static-shell':print(json.dumps(module('host_static.py').write_one(sys.modules[__name__],1)))
        elif mode=='inspect-static':print(json.dumps(module('host_static.py').inspect(sys.modules[__name__])))
        elif mode=='inspect-all':print(json.dumps(module('host_static.py').inspect(sys.modules[__name__],True)))
        else:raise ValueError('KNOWN_MODE_REQUIRED')
    except Exception as error:
        # No command/env/DB payload is included in the public error.
        print('REFUSED: '+type(error).__name__+': '+str(error),file=sys.stderr);sys.exit(2)
