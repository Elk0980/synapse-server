"""Real disposable Compose integration, opt-in Linux CI only. No production config."""
import contextlib
import os
from pathlib import Path
import socket
import sqlite3
import tempfile
import time
import unittest
from agent import Engine, ComposeBackend, Blocked, atomic, command


@unittest.skipUnless(os.environ.get('RELEASE_DOCKER_TEST') == '1', 'disposable Linux Docker CI only')
class DockerRollback(unittest.TestCase):
    def test_real_image_switch_and_rollback_preserve_forward_sqlite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'repo'
            app = source / 'ops/fixture'
            app.mkdir(parents=True)
            data = root / 'data'
            data.mkdir()
            with contextlib.closing(sqlite3.connect(data / 'live.sqlite')) as db, db:
                db.execute('CREATE TABLE messages(text TEXT)')
                db.execute("INSERT INTO messages VALUES ('old draft')")
            (app / 'Dockerfile').write_text('FROM python:3.12-alpine\nWORKDIR /app\nCOPY . .\nCMD ["python","app.py"]\n')
            (app / 'version').write_text('good')
            (app / 'app.py').write_text('''from http.server import BaseHTTPRequestHandler, HTTPServer
import sqlite3
db=sqlite3.connect('/data/live.sqlite'); db.execute("INSERT INTO messages VALUES ('startup request')"); db.commit(); db.close()
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200 if open('/app/version').read()=='good' else 500); self.end_headers(); self.wfile.write(b'ok')
HTTPServer(('0.0.0.0',8080),Handler).serve_forever()
''')
            def git(*args): return command(['git', '-C', str(source), *args]).decode().strip()
            git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture')
            git('add', '.'); git('commit', '-qm', 'good')
            old = git('rev-parse', 'HEAD')
            tag = 'synapse-release-test:' + old
            command(['docker', 'build', '-t', tag, str(app)], timeout=240)
            project = 'release-test-' + old[:8]
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
            recipe = root / 'recipe.json'
            atomic(recipe, {'services': {'fixture': {'image': tag,
                'ports': [f'127.0.0.1:{port}:8080'], 'volumes': [str(data) + ':/data']}}})
            config = {'project': project, 'checkout': str(source), 'recipe': str(recipe),
                'stateDir': str(root / 'state'), 'mirror': str(source),
                'services': {'fixture': {'context': 'ops/fixture', 'databases': [str(data / 'live.sqlite')]}},
                'health': [{'url': f'http://127.0.0.1:{port}/health'}]}
            backend = ComposeBackend(config)
            try:
                backend.compose(recipe, 'up', '-d')
                for attempt in range(50):
                    try: backend.health(); break
                    except Blocked: time.sleep(0.1)
                else: self.fail('fixture startup')
                engine = Engine(config['stateDir'], backend)
                engine.save({'phase': 'idle', 'current': old})
                (app / 'version').write_text('broken')
                git('add', '.'); git('commit', '-qm', 'broken health')
                bad = git('rev-parse', 'HEAD')
                import hashlib
                plan = {'sha': bad, 'parent': old, 'services': ['fixture'], 'writers': ['fixture'],
                        'recipeSha256': hashlib.sha256(recipe.read_bytes()).hexdigest()}
                with self.assertRaisesRegex(Blocked, 'RELEASE_ROLLED_BACK'): engine.deploy(plan)
                self.assertEqual(engine.state()['phase'], 'rolled_back')
                backend.health()
                with contextlib.closing(sqlite3.connect(data / 'live.sqlite')) as db:
                    rows = db.execute('SELECT text FROM messages').fetchall()
                self.assertIn(('old draft',), rows)
                self.assertGreaterEqual(rows.count(('startup request',)), 3)
                self.assertTrue((root / 'state' / bad / 'fixture-0.sqlite').exists())
            finally:
                backend.compose(recipe, 'down', '--remove-orphans')


if __name__ == '__main__': unittest.main()
