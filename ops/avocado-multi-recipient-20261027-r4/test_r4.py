"""R4 regression checks. Synthetic identifiers and data only; no real SMTP/production."""
from pathlib import Path
from datetime import datetime,timezone
import copy,hashlib,importlib.util,json,sqlite3,subprocess,sys,tempfile,types,unittest,zipfile
from unittest.mock import patch
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
SPEC=importlib.util.spec_from_file_location('r4_candidate',HERE/'install.py')
m=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(m)

class ImageUserTests(unittest.TestCase):
    def config(self):return {'Env':[],'WorkingDir':'/app','Cmd':['node','server.js'],'Entrypoint':['docker-entrypoint.sh']}
    def test_minimal_actual_docker_config_missing_user_uses_default_without_mutation(self):
        config=self.config();before=copy.deepcopy(config);self.assertEqual(m.validate_image_startup(config),'');self.assertEqual(config,before);self.assertNotIn('User',config)
    def test_explicit_old_allowed_user_values_remain_valid(self):
        for user in ('','root','0'):self.assertEqual(m.validate_image_startup({**self.config(),'User':user}),user)
    def test_null_malformed_and_nonroot_user_values_rejected(self):
        for user in (None,0,False,[],{},1.0,'node','1000','root:root','0:0',' root'):
            with self.assertRaisesRegex(ValueError,'IMMUTABLE_IMAGE_USER'):m.validate_image_startup({**self.config(),'User':user})
    def test_no_defaults_for_other_startup_fields(self):
        for key in ('WorkingDir','Cmd','Entrypoint'):
            config=self.config();config.pop(key)
            with self.assertRaisesRegex(ValueError,'IMMUTABLE_IMAGE_STARTUP'):m.validate_image_startup(config)
    def test_all_six_reader_files_byte_exact_r3_only_entry_changes(self):
        previous=HERE/'previous-reader.zip'
        self.assertEqual(hashlib.sha256(previous.read_bytes()).hexdigest(),'e1a2e601cf6a3577d7139c58f45c10ba1f58b4ab3e71b449795f4c1a16756531')
        with zipfile.ZipFile(previous) as archive:
            original=json.loads(archive.read('reader-manifest.json'))
            for name in original['files']:self.assertEqual((HERE/'reader'/name).read_bytes(),archive.read('reader-code/'+name))
        expected=copy.deepcopy(original);expected['entry']=m.READER_ENTRY
        self.assertEqual(json.loads((HERE/'reader-manifest.json').read_bytes()),expected)

class ServiceHashTests(unittest.TestCase):
    def fixture(self):
        images=dict(m.KNOWN_IMAGES);services={m.CRM:'crm',m.CONTENT:'content','synapse-hugh-runtime-1':'hugh-runtime',m.WORKER:'chat','caddy':'caddy'}
        hashes={service:str(index+1)*64 for index,service in enumerate(services.values())}
        base=['/recovery/candidate-0','/accepted.json'];chains={name:list(base) for name in (m.CRM,m.CONTENT,'synapse-hugh-runtime-1')}
        chains['synapse-hugh-runtime-1'].append('/hugh.json');chains[m.WORKER]=chains['caddy']=['/root/docker-compose.yml']
        rows={name:{'Image':image,'State':{'Running':True,'Restarting':False},'Config':{'Labels':{'com.docker.compose.project':'synapse','com.docker.compose.project.working_dir':'/opt/synapse','com.docker.compose.project.config_files':','.join(chains[name]),'com.docker.compose.service':services[name],'com.docker.compose.config-hash':hashes[services[name]]}}} for name,image in images.items()}
        resolved={'services':{services[name]:{'image':image} for name,image in images.items()}}
        mutations={};file_bytes={}
        def args(plan):return ['docker','compose']+[part for row in plan['files'] for part in ('--file',row['path'])]
        def run(argv):
            if argv[:3]==['docker','image','inspect']:return argv[-1].encode()
            if argv[-3:]==['config','--format','json']:return json.dumps(resolved).encode()
            if argv[-3:-1]==['config','--hash']:
                service=argv[-1];paths=tuple(argv[index+1] for index,item in enumerate(argv) if item=='--file')
                return (service+' '+mutations.get((service,paths),hashes[service])).encode()
            raise AssertionError(argv)
        old={'inspect':lambda name:copy.deepcopy(rows[name]),'read':lambda path:file_bytes.get(path,path.encode()),'run':run,'compose_args':args}
        return old,images,rows,chains,hashes,mutations,file_bytes
    def test_equivalent_legacy_root_chains_allowed_only_with_all_five_hashes(self):
        old,images,rows,chains,_,_,_=self.fixture()
        with self.assertRaises(ValueError):m.longest_chain(list(chains.values()))
        plan=m.effective_plan(old,images);self.assertEqual([x['path'] for x in plan['files']],chains['synapse-hugh-runtime-1'])
        self.assertEqual(len(plan['ownChains']),5);self.assertEqual(plan['ownChains']['caddy']['files'][0]['path'],'/root/docker-compose.yml')
    def test_any_service_global_or_own_hash_drift_rejected(self):
        for name in m.CONTAINERS:
            old,images,rows,chains,_,mutations,_=self.fixture();service=rows[name]['Config']['Labels']['com.docker.compose.service']
            mutations[(service,tuple(chains[name]))]='f'*64
            with self.assertRaisesRegex(ValueError,'GLOBAL_OWN_ACTUAL_SERVICE_HASH'):m.effective_plan(old,images)
    def test_control_chain_divergence_still_rejected_and_source_files_pinned(self):
        old,images,rows,_,_,_,file_bytes=self.fixture();first=m.effective_plan(old,images)
        file_bytes['/root/docker-compose.yml']=b'changed-but-same-synthetic-service-hash';second=m.effective_plan(old,images)
        self.assertNotEqual(first['ownChains']['caddy']['files'],second['ownChains']['caddy']['files'])
        rows[m.CONTENT]['Config']['Labels']['com.docker.compose.project.config_files']='/unaccepted-branch'
        with self.assertRaisesRegex(ValueError,'DIVERGENT_ACTIVE_COMPOSE'):m.effective_plan(old,images)

class PolicyTests(unittest.TestCase):
    def setup_policy(self):
        script=b'if managed: MANAGED_RELEASE_BLOCKS_LEGACY_SYNC';condition=b'[Unit]\nConditionPathExists=!/etc/synapse/managed-release.json\n'
        data={m.LEGACY_EXECUTABLE:script,'/opt/synapse/ops/synapse-sync':script,'/etc/systemd/system/synapse-sync.service.d/50-managed-release.conf':condition,
              '/etc/synapse/managed-release.json':b'policy','/opt/synapse/caddy/Caddyfile':b'caddy'}
        state={'exec':m.LEGACY_EXECUTABLE,'active':'inactive','enabled':'disabled','exists':False,'symlink':False};reads=[]
        class Absent:
            def exists(self):return state['exists']
            def is_symlink(self):return state['symlink']
            def __str__(self):return '/usr/local/sbin/synapse-sync'
        def run(argv,**kwargs):
            if argv[1]=='is-active':body=state['active']
            elif argv[1]=='is-enabled':body=state['enabled']
            else:body='{ path='+state['exec']+' ; argv[]='+state['exec']+' ; }'
            return types.SimpleNamespace(returncode=0,stdout=body.encode(),stderr=b'')
        def read(path):reads.append(str(path));return data[str(path)]
        for item in (patch.object(m,'LEGACY_SCRIPT_SHA',m.sha(script)),patch.object(m,'LEGACY_ABSENT_PATH',Absent()),patch.object(m,'safe_read',side_effect=read),patch.object(m.subprocess,'run',side_effect=run)):
            item.start();self.addCleanup(item.stop)
        return state,data,reads
    def test_actual_bin_execstart_and_both_blocking_scripts_without_sbin_read(self):
        _,_,reads=self.setup_policy();result=m.policy_state();self.assertEqual(result['execStartPath'],'/usr/local/bin/synapse-sync');self.assertNotIn('/usr/local/sbin/synapse-sync',reads)
    def test_wrong_execstart_existing_or_dangling_sbin_rejected(self):
        state,_,_=self.setup_policy();state['exec']='/wrong'
        with self.assertRaisesRegex(ValueError,'EXACT_LEGACY_EXECSTART'):m.policy_state()
        state['exec']=m.LEGACY_EXECUTABLE;state['exists']=True
        with self.assertRaisesRegex(ValueError,'LEGACY_SBIN'):m.policy_state()
        state['exists']=False;state['symlink']=True
        with self.assertRaisesRegex(ValueError,'LEGACY_SBIN'):m.policy_state()
    def test_changed_script_dropin_or_timer_rejected(self):
        state,data,_=self.setup_policy();saved=data[m.LEGACY_EXECUTABLE];data[m.LEGACY_EXECUTABLE]=b'changed'
        with self.assertRaisesRegex(ValueError,'EXACT_BLOCKING_LEGACY'):m.policy_state()
        data[m.LEGACY_EXECUTABLE]=saved;data['/etc/systemd/system/synapse-sync.service.d/50-managed-release.conf']=b'[Unit]\n'
        with self.assertRaisesRegex(ValueError,'EXACT_MANAGED_RELEASE_CONDITION'):m.policy_state()
        state['active']='active'
        with self.assertRaisesRegex(ValueError,'LEGACY_SYNC'):m.policy_state()
    def test_real_root_script_pin_is_fixed(self):self.assertEqual(m.LEGACY_SCRIPT_SHA,'91323f3430ee65b8df371c055d4fd1d3d7ff2762a09c5a379ee35263416cced7')

class LegacyAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='synthetic-r4-queue-');self.path=Path(self.temp.name)/'crm.sqlite';self.db=sqlite3.connect(self.path,isolation_level=None)
        self.legacy_id=31415;self.expiry=m.time.time()+1800
        due=datetime.fromtimestamp(m.time.time()+7200,timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
        self.db.executescript("CREATE TABLE leads(id INTEGER PRIMARY KEY,company_code TEXT,name TEXT,contact TEXT,attachment BLOB);CREATE TABLE lead_email_outbox(lead_id INTEGER PRIMARY KEY,status TEXT,attempts INTEGER,created_at TEXT,next_attempt_at TEXT,last_attempt_at TEXT,last_error_code TEXT,sent_at TEXT,repeated_at TEXT);CREATE TABLE company_email_recipients(company_code TEXT PRIMARY KEY,recipient TEXT,updated_at TEXT);CREATE TABLE email_settings(singleton INTEGER PRIMARY KEY,revision INTEGER,encrypted_json TEXT,updated_at TEXT);")
        self.db.execute('INSERT INTO leads VALUES(?,?,?,?,?)',(self.legacy_id,'synapse-business','synthetic legacy','no contact',b'\x00\xff'))
        self.db.execute('INSERT INTO lead_email_outbox VALUES(?,?,?,?,?,?,?,?,?)',(self.legacy_id,'pending',17,'2020-01-01T00:00:00.000Z',due,'2020-01-01T01:00:00.000Z','EMAIL_RECIPIENT_MISSING',None,None))
        self.env=['LEADS_NOTIFY_EMAIL=','SYNTHETIC_FIXED_SETTING=same']
        self.proof={'oldResolverEmpty':True,'candidateResolverEmpty':True,'sourceImage':m.KNOWN_IMAGES[m.CRM],'settingsBefore':m.GLOBAL_ROUTE_SETTINGS_BEFORE,'settingsAfter':m.GLOBAL_ROUTE_SETTINGS_AFTER}
        self.reopen();self.base=json.loads(m.enc(m.db_facts(self.db)));self.admission=m.capture_legacy_admission(self.db,self.env,self.legacy_id,self.proof)
    def reopen(self):self.db.close();self.db=sqlite3.connect(self.path,isolation_level=None)
    def tearDown(self):self.db.close();self.temp.cleanup()
    def verify(self):return m.verify_delivery_admission(self.db,self.env,self.admission,self.expiry,self.proof)
    def test_exact_selected_job_seal_no_writes_no_autoselection(self):
        self.verify();self.assertEqual(self.db.total_changes,0);self.assertEqual(self.admission['retainedDormantPending'],1);self.assertTrue(self.admission['historicalSMTPNotAssessed'])
        with self.assertRaisesRegex(ValueError,'ONLY_EXPLICIT'):m.capture_legacy_admission(self.db,self.env,self.legacy_id+1,self.proof)
        with self.assertRaisesRegex(ValueError,'FRESH_EMPTY'):m.verify_delivery_admission(self.db,self.env,None,self.expiry,None)
    def test_unknown_smtp_errors_sending_and_other_pending_refused(self):
        for status,error in [('sending','EMAIL_RECIPIENT_MISSING'),('pending','SMTP_CONNECTION'),('pending','EMAIL_DELIVERY_UNCONFIRMED')]:
            self.db.execute('UPDATE lead_email_outbox SET status=?,last_error_code=?',(status,error))
            with self.assertRaises(ValueError):self.verify()
        self.db.execute("UPDATE lead_email_outbox SET status='pending',last_error_code='EMAIL_RECIPIENT_MISSING'")
        self.db.execute("INSERT INTO leads VALUES(777,'avokado','synthetic','none',NULL)");self.db.execute("INSERT INTO lead_email_outbox VALUES(777,'pending',1,'old','future','old','EMAIL_RECIPIENT_MISSING',NULL,NULL)")
        with self.assertRaisesRegex(ValueError,'ONLY_EXPLICIT'):self.verify()
    def test_each_old_record_change_or_natural_tick_invalidates_seal(self):
        for query in ("UPDATE lead_email_outbox SET attempts=attempts+1","UPDATE lead_email_outbox SET repeated_at='changed'","UPDATE leads SET contact='changed'"):
            self.db.execute('SAVEPOINT t');self.db.execute(query)
            with self.assertRaisesRegex(ValueError,'SEAL_CHANGED'):self.verify()
            self.db.execute('ROLLBACK TO t');self.db.execute('RELEASE t')
    def test_route_absence_must_be_proven_not_sender_failure(self):
        for route in ('owner@example.test','\u0085'):
            with self.assertRaisesRegex(ValueError,'GLOBAL_ROUTE'):m.capture_legacy_admission(self.db,['LEADS_NOTIFY_EMAIL='+route],self.legacy_id,self.proof)
        self.db.execute("INSERT INTO company_email_recipients VALUES('synapse-business','','synthetic')")
        with self.assertRaisesRegex(ValueError,'OVERRIDE_MUST_BE_ABSENT'):self.verify()
    def test_full_env_and_sender_opaque_settings_changes_invalidate_seal(self):
        self.env.append('OTHER_SYNTHETIC_SETTING=changed')
        with self.assertRaisesRegex(ValueError,'SEAL_CHANGED'):self.verify()
        self.env.pop();self.db.execute("INSERT INTO email_settings VALUES(1,1,'opaque synthetic settings','synthetic')")
        with self.assertRaisesRegex(ValueError,'SEAL_CHANGED'):self.verify()
    def test_fixed_action_deadline_margin_and_read_after_expiry(self):
        self.expiry=self.admission['nextDueEpoch']-600
        with self.assertRaisesRegex(ValueError,'MARGIN'):self.verify()
        self.expiry=m.time.time()-100;self.verify()
    def test_linked_company_change_or_unproven_resolver_refused(self):
        self.db.execute("UPDATE leads SET company_code='avokado'")
        with self.assertRaisesRegex(ValueError,'COMPANY_BUCKET'):self.verify()
        self.db.execute("UPDATE leads SET company_code='synapse-business'");self.proof['oldResolverEmpty']=False
        with self.assertRaisesRegex(ValueError,'POSITIVE_EMPTY_ROUTE'):self.verify()
    def test_missing_lead_routing_column_is_not_assumed_synapse(self):
        self.db.execute('ALTER TABLE leads RENAME COLUMN company_code TO changed_column')
        with self.assertRaisesRegex(ValueError,'EXACT_LEGACY_LEAD_ROUTING_FIELD'):self.verify()
    def test_backup_additive_ledger_no_old_job_send_and_exact_rows_preserved(self):
        destination=Path(self.temp.name)/'backup.sqlite';m.assert_database(self.db,self.base,False,self.admission)
        m.create_backup(self.path,destination,self.base,lambda:None,queue_admission=self.admission)
        self.db.execute(m.LEDGER_SQL);self.reopen();self.verify();m.assert_database(self.db,self.base,True,self.admission)
        self.assertEqual(self.db.execute('SELECT count(*) FROM lead_email_recipients').fetchone(),(0,))
        self.db.execute('INSERT INTO lead_email_recipients(lead_id,recipient) VALUES(?,?)',(self.legacy_id,'a@example.test'))
        with self.assertRaisesRegex(ValueError,'NO_LEGACY_DELIVERY_LEDGER'):self.verify()
    def test_pure_route_probe_mounts_public_code_only_no_smtp_factory(self):
        manifest={'runtime':[{'file':'candidate/crm/email-settings.js','beforeSha256':m.GLOBAL_ROUTE_SETTINGS_BEFORE,'sha256':m.GLOBAL_ROUTE_SETTINGS_AFTER}]}
        calls=[]
        def run(argv,**kwargs):calls.append(argv);return types.SimpleNamespace(returncode=0,stdout=b'{"oldResolverEmpty":true,"candidateResolverEmpty":true}',stderr=b'')
        area=Path(self.temp.name)
        with patch.object(m,'AREA',area),patch.object(m.subprocess,'run',side_effect=run):self.assertEqual(m.queue_route_probe(manifest),self.proof)
        argv=calls[0];self.assertIn('--pull=never',argv);self.assertIn('--network=none',argv);self.assertIn('--read-only',argv)
        self.assertEqual(argv[argv.index('--mount')+1],'type=bind,src='+str(area/'code/candidate/crm')+',dst=/review,readonly')
        self.assertNotIn('createEmailNotifications(',argv[-1]);self.assertNotIn('sendMail(',argv[-1]);self.assertNotIn('--env',argv)

if __name__=='__main__':unittest.main(verbosity=2)
