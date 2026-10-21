"""Root one-attempt content/CRM update. No messages, provider calls, grants or DB restore."""
import copy,hashlib,io,json,os,re,sqlite3,stat,subprocess,sys,tarfile,time,urllib.request,zipfile
from pathlib import Path
sys.dont_write_bytecode=True
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
AREA=ROOT/'palitra-content-day-install-r3'
PRE=ROOT/'palitra-content-day-native-20261021-r2'
SELF=Path(__file__)
CONTENT='synapse-content-1';CRM='synapse-crm-1'
TABLES={'media_mentor_publication_copy_links','media_mentor_publication_copy_decisions','autoposting_publication_payloads'}

def need(ok,code):
 if not ok:raise ValueError(code)
def sha(b):return hashlib.sha256(b).hexdigest()
def enc(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def read(p):
 p=Path(p)
 for q in (p,*p.parents):need(not q.is_symlink(),'PATH_ALIAS')
 s=p.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==0 and s.st_gid==0 and s.st_size<=64*1024*1024,'ROOT_FILE_BOUNDARY')
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  with os.fdopen(fd,'rb',closefd=False) as f:b=f.read(64*1024*1024+1)
  keys=('st_dev','st_ino','st_size','st_mode','st_uid','st_gid','st_nlink','st_mtime_ns','st_ctime_ns')
  need(len(b)==s.st_size and all(getattr(s,k)==getattr(os.fstat(fd),k)==getattr(p.lstat(),k) for k in keys),'STABLE_READ_REQUIRED');return b
 finally:os.close(fd)
def write(p,b,mode=0o600):
 p=Path(p)
 for q in (p,*p.parents):need(not q.is_symlink(),'WRITE_ALIAS')
 fd=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,mode)
 try:
  os.fchmod(fd,mode)
  with os.fdopen(fd,'wb',closefd=False) as f:f.write(b);f.flush();os.fsync(f.fileno())
 finally:os.close(fd)
def load(p):return json.loads(read(p))
def run(args,timeout=90):
 need(type(args) is list and all(type(v) is str for v in args),'NO_SHELL');r=subprocess.run(args,stdin=subprocess.DEVNULL,capture_output=True,timeout=timeout);need(r.returncode==0,'NATIVE_COMMAND_FAILED');need(len(r.stdout)<=32*1024*1024 and len(r.stderr)<=8*1024*1024,'NATIVE_OUTPUT_BOUND');return r.stdout

def primitive():
 p=Path('/tmp/tg-r3.py');b=read(p);need(sha(b)=='ba26b351071719ac21a89ec9e393d532910196d9b6acbc8a6034b6a45d869106','READ_PRIMITIVE_PIN');n={'__name__':'accepted_read_primitive','__file__':str(p)};exec(compile(b,str(p),'exec'),n);d=n['d'];_,product,native,reader,contract=d['load']();return product,native,reader,contract

def inspect(name):
 v=json.loads(run(['docker','inspect',name]));need(len(v)==1,'ONE_CONTAINER');return v[0]
def image_info(image):
 v=json.loads(run(['docker','image','inspect',image]));need(len(v)==1 and v[0]['Id']==image,'EXACT_IMAGE');return v[0]
def tree(name,reader):return json.loads(run(['docker','exec',name,'node','-e',reader.TREE_JS]))
def image_tree(image,reader):return json.loads(run(['docker','run','--rm','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint=node',image,'-e',reader.TREE_JS]))
def compose_args(c):return ['docker','compose','--project-name',c['project'],'--project-directory',c['directory']]+[v for f in c['files'] for v in ('--file',f['path'])]
def content_snapshot(native,reader,contract):
 names=run(['docker','ps','--all','--no-trunc','--format','{{.Names}}']).decode().splitlines();need(names and len(names)==len(set(names)),'CONTAINER_CLOSURE');row=inspect(CONTENT);label=row['Config']['Labels'];files=label['com.docker.compose.project.config_files'].split(',')
 g=object.__new__(native.Native);g.command=run;g.read_scripts=set(contract['readScriptSha256']);g.read_scopes=contract['readScriptScopes'];g.allowed_images={row['Image'],'sha256:45726089f65301dc85b40d88699233f71d11fe8825ae50c13b1c3ab1cf919fc5'};g.bindings={'containerNames':names,'contentContainer':CONTENT};g.forward_plan=None;g.before={'compose':{'project':label['com.docker.compose.project'],'directory':label['com.docker.compose.project.working_dir'],'files':[{'path':p,'sha256':sha(read(p))} for p in files]}}
 return reader.create(g.read_command).snapshot()
def db_identity(path):
 p=Path(path);s=p.lstat();need(not p.is_symlink() and stat.S_ISREG(s.st_mode) and s.st_nlink==1,'DATABASE_BOUNDARY');return [s.st_dev,s.st_ino]
def normalize_config(row):
 c=copy.deepcopy(row['Config']);c['Image']='<controlled-image>';c['Env']=sorted(c['Env'])
 if c.get('Hostname')==row['Id'][:12]:c['Hostname']='<own-container>'
 for key in ('com.docker.compose.image','com.docker.compose.config-hash','com.docker.compose.project.config_files'):
  need(key in c['Labels'],'COMPOSE_LABEL');c['Labels'][key]='<controlled>'
 return c

def relative(s):return type(s) is str and not s.startswith('/') and '\\' not in s and ':' not in s and all(p not in ('','.','..') for p in s.split('/'))
def stage(commit,bundle_pin):
 need(re.fullmatch('[a-f0-9]{40}',commit) and re.fullmatch('[a-f0-9]{64}',bundle_pin),'EXACT_PUBLIC_REFS');need(not AREA.exists(),'STAGE_EXISTS_INSPECT_ONLY');prefix='https://raw.githubusercontent.com/Elk0980/synapse-server/'+commit+'/ops/palitra-content-native-20261021-r1/'
 with urllib.request.urlopen(prefix+'bundle.json',timeout=30) as r:b=r.read(128*1024)
 need(sha(b)==bundle_pin,'BUNDLE_PIN');bundle=json.loads(b);need(bundle['status']=='ROOT_ACCEPTED_EXACT_CONTENT_CODE' and bundle['runtimeAuthorization'] is False,'CODE_ACCEPTANCE_REQUIRED')
 with urllib.request.urlopen(prefix+'payload.zip',timeout=45) as r:z=r.read(bundle['zipBytes']+1)
 need(len(z)==bundle['zipBytes'] and sha(z)==bundle['zipSha256'],'ZIP_PIN')
 with zipfile.ZipFile(io.BytesIO(z)) as f:
  names=f.namelist();need(len(names)==len(set(names)) and sum(i.file_size for i in f.infolist())<16*1024*1024,'ZIP_BOUND');mb=f.read('code-manifest.json');need(sha(mb)==bundle['manifestSha256'],'MANIFEST_PIN');m=json.loads(mb);need(set(names)=={'code-manifest.json'}|{r['file'] for r in m['files']},'CLOSED_CODE_ZIP');payload={}
  for row in m['files']:
   need(relative(row['file']) and row['file'].startswith(('candidate/content/','candidate/crm/','candidate/static/')),'CLOSED_CANDIDATE_PATH');raw=f.read(row['file']);need(sha(raw)==row['sha256'] and len(raw)==row['bytes'],'PAYLOAD_PIN');payload[row['file']]=raw
 with urllib.request.urlopen(prefix+'schema.sql',timeout=30) as r:sql=r.read(128*1024)
 need(sha(sql)==bundle['schemaSha256'],'SCHEMA_PIN');AREA.mkdir(mode=0o700);code=AREA/'code';code.mkdir(mode=0o700)
 for name,raw in payload.items():
  p=code/name;p.parent.mkdir(mode=0o700,parents=True,exist_ok=True);write(p,raw)
 write(code/'code-manifest.json',mb);write(AREA/'bundle.json',b);write(AREA/'schema.sql',sql);write(AREA/'stage.json',enc({'bundleSha256':bundle_pin,'helperSha256':sha(read(SELF)),'commit':commit,'manifestSha256':bundle['manifestSha256']}));print(json.dumps({'status':'CODE_STAGED_NOT_APPLIED','files':len(payload)}))

def package():
 staged=load(AREA/'stage.json');need(sha(read(SELF))==staged['helperSha256'],'HELPER_CHANGED');bb=read(AREA/'bundle.json');need(sha(bb)==staged['bundleSha256'],'BUNDLE_CHANGED');bundle=json.loads(bb);need(bundle['helperSha256']==staged['helperSha256'],'BUNDLE_HELPER_PIN');mb=read(AREA/'code/code-manifest.json');need(sha(mb)==staged['manifestSha256'],'MANIFEST_CHANGED');m=json.loads(mb);pins={r['file']:r['sha256'] for r in m['files']}
 actual={p.relative_to(AREA/'code').as_posix() for p in (AREA/'code').rglob('*') if p.is_file()};need(actual==set(pins)|{'code-manifest.json'},'PACKAGE_CLOSURE')
 for name,pin in pins.items():need(sha(read(AREA/'code'/name))==pin,'PACKAGE_PAYLOAD_CHANGED')
 need(sha(read(AREA/'schema.sql'))==bundle['schemaSha256'],'SCHEMA_CHANGED');return staged,bundle,m

def prepare(pid):
 staged,bundle,m=package();product,native,reader,contract=primitive();raw=Path('/proc/'+str(pid)+'/stat').read_text();lease={'pid':pid,'startTicks':raw[raw.rfind(')')+2:].split()[19],'path':str(native.LOCK)};native.Ticket.native_lease(lease);need(not (AREA/'action.json').exists(),'ACTION_EXISTS_NO_REPLAY')
 c=content_snapshot(native,reader,contract);need(c['image']=='sha256:2010268786d7ee4b0ff9259c9cdbde7be9ac145c5bae2b0ac394bcfed27e7867' and c['appTree']==product['appTreeAfter'],'CURRENT_INSTALLED_R7_REQUIRED');crm=inspect(CRM);ct=tree(CRM,reader);need(ct==load(PRE/'crm-tree.json'),'CRM_CHANGED_SINCE_PRECHECK');need(crm['Mounts']==[x for x in crm['Mounts'] if x['Destination']=='/data'],'NO_CRM_SOURCE_MOUNTS');need(image_tree(crm['Image'],reader)==ct and image_tree(c['image'],reader)==c['appTree'],'IMAGE_RUNTIME_TREE_MUST_MATCH')
 statics={};overlays={CONTENT:{},CRM:{}}
 for row in m['files']:
  key=row['file'];prefix=next(p for p in ('candidate/content/','candidate/crm/','candidate/static/') if key.startswith(p));rel=key[len(prefix):]
  if prefix!='candidate/static/':
   name=CONTENT if prefix=='candidate/content/' else CRM;t=c['appTree'] if name==CONTENT else ct;got=t.get(rel);want=row['beforeSha256'];need((got is None if want is None else got and got.get('sha256')==want),'FRESH_RUNTIME_BEFORE_PIN');need(got is None or got['type']=='file' and got['nlink']==1 and type(got['uid']) is int and type(got['gid']) is int and not got['mode']&0o7000,'RUNTIME_FILE_METADATA');
   for parent in Path(rel).parents:
    if str(parent)!='.' and parent.as_posix() in t:need(t[parent.as_posix()]['type']=='directory','PARENT_DIRECTORY_METADATA')
   overlays[name][rel]=row
  for target in row['targets']:
   if not target.startswith('/opt/'):continue
   p=Path(target);need(str(p).startswith('/opt/synapse/sites/synapse/') and '..' not in p.parts,'STATIC_TARGET_SCOPE');raw=read(p);need(row['beforeSha256'] and sha(raw)==row['beforeSha256'],'FRESH_STATIC_BEFORE_PIN');statics[target]={'sha256':sha(raw),'mode':stat.S_IMODE(p.stat().st_mode),'uid':p.stat().st_uid,'gid':p.stat().st_gid,'file':key,'afterSha256':row['sha256']}
 need(overlays[CONTENT] and overlays[CRM] and statics,'BOTH_SERVICES_AND_STATIC_REQUIRED');crm_base=load(PRE/'crm-base.json');need(db_identity(crm_base['databasePath'])==crm_base['databaseIdentity'],'CRM_DATABASE_CHANGED');base={'content':c,'crm':crm,'crmTree':ct,'crmDatabase':crm_base,'statics':statics,'overlays':overlays};write(AREA/'base.json',enc(base));now=time.time();action={'status':'ROOT_AUTHORIZED_ONE_ATTEMPT','created':now,'expires':now+1800,'lease':lease,'baseSha256':sha(enc(base)),'bundleSha256':staged['bundleSha256'],'helperSha256':staged['helperSha256'],'namespace':'palitra-content-'+os.urandom(12).hex(),'singleWriter':'Root','userAuthorization':'Direct request: complete Content and install for verification'};write(AREA/'action.json',enc(action));print(json.dumps({'status':'FRESH_BASE_READY_NOT_APPLIED','namespace':action['namespace'],'runtimeFiles':sum(map(len,overlays.values())),'staticFiles':len(statics),'schemaTables':sorted(TABLES),'metadataPreserved':True,'lease':lease}))

class Apply:
 def __init__(self):
  self.staged,self.bundle,self.m=package();self.product,self.native,self.reader,self.contract=primitive();self.action=load(AREA/'action.json');self.base=load(AREA/'base.json');self.readLease=None;self.children={};self.plan=None;self.published=set();self.seq=0;self.journal=ROOT/(self.action['namespace']+'-apply');self.ticket();need(not self.journal.exists(),'ATTEMPT_EXISTS_INSPECT_ONLY')
 def ticket(self):
  a=self.action;need(load(AREA/'action.json')==a and a['status']=='ROOT_AUTHORIZED_ONE_ATTEMPT' and (self.readLease is not None or a['created']<=time.time()<a['expires']) and 0<a['expires']-a['created']<=1800,'FRESH_ACTION_REQUIRED');need(sha(read(AREA/'base.json'))==a['baseSha256'] and self.staged['bundleSha256']==a['bundleSha256'] and sha(read(SELF))==a['helperSha256'],'ACTION_INPUT_CHANGED');self.native.Ticket.native_lease(self.readLease or a['lease'])
 def record(self,phase,status,facts=None):
  write(self.journal/('%03d.json'%self.seq),enc({'phase':phase,'status':status,'facts':facts,'automaticRetry':False}));self.seq+=1
 def once(self,phase,fn):
  self.record(phase,'STARTED_UNKNOWN_INSPECT_ONLY');v=fn();self.record(phase,'RETURNED_REQUIRES_READBACK',v);return v
 def expected_tree(self,name):
  t=copy.deepcopy(self.base['content']['appTree'] if name==CONTENT else self.base['crmTree'])
  for rel,row in self.base['overlays'][name].items():
   for p in Path(rel).parents:
    if str(p)=='.':continue
    key=p.as_posix()
    if key not in t:t[key]={'uid':0,'gid':0,'mode':0o755,'type':'directory'}
   t[rel]={**t.get(rel,{'uid':0,'gid':0,'mode':0o644,'type':'file','nlink':1}),'bytes':row['bytes'],'sha256':row['sha256']}
  return t
 def crm_guard(self,after):
  actual=inspect(CRM);before=self.base['crm'];need(actual['State']['Running'] and not actual['State']['Restarting'] and not actual['State']['OOMKilled'] and actual['State'].get('Health',{}).get('Status') in (None,'healthy'),'CRM_HEALTH');need(actual['Image']==(self.children[CRM]['image'] if after else before['Image']),'CRM_IMAGE');need(normalize_config(actual)==normalize_config(before) and self.reader.canonical_host(actual['HostConfig'])==self.reader.canonical_host(before['HostConfig']) and sorted(actual['Mounts'],key=lambda x:x['Destination'])==sorted(before['Mounts'],key=lambda x:x['Destination']) and self.reader.content_network(actual)==self.reader.content_network(before),'CRM_CONFIG_ENV_MOUNTS_NETWORKS_CHANGED');need(tree(CRM,self.reader)==(self.expected_tree(CRM) if after else self.base['crmTree']),'CRM_FULL_TREE_CHANGED');need(db_identity(self.base['crmDatabase']['databasePath'])==self.base['crmDatabase']['databaseIdentity'],'CRM_DATABASE_IDENTITY');return actual
 def guard(self,after=False):
  self.ticket();package();crm=self.crm_guard(after);actual=content_snapshot(self.native,self.reader,self.contract);want=copy.deepcopy(self.base['content'])
  if after:
   want.update(image=self.children[CONTENT]['image'],appTree=self.expected_tree(CONTENT),compose=self.plan)
   want['source']={k:v['sha256'] for k,v in want['appTree'].items() if v['type']=='file' and k in self.base['content']['source']}
   # Own CRM recreation is independently checked above, not trusted from this cell.
   want['invariants']['foreignContainers'][CRM]=self.reader.foreign(crm)
   for group in ['authCode','pushCode']:
    hashes=want['invariants'][group].get('files') if group=='authCode' else want['invariants'][group]
    for rel,row in self.base['overlays'][CONTENT].items():
     if rel in hashes:hashes[rel]=row['sha256']
  for target in self.published:
   if target in want['static']:want['static'][target]['sha256']=self.base['statics'][target]['afterSha256']
  need(actual==want,'FULL_CONTENT_NATIVE_STATE_CHANGED')
  for target,row in self.base['statics'].items():need(sha(read(target))==(row['afterSha256'] if target in self.published else row['sha256']),'STATIC_CAS_CHANGED')
  return sha(enc(actual))
 def backup(self):
  self.guard();import database
  result={}
  for key,path in [('content',self.base['content']['database']['path']),('crm',self.base['crmDatabase']['databasePath'])]:result[key]=database.backup(path,self.journal/(key+'.sqlite'),self.ticket)
  result['static']={}
  for i,(target,row) in enumerate(self.base['statics'].items()):
   b=read(target);need(sha(b)==row['sha256'],'STATIC_BACKUP_CAS');p=self.journal/('static-'+str(i));write(p,b);result['static'][target]={'path':str(p),'sha256':sha(b),'mode':row['mode']}
  return result
 def build(self,name):
  self.guard();parent=self.base['content']['image'] if name==CONTENT else self.base['crm']['Image'];old=image_info(parent);context=self.journal/('build-'+name);context.mkdir(mode=0o700);buffer=io.BytesIO();rows=self.base['overlays'][name];dirs={p.as_posix() for rel in rows for p in Path(rel).parents if str(p)!='.'}
  with tarfile.open(fileobj=buffer,mode='w',format=tarfile.USTAR_FORMAT) as z:
   for rel in sorted(dirs):
    info=tarfile.TarInfo(rel);info.type=tarfile.DIRTYPE;metadata=self.expected_tree(name)[rel];info.mode=metadata['mode'];info.uid=metadata['uid'];info.gid=metadata['gid'];info.mtime=0;z.addfile(info)
   for rel,row in sorted(rows.items()):
    b=read(AREA/'code'/row['file']);need(sha(b)==row['sha256'],'BUILD_PAYLOAD_PIN');info=tarfile.TarInfo(rel);info.size=len(b);metadata=self.expected_tree(name)[rel];info.mode=metadata['mode'];info.uid=metadata['uid'];info.gid=metadata['gid'];info.mtime=0;z.addfile(info,io.BytesIO(b))
  archive=buffer.getvalue();write(context/'payload.tar',archive);alias='synapse-'+self.action['namespace']+'-'+name+'-base:local';tag=alias.replace('-base:local',':local');need(run(['docker','image','ls','--quiet',alias]).strip()==run(['docker','image','ls','--quiet',tag]).strip()==b'','NEW_IMAGE_ALIAS_REQUIRED');dockerfile=('FROM '+alias+'\nADD payload.tar /app/\n').encode();write(context/'Dockerfile',dockerfile);need({x.name for x in context.iterdir()}=={'Dockerfile','payload.tar'},'CLOSED_BUILD_CONTEXT');self.ticket();run(['docker','image','tag',parent,alias]);need(sha(read(context/'payload.tar'))==sha(archive) and read(context/'Dockerfile')==dockerfile,'BUILD_CONTEXT_CHANGED');run(['docker','build','--network=none','--pull=false','--tag',tag,'--iidfile',str(context/'image.id'),str(context)],180);child=read(context/'image.id').decode().strip();new=image_info(child);need(child!=parent and new['RootFS']['Layers'][:-1]==old['RootFS']['Layers'] and len(new['RootFS']['Layers'])==len(old['RootFS']['Layers'])+1 and new['Config']==old['Config'] and image_tree(child,self.reader)==self.expected_tree(name),'EXACT_ONE_LAYER_CHILD');self.children[name]={'image':child,'parent':parent};return self.children[name]
 def make_plan(self):
  self.guard();path=self.journal/'content-crm-overlay.json';write(path,enc({'services':{'content':{'image':self.children[CONTENT]['image']},'crm':{'image':self.children[CRM]['image']}}}));c=copy.deepcopy(self.base['content']['compose']);c['files'].append({'path':str(path),'sha256':sha(read(path))});resolved=json.loads(run(compose_args(c)+['config','--format','json']));want=copy.deepcopy(c['resolved']);want['services']['content']['image']=self.children[CONTENT]['image'];want['services']['crm']['image']=self.children[CRM]['image'];need(resolved==want,'ONLY_TWO_IMAGES_MAY_CHANGE');c['resolved']=resolved;self.plan=c;return {'composeFiles':c['files']}
 def schema(self):
  self.guard();sql=read(AREA/'schema.sql').decode();statements=[];buf=''
  for c in sql:
   buf+=c
   if c==';' and sqlite3.complete_statement(buf):statements.append(buf.strip());buf=''
  need(not buf.strip() and len(statements)==9,'THREE_TABLE_SIX_TRIGGER_SCHEMA');objects={}
  for stmt in statements:
   match=re.match(r'CREATE (TABLE|TRIGGER) IF NOT EXISTS ([a-z_]+)\b',stmt);need(match is not None,'ADDITIVE_SCHEMA_ONLY');kind,name=match.groups();need(name in TABLES if kind=='TABLE' else any(name==t+suffix for t in TABLES for suffix in ('_no_update','_no_delete')),'OWN_SCHEMA_SCOPE');objects[name]=stmt
  need(set(objects)==TABLES|{t+s for t in TABLES for s in ('_no_update','_no_delete')},'EXACT_SCHEMA_CLOSURE');path=Path(self.base['crmDatabase']['databasePath']);db=sqlite3.connect(path.as_uri()+'?mode=rw',uri=True,isolation_level=None,timeout=5)
  def seal():
   schema=db.execute('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').fetchall();kept=[r for r in schema if r[2] not in TABLES];parts=[]
   import database
   for name, in db.execute("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name"):
    if name in TABLES:continue
    rows=sorted(sha(enc([database.typed(v) for v in r])) for r in db.execute('SELECT * FROM "'+name.replace('"','""')+'"'));parts.append([name,rows])
   return sha(enc([kept,parts]))
  try:
   db.execute('PRAGMA foreign_keys=ON');db.execute('BEGIN IMMEDIATE');self.ticket();need(not any(db.execute('SELECT 1 FROM sqlite_schema WHERE name=?',(n,)).fetchone() for n in objects),'OWN_SCHEMA_ALREADY_EXISTS_INSPECT_ONLY');before=seal();changes=db.total_changes
   for stmt in statements:db.execute(stmt)
   need(db.total_changes==changes and seal()==before,'EXISTING_CRM_ROWS_OR_SCHEMA_CHANGED');self.ticket();db.execute('COMMIT')
  except BaseException:
   if db.in_transaction:db.execute('ROLLBACK')
   raise
  finally:db.close()
  return {'created':sorted(objects),'oldRowsSchemaSeal':before,'businessRowsChanged':0}
 def schema_readback(self):
  self.ticket();expected=sqlite3.connect(':memory:');expected.executescript(read(AREA/'schema.sql').decode());objects=expected.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall();expected.close();db=sqlite3.connect(Path(self.base['crmDatabase']['databasePath']).as_uri()+'?mode=ro',uri=True,isolation_level=None,timeout=5)
  try:
   db.execute('PRAGMA query_only=ON');db.execute('BEGIN');actual=[db.execute('SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name=?',(row[1],)).fetchone() for row in objects];need(actual==objects and db.execute('PRAGMA quick_check').fetchone()==('ok',) and db.total_changes==0,'EXACT_ADDITIVE_SCHEMA_READBACK');db.execute('ROLLBACK')
  finally:db.close()
  return {'objects':len(objects),'quickCheck':'ok','readOnly':True}
 def up(self):
  self.guard();need(json.loads(run(compose_args(self.plan)+['config','--format','json']))==self.plan['resolved'],'LATE_COMPOSE_CAS');self.ticket();run(compose_args(self.plan)+['up','--detach','--no-build','--pull','never','--no-deps','crm','content'],180);
  deadline=time.monotonic()+45
  while True:
   self.ticket();states=[inspect(n)['State'] for n in (CRM,CONTENT)]
   if all(x['Running'] and not x['Restarting'] and not x['OOMKilled'] and x.get('Health',{}).get('Status') in (None,'healthy') for x in states):break
   need(time.monotonic()<deadline,'SERVICE_HEALTH_TIMEOUT_INSPECT_ONLY');time.sleep(1)
  return {'commandReturned':True,'requiresReadback':True}
 def publish(self):
  self.guard(True)
  for target,row in self.base['statics'].items():
   self.guard(True);self.native.cas(target,row['sha256'],read(AREA/'code'/row['file']),row['mode'],self.ticket);self.published.add(target);self.record('static-file','CAS_READBACK',{'path':target,'sha256':row['afterSha256']})
  return {'staticFiles':len(self.published)}
 def execute(self):
  self.guard();self.journal.mkdir(mode=0o700);self.record('admission','PASS');backup=self.once('protected-backup',self.backup);self.once('build-content',lambda:self.build(CONTENT));self.once('build-crm',lambda:self.build(CRM));self.once('compose-plan',self.make_plan);schema=self.once('single-additive-schema',self.schema);self.once('content-crm-up',self.up);self.guard(True);self.once('static-publication',self.publish);observed=self.guard(True);self.schema_readback();result={'status':'INSTALLED_PENDING_ROOT_LIVE_ACCEPTANCE','images':self.children,'plan':self.plan,'backup':backup,'schema':schema,'snapshotSha256':observed,'dataRestored':False,'wholePlatformAccepted':False};write(self.journal/'result.json',enc(result));write(AREA/'installed.json',enc(result));print(json.dumps({'status':result['status'],'resultSha256':sha(enc(result)),'images':self.children,'staticFiles':len(self.published)}))

def independent_inspect(pid):
 staged,bundle,m=package();product,native,reader,contract=primitive();original=load(AREA/'action.json');result=load(AREA/'installed.json');raw=Path('/proc/'+str(pid)+'/stat').read_text();lease={'pid':pid,'startTicks':raw[raw.rfind(')')+2:].split()[19],'path':str(native.LOCK)}
 native.Ticket.native_lease(lease);need(sha(read(AREA/'base.json'))==original['baseSha256'] and original['bundleSha256']==staged['bundleSha256'] and original['helperSha256']==staged['helperSha256'],'READBACK_INPUT_CHANGED')
 obj=object.__new__(Apply);obj.staged=staged;obj.bundle=bundle;obj.m=m;obj.product=product;obj.native=native;obj.reader=reader;obj.contract=contract;obj.action=original;obj.readLease=lease;obj.base=load(AREA/'base.json');obj.children=result['images'];obj.plan=result['plan'];obj.published=set(obj.base['statics'])
 observed=obj.guard(True);schema=obj.schema_readback();report={'status':'ROOT_INDEPENDENT_NATIVE_READBACK_PASS','snapshotSha256':observed,'schema':schema,'images':result['images'],'staticFiles':len(obj.published),'physicalPhoneAccepted':False,'wholePlatformAccepted':False};write(AREA/('readback-'+str(time.time_ns())+'.json'),enc(report));print(json.dumps(report))


def main():
 need(os.name=='posix' and os.geteuid()==0,'LINUX_ROOT_ONLY');mode=sys.argv[1]
 if mode=='stage':stage(sys.argv[2],sys.argv[3])
 elif mode=='prepare':prepare(int(sys.argv[2]))
 elif mode=='apply':Apply().execute()
 elif mode=='inspect':independent_inspect(int(sys.argv[2]))
 else:raise ValueError('UNKNOWN_MODE')
if __name__=='__main__':
 try:main()
 except Exception as e:
  code=str(e);print(json.dumps({'status':'STOP_INSPECT_ONLY_NO_RETRY','error':type(e).__name__,'code':code if isinstance(e,ValueError) and re.fullmatch('[A-Z0-9_]{1,96}',code) else 'NATIVE_OPERATION_FAILED'}));raise SystemExit(2)
