from pathlib import Path
from unittest.mock import patch
import ast,copy,hashlib,importlib.util,json,tempfile,unittest,os,types

HERE=Path(__file__).resolve().parent
MAIN=HERE.parent/'palitra-auth-chat-production-20261031-r7'
LF=HERE.parent/'palitra-auth-chat-managed-20261031-r7-lf'
def module(path,name):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
m=module(MAIN/'install.py','pure_frozen_helpers');d=module(HERE/'drift.py','new_drift');v=module(HERE/'verify.py','new_verifier');cur=module(HERE/'current.py','new_current')

def facts(rows):
 out={}
 for t,values in rows.items():
  cols=list(next(iter(values.values())))if values else ['id']
  out[t]={'columns':cols,'rows':{k:m.sha(m.enc([m.cell(row[c])for c in cols]))for k,row in values.items()}}
 return {'schema':[['table',t,t,'fixed synthetic schema']for t in sorted(rows)],'tables':out}

def fixture():
 run={'id':12,'company_code':'synthetic','platform':'fixture','account_ref':'test-only','date':'1970-01-01','trigger':'schedule','status':'partial','closed':0,'started_at':'1970-01-01T00:01:40.000Z','finished_at':'1970-01-01T00:01:43.000Z'}
 e={'id':16,'company_code':'synthetic','platform':'fixture','run_id':'run-12','collected_at':'1970-01-01T00:01:41.000Z','created_at':'1970-01-01T00:01:42.000Z'}
 snap={'id':30,'company_code':'synthetic','platform':'fixture','account_ref':'test-only','value':1,'collected_at':'1970-01-01T00:01:00.000Z','run_id':11}
 q={'id':9,'company_code':'synthetic','platform':'fixture','account_ref':'test-only','date':'1970-01-01','attempts':6}
 old={'social_collect_runs':{'old':{**run,'id':11}},'social_analytics_evidence':{'old':{**e,'id':15}},'social_snapshots':{'same':snap},'social_collect_queue':{'one':q},'sqlite_sequence':{n:{'name':n,'seq':seq}for n,seq in [('social_collect_runs',11),('social_analytics_evidence',15),('social_snapshots',31)]},'customer_records':{'kept':{'id':1,'message':'synthetic preserved'}}}
 new=copy.deepcopy(old);new['social_collect_runs']['new']=run;new['social_analytics_evidence']['new']=e;new['social_snapshots']['same'].update(collected_at=e['collected_at'],run_id=12);new['social_collect_queue']={}
 for row in new['sqlite_sequence'].values():row['seq']+=1
 a=facts(old);b=facts(new);b['tables']['social_collect_queue']['columns']=a['tables']['social_collect_queue']['columns']
 return a,b,old,new

class Drift(unittest.TestCase):
 def validate(self,a,b,x,y):return d.crm(m,a,b,x,y,90,120)
 def test_closed_linked_background_delta(self):self.assertTrue(self.validate(*fixture())['sequenceThreeExactSteps'])
 def test_unknown_customer_update_and_schema_are_rejected(self):
  for kind in ('customer','schema','extra-row'):
   with self.subTest(kind=kind):
    a,b,x,y=fixture()
    if kind=='customer':b['tables']['customer_records']['rows']['kept']='bad'
    elif kind=='schema':b['schema'].append(['trigger','unexpected','customer_records','bad'])
    else:y['social_collect_runs']['another']={**y['social_collect_runs']['new'],'id':99};b=facts(y);b['tables']['social_collect_queue']['columns']=a['tables']['social_collect_queue']['columns']
    with self.assertRaises(ValueError):self.validate(a,b,x,y)
 def test_scope_evidence_queue_snapshot_and_time_negatives(self):
  cases=[('social_collect_runs','new','trigger','manual'),('social_collect_queue','one','attempts',5),('social_analytics_evidence','new','run_id','run-13'),('social_snapshots','same','value',2),('social_snapshots','same','company_code','different'),('social_collect_runs','new','finished_at','1970-01-01T01:00:00.000Z')]
  for t,k,c,value in cases:
   with self.subTest(case=(t,c)):
    a,b,x,y=fixture()
    if t=='social_collect_queue':x[t][k][c]=value;a=facts(x)
    else:y[t][k][c]=value;b=facts(y);b['tables']['social_collect_queue']['columns']=a['tables']['social_collect_queue']['columns']
    with self.assertRaises(ValueError):self.validate(a,b,x,y)
 def test_sequence_exact_step_and_rowid_required(self):
  for field in ('step','runid','unrelated-sequence'):
   with self.subTest(field=field):
    a,b,x,y=fixture()
    if field=='step':y['sqlite_sequence']['social_snapshots']['seq']+=1
    elif field=='runid':y['social_collect_runs']['new']['id']=100
    else:y['sqlite_sequence']['social_snapshots']['name']='customer_records'
    b=facts(y);b['tables']['social_collect_queue']['columns']=a['tables']['social_collect_queue']['columns']
    with self.assertRaises(ValueError):self.validate(a,b,x,y)
 def test_record_hashes_are_bound_not_disconnected_evidence(self):
  a,b,x,y=fixture();y['social_snapshots']['same']['value']=2
  with self.assertRaisesRegex(ValueError,'RECORDS_FACTS_BINDING'):self.validate(a,b,x,y)
 def test_provider_no_financial_or_revision_or_key_exception(self):
  old={'k':{'provider':'deepseek','revision':1,'status':'ok','data':'synthetic balance payload','error':'','checked_at':90000,'attempt_at':90000}};new=copy.deepcopy(old);new['k'].update(checked_at=100000,attempt_at=100000)
  self.assertTrue(d.balance(m,old,new,90,120)['payloadRevisionStatusErrorPreserved'])
  for col,val in [('provider','other'),('revision',2),('data','changed'),('error','changed'),('status','error'),('attempt_at',99999),('checked_at',130000)]:
   with self.subTest(column=col):
    bad=copy.deepcopy(new);bad['k'][col]=val
    with self.assertRaises(ValueError):d.balance(m,old,bad,90,120)
 def test_provider_future_or_regressing_clock_rejected(self):
  old={'k':{'provider':'deepseek','revision':1,'status':'ok','data':'fixture','error':'','checked_at':90000,'attempt_at':90000}}
  for t in (80000,130000):
   new=copy.deepcopy(old);new['k'].update(checked_at=t,attempt_at=t)
   with self.assertRaises(ValueError):d.balance(m,old,new,90,120)
 def test_content_unknown_business_or_schema_or_bridge_is_not_masked(self):
  old={'ai_balance_snapshots':{'k':{'provider':'deepseek','revision':1,'status':'ok','data':'fixed synthetic payload','error':'','checked_at':90000,'attempt_at':90000}},'client_bot_bridge_state':{'bridge':{'bot_key':'fixture','checked_at':'old'}},'sqlite_sequence':{'seq':{'name':'hugh_owner_alerts','seq':1}},'hugh_owner_alerts':{},'customer_records':{'one':{'id':1,'body':'synthetic history'}}}
  new=copy.deepcopy(old);new['ai_balance_snapshots']['k'].update(checked_at=100000,attempt_at=100000);new['client_bot_bridge_state']['bridge']['checked_at']='new';new['sqlite_sequence']['seq']['seq']=2
  diag={'bridge':{'key':'bridge','payload':'same','checkedAt':'1970-01-01T00:01:30.000Z'},'sequence':{'key':'seq','name':'hugh_owner_alerts','value':1}};obs=copy.deepcopy(diag);obs['bridge']['checkedAt']='1970-01-01T00:01:40.000Z';obs['sequence']['value']=2
  policy=module(MAIN/'diagnostic_preservation.py','original_pure_diagnostic')
  def invoke(a,b,o):
   with patch.object(m,'diagnostic_policy',return_value=policy):return d.content(m,facts(old),b,diag,o,old['ai_balance_snapshots'],a['ai_balance_snapshots'],90,120)
  a=facts(new);a['tables']['hugh_owner_alerts']['columns']=facts(old)['tables']['hugh_owner_alerts']['columns'];self.assertFalse(invoke(new,a,obs)['expiredWindowAccepted'])
  for kind in ('business','schema','bridge','balance'):
   with self.subTest(kind=kind):
    n=copy.deepcopy(new);o=copy.deepcopy(obs)
    if kind=='business':n['customer_records']['one']['body']='changed'
    elif kind=='bridge':o['bridge']['payload']='changed'
    elif kind=='balance':n['ai_balance_snapshots']['k']['data']='changed'
    b=facts(n)
    if kind=='schema':b['schema'].append(['trigger','unapproved','customer_records','changed'])
    with self.assertRaises(ValueError):invoke(n,b,o)

class Binding(unittest.TestCase):
 def test_frozen_source_and_reused_guards_are_unchanged(self):
  self.assertEqual(hashlib.sha256((MAIN/'install.py').read_bytes()).hexdigest(),'473028a50555fced995708ece843b9695fb4d5c0ee88d282c2ca806436e68838')
  self.assertEqual(hashlib.sha256((MAIN/'host_static.py').read_bytes()).hexdigest(),'73b3c34e3d646e2b077b45b7fce84dfc3a480f39cf5dfbb5eeed8be4b94018f0')
  self.assertEqual(hashlib.sha256((MAIN/'diagnostic_preservation.py').read_bytes()).hexdigest(),'658ddfc204ba95c75889a5f0d9f73d9f5142a30261cac462e461cbd431747a70')
  def funcs(path):return {n.name:ast.dump(n,include_attributes=False)for n in ast.parse(path.read_bytes()).body if isinstance(n,ast.FunctionDef)}
  a=funcs(LF/'verify.py');b=funcs(HERE/'verify.py');self.assertNotEqual(a.pop('provenance'),b.pop('provenance'));self.assertEqual(a,b)
  self.assertEqual(v.AFTER,'e564f807d1de31c2d9fd1a0f89581afd52a57042ce5b8a444aa3fa8ae793c5e8');self.assertEqual(v.AFTER_BYTES,81128)
 def test_no_backend_or_sql_write_cli_and_fresh_end_fences_retained(self):
  code=(HERE/'current.py').read_text();tree=ast.parse(code)
  calls={n.func.attr for n in ast.walk(tree)if isinstance(n,ast.Call)and isinstance(n.func,ast.Attribute)}
  self.assertFalse(calls&{'release','apply','build','restore','connect','execute','executescript'})
  g=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='guard');calls=[n.func.attr for n in ast.walk(g)if isinstance(n,ast.Call)and isinstance(n.func,ast.Attribute)]
  self.assertEqual(calls.count('assert_preserved_path'),2);self.assertIn('startup_guard',calls);self.assertIn('backup_guard',calls);self.assertIn('managed_guard',calls)
  self.assertNotIn("write_new(s.AREA",code);self.assertNotIn("runtime-accepted.json",code)

class CurrentGuard(unittest.TestCase):
 def setup_guard(self):
  proof={'kind':cur.KIND,'status':'FRESH_CURRENT_AFTER_STATIC_SCOPE_ONLY','originalExpiredAcceptanceReplaced':False,'lease':'lease','companionPinsSha256':'code','originalReference':{'old':'hash'},'identities':{'content':m.sha(m.enc('c')),'crm':m.sha(m.enc('f'))}}
  base={'created':90,'expires':990,'lease':'lease','companionPinsSha256':'code','originalReference':{'old':'hash'},'currentAfterSha256':m.sha(m.enc(proof)),'tree':'tree','plan':'plan','databases':{'a':'row-a','b':'row-b'},'databaseFacts':{'a':'facts-a','b':'facts-b'},'managed':'managed'}
  files={'static-base.json':base,'static-layer/prepared.json':{'baseSha256':m.sha(m.enc(base)),'stageManifestSha256':'manifest'},'current-after.json':proof}
  s=types.SimpleNamespace(package=lambda:({'manifestSha256':'manifest'},{}),need=m.need,own_lease=lambda:'lease',load=lambda p:files[p.relative_to(cur.AREA).as_posix()],safe_read=lambda p:m.enc(files[p.relative_to(cur.AREA).as_posix()]),sha=m.sha,enc=m.enc,CONTAINERS=('content','crm'),inspect_container=lambda n: 'c'if n=='content'else'f',foreign=lambda r:r,backup_guard=lambda:None,database_paths=lambda r,m:base['databases'],managed_guard=lambda p,f:'managed',startup_guard=lambda p,r,end:self.assertEqual(end,280),APPLY_TTL=120,GRACE=60,module=lambda n:types.SimpleNamespace(expect=lambda c,b,p:None))
  calls=[];c=types.SimpleNamespace(assert_preserved_path=lambda *args:calls.append(args))
  return s,c,files,calls
 def invoke(self,s,c):
  with patch.object(cur,'own_files',return_value='code'),patch.object(cur,'reference',return_value={'old':'hash'}),patch.object(cur,'envelope',return_value=({},'tree','plan')),patch.object(cur.time,'time',return_value=100):return cur.guard(s,c,0)
 def test_both_whole_db_sweeps_and_startup_margin(self):
  s,c,files,calls=self.setup_guard();self.invoke(s,c);self.assertEqual(len(calls),4);self.assertTrue(all(a[-2:]==(False,True)for a in calls))
 def test_current_five_identity_and_lease_and_static_ttl(self):
  for kind in ('identity','lease','expired','basehash','explicit-kind'):
   with self.subTest(kind=kind):
    s,c,f,calls=self.setup_guard()
    if kind=='identity':s.inspect_container=lambda n:'different'
    elif kind=='lease':s.own_lease=lambda:'different'
    elif kind=='expired':f['static-base.json']['expires']=99
    elif kind=='basehash':f['static-layer/prepared.json']['baseSha256']='wrong'
    else:f['current-after.json']['kind']='old-runtime-acceptance'
    with self.assertRaises(ValueError):self.invoke(s,c)
 def test_backup_history_startup_nonce_and_second_fence_errors_propagate(self):
  for error in ('backup','history','startup_nonce','first_database','second_database','clock'):
   with self.subTest(error=error):
    s,c,f,calls=self.setup_guard()
    def refuse(*a):raise ValueError('INJECTED_'+error.upper())
    if error=='backup':s.backup_guard=refuse
    elif error=='history':s.managed_guard=refuse
    elif error=='startup_nonce':s.startup_guard=refuse
    else:
     def preserve(*a):
      calls.append(a)
      if len(calls)==(1 if error=='first_database'else 3):refuse()
     c.assert_preserved_path=preserve
    with self.assertRaisesRegex(ValueError,'INJECTED_'):self.invoke(s,c)
 def test_runtime_envelope_checks_complete_tree_image_config_foreign_and_price(self):
  base={'rows':{'content':{'Image':'old','identity':'before','config':'config'},'crm':{'identity':'foreign'}},'policy':'policy','price':'price'};child={'image':cur.IMAGE};rows={'content':{'Image':cur.IMAGE,'identity':'after','config':'config'},'crm':{'identity':'foreign'}}
  def make():return types.SimpleNamespace(AREA=Path('/closed'),load=lambda p:base if p.name=='base.json'else child,CONTENT='content',CONTAINERS=('content','crm'),need=m.need,built_image_guard=lambda *a:None,expected_tree=lambda *a:'tree',runtime_tree=lambda *a:'tree',source_phase_tree=lambda *a:None,image_tree=lambda *a:'tree',foreign=lambda r:r['identity'],normalize_content=lambda r:r.get('config'),effective_plan=lambda *a:'plan',validated_plan=lambda *a:'plan',policy_state=lambda:'policy',price_pin=lambda:'price',source_review_guard=lambda *a:None)
  manifest={'expectedImages':{'content':'old','crm':'foreign'}};cur.envelope(make(),manifest,rows)
  for field in ('runtime_tree','image_tree','price_pin','policy_state','validated_plan','built_image_guard','source_review_guard'):
   with self.subTest(field=field):
    s=make()
    if field in('built_image_guard','source_review_guard'):
     def refuse(*a):raise ValueError('INJECTED_REQUIRED_GUARD')
     setattr(s,field,refuse)
    else:setattr(s,field,lambda *a:'mismatch')
    with self.assertRaises(ValueError):cur.envelope(s,manifest,rows)
  for role,key,val in [('content','Image','other'),('content','config','other'),('crm','identity','other')]:
   bad=copy.deepcopy(rows);bad[role][key]=val
   with self.assertRaises(ValueError):cur.envelope(make(),manifest,bad)

class NewProvenance(unittest.TestCase):
 def setUp(self):
  tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);self.root=Path(tmp.name).resolve();self.source=self.root/'sources';self.source.mkdir();self.release=self.root/'releases/palitra-auth-chat-production-20261031-r7';self.release.mkdir(parents=True);self.current=self.root/'releases/palitra-auth-chat-static-current-20261031-r1';self.current.mkdir()
  self.put(self.release/'manifest.json',json.loads((MAIN/'manifest.json').read_bytes()));self.put(self.release/'stage.json',{'manifestSha256':v.sha((self.release/'manifest.json').read_bytes()),'helperSha256':v.RELEASE_HELPER_SHA})
  for n in ('base.json','prepared.json','diagnostic-observations/head.json','history-witness.json','history-ready.json','backups.json','apply-intent.json','up-returned.json','auth-outcome-schema-init-intent.json','auth-outcome-schema-init-observed.json'):
   (self.release/n).parent.mkdir(parents=True,exist_ok=True);self.put(self.release/n,{'synthetic':n})
  self.put(self.release/'child.json',{'parent':v.IMAGES['synapse-content-1'],'image':'sha256:53fcc6b81e2b68a782fdb58a0fa1a66e5ad3277dfc90fc08fd02cfb70ebfea26'})
  for n in ('current.py','drift.py','verify.py'):(self.source/n).write_bytes((HERE/n).read_bytes())
  pins={n:{'sha256':v.sha((self.source/n).read_bytes()),'bytes':(self.source/n).stat().st_size}for n in ('current.py','drift.py','verify.py')};self.put(self.source/'companion-pins.json',pins)
  refs={p.relative_to(self.release).as_posix():v.sha(p.read_bytes())for p in self.release.rglob('*')if p.is_file()and p.name not in ('manifest.json','stage.json')}
  self.proof={'kind':'FRESH_CURRENT_RUNTIME_FOR_STATIC_ONLY_V1','status':'FRESH_CURRENT_AFTER_STATIC_SCOPE_ONLY','at':100,'expires':1000,'lease':{'pid':1,'startTicks':'123'},'originalExpiredAcceptanceReplaced':False,'companionPinsSha256':v.sha((self.source/'companion-pins.json').read_bytes()),'originalReference':refs,'image':'sha256:53fcc6b81e2b68a782fdb58a0fa1a66e5ad3277dfc90fc08fd02cfb70ebfea26','identities':{'fixture':'controlled'}}
  self.refresh();original_path=Path
  patches=[patch.object(v,'ROOT',self.root),patch.object(v,'RELEASE_AREA',self.release),patch.object(v,'RELEASE_MANIFEST_SHA',v.sha((self.release/'manifest.json').read_bytes())),patch.object(v,'SELF',self.source/'verify.py'),patch.object(v.time,'time',return_value=101),patch.object(v,'own_lease',return_value={'pid':1,'startTicks':'123'}),patch.object(v,'Path',side_effect=lambda p:self.source if str(p)=='/root/palitra-auth-chat-static-current-20261031-r1'else original_path(p))]
  if os.name=='nt':
   # Same known Windows stat/fstat ctime precision limitation as predecessor
   # fixtures. Substitute ONLY local fixture I/O; Linux production safe() exact.
   def windows_safe(p,limit=v.LIMIT):
    p=original_path(p);before=v.file_meta(p);self.assertFalse(p.is_symlink());self.assertEqual(p.resolve(),p);raw=p.read_bytes();self.assertLessEqual(len(raw),limit);self.assertEqual(before,v.file_meta(p));return raw
   patches.append(patch.object(v,'safe',side_effect=windows_safe))
  for x in patches:x.start();self.addCleanup(x.stop)
 def put(self,p,x):p.write_bytes(v.enc(x))
 def refresh(self):
  self.put(self.current/'current-after.json',self.proof);pin=v.sha((self.current/'current-after.json').read_bytes());base={'lease':self.proof['lease'],'currentAfterSha256':pin,'originalReference':self.proof['originalReference'],'companionPinsSha256':self.proof['companionPinsSha256']};self.put(self.current/'static-base.json',base);bp=v.sha((self.current/'static-base.json').read_bytes())
  self.put(self.current/'current-after-accepted.json',{'kind':self.proof['kind'],'status':'FRESH_CURRENT_AFTER_READBACK_PASS','companionPinsSha256':self.proof['companionPinsSha256'],'currentAfterSha256':pin,'staticBaseSha256':bp,'originalReference':self.proof['originalReference']})
  self.put(self.current/'static-complete.json',{'kind':self.proof['kind'],'status':'ATTENTION_ALL_AFTER_PASS','phase':2,'targets':v.HOST_PINS,'automaticReplay':False,'currentAfterSha256':pin,'staticBaseSha256':bp})
 def test_new_explicit_context_without_forging_old_acceptance(self):
  self.assertFalse((self.release/'runtime-accepted.json').exists());self.assertEqual(v.provenance()['image'],self.proof['image'])
 def test_expired_or_wrong_context_refused(self):
  for key,val in [('expires',101),('kind','AFTER_INDEPENDENT_READBACK_PASS'),('originalExpiredAcceptanceReplaced',True)]:
   with self.subTest(key=key):
    old=copy.deepcopy(self.proof);self.proof[key]=val;self.refresh()
    with self.assertRaises(ValueError):v.provenance()
    self.proof=old;self.refresh()
 def test_static_incomplete_or_wrong_pin_refused(self):
  for change in ('phase','target'):
   self.refresh();p=self.current/'static-complete.json';value=json.loads(p.read_bytes())
   if change=='phase':value['phase']=1
   else:value['targets'][next(iter(v.HOST_PINS))]='0'*64
   self.put(p,value)
   with self.assertRaisesRegex(ValueError,'COMPLETE_PAIR'):v.provenance()
 def test_original_backup_or_source_tamper_refused(self):
  for p in (self.release/'backups.json',self.source/'drift.py'):
   with self.subTest(path=p.name):
    old=p.read_bytes();p.write_bytes(b'tampered')
    with self.assertRaises(ValueError):v.provenance()
    p.write_bytes(old)

if __name__=='__main__':unittest.main()
