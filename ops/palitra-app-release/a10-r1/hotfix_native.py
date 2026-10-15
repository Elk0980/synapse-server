"""Root-only A10 shell hotfix AFTER a completed exact Push enable.

One inherited COPY layer and one cabinet shell CAS. No key/DB/model/auth writes.
Writer/rollback are scoped literal copies of accepted f717, with actual Push retained.
"""
import argparse,base64,hashlib,json,os,re,stat,sys,types
from datetime import datetime,timezone
from pathlib import Path
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
PUSH_SHA='7b761a06694ab713b01b974b1ec3090b75b1c3f05bcd5268533bb8b6181b9be8'
FEATURES_RECEIPT='dcc2c3c91029021117321066698cb555896b8cb13cc132e947142dece9e36bae'
FEATURES_IMAGE='sha256:b3af5c8634c8cc99b883c220a8e5e4503c6156c6694482042c715a84a8b604d'
MANIFEST_SHA='d33d4799cb225db9ac85e622750f2bfa49df4bf10c69b754daf0d2be7f08569f'
OLD_SHELL='9db1f2eca6d8c28dd5a670be47a32f0a3904b8ca82eb30d63c7e7bddfe7da2cf'
NEW_SHELL='3ce8a5c307f2011a5872377c8f7a8e599944c6a3a93ff78c80eda52d5507e877'
WORKER_IMAGE='sha256:c5dd4502daf630afaac7415da5b19dc456c81a5f81626574f5480dec04307cca'
WORKER_SOURCE='36b0bdc733ad4f4514635d0416867d5964fef4c82aeabe125f542a20969de0ee'
WORKER_CID='7d7ec369e7ce44e492874137813caf3399b21b0242438b3b6df1281e4f379415'
TARGET='palitra-orders-public/shell.js'

def need(v,m):
 if not v:raise ValueError(m)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def rel(name):
 need(type(name)is str and re.fullmatch('[a-z0-9][a-z0-9.-]{0,63}',name)is not None,'BASENAME_REQUIRED');return name
def write(p,raw,mode=0o600):
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),mode)
 with os.fdopen(fd,'wb')as f:f.write(raw);f.flush();os.fsync(f.fileno())
def loaded(root=ROOT):
 p=root/'push_enable.py';need(not p.is_symlink(),'EXACT_PUSH_HELPER_REQUIRED');raw=p.read_bytes();need(sha(raw)==PUSH_SHA,'EXACT_PUSH_HELPER_REQUIRED');m=types.ModuleType('accepted_a10_push');m.__file__=str(p);exec(compile(raw,str(p),'exec'),m.__dict__);inc,c=m.loaded_incremental(root);c.path(p);return m,inc,c

class Hotfix:
 def __init__(self,push,release,push_name,push_receipt_sha,payload=None,incremental=None,key_directory=None,public_roots=None):
  self.pm=push;self.r=release;self.c=release.c;self.root=release.root;self.run=release.run;self.a=release.a;self.now=release.now;self.cabinet=release.cabinet;self.bundle=self.c.path(payload or Path(__file__).parent);self.msha=MANIFEST_SHA
  options={}
  if key_directory is not None:options['key_directory']=key_directory
  if public_roots is not None:options['public_roots']=public_roots
  self.p=push.PushEnable(release,'features1',FEATURES_RECEIPT,**options)
  need(re.fullmatch('[0-9a-f]{64}',push_receipt_sha or'')is not None,'PUSH_RECEIPT_SHA_REQUIRED');self.push_name=push_name;self.pp=self.p.paths(push_name);self.psha=push_receipt_sha;self.ps=self.r.pin(self.pp['journal'],push_receipt_sha)
  need(self.ps.get('phase')=='PUSH_SERVER_CONFIG_APPLIED_NOT_DEVICE_PROOF'and self.ps.get('name')==push_name and self.ps.get('workerRecreated')is False and self.ps.get('dbWrites')==0 and self.ps['after']['afterImages']=={'content':FEATURES_IMAGE,'chat':WORKER_IMAGE},'EXACT_COMPLETED_PUSH_REQUIRED')
  need(self.p.incremental['after']['afterImages']=={'content':FEATURES_IMAGE,'chat':WORKER_IMAGE}and self.p.incremental['workerProof']['containerId']==WORKER_CID,'EXACT_FEATURES_BASE_AND_WORKER_REQUIRED')
  need(Path(self.ps['overlay'])==self.pp['overlay'],'EXACT_PUSH_OVERLAY_PATH_REQUIRED')
  self.pre=self.r.pin(self.pp['preflight'],self.ps['preflightSha256']);self.k=self.r.pin(self.pp['keys'],self.ps['keyReceiptSha256'])
  need(self.pre.get('schema')==1 and self.pre.get('kind')=='PUSH_ENABLE_PREFLIGHT_NOT_APPROVAL'and self.pre.get('name')==push_name and self.pre.get('incrementalReceiptSha256')==FEATURES_RECEIPT and self.pre.get('manifestSha256')==self.r.msha,'EXACT_PUSH_PREFLIGHT_REQUIRED')
  need(self.ps['before']==self.pre['facts']and self.ps['publicKeySha256']==self.k['publicKeySha256'],'EXACT_PUSH_KEY_LINEAGE_REQUIRED')
  raw=self.c.read(self.bundle/'HUNK_MANIFEST.json');need(sha(raw)==MANIFEST_SHA,'EXACT_A10_MANIFEST_REQUIRED');m=self.c.obj(raw);new=self.c.read(self.bundle/'shell.js');need(sha(new)==NEW_SHELL and m['sourceSha256']==OLD_SHELL and m['outputSha256']==NEW_SHELL,'EXACT_A10_PAYLOAD_REQUIRED')
  common={'payload':'shell.js','baseSha256':OLD_SHELL,'sha256':NEW_SHELL,'bytes':len(new),'edits':m['hunks']};self.m={'records':[dict(common,group='content',target=TARGET),dict(common,group='cabinet',target='shell.js')]}
  self.pinfiles={str(self.bundle/'HUNK_MANIFEST.json'):MANIFEST_SHA,str(self.bundle/'shell.js'):NEW_SHELL,str(self.pp['journal']):self.psha,str(self.pp['preflight']):self.ps['preflightSha256'],str(self.pp['keys']):self.ps['keyReceiptSha256'],str(self.pp['overlay']):self.ps['overlaySha256']}
  need(incremental is not None and type(release)is incremental.Release,'EXACT_INCREMENTAL_RELEASE_REQUIRED');self._inc=incremental
 def __getattr__(self,name):return getattr(self.r,name)
 def stable(self):
  self.r.stable()
  for p,pin in self.pinfiles.items():need(sha(self.c.read(Path(p)))==pin,'A10_REVIEWED_INPUT_CHANGED')
 def paths(self,name):
  need(re.fullmatch('a10-r[1-9][0-9]{0,3}',name or'')is not None,'UNIQUE_A10_RN_REQUIRED');return {k:self.root/(name+'-'+k+('.json'if k.endswith(('decision','journal','overlay'))else''))for k in ('decision','journal','overlay','context','backup','rollback-overlay')}
 def available(self,name,decision=False):
  paths=self.paths(name)
  for key,p in paths.items():
   self.c.path(p,True)
   if key!='decision'or decision:need(not p.exists(),'A10_ATTEMPT_ALREADY_EXISTS_NO_RETRY')
  return paths
 def keys(self):return self.p.verified_keys(self.pp,self.pre,self.ps['keyReceiptSha256'])
 def push_off(self):
  # Inherited writer's guard hook means preserve the exact enabled Push state here.
  self.stable();cid=self.p.cid();keys=self.keys();need(self.p.flag(),'PUSH_ENABLED_STATE_MUST_BE_PRESERVED')
  expected=sorted(self.ps['before']['mounts']+[{'Type':'bind','Source':keys['directory'],'Destination':self.pm.TARGET,'RW':False}],key=lambda row:row['Destination']);mounts=self.p.mounts();need(mounts==expected,'PUSH_RO_MOUNTS_CHANGED');need(self.p.binding(mounts)==self.ps['before']['binding'],'PERSISTENT_DB_BINDING_CHANGED')
  probe=self.c.obj(self.run(['docker','exec','synapse-content-1','node','-e',self.pm.KEY_JS]));need(probe=={'keyValid':True,'publicKeySha256':keys['publicKeySha256'],'webPushVersion':'3.6.7','transportReady':True},'ACTIVE_PUSH_KEY_LIBRARY_CHANGED')
  health=self.c.obj(self.run(['docker','exec','synapse-content-1','node','-e',self.pm.HEALTH_JS]));need(health=={'status':200,'ok':True,'service':'content'},'CONTENT_HEALTH_FAILED');need(self.p.cid()==cid,'CONTENT_CID_CHANGED_DURING_PUSH_READBACK')
 def capture(self):
  self.stable();keys=self.keys();cid=self.p.cid();need(cid==self.ps['contentContainerId'],'COMPLETED_PUSH_CONTENT_CID_CHANGED');snap=self.p.after(self.ps['before'],self.pp['overlay'],self.ps['plannedConfigHash'],keys,enabled=True);need(snap==self.ps['after'],'COMPLETED_PUSH_SNAPSHOT_CHANGED');need(self.p.cid()==cid,'CONTENT_CID_CHANGED_DURING_CAPTURE');need(snap['selected']['content']['PALITRA_WEB_UPLOADS_ENABLED']!='true','MEDIA_MUST_STAY_OFF');return {'snapshot':snap,'contentContainerId':cid,'publicKeySha256':keys['publicKeySha256'],'keyMetadata':keys['keyMetadata'],'binding':self.ps['before']['binding']}
 def approve_current(self,name,*,apply=False):
  need(apply is True,'EXPLICIT_ROOT_APPROVAL_REQUIRED');paths=self.available(name,True);started=self.now();facts=self.capture();self.stable();self.a.lease();need(self.p.cid()==facts['contentContainerId'],'CONTENT_CID_CHANGED_BEFORE_APPROVAL');need(0<=(self.now()-started).total_seconds()<=600,'A10_NATIVE_CHECK_TOO_OLD');value={'schema':1,'scope':'A10_SHELL_ONLY_PUSH_PRESERVED','rootApproved':True,'name':name,'manifestSha256':self.msha,'pushName':self.push_name,'pushReceiptSha256':self.psha,'featuresReceiptSha256':FEATURES_RECEIPT,'contentImage':FEATURES_IMAGE,'workerImage':WORKER_IMAGE,'workerContainerId':WORKER_CID,'workerSourceSha256':WORKER_SOURCE,'pushEnabled':True,'facts':facts,'observedAtUtc':started.isoformat()};self.c.create(paths['decision'],value);return {'status':'A10_ROOT_DECISION_READY_RUNTIME_UNCHANGED','decisionFile':paths['decision'].name,'decisionSha256':sha(self.c.read(paths['decision'])),'contentImage':FEATURES_IMAGE,'workerRecreated':False,'pushEnabled':True,'runtimeWrites':0,'dbWrites':0}
 def decision(self,name,pin):
  rel(name);d=self.r.pin(self.root/name,pin);need(set(d)=={'schema','scope','rootApproved','name','manifestSha256','pushName','pushReceiptSha256','featuresReceiptSha256','contentImage','workerImage','workerContainerId','workerSourceSha256','pushEnabled','facts','observedAtUtc'},'EXACT_A10_DECISION_REQUIRED')
  need(d['schema']==1 and d['scope']=='A10_SHELL_ONLY_PUSH_PRESERVED'and d['rootApproved']is True and d['manifestSha256']==self.msha and d['pushName']==self.push_name and d['pushReceiptSha256']==self.psha and d['featuresReceiptSha256']==FEATURES_RECEIPT and d['contentImage']==FEATURES_IMAGE and d['workerImage']==WORKER_IMAGE and d['workerContainerId']==WORKER_CID and d['workerSourceSha256']==WORKER_SOURCE and d['pushEnabled']is True,'A10_APPROVAL_SCOPE_REQUIRED');need(name==self.paths(d['name'])['decision'].name,'EXACT_A10_DECISION_BASENAME_REQUIRED');at=datetime.fromisoformat(d['observedAtUtc'].replace('Z','+00:00'));need(at.tzinfo is not None and 0<=(self.now()-at).total_seconds()<=600,'A10_DECISION_STALE_OR_FUTURE');return d
 def before(self,d):
  facts=self.capture();need(facts==d['facts'],'A10_APPROVED_BASE_CHANGED');p=self.c.path(self.cabinet/'shell.js');need(self.fingerprint(p)==OLD_SHELL,'A10_STATIC_BASE_CHANGED');return facts['snapshot'],[(self.m['records'][1],p)]
 def expected_hashes(self,new=False):
  values=self.r.expected_hashes(True);need(values.get(TARGET)==OLD_SHELL,'ACCEPTED_FEATURES_SHELL_MUST_MATCH');values[TARGET]=NEW_SHELL if new else OLD_SHELL;return values
 def patch(self,raw,record):
  need(sha(raw)==OLD_SHELL,'EXACT_HUNK_BASE_CHANGED')
  for edit in record['edits']:
   before=edit['before'].encode();after=edit['after'].encode();need(before and raw.count(before)==1,'EXACT_HUNK_UNIQUE_REQUIRED');raw=raw.replace(before,after,1)
  need(sha(raw)==NEW_SHELL and raw==self.c.read(self.bundle/'shell.js'),'PATCHED_OUTPUT_SHA_CHANGED');return raw
 def tree(self,root):return self._inc.Release.tree(self,root)
 def context_proof(self,*args):return self._inc.Release.context_proof(self,*args)
 def static_after(self,state):
  for r in self.p.incremental['static']:
   expected=NEW_SHELL if Path(r['target'])==self.cabinet/'shell.js'else r['sha256'];need(self.fingerprint(Path(r['target']))==expected,'STATIC_CHANGED_AFTER_APPLY')

 def apply(self,name,decision_name,decision_sha,*,apply=False):
  need(apply is True,'EXPLICIT_ROOT_APPLY_REQUIRED');self.available(name);need(decision_name==self.paths(name)['decision'].name,'EXACT_A10_DECISION_BASENAME_REQUIRED');need(re.fullmatch('[a-z0-9][a-z0-9-]{0,31}',name)is not None,'UNIQUE_SHORT_RELEASE_REQUIRED');d=self.decision(decision_name,decision_sha);before,static=self.before(d);context=self.root/(name+'-context');journal=self.root/(name+'-journal.json');overlay=self.root/(name+'-overlay.json');backup=self.root/(name+'-backup');alias='palitra-a10-base:'+name;tag='palitra-a10:'+name
  for p in [context,journal,overlay,backup,self.root/(name+'-rollback-overlay.json')]:self.c.path(p,True);need(not p.exists(),'UNKNOWN_OR_PREVIOUS_ATTEMPT_NO_RETRY')
  self.unused(alias);self.unused(tag);need(self.run(['docker','image','inspect','--format','{{.Id}}',d['contentImage']]).decode().strip()==d['contentImage'],'EXACT_LOCAL_CURRENT_CONTENT_IMAGE_REQUIRED');layers=self.c.obj(self.run(['docker','image','inspect','--format','{{json .RootFS.Layers}}',d['contentImage']]));need(type(layers)is list and layers,'CURRENT_CONTENT_LAYER_PROOF_REQUIRED')
  context.mkdir(mode=0o700);backup.mkdir(mode=0o700);state={'schema':1,'phase':'A10_CONTEXT_STARTED_UNKNOWN','name':name,'manifestSha256':self.msha,'decisionFile':decision_name,'decisionSha256':decision_sha,'before':before,'workerProof':{'containerId':d['workerContainerId'],'sourceSha256':WORKER_SOURCE},'workerRecreated':False,'pushEnabled':True,'dbWrites':0,'static':[]};self.c.create(journal,state)
  # Build material comes from exact hunks applied to actual running source bytes, not old file replacement.
  for r in self.m['records']:
   if r['group']!='content':continue
   if r['baseSha256']is None:raw=self.c.read(self.bundle/r['payload'])
   else:
    encoded=self.run(['docker','exec','synapse-content-1','node','-e',self._inc.SOURCE_JS,r['target']]);need(len(encoded)<=3*1024*1024,'BOUNDED_CURRENT_SOURCE_REQUIRED');raw=self.patch(base64.b64decode(encoded,validate=True),r)
   p=context/'app'/r['target'];p.parent.mkdir(mode=0o755,parents=True,exist_ok=True);write(p,raw,0o644)
  for i,(r,p)in enumerate(static):
   old=self.c.read(p)if p.exists()else None;raw=self.patch(old,r)if old is not None else self.c.read(self.bundle/r['payload']);mode=stat.S_IMODE(p.stat().st_mode)if p.exists()else 0o644;copy=context/'static'/str(i);copy.parent.mkdir(mode=0o700,exist_ok=True);write(copy,raw);record={'target':str(p),'baseSha256':r['baseSha256'],'sha256':r['sha256'],'prepared':str(copy),'mode':mode,'backup':str(backup/str(i))if old is not None else None,'written':False}
   if old is not None:write(Path(record['backup']),old)
   state['static'].append(record)
  write(context/'Dockerfile',('FROM '+alias+'\nCOPY app/ /app/\n').encode());state['contextSha256']=self.context_proof(context,state,alias);self.c.replace(journal,state)
  self.decision(decision_name,decision_sha);current,unused=self.before(d);self.compare(current,before,before['afterImages']);self.unused(alias);self.a.lease();self.decision(decision_name,decision_sha);self.run(['docker','image','tag',d['contentImage'],alias]);need(self.run(['docker','image','inspect','--format','{{.Id}}',alias]).decode().strip()==d['contentImage'],'LOCAL_ALIAS_CHANGED');self.unused(tag);state['phase']='A10_BUILD_STARTED_UNKNOWN';self.c.replace(journal,state);iid=context/'image.id';need(self.context_proof(context,state,alias)==state['contextSha256'],'BUILD_CONTEXT_CHANGED');self.decision(decision_name,decision_sha);self.a.lease();need(self.run(['docker','image','inspect','--format','{{.Id}}',alias]).decode().strip()==d['contentImage'],'LOCAL_ALIAS_CHANGED_BEFORE_BUILD');need(self.p.cid()==d['facts']['contentContainerId'],'CONTENT_CID_CHANGED_BEFORE_BUILD');self.decision(decision_name,decision_sha);self.run(['docker','build','--network=none','--pull=false','--tag',tag,'--iidfile',str(iid),str(context)]);child=self.c.read(iid).decode().strip();need(self.c.image(child)and child!=d['contentImage'],'CHILD_IMAGE_REQUIRED');need(self.context_proof(context,state,alias,True)==state['contextSha256'],'BUILD_CONTEXT_CHANGED_DURING_BUILD');need(self.run(['docker','image','inspect','--format','{{.Id}}',tag]).decode().strip()==child,'CHILD_IMAGE_TAG_CHANGED');childlayers=self.c.obj(self.run(['docker','image','inspect','--format','{{json .RootFS.Layers}}',child]));need(childlayers[:len(layers)]==layers and len(childlayers)==len(layers)+1,'ONE_COPY_EXACT_PARENT_REQUIRED');expected=self.expected_hashes(True);need(self.hashes(expected,child)==expected,'CHILD_SOURCE_READBACK_FAILED')
  current,unused=self.before(d);self.compare(current,before,before['afterImages']);self.decision(decision_name,decision_sha);state.update(phase='A10_STATIC_STARTED_UNKNOWN',childImage=child,contextTreeSha256=self.tree(context/'app'));self.c.replace(journal,state)
  for rec in state['static']:
   p=Path(rec['target']);need(self.fingerprint(p)==rec['baseSha256'],'STATIC_CAS_CONFLICT');raw=self.c.read(Path(rec['prepared']));need(sha(raw)==rec['sha256'],'PREPARED_STATIC_CHANGED');self.atomic(p,raw,rec['mode']);rec['written']=True;self.c.replace(journal,state)
  self.c.create(overlay,{'services':{'content':{'image':child}}});overlay_sha=sha(self.c.read(overlay));planned=self.plan_hash(before,overlay);state.update(phase='A10_CONTENT_UP_STARTED_UNKNOWN',overlay=str(overlay),overlaySha256=overlay_sha,plannedConfigHash=planned);self.c.replace(journal,state)
  self.stable();self.decision(decision_name,decision_sha);self.compare(self.a.snapshot(),before,before['afterImages']);need(self.hashes(self.expected_hashes())==self.expected_hashes(),'PRE_UP_SOURCE_DRIFT');self.static_after(state);self.worker(d);self.push_off();self.worker(d);self.a.lease();need(sha(self.c.read(overlay))==overlay_sha and self.tree(context/'app')==state['contextTreeSha256'],'LAST_INPUT_DRIFT');need(self.p.cid()==d['facts']['contentContainerId'],'CONTENT_CID_CHANGED_BEFORE_UP');self.decision(decision_name,decision_sha);self.run(self.command(before,overlay,['up','--detach','--no-build','--pull','never','--no-deps','content']));after_cid=self.p.cid();need(after_cid!=d['facts']['contentContainerId'],'CONTENT_RECREATION_EXPECTED');after=self.a.snapshot();images={'content':child,'chat':WORKER_IMAGE};self.compare(after,before,images,overlay,planned);self.worker(d);self.push_off();need(self.hashes(expected)==expected,'ACTIVE_CHILD_SOURCE_READBACK_FAILED');self.static_after(state);need(self.p.cid()==after_cid,'CONTENT_CID_CHANGED_DURING_READBACK');state.update(phase='A10_CONTENT_AND_STATIC_APPLIED_NOT_PUBLIC_PROOF',after=after,contentContainerId=after_cid);self.c.replace(journal,state);return {'status':state['phase'],'journalFile':journal.name,'journalSha256':sha(self.c.read(journal)),'images':images,'workerRecreated':False,'pushEnabled':True,'dbWrites':0,'publicReady':False}
 def rollback(self,name,journal_sha,*,apply=False):
  need(apply is True and re.fullmatch('[a-z0-9][a-z0-9-]{0,31}',name)is not None,'EXPLICIT_ROOT_ROLLBACK_REQUIRED');journal=self.root/(name+'-journal.json');r=self.pin(journal,journal_sha);need(r.get('phase')=='A10_CONTENT_AND_STATIC_APPLIED_NOT_PUBLIC_PROOF'and r.get('manifestSha256')==self.msha,'COMPLETED_EXACT_RECEIPT_REQUIRED');before=r['before'];after=r['after'];self.stable();self.push_off();need(self.p.cid()==r['contentContainerId'],'COMPLETED_CONTENT_CID_CHANGED');current=self.a.snapshot();self.compare(current,before,after['afterImages'],Path(r['overlay']),r['plannedConfigHash']);self.worker({'workerContainerId':r['workerProof']['containerId']});self.static_after(r)
  for rec in r['static']:
   if rec['backup']:need(sha(self.c.read(Path(rec['backup'])))==rec['baseSha256'],'BACKUP_CHANGED')
  need(self.hashes(self.expected_hashes(True))==self.expected_hashes(True),'ROLLBACK_ACTIVE_SOURCE_DRIFT');need(sha(self.c.read(Path(r['overlay'])))==r['overlaySha256'],'APPLIED_OVERLAY_CHANGED');old=before['afterImages']['content'];need(self.run(['docker','image','inspect','--format','{{.Id}}',old]).decode().strip()==old,'EXACT_PREVIOUS_CONTENT_IMAGE_MISSING');overlay=self.root/(name+'-rollback-overlay.json');self.c.create(overlay,{'services':{'content':{'image':old}}});pin=sha(self.c.read(overlay));planned=self.plan_hash(current,overlay);r['phase']='A10_ROLLBACK_STARTED_UNKNOWN';self.c.replace(journal,r);self.compare(self.a.snapshot(),before,after['afterImages'],Path(r['overlay']),r['plannedConfigHash']);self.static_after(r);self.worker({'workerContainerId':r['workerProof']['containerId']});self.a.lease();need(sha(self.c.read(overlay))==pin,'ROLLBACK_OVERLAY_CHANGED');self.push_off();need(self.p.cid()==r['contentContainerId'],'COMPLETED_CONTENT_CID_CHANGED');need(sha(self.c.read(journal))==sha(self.c.data(r)),'ROLLBACK_JOURNAL_CHANGED');self.a.lease();self.run(self.command(current,overlay,['up','--detach','--no-build','--pull','never','--no-deps','content']));restored=self.a.snapshot();self.compare(restored,current,before['afterImages'],overlay,planned);need(self.hashes(self.expected_hashes())==self.expected_hashes(),'ROLLED_BACK_SOURCE_READBACK_FAILED')
  # Restore static only after the old content image is proven running; reverse CAS order.
  for rec in r['static']:
   if rec['backup']:need(sha(self.c.read(Path(rec['backup'])))==rec['baseSha256'],'BACKUP_CHANGED_AFTER_CONTENT_ROLLBACK')
  for rec in reversed(r['static']):
   p=Path(rec['target']);need(self.fingerprint(p)==rec['sha256'],'ROLLBACK_STATIC_CAS_CONFLICT')
   if rec['backup']:
    backup_raw=self.c.read(Path(rec['backup']));need(sha(backup_raw)==rec['baseSha256'],'BACKUP_CHANGED_BEFORE_RESTORE');self.atomic(p,backup_raw,rec['mode'])
   else:p.unlink()
  self.worker({'workerContainerId':r['workerProof']['containerId']});self.push_off();self.r.static_after(self.p.incremental);r.update(phase='A10_CODE_ROLLED_BACK_NO_DB_RESTORE',afterRollback=restored);self.c.replace(journal,r);return {'status':r['phase'],'images':restored['afterImages'],'workerRecreated':False,'dbRestore':False}
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('operation',choices=['approve-current','apply','rollback']);p.add_argument('--bundle',type=Path,required=True);p.add_argument('--push-name',required=True);p.add_argument('--push-receipt-sha',required=True);p.add_argument('--name',required=True);p.add_argument('--decision-sha');p.add_argument('--receipt-sha');p.add_argument('--apply',action='store_true');args=p.parse_args()
 try:
  need(args.apply,'EXPLICIT_ROOT_APPLY_REQUIRED');need(os.name=='posix'and os.geteuid()==0,'NATIVE_ROOT_ONLY');pm,inc,c=loaded();release=inc.Release(c,args.bundle,pm.MANIFEST_SHA);h=Hotfix(pm,release,args.push_name,args.push_receipt_sha,incremental=inc)
  if args.operation=='approve-current':out=h.approve_current(args.name,apply=True)
  elif args.operation=='apply':h.available(args.name);out=h.apply(args.name,args.name+'-decision.json',args.decision_sha,apply=True)
  else:out=h.rollback(args.name,args.receipt_sha,apply=True)
  print(json.dumps(out,separators=(',',':')));return 0
 except BaseException as error:
  code=str(error);code=code if re.fullmatch('[A-Z][A-Z0-9_]{0,100}',code)else'ACCEPTED_GUARD_REFUSED';print(json.dumps({'status':'REFUSED_UNKNOWN_DO_NOT_RETRY','operation':args.operation,'code':code,'automaticRetry':False,'dbRestore':False}));return 2
if __name__=='__main__':sys.exit(main())
