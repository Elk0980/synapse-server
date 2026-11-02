"""Offline, closed fallback assembly after the forward image has been observed.

Does not contact the server or run Docker. Every generated release must receive
its own review, immutable commit, fresh lease/prehistory/prepare/backup/readback.
The same whole-database, queue, economy, policy and company guards remain active.
"""
from pathlib import Path
import argparse,ast,copy,hashlib,json,re,shutil
HERE=Path(__file__).resolve().parent
NAME='palitra-auth-chat-fallback-20261031-r5'
sha=lambda b:hashlib.sha256(b).hexdigest()
def need(ok,why):
 if not ok:raise ValueError(why)
def dump(p,v):p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
def assign(s,n,v):
 p=r'^'+re.escape(n)+r'=.*$';need(len(re.findall(p,s,re.M))==1,'ONE_LITERAL_ASSIGNMENT');return re.sub(p,lambda _:n+'='+repr(v),s,flags=re.M)
def function(s,n,new):
 t=next(x for x in ast.parse(s).body if isinstance(x,ast.FunctionDef)and x.name==n);lines=s.splitlines(True);return ''.join(lines[:t.lineno-1])+new.rstrip()+'\n'+''.join(lines[t.end_lineno:])
def assemble(forward_image,managed_version,managed_revision,static_phase,output=None):
 need(re.fullmatch('sha256:[a-f0-9]{64}',forward_image),'ACTUAL_FORWARD_IMAGE_REQUIRED')
 need(managed_version in(337,338)and re.fullmatch('[a-f0-9]{64}',managed_revision),'ACTUAL_MANAGED_SCOPE_REQUIRED')
 need(managed_version!=337 or managed_revision=='4d8e767175cb2d3c5f06a8e61ec40ab0122113e77691776f8ef04212e75055db','EXACT337_REQUIRED')
 need(static_phase in(0,2),'COMPLETE_STATIC_PAIR_ONLY_NO_MIXED_RECOVERY')
 out=Path(output)if output else HERE.parent/NAME;need(not out.exists(),'FRESH_FALLBACK_NAMESPACE_REQUIRED');out.mkdir()
 s=(HERE/'install.py').read_text(encoding='utf8');tree=ast.parse(s)
 constants={n.targets[0].id:ast.literal_eval(n.value)for n in tree.body if isinstance(n,ast.Assign)and len(n.targets)==1 and isinstance(n.targets[0],ast.Name)and n.targets[0].id in('FILE_PINS','STATIC_PINS','PRESERVED_R7','REVIEWED_DATA_PINS')}
 forward=json.loads((HERE/'manifest.json').read_text(encoding='utf8'));need(forward_image!=forward['expectedImages']['synapse-content-1'],'FORWARD_MUST_BE_NEW')
 files=[];pins={}
 for name in ('site-orders.js',):
  target='/app/'+name;raw=(HERE/'source-proof'/('fallback-'+name)).read_bytes();prior=constants['FILE_PINS'][target][1]
  pins[target]=(prior,sha(raw));files.append({'target':target,'beforeSha256':prior,'afterSha256':sha(raw),'bytes':len(raw)})
  dest=out/'payload'/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(raw)
 staticpins={};statics=[]
 for row in forward['staticFiles']:
  target=row['target'];pin=constants['STATIC_PINS'][target][0 if static_phase==0 else 1]
  name='cab-native-host.js'if target.endswith('/native-host.js')else'cab-shell.js'
  source=HERE.parent/'palitra-production-integration-20261031'/('before'if static_phase==0 else'candidate')/name;raw=source.read_bytes();need(sha(raw)==pin,'STATIC_PHASE_SOURCE_EXACT')
  (out/'static-payload').mkdir(exist_ok=True);(out/'static-payload'/name).write_bytes(raw);staticpins[target]=(pin,pin);statics.append({'target':target,'beforeSha256':pin,'afterSha256':pin,'bytes':len(raw)})
 excluded={'fallback_image.py','managed_verify.py','source-proof/storefront-after.js','source-proof/storefront-before.js',*('source-proof/fallback-'+n for n in('server.js','palitra-manager-attention.cjs','site-orders.js'))}
 for n in constants['REVIEWED_DATA_PINS']:
  if n in excluded:continue
  dest=out/n;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(HERE/n,dest)
 (out/'source-proof/server-before.js').write_bytes((HERE/'payload/server.js').read_bytes())
 (out/'source-proof/server-after.js').write_bytes((HERE/'payload/server.js').read_bytes())
 # Whole accepted337 or338 is captured afresh, never restored or rewritten.
 mh=(out/'managed_history.py').read_text(encoding='utf8')
 if managed_version==338:
  mh=mh.replace('HISTORY_COUNT=337','HISTORY_COUNT=338').replace('==337','==338').replace("'version':337","'version':338")
  mh=mh.replace('008f75eecee63f7bd6657408d844f08f9f37472e1d1d3c81256f52505423a808','eb5e683f1a69f5a8fcc417df219b74368da36eb668c5ee9e4a90d43956c09670')
 (out/'managed_history.py').write_text(mh,encoding='utf8')
 anchor=json.loads((out/'managed-anchor.json').read_text(encoding='utf8'));anchor.update(version=managed_version,historyRecords=managed_version,revision=managed_revision,kind='Fresh fallback scope: preserve all current business data; no restore');dump(out/'managed-anchor.json',anchor)
 inventory=json.loads((out/'inventory-review.json').read_text(encoding='utf8'));inventory['sourcePins']['server.js']=constants['FILE_PINS']['/app/server.js'][1];inventory['sourcePins']['site-workspace-feature.js']=constants['FILE_PINS']['/app/site-workspace-feature.js'][1];dump(out/'inventory-review.json',inventory)
 reviewed=json.loads((out/'reviewed-source-pins.json').read_text(encoding='utf8'))
 for key in reviewed:
  role,name=key.split('/',1)
  if role=='content'and '/app/'+name in constants['FILE_PINS']:reviewed[key]=constants['FILE_PINS']['/app/'+name][1]
 dump(out/'reviewed-source-pins.json',reviewed)
 dump(out/'scope-review.json',{'kind':'Fresh security-preserving runtime-only fallback; retain exact server/manager display-v3; only order-producer snapshot enhancement removed; NOT production DONE','forwardImage':forward_image,'runtimeFiles':files,'managedVersion':managed_version,'managedRevision':managed_revision,'staticPhasePreserved':static_phase,'noDatabaseRestore':True,'sameSafetyGuards':True,'requiresIndependentReviewAndFreshExecution':True})
 phase=(out/'server_phase.py').read_text(encoding='utf8');phase=assign(phase,'BEFORE',constants['FILE_PINS']['/app/server.js'][1]);phase=assign(phase,'AFTER',constants['FILE_PINS']['/app/server.js'][1]);(out/'server_phase.py').write_text(phase,encoding='utf8')
 protected=constants['PRESERVED_R7'].copy()
 for target,(_,after)in constants['FILE_PINS'].items():
  if target not in pins:protected[target]=after
 s=assign(s,'NAME',NAME);s=assign(s,'BASE_IMAGE',forward_image);s=assign(s,'FILE_PINS',pins);s=assign(s,'STATIC_PINS',staticpins);s=assign(s,'PRESERVED_R7',protected);s=assign(s,'MANAGED_REV',managed_revision)
 s=s.replace("    module('fallback_image.py').validate(sys.modules[__name__])\n",'').replace("        elif mode=='build-fallback':module('fallback_image.py').build(sys.modules[__name__])\n",'')
 s=s.replace("FILE_PINS['/app/site-workspace-feature.js'][1 if after else 0]==tree.get('site-workspace-feature.js',{}).get('sha256')","PRESERVED_R7['/app/site-workspace-feature.js']==tree.get('site-workspace-feature.js',{}).get('sha256')")
 s=s.replace("FILE_PINS['/app/server.js'][1 if after else 0]","PRESERVED_R7['/app/server.js']").replace("FILE_PINS['/app/server.js'][0]","PRESERVED_R7['/app/server.js']")
 s=s.replace("safe_read(AREA/'payload/server.js')","safe_read(AREA/'source-proof/server-after.js')")
 s=function(s,'r7_plan_guard',"""def r7_plan_guard(plan):
    predecessor=ROOT/'releases/palitra-auth-chat-production-20261031-r5/content-image-only.json'
    need(len(plan['files'])==70 and plan['files'][-1]['path']==str(predecessor),'EXACT_FORWARD_70_ORDERED_PARENT_REQUIRED')
    need(safe_read(predecessor)==enc({'services':{'content':{'image':BASE_IMAGE}}})and sha(safe_read(predecessor))==plan['files'][-1]['sha256'],'EXACT_FORWARD_IMAGE_OVERLAY_REQUIRED')""")
 if managed_version==338:s=s.replace("anchor['version']==337","anchor['version']==338").replace("anchor['historyRecords']==337","anchor['historyRecords']==338").replace("'version':337,'revision':MANAGED_REV","'version':338,'revision':MANAGED_REV")
 updated={p.relative_to(out).as_posix():sha(p.read_bytes())for p in out.rglob('*')if p.is_file()and not str(p.relative_to(out)).startswith(('payload/','static-payload/'))}
 s=assign(s,'REVIEWED_DATA_PINS',updated);s=assign(s,'INVENTORY_REVIEW_SHA',updated['inventory-review.json']);(out/'install.py').write_text(s,encoding='utf8')
 manifest=copy.deepcopy(forward);manifest.update(packageId=NAME,helperSha256=sha((out/'install.py').read_bytes()),files=files,staticFiles=statics);manifest['expectedImages']['synapse-content-1']=forward_image;manifest['databaseInventory']['sourceReviewSha256']=updated['inventory-review.json'];dump(out/'manifest.json',manifest)
 (out/'.gitattributes').write_text('* -text\n',encoding='ascii')
 return out
if __name__=='__main__':
 a=argparse.ArgumentParser();a.add_argument('--forward-image',required=True);a.add_argument('--managed-version',type=int,choices=(337,338),required=True);a.add_argument('--managed-revision',required=True);a.add_argument('--static-phase',type=int,choices=(0,2),required=True);v=a.parse_args();print(assemble(v.forward_image,v.managed_version,v.managed_revision,v.static_phase))
