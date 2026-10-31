"""New 4-runtime + 2-host release pipeline; inherited fixtures are read unchanged."""
from pathlib import Path
import ast,copy,hashlib,importlib.util,json,os,sys,types,unittest
from unittest.mock import patch
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent;OLD=HERE.parent/'DURABLE_CONTENT_RELEASE_R7';sys.path.insert(0,str(OLD))
import test_install as inherited
spec=importlib.util.spec_from_file_location('attention_installer_test',HERE/'install.py');m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
REAL_SOURCE_REVIEW=m.source_review_guard
class RuntimeHost(unittest.TestCase):
 def setUp(self):
  self.global_m=patch.object(inherited,'m',m);self.global_m.start();self.addCleanup(self.global_m.stop);self.f=inherited.Pipeline(methodName='runTest');self.f.store_manifest=types.MethodType(self.store_manifest,self.f);self.f.setUp();self.addCleanup(self.f.tearDown)
  self.plancheck=patch.object(m,'r7_plan_guard');self.plancheck.start();self.addCleanup(self.plancheck.stop)
  self.history=patch.object(m,'history_capture',return_value={'version':334,'revision':'a'*64,'fixture':'history independently tested'});self.history.start();self.addCleanup(self.history.stop)
  # Windows lacks POSIX fchmod. Model it only in this fresh test module's os namespace;
  # never mutate the real os module or add a production fallback/branch.
  original_loader=m.module
  def fixture_loader(name):
   loaded=original_loader(name)
   if name=='host_static.py'and os.name=='nt'and not hasattr(os,'fchmod'):
    class FixtureOs:
     def __getattr__(self,key):return getattr(os,key)
     def fchmod(self,fd,mode):
      self_test.assertIsInstance(fd,int);self_test.assertIn(mode,(0o600,0o644,0o666))
    self_test=self;loaded.os=FixtureOs()
   return loaded
  self.loader_patch=patch.object(m,'module',side_effect=fixture_loader);self.loader_patch.start();self.addCleanup(self.loader_patch.stop)

  self.f.patches.append(patch.object(m,'managed_guard',return_value={'version':334,'revision':'a'*64}));self.f.patches[-1].start()
 def store_manifest(self,f):
  if not getattr(f,'r8_ready',False):
   f.r8_ready=True;scope=json.loads((HERE/'scope-review.json').read_bytes());runtime=[r for r in scope['targets']if r['kind']=='content-runtime'];f.rows.clear();f.pins.clear()
   for row in runtime:
    rel=row['target'].removeprefix('/app/');raw=(HERE/'payload'/rel).read_bytes();path=f.area/'payload'/rel;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw);f.pins[row['target']]=(row['beforeSha256'],row['afterSha256']);f.rows.append({'target':row['target'],'beforeSha256':row['beforeSha256'],'afterSha256':row['afterSha256'],'bytes':len(raw)});f.tree[rel]={'type':'file','nlink':1,'mode':0o644,'uid':0,'gid':0,'bytes':row['beforeBytes'],'sha256':row['beforeSha256']}
   for target,pin in m.PRESERVED_R7.items():
    raw=(OLD/'payload'/target.removeprefix('/app/')).read_bytes();f.tree[target.removeprefix('/app/')]={'type':'file','nlink':1,'mode':0o644,'uid':0,'gid':0,'bytes':len(raw),'sha256':pin}
   (f.area/'static-payload').mkdir();self.staticpins={};staticrows=[]
   for i,target in enumerate(m.STATIC_TARGETS):
    path=f.root/target.removeprefix('/opt/synapse/');path.parent.mkdir(parents=True,exist_ok=True);before=('old static '+str(i)).encode();after=('new static '+str(i)).encode();path.write_bytes(before);path.chmod(0o600);(f.area/'static-payload'/m.STATIC_NAMES[target]).write_bytes(after);self.staticpins[target]=(m.sha(before),m.sha(after));staticrows.append({'target':target,'beforeSha256':m.sha(before),'afterSha256':m.sha(after),'bytes':len(after)})
   f.patches.append(patch.object(m,'STATIC_PINS',self.staticpins));f.patches[-1].start()
   for name in ['managed_history.py','host_static.py','server_phase.py','scope-review.json','managed-anchor.json','source-proof/server-before.js']:
    raw=(HERE/name).read_bytes();f.guard_data[name]=raw;path=f.area/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw);m.REVIEWED_DATA_PINS[name]=m.sha(raw)
   f.manifest['staticFiles']=staticrows;f.export=inherited.Export(f.layer(),f.image_config,attestation=True);f.child=f.export.child['Id']
  (f.area/'manifest.json').write_bytes(m.enc(f.manifest));(f.area/'stage.json').write_bytes(m.enc({'commit':'b'*40,'helperSha256':m.sha(m.SELF.read_bytes()),'manifestSha256':m.sha((f.area/'manifest.json').read_bytes()),**{n+'Sha256':m.sha(v)for n,v in f.guard_data.items()}}))
 def prepared(self):m.prehistory();m.prepare()
 def runtime_accepted(self):self.prepared();m.build();m.apply();self.assertEqual(m.inspect_result()['status'],'AFTER_INDEPENDENT_READBACK_PASS')
 def test_three_phase_delivery_old_pair_then_host_then_shell_and_fullafter(self):
  self.runtime_accepted();self.assertTrue((m.AREA/'runtime-accepted.json').exists());m.static_prepare();host=m.module('host_static.py');self.assertEqual(host.classify(m,m.load(m.AREA/'static-base.json'))[0],0);host.write_one(m,0);self.assertEqual(host.inspect(m)['phase'],1);host.write_one(m,1);self.assertEqual(host.inspect(m,True)['status'],'ATTENTION_ALL_AFTER_PASS');self.assertEqual(len([a for a in self.f.commands if'up'in a]),1)
 def test_static_anchor_requires_independent_runtime_receipt(self):
  self.prepared();m.build();m.apply()
  with self.assertRaisesRegex(ValueError,'INDEPENDENT_RUNTIME_ACCEPTANCE_REQUIRED'):m.static_prepare()
  self.assertFalse((m.AREA/'static-base.json').exists())
 def test_stage_closed_four_runtime_two_static_no_cab_image_or_extra_path(self):
  m.package();bad=copy.deepcopy(self.f.manifest);bad['files'].append({'target':m.STATIC_TARGETS[0],'beforeSha256':'a'*64,'afterSha256':'b'*64,'bytes':1})
  with self.assertRaisesRegex(ValueError,'FOUR_RUNTIME'):m.validate_manifest(bad)
  bad=copy.deepcopy(self.f.manifest);bad['staticFiles'].reverse()
  with self.assertRaisesRegex(ValueError,'TWO_HOST_STATIC'):m.validate_manifest(bad)
 def test_prehistory_and_base_bind_full_runtime_identity_code_and_host_before(self):
  m.prehistory();target=m.host_static_path(m.STATIC_TARGETS[0]);target.write_bytes(b'fresh user source changed')
  with self.assertRaisesRegex(ValueError,'HOST_BINDING'):m.prepare()
  self.assertFalse((m.AREA/'base.json').exists())
 def test_source_phase_is_exact_and_r7_protected_five_never_widened(self):
  m.source_phase_tree(self.f.tree,False)
  with self.assertRaisesRegex(ValueError,'EXACT_PHASE'):m.source_phase_tree(self.f.tree,True)
  after=self.f.aftertree();m.source_phase_tree(after,True);target=next(iter(m.PRESERVED_R7));after[target.removeprefix('/app/')]['sha256']='0'*64
  with self.assertRaisesRegex(ValueError,'R7_PROTECTED'):m.source_phase_tree(after,True)
 def test_only_runtime_four_in_layer_and_wholechild_lastlayer_scope(self):
  self.prepared();m.build();base=m.load(m.AREA/'base.json');m.tar_members(self.f.layer(),base,self.f.manifest)
  self.assertEqual(len(self.f.manifest['files']),4);self.assertTrue(all(r['target'].startswith('/app/')for r in self.f.manifest['files']));self.assertFalse(any(r['target']in m.STATIC_TARGETS for r in self.f.manifest['files']))
 def test_static_fresh_anchor_preserves_legitimate_preanchor_crm_rows_but_refuses_late_changes(self):
  self.runtime_accepted();crm=self.f.crm/'crm.sqlite'
  c=m.sqlite3.connect(crm);c.execute("UPDATE preserved SET value='legitimate before static anchor'");c.commit();c.close();m.static_prepare();m.static_guard(0)
  c=m.sqlite3.connect(crm);self.assertEqual(c.execute('SELECT value FROM preserved').fetchone()[0],'legitimate before static anchor');c.execute("UPDATE preserved SET value='later external write'");c.commit();c.close()
  with self.assertRaisesRegex(ValueError,'DATABASE_SCHEMA_OR_ROWS_CHANGED'):m.module('host_static.py').write_one(m,0)
  self.assertFalse((m.AREA/'host-static-host-intent.json').exists());self.assertEqual(len([a for a in self.f.commands if'up'in a]),1)
 def test_late_host_change_during_runtime_independent_scan_cannot_receive_acceptance(self):
  self.prepared();m.build();m.apply();original=m.managed_guard
  def changed(paths,full=False):
   result=original(paths,full)
   if full:m.host_static_path(m.STATIC_TARGETS[0]).write_bytes(b'late host source')
   return result
  with patch.object(m,'managed_guard',side_effect=changed):
   with self.assertRaises(ValueError):m.inspect_result()
  self.assertFalse((m.AREA/'runtime-accepted.json').exists())
 def test_unchanged_guard_primitives_ast_exact_r7(self):
  old=ast.parse((OLD/'install.py').read_text());new=ast.parse((HERE/'install.py').read_text());names=('db_identity','db_open','db_facts','assert_database','allowed_command','_process','run','probe_profile','runtime_tree','image_tree','foreign','review_window_guard','opaque_vault_probe','economy_guard','startup_guard','opaque_archive_facts','archive_review_state','database_paths','tar_members','audit_saved_layer','built_image_guard','validated_plan','build','apply','backup_guard','backup_databases')
  a={n.name:ast.dump(n,include_attributes=False)for n in old.body if isinstance(n,ast.FunctionDef)and n.name in names};b={n.name:ast.dump(n,include_attributes=False)for n in new.body if isinstance(n,ast.FunctionDef)and n.name in names};self.assertEqual(set(a),set(names));self.assertEqual(a,b)
 def test_server_scope_proof_and_phase_sensitive_real_source_guard(self):
  proof=m.module('server_phase.py');before=(HERE/'source-proof/server-before.js').read_bytes();after=(HERE/'payload/server.js').read_bytes();self.assertEqual(proof.validate(before,after)['after'],m.FILE_PINS['/app/server.js'][1])
  with self.assertRaisesRegex(ValueError,'PINS'):proof.validate(before,after+b'// startup changed')
  inv=json.loads((HERE/'inventory-review.json').read_bytes());inv['dataMount']=str(self.f.content);pins=json.loads((HERE/'reviewed-source-pins.json').read_bytes());tree={key.split('/',1)[1]:{'sha256':pin}for key,pin in pins.items()if key.startswith('content/')}
  for target,pin in m.PRESERVED_R7.items():tree[target.removeprefix('/app/')]={'sha256':pin}
  load=m.load
  def mocked(path):return inv if path.name=='inventory-review.json'else pins if path.name=='reviewed-source-pins.json'else load(path)
  with patch.object(m,'load',side_effect=mocked),patch.object(m,'runtime_tree',return_value={'task-dispatch.js':{'sha256':pins['crm/task-dispatch.js']}}),patch.object(m,'passive_chat_source'):
   REAL_SOURCE_REVIEW(self.f.current,tree,False)
   with self.assertRaisesRegex(ValueError,'EXACT_PHASE'):REAL_SOURCE_REVIEW(self.f.current,tree,True)
   tree['server.js']['sha256']=m.FILE_PINS['/app/server.js'][1];REAL_SOURCE_REVIEW(self.f.current,tree,True)
 def test_exact_69_predecessor_guard_refuses_reordered_or_replaced_overlay(self):
  # Original callable is recovered from the source module without executing app code.
  tree=ast.parse((HERE/'install.py').read_text());node=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='r7_plan_guard');scope=dict(vars(m));exec(compile(ast.Module(body=[node],type_ignores=[]),'r7_plan_guard','exec'),scope);call=scope['r7_plan_guard']
  path=m.ROOT/'releases/palitra-customer-content-durable-20261030-r7/content-image-only.json';path.parent.mkdir(parents=True,exist_ok=True);raw=m.enc({'services':{'content':{'image':m.BASE_IMAGE}}});path.write_bytes(raw);rows=[{'path':str(m.ROOT/('prior'+str(i))),'sha256':'a'*64}for i in range(68)]+[{'path':str(path),'sha256':m.sha(raw)}];call({'files':rows})
  with self.assertRaisesRegex(ValueError,'PREDECESSOR'):call({'files':list(reversed(rows))})
  path.write_bytes(b'other configuration')
  with self.assertRaisesRegex(ValueError,'OVERLAY'):call({'files':rows})
 def test_real_stage_fetches_exact_runtime_and_host_catalog_without_execution(self):
  files={'manifest.json':m.enc(self.f.manifest),**self.f.guard_data,**{'payload/'+r['target'].removeprefix('/app/'):(m.AREA/'payload'/r['target'].removeprefix('/app/')).read_bytes()for r in self.f.rows},**{'static-payload/'+m.STATIC_NAMES[r['target']]:(m.AREA/'static-payload'/m.STATIC_NAMES[r['target']]).read_bytes()for r in self.f.manifest['staticFiles']}}
  dest=self.f.root/'releases/new-staged-r8'
  with patch.object(m,'AREA',dest),patch.object(m.urllib.request,'urlopen',side_effect=lambda url,timeout:__import__('io').BytesIO(files[url.split('/ops/'+m.NAME+'/')[1]])):
   m.stage('b'*40,m.sha(files['manifest.json']));self.assertTrue((dest/'stage.json').exists());self.assertEqual(len(list((dest/'static-payload').iterdir())),2);self.assertFalse((dest/'base.json').exists())
 def test_manifest_assembler_uses_only_reviewed_four_plus_two_and_no_real_file_written(self):
  spec=importlib.util.spec_from_file_location('attention_assembler_test',HERE/'make_manifest.py');assembler=importlib.util.module_from_spec(spec);sys.modules[spec.name]=assembler;spec.loader.exec_module(assembler);am=assembler.m
  images={n:'sha256:'+'a'*64 for n in am.CONTAINERS};images[am.CONTENT]=am.BASE_IMAGE;inventory={'sourceReviewSha256':am.INVENTORY_REVIEW_SHA,'contentPaths':list(am.ACTIVE_DATABASE_PATHS+am.OPAQUE_ARCHIVE_PATHS),'crmPaths':['/data/crm.sqlite']};before=(HERE/'manifest.json').read_bytes()if(HERE/'manifest.json').exists()else None;value=assembler.build(images,inventory);self.assertEqual(len(value['files']),4);self.assertEqual(len(value['staticFiles']),2);self.assertEqual((HERE/'manifest.json').read_bytes()if(HERE/'manifest.json').exists()else None,before)
 def test_prehistory_witness_cannot_be_replaced_and_env_drift_requires_new_review(self):
  m.prehistory();self.f.current[m.CONTENT]['Config']['Env'].append('SYNTHETIC_CONFIG_DRIFT=true')
  with self.assertRaisesRegex(ValueError,'FRESH_BINDING'):m.prepare()
  with self.assertRaisesRegex(ValueError,'WITNESS_EXISTS'):m.prehistory()
  self.assertFalse((m.AREA/'base.json').exists())
 def test_cabinet_host_file_is_rejected_from_image_layer_even_if_regular(self):
  import io,tarfile
  stream=io.BytesIO()
  with tarfile.open(fileobj=stream,mode='w')as out:
   row=tarfile.TarInfo('opt/synapse/sites/synapse/cabinet/palitra-orders/native-host.js');row.size=3;out.addfile(row,io.BytesIO(b'bad'))
  with self.assertRaisesRegex(ValueError,'FOREIGN_OR_NONREGULAR_LAYER_FILE'):m.tar_members(stream.getvalue(),{'tree':self.f.tree},self.f.manifest)
if __name__=='__main__':unittest.main()
