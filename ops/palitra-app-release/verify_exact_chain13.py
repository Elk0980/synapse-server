"""Exact current a10-r1 Compose proof only. Never mutate or complete a release."""
import hashlib,json,os,re,subprocess,sys,types
from datetime import datetime,timezone
from pathlib import Path

ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
CORE_SHA='60a129b3467068932e0d1ca5529f808a76f36f52027990d71bd19d588149db4b'
INC_SHA='f7170af089f3ca6e951426320f74b139294e85eda18a56296726c360c1f807d7'
JOURNAL_SHA='16bfbde077bc5074fcf49c26ad86992ac9d49d4bb9f51b431ab9bb41859e6839'
DECISION_SHA='2152d13fffad5cc9370b42f44f1a7f63c748aa8aac5c73ab7cdf869f1c174fac'
MANIFEST_SHA='f6695c9fb998206fb77e5e5ce78cd318263b53d404c8a028146e47c8c854fe2e'
CHILD='sha256:5cceeb7019e78fa1269e7e5ed1c5f93951ab26afae6aa73457cfb1622aaefa0e'
WORKER='sha256:c5dd4502daf630afaac7415da5b19dc456c81a5f81626574f5480dec04307cca'
WORKER_CID='7d7ec369e7ce44e492874137813caf3399b21b0242438b3b6df1281e4f379415'
EXACT_CHAIN=(
 '/opt/synapse/docker-compose.yml',
 '/opt/synapse/ops/site-workspaces.release.yml',
 '/opt/palitra-editor-backups-36-38/image.override.yml',
 '/opt/palitra-order-guard-20261013/image.override.yml',
 '/opt/palitra-production-20261013/image.override.yml',
 '/opt/palitra-main-usability.override.yml',
 '/opt/palitra-category.override.yml',
 '/opt/palitra-app.override.yml',
 '/opt/synapse/releases/palitra-app-20261015/activation-r3-content-overlay.json',
 '/opt/synapse/releases/palitra-app-20261015/frontend-runtime-overlay.json',
 '/opt/synapse/releases/palitra-app-20261015/features1-overlay.json',
 '/opt/synapse/releases/palitra-app-20261015/push-r1-overlay.json',
 '/opt/synapse/releases/palitra-app-20261015/a10-r1-overlay.json')

def sha(raw):return hashlib.sha256(raw).hexdigest()
def need(value,code):
 if not value:raise ValueError(code)
def load(root,name,pin):
 path=root/name;need(path.is_absolute()and not path.is_symlink(),'EXACT_HELPER_PATH_REQUIRED');raw=path.read_bytes();need(sha(raw)==pin,'EXACT_ACCEPTED_HELPER_REQUIRED');module=types.ModuleType('readonly_'+name.replace('.','_'));module.__file__=str(path);exec(compile(raw,str(path),'exec'),module.__dict__);return module
def validate_literals():
 for value in (CORE_SHA,INC_SHA,JOURNAL_SHA,DECISION_SHA,MANIFEST_SHA,WORKER_CID):need(re.fullmatch('[0-9a-f]{64}',value)is not None,'EXACT_PRODUCTION_PIN_REQUIRED')
 for value in (CHILD,WORKER):need(re.fullmatch('sha256:[0-9a-f]{64}',value)is not None,'EXACT_PRODUCTION_IMAGE_REQUIRED')
 need(len(EXACT_CHAIN)==13 and len(set(EXACT_CHAIN))==13,'EXACT_PRODUCTION_CHAIN13_REQUIRED')
validate_literals()

class NativeFailure(Exception):
 def __init__(self,event):self.event=event;super().__init__('READONLY_NATIVE_FAILED')
class Runner:
 def __init__(self,core,before,expected,executor=subprocess.run):self.c=core;self.before=before;self.expected=expected;self.executor=executor;self.events=[];self.stage='INIT'
 def allow(self,args):
  if args==['lslocks','--noheadings','--output','PID,PATH']:return None
  for container in ('synapse-content-1','synapse-chat-1'):
   if args in (['docker','inspect','--format',self.c.LABELS,container],['docker','inspect','--format','{{.Id}}',container],['docker','exec',container,'node','-e',self.c.ENV]):return None
  if args==['docker','compose','config','--help']:return None
  for service,b in self.before['containers'].items():
   if service not in ('content','chat'):continue
   files=self.expected if service=='content'else b['files'];exact=['docker','compose','--project-name',b['project'],'--project-directory',b['workingDir']]
   for file in files:exact+=['--file',file]
   if args==exact+['config','--hash',service]:return str(self.c.path(b['workingDir']))
  raise ValueError('READONLY_COMMAND_NOT_ALLOWED')
 def __call__(self,args):
  cwd=self.allow(args);event={'stage':self.stage,'returnCode':None,'timeout':False}
  try:
   result=self.executor(args,capture_output=True,stdin=subprocess.DEVNULL,shell=False,timeout=30,cwd=cwd);out,err=result.stdout or b'',result.stderr or b'';event.update(returnCode=result.returncode,stdoutBytes=len(out),stderrBytes=len(err),stdoutSha256=sha(out),stderrSha256=sha(err));self.events.append(event)
   if result.returncode!=0 or len(out)>2*1024*1024 or len(err)>2*1024*1024:raise NativeFailure(event)
   return out
  except subprocess.TimeoutExpired as error:
   out,err=error.stdout or b'',error.stderr or b'';event.update(timeout=True,stdoutSha256=sha(out),stderrSha256=sha(err));self.events.append(event);raise NativeFailure(event)
  except OSError as error:
   event.update(errorClass=type(error).__name__,errno=error.errno);self.events.append(event);raise NativeFailure(event)

class Verifier:
 def __init__(self,core,inc,root=ROOT,executor=subprocess.run,*,journal_sha=JOURNAL_SHA,decision_sha=DECISION_SHA,expected_chain=EXACT_CHAIN):
  self.c=core;self.inc=inc;self.root=core.path(root);self.jp=journal_sha;self.dp=decision_sha;self.expected=list(expected_chain);need(len(self.expected)==13 and len(set(self.expected))==13,'ONLY_EXACT13_ALLOWED');self.jpath=self.root/'a10-r1-journal.json';self.dpath=self.root/'a10-r1-decision.json';self.jraw=core.read(self.jpath);self.draw=core.read(self.dpath);need(sha(self.jraw)==journal_sha and sha(self.draw)==decision_sha,'PINNED_PRIVATE_INPUT_CHANGED');self.j=core.obj(self.jraw);self.d=core.obj(self.draw);j,d=self.j,self.d
  need(j.get('phase')=='A10_CONTENT_UP_STARTED_UNKNOWN'and j.get('name')=='a10-r1'and j.get('manifestSha256')==MANIFEST_SHA and j.get('decisionFile')==self.dpath.name and j.get('decisionSha256')==decision_sha,'EXACT_PARTIAL_JOURNAL_REQUIRED');need(d.get('schema')==1 and d.get('rootApproved')is True and d.get('scope')=='A10_SHELL_ONLY_PUSH_PRESERVED'and d.get('name')=='a10-r1'and d.get('manifestSha256')==MANIFEST_SHA,'EXACT_ROOT_LINEAGE_REQUIRED');need(j['before']==d['facts']['snapshot']and j['childImage']==CHILD and j['before']['afterImages']['chat']==WORKER and j['workerProof']['containerId']==WORKER_CID and d['workerContainerId']==WORKER_CID,'EXACT_BEFORE_CHILD_WORKER_REQUIRED');self.before=j['before'];self.overlay=self.root/'a10-r1-overlay.json';need(j['overlay']==str(self.overlay)and self.expected==self.before['containers']['content']['files']+[str(self.overlay)]and len(self.before['containers']['content']['files'])==12,'EXACT_PINNED12_PLUS_ONE_REQUIRED');self.oraw=core.read(self.overlay);need(sha(self.oraw)==j['overlaySha256']and core.obj(self.oraw)=={'services':{'content':{'image':CHILD}}},'EXACT_IMAGE_ONLY_OVERLAY_REQUIRED');need(re.fullmatch('[0-9a-f]{64}',j['plannedConfigHash'])is not None,'EXACT_PLANNED_HASH_REQUIRED');self.pins={**self.before['containers']['content']['filePins'],str(self.overlay):j['overlaySha256']};need(set(self.pins)==set(self.expected),'EXACT_EXPECTED_FILE_PINS_REQUIRED');self.run=Runner(core,self.before,self.expected,executor);self.a=core.Activate(self.root,self.run);self.stage='INIT'
 def immutable(self):
  need(self.c.read(self.jpath)==self.jraw and self.c.read(self.dpath)==self.draw and self.c.read(self.overlay)==self.oraw,'PINNED_INPUT_CHANGED_DURING_READ')
 def cid(self,service):
  value=self.run(['docker','inspect','--format','{{.Id}}','synapse-'+service+'-1']).decode().strip();need(re.fullmatch('[0-9a-f]{64}',value)is not None,'EXACT_CID_REQUIRED');return value
 def content(self):
  c=self.c;m=c.obj(self.run(['docker','inspect','--format',c.LABELS,'synapse-content-1']));b=self.before['containers']['content'];need(set(m)=={'image','project','service','workingDir','configFiles','configHash','running','health'}and m['image']==CHILD and m['service']=='content'and m['project']==b['project']and m['workingDir']==b['workingDir']and m['running']is True and m['health']in (None,'healthy','starting','unhealthy')and m['configHash']==self.j['plannedConfigHash'],'EXACT_CONTENT_METADATA_REQUIRED');need(c.path(m['workingDir']).is_dir()and type(m['configFiles'])is str and len(m['configFiles'])<=65536,'EXACT_CONTENT_LABEL_REQUIRED');files=m['configFiles'].split(',');need(files==self.expected and len(files)==13 and len(set(files))==13,'ACTUAL_CHAIN_NOT_EXACT_PINNED13');pins={}
  for name in files:
   p=c.path(name);need(p.suffix.lower()in ('.yml','.yaml','.json'),'EXACT_COMPOSE_FILE_TYPE_REQUIRED');pins[name]=sha(c.read(p))
  need(pins==self.pins,'ACTUAL_COMPOSE_FILE_PIN_DRIFT');m.update(files=files,filePins=pins);return m
 def verify(self):
  self.stage=self.run.stage='INITIAL_PINS_CID_LEASE';self.immutable();self.a.lease();cid=self.cid('content');worker=self.cid('chat');need(worker==WORKER_CID and cid!=self.d['facts']['contentContainerId'],'EXACT_CURRENT_CID_LINEAGE_REQUIRED')
  self.stage=self.run.stage='EXACT13_METADATA_SELECTED';before={'content':self.content(),'chat':self.a.metadata('chat')};selected={s:self.a.selected(s)for s in ('content','chat')};need(selected==self.before['selected'],'SELECTED_CONFIGURATION_DRIFT')
  self.stage=self.run.stage='RESOLVED_OPAQUE_HASHES';proof=self.a.hashproof(before)
  self.stage=self.run.stage='STABLE_METADATA_SELECTED';after={'content':self.content(),'chat':self.a.metadata('chat')};selected_after={s:self.a.selected(s)for s in ('content','chat')};need(before==after and selected==selected_after,'CONCURRENT_COMPOSE_OR_SELECTED_CHANGE');current={'containers':after,'selected':selected_after,'afterImages':{s:after[s]['image']for s in after}};self.inc.Release.compare(None,current,self.before,{'content':CHILD,'chat':WORKER},self.overlay,self.j['plannedConfigHash'])
  self.stage=self.run.stage='FINAL_PINS_CID_LEASE';self.immutable();self.a.lease();need(self.cid('content')==cid and self.cid('chat')==worker,'CID_CHANGED_DURING_PROOF')
  return {'schema':1,'status':'CURRENT_EXACT13_COMPOSE_PROOF_OLD_JOURNAL_STILL_UNKNOWN','observedAtUtc':datetime.now(timezone.utc).isoformat(),'originalJournalSha256':self.jp,'decisionSha256':self.dp,'originalJournalUnmodified':True,'decisionUnmodified':True,'overlayUnmodified':True,'originalFailureCauseProven':False,'frozenGuardChanged':False,'legacyCountGuardPass':False,'legacyCountMaximum':12,'actualCount':13,'uniqueCount':13,'pinnedBeforeCount':12,'exactPinnedPrefixAndOverlay':True,'composeFilePinsMatch':True,'selectedUnchanged':True,'opaqueConfigResolvedAndMatched':{s:proof[s]['matched']for s in proof},'resolvedConfigHashes':{s:proof[s]['resolved']for s in proof},'sameContentCid':True,'sameWorkerCid':True,'contentContainerId':cid,'workerContainerId':worker,'contentImage':CHILD,'workerImage':WORKER,'currentScopedProofComplete':True,'fullReleaseProofComplete':False,'journalCompleted':False,'commandCount':len(self.run.events),'mutations':0,'runtimeRestarts':0,'dbWrites':0,'receiptEdits':0,'automaticRetry':False}

def main():
 verifier=None
 try:
  need(len(sys.argv)==1,'NO_ARGUMENTS_OR_APPLY_ALLOWED');need(os.name=='posix'and os.geteuid()==0,'NATIVE_ROOT_READONLY_ONLY');c=load(ROOT,'activate_root.py',CORE_SHA);c.path(ROOT/'activate_root.py');inc=load(ROOT,'incremental_native.py',INC_SHA);c.path(ROOT/'incremental_native.py');verifier=Verifier(c,inc);result=verifier.verify();need(sha(c.read(ROOT/'activate_root.py'))==CORE_SHA and sha(c.read(ROOT/'incremental_native.py'))==INC_SHA,'ACCEPTED_HELPER_CHANGED_DURING_READ');print(json.dumps(result,separators=(',',':')));return 0
 except Exception as error:
  msg=str(error);code=msg if re.fullmatch('[A-Z][A-Z0-9_]{0,100}',msg)else'ACCEPTED_GUARD_REFUSED';result={'status':'READONLY_EXACT13_REFUSED_NO_MUTATION','stage':verifier.stage if verifier else'INPUTS','errorClass':type(error).__name__,'code':code,'messageSha256':sha(msg.encode()),'mutations':0,'runtimeRestarts':0,'dbWrites':0,'receiptEdits':0,'automaticRetry':False}
  if isinstance(error,NativeFailure):result['native']=error.event
  print(json.dumps(result,separators=(',',':')));return 2
if __name__=='__main__':sys.exit(main())
