#!/usr/bin/env python3
"""485N1: один RO-классификатор, отдельный Q; серверный installer не повторяется.
Разрешённые записи: только Q и идемпотентный redacted task_comment25.
SB485_CLASSIFIER_SHA — SHA проверенного файла; все app/SQL действия остаются только чтением.
"""
from pathlib import Path
import ast,hashlib,json,os,re,sqlite3,stat,subprocess as sp,sys,time,types
P=Path('/opt/synapse/releases/tasks-mcp-20261103-r1');Q=P/'diagnose485-preflight-r1'
LOCK=Path('/opt/synapse/.palitra-app-release.lock');SCRIPT=P/'release485-onefile-r1.py'
SOURCE_SHA='a9329c259337031de62cd07fd540df104ca20cd3094e85561ca4e2c9b63b367e'
LIBRARY=P/'release477-resume-r2.py';LIBRARY_SHA='1a758b6c1609bec8e8aa431d6703d2380d334a2936a76c4a27ec1f8f52903cd8'
PRIOR=P/'release-482-43-r1';FAILED=P/'release-485-59-r1'
PROOF_SHA='aeaf516f6307e2b558d37d046854759c3b8b14b044d591bb3f5dd504a1080334'
PLAN_SHA='5816e89edbf2d004ecf094b5bd3f162124cccd8d6c83750150b4ae74d5e2951c'
SOURCE482_SHA='6ae8ea27836a07f36c3d10cb58412b3658e7569f6dc88c39a06ed9b20b55d750'
SCHEMAS={'crm':'5eae45d2b83e6a9b1475159cd379b44c7ae95b31091c1dc4c421e745a0207e87','content':'7767fe2b80092b29747fc7e48da48057e1f25312636a3cab9cdcc9fa017c0858'}
META_SHA='e27a8203409536527cfe49cc82e07a28e7f40940ccab62a48f72590e06718336'
MARKER='R485_N1_PREFLIGHT_SHAPE_CLASSIFIER_R1';AUTHOR='Codex — Выпуск PR485/#59'
class Refusal(Exception):pass
def need(ok,code):
 if not ok:raise Refusal(code)
def canonical(x):return json.dumps(x,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
def sha(x):return hashlib.sha256(x).hexdigest()
def regular(path,directory=False,private=False):
 path=Path(path);need(path.is_absolute() and not any(p.is_symlink() for p in [path,*path.parents]),'REGULAR_ABSOLUTE_REQUIRED');st=path.stat()
 need(stat.S_ISDIR(st.st_mode) if directory else stat.S_ISREG(st.st_mode),'REGULAR_TYPE_REQUIRED')
 if private:need(st.st_uid==0 and stat.S_IMODE(st.st_mode)==(0o700 if directory else 0o600) and (directory or st.st_nlink==1),'PRIVATE_ROOT_METADATA_REQUIRED')
 return path

def filehash(path):
 h=hashlib.sha256()
 with regular(path).open('rb') as f:
  for data in iter(lambda:f.read(65536),b''):h.update(data)
 return h.hexdigest()
def load(path):return json.loads(regular(path).read_bytes())
def write(name,value):
 need('/' not in name and name not in ['.','..'],'Q_FILENAME');target=Q/name
 with target.open('xb') as f:f.write(canonical(value)+b'\n');f.flush();os.fsync(f.fileno())
 target.chmod(0o600)
def phase(code):print('R485_CLASSIFIER_'+code,flush=True)
def frozen(path,digest,name):
 regular(path,private=True);raw=path.read_bytes();need(sha(raw)==digest,'FROZEN_MODULE_SOURCE_PIN')
 m=types.ModuleType(name);m.__file__=str(path);exec(compile(raw,str(path),'exec'),m.__dict__);return m,raw

def shape_contract(raw,proof,targets):
 tree=ast.parse(raw);method=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='prepare_metadata')
 unsafe=[n.lineno for n in ast.walk(method) if isinstance(n,ast.Subscript) and isinstance(n.value,ast.Name) and n.value.id=='proof' and isinstance(n.slice,ast.Name) and n.slice.id=='kind']
 missing=sorted(set(targets)-set(proof));alias='mcp' in proof
 return {'missing_proof_keys':missing,'mcp_alias_exists':alias,'direct_proof_kind_lookup_lines':unsafe,
  'deterministic_key_shape_error':missing==['tasks-mcp'] and alias and bool(unsafe)}

def health(low,kind,name):
 prefix=("const c=require('/app/server.js').loadConfig();const url='http://127.0.0.1:'+c.port+'/health';" if kind=='tasks-mcp' else
  "const url='http://127.0.0.1:8080"+('/summary?from=2026-11-04&to=2026-11-04' if kind=='crm' else '/health')+"';")
 code=prefix+"(async()=>{const r=await fetch(url,{signal:AbortSignal.timeout(10000)"+(",headers:{'x-api-key':process.env.API_KEY}" if kind=='crm' else '')+"});let json=false;try{await r.json();json=true;}catch{}console.log(JSON.stringify({http_status:r.status,json_body:json}));})().catch(()=>{console.log(JSON.stringify({http_status:0,request_failed:true}));});"
 result=low.run(['docker','exec',name,'node','-e',code],'readonly-health-'+kind,timeout=20)
 value=json.loads(result.stdout);need(isinstance(value.get('http_status'),int),'HEALTH_RESULT_SHAPE');return value

def database(path,kind):
 regular(path);db=sqlite3.connect(Path(path).as_uri()+'?mode=ro',uri=True,timeout=15,isolation_level=None)
 try:
  db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
  integrity=db.execute('PRAGMA integrity_check').fetchall();fk=db.execute('PRAGMA foreign_key_check').fetchall()
  schema=[list(r) for r in db.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name,tbl_name,sql')]
  meta=[[key,db.execute('PRAGMA '+key).fetchone()[0]] for key in ['user_version','application_id','encoding','page_size']]
  result={'integrity_ok':integrity==[('ok',)],'foreign_key_violations':len(fk),'schema_sha256':sha(canonical(schema)),
   'metadata_sha256':sha(canonical(meta)),'watchdog_objects':db.execute("SELECT count(*) FROM sqlite_master WHERE lower(name) LIKE '%watchdog%' OR lower(tbl_name) LIKE '%watchdog%'").fetchone()[0]}
  if kind=='crm':result['schema_versions']=[r[0] for r in db.execute('SELECT version FROM schema_migrations ORDER BY version')]
  result['matches_expected']=result['integrity_ok'] and not fk and result['schema_sha256']==SCHEMAS[kind] and result['metadata_sha256']==META_SHA and result['watchdog_objects']==0 and (kind!='crm' or result['schema_versions']==list(range(1,11)))
  return result
 finally:
  if db.in_transaction:db.execute('ROLLBACK')
  db.close()

def inspect_all(low,proof):
 result={};rows={}
 for kind in ['crm','content','tasks-mcp']:
  row=low.inspect('synapse-'+kind+'-1');key='mcp' if kind=='tasks-mcp' else kind;rows[kind]=row
  result[kind]={'matches_parent482':low.matching_fact(row,proof[key]),'running':row['State']['Running'],'restart_count':row['RestartCount'],'fact':low.fact(row)}
 return rows,result

def report(low,receipt):
 text=MARKER+'\n'+canonical(receipt).decode()
 try:
  need(len(text)<=9000,'REPORT_TOO_LONG')
  result=low.run(['docker','exec','-i','synapse-tasks-mcp-1','node','-e',COMMENT_JS],'task25-redacted-classifier-report',data=canonical({'marker':MARKER,'author':AUTHOR,'text':text}),timeout=120)
  value=json.loads(result.stdout);need(type(value.get('comment_id')) is int,'REPORT_UNKNOWN');write('task25-comment.redacted.json',value);phase('TASK25_REPORTED')
 except Exception:write('report-pending.redacted.json',{'read_task25_before_any_retry':True,'retry_report_only':True,'marker':MARKER});phase('REPORT_PENDING')

def classify(source,low,raw,receipt):
 proofpath=PRIOR/'final-verified.redacted.json';planpath=PRIOR/'release-plan.private.json'
 for file,digest in [(proofpath,PROOF_SHA),(planpath,PLAN_SHA),(P/'release482-onefile-r1.py',SOURCE482_SHA)]:regular(file,private=True);need(filehash(file)==digest,'PARENT482_RAW_PIN')
 proof=load(proofpath);plan=load(planpath)
 need(proof.get('verified') is True and proof.get('merge')=='92208d30d141ce7d1551445749fc2035335fbadd' and proof.get('source_sha256')==SOURCE482_SHA and proof.get('manifest_sha256')=='df5800b3ea54457b1fd05b2ad27421a73b81f9e7bc525e0fb56a41253a6b02f8' and proof.get('release_plan_sha256')==PLAN_SHA,'PARENT482_VERIFIED_SHAPE')
 receipt['parent482']={'proof_sha256':PROOF_SHA,'release_plan_sha256':PLAN_SHA,'source_sha256':SOURCE482_SHA}
 receipt['shape']=shape_contract(raw,proof,source.TARGETS)
 rows,facts=inspect_all(low,proof);receipt['containers']=facts
 need(all(v['matches_parent482'] and v['running'] and v['restart_count']==0 for v in facts.values()),'CURRENT_PARENT482_FACTS_CHANGED')
 receipt['mcp_identity_verified']=True;receipt['people_flags_unchanged']={kind:low.flags(row) for kind,row in rows.items()}
 pins={path:filehash(path)==digest for path,digest in plan['input_pins'].items()};receipt['input_pins']={'count':len(pins),'all_match':all(pins.values()),'expected_map_sha256':sha(canonical(plan['input_pins']))};need(all(pins.values()),'PARENT_INPUT_PIN_CHANGED')
 guards={}
 for path,expected in plan['guards'].items():
  st=regular(path).stat();guards[path]={'sha256':filehash(path),'uid':st.st_uid,'gid':st.st_gid,'mode':stat.S_IMODE(st.st_mode)}==expected
 receipt['guards']=guards;need(len(guards)==5 and all(guards.values()),'GUARD_CHANGED')
 sync={}
 for unit in ['synapse-sync.service','synapse-sync.timer']:sync[unit]=low.run(['systemctl','show',unit,'-p','ActiveState','--value'],'readonly-sync-state').stdout.strip()==b'inactive'
 sync['timer_disabled']=low.run(['systemctl','is-enabled','synapse-sync.timer'],'readonly-sync-enabled',accepted=(0,1,3)).stdout.strip()==b'disabled'
 sync['legacy_sbin_absent']=not Path('/usr/local/sbin/synapse-sync').exists() and not Path('/usr/local/sbin/synapse-sync').is_symlink()
 sync['checkout_head_unchanged']=low.run(['git','--no-optional-locks','-C','/opt/synapse','rev-parse','HEAD'],'readonly-checkout-head').stdout.decode().strip()==low.HOST_HEAD
 receipt['sync_and_checkout']=sync;need(all(sync.values()),'SYNC_OR_CHECKOUT_HEAD_CHANGED')
 receipt['health']={kind:health(low,kind,'synapse-'+kind+'-1') for kind in rows}
 receipt['databases']={kind:database(plan['databases'][kind],kind) for kind in ['crm','content']}
 late=['before-build','online-trial','source','source-before','source-plan.private.json','candidate.json','release-plan.private.json','cold-raw','cold-trial','actual-post','actual-post-fingerprints.private.json','final-verified.redacted.json']
 receipt['late_artifacts']={name:(FAILED/name).exists() or (FAILED/name).is_symlink() for name in late};need(not any(receipt['late_artifacts'].values()),'N1_LATE_STAGE_PRESENT')
 for file in [FAILED/'attempt.once.json',FAILED/'verifier485.cjs',FAILED/'package485/manifest.json']:regular(file,private=True)
 attempt=load(FAILED/'attempt.once.json');need(attempt.get('source_sha256')==SOURCE_SHA and attempt.get('head')==source.HEAD and attempt.get('package_head')==source.PACKAGE_HEAD and attempt.get('merge')==source.MERGE,'N1_ATTEMPT_SOURCE_PIN')
 need(filehash(FAILED/'verifier485.cjs')==source.VERIFY_SHA and filehash(FAILED/'package485/manifest.json')==source.MANIFEST_SHA,'N1_VERIFIER_PACKAGE_PIN')
 package=load(FAILED/'package485/manifest.json');artifact_matches=[]
 for artifact in package['artifacts']:artifact_matches.append(filehash(FAILED/'package485'/artifact['path'])==artifact['sha256'])
 receipt['expected_initial_artifacts']={'attempt':True,'verifier':True,'package_manifest':True,'package_artifacts':len(artifact_matches),'all_package_pins_match':all(artifact_matches)};need(all(artifact_matches),'N1_PACKAGE_ARTIFACT_PIN')
 _,after=inspect_all(low,proof);need(after==facts,'CONTAINER_FACTS_CHANGED_DURING_DIAGNOSTIC')
 need(receipt['shape']['deterministic_key_shape_error'],'EXPECTED_KEY_SHAPE_NOT_CONFIRMED')
 need(all(x['http_status']==200 for x in receipt['health'].values()) and all(x['matches_expected'] for x in receipt['databases'].values()),'BASELINE_HEALTH_OR_SCHEMA_NOT_CONFIRMED')
 receipt.update(verified=True,classification='EARLY_PARENT_PROOF_TASKS_MCP_KEY_SHAPE',late_app_stages_reached=False,installer_replayed=False,original_exception_trace_available=False,old_data_rows_compared=False)

COMMENT_JS="const fs=require('node:fs'),{loadConfig,crmClient}=require('/app/server.js');(async()=>{const x=JSON.parse(fs.readFileSync(0,'utf8')),call=crmClient(loadConfig());let offset=0;for(;;){const t=await call('task_get',{task_id:25,comments_limit:20,comments_offset:offset,subtasks_limit:1}),f=t.comments.find(c=>c.text.startsWith(x.marker+'\\n'));if(f){if(f.author!==x.author||f.text!==x.text)throw Error('MARKER');console.log(JSON.stringify({comment_id:f.id,status:'ALREADY_POSTED'}));return;}offset+=t.comments.length;if(offset>=t.comments_pagination.total)break;if(!t.comments.length)throw Error('PAGE');}const r=await call('task_comment',{task_id:25,author:x.author,text:x.text});if(!Number.isSafeInteger(r.comment?.id))throw Error('COMMENT');console.log(JSON.stringify({comment_id:r.comment.id,status:'POSTED'}));})().catch(()=>{console.error('REPORT_UNKNOWN_READ_TASK25_BEFORE_REPORT_ONLY_RETRY');process.exitCode=1;});"

def main():
 need(sys.platform.startswith('linux') and os.geteuid()==0,'NATIVE_ROOT_ONLY');regular(P,directory=True,private=True)
 need(sp.check_output(['hostname']).decode().strip()=='msk-1-vm-tgnt','HOST_MISMATCH')
 need(filehash(Path(__file__).resolve())==os.environ.get('SB485_CLASSIFIER_SHA'),'CLASSIFIER_SELF_PIN_REQUIRED')
 regular(LOCK);need(LOCK.stat().st_uid==0 and LOCK.stat().st_nlink==1,'ROOT_COMMON_LOCK_REQUIRED')
 import fcntl
 with LOCK.open('rb') as lock:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise Refusal('OTHER_WRITER_LOCK_HELD') from None
  phase('RO_LOCK_ACQUIRED');low=None
  try:
   need(not Q.exists() and not Q.is_symlink(),'DIAGNOSTIC_ALREADY_ATTEMPTED_INSPECT_Q');Q.mkdir(mode=0o700)
   receipt={'verified':False,'source_sha256':filehash(Path(__file__).resolve()),'frozen485_source_sha256':SOURCE_SHA,'source_probe_readonly':True,'report_comment_write':True,'held_common_release_flock':True,'app_mutations':0,'ddl_applied':False,'restarts':0,'old_database_restored':False,'private_rows_or_environment_exported':False,'secretValue':'REDACTED'}
   try:
    source,raw=frozen(SCRIPT,SOURCE_SHA,'frozen485_readonly_classifier');need(source.LOCK==LOCK and source.N==FAILED,'FROZEN_RELEASE_SCOPE')
    low,_=frozen(LIBRARY,LIBRARY_SHA,'frozen477_lowlevel_readonly');low.N=Q;low.B=Q;low.GLOBAL_ENV=None;low.RUN_NUMBER=0
    classify(source,low,raw,receipt);write('receipt.redacted.json',receipt);phase('CLASSIFIED_SOURCE_SHAPE_BASELINE_UNCHANGED')
   except Exception as error:
    receipt['code']=str(error) if isinstance(error,Refusal) else 'PRIVATE_CLASSIFIER_INSPECTION_REQUIRED';write('failure.redacted.json',receipt);phase('INSPECT_ONLY_FAILURE')
   if low is not None and receipt.get('mcp_identity_verified'):report(low,receipt)
   else:phase('REPORT_PENDING')
   return 0 if receipt['verified'] else 1
  finally:fcntl.flock(lock,fcntl.LOCK_UN);phase('RO_LOCK_RELEASED')
if __name__=='__main__':
 try:sys.exit(main())
 except BaseException as error:
  if isinstance(error,SystemExit):raise
  phase('STOP_'+(str(error) if isinstance(error,Refusal) else 'PRIVATE_CLASSIFIER_INSPECTION_REQUIRED'));sys.exit(1)
