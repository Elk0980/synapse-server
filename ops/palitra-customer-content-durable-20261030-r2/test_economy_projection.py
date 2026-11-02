"""Synthetic DBs only; oracle extracts pure functions, never app factories."""
from pathlib import Path
import copy,importlib.util,itertools,json,sqlite3,subprocess,tempfile,unittest
spec=importlib.util.spec_from_file_location('ep',Path(__file__).with_name('economy_projection.py'));e=importlib.util.module_from_spec(spec);spec.loader.exec_module(e)
AT=1793293200000
ENV={'HUGH_PROVIDER_MASTER_KEY':'synthetic-master-key-32-bytes-ONLY','HUGH_FALLBACK_BUDGET_USD':'100','HUGH_FALLBACK_BUDGET_MAX_REQUESTS':'100'}
def saved(name='deepseek',cap=None):return dict(name=name,enabled=1,budget_usd_micro=cap,config_revision=1,check_state='ok',checked_revision=1,encrypted_key='SYNTHETIC',base_url='https://api.deepseek.com'if name=='deepseek'else'https://api.openai.com')
class Fixture:
 def __init__(self,item=None):
  self.item=copy.deepcopy(item or dict(at=AT,env=ENV,saved={'deepseek':saved()},spend=[],reservations=[],states={},cache=dict(revision=1,status='ok',checked_at=AT-1000,attempt_at=AT-1000,data=json.dumps({'available':True,'balances':[]}),error=''),runtime=[]))
  self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'fixture.sqlite';c=sqlite3.connect(self.path)
  c.executescript('''CREATE TABLE hugh_provider_settings(name TEXT PRIMARY KEY,enabled INTEGER,budget_usd_micro INTEGER,config_revision INTEGER,check_state TEXT,checked_revision INTEGER,encrypted_key TEXT,base_url TEXT);
CREATE TABLE ai_balance_snapshots(provider TEXT PRIMARY KEY,revision INTEGER,status TEXT,checked_at INTEGER,attempt_at INTEGER,data TEXT,error TEXT);
CREATE TABLE ai_economy_alert_state(key TEXT PRIMARY KEY,active INTEGER,episode INTEGER);
CREATE TABLE project_chat_provider_state(provider TEXT PRIMARY KEY,cooldown_until TEXT);
CREATE TABLE hugh_fallback_spend(window_start TEXT,provider TEXT,requests INTEGER,micro_usd INTEGER);
CREATE TABLE hugh_fallback_reservations(window_start TEXT,provider TEXT,micro_usd INTEGER,state TEXT);''')
  for row in self.item['saved'].values():c.execute('INSERT INTO hugh_provider_settings VALUES(:name,:enabled,:budget_usd_micro,:config_revision,:check_state,:checked_revision,:encrypted_key,:base_url)',row)
  if self.item['cache']:c.execute("INSERT INTO ai_balance_snapshots VALUES('deepseek',:revision,:status,:checked_at,:attempt_at,:data,:error)",self.item['cache'])
  for name,row in self.item['states'].items():c.execute('INSERT INTO project_chat_provider_state VALUES(?,?)',(name,row.get('cooldown_until')))
  for row in self.item['spend']:c.execute('INSERT INTO hugh_fallback_spend VALUES(:window_start,:provider,:requests,:micro_usd)',row)
  for row in self.item['reservations']:c.execute('INSERT INTO hugh_fallback_reservations VALUES(:window_start,:provider,:micro_usd,:state)',row)
  c.commit();c.close();self.c=sqlite3.connect(self.path.as_uri()+'?mode=ro',uri=True);self.c.execute('PRAGMA query_only=ON')
 def project(self,end=None):return e.project(self.c,self.item['env'],self.item['at'],end or self.item['at']+180000)
 def write(self,sql,args=()):
  c=sqlite3.connect(self.path);c.execute(sql,args);c.commit();c.close()
 def prime(self):
  for key,on in self.project()['flags'].items():
   if on:self.write('INSERT INTO ai_economy_alert_state VALUES(?,1,1)',(key,))
 def close(self):self.c.close();self.tmp.cleanup()
def oracle(cases):
 p=subprocess.run(['node',str(Path(__file__).with_name('economy-source-oracle.cjs'))],input=json.dumps(cases),text=True,capture_output=True,timeout=30)
 if p.returncode:raise AssertionError(p.stderr)
 return json.loads(p.stdout)
class Projection(unittest.TestCase):
 def test_one_possible_provider_has_stable_reserve_and_readonly_no_effect_after_prior_state_matches(self):
  f=Fixture()
  try:
   value=f.project();self.assertTrue(value['flags']['reserve']);self.assertEqual(value['wouldNewAlerts'],1)
   with self.assertRaisesRegex(ValueError,'WOULD_CHANGE_ALERT_STATE'):e.verify(f.c,f.item['env'],AT,AT+180000)
   f.prime();before=f.path.read_bytes();r=e.verify(f.c,f.item['env'],AT,AT+180000);self.assertEqual(r['wouldStateWrites'],0);self.assertEqual(before,f.path.read_bytes());self.assertEqual(f.c.total_changes,0)
  finally:f.close()
 def test_fresh_opaque_selection_resolves_real_two_provider_ambiguity_and_balance_distinction(self):
  f=Fixture()
  try:
   f.write("INSERT INTO hugh_provider_settings SELECT 'openai',enabled,budget_usd_micro,config_revision,check_state,checked_revision,encrypted_key,'https://api.openai.com'FROM hugh_provider_settings WHERE name='deepseek'")
   with self.assertRaisesRegex(ValueError,'AMBIGUOUS'):f.project()
   rows=[{'provider':name,'canDecryptAndPassRuntimeSelection':name in('deepseek','openai')}for name in e.CATALOG]
   proof={'providers':rows,'canUseBalanceAccount':True}
   self.assertFalse(e.project(f.c,f.item['env'],AT,AT+180000,proof)['flags']['reserve'])
   rows[5]['canDecryptAndPassRuntimeSelection']=False
   self.assertTrue(e.project(f.c,f.item['env'],AT,AT+180000,proof)['flags']['reserve'])
   f.write('DELETE FROM ai_balance_snapshots')
   with self.assertRaisesRegex(ValueError,'REFRESH_WOULD_REQUEST'):e.project(f.c,f.item['env'],AT,AT+180000,proof)
   proof['canUseBalanceAccount']=False
   self.assertTrue(e.project(f.c,f.item['env'],AT,AT+180000,proof)['flags']['reserve'])
   with self.assertRaisesRegex(ValueError,'PROOF_SHAPE'):e.project(f.c,f.item['env'],AT,AT+180000,{'providers':rows})
  finally:f.close()
 def test_cache_spread_override_and_unknown_root_cannot_hide_future_state_write(self):
  f=Fixture()
  try:
   f.item['cache']['data']=json.dumps({'available':False,'balances':[],'stale':True})
   self.assertFalse(oracle([f.item])[0]['wallet:deepseek'])
   for raw in [f.item['cache']['data'],json.dumps({'available':False,'balances':[],'status':'error'}),'[]','null','{"available":false,"balances":[],"available":true}']:
    f.write('UPDATE ai_balance_snapshots SET data=?',(raw,))
    with self.assertRaisesRegex(ValueError,'SPREAD_SHAPE'):f.project()
  finally:f.close()
 def test_cache_schema_revision_expiry_json_boolean_fail_closed(self):
  for case,reason in [('missing','REFRESH_WOULD_REQUEST'),('revision','REFRESH_WOULD_REQUEST'),('expiry','CACHE_EXPIRES'),('badjson','CACHE_METADATA'),('boolean','WALLET_BOOLEAN')]:
   f=Fixture()
   try:
    if case=='missing':f.write('DELETE FROM ai_balance_snapshots')
    elif case=='revision':f.write('UPDATE ai_balance_snapshots SET revision=2')
    elif case=='expiry':f.write('UPDATE ai_balance_snapshots SET attempt_at=?',(AT-500000,))
    elif case=='badjson':f.write("UPDATE ai_balance_snapshots SET data='invalid'")
    else:f.write('UPDATE ai_balance_snapshots SET data=?',(json.dumps({'available':0,'balances':[]}),))
    with self.assertRaisesRegex(ValueError,reason):f.project()
   finally:f.close()
  f=Fixture()
  try:
   f.write('DROP TABLE ai_economy_alert_state')
   with self.assertRaisesRegex(ValueError,'SCHEMA_UNKNOWN'):f.project()
  finally:f.close()
 def test_unknown_decryption_branch_is_not_assumed_ready(self):
  f=Fixture();item=copy.deepcopy(f.item);f.close();item['saved']['openai']=saved('openai');f=Fixture(item)
  try:
   with self.assertRaisesRegex(ValueError,'READY_BRANCH_AMBIGUOUS'):f.project()
   a=copy.deepcopy(item);b=copy.deepcopy(item);b['runtime']=[{'name':'deepseek'},{'name':'openai'}];out=oracle([a,b]);self.assertNotEqual(out[0]['reserve'],out[1]['reserve'])
  finally:f.close()
 def test_no_clear_or_new_alert_effects_admitted(self):
  f=Fixture()
  try:
   f.prime();f.write("INSERT INTO ai_economy_alert_state VALUES('global-limit',1,9)")
   with self.assertRaisesRegex(ValueError,'WOULD_CHANGE_ALERT_STATE:1:NEW:0'):e.verify(f.c,f.item['env'],AT,AT+180000)
  finally:f.close()
 def test_wallet_staleness_transition_refused(self):
  f=Fixture()
  try:
   f.write('UPDATE ai_balance_snapshots SET data=?,checked_at=?',(json.dumps({'available':False,'balances':[]}),AT-1750000))
   with self.assertRaisesRegex(ValueError,'WARNING_TRANSITION'):f.project()
  finally:f.close()
 def test_public_summary_has_no_raw_money_key_wallet_or_ciphertext(self):
  f=Fixture()
  try:
   f.prime();r=e.verify(f.c,f.item['env'],AT,AT+180000);self.assertEqual(set(r),{'wouldStateWrites','wouldNewAlerts','cacheHitGuaranteed','runtimeIntervalUsed'});self.assertNotIn('SYNTHETIC',json.dumps(r))
  finally:f.close()
 def test_source_extracted_thresholds_full_projection_all_crypto_outcomes(self):
  cases=[];expected=[]
  for cap,requests,spent,used,owncap in itertools.product(['0','100'],['0','10'],[0,89000000,90000000,100000000],[0,9,10],[None,100000000]):
   f=Fixture();item=copy.deepcopy(f.item);f.close();item['env'].update(HUGH_FALLBACK_BUDGET_USD=cap,HUGH_FALLBACK_BUDGET_MAX_REQUESTS=requests);item['saved']['deepseek']['budget_usd_micro']=owncap
   start=e.iso((AT//(30*e.DAY))*(30*e.DAY));item['spend']=[dict(window_start=start,provider='deepseek',requests=used,micro_usd=spent)];f=Fixture(item)
   try:value=f.project()['flags']
   finally:f.close()
   for runtime in [[],[dict(name='deepseek',budgetMicroUsd=owncap)]]:
    one=copy.deepcopy(item);one['runtime']=runtime;cases.append(one);expected.append(value)
  self.assertEqual(oracle(cases),expected)
 def test_env_replacement_and_duplicate_bounds_match_source(self):
  f=Fixture();item=copy.deepcopy(f.item);f.close();item['env'].update(HUGH_FALLBACK_PROVIDERS='deepseek,openrouter',HUGH_FALLBACK_DEEPSEEK_URL='https://api.deepseek.com',HUGH_FALLBACK_DEEPSEEK_KEY='SYNTHETIC',HUGH_FALLBACK_DEEPSEEK_MODEL='fixture',HUGH_FALLBACK_OPENROUTER_URL='https://example.invalid',HUGH_FALLBACK_OPENROUTER_KEY='SYNTHETIC',HUGH_FALLBACK_OPENROUTER_MODEL='fixture');f=Fixture(item)
  try:
   flags=f.project()['flags'];self.assertFalse(flags['reserve']);a=copy.deepcopy(item);a['runtime']=[{'name':'deepseek'},{'name':'openrouter'}];b=copy.deepcopy(item);b['runtime']=[{'name':'openrouter'},{'name':'deepseek','budgetMicroUsd':None}];self.assertEqual(oracle([a,b]),[flags,flags])
  finally:f.close()
  item['env']['HUGH_FALLBACK_PROVIDERS']='deepseek,deepseek';f=Fixture(item)
  try:
   with self.assertRaisesRegex(ValueError,'READY_BRANCH_AMBIGUOUS'):f.project()
  finally:f.close()
if __name__=='__main__':unittest.main()
