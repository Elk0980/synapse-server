"""Read-only exact ten-file worker graph observation. No app imports, build or rollback approval."""
import argparse,hashlib,json,re,subprocess,types
from pathlib import Path
from datetime import datetime,timezone

READER_SHA='26010f48a7e88a9d3dda6fef05fb61caa6a1358cb3e6a780f2e892aa5abc2a4f'
READER_BYTES=13683
CID='7d7ec369e7ce44e492874137813caf3399b21b0242438b3b6df1281e4f379415'
IMAGE='sha256:c5dd4502daf630afaac7415da5b19dc456c81a5f81626574f5480dec04307cca'
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
EXPECTED={
 'server.js':(67386,'0cd5f50dd97524460ac2b688e221ca2b97fe81968cd8e6765aab5f85053e9cb4'),
 'telegram-channel-stats.js':(11471,'cf45fe0136f24c0bca76dcb0205775060fa5b892e253f0a1553a7504c5ae5f11'),
 'consent-texts.json':(884,'f0123fe085f21c6438b1dd38a1a31e0027f7f1404d87c861b6e082f8ac169d7f'),
 'quiet-hours.js':(2344,'4307380c32b34edf1f361f1ab9e618627aab251945c5f432d2a31f9e255bfd6b'),
 'task-intake.js':(1655,'8537fdb9a35af47dbd1c1283eae4ddf566a063d645cad00c7da2880eee405397'),
 'telegram-binding.js':(1282,'93fe9739f64470afc90086de4ba3a0c479ca9bfd775d137ea83162df6c7f263b'),
 'project-chat-bridge.js':(32633,'48061448959917a4aae7798dae185fce51562d49e9da9b6fd814d20147a404c4'),
 'client-bot-registry.js':(2078,'d15c1c9d79aacc8b674b18d55a52bbc0949252fbc5dbeb37a394a8077866e87b'),
 'client-bot-config.js':(1199,'5e1b6cf2d88fb672f5be4dea3648596cb3618663b57caf2da7c9709b630cdf20'),
 'client-bot-bridge.js':(27676,'36b0bdc733ad4f4514635d0416867d5964fef4c82aeabe125f542a20969de0ee'),
}
sha=lambda b:hashlib.sha256(b).hexdigest()
canon=lambda x:json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()
def need(value,code):
 if not value:raise ValueError(code)

GRAPH_PROBE=r'''const fs=require('node:fs'),c=require('node:crypto'),p=require('node:path');
const names=Object.freeze(__NAMES__),files={};
if(fs.realpathSync('/app')!=='/app'||!fs.lstatSync('/app').isDirectory()||fs.lstatSync('/app').isSymbolicLink()||process.cwd()!=='/app')throw Error('APP_BOUNDARY');
for(const name of names){const f=p.join('/app',name),limit=2*1024*1024;let fd=null;
 try{const s=fs.lstatSync(f);if(!s.isFile()||s.isSymbolicLink()||fs.realpathSync(f)!==f||s.size>limit)throw Error('FILE_BOUNDARY');
  fd=fs.openSync(f,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const first=fs.fstatSync(fd);if(first.dev!==s.dev||first.ino!==s.ino||first.size!==s.size)throw Error('FILE_RACE');
  let size=0,n;const buffer=Buffer.alloc(65536),h=c.createHash('sha256');while((n=fs.readSync(fd,buffer,0,Math.min(buffer.length,limit+1-size),null))>0){size+=n;if(size>limit)throw Error('FILE_LIMIT');h.update(buffer.subarray(0,n));}
  const end=fs.fstatSync(fd),last=fs.lstatSync(f);if(size!==s.size||end.size!==s.size||end.mtimeMs!==s.mtimeMs||end.ctimeMs!==s.ctimeMs||last.dev!==s.dev||last.ino!==s.ino||last.size!==s.size||last.mtimeMs!==s.mtimeMs||last.ctimeMs!==s.ctimeMs||last.isSymbolicLink()||fs.realpathSync(f)!==f)throw Error('FILE_RACE');
  files[name]={available:true,size,mode:s.mode&4095,sha256:h.digest('hex')};
 }catch{files[name]={available:false};}finally{if(fd!==null)fs.closeSync(fd);}}
console.log(JSON.stringify({schema:1,files}));'''.replace('__NAMES__',json.dumps(sorted(EXPECTED),separators=(',',':')))

def load_reader(path,allowed_root=ROOT):
 path=Path(path);need(path.is_absolute()and path.is_file()and not path.is_symlink(),'LOCAL_READER_REQUIRED')
 root=Path(allowed_root).resolve(strict=True);need(path.resolve(strict=True)==path and path.parent==root,'LOCAL_READER_BOUNDARY')
 need(path.stat().st_size==READER_BYTES,'EXACT_ACCEPTED_READER_SIZE_REQUIRED')
 raw=path.read_bytes();need(len(raw)==READER_BYTES and sha(raw)==READER_SHA,'EXACT_ACCEPTED_READER_REQUIRED')
 mod=types.ModuleType('accepted_worker_reader');mod.__file__=str(path)
 exec(compile(raw,'accepted_worker_reader','exec'),mod.__dict__)
 need(mod.CID==CID and mod.IMAGE==IMAGE and mod.PID==2744197 and mod.LOCK=='/opt/synapse/.palitra-app-release.lock','ACCEPTED_BINDING_REQUIRED')
 return mod

class Observer:
 def __init__(self,accepted,execute=None):
  self.accepted=accepted;self.execute=execute or subprocess.run;self.events=[];self.observations=[]
  self.allowed=[['lslocks','--json','--output','PID,MODE,PATH'],['docker','inspect','--format',accepted.INSPECT,'synapse-chat-1'],['docker','exec',CID,'node','-e',GRAPH_PROBE]]
  self.reader=accepted.Reader(execute=self.safe_execute)
 def safe_execute(self,args,**kwargs):
  need(args in self.allowed,'READONLY_COMMAND_NOT_ALLOWED')
  need(kwargs==dict(capture_output=True,stdin=subprocess.DEVNULL,shell=False,timeout=30),'EXACT_READONLY_EXEC_REQUIRED')
  try:out=self.execute(args,**kwargs)
  except subprocess.TimeoutExpired:
   self.events.append(dict(command=self.allowed.index(args),timeout=True));raise ValueError('READONLY_TIMEOUT')from None
  stdout,stderr=out.stdout or b'',out.stderr or b''
  self.events.append(dict(command=self.allowed.index(args),rc=out.returncode,stdoutBytes=len(stdout),stderrSha256=sha(stderr)))
  need(len(stdout)<=2*1024*1024 and len(stderr)<=2*1024*1024,'READONLY_OUTPUT_BOUND')
  need(out.returncode==0,'READONLY_COMMAND_FAILED')
  return out
 def graph(self):
  raw=self.safe_execute(self.allowed[2],capture_output=True,stdin=subprocess.DEVNULL,shell=False,timeout=30).stdout
  data=json.loads(raw);need(type(data)is dict and set(data)=={'schema','files'}and type(data['schema'])is int and data['schema']==1,'GRAPH_SCHEMA_REQUIRED')
  files=data['files'];need(type(files)is dict and set(files)==set(EXPECTED),'EXACT_TEN_FILE_SET_REQUIRED')
  matches={}
  for name,(size,digest)in EXPECTED.items():
   r=files[name];need(type(r)is dict and type(r.get('available'))is bool,'KNOWN_FILE_SCHEMA_REQUIRED')
   if r['available']:
    need(set(r)=={'available','size','mode','sha256'}and type(r['size'])is int and 0<=r['size']<=2*1024*1024 and type(r['sha256'])is str and re.fullmatch(r'[0-9a-f]{64}',r['sha256'])and type(r['mode'])is int and 0<=r['mode']<=4095,'KNOWN_FILE_METADATA_REQUIRED')
    matches[name]=r['size']==size and r['sha256']==digest
   else:need(set(r)=={'available'},'KNOWN_FILE_SCHEMA_REQUIRED');matches[name]=False
  self.observations.append(dict(files=files,matches=matches,allTenExact=all(matches.values())))
  return data
 def observe(self):
  out=dict(schema=1,observedAtUtc=datetime.now(timezone.utc).isoformat(),status='READONLY_GRAPH_INCOMPLETE_NO_MUTATION',commands=self.events,codeObservations=self.observations,mutations=0,dbWrites=0,runtimeRestarts=0,rollbackApproved=False,nodeBaseApproved=False,applicationImportsExecuted=False)
  try:
   self.reader.lease();before=self.accepted.safe_snapshot(self.reader.snapshot())
   need(before['startupAllowed']and not before['appOrRuntimeMountOverlap'],'STARTUP_OR_MOUNT_NEEDS_REVIEW')
   first=self.graph();second=self.graph();after=self.accepted.safe_snapshot(self.reader.snapshot());self.reader.lease()
   need(after['startupAllowed']and not after['appOrRuntimeMountOverlap'],'FINAL_STARTUP_OR_MOUNT_NEEDS_REVIEW')
   need(all(before[k]==after[k]for k in ['cid','image','restartCount','startupSha256','envOpaqueSha256','configOpaqueSha256','canonicalMountsSha256','composeLabelsSha256']),'FINAL_STARTUP_CONFIG_MOUNT_DRIFT')
   need(canon(first)==canon(second),'FINAL_CODE_METADATA_DRIFT')
   need(all(row['allTenExact']for row in self.observations),'EXACT_TRUSTED_CODE_PIN_REQUIRED')
   out.update(status='EXACT_TEN_WORKER_CODE_PINS_STABLE_NOT_RUNTIME_BASE_APPROVAL',worker=after,files=first['files'],allTenExact=True,stableStartupConfigMountsLease=True)
  except Exception as e:
   out['failure']=dict(errorClass=type(e).__name__ if re.fullmatch(r'[A-Za-z0-9_]{1,64}',type(e).__name__)else'Error',code=str(e)if type(e)is ValueError and re.fullmatch(r'[A-Z0-9_]{1,80}',str(e))else'READONLY_GRAPH_REFUSED')
  return out

def main():
 p=argparse.ArgumentParser(description='Read-only ten known worker code hashes; no app imports or runtime changes.')
 p.add_argument('--reader',required=True,type=Path);args=p.parse_args()
 try:
  accepted=load_reader(args.reader);out=Observer(accepted).observe()
  need(args.reader.stat().st_size==READER_BYTES and sha(args.reader.read_bytes())==READER_SHA,'ACCEPTED_READER_CHANGED_DURING_OBSERVATION')
 except Exception as e:out=dict(status='READONLY_GRAPH_INCOMPLETE_NO_MUTATION',mutations=0,dbWrites=0,runtimeRestarts=0,failure=dict(code=str(e)if type(e)is ValueError and re.fullmatch(r'[A-Z0-9_]{1,80}',str(e))else'LOCAL_READER_REFUSED'))
 print(json.dumps(out,sort_keys=True,separators=(',',':')))
if __name__=='__main__':main()
