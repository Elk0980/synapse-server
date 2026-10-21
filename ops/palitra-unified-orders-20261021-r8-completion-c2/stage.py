ZIP_PIN='b0eb7301716177937404119cdeebbc28e571b1a7551f076c7a3b5bcac8505b13'
PINS={'completion_entry.py': 'a2ebbcdbb0fa27014e6d487d4d3df44b1b5451d807df42668bbeb9b7b74e1b6c', 'native-adoption-probe.cjs': '17838ad0cd2e7f6f0e1c3ab284bcf47ad51c2453dd912845ab8765fd52c85483', 'completion-manifest.json': '45e940fbad45a24d80f69663eced983ff8f157446395c50523576401e160eb1d'}
import hashlib,io,json,os,pathlib,re,stat,subprocess,sys,urllib.request,zipfile
root=pathlib.Path('/opt/synapse/releases/palitra-app-20261015');code=root/'palitra-unified-orders-20261021-r8-completion-c2-code'
commit,pid,ticks=sys.argv[1:];sha=lambda b:hashlib.sha256(b).hexdigest()
def need(v,c):
 if not v:raise ValueError(c)
need(os.name=='posix' and os.geteuid()==os.getegid()==0 and re.fullmatch('[a-f0-9]{40}',commit) and pid.isdigit() and ticks.isdigit(),'EXACT_ROOT_INPUTS')
def lease():
 rows=[r.split(maxsplit=1)for r in subprocess.check_output(['lslocks','-n','-o','PID,PATH'],timeout=10).decode().splitlines()]
 need([r for r in rows if len(r)==2 and r[1]=='/opt/synapse/.palitra-app-release.lock']==[[pid,'/opt/synapse/.palitra-app-release.lock']],'OWN_LEASE_REQUIRED')
 need((pathlib.Path('/proc')/pid/'stat').read_text().rsplit(')',1)[1].split()[19]==ticks,'LEASE_PID_REUSED')
lease()
for p in [root,*root.parents]:
 s=p.lstat();need(stat.S_ISDIR(s.st_mode)and not p.is_symlink()and s.st_uid==s.st_gid==0 and not stat.S_IMODE(s.st_mode)&0o022,'ROOT_PATH_REQUIRED')
need(not os.path.lexists(code),'EXISTING_STAGE_NO_REPLAY')
url='https://raw.githubusercontent.com/Elk0980/synapse-server/'+commit+'/ops/palitra-unified-orders-20261021-r8-completion-c2/code-only.zip'
with urllib.request.urlopen(url,timeout=30)as f:
 need(f.status==200 and f.geturl()==url,'EXACT_CODE_RESPONSE');raw=f.read(2097153)
need(len(raw)<=2097152 and sha(raw)==ZIP_PIN,'EXACT_CODE_ZIP')
with zipfile.ZipFile(io.BytesIO(raw))as z:
 need(len(z.infolist())==len(PINS)and set(z.namelist())==set(PINS)and sum(x.file_size for x in z.infolist())<16777216,'EXACT_CLOSED_CODE')
 files={n:z.read(n)for n in PINS}
need(all(sha(files[n])==p for n,p in PINS.items()),'EXACT_CODE_HASHES')
lease();code.mkdir(mode=0o700)
for n,raw in files.items():
 p=code/n;p.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb')as f:f.write(raw);f.flush();os.fsync(f.fileno())
 need(p.read_bytes()==raw,'STAGED_BYTES_CHANGED')
lease();print(json.dumps({'status':'CODE_ONLY_STAGED_NOT_INSTALL_AUTHORIZATION','codeFiles':len(files),'applicationWrites':0,'databaseWrites':0}))
