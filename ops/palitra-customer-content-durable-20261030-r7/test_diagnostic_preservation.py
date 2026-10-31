"""Real SQLite preservation and actual helper integration; no native capabilities."""
import copy,sqlite3,time,unittest
from datetime import datetime,timezone
from unittest.mock import patch
import test_install as fixture
m=fixture.m

def iso(ms):return datetime.fromtimestamp(ms/1000,timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
class Diagnostic(unittest.TestCase):
 def setUp(self):
  self.f=fixture.Pipeline(methodName='runTest');self.f.setUp();self.path=self.f.content/'content.sqlite';self.base=self.f.prepared();self.policy=m.diagnostic_policy()
 def tearDown(self):self.f.tearDown()
 def write(self,sql,args=()):
  c=sqlite3.connect(self.path);c.execute(sql,args);c.commit();c.close()
 def capture(self,elapsed=1000):
  b=self.base['diagnosticBase'];now=b['utcMs']+elapsed;mono=b['monoNs']+elapsed*1000000
  with m.db_open(self.path)as c:
   full=m.db_facts(c);proof=self.policy.capture(c,m.env_map(self.f.current[m.CONTENT]),full,utc_ms=now,mono_ns=mono)
  return full,proof
 def compare(self,full,proof,previous=None,G=1):return self.policy.compare(self.base['databaseFacts']['content:/data/content.sqlite'],self.base['diagnosticBase'],full,proof,previous or self.base['diagnosticBase'],G)
 def test_same_ready_heartbeat_and_real_ignored_insert_are_preserved(self):
  b=self.base['diagnosticBase'];self.write('UPDATE client_bot_bridge_state SET checked_at=?',(iso(b['utcMs']+1000),));self.write("INSERT OR IGNORE INTO hugh_owner_alerts(event_key,status)VALUES('dispatch-transport-error','uncertain')")
  full,p=self.capture();self.assertEqual(p['sequence']['value'],b['sequence']['value']+1);self.compare(full,p)
  with m.db_open(self.path)as c:self.assertEqual(c.execute('SELECT COUNT(*)FROM hugh_owner_alerts').fetchone()[0],1)
 def test_row_payload_new_business_alert_and_other_sequence_are_rejected(self):
  for sql in ["UPDATE client_bot_bridge_state SET error='failure'","UPDATE preserved SET value='business write'","INSERT INTO hugh_owner_alerts(event_key,status)VALUES('new alert','pending')","UPDATE sqlite_sequence SET seq=seq+1 WHERE name='preserved'"]:
   with self.subTest(sql=sql):
    c=sqlite3.connect(self.path);before=c.serialize();c.execute(sql);c.commit();c.close()
    try:
     with self.assertRaises(ValueError):full,p=self.capture();self.compare(full,p)
    finally:
     memory=sqlite3.connect(':memory:');memory.deserialize(before);c=sqlite3.connect(self.path);memory.backup(c);c.close();memory.close()
 def test_timestamp_future_stale_noncanonical_and_regression_refuse(self):
  b=self.base['diagnosticBase']
  for value in [iso(b['utcMs']+1001),iso(b['utcMs']-301000),'2026-10-29T00:00:00Z',iso(self.policy.stamp(b['bridge']['checkedAt'])-1)]:
   with self.subTest(value=value):
    self.write('UPDATE client_bot_bridge_state SET checked_at=?',(value,))
    with self.assertRaises(ValueError):full,p=self.capture();self.compare(full,p)
 def test_cumulative_budget_and_successive_highwater_refuse(self):
  b=self.base['diagnosticBase'];self.write("UPDATE sqlite_sequence SET seq=seq+4 WHERE name='hugh_owner_alerts'");full,p=self.capture()
  with self.assertRaisesRegex(ValueError,'BUDGET'):self.compare(full,p)
  self.write("UPDATE sqlite_sequence SET seq=? WHERE name='hugh_owner_alerts'",(b['sequence']['value']+2,));full,p=self.capture();self.compare(full,p)
  self.write("UPDATE sqlite_sequence SET seq=? WHERE name='hugh_owner_alerts'",(b['sequence']['value']+1,));full,p2=self.capture(2000)
  with self.assertRaisesRegex(ValueError,'HIGHWATER'):self.compare(full,p2,p)
 def test_budget_anchor_precedes_inventory_and_join_multiplicity(self):
  # Existing full schema/row facts change only in a new baseline, never during release.
  self.write("INSERT INTO project_chat_messages VALUES(10)");self.write("INSERT INTO project_chat_outbox VALUES(7,10,'palitra-love','uncertain')")
  self.write("INSERT INTO project_chat_ai_jobs VALUES(1,'palitra-love',10,10,1,'done')");self.write("INSERT INTO project_chat_ai_jobs VALUES(2,'palitra-love',10,10,1,'done')")
  self.write("INSERT INTO hugh_owner_alerts(event_key,status)VALUES('delivery:7','uncertain')")
  with m.db_open(self.path)as c:
   full=m.db_facts(c);b=self.policy.capture(c,m.env_map(self.f.current[m.CONTENT]),full,anchor={'utcMs':int(time.time()*1000)-10000,'monoNs':time.monotonic_ns()-10000000000})
  self.assertEqual(b['D'],2);self.assertLess(b['anchorMonoNs'],b['monoNs'])
  self.write("DELETE FROM hugh_owner_alerts WHERE event_key='delivery:7'")
  with m.db_open(self.path)as c:
   with self.assertRaisesRegex(ValueError,'DUPLICATE_DELIVERY'):self.policy.capture(c,m.env_map(self.f.current[m.CONTENT]),m.db_facts(c))
 def test_budget_uses_pre_read_anchor_even_when_inventory_takes_time(self):
  full,p=self.capture();baseline=copy.deepcopy(self.base['diagnosticBase']);baseline['anchorUtcMs']-=100000;baseline['anchorMonoNs']-=100000000000
  # A delayed inventory cannot reset accumulated elapsed-time source budget.
  self.write("UPDATE sqlite_sequence SET seq=seq+12 WHERE name='hugh_owner_alerts'");full,p=self.capture()
  self.policy.compare(self.base['databaseFacts']['content:/data/content.sqlite'],baseline,full,p,baseline,1)
 def test_fresh_ttl_transition_and_clock_window_mismatch_fail(self):
  full,p=self.capture();p=copy.deepcopy(p);p['utcMs']+=100000
  with self.assertRaisesRegex(ValueError,'CLOCK_WINDOW'):self.compare(full,p)
  b=self.base['diagnosticBase'];self.write('UPDATE client_bot_bridge_state SET checked_at=?',(iso(b['utcMs']-300001),))
  with self.assertRaisesRegex(ValueError,'FRESH'):self.capture()
 def test_disabled_plan_worker_and_only_configured_transport_branch(self):
  env=m.env_map(self.f.current[m.CONTENT])
  with m.db_open(self.path)as c:
   full=m.db_facts(c)
   with self.assertRaisesRegex(ValueError,'PLAN_WORKER'):self.policy.capture(c,{**env,'CONTENT_PLAN_WORKER_ENABLED':'1'},full)
   self.assertEqual(self.policy.capture(c,{**env,'CRM_API_KEY':''},full)['transport'],0)
 def test_helper_observer_hwm_chain_and_exact_main_scope(self):
  self.write("INSERT OR IGNORE INTO hugh_owner_alerts(event_key,status)VALUES('dispatch-transport-error','uncertain')");m.base_guard();head,last=m.diagnostic_history(self.base);self.assertGreater(head['count'],1)
  self.write("UPDATE sqlite_sequence SET seq=seq-1 WHERE name='hugh_owner_alerts'")
  with self.assertRaisesRegex(ValueError,'HIGHWATER'):m.base_guard()
  self.assertFalse(m.diagnostic_main({'role':'crm','containerPath':'/data/content.sqlite'}));self.assertFalse(m.diagnostic_main({'role':'content','containerPath':'/data/salon-reports.sqlite'}))
 def test_journal_missing_uncommitted_or_tampered_is_not_replayed(self):
  folder=m.AREA/'diagnostic-observations';m.write_new(folder/'000001.json',b'{}')
  with self.assertRaisesRegex(ValueError,'JOURNAL_INCOMPLETE'):m.base_guard()
 def test_generation_samecid_restart_extra_child_and_phase_regression_refuse(self):
  rows=copy.deepcopy(self.f.current);rows[m.CONTENT]['RestartCount']=1
  with self.assertRaisesRegex(ValueError,'RESTART'):m.diagnostic_generation(self.base,rows,False)
  rows=copy.deepcopy(self.f.current);rows[m.CONTENT]['State']['StartedAt']='restarted'
  with self.assertRaisesRegex(ValueError,'GENERATION_CHANGED'):m.diagnostic_generation(self.base,rows,False)
  m.write_new(m.AREA/'apply-intent.json',b'{}');rows[m.CONTENT]['Id']='d'*64;rows[m.CONTENT]['State']['StartedAt']='owned new';g=m.diagnostic_generation(self.base,rows,True)
  self.assertEqual(g['count'],2);other=copy.deepcopy(rows);other[m.CONTENT]['Id']='e'*64
  with self.assertRaisesRegex(ValueError,'EXTRA_GENERATION'):m.diagnostic_generation(self.base,other,True,g)
  with self.assertRaisesRegex(ValueError,'GENERATION_REGRESSION'):m.diagnostic_generation(self.base,self.f.current,False,g)
 def test_backup_uses_actual_begin_snapshot_with_accepted_cells_without_normalizing_destination(self):
  self.write("INSERT OR IGNORE INTO hugh_owner_alerts(event_key,status)VALUES('dispatch-transport-error','uncertain')")
  m.backup_databases(self.base);backups=m.load(m.AREA/'backups.json')
  with m.db_open(backups['content:/data/content.sqlite']['path'])as dest,m.db_open(self.path)as source:
   self.assertEqual(m.enc(m.db_facts(dest)),m.enc(m.db_facts(source)))
   self.assertNotEqual(m.enc(m.db_facts(dest)),m.enc(self.base['databaseFacts']['content:/data/content.sqlite']))
 def test_late_real_business_write_after_startup_still_refuses_whole_fence(self):
  def late(*args):self.write("UPDATE preserved SET value='late business write'");return {'fixture':True}
  with patch.object(m,'startup_guard',side_effect=late):
   with self.assertRaisesRegex(ValueError,'DATABASE_SCHEMA_OR_ROWS'):m.base_guard()
  self.assertFalse((m.AREA/'apply-intent.json').exists());self.assertFalse(any('up'in a for a in self.f.commands))
if __name__=='__main__':unittest.main()
