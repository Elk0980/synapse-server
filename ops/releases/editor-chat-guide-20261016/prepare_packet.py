"""Stage one verified, code-only release in its new private directory; never deploy."""
from pathlib import Path, PurePosixPath
import hashlib,io,json,os,re,stat,sys,urllib.request,zipfile
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
CODE=ROOT/'palitra-editor-chat-guide-code-r1'
ZIP_SHA='c2666358c29720e755cbcae66acc1d0999467f28ec5b7538e166cd20ada8e996'
HELPER_SHA='0ae393d971f63ab97721e240d52fcfd6b3eca34deb94e11ab313773f8d580a1c'
WRAPPER_SHA='237f57af4e466d11742ee76e8564c89e52915192dafb011f46b1949d0143289d'
MANIFEST_SHA='332bc67b1f6a4902ed859126d7b432a7a2a805dc2eb5b1cfc0d739f7693f9d51'
sha=lambda b:hashlib.sha256(b).hexdigest()
def main():
 assert os.name=='posix' and os.geteuid()==0 and len(sys.argv)==2
 url=sys.argv[1];assert re.fullmatch(r'https://raw\.githubusercontent\.com/Elk0980/synapse-server/[0-9a-f]{40}/ops/releases/editor-chat-guide-20261016/code-r1\.zip',url)
 for p in [*reversed(ROOT.parents),ROOT]:assert p.is_dir() and not p.is_symlink()
 assert not CODE.exists() and not CODE.is_symlink()
 with urllib.request.urlopen(url,timeout=60) as response:
  assert response.status==200 and response.url==url
  raw=response.read(4*1024*1024+1)
 assert len(raw)<4*1024*1024 and sha(raw)==ZIP_SHA
 with zipfile.ZipFile(io.BytesIO(raw)) as z:
  rows=z.infolist();assert len(rows)==20 and len({i.filename for i in rows})==20 and sum(i.file_size for i in rows)<8*1024*1024
  for i in rows:
   p=PurePosixPath(i.filename);assert not i.is_dir() and not p.is_absolute() and '..' not in p.parts and '\\' not in i.filename and ':' not in i.filename and stat.S_IFMT(i.external_attr>>16)!=stat.S_IFLNK
  assert sha(z.read('editor_chat_guide_release_native.py'))==HELPER_SHA and sha(z.read('guide.py'))==WRAPPER_SHA
  manifest=z.read('payload/MANIFEST.json');assert sha(manifest)==MANIFEST_SHA
  records=json.loads(manifest)['records'];assert len(records)==17
  names={'guide.py','editor_chat_guide_release_native.py','payload/MANIFEST.json'}|{'payload/'+r['payload'] for r in records}
  assert names=={i.filename for i in rows}
  for r in records:
   b=z.read('payload/'+r['payload']);assert sha(b)==r['sha256'] and len(b)==r['bytes']
  CODE.mkdir(mode=0o700)
  for name in sorted(names):
   target=CODE/name;target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
   assert target.resolve().is_relative_to(CODE.resolve()) and not target.exists() and not target.is_symlink()
   with target.open('xb') as f:f.write(z.read(name))
   target.chmod(0o600)
 print(json.dumps({'status':'EXACT_CODE_PACKET_STAGED_NOT_APPLIED','members':20,'zipSha256':ZIP_SHA,'helperSha256':HELPER_SHA,'wrapperSha256':WRAPPER_SHA,'manifestSha256':MANIFEST_SHA,'runtimeWrites':0,'dbWrites':0}))
if __name__=='__main__':main()
