"""Explicit Root decision: build/restart content only, keep exact running worker untouched.
No pull, worker image inspection/recreation, DB, auth, price, bot or shared env-file edits.
"""
import argparse,hashlib,importlib.util,json,os,re,stat,sys,time,types
from pathlib import Path
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
MANIFEST='dd82ce11f239823d005a0e05132f92b640776984f01013094d07e07e62c6d812'
WORKER_SOURCE='36b0bdc733ad4f4514635d0416867d5964fef4c82aeabe125f542a20969de0ee'
WORKER_TARGET='ac3a139d9715036ce5a6966794b61d65e900b0deb2eb3cf6edcd108c643cf683'
PINS={'activate_root.py':'60a129b3467068932e0d1ca5529f808a76f36f52027990d71bd19d588149db4b','release_common.py':'924c235d6927da5f4f8d210fa50ca05be85b67a2455269b7baffc0aeca2d24bc','native_release.py':'c2b01d25f38f1113a3f774e28b474ac2301adfe47654a600bbca95912e08a8b4'}
ALIAS='palitra-local-base-content:root-final-r3';TAG='palitra-combined:root-final-r3'
def sha(raw):return hashlib.sha256(raw).hexdigest()
def dependencies():
 modules={}
 for name in PINS:
  path=ROOT/name if name=='activate_root.py' else ROOT/'bundle-root-final'/name
  for p in [*reversed(path.parents),path]:
   st=p.lstat()
   if stat.S_ISLNK(st.st_mode):raise ValueError('Code symlink refused')
  raw=path.read_bytes()
  if sha(raw)!=PINS[name]:raise ValueError('Exact frozen code SHA required: '+name)
  module=types.ModuleType(name[:-3]);module.__file__=str(path);sys.modules[name[:-3]]=module;exec(compile(raw,str(path),'exec'),module.__dict__);modules[name]=module
 return modules['activate_root.py'],modules['native_release.py']

class Release:
 def __init__(self,core,native,root=ROOT,runner=None,now=time.time):
  self.c=core;self.n=native;self.root=core.path(root);self.bundle=self.root/'bundle-root-final';self.run=runner or core.native;self.a=core.Activate(self.root,self.run);self.now=now
 def pinned(self,name,pin):
  c=self.c;c.artifact(name);c.need(type(pin)is str and re.fullmatch('[0-9a-f]{64}',pin) is not None,'Independent artifact SHA required');raw=c.read(self.root/name);c.need(sha(raw)==pin,'Artifact SHA changed: '+name);return c.obj(raw)
 def worker(self,decision):
  c=self.c;cid=self.run(['docker','inspect','--format','{{.Id}}','synapse-chat-1']).decode().strip();c.need(re.fullmatch('[0-9a-f]{64}',cid) is not None and cid==decision['workerContainerId'],'Running worker container identity changed')
  raw=self.n.docker_read('synapse-chat-1','client-bot-bridge.js',self.run);c.need(raw is not None and sha(raw)==WORKER_SOURCE,'Exact running worker source changed')
  return {'containerId':cid,'sourceSha256':WORKER_SOURCE,'image':c.OLD['chat']}
 def inputs(self,name,pin,fresh=False):
  c=self.c;d=self.pinned(name,pin);keys={'schema','rootApproved','releaseId','manifestSha256','observedEpoch','beforeFactsSha256','workerContainerId','workerSourceSha256','deferredWorkerTargetSha256','mediaUploadsDisabled','workerMustRemainRunning','contentOnlyDecision','botId','botIdRootVerified','sharedEnvSourcesRootVerified'}
  c.need(set(d)==keys and d['schema']==1 and d['rootApproved'] is True and d['releaseId']=='root-final' and d['manifestSha256']==MANIFEST and d['mediaUploadsDisabled'] is True and d['workerMustRemainRunning'] is True and d['contentOnlyDecision'] is True and d['workerSourceSha256']==WORKER_SOURCE and d['deferredWorkerTargetSha256']==WORKER_TARGET and d['botIdRootVerified'] is True and d['sharedEnvSourcesRootVerified'] is True and type(d['botId'])is str and re.fullmatch('[1-9][0-9]{0,19}',d['botId']) is not None,'Explicit Root content-only/media-deferred decision required')
  if fresh:c.need(type(d['observedEpoch'])in (int,float) and 0<=self.now()-d['observedEpoch']<=600,'Root decision stale/future')
  before=self.pinned('activation-before.json',d['beforeFactsSha256']);c.need(before.get('schema')==1 and before['beforeImages']==before['afterImages']==c.OLD and before['lease']=={'pid':c.PID,'path':c.LOCK},'Original exact native facts/images/lease required')
  for s in c.CONTAINERS:
   p=before['sharedConfigHashProof'][s];c.need(p['matched'] is True and p['label']==p['resolved']==before['containers'][s]['configHash'],'Original opaque Compose hash proof required')
  selected=before['selected']['content'];c.need(selected['PALITRA_CHECKOUT_ENABLED']=='true' and selected['PALITRA_MAIN_ORIGIN']=='https://palitra-love.ru' and selected['PALITRA_WEB_UPLOADS_ENABLED']!='true','Original Main checkout/origin/media-off required')
  m=self.n.manifest(self.bundle,MANIFEST);c.need(m['releaseId']=='root-final' and m['images']=={'content':c.OLD['content'],'worker':c.OLD['chat']} and m['lease']=={'pid':c.PID,'path':c.LOCK} and len(m['content'])==39 and len(m['worker'])==1 and m['worker'][0]['sha256']==WORKER_TARGET and m['worker'][0]['baseSha256']==WORKER_SOURCE,'Frozen full scope/worker deferred delta changed')
  self.a.lease();self.worker(d);return d,before,m
 def original(self,before,d):
  current=self.a.snapshot();self.a.same(current,before,self.c.OLD,before['selected']);self.worker(d);return current
 def image(self,tag):
  value=self.run(['docker','image','inspect','--format','{{.Id}}',tag]).decode().strip();self.c.need(self.c.image(value),'Exact local image required');return value
 def layers(self,image):
  value=self.c.obj(self.run(['docker','image','inspect','--format','{{json .RootFS.Layers}}',image]));self.c.need(type(value)is list and value and all(self.c.image(v) for v in value),'Exact layer inventory required');return value
 def unused(self,tag):self.c.need(self.run(['docker','image','ls','--quiet',tag]).strip()==b'','Unique tag already exists: unknown result, do not retry')
 def source_hashes(self,image,rows):
  expected={r['target']:r['sha256'] for r in rows};code="const fs=require('fs'),c=require('crypto');const expected="+json.dumps(expected,separators=(',',':'))+";let bad=0;for(const [p,s] of Object.entries(expected)){const b=fs.readFileSync('/app/'+p);if(c.createHash('sha256').update(b).digest('hex')!==s)bad++};console.log(JSON.stringify({checked:Object.keys(expected).length,bad}));if(bad)process.exit(3)"
  result=self.c.obj(self.run(['docker','run','--rm','--network=none','--read-only','--entrypoint','node',image,'-e',code]));self.c.need(result=={'checked':len(rows),'bad':0},'Built image payload readback failed')
 def build(self,name,pin,apply=False):
  c=self.c;c.need(apply is True,'Explicit --apply required');d,before,m=self.inputs(name,pin,True);self.original(before,d);self.n.preflight(self.bundle,m,self.run)
  journal=self.root/'native-build-r3.json';context=self.root/'build-recovery-r3';c.need(not journal.exists() and not context.exists(),'R3 attempt already exists/unknown: inspect, do not retry');self.unused(ALIAS);self.unused(TAG)
  raw=c.read(self.bundle/'Dockerfile');original=('FROM '+m['images']['content']+'\n'+''.join('COPY '+r['payload']+' /app/'+r['target']+'\n' for r in m['content'])).encode();c.need(raw==original,'Exact original FROM +39 COPY required');derived=('FROM '+ALIAS+'\n').encode()+raw.split(b'\n',1)[1];prefix=self.layers(c.OLD['content'])
  state={'schema':1,'releaseId':'root-final','attemptId':'root-final-r3','phase':'CONTENT_ONLY_BUILD_STARTED_UNKNOWN','manifestSha256':MANIFEST,'decisionFile':name,'decisionSha256':pin,'workerUnchanged':True,'workerProof':self.worker(d),'workerImage':c.OLD['chat'],'workerTargetDeferredSha256':WORKER_TARGET,'mediaUploadsEnabled':False,'copyCounts':{'content':39,'worker':0},'dbWrites':0,'runtimeRestarts':0};c.create(journal,state)
  try:
   c.path(context,True);context.mkdir(mode=0o700);file=context/'Dockerfile';fd=os.open(file,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
   with os.fdopen(fd,'wb') as stream:stream.write(derived);stream.flush();os.fsync(stream.fileno())
   self.original(before,d);self.n.preflight(self.bundle,m,self.run);self.unused(ALIAS);self.unused(TAG);self.run(['docker','tag',c.OLD['content'],ALIAS]);c.need(self.image(ALIAS)==c.OLD['content'],'Local content alias drift')
   state['stage']='build_content';c.replace(journal,state);self.unused(TAG);c.need(c.read(file)==derived,'Derived Dockerfile changed before build');self.run(['docker','build','--network=none','--pull=false','--tag',TAG,'--file',str(file),str(self.bundle)])
   child=self.image(TAG);layers=self.layers(child);c.need(child!=c.OLD['content'] and layers[:len(prefix)]==prefix and len(layers)==len(prefix)+39,'Content RootFS prefix/+39 layers mismatch');c.need(self.image(ALIAS)==c.OLD['content'] and c.read(file)==derived,'Alias/Dockerfile changed')
   self.source_hashes(child,m['content']);self.original(before,d);self.n.preflight(self.bundle,m,self.run);self.inputs(name,pin);c.need(self.image(TAG)==child and self.image(ALIAS)==c.OLD['content'],'Final content tag/alias drift')
   state.update(phase='BUILT_NOT_ACTIVATED',contentTag=TAG,contentImage=child,stage='complete');c.replace(journal,state);return {'status':state['phase'],'contentImage':child,'workerImage':c.OLD['chat'],'workerUnchanged':True,'workerTargetInstalled':False,'mediaUploadsEnabled':False,'journalSha256':sha(c.read(journal))}
  except BaseException:
   state.update(phase='CONTENT_ONLY_BUILD_FAILED_UNKNOWN');c.replace(journal,state);raise
 def static_and_sources(self,m,journal_sha):
  c=self.c;receipt=self.pinned('native-static.json',journal_sha);c.need(receipt['releaseId']=='root-final' and receipt['phase']=='STATIC_APPLIED_CODE_ONLY' and len(receipt['records'])==len(m['static']),'Completed exact static apply required')
  by_path={str(self.n.static_target(m,r)):r for r in m['static']};c.need({r['target'] for r in receipt['records']}==set(by_path),'Static receipt inventory mismatch')
  for i,rec in enumerate(receipt['records']):
   row=by_path[rec['target']];c.need(rec['index']==i and rec['baseSha256']==row['baseSha256'] and rec['newSha256']==row['sha256'] and type(rec['written'])is bool and sha(c.read(Path(rec['target'])))==row['sha256'],'Static receipt/readback changed')
  for row in m['capture']['inventory']:
   target=row['target']
   if target.startswith('content/'):
    b=self.n.docker_read('synapse-content-1',target[8:],self.run);c.need((None if b is None else sha(b))==row['sha256'],'Original content capture changed after static apply')
  for row in m['content']:
   b=self.n.docker_read('synapse-content-1',row['target'],self.run);c.need((None if b is None else sha(b))==row['baseSha256'],'Image target BASE changed after static apply')
 def activate(self,name,pin,build_sha,static_sha,apply=False):
  c=self.c;c.need(apply is True,'Explicit --apply required');d,before,m=self.inputs(name,pin);build=self.pinned('native-build-r3.json',build_sha);c.need(build['phase']=='BUILT_NOT_ACTIVATED' and build['decisionSha256']==pin and build['manifestSha256']==MANIFEST and build['workerUnchanged'] is True and build['workerImage']==c.OLD['chat'] and build['copyCounts']=={'content':39,'worker':0} and build['mediaUploadsEnabled'] is False,'Exact completed content-only R3 build required');new={'content':build['contentImage'],'chat':c.OLD['chat']};c.need(self.image(new['content'])==new['content'],'Content image not local');self.original(before,d);self.static_and_sources(m,static_sha);self.source_hashes(new['content'],m['content'])
  journal=self.root/'activation-r3-journal.json';overlay=self.root/'activation-r3-content-overlay.json';c.need(not journal.exists() and not overlay.exists(),'Activation exists/unknown: never retry')
  env={'PALITRA_CRM_ENABLED':'true','PALITRA_CUSTOMER_CHAT_ENABLED':'true','PALITRA_WEB_UPLOADS_ENABLED':'false',c.BOT:d['botId']};value={'services':{'content':{'image':new['content'],'environment':env}}};c.create(overlay,value)
  state={'schema':1,'phase':'CONTENT_ONLY_ACTIVATION_STARTED_UNKNOWN','before':before,'newImages':new,'botId':d['botId'],'workerUnchanged':True,'workerProof':self.worker(d),'workerTargetInstalled':False,'workerTargetDeferredSha256':WORKER_TARGET,'mediaUploadsEnabled':False,'decisionFile':name,'decisionSha256':pin,'buildJournalSha256':build_sha,'staticJournalSha256':static_sha,'overlay':str(overlay),'overlaySha256':sha(c.read(overlay)),'dbWrites':0};c.create(journal,state)
  self.original(before,d);self.inputs(name,pin);self.static_and_sources(m,static_sha);c.need(c.read(overlay)==c.data(value),'Overlay changed');b=before['containers']['content'];args=['docker','compose','--project-name',b['project'],'--project-directory',b['workingDir']]
  for file in b['files']+[str(overlay)]:args+=['--file',file]
  self.original(before,d);self.inputs(name,pin);c.need(self.pinned('native-build-r3.json',build_sha)==build,'Build receipt changed before activation');self.pinned('native-static.json',static_sha);c.need(c.read(overlay)==c.data(value),'Overlay changed before activation');self.a.lease();self.run(args+['up','--detach','--no-build','--pull','never','--no-deps','content']);after=self.a.snapshot();configs={s:dict(before['selected'][s]) for s in c.CONTAINERS};configs['content'].update(env)
  c.need(after['afterImages']==new and after['selected']==configs,'Unexpected activated image/selected config');c.need(after['containers']['chat']==before['containers']['chat'],'Untouched worker metadata/config changed')
  live=after['containers']['content'];c.need(live['project']==b['project'] and live['workingDir']==b['workingDir'] and live['files']==b['files']+[str(overlay)] and all(live['filePins'].get(k)==v for k,v in b['filePins'].items()),'Content Compose source/chain changed');self.worker(d);c.need(c.read(overlay)==c.data(value),'Overlay changed during apply')
  for row in m['content']:
   actual=self.n.docker_read('synapse-content-1',row['target'],self.run);c.need(actual is not None and sha(actual)==row['sha256'],'Activated content payload mismatch')
  state.update(phase='IMAGES_AND_SELECTED_CONFIG_APPLIED_NOT_BACKEND_PROOF',after=after);c.replace(journal,state);return {'status':state['phase'],'images':new,'workerUnchanged':True,'workerTargetInstalled':False,'mediaUploadsEnabled':False,'journalSha256':sha(c.read(journal)),'backendProof':False,'dbWrites':0}

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('operation',choices=['check','build','activate']);p.add_argument('--decision',default='content-only-root-decision-r3.json');p.add_argument('--decision-sha',required=True);p.add_argument('--build-sha');p.add_argument('--static-sha');p.add_argument('--apply',action='store_true');a=p.parse_args()
 try:
  if os.name!='posix' or os.geteuid()!=0:raise ValueError('Native Root required')
  core,native=dependencies();r=Release(core,native)
  if a.operation=='check':d,b,m=r.inputs(a.decision,a.decision_sha,True);r.original(b,d);native.preflight(r.bundle,m,r.run);result={'status':'CONTENT_ONLY_CHECK_ONLY','contentCopies':39,'workerCopies':0,'workerUnchanged':True,'workerTargetInstalled':False,'mediaUploadsEnabled':False}
  elif a.operation=='build':result=r.build(a.decision,a.decision_sha,a.apply)
  else:result=r.activate(a.decision,a.decision_sha,a.build_sha,a.static_sha,a.apply)
  print(json.dumps(result));return 0
 except Exception as error:print(json.dumps({'status':'REFUSED','reason':str(error),'automaticRetry':False}));return 2
if __name__=='__main__':sys.exit(main())
