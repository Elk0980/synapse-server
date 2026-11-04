#!/usr/bin/env python3
"""Один Owner GET observe + агрегаты БД. Записи только в Q и redacted comment59."""
from pathlib import Path
import fcntl,hashlib,json,os,sqlite3,stat,subprocess as sp,sys
P=Path('/opt/synapse/releases/tasks-mcp-20261103-r1');N=P/'release-485-59-r2';Q=P/'verify485-observe-r1';LOCK=Path('/opt/synapse/.palitra-app-release.lock')
PROOF_SHA='642ada6be28fc42e494b4ed935fcca0f5a0b77c1b3e30ee103f7e01a17a73ff9';PLAN_SHA='d8fcf03d69d7c16f0ab59c90390566e5f296fa21682281e522d510f000b43929';SOURCE_SHA='db5d5648506260d6193a7eb7b275277ae1c6ddd7f3c31b7657d50d3224aedeeb'
MARKER='R485_OBSERVE_API_SQL_READONLY_R1';AUTHOR='Codex — Выпуск PR485/#59'
class Refusal(Exception):pass
def need(ok,code):
 if not ok:raise Refusal(code)
def canon(v):return json.dumps(v,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()
def digest(v):return hashlib.sha256(v).hexdigest()
def regular(p,directory=False,private=False):
 p=Path(p);need(p.is_absolute() and not any(x.is_symlink() for x in [p,*p.parents]),'REGULAR_ABSOLUTE_REQUIRED');st=p.stat();need(stat.S_ISDIR(st.st_mode) if directory else stat.S_ISREG(st.st_mode),'REGULAR_TYPE_REQUIRED')
 if private:need(st.st_uid==0 and stat.S_IMODE(st.st_mode)==(0o700 if directory else 0o600) and (directory or st.st_nlink==1),'PRIVATE_ROOT_METADATA_REQUIRED')
 return p
def filehash(p):return digest(regular(p).read_bytes())
def run(args,data=None):
 r=sp.run(args,input=data,capture_output=True,timeout=45);need(r.returncode==0,'READONLY_COMMAND_FAILED');return r.stdout
def write(name,value):
 with (Q/name).open('xb') as f:f.write(canon(value)+b'\n');f.flush();os.fsync(f.fileno())
 (Q/name).chmod(0o600)
def facts(proof):
 out={}
 for kind,key in [('crm','crm'),('content','content'),('tasks-mcp','mcp')]:
  r=json.loads(run(['docker','inspect','synapse-'+kind+'-1']))[0];env={}
  for v in r['Config'].get('Env') or []:
   k,sep,value=v.partition('=');need(sep and k not in env,'UNAMBIGUOUS_ENV_REQUIRED');env[k]=value
  f={'Id':r['Id'],'Image':r['Image'],'StartedAt':r['State']['StartedAt'],'RestartCount':r['RestartCount'],'Running':r['State']['Running'],'Config':digest(canon(r['Config'])),'Env':digest(canon(env)),'Mounts':digest(canon(sorted(r['Mounts'],key=lambda m:(m.get('Destination',''),m.get('Source',''),m.get('Type',''))))),'Networks':digest(canon({k:v.get('NetworkID') for k,v in r['NetworkSettings']['Networks'].items()}))}
  need(f==proof[key] and f['Running'] and f['RestartCount']==0,'CURRENT_391_FACTS_CHANGED');out[kind]={'matches_391':True,'id':f['Id'],'image':f['Image']}
 return out
def aggregates(path):
 regular(path);db=sqlite3.connect(Path(path).as_uri()+'?mode=ro',uri=True,timeout=15,isolation_level=None)
 try:
  db.execute('PRAGMA query_only=ON');db.execute('BEGIN');r={name:db.execute(sql).fetchone()[0] for name,sql in [('active_tasks','SELECT count(*) FROM tasks WHERE is_deleted=0'),('audits','SELECT count(*) FROM task_watchdog_audits'),('digests','SELECT count(*) FROM task_watchdog_digests'),('mode',"SELECT value FROM task_watchdog_settings WHERE key='mode'")]};return r
 finally:
  if db.in_transaction:db.execute('ROLLBACK')
  db.close()
def agreement(before,after,api):
 stable=before['active_tasks']==after['active_tasks'];return {'sql_task_count_stable':stable,'api_total_matches_stable_sql':stable and api.get('total')==before['active_tasks'],'concurrent_count_change_pending':not stable,'background_rows_seen':after['audits']+after['digests']>0}
OWNER_JS=r"""const {DatabaseSync}=require('node:sqlite'),{COMPANIES}=require('/app/auth-store');let db,row;try{db=new DatabaseSync(process.env.DATABASE_PATH||'/data/content.sqlite',{readOnly:true});db.exec('PRAGMA query_only=ON;BEGIN');row=db.prepare("SELECT id,role,display_name FROM auth_users WHERE role='owner' ORDER BY id LIMIT 1").get();}finally{if(db){if(db.isTransaction)db.exec('ROLLBACK');db.close();}}
(async()=>{if(!row||!Number.isSafeInteger(row.id)||row.id<1||row.role!=='owner'||!Object.hasOwn(COMPANIES,'synapse-business')||!process.env.CRM_API_KEY)throw Error();const identity={v:1,userId:row.id,userName:row.display_name,role:row.role,permissions:[],companyCodes:Object.keys(COMPANIES)};
const response=await fetch((process.env.CRM_URL||'http://crm:8080').replace(/\/$/,'')+'/coordination/watchdog',{method:'GET',headers:{'x-api-key':process.env.CRM_API_KEY,'x-synapse-crm-identity':Buffer.from(JSON.stringify(identity)).toString('base64url')},redirect:'error',signal:AbortSignal.timeout(15000)});const body=await response.text(),out={http_status:response.status,body_length:Buffer.byteLength(body),json_parse_valid:false};let value;
try{value=JSON.parse(body);out.json_parse_valid=true;}catch(error){out.parse_error_class=error instanceof SyntaxError?'SyntaxError':'Error';const offset=/\bposition\s+(\d+)\b/.exec(String(error.message));out.parse_error_offset=offset?Number(offset[1]):null;console.log(JSON.stringify(out));return;}
out.mode=typeof value?.mode==='string'&&['observe','enforce'].includes(value.mode)?value.mode:null;out.delivery_enabled=typeof value?.delivery_enabled==='boolean'?value.delivery_enabled:null;out.total=Number.isSafeInteger(value?.total)?value.total:null;for(const key of ['events','alerts','audits','observations'])out[key+'_length']=Array.isArray(value?.[key])?value[key].length:null;console.log(JSON.stringify(out));})().catch(()=>{console.log(JSON.stringify({http_status:0,json_parse_valid:false,request_failed:true}));process.exitCode=1;});"""
COMMENT_JS=r"""const fs=require('node:fs'),{loadConfig,crmClient}=require('/app/server.js');(async()=>{const x=JSON.parse(fs.readFileSync(0,'utf8')),call=crmClient(loadConfig());let offset=0;for(;;){const r=await call('task_get',{task_id:59,comments_limit:20,comments_offset:offset,subtasks_limit:1}),c=r.comments.find(c=>c.text.startsWith(x.marker+'\n'));if(c){if(c.author!==x.author||c.text!==x.text)throw Error();console.log(JSON.stringify({comment_id:c.id,already_posted:true}));return;}offset+=r.comments.length;if(offset>=r.comments_pagination.total)break;if(!r.comments.length)throw Error();}const r=await call('task_comment',{task_id:59,author:x.author,text:x.text});if(!Number.isSafeInteger(r.comment?.id))throw Error();console.log(JSON.stringify({comment_id:r.comment.id,already_posted:false}));})().catch(()=>{console.error('REPORT_PENDING_READ_TASK59_BEFORE_ANY_RETRY');process.exitCode=1;});"""
def main():
 need(sys.platform.startswith('linux') and os.geteuid()==0,'NATIVE_ROOT_ONLY');regular(P,True,True);need(run(['hostname']).decode().strip()=='msk-1-vm-tgnt','HOST_MISMATCH');need(filehash(Path(__file__).resolve())==os.environ.get('SB485_OBSERVE_SHA'),'SELF_PIN_REQUIRED');regular(LOCK);need(LOCK.stat().st_uid==0 and LOCK.stat().st_nlink==1,'ROOT_RELEASE_LOCK_REQUIRED')
 with LOCK.open('rb') as lock:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise Refusal('OTHER_WRITER_LOCK_HELD') from None
  print('R485_OBSERVE_RO_LOCK_ACQUIRED',flush=True);mcp_verified=False
  try:
   need(not Q.exists() and not Q.is_symlink(),'FRESH_Q_REQUIRED');Q.mkdir(mode=0o700);r={'verified':False,'source_sha256':filehash(Path(__file__).resolve()),'source_probe_readonly':True,'report_comment_write':True,'cookies_or_sessions_used':False,'manual_audit_or_scheduler_called':False,'app_mutations':0,'private_items_exported':False}
   try:
    for p,h in [(N/'final-verified.redacted.json',PROOF_SHA),(N/'release-plan.private.json',PLAN_SHA),(P/'release485-onefile-r2.py',SOURCE_SHA)]:regular(p,private=True);need(filehash(p)==h,'ACTUAL391_PIN_CHANGED')
    proof=json.loads((N/'final-verified.redacted.json').read_bytes());plan=json.loads((N/'release-plan.private.json').read_bytes());need(proof.get('verified') is True and proof.get('source_sha256')==SOURCE_SHA and proof.get('release_plan_sha256')==PLAN_SHA and proof.get('watchdog_mode')=='observe' and proof.get('enforce_enabled') is False and proof.get('installer_audit_or_digest_called') is False,'ACTUAL391_OBSERVE_REQUIRED')
    r['containers']=facts(proof);mcp_verified=True;r['proof_sha256']=PROOF_SHA;r['release_plan_sha256']=PLAN_SHA;r['sql_before']=aggregates(plan['databases']['crm']);r['api']=json.loads(run(['docker','exec','synapse-content-1','node','-e',OWNER_JS]));r['sql_after']=aggregates(plan['databases']['crm']);r.update(agreement(r['sql_before'],r['sql_after'],r['api']));need(facts(proof)==r['containers'],'FACTS_CHANGED_DURING_GET');need(r['api'].get('http_status')==200 and r['api'].get('json_parse_valid') is True and r['api'].get('mode')=='observe' and r['api'].get('delivery_enabled') is False and r['sql_before']['mode']==r['sql_after']['mode']=='observe','OBSERVE_GET_NOT_CONFIRMED');r['verified']=r['api_total_matches_stable_sql'];r['status']='VERIFIED' if r['verified'] else 'CONCURRENT_COUNT_PENDING';write('receipt.redacted.json',r);print('R485_OBSERVE_'+r['status'],flush=True)
   except Exception as error:r['verified']=False;r['code']=str(error) if isinstance(error,Refusal) else 'READONLY_INSPECTION_REQUIRED';write('failure.redacted.json',r);print('R485_OBSERVE_INSPECT_ONLY_FAILURE',flush=True)
   if mcp_verified:
    try:
     text=MARKER+'\n'+canon(r).decode();need(len(text)<=9000,'REPORT_TOO_LONG');v=json.loads(run(['docker','exec','-i','synapse-tasks-mcp-1','node','-e',COMMENT_JS],canon({'marker':MARKER,'author':AUTHOR,'text':text})));need(type(v.get('comment_id')) is int,'REPORT_UNKNOWN');write('task59-comment.redacted.json',v);print('R485_OBSERVE_TASK59_REPORTED',flush=True)
    except Exception:write('report-pending.redacted.json',{'marker':MARKER,'read_task59_before_any_report_only_retry':True});print('R485_OBSERVE_REPORT_PENDING',flush=True)
   return 0 if r['verified'] else 1
  finally:fcntl.flock(lock,fcntl.LOCK_UN);print('R485_OBSERVE_RO_LOCK_RELEASED',flush=True)
if __name__=='__main__':
 try:sys.exit(main())
 except BaseException as error:
  if isinstance(error,SystemExit):raise
  print('R485_OBSERVE_STOP_'+(str(error) if isinstance(error,Refusal) else 'READONLY_INSPECTION_REQUIRED'),flush=True);sys.exit(1)
