import hashlib,io,json,os,re,stat,sys,urllib.request,zipfile
from pathlib import Path,PurePosixPath
CODE=Path('/opt/synapse/releases/palitra-app-20261015/multi-company-app-20261019-r5-code')
ZIP_SHA='3ba82a1a320b051988cc4b83ce9c953c58a7dc4e9c9832e3827d2ad39c9abf6c'
EXPECTED={'company-app.py': {'sha256': '67628c441bdf3e9627c0ac3a139cd60e8196c9292b6d4131056842e79396e247', 'bytes': 928}, 'payload/MANIFEST.json': {'sha256': '2ddecd2cfa48faf96c0bf9ff20291c941549d6f11e7ebbd671138441b5f47885', 'bytes': 1807}, 'payload/product/cabinet.html': {'sha256': 'd15189623930442674245d12418c232feed90b7dfc7c259084300d24868ebdd3', 'bytes': 2461}, 'payload/product/company-context.js': {'sha256': 'ce507fba3dbe665f0f82de42d47c81b9d97fda29bfc290b36d7fc7b60f3477a5', 'bytes': 10604}, 'payload/product/shell.js': {'sha256': 'dfb1e7e0b89fc0c25ff4366c074e808556fc06acf41daef35879d587403f39fc', 'bytes': 264342}, 'payload/product/workflow-ui.js': {'sha256': '972bb6e141f8bf5dbf30a5b68b3e3d58fd19519cb9caeaf0a725b7628d5585b8', 'bytes': 66968}, 'PRODUCT_MANIFEST.json': {'sha256': 'f3a6f6a51143e21acd99d6242bff860e071ef16aff6d6a4022e1eb3c38de5e80', 'bytes': 9732}, 'PRODUCT_REVIEW.json': {'sha256': 'dcc6b40c2762f167db9096c0ab5b82e1e2cb2667fed02cd41e0c6e02b8852202', 'bytes': 4052}, 'release-native.py': {'sha256': 'b9108632e8f1d1cba15a6f0749c7b31642b1e12d4dd41b8b9aa9eb830b2848bd', 'bytes': 38109}, 'report-db.py': {'sha256': '08456dc9fcfae875b22c631a461e0cedea5a702b5f8d43ae770de7cff6e78a63', 'bytes': 7626}, 'ROLLBACK.md': {'sha256': '556ad6492ccaf650b8eddd703c189a4f5950a089dcd5303452864a7a281bbdfe', 'bytes': 7670}}
def need(v,c):
 if not v:raise ValueError(c)
def main():
 try:
  need(os.name=='posix' and os.geteuid()==0,'EXACT_ROOT_REQUIRED')
  need(len(sys.argv)==2 and re.fullmatch(r'https://raw[.]githubusercontent[.]com/Elk0980/synapse-server/[0-9a-f]{40}/ops/releases/multi-company-app-20261019/code-r5[.]zip',sys.argv[1]),'EXACT_IMMUTABLE_URL_REQUIRED')
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
