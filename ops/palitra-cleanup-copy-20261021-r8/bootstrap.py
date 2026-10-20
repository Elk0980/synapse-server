"""One code transfer and staging; does not run preparation or deletion."""
import hashlib,os,pathlib,re,stat,subprocess,sys,urllib.request
root=pathlib.Path('/opt/synapse/releases/palitra-app-20261015')
target=root/'palitra-order-cleanup-copy-20261021-r8-input'
pins={'copy-code-only.zip': '9173a3fd39261fcfd1dffe6ff538a8b3154ab596d45f1edf3ba69fbceb73fcec', 'stage_copy_code.py': 'de58198a5585d770378f85cb4bd2a0290708015d2562fbef9ce01e3e5560141f'}
sha=lambda b:hashlib.sha256(b).hexdigest()
commit,ticks=sys.argv[1:]
assert os.name=='posix' and os.geteuid()==os.getegid()==0 and re.fullmatch('[a-f0-9]{40}',commit) and re.fullmatch('[1-9][0-9]*',ticks)
def lease():
 rows=[r.strip().split(maxsplit=1) for r in subprocess.check_output(['lslocks','-n','-o','PID,PATH'],timeout=10).decode().splitlines()]
 assert [r for r in rows if len(r)==2 and r[1]=='/opt/synapse/.palitra-app-release.lock']==[['3462715','/opt/synapse/.palitra-app-release.lock']]
 assert pathlib.Path('/proc/3462715/stat').read_text().rsplit(') ',1)[1].split()[19]==ticks
lease()
for p in [root,*root.parents]:
 s=p.lstat();assert stat.S_ISDIR(s.st_mode) and not p.is_symlink() and s.st_uid==s.st_gid==0 and not stat.S_IMODE(s.st_mode)&0o022
assert not os.path.lexists(target)
data={}
for name,h in pins.items():
 url='https://raw.githubusercontent.com/Elk0980/synapse-server/'+commit+'/ops/palitra-cleanup-copy-20261021-r8/'+name
 with urllib.request.urlopen(url,timeout=30) as response:
  assert response.status==200 and response.geturl()==url
  raw=response.read(1048577)
 assert len(raw)<=1048576 and sha(raw)==h;data[name]=raw
lease();target.mkdir(mode=0o700)
for name,raw in data.items():
 fd=os.open(target/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
 assert (target/name).read_bytes()==raw
lease()
subprocess.run(['python3','-B',str(target/'stage_copy_code.py'),'--zip',str(target/'copy-code-only.zip'),'--lease-start-ticks',ticks],check=True,timeout=60)
