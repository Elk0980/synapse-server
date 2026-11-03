import contextlib
import hashlib
import hmac
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import agent
from broker import validate_plan, dispatch
from issuer import trusted
from install import activate, install
from test_agent import Backend


class MigrationBackend(Backend):
    def __init__(self, db, closed):
        super().__init__(db)
        self.closed = closed

    def traffic_is_closed(self, plan): return self.closed
    def return_traffic(self, plan): self.events.append('open_traffic')

    def switch(self, plan):
        super().switch(plan)
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.execute('CREATE TABLE migration_table(value TEXT)')
            db.execute("INSERT INTO migration_table VALUES ('migration data')")

    def restore_databases(self, plan):
        self.events.append('restore_database')
        shutil.copyfile(self.db.parent / (plan['sha'] + '.sqlite'), self.db)


class ReviewFixes(unittest.TestCase):
    def test_rollback_cli_is_cas_and_request_id_idempotent(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / 'db.sqlite'
            with contextlib.closing(sqlite3.connect(database)) as db, db:
                db.execute('CREATE TABLE messages(text TEXT)')
            backend = Backend(database)
            engine = agent.Engine(root / 'state', backend)
            old, new = 'a' * 40, 'b' * 40
            engine.save({'phase': 'idle', 'current': old})
            engine.deploy({'sha': new, 'parent': old})
            config = {'stateDir': str(engine.directory), 'lock': str(root / 'lock')}
            with patch.object(agent, 'ComposeBackend', return_value=backend), \
                 patch.object(agent, 'release_lock', return_value=contextlib.nullcontext()):
                with self.assertRaisesRegex(agent.Blocked, 'ROLLBACK_STALE_SHA'):
                    agent.rollback_command(config, 'c' * 40, 'wrong')
                agent.rollback_command(config, new, 'request-1')
                restores = backend.events.count('restore')
                agent.rollback_command(config, new, 'request-1')
                self.assertEqual(backend.events.count('restore'), restores)
                with self.assertRaisesRegex(agent.Blocked, 'ROLLBACK_REQUEST_REUSED'):
                    agent.rollback_command(config, old, 'request-1')

    def test_pinned_bootstrap_downloads_complete_package_then_enables_once(self):
        import bootstrap
        import install as installer
        import io
        urls, calls = [], []
        source = Path(__file__).parent
        def download(url, timeout):
            urls.append(url)
            return io.BytesIO((source / url.rsplit('/', 1)[1]).read_bytes())
        def stage(directory, root):
            self.assertTrue(all((Path(directory) / name).exists() for name in installer.FILES))
            calls.append(('install', root))
        with patch('sys.argv', ['bootstrap', '--commit', 'a' * 40, '--bundle', '/private/accepted.json']), \
             patch('urllib.request.urlopen', side_effect=download), \
             patch.object(installer, 'install', side_effect=stage), \
             patch.object(installer, 'activate', side_effect=lambda root, bundle, run: calls.append(('enable', bundle))):
            bootstrap.main()
        self.assertTrue(all('/' + 'a' * 40 + '/' in url for url in urls))
        self.assertEqual(calls, [('install', '/'), ('enable', '/private/accepted.json')])

    def test_migration_pretraffic_restores_snapshot_posttraffic_preserves_new_rows(self):
        for closed in (True, False):
            with self.subTest(closed=closed), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                database = root / 'live.sqlite'
                with contextlib.closing(sqlite3.connect(database)) as db, db:
                    db.execute('CREATE TABLE messages(text TEXT)')
                    db.execute("INSERT INTO messages VALUES ('old draft')")
                backend = MigrationBackend(database, closed)
                backend.fail = 'health'
                engine = agent.Engine(root / 'state', backend)
                engine.save({'phase': 'idle', 'current': 'a'})
                with self.assertRaisesRegex(agent.Blocked, 'RELEASE_ROLLED_BACK'):
                    engine.deploy({'sha': 'b', 'parent': 'a', 'hasMigration': True})
                state = engine.state()
                self.assertEqual(state['needsDatabaseDecision'], not closed)
                with contextlib.closing(sqlite3.connect(database)) as db:
                    rows = db.execute('SELECT text FROM messages').fetchall()
                    migrated = bool(db.execute("SELECT 1 FROM sqlite_master WHERE name='migration_table'").fetchall())
                self.assertEqual(rows, [('old draft',)] if closed else [('old draft',), ('new request',)])
                self.assertEqual(migrated, not closed)
                self.assertEqual('restore_database' in backend.events, closed)
                self.assertTrue((root / 'b.sqlite').exists())

    def test_legacy_author_string_cannot_become_claude_credential(self):
        registry = [{'id': 28, 'name': 'Claude', 'kind': 'claude'}]
        config = {'reviewerCredentials': {'28': 'credential-claude'}}
        self.assertFalse(trusted({'author': 'Claude'}, registry, config, 'claude'))
        comment = {'identity': {'verified': True, 'agentId': 28, 'credentialId': 'credential-claude'}}
        self.assertTrue(trusted(comment, registry, config, 'claude'))
        comment['identity']['credentialId'] = 'credential-codex'
        self.assertFalse(trusted(comment, registry, config, 'claude'))

    def test_broker_denies_arbitrary_commands_services_and_modified_plan(self):
        with self.assertRaisesRegex(agent.Blocked, 'BROKER_OPERATION_DENIED'):
            dispatch({}, {'operation': 'shell', 'command': 'anything'})
        with self.assertRaisesRegex(agent.Blocked, 'BROKER_SERVICE_DENIED'):
            validate_plan({'services': {'crm': {}}}, {'sha': 'a' * 40, 'services': ['caddy']})
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            agent.atomic(root / 'key.json', 'fixture')
            key = (root / 'key.json').read_bytes()
            body = {'sha': 'a' * 40, 'parent': 'b' * 40, 'reviewerRole': 'claude', 'codeAccepted': True,
                    'taskId': 55, 'expires': 9999999999, 'migration': 'forward-compatible', 'reconciled': True,
                    'services': ['crm'], 'writers': ['crm']}
            agent.atomic(root / (body['sha'] + '.json'), {'body': body,
                'signature': hmac.new(key, agent.canonical(body), hashlib.sha256).hexdigest()})
            config = {'services': {'crm': {}, 'content': {}}, 'admissions': str(root), 'admissionKey': str(root / 'key.json')}
            self.assertEqual(validate_plan(config, body), body)
            with self.assertRaisesRegex(agent.Blocked, 'BROKER_SERVICE_BINDING'):
                validate_plan(config, dict(body, services=['content']))

    def test_enabled_install_on_copy_uses_nonroot_worker_without_docker_group(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            install(Path(__file__).parent, root)
            lock = root / 'opt/synapse/.palitra-app-release.lock'
            lock.parent.mkdir(parents=True)
            lock.touch()
            bundle = root / 'accepted.json'
            worker = {'stateDir': '/var/lib/synapse-release-agent', 'brokerSocket': '/run/synapse-release/broker.sock',
                      'mirror': '/var/lib/synapse-release-agent/mirror', 'repository': 'fixture/repo'}
            broker = {'stateDir': '/var/lib/synapse-release-broker', 'mirror': worker['mirror'],
                      'runtimeShaFile': '/var/lib/synapse-release-broker/runtime.json',
                      'admissions': '/var/lib/synapse-release-broker/admissions',
                      'admissionKey': '/etc/synapse/release-agent/admission.key'}
            url = root / 'existing-board-url'
            url.write_text('https://fixture.invalid/synthetic')
            url.chmod(0o600)
            broker['boardUrlFile'] = str(url)
            agent.atomic(bundle, {'acceptedByClaude': True, 'reconciled': True, 'initialSha': 'a' * 40,
                                  'worker': worker, 'broker': broker})
            calls = []
            activate(root, bundle, calls.append)
            self.assertIn(['systemctl', 'enable', '--now', 'synapse-release-broker.socket', 'synapse-release-agent.timer'], calls)
            self.assertTrue(agent.load(root / 'var/lib/synapse-release-agent/installation.json')['enabled'])
            unit = (root / 'etc/systemd/system/synapse-release-agent.service').read_text()
            self.assertIn('User=synapse-release', unit)
            self.assertNotIn('User=root', unit)
            self.assertIn('ReadOnlyPaths=/opt/synapse /opt/synapse-release-agent', unit)
            self.assertFalse(any('docker' in item for command in calls for item in command))


if __name__ == '__main__': unittest.main()
