"""Stage four exact reviewed code files only. No admission/preparation/apply."""
import argparse,hashlib,io,json,os,re,stat,subprocess,urllib.request,zipfile
from pathlib import Path
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
NAMESPACE='palitra-order-cleanup-20261021-r11-5de119ea7e40cd9213adc28a0d6a51ee'
CODE=ROOT/(NAMESPACE+'-code')
LOCK='/opt/synapse/.palitra-app-release.lock'
URL_PREFIX='https://raw.githubusercontent.com/Elk0980/synapse-server/'
PUBLIC_NAMESPACE='ops/palitra-cleanup-live-20261021-r11-5de119ea7e40cd9213adc28a0d6a51ee'
ZIP_SHA='4bd061ebbe0535995a99362d592736035fbd95f31ab28836b052f31a7fcc25a6'
PINS={'live_entry.py': {'bytes': 41649, 'sha256': '8e2c81be05deedef8b4ca16c7b396dbd9a5e190fa42b11c65b7d80102365dc92'}, 'cleanup_runtime.py': {'bytes': 29240, 'sha256': '6bd4b9f29ff1ffd4e553750d43df437444b5651485748e1eeca82163c8259861'}, 'runtime_inspector_adapter.py': {'bytes': 9431, 'sha256': '4c14a6c97d3a4edb02cd5cc238531b2deafadb96ba7c4e34e758e2cdfea1ac5b'}, 'LOCAL_CODE_PINS.json': {'bytes': 4108, 'sha256': 'f92e0147dcb88e66c803d6e9d7aa6859c6c8d4ab4407824142d33c41003dab3b'}}
DEPENDENCIES={'palitra-clear-readonly260-20261021-r6-code': {'capture_managed260.py': '3854d183bb729245ceb5120d3b2a2d853dc6ec4f1d9481741cf93af91c65b6fb', 'collect_runtime.py': 'fbba7c7a32a7407c36626f27586e7796ecebdaf15690deaf4ac41068a53d64b5', 'entry_r1_history.py': '2910e0e74b32af6e19f31ef30af2ee5e78ce6081e1d079b64596cafdb8cb25cb', 'evidence_validator.py': '37d16b054aa3b80b99f53b06c3ce15afc3cd4c4966a7a22c3847bb3e0b2d5379', 'fast-managed260.cjs': '2e4f023ad698316decafe4d93f8c6c51c297b97cbd9044d5ffed609069bd723b', 'incremental-manifest.json': '8894c2f449b18698848e5e3f60d973ba64e307316a2b3adc630336601c95c853', 'inspect_readonly.py': '8a283418d98c9ea4fd7675e1d0d13d760c08245ef9040a5b009154807c19a867', 'literal_history.py': 'debe707d371da1a274101636a62b9c28b87b6c637d89d01608250101f73858a4', 'managed260-probe.cjs': '146732c590b3eb2fe45071c506fcef3798400868d5d2a4adaedad600f7a1d855', 'read_primitives.json': '81b2a1bcf492c1ccebdb6910b5e5b5e8e1ab3ec63bca57b4b121666168a45ef3', 'readonly_entry.py': 'e11c298545d268fe544b7251f23998ef842a1c4d776ec1f7f2025cfb5de5baf8', 'safe_primitives.py': '13f44a34e54d24585be67518e291e930275a1e87dcf292c48e95295e030df828', 'static_closure.py': '273c0d4fd49f366adf77893376619066e83be6f5d86c5f91250b3e7c35bebcbf', 'storage_seals.py': '6db80ce5488bfa466227213bd17253169bb6e50921350d9df5aaa24f997613da', 'readonly-code-pins.json': '7de083ac3cf4b39c352ed7b3c60d35e447480f0ab836915d2c87482ef8125c09'}, 'palitra-order-cleanup-copy-20261021-r10-code': {'COPY_ONLY_MANIFEST.json': 'cc30b814fa4ec3fc9391d6114ee118bd7afe8639d34829db88f8bdebc1b3aaef', 'LOCAL_CODE_PINS.json': '556cff84fb6c8aff6ee00e3f77c903588f7cd29e217bc11d43ebde3a5c377b85', 'cleanup_runtime.py': '6bd4b9f29ff1ffd4e553750d43df437444b5651485748e1eeca82163c8259861', 'copy_prepare.py': '8d96092beec7779de66eba919f6beb95c8bef42b173c4a0ed7db6c69d5dbb748', 'live_entry.py': '16600560cef5f63f6e799113cebafff2164b3e765472bc4d46c1bdfc8c656935', 'prepare_preview.py': '69197d0c9e14cd794a9c5e4c45d81f20c49084cea5183cd8192b3a7ca9df5284'}}
COPY_AREA='/opt/synapse/releases/palitra-app-20261015/palitra-order-cleanup-copy-20261021-r10-5de119ea7e40cd9213adc28a0d6a51ee'
EXPECTED_LOCAL_PINS={'schema': 2, 'status': 'LOCAL_STAGED_CODE_ONLY_NOT_RUNTIME_AUTHORIZATION', 'originalCleanupSha256': '5e023ee3c3cf0b4daafde6b31688c3dcff39a7a8cfa5cd967842eadc7ff16f75', 'engineSha256': '6bd4b9f29ff1ffd4e553750d43df437444b5651485748e1eeca82163c8259861', 'guardName': 'palitra-clear-orders-guard-20261020-r1', 'guardEntrySha256': '283e6211887e7b50d4aa134a97d86de04d160f818fff0284a722de692aa20e9c', 'guardManifestSha256': '86abb1a09c3244fe58cd7dceca40faf379c7d058a22c71e78fb543056d7c5282', 'guardSourcePins': {'palitra-orders-public/cabinet.html': '91277f53ec62bd700395d53f26a494c25ed8238f87b8973d647f96ab881a9187', 'palitra-orders-public/shell.js': '60502c40ecfb7a5f75972b7a841a197fb75b372fba76ade072cef9d3db5f9e4b', 'palitra-orders-public/shop.html': '862f294019ed0033c4daf70283654f6df895fe7cb203cbfb93d03de35e9f095b', 'server.js': 'd1e0a83cfc23a5cf6558a1023438257240e78fc9c4c997c49f0ca23e36da093f', 'site-orders.js': '4826cc1d35bc0ac5216ab765f8dde31bb91ca96b935d5aee01537724eff6ef94'}, 'guardReceiptSha256': '34ce6389ef04a5db158d5b1a27734e2d09c919df28b35a9dad4561af48d42892', 'guardImage': 'sha256:951db09e9e6c4781350bbced7e7a9e4ef099077a368e38a6b1fac40e0a4a6a22', 'successor': 'LIVE_ENTRY_R11', 'inspectorAdapterSha256': '4c14a6c97d3a4edb02cd5cc238531b2deafadb96ba7c4e34e758e2cdfea1ac5b', 'inspector': {'enabled': True, 'manifestPath': '/opt/synapse/releases/palitra-app-20261015/palitra-clear-readonly260-20261021-r6-code/readonly-code-pins.json', 'manifestSha256': '7de083ac3cf4b39c352ed7b3c60d35e447480f0ab836915d2c87482ef8125c09', 'entryPath': '/opt/synapse/releases/palitra-app-20261015/palitra-clear-readonly260-20261021-r6-code/readonly_entry.py', 'entrySha256': 'e11c298545d268fe544b7251f23998ef842a1c4d776ec1f7f2025cfb5de5baf8', 'files': {'capture_managed260.py': '3854d183bb729245ceb5120d3b2a2d853dc6ec4f1d9481741cf93af91c65b6fb', 'collect_runtime.py': 'fbba7c7a32a7407c36626f27586e7796ecebdaf15690deaf4ac41068a53d64b5', 'entry_r1_history.py': '2910e0e74b32af6e19f31ef30af2ee5e78ce6081e1d079b64596cafdb8cb25cb', 'evidence_validator.py': '37d16b054aa3b80b99f53b06c3ce15afc3cd4c4966a7a22c3847bb3e0b2d5379', 'fast-managed260.cjs': '2e4f023ad698316decafe4d93f8c6c51c297b97cbd9044d5ffed609069bd723b', 'incremental-manifest.json': '8894c2f449b18698848e5e3f60d973ba64e307316a2b3adc630336601c95c853', 'inspect_readonly.py': '8a283418d98c9ea4fd7675e1d0d13d760c08245ef9040a5b009154807c19a867', 'literal_history.py': 'debe707d371da1a274101636a62b9c28b87b6c637d89d01608250101f73858a4', 'managed260-probe.cjs': '146732c590b3eb2fe45071c506fcef3798400868d5d2a4adaedad600f7a1d855', 'read_primitives.json': '81b2a1bcf492c1ccebdb6910b5e5b5e8e1ab3ec63bca57b4b121666168a45ef3', 'readonly_entry.py': 'e11c298545d268fe544b7251f23998ef842a1c4d776ec1f7f2025cfb5de5baf8', 'safe_primitives.py': '13f44a34e54d24585be67518e291e930275a1e87dcf292c48e95295e030df828', 'static_closure.py': '273c0d4fd49f366adf77893376619066e83be6f5d86c5f91250b3e7c35bebcbf', 'storage_seals.py': '6db80ce5488bfa466227213bd17253169bb6e50921350d9df5aaa24f997613da'}}, 'copyPreparation': {'namespace': 'palitra-order-cleanup-copy-20261021-r10', 'manifestSha256': 'cc30b814fa4ec3fc9391d6114ee118bd7afe8639d34829db88f8bdebc1b3aaef', 'files': {'COPY_ONLY_MANIFEST.json': 'cc30b814fa4ec3fc9391d6114ee118bd7afe8639d34829db88f8bdebc1b3aaef', 'LOCAL_CODE_PINS.json': '556cff84fb6c8aff6ee00e3f77c903588f7cd29e217bc11d43ebde3a5c377b85', 'cleanup_runtime.py': '6bd4b9f29ff1ffd4e553750d43df437444b5651485748e1eeca82163c8259861', 'copy_prepare.py': '8d96092beec7779de66eba919f6beb95c8bef42b173c4a0ed7db6c69d5dbb748', 'live_entry.py': '16600560cef5f63f6e799113cebafff2164b3e765472bc4d46c1bdfc8c656935', 'prepare_preview.py': '69197d0c9e14cd794a9c5e4c45d81f20c49084cea5183cd8192b3a7ca9df5284'}, 'privateArea': '/opt/synapse/releases/palitra-app-20261015/palitra-order-cleanup-copy-20261021-r10-5de119ea7e40cd9213adc28a0d6a51ee'}}
RELEASED=(3284416,3308227,3336085,3367042,3401855,3462715,3471272,3471456,3471638)
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
  need(len(infos)==4 and {row.filename for row in infos}==set(PINS) and not any(row.is_dir()for row in infos),'CLOSED_FOUR_CODE_FILES_REQUIRED')
  need(all(row.file_size==PINS[row.filename]['bytes'] and row.file_size<=1048576 for row in infos)
       and sum(row.file_size for row in infos)<=2000000,'BOUNDED_CLOSED_CODE_FILES_REQUIRED')
  files={name:archive.read(name)for name in PINS}
 need(all(len(value)==PINS[name]['bytes'] and sha(value)==PINS[name]['sha256']for name,value in files.items()),'EXACT_REVIEWED_FOUR_BYTES_REQUIRED')
 need(set(files)=={'live_entry.py','cleanup_runtime.py','runtime_inspector_adapter.py','LOCAL_CODE_PINS.json'}
      and json.loads(files['LOCAL_CODE_PINS.json'])==EXPECTED_LOCAL_PINS,'EXACT_REVIEWED_ACTIVATED_PINS_REQUIRED')
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
def dependency_guard(private=True):
 # No business data/proofs are opened: exactly15 inspector-code +6 copy-code.
 for name,pins in DEPENDENCIES.items():
  directory=ROOT/name;s=directory.lstat()
  need(directory.parent==ROOT and not directory.is_symlink() and stat.S_ISDIR(s.st_mode),'EXACT_DEPENDENCY_DIRECTORY_REQUIRED')
  if private:need(s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o700,'ROOT700_DEPENDENCY_DIRECTORY_REQUIRED')
  need({p.name for p in directory.iterdir()}==set(pins),'CLOSED_DEPENDENCY_CODE_REQUIRED')
  for filename,pin in pins.items():
   need(Path(filename).name==filename,'DEPENDENCY_BASENAME_REQUIRED');path=directory/filename;info=path.lstat()
   need(not path.is_symlink() and stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_size<=4194304,'BOUNDED_REGULAR_DEPENDENCY_CODE_REQUIRED')
   raw=path.read_bytes();need(sha(raw)==pin,'EXACT_STAGED_DEPENDENCY_SHA_REQUIRED');readback(path,raw,private)
  z=directory.lstat();need((s.st_dev,s.st_ino,s.st_uid,s.st_gid,s.st_mode)==(z.st_dev,z.st_ino,z.st_uid,z.st_gid,z.st_mode)
                          and {p.name for p in directory.iterdir()}==set(pins),'DEPENDENCY_DIRECTORY_CHANGED')
 area=Path(COPY_AREA);s=area.lstat()
 need(area.parent==ROOT and not area.is_symlink() and stat.S_ISDIR(s.st_mode),'EXACT_COPY_AREA_DIRECTORY_REQUIRED')
 if private:need(s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o700,'ROOT700_COPY_AREA_DIRECTORY_REQUIRED')
def write_new_files(code,files,lease,private=True):
 # Windows tests exercise local EXCL I/O with private=False. CLI always true.
 need(not os.path.lexists(code),'EXISTING_CODE_STAGE_NO_REPLAY')
 lease();code.mkdir(mode=0o700)
 if private:
  info=code.lstat();need(info.st_uid==info.st_gid==0 and not code.is_symlink() and stat.S_IMODE(info.st_mode)==0o700,'ROOT_PRIVATE_CODE_DIRECTORY0700_REQUIRED')
 for name,raw in files.items():
  need(Path(name).name==name and name in PINS,'CLOSED_CODE_BASENAME_REQUIRED')
  lease();fd=os.open(code/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
  with os.fdopen(fd,'wb')as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
  readback(code/name,raw,private=private)
 need({path.name for path in code.iterdir()}==set(PINS),'STAGED_CLOSED_FOUR_FILES_REQUIRED')
 for name,raw in files.items():readback(code/name,raw,private=private)
 if private:
  fd=os.open(code,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  try:os.fsync(fd)
  finally:os.close(fd)
 lease()
def main():
 parser=argparse.ArgumentParser(description='Stage reviewed code only; no admission or apply')
 parser.add_argument('--stage-code-only',action='store_true');parser.add_argument('--commit',required=True)
 parser.add_argument('--lease-pid',required=True,type=int);parser.add_argument('--lease-start-ticks',required=True)
 args=parser.parse_args();need(args.stage_code_only is True,'EXPLICIT_STAGE_CODE_ONLY_REQUIRED')
 checked_inputs(args.commit,args.lease_pid,args.lease_start_ticks)
 need(os.name=='posix' and os.geteuid()==os.getegid()==0,'EXACT_POSIX_ROOT_REQUIRED')
 checked_root();need(not os.path.lexists(CODE),'EXISTING_CODE_STAGE_NO_REPLAY')
 lease=lambda:held_lease(args.lease_pid,args.lease_start_ticks)
 lease();dependency_guard();lease();url=URL_PREFIX+args.commit+'/'+PUBLIC_NAMESPACE+'/code-only.zip'
 with urllib.request.urlopen(url,timeout=30)as response:
  need(response.status==200 and response.geturl()==url,'EXACT_IMMUTABLE_CODE_RESPONSE_REQUIRED');raw=response.read(2000001)
 files=unpack(raw);lease();checked_root();dependency_guard();write_new_files(CODE,files,lease);dependency_guard();lease()
 print(json.dumps({'status':'LIVE_R11_CODE_STAGED_NOT_RUNTIME_AUTHORIZATION','codeFiles':4,'namespace':NAMESPACE,
  'directory':str(CODE),'runtimeAuthorization':False,'approvalProvided':False,'liveDatabaseWrites':0,'applyPerformed':False}))
if __name__=='__main__':
 try:main()
 except BaseException as error:
  code=str(error)if type(error)is ValueError and re.fullmatch('[A-Z][A-Z0-9_]{0,120}',str(error))else'STAGE_REFUSED_OR_UNKNOWN_NO_REPLAY'
  print(json.dumps({'status':'CODE_STAGE_REFUSED_OR_UNKNOWN_NO_REPLAY','code':code,'runtimeAuthorization':False,'liveDatabaseWrites':0,'applyPerformed':False}));raise SystemExit(2)
