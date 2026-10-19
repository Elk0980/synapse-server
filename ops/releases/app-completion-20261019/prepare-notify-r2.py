import hashlib,io,json,os,re,stat,sys,urllib.request,zipfile
from pathlib import Path,PurePosixPath
CODE=Path('/opt/synapse/releases/palitra-app-20261015/palitra-notify-update-20261020-r2-code')
ZIP_SHA='1d6b0596329094dd6af4af85f9cafd458710828aec810ec691cd75b638f0a8e9'
EXPECTED={'company-app.py': {'sha256': '15c16be0e3d132fdc0416cb8fdec6175d12b1c828fbddc5b2243d2c6c71b75a1', 'bytes': 1007}, 'content-db.py': {'sha256': 'd6363b217d69a49751d875b00cf50776593d01160b386190edaac8bf537ab4be', 'bytes': 7788}, 'GROUP_REVIEW.json': {'sha256': '222ba812eb92208765368f24966e85ca8217081ae8ef8ca9dd606e325b2c6b22', 'bytes': 2331}, 'managed-source-probe.cjs': {'sha256': '6adf008d2a6016031b6ad6812c3550a557694293a9a855a92cfb64e6c964ca6f', 'bytes': 6956}, 'managed-source.py': {'sha256': 'b01bf2eb4d3b943a79855bccec858ea11b8f6aa57b400cf6f252c3b35c4c079e', 'bytes': 5256}, 'MAP_OUTCOME.json': {'sha256': '7c206110ddb478f1be1221e689ea346e125b9e438096b59af39a7eb84ebc2c42', 'bytes': 7473}, 'payload/backend/server.js': {'sha256': '1d07040b2c01f2e3ade56a59bb681f6858e29f950d642c69a2d552c30c18a876', 'bytes': 125763}, 'payload/MANIFEST.json': {'sha256': 'd321b06a1c30296179e6097739200a56a8d3208f4dfc34d40eaa1a387621b707', 'bytes': 1793}, 'payload/product/cabinet.html': {'sha256': '65934139f9dfaf9ff6b3dc10dd92d7e7c9b779f74a99b987705297b17fd11d9c', 'bytes': 2529}, 'payload/product/shell.css': {'sha256': '35e5ecaaca56b9f01db6b8dddcc6bef088c795acd4d0f46d83effbc1a0837fc7', 'bytes': 59669}, 'payload/product/shell.js': {'sha256': 'c2e7301808f82a41bf4a5d94964ebc4ce07a97242455f14284e278a39c553be1', 'bytes': 270629}, 'PRODUCT_MANIFEST.json': {'sha256': 'c84380de6b63755451c9f1409c910579bca1adbd8a72383d8a0b4b5c6fd1b838', 'bytes': 13010}, 'PRODUCT_REVIEW.json': {'sha256': '2bda32551047b6d952e20042004d6e1d6e69b9aca778cf61e4412066c33c6840', 'bytes': 3508}, 'release-native.py': {'sha256': '0e2a1f5487cb62578846d55f8d91bd2a9869afb8dca8f927bea0df5e7b9e9016', 'bytes': 51508}, 'report-db.py': {'sha256': '08456dc9fcfae875b22c631a461e0cedea5a702b5f8d43ae770de7cff6e78a63', 'bytes': 7626}, 'rollback-plan.py': {'sha256': '1eb4898d8f982825b85707f87b6bd6a5531f45442185b060697d9872b3b13aa8', 'bytes': 2532}, 'ROLLBACK.md': {'sha256': '3c225c8945d79af8cd78922a3d9c2db18ff74c7c8910e233f16eda2e87020879', 'bytes': 3742}, 'traffic-db.py': {'sha256': '2b44578d7b7fee9d779fe647c6d3b56eb5aa9d377f89b68f5aaed7230ca1127f', 'bytes': 12391}}

def need(v,c):
 if not v:raise ValueError(c)
def main():
 try:
  need(os.name=='posix' and os.geteuid()==0,'EXACT_ROOT_REQUIRED')
  need(len(sys.argv)==2 and re.fullmatch(r'https://raw[.]githubusercontent[.]com/elk0980/synapse-server/[0-9a-f]{40}/ops/releases/app-completion-20261019/code-notify-r2[.]zip',sys.argv[1]),'EXACT_IMMUTABLE_URL_REQUIRED')
  for p in [*reversed(CODE.parents),CODE]:need(not p.is_symlink(),'CODE_SYMLINK_REFUSED')
  need(CODE.parent.is_dir() and CODE.parent.stat().st_uid==0 and not os.path.lexists(CODE),'NEW_CODE_NAMESPACE_REQUIRED_NO_RETRY')
  with urllib.request.urlopen(sys.argv[1],timeout=30) as response:raw=response.read(2*1024*1024+1)
  need(len(raw)<=2*1024*1024 and hashlib.sha256(raw).hexdigest()==ZIP_SHA,'EXACT_CODE_ARCHIVE_REQUIRED')
  z=zipfile.ZipFile(io.BytesIO(raw));names=z.namelist();need(len(names)==len(set(names))==len(EXPECTED) and set(names)==set(EXPECTED),'CLOSED_CODE_PACKET_REQUIRED')
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
