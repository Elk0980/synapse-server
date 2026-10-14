"""Root-only two-service image activation. Preparation has no native calls.
Runtime: selected inspect, explicit check/apply/rollback; no build/pull/DB/API.
"""
import argparse,hashlib,json,os,re,stat,subprocess,sys
from pathlib import Path
ROOT=Path('/opt/synapse/releases/palitra-app-20261015');PID=2744197;LOCK='/opt/synapse/.palitra-app-release.lock'
OLD={'content':'sha256:8a98cf8656cc139e6cbb842f81bc05e20c534065b2274063629b18c32db3fa72','chat':'sha256:c5dd4502daf630afaac7415da5b19dc456c81a5f81626574f5480dec04307cca'}
CONTAINERS={'content':'synapse-content-1','chat':'synapse-chat-1'}
FLAGS=['PALITRA_CHECKOUT_ENABLED','PALITRA_CRM_ENABLED','PALITRA_CUSTOMER_CHAT_ENABLED','PALITRA_WEB_UPLOADS_ENABLED'];ORIGINS=['PALITRA_MAIN_ORIGIN','PALITRA_SHOP_ORIGIN','PALITRA_CRM_SYNAPSE_ORIGIN'];BOT='PALITRA_CRM_BOT_ID';ALLOWED=FLAGS+ORIGINS+[BOT]
LABELS=r'{"image":{{json .Image}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"workingDir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"configFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}},"configHash":{{json (index .Config.Labels "com.docker.compose.config-hash")}},"running":{{json .State.Running}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}'
ENV="const out={};for(const k of "+json.dumps(ALLOWED)+"){out[k]=process.env[k]===undefined?null:process.env[k]};console.log(JSON.stringify(out));"
class Refused(Exception):pass
def need(v,m):
 if not v:raise Refused(m)
def sha(b):return hashlib.sha256(b).hexdigest()
def obj(b):
 def pairs(items):
  d={}
  for k,v in items:need(k not in d,'Duplicate JSON key');d[k]=v
  return d
 try:return json.loads(b.decode('utf8'),object_pairs_hook=pairs)
 except (ValueError,UnicodeError):raise Refused('Malformed private JSON')
def data(v):return (json.dumps(v,ensure_ascii=False,indent=2)+'\n').encode()
def path(p,missing=False):
 p=Path(p);need(p.is_absolute() and '..' not in p.parts,'Absolute verified path required')
 for x in [*reversed(p.parents),p]:
  try:s=x.lstat()
  except FileNotFoundError:need(missing,'Required path absent');continue
  need(not stat.S_ISLNK(s.st_mode) and not(getattr(s,'st_file_attributes',0)&0x400),'Symlink/reparse refused')
  if x!=p:need(stat.S_ISDIR(s.st_mode),'Non-directory parent')
 return p
def read(p):
 p=path(p);s=p.stat();need(stat.S_ISREG(s.st_mode) and 0<s.st_size<=16*1024*1024,'Bounded regular file required');fd=os.open(p,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
 try:
  with os.fdopen(fd,'rb',closefd=False) as f:b=f.read(16*1024*1024+1)
  t=os.fstat(fd);u=p.stat();need((s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns)==(t.st_dev,t.st_ino,t.st_size,t.st_mtime_ns)==(u.st_dev,u.st_ino,u.st_size,u.st_mtime_ns),'File changed during read');return b
 finally:os.close(fd)
def create(p,v):
 p=path(p,True);need(not p.exists() and p.parent.is_dir(),'New private artifact required');fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'wb') as f:f.write(data(v));f.flush();os.fsync(f.fileno())
def replace(p,v):
 temp=Path(str(p)+'.pending');create(temp,v);os.replace(temp,p)
def native(args):
 # Compose's project directory and process cwd must both match captured labels.
 cwd=str(path(args[args.index('--project-directory')+1])) if 'compose' in args and '--project-directory' in args else None
 r=subprocess.run(args,capture_output=True,stdin=subprocess.DEVNULL,shell=False,timeout=180,cwd=cwd)
 need(r.returncode==0,'Native command failed/unknown; inspect private journal, do not retry');return r.stdout
def image(v):return type(v)is str and re.fullmatch(r'sha256:[0-9a-f]{64}',v) is not None
class Activate:
 def __init__(self,root=ROOT,runner=native):self.root=path(root);self.run=runner
 def lease(self):
  rows=self.run(['lslocks','--noheadings','--output','PID,PATH']).decode().splitlines();need(any(x.strip().split(maxsplit=1)==[str(PID),LOCK] for x in rows),'Root lease absent/changed')
 def selected(self,service):
  v=obj(self.run(['docker','exec',CONTAINERS[service],'node','-e',ENV]));need(set(v)==set(ALLOWED),'Unapproved selected env fields')
  for k in FLAGS:need(v[k] is None or v[k] in ['true','false'],'Invalid selected flag')
  for k in ORIGINS:need(v[k] is None or v[k] in ['','https://palitra-love.ru','https://palitra-love-draft-1.synapsebusiness.ru','https://synapse.synapsebusiness.ru'],'Unknown origin')
  need(v[BOT] in [None,''] or (type(v[BOT])is str and re.fullmatch(r'[1-9][0-9]{0,19}',v[BOT]) is not None),'Invalid numeric botID');return v
 def metadata(self,service):
  m=obj(self.run(['docker','inspect','--format',LABELS,CONTAINERS[service]]));need(set(m)=={'image','project','service','workingDir','configFiles','configHash','running','health'} and image(m['image']) and re.fullmatch(r'[0-9a-f]{64}',m.get('configHash') or '') is not None and m['service']==service and type(m['project'])is str and re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}',m['project']) is not None,'Wrong existing Compose service/project/image/config-hash')
  need(m['running'] is True and m['health'] in [None,'healthy','starting','unhealthy'],'Existing container not running');wd=path(m['workingDir']);need(wd.is_dir() and type(m['configFiles'])is str and m['configFiles'],'Actual Compose paths missing')
  files=m['configFiles'].split(',');need(len(files)==len(set(files)) and 1<=len(files)<=12,'Duplicate/too many Compose files');pins={}
  for name in files:
   p=path(name);need(p.suffix.lower() in ['.yml','.yaml','.json'],'Unreviewed Compose file type');pins[name]=sha(read(p))
  m['files']=files;m['filePins']=pins;return m
 def snapshot(self):
  self.lease();before={s:self.metadata(s) for s in CONTAINERS};configs={s:self.selected(s) for s in CONTAINERS};proof=self.hashproof(before);after={s:self.metadata(s) for s in CONTAINERS};need(before==after and configs=={s:self.selected(s) for s in CONTAINERS},'Concurrent image/Compose/config source change');self.lease()
  return {'schema':1,'status':'SELECTED_NATIVE_FACTS_NOT_APPROVED','containers':after,'selected':configs,'sharedConfigHashProof':proof,'beforeImages':{s:before[s]['image'] for s in before},'afterImages':{s:after[s]['image'] for s in after},'lease':{'pid':PID,'path':LOCK},'runtimeWrites':0,'healthProof':'actual Docker health metadata only; no endpoint/port guessed'}
 def hashproof(self,labels):
  helptext=self.run(['docker','compose','config','--help']);need(b'--hash' in helptext,'Existing Compose CLI lacks scoped config --hash capability');result={}
  for service,b in labels.items():
   args=['docker','compose','--project-name',b['project'],'--project-directory',b['workingDir']]
   for file in b['files']:args+=['--file',file]
   raw=self.run(args+['config','--hash',service]);need(len(raw)<=200,'Opaque config hash output oversized');text=raw.decode('ascii').strip();match=re.fullmatch(re.escape(service)+r'\s+([0-9a-f]{64})',text);need(match is not None,'Expected service/SHA only from Compose --hash');actual=match.group(1);need(actual==b['configHash'],'Baseline resolved Compose hash mismatch: '+service);result[service]={'label':b['configHash'],'resolved':actual,'matched':True}
  return result
 def inspect(self,filename):
  facts=self.snapshot();create(self.root/filename,facts);return {'status':facts['status'],'factsFile':filename,'factsSha256':sha(read(self.root/filename)),'images':facts['afterImages'],'services':{s:{k:facts['containers'][s][k] for k in ['project','workingDir','files','health']} for s in CONTAINERS},'selected':facts['selected'],'runtimeWrites':0}
 def inputs(self,a,buildfile,beforefile):
  need(a.get('schema')==1 and a.get('rootApproved') is True and a.get('botIdRootVerified') is True and a.get('sharedEnvSourcesRootVerified') is True and type(a.get('botId'))is str and re.fullmatch(r'[1-9][0-9]{0,19}',a['botId']) is not None,'Independent Root approval/unchanged shared env sources/existing verified BOTID required')
  beforeRaw=read(self.root/beforefile);need(sha(beforeRaw)==a['beforeFactsSha256'],'Before facts changed');before=obj(beforeRaw);need(before['afterImages']==OLD and before['beforeImages']==OLD,'Independent fresh old image BASE changed')
  journalRaw=read(self.root/buildfile);need(sha(journalRaw)==a['buildJournalSha256'],'Accepted native build journal changed');j=obj(journalRaw);need(j.get('phase')=='BUILT_NOT_ACTIVATED' and image(j.get('contentImage')) and image(j.get('workerImage')),'Exact two child images from native build required');new={'content':j['contentImage'],'chat':j['workerImage']};need(new==a['newImages'] and all(new[s]!=OLD[s] for s in new),'Child image approval mismatch')
  labels=[before['containers'][s] for s in CONTAINERS];need(all([x['project'],x['workingDir'],x['files'],x['filePins']]==[labels[0]['project'],labels[0]['workingDir'],labels[0]['files'],labels[0]['filePins']] for x in labels),'Two services have different Compose chains; Root decision required')
  need(before['selected']['content']['PALITRA_CHECKOUT_ENABLED']=='true' and before['selected']['content']['PALITRA_MAIN_ORIGIN']=='https://palitra-love.ru' and before['selected']['content']['PALITRA_WEB_UPLOADS_ENABLED']!='true','Known Main checkout/origin/upload BASE required')
  for s in new:need(self.run(['docker','image','inspect','--format','{{.Id}}',new[s]]).decode().strip()==new[s],'Local accepted child image unavailable; never pull')
  return before,new,j
 def expected(self,before,new,bot):
  configs={s:dict(before['selected'][s]) for s in CONTAINERS};configs['content'].update({'PALITRA_CRM_ENABLED':'true','PALITRA_CUSTOMER_CHAT_ENABLED':'true',BOT:bot});return new,configs
 def same(self,current,before,images,configs,overlay=None):
  need(current['afterImages']==images and current['selected']==configs,'Concurrent/unexpected live images or selected config')
  for s in CONTAINERS:
   c,b=current['containers'][s],before['containers'][s];files=b['files']+([str(overlay)] if overlay else []);need(c['project']==b['project'] and c['workingDir']==b['workingDir'] and c['files']==files,'Live Compose identity/chain changed')
   if overlay is None:need(c['configHash']==b['configHash'],'Approved baseline Compose config hash changed: '+s)
   for name,pin in b['filePins'].items():need(c['filePins'].get(name)==pin,'Shared Compose source changed')
 def check(self,a,buildfile,beforefile):
  self.lease();before,new,j=self.inputs(a,buildfile,beforefile);current=self.snapshot();self.same(current,before,OLD,before['selected']);return {'status':'ACTIVATION_CHECK_ONLY','newImages':new,'services':['content','chat'],'changes':['content.PALITRA_CRM_ENABLED=true','content.PALITRA_CUSTOMER_CHAT_ENABLED=true','content.PALITRA_CRM_BOT_ID=Rootverified'],'runtimeWrites':0,'backendProof':False}
 def command(self,before,overlay,nulls=()):
  b=before['containers']['content'];args=(['env']+sum((['-u',k] for k in nulls),[]) if nulls else [])+['docker','compose','--project-name',b['project'],'--project-directory',b['workingDir']]
  for file in b['files']+[str(overlay)]:args+=['--file',file]
  return args+['up','--detach','--no-build','--pull','never','--no-deps','content','chat']
 def apply(self,a,buildfile,beforefile,*,apply=False):
  need(apply is True,'Explicit --apply required');self.check(a,buildfile,beforefile);before,new,j=self.inputs(a,buildfile,beforefile);journal=self.root/'activation-journal.json';overlay=self.root/'activation-overlay.json';need(not journal.exists() and not overlay.exists(),'Existing activation artifacts: result unknown, never repeat')
  env={'PALITRA_CRM_ENABLED':'true','PALITRA_CUSTOMER_CHAT_ENABLED':'true',BOT:a['botId']};value={'services':{'content':{'image':new['content'],'environment':env},'chat':{'image':new['chat']}}};create(overlay,value);create(journal,{'phase':'ACTIVATION_STARTED_UNKNOWN','before':before,'newImages':new,'overlay':str(overlay),'overlaySha256':sha(read(overlay)),'botId':a['botId'],'approvalSha256':sha(data(a))})
  self.same(self.snapshot(),before,OLD,before['selected']);need(read(overlay)==data(value),'Private overlay changed before activation');self.lease();self.run(self.command(before,overlay));after=self.snapshot();imgs,configs=self.expected(before,new,a['botId']);self.same(after,before,imgs,configs,overlay);need(read(overlay)==data(value),'Private overlay changed during activation')
  receipt={'phase':'IMAGES_AND_SELECTED_CONFIG_APPLIED_NOT_BACKEND_PROOF','before':before,'after':after,'newImages':new,'overlay':str(overlay),'overlaySha256':sha(read(overlay)),'botId':a['botId'],'approvalSha256':sha(data(a))};replace(journal,receipt);return {'status':receipt['phase'],'journalSha256':sha(read(journal)),'images':new,'backendProof':False}
 def rollback(self,a,*,apply=False,journal_sha=None):
  need(apply is True and a.get('rootApproved') is True,'Explicit approved rollback required');journal=self.root/'activation-journal.json';raw=read(journal);need(sha(raw)==journal_sha,'Independent activation receipt SHA required');r=obj(raw);need(r['phase']=='IMAGES_AND_SELECTED_CONFIG_APPLIED_NOT_BACKEND_PROOF' and r['approvalSha256']==sha(data(a)),'Unknown result/approval: inspect, do not retry');need(sha(read(Path(r['overlay'])))==r['overlaySha256'],'Private activation overlay changed');before=r['before'];current=self.snapshot();self.same(current,before,r['newImages'],r['after']['selected'],Path(r['overlay']))
  for s in CONTAINERS:need(current['containers'][s]['configHash']==r['after']['containers'][s]['configHash'],'Approved activation receipt Compose config hash changed: '+s)
  for s in OLD:need(self.run(['docker','image','inspect','--format','{{.Id}}',OLD[s]]).decode().strip()==OLD[s],'Old immutable image unavailable; no pull')
  overlay=self.root/'rollback-overlay.json';need(not overlay.exists(),'Rollback already started/unknown');env=before['selected']['content'];create(overlay,{'services':{'content':{'image':OLD['content'],'environment':env},'chat':{'image':OLD['chat']}}});replace(journal,{**r,'phase':'ROLLBACK_STARTED_UNKNOWN'});self.lease();self.run(self.command(before,overlay,[k for k,v in env.items() if v is None]));after=self.snapshot();self.same(after,before,OLD,before['selected'],overlay);replace(journal,{**r,'phase':'ROLLED_BACK_IMAGES_AND_SELECTED_CONFIG_ONLY','rollbackOverlay':str(overlay),'afterRollback':after});return {'status':'ROLLED_BACK_IMAGES_AND_SELECTED_CONFIG_ONLY','images':OLD,'dbRestore':False}
def artifact(name):need(type(name)is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,79}',name) is not None and '..' not in name,'Explicit private artifact basename required');return name
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('operation',choices=['inspect','check','apply','rollback']);p.add_argument('--facts',default='activation-before.json');p.add_argument('--output',default='activation-before.json');p.add_argument('--build-journal');p.add_argument('--approval',default='activation-approval.json');p.add_argument('--apply',action='store_true');p.add_argument('--expected-journal-sha');x=p.parse_args()
 try:
  o=Activate();artifact(x.facts);artifact(x.output);artifact(x.approval)
  if x.operation=='inspect':result=o.inspect(x.output)
  else:
   a=obj(read(ROOT/x.approval))
   if x.operation=='rollback':result=o.rollback(a,apply=x.apply,journal_sha=x.expected_journal_sha)
   else:artifact(x.build_journal);result=o.check(a,x.build_journal,x.facts) if x.operation=='check' else o.apply(a,x.build_journal,x.facts,apply=x.apply)
  print(json.dumps(result,ensure_ascii=False));return 0
 except Exception as e:print(json.dumps({'status':'REFUSED','reason':str(e),'automaticRetry':False},ensure_ascii=False));return 2
if __name__=='__main__':sys.exit(main())
