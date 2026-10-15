"""One read-only A10 observation. Never apply/retry/rollback/finalize any release.
No Docker run/build/tag/up, no writes, no raw stdout/stderr, no private key reads.
"""
import argparse,hashlib,json,os,re,subprocess,sys,types
from pathlib import Path
from datetime import datetime,timezone
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
HOTFIX_SHA='1e7ce869be02af7cf285fbebd33f7e97c6080c57e193c70c832b5eba1f0ff2b3'
PUSH_RECEIPT='00abb8d802d59b86013e8ca893c08ae41799ef887c4c330b501538c4f5176870'
def need(v,m):
 if not v:raise ValueError(m)
def sha(raw):return hashlib.sha256(raw).hexdigest()
class NativeFailure(Exception):
 def __init__(self,event):self.event=event;super().__init__('READONLY_NATIVE_COMMAND_FAILED')
class ReadOnlyRunner:
 def __init__(self,core,inc,push,before,images,executor=None):
  self.c=core;self.events=[];self.stage='INIT';self.executor=executor or subprocess.run
  self.images=set(images);self.hash_js=inc.HASH_JS;self.hash_names=set();self.js={core.ENV,inc.HASH_JS,push.FLAG_JS,push.DB_JS,push.KEY_JS,push.HEALTH_JS}
  self.labels={core.LABELS,'{{.Id}}','{{.Image}}','{{json .Mounts}}'}
  self.files={str(p)for row in before['containers'].values()for p in row['files']}
  self.projects={row['project']for row in before['containers'].values()};self.dirs={row['workingDir']for row in before['containers'].values()}
 def allow(self,args):
  need(type(args)is list and all(type(a)is str for a in args),'READONLY_ARGV_REQUIRED')
  if args==['lslocks','--noheadings','--output','PID,PATH']:return 'lease',None
  if len(args)==5 and args[:3]==['docker','inspect','--format']and args[3]in self.labels and args[4]in ('synapse-content-1','synapse-chat-1'):return 'inspect-container',None
  if len(args)==6 and args[:4]==['docker','image','inspect','--format']and args[4]in ('{{.Id}}','{{json .RootFS.Layers}}')and args[5]in self.images:return 'inspect-image',None
  if args==['docker','exec','synapse-chat-1','sha256sum','/app/client-bot-bridge.js']:return 'worker-source',None
  if args==['docker','exec','synapse-chat-1','node','-e',self.c.ENV]:return 'exec-worker-selected-readonly',None
  if len(args)in (6,7)and args[:5]==['docker','exec','synapse-content-1','node','-e']and args[5]in self.js:
   if args[5]==self.hash_js:
    need(len(args)==7,'EXACT_HASH_ARGUMENT_REQUIRED');names=json.loads(args[6]);need(type(names)is list and len(names)<=256 and all(type(n)is str and n in self.hash_names for n in names),'EXACT_REVIEWED_SOURCE_NAMES_REQUIRED')
   else:need(len(args)==6,'NO_EXTRA_NODE_ARGUMENTS_ALLOWED')
   return 'exec-selected-readonly',None
  if args==['docker','compose','config','--help']:return 'compose-help',None
  if len(args)>=11 and args[:3]==['docker','compose','--project-name']and args[4]=='--project-directory'and args[3]in self.projects and args[5]in self.dirs and args[-3:-1]==['config','--hash']and args[-1]in ('content','chat'):
   middle=args[6:-3];need(len(middle)%2==0 and all(middle[i]=='--file'and middle[i+1]in self.files for i in range(0,len(middle),2)),'EXACT_READONLY_COMPOSE_FILES_REQUIRED');return 'compose-config-hash',str(self.c.path(args[5]))
  raise ValueError('MUTATING_OR_UNAPPROVED_COMMAND_REFUSED')
 def __call__(self,args):
  kind,cwd=self.allow(args)
  event={'stage':self.stage,'kind':kind,'returnCode':None,'timeout':False}
  try:
   r=self.executor(args,capture_output=True,stdin=subprocess.DEVNULL,shell=False,timeout=30,cwd=cwd)
   out,err=r.stdout or b'',r.stderr or b'';event.update(returnCode=r.returncode,stdoutBytes=len(out),stderrBytes=len(err),stdoutSha256=sha(out),stderrSha256=sha(err));self.events.append(event)
   if r.returncode!=0 or len(out)>2*1024*1024 or len(err)>2*1024*1024:raise NativeFailure(event)
   return out
  except subprocess.TimeoutExpired as error:
   out=error.stdout or b'';err=error.stderr or b'';event.update(timeout=True,stdoutBytes=len(out),stderrBytes=len(err),stdoutSha256=sha(out),stderrSha256=sha(err));self.events.append(event);raise NativeFailure(event)
  except OSError as error:
   event.update(errorClass=type(error).__name__,errno=error.errno);self.events.append(event);raise NativeFailure(event)
class Observation:
 def __init__(self,h,name,journal_sha,decision_sha,runner):
  self.h=h;self.c=h.c;self.r=h.r;self.p=h.p;self.run=runner;self.name=name
  need(re.fullmatch('a10-r[1-9][0-9]{0,3}',name or'')is not None,'EXACT_A10_NAME_REQUIRED')
  self.jpath=h.root/(name+'-journal.json');self.dpath=h.root/(name+'-decision.json')
  self.j=self.r.pin(self.jpath,journal_sha);self.d=self.r.pin(self.dpath,decision_sha);self.jp=journal_sha;self.dp=decision_sha
  j,d=self.j,self.d
  need(j.get('phase')=='A10_CONTENT_UP_STARTED_UNKNOWN'and j.get('name')==name and j.get('manifestSha256')==h.msha and j.get('decisionFile')==self.dpath.name and j.get('decisionSha256')==decision_sha,'EXACT_PARTIAL_A10_JOURNAL_REQUIRED')
  need(d.get('schema')==1 and d.get('rootApproved')is True and d.get('scope')=='A10_SHELL_ONLY_PUSH_PRESERVED'and d.get('name')==name and d.get('manifestSha256')==h.msha and d.get('pushReceiptSha256')==h.psha and d.get('featuresReceiptSha256')==h.p.incremental_sha,'EXACT_APPROVAL_LINEAGE_REQUIRED');need(d.get('contentImage')==h.ps['after']['afterImages']['content']and d.get('workerImage')==h.ps['after']['afterImages']['chat']and d.get('workerContainerId')==h.p.incremental['workerProof']['containerId']and d.get('workerSourceSha256')==h._inc.WORKER_SOURCE and d.get('pushEnabled')is True and d.get('pushName')=='push-r1','EXACT_DECISION_SCOPE_REQUIRED')
  need(j['before']==d['facts']['snapshot']and j['workerProof']['containerId']==d['workerContainerId'],'EXACT_APPROVED_BEFORE_REQUIRED');self.before=j['before'];self.child=j['childImage'];self.old=d['contentImage'];need(self.c.image(self.child)and self.child!=self.old,'EXACT_CANDIDATE_IMAGE_REQUIRED')
  self.overlay=h.root/(name+'-overlay.json');need(Path(j['overlay'])==self.overlay and sha(self.c.read(self.overlay))==j['overlaySha256'],'EXACT_APPLIED_IMAGE_OVERLAY_REQUIRED');need(self.c.obj(self.c.read(self.overlay))=={'services':{'content':{'image':self.child}}},'IMAGE_ONLY_OVERLAY_REQUIRED');need(re.fullmatch('[0-9a-f]{64}',j['plannedConfigHash'])is not None,'PLANNED_CONFIG_PIN_REQUIRED')
  self.run.files.add(str(self.overlay));self.report={'schema':1,'status':'READONLY_OBSERVATION_INCOMPLETE','originalJournalPhase':j['phase'],'originalJournalSha256':journal_sha,'decisionSha256':decision_sha,'originalFailureMetadataAvailable':False,'originalReturnCode':None,'originalStderrSha256':None,'nativeMetadataScope':'This observation only; historical masked error cannot be recovered from current health','observedAtUtc':datetime.now(timezone.utc).isoformat(),'stages':[],'mutations':0,'runtimeRestarts':0,'dbWrites':0,'receiptEdits':0,'automaticRetry':False};self.active=None;self.cid=None;self.source_ok=False
 def stage(self,name,fn):
  self.run.stage=name
  try:
   value=fn();self.report['stages'].append({'stage':name,'ok':True,'facts':value});return value
  except Exception as error:
   info={'stage':name,'ok':False,'errorClass':type(error).__name__};msg=str(error);info['code']=msg if re.fullmatch('[A-Z][A-Z0-9_]{0,100}',msg)else'ACCEPTED_GUARD_REFUSED';info['messageSha256']=sha(msg.encode())
   if isinstance(error,NativeFailure):info['native']=error.event
   self.report['stages'].append(info);return None
 def identities(self):
  self.cid=self.p.cid();image=self.run(['docker','inspect','--format','{{.Image}}','synapse-content-1']).decode().strip();need(image in (self.old,self.child),'UNEXPECTED_RUNNING_CONTENT_IMAGE');self.active='candidate'if image==self.child else'old';need((self.cid!=self.d['facts']['contentContainerId'])if self.active=='candidate'else(self.cid==self.d['facts']['contentContainerId']),'CONTENT_CID_LINEAGE_NOT_PROVEN');return {'contentContainerId':self.cid,'contentImage':image,'classification':self.active,'beforeContainerIdMatches':self.cid==self.d['facts']['contentContainerId']}
 def immutable(self):
  self.h.stable();need(sha(self.c.read(self.h.bundle/'hotfix_native.py'))==HOTFIX_SHA,'HOTFIX_CODE_PIN_CHANGED');need(sha(self.c.read(self.jpath))==self.jp and sha(self.c.read(self.dpath))==self.dp,'PARTIAL_INPUT_CHANGED');pending=Path(str(self.jpath)+'.pending');value={'codeAndReceiptPinsMatch':True,'pendingJournalExists':pending.exists()}
  if pending.exists():
   raw=self.c.read(pending);m=self.c.obj(raw);phase=m.get('phase');known={'A10_CONTEXT_STARTED_UNKNOWN','A10_BUILD_STARTED_UNKNOWN','A10_STATIC_STARTED_UNKNOWN','A10_CONTENT_UP_STARTED_UNKNOWN','A10_CONTENT_AND_STATIC_APPLIED_NOT_PUBLIC_PROOF','A10_ROLLBACK_STARTED_UNKNOWN','A10_CODE_ROLLED_BACK_NO_DB_RESTORE'};value.update(pendingSha256=sha(raw),pendingPhase=phase if type(phase)is str and phase in known else None,pendingPhaseSha256=sha(phase.encode())if type(phase)is str else None,pendingSameLineage=m.get('manifestSha256')==self.h.msha and m.get('name')==self.name)
  return value
 def build(self):
  context=self.h.root/(self.name+'-context');need(self.h.context_proof(context,self.j,'palitra-a10-base:'+self.name,True)==self.j['contextSha256'],'CLOSED_CONTEXT_CHANGED');need(self.h.tree(context/'app')==self.j['contextTreeSha256'],'CONTEXT_SOURCE_CHANGED');need(self.c.read(context/'image.id').decode().strip()==self.child,'IID_CHANGED')
  for image in (self.old,self.child):need(self.run(['docker','image','inspect','--format','{{.Id}}',image]).decode().strip()==image,'LOCAL_EXACT_IMAGE_MISSING')
  old=self.c.obj(self.run(['docker','image','inspect','--format','{{json .RootFS.Layers}}',self.old]));new=self.c.obj(self.run(['docker','image','inspect','--format','{{json .RootFS.Layers}}',self.child]));need(type(old)is list and old and new[:len(old)]==old and len(new)==len(old)+1,'EXACT_ONE_COPY_PARENT_PROOF_FAILED');return {'oldImage':self.old,'candidateImage':self.child,'oneCopyParentProof':True}
 def config(self):
  need(self.active is not None,'RUNNING_IDENTITY_NOT_PROVEN');snapshot=self.h.a.snapshot();images={'content':self.child if self.active=='candidate'else self.old,'chat':self.before['afterImages']['chat']};self.r.compare(snapshot,self.before,images,self.overlay if self.active=='candidate'else None,self.j['plannedConfigHash']if self.active=='candidate'else None);need(self.r.plan_hash(self.before,self.overlay)==self.j['plannedConfigHash'],'PLANNED_OVERLAY_CONFIG_CHANGED');need(snapshot['selected']['content']['PALITRA_WEB_UPLOADS_ENABLED']!='true','MEDIA_UPLOADS_MUST_STAY_OFF');return {'opaqueConfigAndChainMatch':True,'workerComposeUnchanged':True,'mediaUploadsDisabled':True,'contentHealthMetadata':snapshot['containers']['content']['health']}
 def sources(self):
  need(self.active is not None,'RUNNING_IDENTITY_NOT_PROVEN');expected=self.h.expected_hashes(self.active=='candidate');actual=self.r.hashes(expected);need(actual==expected,'CURRENT_SOURCE_INVENTORY_MISMATCH');self.source_ok=True;return {'expectedVersion':self.active,'files':len(expected),'inventorySha256':sha(self.c.data(actual))}
 def static(self):
  self.h.static_after(self.j);need(len(self.j['static'])==1,'ONE_STATIC_SHELL_RECORD_REQUIRED');row=self.j['static'][0];need(Path(row['target'])==self.h.cabinet/'shell.js','EXACT_CABINET_SHELL_REQUIRED');need(Path(row['backup'])==self.h.root/(self.name+'-backup')/'0','EXACT_PRIVATE_BACKUP_REQUIRED');need(sha(self.c.read(Path(row['backup'])))==row['baseSha256'],'PRIVATE_BACKUP_CHANGED');return {'candidateShellSha256':row['sha256'],'oldBackupSha256':row['baseSha256'],'otherStaticUnchanged':True}
 def worker(self):
  self.r.worker(self.d);return {'containerId':self.d['workerContainerId'],'sourceSha256':self.d['workerSourceSha256'],'unchanged':True}
 def push(self):
  need(self.active is not None and self.source_ok,'ACTIVE_SOURCE_PROOF_REQUIRED_BEFORE_LIBRARY_EXEC');keys=self.h.k;need(self.p.private_meta(Path(keys['directory']))==keys['keyMetadata'],'PRIVATE_KEY_METADATA_CHANGED');mounts=self.p.mounts();expected=sorted(self.h.ps['before']['mounts']+[{'Type':'bind','Source':keys['directory'],'Destination':self.h.pm.TARGET,'RW':False}],key=lambda row:row['Destination']);need(mounts==expected,'EXACT_PUSH_RO_MOUNTS_CHANGED');need(self.p.binding(mounts)==self.h.ps['before']['binding'],'PERSISTENT_DB_BINDING_CHANGED');need(self.p.flag(),'PUSH_FLAG_CHANGED');probe=self.c.obj(self.run(['docker','exec','synapse-content-1','node','-e',self.h.pm.KEY_JS]));need(probe=={'keyValid':True,'publicKeySha256':keys['publicKeySha256'],'webPushVersion':'3.6.7','transportReady':True},'ACTIVE_KEY_LIBRARY_CHANGED');return {'pushEnabled':True,'privateMountReadOnly':True,'keyMetadataAndBindingMatch':True,'publicKeySha256':keys['publicKeySha256']}
 def health(self):
  need(self.active is not None,'RUNNING_IDENTITY_NOT_PROVEN');value=self.c.obj(self.run(['docker','exec','synapse-content-1','node','-e',self.h.pm.HEALTH_JS]));need(value=={'status':200,'ok':True,'service':'content'},'CONTENT_HEALTH_FAILED');return value
 def final(self):
  self.immutable();self.h.a.lease();need(self.p.cid()==self.cid,'CONTENT_CID_CHANGED_DURING_OBSERVATION');self.r.worker(self.d);return {'originalJournalUnmodified':True,'decisionUnmodified':True,'sameContentCid':True}
 def observe(self):
  for name,fn in [('PINNED_INPUTS',self.immutable),('BUILD_PARENT',self.build),('RUNNING_IDENTITY',self.identities),('OPAQUE_COMPOSE',self.config),('SOURCE_INVENTORY',self.sources),('STATIC_AND_BACKUP',self.static),('WORKER',self.worker),('PUSH_RO_KEY',self.push),('CONTENT_HEALTH',self.health),('FINAL_PINS_CID',self.final)]:self.stage(name,fn)
  ok=all(s['ok']for s in self.report['stages']);self.report.update(status=('READONLY_CANDIDATE_VERIFIED_JOURNAL_STILL_UNKNOWN'if self.active=='candidate'else'READONLY_OLD_CONTENT_OBSERVED_JOURNAL_STILL_UNKNOWN')if ok else'READONLY_INCOMPLETE_OR_DRIFT_NO_MUTATION',activeClassification=self.active,finishedAtUtc=datetime.now(timezone.utc).isoformat(),commandCount=len(self.run.events),nativeFailedEvents=[e for e in self.run.events if e['returnCode']!=0],nativeEventsSha256=sha(self.c.data(self.run.events)),allChecksPass=ok);return self.report

def load_hotfix(code_dir):
 path=Path(code_dir)/'hotfix_native.py';need(path.is_absolute()and not path.is_symlink(),'EXACT_ABSOLUTE_HOTFIX_CODE_REQUIRED');raw=path.read_bytes();need(sha(raw)==HOTFIX_SHA,'EXACT_ACCEPTED_HOTFIX_REQUIRED');h=types.ModuleType('a10_readonly_accepted');h.__file__=str(path);exec(compile(raw,str(path),'exec'),h.__dict__);return h

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--code-dir',type=Path,required=True);p.add_argument('--bundle',type=Path,required=True);p.add_argument('--name',default='a10-r1');p.add_argument('--journal-sha',required=True);p.add_argument('--decision-sha',required=True);args=p.parse_args()
 try:
  need(os.name=='posix'and os.geteuid()==0,'NATIVE_ROOT_READONLY_ONLY');need(re.fullmatch('a10-r[1-9][0-9]{0,3}',args.name or'')is not None,'EXACT_A10_NAME_REQUIRED');need(all(re.fullmatch('[0-9a-f]{64}',v)for v in [args.journal_sha,args.decision_sha]),'EXACT_INPUT_SHA_REQUIRED');hm=load_hotfix(args.code_dir);pm,inc,c=hm.loaded(ROOT);c.path(args.code_dir);jraw=c.read(ROOT/(args.name+'-journal.json'));need(sha(jraw)==args.journal_sha,'PARTIAL_JOURNAL_PIN_MISMATCH');j=c.obj(jraw);need(j.get('phase')=='A10_CONTENT_UP_STARTED_UNKNOWN','EXACT_PARTIAL_PHASE_REQUIRED');runner=ReadOnlyRunner(c,inc,pm,j['before'],[hm.FEATURES_IMAGE,j['childImage']]);r=inc.Release(c,args.bundle,pm.MANIFEST_SHA,ROOT,runner=runner);h=hm.Hotfix(pm,r,'push-r1',PUSH_RECEIPT,args.code_dir,incremental=inc);runner.hash_names=set(r.expected_hashes(True));report=Observation(h,args.name,args.journal_sha,args.decision_sha,runner).observe();print(json.dumps(report,separators=(',',':')));return 0 if report['allChecksPass']else 2
 except Exception as error:
  msg=str(error);code=msg if re.fullmatch('[A-Z][A-Z0-9_]{0,100}',msg)else'ACCEPTED_GUARD_REFUSED';print(json.dumps({'status':'READONLY_PRECONDITION_REFUSED_NO_MUTATION','errorClass':type(error).__name__,'code':code,'messageSha256':sha(msg.encode()),'mutations':0,'receiptEdits':0}));return 2
if __name__=='__main__':sys.exit(main())
