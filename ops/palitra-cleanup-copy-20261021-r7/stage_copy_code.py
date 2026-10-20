"""Local private ZIP staging only; no SQLite open, runtime inspect or preparation."""
import argparse,hashlib,io,json,os,re,stat,subprocess,sys,zipfile
from pathlib import Path
ROOT=Path('/opt/synapse/releases/palitra-app-20261015');NAME='palitra-order-cleanup-copy-20261021-r7';CODE=ROOT/(NAME+'-code')
ZIP_SHA='9d0025e7702064c8e954cdd4975eb88727b07495725910dc31ed7a3dcfe31c62'
MANIFEST_SHA='bf0eaa9ac1e7a3330b8678875f7cac94d400d5b7ee1ea597a7b60bf5cd0e02f5'
RUNNER_SHA='b59e42f814c6e91246e0f56df9487c8d75a924e50d53b19dc426594c21ca5872'
LOCK='/opt/synapse/.palitra-app-release.lock';PID=3462715
NAMES={'copy_prepare.py','cleanup_runtime.py','live_entry.py','prepare_preview.py','LOCAL_CODE_PINS.json','COPY_ONLY_MANIFEST.json'}
sha=lambda b:hashlib.sha256(b).hexdigest()
def need(ok,code):
 if not ok:raise ValueError(code)
def directory(path,mode):
 for p in (path,*path.parents):need(not p.is_symlink(),'STAGE_ALIAS_REFUSED')
 s=path.lstat();need(stat.S_ISDIR(s.st_mode) and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==mode,'STAGE_ROOT_DIRECTORY_REQUIRED')
def read(path,pin=None):
 need(path.is_relative_to(ROOT) and path.is_absolute() and '..' not in path.parts,'PRIVATE_STAGE_INPUT_PATH_REQUIRED')
 for p in (path,*path.parents):need(not p.is_symlink(),'STAGE_INPUT_ALIAS_REFUSED')
 s=path.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o600 and 0<s.st_size<=4*1024*1024,'PRIVATE_STAGE_FILE_REQUIRED')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 with os.fdopen(fd,'rb') as stream:
  a=os.fstat(stream.fileno());raw=stream.read(4*1024*1024+1);z=os.fstat(stream.fileno())
 q=path.lstat();fields=('st_dev','st_ino','st_uid','st_gid','st_mode','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
 need(len(raw)==s.st_size and all(getattr(s,k)==getattr(a,k)==getattr(z,k)==getattr(q,k) for k in fields),'STAGE_INPUT_RACED')
 need(pin is None or sha(raw)==pin,'STAGE_PIN_CHANGED');return raw
def write(path,raw):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as out:out.write(raw);out.flush();os.fsync(out.fileno())
 need(read(path)==raw,'STAGE_READBACK_CHANGED')
def lease(ticks):
 need(type(ticks) is str and re.fullmatch('[1-9][0-9]*',ticks),'FRESH_START_TICKS_REQUIRED')
 out=subprocess.run(['lslocks','--noheadings','--output','PID,PATH'],check=True,capture_output=True,timeout=10)
 need(not out.stderr and len(out.stdout)<=1048576,'BOUNDED_STAGE_LEASE_REQUIRED')
 rows=[r.strip().split(maxsplit=1) for r in out.stdout.decode().splitlines()]
 need([r for r in rows if len(r)==2 and r[1]==LOCK]==[[str(PID),LOCK]],'STAGE_EXACT_OWN_LEASE_REQUIRED')
 proc=Path('/proc')/str(PID)/'stat';need(proc.stat().st_size<=8192 and proc.read_text().rsplit(') ',1)[1].split()[19]==ticks,'STAGE_PID_REUSED')
def archive(raw):
 need(sha(raw)==ZIP_SHA,'EXACT_COPY_ONLY_ZIP_REQUIRED')
 with zipfile.ZipFile(io.BytesIO(raw)) as z:
  info=z.infolist();need(len(info)==6 and {r.filename for r in info}==NAMES,'CLOSED_SIX_FLAT_FILES_REQUIRED')
  need(all(not r.is_dir() and r.filename in NAMES and stat.S_ISREG(r.external_attr>>16) and stat.S_IMODE(r.external_attr>>16)==0o600 and r.file_size<=4*1024*1024 for r in info),'REGULAR_PRIVATE_BOUNDED_MEMBERS_REQUIRED')
  files={r.filename:z.read(r) for r in info}
 need(sha(files['COPY_ONLY_MANIFEST.json'])==MANIFEST_SHA and sha(files['copy_prepare.py'])==RUNNER_SHA,'EXACT_MANIFEST_RUNNER_REQUIRED')
 m=json.loads(files['COPY_ONLY_MANIFEST.json']);need(m['namespace']==NAME and m['runtimeAuthorization'] is False and m['fullGuardAccepted'] is False and set(m['files'])==NAMES-{'COPY_ONLY_MANIFEST.json'},'COPY_ONLY_SCOPE_REQUIRED')
 for n,row in m['files'].items():need(sha(files[n])==row['sha256'] and len(files[n])==row['bytes'],'EXACT_INNER_STAGE_BYTES_REQUIRED')
 return files
def main():
 p=argparse.ArgumentParser(description='Code staging only; no run mode');p.add_argument('--zip',required=True);p.add_argument('--lease-start-ticks',required=True);a=p.parse_args()
 need(os.name=='posix' and os.geteuid()==os.getegid()==0,'STAGE_POSIX_ROOT_REQUIRED');directory(ROOT,0o755);lease(a.lease_start_ticks)
 files=archive(read(Path(a.zip),ZIP_SHA));unknown=ROOT/(NAME+'-code-stage-unknown.json');done=ROOT/(NAME+'-code-stage-completed.json')
 need(not any(os.path.lexists(p) for p in (CODE,unknown,done)),'EXISTING_STAGE_NO_RETRY');lease(a.lease_start_ticks)
 write(unknown,json.dumps({'schema':1,'phase':'CODE_STAGE_STARTED_UNKNOWN_NO_RETRY','namespace':NAME,'zipSha256':ZIP_SHA,'leasePid':PID,'startTicks':a.lease_start_ticks,'runtimeDatabaseWrites':0,'runtimeAuthorization':False},sort_keys=True).encode())
 os.mkdir(CODE,0o700);directory(CODE,0o700)
 for n,b in sorted(files.items()):write(CODE/n,b)
 need({p.name for p in CODE.iterdir()}==NAMES,'STAGED_CODE_CLOSURE_CHANGED');lease(a.lease_start_ticks)
 result={'schema':1,'status':'COPY_CODE_STAGED_NOT_RUNTIME_AUTHORIZATION','namespace':NAME,'zipSha256':ZIP_SHA,'manifestSha256':MANIFEST_SHA,'runnerSha256':RUNNER_SHA,'files':6,'fullGuardAccepted':False,'liveApplyEnabled':False,'runtimeDatabaseWrites':0}
 write(done,json.dumps(result,sort_keys=True).encode());print(json.dumps(result,sort_keys=True))
if __name__=='__main__':
 try:main()
 except BaseException:
  print(json.dumps({'status':'COPY_CODE_STAGE_REFUSED_OR_UNKNOWN_NO_RETRY','runtimeAuthorization':False,'liveApplyEnabled':False,'runtimeDatabaseWrites':0}));raise SystemExit(2)
