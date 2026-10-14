"""Strict local byte/path helpers. No network, shell, credentials or DB."""
import hashlib,json,os,re,stat
from pathlib import Path,PurePosixPath
MAX=16*1024*1024
CONTENT='sha256:8a98cf8656cc139e6cbb842f81bc05e20c534065b2274063629b18c32db3fa72'
WORKER='sha256:c5dd4502daf630afaac7415da5b19dc456c81a5f81626574f5480dec04307cca'
SERVER='26193d64a4a64cd3ca1308ec0e70ad4cd548524375f925cc72149e56ca30a395'
MAIN={'content/site-workspace-http.js':'3f08a192470dec74909315c37f58dc81262d5f2db28834152bb83f6fd5176aef','content/site-workspace-feature.js':'319c233f6066955193ac850ce8b58464b198ad262d168be64281659828e82910','content/palitra-host-adapter.cjs':'4827ba116be8ee04882cbdf44ad0ea27ab2e4ea843ea1ed145f4054af2091136'}
class Refused(Exception):pass
def need(ok,msg):
 if not ok:raise Refused(msg)
def sha(data):return hashlib.sha256(data).hexdigest()
def relative(s):
 need(isinstance(s,str) and s and '\\' not in s and ':' not in s and '\x00' not in s,'Bad relative path')
 p=PurePosixPath(s);need(not p.is_absolute() and str(p)==s and all(x not in ('','.','..') for x in s.split('/')),'Noncanonical path');return p
def safe(p,missing=False):
 p=Path(p);need(p.is_absolute() and '..' not in p.parts,'Absolute path required')
 for item in [*reversed(p.parents),p]:
  try:s=item.lstat()
  except FileNotFoundError:need(missing,'Missing required path');continue
  need(not stat.S_ISLNK(s.st_mode) and not(getattr(s,'st_file_attributes',0)&0x400),'Symlink/reparse refused')
  if item!=p:need(stat.S_ISDIR(s.st_mode),'Ancestor not directory')
 return p
def under(root,s,missing=False):
 p=safe(Path(root).joinpath(*relative(s).parts),missing);need(p.resolve(strict=False).is_relative_to(Path(root).resolve()),'Path escapes root');return p
def read(p,limit=MAX):
 p=safe(p);s=p.stat();need(stat.S_ISREG(s.st_mode) and 0<s.st_size<=limit,'Regular bounded file required')
 fd=os.open(p,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
 try:
  a=os.fstat(fd)
  with os.fdopen(fd,"rb",closefd=False) as stream:data=stream.read(limit+1)
  b=os.fstat(fd);c=p.lstat()
  need((a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns)==(b.st_dev,b.st_ino,b.st_size,b.st_mtime_ns),'Source changed')
  need((a.st_dev,a.st_ino)==(c.st_dev,c.st_ino) and len(data)==a.st_size,'Source replaced');return data
 finally:os.close(fd)
def obj(raw):
 def pairs(items):
  d={}
  for k,v in items:need(k not in d,'Duplicate JSON key');d[k]=v
  return d
 try:return json.loads(raw.decode('utf-8-sig'),object_pairs_hook=pairs)
 except (ValueError,UnicodeError):raise Refused('Malformed JSON')
def load(p):return obj(read(p))
def json_bytes(o):return (json.dumps(o,ensure_ascii=False,indent=2)+'\n').encode()
def replace_once(data,old,new):
 text=data.decode('utf-8-sig');nl='\r\n' if '\r\n' in text else '\n';old=old.replace('\n',nl);new=new.replace('\n',nl)
 if old not in text:
  need(text.count(new)==1,'Unique anchor missing');return data
 need(text.count(old)==1,'Duplicate anchor');return text.replace(old,new,1).encode('utf-8')
def source_file(root,name,pin,snapshots):
 p=under(root,name);b=read(p);need(sha(b)==pin,'Source hash mismatch: '+name);snapshots[p]=sha(b);return b
def check_snapshots(snapshots):
 for p,pin in snapshots.items():need(sha(read(p))==pin,'Source changed after preflight')
