"""Root-only K01 client entry + reversible two-field editor UI release after chain19.
No worker, flag, auth, rights, DB, queue, automatic rollback or retry operations.
The exact five-file payload manifest is reviewed and pinned by Root at invocation.
"""
import argparse,base64,hashlib,json,os,re,stat,sys,time
from pathlib import Path

ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
ACTIVATION_SHA='5069df0759312e2410bcfb05e94db00583af1cb6d87ab3c8dde62c161e22b8ec'
REPORTS_HELPER_SHA='08c49246784a37b260de11c94c2736399975c3478d7c49a5c2bedf380f06226d'
PUSH_HELPER_SHA='d790ffa1a85841a962f6be0450350ede43d5bd3a9caa6423dabeb8340ef5fcd1'
PUSH_RECEIPT_SHA='c61fb1127dfd7598e172ef0c221ee86074ef7fd177a5000a3c23650b3b35bd38'
PUSH_MANIFEST_SHA='7ea7731289082aef2c4e4d305a4cebad07f36ae41828460c486555983f73c869'
PAYLOAD_MANIFEST_SHA='0757aa618be915d5dfa75a00ae1aa66edb0a46cd219f0af8412505af9996cb53'
CONTENT='sha256:7480501d7fe758fa00df484770806b63b4107671f127b985fd9963bb55fb52ed'
WORKER='sha256:d4d4d453ce2e3dc47d5e0962d62b95938f42c56ec73789fe76a324e0d2ff0508'
FULLSCREEN_SHA='59f65e501267d8304aed0795e6d05b270242cfa69d3e2a72391064f8ce0abcfe'
BEFORE={
 'product/shell.js':('aaf87e6ecdfda9d0f8f866b68a10cf5242b545df2467d29c14ed86f516194104',120300),
 'product/design-data.js':('6fc4c3ce15c73fb69e4f139bf2396126970aa5e5a5d0dea25ba48c53bb8a004f',24089),
 'editor/app.js':('aef949ead4aef07f7955ec02553af6504fadd8fbbcfd61d75c0404954114a9c2',185083),
 'editor/form-builder.js':('f5029bcec9b49416e3fede11a22c3249465f18f95aa459839c6b83a343ff3b56',17586),
 'editor/index.html':('137425d2c3404dafc4dbbe3388d6aaf0ce2727fcf9927135a021109dbb2150e9',7246),
}
LOCK='/opt/synapse/.palitra-app-release.lock'
NAME='k01-client-entry-r1';PHASE='K01_CLIENT_ENTRY_AND_EDITOR_UI_APPLIED_NOT_ROLE_ACCEPTANCE'
MANIFEST_STATUS='EXACT_K01_TWO_PRODUCT_THREE_EDITOR_UI_FILES_NO_BACKEND_CHANGE'
sha=lambda raw:hashlib.sha256(raw).hexdigest()
def need(ok,code):
 if not ok:raise ValueError(code)
for _pin in (ACTIVATION_SHA,REPORTS_HELPER_SHA,PUSH_HELPER_SHA,PUSH_RECEIPT_SHA,PUSH_MANIFEST_SHA,PAYLOAD_MANIFEST_SHA,FULLSCREEN_SHA,*[v[0]for v in BEFORE.values()]):need(re.fullmatch('[0-9a-f]{64}',_pin)is not None,'BAD_K01_PRODUCTION_SHA_LITERAL')
for _image in (CONTENT,WORKER):need(re.fullmatch('sha256:[0-9a-f]{64}',_image)is not None,'BAD_K01_PRODUCTION_IMAGE_LITERAL')

class K01Release:
 def __init__(self,a,b,push,payload,manifest_pin,lease_pid,clock=time.time):
  self.a,self.b,self.push,self.photo,self.root,self.clock=a,b,push,b.photo,b.root,clock;self.c=b.photo.c;self.run=b.run
  need(type(lease_pid)is int and lease_pid>1,'FRESH_ROOT_LEASE_PID_REQUIRED');self.lease_pid=lease_pid
  self.b.lease=self.lease
  self.payload=a.exact_path(payload);need(self.payload.is_dir()and self.payload.is_relative_to(self.root),'ROOT_K01_PAYLOAD_REQUIRED')
  need(type(manifest_pin)is str and re.fullmatch('[0-9a-f]{64}',manifest_pin)is not None,'EXACT_ROOT_K01_MANIFEST_PIN_REQUIRED')
  self.manifest_pin=manifest_pin;raw=a.read(self.payload/'MANIFEST.json');need(manifest_pin==PAYLOAD_MANIFEST_SHA and sha(raw)==manifest_pin,'PINNED_K01_MANIFEST_REQUIRED');m=a.decode(raw)
  need(set(m)=={'schema','status','records'}and m['schema']==1 and m['status']==MANIFEST_STATUS and type(m['records'])is list and len(m['records'])==5,'EXACT_FIVE_K01_UI_MANIFEST_REQUIRED')
  self.pins={str(self.payload/'MANIFEST.json'):manifest_pin};self.records={};self.m={'records':[]}
  self.helper=a.exact_path(__file__);self.helper_pin=sha(a.read(self.helper));self.pins[str(self.helper)]=self.helper_pin
  self.cabinet=self.photo.ui.cabinet;need(self.cabinet==Path('/opt/synapse/sites/synapse/cabinet/palitra-orders')or self.root!=ROOT,'EXACT_EXISTING_CABINET_REQUIRED')
  self.editor=self.cabinet.parent/'project-forms'
  self.targets={n:(self.cabinet if n.startswith('product/')else self.editor)/n.split('/')[-1]for n in BEFORE}
  self.fullscreen=self.cabinet.parent/'project-forms.js'
  for r in m['records']:
   need(type(r)is dict and set(r)=={'name','payload','beforeSha256','beforeBytes','sha256','bytes','hunks'}and r['name']in BEFORE and r['payload']==r['name']and r['name']not in self.records,'EXACT_K01_RECORD_NAMES_REQUIRED')
   n=r['name'];need((r['beforeSha256'],r['beforeBytes'])==BEFORE[n]and type(r['sha256'])is str and re.fullmatch('[0-9a-f]{64}',r['sha256'])is not None and r['sha256']!=r['beforeSha256']and type(r['bytes'])is int and 0<r['bytes']<=2*1024*1024 and type(r['hunks'])is list and 1<=len(r['hunks'])<=256,'EXACT_K01_BASE_AND_BOUNDED_HUNKS_REQUIRED')
   new=a.read(self.payload/n);need(len(new)==r['bytes']and sha(new)==r['sha256'],'K01_PAYLOAD_CHANGED');old=new
   for h in reversed(r['hunks']):
    need(type(h)is dict and set(h)=={'before','after'}and type(h['before'])is str and type(h['after'])is str and h['before']and h['after']and h['before']!=h['after']and max(len(h['before'].encode()),len(h['after'].encode()))<=2*1024*1024,'EXACT_NONEMPTY_K01_HUNK_REQUIRED')
    x,y=h['after'].encode(),h['before'].encode();need(old.count(x)==1,'K01_REVERSE_UNIQUE_HUNK_REQUIRED');old=old.replace(x,y,1)
   need(sha(old)==r['beforeSha256']and len(old)==r['beforeBytes']and self.patch(old,r)==new,'EXACT_RAW_K01_BASE_RECONSTRUCTION_REQUIRED')
   self.records[n]=r;self.pins[str(self.payload/n)]=r['sha256']
   if n.startswith('product/'):self.m['records'].append({'group':'content','target':'palitra-orders-public/'+n.split('/')[-1],'sha256':r['sha256']})
  need(set(self.records)==set(BEFORE),'EXACT_FIVE_K01_NAMES_REQUIRED')
  self.receipt_path=self.root/'push-diagnostic-ui-r1-journal.json';self.receipt=a.pinned(self.receipt_path,PUSH_RECEIPT_SHA,True)
  historical=self.receipt.get('inputs');expected=push.binding()
  need(type(historical)is dict and type(historical.get('freshLeasePid'))is int and historical['freshLeasePid']>1 and {k:v for k,v in historical.items()if k!='freshLeasePid'}=={k:v for k,v in expected.items()if k!='freshLeasePid'},'EXACT_HISTORICAL_PUSH_BINDING_REQUIRED')
  # The pinned completed receipt retains its historical lease. Only the current operation uses the fresh lease.
  need(self.receipt.get('schema')==1 and self.receipt.get('name')=='push-diagnostic-ui-r1'and self.receipt.get('phase')=='PUSH_DIAGNOSTIC_UI_APPLIED_NOT_IPHONE_CAUSE_OR_SUBSCRIPTION_PROOF'and self.receipt.get('before')==push.base and self.receipt.get('workerRecreated')is False and self.receipt.get('uploadsEnabled')is True and self.receipt.get('automaticRetry')is False and self.receipt.get('directDbWrites')==self.receipt.get('queueEdits')==0,'EXACT_COMPLETED_CHAIN19_RECEIPT_REQUIRED')
  overlay=Path(self.receipt['overlay']);need(overlay==self.root/'push-diagnostic-ui-r1-overlay.json'and sha(a.read(overlay))==self.receipt['overlaySha256']and a.decode(a.read(overlay))=={'services':{'content':{'image':CONTENT}}}and self.receipt['childImage']==CONTENT,'EXACT_COMPLETED_CHAIN19_OVERLAY_REQUIRED')
  push.transition(push.base,self.receipt['after'],overlay,self.receipt['plannedConfigHash'],CONTENT)
  self.base=self.receipt['after'];self.pins[str(self.receipt_path)]=PUSH_RECEIPT_SHA;self.pins[str(overlay)]=self.receipt['overlaySha256']
  need(self.base['containers']['content']['image']==CONTENT and len(self.base['containers']['content']['files'])==19 and self.base['worker']['image']==b.images['new']==WORKER and self.base['selected']['content']['PALITRA_WEB_UPLOADS_ENABLED']=='true','EXACT_CURRENT_K01_CHAIN19_REQUIRED')
  self.source=dict(push.final_source);self.static=dict(push.final_static)
  need(len(self.source)==202 and len(self.static)==16,'EXACT_K01_SOURCE202_STATIC16_REQUIRED')
  for n,(pin,size)in BEFORE.items():
   if n.startswith('product/'):need(self.source['palitra-orders-public/'+n.split('/')[-1]]==self.static[str(self.targets[n])]==pin,'EXACT_LIVE_PRODUCT_K01_BASE_REQUIRED')
   else:need(str(self.targets[n])not in self.static,'EDITOR_ALREADY_IN_ACCEPTED_STATIC_INVENTORY');self.static[str(self.targets[n])]=pin
  need(len(self.static)==19,'EXACT_K01_FULL_STATIC19_REQUIRED')
  self.final_source=dict(self.source);self.final_static=dict(self.static)
  for n,r in self.records.items():
   if n.startswith('product/'):self.final_source['palitra-orders-public/'+n.split('/')[-1]]=r['sha256']
   self.final_static[str(self.targets[n])]=r['sha256']
 def patch(self,raw,r):
  need(len(raw)==r['beforeBytes']and sha(raw)==r['beforeSha256'],'K01_ACTUAL_RAW_BASE_CHANGED')
  for h in r['hunks']:
   old,new=h['before'].encode(),h['after'].encode();need(raw.count(old)==1,'K01_FORWARD_UNIQUE_HUNK_REQUIRED');raw=raw.replace(old,new,1)
  need(len(raw)==r['bytes']and sha(raw)==r['sha256'],'K01_FINAL_BYTES_CHANGED');return raw
 def paths(self):return {k:self.root/(NAME+'-'+k+('.json'if k in ('decision','journal','overlay')else''))for k in ('decision','journal','overlay','context','backup')}
 def lease(self):
  raw=self.run(['lslocks','--noheadings','--output','PID,PATH']);need(len(raw)<=1048576,'BOUNDED_LEASE_INVENTORY_REQUIRED')
  rows=[line.strip().split(maxsplit=1)for line in raw.decode('utf-8').splitlines()if len(line.strip().split(maxsplit=1))==2 and line.strip().split(maxsplit=1)[1]==LOCK]
  need(rows==[[str(self.lease_pid),LOCK]],'FRESH_EXCLUSIVE_ROOT_LEASE_REQUIRED')
 def stable(self):
  self.push.stable()
  for path,pin in self.pins.items():need(sha(self.a.read(Path(path)))==pin,'K01_PINNED_INPUT_CHANGED')
 def static_guard(self,changed):
  need(sha(self.a.read(self.fullscreen))==FULLSCREEN_SHA,'K01_FULLSCREEN_MODULE_CHANGED')
  for path,pin in (self.final_static if changed else self.static).items():need(sha(self.a.read(Path(path)))==pin,'K01_FULL_STATIC19_CHANGED')
 def snapshot(self,content=CONTENT,source=False,static=False):
  # Same checks as accepted NativeBackend.snapshot; only exact two-file maps and content image vary.
  self.stable();self.b.lease();first={s:self.b.metadata(s)for s in ('content','chat')};worker=self.b.worker_facts()
  selected={s:self.b.a.selected(s)for s in ('content','chat')};need(selected==self.base['selected'],'K01_SELECTED_FLAGS_CHANGED')
  flags=self.a.decode(self.run(['docker','exec','synapse-content-1','node','-e',self.a.FLAGS_JS]));need(flags==self.base['l12'],'K01_L12_CUTOFF_CHANGED')
  for service,row in first.items():
   text=self.run(self.b._resolve_command(row,service)).decode('ascii').strip();found=re.fullmatch(re.escape(service)+r'\s+([0-9a-f]{64})',text);need(found is not None and found.group(1)==row['configHash'],'K01_RESOLVED_CONFIG_MISMATCH')
  need(first['content']['image']==content and worker==self.base['worker']and first['chat']==self.base['containers']['chat'],'K01_CURRENT_WORKER_OR_IMAGE_CHANGED')
  self.b.graph(new=True);self.b.push_guard();expected=self.final_source if source else self.source;need(self.photo.hashes(expected)==expected,'K01_FULL_SOURCE202_CHANGED');self.static_guard(static)
  cid=self.photo.cid();last={s:self.b.metadata(s)for s in ('content','chat')};need(first==last and worker==self.b.worker_facts()and selected=={s:self.b.a.selected(s)for s in ('content','chat')},'K01_CONCURRENT_CHANGE')
  self.b.lease();self.stable();need(cid==self.photo.cid(),'K01_CONTENT_CID_CHANGED_DURING_READ');return {'containers':last,'selected':selected,'worker':worker,'contentCid':cid,'l12':flags}
 def baseline(self,static=False):
  current=self.snapshot(static=static);need(current==self.base,'K01_UPLOADS_RECEIPT_BASE_CHANGED');heartbeat=self.b.heartbeat(current['worker']['startedAt'],self.clock());need(heartbeat['freshAfterWorkerStart'],'K01_FRESH_WORKER_HEARTBEAT_REQUIRED');return current
 def absent(self,decision=False):
  old=list(self.root.glob('k01-client-entry-r*-journal.json'));need(len(old)<=32,'BOUNDED_K01_HISTORY_REQUIRED')
  for p in old:need(re.fullmatch('k01-client-entry-r[1-9][0-9]{0,3}-journal.json',p.name)is not None and self.a.decode(self.a.read(p)).get('phase')==PHASE,'K01_UNKNOWN_HISTORY_NO_NEW_NAMESPACE')
  for kind,p in self.paths().items():
   if kind=='decision'and not decision:continue
   self.a.exact_path(p,True);need(not os.path.lexists(p)and not os.path.lexists(str(p)+'.pending'),'K01_ATTEMPT_EXISTS_NO_REPLAY')
 def binding(self):return {'pushReceiptSha256':PUSH_RECEIPT_SHA,'pushHelperSha256':PUSH_HELPER_SHA,'activationHelperSha256':ACTIVATION_SHA,'manifestSha256':self.manifest_pin,'helperSha256':self.helper_pin,'workerImage':WORKER,'contentImage':CONTENT,'fullscreenSha256':FULLSCREEN_SHA,'freshLeasePid':self.lease_pid}
 def decision(self,pin):
  d=self.a.pinned(self.paths()['decision'],pin,True);need(set(d)=={'schema','scope','name','rootApproved','observedAtUtc','inputs','before'}and d['schema']==1 and d['scope']=='TWO_PRODUCT_THREE_EDITOR_UI_FILES_KEEP_LIVE_WORKER_FLAGS'and d['name']==NAME and d['rootApproved']is True and d['inputs']==self.binding()and d['before']==self.base,'EXACT_K01_ROOT_DECISION_REQUIRED');self.a.fresh(d['observedAtUtc'],self.clock());return d
 def inspect_current(self):
  current=self.baseline();return {'status':'K01_CURRENT_CHAIN19_READONLY_NOT_APPROVED','contentImage':CONTENT,'sourceFiles':202,'staticFiles':19,'contentChainFiles':19,'freshLeasePid':self.lease_pid,'fullscreenSha256':FULLSCREEN_SHA,'mutations':0,'workerRecreated':False,'uploadsEnabled':True,'roleAcceptanceProven':False}
 def approve(self,apply=False):
  need(apply is True,'EXPLICIT_ROOT_K01_APPROVAL_REQUIRED');self.absent(True);at=self.clock();before=self.baseline();self.stable();self.b.lease();self.a.fresh(self.a.stamp(at),self.clock())
  d={'schema':1,'scope':'TWO_PRODUCT_THREE_EDITOR_UI_FILES_KEEP_LIVE_WORKER_FLAGS','name':NAME,'rootApproved':True,'observedAtUtc':self.a.stamp(at),'inputs':self.binding(),'before':before};self.a.write_new(self.paths()['decision'],d);return {'status':'K01_UI_ROOT_DECISION_READY_NOT_APPLIED','decisionSha256':sha(self.a.read(self.paths()['decision'])),'runtimeWrites':0,'directDbWrites':0}
 def context(self,p,state,alias,built=False):return self.photo.ui.inc.Release.context_proof(self,p,state,alias,built)
 def update(self,j,s,phase,**values):s.update(phase=phase,**values);self.a.replace(j,s)
 def apply(self,pin,apply=False):
  need(apply is True,'EXPLICIT_ROOT_K01_APPLY_REQUIRED');self.absent();d=self.decision(pin);before=self.baseline();p=self.paths();alias='palitra-k01-client-base:'+NAME;tag='palitra-k01-client:'+NAME
  self.photo.unused(alias);self.photo.unused(tag);need(self.run(['docker','image','inspect','--format','{{.Id}}',CONTENT]).decode().strip()==CONTENT,'EXACT_K01_PARENT_IMAGE_REQUIRED');layers=self.a.decode(self.run(['docker','image','inspect','--format','{{json .RootFS.Layers}}',CONTENT]));need(type(layers)is list and layers,'K01_PARENT_LAYERS_REQUIRED')
  self.decision(pin);self.b.lease();self.stable();self.baseline();self.decision(pin)
  s={'schema':1,'name':NAME,'phase':'K01_CONTEXT_STARTED_UNKNOWN','inputs':self.binding(),'decisionSha256':pin,'before':before,'static':[],'automaticRetry':False,'automaticCodeRollback':False,'workerRecreated':False,'uploadsEnabled':True,'directDbWrites':0,'queueEdits':0}
  self.a.write_new(p['journal'],s);p['context'].mkdir(mode=0o700);p['backup'].mkdir(mode=0o700)
  for n,r in sorted(self.records.items()):
   if not n.startswith('product/'):continue
   encoded=self.run(['docker','exec','synapse-content-1','node','-e',self.photo.ui.inc.SOURCE_JS,'palitra-orders-public/'+n.split('/')[-1]]);need(len(encoded)<=3*1024*1024,'BOUNDED_K01_SOURCE_REQUIRED');raw=self.patch(base64.b64decode(encoded,validate=True),r);need(raw==self.a.read(self.payload/n),'K01_SOURCE_NOT_REVIEWED_PAYLOAD');target=p['context']/'app/palitra-orders-public'/n.split('/')[-1];target.parent.mkdir(parents=True,exist_ok=True,mode=0o755);self.photo.u.write(target,raw,0o644)
  for i,(n,r)in enumerate(sorted(self.records.items())):
   target=self.targets[n];old=self.a.read(target);raw=self.patch(old,r);mode=stat.S_IMODE(target.stat().st_mode);backup=p['backup']/str(i);prepared=p['context']/'static'/str(i);prepared.parent.mkdir(exist_ok=True,mode=0o700);self.photo.u.write(backup,old);self.photo.u.write(prepared,raw);s['static'].append({'target':str(target),'baseSha256':r['beforeSha256'],'sha256':r['sha256'],'mode':mode,'backup':str(backup),'prepared':str(prepared),'written':False})
  self.photo.u.write(p['context']/'Dockerfile',('FROM '+alias+'\nCOPY app/ /app/\n').encode());s['contextSha256']=self.context(p['context'],s,alias);self.a.replace(p['journal'],s)
  self.baseline();self.decision(pin);self.photo.unused(alias);self.b.lease();self.run(['docker','image','tag',CONTENT,alias]);need(self.run(['docker','image','inspect','--format','{{.Id}}',alias]).decode().strip()==CONTENT,'K01_PARENT_ALIAS_CHANGED');self.photo.unused(tag);self.update(p['journal'],s,'K01_BUILD_STARTED_UNKNOWN')
  self.decision(pin);self.b.lease();self.stable();need(self.context(p['context'],s,alias)==s['contextSha256']and self.run(['docker','image','inspect','--format','{{.Id}}',alias]).decode().strip()==CONTENT,'K01_LAST_BUILD_INPUT_CHANGED');self.baseline();self.decision(pin)
  iid=p['context']/'image.id';self.run(['docker','build','--network=none','--pull=false','--tag',tag,'--iidfile',str(iid),str(p['context'])]);child=self.a.read(iid).decode().strip();need(self.a.image(child)and child!=CONTENT,'K01_EXACT_CHILD_REQUIRED');need(self.run(['docker','image','inspect','--format','{{.Id}}',tag]).decode().strip()==child and self.context(p['context'],s,alias,True)==s['contextSha256'],'K01_BUILT_CHILD_OR_CONTEXT_CHANGED')
  childlayers=self.a.decode(self.run(['docker','image','inspect','--format','{{json .RootFS.Layers}}',child]));need(childlayers[:len(layers)]==layers and len(childlayers)==len(layers)+1,'K01_EXACT_PARENT_SINGLE_COPY_REQUIRED');need(self.photo.hashes(self.final_source,child)==self.final_source,'K01_CHILD_SOURCE202_CHANGED')
  self.baseline();self.decision(pin);self.stable();self.update(p['journal'],s,'K01_STATIC_STARTED_UNKNOWN',childImage=child)
  for rec in s['static']:need(sha(self.a.read(Path(rec['backup'])))==rec['baseSha256']and sha(self.a.read(Path(rec['prepared'])))==rec['sha256'],'K01_BACKUP_OR_PREPARED_CHANGED')
  self.decision(pin);self.b.lease()
  for rec in s['static']:
   self.decision(pin);raw=self.a.read(Path(rec['prepared']));need(sha(raw)==rec['sha256'],'K01_LAST_PREPARED_STATIC_CHANGED');target=Path(rec['target']);need(sha(self.a.read(target))==rec['baseSha256']and stat.S_IMODE(target.stat().st_mode)==rec['mode'],'K01_STATIC_CAS_CONFLICT');self.photo.atomic(target,raw,rec['mode']);rec['written']=True;self.a.replace(p['journal'],s)
  self.decision(pin);value={'services':{'content':{'image':child}}};self.a.write_new(p['overlay'],value);overlaypin=sha(self.a.read(p['overlay']));planned=self.b.plan(before,'content',p['overlay']);self.update(p['journal'],s,'K01_CONTENT_UP_STARTED_UNKNOWN',overlay=str(p['overlay']),overlaySha256=overlaypin,plannedConfigHash=planned)
  self.baseline(True);self.decision(pin);self.stable();self.b.lease();need(self.context(p['context'],s,alias,True)==s['contextSha256']and self.a.decode(self.a.read(p['overlay']))==value and sha(self.a.read(p['overlay']))==overlaypin,'K01_LAST_UP_INPUT_CHANGED')
  for rec in s['static']:need(sha(self.a.read(Path(rec['backup'])))==rec['baseSha256'],'K01_LAST_BACKUP_CHANGED')
  self.decision(pin);self.b.up(before,'content',p['overlay']);after=self.snapshot(child,True,True);self.transition(before,after,p['overlay'],planned,child);heartbeat=self.b.heartbeat(after['worker']['startedAt'],self.clock());need(heartbeat['freshAfterWorkerStart'],'K01_AFTER_FRESH_HEARTBEAT_REQUIRED');need(self.snapshot(child,True,True)==after,'K01_LATE_CURRENT_STATE_CHANGED');self.stable();self.b.lease();self.update(p['journal'],s,PHASE,after=after,heartbeat=heartbeat,finishedAtUtc=self.a.stamp(self.clock()))
  return {'status':PHASE,'journalSha256':sha(self.a.read(p['journal'])),'contentImage':child,'sourceFiles':202,'staticFiles':19,'contentChainFiles':20,'workerRecreated':False,'uploadsEnabled':True,'directDbWrites':0,'queueEdits':0,'automaticRetry':False,'roleAcceptanceProven':False}
 def transition(self,before,after,overlay,planned,child):
  old=before['containers']['content'];expected=dict(old,image=child,files=old['files']+[str(overlay)],configFiles=','.join(old['files']+[str(overlay)]),filePins={**old['filePins'],str(overlay):sha(self.a.read(overlay))},configHash=planned)
  need(after['containers']['content']==expected and len(expected['files'])==20 and after['containers']['chat']==before['containers']['chat']and after['worker']==before['worker']and after['contentCid']!=before['contentCid']and after['selected']==before['selected']and after['l12']==before['l12'],'K01_ONLY_TWO_PRODUCT_FILES_ONE_CONTENT_OVERLAY_ALLOWED')
 def inspect(self,pin):
  p=self.paths();s=self.a.pinned(p['journal'],pin,True);need(s.get('schema')==1 and s.get('name')==NAME and s.get('phase')==PHASE and s.get('inputs')==self.binding()and s.get('before')==self.base and s.get('workerRecreated')is False and s.get('uploadsEnabled')is True and s.get('automaticRetry')is False and s.get('directDbWrites')==s.get('queueEdits')==0,'EXACT_COMPLETED_K01_RECEIPT_REQUIRED')
  need(s['overlay']==str(p['overlay'])and sha(self.a.read(p['overlay']))==s['overlaySha256']and self.a.decode(self.a.read(p['overlay']))=={'services':{'content':{'image':s['childImage']}}},'K01_COMPLETED_OVERLAY_CHANGED');after=self.snapshot(s['childImage'],True,True);self.transition(self.base,after,p['overlay'],s['plannedConfigHash'],s['childImage']);need(after==s['after'],'K01_COMPLETED_CURRENT_STATE_CHANGED')
  return {'status':'COMPLETED_K01_READONLY_NOT_ROLE_ACCEPTANCE','heartbeat':self.b.heartbeat(after['worker']['startedAt'],self.clock()),'mutations':0,'workerRecreated':False,'uploadsEnabled':True,'roleAcceptanceProven':False}

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('operation',choices=('inspect-current','approve-current','apply','inspect'))
 for n in ('reports-helper','reports-payload','activation-helper','bundle','photo-code','ui-code','l12-code','graph','build-journal','runtime-proof','push-diag-helper','push-diag-payload','payload'):p.add_argument('--'+n,type=Path,required=True)
 for n in ('build-sha','runtime-sha','manifest-sha','reports-manifest-sha'):p.add_argument('--'+n,required=True)
 p.add_argument('--lease-pid',type=int,required=True);p.add_argument('--decision-sha');p.add_argument('--receipt-sha');p.add_argument('--apply',action='store_true');args=p.parse_args()
 try:
  need(os.name=='posix'and os.geteuid()==0,'NATIVE_ROOT_K01_REQUIRED')
  import types
  path=args.activation_helper;raw=path.read_bytes();need(path.is_absolute()and path.is_relative_to(ROOT)and sha(raw)==ACTIVATION_SHA,'FROZEN_ACTIVATION5069_REQUIRED');a=types.ModuleType('k01_accepted5069');a.__file__=str(path);exec(compile(raw,str(path),'exec'),a.__dict__);a.exact_path(path)
  for path in (args.bundle,args.photo_code,args.ui_code,args.l12_code,args.payload,args.reports_payload,args.push_diag_payload):need(a.exact_path(path).is_dir()and path.is_relative_to(ROOT),'ROOT_K01_INPUT_DIRECTORY_REQUIRED')
  need(args.graph.parent==ROOT,'ROOT_K01_GRAPH_PATH_REQUIRED');photo_module=a.load_module(args.photo_code/'photo_ui_release_native.py',a.PHOTO_HELPER_SHA,'k01_photo');graph=a.load_module(args.graph,a.GRAPH_SHA,'k01_graph');x,l=photo_module.loaded(args.bundle,args.ui_code,args.l12_code);photo=photo_module.PhotoRelease(x,l,args.photo_code);b=a.NativeBackend(photo,graph,args.build_journal,args.build_sha,args.runtime_proof,args.runtime_sha)
  need(args.reports_helper.is_relative_to(ROOT)and args.push_diag_helper.is_relative_to(ROOT),'ROOT_FROZEN_K01_HELPERS_REQUIRED');report=a.load_module(args.reports_helper,REPORTS_HELPER_SHA,'k01_reports');reports=report.ReportsRelease(a,b,args.reports_payload,args.reports_manifest_sha);push_module=a.load_module(args.push_diag_helper,PUSH_HELPER_SHA,'k01_push_diag');push=push_module.PushDiagnosticRelease(a,b,reports,args.push_diag_payload,PUSH_MANIFEST_SHA,args.lease_pid);release=K01Release(a,b,push,args.payload,args.manifest_sha,args.lease_pid)
  out=release.inspect_current()if args.operation=='inspect-current'else release.approve(args.apply)if args.operation=='approve-current'else release.apply(args.decision_sha,args.apply)if args.operation=='apply'else release.inspect(args.receipt_sha);print(json.dumps(out,separators=(',',':')));return 0
 except Exception as e:
  message=str(e);code=message if type(e)is ValueError and re.fullmatch('[A-Z][A-Z0-9_]{0,100}',message)else'K01_ACTION_REFUSED';print(json.dumps({'status':'K01_REFUSED_OR_UNKNOWN_INSPECT_PRIVATE_JOURNAL','code':code,'messageSha256':sha(message.encode()),'automaticRetry':False,'automaticCodeRollback':False,'workerRecreated':False,'directDbWrites':0,'queueEdits':0},separators=(',',':')));return 2
if __name__=='__main__':sys.exit(main())
