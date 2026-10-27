"""R5 offline regressions. Synthetic IDs, local fixtures, no Docker or SMTP."""
from pathlib import Path
import hashlib,zipfile
from contextlib import ExitStack
import copy,importlib.util,json,sys,tempfile,unittest
from unittest.mock import MagicMock,patch
import test_install,test_r4
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
SPEC=importlib.util.spec_from_file_location('r5_candidate',HERE/'install.py')
m=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(m)

class ImageResolverTests(unittest.TestCase):
    def fixture(self,chat_explicit=False):
        old,images,rows,chains,hashes,mutations,file_bytes=test_r4.ServiceHashTests().fixture()
        resolved={'services':{row['Config']['Labels']['com.docker.compose.service']:{'image':images[name]} for name,row in rows.items()}}
        if not chat_explicit:resolved['services']['chat']={'build':{'context':'/synthetic/chat'}}
        else:resolved['services']['chat']={'image':None,'build':{'context':'/synthetic/chat'}}
        refs={service:row.get('image') or 'synthetic-chat-local' for service,row in resolved['services'].items()}
        local={refs[row['Config']['Labels']['com.docker.compose.service']]:images[name] for name,row in rows.items()}
        commands=[];previous_run=old['run']
        def args(plan):return ['docker','compose','--project-name',plan['project'],'--project-directory',plan['directory']]+[part for row in plan['files'] for part in ('--file',row['path'])]
        def run(argv):
            commands.append(list(argv))
            if argv[-3:]==['config','--format','json']:return m.enc(resolved)
            if argv[-3:-1]==['config','--images']:return (refs[argv[-1]]+'\n').encode()
            if argv[:3]==['docker','image','inspect']:return local[argv[-1]].encode()
            return previous_run(argv)
        old.update(run=run,compose_args=args)
        return old,images,resolved,refs,local,commands,chains
    def test_build_only_service_uses_official_local_resolver_without_json_mutation(self):
        for explicit in (False,True):
            old,images,resolved,_,_,commands,chains=self.fixture(explicit);before=copy.deepcopy(resolved)
            plan=m.effective_plan(old,images)
            self.assertEqual(plan['resolved'],before);self.assertEqual(resolved,before)
            queries=[argv for argv in commands if argv[-3:-1]==['config','--images']]
            self.assertEqual({argv[-1] for argv in queries},{'crm','content','hugh-runtime','chat','caddy'});self.assertEqual(len(queries),5)
            prefix=old['compose_args'](plan)
            self.assertTrue(all(argv[:-3]==prefix for argv in queries))
            self.assertEqual([row['path'] for row in plan['files']],chains['synapse-hugh-runtime-1'])
            self.assertTrue(all(argv[:3] in (['docker','compose','--project-name'],['docker','image','inspect']) for argv in commands))
            self.assertFalse(any('pull' in argv or 'build' in argv for argv in commands))
    def test_single_exact_image_reference_only(self):
        rejected=('', '\n','one\ntwo\n','one\n\n',' one\n','one \n','one\ttwo\n','one\x00\n','one\x7f\n','-option\n','one\u00a0two\n')
        for output in rejected:
            with self.subTest(output=repr(output)):
                old={'compose_args':lambda _:['docker','compose'],'run':lambda _,output=output:output.encode()}
                with self.assertRaisesRegex(ValueError,'ONE_EXACT_LOCAL_IMAGE_REFERENCE'):m.compose_image_reference(old,{},'chat')
        old={'compose_args':lambda _:['docker','compose'],'run':lambda _:b'synthetic-chat-local\n'}
        self.assertEqual(m.compose_image_reference(old,{},'chat'),'synthetic-chat-local')
    def test_only_one_lf_or_crlf_terminator_or_no_terminator_is_accepted(self):
        for ending in ('','\n','\r\n'):
            old={'compose_args':lambda _:['docker','compose'],'run':lambda _,ending=ending:('synthetic-chat-local'+ending).encode()}
            self.assertEqual(m.compose_image_reference(old,{},'chat'),'synthetic-chat-local')
    def test_control_separators_cannot_be_discarded_as_line_terminators(self):
        for separator in ('\x0b','\x0c','\x1c','\x1d','\x1e','\u0085','\u2028','\u2029','\x00','\x7f','\u00a0','é'):
            for output in ('synthetic-chat-local'+separator,'synthetic-chat-local'+separator+'\n','synthetic'+separator+'chat\r\n'):
                with self.subTest(output=repr(output)):
                    old={'compose_args':lambda _:['docker','compose'],'run':lambda _,output=output:output.encode()}
                    with self.assertRaisesRegex(ValueError,'ONE_EXACT_LOCAL_IMAGE_REFERENCE'):m.compose_image_reference(old,{},'chat')
        for output in ('synthetic-chat-local\n\n','synthetic-chat-local\r\n\r\n','synthetic-chat-local\nanother','synthetic-chat-local\r','synthetic-chat-local\r\r\n','synthetic\rchat\r\n','\n','\r\n'):
            old={'compose_args':lambda _:['docker','compose'],'run':lambda _,output=output:output.encode()}
            with self.assertRaisesRegex(ValueError,'ONE_EXACT_LOCAL_IMAGE_REFERENCE'):m.compose_image_reference(old,{},'chat')
    def test_wrong_local_image_id_or_missing_service_fails_without_fallback(self):
        old,images,_,refs,local,commands,_=self.fixture();local[refs['chat']]='sha256:'+'0'*64
        with self.assertRaisesRegex(ValueError,'GLOBAL_PLAN_MUST_MATCH'):m.effective_plan(old,images)
        self.assertFalse(any('pull' in argv or 'build' in argv for argv in commands))
        old,images,resolved,_,_,_,_=self.fixture();del resolved['services']['chat']
        with self.assertRaisesRegex(ValueError,'GLOBAL_SERVICE_REQUIRED'):m.effective_plan(old,images)
    def test_closed_service_name_before_command(self):
        calls=[];old={'compose_args':lambda _:[],'run':lambda argv:calls.append(argv)}
        for service in ('--all','chat;whoami','chat\n',None):
            with self.assertRaisesRegex(ValueError,'CLOSED_SERVICE_NAME'):m.compose_image_reference(old,{},service)
        self.assertEqual(calls,[])
    def test_resolver_failure_is_not_retried_or_replaced(self):
        calls=[]
        def run(argv):calls.append(argv);raise RuntimeError('synthetic resolver unavailable')
        old={'compose_args':lambda _:['docker','compose'],'run':run}
        with self.assertRaises(RuntimeError):m.compose_image_reference(old,{},'chat')
        self.assertEqual(calls,[['docker','compose','config','--images','chat']])

class MetadataTests(unittest.TestCase):
    def test_corrected_server_metadata_only(self):
        self.assertEqual(m.SERVER_SHA,'b0146b3c3a9bc4a8cea15171d6edb46d178d83072dbf08945778d4be7a332248')
        self.assertNotIn('server.js',m.RUNTIME)
        self.assertEqual(m.NAME,'avocado-multi-recipient-20261027-r5')
    def test_six_reader_files_exact_r4_and_entry_only_manifest(self):
        previous=HERE/'r4-reader.zip'
        self.assertEqual(hashlib.sha256(previous.read_bytes()).hexdigest(),'676091564650b446608d89d971f57b577fd7964ccceff4f0f6431cd09f3b9d62')
        with zipfile.ZipFile(previous) as archive:
            contract=json.loads(archive.read('reader-manifest.json'))
            files={name:archive.read('reader-code/'+name) for name in contract['files']}
        names=set(files)
        self.assertEqual(names,{file.name for file in (HERE/'reader').iterdir()});self.assertEqual(len(names),6)
        for name in names:self.assertEqual(files[name],(HERE/'reader'/name).read_bytes())
        contract['entry']=m.READER_ENTRY
        self.assertEqual(contract,json.loads((HERE/'reader-manifest.json').read_bytes()))

class ActionTTLTests(unittest.TestCase):
    def test_only_explicit_integers_in_tight_range(self):
        for value in (300,600,900,1800):self.assertEqual(m.validate_action_ttl(value),value)
        for value in (299,1801,0,-1,True,False,300.0,'900',None):
            with self.assertRaisesRegex(ValueError,'EXPLICIT_ROOT_TTL'):m.validate_action_ttl(value)
    def test_max_safe_diagnostic_preserves_strict_inequality(self):
        now=1000
        for gap,expected in ((10000,1800),(2400,1799),(1500,899),(900,0),(900.1,300),(899.99,0),(600,0),(-1,0)):
            actual=m.maximum_safe_action_seconds(now+gap,now);self.assertEqual(actual,expected)
            if actual:self.assertGreater(now+gap,now+actual+600)
    def test_cli_default_and_explicit_ttl_are_forwarded_only_to_prepare(self):
        for extra,expected in (([],1800),(['--ttl','900'],900)):
            with patch.object(sys,'argv',['install.py','prepare']+extra),patch.object(m,'native_only'),patch.object(m,'prepare') as prepare:m.main()
            prepare.assert_called_once_with(action_ttl=expected)
        with patch.object(sys,'argv',['install.py','prepare','31415','a'*64,'--ttl','600']),patch.object(m,'native_only'),patch.object(m,'prepare') as prepare:m.main()
        prepare.assert_called_once_with(31415,'a'*64,action_ttl=600)
    def test_cli_ttl_outside_prepare_or_bad_value_stops_before_native(self):
        for mode in ('stage','seal','apply','inspect'):
            with patch.object(sys,'argv',['install.py',mode,'--ttl','900']),patch.object(m,'native_only') as native:
                with self.assertRaisesRegex(ValueError,'TTL_ONLY_FOR_PREPARE'):m.main()
                native.assert_not_called()
        for value in ('299','1801'):
            with patch.object(sys,'argv',['install.py','prepare','--ttl',value]),patch.object(m,'native_only') as native:
                with self.assertRaisesRegex(ValueError,'EXPLICIT_ROOT_TTL'):m.main()
                native.assert_not_called()
    def test_shorter_ttl_tightens_only_action_not_sealed_row_or_due(self):
        fixture=test_r4.LegacyAdmissionTests();fixture.setUp();self.addCleanup(fixture.tearDown)
        due=fixture.admission['nextDueEpoch'];before=copy.deepcopy(fixture.admission)
        m.verify_delivery_admission(fixture.db,fixture.env,fixture.admission,due-1500,fixture.proof)
        with self.assertRaisesRegex(ValueError,'MARGIN'):m.verify_delivery_admission(fixture.db,fixture.env,fixture.admission,due-600,fixture.proof)
        self.assertEqual(fixture.admission,before);self.assertEqual(fixture.db.total_changes,0)
    def test_prepare_seals_fixed_expiry_once_without_autopicking_or_rewriting(self):
        with tempfile.TemporaryDirectory(prefix='synthetic-r5-prepare-') as temporary,ExitStack() as stack:
            area=Path(temporary);static=area/'settings.js';static.write_bytes(b'synthetic old static')
            manifest=test_install.manifest();manifest['static'][0]['beforeSha256']=m.sha(static.read_bytes())
            tree={'server.js':{'sha256':m.SERVER_SHA}}
            for row in manifest['runtime']:
                if row['beforeSha256'] is not None:tree[Path(row['file']).name]={'type':'file','nlink':1,'sha256':row['beforeSha256']}
            content={'image':m.KNOWN_IMAGES[m.CONTENT],'appTree':{'synthetic-content':True}}
            crm={'Image':m.KNOWN_IMAGES[m.CRM],'Config':{'Env':[]}}
            old={'content_snapshot':lambda *_:content,'inspect':lambda _:crm,'tree':lambda *_:tree,'image_tree':lambda image,_:tree if image==crm['Image'] else content['appTree'],'db_identity':lambda _:[1,2]}
            admission={'sealSha256':'a'*64,'jobId':31415,'nextDueEpoch':2501}
            connection=object();context=MagicMock();context.__enter__.return_value=connection
            writes=[]
            patches={'AREA':area,'STATIC':static,'package':MagicMock(return_value=({'manifestSha256':'b'*64,'helperSha256':'c'*64},manifest,{})),
                     'primitives':MagicMock(return_value=(old,None,None,None,None)),'own_lease':MagicMock(return_value={'pid':400}),
                     'pinned_worker_probe':MagicMock(return_value={}), 'database_path':MagicMock(return_value=area/'synthetic.sqlite'),
                     'effective_plan':MagicMock(return_value={}), 'policy_state':MagicMock(return_value={}), 'queue_route_probe':MagicMock(return_value={}),
                     'db_open':MagicMock(return_value=context),'db_facts':MagicMock(return_value={'schema':[]}),
                     'capture_legacy_admission':MagicMock(return_value=admission),
                     'verify_delivery_admission':MagicMock(), 'write_new':MagicMock(side_effect=lambda path,raw:writes.append((path,json.loads(raw))))}
            for name,value in patches.items():stack.enter_context(patch.object(m,name,value))
            clock=stack.enter_context(patch.object(m.time,'time',return_value=1000))
            stack.enter_context(patch('builtins.print'))
            m.prepare(31415,'a'*64,action_ttl=900)
            action=next(value for path,value in writes if path.name=='action.json')
            self.assertEqual((action['created'],action['expires']),(1000,1900));self.assertEqual(clock.call_count,1)
            patches['verify_delivery_admission'].assert_called_once_with(connection,[],admission,1900,{})
            self.assertEqual(admission['nextDueEpoch'],2501);self.assertEqual(action['legacyAdmission'],{'jobId':31415,'sealSha256':'a'*64})
    def test_invalid_ttl_rejected_before_reading_package(self):
        with patch.object(m,'package') as package:
            with self.assertRaisesRegex(ValueError,'EXPLICIT_ROOT_TTL'):m.prepare(action_ttl=True)
            package.assert_not_called()

if __name__=='__main__':unittest.main(verbosity=2)
