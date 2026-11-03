#!/usr/bin/env python3
"""Read-only Compose context comparison; values stay in memory, only names/hashes are reported."""
from pathlib import Path
import hashlib,json,os,stat,subprocess as sp
P=Path('/opt/synapse/releases/tasks-mcp-20261103-r1')
N=P/'release-478-35-r4'
def need(x): 
 if not x: raise RuntimeError('READONLY_CONTEXT_STOP')
def load(p):return json.loads(Path(p).read_bytes())
def sha(v):return hashlib.sha256(v).hexdigest()
def run(a,env=None):
 r=sp.run(a,capture_output=True,timeout=120,env=env);need(r.returncode==0);return r.stdout
def envmap(r):return dict(x.split('=',1) for x in r['Config'].get('Env',[]))
def mountsort(r):return sorted(r['Mounts'],key=lambda x:(x['Destination'],x['Source'],x['Type']))
def fact(r):return {'id':r['Id'],'image':r['Image'],'started':r['State']['StartedAt'],'restarts':r['RestartCount'],'running':r['State']['Running'],'config':r['Config'],'mounts':mountsort(r),'networks':{k:v['NetworkID'] for k,v in r['NetworkSettings']['Networks'].items()}}
def canonical(x):return json.dumps(x,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
def paths(c,flags):return [c[i+1] for i,x in enumerate(c[:-1]) if x in flags]
def subseq(a,b):
 it=iter(b);return all(any(y==x for y in it) for x in a)
def lockfree():return not any(x.get('path')=='/opt/synapse/.palitra-app-release.lock' for x in json.loads(run(['lslocks','--json','-o','PID,PATH'])).get('locks',[]))
def image(i):return json.loads(run(['docker','image','inspect',i]))[0]
def settings(cfg,service,row):
 s=cfg['services'][service];old=envmap(row);given=s.get('environment') or {}
 parent={x.split('=',1)[0]:x.split('=',1)[1] for x in image(row['Image'])['Config'].get('Env',[]) }
 expected={**parent,**given}
 diff=sorted(k for k in set(expected)|set(old) if expected.get(k)!=old.get(k))
 return {'image_matches':image(s['image'])['Id']==row['Image'],'environment_matches':not diff,'environment_different_keys':diff}
def main():
 os.umask(0o077);need(os.geteuid()==0 and run(['hostname']).decode().strip()=='msk-1-vm-tgnt' and lockfree())
 target=N/'context-diagnostic.redacted.json';need(not target.exists() and not target.is_symlink())
 meta=load(N/'metadata.redacted.json');rows=load(N/'containers.private.json')
 for oldrow in rows:
  need(fact(json.loads(run(['docker','inspect',oldrow['Id']]))[0])==fact(oldrow))
 plan=load(N/'prepared-plan476.private.json');childenv=load(plan['child_environment_file'])
 common=load(N/'compose-contexts.private.json')['pr476_full_recipe'];need(common[:2]==['docker','compose'])
 files=paths(common,{'-f','--file'});envs=paths(common,{'--env-file'})
 rendered=json.loads(run(common+['config','--format','json'],childenv))
 profiles=[];i=2
 while i<len(common):
  flag,value=common[i:i+2];need(flag in ['--env-file','-f','--file','-p','--project-name','--project-directory','--profile','--ansi','--progress'])
  if flag in ['--profile','--ansi','--progress']:profiles.extend([flag,value])
  i+=2
 report={'source_probe_readonly':True,'report_comment_write':True,'lock_free':True,'baseline_unchanged':True,'r1_file_count':len(files),'r1_env_files':envs,'services':[]}
 private={'common':common,'own_commands':{}}
 for service in ['crm','content','tasks-mcp']:
  row=next(r for r in rows if r['Name']=='/synapse-'+service+'-1');ctx=meta['contexts'][service]
  envfiles=list(ctx['environment_files'])
  if not envfiles and (Path(ctx['working_directory'])/'.env').is_file():envfiles=[str(Path(ctx['working_directory'])/'.env')]
  own=['docker','compose','--project-directory',ctx['working_directory'],'-p','synapse',*profiles]
  for p in envfiles:own+=['--env-file',p]
  if plan['canonical_environment_file'] not in envfiles:own+=['--env-file',plan['canonical_environment_file']]
  for p in ctx['config_files']:own+=['-f',p]
  private['own_commands'][service]=own
  owncfg=json.loads(run(own+['config','--format','json'],childenv))
  entry={'service':service,'config_files_covered':subseq(ctx['config_files'],files),'env_files_covered':subseq(ctx['environment_files'],envs),
   'actual_config_count':len(ctx['config_files']),'actual_environment_files':ctx['environment_files'],'working_directory':ctx['working_directory'],
   'config_missing_paths':[p for p in ctx['config_files'] if p not in files],
   'env_missing_paths':[p for p in ctx['environment_files'] if p not in envs],
   'r1_settings':settings(rendered,service,row),'own_settings':settings(owncfg,service,row),
   'own_content_service_equal_r1':owncfg['services'].get('content')==rendered['services'].get('content'),
   'own_service_equal_r1':owncfg['services'][service]==rendered['services'][service]}
  report['services'].append(entry)
 for oldrow in rows:need(fact(json.loads(run(['docker','inspect',oldrow['Id']]))[0])==fact(oldrow))
 need(lockfree())
 for p,expected in meta['guards'].items():need(sha(Path(p).read_bytes())==expected['sha256'])
 private['source_files_sha256']={p:sha(Path(p).read_bytes()) for c in [common,*private['own_commands'].values()] for p in paths(c,{'-f','--file','--env-file'})}
 p=N/'context-commands.private.json'
 with p.open('xb') as f:f.write(canonical(private));f.flush();os.fsync(f.fileno())
 p.chmod(0o600)
 with target.open('xb') as f:f.write(canonical(report));f.flush();os.fsync(f.fileno())
 target.chmod(0o600)
 print('R478_CONTEXT_DIAGNOSTIC_DONE',flush=True)
 text='R478_CONTEXT_DIAG_R4\n'+canonical(report).decode()
 if len(text)>9500:print('R478_CONTEXT_REPORT_PENDING_LIMIT',flush=True);return
 try:
  r=sp.run(['docker','exec','-i','synapse-tasks-mcp-1','node','-e',COMMENT_JS],input=canonical({'marker':'R478_CONTEXT_DIAG_R4','text':text}),capture_output=True,timeout=120)
  need(r.returncode==0);out=json.loads(r.stdout);need(isinstance(out.get('comment_id'),int))
  print('R478_CONTEXT_REPORT',json.dumps(out),flush=True)
 except Exception:print('R478_CONTEXT_REPORT_PENDING_INSPECT35_NO_REPLAY',flush=True)
COMMENT_JS="const fs=require('node:fs'),{loadConfig,crmClient}=require('/app/server.js');(async()=>{const i=JSON.parse(fs.readFileSync(0,'utf8')),c=crmClient(loadConfig());let o=0;for(;;){const t=await c('task_get',{task_id:35,comments_limit:20,comments_offset:o,subtasks_limit:1});const f=t.comments.find(x=>x.text.includes(i.marker));if(f){if(f.author!=='Codex — Выпуск PR478/#35'||f.text!==i.text)throw Error('MARKER');console.log(JSON.stringify({comment_id:f.id,status:'ALREADY_POSTED'}));return;}o+=t.comments.length;if(o>=t.comments_pagination.total)break;if(!t.comments.length)throw Error('PAGE');}const r=await c('task_comment',{task_id:35,author:'Codex — Выпуск PR478/#35',text:i.text});if(!Number.isSafeInteger(r.comment?.id))throw Error('COMMENT');console.log(JSON.stringify({comment_id:r.comment.id,status:'POSTED'}));})().catch(()=>{console.error('REPORT_UNKNOWN');process.exitCode=1;});"
if __name__=='__main__':
 try:main()
 except Exception:print('R478_CONTEXT_STOP_READONLY_INSPECTION_REQUIRED',flush=True);raise SystemExit(1)
