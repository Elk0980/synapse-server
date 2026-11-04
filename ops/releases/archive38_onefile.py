#!/usr/bin/env python3
"""Черновик отдельной миграции #38 после verified478. Запуск блокируется receipt pin.

Только установленный мигратор accepted PR476; старые образы/контейнеры сохраняются.
Два испытания на копиях, холодный raw backup, собственный VACUUM backup мигратора.
Автоматического восстановления БД нет. Реальный archive_write/session — отдельный этап.
"""
from pathlib import Path
import copy,hashlib,json,os,re,shutil,sqlite3,stat,subprocess as sp,sys,time
P=Path('/opt/synapse/releases/tasks-mcp-20261103-r1')
PRIOR=P/'release-478-35-r5';R1=P/'release-475-476-25-r1'
W=P/'archive38-20261104-r1';LOCK=Path('/opt/synapse/.palitra-app-release.lock')
PARENT_478_FINISH=P/'finish-478-r5-20261104-r1/verified.redacted.json'
PARENT_478_FINISH_SHA='422e745a611307de027ec6626353033ecf1529f11049e80ef2ad9061dfc613f5'
PARENT_SOURCE_SHA='24169c8092e711000d858bb3b4329931c91dd81cc1d61669aae1f86632e3952e'
ARCHIVE_HEAD='7432c96c0bf907a98f2c12c3a2b45914c5a6d350'
PINS={'/app/module-archive-migrate.js':'a1db92c4760b836ba9accd0b4098f6166cc47ca4c5cc9344f9da8aa400ad3402',
 '/app/module-archive-schema.js':'3b397bc9d93931d56beda88bee13657b0d5d56b3b4663c23d803095e75470e68',
 '/app/module-archive.js':'56b0dcf6a033d27b13f67569d42b0e0dce642fadaf441f139caa003a100675f9'}
LABEL='synapse.archive38.operator';MARKER='ARCHIVE38_NATIVE_MIGRATION_VERIFIED_R1'
SOURCE_SHA=None;OWNED={};COUNTER=0
class Refusal(Exception):pass
def need(ok,code):
 if not ok:raise Refusal(code)
def sha(value):return hashlib.sha256(value).hexdigest()
def canonical(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),default=lambda item:str(item) if isinstance(item,Path) else (_ for _ in ()).throw(TypeError('PRIVATE_JSON_TYPE'))).encode()
def load(path):return json.loads(Path(path).read_bytes())
def regular(path,directory=False,protected=False):
 path=Path(path);need(path.is_absolute() and not any(p.is_symlink() for p in [path,*path.parents]),'ABSOLUTE_REGULAR_PATH_REQUIRED')
 info=path.stat();need(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode),'FILE_TYPE_REFUSED')
 if protected:need(info.st_uid==0 and stat.S_IMODE(info.st_mode)==(0o700 if directory else 0o600) and (directory or info.st_nlink==1),'PRIVATE_PERMISSIONS_REQUIRED')
 return info
def filehash(path):
 digest=hashlib.sha256()
 with Path(path).open('rb') as stream:
  for block in iter(lambda:stream.read(65536),b''):digest.update(block)
 return digest.hexdigest()
def write(path,value,raw=False):
 path=Path(path);need(path.is_relative_to(W) and not path.exists() and not path.is_symlink(),'OUTPUT_ONCE_SCOPE')
 path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
 with path.open('xb') as stream:stream.write(value if raw else canonical(value)+b'\n');stream.flush();os.fsync(stream.fileno())
 path.chmod(0o600)
def event(phase):
 with (W/'events.redacted.jsonl').open('ab') as stream:stream.write(canonical({'phase':phase,'at':time.time()})+b'\n');stream.flush();os.fsync(stream.fileno())
 print('ARCHIVE38_'+phase,flush=True)
def run(args,purpose='command',data=None,timeout=120,accepted=(0,)):
 global COUNTER
 COUNTER+=1;code=re.sub('[^A-Z0-9_]','_',purpose.upper())
 try:result=sp.run(args,input=data,capture_output=True,timeout=timeout)
 except sp.TimeoutExpired:write(W/(str(COUNTER)+'-'+purpose+'.rc.json'),{'unknown':True});raise Refusal('TIMEOUT_'+code+'_INSPECT_ONLY') from None
 write(W/(str(COUNTER)+'-'+purpose+'.rc.json'),{'returncode':result.returncode})
 need(result.returncode in accepted,'COMMAND_'+code+'_INSPECT_ONLY');return result.stdout
def inspect(value):
 rows=json.loads(run(['docker','inspect',value],'inspect'));need(len(rows)==1,'ONE_CONTAINER_REQUIRED');return rows[0]
def live():
 ids=run(['docker','ps','-q','--no-trunc'],'running').decode().split()
 return json.loads(run(['docker','inspect',*ids],'running-inspect')) if ids else []
def env(row):
 result={}
 for item in row['Config'].get('Env') or []:
  key,separator,value=item.partition('=');need(separator and key not in result,'AMBIGUOUS_ENV');result[key]=value
 return result
def mounts(row):return sorted(row.get('Mounts',[]),key=lambda m:(m['Destination'],m['Source'],m['Type']))
def fact(row):
 return {'Id':row['Id'],'Image':row['Image'],'StartedAt':row['State']['StartedAt'],'RestartCount':row['RestartCount'],'Running':row['State']['Running'],
  'Env':sha(canonical(env(row))),'Mounts':sha(canonical(mounts(row))),'Networks':sha(canonical({k:v['NetworkID'] for k,v in row['NetworkSettings']['Networks'].items()})),'Config':sha(canonical(row['Config']))}
def matches(row,proof):
 need(isinstance(proof,dict) and all(key in proof for key in ['Id','Image','StartedAt','RestartCount','Mounts','Env','Config']),'PARENT_CONTAINER_FACT_CONTRACT')
 return all(fact(row).get(key)==value for key,value in proof.items() if key in fact(row))
def lease():
 pid=os.environ.get('SB_ARCHIVE38_LEASE_PID','');need(pid.isdigit() and int(pid)==os.getppid(),'PARENT_LEASE_PID_REQUIRED')
 rows=json.loads(run(['lslocks','--json','-o','PID,PATH,TYPE'],'lease')).get('locks',[]);same=[r for r in rows if r.get('path')==str(LOCK)]
 need(len(same)==1 and int(same[0]['pid'])==int(pid) and same[0].get('type')=='FLOCK','OWN_FRESH_FLOCK_REQUIRED')
def inputs(plan):
 lease();need(filehash(Path(__file__))==SOURCE_SHA,'SOURCE_DRIFT')
 for path,digest in plan['input_pins'].items():regular(path);need(filehash(path)==digest,'PINNED_INPUT_DRIFT')
 for path,expected in plan['guards'].items():
  info=regular(path);need({'sha256':filehash(path),'uid':info.st_uid,'gid':info.st_gid,'mode':stat.S_IMODE(info.st_mode)}==expected,'MANAGED_GUARD_DRIFT')
 for unit in ['synapse-sync.service','synapse-sync.timer']:need(run(['systemctl','show',unit,'-p','ActiveState','--value'],'sync').strip()==b'inactive','LEGACY_SYNC_ACTIVE')
 need(run(['systemctl','is-enabled','synapse-sync.timer'],'sync-enabled',accepted=(0,1,3)).strip()==b'disabled','SYNC_TIMER_ENABLED')
def same_original(row,before):
 need(row['Id']==before['Id'] and row['Image']==before['Image'] and row['Config']==before['Config'] and row['HostConfig']==before['HostConfig'] and mounts(row)==mounts(before),'ORIGINAL_CRM_CONTAINER_CHANGED')
 need({k:v['NetworkID'] for k,v in row['NetworkSettings']['Networks'].items()}=={k:v['NetworkID'] for k,v in before['NetworkSettings']['Networks'].items()},'ORIGINAL_CRM_NETWORK_CHANGED')
def stable(plan):
 inputs(plan);same_original(inspect(plan['crm']['Id']),plan['crm'])
 ownids={value.get('id') for value in OWNED.values()}
 others={row['Id']:fact(row) for row in live() if row['Id']!=plan['crm']['Id'] and row['Id'] not in ownids}
 need(others==plan['foreign_before'],'CONTENT_MCP_OR_OTHER_CONTAINER_CHANGED')
def backup(source,target):
 target.parent.mkdir(mode=0o700,parents=True,exist_ok=True);need(not target.exists(),'BACKUP_TARGET_EXISTS')
 a=sqlite3.connect(Path(source).as_uri()+'?mode=ro',uri=True,timeout=15);b=sqlite3.connect(target)
 try:a.backup(b,pages=256,sleep=0.05);need(b.execute('PRAGMA journal_mode=DELETE').fetchone()[0]=='delete','BACKUP_JOURNAL');need(b.execute('PRAGMA integrity_check').fetchall()==[('ok',)] and not b.execute('PRAGMA foreign_key_check').fetchall(),'BACKUP_INTEGRITY_FK')
 finally:b.close();a.close()
 target.chmod(0o600);d=sqlite3.connect(target.as_uri()+'?mode=ro',uri=True);memory=sqlite3.connect(':memory:')
 try:d.backup(memory);need(memory.execute('PRAGMA integrity_check').fetchall()==[('ok',)] and not memory.execute('PRAGMA foreign_key_check').fetchall(),'BACKUP_RESTORE_PROOF')
 finally:memory.close();d.close()
 return filehash(target)
def no_writers(plan):
 files=[Path(str(plan['database'])+suffix) for suffix in ['','-wal','-shm']]
 for row in live():
  for mount in row.get('Mounts',[]):need(not mount.get('RW') or not any(Path(mount['Source'])==path or Path(mount['Source']) in path.parents for path in files),'CRM_RW_MOUNT_WRITER_STILL_RUNNING')
def raw_backup(plan):
 no_writers(plan);folder=W/'cold-raw';folder.mkdir(mode=0o700);proof={}
 for suffix in ['','-wal','-shm']:
  source=Path(str(plan['database'])+suffix)
  if not source.exists():proof[source.name]=None;continue
  before=regular(source);target=folder/source.name
  with source.open('rb') as a,target.open('xb') as b:shutil.copyfileobj(a,b,65536);b.flush();os.fsync(b.fileno())
  target.chmod(0o600);after=source.stat();need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns) and filehash(source)==filehash(target),'RAW_COPY_CHANGED')
  proof[source.name]={'sha256':filehash(target),'uid':before.st_uid,'gid':before.st_gid,'mode':stat.S_IMODE(before.st_mode)}
 no_writers(plan);write(folder/'manifest.private.json',proof)
 working=W/'cold-raw-working';working.mkdir(mode=0o700)
 for source in folder.iterdir():
  if source.name=='manifest.private.json':continue
  target=working/source.name;shutil.copyfile(source,target);target.chmod(0o600)
 backup(working/plan['database'].name,W/'cold/before.sqlite')
def capture_owned(name,image):
 ids=run(['docker','ps','-aq','--no-trunc','--filter','name=^/'+name+'$'],'helper-id').decode().split()
 if not ids:return
 need(len(ids)==1,'OWN_HELPER_AMBIGUOUS');row=inspect(ids[0]);need(row['Name']=='/'+name and row['Image']==image and row['Config'].get('Labels',{}).get(LABEL)==SOURCE_SHA,'OWN_HELPER_IDENTITY');OWNED[name]['id']=row['Id']
def clean_helpers():
 for name,value in OWNED.items():
  if value.get('removed'):continue
  if not value.get('id'):capture_owned(name,value['image'])
  if not value.get('id'):continue
  row=inspect(value['id']);need(row['Id']==value['id'] and row['Name']=='/'+name and row['Image']==value['image'] and row['Config'].get('Labels',{}).get(LABEL)==SOURCE_SHA,'OWN_HELPER_IDENTITY')
  if row['State']['Running']:run(['docker','stop','--time','120',row['Id']],'stop-own-helper',timeout=150)
  row=inspect(row['Id']);need(not row['State']['Running'],'OWN_HELPER_STILL_RUNNING');run(['docker','rm',row['Id']],'remove-own-helper');value['removed']=True
def helper(plan,name,request,mounts_spec):
 name='sb-archive38-r1-'+name;image=plan['crm']['Image'];need(not run(['docker','ps','-aq','--no-trunc','--filter','name=^/'+name+'$'],'helper-absent').strip(),'HELPER_ALREADY_EXISTS');OWNED[name]={'image':image}
 args=['docker','run','-i','--name',name,'--label',LABEL+'='+SOURCE_SHA,'--network','none','--user','0','--entrypoint','node']
 for item in mounts_spec:args+=['--mount',item]
 try:raw=run(args+[image,'-e',HELPER_JS],'archive-helper',data=canonical(request),timeout=900)
 finally:capture_owned(name,image)
 row=inspect(OWNED[name]['id']);need(not row['State']['Running'] and row['State']['ExitCode']==0,'HELPER_EXIT_STATE')
 result=json.loads(raw);need(result.get('verified') is True and result.get('source_pins')==PINS,'HELPER_VERIFICATION_REQUIRED');return result
def trial(plan,folder):
 before=folder/'before.sqlite';target=folder/'crm.sqlite';need(before.is_file() and not target.exists(),'TRIAL_INPUT_SCOPE');shutil.copyfile(before,target);target.chmod(0o600)
 result=helper(plan,folder.name+'-trial',{'mode':'migrate','database':str(target),'backup':str(folder/'migrator-vacuum-before.sqlite')},[f'type=bind,src={folder},dst={folder}'])
 need(result['installed'] is True and result['state']=='installed' and result['legacy_before_sha256']==result['legacy_after_sha256'],'TRIAL_TYPED_PRESERVATION');write(folder/'proof.private.json',result);clean_helpers();event(folder.name.upper()+'_TRIAL_VERIFIED');return result
def parent_proof():
 parent=PRIOR/'verified.native.redacted.json';regular(parent,protected=True);regular(PARENT_478_FINISH,protected=True)
 need(filehash(PARENT_478_FINISH)==PARENT_478_FINISH_SHA,'VERIFIED478_FINISH_PROOF_PIN');proof=load(parent)
 need(proof.get('ready') is True and proof.get('native_verified') is True and proof.get('head')=='7cfe5a474a7a59bb7f19afc76e314ae4359a6d15' and proof.get('merge')=='fb598368ba0d05447e04d254bb8fd67807d891fa' and proof.get('schema_crm')==10 and proof.get('archive_migration') is False,'VERIFIED478_REQUIRED')
 need(proof.get('finish_receipt')==str(PARENT_478_FINISH) and proof.get('finish_receipt_sha256')==PARENT_478_FINISH_SHA and proof.get('notifications_off') is True and proof.get('database_restored') is False,'VERIFIED478_FINISH_LINK_REQUIRED')
 return proof,filehash(parent)
def prepare():
 parent=PRIOR/'verified.native.redacted.json';proof,parent_sha=parent_proof()
 need(load(PRIOR/'attempt.once.json').get('onefile_sha256')==PARENT_SOURCE_SHA,'ORIGINAL_R5_SOURCE_PIN')
 parentplan=load(PRIOR/'release-plan.private.json');rows=live();crm=inspect('synapse-crm-1');content=inspect('synapse-content-1');mcp=inspect('synapse-tasks-mcp-1')
 need(matches(crm,proof['containers']['crm']) and matches(content,proof['containers']['content']) and all(r['State']['Running'] and r['RestartCount']==0 for r in [crm,content,mcp]),'CURRENT478_CONTAINERS_REQUIRED')
 need(fact(mcp)==parentplan['foreign_before'].get('/synapse-tasks-mcp-1'),'PARENT478_MCP_KEY_PROJECTS_RUNTIME_REQUIRED')
 need(env(crm).get('DATABASE_PATH','/data/crm.sqlite')=='/data/crm.sqlite','CRM_DATABASE_PATH')
 data=[m for m in mounts(crm) if m['Destination']=='/data' and m.get('RW')];need(len(data)==1,'EXACT_DATA_MOUNT');database=Path(data[0]['Source'])/'crm.sqlite';regular(database)
 need(database==Path(parentplan['databases']['crm']),'PARENT478_CRM_DATABASE_PATH_REQUIRED')
 need(shutil.disk_usage(database.parent).free>max(2*1024**3,database.stat().st_size*10),'BACKUP_DISK_SPACE')
 pins=dict(parentplan['input_pins'])
 for path in [parent,PARENT_478_FINISH,PRIOR/'release-plan.private.json',PRIOR/'attempt.once.json',R1/'.env']:regular(path,protected=True);pins[str(path)]=filehash(path)
 plan={'crm':crm,'database':database,'parent478_receipt_sha256':parent_sha,'foreign_before':{r['Id']:fact(r) for r in rows if r['Id']!=crm['Id']},'guards':parentplan['guards'],'input_pins':pins}
 stable(plan);source=json.loads(run(['docker','exec',crm['Id'],'node','-e',SOURCE_CHECK_JS],'installed-source-pins'));need(source==PINS,'INSTALLED_MIGRATOR_PUBLIC_PINS');write(W/'runtime-before.private.json',rows);write(W/'plan.private.json',plan,False);return plan
def readiness(plan):
 code='fetch("http://127.0.0.1:8080/summary?from=2026-11-03&to=2026-11-03",{headers:{"x-api-key":process.env.API_KEY},signal:AbortSignal.timeout(10000)}).then(r=>{if(r.status!==200)throw Error("HTTP");console.log("READY");}).catch(()=>{process.exitCode=1;});'
 for _ in range(20):
  result=sp.run(['docker','exec',plan['crm']['Id'],'node','-e',code],capture_output=True,timeout=20)
  if result.returncode==0 and result.stdout.strip()==b'READY':return
  time.sleep(1)
 raise Refusal('CRM_READINESS_FAILED')
def start_original(plan):
 row=inspect(plan['crm']['Id']);same_original(row,plan['crm'])
 if not row['State']['Running']:inputs(plan);run(['docker','start',row['Id']],'start-original-crm')
 readiness(plan);row=inspect(plan['crm']['Id']);same_original(row,plan['crm']);need(row['State']['Running'] and row['RestartCount']==0,'ORIGINAL_CRM_RUNNING_REQUIRED')
def inspect_database(plan,name):
 return helper(plan,name,{'mode':'inspect','database':'/production/crm.sqlite'},[f'type=bind,src={plan["database"].parent},dst=/production,readonly'])
def apply(plan):
 stopped=False;mutation=False;resumed=False;cold=None
 try:
  backup(plan['database'],W/'online/before.sqlite');online=trial(plan,W/'online');stable(plan);event('ONLINE_BACKUP_AND_TRIAL_VERIFIED')
  stopped=True;event('STOP_ORIGINAL_CRM_INTENT');same_original(inspect(plan['crm']['Id']),plan['crm']);run(['docker','stop','--time','120',plan['crm']['Id']],'stop-original-crm',timeout=150)
  row=inspect(plan['crm']['Id']);need(not row['State']['Running'] and row['State']['ExitCode']==0,'GRACEFUL_ORIGINAL_CRM_STOP');no_writers(plan);raw_backup(plan);cold=trial(plan,W/'cold')
  need(cold['schema_sha256']==online['schema_sha256'] and cold['metadata_sha256']==online['metadata_sha256'],'TRIAL_SCHEMA_METADATA_MODEL');stable(plan);no_writers(plan)
  actual=W/'actual';actual.mkdir(mode=0o700);mutation=True;event('ACTUAL_MIGRATOR_INTENT')
  result=helper(plan,'actual-migration',{'mode':'migrate','database':'/production/crm.sqlite','backup':str(actual/'migrator-vacuum-before.sqlite'),'expected_legacy_sha256':cold['legacy_before_sha256'],'expected_before_schema_sha256':cold['before_schema_sha256']},[f'type=bind,src={plan["database"].parent},dst=/production',f'type=bind,src={actual},dst={actual}'])
  need(result['installed'] is True and result['legacy_before_sha256']==result['legacy_after_sha256']==cold['legacy_before_sha256'] and result['schema_sha256']==cold['schema_sha256'] and result['metadata_sha256']==cold['metadata_sha256'],'ACTUAL_PRESERVATION_OR_MODEL')
  write(W/'actual-migration.private.json',result);clean_helpers();no_writers(plan);event('ACTUAL_MIGRATION_VERIFIED');backup(plan['database'],W/'actual/post-consistent.sqlite');start_original(plan);resumed=True;stable(plan)
  event('ARCHIVE_API_AUDIT_INTENT_NO_DB_RESTORE_AFTER_THIS');api=json.loads(run(['docker','exec','synapse-tasks-mcp-1','node','-e',API_JS],'archive-api-smoke'))
  need(api.get('archive_list_ok') is True and api.get('archive_read_status') in [200,404] and api.get('archive_write_called') is False,'ARCHIVE_API_NOT_AVAILABLE')
  final=inspect_database(plan,'post-read-inspection');clean_helpers();stable(plan)
  need(final['state']=='installed' and final['schema_sha256']==result['schema_sha256'] and final['metadata_sha256']==result['metadata_sha256'] and final['archive_marker_sha256']==result['archive_marker_sha256'],'POST_API_SCHEMA_METADATA_CONTINUITY')
  receipt={'verified':True,'native_migration_verified':True,'archive_version':'module-archive-v1','accepted_head':ARCHIVE_HEAD,'source_sha256':SOURCE_SHA,'parent478_receipt_sha256':plan['parent478_receipt_sha256'],'parent478_finish_sha256':PARENT_478_FINISH_SHA,'source_pins':PINS,
   'schema_sha256':final['schema_sha256'],'archive_schema_sha256':final['archive_schema_sha256'],'metadata_sha256':final['metadata_sha256'],'metadata':final['metadata'],'archive_marker_sha256':final['archive_marker_sha256'],'archive_catalog_sha256':final['archive_catalog_sha256'],'schema_versions':final['schema_versions'],'archive_objects':final['archive_objects'],
   'typed_legacy_preserved_before_commit':True,'hidden_rowid_and_sequences_preserved':True,'integrity_ok':True,'foreign_key_violations':0,'migrator_vacuum_backup_kept':True,'vacuum_backup_sha256':result['backup_sha256'],'same_original_crm_id':plan['crm']['Id'],'crm':fact(inspect(plan['crm']['Id'])),'other_containers_unchanged':True,'runtime_guards_and_environment_unchanged':True,'database_restored':False,'image_builds':0,'container_recreations':0,'api_availability':api,'archive_write_read_smoke_pending':True,'map_session_question':'#35/comment316','secretValue':'REDACTED'}
  write(W/'exact-schema-and-metadata.private.json',final);write(W/'verified-native-archive.redacted.json',receipt);event('NATIVE_MIGRATION_VERIFIED_WRITE_READ_PENDING')
 except BaseException as error:
  code=str(error) if isinstance(error,Refusal) and re.fullmatch('[A-Z0-9_]+',str(error)) else 'PRIVATE_ATTEMPT_INSPECTION_REQUIRED'
  write(W/'failure.redacted.json',{'code':code,'stop_intent':stopped,'migration_intent':mutation,'database_restored':False,'no_blind_retry':True});clean_helpers()
  if stopped:
   state=inspect_database(plan,'failure-database-inspection');clean_helpers();need(state['integrity_ok'] and state['foreign_key_violations']==0 and state['schema_versions']==list(range(1,11)),'UNKNOWN_DATABASE_MANUAL_RECOVERY_STOP')
   need(state['state'] in ['absent','installed'],'PARTIAL_ARCHIVE_MANUAL_RECOVERY_STOP')
   if mutation and not resumed:need(cold and state['legacy_after_sha256']==cold['legacy_before_sha256'],'UNEXPECTED_LEGACY_DATA_MANUAL_RECOVERY_STOP')
   if resumed:need(state['state']=='installed' and state['schema_sha256']==result['schema_sha256'] and state['metadata_sha256']==result['metadata_sha256'],'POST_RESUME_SCHEMA_MANUAL_RECOVERY_STOP')
   write(W/'failure-database-state.private.json',state);start_original(plan);stable(plan);event('SAME_ORIGINAL_CRM_RESTARTED_NO_DB_RESTORE')
  raise
 try:
  public={key:receipt[key] for key in ['verified','native_migration_verified','archive_version','accepted_head','source_sha256','parent478_receipt_sha256','schema_sha256','archive_schema_sha256','metadata_sha256','archive_marker_sha256','archive_catalog_sha256','schema_versions','archive_objects','typed_legacy_preserved_before_commit','integrity_ok','foreign_key_violations','same_original_crm_id','crm','database_restored','image_builds','container_recreations','api_availability','archive_write_read_smoke_pending','map_session_question','secretValue']}
  public.update(receipt_path=str(W/'verified-native-archive.redacted.json'),receipt_sha256=filehash(W/'verified-native-archive.redacted.json'),schema_metadata_path=str(W/'exact-schema-and-metadata.private.json'),schema_metadata_sha256=filehash(W/'exact-schema-and-metadata.private.json'))
  text=MARKER+'\n'+canonical(public).decode();need(len(text.encode())<=9000,'REPORT_BOUND');out=json.loads(run(['docker','exec','-i','synapse-tasks-mcp-1','node','-e',COMMENT_JS],'task38-report',data=canonical({'marker':MARKER,'text':text})));need(type(out.get('comment_id')) is int,'COMMENT_RESULT_UNKNOWN');write(W/'task38-comment.redacted.json',out);event('TASK38_REPORTED')
 except BaseException:write(W/'report-pending.redacted.json',{'verified':True,'retry_comment_only':True,'helper_must_not_run_again':True,'marker':MARKER});event('REPORT_PENDING')
def parameters():
 need(sys.platform.startswith('linux') and os.geteuid()==0,'LINUX_ROOT_REQUIRED');need(re.fullmatch('[0-9a-f]{64}',PARENT_478_FINISH_SHA),'VERIFIED478_FINISH_PIN_PENDING');need(filehash(Path(__file__))==os.environ.get('SB_ARCHIVE38_SCRIPT_SHA'),'REVIEWED_SOURCE_REQUIRED')
def child():
 global SOURCE_SHA
 os.umask(0o077);parameters();SOURCE_SHA=filehash(Path(__file__));regular(P,True,True);regular(PRIOR,True,True)
 need(sp.check_output(['hostname']).strip()==b'msk-1-vm-tgnt' and not W.exists() and not W.is_symlink(),'HOST_OR_PREVIOUS_ATTEMPT');need((P/'.gitignore').read_bytes().strip()==b'*','PRIVATE_IGNORE');_,parent_sha=parent_proof();W.mkdir(mode=0o700);write(W/'attempt.once.json',{'source_sha256':SOURCE_SHA,'parent478_receipt_sha256':parent_sha,'parent478_finish_sha256':PARENT_478_FINISH_SHA,'accepted_head':ARCHIVE_HEAD});lease()
 try:plan=prepare();apply(plan)
 finally:clean_helpers()
def parent():
 parameters();need(not LOCK.is_symlink(),'LOCK_SYMLINK')
 import fcntl
 with LOCK.open('a+b') as lock:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise Refusal('ANOTHER_WRITER_LOCKED') from None
  environment=dict(os.environ);environment['SB_ARCHIVE38_LEASE_PID']=str(os.getpid());print('ARCHIVE38_LOCK_ACQUIRED',flush=True)
  try:return sp.run([sys.executable,str(Path(__file__).resolve()),'--lease-child'],env=environment).returncode
  finally:fcntl.flock(lock,fcntl.LOCK_UN);print('ARCHIVE38_LOCK_RELEASED',flush=True)
SOURCE_CHECK_JS="const f=require('node:fs'),c=require('node:crypto');console.log(JSON.stringify(Object.fromEntries("+json.dumps(list(PINS))+".map(p=>[p,c.createHash('sha256').update(f.readFileSync(p)).digest('hex')]))));"
HELPER_JS=r'''const fs=require('node:fs'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const pins={"/app/module-archive-migrate.js":"a1db92c4760b836ba9accd0b4098f6166cc47ca4c5cc9344f9da8aa400ad3402","/app/module-archive-schema.js":"3b397bc9d93931d56beda88bee13657b0d5d56b3b4663c23d803095e75470e68","/app/module-archive.js":"56b0dcf6a033d27b13f67569d42b0e0dce642fadaf441f139caa003a100675f9"};
const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),encode=value=>JSON.stringify(value),need=ok=>{if(!ok)throw Error('REFUSED');};
function rows(db){return db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name,tbl_name,sql').all().map(r=>[r.type,r.name,r.tbl_name,r.sql]);}
function proof(path){const db=new DatabaseSync(path,{readOnly:true});try{db.exec('PRAGMA query_only=ON;BEGIN');schema.assertDatabaseHealthy(db);const all=rows(db),archive=all.filter(r=>r[1].startsWith('module_archive_')||r[2].startsWith('module_archive_'));const metadata=['user_version','application_id','encoding','page_size'].map(k=>[k,Object.values(db.prepare('PRAGMA '+k).get())[0]]);const versions=db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r=>r.version);need(encode(versions)==='[1,2,3,4,5,6,7,8,9,10]');let marker=null,catalog=null;if(archive.length){marker=schema.verifyArchiveSchema(db);catalog=db.prepare('SELECT * FROM module_archive_modules ORDER BY code').all();}return {verified:true,source_pins:pins,state:archive.length?'installed':'absent',integrity_ok:true,foreign_key_violations:0,schema_rows:all,schema_sha256:hash(encode(all)),archive_schema_rows:archive,archive_schema_sha256:hash(encode(archive)),metadata,metadata_sha256:hash(encode(metadata)),schema_versions:versions,archive_objects:archive.length,archive_marker_sha256:hash(encode(marker)),archive_catalog_sha256:hash(encode(catalog)),legacy_after_sha256:hash(schema.snapshotLegacyState(db))};}finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}}
let schema;try{for(const [path,digest]of Object.entries(pins)){need(!fs.lstatSync(path).isSymbolicLink()&&hash(fs.readFileSync(path))===digest);}schema=require('/app/module-archive-schema');const input=JSON.parse(fs.readFileSync(0,'utf8'));need(['migrate','inspect'].includes(input.mode));need(input.database==='/production/crm.sqlite'||/^\/opt\/synapse\/releases\/tasks-mcp-20261103-r1\/archive38-20261104-r1\/(online|cold)\/crm.sqlite$/.test(input.database));const before=proof(input.database);if(input.mode==='inspect'){console.log(encode(before));}else{need(before.state==='absent'&&typeof input.backup==='string'&&input.backup.startsWith('/opt/synapse/releases/tasks-mcp-20261103-r1/archive38-20261104-r1/')&&input.backup.endsWith('/migrator-vacuum-before.sqlite'));if(input.database==='/production/crm.sqlite')need(input.expected_legacy_sha256===before.legacy_after_sha256&&input.expected_before_schema_sha256===before.schema_sha256);const result=require('/app/module-archive-migrate').migrateArchiveDatabase({databasePath:input.database,backupPath:input.backup,offlineConfirmation:'CRM_STOPPED'});const after=proof(input.database);need(result.installed===true&&result.version==='module-archive-v1'&&after.state==='installed'&&after.legacy_after_sha256===before.legacy_after_sha256&&after.metadata_sha256===before.metadata_sha256);need(hash(fs.readFileSync(input.backup))===result.backupSha256);console.log(encode({...after,installed:true,archive_version:result.version,legacy_before_sha256:before.legacy_after_sha256,before_schema_sha256:before.schema_sha256,backup_path:input.backup,backup_sha256:result.backupSha256,typed_preservation_verified:true}));}}catch{console.error('ARCHIVE38_HELPER_REFUSED_INSPECT_PRIVATE_ATTEMPT');process.exitCode=1;}'''
API_JS=r'''const {loadConfig,crmClient}=require('/app/server.js');(async()=>{const call=crmClient(loadConfig());const list=await call('archive_list',{module:'crm',project:'synapse-business',limit:1,offset:0});if(!Array.isArray(list.modules)||!Array.isArray(list.entries))throw Error('LIST');let read=200;try{await call('archive_read',{id:1});}catch(e){read=e.status;if(read!==404)throw Error('READ');}console.log(JSON.stringify({archive_list_ok:true,archive_read_status:read,archive_write_called:false,archive_access_audit_may_be_written:true,real_entry_write_read_pending:true}));})().catch(()=>{console.error('ARCHIVE38_API_UNCONFIRMED');process.exitCode=1;});'''
COMMENT_JS="const fs=require('node:fs'),{loadConfig,crmClient}=require('/app/server.js');(async()=>{const i=JSON.parse(fs.readFileSync(0,'utf8')),call=crmClient(loadConfig());let o=0;for(;;){const t=await call('task_get',{task_id:38,comments_limit:20,comments_offset:o,subtasks_limit:1}),f=t.comments.find(c=>c.text.includes(i.marker));if(f){if(f.author!=='Codex — Миграция архива #38'||f.text!==i.text)throw Error('MARKER');console.log(JSON.stringify({comment_id:f.id,status:'ALREADY_POSTED'}));return;}o+=t.comments.length;if(o>=t.comments_pagination.total)break;if(!t.comments.length)throw Error('PAGE');}const r=await call('task_comment',{task_id:38,author:'Codex — Миграция архива #38',text:i.text});if(!Number.isSafeInteger(r.comment?.id))throw Error('COMMENT');console.log(JSON.stringify({comment_id:r.comment.id,status:'POSTED'}));})().catch(()=>{console.error('REPORT_UNKNOWN_READ_BEFORE_RETRY');process.exitCode=1;});"
if __name__=='__main__':
 try:
  if sys.argv==[sys.argv[0],'--lease-child']:child();sys.exit(0)
  need(sys.argv==[sys.argv[0]],'NO_OPERATOR_ARGUMENTS');sys.exit(parent())
 except BaseException as error:
  if isinstance(error,SystemExit):raise
  code=str(error) if isinstance(error,Refusal) and re.fullmatch('[A-Z0-9_]+',str(error)) else 'PRIVATE_ATTEMPT_INSPECTION_REQUIRED'
  print('ARCHIVE38_STOP_'+code,flush=True);sys.exit(1)
