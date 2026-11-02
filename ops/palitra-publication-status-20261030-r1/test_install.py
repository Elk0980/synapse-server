"""Offline filesystem and in-memory HTTP fixtures. No production access."""
from pathlib import Path
import importlib.util, io, json, os, tempfile, unittest
import ast
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('publication_static_install', Path(__file__).with_name('install.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class StaticInstallTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.area = self.root/'releases'/m.NAME
        self.area.mkdir(parents=True)
        self.patches = [patch.object(m, 'ROOT', self.root), patch.object(m, 'AREA', self.area),
                        patch.object(m, 'lease', return_value={'pid': 123, 'startTicks': '456'}),
                        patch.object(m, 'environment', return_value={'priceVersion': 83, 'priceSha256': 'fixture', 'containers': {name: {'image': 'sha256:'+str(index+1)*64} for index, name in enumerate(m.CONTAINERS)}}),
                        patch.object(m.os, 'chown', create=True), patch.object(m, 'sync_directory')]
        # Windows does not implement POSIX directory write bits or chmod(0644).
        # Emulate just those permission values; retain actual canonical/link checks.
        if os.name == 'nt':
            native_metadata = m.metadata
            def file_info(path):
                value = native_metadata(path)
                return {**value, 'mode': 0o644}
            def directory_info(path):
                parent = path.parent
                m.need(parent.resolve() == parent and parent.is_dir() and not parent.is_symlink(), 'CANONICAL_PARENT_REQUIRED')
                return {'mode': 0o755, 'uid': 0, 'gid': 0}
            self.patches.extend([patch.object(m, 'metadata', side_effect=file_info), patch.object(m, 'parent_metadata', side_effect=directory_info)])
        for p in self.patches: p.start()
        self.rows = []
        for index, name in enumerate(m.SCOPE):
            target = self.root/name
            target.parent.mkdir(parents=True, exist_ok=True)
            if name in m.EXISTING:
                target.write_bytes(('before-'+str(index)).encode())
            payload = self.area/'payload'/name
            payload.parent.mkdir(parents=True, exist_ok=True)
            payload.write_bytes(('after-'+str(index)).encode())
            self.rows.append({'target': name, 'beforeSha256': m.sha(target.read_bytes()) if name in m.EXISTING else None,
                              'afterSha256': m.sha(payload.read_bytes())})
        self.foreign = self.root/'sites/synapse/unrelated.js'
        self.foreign.write_bytes(b'preserve')
        self.manifest = {'schema':1, 'status':'ROOT_REVIEWED_CODE_ONLY', 'expectedImages':{name:'sha256:'+str(index+1)*64 for index,name in enumerate(m.CONTAINERS)}, 'packageId': m.NAME, 'helperSha256': m.sha(m.SELF.read_bytes()), 'targets': self.rows}
        self.store_manifest()

    def store_manifest(self):
        (self.area/'manifest.json').write_bytes(m.enc(self.manifest))
        (self.area/'stage.json').write_bytes(m.enc({'commit': 'a'*40, 'helperSha256': m.sha(m.SELF.read_bytes()),
                                                'manifestSha256': m.sha((self.area/'manifest.json').read_bytes())}))

    def tearDown(self):
        for p in reversed(self.patches): p.stop()
        self.temp.cleanup()

    def test_backup_apply_readback_preserves_unrelated_refuses_repeat(self):
        m.prepare(); m.apply(); m.inspect()
        for r in self.rows:
            self.assertEqual(m.sha((self.root/r['target']).read_bytes()), r['afterSha256'])
            if r['beforeSha256'] is not None:
                self.assertEqual(m.sha((self.area/'backup'/r['target']).read_bytes()), r['beforeSha256'])
            else:
                self.assertFalse((self.area/'backup'/r['target']).exists())
        self.assertEqual(self.foreign.read_bytes(), b'preserve')
        result = m.read_json(self.area/'installed.json')
        self.assertEqual((result['files'], result['newFiles'], result['runtimeWrites']), (3, 0, 0))
        with self.assertRaisesRegex(ValueError, 'ONE_ATTEMPT'): m.apply()

    def test_changed_existing_target_refuses_before_first_write(self):
        m.prepare()
        (self.root/m.EXISTING[0]).write_bytes(b'newer-writer')
        with self.assertRaisesRegex(ValueError, 'CAS_TARGET_CHANGED'): m.apply()
        self.assertEqual((self.root/m.SCOPE[0]).read_bytes(), b'newer-writer')
        self.assertFalse((self.area/'apply-attempt.json').exists())



    def test_new_null_is_not_allowed_for_existing_target(self):
        self.manifest['targets'][0]['beforeSha256'] = None
        self.store_manifest()
        with self.assertRaisesRegex(ValueError, 'EXISTING_BEFORE_PIN'): m.prepare()


    def test_missing_existing_file_fails_before_backup(self):
        (self.root/m.EXISTING[0]).unlink()
        with self.assertRaises(FileNotFoundError): m.prepare()
        self.assertFalse((self.area/'backup').exists())

    def test_foreign_environment_changed_refuses_before_write(self):
        m.prepare()
        with patch.object(m, 'environment', return_value={'priceVersion': 84, 'priceSha256': 'newer'}):
            with self.assertRaisesRegex(ValueError, 'ENVIRONMENT_OR_PRICE_CHANGED'): m.apply()
        self.assertFalse((self.area/'apply-attempt.json').exists())

    def test_changed_lease_or_expired_action_refused(self):
        m.prepare()
        with patch.object(m, 'lease', return_value={'pid': 456, 'startTicks': '789'}):
            with self.assertRaisesRegex(ValueError, 'OWN_LEASE_CHANGED'): m.apply()
        action = m.read_json(self.area/'action.json'); action['expires'] = 0
        (self.area/'action.json').write_bytes(m.enc(action))
        with self.assertRaisesRegex(ValueError, 'FRESH_ACTION'): m.apply()

    def test_extra_payload_and_changed_backup_refused(self):
        extra = self.area/'payload/foreign.js'; extra.write_bytes(b'extra')
        with self.assertRaisesRegex(ValueError, 'CLOSED_PAYLOAD'): m.prepare()
        extra.unlink(); m.prepare()
        (self.area/'backup'/m.EXISTING[0]).write_bytes(b'damaged')
        with self.assertRaisesRegex(ValueError, 'BACKUP_CHANGED'): m.apply()
        self.assertFalse((self.area/'apply-attempt.json').exists())

    def make_symlink(self, target, source):
        try:
            target.symlink_to(source)
        except (OSError, NotImplementedError) as error:
            self.skipTest('Native symlink unavailable: '+str(error))

    def test_existing_symlink_rejected(self):
        target = self.root/m.EXISTING[0]; target.unlink()
        self.make_symlink(target, self.foreign)
        with self.assertRaisesRegex(ValueError, 'CANONICAL_TARGET'): m.prepare()
        self.assertEqual(self.foreign.read_bytes(), b'preserve')






    def test_mount_order_ignored_values_still_checked(self):
        first = {'Type': 'bind', 'Source': '/one', 'Destination': '/app', 'RW': False}
        second = {'Type': 'volume', 'Name': 'data', 'Source': '/volume', 'Destination': '/data', 'RW': True}
        self.assertEqual(m.mount_digest([first, second]), m.mount_digest([second, first]))
        self.assertNotEqual(m.mount_digest([first, second]), m.mount_digest([first, {**second, 'RW': False}]))

    def test_two_file_publish_has_no_html_or_new_target(self):
        m.prepare();observed=[];original=m.after_state
        def observe(row,base):observed.append(row['target']);return original(row,base)
        with patch.object(m,'after_state',side_effect=observe):m.apply()
        expected=list(m.EXISTING)
        self.assertEqual(observed[:3],expected)

    def test_command_capability_explicitly_denies_runtime_lifecycle_and_shell(self):
        with patch.object(m.subprocess,'check_output',return_value=b'fixture') as command:
            for argv in [['docker','compose','up','crm'],['docker','build','.'],['docker','exec','synapse-crm-1','node'],['docker','run','image'],['systemctl','start','crm'],['sh','-c','anything']]:
                with self.assertRaisesRegex(ValueError,'READ_ONLY_COMMAND_ALLOWLIST'):m.command(argv)
            self.assertEqual(command.call_count,0)
            m.command(['lslocks','--json','--output','PID,PATH']);m.command(['docker','inspect',*m.CONTAINERS]);self.assertEqual(command.call_count,2)

    def test_closed_static_scope_has_no_sqlite_runtime_or_lifecycle_function(self):
        source=m.SELF.read_text(encoding='utf-8');tree=ast.parse(source)
        imported={alias.name for node in ast.walk(tree) if isinstance(node,ast.Import) for alias in node.names}
        self.assertNotIn('sqlite3',imported);self.assertEqual(len(m.SCOPE),3);self.assertEqual(len(m.NEW),0)
        self.assertTrue(all(target.startswith('sites/synapse/cabinet/palitra-orders/') for target in m.SCOPE))
        self.assertFalse(any(name in vars(m) for name in ('build_child','db_open','queue_guard','rollback')))
        calls=[node for node in ast.walk(tree) if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and isinstance(node.func.value,ast.Name) and node.func.value.id=='subprocess' and node.func.attr=='run']
        self.assertEqual(len(calls),1);self.assertEqual(ast.literal_eval(calls[0].args[0]),['systemctl','is-active','synapse-sync.timer'])

    def test_fresh_expected_image_mismatch_stops_before_backup(self):
        self.manifest['expectedImages'][m.CONTAINERS[0]]='sha256:'+'e'*64;self.store_manifest()
        with self.assertRaisesRegex(ValueError,'FRESH_FIVE_ACTUAL_IMAGES_REQUIRED'):m.prepare()
        self.assertFalse((self.area/'base.json').exists());self.assertFalse((self.area/'backup').exists())

    def test_symlink_metadata_guard_rejects_before_read_or_stat(self):
        class Symlink:
            def resolve(self): return self
            def is_symlink(self): return True
            def stat(self): raise AssertionError('must reject symlink first')
        with self.assertRaisesRegex(ValueError, 'CANONICAL_TARGET_REQUIRED'):
            m.metadata(Symlink())

    def test_stage_checks_all_pins_and_stages_without_production(self):
        raw = m.enc(self.manifest)
        files = {'manifest.json': raw, **{'payload/'+r['target']: (self.area/'payload'/r['target']).read_bytes() for r in self.rows}}
        target_area = self.root/'releases'/'second-stage'
        def response(url, timeout):
            suffix = url.split('/ops/'+m.NAME+'/', 1)[1]
            return io.BytesIO(files[suffix])
        with patch.object(m, 'AREA', target_area), patch.object(m.urllib.request, 'urlopen', side_effect=response):
            m.stage('a'*40, m.sha(raw))
            self.assertTrue((target_area/'stage.json').is_file())
        refused = self.root/'releases'/'refused-stage'
        bad = {**self.manifest}; del bad['helperSha256']; badraw = m.enc(bad)
        with patch.object(m, 'AREA', refused), patch.object(m.urllib.request, 'urlopen', return_value=io.BytesIO(badraw)):
            with self.assertRaisesRegex(ValueError, 'CLOSED_MANIFEST_REQUIRED'): m.stage('a'*40, m.sha(badraw))
            self.assertFalse(refused.exists())


    def test_second_target_changed_refuses_before_any_replacement(self):
        m.prepare()
        (self.root/m.EXISTING[1]).write_bytes(b'concurrent-second-edit')
        with self.assertRaisesRegex(ValueError,'CAS_TARGET_CHANGED'):m.apply()
        self.assertEqual((self.root/m.EXISTING[0]).read_bytes(),b'before-0')
        self.assertFalse((self.area/'apply-attempt.json').exists())

    def test_public_shop_or_third_target_cannot_enter_manifest(self):
        self.manifest['targets'].append({'target':'sites/palitra/love-app/shell.js','beforeSha256':'a'*64,'afterSha256':'b'*64})
        self.store_manifest()
        with self.assertRaisesRegex(ValueError,'EXACT_THREE_CABINET_FILES_REQUIRED'):m.prepare()
        self.assertFalse((self.area/'backup').exists())

    def test_partial_failure_freezes_attempt_without_replay_or_rollback(self):
        m.prepare();original=m.replace_existing;calls=[]
        def replace(path,raw,info,check):
            calls.append(path)
            if len(calls)==2:raise OSError('fixture interrupted second replacement')
            original(path,raw,info,check)
        with patch.object(m,'replace_existing',side_effect=replace):
            with self.assertRaisesRegex(OSError,'interrupted'):m.apply()
        self.assertEqual((self.root/m.EXISTING[0]).read_bytes(),b'after-0')
        self.assertEqual((self.root/m.EXISTING[1]).read_bytes(),b'before-1')
        self.assertFalse((self.area/'installed.json').exists())
        with self.assertRaisesRegex(ValueError,'ONE_ATTEMPT'):m.apply()
        with self.assertRaisesRegex(ValueError,'INSTALLED_READBACK_FAILED'):m.inspect()

    def test_manifest_generation_requires_both_exact_bases_and_reviewed_afters(self):
        spec=importlib.util.spec_from_file_location('customer_make_manifest',m.SELF.with_name('make_manifest.py'))
        maker=importlib.util.module_from_spec(spec);spec.loader.exec_module(maker)
        refs=Path(__file__).resolve().parents[2]
        bases=[refs/p for p in ['ops/palitra-customer-static-20261029-r1/payload/sites/synapse/cabinet/palitra-orders/palitra-publication-composer.js', 'ops/palitra-content-native-ux-20261029-r1/payload/sites/synapse/cabinet/palitra-orders/palitra-content-material-ui.js', 'ops/palitra-content-native-20261029-r1/payload/sites/synapse/cabinet/palitra-orders/palitra-content-tasks-ui.js']]
        value=maker.build(bases,self.manifest['expectedImages'])
        self.assertEqual([r['target'] for r in value['targets']],list(m.SCOPE))
        self.assertEqual(value['targets'][0]['afterSha256'],'7b4644c80a5dd897781785546eb46a80248d712ce9b7b392e09e9b96abda7dee')
        with self.assertRaisesRegex(ValueError,'FRESH_INSTALLED_TARGET_SHA_REQUIRED'):
            maker.build([self.foreign,*bases[1:]],self.manifest['expectedImages'])
        with self.assertRaisesRegex(ValueError,'FRESH_FIVE_IMAGE_PINS_REQUIRED'):maker.build(bases,{})

    def test_inherited_guard_functions_remain_byte_exact(self):
        prior=(Path(__file__).resolve().parents[1]/'palitra-customer-static-20261029-r1/install.py').read_text(encoding='utf-8')
        fresh=m.SELF.read_text(encoding='utf-8')
        def funcs(text):
            return {n.name:ast.get_source_segment(text,n) for n in ast.parse(text).body if isinstance(n,ast.FunctionDef)}
        old,new=funcs(prior),funcs(fresh)
        changed={'validate_manifest','stage','prepare','apply_order','inspect'}
        self.assertEqual(set(old),set(new))
        for name in set(old)-changed:self.assertEqual(new[name],old[name],name)
        self.assertIn("'EXACT_THREE_CABINET_FILES_REQUIRED'",new['validate_manifest'])
        self.assertNotIn('shop-shell',fresh)

if __name__ == '__main__':
    unittest.main()
