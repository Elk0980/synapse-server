"""Explicit Root steps only: readonly facts/capture and private source bundle.
No Docker build/static apply/activation/config/DB/env/network operations.
"""
import argparse,hashlib,importlib.util,json,os,re,stat,subprocess,sys,zipfile
from pathlib import Path
ROOT=Path('/opt/synapse/releases/palitra-app-20261015');LEASE='/opt/synapse/.palitra-app-release.lock';PID=2744197
CONTENT='sha256:8a98cf8656cc139e6cbb842f81bc05e20c534065b2274063629b18c32db3fa72';WORKER='sha256:c5dd4502daf630afaac7415da5b19dc456c81a5f81626574f5480dec04307cca'
VERSIONS='/data/projects/palitra-love/sites/site-44bbe13f1bad5e005b2a/versions';HOST_VERSIONS='/var/lib/docker/volumes/synapse_content_data/_data/projects/palitra-love/sites/site-44bbe13f1bad5e005b2a/versions'
ZIP_SHA='88f451adcd88430a7ebc531311ef1e7aa2a9c738db14d16d2fdd7513fe642b3a';MANIFEST_SHA='b27b2cf1517cb1c3719ce0511436ba62dfa6569c00e3357867f82f94ce67a2fe'
BOOT={'release_common.py':'623e4f9a2b0f4124e93caa5103790b1bed9761545f86d584fc2b432efdfd6211','native_release.py':'be1b649875b74d1aae482ea6f8d628f8aa3a512f0506900b6e66480995d74213','build_release.py':'ac338a65ba83444212318685270580d790e233cb2e31cb37f0a3bd2364b19acb','package_inputs.py':'2bc76311cd485706b1c98f543977b2c4b7846067d2f867135aad91e4afe54a24'}
CAPTURE_SHA='d10842caa196565b799499fa56dc6e4d273998147b47fb862a57ff3b5b326ca7'
class Refused(Exception):pass
def need(v,m):
 if not v:raise Refused(m)
def sha(b):return hashlib.sha256(b).hexdigest()
def js(b):
 def pairs(items):
  d={}
  for k,v in items:need(k not in d,'Duplicate JSON key');d[k]=v
  return d
 try:return json.loads(b.decode('utf8'),object_pairs_hook=pairs,parse_constant=lambda x:(_ for _ in ()).throw(Refused('Invalid JSON number')))
 except (ValueError,UnicodeError,RecursionError):raise Refused('Malformed JSON')
def dump(v):return (json.dumps(v,ensure_ascii=False,indent=2)+'\n').encode()
def safe(p,missing=False):
 p=Path(p);need(p.is_absolute() and '..' not in p.parts,'Absolute canonical path required')
 for x in [*reversed(p.parents),p]:
  try:s=x.lstat()
  except FileNotFoundError:need(missing,'Required path absent');continue
  need(not stat.S_ISLNK(s.st_mode) and not(getattr(s,'st_file_attributes',0)&0x400),'Symlink/reparse refused')
  if x!=p:need(stat.S_ISDIR(s.st_mode),'Non-directory parent')
 return p
def read(p,limit=32*1024*1024):
 p=safe(p);a=p.stat();need(stat.S_ISREG(a.st_mode) and 0<a.st_size<=limit,'Regular bounded input required');fd=os.open(p,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
 try:
  with os.fdopen(fd,'rb',closefd=False) as f:b=f.read(limit+1)
  c=os.fstat(fd);d=p.stat();need((a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns)==(c.st_dev,c.st_ino,c.st_size,c.st_mtime_ns)==(d.st_dev,d.st_ino,d.st_size,d.st_mtime_ns),'Input changed');return b
 finally:os.close(fd)
def relative(n):need(type(n)is str and re.fullmatch(r'[A-Za-z0-9_./-]+',n) is not None and all(x not in ['', '.', '..'] for x in n.split('/')),'Unsafe source relative path');return n
def live_lease(pid):
 need(type(pid)is int and pid==PID,'Only independently confirmed Root lease PID accepted')
 r=subprocess.run(['lslocks','--noheadings','--output','PID,PATH'],capture_output=True,timeout=15,shell=False)
 need(r.returncode==0 and any(x.strip().split(maxsplit=1)==[str(pid),LEASE] for x in r.stdout.decode().splitlines()),'Root lease absent/changed')
class Ops:
 def __init__(self,root=ROOT,lease_check=live_lease,loader=None):self.root=safe(root);self.lease_check=lease_check;self.loader=loader;self.loaded={}
 def facts(self,full=False):
  raw=read(self.root/'facts-v3.json',4*1024*1024);f=js(raw)
  need(type(f)is dict and set(f)<= {'status','mode','images','selected','routes','routeProjectionOnly','caddyAdaptSha256','publicMounts','network','runtimeWrites'},'Unexpected facts/private fields')
  need(f.get('status')=='READONLY_FACTS' and f.get('network')==0 and f.get('runtimeWrites')==0,'Wrong facts status/writes')
  images=f.get('images',{});need(images.get('synapse-content-1')==CONTENT and images.get('synapse-chat-1')==WORKER and set(images)=={'synapse-content-1','synapse-chat-1','caddy'} and re.fullmatch(r'sha256:[0-9a-f]{64}',images['caddy']) is not None,'Wrong immutable facts images')
  s=f.get('selected',{});need(set(s)<= {'flags','origins','workspaceVersionsRoot','publishedRoot','publishedMetadataRead','published','pending','botId'},'Private/unexpected selected fields')
  flags=s.get('flags',{});need(set(flags)=={'PALITRA_CHECKOUT_ENABLED','PALITRA_CRM_ENABLED','PALITRA_CUSTOMER_CHAT_ENABLED','PALITRA_WEB_UPLOADS_ENABLED'} and all(v is None or type(v)is bool for v in flags.values()),'Invalid selected flags')
  origins=s.get('origins',{});need(set(origins)=={'PALITRA_MAIN_ORIGIN','PALITRA_SHOP_ORIGIN','PALITRA_CRM_SYNAPSE_ORIGIN'} and all(v is None or v in ['https://palitra-love.ru','https://palitra-love-draft-1.synapsebusiness.ru','https://synapse.synapsebusiness.ru'] for v in origins.values()),'Invalid selected origin')
  need('botId' not in s or s['botId'] is None or (type(s['botId'])is str and re.fullmatch(r'[1-9][0-9]{0,19}',s['botId']) is not None),'Unexpected bot field')
  derived=None
  if s.get('publishedMetadataRead') is True:
   p=s.get('published',{});need(set(p)=={'siteId','company','hostname','revision','indexBytes','orderBytes'} and p['siteId']=='site-44bbe13f1bad5e005b2a' and p['company']=='palitra-love' and p['hostname']=='palitra-love-draft-1.synapsebusiness.ru' and type(p['revision'])is str and re.fullmatch(r'[0-9a-f]{64}',p['revision']) is not None and all(type(p[k])is int and p[k]>0 for k in ['indexBytes','orderBytes']),'Wrong fixed published workspace')
   need(s.get('workspaceVersionsRoot')==VERSIONS and s.get('publishedRoot')==VERSIONS+'/'+p['revision'],'Published root/revision mismatch')
   mounts=f.get('publicMounts',{}).get('synapse-content-1',[]);projection=[r for r in mounts if r.get('projection')=='fixed-public-workspace-versions'];need(len(projection)==1,'Unique approved fixed volume projection required')
   need(projection[0]=={'type':'volume','source':HOST_VERSIONS,'destination':VERSIONS,'readOnly':False,'projection':'fixed-public-workspace-versions'},'Wrong approved volume/mount/projection')
   derived=HOST_VERSIONS+'/'+p['revision']
  else:need(s.get('publishedRoot') is None and 'published' not in s,'Partial facts with published root')
  if full:
   need(derived is not None and f.get('routeProjectionOnly') is True,'Full published facts required')
   routes=f.get('routes',[])
   def route(host,paths):return any(host in r.get('hosts',[]) and any(p in r.get('paths',[]) for p in paths) and r.get('reverse_proxy')==['content:8080'] and r.get('unprojectedUpstreamCount')==0 and not r.get('additionalMatchConditions') for r in routes)
   need(route('palitra-love.ru',['/*']) and route('synapse.synapsebusiness.ru',['/*','/content/*']),'Existing Main/cabinet content proxy proof missing')
   need(origins['PALITRA_MAIN_ORIGIN']=='https://palitra-love.ru','Approved Main origin missing')
  return f,derived,sha(raw)
 def summary(self):
  self.lease_check(PID);f,root,pin=self.facts();return {'status':'READONLY_SUMMARY','factsSha256':pin,'selected':{k:f['selected'][k] for k in ['flags','origins']},'routes':f.get('routes',[]),'managedRoot':root,'pending':None if root else 'Full published metadata/projection required','approvalCreated':False,'runtimeWrites':0}
 def source(self,extracted=False):
  archive=self.root/'SOURCE_INPUTS.zip';need(sha(read(archive,128*1024*1024))==ZIP_SHA,'Pinned source ZIP changed')
  with zipfile.ZipFile(archive) as z:
   raw=z.read('SOURCE_INPUTS_MANIFEST.json');need(sha(raw)==MANIFEST_SHA,'Source manifest pin changed');m=js(raw)
   need(m.get('status')=='SOURCE_INPUTS_ONLY_NOT_ROOT_APPROVED' and m.get('nativeCaptureIncluded') is False and m.get('privateModelIncluded') is False and m.get('nativeActions')==0,'Private/runtime data in source pack')
  if extracted:
   base=safe(self.root/'inputs');need(read(base/'SOURCE_INPUTS_MANIFEST.json')==raw,'Extracted source manifest changed')
   for name,r in m['files'].items():relative(name);b=read(base/name);need(sha(b)==r['sha256'] and len(b)==r['bytes'],'Extracted source changed')
   need(js(read(base/'tools/APPROVAL_TEMPLATE.json')).get('rootApproved') is False,'Private approval embedded in source inputs')
  return m
 def module(self,name,extracted=False):
  if self.loader:return self.loader(name,extracted)
  key=(name,extracted)
  if key in self.loaded:return self.loaded[key]
  if name=='capture':file=self.root/'capture-v2.py';pin=CAPTURE_SHA;modname='root_ops_capture'
  else:
   need(name in ['release_common','native_release','build_release','package_inputs'],'Unknown code module')
   if name!='release_common':self.module('release_common',extracted)
   if name in ['build_release','package_inputs']:self.module('native_release',extracted)
   if name=='package_inputs':self.module('build_release',extracted)
   file=(self.root/'inputs/tools' if extracted else self.root)/(name+'.py');pin=self.source()['files']['tools/'+name+'.py']['sha256'] if extracted else BOOT[name+'.py'];modname=name
  data=read(file);need(sha(data)==pin,'Fixed reviewed helper code SHA changed')
  spec=importlib.util.spec_from_file_location(modname,file);m=importlib.util.module_from_spec(spec);sys.modules[modname]=m;exec(compile(data,str(file),'exec'),m.__dict__);self.loaded[key]=m;return m
 def extract(self):
  self.lease_check(PID);self.source();need(not (self.root/'inputs').exists(),'Inputs exist: do not overwrite/repeat')
  return self.module('package_inputs').unpack(self.root/'SOURCE_INPUTS.zip',self.root/'inputs',ZIP_SHA,MANIFEST_SHA)
 def capture(self,name):
  need(name=='root-final','Explicit root-final capture child required');self.lease_check(PID);_,root,pin=self.facts(True);need(not (self.root/'capture/root-final').exists(),'Capture exists: do not overwrite/repeat');cap=self.module('capture')
  result=cap.capture(output=self.root/'capture/root-final',expected_worker_image=WORKER,managed_root=Path(root),no_managed=False,root_approved=False,capture_parent=self.root/'capture')
  need(self.facts(True)[2]==pin,'Facts changed during capture');self.lease_check(PID);return result
 def approve(self,root_approved,lease_pid,release_id):
  need(root_approved is True and lease_pid==PID,'Separate explicit Root approval/lease required');need(type(release_id)is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}',release_id),'Explicit unique releaseId required')
  self.lease_check(lease_pid);_,root,pin=self.facts(True);sources=self.source(True);capture=safe(self.root/'capture/root-final');c=read(capture/'capture-manifest.json')
  a={'schema':1,'rootApproved':True,'captureSha256':sha(c),'contentImage':CONTENT,'workerImage':WORKER,'leasePath':LEASE,'leasePid':lease_pid,'releaseId':release_id,'origins':{'cabinet':'https://synapse.synapsebusiness.ru','customer':'https://palitra-love.ru'},'managedRoot':root,'sourcePins':sources['sourcePins']}
  self.module('build_release',True).validate_capture(capture,a,{})
  need(self.facts(True)[2]==pin,'Facts changed before approval');self.lease_check(lease_pid);out=safe(self.root/'privateapproval.json',True);need(not out.exists(),'Approval exists: inspect first, never overwrite');fd=os.open(out,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,'wb') as f:f.write(dump(a));f.flush();os.fsync(f.fileno())
  return {'status':'EXPLICIT_PRIVATE_ROOT_APPROVAL_CREATED','approvalSha256':sha(read(out)),'captureSha256':sha(c),'releaseId':release_id,'runtimeWrites':0}
 def bundle(self,write=False):
  self.lease_check(PID);_,root,pin=self.facts(True);self.source(True);approval=self.root/'privateapproval.json';a=js(read(approval));need(a.get('rootApproved') is True and a.get('managedRoot')==root and a.get('leasePid')==PID,'Explicit private approval mismatch');relative(a['releaseId']);need(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}',a['releaseId']),'Unsafe release id');inputs=self.root/'inputs';output=self.root/('bundle-'+a['releaseId']);need(not output.exists() and not output.with_suffix('.zip').exists(),'Bundle exists: unknown/executed step')
  args={'e_root':inputs/'inputs/e','e_base_root':inputs/'inputs/e-base','forms_root':inputs/'inputs/forms','app_root':inputs/'inputs/app/web','persistent_root':inputs/'inputs/persistent','capture_root':self.root/'capture/root-final','approval_path':approval,'output':output}
  m=self.module('build_release',True);result=m.assemble(check=not write,**args);need(self.facts(True)[2]==pin,'Facts changed during bundle');self.lease_check(PID);return result
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('operation',choices=['summary','extract-source','capture-from-facts','approve','bundle-check','bundle']);p.add_argument('--capture-name');p.add_argument('--root-approved',action='store_true');p.add_argument('--lease-pid',type=int);p.add_argument('--release-id');a=p.parse_args()
 try:
  o=Ops();result=o.summary() if a.operation=='summary' else o.extract() if a.operation=='extract-source' else o.capture(a.capture_name) if a.operation=='capture-from-facts' else o.approve(a.root_approved,a.lease_pid,a.release_id) if a.operation=='approve' else o.bundle(a.operation=='bundle');print(json.dumps(result,ensure_ascii=False));return 0
 except Exception as e:print(json.dumps({'status':'REFUSED','reason':str(e)},ensure_ascii=False));return 2
if __name__=='__main__':sys.exit(main())
