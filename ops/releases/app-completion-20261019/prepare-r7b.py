import hashlib,io,json,os,re,stat,sys,urllib.request,zipfile
from pathlib import Path,PurePosixPath
CODE=Path('/opt/synapse/releases/palitra-app-20261015/multi-company-app-20261019-r7b-code')
ZIP_SHA='1b0fd24e4d3c615baf41546aa371b96ac1a95639b09b6f1fc98df37eef06d424'
EXPECTED={'company-app.py': {'sha256': '5fd92095440c9a8d1d59cd6d1036e3d5c509a8dba161acf9a629d23792b9c829', 'bytes': 987}, 'content-db.py': {'sha256': 'd6363b217d69a49751d875b00cf50776593d01160b386190edaac8bf537ab4be', 'bytes': 7788}, 'CONTENT_MIGRATION.json': {'sha256': '84e3e34c782a36f555a850cff6ea761823ef625059d1c782f5039f328dc27100', 'bytes': 3196}, 'payload/backend/company-app/customer-report-cache.cjs': {'sha256': '3fca5842514e2ba770ea19b94183002a437cae9b065358537055fa3772d23d92', 'bytes': 12285}, 'payload/backend/company-app/customer-reports.cjs': {'sha256': 'ff51c487eb717b835f3268cc6239bef3a640e7c3aebffca27cb5dbcf4fd18ddd', 'bytes': 12691}, 'payload/backend/project-chat-work-queue.js': {'sha256': 'd9e3c54f502f0074f0fdf89c6c6c0e7741a6f7ead6bf8d15301edf0ddc76b78a', 'bytes': 19367}, 'payload/backend/project-chat.js': {'sha256': '6803bd270182de06339f9b6a14adbbbf92ced9f6f186a2966e3817aaee397e8d', 'bytes': 182950}, 'payload/MANIFEST.json': {'sha256': 'af7bd62072e4a6eb369b46e04ca6c7dc5a4c3bc2e9350a605483af12fc551b0d', 'bytes': 6116}, 'payload/native-cabinet/project-chat.css': {'sha256': '7d9fae166ee2d1f5888f0af12d047050442f320180999af0eb27746d99400c40', 'bytes': 13260}, 'payload/native-cabinet/project-chat.js': {'sha256': 'f87a01451429b46b784f7c6bbd10c96ac29020fd0255bec7192566248869a4b1', 'bytes': 101213}, 'payload/product/cabinet.html': {'sha256': 'b3fbf23c1e0dbd5c19cf62a258380f3a60b1eb7818be5bd1d328322f03c5e4b0', 'bytes': 2501}, 'payload/product/customer-reports-ui.js': {'sha256': '1b12ef902ae597bef52548638a798b127f54193b005a87f5f23534cf70dd2401', 'bytes': 19106}, 'payload/product/shell.css': {'sha256': '90ab73b9297c0c0e25ca793e8475dbc52cd068566313ffb5137dff3be4789212', 'bytes': 59321}, 'payload/product/shell.js': {'sha256': 'f9e51cb873d5cd8a098962bb49eef9d6903dcda0ac4dca37acb5f44116c1d941', 'bytes': 269459}, 'payload/product/team-chat-drafts.js': {'sha256': 'ca033fd0d36acdd9b61a0597da4e5dd54c8875dd8728f53eb4a13ac1df46521a', 'bytes': 4019}, 'payload/product/team-chat-host.js': {'sha256': '3cbd2d02962365904a56d82b826e8bfbe116408b497bc4f1a57ef343052abdab', 'bytes': 3499}, 'payload/product/team-chat-renderer.js': {'sha256': 'ca8e0f9bfc975862a105acc144aa7ca3ac8bb9b8bade84bfd1ee03972dce8a85', 'bytes': 105533}, 'payload/product/team-chat-start.js': {'sha256': '2e991f310d438cdfb98bcb1a011c3d32e35d72f7aecde882958312331cbb7f50', 'bytes': 52}, 'payload/product/team-chat.css': {'sha256': 'be845937b87c56fac1d66987c6c217b1e841627e667cdfbda5f8440cdab68042', 'bytes': 13164}, 'payload/product/team-chat.html': {'sha256': 'f1b8ed36a9606be7535ee07c62384202b4baeb88a750f3e88eb19274ef692e15', 'bytes': 696}, 'PRODUCT_MANIFEST.json': {'sha256': 'b594f37643edd9beebfce3f15b94a0cce52c133fc7dc81d6bcd675fb338c9c94', 'bytes': 17224}, 'PRODUCT_REVIEW.json': {'sha256': 'c45c91f084c3f5a5b08a21cea3f79cc99ca294e77ab48c77cb1c1ebccffdc971', 'bytes': 14289}, 'release-native.py': {'sha256': '5610ff8008b25b334c184388873d3633df5e9a92fa409c96ab7dca42bb441ff9', 'bytes': 51132}, 'report-db.py': {'sha256': '08456dc9fcfae875b22c631a461e0cedea5a702b5f8d43ae770de7cff6e78a63', 'bytes': 7626}, 'rollback-plan.py': {'sha256': '53ef9085d9120e3cc1b18715a83f6e11285dbd13a64de119ab9c5cf5084eed62', 'bytes': 1929}, 'ROLLBACK.md': {'sha256': '01056c19d8435c8568e7f0fe40d0d9913a3a522cf336a99bfcf4481e081dab79', 'bytes': 4642}}
def need(v,c):
 if not v:raise ValueError(c)
def main():
 try:
  need(os.name=='posix' and os.geteuid()==0,'EXACT_ROOT_REQUIRED')
  need(len(sys.argv)==2 and re.fullmatch(r'https://raw[.]githubusercontent[.]com/elk0980/synapse-server/[0-9a-f]{40}/ops/releases/app-completion-20261019/code-r7b[.]zip',sys.argv[1]),'EXACT_IMMUTABLE_URL_REQUIRED')
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
