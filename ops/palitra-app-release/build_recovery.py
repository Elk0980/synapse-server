"""One explicitly approved local-tag recovery. No activation/static/DB/network tools."""
import argparse,hashlib,importlib.util,json,os,re,stat,subprocess,sys,threading,time
from pathlib import Path

ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
BUNDLE=ROOT/'bundle-root-final'
OLD_JOURNAL=ROOT/'native-build.json'
RECEIPT=ROOT/'native-build-failure-receipt-r2.json'
CONTEXT=ROOT/'build-recovery-r2'
JOURNAL=ROOT/'native-build-r2.json'
MANIFEST_SHA='dd82ce11f239823d005a0e05132f92b640776984f01013094d07e07e62c6d812'
OLD_JOURNAL_SHA='6cf875310ce04cd431320ab90a64715b35bf9b81bda94bd6534a6da33f66a13e'
CODE_PINS={'release_common.py':'924c235d6927da5f4f8d210fa50ca05be85b67a2455269b7baffc0aeca2d24bc',
           'native_release.py':'c2b01d25f38f1113a3f774e28b474ac2301adfe47654a600bbca95912e08a8b4'}
LEASE={'pid':2744197,'path':'/opt/synapse/.palitra-app-release.lock'}
IMAGE_RE=re.compile(r'sha256:[0-9a-f]{64}')
LOCAL={'content':'palitra-local-base-content:root-final-r2','worker':'palitra-local-base-worker:root-final-r2'}
CHILD={'content':'palitra-combined:root-final-r2','worker':'palitra-chat-combined:root-final-r2'}

class Refused(Exception):pass
def need(condition,code):
 if not condition:raise Refused(code)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def read(path,limit=4*1024*1024):
 path=Path(path)
 need(path.is_absolute() and '..' not in path.parts,'PATH_GUARD')
 for part in reversed([path,*path.parents]):
  info=part.lstat();need(not stat.S_ISLNK(info.st_mode),'LINK_GUARD')
  if part!=path:need(stat.S_ISDIR(info.st_mode),'PARENT_GUARD')
 info=path.lstat();need(stat.S_ISREG(info.st_mode) and 0<info.st_size<=limit,'FILE_GUARD')
 fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
 try:
  before=os.fstat(fd)
  with os.fdopen(fd,'rb',closefd=False) as stream:raw=stream.read(limit+1)
  after=os.fstat(fd);named=path.lstat()
  fields=lambda value:(value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_mode)
  need(fields(info)==fields(before)==fields(after)==fields(named) and len(raw)==info.st_size,'FILE_CHANGED')
  return raw
 finally:os.close(fd)
def obj(raw):
 def pairs(items):
  result={}
  for key,value in items:need(key not in result,'DUPLICATE_JSON');result[key]=value
  return result
 return json.loads(raw.decode('utf-8-sig'),object_pairs_hook=pairs)
def absent(path):
 for parent in reversed(path.parents):
  info=parent.lstat();need(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode),'PARENT_GUARD')
 try:path.lstat()
 except FileNotFoundError:return
 raise Refused('OUTPUT_EXISTS_UNKNOWN')
def private_new(path,raw):
 absent(path);fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
 with os.fdopen(fd,'wb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
def json_bytes(value):return (json.dumps(value,sort_keys=True,indent=2)+'\n').encode()
def store(value,new=False):
 if new:private_new(JOURNAL,json_bytes(value));return
 pending=JOURNAL.with_name(JOURNAL.name+'.pending');private_new(pending,json_bytes(value));os.replace(pending,JOURNAL)

class CommandFailure(Refused):
 def __init__(self,proof):self.proof=proof;super().__init__(proof['code'])
class Runner:
 """Keep bounded bytes and hashes; never emit raw subprocess output on failure."""
 def __init__(self):self.stage='preflight';self.last=None
 def __call__(self,args):
  process=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,shell=False)
  results={}
  def drain(stream,name,limit):
   digest=hashlib.sha256();kept=bytearray();size=0;failed=False
   try:
    while True:
     block=stream.read(65536)
     if not block:break
     digest.update(block);size+=len(block)
     if len(kept)<limit:kept.extend(block[:limit-len(kept)])
   except BaseException:failed=True
   finally:stream.close();results[name]=(bytes(kept),size,digest.hexdigest(),failed)
  threads=[threading.Thread(target=drain,args=(process.stdout,'out',32*1024*1024),daemon=True),
           threading.Thread(target=drain,args=(process.stderr,'err',65536),daemon=True)]
  for thread in threads:thread.start()
  timeout=False
  try:code=process.wait(timeout=300)
  except subprocess.TimeoutExpired:timeout=True;process.kill();code=process.wait(timeout=10)
  for thread in threads:thread.join(timeout=10)
  need(set(results)=={'out','err'},'COMMAND_DRAIN_FAILED')
  out,out_size,_,out_failed=results['out'];err,err_size,err_sha,err_failed=results['err']
  need(not out_failed and not err_failed,'COMMAND_DRAIN_FAILED')
  reason='COMMAND_TIMEOUT' if timeout else 'COMMAND_NONZERO'
  for marker,name in [(b'pull access denied','REGISTRY_REFERENCE_REFUSED'),(b'insufficient_scope','REGISTRY_REFERENCE_REFUSED'),
                      (b'unknown flag','UNSUPPORTED_CLI_FLAG'),(b'no space left on device','STORAGE_FULL'),
                      (b'failed to calculate checksum','COPY_CONTEXT_REFUSED')]:
   if not timeout and marker in err.lower():reason=name;break
  if out_size>len(out):reason='STDOUT_LIMIT'
  self.last={'stage':self.stage,'code':reason,'exitCode':code,'stderrBytes':err_size,'stderrSha256':err_sha,'stderrTruncated':err_size>65536}
  if code!=0 or timeout or out_size>len(out):raise CommandFailure(self.last)
  return out

def load_native():
 # Import only immutable code from the already validated frozen bundle.
 for name,pin in CODE_PINS.items():
  path=BUNDLE/name;raw=read(path);need(sha(raw)==pin,'HELPER_SHA_CHANGED')
  module_name=name[:-3]
  spec=importlib.util.spec_from_file_location(module_name,path);module=importlib.util.module_from_spec(spec)
  sys.modules[module_name]=module;exec(compile(raw,str(path),'exec'),module.__dict__)
 return sys.modules['native_release']
def layers(runner,image):
 raw=runner(['docker','image','inspect','--format','{{json .RootFS.Layers}}',image]);value=obj(raw)
 need(type(value)is list and value and all(type(item)is str and IMAGE_RE.fullmatch(item) for item in value),'LAYER_PROOF_INVALID')
 return value
def image_id(runner,tag):
 value=runner(['docker','image','inspect','--format','{{.Id}}',tag]).decode('ascii').strip()
 need(IMAGE_RE.fullmatch(value) is not None,'IMAGE_ID_INVALID');return value
def unused(runner,tag):need(runner(['docker','image','ls','--quiet',tag]).strip()==b'','TAG_EXISTS_UNKNOWN')
def derive(raw,image,local_tag,rows):
 original=('FROM '+image+'\n'+''.join('COPY '+row['payload']+' /app/'+row['target']+'\n' for row in rows)).encode()
 need(raw==original,'DOCKERFILE_NOT_EXACT_COPY_ONLY')
 return ('FROM '+local_tag+'\n').encode()+raw.split(b'\n',1)[1]

def recovery(*,apply,receipt_sha,runner=None,native=None,now=None):
 need(apply is True,'EXPLICIT_APPLY_REQUIRED');need(re.fullmatch(r'[0-9a-f]{64}',receipt_sha or '') is not None,'RECEIPT_PIN_REQUIRED')
 native=load_native() if native is None else native;runner=Runner() if runner is None else runner
 m=native.manifest(BUNDLE,MANIFEST_SHA)
 need(m['releaseId']=='root-final' and m['lease']==LEASE and len(m['content'])==39 and len(m['worker'])==1,'FROZEN_SCOPE_CHANGED')
 receipt_raw=read(RECEIPT);need(sha(receipt_raw)==receipt_sha,'RECEIPT_SHA_CHANGED');receipt=obj(receipt_raw)
 required={'schema','rootApproved','observedEpoch','releaseId','oldJournalSha256','diagnosticCode','builder','nativeAuthorizationFailure'}
 need(set(receipt)==required and receipt['schema']==1 and receipt['rootApproved'] is True and receipt['releaseId']=='root-final'
      and receipt['diagnosticCode']=='FROM_ID_RESOLVED_AS_REGISTRY_NAME' and receipt['builder']=='docker:default'
      and receipt['nativeAuthorizationFailure'] is False,'INDEPENDENT_DIAGNOSTIC_REQUIRED')
 epoch=time.time() if now is None else now
 need(type(receipt['observedEpoch'])in (int,float) and 0<=epoch-receipt['observedEpoch']<=600,'DIAGNOSTIC_RECEIPT_STALE')
 old_raw=read(OLD_JOURNAL);need(sha(old_raw)==receipt['oldJournalSha256']==OLD_JOURNAL_SHA,'OLD_JOURNAL_CHANGED')
 need(obj(old_raw)=={'releaseId':'root-final','phase':'BUILD_STARTED_UNKNOWN'},'OLD_ATTEMPT_STATE_CHANGED')
 absent(JOURNAL);absent(JOURNAL.with_name(JOURNAL.name+'.pending'));absent(CONTEXT)
 def guard(stage):
  runner.stage=stage
  need(native.manifest(BUNDLE,MANIFEST_SHA)==m,'FROZEN_SOURCE_CHANGED')
  native.preflight(BUNDLE,m,runner)
  need(sha(read(OLD_JOURNAL))==sha(old_raw) and sha(read(RECEIPT))==receipt_sha,'PROOF_CHANGED')
  unused(runner,'palitra-combined:root-final');unused(runner,'palitra-chat-combined:root-final')
 guard('preflight_before')
 for tag in ['palitra-combined:root-final','palitra-chat-combined:root-final',*LOCAL.values(),*CHILD.values()]:unused(runner,tag)
 frames={};base_layers={}
 for group,name in [('content','Dockerfile'),('worker','Dockerfile.worker')]:
  raw=read(BUNDLE/name);need(sha(raw)==m['sourceFiles'][name]['sha256'],'DOCKERFILE_SHA_CHANGED')
  frames[group]=derive(raw,m['images'][group],LOCAL[group],m[group]);base_layers[group]=layers(runner,m['images'][group])
 state={'schema':1,'releaseId':m['releaseId'],'attemptId':'root-final-r2','phase':'RECOVERY_STARTED_UNKNOWN','stage':'create_context',
        'manifestSha256':MANIFEST_SHA,'oldJournalSha256':sha(old_raw),'diagnosticReceiptSha256':receipt_sha,
        'originalImages':m['images'],'localTags':LOCAL,'childTags':CHILD,'childImages':{},'copyCounts':{'content':39,'worker':1},
        'dockerfileSha256':{key:sha(value) for key,value in frames.items()},'runtimeRestarts':0,'dbWrites':0,'staticWrites':0}
 store(state,new=True)
 try:
  CONTEXT.mkdir(mode=0o700)
  for group,name in [('content','Dockerfile'),('worker','Dockerfile.worker')]:private_new(CONTEXT/name,frames[group])
  for group,name in [('content','Dockerfile'),('worker','Dockerfile.worker')]:
   runner.stage=state['stage']='preflight_'+group;store(state);guard(runner.stage)
   need(sha(read(OLD_JOURNAL))==state['oldJournalSha256'] and sha(read(RECEIPT))==receipt_sha,'PROOF_CHANGED')
   unused(runner,LOCAL[group]);unused(runner,CHILD[group])
   runner.stage=state['stage']='tag_'+group;store(state)
   runner(['docker','tag',m['images'][group],LOCAL[group]])
   need(image_id(runner,LOCAL[group])==m['images'][group],'LOCAL_TAG_BASE_MISMATCH')
   runner.stage=state['stage']='build_'+group;store(state)
   need(sha(read(CONTEXT/name))==state['dockerfileSha256'][group],'RECOVERY_DOCKERFILE_CHANGED')
   runner(['docker','build','--network=none','--pull=false','--tag',CHILD[group],'--file',str(CONTEXT/name),str(BUNDLE)])
   child=image_id(runner,CHILD[group]);need(child!=m['images'][group],'CHILD_IMAGE_UNCHANGED')
   need(image_id(runner,LOCAL[group])==m['images'][group],'LOCAL_TAG_DRIFT')
   child_layers=layers(runner,child);prefix=base_layers[group]
   need(child_layers[:len(prefix)]==prefix and len(child_layers)==len(prefix)+len(m[group]),'CHILD_LAYER_PREFIX_OR_COUNT')
   state['childImages'][group]=child;store(state)
  runner.stage=state['stage']='preflight_after';store(state);guard(runner.stage)
  need(sha(read(OLD_JOURNAL))==state['oldJournalSha256'] and sha(read(RECEIPT))==receipt_sha,'PROOF_CHANGED')
  for group in ('content','worker'):
   need(image_id(runner,LOCAL[group])==m['images'][group] and image_id(runner,CHILD[group])==state['childImages'][group],'FINAL_IMAGE_TAG_DRIFT')
  state.update({'phase':'BUILT_NOT_ACTIVATED','stage':'complete','contentTag':CHILD['content'],'contentImage':state['childImages']['content'],
                'workerTag':CHILD['worker'],'workerImage':state['childImages']['worker']});store(state)
  return {'status':'BUILT_NOT_ACTIVATED','contentTag':state['contentTag'],'contentImage':state['contentImage'],
          'workerTag':state['workerTag'],'workerImage':state['workerImage'],'journalSha256':sha(read(JOURNAL)),
          'runtimeRestarts':0,'dbWrites':0,'staticWrites':0}
 except BaseException as error:
  state['phase']='RECOVERY_FAILED_UNKNOWN'
  state['failure']=error.proof if isinstance(error,CommandFailure) else {'stage':state['stage'],'code':str(error) if isinstance(error,Refused) else 'RECOVERY_FAILED'}
  try:store(state)
  except BaseException:pass
  raise

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--apply',action='store_true');parser.add_argument('--receipt-sha',required=True)
 args=parser.parse_args()
 try:
  need(os.name=='posix' and os.geteuid()==0,'NATIVE_ROOT_REQUIRED')
  result=recovery(apply=args.apply,receipt_sha=args.receipt_sha);print(json.dumps(result,separators=(',',':')));return 0
 except BaseException as error:
  result={'status':'REFUSED','code':str(error) if isinstance(error,Refused) else 'RECOVERY_FAILED'}
  if isinstance(error,CommandFailure):result.update(error.proof)
  print(json.dumps(result,separators=(',',':')));return 2
if __name__=='__main__':sys.exit(main())
