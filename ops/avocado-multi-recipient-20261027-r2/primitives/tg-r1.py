"""Root-only staging/capture/one-attempt orchestration for an exact accepted tuple.
No secrets are printed; captures and actions stay root600 on the server.
"""
import argparse,hashlib,importlib.util,io,json,os,re,stat,subprocess,sys,time,urllib.request,zipfile
from pathlib import Path
sys.dont_write_bytecode=True
ROOT=Path('/opt/synapse/releases/palitra-app-20261015')
AREA=ROOT/'palitra-tg-native-install-20261021-r1'
CODE=ROOT/'palitra-tg-r7-installer-readbinding-r1-code'
READER=ROOT/'palitra-tg-root-reader-configsafe-r2'
INSTALLER_SHA='d52031302191b3fce9b0ebc549164c412c31091677d1a0a64716446c6ff96ac2'
READER_SHA='366396f20080f3cda97c408f91b3b954a80401e4f210b745dc7a33c8a9894224'
ZIP_PINS={'installer.zip':('66c9503454151984599dff74cd9bcd619848e62f5d347602c18ca63f154e3847',355602),'reader.zip':('82ca78298c2b6eddda08b2d23e98e0d2d0022ef2ae851f01f2776461eeb4e3f3',19389)}
def need(ok,code):
 if not ok:raise ValueError(code)
def sha(b):return hashlib.sha256(b).hexdigest()
def encoded(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def private_read(p):
 for q in (p,*p.parents):need(not q.is_symlink(),'CODE_PATH_ALIAS')
 s=p.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_size<=32*1024*1024,'CODE_FILE_BOUNDARY')
 if os.name=='posix':need(s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o600,'ROOT600_CODE')
 fd=os.open(p,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0)|getattr(os,'O_BINARY',0))
 try:
  raw=b''
  while len(raw)<=s.st_size:
   b=os.read(fd,min(65536,s.st_size+1-len(raw)))
   if not b:break
   raw+=b
  keys=('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns')+(('st_ctime_ns',) if os.name=='posix' else ())
  need(len(raw)==s.st_size and all(getattr(s,k)==getattr(os.fstat(fd),k)==getattr(p.lstat(),k) for k in keys),'CODE_READ_RACE');return raw
 finally:os.close(fd)
def write(p,b):
 for q in (p,*p.parents):need(not q.is_symlink(),'PATH_ALIAS')
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:
  os.fchmod(fd,0o600)
  with os.fdopen(fd,'wb',closefd=False) as f:f.write(b);f.flush();os.fsync(f.fileno())
 finally:os.close(fd)
def ref(p):return {'path':str(p),'sha256':sha(p.read_bytes())}
def run(args,timeout=90):
 need(type(args) is list and all(type(a) is str for a in args),'NO_SHELL')
 r=subprocess.run(args,stdin=subprocess.DEVNULL,capture_output=True,timeout=timeout,check=True)
 need(len(r.stdout)<=32*1024*1024 and len(r.stderr)<=8*1024*1024,'OUTPUT_BOUND')
 return r.stdout
def unpack(raw,manifest,pin,prefix=''):
 with zipfile.ZipFile(io.BytesIO(raw)) as z:
  names=z.namelist();need(len(names)==len(set(names)) and sum(i.file_size for i in z.infolist())<8*1024*1024,'ZIP_BOUND')
  mb=z.read(manifest);need(sha(mb)==pin,'EXACT_MANIFEST');m=json.loads(mb);files=m['files']
  need(set(names)=={prefix+n for n in files}|{manifest},'ZIP_CLOSURE')
  out={}
  for n,h in files.items():
   need(not n.startswith('/') and '\\' not in n and ':' not in n and all(p not in ('','.','..') for p in n.split('/')),'ZIP_PATH')
   b=z.read(prefix+n);need(sha(b)==h,'ZIP_STREAM_SHA');out[n]=b
  return mb,m,out
def stage(commit):
 need(re.fullmatch('[a-f0-9]{40}',commit),'EXACT_PUBLIC_COMMIT')
 need(not any(p.exists() for p in (AREA,CODE,READER)),'STAGE_ALREADY_EXISTS_INSPECT_ONLY')
 bundles={}
 for name,(pin,size) in ZIP_PINS.items():
  url='https://raw.githubusercontent.com/Elk0980/synapse-server/'+commit+'/ops/palitra-tg-native-20261021-r1/'+name
  with urllib.request.urlopen(url,timeout=45) as response:raw=response.read(size+1)
  need(len(raw)==size and sha(raw)==pin,'PUBLIC_CODE_ZIP_PIN');bundles[name]=raw
 im,_,ip=unpack(bundles['installer.zip'],'code-manifest.json',INSTALLER_SHA)
 rm,contract,rp=unpack(bundles['reader.zip'],'reader-manifest.json',READER_SHA,'reader-code/')
 need(contract['entry']==str(READER/'reader.py'),'READER_ENTRY_BINDING')
 for p in (ROOT,*ROOT.parents):need(p.is_dir() and not p.is_symlink(),'ROOT_DIRECTORY')
 for d in (AREA,CODE,READER):d.mkdir(mode=0o700)
 for base,files in ((CODE,ip),(READER,rp)):
  for name,raw in files.items():
   dest=base/name;dest.parent.mkdir(mode=0o700,parents=True,exist_ok=True);write(dest,raw)
 write(CODE/'code-manifest.json',im);write(AREA/'reader-manifest.json',rm)
 acceptance={'schema':'palitra-tg-installer-acceptance/v1','status':'ROOT_ACCEPTED_EXACT_INSTALLER_CODE','manifestSha256':INSTALLER_SHA,'readonlyAdapterManifestSha256':READER_SHA}
 write(AREA/'installer-code-acceptance.json',encoded(acceptance))
 write(AREA/'stage.json',encoded({'status':'CODE_STAGED_NOT_APPLIED','commit':commit,'installer':INSTALLER_SHA,'reader':READER_SHA,'productionWrites':0}))
 print(json.dumps({'status':'CODE_STAGED_NOT_APPLIED','installerFiles':len(ip),'readerFiles':len(rp),'installerSha':INSTALLER_SHA,'readerSha':READER_SHA}))
def load():
 manifest=private_read(CODE/'code-manifest.json');need(sha(manifest)==INSTALLER_SHA,'INSTALLER_MANIFEST_CHANGED');pins=json.loads(manifest)['files']
 need({p.relative_to(CODE).as_posix() for p in CODE.rglob('*') if p.is_file()}==set(pins)|{'code-manifest.json'},'INSTALLER_CODE_CLOSURE')
 for name,pin in pins.items():need(sha(private_read(CODE/name))==pin,'INSTALLER_CODE_CHANGED_BEFORE_IMPORT')
 entry_spec=importlib.util.spec_from_file_location('accepted_tg_entry',CODE/'entry.py');entry=importlib.util.module_from_spec(entry_spec);entry_spec.loader.exec_module(entry)
 package=entry.load_package(CODE,INSTALLER_SHA)
 sys.path.insert(0,str(CODE))
 import native
 rm=AREA/'reader-manifest.json';need(sha(rm.read_bytes())==READER_SHA,'READER_MANIFEST_CHANGED');contract=json.loads(rm.read_bytes())
 need({p.relative_to(READER).as_posix() for p in READER.rglob('*') if p.is_file()}==set(contract['files']),'READER_CLOSURE')
 for name,pin in contract['files'].items():need(sha(native.read(READER/name,native=True))==pin,'READER_CODE_CHANGED')
 spec=importlib.util.spec_from_file_location('accepted_tg_reader_r2',READER/'reader.py');reader=importlib.util.module_from_spec(spec);spec.loader.exec_module(reader)
 return entry,package,native,reader,contract
def lease(native,pid):
 statline=Path('/proc/'+str(pid)+'/stat').read_text();ticks=statline[statline.rfind(')')+2:].split()[19]
 value={'pid':pid,'startTicks':ticks,'path':str(native.LOCK)};native.Ticket.native_lease(value);return value
def capture(pid):
 need(not (AREA/'capture.json').exists() and not (AREA/'action.json').exists(),'CAPTURE_EXISTS_INSPECT_ONLY')
 entry,package,native,reader,contract=load();own=lease(native,pid)
 names=run(['docker','ps','--all','--no-trunc','--format','{{.Names}}']).decode().splitlines()
 need(names and len(names)==len(set(names)) and 'synapse-content-1' in names,'CONTAINER_CLOSURE')
 rows=json.loads(run(['docker','inspect','synapse-content-1']));need(len(rows)==1,'ONE_CONTENT')
 labels=rows[0]['Config']['Labels'];files=labels['com.docker.compose.project.config_files'].split(',')
 gate=object.__new__(native.Native);gate.command=run;gate.read_scripts=set(contract['readScriptSha256']);gate.read_scopes=contract['readScriptScopes'];gate.allowed_images={package['parentImage']};gate.bindings={'containerNames':names,'contentContainer':'synapse-content-1'};gate.forward_plan=None
 gate.before={'compose':{'project':labels['com.docker.compose.project'],'directory':labels['com.docker.compose.project.working_dir'],'files':[{'path':f,'sha256':sha(native.read(f,native=True))} for f in files]}}
 current=reader.create(gate.read_command);base=current.snapshot();gate.before=base;gate.package=package;gate.verify_before_contract()
 readiness=current.readiness();need(all(v is True for k,v in readiness.items() if k not in ('csp','miniappSchema')),'PREBUILD_BOT_OR_AUTH_READINESS_REFUSED')
 base_path=AREA/'native-base.json';write(base_path,encoded(base))
 bindings={'installerAcceptance':ref(AREA/'installer-code-acceptance.json'),'readonlyAdapterManifest':ref(AREA/'reader-manifest.json'),'nativeBase':ref(base_path),'containerNames':names,'contentContainer':'synapse-content-1'}
 now=time.time();namespace='palitra-tg-r7-'+os.urandom(16).hex()
 action={'schema':'palitra-tg-root-action/v1','mode':'apply','status':'ROOT_AUTHORIZED_ONE_ATTEMPT','runtimeAuthorization':True,'packageSha256':INSTALLER_SHA,'namespace':namespace,'created':now,'expires':now+1800,'lease':own,'queue':{'resource':'synapse-content-production','owner':'Root','clear':True},'bindings':bindings}
 # Explicit human deployment instruction is required outside this file; this
 # action is fresh, private and bound to the actual kernel lease and BASE.
 write(AREA/'action.json',encoded(action))
 report={'status':'FRESH_NATIVE_BASE_CAPTURED_NOT_APPLIED','namespace':namespace,'image':base['image'],'source':len(base['source']),'static':len(base['static']),'managedVersion':base['invariants']['managedSite']['version'],'managedFiles':len(base['invariants']['managedSite']['files']),'readinessBeforeBuild':readiness,'nativeBaseSha':sha(encoded(base)),'actionSha':sha(encoded(action)),'lease':own,'botUsername':current.script('synapse-content-1','config-readiness.js')['bots'][0]['username'],'productionWrites':0}
 write(AREA/'capture.json',encoded(report));print(json.dumps(report))
def apply():
 entry,package,native,reader,contract=load();p=AREA/'action.json';need(p.exists(),'FRESH_ACTION_REQUIRED')
 return entry.main(['--mode','apply','--manifest-sha',INSTALLER_SHA,'--action',str(p),'--action-sha',sha(p.read_bytes())])
def inspect(pid):
 entry,package,native,reader,contract=load();original=json.loads((AREA/'action.json').read_bytes());receipt=ROOT/(original['namespace']+'-apply')/'result.json'
 need(receipt.exists(),'NO_INSTALLED_RESULT_INSPECT_JOURNAL_FIRST');installed=json.loads(receipt.read_bytes())
 now=time.time();action={**original,'mode':'inspect','status':'ROOT_AUTHORIZED_READ_ONLY','runtimeAuthorization':False,'created':now,'expires':now+900,'lease':lease(native,pid),'namespace':'palitra-tg-r7-'+os.urandom(16).hex()}
 dest=AREA/('inspect-'+str(time.time_ns())+'.json');write(dest,encoded(action));ticket=native.Ticket(dest,sha(dest.read_bytes()),INSTALLER_SHA,'inspect');backend=native.Native(ticket,package,CODE,None);backend.bind_rollback(installed)
 observed=backend.guard('installed');ready=backend.reader.readiness();need(all(v is True for v in ready.values()),'INSTALLED_READINESS_REFUSED')
 report={'status':'ROOT_INDEPENDENT_NATIVE_READBACK_PASS','resultSha':sha(receipt.read_bytes()),'image':installed['child']['image'],'observed':observed,'readiness':ready,'runtimeAcceptance':False,'wholeAppAcceptance':False}
 write(AREA/('readback-'+str(time.time_ns())+'.json'),encoded(report));print(json.dumps(report))
def status():
 entry,package,native,reader,contract=load();action=json.loads((AREA/'action.json').read_bytes());folder=ROOT/(action['namespace']+'-apply');items=[]
 if folder.exists():
  for p in sorted(folder.glob('[0-9][0-9][0-9].json')):
   d=json.loads(p.read_bytes());items.append({'file':p.name,'phase':d['phase'],'status':d['status']})
 print(json.dumps({'namespace':action['namespace'],'phases':items,'resultExists':(folder/'result.json').exists()}))
def main():
 need(os.name=='posix' and os.geteuid()==0,'LINUX_ROOT_ONLY')
 p=argparse.ArgumentParser();p.add_argument('mode',choices=('stage','capture','apply','inspect','status'));p.add_argument('argument',nargs='?');args=p.parse_args()
 if args.mode=='stage':stage(args.argument)
 elif args.mode=='capture':capture(int(args.argument))
 elif args.mode=='apply':return apply()
 elif args.mode=='inspect':inspect(int(args.argument))
 else:status()
 return 0
if __name__=='__main__':
 try:raise SystemExit(main())
 except Exception as e:
  value=str(e);print(json.dumps({'status':'STOP_INSPECT_ONLY_NO_RETRY','error':type(e).__name__,'code':value if isinstance(e,ValueError) and re.fullmatch('[A-Z0-9_]{1,96}',value) else 'NATIVE_PREPARATION_FAILED'}));raise SystemExit(2)
