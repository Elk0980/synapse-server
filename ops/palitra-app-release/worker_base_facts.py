"""Minimum read-only worker observation. No release authorization, writes, app imports or outbound calls."""
import hashlib,json,os,posixpath,re,stat,subprocess,sys
from pathlib import Path
from datetime import datetime,timezone
CID='7d7ec369e7ce44e492874137813caf3399b21b0242438b3b6df1281e4f379415'
IMAGE='sha256:c5dd4502daf630afaac7415da5b19dc456c81a5f81626574f5480dec04307cca'
BRIDGE='36b0bdc733ad4f4514635d0416867d5964fef4c82aeabe125f542a20969de0ee'
QUIET='6cb97cf8c85a4b6763c94c2ee3ba707a2d5fa33b2806ea5c7f0594dd137f634e'
ROOT=Path('/opt/synapse/releases/palitra-app-20261015');LOCK='/opt/synapse/.palitra-app-release.lock';PID=2744197
INSPECT='{"Id":{{json .Id}},"Image":{{json .Image}},"Config":{"Cmd":{{json .Config.Cmd}},"Entrypoint":{{json .Config.Entrypoint}},"WorkingDir":{{json .Config.WorkingDir}},"User":{{json .Config.User}},"Env":{{json .Config.Env}},"Labels":{{json .Config.Labels}}},"State":{"Running":{{json .State.Running}},"Status":{{json .State.Status}},"Health":{{json .State.Health.Status}}},"RestartCount":{{json .RestartCount}},"Mounts":{{json .Mounts}},"HostConfig":{"RestartPolicy":{{json .HostConfig.RestartPolicy}},"NetworkMode":{{json .HostConfig.NetworkMode}},"PortBindings":{{json .HostConfig.PortBindings}}}}'
# .State.Health may not exist: Docker template index access is safe for an unconfigured healthcheck.
INSPECT=INSPECT.replace('{{json .State.Health.Status}}','{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}')
IMAGE_INSPECT='{"Id":{{json .Id}},"RepoTags":{{json .RepoTags}},"RepoDigests":{{json .RepoDigests}},"Os":{{json .Os}},"Architecture":{{json .Architecture}},"RootFS":{{json .RootFS}}}'
PROBE=r'''const fs=require('node:fs'),c=require('node:crypto'),p=require('node:path');
const hash=b=>c.createHash('sha256').update(b).digest('hex');
function file(f,limit){try{const s=fs.lstatSync(f);if(!s.isFile()||s.isSymbolicLink()||fs.realpathSync(f)!==f||s.size>limit)throw Error('boundary');const fd=fs.openSync(f,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const v=fs.fstatSync(fd);if(v.dev!==s.dev||v.ino!==s.ino||v.size!==s.size)throw Error('race');let n=0,read;const b=Buffer.alloc(65536),h=c.createHash('sha256');while((read=fs.readSync(fd,b,0,Math.min(b.length,limit+1-n),null))>0){n+=read;if(n>limit)throw Error('limit');h.update(b.subarray(0,read));}const end=fs.fstatSync(fd);if(n!==s.size||end.size!==s.size||end.mtimeMs!==s.mtimeMs||end.ctimeMs!==s.ctimeMs)throw Error('race');return{available:true,mode:s.mode&4095,size:n,sha256:h.digest('hex')};}finally{fs.closeSync(fd);}}catch{return{available:false};}}
const names=['server.js','client-bot-bridge.js','quiet-hours.js','task-intake.js'],files={};
if(fs.realpathSync('/app')!=='/app'||!fs.lstatSync('/app').isDirectory()||process.cwd()!=='/app')throw Error('app boundary');
for(const name of names)files[name]=file('/app/'+name,2*1024*1024);
const safeExec=['/usr/local/bin/node','/usr/bin/node'].includes(process.execPath);
const binary=safeExec?file(process.execPath,256*1024*1024):{available:false};
console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,execPath:safeExec?process.execPath:null,execPathSha256:hash(process.execPath),binary,api:{fetch:typeof fetch==='function',FormData:typeof FormData==='function',Blob:typeof Blob==='function',abortTimeout:typeof AbortSignal.timeout==='function'},files}));'''
def need(value,code):
 if not value:raise ValueError(code)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def canon(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()
class Reader:
 def __init__(self,execute=None):self.execute=execute or subprocess.run;self.events=[]
 def run(self,args,optional=False):
  allowed=[['lslocks','--json','--output','PID,MODE,PATH'],['docker','inspect','--format',INSPECT,'synapse-chat-1'],['docker','image','ls','--no-trunc','--format','{{json .}}'],['docker','image','inspect','--format',IMAGE_INSPECT,IMAGE],['docker','exec',CID,'node','-e',PROBE]]
  need(args in allowed,'READONLY_COMMAND_NOT_ALLOWED')
  try:r=self.execute(args,capture_output=True,stdin=subprocess.DEVNULL,shell=False,timeout=30)
  except subprocess.TimeoutExpired:self.events.append({'command':allowed.index(args),'timeout':True});raise ValueError('READONLY_TIMEOUT') from None
  out,err=r.stdout or b'',r.stderr or b'';self.events.append({'command':allowed.index(args),'rc':r.returncode,'stdoutBytes':len(out),'stderrSha256':sha(err)})
  need(len(out)<=2*1024*1024 and len(err)<=2*1024*1024,'READONLY_OUTPUT_BOUND')
  if r.returncode:
   if optional:
    self.events[-1]['unavailableReason']='missing_image_object'if re.search(rb'(?i)no such (?:image|object)|image[^\r\n]{0,160}not found',err)else'exact_image_inspection_failed'
    return None
   raise ValueError('READONLY_COMMAND_FAILED')
  return out
 def lease(self):
  rows=json.loads(self.run(['lslocks','--json','--output','PID,MODE,PATH']))['locks']
  found=[r for r in rows if r.get('path')==LOCK];need(len(found)==1 and found[0].get('pid')==PID and found[0].get('mode')=='WRITE','EXACT_ROOT_LEASE_REQUIRED')
 def snapshot(self):
  value=json.loads(self.run(['docker','inspect','--format',INSPECT,'synapse-chat-1']));need(value.get('Id')==CID and value.get('Image')==IMAGE and value.get('State',{}).get('Running') is True,'EXACT_RUNNING_WORKER_REQUIRED');return value
def safe_snapshot(value):
 conf=value['Config'];cmd=conf.get('Cmd');entry=conf.get('Entrypoint');wd=conf.get('WorkingDir');user=conf.get('User')
 allowed=cmd in (['node','server.js'],['node','/app/server.js']) and entry in (None,[],['docker-entrypoint.sh'],['/usr/local/bin/docker-entrypoint.sh']) and wd=='/app' and user in ('','root','node','0','1000')
 need(type(value['RestartCount'])is int and 0<=value['RestartCount']<=1000000,'RESTART_COUNT_REQUIRED')
 mounts=value['Mounts'];need(type(mounts)is list and len(mounts)<=64,'MOUNT_BOUND')
 dest=[r.get('Destination')for r in mounts];need(all(type(d)is str and d.startswith('/') and d==posixpath.normpath(d) for d in dest) and len(set(dest))==len(dest),'MOUNT_DESTINATION_REQUIRED')
 overlap=lambda d,x:d=='/'or d==x or x.startswith(d.rstrip('/')+'/')or d.startswith(x.rstrip('/')+'/')
 app_alias=any(overlap(d,'/app')or overlap(d,'/usr/local/bin')or overlap(d,'/usr/bin')for d in dest)
 env=conf.get('Env');need(type(env)is list and len(env)<=256 and all(type(e)is str for e in env),'ENV_BOUND')
 names=[e.split('=',1)[0]for e in env];need(len(set(names))==len(names),'ENV_DUPLICATE')
 full={'Id':value['Id'],'Image':value['Image'],'Config':conf,'Mounts':sorted(mounts,key=lambda r:r['Destination']),'HostConfig':value['HostConfig']}
 return {'cid':value['Id'],'image':value['Image'],'running':True,'health':value['State'].get('Health') if value['State'].get('Health') in (None,'healthy','starting','unhealthy') else 'unknown','restartCount':value['RestartCount'],'startupAllowed':allowed,'startup':{'Cmd':cmd,'Entrypoint':entry,'WorkingDir':wd,'User':user}if allowed else None,'startupSha256':sha(canon([cmd,entry,wd,user])),'envOpaqueSha256':sha(canon(env)),'configOpaqueSha256':sha(canon(full)),'mountCount':len(mounts),'canonicalMountsSha256':sha(canon(sorted(mounts,key=lambda r:r['Destination']))),'appOrRuntimeMountOverlap':app_alias,'composeLabelsSha256':sha(canon(conf.get('Labels')))}
def safe_probe(value):
 need(type(value)is dict and set(value)=={'node','platform','arch','execPath','execPathSha256','binary','api','files'},'PROBE_SCHEMA_REQUIRED')
 need(type(value['node'])is str and re.fullmatch(r'v\d{1,3}\.\d{1,3}\.\d{1,4}',value['node'])and value['platform']=='linux'and value['arch']in ('x64','arm64','arm','ia32')and value['execPath']in ('/usr/local/bin/node','/usr/bin/node')and re.fullmatch(r'[0-9a-f]{64}',value['execPathSha256']),'PROBE_RUNTIME_REQUIRED')
 need(type(value['api'])is dict and set(value['api'])=={'fetch','FormData','Blob','abortTimeout'}and all(type(x)is bool for x in value['api'].values()),'PROBE_API_REQUIRED')
 need(type(value['files'])is dict and set(value['files'])=={'server.js','client-bot-bridge.js','quiet-hours.js','task-intake.js'},'KNOWN_FILE_SET_REQUIRED')
 for record in [value['binary'],*value['files'].values()]:
  need(type(record)is dict and type(record.get('available'))is bool,'PROBE_FILE_REQUIRED')
  need(set(record)==({'available','mode','size','sha256'}if record['available']else{'available'}),'PROBE_FILE_SCHEMA_REQUIRED')
  if record['available']:need(type(record['mode'])is int and 0<=record['mode']<=4095 and type(record['size'])is int and 0<=record['size']<=256*1024*1024 and re.fullmatch(r'[0-9a-f]{64}',record['sha256']),'PROBE_FILE_HASH_REQUIRED')
 return value
def inventory(reader):
 raw=reader.run(['docker','image','ls','--no-trunc','--format','{{json .}}']);lines=raw.splitlines();result=[]
 for line in lines[:100]:
  row=json.loads(line);ident=row.get('ID','');need(re.fullmatch(r'sha256:[0-9a-f]{64}',ident)is not None,'IMAGE_ID_REQUIRED')
  safe=lambda v:v if type(v)is str and re.fullmatch(r'[A-Za-z0-9._/@:+-]{1,256}',v) else None
  result.append({'id':ident,'repository':safe(row.get('Repository')),'tag':safe(row.get('Tag')),'digest':safe(row.get('Digest'))})
 exact=reader.run(['docker','image','inspect','--format',IMAGE_INSPECT,IMAGE],optional=True)
 if exact is None:available={'available':False,'reason':reader.events[-1]['unavailableReason'],'acceptedRollbackBase':False}
 else:
  row=json.loads(exact);need(row.get('Id')==IMAGE,'EXACT_IMAGE_ID_REQUIRED');layers=row.get('RootFS',{}).get('Layers',[]);need(type(layers)is list and len(layers)<=256 and all(re.fullmatch(r'sha256:[0-9a-f]{64}',x)for x in layers),'IMAGE_LAYERS_REQUIRED')
  available={'available':True,'id':row['Id'],'os':row.get('Os')if row.get('Os')in ('linux','windows')else None,'architecture':row.get('Architecture')if row.get('Architecture')in ('amd64','arm64','arm','386')else None,'rootfsLayerCount':len(layers),'rootfsSha256':sha(canon(row['RootFS'])),'acceptedRollbackBase':False}
 return {'rows':result,'shown':len(result),'truncated':len(lines)>100,'tagDoesNotProveTrustedBase':True,'exactPreviousImage':available}
def archives(root=ROOT):
 if not root.exists():return {'available':False,'entries':[]}
 need(not root.is_symlink()and root.resolve()==root and root.is_dir(),'ARCHIVE_ROOT_BOUNDARY');rows=[];count=0;total=0
 for entry in os.scandir(root):
  count+=1;need(count<=512,'ARCHIVE_DIRECTORY_BOUND')
  if not re.fullmatch(r'(?i)(?=[A-Za-z0-9._-]*(?:worker|chat|node|runtime))[A-Za-z0-9._-]+\.(?:tar|tar\.gz|tgz|zip|tar\.zst)',entry.name):continue
  value=entry.stat(follow_symlinks=False);need(stat.S_ISREG(value.st_mode)and not entry.is_symlink(),'ARCHIVE_FILE_BOUNDARY');total+=value.st_size;need(len(rows)<20 and value.st_size<=256*1024*1024 and total<=512*1024*1024,'ARCHIVE_BYTES_BOUND')
  fd=os.open(entry.path,os.O_RDONLY|os.O_NOFOLLOW)
  try:
   first=os.fstat(fd);need((first.st_dev,first.st_ino,first.st_size)==(value.st_dev,value.st_ino,value.st_size),'ARCHIVE_RACE');h=hashlib.sha256();size=0
   while True:
    block=os.read(fd,65536)
    if not block:break
    size+=len(block);need(size<=value.st_size,'ARCHIVE_RACE');h.update(block)
   end=os.fstat(fd);need(size==value.st_size and (end.st_size,end.st_mtime_ns,end.st_ctime_ns)==(value.st_size,value.st_mtime_ns,value.st_ctime_ns),'ARCHIVE_RACE')
  finally:os.close(fd)
  rows.append({'name':entry.name,'mode':stat.S_IMODE(value.st_mode),'bytes':size,'sha256':h.hexdigest(),'provenanceVerified':False})
 return {'available':True,'entries':sorted(rows,key=lambda r:r['name']),'topLevelOnly':True,'trustedByFilename':False}
def observe(reader,archive_root=ROOT):
 output={'schema':1,'observedAtUtc':datetime.now(timezone.utc).isoformat(),'status':'READONLY_INCOMPLETE_NO_MUTATION','mutations':0,'commands':reader.events,'phase':'MINIMUM_FACTS','fullReleaseProof':False,'composeResolvedProof':False,'rollbackProven':False}
 try:
  reader.lease();before=reader.snapshot();base=safe_snapshot(before);output['worker']=base
  need(base['startupAllowed']and not base['appOrRuntimeMountOverlap'],'STARTUP_OR_MOUNT_NEEDS_REVIEW')
  output['images']=inventory(reader);probe=safe_probe(json.loads(reader.run(['docker','exec',CID,'node','-e',PROBE])));output['runtimeAndKnownCode']=probe
  need(set(probe['files'])=={'server.js','client-bot-bridge.js','quiet-hours.js','task-intake.js'},'KNOWN_FILE_SET_REQUIRED')
  need(probe['files']['client-bot-bridge.js'].get('sha256')==BRIDGE and probe['files']['quiet-hours.js'].get('sha256')==QUIET,'RUNNING_CODE_PIN_CHANGED')
  need(probe['files']['server.js'].get('available')is True and probe.get('binary',{}).get('available')is True and all(probe.get('api',{}).get(k)is True for k in ('fetch','FormData','Blob','abortTimeout')),'RUNTIME_NEEDS_REVIEW')
  output['archiveMetadata']=archives(archive_root);after_probe=safe_probe(json.loads(reader.run(['docker','exec',CID,'node','-e',PROBE])));after=safe_snapshot(reader.snapshot());reader.lease()
  need(base['configOpaqueSha256']==after['configOpaqueSha256']and base['restartCount']==after['restartCount']and canon(probe)==canon(after_probe),'FINAL_IDENTITY_CONFIG_OR_SOURCE_DRIFT')
  output['stableIdentityConfigSource']=True;output['status']='MINIMUM_WORKER_FACTS_OBSERVED_NOT_BUILD_OR_ROLLBACK_APPROVAL'
 except Exception as error:output['failure']={'class':type(error).__name__,'code':str(error)if type(error)is ValueError and re.fullmatch(r'[A-Z0-9_]{1,80}',str(error))else 'READONLY_FACTS_REFUSED'}
 return output
if __name__=='__main__':
 need(len(sys.argv)==1,'NO_ARGUMENTS_ALLOWED');print(json.dumps(observe(Reader()),sort_keys=True,separators=(',',':')))
