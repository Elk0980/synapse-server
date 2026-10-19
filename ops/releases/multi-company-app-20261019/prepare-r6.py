import hashlib,io,json,os,re,stat,sys,urllib.request,zipfile
from pathlib import Path,PurePosixPath
CODE=Path('/opt/synapse/releases/palitra-app-20261015/multi-company-app-20261019-r6-code')
ZIP_SHA='a3857093c2214bcb91b891c32f0732111a3805f3618b4f6ef9be94e7a2275a33'
EXPECTED={'company-app.py': {'sha256': '4ede44bf6a222fab53a2810e456bb69926b865ab20871006aac906ae48c81a80', 'bytes': 928}, 'payload/MANIFEST.json': {'sha256': '0157a28111ea0056422c3143d2c886805d69716d9fb5cc6332ecd09b31ecefd2', 'bytes': 1792}, 'payload/product/cabinet.html': {'sha256': 'f1d5b19b43a04b7a4a5406acab2e084b92efc1a972208cefc90e1f899c83ef07', 'bytes': 2501}, 'payload/product/company-context.js': {'sha256': '5093ff654e8075ee6314e9bfb427cdf33b50219bbb6b3c53f911d6ef8488285a', 'bytes': 14578}, 'payload/product/shell.css': {'sha256': '4a527e43b68f535e7e95e069e487a96662921eb3f1f2f2b8afa91506d47d4dab', 'bytes': 59045}, 'payload/product/shell.js': {'sha256': '4a60c210c5dbe71de4e703f34378e4c9609563ee2bcdf4e099990c965c99fa03', 'bytes': 267644}, 'PRODUCT_MANIFEST.json': {'sha256': 'a1de0f7e85daec66fa9f5a9b24126e2d2b65b3b96305f3b09028c74c67d969cf', 'bytes': 9725}, 'PRODUCT_REVIEW.json': {'sha256': 'f7a255a6c3b2ba4a59195a7634cccb6de42bd049003fedd567edcbd761fe7fa6', 'bytes': 4232}, 'release-native.py': {'sha256': '1f4b048551ba20309e129212a269ed53765cd99997802ee2b16d6985cfc46de0', 'bytes': 37809}, 'report-db.py': {'sha256': '08456dc9fcfae875b22c631a461e0cedea5a702b5f8d43ae770de7cff6e78a63', 'bytes': 7626}, 'ROLLBACK.md': {'sha256': 'f46d264fd3991454286c54253b7c581f8f9c018445473530c97fe377f1fd82ce', 'bytes': 5861}}
def need(v,c):
 if not v:raise ValueError(c)
def main():
 try:
  need(os.name=='posix' and os.geteuid()==0,'EXACT_ROOT_REQUIRED')
  need(len(sys.argv)==2 and re.fullmatch(r'https://raw[.]githubusercontent[.]com/Elk0980/synapse-server/[0-9a-f]{40}/ops/releases/multi-company-app-20261019/code-r6[.]zip',sys.argv[1]),'EXACT_IMMUTABLE_URL_REQUIRED')
  for p in [*reversed(CODE.parents),CODE]:need(not p.is_symlink(),'CODE_SYMLINK_REFUSED')
  need(CODE.parent.is_dir() and CODE.parent.stat().st_uid==0 and not os.path.lexists(CODE),'NEW_CODE_NAMESPACE_REQUIRED_NO_RETRY')
  with urllib.request.urlopen(sys.argv[1],timeout=30) as response:raw=response.read(2*1024*1024+1)
  need(len(raw)<=2*1024*1024 and hashlib.sha256(raw).hexdigest()==ZIP_SHA,'EXACT_CODE_ARCHIVE_REQUIRED')
  z=zipfile.ZipFile(io.BytesIO(raw));names=z.namelist();need(len(names)==len(set(names))==11 and set(names)==set(EXPECTED),'CLOSED_CODE_PACKET_REQUIRED')
  bodies={}
  for info in z.infolist():
   name=info.filename;p=PurePosixPath(name);need(not p.is_absolute() and p.as_posix()==name and '..' not in p.parts and stat.S_IFMT(info.external_attr>>16) in (0,stat.S_IFREG) and not info.flag_bits&1,'REGULAR_CODE_MEMBER_REQUIRED')
   need(info.file_size==EXPECTED[name]['bytes'] and info.file_size<=2*1024*1024,'BOUNDED_CODE_MEMBER_REQUIRED')
   data=z.read(info);need(hashlib.sha256(data).hexdigest()==EXPECTED[name]['sha256'],'CODE_MEMBER_CHANGED');bodies[name]=data
  need(sum(map(len,bodies.values()))<=4*1024*1024,'BOUNDED_CODE_PACKET_REQUIRED')
  os.umask(0o077);CODE.mkdir(mode=0o700)
  for name in sorted(bodies):
   dest=CODE/name;need(dest.is_relative_to(CODE),'CODE_BOUNDARY_REQUIRED')
   dest.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
   for p in [*dest.parents,dest]:need(not p.is_symlink(),'CODE_PARENT_SYMLINK_REFUSED')
   fd=os.open(dest,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
   with os.fdopen(fd,'wb') as f:f.write(bodies[name]);f.flush();os.fsync(f.fileno())
  print(json.dumps({'status':'EXACT_CODE_PACKET_STAGED_NOT_APPLIED','files':len(bodies),'runtimeWrites':0,'dbWrites':0}));return 0
 except Exception as e:
  print(json.dumps({'status':'REFUSED_OR_PARTIAL_STAGE_NO_RETRY','messageSha256':hashlib.sha256(str(e).encode()).hexdigest(),'runtimeWrites':0,'dbWrites':0}));return 2
if __name__=='__main__':sys.exit(main())
