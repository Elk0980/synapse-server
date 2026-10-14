"""Root-only activation of content/chat on their separately pinned Compose chains.
One service per command. No build/pull/shared env edits/DB/HTTP/auth.
"""
import argparse,hashlib,json,re,stat,sys,types
from pathlib import Path
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
DEPENDENCY_SHA='60a129b3467068932e0d1ca5529f808a76f36f52027990d71bd19d588149db4b'
def load_dependency(filename):
 p=Path(filename)
 if not p.is_absolute() or '..' in p.parts:raise ValueError('Absolute dependency path required')
 for item in [*reversed(p.parents),p]:
  s=item.lstat()
  if stat.S_ISLNK(s.st_mode) or getattr(s,'st_file_attributes',0)&0x400:raise ValueError('Dependency symlink/reparse refused')
 b=p.stat()
 if not stat.S_ISREG(b.st_mode) or not 0<b.st_size<1024*1024:raise ValueError('Bounded code dependency required')
 raw=p.read_bytes();a=p.stat()
 if (b.st_ino,b.st_dev,b.st_size,b.st_mtime_ns)!=(a.st_ino,a.st_dev,a.st_size,a.st_mtime_ns) or hashlib.sha256(raw).hexdigest()!=DEPENDENCY_SHA:raise ValueError('Frozen dependency changed/SHA mismatch')
 module=types.ModuleType('accepted_backend_activation');module.__file__=str(p);exec(compile(raw,str(p),'exec'),module.__dict__);return module

class PerService:
 def __init__(self,core,root=ROOT,runner=None):self.m=core;self.root=core.path(root);self.native=core.Activate(self.root,runner or core.native);self.run=self.native.run
 def inputs(self,a,buildfile,beforefile):
  m=self.m;m.artifact(buildfile);m.artifact(beforefile);m.need(a.get('schema')==1 and a.get('rootApproved') is True and a.get('botIdRootVerified') is True and a.get('sharedEnvSourcesRootVerified') is True and type(a.get('botId'))is str and re.fullmatch('[1-9][0-9]{0,19}',a['botId']) is not None,'Independent Root approval/existing BOTID/selected shared-source proof required')
  raw=m.read(self.root/beforefile);m.need(m.sha(raw)==a.get('beforeFactsSha256'),'Approved before facts changed');before=m.obj(raw);m.need(before.get('schema')==1 and before.get('status')=='SELECTED_NATIVE_FACTS_NOT_APPROVED' and before.get('beforeImages')==m.OLD and before.get('afterImages')==m.OLD and before.get('lease')=={'pid':m.PID,'path':m.LOCK},'Exact original native facts/images/lease required')
  for s in m.CONTAINERS:
   row=before['sharedConfigHashProof'][s];m.need(row['matched'] is True and row['label']==row['resolved']==before['containers'][s]['configHash'],'Approved original opaque hash proof incomplete')
  c,h=before['containers']['content'],before['containers']['chat'];m.need(c['project']==h['project'] and c['workingDir']==h['workingDir'],'Actual existing project/workdir mismatch')
  content=before['selected']['content'];m.need(content['PALITRA_CHECKOUT_ENABLED']=='true' and content['PALITRA_MAIN_ORIGIN']=='https://palitra-love.ru' and content['PALITRA_WEB_UPLOADS_ENABLED']!='true','Known Main checkout/origin/upload BASE required')
  raw=m.read(self.root/buildfile);m.need(m.sha(raw)==a.get('buildJournalSha256'),'Accepted native build journal changed');j=m.obj(raw);new={'content':j.get('contentImage'),'chat':j.get('workerImage')};m.need(j.get('phase')=='BUILT_NOT_ACTIVATED' and all(m.image(new[s]) and new[s]!=m.OLD[s] for s in new) and new==a.get('newImages'),'Exact independently approved native child images required')
  for s in new:m.need(self.run(['docker','image','inspect','--format','{{.Id}}',new[s]]).decode().strip()==new[s],'Accepted child image not local; never pull')
  return before,new,j
 def check(self,a,buildfile,beforefile):
  self.native.lease();before,new,j=self.inputs(a,buildfile,beforefile);current=self.native.snapshot();self.native.same(current,before,self.m.OLD,before['selected']);return before,new,j,current
 def command(self,original,service,overlay,nulls=()):
  b=original['containers'][service];args=(['env']+sum((['-u',k] for k in nulls),[]) if nulls else [])+['docker','compose','--project-name',b['project'],'--project-directory',b['workingDir']]
  for file in b['files']+[str(overlay)]:args+=['--file',file]
  return args+['up','--detach','--no-build','--pull','never','--no-deps',service]
 def state(self,current,prior):self.native.same(current,prior,prior['afterImages'],prior['selected'])
 def transition(self,current,prior,original,service,overlay,images,configs):
  m=self.m;m.need(current['afterImages']==images and current['selected']==configs,'Unexpected transition image/selected configuration')
  for s in m.CONTAINERS:
   c,b,p=current['containers'][s],original['containers'][s],prior['containers'][s];files=b['files']+[str(overlay)] if s==service else p['files'];m.need(c['project']==b['project'] and c['workingDir']==b['workingDir'] and c['files']==files,'Per-service Compose chain/identity changed: '+s)
   for name,pin in b['filePins'].items():m.need(c['filePins'].get(name)==pin,'Original Compose source changed: '+s)
   if s!=service:m.need(c['configHash']==p['configHash'] and c['filePins']==p['filePins'],'Untouched service opaque hash/source changed: '+s)
 def apply(self,a,buildfile,beforefile,*,apply=False):
  m=self.m;m.need(apply is True,'Explicit Root --apply required');before,new,j,current=self.check(a,buildfile,beforefile);journal=self.root/'activation-v2-journal.json';overlays={s:self.root/('activation-v2-'+s+'-overlay.json') for s in m.CONTAINERS};m.need(not journal.exists() and all(not x.exists() for x in overlays.values()),'Existing V2 artifacts: partial/unknown result, inspect without retry')
  env={'PALITRA_CRM_ENABLED':'true','PALITRA_CUSTOMER_CHAT_ENABLED':'true',m.BOT:a['botId']};values={'content':{'services':{'content':{'image':new['content'],'environment':env}}},'chat':{'services':{'chat':{'image':new['chat']}}}}
  for s in overlays:m.create(overlays[s],values[s])
  r={'schema':1,'phase':'CONTENT_ACTIVATION_STARTED_UNKNOWN','before':before,'newImages':new,'botId':a['botId'],'approvalSha256':m.sha(m.data(a)),'buildJournalSha256':a['buildJournalSha256'],'overlays':{s:str(p) for s,p in overlays.items()},'overlaySha256':{s:m.sha(m.read(p)) for s,p in overlays.items()},'stageReceipts':{},'dbWrites':0};m.create(journal,r)
  images=dict(m.OLD);configs={s:dict(before['selected'][s]) for s in m.CONTAINERS};prior=current
  for s in ['content','chat']:
   if s=='chat':r['phase']='CHAT_ACTIVATION_STARTED_UNKNOWN';m.replace(journal,r)
   self.state(self.native.snapshot(),prior);self.inputs(a,buildfile,beforefile)
   for name,p in overlays.items():m.need(m.read(p)==m.data(values[name]),'Per-service overlay changed before apply')
   self.native.lease();self.run(self.command(before,s,overlays[s]));images[s]=new[s]
   if s=='content':configs[s].update(env)
   after=self.native.snapshot();self.transition(after,prior,before,s,overlays[s],images,configs)
   for name,p in overlays.items():m.need(m.read(p)==m.data(values[name]),'Per-service overlay changed during apply')
   r['stageReceipts'][s]=after;r['phase']='CONTENT_APPLIED_CHAT_PENDING' if s=='content' else 'IMAGES_AND_SELECTED_CONFIG_APPLIED_NOT_BACKEND_PROOF';r['after']=after;m.replace(journal,r);prior=after
  return {'status':r['phase'],'images':new,'journalSha256':m.sha(m.read(journal)),'backendProof':False,'dbWrites':0}
 def rollback(self,a,*,apply=False,journal_sha=None):
  m=self.m;m.need(apply is True and a.get('rootApproved') is True,'Explicit approved rollback required');journal=self.root/'activation-v2-journal.json';raw=m.read(journal);m.need(m.sha(raw)==journal_sha,'Independent completed V2 receipt SHA required');r=m.obj(raw);m.need(r.get('phase')=='IMAGES_AND_SELECTED_CONFIG_APPLIED_NOT_BACKEND_PROOF' and r.get('approvalSha256')==m.sha(m.data(a)),'Known partial/unknown/changed receipt: manual inspect required');current=self.native.snapshot();self.state(current,r['after']);before=r['before']
  for s in m.CONTAINERS:
   p=Path(r['overlays'][s]);m.need(m.sha(m.read(p))==r['overlaySha256'][s],'Activation overlay changed');m.need(self.run(['docker','image','inspect','--format','{{.Id}}',m.OLD[s]]).decode().strip()==m.OLD[s],'Old immutable image missing; no pull')
  overlays={s:self.root/('rollback-v2-'+s+'-overlay.json') for s in m.CONTAINERS};m.need(all(not p.exists() for p in overlays.values()),'Existing rollback artifacts: inspect partial/unknown result')
  values={s:{'services':{s:{'image':m.OLD[s]}}} for s in m.CONTAINERS};values['content']['services']['content']['environment']=before['selected']['content']
  for s,p in overlays.items():m.create(p,values[s])
  prior=current;images=dict(r['newImages']);configs={s:dict(r['after']['selected'][s]) for s in m.CONTAINERS}
  for s in ['chat','content']:
   r['phase']=s.upper()+'_ROLLBACK_STARTED_UNKNOWN';m.replace(journal,r);self.state(self.native.snapshot(),prior)
   for name,p in overlays.items():m.need(m.read(p)==m.data(values[name]),'Rollback overlay changed before apply')
   self.native.lease();nulls=[k for k,v in before['selected']['content'].items() if v is None] if s=='content' else [];self.run(self.command(before,s,overlays[s],nulls));images[s]=m.OLD[s]
   if s=='content':configs[s]=dict(before['selected'][s])
   after=self.native.snapshot();self.transition(after,prior,before,s,overlays[s],images,configs)
   for name,p in overlays.items():m.need(m.read(p)==m.data(values[name]),'Rollback overlay changed during apply')
   r['phase']='CHAT_ROLLED_BACK_CONTENT_PENDING' if s=='chat' else 'ROLLED_BACK_IMAGES_AND_SELECTED_CONFIG_ONLY';r['afterRollback']=after;m.replace(journal,r);prior=after
  return {'status':r['phase'],'images':m.OLD,'dbRestore':False}

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('operation',choices=['inspect','check','apply','rollback']);p.add_argument('--facts',default='activation-before.json');p.add_argument('--output',default='activation-v2-before.json');p.add_argument('--build-journal');p.add_argument('--approval',default='activation-approval.json');p.add_argument('--apply',action='store_true');p.add_argument('--receipt-sha');a=p.parse_args()
 try:
  m=load_dependency(ROOT/'activate_root.py');o=PerService(m);m.artifact(a.facts);m.artifact(a.output);m.artifact(a.approval)
  if a.operation=='inspect':result=o.native.inspect(a.output)
  else:
   approval=m.obj(m.read(ROOT/a.approval))
   if a.operation=='rollback':result=o.rollback(approval,apply=a.apply,journal_sha=a.receipt_sha)
   elif a.operation=='check':before,new,j,current=o.check(approval,a.build_journal,a.facts);result={'status':'PER_SERVICE_ACTIVATION_CHECK_ONLY','images':current['afterImages'],'newImages':new,'runtimeWrites':0,'backendProof':False}
   else:result=o.apply(approval,a.build_journal,a.facts,apply=a.apply)
  print(json.dumps(result,ensure_ascii=False));return 0
 except Exception as error:print(json.dumps({'status':'REFUSED','reason':str(error),'automaticRetry':False},ensure_ascii=False));return 2
if __name__=='__main__':sys.exit(main())
