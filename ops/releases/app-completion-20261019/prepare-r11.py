import hashlib,io,json,os,re,stat,sys,urllib.request,zipfile
from pathlib import Path,PurePosixPath
CODE=Path('/opt/synapse/releases/palitra-app-20261015/multi-company-app-20261019-r11-code')
ZIP_SHA='e0eab365d4fba6b116f4909e924bb655d77a257a9998cdff13ea1df5563c530b'
EXPECTED={'company-app.py': {'sha256': '80511bb3f45d2a15d3e6eda0ad0caf20e0d323633e864eb7559123be604c0cf1', 'bytes': 1004}, 'content-db.py': {'sha256': 'd6363b217d69a49751d875b00cf50776593d01160b386190edaac8bf537ab4be', 'bytes': 7788}, 'managed-source-probe.cjs': {'sha256': '6adf008d2a6016031b6ad6812c3550a557694293a9a855a92cfb64e6c964ca6f', 'bytes': 6956}, 'managed-source.py': {'sha256': 'b01bf2eb4d3b943a79855bccec858ea11b8f6aa57b400cf6f252c3b35c4c079e', 'bytes': 5256}, 'MAP_OUTCOME.json': {'sha256': '7c206110ddb478f1be1221e689ea346e125b9e438096b59af39a7eb84ebc2c42', 'bytes': 7473}, 'payload/backend/company-app/app-entry-http.cjs': {'sha256': '6efe27dbe8f6a98c462957398020be345ec7398e4146f37ecfbe3d5e83c116c3', 'bytes': 5651}, 'payload/backend/company-app/app-entry-statistics.cjs': {'sha256': 'b1332a5c5d6b18161a0289d638c36289b9c86a90a922d87c6b9a08d7d351c4b9', 'bytes': 12052}, 'payload/backend/company-app/certificate-receipts.cjs': {'sha256': 'd5ae1c17385a9627c27f14b14f6d698064ea0184488f9402ed20703bea58b2b6', 'bytes': 4352}, 'payload/backend/company-app/customer-report-aggregates.cjs': {'sha256': '7b914a6a96dedd6351e94d9d1d3bc842fed7b319e07b998f42ad515e41000284', 'bytes': 4065}, 'payload/backend/company-app/customer-report-cache.cjs': {'sha256': '02d5c1f6444f172383ef0528d8fd2796de79b84d3df06bacfb2ce5b9a025d112', 'bytes': 13975}, 'payload/backend/company-app/customer-reports.cjs': {'sha256': '63ae5e28213c9b076ba29db455d11604650b9ad2c821d8db469eb7db720dc019', 'bytes': 12881}, 'payload/backend/company-app/runtime.cjs': {'sha256': '3bd87549205eaae728233cf63e4c1fd9d8d661a95d11ac60a275369ac2e94306', 'bytes': 2445}, 'payload/MANIFEST.json': {'sha256': '480e2a71c7d12d1e9aa8687b82e6e875a766cc41b05f98015d327e6dde938bb7', 'bytes': 4520}, 'payload/product/cabinet.html': {'sha256': 'a8cc85718144caac8a9fe07a6a6e9a06f3a10bc314dabc2111e948f2361a99a4', 'bytes': 2509}, 'payload/product/customer-reports-ui.js': {'sha256': '6187ab61f30951c052a48ce8bb3a0dab529915e4006eb6e87c4e5b4e1602ce0b', 'bytes': 23500}, 'payload/product/native-host.js': {'sha256': '3a5f38167aa8e976c8991d31b778bcc775fa7beb8fe9a1afdef95ab865e3ae41', 'bytes': 17863}, 'payload/product/shell.js': {'sha256': '0a6bda28fa1884073c3957343f92b1e095c7b4e1afef8b4afbeea065ba2191e3', 'bytes': 274381}, 'PRODUCT_MANIFEST.json': {'sha256': '2ea26b700b502f360085c35797e737f88d821d08cd5ee77a1762aede607c5db8', 'bytes': 16725}, 'PRODUCT_REVIEW.json': {'sha256': 'd85c58f92607b7d65bf51a5c86d81390d1a2679f81f58ac137631a54a590058b', 'bytes': 6357}, 'release-native.py': {'sha256': '003a25c904537b48444c2f73ad814e83ab1aa36522ae2bcea55c891c19a2bc46', 'bytes': 53017}, 'report-db.py': {'sha256': '08456dc9fcfae875b22c631a461e0cedea5a702b5f8d43ae770de7cff6e78a63', 'bytes': 7626}, 'rollback-plan.py': {'sha256': '4df7c6ce718bbd6a3fd1197300b461dd4b9d7c7abdb6bfeddc9653ba669d234d', 'bytes': 1877}, 'ROLLBACK.md': {'sha256': '6d81ef45f0739ca7ad3d81f6be9ff8686ea484251f213abe1993f3255a4bb446', 'bytes': 4283}, 'traffic-db.py': {'sha256': '2b44578d7b7fee9d779fe647c6d3b56eb5aa9d377f89b68f5aaed7230ca1127f', 'bytes': 12391}}

def need(v,c):
 if not v:raise ValueError(c)
def main():
 try:
  need(os.name=='posix' and os.geteuid()==0,'EXACT_ROOT_REQUIRED')
  need(len(sys.argv)==2 and re.fullmatch(r'https://raw[.]githubusercontent[.]com/elk0980/synapse-server/[0-9a-f]{40}/ops/releases/app-completion-20261019/code-r11[.]zip',sys.argv[1]),'EXACT_IMMUTABLE_URL_REQUIRED')
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
