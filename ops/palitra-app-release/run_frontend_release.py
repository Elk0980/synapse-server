"""Root one-pass: NOECHO data-only readbacks, then exact accepted frontend phases.
No retries/resume, worker recreation, DB/auth/bot changes or customer orders/messages.
"""
import argparse,hashlib,json,os,re,signal,stat,sys,types
from datetime import datetime,timezone
from pathlib import Path
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
PINS={'root_readback_inputs.py':'b5f37dfa9af174251c3c6ba63bc1860d8552973a4a90252904b6373fa69ad1c2','frontend_activation.py':'0fcb4ddc53d52a5c38b3699d99cdba938cc923e4cd8f4f1e0a719b1f9755f86a','frontend_runtime.py':'a0a35ddd0a96391fb51a5e6601dd76e02a7ef26e175e22eeff187c727898f426','activate_root.py':'60a129b3467068932e0d1ca5529f808a76f36f52027990d71bd19d588149db4b'}
MAX_INPUT=8192
WAITING='WAITING_FOR_ROOT_READBACK_DATA_AND_EOF'
class Refused(Exception):pass
def need(ok,code):
 if not ok:raise Refused(code)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def parse_payload(raw,expected):
 need(type(raw)is bytes and 1<=len(raw)<=MAX_INPUT,'READBACK_INPUT_SIZE')
 need(raw.endswith(b'\n'),'READBACK_INPUT_NEEDS_TRAILING_NEWLINE')
 need(all(b<128 and (b>=32 or b in (9,10,13)) for b in raw),'READBACK_INPUT_ASCII_JSON_ONLY')
 need(re.fullmatch('[0-9a-f]{64}',expected or '') is not None and sha(raw)==expected,'READBACK_INPUT_SHA_MISMATCH')
 def pairs(items):
  value={}
  for k,v in items:need(k not in value,'DUPLICATE_JSON_KEY');value[k]=v
  return value
 def invalid(_):raise Refused('NONFINITE_JSON_NUMBER')
 try:value=json.loads(raw.decode('ascii'),object_pairs_hook=pairs,parse_constant=invalid)
 except (ValueError,UnicodeError,RecursionError):raise Refused('ONE_JSON_DATA_OBJECT_REQUIRED')
 need(type(value)is dict and set(value)=={'owner','account'},'EXACT_OWNER_ACCOUNT_ROWS_REQUIRED');return value
class NoEcho:
 def __init__(self,stream,terminal=None):self.stream=stream;self.terminal=terminal;self.original=None;self.fd=None;self.handlers={}
 def __enter__(self):
  try:
   if self.stream.isatty():
    if self.terminal is None:import termios;self.terminal=termios
    self.fd=self.stream.fileno();self.original=self.terminal.tcgetattr(self.fd);masked=list(self.original);masked[3]&=~(self.terminal.ECHO|self.terminal.ECHONL);self.terminal.tcsetattr(self.fd,self.terminal.TCSANOW,masked)
    for name in ('SIGTERM','SIGHUP'):
     sig=getattr(signal,name,None)
     if sig is not None:self.handlers[sig]=signal.getsignal(sig);signal.signal(sig,self.interrupted)
  except BaseException:
   self.restore(True);raise
  return self
 def interrupted(self,signum,frame):raise Refused('RECEIVER_INTERRUPTED_NO_RETRY')
 def restore(self,flush):
  try:
   if self.original is not None:
    try:
     if flush:
      try:self.terminal.tcflush(self.fd,self.terminal.TCIFLUSH)
      except OSError:pass
    finally:self.terminal.tcsetattr(self.fd,self.terminal.TCSANOW,self.original)
  finally:
   for sig,handler in self.handlers.items():signal.signal(sig,handler)
   self.handlers={}
 def __exit__(self,kind,value,traceback):
  # On refusal flush only the owned pending paste; never execute any input as code.
  self.restore(kind is not None)
  return False
def receive(stream,expected,emit=print):
 emit(WAITING,flush=True);binary=getattr(stream,'buffer',stream);raw=binary.read(MAX_INPUT+1)
 return parse_payload(raw,expected)
def load_code(path,pin):
 path=Path(path);need(path.is_absolute() and '..' not in path.parts,'ABSOLUTE_PINNED_CODE_REQUIRED')
 for item in [*reversed(path.parents),path]:
  s=item.lstat();need(not stat.S_ISLNK(s.st_mode) and not(getattr(s,'st_file_attributes',0)&0x400),'CODE_LINK_REFUSED')
 before=path.stat();need(stat.S_ISREG(before.st_mode) and 0<before.st_size<=1024*1024,'BOUNDED_PINNED_CODE_REQUIRED');raw=path.read_bytes();after=path.stat()
 need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns) and sha(raw)==pin,'PINNED_DEPENDENCY_CHANGED')
 m=types.ModuleType(path.stem);m.__file__=str(path);exec(compile(raw,str(path),'exec'),m.__dict__);return m
def modules(root):return {name:load_code(root/name,pin) for name,pin in PINS.items()}
def namespace(root,name):
 need(type(name)is str and re.fullmatch('[A-Za-z0-9][A-Za-z0-9_-]{0,23}',name) is not None,'SHORT_UNIQUE_NAMESPACE_REQUIRED');root=Path(root)
 names=['ob-'+name+'.json','ab-'+name+'.json','frontend-one-pass-'+name+'.json','backend-proof-'+name+'.json','frontend-inputs-'+name+'.json','readback-prep-'+name+'.json','frontend-'+name,'frontend-journal-'+name+'.json','frontend-runtime-inputs-'+name+'.json','frontend-runtime-journal.json','frontend-runtime-overlay.json','frontend-runtime-rollback-overlay.json']
 for p in [root]+[root/n for n in names]:
  need(p.is_absolute() and '..' not in p.parts,'ABSOLUTE_RELEASE_REQUIRED')
  for q in [*reversed(p.parents),p]:
   try:s=q.lstat()
   except FileNotFoundError:continue
   need(not stat.S_ISLNK(s.st_mode) and not(getattr(s,'st_file_attributes',0)&0x400),'RELEASE_LINK_REFUSED')
  if p!=root:need(not p.exists(),'NAMESPACE_EXISTS_UNKNOWN_RESULT_DO_NOT_RETRY')
 need(root.is_dir(),'EXISTING_RELEASE_REQUIRED')
class NativeRunner:
 def __init__(self,mods):self.read=mods['root_readback_inputs.py'].Runner();self.core=mods['activate_root.py']
 def __call__(self,args,input=None):
  # Preserve the accepted Compose runner's captured project-directory + process cwd.
  if 'compose' in args:
   need(input is None and (args==['docker','compose','config','--help'] or '--project-directory' in args),'EXACT_COMPOSE_RUNNER_REQUIRED');return self.core.native(args)
  return self.read(args,input)
def validate_rows(value,f,now):
 rowkeys={'method','origin','path','status','projection','responseSha256','observationId','observedAtUtc'}
 for key,origin,path in [('owner','https://synapse.synapsebusiness.ru','/content/whoami'),('account','https://palitra-love.ru','/api/draft-account/session')]:
  row=value[key];need(type(row)is dict and set(row)==rowkeys and row['method']=='GET' and row['origin']==origin and row['path']==path and type(row['status'])is int and row['status']==200,'EXACT_ACTUAL_UI_READBACK_REQUIRED')
  need(f.hash_ok(row['responseSha256']) and type(row['observationId'])is str and re.fullmatch('[A-Za-z0-9_:/.-]{1,200}',row['observationId']) is not None,'ACTUAL_UI_DIGEST_OBSERVATION_REQUIRED');f.fresh(row['observedAtUtc'],now)
 owner=value['owner']['projection'];account=value['account']['projection']
 need(type(owner)is dict and set(owner)=={'userId','role','companyIds'} and type(owner['userId'])in (int,str) and str(owner['userId'])=='1' and owner['role']=='owner' and type(owner['companyIds'])is list and 0<len(owner['companyIds'])<=50 and all(type(c)is str and re.fullmatch('[a-z0-9-]{1,64}',c) for c in owner['companyIds']) and len(set(owner['companyIds']))==len(owner['companyIds']) and 'palitra-love' in owner['companyIds'],'EXISTING_OWNER_COMPANY_REQUIRED')
 need(type(account)is dict and set(account)=={'loggedIn'} and type(account['loggedIn'])is bool,'ACTUAL_SELECTED_ACCOUNT_PROJECTION_REQUIRED')
def safe_failure(error):
 if isinstance(error,Refused):return str(error)
 text=str(error).lower()
 for needle,code in [('stale','ACTUAL_READBACK_STALE'),('future','ACTUAL_READBACK_FUTURE'),('sha','ARTIFACT_SHA_REFUSED'),('unknown','UNKNOWN_RESULT_STOPPED'),('native command','NATIVE_COMMAND_REFUSED'),('already','ARTIFACT_ALREADY_EXISTS'),('existing','EXISTING_STATE_REFUSED'),('image','IMAGE_PROOF_REFUSED'),('origin','ORIGIN_PROOF_REFUSED')]:
  if needle in text:return code
 return 'PHASE_REFUSED_NO_RETRY'
class OnePass:
 def __init__(self,mods,root=ROOT,runner=None,now=None,emit=None):self.mods=mods;self.root=Path(root);self.f=mods['frontend_activation.py'];self.collector=mods['root_readback_inputs.py'].Collector(self.f,self.root,runner or NativeRunner(mods),now);self.runner=self.collector.run;self.now=now or (lambda:datetime.now(timezone.utc));self.emit=emit or (lambda row:print(json.dumps(row,separators=(',',':')),flush=True));self.state=None;self.journal=None
 def stage(self,name,**extra):
  self.state.update(phase=name,**extra);self.f.replace_json(self.journal,self.state);self.emit({'stage':name,'status':'IN_PROGRESS','journalFile':self.journal.name})
 def run(self,rows,name,expected,apply=False):
  need(apply is True,'EXPLICIT_ROOT_APPLY_REQUIRED');namespace(self.root,name);validate_rows(rows,self.f,self.now());f=self.f;root=f.path(self.root);owner=root/('ob-'+name+'.json');account=root/('ab-'+name+'.json');self.journal=root/('frontend-one-pass-'+name+'.json')
  self.state={'schema':1,'phase':'ROW_FILES_CREATE_STARTED_UNKNOWN','name':name,'readbackDataSha256':expected,'dependencyPins':PINS,'ownerFile':owner.name,'accountFile':account.name,'automaticRetry':False,'accountGetsByCollector':0,'workerRecreated':False,'directDatabaseWrites':0,'externalMessages':0}
  f.write_new(self.journal,f.encoded(self.state))
  try:
   f.write_new(owner,f.encoded(rows['owner']));f.write_new(account,f.encoded(rows['account']));owner_sha=sha(f.read(owner));account_sha=sha(f.read(account));self.collector.owner(owner.name,owner_sha);self.collector.account(account.name,account_sha)
   self.stage('COLLECTOR_PREPARE_STARTED_UNKNOWN',ownerSha256=owner_sha,accountSha256=account_sha)
   prepared=self.collector.prepare(owner.name,owner_sha,account.name,account_sha,name,True);need(prepared.get('status')=='PRIVATE_READBACK_PROOF_AND_INPUTS_READY','COLLECTOR_RESULT_UNKNOWN')
   self.stage('FROZEN_FRONTEND_APPLY_STARTED_UNKNOWN',frontendInputsFile=prepared['inputsFile'],frontendInputsSha256=prepared['inputsSha256'])
   values=self.collector.pin(prepared['inputsFile'],prepared['inputsSha256']);front=f.Frontend(self.runner,self.now);x=front.artifacts(Path(values['bundle']),values['manifest_sha'],Path(values['build_journal']),values['build_journal_sha'],Path(values['activation_journal']),values['activation_journal_sha'],Path(values['candidate']))
   code=front.apply(x,Path(values['backend_proof']),values['backend_proof_sha'],Path(values['context']),Path(values['journal']),apply=True);need(code.get('status')=='FRONTEND_CODE_READY_IMAGE_NOT_ACTIVATED','FRONTEND_CODE_RESULT_UNKNOWN')
   self.stage('RUNTIME_INPUTS_PREPARE_STARTED_UNKNOWN',frontendImage=code['frontendImage'],frontendJournalSha256=code['journalSha256'])
   runtime=self.mods['frontend_runtime.py'];core=self.mods['activate_root.py'];ready=self.collector.runtime_inputs(prepared['inputsFile'],prepared['inputsSha256'],name,True,runtime,core);need(ready.get('status')=='PRIVATE_FRONTEND_RUNTIME_INPUTS_READY','RUNTIME_INPUTS_RESULT_UNKNOWN')
   self.stage('FROZEN_RUNTIME_APPLY_STARTED_UNKNOWN',runtimeInputsFile=ready['inputsFile'],runtimeInputsSha256=ready['inputsSha256'])
   runtime_value=self.collector.pin(ready['inputsFile'],ready['inputsSha256']);result=runtime.Switch(core,root,self.runner,self.now).apply(runtime_value,apply=True);need(result.get('status')=='FRONTEND_CONTENT_APPLIED_NOT_PUBLIC_PROOF' and result.get('workerRecreated') is False,'FRONTEND_RUNTIME_RESULT_UNKNOWN')
   self.state.update(phase='FRONTEND_RELEASE_APPLIED_NOT_PUBLIC_PROOF',runtimeJournalSha256=result['journalSha256'],images=result['images'],publicReady=False);f.replace_json(self.journal,self.state)
   final={'stage':self.state['phase'],'status':'COMPLETE','images':result['images'],'journalFile':self.journal.name,'journalSha256':sha(f.read(self.journal)),'frontendInputsFile':prepared['inputsFile'],'runtimeInputsFile':ready['inputsFile'],'publicReady':False,'workerRecreated':False,'directDatabaseWrites':0,'externalMessages':0};self.emit(final);return final
  except BaseException as error:
   self.state.update(failedStage=self.state['phase'],phase='ONE_PASS_FAILED_UNKNOWN_DO_NOT_RETRY',failureCode=safe_failure(error),automaticRetry=False)
   try:f.replace_json(self.journal,self.state)
   except BaseException:pass
   raise
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--apply',action='store_true');p.add_argument('--name',required=True);p.add_argument('--expected-readbacks-sha',required=True);a=p.parse_args();stream=sys.stdin;operation=None
 try:
  need(os.name=='posix' and os.geteuid()==0,'NATIVE_ROOT_REQUIRED');need(a.apply is True,'EXPLICIT_ROOT_APPLY_REQUIRED');need(re.fullmatch('[0-9a-f]{64}',a.expected_readbacks_sha) is not None,'EXPECTED_READBACK_SHA_REQUIRED');need(re.fullmatch('[A-Za-z0-9][A-Za-z0-9_-]{0,23}',a.name) is not None,'SHORT_UNIQUE_NAMESPACE_REQUIRED')
  namespace(ROOT,a.name)
  with NoEcho(stream):rows=receive(stream,a.expected_readbacks_sha)
  mods=modules(ROOT);operation=OnePass(mods);operation.run(rows,a.name,a.expected_readbacks_sha,True)
  return 0
 except BaseException as error:
  stage=operation.state.get('failedStage',operation.state['phase']) if operation and operation.state else 'RECEIVE_OR_PREFLIGHT'
  print(json.dumps({'status':'REFUSED','stage':stage,'code':safe_failure(error),'automaticRetry':False},separators=(',',':')),flush=True);return 2
if __name__=='__main__':sys.exit(main())
