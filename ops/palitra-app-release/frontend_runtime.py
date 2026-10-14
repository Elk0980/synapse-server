"""Root-only second phase: exact content image switch and receipt-bound rollback.
No build/pull/env changes/worker recreation/static writes/DB/HTTP/auth.
"""
import argparse, json, re, stat, sys, types
from datetime import datetime, timezone
from pathlib import Path

ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
DEPENDENCY_SHA='60a129b3467068932e0d1ca5529f808a76f36f52027990d71bd19d588149db4b'
BASE_SHA='b6204caab72403a86a41f0535547b6cddf19f990faf50d2f5136070b7ee9d8db'
CANDIDATE_SHA='c23c78fd5d86f30a3bd538de3298a0e844e775a63ffad6403581a3f14f7997ea'

def load_dependency(filename):
 import hashlib
 p=Path(filename)
 if not p.is_absolute() or '..' in p.parts:raise ValueError('Absolute dependency path required')
 for item in [*reversed(p.parents),p]:
  s=item.lstat()
  if stat.S_ISLNK(s.st_mode) or getattr(s,'st_file_attributes',0)&0x400:raise ValueError('Dependency symlink/reparse refused')
 before=p.stat()
 if not stat.S_ISREG(before.st_mode) or not 0<before.st_size<1024*1024:raise ValueError('Bounded code dependency required')
 raw=p.read_bytes();after=p.stat()
 if (before.st_ino,before.st_dev,before.st_size,before.st_mtime_ns)!=(after.st_ino,after.st_dev,after.st_size,after.st_mtime_ns):raise ValueError('Dependency changed during read')
 if hashlib.sha256(raw).hexdigest()!=DEPENDENCY_SHA:raise ValueError('Frozen activation dependency SHA mismatch')
 module=types.ModuleType('accepted_backend_activation');module.__file__=str(p);exec(compile(raw,str(p),'exec'),module.__dict__);return module

class Switch:
 def __init__(self,core,root=ROOT,runner=None,now=None):
  self.m=core;self.root=core.path(root);self.native=core.Activate(self.root,runner or core.native);self.run=self.native.run;self.now=now or (lambda:datetime.now(timezone.utc))
 def pinned(self,name,pin):
  m=self.m;m.artifact(name);m.need(type(pin)is str and re.fullmatch('[0-9a-f]{64}',pin) is not None,'Independent artifact SHA required');raw=m.read(self.root/name);m.need(m.sha(raw)==pin,'Private artifact changed: '+name);return m.obj(raw)
 def inputs(self,value,*,fresh=True):
  m=self.m;m.need(type(value)is dict and set(value)=={'backendReceipt','backendReceiptSha256','frontendReceipt','frontendReceiptSha256','backendProof'},'Exact selected input inventory required')
  backend=self.pinned(value['backendReceipt'],value['backendReceiptSha256']);frontend=self.pinned(value['frontendReceipt'],value['frontendReceiptSha256'])
  m.need(backend.get('phase')=='IMAGES_AND_SELECTED_CONFIG_APPLIED_NOT_BACKEND_PROOF','Completed backend activation receipt required');images=backend.get('newImages');after=backend.get('after',{})
  m.need(type(images)is dict and set(images)=={'content','chat'} and all(m.image(v) for v in images.values()) and after.get('afterImages')==images and after.get('lease')=={'pid':m.PID,'path':m.LOCK},'Exact backend receipt images/lease required')
  selected=after.get('selected',{});m.need(set(selected)=={'content','chat'},'Both selected backend configurations required');content=selected['content'];m.need(set(content)==set(m.ALLOWED) and content['PALITRA_CHECKOUT_ENABLED']=='true' and content['PALITRA_CRM_ENABLED']=='true' and content['PALITRA_CUSTOMER_CHAT_ENABLED']=='true' and content['PALITRA_WEB_UPLOADS_ENABLED']!='true' and content['PALITRA_MAIN_ORIGIN']=='https://palitra-love.ru' and content[m.BOT]==backend.get('botId') and type(backend.get('botId'))is str and re.fullmatch('[1-9][0-9]{0,19}',backend['botId']) is not None,'Exact enabled backend selected config required')
  m.need(frontend.get('schema')==1 and frontend.get('phase')=='FRONTEND_CODE_READY_IMAGE_NOT_ACTIVATED' and frontend.get('backendImages')==images and frontend.get('activationJournalSha256')==value['backendReceiptSha256'] and frontend.get('baseSha256')==BASE_SHA and frontend.get('candidateSha256')==CANDIDATE_SHA and frontend.get('runtimeRestarts')==0 and frontend.get('dbWrites')==0 and m.image(frontend.get('frontendImage')) and frontend['frontendImage']!=images['content'],'Exact completed one-file frontend receipt required')
  proof=self.pinned(value['backendProof'],frontend.get('backendProofSha256'));self.proof(proof,backend,frontend,value,fresh=fresh)
  m.need(self.run(['docker','image','inspect','--format','{{.Id}}',frontend['frontendImage']]).decode().strip()==frontend['frontendImage'],'Accepted frontend image not local; never pull')
  return backend,frontend,proof
 def proof(self,p,b,f,v,*,fresh):
  m=self.m;keys={'schema','status','rootApproved','observedAtUtc','releaseId','buildJournalSha256','activationJournalSha256','images','lease','dbWrites','externalMessages','apiReadbacks','existingBotReadback'}
  m.need(type(p)is dict and set(p)==keys and p.get('schema')==1 and p.get('status')=='ROOT_BACKEND_NATIVE_READBACK' and p.get('rootApproved') is True,'Actual selected native backend readback artifact required')
  m.need(p['releaseId']==f.get('releaseId') and p['buildJournalSha256']==f.get('buildJournalSha256') and p['activationJournalSha256']==v['backendReceiptSha256'] and p['images']==b['newImages'] and p['lease']=={'pid':m.PID,'path':m.LOCK} and p['dbWrites']==p['externalMessages']==0,'Backend proof does not bind exact completed release')
  def observed(value):
   m.need(type(value)is str,'Actual observation timestamp required')
   try:t=datetime.fromisoformat(value.replace('Z','+00:00'))
   except ValueError:raise m.Refused('Invalid observation timestamp')
   m.need(t.tzinfo is not None and t.utcoffset().total_seconds()==0,'Explicit UTC observation required')
   if fresh:m.need(-30<=(self.now()-t).total_seconds()<=300,'Actual backend proof stale/future')
  observed(p['observedAtUtc']);rows=p.get('apiReadbacks',{});expect={
   'health':('native-content','/health',200,set()),
   'owner':('https://synapse.synapsebusiness.ru','/content/whoami',200,{'userId','role','companyIds'}),
   'account':('https://palitra-love.ru','/api/draft-account/session',200,{'loggedIn'}),
   'crmScript':('https://palitra-love.ru','/palitra-app/crm-session.js',200,set()),
   'chatRoute':('https://palitra-love.ru','/api/customer-chat/session',405,{'code','allow'})}
  m.need(type(rows)is dict and set(rows)==set(expect),'Actual backend readback inventory required')
  for name,(origin,path,status,projection) in expect.items():
   r=rows[name];m.need(type(r)is dict and set(r)=={'method','origin','path','status','projection','responseSha256','observationId','observedAtUtc'} and r['method']=='GET' and r['origin']==origin and r['path']==path and r['status']==status and type(r['projection'])is dict and set(r['projection'])==projection,'Selected GET observation mismatch: '+name)
   m.need(type(r['responseSha256'])is str and re.fullmatch('[0-9a-f]{64}',r['responseSha256']) is not None and type(r['observationId'])is str and re.fullmatch('[A-Za-z0-9_:/.-]{1,200}',r['observationId']) is not None,'Actual response digest/observation ID required');observed(r['observedAtUtc'])
  owner=rows['owner']['projection'];m.need(str(owner['userId'])=='1' and owner['role']=='owner' and 'palitra-love' in owner['companyIds'],'Existing owner/company observation required');m.need(type(rows['account']['projection']['loggedIn'])is bool,'Existing Main account observation required');m.need(rows['chatRoute']['projection']=={'code':'METHOD','allow':'POST'},'Enabled native chat method-guard observation required')
  bot=p['existingBotReadback'];m.need(type(bot)is dict and set(bot)=={'observedAtUtc','checkedAtUtc','botKey','username','botId','responseSha256','bridgeConfirmed','usernameMatches'} and bot['botKey']=='palitra' and bot['username']=='palitra_love_orders_bot' and str(bot['botId'])==b.get('botId') and type(bot['responseSha256'])is str and re.fullmatch('[0-9a-f]{64}',bot['responseSha256']) is not None and bot['bridgeConfirmed'] is True and bot['usernameMatches'] is True,'Actual existing bot bridge observation required');observed(bot['observedAtUtc']);observed(bot['checkedAtUtc'])
 def stable(self,value):self.inputs(value)
 def check(self,value):
  b,f,p=self.inputs(value);current=self.native.snapshot();self.native.same(current,b['after'],b['newImages'],b['after']['selected']);self.inputs(value);return b,f,current
 def command(self,before,overlay):
  b=before['containers']['content'];args=['docker','compose','--project-name',b['project'],'--project-directory',b['workingDir']]
  for file in b['files']+[str(overlay)]:args+=['--file',file]
  return args+['up','--detach','--no-build','--pull','never','--no-deps','content']
 def compare(self,current,before,images,overlay=None):
  m=self.m;m.need(current['afterImages']==images and current['selected']==before['selected'],'Concurrent images/selected configuration changed')
  c,b=current['containers']['content'],before['containers']['content'];files=b['files']+([str(overlay)] if overlay else [])
  m.need(c['project']==b['project'] and c['workingDir']==b['workingDir'] and c['files']==files,'Content Compose identity/chain changed')
  for name,pin in b['filePins'].items():m.need(c['filePins'].get(name)==pin,'Shared Compose source changed')
  if overlay is None:m.need(c['configHash']==b['configHash'],'Approved baseline content config-hash changed')
  m.need(current['containers']['chat']==before['containers']['chat'],'Worker metadata/config changed or worker recreated')
 def apply(self,value,*,apply=False):
  m=self.m;m.need(apply is True,'Explicit Root --apply required');b,f,before=self.check(value);journal=self.root/'frontend-runtime-journal.json';overlay=self.root/'frontend-runtime-overlay.json';m.need(not journal.exists() and not overlay.exists(),'Existing frontend runtime artifacts: never repeat unknown result')
  image={'content':f['frontendImage'],'chat':b['newImages']['chat']};ov={'services':{'content':{'image':image['content']}}};m.create(overlay,ov);state={'schema':1,'phase':'FRONTEND_RUNTIME_STARTED_UNKNOWN','before':before,'images':image,'overlay':str(overlay),'overlaySha256':m.sha(m.read(overlay)),'inputs':value,'inputsSha256':m.sha(m.data(value)),'dbWrites':0};m.create(journal,state)
  current=self.native.snapshot();self.compare(current,before,b['newImages']);self.stable(value);m.need(m.read(overlay)==m.data(ov),'Frontend image overlay changed');self.native.lease();self.run(self.command(before,overlay));after=self.native.snapshot();self.compare(after,before,image,overlay);m.need(m.read(overlay)==m.data(ov),'Frontend image overlay changed during apply')
  state.update(phase='FRONTEND_CONTENT_APPLIED_NOT_PUBLIC_PROOF',after=after);m.replace(journal,state);return {'status':state['phase'],'images':image,'journalSha256':m.sha(m.read(journal)),'publicReady':False,'dbWrites':0,'workerRecreated':False}
 def rollback(self,value,*,apply=False,journal_sha=None):
  m=self.m;m.need(apply is True,'Explicit Root --apply rollback required');self.inputs(value,fresh=False);journal=self.root/'frontend-runtime-journal.json';raw=m.read(journal);m.need(m.sha(raw)==journal_sha,'Independent completed frontend-runtime receipt SHA required');r=m.obj(raw);m.need(r.get('schema')==1 and r.get('phase')=='FRONTEND_CONTENT_APPLIED_NOT_PUBLIC_PROOF' and r.get('inputsSha256')==m.sha(m.data(value)) and r.get('inputs')==value,'Unknown/incomplete/changed runtime receipt');m.need(m.sha(m.read(Path(r['overlay'])))==r['overlaySha256'],'Frontend overlay changed')
  current=self.native.snapshot();self.compare(current,r['before'],r['images'],Path(r['overlay']))
  for s in m.CONTAINERS:m.need(current['containers'][s]['configHash']==r['after']['containers'][s]['configHash'],'Runtime receipt config-hash changed: '+s)
  backend=r['before']['afterImages']['content'];m.need(self.run(['docker','image','inspect','--format','{{.Id}}',backend]).decode().strip()==backend,'Backend image not local; no pull');overlay=self.root/'frontend-runtime-rollback-overlay.json';ov={'services':{'content':{'image':backend}}};m.create(overlay,ov);m.replace(journal,{**r,'phase':'FRONTEND_RUNTIME_ROLLBACK_STARTED_UNKNOWN'});self.compare(self.native.snapshot(),current,r['images']);self.inputs(value,fresh=False);self.native.lease();m.need(m.read(overlay)==m.data(ov),'Rollback overlay changed');self.run(self.command(current,overlay));after=self.native.snapshot();expected={'content':backend,'chat':r['images']['chat']};self.compare(after,current,expected,overlay);m.need(m.read(overlay)==m.data(ov),'Rollback overlay changed during apply');m.replace(journal,{**r,'phase':'FRONTEND_CONTENT_ROLLED_BACK_TO_BACKEND','afterRollback':after});return {'status':'FRONTEND_CONTENT_ROLLED_BACK_TO_BACKEND','images':expected,'workerRecreated':False,'dbRestore':False,'cabinetRollback':'separate accepted frontend_activation.py step'}

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('operation',choices=['inspect','check','apply','rollback']);p.add_argument('--inputs',required=True);p.add_argument('--inputs-sha',required=True);p.add_argument('--apply',action='store_true');p.add_argument('--receipt-sha');a=p.parse_args()
 try:
  m=load_dependency(ROOT/'activate_root.py');m.path(ROOT/'activate_root.py');s=Switch(m);value=s.pinned(a.inputs,a.inputs_sha)
  if a.operation in ['inspect','check']:
   b,f,current=s.check(value);result={'status':'FRONTEND_RUNTIME_CHECK_ONLY','images':current['afterImages'],'nextContentImage':f['frontendImage'],'runtimeWrites':0,'publicReady':False}
  elif a.operation=='apply':result=s.apply(value,apply=a.apply)
  else:result=s.rollback(value,apply=a.apply,journal_sha=a.receipt_sha)
  print(json.dumps(result,ensure_ascii=False));return 0
 except Exception as error:print(json.dumps({'status':'REFUSED','reason':str(error),'automaticRetry':False},ensure_ascii=False));return 2
if __name__=='__main__':sys.exit(main())
