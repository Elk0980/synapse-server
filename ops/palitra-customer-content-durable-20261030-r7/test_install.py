"""Offline only. Real files/SQLite/tar; Docker/process boundaries modeled, never run."""
from pathlib import Path
import ast,copy,hashlib,importlib.util,io,json,os,sqlite3,tarfile,tempfile,time,unittest
from unittest.mock import patch
from test_image_archive_audit import Export
spec=importlib.util.spec_from_file_location('durable_candidate',Path(__file__).with_name('install.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class Pipeline(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();self.area=self.root/'releases'/m.NAME;self.area.mkdir(parents=True)
  self.commands=[];self.aliases={};self.child='sha256:'+'a'*64;self.facts={};self.rows=[]
  self.tree={'':{'type':'directory','mode':0o755,'uid':0,'gid':0},'palitra-orders-public':{'type':'directory','mode':0o755,'uid':0,'gid':0},'palitra-review-public':{'type':'directory','mode':0o755,'uid':0,'gid':0}}
  self.pins={}
  for i,target in enumerate(m.TARGETS):
   old=('old'+str(i)).encode();new=('new'+str(i)).encode();relative=target.removeprefix('/app/');file=self.area/'payload'/relative;file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes(new)
   self.rows.append({'target':target,'beforeSha256':m.sha(old),'afterSha256':m.sha(new),'bytes':len(new)});self.pins[target]=(m.sha(old),m.sha(new));self.tree[relative]={'type':'file','nlink':1,'mode':0o644,'uid':0,'gid':0,'bytes':len(old),'sha256':m.sha(old)}
  self.tree['unrelated.js']={'type':'file','nlink':1,'mode':0o644,'uid':0,'gid':0,'bytes':8,'sha256':'f'*64}
  self.images={n:'sha256:'+str(i+1)*64 for i,n in enumerate(m.CONTAINERS)};self.images[m.CONTENT]=m.BASE_IMAGE
  self.services={n:('content'if n==m.CONTENT else'crm'if n==m.CRM else'hugh-runtime'if'hugh'in n else'chat'if'chat'in n else'caddy')for n in m.CONTAINERS}
  self.config={'services':{self.services[n]:{'image':im}for n,im in self.images.items()}}
  self.compose=self.root/'compose.yml';self.compose.write_text('fixture compose')
  self.image_config={'WorkingDir':'/app','Cmd':['node','server.js'],'Entrypoint':['docker-entrypoint.sh'],'Env':[],'User':''}
  self.export=Export(self.layer(),self.image_config,attestation=True);self.child=self.export.child['Id']
  self.current={n:self.container(n,i)for i,n in enumerate(m.CONTAINERS)}
  self.content=self.root/'content-data';self.crm=self.root/'crm-data';self.content.mkdir();self.crm.mkdir()
  self.inv={'sourceReviewSha256':'e'*64,'contentPaths':list(m.ACTIVE_DATABASE_PATHS+m.OPAQUE_ARCHIVE_PATHS),'crmPaths':['/data/crm.sqlite']}
  for role,folder in [('content',self.content),('crm',self.crm)]:
   self.current[m.CONTENT if role=='content'else m.CRM]['Mounts']=[{'Source':str(folder),'Destination':'/data','RW':True}]
   for name in self.inv[role+'Paths']:
    p=folder/name.removeprefix('/data/');p.parent.mkdir(parents=True,exist_ok=True)
    if name in m.OPAQUE_ARCHIVE_PATHS:p.write_bytes(b'SQLite format 3\x00'+b'\x00\x00\x02\x02'+b'SYNTHETIC_OPAQUE_NOT_VALID_FOR_SQLITE');p.chmod(0o600)
    else:
     db=sqlite3.connect(p);db.executescript('CREATE TABLE preserved(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT);INSERT INTO preserved(value)VALUES("kept");');db.close()
  self.setup_diagnostic_db()
  (self.root/'sites').mkdir();(self.root/'sites/foreign.js').write_bytes(b'preserved')
  self.manifest={'schema':1,'packageId':m.NAME,'status':'ROOT_REVIEWED_CODE_ONLY','helperSha256':m.sha(m.SELF.read_bytes()),'expectedImages':self.images,'files':self.rows,'databaseInventory':self.inv}
  archive_review={'archives':[{'containerPath':name,'role':'opaque_retained_copy','uid':0,'gid':0,'mode':'0600','nlink':1,'sameResolvedPath':True,'maxBytes':m.MAX_FILE,'observedBytes':(self.content/name.removeprefix('/data/')).stat().st_size,'sidecars':{'-wal':{'present':False},'-shm':{'present':False}}}for name in m.OPAQUE_ARCHIVE_PATHS]}
  self.guard_data={'reviewed-source-pins.json':b'{}\n','reviewed-sql.json':b'{}\n','inventory-review.json':m.enc(archive_review)}
  self.guard_data['diagnostic_preservation.py']=Path(__file__).with_name('diagnostic_preservation.py').read_bytes()
  self.guard_data['image_archive_audit.py']=Path(__file__).with_name('image_archive_audit.py').read_bytes()
  for name,raw in self.guard_data.items():(self.area/name).write_bytes(raw)
  # Linux metadata checks are retained in production. Windows cannot model fd ctime/POSIX owners.
  def read(path):
   p=Path(path);self.assertFalse(p.is_symlink());a=p.stat();v=p.read_bytes();b=p.stat();self.assertEqual((a.st_ino,a.st_size,a.st_mtime_ns),(b.st_ino,b.st_size,b.st_mtime_ns));return v
  self.patches=[patch.object(m,'sync_dir'),patch.object(m,'ROOT',self.root),patch.object(m,'AREA',self.area),patch.object(m,'FILE_PINS',self.pins),patch.object(m,'INVENTORY_REVIEW_SHA','e'*64),patch.object(m,'safe_read',side_effect=read),
   patch.object(m,'REVIEWED_DATA_PINS',{n:m.sha(v)for n,v in self.guard_data.items()}),patch.object(m,'own_lease',return_value={'pid':123,'startTicks':'456'}),patch.object(m,'policy_state',return_value={'legacyDisabled':True}),patch.object(m,'price_pin',return_value={'version':83,'sha256':'fixture'}),
   patch.object(m,'startup_guard',return_value={'status':'FIXTURE_ONLY_NOT_NATIVE_READINESS'}),patch.object(m,'source_review_guard'),patch.object(m,'managed_guard',return_value={'version':332,'revision':'fixture-v332','files':{'a':'b'}}),patch.object(m,'_process',side_effect=self.process)]
  for p in self.patches:p.start()
  self.store_manifest()
 def setup_diagnostic_db(self):
  from datetime import datetime,timezone
  db=sqlite3.connect(self.content/'content.sqlite');db.executescript("""
   CREATE TABLE client_bot_bridge_state(bot_key TEXT PRIMARY KEY,ok INTEGER,username TEXT,telegram_bot_id TEXT,error TEXT,checked_at TEXT);
   CREATE TABLE hugh_owner_alerts(id INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT UNIQUE,status TEXT);
   INSERT INTO hugh_owner_alerts(event_key,status)VALUES('dispatch-transport-error','uncertain');
   CREATE TABLE project_chat_outbox(id INTEGER PRIMARY KEY,message_id INTEGER,company_code TEXT,status TEXT);
   CREATE TABLE project_chat_ai_jobs(id INTEGER PRIMARY KEY,company_code TEXT,reply_message_id INTEGER,message_id INTEGER,api_assistant INTEGER,status TEXT);
   CREATE TABLE project_chat_messages(id INTEGER PRIMARY KEY);
   CREATE TABLE project_chat_rooms(company_code TEXT PRIMARY KEY,api_assistant INTEGER);
   CREATE TABLE project_chat_tasks(id INTEGER PRIMARY KEY,company_code TEXT,external_ref TEXT,status TEXT);
  """)
  db.execute('INSERT INTO client_bot_bridge_state VALUES(?,?,?,?,?,?)',('palitra',1,'Fixture_bot','123','',datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')));db.commit();db.close()
 def store_manifest(self):
  (self.area/'manifest.json').write_bytes(m.enc(self.manifest));(self.area/'stage.json').write_bytes(m.enc({'commit':'b'*40,'helperSha256':m.sha(m.SELF.read_bytes()),'manifestSha256':m.sha((self.area/'manifest.json').read_bytes()),**{n+'Sha256':m.sha(v)for n,v in self.guard_data.items()}}))
 def tearDown(self):
  for p in reversed(self.patches):p.stop()
  self.temp.cleanup()
 def service_hash(self,config,service):return m.sha(m.enc(config['services'][service]))
 def container(self,n,i):
  cid=str(i+1)*64;config=copy.deepcopy(self.image_config);config.update(Image=self.images[n],Hostname=cid[:12]);config['Env']=['DATABASE_PATH=/data/'+('crm'if n==m.CRM else'content')+'.sqlite']+(['PALITRA_CLIENT_BOT_USERNAME=Fixture_bot','CONTENT_PLAN_WORKER_ENABLED=0','CRM_API_KEY=SYNTHETIC']if n==m.CONTENT else[]);config['Labels']={'com.docker.compose.project':'synapse','com.docker.compose.project.working_dir':str(self.root),'com.docker.compose.project.config_files':str(self.compose),'com.docker.compose.service':self.services[n],'com.docker.compose.image':self.images[n],'com.docker.compose.config-hash':self.service_hash(self.config,self.services[n])}
  return{'Id':cid,'Name':'/'+n,'Image':self.images[n],'Config':config,'HostConfig':{'RestartPolicy':{'Name':'always'}},'Mounts':[],'NetworkSettings':{'SandboxID':'old','Networks':{'synapse':{'EndpointID':'e','MacAddress':'m','IPAddress':'172.0.0.2','GlobalIPv6Address':'','Aliases':[n,cid[:12]],'DNSNames':[n,cid[:12]],'IPAMConfig':None}}},'State':{'Running':True,'Restarting':False,'OOMKilled':False,'StartedAt':'before'},'RestartCount':0}
 def aftertree(self):return m.expected_tree({'tree':self.tree},self.manifest)
 def layer(self):
  stream=io.BytesIO()
  with tarfile.open(fileobj=stream,mode='w',format=tarfile.USTAR_FORMAT)as out:
   for row in self.rows:
    key=row['target'].removeprefix('/');v=(self.area/'payload'/key.removeprefix('app/')).read_bytes();info=tarfile.TarInfo(key);info.mode=0o644;info.uid=info.gid=0;info.size=len(v);out.addfile(info,io.BytesIO(v))
  return stream.getvalue()
 def process(self,a,timeout,limit=m.MAX_FILE):
  self.commands.append(a)
  if a[:2]==['docker','inspect']:return 0,m.enc([self.current[a[2]]]),b''
  if a[:3]==['docker','image','inspect']:
   if a[3]=='--format':return 0,(self.aliases.get(a[5],a[5])+'\n').encode(),b''
   im=a[3]
   info=copy.deepcopy(self.export.child)if im==self.child else{'Id':im,'Config':self.image_config,'RootFS':{'Layers':[self.export.parent_diff]},'Os':'linux','Architecture':'amd64','Variant':None}
   return 0,m.enc([info]),b''
  if a[:2]==['docker','exec']:
   row=next(v for v in self.current.values()if v['Id']==a[2]);tree=self.aftertree()if row['Image']==self.child else self.tree;return 0,m.enc(tree),b''
  if a[:2]==['docker','run']:return 0,m.enc(self.aftertree()if a[9]==self.child else self.tree),b''
  if a[:3]==['docker','image','ls']:return 0,b'',b''
  if a[:3]==['docker','image','tag']:self.aliases[a[4]]=a[3];return 0,b'',b''
  if a[:2]==['docker','build']:Path(a[7]).write_text(self.child);return 0,b'',b''
  if a[:3]==['docker','image','save']:
   self.export.write(Path(a[4]));return 0,b'',b''
  if a[:2]==['docker','compose']:
   i=a.index('config')if'config'in a else a.index('up');config=copy.deepcopy(self.config);files=[a[x+1]for x,v in enumerate(a[:i])if v=='--file']
   if any(p.endswith('content-image-only.json')for p in files):config['services']['content']['image']=self.child
   suffix=a[i:]
   if suffix[:2]==['config','--format']:return 0,m.enc(config),b''
   if suffix[:2]==['config','--hash']:return 0,(suffix[2]+' '+self.service_hash(config,suffix[2])+'\n').encode(),b''
   if suffix[:2]==['config','--images']:return 0,(config['services'][suffix[2]]['image']+'\n').encode(),b''
   if suffix[0]=='up':
    self.assertEqual(suffix,['up','--detach','--no-build','--pull','never','--no-deps','content']);row=self.current[m.CONTENT];row['Id']='d'*64;row['Image']=self.child;row['Config']['Image']=self.child;row['Config']['Hostname']='d'*12;row['Config']['Labels'].update({'com.docker.compose.project.config_files':','.join(files),'com.docker.compose.image':self.child,'com.docker.compose.config-hash':self.service_hash(config,'content')});row['State']['StartedAt']='after';net=row['NetworkSettings']['Networks']['synapse'];net.update(Aliases=[m.CONTENT,'d'*12],DNSNames=[m.CONTENT,'d'*12]);return 0,b'',b''
  raise AssertionError('Unmodeled capability '+str(a[:4]))
 def prepared(self):m.prepare();return m.load(self.area/'base.json')
 def built(self):self.prepared();m.build()
 def test_full_six_nested_pipeline_one_content_up_and_independent_readback(self):
  before=(self.root/'sites/foreign.js').read_bytes();self.built();m.apply();result=m.inspect_result();self.assertEqual(result['status'],'AFTER_INDEPENDENT_READBACK_PASS');self.assertEqual(result['otherServiceRestarts'],0);self.assertEqual(before,(self.root/'sites/foreign.js').read_bytes());self.assertEqual(len([a for a in self.commands if'up'in a]),1)
  with self.assertRaisesRegex(ValueError,'ONE_APPLY'):m.apply()
 def test_stage_checks_all_six_and_guard_files_before_area(self):
  files={'manifest.json':m.enc(self.manifest),**self.guard_data,**{'payload/'+r['target'].removeprefix('/app/'):(self.area/'payload'/r['target'].removeprefix('/app/')).read_bytes()for r in self.rows}}
  dest=self.root/'releases/staged'
  with patch.object(m,'AREA',dest),patch.object(m.urllib.request,'urlopen',side_effect=lambda url,timeout:io.BytesIO(files[url.split('/ops/'+m.NAME+'/')[1]])):
   m.stage('b'*40,m.sha(files['manifest.json']));self.assertTrue((dest/'stage.json').exists())
 def test_before_drift_or_covering_mount_refused_before_base(self):
  self.tree['customer-chat.js']['sha256']='e'*64
  with self.assertRaisesRegex(ValueError,'SIX_BEFORE'):m.prepare()
  self.assertFalse((self.area/'base.json').exists())
 def test_undeclared_sqlite_account_path_fails_closed(self):
  extra=self.content/'unknown.sqlite';sqlite3.connect(extra).close()
  with self.assertRaisesRegex(ValueError,'UNCONFIRMED_PERSISTENT'):m.prepare()
  self.assertFalse((self.area/'base.json').exists())
 def test_foreign_container_and_db_row_change_refuse_before_up(self):
  self.built();db=sqlite3.connect(self.content/'content.sqlite');db.execute('UPDATE preserved SET value="new user data"');db.commit();db.close()
  with self.assertRaisesRegex(ValueError,'DATABASE_SCHEMA_OR_ROWS_CHANGED'):m.apply()
  self.assertFalse(any('up'in a for a in self.commands));self.assertFalse((self.area/'apply-intent.json').exists())
 def test_unknown_up_success_reconciles_without_installed_receipt_and_never_replays(self):
  self.built();original=self.process
  def unknown(a,t,limit=m.MAX_FILE):
   result=original(a,t,limit)
   if'up'in a:raise ValueError('COMMAND_TIMEOUT_INSPECT_ONLY')
   return result
  with patch.object(m,'_process',side_effect=unknown):
   with self.assertRaisesRegex(ValueError,'COMMAND_TIMEOUT'):m.apply()
  self.assertFalse((self.area/'installed.json').exists());self.assertEqual(m.inspect_result()['status'],'AFTER_INDEPENDENT_READBACK_PASS')
  with self.assertRaisesRegex(ValueError,'ONE_APPLY'):m.apply()
  self.assertEqual(len([a for a in self.commands if'up'in a]),1)
 def test_unknown_up_before_execution_inspects_before_no_replay(self):
  self.built();original=self.process
  def unknown(a,t,limit=m.MAX_FILE):
   if'up'in a:raise ValueError('COMMAND_TIMEOUT_INSPECT_ONLY')
   return original(a,t,limit)
  with patch.object(m,'_process',side_effect=unknown):
   with self.assertRaisesRegex(ValueError,'COMMAND_TIMEOUT'):m.apply()
  self.assertEqual(m.inspect_result()['status'],'BEFORE_NO_REPLAY')
  with self.assertRaisesRegex(ValueError,'ONE_APPLY'):m.apply()
 def test_expired_prepare_and_wrong_lease_fail_before_build(self):
  self.prepared()
  with patch.object(m,'own_lease',return_value={'pid':777,'startTicks':'888'}):
   with self.assertRaisesRegex(ValueError,'FRESH_OWN_LEASE'):m.build()
  with patch.object(m.time,'time',return_value=time.time()+1000):
   with self.assertRaisesRegex(ValueError,'PREPARE_EXPIRED'):m.build()
 def test_build_tar_is_exact_six_and_network_none_pull_false(self):
  self.built();calls=[a for a in self.commands if a[:2]==['docker','build']];self.assertEqual(len(calls),1);self.assertEqual(calls[0][2:4],['--network=none','--pull=false'])
  with tarfile.open(self.area/'build/payload.tar')as a:self.assertEqual(set(a.getnames()),{p.removeprefix('/app/')for p in m.TARGETS});self.assertTrue(all(x.isfile()for x in a.getmembers()))
  self.assertNotIn('RUN',(self.area/'build/Dockerfile').read_text())
 def test_child_whole_layer_rejects_outside_app_extra_and_links(self):
  base={'tree':self.tree};raw=self.layer();m.tar_members(raw,base,self.manifest)
  for name,kind in [('etc/foreign.conf',tarfile.REGTYPE),('app/alien.js',tarfile.REGTYPE),('app/.wh.customer-chat.js',tarfile.REGTYPE),('app/customer-chat.js',tarfile.SYMTYPE)]:
   stream=io.BytesIO()
   with tarfile.open(fileobj=stream,mode='w')as out:
    info=tarfile.TarInfo(name);info.type=kind;info.mode=0o644;info.size=1 if kind==tarfile.REGTYPE else 0;out.addfile(info,io.BytesIO(b'x')if info.size else None)
   with self.assertRaises(ValueError):m.tar_members(stream.getvalue(),base,self.manifest)
 def test_command_adapter_denies_lifecycle_other_services_app_require_and_shell(self):
  forbidden=[['sh','-c','true'],['docker','exec','a'*64,'node','server.js'],['docker','run','image'],['docker','pull',m.BASE_IMAGE],['docker','compose','up'],m.compose_args({'project':'synapse','directory':str(self.root),'files':[{'path':str(self.compose)}]})+['up','--detach','--no-build','--pull','never','--no-deps','crm']]
  before=len(self.commands)
  for cmd in forbidden:
   with self.assertRaisesRegex(ValueError,'CLOSED_COMMAND'):m.run(cmd)
  self.assertEqual(len(self.commands),before)
 def test_readonly_backup_preserves_all_dbs_and_schema_including_sequence(self):
  self.prepared();base=m.load(self.area/'base.json');m.backup_databases(base)
  backups=m.load(self.area/'backups.json');self.assertEqual(len(backups),11)
  for name,row in backups.items():
   if base['databases'][name]['preservation']=='opaque':
    self.assertEqual(Path(row['path']).read_bytes(),Path(base['databases'][name]['hostPath']).read_bytes());continue
   with m.db_open(row['path'])as con:m.assert_database(con,base['databaseFacts'][name]);self.assertIn('sqlite_sequence',m.db_facts(con)['tables'])
   with m.db_open(base['databases'][name]['hostPath'])as con:
    with self.assertRaises(sqlite3.OperationalError):con.execute('UPDATE preserved SET value="forbidden"')
 def test_manifest_refuses_extra_path_and_unconfirmed_inventory(self):
  bad=copy.deepcopy(self.manifest);bad['files'].append(bad['files'][0])
  with self.assertRaisesRegex(ValueError,'EXACT_SIX'):m.validate_manifest(bad)
  with patch.object(m,'INVENTORY_REVIEW_SHA',None):
   with self.assertRaisesRegex(ValueError,'PERSISTENT_DB_INVENTORY_NOT_FROZEN'):m.validate_manifest(self.manifest)
  with patch.object(m,'FILE_PINS',{**self.pins,'/app/draft-account-service.cjs':('a'*64,None)}):
   with self.assertRaisesRegex(ValueError,'SCOPED_R2_PINS_NOT_FROZEN'):m.validate_manifest(self.manifest)


 def test_late_overlay_tampering_refuses_before_up(self):
  self.built();p=self.area/'content-image-only.json';p.write_bytes(m.enc({'services':{'content':{'image':self.child,'environment':{'BYPASS':'true'}}}}))
  with self.assertRaisesRegex(ValueError,'IMAGE_ONLY_OVERLAY_CHANGED'):m.apply()
  self.assertFalse(any('up'in a for a in self.commands));self.assertFalse((self.area/'apply-intent.json').exists())
 def test_child_config_change_is_rejected_again_before_up(self):
  self.built();original=self.process
  def changed(a,t,limit=m.MAX_FILE):
   code,out,err=original(a,t,limit)
   if a[:4]==['docker','image','inspect',self.child]:
    rows=json.loads(out);rows[0]['Config']['Env'].append('UNREVIEWED=true');out=m.enc(rows)
   return code,out,err
  with patch.object(m,'_process',side_effect=changed):
   with self.assertRaisesRegex(ValueError,'CHILD_IMAGE_CONFIG_CHANGED'):m.apply()
  self.assertFalse(any('up'in a for a in self.commands))
 def test_foreign_restart_or_price_drift_stops_before_build(self):
  self.prepared();self.current[m.CRM]['RestartCount']+=1
  with self.assertRaisesRegex(ValueError,'FOREIGN_CONTAINER_CHANGED'):m.build()
  self.assertFalse((self.area/'build-intent.json').exists())
 def test_backups_changed_refuse_without_restore(self):
  self.built();meta=m.load(self.area/'backups.json');first=next(iter(meta.values()));Path(first['path']).write_bytes(b'damaged backup')
  with self.assertRaisesRegex(ValueError,'PROTECTED_BACKUP_CHANGED'):m.apply()
  with m.db_open(self.content/'content.sqlite')as c:self.assertEqual(c.execute('SELECT value FROM preserved').fetchone(),('kept',))
 def test_late_unrelated_business_write_during_readonly_startup_guard_refuses_before_up(self):
  self.built()
  def change(paths,rows,end):
   c=sqlite3.connect(self.content/'content.sqlite')
   try:c.execute("INSERT INTO preserved(value)VALUES('late business row')");c.commit()
   finally:c.close()
   return {'status':'FIXTURE_READONLY_BINDING_COULD_MATCH'}
  with patch.object(m,'startup_guard',side_effect=change):
   with self.assertRaisesRegex(ValueError,'DATABASE'):m.apply()
  self.assertFalse(any('up'in cmd for cmd in self.commands))
  self.assertFalse((self.area/'apply-intent.json').exists())
 def test_native_command_capability_rejects_before_any_process_even_on_windows(self):
  original=m._process
  # Pipeline patch is a fixture, so call the actual implementation captured from source
  # through a separate module; the refusal occurs before resource/platform/process work.
  sp=importlib.util.spec_from_file_location('real_capture',m.SELF);other=importlib.util.module_from_spec(sp);sp.loader.exec_module(other)
  with patch.object(other.subprocess,'Popen')as proc:
   with self.assertRaisesRegex(ValueError,'CLOSED_COMMAND'):other._process(['sh','-c','true'],1)
   self.assertEqual(proc.call_count,0)

class FailClosed(unittest.TestCase):
 def test_pure_economy_module_pin_is_required_before_execution(self):
  with tempfile.TemporaryDirectory()as tmp:
   path=Path(tmp);(path/'economy_projection.py').write_bytes(b'raise AssertionError("must not execute")')
   with patch.object(m,'AREA',path),patch.object(m,'safe_read',side_effect=lambda x:Path(x).read_bytes()):
    with self.assertRaisesRegex(ValueError,'ECONOMY_PROJECTION_PIN_CHANGED'):m.economy_guard(None,{},time.time()+60)
 def test_opaque_command_is_fixed_source_pinned_and_arbitrary_code_refused(self):
  directory=Path(__file__).parent
  with patch.object(m,'AREA',directory),patch.object(m,'safe_read',side_effect=lambda x:Path(x).read_bytes()):
   code=m.vault_code();self.assertTrue(m.allowed_command(['docker','exec','a'*64,'node','-e',code,'b'*64]))
   self.assertFalse(m.allowed_command(['docker','exec','a'*64,'node','-e',code+';console.log(process.env)','b'*64]))
   with patch.object(m,'REVIEWED_DATA_PINS',{**m.REVIEWED_DATA_PINS,'vault_probe.cjs':'0'*64}):
    with self.assertRaisesRegex(ValueError,'VAULT_PROBE_PIN_CHANGED'):m.vault_code()
 def test_missing_proof_cannot_be_replaced_by_manual_attestation(self):
  directory=Path(__file__).parent
  with patch.object(m,'AREA',directory),patch.object(m,'safe_read',side_effect=lambda x:Path(x).read_bytes()):
   with self.assertRaisesRegex(ValueError,'FRESH_OPAQUE'):m.economy_guard(None,{},time.time()+60)
 def test_assembler_does_not_make_manifest_without_scoped_pins(self):
  sp=importlib.util.spec_from_file_location('blocked_assembler',Path(__file__).with_name('make_manifest.py'));v=importlib.util.module_from_spec(sp);sp.loader.exec_module(v)
  with patch.object(v.m,'FILE_PINS',{**v.m.FILE_PINS,'/app/draft-account-service.cjs':('a'*64,None)}):
   with self.assertRaisesRegex(ValueError,'SCOPED_R2_PINS_NOT_FROZEN'):v.build({}, {})
 def test_frozen_six_payload_pins_and_source_inventory_receipt(self):
  for target,(before,after)in m.FILE_PINS.items():self.assertEqual(m.sha((Path(__file__).parent/'payload'/target.removeprefix('/app/')).read_bytes()),after)
  receipt=Path(__file__).with_name('inventory-review.json');self.assertEqual(m.sha(receipt.read_bytes()),m.INVENTORY_REVIEW_SHA)
  inv=json.loads(receipt.read_bytes());fixed=m.account_database_path(inv['databasePathEnv'],'palitra-love','site-44bbe13f1bad5e005b2a');self.assertIn(fixed,[r['containerPath']for r in inv['activeDatabases']])
  self.assertNotEqual(m.account_database_path('/data/content.sqlite','alvi','other-draft'),fixed)
  with self.assertRaisesRegex(ValueError,'INVENTORY_SCOPE_PATH_UNKNOWN'):m.account_database_path('/data/content.sqlite','../alvi','other-draft')
 def test_scoped_constructor_and_factory_foreign_branch_still_mandatory(self):
  import subprocess
  directory=Path(__file__).parent.parent/'ACCOUNT_SCOPED_R2'
  env=dict(os.environ);env['NODE_PATH']='D:/Codex_Task_Artifacts/PALITRA_EDITOR_CATEGORY_FILTER_20261027/CHANGE_R1/node_modules'
  result=subprocess.run(['node','--test',str(directory/'factory-scope.test.cjs')],capture_output=True,text=True,env=env,timeout=30)
  self.assertEqual(result.returncode,0,result.stdout+result.stderr)
 def test_current_or_crossing_moscow_review_slot_refused(self):
  env={'PALITRA_REVIEW_REMINDERS_ENABLED':'true','PALITRA_REVIEW_REMINDER_EVENING':'18:00'}
  at=m.datetime(2026,10,29,15,30,tzinfo=m.timezone.utc).timestamp()
  with self.assertRaisesRegex(ValueError,'CURRENT_REVIEW_SLOT'):m.review_window_guard(env,at,at+180)
  m.review_window_guard(env,at+7200,at+7300)
  with self.assertRaisesRegex(ValueError,'UNKNOWN_REVIEW'):m.review_window_guard({**env,'PALITRA_REVIEW_REMINDER_EVENING':'25:60'},at,at+10)


class RealQueueSQL(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.area=Path(self.temp.name);self.source=Path(__file__).with_name('reviewed-sql.json');self.data=json.loads(self.source.read_bytes());(self.area/'reviewed-sql.json').write_bytes(self.source.read_bytes());self.paths={};self.rows={m.CONTENT:{'Config':{'Env':[]}}};self.dbs={}
  for role in('content','crm'):
   p=self.area/(role+'.sqlite');con=sqlite3.connect(p);required={}
   pairs=[('content_queue_required','content_queue_queries'),('final_content_required','final_content_queries')]if role=='content'else[('final_crm_required','final_crm_queries')]
   for key,_ in pairs:
    for table,cols in self.data[key].items():required.setdefault(table,set()).update(cols)
   if role=='content':
    for table in('project_chat_outbox','project_chat_message_edits','project_chat_scheduled'):required.setdefault(table,set()).update(['status','claimed_at'])
   for table,cols in required.items():con.execute('CREATE TABLE '+table+'('+','.join('"'+c+'"'+(' INTEGER'if c in('id','attempts','api_assistant','handed_off','version')else' TEXT')for c in cols)+')')
   if role=='content':con.execute('INSERT INTO ai_economy_meta(id)VALUES(1)')
   con.commit();con.close();self.dbs[role]=p;self.paths[role+':/data/'+role+'.sqlite']={'hostPath':str(p)}
  self.sr=patch.object(m,'safe_read',side_effect=lambda path:Path(path).read_bytes());self.sr.start();self.patch=patch.object(m,'AREA',self.area);self.patch.start();self.ec=patch.object(m,'economy_guard',return_value=None);self.ec.start();self.vp=patch.object(m,'opaque_vault_probe',return_value={});self.vp.start()
 def tearDown(self):self.vp.stop();self.ec.stop();self.patch.stop();self.sr.stop();self.temp.cleanup()
 def put(self,role,sql,params=()):
  c=sqlite3.connect(self.dbs[role]);c.execute(sql,params);c.commit();c.close()
 def guard(self):return m.startup_guard(self.paths,self.rows,time.time()+180)
 def test_empty_readonly_queue_fixture_passes_only_with_explicit_mocked_economy_boundary(self):
  before={k:Path(v).read_bytes()for k,v in self.dbs.items()};self.assertEqual(self.guard()['status'],'EXACT_STARTUP_GUARD_PASS');self.assertEqual(before,{k:Path(v).read_bytes()for k,v in self.dbs.items()})
 def test_ai_due_running_unknown_and_bad_timestamp_refused(self):
  for status,next_at,reason in [('pending','2000-01-01T00:00:00Z','AI_ELIGIBLE'),('running','2099-01-01T00:00:00Z','AI_ELIGIBLE'),('mystery','2099-01-01T00:00:00Z','AI_STATE'),('error','zzzz','AI_QUEUE_TIMESTAMP')]:
   self.put('content','DELETE FROM project_chat_ai_jobs');self.put('content','INSERT INTO project_chat_ai_jobs(status,attempts,api_assistant,next_attempt_at,reply_message_id)VALUES(?,0,0,?,NULL)',(status,next_at))
   with self.assertRaisesRegex(ValueError,reason):self.guard()
 def test_budget_held_and_push_active_or_invalid_refused(self):
  self.put('content',"INSERT INTO hugh_fallback_reservations(state,provider,created_at)VALUES('held','fixture','2000-01-01T00:00:00Z')")
  with self.assertRaisesRegex(ValueError,'BUDGET_RECOVERY'):self.guard()
  self.put('content','DELETE FROM hugh_fallback_reservations')
  for value in [json.dumps({'schema':1,'cipher':'aes-256-gcm','active':True}),'not json',json.dumps({'schema':1,'cipher':'unknown','active':False})]:
   self.put('content','DELETE FROM documents');self.put('content','INSERT INTO documents(key,version,body)VALUES(?,1,?)',('palitra-push-private/v1/job/fixture',value))
   with self.assertRaisesRegex(ValueError,'PUSH_ENVELOPE'):self.guard()
 def test_old_uncertain_is_inert_but_pending_claim_or_unhanded_alert_refused(self):
  self.put('content',"INSERT INTO client_bot_outbox(company_code,kind,status,claimed_at)VALUES('palitra-love','fixture','uncertain',NULL)");self.guard()
  self.put('content',"UPDATE client_bot_outbox SET status='pending'")
  with self.assertRaisesRegex(ValueError,'CLIENT_OUTBOX_ACTIVE'):self.guard()
  self.put('content',"UPDATE client_bot_outbox SET status='uncertain',claimed_at='old-claim'")
  with self.assertRaisesRegex(ValueError,'CLIENT_OUTBOX_ACTIVE'):self.guard()
  self.put('content','DELETE FROM client_bot_outbox');self.put('crm',"INSERT INTO task_dispatch_alerts(handed_off)VALUES(0)")
  with self.assertRaisesRegex(ValueError,'CRM_UNHANDED_ALERT'):self.guard()
 def test_crm_reconcile_and_active_dispatch_block_without_any_claim_api(self):
  self.put('crm',"INSERT INTO task_dispatch(company_code,state,attempts,next_at,task_id)VALUES('palitra-love','queued',0,0,1)")
  with self.assertRaisesRegex(ValueError,'CRM_DISPATCH_ACTIVE'):self.guard()
  self.put('crm',"UPDATE task_dispatch SET state='needs_input'")
  with self.assertRaisesRegex(ValueError,'CRM_RECONCILIATION'):self.guard()
 def test_missing_schema_fails_instead_of_empty_queue(self):
  self.put('content','DROP TABLE project_chat_ai_jobs')
  with self.assertRaisesRegex(ValueError,'STARTUP_QUEUE_SCHEMA_MISMATCH'):self.guard()

if __name__=='__main__':unittest.main()
