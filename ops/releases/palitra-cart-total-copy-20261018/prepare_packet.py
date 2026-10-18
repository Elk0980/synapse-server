"""Root-only new static28 code namespace. Stage only; no product/runtime writes."""
import hashlib,json,os,stat,urllib.request,zipfile,io
from pathlib import Path
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
DEST=ROOT/'palitra-cart-total-copy-code-r1'
ZIP_URL='https://raw.githubusercontent.com/Elk0980/synapse-server/refs/heads/codex/palitra-app-release-20261015/ops/releases/palitra-cart-total-copy-20261018/code-r1.zip'
ZIP_SHA='2b25a1a6115999a74d03ce4f0dca476a85841258f9bd105b6d6bc3775c7c4323'
ZIP_BYTES=41921
MEMBERS={'cart_total_copy.py': ('5631aacdf3bcace355d4777d2d6bf1003131e3aa2f5367cb96c0601c0ca04bb2', 26551), 'payload/MANIFEST.json': ('e2e8f0364c9df75d580391e6aba79ac7b227c2eb81a2b194552576336ec6bf87', 2036), 'payload/product/order.js': ('468e43816e3ab1787dd9fff9861af1e08ca8c09060ed8a2141568e4edbd18223', 81971), 'payload/product/storefront.js': ('7e71b415d7592e2258a88f222ef57ec539a2c6ab8478c3dddb5b1f65aff7b87c', 27572)}
def need(value,code):
 if not value:raise ValueError(code)
def chain(p):
 for item in [*reversed(p.parents),p]:
  s=item.lstat();need(not stat.S_ISLNK(s.st_mode),'SYMLINK_REFUSED')
 need(p.resolve()==p,'EXACT_CANONICAL_PATH_REQUIRED')
def packet_files(raw):
 need(len(raw)==ZIP_BYTES and hashlib.sha256(raw).hexdigest()==ZIP_SHA,'ZIP_PIN_CHANGED')
 result={}
 with zipfile.ZipFile(io.BytesIO(raw)) as z:
  names=z.namelist();need(len(names)==len(set(names))==4 and set(names)==set(MEMBERS),'CLOSED_FOUR_MEMBERS_REQUIRED')
  for name in names:
   info=z.getinfo(name);need(not info.is_dir() and stat.S_ISREG(info.external_attr>>16) and info.file_size==MEMBERS[name][1] and not info.flag_bits&1,'REGULAR_BOUNDED_CODE_MEMBER_REQUIRED')
   data=z.read(name);need(len(data)==MEMBERS[name][1] and hashlib.sha256(data).hexdigest()==MEMBERS[name][0],'MEMBER_PIN_CHANGED');result[name]=data
 return result
def main():
 need(os.name=='posix' and os.geteuid()==0,'ROOT_POSIX_REQUIRED');chain(ROOT)
 need(not os.path.lexists(DEST),'NEW_NAMESPACE_ONLY_NO_OVERWRITE')
 with urllib.request.urlopen(ZIP_URL,timeout=30) as response:
  need(response.status==200 and response.geturl().startswith('https://raw.githubusercontent.com/Elk0980/synapse-server/'),'EXACT_CODE_ORIGIN_REQUIRED')
  raw=response.read(ZIP_BYTES+1)
 files=packet_files(raw);chain(ROOT);need(not os.path.lexists(DEST),'NAMESPACE_APPEARED_NO_OVERWRITE')
 os.umask(0o077);DEST.mkdir(mode=0o700)
 for directory in ('payload','payload/product'):(DEST/directory).mkdir(mode=0o700)
 for name,data in files.items():
  p=DEST/name
  with p.open('xb') as output:output.write(data);output.flush();os.fsync(output.fileno())
  chain(p);need(hashlib.sha256(p.read_bytes()).hexdigest()==MEMBERS[name][0],'STAGED_READBACK_CHANGED')
 actual={p.relative_to(DEST).as_posix() for p in DEST.rglob('*') if p.is_file()}
 need(actual==set(MEMBERS),'CLOSED_STAGE_REQUIRED')
 print(json.dumps({'status':'STATIC28_CODE_STAGED_NOT_APPLIED','members':4,'zipSha256':ZIP_SHA,'builds':0,'contentUps':0,'dbWrites':0}))
if __name__=='__main__':main()
