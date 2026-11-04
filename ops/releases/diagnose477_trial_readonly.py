#!/usr/bin/env python3
"""Inspect a stopped copy-only PR477 attempt; reproduce only pure read-only capture guard."""
from pathlib import Path
import fcntl,hashlib,json,os,re,sqlite3,stat,subprocess as sp
P=Path('/opt/synapse/releases/tasks-mcp-20261103-r1');N=P/'release-477-40-r1';B=P/'release-477-40-bootstrap-r1'
W=P/'diagnose477-trial-r1';MARKER='PR477_COPY_TRIAL_READONLY_DIAG_R1'
SOURCE477='e13bc8fb6259b88fbdcc647c8adb06139cd909bcf71b651c07a8a8ed03cb325f'
VERIFIER='f1780baeed33495a5bf6d782d1761da83e449b206eee317dbc43ced08cadd2c3'
def need(v):
 if not v:raise RuntimeError('READONLY_PRECONDITION')
def sha(b):return hashlib.sha256(b).hexdigest()
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def load(p):return json.loads(p.read_bytes())
def run(a,timeout=60):
 r=sp.run(a,capture_output=True,timeout=timeout);need(r.returncode==0);return r.stdout
def inspect(n):return json.loads(run(['docker','inspect',n]))[0]
def env(r):return dict(x.split('=',1) for x in r['Config'].get('Env',[]))
def mounts(r):return sorted(r.get('Mounts',[]),key=lambda m:(m['Destination'],m['Source'],m['Type']))
def fact(r):return {'Id':r['Id'],'Image':r['Image'],'StartedAt':r['State']['StartedAt'],'RestartCount':r['RestartCount'],'Running':r['State']['Running'],'Env':sha(canonical(env(r))),'Mounts':sha(canonical(mounts(r))),'Networks':sha(canonical({k:v['NetworkID'] for k,v in r['NetworkSettings']['Networks'].items()})),'Config':sha(canonical(r['Config']))}
def sqlstate(path):
 d=sqlite3.connect(Path(path).as_uri()+'?mode=ro',uri=True,timeout=15)
 try:
  d.execute('PRAGMA query_only=ON');d.execute('BEGIN')
  rows=d.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name,tbl_name,sql').fetchall()
  metadata=[(k,d.execute('PRAGMA '+k).fetchone()[0]) for k in ['user_version','application_id','encoding','page_size']]
  return {'integrity_ok':d.execute('PRAGMA integrity_check').fetchall()==[('ok',)],'fk_violations':len(d.execute('PRAGMA foreign_key_check').fetchall()),'schema_sha256':sha(canonical(rows)),'metadata_sha256':sha(canonical(metadata)),'versions':[x[0] for x in d.execute('SELECT version FROM schema_migrations ORDER BY version')],'agent_objects':sum(x[1].startswith('task_dispatch_agent_') or x[2].startswith('task_dispatch_agent_') for x in rows),'archive_objects':sum(x[1].startswith('module_archive_') or x[2].startswith('module_archive_') for x in rows)}
 finally:d.close()
def health(name,crm=False):
 path='/summary?from=2026-11-03&to=2026-11-03' if crm else '/health'
 prefix=('const url='+json.dumps('http://127.0.0.1:8080'+path)+';' if crm else 'const c=require("/app/server.js").loadConfig();const url="http://127.0.0.1:"+c.port+"/health";')
 code=prefix+'fetch(url,{signal:AbortSignal.timeout(10000)'+(',headers:{"x-api-key":process.env.API_KEY}' if crm else '')+'}).then(r=>console.log(JSON.stringify({status:r.status}))).catch(()=>console.log(JSON.stringify({status:0})));'
 return json.loads(run(['docker','exec',name,'node','-e',code],25))
COMMENT_JS="const fs=require('node:fs'),{loadConfig,crmClient}=require('/app/server.js');(async()=>{const i=JSON.parse(fs.readFileSync(0,'utf8')),call=crmClient(loadConfig());let o=0;for(;;){const t=await call('task_get',{task_id:25,comments_limit:20,comments_offset:o,subtasks_limit:1}),f=t.comments.find(c=>c.text.includes(i.marker));if(f){if(f.author!=='Codex — Выпуск PR477'||f.text!==i.text)throw Error('MARKER');console.log(JSON.stringify({comment_id:f.id}));return;}o+=t.comments.length;if(o>=t.comments_pagination.total)break;if(!t.comments.length)throw Error('PAGE');}const r=await call('task_comment',{task_id:25,author:'Codex — Выпуск PR477',text:i.text});if(!Number.isSafeInteger(r.comment?.id))throw Error('COMMENT');console.log(JSON.stringify({comment_id:r.comment.id}));})().catch(()=>{console.error('REPORT_UNKNOWN');process.exitCode=1;});"
def main():
 os.umask(0o077);need(os.geteuid()==0 and run(['hostname']).strip()==b'msk-1-vm-tgnt')
 need(P.is_dir() and P.stat().st_uid==0 and stat.S_IMODE(P.stat().st_mode)==0o700 and not any(p.is_symlink() for p in [P,*P.parents]))
 need(not W.exists() and not W.is_symlink());fd=os.open('/opt/synapse/.palitra-app-release.lock',os.O_RDWR|os.O_NOFOLLOW)
 try:
  fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);W.mkdir(mode=0o700)
  source=P/'release477-after-archive-r1.py';need(sha(source.read_bytes())==SOURCE477)
  planpath=N/'release-plan.private.json';plan=load(planpath);failure=load(N/'failure.redacted.json')
  need(failure=={'code':'COMMAND_TRIAL_CONSTRUCTOR','stopped':False,'constructor_intent':False,'up_intent':False,'no_blind_retry':True})
  out={'failure':failure,'source_sha256':SOURCE477,'plan_sha256':sha(planpath.read_bytes()),'source_plan_sha256':sha((N/'source-plan.private.json').read_bytes()),'services':{},'candidate_images':{},'guards':{},'input_pins_match':all(sha(Path(p).read_bytes())==h for p,h in plan['input_pins'].items()),'late_artifacts':{s:(N/s).exists() for s in ['cold-raw','actual-post-fingerprint.private.json','final-verified.redacted.json']}}
  for s in ['crm','tasks-mcp']:
   row=inspect('synapse-'+s+'-1');before=plan['before'][s]
   out['services'][s]={'same_fact':fact(row)==fact(before),'hostconfig_equal':row['HostConfig']==before['HostConfig'],'fact':fact(row),'health':health('synapse-'+s+'-1',s=='crm')}
   image=json.loads(run(['docker','image','inspect',plan['images'][s]]))[0];base=json.loads(run(['docker','image','inspect',before['Image']]))[0]
   out['candidate_images'][s]={'id':image['Id'],'config_equal_parent':image['Config']==base['Config'],'parent_layers_prefix':image['RootFS']['Layers'][:len(base['RootFS']['Layers'])]==base['RootFS']['Layers']}
  content=inspect('synapse-content-1');out['content_same_fact']=fact(content)==plan['content_before']
  current=sqlstate(plan['databases']['crm']);out['crm_database']=current
  need(current['agent_objects']==0 and current['archive_objects']==24 and current['integrity_ok'] and current['fk_violations']==0)
  for p,v in plan['guards'].items():
   st=Path(p).stat();out['guards'][p]=sha(Path(p).read_bytes())==v['sha256'] and (st.st_uid,st.st_gid,stat.S_IMODE(st.st_mode))==(v['uid'],v['gid'],v['mode'])
  verify=B/'verifier477.cjs';before=N/'online-trial/crm/before.sqlite';need(sha(verify.read_bytes())==VERIFIER)
  name='sb477-diag-copyguard-r1';need(not run(['docker','ps','-aq','--filter','name=^/'+name+'$']).strip())
  code='const {DatabaseSync}=require("node:sqlite"),v=require("/verify.cjs"),d=new DatabaseSync("/input/before.sqlite",{readOnly:true});try{d.exec("PRAGMA query_only=ON;BEGIN");v.capture(d);console.log(JSON.stringify({capture_passed:true}));}catch(e){if(!(e instanceof v.Refusal)||!/^[A-Z0-9_]+$/.test(e.message))throw Error("UNKNOWN");console.log(JSON.stringify({capture_passed:false,code:e.message}));}finally{if(d.isTransaction)d.exec("ROLLBACK");d.close();}'
  raw=run(['docker','run','--rm','--name',name,'--network','none','--read-only','--user','0','--entrypoint','node','--mount',f'type=bind,src={verify},dst=/verify.cjs,readonly','--mount',f'type=bind,src={before},dst=/input/before.sqlite,readonly',plan['images']['crm'],'-e',code],120)
  out['pure_readonly_capture_reproduction']=json.loads(raw);need(out['pure_readonly_capture_reproduction']=={'capture_passed':False,'code':'ARCHIVE_MIGRATION_NOT_AUTHORIZED'})
  out['live_ddl_executed']=False;out['application_restarts']=0;out['database_restored']=False;out['diagnostic_helper_removed']=not run(['docker','ps','-aq','--filter','name=^/'+name+'$']).strip()
  out['baseline_after_readonly_same']=all(fact(inspect('synapse-'+s+'-1'))==fact(plan['before'][s]) for s in ['crm','tasks-mcp']) and fact(inspect('synapse-content-1'))==plan['content_before']
  data=canonical(out);receipt=W/'receipt.redacted.json'
  f=os.open(receipt,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  with os.fdopen(f,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
  print('PR477_READONLY_DIAG_VERIFIED',flush=True)
 finally:os.close(fd)
 text=MARKER+'\n'+data.decode();need(len(text)<9500)
 r=sp.run(['docker','exec','-i','synapse-tasks-mcp-1','node','-e',COMMENT_JS],input=canonical({'marker':MARKER,'text':text}),capture_output=True,timeout=120)
 if r.returncode==0:print('PR477_READONLY_DIAG_REPORTED',json.loads(r.stdout)['comment_id'],flush=True)
 else:print('PR477_READONLY_DIAG_REPORT_PENDING_INSPECT_ONLY',flush=True)
if __name__=='__main__':
 try:main()
 except BaseException:print('PR477_READONLY_DIAG_STOP_INSPECT_ONLY',flush=True);raise SystemExit(1)
