"""R2 real SQLite snapshots + real fixed source crypto; no native/Docker operations."""
from pathlib import Path
import ast,copy,importlib.util,json,sqlite3,subprocess,time,unittest
from unittest.mock import patch
import test_economy_projection as fixture
spec=importlib.util.spec_from_file_location('helper_binding',Path(__file__).with_name('install.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
ROOT=Path(__file__).parent
SOURCE='C:/Users/Vlad/Documents/Codex/AI_HANDOFF/SYNAPSE_BUSINESS/AVOKADO_SITE_PRICES_V8_20261003/RELEASE/ops/content/hugh-providers.js'
class Binding(unittest.TestCase):
 def setUp(self):
  self.f=fixture.Fixture();self.f.prime();self.f.c.close()
  c=sqlite3.connect(self.f.path);c.execute('PRAGMA journal_mode=WAL');c.execute('CREATE TABLE unrelated_business(value TEXT)');c.commit();c.close()
  self.f.c=sqlite3.connect(self.f.path.as_uri()+'?mode=ro',uri=True,isolation_level=None);self.f.c.execute('PRAGMA query_only=ON');self.f.c.execute('BEGIN');self.f.c.execute('SELECT count(*)FROM hugh_provider_settings').fetchone()
  self.env={**self.f.item['env'],'DATABASE_PATH':'/data/content.sqlite'}
  self.row={'Id':'a'*64,'Image':m.BASE_IMAGE,'Config':{'WorkingDir':'/app','Cmd':['node','server.js'],'Entrypoint':['docker-entrypoint.sh'],'Env':[k+'='+v for k,v in self.env.items()],'User':''}}
  self.rows={m.CONTENT:self.row};self.return_mutator=lambda r:r
  m._VAULT_PROOFS.clear();m._USED_VAULT_NONCES.clear()
  self.patches=[patch.object(m,'AREA',ROOT),patch.object(m,'safe_read',side_effect=lambda p:Path(p).read_bytes()),patch.object(m.time,'time',return_value=fixture.AT/1000),patch.object(m,'inspect_container',side_effect=lambda n:copy.deepcopy(self.row)),patch.object(m,'run',side_effect=self.run_probe)]
  for p in self.patches:p.start()
 def tearDown(self):
  for p in reversed(self.patches):p.stop()
  self.f.close()
 def run_probe(self,args,timeout=90):
  self.assertTrue(m.allowed_command(args));self.assertEqual(timeout,10);nonce=args[6]
  js="const{DatabaseSync}=require('node:sqlite'),fs=require('node:fs'),p=require(process.argv[1]),db=new DatabaseSync(process.argv[2],{readOnly:true});db.exec('PRAGMA query_only=ON;BEGIN');process.stdout.write(JSON.stringify(p.evaluate(fs.readFileSync(process.argv[3]),db,JSON.parse(process.argv[5]),process.argv[4])));db.close();"
  x=subprocess.run(['node','-e',js,str(ROOT/'vault_probe.cjs'),str(self.f.path),SOURCE,nonce,json.dumps(self.env)],capture_output=True,text=True,timeout=10);self.assertEqual(x.returncode,0,x.stderr)
  r=json.loads(x.stdout);r.update(databasePath='/data/content.sqlite',files=[m.vault_file_identity(self.f.path),m.vault_file_identity(str(self.f.path)+'-wal')],asOfMs=fixture.AT)
  return json.dumps(self.return_mutator(r)).encode()
 def proof(self):return m.opaque_vault_probe(self.rows,self.f.path)
 def verify(self,proof):return m.economy_guard(self.f.c,self.env,fixture.AT/1000+180,proof,self.f.path)
 def test_exact_full_cipher_snapshot_hmac_matches_real_node_and_python(self):
  p=self.proof();before=self.f.path.read_bytes();r=self.verify(p);self.assertEqual(r['wouldStateWrites'],0);self.assertFalse(r['runtimeIntervalUsed']);self.assertEqual(before,self.f.path.read_bytes())
 def test_provider_config_or_cipher_change_between_snapshots_refuses(self):
  for field,value in [('config_revision',2),('encrypted_key','SYNTHETIC_CHANGED')]:
   with self.subTest(field=field):
    self.f.write('UPDATE hugh_provider_settings SET '+field+'=?',(value,));p=self.proof()
    with self.assertRaisesRegex(ValueError,'SNAPSHOT_MISMATCH'):self.verify(p)
    self.f.write('UPDATE hugh_provider_settings SET '+field+'=?',(1 if field=='config_revision'else'SYNTHETIC',))
 def test_provider_change_after_proof_detected_by_fresh_settings_readback(self):
  p=self.proof();self.f.write("UPDATE hugh_provider_settings SET encrypted_key='SYNTHETIC_CHANGED'")
  with self.assertRaisesRegex(ValueError,'SETTINGS_CHANGED_AFTER'):self.verify(p)
 def test_unrelated_real_wal_write_keeps_scope_proof_valid_but_changes_whole_database(self):
  p=self.proof();before=m.vault_file_state(str(self.f.path)+'-wal');self.f.write("INSERT INTO unrelated_business VALUES('preserved')")
  self.assertNotEqual(before,m.vault_file_state(str(self.f.path)+'-wal'));self.assertEqual(self.verify(p)['wouldStateWrites'],0)
  # Original independent wholeDB guard still refuses the added business row.
  with m.db_open(self.f.path)as fresh:
   with self.assertRaisesRegex(ValueError,'DATABASE'):m.assert_database(fresh,m.db_facts(self.f.c))
 def test_nonce_mismatch_and_old_replayed_response_refuse(self):
  self.return_mutator=lambda r:{**r,'nonce':'0'*64}
  with self.assertRaisesRegex(ValueError,'NONCE_MISMATCH'):self.proof()
  self.return_mutator=lambda r:r;old=self.proof();self.return_mutator=lambda r:old
  with self.assertRaisesRegex(ValueError,'NONCE_MISMATCH'):self.proof()
 def test_consumed_proof_cannot_be_reused_or_manually_edited(self):
  p=self.proof();self.verify(p)
  with self.assertRaisesRegex(ValueError,'NOT_ISSUED_OR_REPLAYED'):self.verify(p)
  p=self.proof();p['canUseBalanceAccount']=True
  with self.assertRaisesRegex(ValueError,'NOT_ISSUED_OR_REPLAYED'):self.verify(p)
 def test_parent_env_source_age_and_file_identity_changes_refuse(self):
  for mutation,reason in [(lambda r:{**r,'sourceSha256':'0'*64},'PROOF_SCOPE'),(lambda r:{**r,'asOfMs':fixture.AT-10000},'PROOF_TIMESTAMP'),(lambda r:{**r,'files':[None,None]},'IDENTITY_CHANGED')]:
   self.return_mutator=mutation
   with self.assertRaisesRegex(ValueError,reason):self.proof()
  self.return_mutator=lambda r:r;p=self.proof();self.row['Config']['Env'].append('SYNTHETIC_CHANGED=true')
  with self.assertRaisesRegex(ValueError,'PARENT_OR_ENV_CHANGED'):self.verify(p)
 def test_proof_maxage_expiry_refuses_even_without_settings_change(self):
  p=self.proof()
  with patch.object(m.time,'time',return_value=fixture.AT/1000+6):
   with self.assertRaisesRegex(ValueError,'PROOF_EXPIRED'):self.verify(p)
 def test_whole_database_backup_prepare_apply_guard_source_unchanged_from_frozen_r1(self):
  old=ast.parse((ROOT.parent/'DURABLE_CONTENT_RELEASE/install.py').read_text());new=ast.parse((ROOT/'install.py').read_text());names=('db_identity','db_open','db_facts','assert_database','database_paths','prepare','backup_databases','backup_guard','apply')
  a={n.name:ast.dump(n,include_attributes=False)for n in old.body if isinstance(n,ast.FunctionDef)and n.name in names};b={n.name:ast.dump(n,include_attributes=False)for n in new.body if isinstance(n,ast.FunctionDef)and n.name in names};self.assertEqual(set(a),set(names));self.assertEqual(a,b)
if __name__=='__main__':unittest.main()
