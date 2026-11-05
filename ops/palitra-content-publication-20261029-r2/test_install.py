"""Offline filesystem and in-memory HTTP fixtures. No production access."""
from pathlib import Path
import importlib.util, io, json, os, tempfile, unittest
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
                        patch.object(m, 'environment', return_value={'priceVersion': 83, 'priceSha256': 'fixture'}),
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
        self.manifest = {'packageId': m.NAME, 'helperSha256': m.sha(m.SELF.read_bytes()), 'targets': self.rows}
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
        self.assertEqual((result['files'], result['newFiles'], result['runtimeWrites']), (9, 4, 0))
        with self.assertRaisesRegex(ValueError, 'ONE_ATTEMPT'): m.apply()

    def test_changed_existing_target_refuses_before_first_write(self):
        m.prepare()
        (self.root/m.EXISTING[1]).write_bytes(b'newer-writer')
        with self.assertRaisesRegex(ValueError, 'CAS_TARGET_CHANGED'): m.apply()
        self.assertEqual(m.sha((self.root/m.SCOPE[0]).read_bytes()), self.rows[0]['beforeSha256'])
        self.assertFalse((self.area/'apply-attempt.json').exists())

    def test_new_collision_before_prepare_creates_no_backup(self):
        (self.root/m.NEW[0]).write_bytes(b'foreign')
        with self.assertRaisesRegex(ValueError, 'NEW_TARGET_COLLISION'): m.prepare()
        self.assertFalse((self.area/'backup').exists())

    def test_new_collision_after_prepare_refuses_before_any_write(self):
        m.prepare()
        (self.root/m.NEW[-1]).write_bytes(b'foreign')
        with self.assertRaisesRegex(ValueError, 'NEW_TARGET_COLLISION'): m.apply()
        self.assertFalse((self.area/'apply-attempt.json').exists())
        self.assertEqual((self.root/m.NEW[-1]).read_bytes(), b'foreign')

    def test_new_null_is_not_allowed_for_existing_target(self):
        self.manifest['targets'][0]['beforeSha256'] = None
        self.store_manifest()
        with self.assertRaisesRegex(ValueError, 'EXISTING_BEFORE_PIN'): m.prepare()

    def test_new_target_requires_null_not_hash(self):
        self.manifest['targets'][-1]['beforeSha256'] = 'b'*64
        self.store_manifest()
        with self.assertRaisesRegex(ValueError, 'NEW_TARGET_MUST_BE_ABSENT'): m.prepare()

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

    def test_broken_symlink_new_target_collision_rejected(self):
        target = self.root/m.NEW[0]
        self.make_symlink(target, self.root/'missing-file')
        with self.assertRaisesRegex(ValueError, 'NEW_TARGET_COLLISION'): m.prepare()

    def test_atomic_new_install_cannot_replace_concurrent_arrival(self):
        m.prepare()
        native_link = m.os.link
        first_new = self.root/m.NEW[0]
        def arriving_link(source, destination):
            if Path(destination) == first_new:
                first_new.write_bytes(b'foreign-arrival')
            return native_link(source, destination)
        with patch.object(m.os, 'link', side_effect=arriving_link):
            with self.assertRaises(FileExistsError): m.apply()
        self.assertEqual(first_new.read_bytes(), b'foreign-arrival')
        with self.assertRaisesRegex(ValueError, 'ROLLBACK_FOREIGN_TARGET_CHANGED'): m.rollback()
        self.assertFalse((self.area/'rollback-attempt.json').exists())

    def test_partial_apply_explicit_rollback_restores_existing_and_removes_only_own_new(self):
        m.prepare()
        original = m.after_state
        def failure(row, base):
            original(row, base)
            if row['target'] == m.EXISTING[1]:
                raise RuntimeError('fixture interrupted after own mixed writes')
        with patch.object(m, 'after_state', side_effect=failure):
            with self.assertRaisesRegex(RuntimeError, 'fixture interrupted'): m.apply()
        self.assertFalse((self.area/'installed.json').exists())
        m.rollback()
        for row in self.rows:
            path = self.root/row['target']
            if row['beforeSha256'] is None:
                self.assertFalse(os.path.lexists(path))
            else:
                self.assertEqual(m.sha(path.read_bytes()), row['beforeSha256'])
        self.assertEqual(self.foreign.read_bytes(), b'preserve')
        self.assertEqual(m.read_json(self.area/'rolled-back.json')['status'], 'STATIC_NINE_ROLLED_BACK_READBACK_PASS')
        with self.assertRaisesRegex(ValueError, 'ONE_ROLLBACK_ATTEMPT'): m.rollback()
        with self.assertRaisesRegex(ValueError, 'ONE_ATTEMPT'): m.apply()

    def test_full_apply_can_be_explicitly_rolled_back(self):
        m.prepare(); m.apply(); m.rollback()
        with self.assertRaisesRegex(ValueError, 'ROLLBACK_STARTED'): m.inspect()

    def test_apply_publishes_assets_before_html_and_rollback_reverses_actual_order(self):
        m.prepare()
        observed = []
        native_after_state = m.after_state
        def observe(row, base):
            observed.append(row['target'])
            native_after_state(row, base)
        expected = list(m.NEW) + [name for name in m.EXISTING if not name.endswith('/cabinet.html')] + [m.PREFIX+'cabinet.html']
        with patch.object(m, 'after_state', side_effect=observe):
            m.apply()
        self.assertEqual(observed[:9], expected)
        self.assertEqual([row['target'] for row in self.manifest['targets']], list(m.SCOPE))
        observed.clear()
        with patch.object(m, 'after_state', side_effect=observe):
            m.rollback()
        # Existing replacements recheck the same target immediately before rename.
        distinct = [name for index, name in enumerate(observed) if index == 0 or name != observed[index-1]]
        self.assertEqual(distinct, list(reversed(expected)))

    def test_mount_order_ignored_values_still_checked(self):
        first = {'Type': 'bind', 'Source': '/one', 'Destination': '/app', 'RW': False}
        second = {'Type': 'volume', 'Name': 'data', 'Source': '/volume', 'Destination': '/data', 'RW': True}
        self.assertEqual(m.mount_digest([first, second]), m.mount_digest([second, first]))
        self.assertNotEqual(m.mount_digest([first, second]), m.mount_digest([first, {**second, 'RW': False}]))

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
            with self.assertRaisesRegex(ValueError, 'HELPER_PIN_REQUIRED'): m.stage('a'*40, m.sha(badraw))
            self.assertFalse(refused.exists())

if __name__ == '__main__':
    unittest.main()
