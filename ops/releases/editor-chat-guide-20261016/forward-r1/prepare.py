"""Stage only the exact reviewed forward code; no runtime mutation."""
from pathlib import Path
import hashlib,io,json,os,re,sys,urllib.request,zipfile
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
CODE=ROOT/'palitra-editor-chat-guide-forward-code-r1'
PINS={'RECOVERY_SEAL.json': '78499aff9f3d947a9ad0561e9aef70c84c23ef8ebe22247c5087b0e08e1b8ffa', 'forward_recovery_native.py': 'fdfec3945b8317d14e2e0f004f6152d03a1121dfaf9fe9712cc940de38c6152e', 'forward.py': '69595d3038cdec9eb79599834b09d55dc04d3b7b0f45776322259e13fe46be7e'}
ZIP_SHA='ebba2b512c261905984c8e6126c9339c2b260ec67481ec7b6aa1bc869c7cffca'
sha=lambda raw:hashlib.sha256(raw).hexdigest()
def main():
 assert os.name=='posix' and os.geteuid()==0 and len(sys.argv)==2
 url=sys.argv[1];assert re.fullmatch(r'https://raw\.githubusercontent\.com/Elk0980/synapse-server/[0-9a-f]{40}/ops/releases/editor-chat-guide-20261016/forward-r1/code\.zip',url)
 for p in [*reversed(ROOT.parents),ROOT]:assert p.is_dir() and not p.is_symlink()
 assert not os.path.lexists(CODE)
 with urllib.request.urlopen(url,timeout=60) as response:
  assert response.status==200 and response.url==url
  raw=response.read(131073)
 assert len(raw)<=131072 and sha(raw)==ZIP_SHA
 with zipfile.ZipFile(io.BytesIO(raw)) as z:
  assert len(z.infolist())==3 and set(z.namelist())==set(PINS)
  contents={name:z.read(name) for name in PINS}
  assert all(sha(contents[name])==pin for name,pin in PINS.items())
  CODE.mkdir(mode=0o700)
  for name,body in contents.items():
   target=CODE/name
   fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
   with os.fdopen(fd,'wb') as stream:
    stream.write(body);stream.flush();os.fchmod(stream.fileno(),0o600);os.fsync(stream.fileno())
   assert sha(target.read_bytes())==PINS[name]
 print(json.dumps({'status':'FORWARD_CODE_STAGED_NOT_APPLIED','files':PINS,'runtimeWrites':0}))
if __name__=='__main__':main()
