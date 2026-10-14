"""Combine exact accepted sources with a separately Root-approved native capture.
Creates source/context files only. Never calls Docker, edits a DB or activates flags.
"""
import argparse,re,sys,zipfile
from pathlib import Path
from release_common import *
from native_release import CRM_FILES, ALLOWED, APP_FILES, APP_RUNTIME
PERSISTENT_BASE='cdbf01c92288e265182422681aa6187adc15fd38392a7d4c6a75992576223d6b'
PERSISTENT_CANDIDATE='21a580435921e399d1c27465b3856a05838ec70478f0f557c2068bc56dd7c493'
PERSISTENT_PATCH='2cfa4ad5169091a6405cd43804dba125d2be67ac8e444202b391186f43dc5f2e'
FORMS_PUBLIC=['index.html','app.js','project-forms-api.js','form-builder.js','menu-builder.js','flow-canvas.js','style.css','form-builder.css','menu-builder.css','flow-canvas.css','assets/catalog-filters.js','assets/catalog-mobile.html','assets/catalog-site.css','assets/editor-fonts.css','assets/website-catalog.png','assets/k01-celebration-bg.png','assets/k01-celebration-bg-v1.png']
def forms_public(name):return name in FORMS_PUBLIC or bool(re.fullmatch(r'assets/fonts/(inter|lora|montserrat|nunito-sans|open-sans|roboto)/[a-z-]+\.ttf|assets/fonts/(inter|lora|montserrat|nunito-sans|open-sans|roboto)/OFL\.txt',name))
E_IMAGE=['content/'+n for n in ['server.js','client-dialogs.js','palitra-host-adapter.cjs','customer-chat.js','customer-chat-http.cjs','customer-chat-native-adapter.cjs','customer-chat-media.cjs','customer-chat-upload.cjs']]+['content/palitra-review-public/'+n for n in ['palitra-chat.html','palitra-chat.js','palitra-chat.css']]
E_WORKER='ops/chat/client-bot-bridge.js'
E_CABINET=['sites/synapse/cabinet/palitra-work.'+x for x in ['html','js','css']]
E_ORDER='managed-site/assets/order.js'
FORMS_ANCHORS=[
("const { createPalitraTaskReview } = require('./palitra-task-review.cjs');","const { createPalitraTaskReview } = require('./palitra-task-review.cjs');\nconst { createProjectFormsFeature } = require('./project-forms.cjs');"),
('// PALITRA-REVIEW39-WIRING:INIT:END','// PALITRA-REVIEW39-WIRING:INIT:END\nconst projectForms = createProjectFormsFeature({ db, requireSession, requireCsrf, readJson });'),
("    // PALITRA-CRM: /api/crm/* и /palitra-app/* только на точном хосте приложения Synapse; CRM выключена — false.","    // Private namespace precedes public hosts/generic content/OPTIONS.\n    const projectFormsUrl = new URL(request.url, 'http://localhost');\n    if (await projectForms.handle(request, projectFormsUrl, (status, payload, extra) => send(response, status, payload, extra))) return;\n    // PALITRA-CRM: /api/crm/* и /palitra-app/* только на точном хосте приложения Synapse; CRM выключена — false.")]
CABINET_ANCHORS=[
('<a class="nav-link" id="hugh-link" href="#hugh" data-view-link="hugh">Хью</a>','<a class="nav-link" id="hugh-link" href="#hugh" data-view-link="hugh">Хью</a>\n      <a class="nav-link" id="project-forms-link" href="#project-forms" data-view-link="project-forms" hidden>Формы проектов</a>'),
('<section class="view-panel" id="hugh-view" data-view="hugh" hidden></section>','<section class="view-panel" id="hugh-view" data-view="hugh" hidden></section>\n    <section class="view-panel" id="project-forms-view" data-view="project-forms" hidden></section>'),
('"hugh", "project-chat", "analytics",','"hugh", "project-chat", "project-forms", "analytics",'),
('    hugh: "Хью",','    hugh: "Хью",\n    "project-forms": "Формы проектов",'),
('  const permittedView = (value) => {','  const permittedView = (value) => {\n    if (value === "project-forms") return identity?.role === "owner";'),
('      byId("hugh-link").hidden = !permittedView("hugh");','      byId("hugh-link").hidden = !permittedView("hugh");\n      byId("project-forms-link").hidden = !permittedView("project-forms");')]
DTO_ANCHORS=[
("if (!isStaff(actor)) return { ...base, history: detail ? history('order', row.id, actor) : undefined };","if (!isStaff(actor)) return { ...base, siteOrderId: row.site_order_id ?? null, history: detail ? history('order', row.id, actor) : undefined };"),
("SELECT id,created_at,status FROM palitra_crm_inquiries WHERE company_code=? AND principal_provider=? AND principal_subject=? AND status='open' ORDER BY id DESC","SELECT id,created_at,status,site_order_id FROM palitra_crm_inquiries WHERE company_code=? AND principal_provider=? AND principal_subject=? AND status='open' ORDER BY id DESC"),
(".map((r) => ({ id: r.id, createdAt: r.created_at, status: 'received' })) : [];",".map((r) => ({ id: r.id, createdAt: r.created_at, status: 'received', siteOrderId: r.site_order_id ?? null })) : [];")]
def validate_capture(root,approval,snapshots):
 cap=load(root/'capture-manifest.json');raw=read(root/'capture-manifest.json');snapshots[root/'capture-manifest.json']=sha(raw)
 need(approval.get('rootApproved') is True and approval.get('schema')==1,'Explicit Root approval required')
 need(approval.get('captureSha256')==sha(raw),'Independent capture pin mismatch')
 need(cap.get('content_image')==approval.get('contentImage')==CONTENT,'Content image pin mismatch')
 need(cap.get('worker_image')==approval.get('workerImage')==WORKER,'Worker image pin mismatch')
 need(cap.get('managed_pending') is False and cap.get('managed_root')==approval.get('managedRoot'),'Full managed root capture required')
 need(approval.get('origins')=={'cabinet':'https://synapse.synapsebusiness.ru','customer':'https://palitra-love.ru'},'Unknown/unverified origin')
 need(approval.get('leasePath')=='/opt/synapse/.palitra-app-release.lock' and type(approval.get('leasePid')) is int and approval['leasePid']>0,'Independent Root lease proof required')
 need(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}',approval.get('releaseId','')),'Unique release id required')
 inventory={}
 for row in cap['inventory']:
  target=row['target'];relative(target);need(target not in inventory,'Duplicate capture target');relative(row['source'])
  if row['sha256'] is None:need(row['absent'] is True and not under(root,row['source'],True).exists(),'Absence changed');data=None
  else:data=source_file(root,row['source'],row['sha256'],snapshots);need(len(data)==row['bytes'] and row['absent'] is False,'Capture byte count mismatch')
  inventory[target]=(row,data)
 for target,pin in {**MAIN,'content/server.js':SERVER}.items():need(inventory.get(target,({},None))[0].get('sha256')==pin,'Current Main/server pin mismatch: '+target)
 for target in ['content/site-orders.js','content/draft-account-service.cjs']:
  need(inventory.get(target,({},None))[1] is not None,'Required preserved module absent')
 need(cap.get('absenceProof',{}).get('twice_checked') is True,'Double-read capture missing')
 expected={'content/'+n for n in ALLOWED['synapse-content-1'] if n!='project-forms.cjs' and n not in APP_RUNTIME} | {'ops/chat/client-bot-bridge.js','managed-site/assets/order.js','sites/synapse/cabinet.html','sites/synapse/cabinet/menu-preferences.js','sites/synapse/cabinet/module-guide.js',*E_CABINET}
 need(set(inventory)==expected,'Incomplete/extra native capture inventory')
 return cap,inventory
def prepare(*,e_root,e_base_root,forms_root,app_root,persistent_root,capture_root,approval_path,output,crm_root=None):
 roots=[safe(Path(p).absolute()) for p in [e_root,e_base_root,forms_root,app_root,persistent_root,capture_root]]
 e_root,e_base_root,forms_root,app_root,persistent_root,capture_root=roots;output=safe(Path(output).absolute(),True);approval_path=Path(approval_path).absolute()
 need(not output.exists() and output.parent.is_dir(),'Output must be new with existing parent')
 for root in roots:need(not output.resolve(strict=False).is_relative_to(root.resolve()),'Output intersects source')
 snapshots={};approval=load(approval_path);snapshots[Path(approval_path)]=sha(read(approval_path))
 cap,inventory=validate_capture(capture_root,approval,snapshots)
 app_manifest=app_root.parent/'FREEZE.json'
 if not app_manifest.exists():app_manifest=app_root.parent/'QA_ROOT/K01_APP_SYNC_0146/FREEZE.json'
 manifests={'e':e_root/'source-manifest.json','forms':forms_root/'integration-manifest.json','app':app_manifest,'persistent':persistent_root/'persistent-route-source.json'}
 for name,p in manifests.items():need(approval.get('sourcePins',{}).get(name)==sha(read(p)),'Independent approved source pin missing: '+name);snapshots[p]=sha(read(p))
 e=load(manifests['e']);fm=load(manifests['forms']);app=load(manifests['app']);need(e.get('approved_finished') is True and app.get('frozen') is True,'Source not frozen/finished')
 ps=load(manifests['persistent']);need(ps['acceptedSourceSHA256']==PERSISTENT_BASE and ps['candidateSHA256']==PERSISTENT_CANDIDATE and ps['patchSHA256']==PERSISTENT_PATCH,'Persistent source guard changed')
 need(ps['runtimeRoot']=='/app/palitra-orders-public' and ps['routePrefix']=='/love-app' and set(ps['files'])==set(APP_FILES) and len(ps['files'])==26 and set(ps['exactPaths'])=={'/love-app/'+n for n in APP_FILES},'Persistent exact26 map changed')
 persistent=source_file(persistent_root,'palitra-host-adapter-persistent.cjs',PERSISTENT_CANDIDATE,snapshots);source_file(persistent_root,'persistent-app-route.patch',PERSISTENT_PATCH,snapshots)
 rows={}
 for row in e['targets']:need(row['target'] not in rows,'Duplicate E target');rows[row['target']]=row
 need(set(rows)==set(E_IMAGE+[E_WORKER,E_ORDER]+E_CABINET),'E exact16 required')
 payload={};content=[];statics=[];worker=[]
 def add(name,data):relative(name);need(name not in payload,'Duplicate payload');payload[name]=data;return name
 def runtime(target,data):
  base=inventory.get(target,({},None))[0].get('sha256');p=add('payload/'+target,data)
  if base!=sha(data):content.append({'target':target.removeprefix('content/'),'payload':p,'sha256':sha(data),'baseSha256':base})
 def static(group,name,data,base=None):
  p=add('payload/static/'+group+'/'+name,data);statics.append({'group':group,'target':name,'payload':p,'sha256':sha(data),'baseSha256':base})
 existing=['server.js','client-dialogs.js','palitra-host-adapter.cjs']
 for name in existing:
  b=read(e_base_root/name);snapshots[e_base_root/name]=sha(b);need(inventory['content/'+name][1]==b,'Accepted E baseline differs from actual current source: '+name)
 for target in E_IMAGE:
  row=rows[target];data=source_file(e_root,row['source'],row['sha256'],snapshots);need(len(data)==row['bytes'],'E bytes mismatch')
  if target not in ['content/'+n for n in existing]:need(inventory.get(target,({},None))[1] is None,'New E target already exists; unknown execution')
  if target=='content/server.js':
   need(sha(data)==fm['expectedReferenceSha256'],'Forms E reference changed')
   for a,b in FORMS_ANCHORS:data=replace_once(data,a,b)
  if target=='content/palitra-host-adapter.cjs':need(sha(data)==PERSISTENT_BASE,'Accepted E host guard changed');data=persistent
  runtime(target,data)
 forms=fm['sourceFiles'];data=source_file(forms_root,'content/project-forms.cjs',forms['content/project-forms.cjs'],snapshots);runtime('content/project-forms.cjs',data)
 crm=[(t,v) for t,v in inventory.items() if t.startswith('content/palitra-crm/')]
 need(len(crm)==17,'CRM17 complete inventory required')
 present=sum(data is not None for _,(_,data) in crm);need(present in [0,17],'Partial CRM inventory: refuse unknown execution')
 if present==0:
  need(crm_root is not None,'CRM17 absent: explicit approved --crm-root/manifest pin required')
  crm_root=safe(Path(crm_root).absolute());need(not output.resolve(strict=False).is_relative_to(crm_root.resolve()),'Output intersects CRM source');p=crm_root/'manifest.json';need(sha(read(p))==approval.get('sourcePins',{}).get('crm'),'Independent accepted CRM source pin required');snapshots[p]=sha(read(p));cm=load(p)
  approved={r['relativepath']:r for r in cm['files']}
  crm_sources={}
  for name in CRM_FILES:
   source='payload/content/'+name;need(source in approved,'Accepted CRM17 source missing');r=approved[source];b=source_file(crm_root,source,r['sha256'],snapshots);need(len(b)==r['bytes'],'CRM source bytes mismatch');crm_sources['content/'+name]=b
  for t,b in crm_sources.items():
   if t!='content/palitra-crm/app/lib/workspace.js':runtime(t,b)
  data=crm_sources['content/palitra-crm/app/lib/workspace.js']
 else:data=inventory['content/palitra-crm/app/lib/workspace.js'][1]
 target='content/palitra-crm/app/lib/workspace.js'
 for a,b in DTO_ANCHORS:data=replace_once(data,a,b)
 if sha(data)!=inventory[target][0]['sha256']:runtime(target,data)
 row=rows[E_WORKER];data=source_file(e_root,row['source'],row['sha256'],snapshots);base=inventory[E_WORKER][0]['sha256']
 if sha(data)!=base:worker.append({'target':'client-bot-bridge.js','payload':add('payload/'+E_WORKER,data),'sha256':sha(data),'baseSha256':base})
 for target in E_CABINET:
  row=rows[target];data=source_file(e_root,row['source'],row['sha256'],snapshots);static('cabinet',target.removeprefix('sites/synapse/'),data,inventory[target][0]['sha256'])
 row=rows[E_ORDER];data=source_file(e_root,row['source'],row['sha256'],snapshots)
 need(row['sha256']=='230f1c13bf7a78bb4f0c6d19455d1dcad39384ad0d3b600c48ce43d2018b6553','Accepted managed order source changed')
 base=inventory[E_ORDER][0]['sha256'];need(base in ['f3fb7853f8c3db9e2897bbfb497624ac18a6dad7df0bfbddc02e0c8586782173',row['sha256']],'Managed order BASE pin mismatch')
 static('customer','assets/order.js',data,base)
 data=inventory['sites/synapse/cabinet.html'][1]
 for a,b in CABINET_ANCHORS:data=replace_once(data,a,b)
 static('cabinet','cabinet.html',data,inventory['sites/synapse/cabinet.html'][0]['sha256'])
 static('cabinet','cabinet/project-forms.js',source_file(forms_root,'cabinet/project-forms.js',forms['cabinet/project-forms.js'],snapshots))
 for name,pin in forms.items():
  if name.startswith('dist/'):
   if name=='dist/assets/k01-celebration-bg-v1.png':
    # Historical, unreferenced photo kept in the frozen source inventory; not deployed.
    source_file(forms_root,name,pin,snapshots);continue
   relative(name);need(forms_public(name[5:]),'Unexpected Forms public file');need(Path(name).name not in ['project.json','history.json'],'Private model refused');static('cabinet','cabinet/project-forms/'+name[5:],source_file(forms_root,name,pin,snapshots))
 appfiles={}
 for r in app['files']+[r for r in app['readonlyGuards'] if r['file'] in ['native-host.js','synapse-bridge.js','shop.html','cabinet.html']]:
  need(r['file'] not in appfiles,'Duplicate app file');appfiles[r['file']]=r['sha256']
 need(set(['native-host.js','synapse-bridge.js','shop.html','cabinet.html','shell.js','shell.css','design-data.js']).issubset(appfiles),'App entry source incomplete')
 need(set(appfiles)==set(APP_FILES)|{'cabinet.html'},'Exact customer26 plus admin entry required')
 for name,pin in appfiles.items():
  need(name in ['native-host.js','synapse-bridge.js','shop.html','cabinet.html','shell.js','shell.css','design-data.js'] or name.startswith('assets/'),'Unexpected public app source')
  data=source_file(app_root,name,pin,snapshots)
  if name=='native-host.js':
   for flag in ['network','crm','e1Native']:need(re.search(rb'\b'+flag.encode()+rb':\s*false\b',data),'Activation outside source bundle')
  if name!='cabinet.html':runtime('content/palitra-orders-public/'+name,data)
  if name!='shop.html':static('cabinet','cabinet/palitra-orders/'+name,data)
 for path in ['release_common.py','native_release.py']:add(path,read(Path(__file__).parent/path))
 df=['FROM '+CONTENT]+['COPY '+r['payload']+' /app/'+r['target'] for r in content]
 add('Dockerfile',('\n'.join(df)+'\n').encode())
 if worker:add('Dockerfile.worker',('FROM '+WORKER+'\n'+'\n'.join('COPY '+r['payload']+' /app/'+r['target'] for r in worker)+'\n').encode())
 manifest={'schema':1,'status':'SOURCE_ONLY_NOT_INSTALLED','releaseId':approval['releaseId'],'images':{'content':CONTENT,'worker':WORKER},'lease':{'path':approval['leasePath'],'pid':approval['leasePid']},'roots':{'cabinet':'/opt/synapse/sites/synapse','customer':approval['managedRoot']},'capture':cap,'content':content,'worker':worker,'static':statics,'customerStaticPlacement':'immutable-content-image:/app/palitra-orders-public','flagsEnabled':False,'dbWrites':False,'sourceFiles':{n:{'sha256':sha(b),'bytes':len(b)} for n,b in payload.items()}}
 check_snapshots(snapshots);return output,payload,manifest,snapshots
def assemble(check=False,**kwargs):
 output,payload,manifest,snapshots=prepare(**kwargs)
 if check:return {'status':'PREFLIGHT_ONLY','files':len(payload),'contentCopies':len(manifest['content']),'workerCopies':len(manifest['worker']),'staticFiles':len(manifest['static'])}
 need(not output.exists(),'Output appeared; unknown execution');output.mkdir()
 for name,data in {**payload,'manifest.json':json_bytes(manifest)}.items():
  p=under(output,name,True);p.parent.mkdir(parents=True,exist_ok=True);safe(p,True)
  with p.open('xb') as f:f.write(data)
  need(read(p)==data,'Output readback failed')
 check_snapshots(snapshots)
 archive=output.with_suffix('.zip');need(not archive.exists(),'Archive already exists')
 with zipfile.ZipFile(archive,'x',compression=zipfile.ZIP_DEFLATED) as z:
  for name in sorted([*payload,'manifest.json']):z.writestr(name,read(output/name))
 return {'status':'ASSEMBLED_SOURCE_ONLY','output':str(output),'archive':str(archive),'manifestSha256':sha(read(output/'manifest.json')),'archiveSha256':sha(read(archive,128*1024*1024)),'activation':False}
def main():
 p=argparse.ArgumentParser(description=__doc__)
 for name in ['e-root','e-base-root','forms-root','app-root','persistent-root','capture-root','approval-path','output']:p.add_argument('--'+name,required=True,type=Path)
 p.add_argument('--crm-root',type=Path,help='Required only if actual CRM17 all absent, with independent approved manifest pin')
 p.add_argument('--check',action='store_true')
 try:print(json.dumps(assemble(**vars(p.parse_args())),ensure_ascii=False))
 except (Refused,OSError,KeyError,ValueError) as e:print(json.dumps({'status':'REFUSED','reason':str(e)},ensure_ascii=False));return 2
 return 0
if __name__=='__main__':sys.exit(main())
