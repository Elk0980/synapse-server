"""Root-only incremental content/static release. Exact source hunks, inherited image, no DB.
Worker/media/keys/push configuration unchanged. No retries or automatic rollback.
"""
import argparse,base64,hashlib,io,json,os,re,stat,sys,types,zipfile
from datetime import datetime,timezone
from pathlib import Path,PurePosixPath
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
CORE_SHA='60a129b3467068932e0d1ca5529f808a76f36f52027990d71bd19d588149db4b'
CURRENT_CONTENT='sha256:cdac3eefe2074320716cb54e8b2e3524eb3a9e80a3c287cf66a11b08483d15db'
CURRENT_WORKER_CID='7d7ec369e7ce44e492874137813caf3399b21b0242438b3b6df1281e4f379415'
FROZEN_MANIFEST='dd82ce11f239823d005a0e05132f92b640776984f01013094d07e07e62c6d812'
NATIVE_TRUE='c23c78fd5d86f30a3bd538de3298a0e844e775a63ffad6403581a3f14f7997ea'
WORKER_IMAGE='sha256:c5dd4502daf630afaac7415da5b19dc456c81a5f81626574f5480dec04307cca'
WORKER_SOURCE='36b0bdc733ad4f4514635d0416867d5964fef4c82aeabe125f542a20969de0ee'
CABINET=Path('/opt/synapse/sites/synapse/cabinet/palitra-orders')
UI={'shell.js','synapse-bridge.js','native-host.js','shop.html','cabinet.html','workflow-ui.js','workflow-ui.css','push-adapter.js','palitra-sw.js','manifest-shop.webmanifest','manifest-cabinet.webmanifest','assets/palitra-app-192.png','assets/palitra-app-512.png'}
CONTENT={'server.js','customer-chat.js','client-dialogs.js','customer-chat-native-adapter.cjs','site-orders.js','palitra-crm/app/lib/workspace.js','palitra-host-adapter.cjs','palitra-workflow.cjs','native-contact-followup.cjs','palitra-push.cjs','palitra-push-http.cjs','palitra-push-host.cjs','palitra-push-keys.cjs','palitra-push-transport.cjs'}|{'palitra-orders-public/'+n for n in UI if n!='cabinet.html'}
HASH_JS="const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');const names=JSON.parse(process.argv[1]),o={};for(const n of names){const f=p.join('/app',n);let absent=false;for(let q=f;;q=p.dirname(q)){try{if(fs.lstatSync(q).isSymbolicLink())throw Error('LINK')}catch(e){if(e.code==='ENOENT'){absent=true}else throw e}if(q==='/')break}o[n]=absent?null:c.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}console.log(JSON.stringify(o));"
SOURCE_JS="const fs=require('node:fs'),p=require('node:path');const f=p.join('/app',process.argv[1]);for(let q=f;;q=p.dirname(q)){if(fs.lstatSync(q).isSymbolicLink())throw Error('LINK');if(q==='/')break}if(fs.statSync(f).size>2097152)throw Error('SIZE');process.stdout.write(fs.readFileSync(f).toString('base64'));"
PUSH_OFF_JS="process.stdout.write(process.env.PALITRA_WEB_PUSH_ENABLED==='true'?'true':'false');"
def need(v,m):
 if not v:raise ValueError(m)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def rel(s):
 need(type(s)is str and s and '\\'not in s and ':'not in s and '\x00'not in s and all(p not in ('','.','..')for p in s.split('/'))and str(PurePosixPath(s))==s and not s.startswith('/'),'BAD_RELATIVE_PATH');return s
def write(p,raw,mode=0o600):
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),mode)
 with os.fdopen(fd,'wb')as f:f.write(raw);f.flush();os.fsync(f.fileno())
def pinned_core(root=ROOT):
 p=root/'activate_root.py';raw=p.read_bytes();need(sha(raw)==CORE_SHA and not p.is_symlink(),'EXACT_ACCEPTED_CORE_REQUIRED');m=types.ModuleType('accepted_incremental_core');m.__file__=str(p);exec(compile(raw,str(p),'exec'),m.__dict__);m.path(p);return m
def extract(core,archive,output,archive_sha,manifest_sha,*,apply=False):
 need(apply is True,'EXPLICIT_ROOT_EXTRACT_REQUIRED');output=core.path(output,True);need(output.parent==ROOT and not output.exists(),'NEW_PRIVATE_RELEASE_DIRECTORY_REQUIRED');raw=core.read(archive);need(sha(raw)==archive_sha,'ARCHIVE_SHA_CHANGED')
 with zipfile.ZipFile(io.BytesIO(raw))as z:
  names=z.namelist();need(len(names)==len(set(names))and 1<len(names)<=241,'EXACT_UNIQUE_ZIP_MEMBERS_REQUIRED');need(sum(i.file_size for i in z.infolist())<=32*1024*1024,'ZIP_TOTAL_BOUND')
  for info in z.infolist():rel(info.filename);need(not info.is_dir()and not stat.S_ISLNK(info.external_attr>>16)and 0<info.file_size<=16*1024*1024,'ZIP_ENTRY_REFUSED')
  mraw=z.read('manifest.json');need(sha(mraw)==manifest_sha,'MANIFEST_SHA_CHANGED');m=core.obj(mraw);need(m.get('status')=='INCREMENTAL_SOURCE_ONLY_NOT_INSTALLED'and m.get('uiPending')is False,'REVIEWED_MANIFEST_REQUIRED');expected={r['payload']:r for r in m['records']};need(len(expected)==len(m['records'])and set(names)==set(expected)|{'manifest.json'},'ZIP_MUST_CONTAIN_ONLY_EXACT_PAYLOADS');payload={};total=0
  for info in z.infolist():
   name=rel(info.filename);need(not info.is_dir()and not stat.S_ISLNK(info.external_attr>>16)and 0<info.file_size<=16*1024*1024,'ZIP_ENTRY_REFUSED');data=z.read(info);total+=len(data);need(total<=32*1024*1024,'ZIP_TOTAL_BOUND')
   if name!='manifest.json':need(sha(data)==expected[name]['sha256']and len(data)==expected[name]['bytes'],'ZIP_PAYLOAD_CHANGED')
   payload[name]=data
  output.mkdir(mode=0o700)
  for name,data in payload.items():p=output/name;p.parent.mkdir(mode=0o700,parents=True,exist_ok=True);write(p,data)
 return {'status':'INCREMENTAL_CODE_EXTRACTED_NOT_INSTALLED','files':len(payload),'manifestSha256':manifest_sha,'nativeRuntimeWrites':0,'dbWrites':0}
class Release:
 def __init__(self,core,bundle,manifest_sha,root=ROOT,runner=None,now=None,cabinet=CABINET):
  self.c=core;self.root=core.path(root);self.bundle=core.path(bundle);self.run=runner or core.native;self.a=core.Activate(root,self.run);self.now=now or(lambda:datetime.now(timezone.utc));self.cabinet=Path(cabinet);self.msha=manifest_sha;raw=core.read(self.bundle/'manifest.json');need(sha(raw)==manifest_sha,'MANIFEST_SHA_CHANGED');self.m=core.obj(raw);self.validate_manifest();self.pinfiles={str(self.bundle/'manifest.json'):manifest_sha}
  for r in self.m['records']:
   p=core.path(self.bundle/rel(r['payload']));raw=core.read(p);need(sha(raw)==r['sha256']and len(raw)==r['bytes'],'PAYLOAD_CHANGED');self.pinfiles[str(p)]=r['sha256']
 def validate_manifest(self):
  m=self.m;need(m.get('schema')==1 and m.get('status')=='INCREMENTAL_SOURCE_ONLY_NOT_INSTALLED'and m.get('uiPending')is False and m.get('workerUnchanged')is True and m.get('mediaUploadsEnabled')is False and m.get('pushEnabledByThisPackage')is False and m.get('frozenNativeManifestSha256')==FROZEN_MANIFEST,'EXPLICIT_REVIEWED_INCREMENTAL_ONLY')
  need(len(m['source39'])==39 and m['source39']['palitra-orders-public/native-host.js']==NATIVE_TRUE and 1<=len(m['records'])<=240,'EXACT_SOURCE39_REQUIRED');seen=set()
  for r in m['records']:
   need(set(r)=={'group','target','payload','baseSha256','sha256','bytes','edits'},'EXACT_RECORD_REQUIRED');g,n=r['group'],rel(r['target']);need((g,n)not in seen,'DUPLICATE_TARGET');seen.add((g,n));rel(r['payload']);need(type(r['bytes'])is int and 0<r['bytes']<=16*1024*1024,'BOUNDED_PAYLOAD_REQUIRED')
   need((g=='content'and(n in CONTENT or n.startswith('palitra-push-deps/node_modules/')))or(g=='cabinet'and n in UI and n!='shop.html')or(g=='managed'and n=='assets/storefront.js'),'TARGET_OUTSIDE_INCREMENTAL_ALLOWLIST')
   need(re.fullmatch('[0-9a-f]{64}',r['sha256'])and(r['baseSha256']is None or re.fullmatch('[0-9a-f]{64}',r['baseSha256'])),'RECORD_PIN_REQUIRED');need(bool(r['edits'])==(r['baseSha256']is not None),'EXACT_HUNKS_OR_NEW_FILE_REQUIRED')
  need(not any('private'in r['target']or r['target'].endswith(('.sqlite','.db','.pem'))for r in m['records']),'PRIVATE_PAYLOAD_REFUSED')
 def pin(self,p,s):raw=self.c.read(p);need(sha(raw)==s,'PRIVATE_ARTIFACT_CHANGED');return self.c.obj(raw)
 def stable(self):
  for name,pin in self.pinfiles.items():need(sha(self.c.read(Path(name)))==pin,'REVIEWED_INPUT_CHANGED')
 def decision(self,name,pin):
  c=self.c;rel(name);need('/'not in name,'DECISION_BASENAME_REQUIRED');d=self.pin(self.root/name,pin);need(set(d)=={'schema','rootApproved','manifestSha256','contentImage','workerImage','workerContainerId','workerSourceSha256','mediaUploadsDisabled','workerMustRemainRunning','pushEnabled','observedAtUtc'},'EXACT_ROOT_DECISION_REQUIRED')
  need(d['schema']==1 and d['rootApproved']is True and d['manifestSha256']==self.msha and d['contentImage']==CURRENT_CONTENT and d['workerImage']==WORKER_IMAGE and d['workerSourceSha256']==WORKER_SOURCE and d['workerContainerId']==CURRENT_WORKER_CID and d['mediaUploadsDisabled']is True and d['workerMustRemainRunning']is True and d['pushEnabled']is False,'ROOT_APPROVAL_SCOPE_REQUIRED');at=datetime.fromisoformat(d['observedAtUtc'].replace('Z','+00:00'));need(at.tzinfo is not None and 0<=(self.now()-at).total_seconds()<=600,'ROOT_DECISION_STALE_OR_FUTURE');return d
 def frozen(self):
  raw=self.c.read(self.root/'bundle-root-final/manifest.json');need(sha(raw)==FROZEN_MANIFEST,'FROZEN_NATIVE_MANIFEST_CHANGED');m=self.c.obj(raw);expected={r['target']:r['sha256']for r in m['content']};expected['palitra-orders-public/native-host.js']=NATIVE_TRUE;need(expected==self.m['source39'],'SOURCE39_NOT_EXACT_FROZEN_LINEAGE');return m
 def hashes(self,names,image=None):
  args=['docker','exec','synapse-content-1','node','-e',HASH_JS,json.dumps(sorted(names),separators=(',',':'))]if image is None else['docker','run','--rm','--network','none','--read-only','--entrypoint','node',image,'-e',HASH_JS,json.dumps(sorted(names),separators=(',',':'))]
  out=self.c.obj(self.run(args));need(set(out)==set(names),'EXACT_SOURCE_HASH_PROJECTION_REQUIRED');return out
 def worker(self,d):
  cid=self.run(['docker','inspect','--format','{{.Id}}','synapse-chat-1']).decode().strip();need(cid==d['workerContainerId'],'WORKER_CONTAINER_CHANGED');value=self.run(['docker','exec','synapse-chat-1','sha256sum','/app/client-bot-bridge.js']).decode().split();need(len(value)==2 and value[0]==WORKER_SOURCE and value[1]=='/app/client-bot-bridge.js','WORKER_SOURCE_CHANGED')
 def push_off(self):need(self.run(['docker','exec','synapse-content-1','node','-e',PUSH_OFF_JS])==b'false','PUSH_CONFIGURATION_REQUIRES_SEPARATE_ROOT_DECISION')
 def statics(self,frozen):
  rows=[];managed=self.c.path(frozen['roots']['customer']);need(managed.is_dir(),'CAPTURED_MANAGED_ROOT_REQUIRED')
  for r in self.m['records']:
   if r['group']=='content':continue
   p=self.c.path((self.cabinet if r['group']=='cabinet'else managed)/r['target'],True);need(p.parent.is_dir(),'EXISTING_PUBLIC_PARENT_REQUIRED');rows.append((r,p))
  return rows
 def fingerprint(self,p):return sha(self.c.read(p))if p.exists()else None
 def expected_hashes(self,new=False):
  expected=dict(self.m['source39'])
  for r in self.m['records']:
   if r['group']=='content':expected[r['target']]=r['sha256']if new else r['baseSha256']
  return expected
 def before(self,d):
  self.stable();frozen=self.frozen();snap=self.a.snapshot();need(snap['afterImages']=={'content':d['contentImage'],'chat':WORKER_IMAGE},'APPROVED_RUNNING_IMAGES_CHANGED');receipt_path=self.root/'frontend-runtime-journal.json';rraw=self.c.read(receipt_path);r4=self.c.obj(rraw);need(r4.get('phase')=='FRONTEND_CONTENT_APPLIED_NOT_PUBLIC_PROOF'and r4.get('images')=={'content':CURRENT_CONTENT,'chat':WORKER_IMAGE},'EXACT_COMPLETED_R4_BASE_REQUIRED');prior=self.pinfiles.setdefault(str(receipt_path),sha(rraw));need(sha(rraw)==prior,'R4_RECEIPT_CHANGED');self.a.same(snap,r4['after'],r4['images'],r4['after']['selected']);self.worker(d);self.push_off();need(snap['selected']['content']['PALITRA_WEB_UPLOADS_ENABLED']!='true','MEDIA_MUST_STAY_DISABLED');expected=self.expected_hashes();need(self.hashes(expected)==expected,'SOURCE39_OR_EXACT_CHANGED_TARGET_BASE_DRIFT')
  static=self.statics(frozen)
  for r,p in static:need(self.fingerprint(p)==r['baseSha256'],'STATIC_BASE_CHANGED')
  return snap,static
 def approve_current(self,name,*,apply=False):
  need(apply is True,'EXPLICIT_ROOT_APPROVAL_REQUIRED');need(re.fullmatch('[a-z0-9][a-z0-9-]{0,31}',name)is not None,'UNIQUE_SHORT_RELEASE_REQUIRED');p=self.c.path(self.root/(name+'-decision.json'),True);need(not p.exists(),'EXISTING_ROOT_DECISION_NO_OVERWRITE');started=self.now();d={'schema':1,'rootApproved':True,'manifestSha256':self.msha,'contentImage':CURRENT_CONTENT,'workerImage':WORKER_IMAGE,'workerContainerId':CURRENT_WORKER_CID,'workerSourceSha256':WORKER_SOURCE,'mediaUploadsDisabled':True,'workerMustRemainRunning':True,'pushEnabled':False,'observedAtUtc':started.isoformat()};before,static=self.before(d);self.stable();need(0<=(self.now()-started).total_seconds()<=600,'ACTUAL_NATIVE_CHECK_TOO_OLD');self.c.create(p,d);return {'status':'ROOT_DECISION_CREATED_RUNTIME_UNCHANGED','decisionFile':p.name,'decisionSha256':sha(self.c.read(p)),'images':before['afterImages'],'source39Checked':39,'staticBasesChecked':len(static),'workerContainerId':CURRENT_WORKER_CID,'pushEnabled':False,'runtimeWrites':0,'dbWrites':0}
 def compare(self,current,before,images,overlay=None,config_hash=None):
  need(current['afterImages']==images and current['selected']==before['selected'],'IMAGE_OR_SELECTED_CONFIGURATION_CHANGED');need(current['containers']['chat']==before['containers']['chat'],'WORKER_OR_ITS_COMPOSE_CHAIN_CHANGED');a,b=current['containers']['content'],before['containers']['content'];need(a['project']==b['project']and a['workingDir']==b['workingDir']and a['files']==b['files']+([str(overlay)]if overlay else[]),'CONTENT_COMPOSE_CHAIN_CHANGED')
  for p,pin in b['filePins'].items():need(a['filePins'].get(p)==pin,'COMPOSE_SOURCE_CHANGED')
  need(a['configHash']==(config_hash or b['configHash']),'OPAQUE_COMPOSE_CONFIG_CHANGED')
 def command(self,before,overlay,operation):
  b=before['containers']['content'];args=['docker','compose','--project-name',b['project'],'--project-directory',b['workingDir']]
  for p in b['files']+[str(overlay)]:args+=['--file',p]
  return args+operation
 def plan_hash(self,before,overlay):
  raw=self.run(self.command(before,overlay,['config','--hash','content'])).decode().strip();match=re.fullmatch('content\\s+([0-9a-f]{64})',raw);need(match is not None,'PLANNED_CONFIG_HASH_REQUIRED');return match.group(1)
 def patch(self,raw,r):
  need(sha(raw)==r['baseSha256'],'EXACT_HUNK_BASE_CHANGED')
  for e in r['edits']:
   need(set(e)=={'before','after'}and type(e['before'])is str and type(e['after'])is str,'EXACT_TEXT_HUNK_REQUIRED');a=e['before'].encode();b=e['after'].encode();need(a and raw.count(a)==1,'EXACT_HUNK_UNIQUE_REQUIRED');raw=raw.replace(a,b,1)
  need(sha(raw)==r['sha256']and raw==self.c.read(self.bundle/r['payload']),'PATCHED_OUTPUT_SHA_CHANGED');return raw
 def unused(self,tag):need(not self.run(['docker','image','ls','--quiet','--filter','reference='+tag]).strip(),'UNIQUE_IMAGE_TAG_EXISTS')
 def atomic(self,p,raw,mode):
  pending=p.with_name(p.name+'.palitra-incremental-pending');self.c.path(pending,True);write(pending,raw,mode);os.replace(pending,p)
 def apply(self,name,decision_name,decision_sha,*,apply=False):
  need(apply is True,'EXPLICIT_ROOT_APPLY_REQUIRED');need(re.fullmatch('[a-z0-9][a-z0-9-]{0,31}',name)is not None,'UNIQUE_SHORT_RELEASE_REQUIRED');d=self.decision(decision_name,decision_sha);before,static=self.before(d);context=self.root/(name+'-context');journal=self.root/(name+'-journal.json');overlay=self.root/(name+'-overlay.json');backup=self.root/(name+'-backup');alias='palitra-incremental-base:'+name;tag='palitra-incremental:'+name
  for p in [context,journal,overlay,backup,self.root/(name+'-rollback-overlay.json')]:self.c.path(p,True);need(not p.exists(),'UNKNOWN_OR_PREVIOUS_ATTEMPT_NO_RETRY')
  self.unused(alias);self.unused(tag);need(self.run(['docker','image','inspect','--format','{{.Id}}',d['contentImage']]).decode().strip()==d['contentImage'],'EXACT_LOCAL_CURRENT_CONTENT_IMAGE_REQUIRED');layers=self.c.obj(self.run(['docker','image','inspect','--format','{{json .RootFS.Layers}}',d['contentImage']]));need(type(layers)is list and layers,'CURRENT_CONTENT_LAYER_PROOF_REQUIRED')
  context.mkdir(mode=0o700);backup.mkdir(mode=0o700);state={'schema':1,'phase':'INCREMENTAL_CONTEXT_STARTED_UNKNOWN','name':name,'manifestSha256':self.msha,'decisionFile':decision_name,'decisionSha256':decision_sha,'before':before,'workerProof':{'containerId':d['workerContainerId'],'sourceSha256':WORKER_SOURCE},'workerRecreated':False,'pushEnabled':False,'dbWrites':0,'static':[]};self.c.create(journal,state)
  # Build material comes from exact hunks applied to actual running source bytes, not old file replacement.
  for r in self.m['records']:
   if r['group']!='content':continue
   if r['baseSha256']is None:raw=self.c.read(self.bundle/r['payload'])
   else:
    encoded=self.run(['docker','exec','synapse-content-1','node','-e',SOURCE_JS,r['target']]);need(len(encoded)<=3*1024*1024,'BOUNDED_CURRENT_SOURCE_REQUIRED');raw=self.patch(base64.b64decode(encoded,validate=True),r)
   p=context/'app'/r['target'];p.parent.mkdir(mode=0o755,parents=True,exist_ok=True);write(p,raw,0o644)
  for i,(r,p)in enumerate(static):
   old=self.c.read(p)if p.exists()else None;raw=self.patch(old,r)if old is not None else self.c.read(self.bundle/r['payload']);mode=stat.S_IMODE(p.stat().st_mode)if p.exists()else 0o644;copy=context/'static'/str(i);copy.parent.mkdir(mode=0o700,exist_ok=True);write(copy,raw);record={'target':str(p),'baseSha256':r['baseSha256'],'sha256':r['sha256'],'prepared':str(copy),'mode':mode,'backup':str(backup/str(i))if old is not None else None,'written':False}
   if old is not None:write(Path(record['backup']),old)
   state['static'].append(record)
  write(context/'Dockerfile',('FROM '+alias+'\nCOPY app/ /app/\n').encode());state['contextSha256']=self.context_proof(context,state,alias);self.c.replace(journal,state)
  self.decision(decision_name,decision_sha);current,unused=self.before(d);self.compare(current,before,before['afterImages']);self.unused(alias);self.run(['docker','image','tag',d['contentImage'],alias]);need(self.run(['docker','image','inspect','--format','{{.Id}}',alias]).decode().strip()==d['contentImage'],'LOCAL_ALIAS_CHANGED');self.unused(tag);state['phase']='INCREMENTAL_BUILD_STARTED_UNKNOWN';self.c.replace(journal,state);iid=context/'image.id';need(self.context_proof(context,state,alias)==state['contextSha256'],'BUILD_CONTEXT_CHANGED');self.decision(decision_name,decision_sha);self.a.lease();need(self.run(['docker','image','inspect','--format','{{.Id}}',alias]).decode().strip()==d['contentImage'],'LOCAL_ALIAS_CHANGED_BEFORE_BUILD');self.run(['docker','build','--network=none','--pull=false','--tag',tag,'--iidfile',str(iid),str(context)]);child=self.c.read(iid).decode().strip();need(self.c.image(child)and child!=d['contentImage'],'CHILD_IMAGE_REQUIRED');need(self.context_proof(context,state,alias,True)==state['contextSha256'],'BUILD_CONTEXT_CHANGED_DURING_BUILD');need(self.run(['docker','image','inspect','--format','{{.Id}}',tag]).decode().strip()==child,'CHILD_IMAGE_TAG_CHANGED');childlayers=self.c.obj(self.run(['docker','image','inspect','--format','{{json .RootFS.Layers}}',child]));need(childlayers[:len(layers)]==layers and len(childlayers)==len(layers)+1,'ONE_COPY_EXACT_PARENT_REQUIRED');expected=self.expected_hashes(True);need(self.hashes(expected,child)==expected,'CHILD_SOURCE_READBACK_FAILED')
  current,unused=self.before(d);self.compare(current,before,before['afterImages']);self.decision(decision_name,decision_sha);state.update(phase='INCREMENTAL_STATIC_STARTED_UNKNOWN',childImage=child,contextTreeSha256=self.tree(context/'app'));self.c.replace(journal,state)
  for rec in state['static']:
   p=Path(rec['target']);need(self.fingerprint(p)==rec['baseSha256'],'STATIC_CAS_CONFLICT');raw=self.c.read(Path(rec['prepared']));need(sha(raw)==rec['sha256'],'PREPARED_STATIC_CHANGED');self.atomic(p,raw,rec['mode']);rec['written']=True;self.c.replace(journal,state)
  self.c.create(overlay,{'services':{'content':{'image':child}}});overlay_sha=sha(self.c.read(overlay));planned=self.plan_hash(before,overlay);state.update(phase='INCREMENTAL_CONTENT_UP_STARTED_UNKNOWN',overlay=str(overlay),overlaySha256=overlay_sha,plannedConfigHash=planned);self.c.replace(journal,state)
  self.stable();self.decision(decision_name,decision_sha);self.compare(self.a.snapshot(),before,before['afterImages']);need(self.hashes(self.expected_hashes())==self.expected_hashes(),'PRE_UP_SOURCE_DRIFT');self.static_after(state);self.worker(d);self.push_off();self.a.lease();need(sha(self.c.read(overlay))==overlay_sha and self.tree(context/'app')==state['contextTreeSha256'],'LAST_INPUT_DRIFT');self.decision(decision_name,decision_sha);self.run(self.command(before,overlay,['up','--detach','--no-build','--pull','never','--no-deps','content']));after=self.a.snapshot();images={'content':child,'chat':WORKER_IMAGE};self.compare(after,before,images,overlay,planned);self.worker(d);self.push_off();need(self.hashes(expected)==expected,'ACTIVE_CHILD_SOURCE_READBACK_FAILED');self.static_after(state);state.update(phase='INCREMENTAL_CONTENT_AND_STATIC_APPLIED_NOT_PUBLIC_PROOF',after=after);self.c.replace(journal,state);return {'status':state['phase'],'journalFile':journal.name,'journalSha256':sha(self.c.read(journal)),'images':images,'workerRecreated':False,'pushEnabled':False,'dbWrites':0,'publicReady':False}
 def static_after(self,state):
  for r in state['static']:need(self.fingerprint(Path(r['target']))==r['sha256'],'STATIC_CHANGED_AFTER_APPLY')
 def tree(self,root):
  entries=[]
  for p in sorted(root.rglob('*')):
   self.c.path(p)
   if p.is_file():entries.append([p.relative_to(root).as_posix(),sha(self.c.read(p))])
  expected=[[r['target'],r['sha256']]for r in self.m['records']if r['group']=='content'];entries.sort();need(entries==sorted(expected),'EXACT_STAGED_APP_TREE_REQUIRED');return sha(self.c.data(entries))
 def context_proof(self,context,state,alias,after_build=False):
  expected={'Dockerfile':sha(('FROM '+alias+'\nCOPY app/ /app/\n').encode())}
  expected.update({'app/'+r['target']:r['sha256']for r in self.m['records']if r['group']=='content'});expected.update({'static/'+str(i):r['sha256']for i,r in enumerate(state['static'])});actual={}
  for p in context.rglob('*'):
   self.c.path(p)
   if p.is_file():
    name=p.relative_to(context).as_posix()
    if after_build and name=='image.id':continue
    actual[name]=sha(self.c.read(p))
  need(actual==expected,'EXACT_DOCKERFILE_AND_CLOSED_BUILD_CONTEXT_REQUIRED');return sha(self.c.data(sorted(actual.items())))
 def rollback(self,name,journal_sha,*,apply=False):
  need(apply is True and re.fullmatch('[a-z0-9][a-z0-9-]{0,31}',name)is not None,'EXPLICIT_ROOT_ROLLBACK_REQUIRED');journal=self.root/(name+'-journal.json');r=self.pin(journal,journal_sha);need(r.get('phase')=='INCREMENTAL_CONTENT_AND_STATIC_APPLIED_NOT_PUBLIC_PROOF'and r.get('manifestSha256')==self.msha,'COMPLETED_EXACT_RECEIPT_REQUIRED');before=r['before'];after=r['after'];self.stable();current=self.a.snapshot();self.compare(current,before,after['afterImages'],Path(r['overlay']),r['plannedConfigHash']);self.worker({'workerContainerId':r['workerProof']['containerId']});self.static_after(r)
  for rec in r['static']:
   if rec['backup']:need(sha(self.c.read(Path(rec['backup'])))==rec['baseSha256'],'BACKUP_CHANGED')
  need(self.hashes(self.expected_hashes(True))==self.expected_hashes(True),'ROLLBACK_ACTIVE_SOURCE_DRIFT');need(sha(self.c.read(Path(r['overlay'])))==r['overlaySha256'],'APPLIED_OVERLAY_CHANGED');old=before['afterImages']['content'];need(self.run(['docker','image','inspect','--format','{{.Id}}',old]).decode().strip()==old,'EXACT_PREVIOUS_CONTENT_IMAGE_MISSING');overlay=self.root/(name+'-rollback-overlay.json');self.c.create(overlay,{'services':{'content':{'image':old}}});pin=sha(self.c.read(overlay));planned=self.plan_hash(current,overlay);r['phase']='INCREMENTAL_ROLLBACK_STARTED_UNKNOWN';self.c.replace(journal,r);self.compare(self.a.snapshot(),before,after['afterImages'],Path(r['overlay']),r['plannedConfigHash']);self.static_after(r);self.worker({'workerContainerId':r['workerProof']['containerId']});self.a.lease();need(sha(self.c.read(overlay))==pin,'ROLLBACK_OVERLAY_CHANGED');self.run(self.command(current,overlay,['up','--detach','--no-build','--pull','never','--no-deps','content']));restored=self.a.snapshot();self.compare(restored,current,before['afterImages'],overlay,planned);need(self.hashes(self.expected_hashes())==self.expected_hashes(),'ROLLED_BACK_SOURCE_READBACK_FAILED')
  # Restore static only after the old content image is proven running; reverse CAS order.
  for rec in r['static']:
   if rec['backup']:need(sha(self.c.read(Path(rec['backup'])))==rec['baseSha256'],'BACKUP_CHANGED_AFTER_CONTENT_ROLLBACK')
  for rec in reversed(r['static']):
   p=Path(rec['target']);need(self.fingerprint(p)==rec['sha256'],'ROLLBACK_STATIC_CAS_CONFLICT')
   if rec['backup']:
    backup_raw=self.c.read(Path(rec['backup']));need(sha(backup_raw)==rec['baseSha256'],'BACKUP_CHANGED_BEFORE_RESTORE');self.atomic(p,backup_raw,rec['mode'])
   else:p.unlink()
  self.worker({'workerContainerId':r['workerProof']['containerId']});r.update(phase='INCREMENTAL_CODE_ROLLED_BACK_NO_DB_RESTORE',afterRollback=restored);self.c.replace(journal,r);return {'status':r['phase'],'images':restored['afterImages'],'workerRecreated':False,'dbRestore':False}
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('operation',choices=['extract','approve-current','apply','rollback']);p.add_argument('--bundle',type=Path,required=True);p.add_argument('--manifest-sha',required=True);p.add_argument('--name');p.add_argument('--archive',type=Path);p.add_argument('--archive-sha');p.add_argument('--decision');p.add_argument('--decision-sha');p.add_argument('--receipt-sha');p.add_argument('--apply',action='store_true');a=p.parse_args()
 try:
  need(os.name=='posix'and os.geteuid()==0,'NATIVE_ROOT_ONLY');c=pinned_core()
  if a.operation=='extract':result=extract(c,a.archive,a.bundle,a.archive_sha,a.manifest_sha,apply=a.apply)
  else:
   r=Release(c,a.bundle,a.manifest_sha);result=r.approve_current(a.name,apply=a.apply)if a.operation=='approve-current'else r.apply(a.name,a.decision,a.decision_sha,apply=a.apply)if a.operation=='apply'else r.rollback(a.name,a.receipt_sha,apply=a.apply)
  print(json.dumps(result));return 0
 except BaseException as error:
  code=str(error);code=code if re.fullmatch('[A-Z][A-Z0-9_]{0,100}',code)else'ACCEPTED_GUARD_REFUSED';print(json.dumps({'status':'REFUSED_UNKNOWN_DO_NOT_RETRY','operation':a.operation,'code':code,'dbRestore':False,'automaticRetry':False}));return 2
if __name__=='__main__':sys.exit(main())
