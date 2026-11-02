"""Isolated release delta checks; never invokes Docker, a lease or production data."""
import ast,copy,hashlib,importlib.util,io,json,sys,tarfile,tempfile,unittest
from pathlib import Path
HERE=Path(__file__).resolve().parent
OLD=HERE.parent/'palitra-attention-durable-20261030-r13'
def module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec);sys.modules[name]=value;spec.loader.exec_module(value);return value
m=module('reviewed_new_release',HERE/'install.py')
g=module('reviewed_additive_guard',HERE/'migration_guard.py')
schema=json.loads((HERE/'migration-schema.json').read_text(encoding='utf8'))
class ReleaseDelta(unittest.TestCase):
 def fake(self,path):
  value={'schema':[['table','old','old','CREATE TABLE old(id)']], 'tables':{'old':{'columns':['id'],'rows':{'oldkey':'oldvalue'}}}}
  for name,row in schema[path].items():value['schema']+=copy.deepcopy(row['objects']);value['tables'][name]={'columns':row['columns'],'rows':{}}
  value['schema'].sort(key=lambda row:(row[0],row[1]));return value
 def test_exact_four_empty_additive_schemas(self):
  for path in schema:
   clean=g.normalize(self.fake(path),path,schema)
   self.assertEqual(clean,{'schema':[['table','old','old','CREATE TABLE old(id)']], 'tables':{'old':{'columns':['id'],'rows':{'oldkey':'oldvalue'}}}})
 def test_new_business_row_is_not_normalized_away(self):
  for path,tables in schema.items():
   for name in tables:
    facts=self.fake(path);facts['tables'][name]['rows']['new']='row'
    with self.assertRaisesRegex(ValueError,'NONEMPTY'):g.normalize(facts,path,schema)
 def test_existing_business_change_remains_visible(self):
  path=g.CONTENT;before=g.normalize(self.fake(path),path,schema);facts=self.fake(path);facts['tables']['old']['rows']['oldkey']='changed'
  self.assertNotEqual(g.normalize(facts,path,schema),before)
 def test_existing_additive_business_rows_are_preserved_for_fresh_fallback(self):
  for path in schema:
   before=self.fake(path)
   for name in schema[path]:before['tables'][name]['rows']={'existing-business-key':'original-value'}
   self.assertEqual(g.normalize(before,path,schema,before),before)
   after=copy.deepcopy(before);after['tables'][next(iter(schema[path]))]['rows']['existing-business-key']='changed'
   self.assertNotEqual(g.normalize(after,path,schema,before),before)
 def test_fallback_image_targets_only_existing_three_business_view_files(self):
  f=module('reviewed_fallback_image',HERE/'fallback_image.py')
  self.assertEqual(f.NAMES,('server.js','palitra-manager-attention.cjs','site-orders.js'))
  for name in f.NAMES:
   raw=(HERE/'source-proof'/('fallback-'+name)).read_bytes()
   self.assertEqual(raw,(HERE.parent/'palitra-production-integration-20261031/fallback-r2'/name).read_bytes())
   if name!='site-orders.js':self.assertEqual(raw,(HERE.parent/'palitra-production-integration-20261031/candidate'/name).read_bytes())
 def test_extra_column_trigger_index_missing_object_refused(self):
  path=g.CONTENT;name=g.NAMES[path][0]
  for mutation in ('column','trigger','index','missing'):
   facts=self.fake(path)
   if mutation=='column':facts['tables'][name]['columns']=facts['tables'][name]['columns']+['foreign']
   elif mutation=='missing':facts['schema']=[r for r in facts['schema']if r[1]!=name]
   else:facts['schema'].append([mutation,'new',name,'foreign'])
   with self.assertRaises(ValueError):g.normalize(facts,path,schema)
 def test_foreign_database_is_never_normalized(self):
  with self.assertRaisesRegex(ValueError,'SCOPE'):g.normalize(self.fake(g.CONTENT),'/data/crm.sqlite',schema)
 def test_manifest_is_closed_and_one_explicit_new_file(self):
  manifest=json.loads((HERE/'manifest.json').read_text(encoding='utf8'));m.validate_manifest(manifest)
  self.assertEqual(manifest['helperSha256'],hashlib.sha256((HERE/'install.py').read_bytes()).hexdigest())
  self.assertEqual(len(manifest['files']),12);self.assertEqual(len(manifest['staticFiles']),2)
  self.assertEqual([r['target']for r in manifest['files']if r['beforeSha256']is None],['/app/account-auth-outcome.cjs'])
  bad=copy.deepcopy(manifest);bad['files'][0]['beforeSha256']=None
  with self.assertRaises(ValueError):m.validate_manifest(bad)
 def test_new_module_tree_and_tar_metadata(self):
  manifest=json.loads((HERE/'manifest.json').read_text(encoding='utf8'));row=next(r for r in manifest['files']if r['beforeSha256']is None)
  base={'tree':{'':{'type':'directory','mode':0o755,'uid':0,'gid':0}}};want=m.expected_tree(base,{'files':[row]})
  self.assertEqual(want['account-auth-outcome.cjs'],{'type':'file','mode':0o644,'uid':0,'gid':0,'nlink':1,'sha256':row['afterSha256'],'bytes':row['bytes']})
  stream=io.BytesIO();raw=(HERE/'payload/account-auth-outcome.cjs').read_bytes()
  with tarfile.open(fileobj=stream,mode='w',format=tarfile.USTAR_FORMAT)as tar:
   item=tarfile.TarInfo('app/account-auth-outcome.cjs');item.size=len(raw);item.mode=0o644;item.uid=item.gid=0;tar.addfile(item,io.BytesIO(raw))
  m.tar_members(stream.getvalue(),base,{'files':[row]})
  wrong=copy.deepcopy(row);wrong['target']='/app/foreign-new.cjs'
  with self.assertRaisesRegex(ValueError,'EXACT_NEW'):m.expected_tree(base,{'files':[wrong]})
 def test_all_payloads_match_tested_candidate(self):
  source=HERE.parent/'palitra-production-integration-20261031/candidate'
  for row in json.loads((HERE/'manifest.json').read_text(encoding='utf8'))['files']:
   part=row['target'].removeprefix('/app/');name={'palitra-orders-public/native-host.js':'shop-native-host.js','palitra-orders-public/shell.js':'shop-shell.js','palitra-review-public/palitra-chat.js':'palitra-chat.js'}.get(part,part)
   self.assertEqual((HERE/'payload'/part).read_bytes(),(source/name).read_bytes())
 def test_original_safety_guards_are_ast_exact(self):
  def functions(p):return {n.name:ast.dump(n,include_attributes=False)for n in ast.parse(p.read_text(encoding='utf8')).body if isinstance(n,ast.FunctionDef)}
  old=functions(OLD/'install.py');new=functions(HERE/'install.py')
  # The sole base_guard delta binds the final anchor to immutable prebuilt images.
  node=next(n for n in ast.parse((HERE/'install.py').read_text()).body if isinstance(n,ast.FunctionDef)and n.name=='base_guard');extra=[n for n in node.body if isinstance(n,ast.Expr)and 'preserve_binding'in ast.unparse(n)];self.assertEqual(len(extra),1);node.body.remove(extra[0]);new['base_guard']=ast.dump(node,include_attributes=False)
  for name in ('own_lease','foreign','canonical_host','own_network','effective_plan','policy_state','startup_guard','review_window_guard','opaque_vault_probe','settings_snapshot_binding','economy_guard','query_metadata','zero','db_facts','assert_database','backup_databases','inspect_result','static_guard'):
   self.assertEqual(new[name],old[name],name)
  old_apply=next(n for n in ast.parse((OLD/'install.py').read_text(encoding='utf8')).body if isinstance(n,ast.FunctionDef)and n.name=='apply')
  new_apply=next(n for n in ast.parse((HERE/'install.py').read_text(encoding='utf8')).body if isinstance(n,ast.FunctionDef)and n.name=='apply')
  added=[n for n in new_apply.body if isinstance(n,ast.Expr)and "fallback_image.py"in ast.unparse(n)]
  self.assertEqual(len(added),1);new_apply.body.remove(added[0]);self.assertEqual(ast.dump(old_apply,include_attributes=False),ast.dump(new_apply,include_attributes=False))
 def test_server_worker_suffix_unchanged(self):
  phase=module('reviewed_server_phase',HERE/'server_phase.py');result=phase.validate((HERE/'source-proof/server-before.js').read_bytes(),(HERE/'payload/server.js').read_bytes());self.assertEqual(result['after'],m.FILE_PINS['/app/server.js'][1])
 def test_generated_fallback_keeps_safety_and_security_sources_for337_and338(self):
  factory=module('reviewed_fallback_factory',HERE/'prepare_fallback_package.py')
  for version,static_phase in((337,0),(338,2)):
   with tempfile.TemporaryDirectory(prefix='palitra-fallback-fake-')as directory:
    out=factory.assemble('sha256:'+'a'*64,version,m.MANAGED_REV if version==337 else'b'*64,static_phase,Path(directory)/'fallback')
    fm=module('reviewed_fake_fallback_'+str(version),out/'install.py');manifest=json.loads((out/'manifest.json').read_text(encoding='utf8'));fm.validate_manifest(manifest)
    self.assertEqual(manifest['helperSha256'],hashlib.sha256((out/'install.py').read_bytes()).hexdigest())
    self.assertEqual(set(fm.FILE_PINS),{'/app/server.js','/app/palitra-manager-attention.cjs','/app/site-orders.js'})
    self.assertEqual(*fm.FILE_PINS['/app/server.js']);self.assertEqual(*fm.FILE_PINS['/app/palitra-manager-attention.cjs']);self.assertNotEqual(*fm.FILE_PINS['/app/site-orders.js'])
    self.assertEqual(fm.BASE_IMAGE,'sha256:'+'a'*64)
    for name in ('customer-chat.js','customer-chat-http.cjs','draft-account-service.cjs','account-auth-outcome.cjs','palitra-push-host.cjs','site-workspace-feature.js'):
     self.assertEqual(fm.PRESERVED_R7['/app/'+name],m.FILE_PINS['/app/'+name][1])
    functions=lambda p:{n.name:ast.dump(n,include_attributes=False)for n in ast.parse(p.read_text(encoding='utf8')).body if isinstance(n,ast.FunctionDef)}
    forward_functions=functions(HERE/'install.py');fallback_functions=functions(out/'install.py')
    for name in('startup_guard','economy_guard','own_lease','diagnostic_generation','diagnostic_observe','db_facts','assert_database','backup_databases','base_guard','inspect_result'):
     self.assertEqual(fallback_functions[name],forward_functions[name],name)
    phase=module('fake_fallback_server_phase_'+str(version),out/'server_phase.py');phase.validate((out/'source-proof/server-before.js').read_bytes(),(out/'payload/server.js').read_bytes())
    parsed=ast.parse((out/'managed_history.py').read_text(encoding='utf8'));self.assertTrue(parsed)
    self.assertEqual(fm.MANAGED_REV,m.MANAGED_REV if version==337 else'b'*64)
    self.assertNotIn("module('fallback_image.py').validate",ast.unparse(ast.parse((out/'install.py').read_text(encoding='utf8'))))
 def test_unchanged_modules_still_byte_exact(self):
  for name in ('reviewed-sql.json','reviewed-source-pins.json','inventory-review.json','economy_projection.py','vault_probe.cjs','image_archive_audit.py','diagnostic_preservation.py','host_static.py'):
   self.assertEqual((HERE/name).read_bytes(),(OLD/name).read_bytes(),name)
if __name__=='__main__':unittest.main()
