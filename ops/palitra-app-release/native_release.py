"""Native code-only preflight/build/static apply/rollback. No activation or DB writes."""
import argparse,base64,os,subprocess,sys,zipfile
from pathlib import Path
from release_common import *
CRM_FILES=tuple('palitra-crm/app/lib/'+n for n in ['api-routes.js','crm-access.js','crm-http.js','email-address.js','email-fallback.js','email-transport.js','host-integration.js','instagram-hook.js','team-notify.js','telegram-team-transport.js','workspace.js'])+tuple('palitra-crm/app/public/'+n for n in ['app.css','app.js','crm-session.js','miniapp.html','site.html'])+('palitra-crm/telegram-ingest/lib/telegram-ingest.js',)
APP_FILES=tuple(['assets/editor-fonts.css','assets/k01-celebration-bg.png','design-data.js','native-host.js','shell.css','shell.js','shop.html','synapse-bridge.js']+['assets/fonts/'+f+'/'+name for f in ['inter','lora','montserrat','nunito-sans','open-sans','roboto'] for name in ['OFL.txt',f+'-italic.ttf',f+'-normal.ttf']])
APP_RUNTIME={'palitra-orders-public/'+f for f in APP_FILES}
ALLOWED={'synapse-content-1':set(['server.js','client-dialogs.js','palitra-host-adapter.cjs','site-orders.js','draft-account-service.cjs','site-workspace-http.js','site-workspace-feature.js','project-forms.cjs','customer-chat.js','customer-chat-http.cjs','customer-chat-native-adapter.cjs','customer-chat-media.cjs','customer-chat-upload.cjs','palitra-review-public/palitra-chat.html','palitra-review-public/palitra-chat.js','palitra-review-public/palitra-chat.css',*CRM_FILES,*APP_RUNTIME]),'synapse-chat-1':{'client-bot-bridge.js'}}
def run(args):
 r=subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=300,shell=False)
 need(r.returncode==0,'Native command refused; inspect its private journal');return r.stdout
def manifest(bundle,expected):
 bundle=safe(bundle);raw=read(bundle/'manifest.json');need(sha(raw)==expected,'Independent bundle manifest SHA mismatch');m=obj(raw)
 need(m.get('schema')==1 and m.get('status')=='SOURCE_ONLY_NOT_INSTALLED' and m.get('flagsEnabled') is False and m.get('dbWrites') is False,'Unsafe manifest')
 need(m['images']=={'content':CONTENT,'worker':WORKER},'Immutable base mismatch')
 for name,row in m['sourceFiles'].items():
  need(sha(read(under(bundle,name)))==row['sha256'],'Payload changed: '+name)
 return m
def extract(archive,output,expected_archive,expected_manifest):
 need(sha(read(archive,128*1024*1024))==expected_archive,'Archive pin mismatch');safe(output,True);need(not output.exists(),'Extraction output exists/unknown execution')
 with zipfile.ZipFile(archive) as z:
  infos=z.infolist();names=[i.filename for i in infos];need(len(names)==len(set(names)) and len(names)<=500,'Duplicate/large ZIP inventory')
  need(sum(i.file_size for i in infos)<=128*1024*1024,'ZIP oversized')
  for i in infos:relative(i.filename);need(not i.is_dir() and (i.external_attr>>16)&0o170000 != 0o120000,'ZIP symlink/directory refused')
  raw=z.read('manifest.json');need(sha(raw)==expected_manifest,'Manifest ZIP pin mismatch');m=obj(raw)
  need(set(names)==set(m['sourceFiles'])|{'manifest.json'},'Unexpected archive members')
  for name,row in m['sourceFiles'].items():need(sha(z.read(name))==row['sha256'],'Archive payload mismatch')
  output.mkdir()
  for name in names:
   p=under(output,name,True);p.parent.mkdir(parents=True,exist_ok=True);safe(p,True)
   with p.open('xb') as f:f.write(z.read(name))
 return {'status':'EXTRACTED_SOURCE_ONLY','files':len(names)}
def docker_image(container,runner=run):return runner(['docker','inspect','--format','{{.Image}}',container]).decode('ascii').strip()
def docker_read(container,target,runner=run):
 relative(target);need(container in ALLOWED and target in ALLOWED[container],'Docker source outside fixed allowlist');pathname='/app/'+target
 # A single explicit fixed path; no require, environment, DB or shell.
 code="const f=require('fs'),p=process.argv[1],q=require('path');let missing=false;for(let x=p;x!==q.dirname(x);x=q.dirname(x)){try{const s=f.lstatSync(x);if(s.isSymbolicLink()||(x!==p&&!s.isDirectory()))process.exit(31)}catch(e){if(e.code==='ENOENT'){missing=true;continue}throw e}};if(missing){process.stdout.write('ABSENT');process.exit(0)};const fd=f.openSync(p,f.constants.O_RDONLY|(f.constants.O_NOFOLLOW||0));try{const a=f.fstatSync(fd);if(!a.isFile()||a.size>16777216)process.exit(31);const d=f.readFileSync(fd),b=f.fstatSync(fd),c=f.lstatSync(p);if(c.isSymbolicLink()||a.ino!==b.ino||a.dev!==b.dev||a.size!==b.size||a.mtimeMs!==b.mtimeMs||a.ino!==c.ino||a.dev!==c.dev||f.realpathSync(p)!==p||d.length!==a.size)process.exit(31);process.stdout.write(d.toString('base64'))}finally{f.closeSync(fd)};"
 raw=runner(['docker','exec',container,'node','-e',code,'--',pathname]);return None if raw==b'ABSENT' else base64.b64decode(raw,validate=True)
def verify_lease(m,runner=run):
 rows=runner(['lslocks','--noheadings','--output','PID,PATH']).decode().splitlines()
 need(any(line.strip().split(maxsplit=1)==[str(m['lease']['pid']),m['lease']['path']] for line in rows),'Root lease absent/changed')
def static_target(m,row):
 need(row['group'] in ['cabinet','customer'],'Unknown static group')
 if row['group']=='cabinet':need(m['roots']['cabinet']=='/opt/synapse/sites/synapse','Cabinet root changed')
 root=safe(Path(m['roots'][row['group']]));need(root.is_dir() and root!=Path(root.anchor),'Explicit real root required')
 relative(row['target']);name=row['target']
 need((row['group']=='cabinet' and (name=='cabinet.html' or name.startswith('cabinet/'))) or (row['group']=='customer' and name=='assets/order.js'),'Static target outside scope')
 return under(root,name,True)
def preflight(bundle,m,runner=run,lease=True):
 if lease:verify_lease(m,runner)
 need(docker_image('synapse-content-1',runner)==CONTENT and docker_image('synapse-chat-1',runner)==WORKER,'Current container image changed')
 for row in m['capture']['inventory']:
  target=row['target']
  if target.startswith('content/'):
   data=docker_read('synapse-content-1',target[8:],runner);pin=None if data is None else sha(data);need(pin==row['sha256'],'Current runtime bytes changed: '+target)
  elif target.startswith('ops/chat/'):
   data=docker_read('synapse-chat-1',target[9:],runner);need(data is not None and sha(data)==row['sha256'],'Worker source changed')
  elif target.startswith('sites/synapse/') or target=='managed-site/assets/order.js':
   group='customer' if target.startswith('managed-site/') else 'cabinet'
   name=target.removeprefix('managed-site/' if group=='customer' else 'sites/synapse/')
   p=static_target(m,{'group':group,'target':name})
   need((sha(read(p)) if p.exists() else None)==row['sha256'],'Captured static bytes changed: '+target)
  else:raise Refused('Unknown capture target')
 for row in m['content']:
  data=docker_read('synapse-content-1',row['target'],runner);need((None if data is None else sha(data))==row['baseSha256'],'Image target BASE changed')
 seen=set()
 for row in m['static']:
  p=static_target(m,row);need(p not in seen,'Duplicate static destination');seen.add(p)
  current=sha(read(p)) if p.exists() else None;need(current==row['baseSha256'],'Static BASE changed: '+row['target'])
 if lease:verify_lease(m,runner)
 return {'status':'NATIVE_PREFLIGHT_ONLY','contentCopies':len(m['content']),'workerCopies':len(m['worker']),'staticFiles':len(m['static']),'activation':False,'dbWrites':0}
def journal_new(path,m,phase):
 safe(path,True);need(not path.exists(),'Existing journal: execution unknown; never repeat blindly');need(path.parent.is_dir(),'Journal parent missing')
 with path.open('xb') as f:f.write(json_bytes({'releaseId':m['releaseId'],'phase':phase}))
def write_journal(path,value):
 temp=path.with_name(path.name+'.pending');safe(temp,True);need(not temp.exists(),'Pending journal exists')
 with temp.open('xb') as f:f.write(json_bytes(value));f.flush();os.fsync(f.fileno())
 os.replace(temp,path)
def build(bundle,m,journal,apply,runner=run):
 need(apply is True,'Explicit --apply required');preflight(bundle,m,runner);journal_new(journal,m,'BUILD_STARTED_UNKNOWN')
 tag='palitra-combined:'+m['releaseId'];need(runner(['docker','image','ls','--quiet',tag]).strip()==b'','Unique child image tag already exists')
 runner(['docker','build','--network=none','--pull=false','--tag',tag,'--file',str(bundle/'Dockerfile'),str(bundle)])
 result={'releaseId':m['releaseId'],'phase':'BUILT_NOT_ACTIVATED','contentTag':tag,'contentImage':runner(['docker','image','inspect','--format','{{.Id}}',tag]).decode().strip()}
 if m['worker']:
  tagw='palitra-chat-combined:'+m['releaseId'];need(runner(['docker','image','ls','--quiet',tagw]).strip()==b'','Worker child tag exists')
  runner(['docker','build','--network=none','--pull=false','--tag',tagw,'--file',str(bundle/'Dockerfile.worker'),str(bundle)])
  result.update({'workerTag':tagw,'workerImage':runner(['docker','image','inspect','--format','{{.Id}}',tagw]).decode().strip()})
 write_journal(journal,result);return result
def apply_static(bundle,m,journal,backup,apply,runner=run,lease=True):
 need(apply is True,'Explicit --apply required');preflight(bundle,m,runner,lease);safe(backup,True);need(not backup.exists() and backup.parent.is_dir(),'New explicit backup directory required')
 journal_new(journal,m,'STATIC_STARTED_UNKNOWN');backup.mkdir(mode=0o700);records=[]
 # Back up every existing code target before any destination update. No DB/media copies.
 for index,row in enumerate(m['static']):
  p=static_target(m,row);old=read(p) if p.exists() else None
  if old is not None:
   q=backup/str(index)
   with q.open('xb') as f:f.write(old)
  records.append({'target':str(p),'index':index,'baseSha256':row['baseSha256'],'newSha256':row['sha256'],'mode':p.stat().st_mode&0o777 if p.exists() else 0o644,'written':False})
 state={'releaseId':m['releaseId'],'phase':'STATIC_APPLYING','backup':str(backup),'records':records};write_journal(journal,state)
 for row,rec in zip(m['static'],records):
  if lease:verify_lease(m,runner)
  p=Path(rec['target']);current=sha(read(p)) if p.exists() else None;need(current==rec['baseSha256'],'Destination changed before update')
  if current==rec['newSha256']:continue
  p.parent.mkdir(parents=True,exist_ok=True);safe(p,True);temp=p.with_name(p.name+'.'+m['releaseId']+'.pending');safe(temp,True);need(not temp.exists(),'Existing pending update: unknown execution')
  data=read(under(bundle,row['payload']));need(sha(data)==rec['newSha256'],'Payload changed during apply')
  with temp.open('xb') as f:f.write(data);f.flush();os.fsync(f.fileno())
  os.chmod(temp,rec['mode']);need((sha(read(p)) if p.exists() else None)==rec['baseSha256'],'Destination changed before atomic replace');os.replace(temp,p)
  need(sha(read(p))==rec['newSha256'],'Atomic readback failed');rec['written']=True;write_journal(journal,state)
 state['phase']='STATIC_APPLIED_CODE_ONLY';write_journal(journal,state);return {'status':state['phase'],'files':sum(r['written'] for r in records),'dbWrites':0,'activation':False}
def rollback_static(m,journal,apply,runner=run,lease=True):
 need(apply is True,'Explicit --apply required');state=load(journal);need(state.get('releaseId')==m['releaseId'] and state.get('phase') in ['STATIC_APPLIED_CODE_ONLY','STATIC_APPLYING'],'Unknown/incomplete execution requires manual inventory')
 if lease:verify_lease(m,runner)
 backup=safe(Path(state['backup']));expected={str(static_target(m,row)):row for row in m['static']}
 need(len(state['records'])==len(expected) and {r['target'] for r in state['records']}==set(expected),'Rollback inventory changed')
 for index,rec in enumerate(state['records']):
  need(type(rec['index']) is int and rec['index']==index and rec['target'] in expected and rec['baseSha256']==expected[rec['target']]['baseSha256'] and rec['newSha256']==expected[rec['target']]['sha256'] and type(rec['written']) is bool,'Rollback record changed')
  p=safe(Path(rec['target']),True);pin=sha(read(p)) if p.exists() else None
  need(pin==(rec['newSha256'] if rec['written'] else rec['baseSha256']),'Unknown/live-changed rollback state')
  if rec['baseSha256'] is not None:need(sha(read(under(backup,str(index))))==rec['baseSha256'],'Backup pin changed')
 for rec in reversed(state['records']):
  if lease:verify_lease(m,runner)
  need(rec['target'] in expected and rec['newSha256']==expected[rec['target']]['sha256'],'Rollback target outside signed plan')
  p=safe(Path(rec['target']),True)
  if not rec['written']:need((sha(read(p)) if p.exists() else None)==rec['baseSha256'],'Uncertain write requires manual inventory');continue
  need(p.exists() and sha(read(p))==rec['newSha256'],'Live code changed; rollback refused')
  if rec['baseSha256'] is None:p.unlink()
  else:
   data=read(under(backup,str(rec['index'])));need(sha(data)==rec['baseSha256'],'Backup changed');temp=p.with_name(p.name+'.rollback.pending');safe(temp,True);need(not temp.exists(),'Rollback pending exists')
   with temp.open('xb') as f:f.write(data)
   os.chmod(temp,rec['mode']);os.replace(temp,p)
 state['phase']='STATIC_ROLLED_BACK_CODE_ONLY';write_journal(journal,state);return {'status':state['phase'],'dbWrites':0}
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('operation',choices=['preflight','build','static-apply','static-rollback','extract'])
 p.add_argument('--bundle',type=Path);p.add_argument('--expected-manifest-sha',required=True);p.add_argument('--journal',type=Path);p.add_argument('--backup',type=Path);p.add_argument('--apply',action='store_true');p.add_argument('--archive',type=Path);p.add_argument('--expected-archive-sha');p.add_argument('--output',type=Path)
 a=p.parse_args()
 try:
  if a.operation=='extract':result=extract(a.archive,a.output,a.expected_archive_sha,a.expected_manifest_sha)
  else:
   m=manifest(a.bundle,a.expected_manifest_sha)
   if a.operation=='preflight':result=preflight(a.bundle,m)
   elif a.operation=='build':result=build(a.bundle,m,a.journal,a.apply)
   elif a.operation=='static-apply':result=apply_static(a.bundle,m,a.journal,a.backup,a.apply)
   else:result=rollback_static(m,a.journal,a.apply)
  print(json.dumps(result,ensure_ascii=False));return 0
 except (Refused,OSError,ValueError,KeyError,TypeError,subprocess.TimeoutExpired) as e:print(json.dumps({'status':'REFUSED','reason':str(e)},ensure_ascii=False));return 2
if __name__=='__main__':sys.exit(main())
