"""Локальная проверка автовыпуска: python3 -m unittest ops/autosync/test_autosync.py"""
import importlib.util, json, os, pathlib, shutil, stat, subprocess, tempfile, unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('autosync', HERE / 'synapse-autosync.py')
autosync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(autosync)


def sh(*args, cwd):
    subprocess.run(args, cwd=cwd, check=True, capture_output=True)


class AutosyncTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='autosync-fixture-')
        self.addCleanup(temporary.cleanup)
        self.tmp = pathlib.Path(temporary.name)
        self.src = self.tmp / 'src'
        self.live = self.tmp / 'live'
        self.src.mkdir()
        sh('git', 'init', '-q', '-b', 'main', cwd=self.src)
        sh('git', 'config', 'user.email', 't@example.invalid', cwd=self.src)
        sh('git', 'config', 'user.name', 't', cwd=self.src)
        self.put('sites/synapse/cabinet/a.js', 'a1')
        self.put('sites/synapse/cabinet/local.js', 'l1')
        self.put('sites/synapse/cabinet.html', 'h1')
        self.put('ops/crm/server.js', 's1')
        self.commit('base')
        # Боевой: копия базы, local.js изменён вручную на сервере.
        for rel in ('sites/synapse/cabinet/a.js', 'sites/synapse/cabinet/local.js', 'sites/synapse/cabinet.html', 'ops/crm/server.js'):
            dst = self.live / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes((self.src / rel).read_bytes())
        (self.live / 'sites/synapse/cabinet/local.js').write_text('live-edit')
        self.run_sync('--init', '--no-ci')

    def put(self, rel, text):
        p = self.src / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def commit(self, msg):
        sh('git', 'add', '-A', cwd=self.src)
        sh('git', 'commit', '-q', '-m', msg, cwd=self.src)

    def run_sync(self, *extra):
        t = self.tmp
        return autosync.main(['--live-root', str(self.live), '--state-dir', str(t / 'st'),
                              '--backups', str(t / 'bk'), '--log', str(t / 'log.txt'), '--lock', str(t / 'run' / 'lock'),
                              '--repo-url', str(self.src), '--no-http', *extra])

    def test_three_way_rules(self):
        self.put('sites/synapse/cabinet/a.js', 'a2')            # не изменён на боевом → заменить
        self.put('sites/synapse/cabinet/local.js', 'l2')        # локальная правка → пропустить
        self.put('sites/synapse/cabinet/new.css', 'n1')         # новый → добавить
        self.put('sites/synapse/cabinet/x.test.cjs', 't')       # тест → не выкладывать
        self.put('sites/synapse/cabinet.html', 'h2')            # вне белого списка
        self.put('ops/crm/server.js', 's2')                     # вне белого списка
        self.commit('next')
        self.assertEqual(self.run_sync('--no-ci'), 0)
        live = lambda rel: (self.live / rel).read_text()
        self.assertEqual(live('sites/synapse/cabinet/a.js'), 'a2')
        self.assertEqual(live('sites/synapse/cabinet/local.js'), 'live-edit')
        self.assertEqual(live('sites/synapse/cabinet/new.css'), 'n1')
        self.assertFalse((self.live / 'sites/synapse/cabinet/x.test.cjs').exists())
        self.assertEqual(live('sites/synapse/cabinet.html'), 'h1')
        self.assertEqual(live('ops/crm/server.js'), 's1')
        state = json.loads((self.tmp / 'st' / 'state.json').read_text())
        self.assertEqual(sorted(state['deployed']), ['sites/synapse/cabinet/a.js', 'sites/synapse/cabinet/new.css'])
        reasons = {s['path']: s['reason'] for s in state['skipped']}
        self.assertEqual(reasons['sites/synapse/cabinet/local.js'], 'локальная правка, не трогаю')
        manifest = json.loads(next((self.tmp / 'bk').glob('*/manifest.json')).read_text())
        self.assertEqual({f['path']: f['existed'] for f in manifest['files']},
                         {'sites/synapse/cabinet/a.js': True, 'sites/synapse/cabinet/new.css': False,
                          'sites/synapse/cabinet/shell-version.json': False})
        head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=self.src, capture_output=True, text=True).stdout.strip()
        self.assertEqual(json.loads(live('sites/synapse/cabinet/shell-version.json')), {'commit': head})

    def test_rollback_on_failed_health(self):
        self.put('sites/synapse/cabinet/a.js', 'a2')
        self.put('sites/synapse/cabinet/new.css', 'n1')
        self.commit('next')
        original = autosync.http_ok
        autosync.http_ok = lambda ctx, path, data: False
        try:
            self.assertEqual(self.run_sync('--no-ci'), 1)
        finally:
            autosync.http_ok = original
        self.assertEqual((self.live / 'sites/synapse/cabinet/a.js').read_text(), 'a1')
        self.assertFalse((self.live / 'sites/synapse/cabinet/new.css').exists())
        state = json.loads((self.tmp / 'st' / 'state.json').read_text())
        self.assertIn('lastError', state)
        self.assertEqual(self.run_sync('--no-ci'), 1)  # тот же коммит повторно не выкладывается

    def test_no_change_is_noop(self):
        self.assertEqual(self.run_sync('--no-ci'), 0)
        self.assertFalse((self.tmp / 'bk').exists())


    def test_linux_ci_has_real_node(self):
        if os.name == 'posix' and os.environ.get('CI'):
            self.assertIsNotNone(shutil.which('node'), 'Linux CI must run the real node --check')

    def test_missing_node_rejects_whole_batch(self):
        self.put('sites/synapse/cabinet/aaa.css', 'body{color:red}')
        self.put('sites/synapse/cabinet/a.js', 'const valid = 1;')
        self.commit('checker unavailable')
        previous = json.loads((self.tmp / 'st' / 'state.json').read_text())
        before = {str(p.relative_to(self.live)): p.read_bytes() for p in self.live.rglob('*') if p.is_file()}
        with patch.object(autosync.shutil, 'which', return_value=None):
            self.assertTrue(autosync.node_check('asset.css', b'body{}'))
            for suffix in ['.js', '.cjs', '.mjs']:
                self.assertFalse(autosync.node_check('asset' + suffix, b'const valid = 1;'))
            self.assertEqual(self.run_sync('--no-ci'), 1)
            self.assertEqual(self.run_sync('--no-ci'), 1)
        self.assertEqual({str(p.relative_to(self.live)): p.read_bytes() for p in self.live.rglob('*') if p.is_file()}, before)
        state = json.loads((self.tmp / 'st' / 'state.json').read_text())
        self.assertEqual(state['commit'], previous['commit'])
        self.assertEqual(state['deployed'], previous['deployed'])
        self.assertIn('lastError', state)
        self.assertFalse((self.tmp / 'bk').exists())

    def test_oversized_js_rejects_batch_without_reading_blob(self):
        big = 'sites/synapse/cabinet/large.js'
        self.put(big, ' ' * (autosync.MAX_FILE + 1))
        self.put('sites/synapse/cabinet/new.css', 'body{color:red}')
        self.commit('oversized JavaScript')
        previous = json.loads((self.tmp / 'st' / 'state.json').read_text())
        head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=self.src, capture_output=True, text=True, check=True).stdout.strip()
        calls, original = [], autosync.Ctx.git
        def record(ctx, *args, **kwargs):
            calls.append(args)
            return original(ctx, *args, **kwargs)
        with patch.object(autosync.Ctx, 'git', new=record):
            self.assertEqual(self.run_sync('--no-ci'), 1)
        self.assertIn(('cat-file', '-s', f'{head}:{big}'), calls)
        self.assertNotIn(('show', f'{head}:{big}'), calls)
        self.assertFalse((self.live / big).exists())
        self.assertFalse((self.live / 'sites/synapse/cabinet/new.css').exists())
        self.assertFalse((self.live / autosync.SHELL_VERSION).exists())
        state = json.loads((self.tmp / 'st' / 'state.json').read_text())
        self.assertEqual(state['commit'], previous['commit'])
        self.assertEqual(state['deployed'], previous['deployed'])
        self.assertIn('lastError', state)
        self.assertFalse((self.tmp / 'bk').exists())

    @unittest.skipIf(os.name == 'nt', 'POSIX public directory modes require Linux CI')
    def test_new_public_directories_keep_2775_under_restrictive_umask(self):
        root = self.live / 'sites/synapse/cabinet'
        existing_mode = stat.S_IMODE(root.stat().st_mode)
        state_dir_mode = stat.S_IMODE((self.tmp / 'st').stat().st_mode)
        rel = 'sites/synapse/cabinet/new/deeper/asset.css'
        self.put(rel, 'body{color:green}')
        self.commit('nested public directories')
        previous = os.umask(0o077)
        try:
            self.assertEqual(self.run_sync('--no-ci'), 0)
        finally:
            os.umask(previous)
        for directory in [root / 'new', root / 'new/deeper']:
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o2775)
        self.assertEqual(stat.S_IMODE((self.live / rel).stat().st_mode), 0o644)
        self.assertEqual(stat.S_IMODE(root.stat().st_mode), existing_mode)
        self.assertEqual(stat.S_IMODE((self.tmp / 'st').stat().st_mode), state_dir_mode)

    @unittest.skipUnless(shutil.which('node'), 'real node --check is required')
    def test_bad_js_rejects_whole_batch_and_deduplicates_head(self):
        version = self.live / autosync.SHELL_VERSION
        version.write_bytes(b'{"commit":"previous-live-version"}\n')
        before = {str(p.relative_to(self.live)): p.read_bytes() for p in self.live.rglob('*') if p.is_file()}
        version_mtime = version.stat().st_mtime_ns
        state_path = self.tmp / 'st' / 'state.json'
        previous = json.loads(state_path.read_text())
        self.put('sites/synapse/cabinet/aaa.css', 'body{color:red}')
        self.put('sites/synapse/cabinet/new.json', '{"enabled":true}')
        self.put('sites/synapse/cabinet/a.js', 'const broken = ;')
        self.commit('mixed batch with bad JavaScript')
        head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=self.src, capture_output=True, text=True, check=True).stdout.strip()
        with patch.object(autosync, 'node_check', wraps=autosync.node_check) as checked:
            self.assertEqual(self.run_sync('--no-ci'), 1)
            first_calls = checked.call_count
            self.assertGreater(first_calls, 0)
            self.assertEqual(self.run_sync('--no-ci'), 1)
            self.assertEqual(checked.call_count, first_calls)  # failed HEAD is not retried
        after = {str(p.relative_to(self.live)): p.read_bytes() for p in self.live.rglob('*') if p.is_file()}
        self.assertEqual(after, before)
        self.assertEqual(version.stat().st_mtime_ns, version_mtime)
        state = json.loads(state_path.read_text())
        for key in ['commit', 'time', 'deployed', 'skipped', 'note', 'backup']:
            self.assertEqual(state.get(key), previous.get(key))
        self.assertEqual(state['lastError']['head'], head)
        self.assertIn('не пройдена проверка JS', state['lastError']['reason'])
        self.assertFalse((self.tmp / 'bk').exists())
        self.assertEqual((self.tmp / 'log.txt').read_text().count('STOP js-preflight'), 1)

    @unittest.skipUnless(shutil.which('node'), 'real node --check is required')
    def test_bad_js_already_equal_live_still_blocks_batch(self):
        broken = 'const broken = ;'
        self.put('sites/synapse/cabinet/a.js', broken)
        (self.live / 'sites/synapse/cabinet/a.js').write_text(broken)
        self.put('sites/synapse/cabinet/new.css', 'body{color:red}')
        previous = json.loads((self.tmp / 'st' / 'state.json').read_text())
        self.commit('already matching invalid JavaScript')
        self.assertEqual(self.run_sync('--no-ci'), 1)
        self.assertFalse((self.live / 'sites/synapse/cabinet/new.css').exists())
        self.assertFalse((self.live / autosync.SHELL_VERSION).exists())
        state = json.loads((self.tmp / 'st' / 'state.json').read_text())
        self.assertEqual(state['commit'], previous['commit'])
        self.assertEqual(state['deployed'], previous['deployed'])

    @unittest.skipUnless(shutil.which('node'), 'real node --check is required')
    def test_uppercase_js_and_oversized_mjs_block_whole_batch(self):
        previous = json.loads((self.tmp / 'st' / 'state.json').read_text())
        self.put('sites/synapse/cabinet/new.css', 'body{color:red}')
        self.put('sites/synapse/cabinet/bad.JS', 'const broken = ;')
        self.commit('invalid uppercase extension')
        self.assertEqual(self.run_sync('--no-ci'), 1)
        self.put('sites/synapse/cabinet/bad.JS', 'const valid = 1;')
        self.put('sites/synapse/cabinet/large.MJS', ' ' * (autosync.MAX_FILE + 1))
        self.commit('oversized uppercase extension')
        self.assertEqual(self.run_sync('--no-ci'), 1)
        self.assertFalse((self.live / 'sites/synapse/cabinet/new.css').exists())
        self.assertFalse((self.live / 'sites/synapse/cabinet/bad.JS').exists())
        self.assertFalse((self.live / 'sites/synapse/cabinet/large.MJS').exists())
        self.assertFalse((self.live / autosync.SHELL_VERSION).exists())
        state = json.loads((self.tmp / 'st' / 'state.json').read_text())
        self.assertEqual(state['commit'], previous['commit'])
        self.assertEqual(state['deployed'], previous['deployed'])
        self.assertFalse((self.tmp / 'bk').exists())

    @unittest.skipUnless(shutil.which('node'), 'real node --check is required')
    def test_valid_js_css_json_batch_activates_together(self):
        expected = {'sites/synapse/cabinet/a.js': 'const answer = 42;\n',
                    'sites/synapse/cabinet/new.css': 'body{color:green}',
                    'sites/synapse/cabinet/new.json': '{"enabled":true}'}
        for rel, data in expected.items():
            self.put(rel, data)
        self.commit('valid batch')
        self.assertEqual(self.run_sync('--no-ci'), 0)
        for rel, data in expected.items():
            self.assertEqual((self.live / rel).read_text(), data)
        head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=self.src, capture_output=True, text=True, check=True).stdout.strip()
        state = json.loads((self.tmp / 'st' / 'state.json').read_text())
        self.assertEqual(state['commit'], head)
        self.assertEqual(set(state['deployed']), set(expected))
        self.assertNotIn('lastError', state)
        self.assertEqual(json.loads((self.live / autosync.SHELL_VERSION).read_text()), {'commit': head})


    def test_shell_version_from_repo_is_not_deployed(self):
        self.put('sites/synapse/cabinet/shell-version.json', '{"commit":"forged"}')
        self.commit('forged')
        self.assertEqual(self.run_sync('--no-ci'), 0)
        self.assertFalse((self.live / 'sites/synapse/cabinet/shell-version.json').exists())

    @unittest.skipIf(os.name == 'nt', 'real symlink fixture requires Linux CI')
    def test_symlink_in_repo_is_skipped(self):
        os.symlink('/etc/passwd', self.src / 'sites/synapse/cabinet/link.js')
        self.commit('link')
        self.assertEqual(self.run_sync('--no-ci'), 0)
        self.assertFalse(os.path.lexists(self.live / 'sites/synapse/cabinet/link.js'))

    def test_ci_gate_waits_and_fails_closed(self):
        self.put('sites/synapse/cabinet/a.js', 'a2')
        self.commit('next')
        calls = []
        original = autosync.ci_status
        try:
            autosync.ci_status = lambda ctx, sha: calls.append(sha) or 'pending'
            self.assertEqual(self.run_sync(), 0)
            self.assertEqual(self.run_sync(), 0)          # повтор раньше CI_RECHECK — без запроса
            self.assertEqual(len(calls), 1)
            self.assertEqual((self.live / 'sites/synapse/cabinet/a.js').read_text(), 'a1')
            log = (self.tmp / 'log.txt').read_text()
            self.assertEqual(log.count('STOP ci pending'), 1)  # STOP только при смене состояния
            state_path = self.tmp / 'st' / 'state.json'
            state = json.loads(state_path.read_text()); state['ci']['checked'] = 0
            state_path.write_text(json.dumps(state))
            autosync.ci_status = lambda ctx, sha: 'fail:checks:failure'
            self.assertEqual(self.run_sync(), 0)
            self.assertEqual((self.live / 'sites/synapse/cabinet/a.js').read_text(), 'a1')
            state = json.loads(state_path.read_text()); state['ci']['checked'] = 0; state['ci']['result'] = 'pending'
            state_path.write_text(json.dumps(state))
            autosync.ci_status = lambda ctx, sha: 'ok'
            self.assertEqual(self.run_sync(), 0)
            self.assertEqual((self.live / 'sites/synapse/cabinet/a.js').read_text(), 'a2')
        finally:
            autosync.ci_status = original


if __name__ == '__main__':
    unittest.main()
