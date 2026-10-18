"""Create a local, immutable code packet for Root review. Never uploads/installs."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--review', type=Path, required=True)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parent
review = json.loads(args.review.read_text(encoding='utf-8-sig'))
sha = lambda data: hashlib.sha256(data).hexdigest()
assert review['build'] == 'synapse-company-app-20261019-r2'
assert sha(Path(review['archive']).read_bytes()) == review['archive_sha256']
spec = importlib.util.spec_from_file_location('company_release', root / 'release-native.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
records = []
for row in review['files']:
    name = row['path']; target = row['runtime_target'].removeprefix('/app/')
    records.append({'name': name, 'target': target, 'sha256': row['sha256'], 'bytes': row['bytes'],
                    'beforeSha256': row['before_sha256'], 'beforeSourceSha256': None if name == 'product/cabinet.html' else row['before_sha256'],
                    'static': name.split('/')[-1] if name.startswith('product/') else None})
manifest = {'schema': 1, 'build': review['build'], 'records': records}
module.validate_records(manifest)
args.out.mkdir(parents=True, exist_ok=False)
packet = args.out / 'code'; packet.mkdir()
payload = packet / 'payload'; payload.mkdir()
for row in records:
    p = Path(review['candidate_directory']) / row['name']
    assert not p.is_symlink()
    data = p.read_bytes(); assert len(data) == row['bytes'] and sha(data) == row['sha256']
    dest = payload / row['name']; dest.parent.mkdir(parents=True, exist_ok=True); dest.write_bytes(data)
raw = (json.dumps(manifest, sort_keys=True, separators=(',', ':'), ensure_ascii=False) + '\n').encode()
(payload / 'MANIFEST.json').write_bytes(raw); manifest_sha = sha(raw)
rollback = (root / 'ROLLBACK.md').read_bytes(); (packet / 'ROLLBACK.md').write_bytes(rollback)
helper = (root / 'release-native.py').read_text(encoding='utf-8')
for before, after in [("FROZEN = False", "FROZEN = True"), ("MANIFEST_SHA = '0' * 64", "MANIFEST_SHA = '" + manifest_sha + "'"), ("ROLLBACK_SHA = '0' * 64", "ROLLBACK_SHA = '" + sha(rollback) + "'")]:
    assert helper.count(before) == 1; helper = helper.replace(before, after)
(packet / 'release-native.py').write_text(helper, encoding='utf-8', newline='\n')
helper_sha = sha((packet / 'release-native.py').read_bytes())
wrapper = '''import hashlib,json,os,sys,types
from pathlib import Path
CODE=Path('/opt/synapse/releases/palitra-app-20261015/multi-company-app-20261019-r3-code')
HELPER_SHA='@HELPER_SHA@'
def main():
 try:
  if os.name!='posix' or os.geteuid()!=0 or Path(__file__).resolve().parent!=CODE:raise ValueError('EXACT_ROOT_NEW_NAMESPACE_REQUIRED')
  p=CODE/'release-native.py'
  if any(x.is_symlink() for x in [*p.parents,p]):raise ValueError('CODE_SYMLINK_REFUSED')
  raw=p.read_bytes()
  if hashlib.sha256(raw).hexdigest()!=HELPER_SHA:raise ValueError('FROZEN_HELPER_CHANGED')
  m=types.ModuleType('frozen_company_release');m.__file__=str(p);exec(compile(raw,str(p),'exec'),m.__dict__);return m.main()
 except Exception as e:
  print(json.dumps({'status':'ENTRY_REFUSED_NO_RETRY','messageSha256':hashlib.sha256(str(e).encode()).hexdigest()}));return 2
if __name__=='__main__':sys.exit(main())
'''.replace('@HELPER_SHA@', helper_sha)
(packet / 'company-app.py').write_text(wrapper, encoding='utf-8', newline='\n')
inventory = {p.relative_to(packet).as_posix(): {'sha256': sha(p.read_bytes()), 'bytes': p.stat().st_size} for p in packet.rglob('*') if p.is_file()}
assert len(inventory) == 25
archive = args.out / 'code-r3.zip'
with zipfile.ZipFile(archive, 'x', zipfile.ZIP_DEFLATED) as z:
    for name in sorted(inventory): z.write(packet / name, name)
archive_sha = sha(archive.read_bytes())
prepare = '''import hashlib,io,json,os,re,stat,sys,urllib.request,zipfile
from pathlib import Path,PurePosixPath
CODE=Path('/opt/synapse/releases/palitra-app-20261015/multi-company-app-20261019-r3-code')
ZIP_SHA='@ZIP_SHA@'
EXPECTED=@EXPECTED@
def need(v,c):
 if not v:raise ValueError(c)
def main():
 try:
  need(os.name=='posix' and os.geteuid()==0,'EXACT_ROOT_REQUIRED')
  need(len(sys.argv)==2 and re.fullmatch(r'https://raw[.]githubusercontent[.]com/Elk0980/synapse-server/[0-9a-f]{40}/ops/releases/multi-company-app-20261019/code-r3[.]zip',sys.argv[1]),'EXACT_IMMUTABLE_URL_REQUIRED')
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
'''.replace('@ZIP_SHA@', archive_sha).replace('@EXPECTED@', repr(inventory))
(args.out / 'prepare.py').write_text(prepare, encoding='utf-8', newline='\n')
result = {'status': 'IMMUTABLE_INSTALLER_FOR_ROOT_REVIEW_NOT_UPLOADED', 'atProductHead': review['head'], 'productArchiveSha256': review['archive_sha256'],
          'build': review['build'], 'codeArchive': str(archive), 'archiveSha256': archive_sha, 'manifestSha256': manifest_sha,
          'helperSha256': helper_sha, 'wrapperSha256': sha((packet / 'company-app.py').read_bytes()), 'rollbackSha256': sha(rollback),
          'prepareSha256': sha((args.out / 'prepare.py').read_bytes()), 'files': inventory, 'targetCounts': {'source': 227, 'static': 33, 'chain': 36},
          'requiresRootProductAndInstallerAcceptance': True, 'uploaded': False, 'applied': False}
(args.out / 'INSTALLER_REVIEW_READY.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({k: result[k] for k in ('status', 'archiveSha256', 'helperSha256', 'manifestSha256', 'rollbackSha256')}))
