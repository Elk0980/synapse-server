"""Stage exactly six reviewed copy-only files. No module execution/DB/apply."""
import argparse,hashlib,io,json,os,re,stat,subprocess,urllib.request,zipfile
from pathlib import Path
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
NAMESPACE='palitra-order-cleanup-copy-20261021-r10'
CODE=ROOT/(NAMESPACE+'-code')
LOCK='/opt/synapse/.palitra-app-release.lock'
URL_PREFIX='https://raw.githubusercontent.com/Elk0980/synapse-server/'
PUBLIC_NAMESPACE='ops/palitra-cleanup-copy-20261021-r10'
MANIFEST_SHA='cc30b814fa4ec3fc9391d6114ee118bd7afe8639d34829db88f8bdebc1b3aaef'
ZIP_SHA='2fd4e9644ce251efa71e2ac0b2ef8c2d3131d6d303271a5234c66d62e1c0f165'
PINS={'COPY_ONLY_MANIFEST.json': {'bytes': 928, 'sha256': 'cc30b814fa4ec3fc9391d6114ee118bd7afe8639d34829db88f8bdebc1b3aaef'}, 'LOCAL_CODE_PINS.json': {'bytes': 1098, 'sha256': '556cff84fb6c8aff6ee00e3f77c903588f7cd29e217bc11d43ebde3a5c377b85'}, 'cleanup_runtime.py': {'bytes': 29240, 'sha256': '6bd4b9f29ff1ffd4e553750d43df437444b5651485748e1eeca82163c8259861'}, 'copy_prepare.py': {'bytes': 12002, 'sha256': '8d96092beec7779de66eba919f6beb95c8bef42b173c4a0ed7db6c69d5dbb748'}, 'live_entry.py': {'bytes': 28711, 'sha256': '16600560cef5f63f6e799113cebafff2164b3e765472bc4d46c1bdfc8c656935'}, 'prepare_preview.py': {'bytes': 8497, 'sha256': '69197d0c9e14cd794a9c5e4c45d81f20c49084cea5183cd8192b3a7ca9df5284'}}
RELEASED=(3284416,3308227,3336085,3367042,3401855,3462715,3471272,3471456)
sha=lambda raw:hashlib.sha256(raw).hexdigest()
def need(ok,code):
 if not ok:raise ValueError(code)
def checked_inputs(commit,pid,start):
 need(type(commit)is str and re.fullmatch('[a-f0-9]{40}',commit),'EXACT_IMMUTABLE_PUBLIC_COMMIT_REQUIRED')
 need(type(pid)is int and pid>1 and pid not in RELEASED and type(start)is str and re.fullmatch('[1-9][0-9]*',start),'FRESH_OWN_LEASE_INPUTS_REQUIRED')
def held_lease(pid,start):
 result=subprocess.run(['lslocks','--noheadings','--output','PID,PATH'],check=True,capture_output=True,timeout=10)
 need(not result.stderr and len(result.stdout)<=1024*1024,'BOUNDED_LEASE_OBSERVATION_REQUIRED')
 rows=[row.strip().split(maxsplit=1)for row in result.stdout.decode().splitlines()]
 need([row for row in rows if len(row)==2 and row[1]==LOCK]==[[str(pid),LOCK]],'EXACT_OWN_LOCK_NOT_HELD')
 with (Path('/proc')/str(pid)/'stat').open('r',encoding='ascii')as stream:raw=stream.read(8193)
 need(len(raw)<=8192 and raw.rsplit(') ',1)[1].split()[19]==start,'LEASE_PROCESS_REUSED')
def checked_root():
 for path in (ROOT,*ROOT.parents):
  info=path.lstat()
  need(stat.S_ISDIR(info.st_mode) and not path.is_symlink() and info.st_uid==info.st_gid==0
       and not stat.S_IMODE(info.st_mode)&0o022,'EXACT_ROOT_PATH_REQUIRED')
 need(stat.S_IMODE(ROOT.lstat().st_mode)==0o755,'EXACT_RELEASE_ROOT0755_REQUIRED')
def unpack(raw):
 need(type(raw)is bytes and len(raw)<=2000000 and sha(raw)==ZIP_SHA,'EXACT_CODE_ONLY_ZIP_REQUIRED')
 with zipfile.ZipFile(io.BytesIO(raw))as archive:
  infos=archive.infolist()
  need(len(infos)==6 and {row.filename for row in infos}==set(PINS) and not any(row.is_dir()for row in infos),'CLOSED_SIX_CODE_FILES_REQUIRED')
  need(all(row.file_size==PINS[row.filename]['bytes'] and row.file_size<=1048576 for row in infos)
       and sum(row.file_size for row in infos)<=2000000,'BOUNDED_CLOSED_CODE_FILES_REQUIRED')
  files={name:archive.read(name)for name in PINS}
 need(all(len(raw)==PINS[name]['bytes'] and sha(raw)==PINS[name]['sha256']for name,raw in files.items()),'EXACT_REVIEWED_SIX_BYTES_REQUIRED')
 need(sha(files['COPY_ONLY_MANIFEST.json'])==MANIFEST_SHA,'EXACT_COPY_R10_MANIFEST_REQUIRED')
 manifest=json.loads(files['COPY_ONLY_MANIFEST.json'])
 need(set(manifest)=={'schema','namespace','status','runtimeAuthorization','fullGuardAccepted','liveApplyEnabled','files'}
      and manifest['schema']==1 and manifest['namespace']==NAMESPACE and manifest['status']=='CODE_ONLY_NOT_RUNTIME_AUTHORIZATION'
      and manifest['runtimeAuthorization']is False and manifest['fullGuardAccepted']is False and manifest['liveApplyEnabled']is False,
      'COPY_ONLY_MANIFEST_NOT_AUTHORIZATION_REQUIRED')
 need(manifest['files']=={name:row for name,row in PINS.items()if name!='COPY_ONLY_MANIFEST.json'},'CLOSED_MANIFEST_CONTENTS_REQUIRED')
 return files
def readback(path,raw,private=True):
 info=path.lstat()
 need(stat.S_ISREG(info.st_mode) and not path.is_symlink() and info.st_nlink==1,'SINGLE_REGULAR_CODE_FILE_REQUIRED')
 if private:need(info.st_uid==info.st_gid==0 and stat.S_IMODE(info.st_mode)==0o600,'ROOT_PRIVATE_CODE0600_REQUIRED')
 fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
 with os.fdopen(fd,'rb')as stream:
  before=os.fstat(stream.fileno());seen=stream.read(len(raw)+1);after=os.fstat(stream.fileno())
 final=path.lstat();fields=('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns')
 if os.name=='posix':fields+=('st_ctime_ns',)
 need(seen==raw and all(getattr(info,k)==getattr(before,k)==getattr(after,k)==getattr(final,k)for k in fields),'CODE_READBACK_OR_IDENTITY_CHANGED')
def write_new_files(code,files,lease,private=True):
 # Tests may inspect raw file I/O on Windows with private=False. The sole CLI
 # call below always uses the native root/700/600 checks and private=True.
 need(not os.path.lexists(code),'EXISTING_CODE_STAGE_NO_REPLAY')
 lease();code.mkdir(mode=0o700)
 if private:
  info=code.lstat();need(info.st_uid==info.st_gid==0 and not code.is_symlink() and stat.S_IMODE(info.st_mode)==0o700,'ROOT_PRIVATE_CODE_DIRECTORY0700_REQUIRED')
 for name,raw in files.items():
  need(Path(name).name==name and name in PINS,'CLOSED_CODE_BASENAME_REQUIRED')
  lease();fd=os.open(code/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
  with os.fdopen(fd,'wb')as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
  readback(code/name,raw,private=private)
 need({path.name for path in code.iterdir()}==set(PINS),'STAGED_CLOSED_SIX_FILES_REQUIRED')
 for name,raw in files.items():readback(code/name,raw,private=private)
 if private:
  fd=os.open(code,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  try:os.fsync(fd)
  finally:os.close(fd)
 lease()
def main():
 parser=argparse.ArgumentParser(description='Stage code only; never prepare or apply')
 parser.add_argument('--stage-code-only',action='store_true');parser.add_argument('--commit',required=True)
 parser.add_argument('--lease-pid',required=True,type=int);parser.add_argument('--lease-start-ticks',required=True)
 args=parser.parse_args();need(args.stage_code_only is True,'EXPLICIT_STAGE_CODE_ONLY_REQUIRED')
 checked_inputs(args.commit,args.lease_pid,args.lease_start_ticks)
 need(os.name=='posix' and os.geteuid()==os.getegid()==0,'EXACT_POSIX_ROOT_REQUIRED')
 checked_root();need(not os.path.lexists(CODE),'EXISTING_CODE_STAGE_NO_REPLAY')
 lease=lambda:held_lease(args.lease_pid,args.lease_start_ticks)
 lease();url=URL_PREFIX+args.commit+'/'+PUBLIC_NAMESPACE+'/code-only.zip'
 with urllib.request.urlopen(url,timeout=30)as response:
  need(response.status==200 and response.geturl()==url,'EXACT_IMMUTABLE_CODE_RESPONSE_REQUIRED');raw=response.read(2000001)
 files=unpack(raw);lease();checked_root();write_new_files(CODE,files,lease)
 print(json.dumps({'status':'COPY_R10_CODE_STAGED_NOT_RUNTIME_AUTHORIZATION','codeFiles':6,'manifestSha256':MANIFEST_SHA,
  'directory':str(CODE),'runtimeAuthorization':False,'prepared':False,'liveDatabaseWrites':0,'liveApplyEnabled':False}))
if __name__=='__main__':
 try:main()
 except BaseException as error:
  code=str(error)if type(error)is ValueError and re.fullmatch('[A-Z][A-Z0-9_]{0,120}',str(error))else'STAGE_REFUSED_OR_UNKNOWN_NO_REPLAY'
  print(json.dumps({'status':'CODE_STAGE_REFUSED_OR_UNKNOWN_NO_REPLAY','code':code,'runtimeAuthorization':False,'liveDatabaseWrites':0,'prepared':False}));raise SystemExit(2)
