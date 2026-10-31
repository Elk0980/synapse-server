"""Fresh current-runtime/static-only delivery. No build/up/restart/restore/SQL writes.

The expired R7 acceptance remains refused. This companion admits a new, bounded
static/UI operation after an explicit full current-state read and closed historical
drift classification. The original runtime helper and journals stay immutable.
"""
import importlib.util,json,os,sys,time,contextlib,hashlib
from pathlib import Path

NAME='palitra-auth-chat-static-current-20261031-r1'
AREA=Path('/opt/synapse/releases')/NAME
ORIGINAL=Path('/root/palitra-auth-chat-production-20261031-r7.py')
MAIN_SHA='473028a50555fced995708ece843b9695fb4d5c0ee88d282c2ca806436e68838'
MANIFEST_SHA='7ed89e7d55b7919605c597b62ebbc933507dfa1f90d969cc5e920f51dafa0427'
IMAGE='sha256:53fcc6b81e2b68a782fdb58a0fa1a66e5ad3277dfc90fc08fd02cfb70ebfea26'
KIND='FRESH_CURRENT_RUNTIME_FOR_STATIC_ONLY_V1'
SELF=Path(__file__).resolve()

def load_module(path,name):
 spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec);sys.modules[name]=value;spec.loader.exec_module(value);return value

def engine():
 # Validate the known source BEFORE import. Original package() rechecks root,
 # canonical paths, full manifest/support/payload pins on every guard.
 if ORIGINAL.is_symlink()or hashlib.sha256(ORIGINAL.read_bytes()).hexdigest()!=MAIN_SHA:raise ValueError('EXACT_FROZEN_R7_HELPER_REQUIRED')
 s=load_module(ORIGINAL,'static_current_original');s.package()
 s.need(s.sha(s.safe_read(s.AREA/'manifest.json'))==MANIFEST_SHA,'EXACT_FROZEN_R7_MANIFEST_REQUIRED')
 c=load_module(ORIGINAL,'static_current_context')
 c.NAME=NAME;c.AREA=AREA
 c.package=s.package;c.module=s.module;c.backup_guard=s.backup_guard;c.managed_guard=s.managed_guard;c.diagnostic_policy=s.diagnostic_policy
 # New diagnostic journal, unchanged capture/compare/WINDOW/generation logic.
 c.static_guard=lambda phase,readback=False,history_full=False:guard(s,c,phase,readback,history_full)
 return s,c

def own_files(s):
 manifest=s.load(SELF.parent/'companion-pins.json')
 s.need(set(manifest)=={'current.py','drift.py','verify.py'},'CLOSED_STATIC_COMPANION_FILES')
 for name,pin in manifest.items():
  raw=s.safe_read(SELF.parent/name);s.need(s.sha(raw)==pin['sha256']and len(raw)==pin['bytes'],'STATIC_COMPANION_SOURCE_CHANGED')
 return s.sha(s.safe_read(SELF.parent/'companion-pins.json'))

def reference(s):
 s.diagnostic_history(s.load(s.AREA/'base.json'))
 return {name:s.sha(s.safe_read(s.AREA/name))for name in('base.json','prepared.json','diagnostic-observations/head.json','child.json','history-witness.json','history-ready.json','backups.json','apply-intent.json','up-returned.json','auth-outcome-schema-init-intent.json','auth-outcome-schema-init-observed.json')}

def envelope(s,manifest,rows):
 base=s.load(s.AREA/'base.json');child=s.load(s.AREA/'child.json')
 s.need(child['image']==IMAGE and rows[s.CONTENT]['Image']==IMAGE,'EXACT_CURRENT_INSTALLED_IMAGE_REQUIRED')
 s.built_image_guard(base,manifest,child);want=s.expected_tree(base,manifest);actual=s.runtime_tree(rows[s.CONTENT]);s.source_phase_tree(actual,True)
 s.need(actual==want and s.image_tree(child['image'])==want,'STATIC_COMPLETE_RUNTIME_TREE_CHANGED')
 for n in s.CONTAINERS:
  if n!=s.CONTENT:s.need(s.foreign(rows[n])==s.foreign(base['rows'][n]),'STATIC_FOREIGN_CONTAINER_CHANGED')
 s.need(s.normalize_content(rows[s.CONTENT])==s.normalize_content(base['rows'][s.CONTENT]),'STATIC_RUNTIME_CONFIG_CHANGED')
 images=dict(manifest['expectedImages']);images[s.CONTENT]=child['image'];plan=s.effective_plan(rows,images);s.need(plan==s.validated_plan(base,child),'STATIC_EFFECTIVE_PLAN_CHANGED')
 s.need(s.policy_state()==base['policy']and s.price_pin()==base['price'],'STATIC_POLICY_PRICE_CHANGED');s.source_review_guard(rows,want,True)
 return base,want,plan

def classify_history(s,base,rows,paths):
 d=load_module(SELF.parent/'drift.py','static_current_drift');backups=s.load(s.AREA/'backups.json');s.backup_guard();result={}
 for role,name in ((s.CRM,'crm'),(s.CONTENT,'content')):
  tree=s.runtime_tree(rows[role]);s.need(all(tree.get(n,{}).get('sha256')==pin for n,pin in d.WRITERS[name].items()),'EXACT_OBSERVED_BACKGROUND_WRITER_SOURCE_REQUIRED')
 for key,row in paths.items():
  s.need(s.db_identity(row['hostPath'])==row['identity'],'HISTORICAL_DATABASE_IDENTITY_CHANGED')
  if key not in('content:/data/content.sqlite','crm:/data/crm.sqlite'):
   s.assert_preserved_path(row,base['databaseFacts'][key],after=True);continue
  with contextlib.ExitStack()as stack:
   live=stack.enter_context(s.db_open(row['hostPath']));old=stack.enter_context(s.db_open(backups[key]['path']));full=s.db_facts(live);prior=s.db_facts(old);end=time.time()
   if key.startswith('crm:'):
    s.need(s.enc(prior)==s.enc(base['databaseFacts'][key]),'EXACT_HISTORICAL_CRM_BACKUP_REQUIRED')
    a={t:d.records(s,old,t)for t in d.CRM_TABLES};b={t:d.records(s,live,t)for t in d.CRM_TABLES}
    result['crm']=d.crm(s,prior,full,a,b,base['created'],end)
   else:
    full=s.module('migration_guard.py').normalize(full,row['containerPath'],s.load(s.AREA/'migration-schema.json'),base['databaseFacts'][key])
    obs=s.diagnostic_policy().capture(live,s.env_map(rows[s.CONTENT]),full)
    result['content']=d.content(s,base['databaseFacts'][key],full,base['diagnosticBase'],obs,d.records(s,old,'ai_balance_snapshots'),d.records(s,live,'ai_balance_snapshots'),base['created'],end)
  s.need(s.db_identity(row['hostPath'])==row['identity'],'HISTORICAL_DATABASE_IDENTITY_CHANGED_AT_END')
 return result

def prepare(s,c):
 staged,manifest=s.package();pin=own_files(s);lease=s.own_lease();s.need(not os.path.lexists(AREA),'CURRENT_STATIC_NAMESPACE_EXISTS_INSPECT_ONLY')
 rows={n:s.inspect_container(n)for n in s.CONTAINERS};old,tree,plan=envelope(s,manifest,rows);refs=reference(s)
 paths=s.database_paths(rows,manifest);s.need(paths==old['databases'],'STATIC_DATABASE_PATHS_CHANGED');s.managed_guard(paths,True);s.module('host_static.py').expect(s,old,0)
 classified=classify_history(s,old,rows,paths)
 queues=s.startup_guard(paths,rows,time.time()+s.APPLY_TTL+s.GRACE);diag={};facts=s.snapshot_databases(paths,diag,s.env_map(rows[s.CONTENT]))
 # Revalidate historical classification around capture; fresh facts must be
 # byte-exact on both current-state sweeps, except original diagnostic policy.
 s.need(classify_history(s,old,rows,paths)==classified,'HISTORICAL_CLASSIFICATION_CHANGED_DURING_CURRENT_CAPTURE')
 s.need(reference(s)==refs and s.own_lease()==lease,'CURRENT_CAPTURE_REFERENCE_OR_LEASE_CHANGED')
 AREA.mkdir(mode=0o700);(AREA/'static-payload').mkdir(mode=0o700)
 for name in s.STATIC_NAMES.values():s.write_new(AREA/'static-payload'/name,s.safe_read(s.AREA/'static-payload'/name))
 now=time.time();proof={'kind':KIND,'status':'FRESH_CURRENT_AFTER_STATIC_SCOPE_ONLY','at':now,'expires':now+s.PREPARE_TTL,'lease':lease,'companionPinsSha256':pin,'originalReference':refs,'originalExpiredAcceptanceReplaced':False,'historicalClassification':classified,'identities':{n:s.sha(s.enc(s.foreign(r)))for n,r in rows.items()},'image':IMAGE}
 proof_raw=s.enc(proof);s.write_new(AREA/'current-after.json',proof_raw)
 base={'lease':lease,'created':now,'expires':now+s.PREPARE_TTL,'rows':rows,'tree':tree,'databases':paths,'databaseFacts':facts,'diagnosticBase':diag,'hostStatic':old['hostStatic'],'static':old['static'],'plan':plan,'managed':s.managed_guard(paths),'policy':old['policy'],'price':old['price'],'queueProof':queues,'currentAfterSha256':s.sha(proof_raw),'originalReference':refs,'companionPinsSha256':pin}
 (AREA/'static-layer').mkdir(mode=0o700);raw=s.enc(base);s.write_new(AREA/'static-base.json',raw);genesis=c.diagnostic_init(base,s.sha(raw),True);s.write_new(AREA/'static-layer/prepared.json',s.enc({'baseSha256':s.sha(raw),'diagnosticGenesisSha256':genesis,'stageManifestSha256':staged['manifestSha256']}));s.sync_dir(AREA/'static-layer');s.sync_dir(AREA)
 guard(s,c,0,False,True)
 s.write_new(AREA/'current-after-accepted.json',s.enc({'kind':KIND,'status':'FRESH_CURRENT_AFTER_READBACK_PASS','currentAfterSha256':s.sha(proof_raw),'staticBaseSha256':s.sha(raw),'originalReference':refs,'companionPinsSha256':pin,'at':time.time()}));s.sync_dir(AREA)
 return {'kind':KIND,'status':'FRESH_STATIC_CONTEXT_ACCEPTED_NOT_INSTALLED','expires':base['expires'],'backendReapplied':False}

def guard(s,c,phase,readback=False,history_full=False):
 staged,manifest=s.package();s.need(type(phase)is int and phase in(0,1,2),'STATIC_CLOSED_PHASE');own=s.own_lease();pin=own_files(s);base=s.load(AREA/'static-base.json');prepared=s.load(AREA/'static-layer/prepared.json');proof=s.load(AREA/'current-after.json')
 s.need(s.sha(s.safe_read(AREA/'static-base.json'))==prepared['baseSha256']and staged['manifestSha256']==prepared['stageManifestSha256'],'STATIC_ANCHOR_PIN_CHANGED')
 s.need(own==base['lease']==proof['lease'],'STATIC_FRESH_OWN_LEASE_REQUIRED');s.need(readback or base['created']<=time.time()<base['expires'],'STATIC_ANCHOR_EXPIRED')
 s.need(proof['kind']==KIND and proof['status']=='FRESH_CURRENT_AFTER_STATIC_SCOPE_ONLY'and proof['originalExpiredAcceptanceReplaced']is False and pin==proof['companionPinsSha256']==base['companionPinsSha256'],'EXPLICIT_FRESH_STATIC_PROVENANCE_REQUIRED')
 s.need(s.sha(s.safe_read(AREA/'current-after.json'))==base['currentAfterSha256']and reference(s)==base['originalReference']==proof['originalReference'],'CURRENT_STATIC_OR_ORIGINAL_REFERENCE_CHANGED')
 rows={n:s.inspect_container(n)for n in s.CONTAINERS};old,tree,plan=envelope(s,manifest,rows)
 s.need(all(s.sha(s.enc(s.foreign(rows[n])))==proof['identities'][n]for n in s.CONTAINERS),'FRESH_STATIC_FIVE_IDENTITIES_CHANGED')
 s.need(tree==base['tree']and plan==base['plan'],'STATIC_CODE_PLAN_CHANGED');s.module('host_static.py').expect(c,base,phase);s.backup_guard()
 paths=s.database_paths(rows,manifest);s.need(paths==base['databases'],'STATIC_DATABASE_PATHS_CHANGED');s.need(s.managed_guard(paths,history_full)==base['managed'],'STATIC_MANAGED_WITNESS_CHANGED')
 for key,row in paths.items():c.assert_preserved_path(row,base['databaseFacts'][key],base,rows,False,True)
 s.startup_guard(paths,rows,time.time()+s.APPLY_TTL+s.GRACE)
 for key,row in paths.items():c.assert_preserved_path(row,base['databaseFacts'][key],base,rows,False,True)
 s.module('host_static.py').expect(c,base,phase);s.need(all(s.foreign(s.inspect_container(n))==s.foreign(rows[n])for n in s.CONTAINERS),'STATIC_CONTAINER_CHANGED_DURING_GUARD');return base

def main():
 s,c=engine();s.need(os.name=='posix'and os.geteuid()==0,'NATIVE_LINUX_ROOT_ONLY');os.umask(0o077);mode=sys.argv[1]
 if mode=='prepare':result=prepare(s,c)
 elif mode in('host','shell'):
  a=s.load(AREA/'current-after-accepted.json');s.need(a['kind']==KIND and a['status']=='FRESH_CURRENT_AFTER_READBACK_PASS'and a['currentAfterSha256']==s.sha(s.safe_read(AREA/'current-after.json'))and a['staticBaseSha256']==s.sha(s.safe_read(AREA/'static-base.json')),'FRESH_STATIC_ACCEPTANCE_REQUIRED');result=s.module('host_static.py').write_one(c,0 if mode=='host'else 1)
 elif mode=='inspect':
  result=s.module('host_static.py').inspect(c,True);s.write_new(AREA/'static-complete.json',s.enc({**result,'kind':KIND,'currentAfterSha256':s.sha(s.safe_read(AREA/'current-after.json')),'staticBaseSha256':s.sha(s.safe_read(AREA/'static-base.json')),'at':time.time()}))
 else:raise ValueError('STATIC_ONLY_KNOWN_MODE_REQUIRED')
 print(json.dumps(result),flush=True)

if __name__=='__main__':
 try:main()
 except Exception as e:
  print('REFUSED_STATIC_CURRENT_INSPECT_ONLY: '+str(e)if isinstance(e,ValueError)else'REFUSED_STATIC_CURRENT_INSPECT_ONLY',file=sys.stderr);sys.exit(2)
