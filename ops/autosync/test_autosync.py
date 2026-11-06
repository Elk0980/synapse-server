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

    def test_static_sites_and_rollback(self):
        for name in autosync.SITE_URLS:
            (self.live / 'sites' / name).mkdir(parents=True)
            self.put(f'sites/{name}/index.html', '<h1>new</h1>')
        self.commit('sites')
        self.assertEqual(self.run_sync('--no-ci'), 0)
        for name in autosync.SITE_URLS:
            self.assertEqual((self.live / f'sites/{name}/index.html').read_text(), '<h1>new</h1>')
        self.assertFalse((self.live / autosync.SHELL_VERSION).exists())
        self.assertEqual(self.run_sync('--rollback'), 0)
        for name in autosync.SITE_URLS:
            self.assertFalse((self.live / f'sites/{name}/index.html').exists())

    def test_all_exclusions(self):
        for name in autosync.SITE_URLS:
            for tail in ('.env', '.git/config', 'foo.test.css', 'x.TEST.html', 'data.sqlite',
                         'data.db-wal', 'data.sqlite3-shm', 'Caddyfile', 'compose.yaml',
                         'docker-compose.yml', 'cabinet.html', '../escape',
                         'analytics-tests/fixture.js', 'nested/analytics-tests/fixture.html',
                         'README.md', 'NOTES.MD', 'source.bundle', 'source.BUNDLE',
                         'build-results-frames.cjs', 'helper.CJS'):
                self.assertFalse(autosync.allowed(f'sites/{name}/{tail}'), tail)
        self.assertFalse(autosync.allowed('sites/unknown/index.html'))
        self.assertFalse(autosync.allowed('panel/index.html'))

    def test_auxiliary_files_never_deploy(self):
        for root in autosync.ROOTS:
            (self.live / root).mkdir(parents=True, exist_ok=True)
            for tail in ('analytics-tests/probe.js', 'README.md', 'repo.bundle', 'build-results-frames.cjs'):
                self.put(f'{root}/{tail}', 'auxiliary')
        self.commit('auxiliary files')
        self.assertEqual(self.run_sync('--no-ci'), 0)
        for root in autosync.ROOTS:
            for tail in ('analytics-tests/probe.js', 'README.md', 'repo.bundle', 'build-results-frames.cjs'):
                self.assertFalse((self.live / root / tail).exists())

    def test_only_changed_and_preserve_site_local_edits_and_deletions(self):
        rel = 'sites/alvi/index.html'
        self.put(rel, 'base')
        self.commit('site baseline')
        (self.live / 'sites/alvi').mkdir(parents=True)
        (self.live / rel).write_text('local')
        self.run_sync('--init', '--no-ci')
        self.put(rel, 'next')
        self.commit('site next')
        self.assertEqual(self.run_sync('--no-ci'), 0)
        self.assertEqual((self.live / rel).read_text(), 'local')
        self.assertIn('локальная правка', (self.tmp / 'log.txt').read_text())
        (self.src / rel).unlink()
        self.commit('delete')
        self.assertEqual(self.run_sync('--no-ci'), 0)
        self.assertEqual((self.live / rel).read_text(), 'local')
        self.assertFalse((self.live / 'sites/synapse/cabinet.html').read_text() != 'h1')

    def test_manual_rollback_refuses_local_edit(self):
        self.put('sites/synapse/cabinet/a.js', 'a2')
        self.commit('next')
        self.assertEqual(self.run_sync('--no-ci'), 0)
        (self.live / 'sites/synapse/cabinet/a.js').write_text('local-after')
        self.assertEqual(self.run_sync('--rollback'), 1)
        self.assertEqual((self.live / 'sites/synapse/cabinet/a.js').read_text(), 'local-after')

    def test_rollback_survives_unrelated_commit(self):
        self.put('sites/synapse/cabinet/a.js', 'a2')
        self.commit('publish')
        self.assertEqual(self.run_sync('--no-ci'), 0)
        self.put('ops/crm/unused.txt', 'unrelated')
        self.commit('no static changes')
        self.assertEqual(self.run_sync('--no-ci'), 0)
        self.assertEqual(self.run_sync('--rollback'), 0)
        self.assertEqual((self.live / 'sites/synapse/cabinet/a.js').read_text(), 'a1')

    def test_busy_maintenance_reports_failure(self):
        with patch.object(autosync.fcntl, 'flock', side_effect=BlockingIOError):
            self.assertEqual(self.run_sync('--rollback'), 2)
            self.assertEqual(self.run_sync('--bootstrap-avokado'), 2)
            self.assertEqual(self.run_sync('--init'), 2)
            self.assertEqual(self.run_sync(), 0)

    def test_bootstrap_exact_hash_and_reinstall_noop(self):
        rel = autosync.AVOKADO
        (self.live / 'sites/avokado3').mkdir(parents=True)
        self.put(rel, 'old')
        self.commit('avokado old')
        (self.live / rel).write_text('old')
        self.run_sync('--init', '--no-ci')
        baseline = json.loads((self.tmp / 'st/state.json').read_text())['commit']
        self.put(rel, 'new')
        self.commit('avokado new')
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=self.src).decode().strip()
        import hashlib
        with patch.object(autosync, 'BOOTSTRAP', head), patch.object(autosync, 'OLD_SHA', hashlib.sha256(b'old').hexdigest()), patch.object(autosync, 'NEW_SHA', hashlib.sha256(b'new').hexdigest()):
            self.assertEqual(self.run_sync('--bootstrap-avokado'), 0)
            self.assertEqual((self.live / rel).read_text(), 'new')
            self.assertEqual(json.loads((self.tmp / 'st/state.json').read_text())['commit'], baseline)
            self.assertEqual(self.run_sync('--bootstrap-avokado'), 0)
            self.assertEqual(self.run_sync('--rollback'), 0)
            self.assertEqual((self.live / rel).read_text(), 'old')
            (self.live / rel).write_text('different')
            self.assertEqual(self.run_sync('--bootstrap-avokado'), 1)

    def test_site_http_origin_and_exact_bytes(self):
        import argparse
        ctx = autosync.Ctx(argparse.Namespace(live_root=str(self.live), state_dir=str(self.tmp/'st'), backups=str(self.tmp/'bk'), log=str(self.tmp/'log'), public=autosync.PUBLIC, repo_url=str(self.src), api=autosync.API, no_http=False, no_ci=True))
        from unittest.mock import MagicMock
        response = MagicMock()
        response.__enter__.return_value = response
        response.status, response.read.return_value = 200, b'body'
        with patch.object(autosync.urllib.request, 'urlopen', return_value=response) as request:
            self.assertTrue(autosync.http_ok(ctx, 'sites/alvi/index.html', b'body'))
            self.assertTrue(request.call_args.args[0].full_url.startswith('https://spaalvi-38.ru/index.html?'))
            self.assertFalse(autosync.http_ok(ctx, 'sites/alvi/index.html', b'other'))


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

    @unittest.skipIf(os.name == 'nt', 'real symlink fixture requires Linux CI')
    def test_symlink_on_live_path_error_logged_once(self):
        self.put('sites/synapse/cabinet/sub/x.css', 'x1')
        self.commit('sub')
        outside = self.tmp / 'outside'
        outside.mkdir()
        os.symlink(outside, self.live / 'sites/synapse/cabinet/sub')
        self.assertEqual(self.run_sync('--no-ci'), 1)
        self.assertEqual(self.run_sync('--no-ci'), 1)
        log = (self.tmp / 'log.txt').read_text()
        self.assertEqual(log.count('ERROR RuntimeError: symlink на пути'), 1)  # без повторов каждые 2 минуты
        self.assertFalse((outside / 'x.css').exists())
        os.unlink(self.live / 'sites/synapse/cabinet/sub')
        self.assertEqual(self.run_sync('--no-ci'), 0)
        log = (self.tmp / 'log.txt').read_text()
        self.assertIn('RECOVERED', log)
        self.assertEqual((self.live / 'sites/synapse/cabinet/sub/x.css').read_text(), 'x1')
        self.assertNotIn('error', json.loads((self.tmp / 'st' / 'state.json').read_text()))

    def test_unit_allows_pkey_for_node(self):
        unit = (HERE / 'synapse-autosync.service').read_text(encoding='utf-8')
        self.assertIn('SystemCallFilter=@system-service', unit)
        self.assertIn('SystemCallFilter=@pkey', unit)  # иначе V8 убивается SIGSYS на pkey_alloc
        self.assertNotIn('MemoryDenyWriteExecute=yes', unit)  # JIT V8 не работает с W^X

    def test_ci_gate_waits_and_fails_closed(self):
        self.put('sites/synapse/cabinet/a.js', 'a2')
        self.commit('next')
        calls = []
        original, original_fast = autosync.ci_status, autosync.fast_status
        autosync.fast_status = lambda ctx, sha: 'no:pr'
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
            autosync.ci_status, autosync.fast_status = original, original_fast

    # --- быстрый путь: дерево слияния равно проверенному head PR ---
    def git_out(self, *args):
        return subprocess.run(['git', *args], cwd=self.src, check=True, capture_output=True, text=True).stdout.strip()

    def merge_pr(self, number=7, behind=False):
        """PR-ветка от main → merge --no-ff; refs/pull/N/head как на GitHub."""
        sh('git', 'checkout', '-q', '-b', f'pr{number}', cwd=self.src)
        self.put('sites/synapse/cabinet/a.js', 'a2')
        self.commit('pr')
        pr_head = self.git_out('rev-parse', 'HEAD')
        sh('git', 'checkout', '-q', 'main', cwd=self.src)
        if behind:  # main ушёл вперёд, PR не обновлён
            self.put('sites/synapse/cabinet/other.css', 'o1')
            self.commit('main moved')
        sh('git', 'merge', '-q', '--no-ff', '-m', f'Merge pull request #{number}', f'pr{number}', cwd=self.src)
        sh('git', 'update-ref', f'refs/pull/{number}/head', pr_head, cwd=self.src)
        return self.git_out('rev-parse', 'HEAD'), pr_head

    def fake_api(self, merge, pr_head, runs, number=7, merged='2026-11-05T08:00:00Z'):
        calls = []

        def api(ctx, path):
            calls.append(path)
            if path == f'/commits/{merge}/pulls':
                return [{'number': number, 'merge_commit_sha': merge, 'merged_at': merged,
                         'base': {'ref': 'main'}, 'head': {'sha': pr_head}}]
            if path.startswith(f'/commits/{pr_head}/check-runs'):
                return {'total_count': len(runs), 'check_runs': runs}
            raise AssertionError(f'неожиданный запрос {path}')
        return api, calls

    def cr(self, name, conclusion, started, status='completed', id=1):
        return {'id': id, 'name': name, 'status': status, 'conclusion': conclusion, 'started_at': started}

    def test_fast_path_deploys_without_waiting_main_ci(self):
        merge, pr_head = self.merge_pr()
        runs = [self.cr('checks', 'success', '2026-11-05T07:50:00Z', id=1),
                self.cr('site-path-approval', 'success', '2026-11-05T07:51:00Z', id=2),
                # после слияния охрана закрытого PR падает — не учитывается
                self.cr('site-path-approval', 'failure', '2026-11-05T08:00:01Z', id=3)]
        api, calls = self.fake_api(merge, pr_head, runs)
        with patch.object(autosync, 'api_json', api), \
                patch.object(autosync, 'ci_status', lambda ctx, sha: 'pending'):
            self.assertEqual(self.run_sync(), 0)
            self.assertEqual((self.live / 'sites/synapse/cabinet/a.js').read_text(), 'a2')
            self.assertIn('CI fast-path', (self.tmp / 'log.txt').read_text())
            self.assertEqual(self.run_sync(), 0)  # тот же HEAD — без новых запросов
        self.assertEqual(len(calls), 2)

    def test_fast_path_refuses_tree_not_tested_on_pr(self):
        merge, pr_head = self.merge_pr(behind=True)
        api, _ = self.fake_api(merge, pr_head, [self.cr('checks', 'success', '2026-11-05T07:50:00Z')])
        with patch.object(autosync, 'api_json', api), \
                patch.object(autosync, 'ci_status', lambda ctx, sha: 'pending'):
            self.assertEqual(self.run_sync(), 0)
        self.assertEqual((self.live / 'sites/synapse/cabinet/a.js').read_text(), 'a1')
        state = json.loads((self.tmp / 'st' / 'state.json').read_text())
        self.assertEqual(state['fast']['result'], 'no:tree')

    def test_fast_path_refuses_red_or_running_pr_checks(self):
        merge, pr_head = self.merge_pr()
        for runs, expected in (
                ([self.cr('checks', 'failure', '2026-11-05T07:50:00Z')], 'no:fail:checks:failure'),
                ([self.cr('checks', None, '2026-11-05T07:50:00Z', status='in_progress')], 'pending'),
                ([self.cr('checks', 'success', '2026-11-05T08:00:05Z')], 'no:no-runs'),
                # последний до слияния прогон красный, хотя ранний был зелёным
                ([self.cr('checks', 'success', '2026-11-05T07:40:00Z', id=1),
                  self.cr('checks', 'failure', '2026-11-05T07:50:00Z', id=2)], 'no:fail:checks:failure')):
            state_path = self.tmp / 'st' / 'state.json'
            state = json.loads(state_path.read_text()); state.pop('fast', None); state.pop('ci', None)
            state_path.write_text(json.dumps(state))
            api, _ = self.fake_api(merge, pr_head, runs)
            with patch.object(autosync, 'api_json', api), \
                    patch.object(autosync, 'ci_status', lambda ctx, sha: 'pending'):
                self.assertEqual(self.run_sync(), 0)
            self.assertEqual((self.live / 'sites/synapse/cabinet/a.js').read_text(), 'a1')
            self.assertEqual(json.loads(state_path.read_text())['fast']['result'], expected)

    def test_fast_path_refuses_moved_pr_ref_and_foreign_merge(self):
        merge, pr_head = self.merge_pr()
        runs = [self.cr('checks', 'success', '2026-11-05T07:50:00Z')]
        other = self.git_out('rev-parse', 'HEAD~1')
        api, _ = self.fake_api(merge, other, runs)  # API называет другой head, чем refs/pull/7/head
        with patch.object(autosync, 'api_json', api), \
                patch.object(autosync, 'ci_status', lambda ctx, sha: 'pending'):
            self.assertEqual(self.run_sync(), 0)
        state = json.loads((self.tmp / 'st' / 'state.json').read_text())
        self.assertEqual(state['fast']['result'], 'no:pr-head-moved')
        state.pop('fast'); state.pop('ci', None)
        (self.tmp / 'st' / 'state.json').write_text(json.dumps(state))
        with patch.object(autosync, 'api_json', lambda ctx, path: []), \
                patch.object(autosync, 'ci_status', lambda ctx, sha: 'pending'):
            self.assertEqual(self.run_sync(), 0)
        self.assertEqual(json.loads((self.tmp / 'st' / 'state.json').read_text())['fast']['result'], 'no:pr')
        self.assertEqual((self.live / 'sites/synapse/cabinet/a.js').read_text(), 'a1')


if __name__ == '__main__':
    unittest.main()
