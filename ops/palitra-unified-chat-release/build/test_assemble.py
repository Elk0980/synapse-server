"""Офлайн synthetic fixtures E assembler; никаких Docker/installer/server executions."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
QA = HERE.parent
REPO = HERE.parents[2]
spec = importlib.util.spec_from_file_location('palitra_e_assembler', HERE / 'assemble.py')
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)
sha = lambda data: hashlib.sha256(data).hexdigest()


class Assembly(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix='_release_scaffold_e_qa_', dir=QA)).resolve()
        self.assertEqual(self.temp.parent, QA)
        self.source, self.base = self.temp / 'SOURCE', self.temp / 'BASE'
        self.source.mkdir(); self.base.mkdir()
        reference = self.temp / 'REFERENCE'; reference.mkdir()
        self.installer = reference / 'install.py'
        self.installer.write_bytes((REPO / 'ops/palitra-app-workplace-release/install.py').read_bytes())
        self.assertEqual(sha(self.installer.read_bytes()), M.INSTALLER_SHA)
        candidate = (QA / 'payload/managed-site/assets/order.js').read_bytes()
        baseline = (REPO / 'ops/palitra-cart-checkout-release/payload/assets/order.js').read_bytes()
        self.assertEqual(sha(candidate), M.ORDER_SHA)
        self.assertEqual(sha(baseline), M.ORDER_BASE_SHA)
        self.worker_image = 'sha256:' + 'c' * 64  # synthetic; не утверждение native image
        self.source_json = {'schema': 1, 'package_id': 'synthetic-palitra-e-fixture', 'approved_finished': True, 'targets': []}
        for target in M.TARGETS:
            data = candidate if target == M.MANAGED else ('// synthetic SOURCE ' + target + '\r\n').encode()
            name = 'finished/' + target
            self.put(self.source / name, data)
            self.source_json['targets'].append({'target': target, 'source': name, 'sha256': sha(data), 'bytes': len(data)})
        runtime_rows = []
        for target in M.IMAGE_TARGETS:
            name = 'runtime/' + target
            data = ('// synthetic BASE ' + target + '\n').encode()
            value = None
            if target in M.EXISTING_RUNTIME:
                self.put(self.base / name, data); value = sha(data)
            runtime_rows.append({'target': target, 'source': name, 'sha256': value})
        preserved = []
        for target in sorted(M.PRESERVED):
            name = 'runtime/' + target; data = ('// preserved ' + target + '\n').encode()
            self.put(self.base / name, data)
            preserved.append({'target': target, 'source': name, 'sha256': sha(data)})
        self.runtime_json = {'schema': 1, 'root_approved': True, 'captured_at': '2026-10-14T06:25:00+07:00',
                             'image_id': M.IMAGE_ID, 'targets': runtime_rows, 'preserved': preserved}
        static_rows = []
        for target in M.CABINET + (M.MANAGED,):
            name = 'static/' + target
            data = baseline if target == M.MANAGED else ('// native static ' + target + '\n').encode()
            self.put(self.base / name, data)
            static_rows.append({'target': target, 'source': name, 'sha256': sha(data)})
        self.static_json = {'schema': 1, 'root_approved': True, 'captured_at': '2026-10-14T06:25:00+07:00', 'targets': static_rows}
        worker_data = b'// synthetic existing worker BASE\n'
        name = 'worker/ops/chat/client-bot-bridge.js'; self.put(self.base / name, worker_data)
        self.worker_json = {'schema': 1, 'root_approved': True, 'captured_at': '2026-10-14T06:25:00+07:00',
                            'image_id': self.worker_image, 'targets': [{'target': M.WORKER_TARGETS[0], 'source': name,
                                                                       'sha256': sha(worker_data), 'bytes': len(worker_data)}]}
        self.sm = self.source / 'source.json'; self.rm = self.base / 'runtime.json'
        self.tm = self.base / 'static.json'; self.wm = self.base / 'worker.json'
        self.output = self.temp / 'OUTPUT'
        self.flush()
        self.args = dict(source_root=self.source, source_manifest=self.sm, base_root=self.base,
                         runtime_manifest=self.rm, static_manifest=self.tm, worker_base_manifest=self.wm,
                         expected_worker_image=self.worker_image, installer=self.installer, output=self.output)

    def tearDown(self):
        resolved = self.temp.resolve(strict=True)
        self.assertEqual(resolved, self.temp)
        self.assertEqual(resolved.parent, QA)
        self.assertTrue(resolved.name.startswith('_release_scaffold_e_qa_'))
        shutil.rmtree(resolved)  # один свой проверенный абсолютный root, без shell deletion
        self.assertFalse(resolved.exists())

    @staticmethod
    def put(path, data):
        path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)

    def flush(self):
        for path, value in ((self.sm, self.source_json), (self.rm, self.runtime_json),
                            (self.tm, self.static_json), (self.wm, self.worker_json)):
            path.write_bytes((json.dumps(value) + '\n').encode())

    def inputs(self):
        return {str(p.relative_to(self.temp)): p.read_bytes() for p in self.temp.rglob('*')
                if p.is_file() and not p.is_relative_to(self.output)}

    def refuses(self, **overrides):
        with self.assertRaises(M.Refused):
            M.assemble(**dict(self.args, **overrides))
        self.assertFalse(self.output.exists(), 'refusal до первого OUTPUT write')

    def test_success16_exact_readback_two_distinct_images(self):
        before = self.inputs(); result = M.assemble(**self.args)
        self.assertEqual(result['payload_targets'], 16)
        payloads = [p for p in (self.output / 'payload').rglob('*') if p.is_file()]
        self.assertEqual(len(payloads), 16)
        for row in self.source_json['targets']:
            self.assertEqual((self.output / 'payload' / row['target']).read_bytes(), (self.source / row['source']).read_bytes())
        content = (self.output / 'Dockerfile').read_text().splitlines()
        worker = (self.output / 'Dockerfile.worker').read_text().splitlines()
        self.assertEqual(content[0], 'FROM ' + M.IMAGE_ID); self.assertEqual(len(content), 12)
        self.assertEqual(worker, ['FROM ' + self.worker_image, 'COPY payload/ops/chat/client-bot-bridge.js /app/client-bot-bridge.js'])
        self.assertTrue(all(line.startswith('COPY payload/content/') for line in content[1:]))
        self.assertEqual(before, self.inputs())

    def test_check_is_readonly_no_output(self):
        before = self.inputs(); result = M.assemble(**self.args, check=True)
        self.assertEqual(result['mode'], 'read_only'); self.assertFalse(self.output.exists())
        self.assertEqual(before, self.inputs())

    def test_old14_and_missing_upload_or_worker_refused(self):
        original = copy.deepcopy(self.source_json)
        for absent in (('content/customer-chat-upload.cjs', 'ops/chat/client-bot-bridge.js'),
                       ('content/customer-chat-upload.cjs',), ('ops/chat/client-bot-bridge.js',)):
            with self.subTest(absent=absent):
                self.source_json = copy.deepcopy(original)
                self.source_json['targets'] = [r for r in self.source_json['targets'] if r['target'] not in absent]
                self.flush(); self.refuses()

    def test_worker_requires_nonnull_sha_exact_bytes(self):
        original = copy.deepcopy(self.worker_json)
        for key, value in (('sha256', None), ('sha256', '0' * 64), ('bytes', None), ('bytes', 1), ('bytes', True)):
            with self.subTest(key=key, value=value):
                self.worker_json = copy.deepcopy(original); self.worker_json['targets'][0][key] = value
                self.flush(); self.refuses()

    def test_worker_image_trusted_input_fullsha_separate(self):
        for image in ('c5dd4502daf6', 'sha256:' + 'c' * 63, M.IMAGE_ID, 'sha256:' + 'd' * 64):
            with self.subTest(image=image): self.refuses(expected_worker_image=image)

    def test_mixed_groups_refused(self):
        self.runtime_json['targets'][0]['target'] = M.WORKER_TARGETS[0]; self.flush(); self.refuses()

    def test_eol_change_after_manifest_refused(self):
        row = next(r for r in self.source_json['targets'] if r['target'] == M.WORKER_TARGETS[0])
        p = self.source / row['source']; p.write_bytes(p.read_bytes().replace(b'\r\n', b'\n'))
        self.refuses()

    def test_source_change_between_prepare_and_copy_refused(self):
        original = M.prepare
        def changed(*args, **kwargs):
            value = original(*args, **kwargs)
            row = self.source_json['targets'][0]; p = self.source / row['source']; p.write_bytes(p.read_bytes() + b'changed')
            return value
        with mock.patch.object(M, 'prepare', changed): self.refuses()

    def test_preserved_module_changed_refused(self):
        row = self.runtime_json['preserved'][0]; p = self.base / row['source']; p.write_bytes(p.read_bytes() + b'changed')
        self.refuses()

    def test_malformed_duplicate_and_untimed_worker_manifest(self):
        original = copy.deepcopy(self.worker_json)
        for data in (b'{"schema":1,"schema":1}', b'[]', b'not-json'):
            with self.subTest(data=data): self.wm.write_bytes(data); self.refuses()
        self.worker_json = original; self.worker_json['captured_at'] = '2026-10-14T06:25:00'; self.flush(); self.refuses()

    def test_cabinet_noop_and_unapproved_source_refused(self):
        self.source_json['approved_finished'] = False; self.flush(); self.refuses()
        self.source_json['approved_finished'] = True
        row = self.static_json['targets'][0]; candidate = next(r for r in self.source_json['targets'] if r['target'] == row['target'])
        data = (self.source / candidate['source']).read_bytes(); self.put(self.base / row['source'], data); row['sha256'] = sha(data)
        self.flush(); self.refuses()

    def test_mandatory_existing3_new8_absence_and_static_nonnull(self):
        original = copy.deepcopy(self.runtime_json)
        self.runtime_json['targets'][0]['sha256'] = None; self.flush(); self.refuses()
        self.runtime_json = original
        row = next(r for r in self.runtime_json['targets'] if r['target'] == 'content/customer-chat-upload.cjs')
        self.put(self.base / row['source'], b'unexpected existing upload'); self.flush(); self.refuses()
        (self.base / row['source']).unlink()
        self.static_json['targets'][0]['sha256'] = None; self.flush(); self.refuses()

    def test_bundle_index_and_changed_existing_output_never_overwritten(self):
        M.assemble(**self.args); bundle = self.output / 'BUNDLE.json'; index = json.loads(bundle.read_text())
        self.assertEqual(index['worker_base_image_id'], self.worker_image)
        self.assertEqual(len(index['image_targets']), 11); self.assertEqual(index['worker_targets'], list(M.WORKER_TARGETS))
        for row in index['files']:
            data = (self.output / row['path']).read_bytes(); self.assertEqual((sha(data), len(data)), (row['sha256'], row['bytes']))
        bundle.write_bytes(b'own fixture changed bundle')
        with self.assertRaises(M.Refused): M.assemble(**self.args)
        self.assertEqual(bundle.read_bytes(), b'own fixture changed bundle')


if __name__ == '__main__':
    unittest.main(verbosity=2)
