import hashlib,io,json,os,re,stat,sys,urllib.request,zipfile
from pathlib import Path,PurePosixPath
CODE=Path('/opt/synapse/releases/palitra-app-20261015/palitra-manager-workspace-20261020-r1-code')
ZIP_SHA='96ed6dac918fd01960650da18c8e26701492a572f9247941800141681bb50226'
EXPECTED={'company-app.py': {'sha256': 'bd41989b8820b7ff4f264cfaec2b3540b7a2e58f86e0c555e7753fdfbd650f5f', 'bytes': 994}, 'content-db.py': {'sha256': 'd6363b217d69a49751d875b00cf50776593d01160b386190edaac8bf537ab4be', 'bytes': 7788}, 'GROUP_REVIEW.json': {'sha256': '222ba812eb92208765368f24966e85ca8217081ae8ef8ca9dd606e325b2c6b22', 'bytes': 2331}, 'managed-source-probe.cjs': {'sha256': '6adf008d2a6016031b6ad6812c3550a557694293a9a855a92cfb64e6c964ca6f', 'bytes': 6956}, 'managed-source.py': {'sha256': 'b01bf2eb4d3b943a79855bccec858ea11b8f6aa57b400cf6f252c3b35c4c079e', 'bytes': 5256}, 'MAP_OUTCOME.json': {'sha256': '7c206110ddb478f1be1221e689ea346e125b9e438096b59af39a7eb84ebc2c42', 'bytes': 7473}, 'parent-notify-r2.py': {'sha256': '58296305f2ee805f4c390b0676cf8f573ee4d8f3cd9cd6b605c377fb10a71915', 'bytes': 7620}, 'payload/backend/palitra-manager-attention.cjs': {'sha256': '1f21b542f24686a31b481f1d9ef6ba9b65dd0082a6afde699b928fefeca4f6ff', 'bytes': 14385}, 'payload/backend/server.js': {'sha256': 'e88d669adf7451c93f961bc4d284f185faa643ddb3bed9d4b71e50babe5c4842', 'bytes': 125384}, 'payload/MANIFEST.json': {'sha256': '972f57af4039219ee89f4a2e12431add47db23006f1571252d939c314101681a', 'bytes': 2451}, 'payload/product/cabinet.html': {'sha256': '61475f378d3535ddcddc7dfc37fc65e85c938c941c22e297f2c1542199ffb080', 'bytes': 2533}, 'payload/product/native-host.js': {'sha256': '6a6b25d8e219dc1057664fed40017c2927bd23872a4ad06753fb08f9087e8aef', 'bytes': 21987}, 'payload/product/shell.css': {'sha256': '6cf23685027b344cc4f4d32007782facd1775ca52b7cddb08108eb397aca9191', 'bytes': 63603}, 'payload/product/shell.js': {'sha256': '9e91381b701ff7b838be37bec16dcdcc4a4ad8557a7b35676ffa387665c359ac', 'bytes': 290406}, 'payload/product/workflow-ui.js': {'sha256': 'ea9086ff1d14e8c2cf8b2f2af7d405beb301848cab87a0d51cda2efdea397421', 'bytes': 70179}, 'PRODUCT_MANIFEST.json': {'sha256': '0698b0276154ebeaf278537f00085da911860ae71b29006807ccd4e8241162ac', 'bytes': 14499}, 'PRODUCT_REVIEW.json': {'sha256': 'c0122e9d3fbbd745a6eb12e87a4cd1842b617be82adf071c9c56f2c124e9f5d8', 'bytes': 4527}, 'release-native.py': {'sha256': '7409fb40b88a7915f742e33003b89b0ab63ed1734e2f631cbd632a6975c7727d', 'bytes': 56520}, 'report-db.py': {'sha256': '08456dc9fcfae875b22c631a461e0cedea5a702b5f8d43ae770de7cff6e78a63', 'bytes': 7626}, 'rollback-plan.py': {'sha256': '31b98c245f72cc55a0b7891f9b7e0c33017fbcc39b53a9c5fb4a00399f61098a', 'bytes': 2610}, 'ROLLBACK.md': {'sha256': 'b3d05697866d357e1c5c1caecb264ea1739f154114fe2c834624b0a353343e3f', 'bytes': 2361}, 'ROOT_PRODUCT_ACCEPTANCE.json': {'sha256': '6ff651dce44179c12d8ae2f426102fef919ea7cc65db0c237035fc7d7660b053', 'bytes': 1476}, 'traffic-db.py': {'sha256': '2b44578d7b7fee9d779fe647c6d3b56eb5aa9d377f89b68f5aaed7230ca1127f', 'bytes': 12391}}

def need(v,c):
 if not v:raise ValueError(c)
def main():
 try:
  need(os.name=='posix' and os.geteuid()==0,'EXACT_ROOT_REQUIRED')
  need(len(sys.argv)==2 and re.fullmatch(r'https://raw[.]githubusercontent[.]com/elk0980/synapse-server/[0-9a-f]{40}/ops/releases/app-completion-20261019/code-manager-r1[.]zip',sys.argv[1]),'EXACT_IMMUTABLE_URL_REQUIRED')
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
