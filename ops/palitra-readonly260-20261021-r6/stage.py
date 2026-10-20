import hashlib,io,json,os,pathlib,re,stat,subprocess,sys,urllib.request,zipfile
root=pathlib.Path('/opt/synapse/releases/palitra-app-20261015');code=root/'palitra-clear-readonly260-20261021-r6-code';temp=root/'palitra-clear-managed260-r1-readonly-temp'
sha=lambda b:hashlib.sha256(b).hexdigest()
def need(v,c):
 if not v:raise ValueError(c)
commit,pid=sys.argv[1:];need(os.name=='posix' and os.geteuid()==0 and re.fullmatch('[a-f0-9]{40}',commit) and pid.isdigit(),'ROOT_EXACT_INPUTS')
def lease():
 rows=[r.split(maxsplit=1) for r in subprocess.check_output(['lslocks','-n','-o','PID,PATH'],timeout=10).decode().splitlines()]
 need([r for r in rows if len(r)==2 and r[1]=='/opt/synapse/.palitra-app-release.lock']==[[pid,'/opt/synapse/.palitra-app-release.lock']],'OWN_LEASE_REQUIRED')
lease()
for p in [root,*root.parents]:
 s=p.lstat();need(stat.S_ISDIR(s.st_mode) and not p.is_symlink() and s.st_uid==s.st_gid==0 and not stat.S_IMODE(s.st_mode)&0o022,'ROOT_PATH_REQUIRED')
need(not os.path.lexists(code),'EXISTING_STAGE_NO_REPLAY')
u='https://raw.githubusercontent.com/Elk0980/synapse-server/'+commit+'/ops/palitra-readonly260-20261021-r6/code-only.zip'
with urllib.request.urlopen(u,timeout=30) as f:
 need(f.status==200 and f.geturl()==u,'EXACT_CODE_RESPONSE');raw=f.read(2000001)
need(len(raw)<=2000000 and sha(raw)=='e2c16e67f92e4885fb5a0aad24f539724322a4da4c3c92895147e72f1b435277','EXACT_CODE_ZIP')
pins={'capture_managed260.py': '3854d183bb729245ceb5120d3b2a2d853dc6ec4f1d9481741cf93af91c65b6fb', 'collect_runtime.py': 'fbba7c7a32a7407c36626f27586e7796ecebdaf15690deaf4ac41068a53d64b5', 'entry_r1_history.py': '2910e0e74b32af6e19f31ef30af2ee5e78ce6081e1d079b64596cafdb8cb25cb', 'evidence_validator.py': '37d16b054aa3b80b99f53b06c3ce15afc3cd4c4966a7a22c3847bb3e0b2d5379', 'fast-managed260.cjs': '2e4f023ad698316decafe4d93f8c6c51c297b97cbd9044d5ffed609069bd723b', 'incremental-manifest.json': '8894c2f449b18698848e5e3f60d973ba64e307316a2b3adc630336601c95c853', 'inspect_readonly.py': '8a283418d98c9ea4fd7675e1d0d13d760c08245ef9040a5b009154807c19a867', 'literal_history.py': 'debe707d371da1a274101636a62b9c28b87b6c637d89d01608250101f73858a4', 'managed260-probe.cjs': '146732c590b3eb2fe45071c506fcef3798400868d5d2a4adaedad600f7a1d855', 'read_primitives.json': '81b2a1bcf492c1ccebdb6910b5e5b5e8e1ab3ec63bca57b4b121666168a45ef3', 'readonly_entry.py': 'e11c298545d268fe544b7251f23998ef842a1c4d776ec1f7f2025cfb5de5baf8', 'safe_primitives.py': '13f44a34e54d24585be67518e291e930275a1e87dcf292c48e95295e030df828', 'static_closure.py': '273c0d4fd49f366adf77893376619066e83be6f5d86c5f91250b3e7c35bebcbf', 'storage_seals.py': '6db80ce5488bfa466227213bd17253169bb6e50921350d9df5aaa24f997613da', 'readonly-code-pins.json': '7de083ac3cf4b39c352ed7b3c60d35e447480f0ab836915d2c87482ef8125c09'}
with zipfile.ZipFile(io.BytesIO(raw)) as z:
 need(len(z.infolist())==len(pins) and set(z.namelist())==set(pins) and sum(x.file_size for x in z.infolist())<2000000,'EXACT_CODE_CLOSURE');files={n:z.read(n) for n in pins}
need(all(sha(files[n])==pin for n,pin in pins.items()),'EXACT_CODE_HASHES')
if os.path.lexists(temp):
 s=temp.lstat();need(stat.S_ISDIR(s.st_mode) and not temp.is_symlink() and s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o700,'PRIVATE_READONLY_TEMP_REQUIRED')
lease();code.mkdir(mode=0o700)
for n,raw in files.items():
 fd=os.open(code/n,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
 need((code/n).read_bytes()==raw,'EXACT_CODE_READBACK')
if not temp.exists():temp.mkdir(mode=0o700)
lease();print(json.dumps({'status':'READONLY_R6_CODE_STAGED_NOT_RUNTIME_AUTHORIZATION','codeFiles':len(files),'liveDatabaseWrites':0}))
