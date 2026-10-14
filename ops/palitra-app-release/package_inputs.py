"""Portable source-only input ZIP. No native capture, approval, model, DB or network."""
import argparse,sys,zipfile
from pathlib import Path
from release_common import *
from native_release import APP_FILES
from build_release import E_IMAGE,E_WORKER,E_ORDER,E_CABINET,PERSISTENT_BASE,PERSISTENT_CANDIDATE,PERSISTENT_PATCH,forms_public
TOOLS=['build_release.py','native_release.py','release_common.py','package_inputs.py','README.md','APPROVAL_TEMPLATE.json','INPUTS_REQUIRED.json']
def package(*,e_root,e_base_root,forms_root,app_root,persistent_root,output,tool_root=None):
 roots=[safe(Path(p).absolute()) for p in [e_root,e_base_root,forms_root,app_root,persistent_root]];e_root,e_base_root,forms_root,app_root,persistent_root=roots
 output=safe(Path(output).absolute(),True);need(not output.exists() and output.parent.is_dir(),'New archive/existing parent required')
 for root in roots:need(not output.is_relative_to(root),'Archive intersects source')
 snapshots={};payload={}
 def add(name,data):relative(name);need(name not in payload,'Duplicate input file');payload[name]=data
 def source(root,name,pin,dest):add(dest,source_file(root,name,pin,snapshots))
 em=load(e_root/'source-manifest.json');need(em.get('approved_finished') is True,'E source not accepted');targets={r['target']:r for r in em['targets']};need(len(targets)==len(em['targets']) and set(targets)==set(E_IMAGE+[E_WORKER,E_ORDER]+E_CABINET),'E exact16 required')
 source(e_root,'source-manifest.json',sha(read(e_root/'source-manifest.json')),'inputs/e/source-manifest.json')
 for row in em['targets']:source(e_root,row['source'],row['sha256'],'inputs/e/'+row['source'])
 for name in ['server.js','client-dialogs.js','palitra-host-adapter.cjs']:source(e_base_root,name,sha(read(e_base_root/name)),'inputs/e-base/'+name)
 fm=load(forms_root/'integration-manifest.json');source(forms_root,'integration-manifest.json',sha(read(forms_root/'integration-manifest.json')),'inputs/forms/integration-manifest.json')
 fixed={'cabinet-integration.patch','cabinet.html','integration.patch','cabinet/project-forms.js','content/project-forms.cjs'}
 for name,pin in fm['sourceFiles'].items():
  relative(name);need(name in fixed or (name.startswith('dist/') and forms_public(name[5:])),'Unexpected Forms input')
  need(Path(name).name not in ['project.json','history.json'] and not name.startswith('dist/node_modules/'),'Private/dependency input refused')
  source(forms_root,name,pin,'inputs/forms/'+name)
 freeze=app_root.parent/'QA_ROOT/K01_APP_SYNC_0146/FREEZE.json';a=load(freeze);need(a.get('frozen') is True,'App not frozen')
 source(app_root.parent,'QA_ROOT/K01_APP_SYNC_0146/FREEZE.json',sha(read(freeze)),'inputs/app/FREEZE.json')
 files={}
 for r in a['files']+[r for r in a['readonlyGuards'] if r['file'] in ['native-host.js','synapse-bridge.js','shop.html','cabinet.html']]:need(r['file'] not in files,'Duplicate app file');files[r['file']]=r['sha256']
 need(set(files)==set(APP_FILES)|{'cabinet.html'},'Exact customer26/admin entry required')
 for name,pin in files.items():source(app_root,name,pin,'inputs/app/web/'+name)
 ps=load(persistent_root/'persistent-route-source.json');need(ps['acceptedSourceSHA256']==PERSISTENT_BASE and ps['candidateSHA256']==PERSISTENT_CANDIDATE and ps['patchSHA256']==PERSISTENT_PATCH and set(ps['files'])==set(APP_FILES),'Persistent pin/map mismatch')
 for name,pin in [('persistent-route-source.json',sha(read(persistent_root/'persistent-route-source.json'))),('palitra-host-adapter-persistent.cjs',PERSISTENT_CANDIDATE),('persistent-app-route.patch',PERSISTENT_PATCH)]:source(persistent_root,name,pin,'inputs/persistent/'+name)
 tool_root=safe(Path(tool_root or Path(__file__).parent).absolute())
 for name in TOOLS:source(tool_root,name,sha(read(tool_root/name)),'tools/'+name)
 need(obj(payload['tools/APPROVAL_TEMPLATE.json']).get('rootApproved') is False,'Real/private approval must never enter portable sources')
 manifest={'schema':1,'status':'SOURCE_INPUTS_ONLY_NOT_ROOT_APPROVED','nativeCaptureIncluded':False,'privateModelIncluded':False,'nativeActions':0,'directories':{'e-root':'inputs/e','e-base-root':'inputs/e-base','forms-root':'inputs/forms','app-root':'inputs/app/web','persistent-root':'inputs/persistent'},'sourcePins':{'e':sha(payload['inputs/e/source-manifest.json']),'forms':sha(payload['inputs/forms/integration-manifest.json']),'app':sha(payload['inputs/app/FREEZE.json']),'persistent':sha(payload['inputs/persistent/persistent-route-source.json'])},'files':{n:{'sha256':sha(b),'bytes':len(b)} for n,b in payload.items()}}
 check_snapshots(snapshots);raw=json_bytes(manifest)
 with zipfile.ZipFile(output,'x',compression=zipfile.ZIP_DEFLATED) as z:
  for name in sorted(payload):z.writestr(name,payload[name])
  z.writestr('SOURCE_INPUTS_MANIFEST.json',raw)
 check_snapshots(snapshots)
 return {'status':manifest['status'],'archive':str(output),'archiveSha256':sha(read(output,128*1024*1024)),'manifestSha256':sha(raw),'files':len(payload),'sourcePins':manifest['sourcePins'],'nativeActions':0}
def unpack(archive,output,archive_sha,manifest_sha):
 archive=Path(archive).absolute();output=Path(output).absolute();need(sha(read(archive,128*1024*1024))==archive_sha,'Source archive SHA mismatch');safe(output,True);need(not output.exists() and output.parent.is_dir(),'New extraction directory required')
 with zipfile.ZipFile(archive) as z:
  info=z.infolist();names=[i.filename for i in info];need(len(names)==len(set(names)) and len(names)<=500 and sum(i.file_size for i in info)<=128*1024*1024,'Unsafe ZIP inventory')
  for i in info:relative(i.filename);need(not i.is_dir() and (i.external_attr>>16)&0o170000!=0o120000,'Source ZIP symlink refused')
  raw=z.read('SOURCE_INPUTS_MANIFEST.json');need(sha(raw)==manifest_sha,'Source manifest SHA mismatch');m=obj(raw);need(m['status']=='SOURCE_INPUTS_ONLY_NOT_ROOT_APPROVED' and m['nativeCaptureIncluded'] is False and m['privateModelIncluded'] is False,'Unsafe source manifest')
  need(set(names)==set(m['files'])|{'SOURCE_INPUTS_MANIFEST.json'},'Unexpected source ZIP member')
  for name,row in m['files'].items():need(sha(z.read(name))==row['sha256'] and len(z.read(name))==row['bytes'],'Input source changed')
  need(obj(z.read('tools/APPROVAL_TEMPLATE.json')).get('rootApproved') is False,'Private approval in source ZIP')
  output.mkdir()
  for name in names:
   p=under(output,name,True);p.parent.mkdir(parents=True,exist_ok=True);safe(p,True)
   with p.open('xb') as f:f.write(z.read(name))
 return {'status':'SOURCE_INPUTS_EXTRACTED_ONLY','files':len(names),'nativeActions':0}
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('operation',choices=['pack','extract']);p.add_argument('--output',required=True,type=Path)
 for name in ['e-root','e-base-root','forms-root','app-root','persistent-root','archive']:p.add_argument('--'+name,type=Path)
 p.add_argument('--expected-archive-sha');p.add_argument('--expected-manifest-sha');a=p.parse_args()
 try:
  if a.operation=='pack':result=package(e_root=a.e_root,e_base_root=a.e_base_root,forms_root=a.forms_root,app_root=a.app_root,persistent_root=a.persistent_root,output=a.output)
  else:result=unpack(a.archive,a.output,a.expected_archive_sha,a.expected_manifest_sha)
  print(json.dumps(result,ensure_ascii=False));return 0
 except (Refused,OSError,ValueError,KeyError,TypeError) as e:print(json.dumps({'status':'REFUSED','reason':str(e)},ensure_ascii=False));return 2
if __name__=='__main__':sys.exit(main())
