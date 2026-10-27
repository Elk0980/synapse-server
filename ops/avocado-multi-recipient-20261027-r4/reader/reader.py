"""New bounded ROOT read bodies. No filesystem or SQLite writer exists here."""
import hashlib,json,os,stat,sqlite3
from pathlib import Path
from contextlib import contextmanager
def need(ok,code):
    if not ok:raise ValueError(code)
def encoded(v):return json.dumps(v,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()
def sha(v):return hashlib.sha256(v).hexdigest()
def parse(raw):
    def pairs(items):
        out={}
        for k,v in items:need(k not in out,'DUPLICATE_JSON_KEY');out[k]=v
        return out
    return json.loads(raw,object_pairs_hook=pairs)
def exact(path):
    p=Path(path);need(p.is_absolute() and '..' not in p.parts,'ABSOLUTE_CANONICAL_PATH')
    for part in [p,*p.parents]:need(not part.is_symlink() and not getattr(part.lstat(),'st_file_attributes',0)&1024,'FILESYSTEM_ALIAS')
    need(p.exists(),'READ_PATH_ABSENT');return p
def identity(s):return (s.st_dev,s.st_ino,s.st_size,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_mtime_ns,s.st_ctime_ns) if os.name=='posix' else (s.st_dev,s.st_ino,s.st_size,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_mtime_ns)
def read_file(path,native=True,limit=64*1024*1024):
    p=exact(path);s=p.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_size<=limit,'BOUNDED_SINGLE_LINK_READ')
    if native:need(s.st_uid==s.st_gid==0,'ROOT_READ_REQUIRED')
    fd=os.open(p,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0)|getattr(os,'O_BINARY',0))
    try:
        raw=b''
        while len(raw)<=limit:
            chunk=os.read(fd,min(65536,limit+1-len(raw)))
            if not chunk:break
            raw+=chunk
        need(len(raw)==s.st_size and identity(s)==identity(os.fstat(fd))==identity(p.lstat()),'READ_CHANGED');return raw
    finally:os.close(fd)
def static_facts(path,native=True):
    p=exact(path);s=p.stat();raw=read_file(p,native);need(identity(s)==identity(p.lstat()),'STATIC_CHANGED_DURING_FACTS')
    return {'sha256':sha(raw),'uid':s.st_uid,'gid':s.st_gid,'mode':stat.S_IMODE(s.st_mode),'nlink':s.st_nlink,'parentReal':str(p.parent.resolve())}
@contextmanager
def readonly_db(path,native=True):
    p=exact(path);s=p.stat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1,'EXISTING_DATABASE_REQUIRED')
    if native:need(s.st_uid==s.st_gid==0,'ROOT_DATABASE_REQUIRED')
    db=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True,isolation_level=None,timeout=5);db.row_factory=sqlite3.Row
    try:
        db.execute('PRAGMA query_only=ON');db.execute('BEGIN');need(db.execute('PRAGMA query_only').fetchone()[0]==1,'QUERY_ONLY_REQUIRED');yield db
        need(db.total_changes==0 and (p.stat().st_dev,p.stat().st_ino)==(s.st_dev,s.st_ino),'DATABASE_CHANGED_OR_WRITTEN');db.execute('ROLLBACK')
    finally:db.close()
def relative(name):return type(name) is str and 0<len(name)<=1024 and not any(ord(c)<32 for c in name) and not name.startswith('/') and '\\' not in name and ':' not in name and all(x not in ('','.','..') for x in name.split('/'))
def managed(db,data_root,site_id,native=True,minimum_version=261):
    # Actual current pointers, never historical260 or a substituted old receipt.
    rows=db.execute('SELECT m.id,m.company_code,m.publication_status,w.current_revision FROM managed_sites m JOIN site_workspaces w ON w.site_id=m.id WHERE m.id=?',(site_id,)).fetchall();need(len(rows)==1,'ONE_CURRENT_MANAGED_SITE_REQUIRED');pointer=dict(rows[0]);revision=pointer['current_revision']
    need(pointer['company_code']=='palitra-love' and type(revision) is str and len(revision)==64 and all(c in '0123456789abcdef' for c in revision),'CURRENT_MANAGED_IDENTITY')
    r=db.execute('SELECT version,manifest_json FROM site_workspace_revisions WHERE site_id=? AND revision=?',(site_id,revision)).fetchone();need(r and type(r['version']) is int and r['version']>=minimum_version and len(r['manifest_json'].encode())<=1024*1024,'CURRENT_MANAGED_VERSION');manifest=parse(r['manifest_json']);need(type(manifest) is dict and 1<=len(manifest)<=4096 and all(relative(n) for n in manifest),'CURRENT_MANAGED_MANIFEST')
    folder=exact(Path(data_root)/'projects/palitra-love/sites'/site_id/'versions'/revision);actual={};dirs={};total=0
    count=0
    for p in __import__('itertools').chain([folder],folder.rglob('*')):
        count+=1;need(count<=8192,'MANAGED_ENTRY_BOUND')
        exact(p);s=p.stat();name=p.relative_to(folder).as_posix();need(not p.is_symlink(),'MANAGED_ALIAS')
        if p.is_dir():dirs[name]={'uid':s.st_uid,'gid':s.st_gid,'mode':stat.S_IMODE(s.st_mode)};continue
        need(relative(name),'MANAGED_RELATIVE_FILE');raw=read_file(p,native,32*1024*1024);need(identity(s)==identity(p.lstat()),'MANAGED_CHANGED_DURING_FACTS');total+=len(raw);need(total<=512*1024*1024,'MANAGED_TOTAL_BOUND');actual[name]={'sha256':sha(raw),'bytes':len(raw),'uid':s.st_uid,'gid':s.st_gid,'mode':stat.S_IMODE(s.st_mode),'nlink':s.st_nlink}
    need(set(actual)==set(manifest),'CURRENT_MANAGED_FILE_CLOSURE')
    for name,wanted in manifest.items():need(type(wanted) is dict and wanted.get('sha256')==actual[name]['sha256'] and wanted.get('bytes')==actual[name]['bytes'],'CURRENT_MANAGED_FILE_BYTES')
    return {'pointer':pointer,'version':r['version'],'manifestSha256':sha(r['manifest_json'].encode()),'files':actual,'directories':dirs}
from pathlib import PurePosixPath
import re
def digest(v):return type(v) is str and re.fullmatch('[a-f0-9]{64}',v) is not None
def image(v):return type(v) is str and re.fullmatch('sha256:[a-f0-9]{64}',v) is not None
TREE_JS="'use strict';const f=require('node:fs'),c=require('node:crypto');const ROOT='/app';\nif(f.realpathSync(ROOT)!==ROOT)throw Error('APP_ROOT_ALIAS');let count=0,total=0;const out={};\nconst safe=n=>Number.isSafeInteger(n)&&n>=0,hash=x=>c.createHash('sha256').update(x).digest('hex');\nfunction walk(p,rel){if(++count>50000||rel.length>2048)throw Error('TREE_BOUND');const s=f.lstatSync(p);\n if(![s.uid,s.gid,s.mode&511,s.nlink,s.size].every(safe))throw Error('STAT_TYPES');\n const row={uid:s.uid,gid:s.gid,mode:s.mode&4095};\n if(s.isSymbolicLink()){if(s.nlink!==1)throw Error('LINK_COUNT');const link=f.readlinkSync(p);if(link.length>4096)throw Error('LINK_BOUND');out[rel]={...row,type:'symlink',nlink:1,linkSha256:hash(link)};return;}\n if(s.isDirectory()){out[rel]={...row,type:'directory'};const names=f.readdirSync(p).sort();for(const n of names){if(n==='.'||n==='..'||n.includes('/')||n.includes('\\\\'))throw Error('ENTRY_NAME');walk(p+'/'+n,rel?rel+'/'+n:n);}return;}\n if(!s.isFile()||s.nlink!==1||s.size>67108864||(total+=s.size)>1073741824)throw Error('REGULAR_BOUNDED_FILE');\n let fd;try{fd=f.openSync(p,f.constants.O_RDONLY|f.constants.O_NOFOLLOW|f.constants.O_NONBLOCK);const a=f.fstatSync(fd);\n  if(!a.isFile()||a.dev!==s.dev||a.ino!==s.ino||a.size!==s.size||a.nlink!==1)throw Error('OPEN_RACE');\n  const h=c.createHash('sha256'),buf=Buffer.alloc(65536);let bytes=0,n;while((n=f.readSync(fd,buf,0,buf.length,null))>0){bytes+=n;if(bytes>s.size)throw Error('READ_BOUND');h.update(buf.subarray(0,n));}\n  const z=f.fstatSync(fd),q=f.lstatSync(p);for(const k of ['dev','ino','size','mtimeMs','ctimeMs','uid','gid','mode','nlink'])if(s[k]!==z[k]||s[k]!==q[k])throw Error('FILE_CHANGED');\n  if(bytes!==s.size)throw Error('READ_SIZE');out[rel]={...row,type:'file',nlink:1,bytes,sha256:h.digest('hex')};\n }finally{if(fd!==undefined)f.closeSync(fd);}}\nwalk(ROOT,'');process.stdout.write(JSON.stringify(out));"
class NativeReads:
    def _image(self, target):
            need(image(target), 'EXACT_IMAGE_ID_REQUIRED')
            rows = self.a.decode(self.run(['docker', 'image', 'inspect', target]))
            need(type(rows) is list and len(rows) == 1 and (rows[0].get('Id') == target) and (type(rows[0].get('Config')) is dict), 'EXACT_IMAGE_FACTS_REQUIRED')
            return rows[0]
    def _tree(self, target=None):
            args = ['docker', 'exec', 'synapse-content-1', 'node', '-e', TREE_JS] if target is None else ['docker', 'run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--entrypoint=node', target, '-e', TREE_JS]
            value = self.a.decode(self.run(args))
            need(type(value) is dict and '' in value and (len(value) <= 50000), 'BOUNDED_FULL_APP_TREE_REQUIRED')
            for name, row in value.items():
                need(type(name) is str and type(row) is dict and (row.get('type') in ('file', 'directory', 'symlink')) and (name == '' or (not PurePosixPath(name).is_absolute() and PurePosixPath(name).as_posix() == name and ('..' not in PurePosixPath(name).parts))) and all((type(row.get(k)) is int and row[k] >= 0 for k in ('uid', 'gid', 'mode'))) and (row['mode'] <= 4095), 'EXACT_APP_TREE_FACTS_REQUIRED')
                keys = {'uid', 'gid', 'mode', 'type'} | ({'nlink', 'bytes', 'sha256'} if row['type'] == 'file' else {'nlink', 'linkSha256'} if row['type'] == 'symlink' else set())
                need(set(row) == keys, 'CLOSED_APP_TREE_ROW_REQUIRED')
                if row['type'] != 'directory':
                    need(type(row['nlink']) is int and row['nlink'] == 1, 'SINGLE_LINK_APP_ENTRY_REQUIRED')
                if row['type'] == 'file':
                    need(type(row['bytes']) is int and 0 <= row['bytes'] <= 67108864 and digest(row['sha256']), 'BOUNDED_APP_FILE_HASH_REQUIRED')
                if row['type'] == 'symlink':
                    need(digest(row['linkSha256']), 'EXACT_APP_LINK_HASH_REQUIRED')
            return value
"""Current Root reader, no historical Factory constructor, no writes or subprocess.

All external commands pass through the caller's separately reviewed whitelist.
Pinned NativeReads._image/_tree and TREE_JS are extracted from verified sources.
"""
import copy,json,os,re,stat,time,types
from pathlib import Path
from datetime import datetime,timezone
API='palitra-tg-root-readonly/v1';READ_ONLY=True
FLAG='PALITRA_TELEGRAM_MINIAPP_ENABLED';CONTENT='synapse-content-1';WORKER='synapse-chat-1'
MANIFEST_TYPES={'application/vnd.oci.image.manifest.v1+json','application/vnd.docker.distribution.manifest.v2+json'}
INDEX_TYPES={'application/vnd.oci.image.index.v1+json','application/vnd.docker.distribution.manifest.list.v2+json'}
def env_map(values):
    need(type(values) is list and all(type(v) is str and '=' in v for v in values),'ENV_FORMAT');pairs=[v.split('=',1) for v in values];need(len({k for k,v in pairs})==len(pairs),'DUPLICATE_ENV');return dict(pairs)
def epoch(text):
    need(type(text) is str,'TIME_REQUIRED');return datetime.fromisoformat(text.replace('Z','+00:00')).timestamp()
def canonical_host(value):
    value=copy.deepcopy(value);need(type(value) is dict,'CANONICAL_HOST_CONFIG')
    if value.get('Binds') is not None:
        need(type(value['Binds']) is list and len(value['Binds'])==len(set(value['Binds'])),'CANONICAL_HOST_BINDS');value['Binds']=sorted(value['Binds'])
    return value
def foreign(row):
    state={k:row['State'].get(k) for k in ('Running','Paused','Restarting','OOMKilled','Dead','ExitCode','Error','StartedAt','FinishedAt')};state['HealthStatus']=row['State'].get('Health',{}).get('Status')
    return {'id':row['Id'],'image':row['Image'],'configSha256':sha(encoded(row['Config'])),'hostConfigSha256':sha(encoded(canonical_host(row['HostConfig']))),'mountsSha256':sha(encoded(sorted(row['Mounts'],key=lambda x:x['Destination']))),'networksSha256':sha(encoded(row['NetworkSettings'])),'state':state,'restarts':row['RestartCount']}
def content_network(row):
    settings=copy.deepcopy(row['NetworkSettings']);networks=settings['Networks'];cid=row['Id']
    for name in ('SandboxID','SandboxKey'):
        if name in settings:settings[name]='<own-content-recreated>'
    for facts in networks.values():
        for name in ('EndpointID','MacAddress'):facts[name]='<own-content-recreated>'
        requested=facts.get('IPAMConfig') or {}
        for name,key in [('IPAddress','IPv4Address'),('GlobalIPv6Address','IPv6Address')]:
            if not requested.get(key):facts[name]='<docker-assigned>'
        for name in ('Aliases','DNSNames'):
            if isinstance(facts.get(name),list):facts[name]=sorted('<own-cid>' if x in (cid,cid[:12]) else x for x in facts[name])
    return settings

class Reader:
    def __init__(self,run,spec,directory,native=True,clock=time.time):
        need(callable(run),'READ_TRANSPORT_REQUIRED');self.run=run;self.spec=spec;self.directory=Path(directory);self.native=native;self.clock=clock;self.candidate_tree=None
        if native:need(os.name=='posix' and os.geteuid()==0 and spec['dataRoot']=='/var/lib/docker/volumes/synapse_content_data/_data','ROOT_CURRENT_DATA_BINDING')
        self.n=object.__new__(NativeReads);self.n.run=run;self.n.a=types.SimpleNamespace(decode=parse)
    def inspect(self,name):
        rows=parse(self.run(['docker','inspect',name]));need(type(rows) is list and len(rows)==1 and rows[0]['Name'].lstrip('/')==name,'EXACT_CURRENT_CONTAINER');return rows[0]
    def script(self,container,name):return parse(self.run(['docker','exec',container,'node','-e',read_file(self.directory/name,self.native).decode()]))
    def node_profile(self,env,worker=False):
        options=env.get('NODE_OPTIONS','');need((not options and not worker) or sha(options.encode())==self.spec['workerNodeOptionsSha256'],'NODE_OPTIONS_PROFILE_CHANGED');need(all(not env.get(k) for k in self.spec['workerHookNames'] if k!='NODE_OPTIONS'),'NODE_STARTUP_HOOK_REFUSED')
    def platform(self,target,full):
        need(full.get('Os')=='linux' and full.get('Architecture')=='amd64' and full.get('Variant','')=='','LINUX_AMD64_IMAGE');descriptor=full.get('Descriptor',{});need(descriptor.get('digest')==target and descriptor.get('mediaType') in MANIFEST_TYPES|INDEX_TYPES,'FULL_IMAGE_DESCRIPTOR')
        selected=parse(self.run(['docker','image','inspect','--platform','linux/amd64',target]));need(type(selected) is list and len(selected)==1,'ONE_SELECTED_PLATFORM');selected=selected[0];d=selected.get('Descriptor',{})
        need(selected.get('Id')==d.get('digest') and re.fullmatch('sha256:[a-f0-9]{64}',selected['Id']) and d.get('mediaType') in MANIFEST_TYPES and selected.get('Os')=='linux' and selected.get('Architecture')=='amd64' and selected.get('Config')==full['Config'] and selected.get('RootFS')==full['RootFS'],'SELECTED_PLATFORM_BINDING');return d
    def image(self,image_id):
        full=self.n._image(image_id);self.platform(image_id,full);self.node_profile(env_map(full['Config'].get('Env',[])));tree=self.n._tree(image_id);need(full['RootFS'].get('Type')=='layers' and all(re.fullmatch('sha256:[a-f0-9]{64}',x) for x in full['RootFS']['Layers']),'IMAGE_LAYER_TYPES')
        if image_id!=self.spec['parentImage']:self.candidate_tree=tree
        return {'id':full['Id'],'layers':full['RootFS']['Layers'],'config':full['Config'],'appTree':tree}
    def context(self):
        names=self.run(['docker','ps','--all','--no-trunc','--format','{{.Names}}']).decode().splitlines();need(CONTENT in names and WORKER in names and len(names)==len(set(names)),'COMPLETE_CONTAINER_NAMES');rows={name:self.inspect(name) for name in names};row=rows[CONTENT];need(row['State']['Running'] is True and not row['State'].get('Paused') and not row['State'].get('Dead'),'CONTENT_RUNNING');env=env_map(row['Config']['Env'])
        self.node_profile(env);self.node_profile(env_map(rows[WORKER]['Config']['Env']),worker=True)
        mounts=row['Mounts'];destinations=[m['Destination'] for m in mounts];need(len(destinations)==len(set(destinations)),'MOUNT_DESTINATION_UNIQUE');data=[m for m in mounts if m['Destination']=='/data'];need(len(data)==1 and data[0]['Type']=='volume' and data[0]['Name']=='synapse_content_data' and data[0]['Source']==self.spec['dataRoot'] and data[0]['RW'] is True,'EXACT_CURRENT_DATA_VOLUME');need(env.get('DATABASE_PATH','/data/content.sqlite')=='/data/content.sqlite','DATABASE_ENV_BINDING')
        for target in destinations:need(target.startswith('/') and target!='/' and '..' not in target.split('/') and not any(target==p or target.startswith(p+'/') or p.startswith(target.rstrip('/')+'/') for p in ('/app','/usr/local/bin','/usr/bin')),'NO_APP_RUNTIME_MOUNT_OVERLAP')
        database=exact(Path(data[0]['Source'])/'content.sqlite');s=database.stat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1,'REGULAR_CURRENT_DATABASE');return rows,row,env,{'path':str(database),'volumeRoot':str(exact(data[0]['Source'])),'identity':[s.st_dev,s.st_ino]}
    def compose(self,row):
        labels=row['Config']['Labels'];project=labels['com.docker.compose.project'];directory=labels['com.docker.compose.project.working_dir'];names=labels['com.docker.compose.project.config_files'].split(',');need(project=='synapse' and names and len(names)==len(set(names)),'CURRENT_COMPOSE_CHAIN');files=[{'path':name,'sha256':sha(read_file(name,self.native))} for name in names]
        prefix=['docker','compose','--project-name',project,'--project-directory',directory]+[v for name in names for v in ('--file',name)];resolved=parse(self.run(prefix+['config','--format','json']));config_hash=self.run(prefix+['config','--hash','content']).decode().strip();need(config_hash=='content '+labels['com.docker.compose.config-hash'],'ACTUAL_COMPOSE_HASH_LABEL');need(resolved['services']['content']['image']==row['Image']==row['Config']['Image'],'ACTUAL_EFFECTIVE_IMAGE');return {'project':project,'directory':directory,'files':files,'resolved':resolved}
    def data(self,path):
        with readonly_db(path,self.native) as db:
            current=managed(db,self.spec['dataRoot'],self.spec['siteId'],self.native,self.spec['minimumManagedVersion']);price=db.execute("SELECT version FROM documents WHERE key='palitra/price' ORDER BY version DESC LIMIT 1").fetchone();need(price and price['version']>=self.spec['minimumPriceVersion'],'ACTUAL_LATEST_PRICE_REQUIRED')
            bridges=[dict(r) for r in db.execute('SELECT bot_key,ok,username,telegram_bot_id,checked_at FROM client_bot_bridge_state ORDER BY bot_key')]
            staff=[dict(r) for r in db.execute("SELECT l.telegram_user_id,u.id,u.session_version,COALESCE(v.version,1) link_version FROM project_chat_telegram_links l JOIN auth_users u ON u.id=l.user_id LEFT JOIN project_chat_telegram_link_versions v ON v.user_id=u.id WHERE u.role='owner' OR (u.role='editor' AND EXISTS(SELECT 1 FROM auth_user_companies c WHERE c.user_id=u.id AND c.company_code='palitra-love') AND EXISTS(SELECT 1 FROM auth_user_permissions p WHERE p.user_id=u.id AND p.permission='crm.view')) ORDER BY l.telegram_user_id")]
            schema=[tuple(r) for r in db.execute('PRAGMA table_info(palitra_miniapp_sessions)')];fk=[tuple(r) for r in db.execute('PRAGMA foreign_key_list(palitra_miniapp_sessions)')];sql=db.execute("SELECT sql FROM sqlite_schema WHERE name='palitra_miniapp_sessions' AND type='table'").fetchone()
        return {'managed':current,'bridges':bridges,'staff':staff,'schema':schema,'fk':fk,'sql':sql[0] if sql else None}
    def worker(self,row):
        need(row['State']['Running'] is True and row['RestartCount']==0,'EXISTING_UNRESTARTED_WORKER');env=env_map(row['Config']['Env']);need(sha(env.get('NODE_OPTIONS','').encode())==self.spec['workerNodeOptionsSha256'] and all(not env.get(k) for k in self.spec['workerHookNames'] if k!='NODE_OPTIONS'),'WORKER_EXISTING_NODE_PROFILE');need(row['Config']['Cmd']==['node','server.js'] and row['Config']['Entrypoint'] in (['docker-entrypoint.sh'],['/usr/local/bin/docker-entrypoint.sh']) and row['Config']['WorkingDir']=='/app' and row['Config']['User'] in ('','root','0'),'WORKER_STARTUP')
        for mount in row['Mounts']:
            target=mount['Destination'];need(target.startswith('/') and target!='/' and '..' not in target.split('/') and not any(target==p or target.startswith(p+'/') or p.startswith(target.rstrip('/')+'/') for p in ('/app','/usr/local/bin','/usr/bin')),'NO_WORKER_APP_MOUNT_OVERLAP')
        graph=self.script(WORKER,'worker-graph.js');need(graph.get('schema')==1 and set(graph.get('files',{}))==set(self.spec['workerGraphExpected']),'ACTUAL_WORKER_GRAPH')
        for name,w in self.spec['workerGraphExpected'].items():
            r=graph['files'][name];need(r.get('available') is True and r.get('size')==w[0] and r.get('sha256')==w[1],'ACTUAL_WORKER_GRAPH_FILE')
        return {'docker':foreign(row),'graphSha256':sha(encoded(graph))}
    def snapshot(self):
        rows,row,env,database=self.context();compose=self.compose(row);tree=self.n._tree();current_image=self.n._image(row['Image']);binding=self.platform(row['Image'],current_image);descriptor=row.get('ImageManifestDescriptor',{});need(descriptor.get('digest')==binding['digest'] and descriptor.get('mediaType')==binding['mediaType'] and descriptor.get('platform',{'os':'linux','architecture':'amd64'}) in ({'os':'linux','architecture':'amd64'},{'os':'linux','architecture':'amd64','variant':''}),'RUNNING_PLATFORM_MANIFEST');need(current_image['Config']==self.n._image(self.spec['parentImage'])['Config'],'IMAGE_CONFIG_UNCHANGED');need(row['Config']['Labels'].get('com.docker.compose.image')==binding['digest'],'RUNNING_COMPOSE_IMAGE_LABEL')
        source={name:tree[name]['sha256'] for name in self.spec['sourceTargets'] if name in tree};need(len(source) in (244,264),'CURRENT_TRACKED_SOURCE_COUNT');static={name:static_facts(name,self.native) for name in self.spec['staticTargets']};need(len(static)==49,'ALL49_STATIC_READ')
        expected=env_map(current_image['Config'].get('Env',[]));effective=compose['resolved']['services']['content'].get('environment',{});need(all(type(v) is str for v in effective.values()),'RESOLVED_ENV_TYPES');expected.update({k:v.replace('$$','$') for k,v in effective.items()});need(env==expected,'ACTUAL_EFFECTIVE_ENVIRONMENT')
        data=self.data(database['path']);config=self.script(CONTENT,'config-readiness.js');worker=self.worker(rows[WORKER]);selected={name:self.script(name,'selected-env.js') for name in (CONTENT,WORKER)}
        for values in selected.values():
            need(set(values)==set(self.spec['selectedEnvNames']),'SELECTED_ENV_CLOSURE')
            for k in self.spec['selectedFlags']:need(values[k] in (None,'true','false'),'SELECTED_FLAGS')
            for k in self.spec['selectedOrigins']:need(values[k] in (None,'','https://palitra-love.ru','https://palitra-love-draft-1.synapsebusiness.ru','https://synapse.synapsebusiness.ru'),'SELECTED_ORIGINS')
        controlled=copy.deepcopy(row['Config']);controlled['Image']='<own-image>';controlled['Env']=sorted(k+'='+v for k,v in env.items() if k!=FLAG)
        if controlled.get('Hostname')==row['Id'][:12]:controlled['Hostname']='<own-cid>'
        for key in ('com.docker.compose.image','com.docker.compose.config-hash','com.docker.compose.project.config_files'):need(key in controlled['Labels'],'CONTENT_LABEL_REQUIRED');controlled['Labels'][key]='<controlled>'
        def hashes(names):
            need(all(n in tree and tree[n]['type']=='file' for n in names),'REQUIRED_CURRENT_CODE');return {n:tree[n]['sha256'] for n in names}
        identities=[{k:r[k] for k in ('bot_key','username','telegram_bot_id')} for r in data['bridges']]
        invariants={'foreignContainers':{n:foreign(r) for n,r in rows.items() if n!=CONTENT},'runtimeMounts':sorted(row['Mounts'],key=lambda x:x['Destination']),'networks':content_network(row),'workerConfig':{'worker':worker,'botIdentities':identities,'configuredBots':config['bots']},'selection':selected,'managedSite':data['managed'],'otherEnvironment':{'containerConfigSha256':sha(encoded(controlled)),'hostConfigSha256':sha(encoded(canonical_host(row['HostConfig']))),'imageConfigSha256':sha(encoded(current_image['Config']))},'authCode':{'files':hashes(self.spec['authCodePaths']),'refKeySha256':config['refKeySha256'],'secretFile':config['secretFile']},'pushCode':hashes(self.spec['unchangedPushCodePaths'])}
        # Repeat live identity/runtime boundaries; no cached or expected maps returned.
        need(self.inspect(CONTENT)['Id']==row['Id'] and self.inspect(WORKER)['Id']==rows[WORKER]['Id'],'CONTAINER_CHANGED_DURING_READ');return {'schema':'palitra-tg-native-base/v1','image':row['Image'],'source':source,'appTree':tree,'static':static,'env':env,'compose':compose,'invariants':invariants,'database':database}
    def readiness(self):
        rows,row,env,database=self.context();data=self.data(database['path']);config=self.script(CONTENT,'config-readiness.js');bots=config['bots'];unique=len(bots)==1 and bots[0]['site']=='palitra' and bots[0]['companyCode']=='palitra-love' and bool(re.fullmatch('[A-Za-z0-9_]{5,32}',bots[0]['username']));bridge=next((r for r in data['bridges'] if unique and r['bot_key']==bots[0]['key']),None);healthy=bool(bridge and bridge['ok']==1 and bridge['username'].lower()==bots[0]['username'].lower() and re.fullmatch('[1-9][0-9]{0,19}',bridge['telegram_bot_id']) and epoch(rows[WORKER]['State']['StartedAt'])<=epoch(bridge['checked_at'])<=self.clock() and self.clock()-epoch(bridge['checked_at'])<=300)
        tree=self.n._tree();candidate=self.candidate_tree or tree;cols=data['schema'];names=['token_hash','company_code','bot_key','bot_id','created_at','expires_at'];schema=len(cols)==6 and all(c[1]==names[i] and c[2]==('TEXT' if i<4 else 'INTEGER') and c[3]==(0 if i==0 else 1) and c[5]==(1 if i==0 else 0) for i,c in enumerate(cols));fk=data['fk'];schema=schema and len(fk)==1 and fk[0][2:5]==('palitra_crm_sessions','token_hash','token_hash') and fk[0][6]=='CASCADE' and bool(data['sql'] and re.search(r"CHECK\s*\(\s*company_code\s*=\s*'palitra-love'\s*\)",data['sql']))
        normalize=lambda value:' '.join(value.split()).replace(' IF NOT EXISTS','').rstrip(';');schema=schema and normalize(data['sql'])==normalize(self.spec['miniappSchemaSql'])
        return {'uniqueExistingBot':unique,'healthyExistingBridge':healthy,'signedVerifier':tree.get(self.spec['verifierPath'],{}).get('sha256')==self.spec['verifierSha256'],'currentStaffBinding':bool(data['staff']) and all(type(r['id']) is int and 0<r['id']<=9007199254740991 and type(r['session_version']) is int and 0<r['session_version']<=9007199254740991 and type(r['link_version']) is int and 0<r['link_version']<=9007199254740991 and re.fullmatch('[1-9][0-9]{0,15}',r['telegram_user_id']) is not None for r in data['staff']),'sameOrigin':'https://palitra-love.ru' in config['orderOrigins'] and env.get('PALITRA_MAIN_ORIGIN','https://palitra-love.ru')=='https://palitra-love.ru','csp':all(candidate.get(n,{}).get('sha256')==pin for n,pin in self.spec['cspCodePins'].items()),'refKey':config['refKeyValid'] is True,'miniappSchema':bool(schema)}

def create(read_command):
    directory=Path(__file__).resolve().parent;spec=parse(read_file(directory/'spec.json',True));return Reader(read_command,spec,directory,native=True)
