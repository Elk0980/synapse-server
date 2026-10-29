"""Offline only. Docker/systemctl/network observations and lifecycle are fixtures."""
from pathlib import Path
import copy, importlib.util, io, json, os, sqlite3, tempfile, time, unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('inline_release',Path(__file__).with_name('install.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();self.area=self.root/'releases'/m.NAME;self.area.mkdir(parents=True)
        self.database=self.root/'crm.sqlite';db=sqlite3.connect(self.database)
        db.executescript('CREATE TABLE lead_email_outbox(lead_id INTEGER PRIMARY KEY,status TEXT);CREATE TABLE autoposting_posts(id INTEGER PRIMARY KEY,status TEXT,scheduled_at TEXT);CREATE TABLE autoposting_deliveries(id INTEGER PRIMARY KEY,status TEXT);CREATE TABLE preserved(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO preserved VALUES(1,"fixture-private-data");');db.close()
        self.rows=[]
        for index,target in enumerate(m.SCOPE):
            path=self.root/target;path.parent.mkdir(parents=True,exist_ok=True)
            old=('before-'+str(index)).encode();new=('after-'+str(index)).encode()
            if target not in m.NEW:path.write_bytes(old)
            payload=self.area/'payload'/target;payload.parent.mkdir(parents=True,exist_ok=True);payload.write_bytes(new)
            self.rows.append({'target':target,'beforeSha256':None if target in m.NEW else m.sha(old),'afterSha256':m.sha(new),'bytes':len(new)})
        self.foreign=self.root/'sites/synapse/preserve.js';self.foreign.write_bytes(b'unchanged-static')
        self.images={name:'sha256:'+str(index+1)*64 for index,name in enumerate(m.CONTAINERS)}
        self.manifest={'schema':1,'packageId':m.NAME,'status':'ROOT_REVIEWED_CODE_ONLY','helperSha256':m.sha(m.SELF.read_bytes()),'expectedImages':self.images,'files':self.rows}
        self.store_manifest()
        self.before_tree={Path(row['target']).name:{'type':'file','nlink':1,'mode':0o644,'uid':0,'gid':0,'bytes':len(('before-'+str(i)).encode()),'sha256':row['beforeSha256']} for i,row in enumerate(self.rows) if row['target'] in m.RUNTIME}
        self.before_tree['preserve-module.js']={'type':'file','nlink':1,'mode':0o644,'uid':0,'gid':0,'bytes':9,'sha256':'f'*64}
        self.child={'image':'sha256:'+'a'*64,'parent':self.images[m.CRM]}
        self.current={name:self.container(name,index) for index,name in enumerate(m.CONTAINERS)}
        self.base_plan={'project':'synapse','directory':str(self.root),'files':[],'resolved':{'services':{('crm' if name==m.CRM else 'service'+str(i)):{'image':self.images[name]} for i,name in enumerate(m.CONTAINERS)}},'ownChains':{name:{'service':'crm' if name==m.CRM else 'service'+str(i),'files':[],'configHash':'b'*64} for i,name in enumerate(m.CONTAINERS)}}
        self.order=[];self.commands=[];self.original_publish=m.publish_one;self.original_build=m.build_child
        def file_info(path):
            path=Path(path);m.need(path.resolve()==path and not path.is_symlink(),'CANONICAL_TARGET');info=path.stat()
            m.need(path.is_file() and info.st_nlink==1,'ROOT_SINGLE_FILE');return {'mode':0o644,'uid':0,'gid':0}
        def parent_info(path):
            p=Path(path).parent;m.need(p.resolve()==p and p.is_dir(),'CANONICAL_PARENT');return {'mode':0o755,'uid':0,'gid':0}
        def effective(rows,images):
            m.need(all(rows[name]['Image']==images[name] for name in m.CONTAINERS),'ALL_FIVE_ACTUAL_IMAGE_PINS')
            return copy.deepcopy(self.base_plan if rows[m.CRM]['Image']==self.images[m.CRM] else m.load(self.area/'forward-plan.json'))
        self.patches=[patch.object(m,'ROOT',self.root),patch.object(m,'AREA',self.area),patch.object(m,'own_lease',return_value={'pid':123,'startTicks':'456'}),
                      patch.object(m,'inspect_container',side_effect=lambda name:copy.deepcopy(self.current[name])),
                      patch.object(m,'runtime_tree',side_effect=lambda row:copy.deepcopy(self.before_tree if row['Image']==self.images[m.CRM] else m.expected_tree(m.load(self.area/'base.json'),self.manifest))),
                      patch.object(m,'image_tree',side_effect=lambda image:copy.deepcopy(self.before_tree if image==self.images[m.CRM] else m.expected_tree(m.load(self.area/'base.json'),self.manifest))),
                      patch.object(m,'db_path',return_value=self.database),patch.object(m,'effective_plan',side_effect=effective),
                      patch.object(m,'policy_state',return_value={'legacyDisabled':True,'managedPolicy':'fixture'}),patch.object(m,'price_pin',return_value={'version':83,'sha256':'fixture'}),
                      patch.object(m,'file_info',side_effect=file_info),patch.object(m,'parent_info',side_effect=parent_info),patch.object(m,'sync_dir'),patch.object(m.os,'chown',create=True),
                      patch.object(m,'run',side_effect=self.command),patch.object(m,'build_child',side_effect=self.build_child),patch.object(m,'service_hash',return_value='b'*64),
                      patch.object(m,'publish_one',side_effect=self.publish)]
        if os.name=='nt':
            # Python Windows path.lstat ctime is creation-time, fd.fstat ctime may
            # be change-time. Native helper is Linux-only and retains its ctime CAS.
            def windows_read(path):
                path=Path(path)
                for part in (path,*path.parents):m.need(not part.is_symlink(),'PATH_ALIAS')
                before=path.lstat();data=path.read_bytes();after=path.lstat()
                keys=('st_dev','st_ino','st_size','st_mode','st_uid','st_gid','st_nlink','st_mtime_ns')
                m.need(path.is_file() and before.st_nlink==1 and len(data)==before.st_size and all(getattr(before,k)==getattr(after,k) for k in keys),'WINDOWS_FIXTURE_STABLE_READ')
                return data
            self.patches.append(patch.object(m,'safe_read',side_effect=windows_read))
        for item in self.patches:item.start()

    def tearDown(self):
        for item in reversed(self.patches):item.stop()
        self.temp.cleanup()

    def container(self,name,index):
        cid=str(index+1)*64
        return {'Name':'/'+name,'Id':cid,'Image':self.images[name],'Config':{'Image':self.images[name],'Hostname':cid[:12],'Env':['PORT=8080'],
            'Labels':{'com.docker.compose.image':self.images[name],'com.docker.compose.config-hash':'b'*64,'com.docker.compose.project.config_files':'/fixture/compose.yml'}},
            'HostConfig':{'RestartPolicy':{'Name':'always'}},'Mounts':[{'Destination':'/data','Source':'/fixture/data','RW':True}],
            'NetworkSettings':{'SandboxID':'same-sandbox','Networks':{'synapse_default':{'EndpointID':'endpoint','MacAddress':'mac','IPAddress':'172.18.0.2','GlobalIPv6Address':'','Aliases':[name,cid[:12]],'DNSNames':[name,cid[:12]],'IPAMConfig':None}}},
            'State':{'Running':True,'Restarting':False,'OOMKilled':False,'StartedAt':'before','FinishedAt':'','ExitCode':0},'RestartCount':0}

    def store_manifest(self):
        (self.area/'manifest.json').write_bytes(m.enc(self.manifest))
        (self.area/'stage.json').write_bytes(m.enc({'commit':'c'*40,'helperSha256':m.sha(m.SELF.read_bytes()),'manifestSha256':m.sha((self.area/'manifest.json').read_bytes())}))

    def command(self,argv,timeout=90):
        self.commands.append(argv)
        if 'config' in argv and '--format' in argv:
            value=copy.deepcopy(self.base_plan['resolved']);value['services']['crm']['image']=self.child['image'];return m.enc(value)
        if 'up' in argv:
            self.assertEqual(argv[-7:],['up','--detach','--no-build','--pull','never','--no-deps','crm'])
            row=self.current[m.CRM];row['Id']='d'*64;row['Image']=self.child['image'];row['Config']['Image']=self.child['image'];row['Config']['Hostname']='d'*12
            facts=row['NetworkSettings']['Networks']['synapse_default'];facts['Aliases']=[m.CRM,'d'*12];facts['DNSNames']=[m.CRM,'d'*12]
            return b''
        raise AssertionError('unmocked command '+str(argv))

    def build_child(self,base,manifest,guard):guard();return self.child
    def publish(self,row,base):self.order.append(row['target']);return self.original_publish(row,base)

    def alter_database(self,sql):
        con=sqlite3.connect(self.database);con.execute(sql);con.commit();con.close()

    def test_full_prepare_backup_single_crm_apply_html_last_independent_inspect(self):
        m.prepare();m.apply();m.inspect_result()
        self.assertEqual(self.foreign.read_bytes(),b'unchanged-static')
        self.assertEqual(self.order[-1],m.PREFIX+'cabinet.html');self.assertEqual(self.order[:len(m.NEW)],list(m.NEW))
        for row in self.rows:self.assertEqual(m.sha((self.root/row['target']).read_bytes()),row['afterSha256'])
        self.assertEqual(len([cmd for cmd in self.commands if 'up' in cmd]),1)
        result=m.load(self.area/'installed.json');self.assertEqual((result['runtimeSources'],result['staticFiles'],result['newStaticFiles']),(2,9,4));self.assertEqual((result['crmRestarts'],result['otherServiceRestarts'],result['directDatabaseWrites']),(1,0,0))
        with self.assertRaisesRegex(ValueError,'TARGET_CAS_CHANGED|ONE_APPLY'):m.apply()

    def test_due_email_refuses_before_base_backup_or_lifecycle(self):
        self.alter_database("INSERT INTO lead_email_outbox VALUES(1,'pending')")
        with self.assertRaisesRegex(ValueError,'DUE_OR_UNCERTAIN_QUEUE_REFUSED emails=1'):m.prepare()
        self.assertFalse((self.area/'base.json').exists());self.assertFalse((self.area/'backup').exists());self.assertFalse(self.commands)

    def test_due_or_publishing_posts_refuse_and_future_post_is_readonly(self):
        self.alter_database("INSERT INTO autoposting_posts VALUES(1,'scheduled','2020-01-01T00:00:00Z')")
        with self.assertRaisesRegex(ValueError,'dueBeforeMargin=1'):m.prepare()
        self.alter_database("UPDATE autoposting_posts SET scheduled_at='2099-01-01T00:00:00Z'");m.prepare()
        with m.db_open(self.database) as connection:self.assertEqual(connection.execute('SELECT status FROM autoposting_posts').fetchone(),('scheduled',));self.assertEqual(connection.total_changes,0)

    def test_publishing_delivery_refused(self):
        self.alter_database("INSERT INTO autoposting_deliveries VALUES(1,'publishing')")
        with self.assertRaisesRegex(ValueError,'deliveries=1'):m.prepare()

    def test_new_static_collision_refuses_before_base(self):
        (self.root/m.NEW[0]).write_bytes(b'foreign')
        with self.assertRaisesRegex(ValueError,'NEW_TARGET_COLLISION'):m.prepare()
        self.assertFalse((self.area/'base.json').exists())

    def test_image_tree_mismatch_refuses_before_base(self):
        with patch.object(m,'image_tree',return_value={}):
            with self.assertRaisesRegex(ValueError,'RUNNING_IMAGE_FULL_TREE_MUST_MATCH'):m.prepare()
        self.assertFalse((self.area/'base.json').exists())

    def test_host_vs_image_source_mismatch_refuses(self):
        self.before_tree['server.js']['sha256']='e'*64
        with self.assertRaisesRegex(ValueError,'HOST_RUNNING_IMAGE_SOURCE_PIN_MUST_MATCH'):m.prepare()

    def test_old_database_rows_or_schema_changed_refuse_before_lifecycle(self):
        m.prepare();self.alter_database("UPDATE preserved SET value='new data' WHERE id=1")
        with self.assertRaisesRegex(ValueError,'DATABASE_SCHEMA_OR_ROWS_CHANGED'):m.apply()
        self.assertFalse((self.area/'apply-attempt.json').exists());self.assertFalse(self.commands)

    def test_other_container_or_price_changed_refuse_before_lifecycle(self):
        m.prepare();self.current[m.CONTENT]['RestartCount']=1
        with self.assertRaisesRegex(ValueError,'OTHER_CONTAINER_CHANGED'):m.apply()
        self.current[m.CONTENT]['RestartCount']=0
        with patch.object(m,'price_pin',return_value={'version':84,'sha256':'new'}):
            with self.assertRaisesRegex(ValueError,'POLICY_STATIC_OR_PRICE_CHANGED'):m.apply()

    def test_actual_metadata_and_host_file_change_refuse(self):
        m.prepare();(self.root/m.RUNTIME[0]).write_bytes(b'foreign')
        with self.assertRaisesRegex(ValueError,'TARGET_CAS_CHANGED'):m.apply()

    def test_expired_or_other_lease_refuse(self):
        m.prepare()
        with patch.object(m,'own_lease',return_value={'pid':999,'startTicks':'999'}):
            with self.assertRaisesRegex(ValueError,'OWN_OR_NEW_READBACK_LEASE'):m.apply()
        action=m.load(self.area/'action.json');action['expires']=0;(self.area/'action.json').write_bytes(m.enc(action))
        with self.assertRaisesRegex(ValueError,'FRESH_ACTION_REQUIRED'):m.apply()

    def test_unknown_crm_up_outcome_is_not_retried(self):
        m.prepare()
        def unknown(argv,timeout=90):
            if 'up' in argv:self.commands.append(argv);raise TimeoutError('unknown fixture outcome')
            return self.command(argv,timeout)
        with patch.object(m,'run',side_effect=unknown):
            with self.assertRaises(TimeoutError):m.apply()
        self.assertEqual(len([cmd for cmd in self.commands if 'up' in cmd]),1);self.assertFalse((self.area/'installed.json').exists())
        with self.assertRaisesRegex(ValueError,'ONE_APPLY'):m.apply()

    def test_manifest_closed_scope_and_new_null_contract(self):
        bad=copy.deepcopy(self.manifest);bad['files'][0]['beforeSha256']=None
        with self.assertRaisesRegex(ValueError,'EXISTING_OR_EXACT_NEW_PIN'):m.validate_manifest(bad)
        bad=copy.deepcopy(self.manifest);bad['files'][-1]['target']='sites/synapse/cabinet/palitra-orders/shell.css'
        with self.assertRaisesRegex(ValueError,'EXACT_TWO_RUNTIME_NINE_STATIC'):m.validate_manifest(bad)

    def test_readonly_database_rejects_attempted_update_and_backup_preserves_source(self):
        with m.db_open(self.database) as connection:
            before=m.db_facts(connection)
            with self.assertRaises(sqlite3.OperationalError):connection.execute("UPDATE preserved SET value='bad'")
        m.prepare();base=m.load(self.area/'base.json');m.protected_backup(base,lambda:None)
        with m.db_open(self.database) as connection:m.assert_database(connection,before)
        with m.db_open(self.area/'crm-backup.sqlite') as connection:m.assert_database(connection,before)

    def test_atomic_new_file_cannot_clobber_concurrent_arrival(self):
        m.prepare();row=next(row for row in self.rows if row['target']==m.NEW[0]);path=self.root/row['target'];base=m.load(self.area/'base.json');original=m.os.link
        def arrive(source,destination):path.write_bytes(b'arrival');return original(source,destination)
        with patch.object(m.os,'link',side_effect=arrive):
            with self.assertRaises(FileExistsError):m.publish_one(row,base)
        self.assertEqual(path.read_bytes(),b'arrival')

    def test_stage_exact_code_and_corrupt_payload_stops_before_area(self):
        raw=m.enc(self.manifest);values={'manifest.json':raw,**{'payload/'+r['target']:(self.area/'payload'/r['target']).read_bytes() for r in self.rows}}
        def response(url,timeout):return io.BytesIO(values[url.split('/ops/'+m.NAME+'/',1)[1]])
        staged=self.root/'releases/staged-fixture'
        with patch.object(m,'AREA',staged),patch.object(m.urllib.request,'urlopen',side_effect=response):m.stage('c'*40,m.sha(raw))
        self.assertTrue((staged/'stage.json').is_file())
        values['payload/'+m.RUNTIME[0]]=b'bad'
        refused=self.root/'releases/refused-fixture'
        with patch.object(m,'AREA',refused),patch.object(m.urllib.request,'urlopen',side_effect=response):
            with self.assertRaisesRegex(ValueError,'PAYLOAD_PIN'):m.stage('c'*40,m.sha(raw))
        self.assertFalse(refused.exists())

    def build_probe(self,changed_config=False,changed_layers=False):
        m.prepare();base=m.load(self.area/'base.json');calls=[]
        parent={'Id':self.images[m.CRM],'RootFS':{'Layers':['base-layer']},'Config':{'Cmd':['node','server.js'],'Env':['PORT=8080']}}
        child={**copy.deepcopy(parent),'Id':self.child['image'],'RootFS':{'Layers':['base-layer','one-own-layer']}}
        if changed_config:child['Config']['Env'].append('NEW_PERMISSION=1')
        if changed_layers:child['RootFS']['Layers'].append('foreign-extra-layer')
        def image_info(image):return copy.deepcopy(parent if image==self.images[m.CRM] else child)
        def command(argv,timeout=90):
            calls.append(argv)
            if argv[0:3]==['docker','image','ls']:return b''
            if argv[0:3]==['docker','image','tag']:return b''
            if argv[0:2]==['docker','build']:
                Path(argv[argv.index('--iidfile')+1]).write_text(self.child['image']+'\n',encoding='ascii');return b''
            raise AssertionError('unexpected build command')
        with patch.object(m,'image_info',side_effect=image_info),patch.object(m,'run',side_effect=command):
            result=self.original_build(base,self.manifest,lambda:None)
        return result,calls

    def test_real_build_recipe_closed_two_runtime_network_none_one_layer(self):
        result,calls=self.build_probe();self.assertEqual(result,self.child)
        builds=[cmd for cmd in calls if cmd[0:2]==['docker','build']];self.assertEqual(len(builds),1)
        self.assertIn('--network=none',builds[0]);self.assertIn('--pull=false',builds[0])
        with m.tarfile.open(self.area/'build/payload.tar') as archive:self.assertEqual(set(archive.getnames()),{'autoposting.js','server.js'})

    def test_image_config_delta_cannot_pass_child_build(self):
        with self.assertRaisesRegex(ValueError,'ONE_INHERITED_CRM_LAYER'):self.build_probe(changed_config=True)

    def test_more_than_one_image_layer_cannot_pass_child_build(self):
        with self.assertRaisesRegex(ValueError,'ONE_INHERITED_CRM_LAYER'):self.build_probe(changed_layers=True)

class PureGuards(unittest.TestCase):
    def test_image_reference_rejects_control_and_multiline(self):
        plan={'project':'synapse','directory':'/opt/synapse','files':[]}
        for value in [b'one\ntwo\n',b'one\x1c\n',b'\n',b'-flag\n',b' one\n']:
            with patch.object(m,'run',return_value=value):
                with self.assertRaisesRegex(ValueError,'ONE_LOCAL_IMAGE_REFERENCE'):m.image_reference(plan,'crm')
        with patch.object(m,'run',return_value=b'local-image:tag\r\n'):self.assertEqual(m.image_reference(plan,'crm'),'local-image:tag')

    def test_different_compose_chain_refuses(self):
        self.assertEqual(m.longest_chain([['a'],['a','b']]),['a','b'])
        with self.assertRaisesRegex(ValueError,'DIVERGENT_COMPOSE_CHAINS'):m.longest_chain([['a','b'],['a','c']])

    def test_db_path_rejects_source_bind_and_traversal(self):
        with self.assertRaisesRegex(ValueError,'ONLY_EXISTING_CRM_DATA_MOUNT'):
            m.db_path({'Mounts':[{'Destination':'/data','RW':True},{'Destination':'/app','RW':True}],'Config':{'Env':[]}})
        with self.assertRaisesRegex(ValueError,'EXPECTED_CRM_DATABASE_PATH'):
            m.db_path({'Mounts':[{'Destination':'/data','Source':'/fixture','RW':True}],'Config':{'Env':['DATABASE_PATH=/data/../secret.sqlite']}})

    def test_probe_hooks_and_unexpected_startup_refused(self):
        config={'WorkingDir':'/app','Cmd':['node','server.js'],'Entrypoint':['docker-entrypoint.sh'],'Env':[]}
        m.probe_profile(config)
        for key in ['NODE_OPTIONS','NODE_PATH','LD_PRELOAD']:
            with self.assertRaisesRegex(ValueError,'READ_PROBE_HOOKS_NOT_ALLOWED'):m.probe_profile({**config,'Env':[key+'=hook']})

if __name__=='__main__':unittest.main()
