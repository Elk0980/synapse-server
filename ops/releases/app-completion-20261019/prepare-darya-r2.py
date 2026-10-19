"""Exact frozen R2 stage helper; Root review required before publication/use. No automatic retry."""
TRANSPORT_READY=True
import hashlib,io,json,os,re,stat,sys,urllib.request,zipfile
from pathlib import Path,PurePosixPath
CODE=Path('/opt/synapse/releases/palitra-app-20261015/palitra-darya-workspace-20261020-r2-code')
ZIP_SHA='bfc0dffb9f1953d6aac40952b8ca71b97099c4c6b108d05d8a85ff0caaaee201'
EXPECTED={'company-app.py': {'sha256': '9f525765313b1fa8d92bbde5815de8b02f1877dd22896cc0e04bc10a3c155e24', 'bytes': 994}, 'content-db.py': {'sha256': 'd6363b217d69a49751d875b00cf50776593d01160b386190edaac8bf537ab4be', 'bytes': 7788}, 'GROUP_REVIEW.json': {'sha256': '222ba812eb92208765368f24966e85ca8217081ae8ef8ca9dd606e325b2c6b22', 'bytes': 2331}, 'managed-source-probe.cjs': {'sha256': '6adf008d2a6016031b6ad6812c3550a557694293a9a855a92cfb64e6c964ca6f', 'bytes': 6956}, 'managed-source.py': {'sha256': 'b01bf2eb4d3b943a79855bccec858ea11b8f6aa57b400cf6f252c3b35c4c079e', 'bytes': 5256}, 'MAP_OUTCOME.json': {'sha256': '7c206110ddb478f1be1221e689ea346e125b9e438096b59af39a7eb84ebc2c42', 'bytes': 7473}, 'nebo-basis-v5.py': {'sha256': '601c6b8925dbb761465f3072cebb041731b40bb50420394a02df936c6016389c', 'bytes': 19109}, 'parent-notify-r2.py': {'sha256': '58296305f2ee805f4c390b0676cf8f573ee4d8f3cd9cd6b605c377fb10a71915', 'bytes': 7620}, 'payload/backend/palitra-manager-attention.cjs': {'sha256': '63e17f5e1f758446e43f691f42869ed479b8a658e67ab5b908403bebb1360611', 'bytes': 14606}, 'payload/backend/palitra-response-report.cjs': {'sha256': '62ffa4bc34e041b906a06e5abb0b017c47bdc3fae975479c81307dd8d81e29f2', 'bytes': 12662}, 'payload/backend/palitra-workflow.cjs': {'sha256': '36f7cb0f56e0058022be0815afc251f5ce96f874905dffbe783cffeb5264f112', 'bytes': 32186}, 'payload/backend/server.js': {'sha256': 'c15bec303ac328bde1b7577e93d425b81f4637e2a2f4488be255b64b72bf0404', 'bytes': 129308}, 'payload/MANIFEST.json': {'sha256': '5b1fd2fe0e8354cdef1f6273c061b6bb74134efe2713c1610a54dc00d716e9b2', 'bytes': 4343}, 'payload/product/cabinet.html': {'sha256': 'a668c0c5392c9c0caa642ed42facd95384523a257a610c5323703e4fbb6bdd02', 'bytes': 2733}, 'payload/product/native-host.js': {'sha256': 'ace79570defa7feaf491d3b59a37718dee847b4436e614cf71a41ee0d78bbdf1', 'bytes': 32319}, 'payload/product/palitra-content-tasks-ui.js': {'sha256': 'd16fb528869644c0f97ac790340bd64a6b9079f1a9562c58f220b277263a11fc', 'bytes': 8964}, 'payload/product/palitra-response-report-ui.js': {'sha256': '2670a5fa7f35f77a2a7fbc602efa6031b453df939d2171d84dc02b7efa8c4961', 'bytes': 8636}, 'payload/product/shell.css': {'sha256': '4575282b2b0cd3eab10497fc687ed95ac4aece431b73daff710449c0c23f24d6', 'bytes': 66236}, 'payload/product/shell.js': {'sha256': '9e36a2380cfe1c2282e41e79af2b1d04f91f7cf4577d8b7cd505b3a62f5d2f71', 'bytes': 303731}, 'payload/product/workflow-ui.js': {'sha256': '499d626f365f2d4503df0a3732eaacab6919648e1668f2f3d6b451c6945c6720', 'bytes': 73272}, 'PRODUCT_MANIFEST.json': {'sha256': '1f9acbae0840883199822bd8e86e01144407a2cf637f78522ea5b8e141a4a923', 'bytes': 17329}, 'PRODUCT_REVIEW.json': {'sha256': '57467101d22d8b11e93db549144d7fa5360d6cc832af960845079cae99efcc36', 'bytes': 5970}, 'release-native.py': {'sha256': '3ab2d48f02418be290dad21fa9b57ca945c03231523f864ebe8c2d547d31e5c0', 'bytes': 70376}, 'report-db.py': {'sha256': '08456dc9fcfae875b22c631a461e0cedea5a702b5f8d43ae770de7cff6e78a63', 'bytes': 7626}, 'rollback-plan.py': {'sha256': '832f150ea70ee1a9aff70e07f20c42e8453d6873d182979ebd624351b3f2090d', 'bytes': 3538}, 'ROLLBACK.md': {'sha256': 'a6d573a17162c750ad07f81c43c80fc8d4d154c24f4389bff1d33b3acb7cb035', 'bytes': 2497}, 'ROOT_PRODUCT_ACCEPTANCE.json': {'sha256': 'e5c6c8b6457393c78d16379485d3a5f0bc6a51ac8851e062049eda0da38ecb05', 'bytes': 2143}, 'traffic-db.py': {'sha256': '2b44578d7b7fee9d779fe647c6d3b56eb5aa9d377f89b68f5aaed7230ca1127f', 'bytes': 12391}}

def need(v,c):
 if not v:raise ValueError(c)
def main():
 try:
  need(TRANSPORT_READY is True and type(ZIP_SHA) is str and re.fullmatch('[a-f0-9]{64}',ZIP_SHA) and type(EXPECTED) is dict and len(EXPECTED)==28,'TRANSPORT_FINAL_PINS_PENDING')
  need(os.name=='posix' and os.geteuid()==0,'EXACT_ROOT_REQUIRED')
  need(len(sys.argv)==2 and re.fullmatch(r'https://raw[.]githubusercontent[.]com/elk0980/synapse-server/[0-9a-f]{40}/ops/releases/app-completion-20261019/code-darya-r2[.]zip',sys.argv[1]),'EXACT_IMMUTABLE_URL_REQUIRED')
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
