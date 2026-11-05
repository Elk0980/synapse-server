"""Closed CRM-only + nine-static release. Code preparation is not an install receipt.

One fresh own ancestor lease, one apply attempt, one CRM recreation, no DB restore,
DDL, queue admission, settings change, network build, pull or other service restart.
"""
from pathlib import Path
from contextlib import contextmanager
import copy, hashlib, io, json, os, re, sqlite3, stat, subprocess, sys, tarfile, time, urllib.request

sys.dont_write_bytecode = True
NAME = 'palitra-content-native-20261029-r1'
ROOT = Path('/opt/synapse')
AREA = ROOT/'releases'/NAME
SELF = Path(__file__).resolve()
LOCK = ROOT/'.palitra-app-release.lock'
CRM = 'synapse-crm-1'
CONTENT = 'synapse-content-1'
CONTAINERS = (CRM, CONTENT, 'synapse-hugh-runtime-1', 'synapse-chat-1', 'caddy')
RUNTIME = ('ops/crm/autoposting.js', 'ops/crm/server.js')
PREFIX = 'sites/synapse/cabinet/palitra-orders/'
STATIC = tuple(PREFIX+n for n in ('cabinet.html','native-host.js','shell.js','palitra-content-tasks-ui.js','palitra-publication-composer.js','palitra-content-material-ui.js','palitra-content-material-ui.css','palitra-content-plan-ui.js','palitra-content-plan-ui.css'))
NEW = STATIC[-4:]
SCOPE = RUNTIME+STATIC
HEX = re.compile('[a-f0-9]{64}')
LEGACY_SHA = '91323f3430ee65b8df371c055d4fd1d3d7ff2762a09c5a379ee35263416cced7'
MAX_FILE = 64*1024*1024
sha = lambda raw: hashlib.sha256(raw).hexdigest()
enc = lambda value: (json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n').encode()

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

def run(argv,timeout=90):
    need(type(argv) is list and all(type(v) is str for v in argv),'NO_SHELL')
    result=subprocess.run(argv,stdin=subprocess.DEVNULL,capture_output=True,timeout=timeout)
    need(result.returncode==0,'COMMAND_FAILED_INSPECT_ONLY')
    need(len(result.stdout)<=MAX_FILE and len(result.stderr)<=1024*1024,'COMMAND_OUTPUT_BOUND')
    return result.stdout

def validate_manifest(value):
    need(set(value)=={'schema','packageId','status','helperSha256','expectedImages','files'},'CLOSED_MANIFEST')
    need(value['schema']==1 and value['packageId']==NAME and value['status']=='ROOT_REVIEWED_CODE_ONLY','ROOT_REVIEW_REQUIRED')
    need(type(value['helperSha256']) is str and HEX.fullmatch(value['helperSha256']),'HELPER_PIN_REQUIRED')
    images=value['expectedImages']
    need(type(images) is dict and set(images)==set(CONTAINERS) and all(type(v) is str and re.fullmatch('sha256:[a-f0-9]{64}',v) for v in images.values()),'FRESH_ALL_FIVE_IMAGE_PINS')
    rows=value['files']
    need(type(rows) is list and tuple(r.get('target') for r in rows)==SCOPE,'EXACT_TWO_RUNTIME_NINE_STATIC')
    for row in rows:
        need(set(row)=={'target','beforeSha256','afterSha256','bytes'},'CLOSED_FILE_ROW')
        need(type(row['afterSha256']) is str and HEX.fullmatch(row['afterSha256']) and type(row['bytes']) is int and 0<row['bytes']<=512000,'AFTER_PIN_AND_SIZE')
        need(row['beforeSha256'] is None if row['target'] in NEW else type(row['beforeSha256']) is str and HEX.fullmatch(row['beforeSha256']),'EXISTING_OR_EXACT_NEW_PIN')
    return value

def package():
    staged=load(AREA/'stage.json');raw=safe_read(AREA/'manifest.json')
    need(sha(safe_read(SELF))==staged['helperSha256'] and sha(raw)==staged['manifestSha256'],'PINNED_PACKAGE_CHANGED')
    manifest=validate_manifest(json.loads(raw));need(manifest['helperSha256']==staged['helperSha256'],'HELPER_PIN')
    actual={p.relative_to(AREA/'payload').as_posix() for p in (AREA/'payload').rglob('*') if p.is_file() or p.is_symlink()}
    need(actual==set(SCOPE),'CLOSED_PAYLOAD')
    for row in manifest['files']:
        data=safe_read(AREA/'payload'/row['target']);need(len(data)==row['bytes'] and sha(data)==row['afterSha256'],'PAYLOAD_PIN')
    return staged,manifest

def stage(commit,pin):
    need(re.fullmatch('[a-f0-9]{40}',commit) and HEX.fullmatch(pin),'IMMUTABLE_PINS_REQUIRED')
    need(not os.path.lexists(AREA),'STAGE_EXISTS_INSPECT_ONLY')
    base='https://raw.githubusercontent.com/Elk0980/synapse-server/'+commit+'/ops/'+NAME+'/'
    def fetch(name,limit):
        with urllib.request.urlopen(base+name,timeout=30) as response: data=response.read(limit+1)
        need(len(data)<=limit,'PUBLIC_CODE_SIZE');return data
    raw=fetch('manifest.json',64000);need(sha(raw)==pin,'MANIFEST_PIN')
    manifest=validate_manifest(json.loads(raw));need(manifest['helperSha256']==sha(safe_read(SELF)),'HELPER_PIN')
    values={r['target']:fetch('payload/'+r['target'],r['bytes']) for r in manifest['files']}
    need(all(len(values[r['target']])==r['bytes'] and sha(values[r['target']])==r['afterSha256'] for r in manifest['files']),'PAYLOAD_PIN')
    need(AREA.parent.resolve()==AREA.parent and AREA.parent.is_dir(),'CANONICAL_RELEASES')
    AREA.mkdir(mode=0o700)
    for name,data in values.items():
        path=AREA/'payload'/name;path.parent.mkdir(mode=0o700,parents=True,exist_ok=True);write_new(path,data)
    write_new(AREA/'manifest.json',raw);write_new(AREA/'stage.json',enc({'commit':commit,'manifestSha256':pin,'helperSha256':sha(safe_read(SELF))}))
    package();print('STAGED_CODE_ONLY_NOT_INSTALLED')

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
function walk(base,rel){if(++count>50000)throw Error('TREE_BOUND');const at=p.join(base,rel),s=fs.lstatSync(at),mode=s.mode&4095,meta={uid:s.uid,gid:s.gid,mode};if(s.isSymbolicLink()){out[rel]={...meta,type:'symlink',target:fs.readlinkSync(at)};return;}if(s.isDirectory()){if(rel)out[rel]={...meta,type:'directory'};for(const n of fs.readdirSync(at).sort())walk(base,rel?p.join(rel,n):n);return;}if(!s.isFile()||s.size>67108864)throw Error('TREE_FILE_BOUND');const fd=fs.openSync(at,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const raw=fs.readFileSync(fd),t=fs.fstatSync(fd),u=fs.lstatSync(at);for(const k of ['dev','ino','mode','uid','gid','nlink','size','mtimeMs','ctimeMs'])if(s[k]!==t[k]||s[k]!==u[k])throw Error('TREE_CHANGED');out[rel]={...meta,type:'file',nlink:s.nlink,bytes:raw.length,sha256:h.createHash('sha256').update(raw).digest('hex')};}finally{fs.closeSync(fd);}}
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

def normalize_crm(row):
    value=copy.deepcopy(row['Config']);value['Image']='<own-image>';value['Env']=sorted(value.get('Env',[]))
    if value.get('Hostname')==row['Id'][:12]:value['Hostname']='<own-hostname>'
    labels=value.get('Labels',{})
    for key in ('com.docker.compose.image','com.docker.compose.config-hash','com.docker.compose.project.config_files'):
        need(key in labels,'COMPOSE_LABEL_REQUIRED');labels[key]='<own-controlled>'
    return {'config':value,'host':canonical_host(row['HostConfig']),'mounts':sorted(row['Mounts'],key=lambda v:v['Destination']),'networks':own_network(row)}

def compose_args(plan): return ['docker','compose','--project-name',plan['project'],'--project-directory',plan['directory']]+[arg for row in plan['files'] for arg in ('--file',row['path'])]

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
    need(own[CRM]['service']=='crm','CRM_SERVICE_REQUIRED');plan['ownChains']=own;return plan

def policy_state():
    value={}
    for action,expected in (('is-active','inactive'),('is-enabled','disabled')):
        result=subprocess.run(['systemctl',action,'synapse-sync.timer'],stdin=subprocess.DEVNULL,capture_output=True,timeout=20)
        need(result.stdout.decode().strip()==expected,'LEGACY_SYNC_MUST_REMAIN_DISABLED');value[action]=expected
    result=run(['systemctl','show','synapse-sync.service','--property=ExecStart','--value']).decode()
    need(re.findall(r'(?:^|[ {;])path=([^ ;}]+)',result)==['/usr/local/bin/synapse-sync'],'EXACT_LEGACY_EXECSTART')
    need(not os.path.lexists('/usr/local/sbin/synapse-sync'),'LEGACY_SBIN_ABSENT')
    for path in ('/etc/synapse/managed-release.json','/etc/systemd/system/synapse-sync.service.d/50-managed-release.conf','/usr/local/bin/synapse-sync','/opt/synapse/ops/synapse-sync','/opt/synapse/caddy/Caddyfile','/opt/synapse/docker-compose.yml'):
        raw=safe_read(path)
        if path in ('/usr/local/bin/synapse-sync','/opt/synapse/ops/synapse-sync'):need(sha(raw)==LEGACY_SHA and b'MANAGED_RELEASE_BLOCKS_LEGACY_SYNC' in raw,'EXACT_BLOCKING_LEGACY_SCRIPT')
        if path.endswith('50-managed-release.conf'):need(b'ConditionPathExists=!/etc/synapse/managed-release.json' in [line.strip() for line in raw.splitlines()],'EXACT_MANAGED_CONDITION')
        value[path]=sha(raw)
    return value

def db_path(row):
    mounts=row['Mounts'];need(len(mounts)==1 and mounts[0]['Destination']=='/data' and mounts[0]['RW'],'ONLY_EXISTING_CRM_DATA_MOUNT_NO_SOURCE_BIND')
    entries=row['Config'].get('Env',[]);names=[v.split('=',1)[0] for v in entries];need(len(names)==len(set(names)),'DUPLICATE_ENVIRONMENT_KEYS')
    env=dict(v.split('=',1) for v in entries);name=env.get('DATABASE_PATH','/data/crm.sqlite');need(re.fullmatch('/data/[A-Za-z0-9_.-]+\\.sqlite',name),'EXPECTED_CRM_DATABASE_PATH')
    path=Path(mounts[0]['Source'])/Path(name).name;need(path.resolve()==path,'CANONICAL_DATABASE_PATH');return path

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

def db_facts(connection):
    need(connection.execute('PRAGMA quick_check').fetchone()==('ok',),'DATABASE_QUICK_CHECK')
    schema=connection.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall();tables={}
    for kind,name,_,sql in schema:
        if kind!='table':continue
        need(not re.match(r'\s*CREATE\s+VIRTUAL\s+TABLE',sql or '',re.I),'VIRTUAL_DATABASE_REQUIRES_SEPARATE_REVIEW')
        columns=connection.execute('PRAGMA table_info('+quote(name)+')').fetchall();keys=[r[1] for r in sorted(columns,key=lambda r:r[5]) if r[5]]
        names=[r[1] for r in columns];values={};count=len(keys) if keys else 1
        for row in connection.execute('SELECT '+(','.join(map(quote,keys)) if keys else 'rowid')+','+','.join(map(quote,names))+' FROM '+quote(name)):
            key=sha(enc([cell(v) for v in row[:count]]));need(key not in values,'UNIQUE_DATABASE_ROW_KEYS');values[key]=sha(enc([cell(v) for v in row[count:]]))
        tables[name]={'columns':names,'rows':values}
    need(connection.total_changes==0,'DATABASE_READ_ONLY');return {'schema':schema,'tables':tables}

def assert_database(connection,before):
    current=db_facts(connection);need(enc(current)==enc(before),'DATABASE_SCHEMA_OR_ROWS_CHANGED_INSPECT_ONLY');return current

def queue_guard(connection,expires):
    names={r[0] for r in connection.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
    need({'lead_email_outbox','autoposting_posts','autoposting_deliveries'}<=names,'EXPECTED_EXISTING_QUEUE_SCHEMA')
    emails=connection.execute("SELECT count(*) FROM lead_email_outbox WHERE status<>'sent' OR status IS NULL").fetchone()[0]
    active=connection.execute("SELECT count(*) FROM autoposting_posts WHERE status='publishing'").fetchone()[0]
    deliveries=connection.execute("SELECT count(*) FROM autoposting_deliveries WHERE status='publishing'").fetchone()[0]
    margin=expires+600;due=0
    for (when,) in connection.execute("SELECT scheduled_at FROM autoposting_posts WHERE status='scheduled'"):
        try:
            from datetime import datetime
            stamp=datetime.fromisoformat(str(when).replace('Z','+00:00')).timestamp()
            if stamp<=margin:due+=1
        except (ValueError,TypeError,OverflowError):due+=1
    need(not (emails or active or deliveries or due),'DUE_OR_UNCERTAIN_QUEUE_REFUSED emails='+str(emails)+' posts='+str(active)+' deliveries='+str(deliveries)+' dueBeforeMargin='+str(due))
    need(connection.total_changes==0,'QUEUE_READ_ONLY');return {'activeEmail':0,'publishingPosts':0,'publishingDeliveries':0,'dueBeforeFixedExpiryPlus600':0}

def file_info(path):
    path=Path(path);need(path.resolve()==path and not path.is_symlink(),'CANONICAL_TARGET')
    value=path.stat();need(stat.S_ISREG(value.st_mode) and value.st_nlink==1 and value.st_uid==value.st_gid==0,'ROOT_SINGLE_FILE')
    return {'mode':stat.S_IMODE(value.st_mode),'uid':value.st_uid,'gid':value.st_gid}

def parent_info(path):
    parent=Path(path).parent;need(parent.resolve()==parent and parent.is_dir(),'CANONICAL_PARENT')
    info=parent.stat();need(info.st_uid==info.st_gid==0 and not info.st_mode&stat.S_IWOTH,'ROOT_PARENT')
    return {'mode':stat.S_IMODE(info.st_mode),'uid':info.st_uid,'gid':info.st_gid}

def assert_file(row,after,info):
    path=ROOT/row['target'];parent_info(path)
    if not after and row['beforeSha256'] is None:need(not os.path.lexists(path),'NEW_TARGET_COLLISION');return
    need(file_info(path)==info,'TARGET_METADATA_CHANGED')
    need(sha(safe_read(path))==row['afterSha256' if after else 'beforeSha256'],'TARGET_CAS_CHANGED')

def unrelated_static():
    result={}
    for path in (ROOT/'sites/synapse').rglob('*'):
        if path.suffix not in ('.html','.js','.css') or not path.is_file() or path.is_symlink():continue
        rel=path.relative_to(ROOT).as_posix()
        if rel not in STATIC:result[rel]=sha(safe_read(path))
    return result

def price_pin():
    with urllib.request.urlopen('https://palitra-love.ru/data/price.json',timeout=30) as response:raw=response.read(4*1024*1024+1)
    need(len(raw)<=4*1024*1024,'PRICE_BOUND');value=json.loads(raw)
    return {'version':value['version'],'sha256':sha(raw)}

def prepare():
    staged,manifest=package();lease=own_lease();need(not (AREA/'base.json').exists() and not (AREA/'action.json').exists(),'PREPARE_EXISTS_INSPECT_ONLY')
    rows={name:inspect_container(name) for name in CONTAINERS}
    need(all(rows[name]['Image']==manifest['expectedImages'][name] for name in CONTAINERS),'FRESH_ALL_FIVE_IMAGE_PINS')
    image=rows[CRM]['Image'];tree=runtime_tree(rows[CRM])
    need(image_tree(image)==tree,'RUNNING_IMAGE_FULL_TREE_MUST_MATCH');database=db_path(rows[CRM]);expires=time.time()+900
    with db_open(database) as connection:facts=db_facts(connection);queues=queue_guard(connection,expires)
    metadata={};parents={}
    for row in manifest['files']:
        path=ROOT/row['target'];parents[row['target']]=parent_info(path);info=file_info(path) if row['beforeSha256'] is not None else {'mode':0o644,'uid':0,'gid':0}
        assert_file(row,False,info);metadata[row['target']]=info
        if row['target'] in RUNTIME:
            item=tree.get(Path(row['target']).name);need(item and item['type']=='file' and item['nlink']==1 and item['sha256']==row['beforeSha256'],'HOST_RUNNING_IMAGE_SOURCE_PIN_MUST_MATCH')
    base={'lease':lease,'rows':rows,'crmTree':tree,'database':{'path':str(database),'identity':db_identity(database),'facts':facts},'queues':queues,'metadata':metadata,'parents':parents,
          'plan':effective_plan(rows,manifest['expectedImages']),'policy':policy_state(),'unrelatedStatic':unrelated_static(),'price':price_pin()}
    backup=AREA/'backup';backup.mkdir(mode=0o700)
    for row in manifest['files']:
        assert_file(row,False,metadata[row['target']])
        if row['beforeSha256'] is None:continue
        path=backup/row['target'];path.parent.mkdir(parents=True,mode=0o700,exist_ok=True);write_new(path,safe_read(ROOT/row['target']))
    write_new(AREA/'base.json',enc(base));write_new(AREA/'action.json',enc({**staged,'baseSha256':sha(enc(base)),'lease':lease,'created':time.time(),'expires':expires}))
    print('FRESH_BASE_READY_QUEUE_EMPTY_NO_WRITES')

def base_guard(after=False,child=None,published=(),readback=False):
    staged,manifest=package();action=load(AREA/'action.json');base=load(AREA/'base.json')
    need(sha(safe_read(AREA/'base.json'))==action['baseSha256'] and all(action[k]==v for k,v in staged.items()),'PINNED_BASE_ACTION')
    lease=own_lease();need(lease==action['lease'] or readback,'OWN_OR_NEW_READBACK_LEASE')
    if not readback:need(action['created']<=time.time()<action['expires'],'FRESH_ACTION_REQUIRED')
    need(policy_state()==base['policy'] and unrelated_static()==base['unrelatedStatic'] and price_pin()==base['price'],'POLICY_STATIC_OR_PRICE_CHANGED')
    rows={name:inspect_container(name) for name in CONTAINERS}
    for name in CONTAINERS:
        if name!=CRM:need(foreign(rows[name])==foreign(base['rows'][name]),'OTHER_CONTAINER_CHANGED')
    expected=child['image'] if after else base['rows'][CRM]['Image'];need(rows[CRM]['Image']==expected,'CRM_IMAGE_CHANGED')
    need(normalize_crm(rows[CRM])==normalize_crm(base['rows'][CRM]),'CRM_CONFIG_ENV_MOUNTS_NETWORK_CHANGED')
    tree=copy.deepcopy(base['crmTree'])
    if after:
        for row in manifest['files']:
            if row['target'] in RUNTIME:tree[Path(row['target']).name]={**tree[Path(row['target']).name],'sha256':row['afterSha256'],'bytes':row['bytes']}
    need(runtime_tree(rows[CRM])==tree and image_tree(expected)==tree,'COMPLETE_RUNTIME_IMAGE_TREE_CHANGED')
    images=dict(manifest['expectedImages']);images[CRM]=expected;plan=effective_plan(rows,images)
    want=load(AREA/'forward-plan.json') if after else base['plan'];need(plan==want,'EFFECTIVE_COMPOSE_CHANGED')
    need(db_identity(base['database']['path'])==base['database']['identity'],'DATABASE_IDENTITY_CHANGED')
    with db_open(base['database']['path']) as connection:assert_database(connection,base['database']['facts']);queue_guard(connection,max(action['expires'],time.time()) if readback else action['expires'])
    for row in manifest['files']:
        need(parent_info(ROOT/row['target'])==base['parents'][row['target']],'TARGET_PARENT_CHANGED')
        assert_file(row,row['target'] in published,base['metadata'][row['target']])
        if row['beforeSha256'] is not None:need(sha(safe_read(AREA/'backup'/row['target']))==row['beforeSha256'],'BACKUP_CHANGED')
    return staged,manifest,action,base

def protected_backup(base,guard):
    destination=AREA/'crm-backup.sqlite';guard();write_new(destination,b'')
    source=sqlite3.connect(Path(base['database']['path']).as_uri()+'?mode=ro',uri=True,timeout=5);target=sqlite3.connect(destination);started=time.monotonic()
    def progress(status,remaining,total):
        need(time.monotonic()-started<120,'BACKUP_DEADLINE')
        # Progress checks stay narrow: full image/static/DB guards before and
        # after backup; per-page probes must not spawn hundreds of containers.
        action=load(AREA/'action.json')
        need(sha(safe_read(AREA/'base.json'))==action['baseSha256'] and own_lease()==action['lease'],'BACKUP_OWN_BASE_LEASE')
        need(action['created']<=time.time()<action['expires'],'FRESH_BACKUP_ACTION_REQUIRED')
    try:
        source.execute('PRAGMA query_only=ON');need(source.execute('PRAGMA query_only').fetchone()==(1,),'READONLY_BACKUP_SOURCE')
        source.backup(target,pages=128,progress=progress);assert_database(target,base['database']['facts'])
    finally:source.close();target.close()
    os.chmod(destination,0o600);guard();return {'sha256':sha(safe_read(destination)),'path':str(destination)}

def expected_tree(base,manifest):
    tree=copy.deepcopy(base['crmTree'])
    for row in manifest['files']:
        if row['target'] in RUNTIME:tree[Path(row['target']).name]={**tree[Path(row['target']).name],'sha256':row['afterSha256'],'bytes':row['bytes']}
    return tree

def build_child(base,manifest,guard):
    guard();parent=base['rows'][CRM]['Image'];parent_info_value=image_info(parent);context=AREA/'build';context.mkdir(mode=0o700);stream=io.BytesIO()
    with tarfile.open(fileobj=stream,mode='w',format=tarfile.USTAR_FORMAT) as archive:
        for row in manifest['files']:
            if row['target'] not in RUNTIME:continue
            data=safe_read(AREA/'payload'/row['target']);info=tarfile.TarInfo(Path(row['target']).name);before=base['crmTree'][info.name]
            info.size=len(data);info.mode=before['mode'];info.uid=before['uid'];info.gid=before['gid'];info.mtime=0;archive.addfile(info,io.BytesIO(data))
    payload=stream.getvalue();write_new(context/'payload.tar',payload)
    alias=NAME+'-'+os.urandom(8).hex()+'-base:local';tag=alias.replace('-base:local',':local')
    need(not run(['docker','image','ls','--quiet',alias]).strip() and not run(['docker','image','ls','--quiet',tag]).strip(),'NEW_LOCAL_IMAGE_TAGS')
    dockerfile=('FROM '+alias+'\nADD payload.tar /app/\n').encode();write_new(context/'Dockerfile',dockerfile);need({p.name for p in context.iterdir()}=={'Dockerfile','payload.tar'},'CLOSED_BUILD_CONTEXT')
    guard();run(['docker','image','tag',parent,alias]);need(safe_read(context/'payload.tar')==payload and safe_read(context/'Dockerfile')==dockerfile,'BUILD_CONTEXT_CHANGED')
    run(['docker','build','--network=none','--pull=false','--tag',tag,'--iidfile',str(context/'image.id'),str(context)],180)
    child=safe_read(context/'image.id').decode().strip();after=image_info(child)
    need(child!=parent and after['RootFS']['Layers'][:-1]==parent_info_value['RootFS']['Layers'] and len(after['RootFS']['Layers'])==len(parent_info_value['RootFS']['Layers'])+1 and after['Config']==parent_info_value['Config'],'ONE_INHERITED_CRM_LAYER')
    need(image_tree(child)==expected_tree(base,manifest),'EXACT_CHILD_FULL_TREE')
    return {'image':child,'parent':parent}

def make_plan(base,child):
    path=AREA/'crm-image-only.json';write_new(path,enc({'services':{'crm':{'image':child['image']}}}))
    plan=copy.deepcopy(base['plan']);plan['files'].append({'path':str(path),'sha256':sha(safe_read(path))});observed=json.loads(run(compose_args(plan)+['config','--format','json']))
    want=copy.deepcopy(base['plan']['resolved']);want['services']['crm']['image']=child['image'];need(observed==want,'ONLY_CRM_IMAGE_DELTA')
    plan['resolved']=observed
    for name,own in plan['ownChains'].items():
        pin=service_hash(plan,own['service'])
        if name==CRM:own.update(files=copy.deepcopy(plan['files']),configHash=pin)
        else:need(pin==own['configHash'],'ONLY_CRM_SERVICE_HASH_DELTA')
    write_new(AREA/'forward-plan.json',enc(plan));return plan

def publish_one(row,base):
    path=ROOT/row['target'];info=base['metadata'][row['target']];assert_file(row,False,info)
    temp=path.with_name('.'+path.name+'.'+NAME+'.tmp');write_new(temp,safe_read(AREA/'payload'/row['target']),info['mode']);os.chmod(temp,info['mode']);os.chown(temp,info['uid'],info['gid'])
    assert_file(row,False,info)
    if row['beforeSha256'] is None:os.link(temp,path);temp.unlink()
    else:os.replace(temp,path)
    sync_dir(path.parent);assert_file(row,True,info)

def publish_order(manifest):
    rows={row['target']:row for row in manifest['files']}
    return [rows[name] for name in NEW+RUNTIME+tuple(name for name in STATIC if name not in NEW and not name.endswith('/cabinet.html'))+(PREFIX+'cabinet.html',)]

def apply():
    need(not (AREA/'apply-attempt.json').exists(),'ONE_APPLY_ATTEMPT_INSPECT_ONLY');staged,manifest,action,base=base_guard()
    write_new(AREA/'apply-attempt.json',enc({'at':time.time(),'lease':action['lease']}));published=[];child=None
    def guard():return base_guard(after=child is not None and (AREA/'crm-up-returned.json').exists(),child=child,published=published)
    backup=protected_backup(base,guard);child=build_child(base,manifest,guard);write_new(AREA/'child.json',enc(child));plan=make_plan(base,child)
    guard();need(json.loads(run(compose_args(plan)+['config','--format','json']))==plan['resolved'],'LATE_COMPOSE_CAS')
    write_new(AREA/'crm-up-attempt.json',enc({'at':time.time(),'image':child['image']}))
    run(compose_args(plan)+['up','--detach','--no-build','--pull','never','--no-deps','crm'],180)
    # Unknown command outcome is never repeated automatically.
    deadline=time.monotonic()+45
    while True:
        need(time.time()<action['expires'],'FRESH_ACTION_REQUIRED')
        try:
            row=inspect_container(CRM)
            if row['Image']==child['image']:break
        except ValueError:pass
        need(time.monotonic()<deadline,'CRM_HEALTH_TIMEOUT_INSPECT_ONLY');time.sleep(1)
    write_new(AREA/'crm-up-returned.json',enc({'at':time.time(),'image':child['image']}));guard()
    for row in publish_order(manifest):
        guard();publish_one(row,base);published.append(row['target']);write_new(AREA/('published-'+str(len(published))+'.json'),enc({'target':row['target'],'sha256':row['afterSha256']}))
    guard();result={'status':'INSTALLED_REQUIRES_INDEPENDENT_INSPECT','child':child,'backup':backup,'runtimeSources':2,'staticFiles':9,'newStaticFiles':4,'crmRestarts':1,'otherServiceRestarts':0,'directDatabaseWrites':0,'schemaWrites':0,'dataRestored':False,'automaticRollback':False}
    write_new(AREA/'installed.json',enc(result));print(json.dumps(result))

def inspect_result():
    result=load(AREA/'installed.json');base_guard(after=True,child=result['child'],published=SCOPE,readback=True)
    output={**result,'status':'INDEPENDENT_FULL_READBACK_PASS','at':time.time(),'physicalPhoneAccepted':False,'externalPublicationSent':False}
    write_new(AREA/('inspect-'+str(time.time_ns())+'.json'),enc(output));print(json.dumps(output))

if __name__=='__main__':
    try:
        need(os.name=='posix' and os.geteuid()==0,'NATIVE_LINUX_ROOT_ONLY');os.umask(0o077)
        mode=sys.argv[1]
        if mode=='stage':stage(sys.argv[2],sys.argv[3])
        elif mode=='prepare':prepare()
        elif mode=='apply':apply()
        elif mode=='inspect':inspect_result()
        else:raise ValueError('KNOWN_MODE_REQUIRED')
    except Exception as error:
        print('REFUSED: '+type(error).__name__+': '+str(error),file=sys.stderr);sys.exit(2)
