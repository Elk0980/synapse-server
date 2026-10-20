"""One code-only staging, no database or application writes."""
import hashlib,json,os,pathlib,re,stat,subprocess,sys,urllib.request
root=pathlib.Path('/opt/synapse/releases/palitra-app-20261015')
code=root/'palitra-managed260-capture-20261021-r1-code'
pins={'capture_managed260.py': '3854d183bb729245ceb5120d3b2a2d853dc6ec4f1d9481741cf93af91c65b6fb', 'managed260-probe.cjs': '146732c590b3eb2fe45071c506fcef3798400868d5d2a4adaedad600f7a1d855'}
need=lambda v,c:None if v else (_ for _ in ()).throw(ValueError(c))
sha=lambda b:hashlib.sha256(b).hexdigest()
commit,pid=sys.argv[1:]
need(os.name=='posix' and os.geteuid()==0 and re.fullmatch('[a-f0-9]{40}',commit) and pid.isdigit(),'ROOT_PINNED_ARGUMENTS')
def lease():
 rows=[r.strip().split(maxsplit=1) for r in subprocess.check_output(['lslocks','-n','-o','PID,PATH'],timeout=10).decode().splitlines()]
 need([r for r in rows if len(r)==2 and r[1]=='/opt/synapse/.palitra-app-release.lock']==[[pid,'/opt/synapse/.palitra-app-release.lock']],'OWN_LEASE_REQUIRED')
lease()
for p in [root,*root.parents]:
 s=p.lstat();need(stat.S_ISDIR(s.st_mode) and not p.is_symlink() and s.st_uid==s.st_gid==0 and not stat.S_IMODE(s.st_mode)&0o022,'ROOT_PATH_REQUIRED')
need(not os.path.lexists(code),'EXISTING_ATTEMPT_NO_RETRY')
data={}
for name,h in pins.items():
 url='https://raw.githubusercontent.com/Elk0980/synapse-server/'+commit+'/ops/palitra-managed260-capture-20261021-r1/'+name
 with urllib.request.urlopen(url,timeout=30) as response:
  need(response.status==200 and response.geturl()==url,'EXACT_RESPONSE_REQUIRED');raw=response.read(131073)
 need(len(raw)<=131072 and sha(raw)==h,'EXACT_CODE_REQUIRED');data[name]=raw
lease();code.mkdir(mode=0o700)
for name,raw in data.items():
 fd=os.open(code/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as out:out.write(raw);out.flush();os.fsync(out.fileno())
 need((code/name).read_bytes()==raw,'EXACT_CODE_READBACK_REQUIRED')
lease();print(json.dumps({'status':'READONLY_CAPTURE_CODE_STAGED_NOT_RUNTIME_AUTHORIZATION','files':pins,'databaseWrites':0}))
