"""Локальная проверка автовыпуска: python3 -m unittest ops/autosync/test_autosync.py"""
import importlib.util, json, os, pathlib, subprocess, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('autosync', HERE / 'synapse-autosync.py')
autosync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(autosync)


def sh(*args, cwd):
    subprocess.run(args, cwd=cwd, check=True, capture_output=True)


class AutosyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
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
        self.run_sync('--init')

    def put(self, rel, text):
        p = self.src / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def commit(self, msg):
        sh('git', 'add', '-A', cwd=self.src)
        sh('git', 'commit', '-q', '-m', msg, cwd=self.src)

    def run_sync(self, *extra):
        t = self.tmp
        return autosync.main(['--live-root', str(self.live), '--work', str(t / 'work'), '--state', str(t / 'state.json'),
                              '--backups', str(t / 'bk'), '--log', str(t / 'log.txt'), '--lock', str(t / 'lock'),
                              '--repo-url', str(self.src), '--no-http', *extra])

    def test_three_way_rules(self):
        self.put('sites/synapse/cabinet/a.js', 'a2')            # не изменён на боевом → заменить
        self.put('sites/synapse/cabinet/local.js', 'l2')        # локальная правка → пропустить
        self.put('sites/synapse/cabinet/new.css', 'n1')         # новый → добавить
        self.put('sites/synapse/cabinet/x.test.cjs', 't')       # тест → не выкладывать
        self.put('sites/synapse/cabinet.html', 'h2')            # вне белого списка
        self.put('ops/crm/server.js', 's2')                     # вне белого списка
        self.commit('next')
        self.assertEqual(self.run_sync(), 0)
        live = lambda rel: (self.live / rel).read_text()
        self.assertEqual(live('sites/synapse/cabinet/a.js'), 'a2')
        self.assertEqual(live('sites/synapse/cabinet/local.js'), 'live-edit')
        self.assertEqual(live('sites/synapse/cabinet/new.css'), 'n1')
        self.assertFalse((self.live / 'sites/synapse/cabinet/x.test.cjs').exists())
        self.assertEqual(live('sites/synapse/cabinet.html'), 'h1')
        self.assertEqual(live('ops/crm/server.js'), 's1')
        state = json.loads((self.tmp / 'state.json').read_text())
        self.assertEqual(sorted(state['deployed']), ['sites/synapse/cabinet/a.js', 'sites/synapse/cabinet/new.css'])
        reasons = {s['path']: s['reason'] for s in state['skipped']}
        self.assertEqual(reasons['sites/synapse/cabinet/local.js'], 'локальная правка, не трогаю')
        manifest = json.loads(next((self.tmp / 'bk').glob('*/manifest.json')).read_text())
        self.assertEqual({f['path']: f['existed'] for f in manifest['files']},
                         {'sites/synapse/cabinet/a.js': True, 'sites/synapse/cabinet/new.css': False})

    def test_rollback_on_failed_health(self):
        self.put('sites/synapse/cabinet/a.js', 'a2')
        self.put('sites/synapse/cabinet/new.css', 'n1')
        self.commit('next')
        original = autosync.http_ok
        autosync.http_ok = lambda ctx, path, data: False
        try:
            ctx_args = []
            self.assertEqual(self.run_sync(*ctx_args), 1)
        finally:
            autosync.http_ok = original
        self.assertEqual((self.live / 'sites/synapse/cabinet/a.js').read_text(), 'a1')
        self.assertFalse((self.live / 'sites/synapse/cabinet/new.css').exists())
        state = json.loads((self.tmp / 'state.json').read_text())
        self.assertIn('lastError', state)
        self.assertEqual(self.run_sync(), 1)  # тот же коммит повторно не выкладывается

    def test_no_change_is_noop(self):
        self.assertEqual(self.run_sync(), 0)
        self.assertFalse((self.tmp / 'bk').exists())


if __name__ == '__main__':
    unittest.main()
