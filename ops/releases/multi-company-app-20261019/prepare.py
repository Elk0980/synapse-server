import hashlib,io,json,os,re,stat,sys,urllib.request,zipfile
from pathlib import Path,PurePosixPath
CODE=Path('/opt/synapse/releases/palitra-app-20261015/multi-company-app-20261019-r2-code')
ZIP_SHA='5daa137c0cf3da537fac0de9f0dc18923b04607e6f1ca7176a9e637745fe8ab2'
EXPECTED={'company-app.py': {'sha256': 'ed241f147f5b342872029331f060e232aae6ed648065c8a21141ad9adebbd6a7', 'bytes': 928}, 'release-native.py': {'sha256': '55dae4a2046a3ede984671d46cc7c9295bcec7ff64c9adb1b203f026c9a58d2c', 'bytes': 34804}, 'ROLLBACK.md': {'sha256': '7df1d839cb5c54f67f51a6853b7ae462c8cb18824bf92d44f9fed4f0912a26fd', 'bytes': 6894}, 'payload/MANIFEST.json': {'sha256': 'b83977fd69b9733344575708cf499b50e94948e69ed88bd026fbfd13d08579e9', 'bytes': 5128}, 'payload/backend/client-bot-config.js': {'sha256': 'c2b4ae55a67246f7f4df7d82c24f00fabfd4cbe23c9b7fd49a47abc676340a2a', 'bytes': 1391}, 'payload/backend/server.js': {'sha256': 'bda9c24e09409b773fcd6d3ab517ca92bc0257c3a3781ffa8f92d7a2e640236c', 'bytes': 125772}, 'payload/product/cabinet.html': {'sha256': 'a63d26a5ffaff8eb3a4e0485dd20fe045dbca2f9c1d1237e21e2739c39aa3b63', 'bytes': 2451}, 'payload/product/company-context.js': {'sha256': 'ee8d9c0ab1e72febd3df1a34ed559505056c56f526984a6ab6f1e1f4fb95df45', 'bytes': 8480}, 'payload/product/customer-reports-ui.css': {'sha256': '2aaade12b73c0aa78cafa3c45ee43b864b67c4180f47958eae10e041a0e624d3', 'bytes': 4238}, 'payload/product/customer-reports-ui.js': {'sha256': '47cf1a5f8658b766839b1ccabde252efed4e1c2a5450f1379d71486a451541d3', 'bytes': 18964}, 'payload/product/native-host.js': {'sha256': '78519ea84a19f9559f0a4042c6f328fe5cb35771948be2ac9f32f72b807b2e21', 'bytes': 15457}, 'payload/product/report-source-ui.js': {'sha256': 'c5852fcc82b5e49f40f9d3a05b405c3e739489a2086b40412c4bdb454bc62ecd', 'bytes': 16498}, 'payload/product/report-source.css': {'sha256': '449d487cafc56dc14605c2bc84b194df5ff671d689ef98f012e6aa608c289314', 'bytes': 1348}, 'payload/product/report-source.html': {'sha256': 'cdc7b1d4422078c95bc3290a37e5485f71539d92fe5b3b85d0e52a688e278ac8', 'bytes': 1170}, 'payload/product/shell.css': {'sha256': '1c4efc7afc23646fe7c2a216cda21609ad0de7b510658a68f153ab65fc5d1ad7', 'bytes': 58148}, 'payload/product/shell.js': {'sha256': 'ddf516a035144301a93d3d93d30768c2ef169e66a1d0f62b740714ceb8590faa', 'bytes': 263318}, 'payload/product/synapse-bridge.js': {'sha256': '56ba23db6004453bceb4293d3b97f65c8646e8219da7c4fccb7e6278a261c93d', 'bytes': 77631}, 'payload/backend/company-app/company-app-http.cjs': {'sha256': '17803c69dec363fef4ce6cacf699f1ea98c5b1ba6d31d5f788a7579ee6bb2461', 'bytes': 4522}, 'payload/backend/company-app/company-context.js': {'sha256': 'ee8d9c0ab1e72febd3df1a34ed559505056c56f526984a6ab6f1e1f4fb95df45', 'bytes': 8480}, 'payload/backend/company-app/customer-report-aggregates.cjs': {'sha256': '535eb9bbbd5b69a9d0b7506246d9b483f5371c687c2648243f8c1df0ab386893', 'bytes': 3873}, 'payload/backend/company-app/customer-report-cache.cjs': {'sha256': '77065f981f55411dd735d3e2cba16a956bdf8b299f278cf33e97cc6321041844', 'bytes': 12178}, 'payload/backend/company-app/customer-report-import-http.cjs': {'sha256': 'fded2b3dcc49f8331fae8a1530342c6efd4405a1f3825e26aac8215923776258', 'bytes': 4548}, 'payload/backend/company-app/customer-reports-http.cjs': {'sha256': 'c57d11531f2753060de1d15beec50a3cbdc7b3d3139b3e025aab51766f63c976', 'bytes': 2410}, 'payload/backend/company-app/customer-reports.cjs': {'sha256': '03c547c0ac38e453038611c7ae5d86157d56314edc97bd8a42c0c2cf65d5e0bf', 'bytes': 11097}, 'payload/backend/company-app/runtime.cjs': {'sha256': '94734598c6176d824c835d9dae72dbc09832d976cb32cebbabe5590836031028', 'bytes': 1877}}
def need(v,c):
 if not v:raise ValueError(c)
def main():
 try:
  need(os.name=='posix' and os.geteuid()==0,'EXACT_ROOT_REQUIRED')
  need(len(sys.argv)==2 and re.fullmatch(r'https://raw[.]githubusercontent[.]com/Elk0980/synapse-server/[0-9a-f]{40}/ops/releases/multi-company-app-20261019/code-r2[.]zip',sys.argv[1]),'EXACT_IMMUTABLE_URL_REQUIRED')
  for p in [*reversed(CODE.parents),CODE]:need(not p.is_symlink(),'CODE_SYMLINK_REFUSED')
  need(CODE.parent.is_dir() and CODE.parent.stat().st_uid==0 and not os.path.lexists(CODE),'NEW_CODE_NAMESPACE_REQUIRED_NO_RETRY')
  with urllib.request.urlopen(sys.argv[1],timeout=30) as response:raw=response.read(2*1024*1024+1)
  need(len(raw)<=2*1024*1024 and hashlib.sha256(raw).hexdigest()==ZIP_SHA,'EXACT_CODE_ARCHIVE_REQUIRED')
  z=zipfile.ZipFile(io.BytesIO(raw));names=z.namelist();need(len(names)==len(set(names))==25 and set(names)==set(EXPECTED),'CLOSED_CODE_PACKET_REQUIRED')
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
