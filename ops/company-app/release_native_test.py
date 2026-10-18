import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
import os
import tempfile
import types
from unittest.mock import patch

path = Path(__file__).with_name('release-native.py')
spec = importlib.util.spec_from_file_location('company_release', path)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def manifest():
    products = ['shell.js', 'shell.css', 'synapse-bridge.js', 'native-host.js', 'cabinet.html', 'company-context.js',
                'customer-reports-ui.js', 'customer-reports-ui.css', 'report-source.html', 'report-source-ui.js', 'report-source.css']
    modules = ['runtime.cjs', 'company-app-http.cjs', 'company-context.js', 'customer-reports-http.cjs', 'customer-reports.cjs',
               'customer-report-import-http.cjs', 'customer-report-cache.cjs', 'customer-report-aggregates.cjs']
    names = ['product/' + n for n in products] + ['backend/company-app/' + n for n in modules] + ['backend/server.js', 'backend/client-bot-config.js']
    rows = []
    for name in names:
        public = name.startswith('product/')
        target = 'palitra-orders-public/' + name.split('/')[-1] if public else name.removeprefix('backend/')
        rows.append({'name': name, 'target': target, 'sha256': 'a' * 64, 'beforeSha256': None, 'bytes': 32,
                     'static': name.split('/')[-1] if public else None})
    return {'schema': 1, 'build': 'synapse-company-app-20261019-r2', 'records': rows}


class ClosedReleaseTests(unittest.TestCase):
    def publication(self, directory, old=None):
        directory = Path(directory).resolve(); self.assertEqual(directory.parent, Path(tempfile.gettempdir()).resolve()); self.assertTrue(directory.name.startswith('company-publish-')); target = directory / 'target.js'; prepared = directory / 'prepared'
        if old is not None: target.write_bytes(old)
        raw = b'new candidate code'; prepared.write_bytes(raw)
        item = release.Release.__new__(release.Release)
        item.a = types.SimpleNamespace(exact_path=lambda p, *args: Path(p), read=lambda p: Path(p).read_bytes())
        def write(p, data, mode):
            with Path(p).open('xb') as f: f.write(data)
        item.files = types.SimpleNamespace(write=write, mode=lambda p: 0o644)
        item.backups = lambda state: None; item.decision = lambda pin: None; item.lease = lambda: None; item.snapshot = lambda **kw: None
        row = {'target': str(target), 'baseSha256': release.sha(old) if old is not None else None, 'sha256': release.sha(raw), 'mode': 0o644, 'prepared': str(prepared)}
        return item, row, {'written': []}, target

    def test_exact_product_manifest_has_only_fixed_runtime_and_public_paths(self):
        rows = release.validate_records(manifest())
        self.assertEqual(len(rows), 21)
        self.assertEqual(rows['backend/server.js']['target'], 'server.js')
        self.assertIsNone(rows['backend/company-app/runtime.cjs']['static'])

    def test_extra_module_duplicate_or_foreign_target_is_refused(self):
        cases = []
        x = manifest(); x['records'][0]['name'] = 'backend/auth-store.js'; cases.append(x)
        x = manifest(); x['records'][0] = copy.deepcopy(x['records'][1]); cases.append(x)
        x = manifest(); x['records'][0]['target'] = '../data/content.sqlite'; cases.append(x)
        x = manifest(); x['records'][0]['static'] = '../cabinet.html'; cases.append(x)
        x = manifest(); x['records'].append(copy.deepcopy(x['records'][0])); cases.append(x)
        for item in cases:
            with self.subTest(item=item):
                with self.assertRaises(ValueError): release.validate_records(item)

    def test_wrong_build_digest_or_unbounded_payload_is_refused(self):
        for field, value in [('bytes', 0), ('bytes', 3 * 1024 * 1024), ('bytes', True), ('sha256', '0'), ('beforeSha256', 'wrong')]:
            item = manifest(); item['records'][0][field] = value
            with self.subTest(field=field, value=value):
                with self.assertRaises(ValueError): release.validate_records(item)
        item = manifest(); item['build'] = 'old-or-unreviewed'
        with self.assertRaises(ValueError): release.validate_records(item)

    def test_draft_cli_refuses_before_lineage_or_server_calls(self):
        result = subprocess.run([sys.executable, str(path), 'inspect-current', '--lease-pid', '999999'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        out = json.loads(result.stdout)
        self.assertTrue(out['runtimeWritesNotAssumed'])
        self.assertEqual(out['messageSha256'], release.sha(b'DRAFT_INSTALLER_NOT_FROZEN_NO_ACTION'))

    def test_report_group_rejects_orphan_and_nonprivate_files(self):
        self.assertFalse(release.private_report_db(release.ABSENT_REPORT_DB))
        valid = {'path': '/data/salon-reports.sqlite', 'files': {'db': {'uid': 0, 'mode': 0o600}, 'wal': None, 'shm': None}}
        self.assertTrue(release.private_report_db(valid))
        valid['files']['wal'] = {'uid': 0, 'mode': 0o600}
        self.assertTrue(release.private_report_db(valid))
        valid['files']['shm'] = {'uid': 0, 'mode': 0o644}
        self.assertFalse(release.private_report_db(valid))
        valid['files']['shm'] = None; valid['files']['db'] = None
        self.assertFalse(release.private_report_db(valid))

    def test_old_lease_and_implicit_apply_are_rejected_before_native_calls(self):
        with self.assertRaisesRegex(ValueError, 'FRESH_RECEIVER_LEASE_REQUIRED'): release.load36(3031696)
        item = release.Release.__new__(release.Release)
        with self.assertRaisesRegex(ValueError, 'EXPLICIT_OWN_APPLY_REQUIRED'): item.apply('a' * 64)
        with self.assertRaisesRegex(ValueError, 'EXPLICIT_ROOT_ACCEPTED_APPROVAL_REQUIRED'): item.approve('a' * 64)

    def test_new_file_is_published_exclusively_and_not_overwritten_on_a_race(self):
        with tempfile.TemporaryDirectory(prefix='company-publish-') as directory:
            item, row, state, target = self.publication(directory)
            original = os.link
            def concurrent(source, dest):
                Path(dest).write_bytes(b'concurrent code'); return original(source, dest)
            with patch.object(os, 'link', concurrent):
                with self.assertRaises(FileExistsError): item.publish(row, state, 'a' * 64)
            self.assertEqual(target.read_bytes(), b'concurrent code')
            self.assertEqual(state['written'], [])
            self.assertTrue(target.with_name(target.name + '.' + release.NAME + '.pending').exists())

    def test_existing_file_has_a_final_compare_before_replace(self):
        with tempfile.TemporaryDirectory(prefix='company-publish-') as directory:
            item, row, state, target = self.publication(directory, b'old exact code')
            calls = []
            def snapshot(**kw):
                calls.append(kw)
                if len(calls) == 2: target.write_bytes(b'newer owner code')
            item.snapshot = snapshot
            with self.assertRaisesRegex(ValueError, 'LAST_STATIC_CAS_CHANGED'): item.publish(row, state, 'a' * 64)
            self.assertEqual(target.read_bytes(), b'newer owner code')
            self.assertEqual(state['written'], [])

    def test_successful_new_and_existing_publication_records_only_exact_targets(self):
        for old in (None, b'old exact code'):
            with self.subTest(old=old), tempfile.TemporaryDirectory(prefix='company-publish-') as directory:
                item, row, state, target = self.publication(directory, old)
                item.publish(row, state, 'a' * 64)
                self.assertEqual(target.read_bytes(), b'new candidate code')
                self.assertEqual(state['written'], [str(target)])
                self.assertFalse(target.with_name(target.name + '.' + release.NAME + '.pending').exists())


if __name__ == '__main__':
    unittest.main()
