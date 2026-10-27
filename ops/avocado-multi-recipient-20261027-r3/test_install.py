"""Offline synthetic guard tests. No Docker, network, native framework execution or production DB."""
from pathlib import Path
import copy, importlib.util, io, json, sqlite3, sys, tempfile, unittest, warnings, zipfile
from unittest.mock import patch
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('component_candidate',Path(__file__).with_name('install.py'))
m = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(m)

def manifest():
    return {'schema':1,'packageId':m.NAME,'status':'EXACT_MERGED_REVIEW_READY','rootCompatibilityReview':'ACCEPTED',
            'helperSha256':'a'*64,'zipSha256':'b'*64,'zipBytes':10,
            'expectedImages':dict(m.KNOWN_IMAGES),
            'runtime':[{'file':'candidate/crm/'+name,'beforeSha256':None if name=='email-recipients.js' else 'e'*64,'sha256':'f'*64,'bytes':1} for name in m.RUNTIME],
            'static':[{'file':'candidate/static/settings.js','beforeSha256':'e'*64,'sha256':'f'*64,'bytes':1}],
            'unchangedRuntime':{'server.js':m.SERVER_SHA},'workerCompatibility':dict(m.WORKER_COMPATIBILITY)}

def archive_fixture(extra=None, duplicate=False, symlink=False):
    candidate = manifest(); buffer = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter('ignore',UserWarning)
        with zipfile.ZipFile(buffer,'w') as archive:
            for row in candidate['runtime']+candidate['static']:
                value = ('code:'+row['file']).encode(); row['sha256'],row['bytes'] = m.sha(value),len(value)
                info = zipfile.ZipInfo(row['file'])
                if symlink and row == candidate['runtime'][0]: info.external_attr = 0o120777 << 16
                archive.writestr(info,value)
            if extra: archive.writestr(extra,b'not allowed')
            if duplicate: archive.writestr(candidate['runtime'][0]['file'],b'duplicate')
    raw = buffer.getvalue(); candidate['zipBytes'],candidate['zipSha256'] = len(raw),m.sha(raw)
    return raw,candidate

class PackageTests(unittest.TestCase):
    def test_exact_scope_valid(self): self.assertIs(m.validate_manifest(manifest())['schema'],1)
    def test_missing_root_review_or_nonmerged_status_rejected(self):
        for key,value in [('status','CODE_ONLY'),('rootCompatibilityReview','PENDING')]:
            candidate = manifest(); candidate[key] = value
            with self.assertRaises(ValueError): m.validate_manifest(candidate)
    def test_sixth_runtime_or_wrong_static_rejected(self):
        for mutate in (lambda x:x['runtime'].append(dict(x['runtime'][0])),lambda x:x['static'][0].update(file='candidate/static/auth.js')):
            candidate = manifest(); mutate(candidate)
            with self.assertRaises(ValueError): m.validate_manifest(candidate)
    def test_new_helper_cannot_overwrite_unexpected_old_file(self):
        candidate = manifest(); candidate['runtime'][0]['beforeSha256'] = '1'*64
        with self.assertRaisesRegex(ValueError,'NEW_HELPER'): m.validate_manifest(candidate)
    def test_all_five_current_images_required(self):
        candidate = manifest(); del candidate['expectedImages']['caddy']
        with self.assertRaises(ValueError): m.validate_manifest(candidate)
        candidate = manifest(); candidate['expectedImages'][m.CRM] = 'sha256:'+'1'*64
        with self.assertRaises(ValueError): m.validate_manifest(candidate)
    def test_server_change_rejected(self):
        candidate = manifest(); candidate['unchangedRuntime']['server.js'] = '1'*64
        with self.assertRaises(ValueError): m.validate_manifest(candidate)
    def test_zip_exact_file_hashes_and_sizes(self):
        raw,candidate = archive_fixture(); self.assertEqual(len(m.unpack_payload(raw,candidate)),6)
        candidate['runtime'][0]['sha256'] = '1'*64
        with self.assertRaisesRegex(ValueError,'ZIP_FILE_PIN'): m.unpack_payload(raw,candidate)
    def test_zip_extra_traversal_duplicate_and_symlink_rejected(self):
        for options in ({'extra':'../secret'},{'extra':'candidate/crm/server.js'},{'duplicate':True},{'symlink':True}):
            raw,candidate = archive_fixture(**options)
            with self.assertRaises(ValueError): m.unpack_payload(raw,candidate)
    def test_outer_zip_pin_enforced(self):
        raw,candidate = archive_fixture()
        with self.assertRaisesRegex(ValueError,'ZIP_PIN'): m.unpack_payload(raw+b'x',candidate)

class ComposeTests(unittest.TestCase):
    def test_hugh_latest_chain_selected_not_stale_crm_labels(self):
        base=['recovery/candidate-0','accepted-content.json']
        current=base+['recovery/hugh-image-only.json']
        self.assertEqual(m.longest_chain([base,current,base]),current)
    def test_divergent_chain_rejected(self):
        with self.assertRaisesRegex(ValueError,'DIVERGENT'): m.longest_chain([['base','hugh'],['base','other']])
    def test_empty_or_duplicate_chain_rejected(self):
        for rows in ([],[[]],[['base','base']]):
            with self.assertRaises(ValueError): m.longest_chain(rows)
    def test_image_only_delta_accepts_crm_and_preserves_input(self):
        before={'services':{'crm':{'image':'old','environment':{'KEY':'same'},'volumes':['data:/data']},'hugh':{'image':'hugh-new'}},'networks':{'default':{'name':'unchanged'}}}
        original=copy.deepcopy(before); after=copy.deepcopy(before); after['services']['crm']['image']='new'
        m.assert_image_delta(before,after,'new'); self.assertEqual(before,original)
    def test_other_service_environment_mount_or_network_changes_rejected(self):
        before={'services':{'crm':{'image':'old','environment':{'KEY':'same'},'volumes':['data:/data']},'hugh':{'image':'hugh-new'}},'networks':{'default':{'name':'unchanged'}}}
        mutations=[lambda x:x['services']['hugh'].update(image='old-hugh'),lambda x:x['services']['crm']['environment'].update(KEY='different'),lambda x:x['services']['crm']['volumes'].append('source:/app'),lambda x:x['networks']['default'].update(name='other')]
        for mutate in mutations:
            after=copy.deepcopy(before);after['services']['crm']['image']='new';mutate(after)
            with self.assertRaisesRegex(ValueError,'ONLY_CRM_IMAGE'):m.assert_image_delta(before,after,'new')
    def test_effective_plan_checks_live_hugh_and_crm_config_label(self):
        images=manifest()['expectedImages']; chains={name:['/base'] for name in m.CONTAINERS};chains['synapse-hugh-runtime-1']+=['/hugh']
        services={m.CRM:'crm',m.CONTENT:'content','synapse-hugh-runtime-1':'hugh-runtime','synapse-chat-1':'chat','caddy':'caddy'}
        rows={name:{'Image':image,'State':{'Running':True,'Restarting':False},'Config':{'Labels':{'com.docker.compose.project':'synapse','com.docker.compose.project.working_dir':'/opt/synapse','com.docker.compose.project.config_files':','.join(chains[name]),'com.docker.compose.service':services[name],'com.docker.compose.config-hash':'crm-hash'}}} for name,image in images.items()}
        resolved={'services':{services[name]:{'image':image} for name,image in images.items()}}
        def run(args):
            if args[:3]==['docker','image','inspect']:return args[-1].encode()
            if args[-3:]==['config','--format','json']:return json.dumps(resolved).encode()
            if args[-3:]==['config','--hash','crm']:return b'crm crm-hash'
            raise AssertionError(args)
        old={'inspect':lambda name:copy.deepcopy(rows[name]),'read':lambda path:path.encode(),'run':run,'compose_args':lambda plan:['docker','compose']}
        plan=m.effective_plan(old,images);self.assertEqual([x['path'] for x in plan['files']],['/base','/hugh'])
        resolved['services']['hugh-runtime']['image']='sha256:'+'0'*64
        with self.assertRaisesRegex(ValueError,'GLOBAL_PLAN'):m.effective_plan(old,images)
        resolved['services']['hugh-runtime']['image']=images['synapse-hugh-runtime-1'];rows[m.CRM]['Config']['Labels']['com.docker.compose.config-hash']='bad'
        with self.assertRaisesRegex(ValueError,'ACTUAL_CRM_CONFIG'):m.effective_plan(old,images)

class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='avocado-installer-offline-')
        self.path=Path(self.tmp.name)/'crm.sqlite';self.db=sqlite3.connect(self.path)
        self.db.executescript("""CREATE TABLE leads(id INTEGER PRIMARY KEY,name TEXT,attachment BLOB);
          CREATE TABLE lead_email_outbox(lead_id INTEGER PRIMARY KEY,status TEXT,last_error_code TEXT);
          CREATE TABLE company_email_recipients(company_code TEXT PRIMARY KEY,recipient TEXT,updated_at TEXT);
          INSERT INTO leads VALUES(1,'old client',X'00FF'),(2,'other old client',NULL);
          INSERT INTO lead_email_outbox VALUES(1,'sent',NULL);
          INSERT INTO company_email_recipients VALUES('avokado','a@example.test','old');""")
        self.db.commit();self.reopen();self.base=json.loads(m.enc(m.db_facts(self.db)))
    def reopen(self):
        self.db.close();self.db=sqlite3.connect(self.path,isolation_level=None)
    def ledger(self):
        self.db.execute(m.LEDGER_SQL);self.reopen()
    def tearDown(self):self.db.close();self.tmp.cleanup()
    def test_baseline_read_only_guard(self):
        report=m.assert_database(self.db,self.base,False);self.assertEqual(report['oldRows'],4);self.assertEqual(self.db.total_changes,0)
    def test_only_exact_new_ledger_allowed(self):
        self.ledger();m.assert_database(self.db,self.base,True)
    def test_new_real_lead_allowed_without_changing_old_rows(self):
        self.ledger();self.db.executescript("INSERT INTO leads VALUES(3,'new client',NULL);INSERT INTO lead_email_outbox VALUES(3,'sent',NULL);INSERT INTO lead_email_recipients(lead_id,recipient,status) VALUES(3,'a@example.test','accepted');")
        self.reopen();m.assert_database(self.db,self.base,True)
    def test_old_business_update_delete_or_blob_corruption_rejected(self):
        for query in ("UPDATE leads SET name='changed' WHERE id=1","DELETE FROM leads WHERE id=1","UPDATE leads SET attachment=X'00' WHERE id=1"):
            self.db.execute('SAVEPOINT test');self.db.execute(query)
            with self.assertRaisesRegex(ValueError,'OLD_CRM_ROWS'):m.assert_database(self.db,self.base,False)
            self.db.execute('ROLLBACK TO test');self.db.execute('RELEASE test')
    def test_old_schema_mutation_rejected(self):
        self.ledger();self.db.execute('CREATE INDEX unrequested ON leads(name)');self.reopen()
        with self.assertRaisesRegex(ValueError,'ONLY_EXACT_ADDITIVE'):m.assert_database(self.db,self.base,True)
    def test_wrong_ledger_constraint_rejected(self):
        self.db.execute(m.LEDGER_SQL.replace("'withdrawn'","'discarded'"));self.reopen()
        with self.assertRaisesRegex(ValueError,'ONLY_EXACT_ADDITIVE'):m.assert_database(self.db,self.base,True)
    def test_pending_queue_blocks_before_restart(self):
        self.db.execute("INSERT INTO lead_email_outbox VALUES(2,'sending',NULL)");self.reopen()
        with self.assertRaisesRegex(ValueError,'FRESH_EMPTY'):m.assert_database(self.db,self.base,False)
    def test_no_ledger_backfill_for_existing_lead(self):
        self.ledger();self.db.execute("INSERT INTO lead_email_recipients(lead_id,recipient,status) VALUES(1,'a@example.test','accepted')");self.reopen()
        with self.assertRaisesRegex(ValueError,'OLD_LEADS_MUST_NOT'):m.assert_database(self.db,self.base,True)
    def test_rollback_check_safe_single_empty_queue(self):
        self.ledger();self.assertTrue(m.rollback_facts(self.db)['safeForSeparateReviewedLegacyRollback'])
    def test_rollback_partial_unknown_pending_or_multilist_rejected(self):
        self.ledger();self.db.executescript("INSERT INTO lead_email_outbox VALUES(2,'pending','EMAIL_DELIVERY_UNCONFIRMED');INSERT INTO lead_email_recipients(lead_id,recipient,status,last_error_code) VALUES(2,'a@example.test','accepted','EMAIL_DELIVERY_UNCONFIRMED');")
        result=m.rollback_facts(self.db);self.assertFalse(result['safeForSeparateReviewedLegacyRollback']);self.assertEqual(result['partialOrUnknown'],1)
        self.db.execute('DELETE FROM lead_email_recipients WHERE lead_id=2');self.db.execute('DELETE FROM lead_email_outbox WHERE lead_id=2')
        self.db.execute("UPDATE company_email_recipients SET recipient='a@example.test, b@example.test'")
        self.assertFalse(m.rollback_facts(self.db)['safeForSeparateReviewedLegacyRollback'])
        self.db.execute("UPDATE company_email_recipients SET recipient='a@example.test'")
        self.assertFalse(m.rollback_facts(self.db,['LEADS_NOTIFY_EMAIL_AVOKADO=a@example.test,b@example.test'])['safeForSeparateReviewedLegacyRollback'])
    def test_read_only_connection_rejects_writes_and_closes(self):
        with m.db_open(self.path) as connection:
            self.assertEqual(connection.execute('PRAGMA query_only').fetchone(),(1,))
            with self.assertRaises(sqlite3.OperationalError):connection.execute('DELETE FROM leads')
        with self.assertRaises(sqlite3.ProgrammingError):connection.execute('SELECT 1')
    def test_online_backup_preserves_old_rows_and_checks_guard(self):
        destination=Path(self.tmp.name)/'backup.sqlite';calls=[]
        result=m.create_backup(self.path,destination,self.base,lambda:calls.append(True))
        self.assertEqual(result['quickCheck'],'ok');self.assertGreaterEqual(len(calls),3)
        with m.db_open(destination) as connection:m.assert_database(connection,self.base,False)
        m.assert_database(self.db,self.base,False)
    def test_backup_deadline_keeps_source_and_refuses_reuse(self):
        destination=Path(self.tmp.name)/'partial-backup.sqlite';ticks=iter([0,121])
        with self.assertRaisesRegex(ValueError,'BACKUP_DEADLINE'):m.create_backup(self.path,destination,self.base,lambda:None,lambda:next(ticks))
        m.assert_database(self.db,self.base,False)
        with self.assertRaises(FileExistsError):m.create_backup(self.path,destination,self.base,lambda:None)

class LeaseTests(unittest.TestCase):
    def fake_native(self):
        calls=[]
        class Ticket:
            @staticmethod
            def native_lease(value):calls.append(value)
        class Native:pass
        Native.LOCK='/opt/synapse/.palitra-app-release.lock';Native.Ticket=Ticket
        return Native,calls
    def proc(self,path):
        pid=path.parent.name
        parent={'500':'400','400':'1'}[pid]
        return pid+' (bash) '+' '.join(['S',parent]+['0']*17+['123456'])
    def test_actual_ancestor_and_start_ticks_required(self):
        native,calls=self.fake_native();old={'run':lambda args:json.dumps({'locks':[{'path':native.LOCK,'pid':400}]}).encode()}
        with patch.object(m.os,'getppid',return_value=500),patch.object(Path,'read_text',lambda path:self.proc(path)):result=m.own_lease(old,native)
        self.assertEqual(result['pid'],400);self.assertEqual(result['startTicks'],'123456');self.assertEqual(calls,[result])
    def test_foreign_or_multiple_lease_rejected(self):
        native,_=self.fake_native()
        for pids in ([999],[400,401],[]):
            old={'run':lambda args,pids=pids:json.dumps({'locks':[{'path':native.LOCK,'pid':pid} for pid in pids]}).encode()}
            with patch.object(m.os,'getppid',return_value=500),patch.object(Path,'read_text',lambda path:self.proc(path)):
                with self.assertRaises(ValueError):m.own_lease(old,native)

class DriverGuardTests(unittest.TestCase):
    setUp=DatabaseTests.setUp
    reopen=DatabaseTests.reopen
    tearDown=DatabaseTests.tearDown
    # Real candidate guard/ticket/execute admission, synthetic external primitives.
    # This does not claim a Docker lifecycle test or execution of pinned native code.
    def make_driver(self,after=False,read_lease=None):
        temp=Path(self.tmp.name);static=temp/'settings.js';static.write_bytes(b'old static')
        crm={'Image':m.KNOWN_IMAGES[m.CRM],'Config':{'Env':[]}}
        content={'invariants':{'foreignContainers':{m.CRM:{'accepted':'old-crm'},'other':{'fixed':True}}},'static':{},'wholeTree':'exact-content'}
        plan={'fixed':'effective-plan'};lease={'pid':400,'startTicks':'1','path':'/lock'}
        current_lease=read_lease or lease
        policy={'guard':'unchanged'}
        worker_proof={'fixed':'worker-proof'}
        base={'crm':crm,'crmDatabase':{'databasePath':str(self.path),'databaseIdentity':[1,2]},'content':content,'workerProof':worker_proof,'databaseFacts':self.base,'effectiveCompose':plan,'policy':policy,'statics':{str(static):{'sha256':m.sha(b'old static'),'afterSha256':m.sha(b'new static'),'mode':static.stat().st_mode&0o7777}}}
        area=temp/'package';area.mkdir();(area/'base.json').write_bytes(m.enc(base))
        action={'status':'ROOT_AUTHORIZED_ONE_ATTEMPT','singleWriter':'Root','namespace':m.NAME+'-unit','created':m.time.time()-1,'expires':m.time.time()+100,'lease':lease,'baseSha256':m.sha(m.enc(base)),'helperSha256':'a'*64,'bundleSha256':'b'*64}
        (area/'action.json').write_bytes(m.enc(action))
        if after:(area/'installed.json').write_bytes(m.enc({'images':{m.CRM:{'image':'sha256:'+'1'*64}},'plan':plan}))
        class FakeBase:
            def crm_guard(self,installed):return copy.deepcopy(crm)
        class Ticket:
            @staticmethod
            def native_lease(value):
                if value!=current_lease:raise ValueError('BAD_LEASE')
        class Native:pass
        Native.Ticket=Ticket
        class Reader:
            @staticmethod
            def foreign(row):return {'accepted':'new-crm'}
        old={'Apply':FakeBase,'content_snapshot':lambda *args:copy.deepcopy(content)}
        patches=[patch.object(m,'AREA',area),patch.object(m,'package',return_value=({'manifestSha256':'b'*64,'helperSha256':'a'*64},manifest(),{})),patch.object(m,'primitives',return_value=(old,None,Native,Reader,{})),patch.object(m,'own_lease',return_value=current_lease),patch.object(m,'effective_plan',return_value=plan),patch.object(m,'policy_state',return_value=policy),patch.object(m,'pinned_worker_probe',return_value=worker_proof)]
        for item in patches:item.start();self.addCleanup(item.stop)
        return m.driver(after),area,content
    def test_guard_accepts_exact_synthetic_state_and_rejects_foreign_drift(self):
        obj,_,content=self.make_driver();obj.guard()
        content['invariants']['foreignContainers']['other']['fixed']=False
        with self.assertRaisesRegex(ValueError,'FULL_UNCHANGED'):obj.guard()
    def test_existing_journal_refuses_second_apply_before_any_build(self):
        obj,area,_=self.make_driver();(area/'journal').mkdir()
        with self.assertRaisesRegex(ValueError,'ONE_ATTEMPT'):obj.execute()
    def test_expired_action_and_changed_original_lease_refused(self):
        obj,area,_=self.make_driver();obj.action['expires']=obj.action['created']+0.1;(area/'action.json').write_bytes(m.enc(obj.action))
        with self.assertRaisesRegex(ValueError,'FRESH_ACTION'):obj.ticket()
        obj.action['expires']=m.time.time()+100;obj.action['lease']={'pid':999};(area/'action.json').write_bytes(m.enc(obj.action))
        with self.assertRaisesRegex(ValueError,'ORIGINAL_OWN_LEASE'):obj.ticket()
    def test_inspect_same_fresh_lease_keeps_original_action(self):
        obj,area,_=self.make_driver(True);before=(area/'action.json').read_bytes();obj.ticket()
        self.assertEqual(before,(area/'action.json').read_bytes())
    def test_inspect_new_fresh_lease_does_not_reclaim_original(self):
        fresh={'pid':501,'startTicks':'222','path':'/lock'}
        obj,area,_=self.make_driver(True,fresh);before=(area/'action.json').read_bytes();obj.ticket()
        self.assertEqual(obj.action['lease']['pid'],400);self.assertEqual(obj.readLease,fresh)
        self.assertEqual(before,(area/'action.json').read_bytes())
    def test_inspect_foreign_lease_rejected_by_native_check(self):
        obj,_,_=self.make_driver(True,{'pid':501,'startTicks':'222','path':'/lock'});obj.readLease={'pid':999,'startTicks':'1','path':'/lock'}
        with self.assertRaisesRegex(ValueError,'BAD_LEASE'):obj.ticket()
    def test_inspect_changed_original_action_and_base_rejected(self):
        obj,area,_=self.make_driver(True);raw=(area/'action.json').read_bytes();changed=copy.deepcopy(obj.action);changed['namespace']=m.NAME+'-changed';(area/'action.json').write_bytes(m.enc(changed))
        with self.assertRaisesRegex(ValueError,'ACTION_OR_BASE_CHANGED'):obj.ticket()
        (area/'action.json').write_bytes(raw);(area/'base.json').write_bytes(b'{}')
        with self.assertRaisesRegex(ValueError,'ACTION_OR_BASE_CHANGED'):obj.ticket()
    def test_read_only_inspect_can_read_after_original_action_expires(self):
        obj,area,_=self.make_driver(True,{'pid':501,'startTicks':'222','path':'/lock'})
        obj.action['created']=m.time.time()-100;obj.action['expires']=m.time.time()-50;(area/'action.json').write_bytes(m.enc(obj.action))
        before=(area/'action.json').read_bytes();obj.ticket();self.assertEqual(before,(area/'action.json').read_bytes())

if __name__=='__main__':unittest.main(verbosity=2)
