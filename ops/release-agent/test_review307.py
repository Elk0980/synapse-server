import contextlib
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import agent
import issuer
from test_agent import Backend
from test_board import Fixture


class Review307(unittest.TestCase):
    def test_readme_changelog_runtime_extensions_are_not_documentation(self):
        config = {'services': {'crm': {'context': 'ops/crm'}}}
        for path in ('ops/crm/readme-config.json', 'ops/crm/changelog.js'):
            self.assertEqual(agent.make_plan(config, {}, [path])['outcome'], 'runtime')
        for path in ('ops/crm/README', 'ops/crm/README.md', 'ops/crm/README-setup.txt',
                     'ops/crm/CHANGELOG.md', 'ops/crm/CHANGELOG.txt'):
            self.assertEqual(agent.make_plan(config, {}, [path])['outcome'], 'no_release')

    def test_mixed_commit_requires_admission_and_deploy_after_manual_ack(self):
        for approved, health_ok in ((False, True), (True, True), (True, False)):
            with self.subTest(approved=approved, health_ok=health_ok), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                repo = root / 'repo'
                (repo / 'ops/crm').mkdir(parents=True)
                def git(*args):
                    return agent.command(['git', '-C', str(repo), *args]).decode().strip()
                git('init', '-q', '-b', 'main')
                git('config', 'user.email', 'fixture@example.invalid')
                git('config', 'user.name', 'Fixture')
                (repo / 'docker-compose.yml').write_text('old infrastructure')
                (repo / 'ops/crm/server.js').write_text('old service')
                git('add', '.'); git('commit', '-qm', 'baseline')
                old = git('rev-parse', 'HEAD')
                (repo / 'docker-compose.yml').write_text('manually applied infrastructure')
                (repo / 'ops/crm/server.js').write_text('new service requires deployment')
                git('add', '.'); git('commit', '-qm', 'mixed change')
                new = git('rev-parse', 'HEAD')
                git('remote', 'add', 'origin', str(repo))
                database = root / 'live.sqlite'
                with contextlib.closing(sqlite3.connect(database)) as db, db:
                    db.execute('CREATE TABLE messages(text TEXT)')
                key = root / 'key'
                key.write_bytes(b'fixture-key'); key.chmod(0o600)
                agent.atomic(root / 'baseline.json', {'reconciled': True})
                agent.atomic(root / 'runtime.json', {'sha': old})
                agent.atomic(root / 'recipe.json', {'services': {'crm': {'image': 'fixture'}}})
                config = {'stateDir': str(root / 'state'), 'mirror': str(repo), 'taskId': 55,
                          'services': {'crm': {'context': 'ops/crm'}}, 'admissionKey': str(key),
                          'admissions': str(root / 'admissions'), 'boardUrlFile': 'fixture',
                          'reviewerCredentials': {'28': 'credential-claude'}, 'lock': 'fixture',
                          'baseline': str(root / 'baseline.json'), 'runtimeShaFile': str(root / 'runtime.json'),
                          'recipe': str(root / 'recipe.json'), 'requiredChecks': ['fixture'], 'repository': 'fixture/repo'}
                board = Fixture()
                identity = {'verified': True, 'agentId': 28, 'credentialId': 'credential-claude'}
                board.task_data.update(id=55, comments=[{'id': 1, 'text': 'ПРИМЕНЕНО ВРУЧНУЮ ' + new, 'identity': identity}])
                if approved:
                    board.task_data['comments'].append({'id': 2, 'text': 'КОД ПРИНЯТ ' + new, 'identity': identity})
                board.task_data['coordination'].update(
                    links=[{'url': 'https://github.com/fixture/repo/pull/1'}],
                    nextAction='release:' + new + ':manual', blocker='ручное применение: docker-compose.yml')
                original_call = board.call
                def call(method, args):
                    if method == 'agents_list': return {'agents': [{'id': 28, 'kind': 'claude'}]}
                    if method == 'tasks_list': return {'tasks': [{'id': 55}]}
                    return original_call(method, args)
                board.call = call
                engine = agent.Engine(config['stateDir'], None)
                engine.save({'phase': 'idle', 'current': old, 'cursor': old})
                observed = []
                class ObservedBackend(Backend):
                    def event(self, name):
                        # Manual acknowledgement must not consume runtime before health.
                        observed.append((name, engine.state()['cursor']))
                        return super().event(name)
                backend = ObservedBackend(database)
                if not health_ok: backend.fail = 'health'
                def gate(api, sha, admission):
                    observed.append(('admission', engine.state()['cursor']))
                    self.assertEqual(sha, new)
                pr = {'number': 1, 'merged_at': 'fixture', 'merge_commit_sha': new,
                      'base': {'ref': 'main'}, 'head': {'sha': new}}
                with patch.object(agent, 'ComposeBackend', return_value=backend), \
                     patch.object(agent, 'release_lock', return_value=contextlib.nullcontext()), \
                     patch('board.Board', return_value=board), patch.object(issuer, 'Board', return_value=board), \
                     patch.object(agent.GitHub, 'get', return_value=[pr]), patch.object(agent.GitHub, 'gate', new=gate):
                    if health_ok or not approved:
                        agent.tick(config)
                    else:
                        with self.assertRaisesRegex(agent.Blocked, 'RELEASE_ROLLED_BACK'): agent.tick(config)
                state = engine.state()
                self.assertTrue(all(cursor == old for _, cursor in observed))
                self.assertEqual(len(state['manualApplied']), 1)
                if not approved:
                    self.assertEqual(state['cursor'], old)
                    self.assertEqual(state['current'], old)
                    self.assertEqual(backend.events, [])
                    self.assertEqual(state['waiting']['kind'], 'waiting')
                else:
                    self.assertIn('admission', [name for name, _ in observed])
                    self.assertIn('build', backend.events)
                    self.assertIn('switch', backend.events)
                    self.assertIn('health', backend.events)
                    self.assertEqual(state['cursor'], new)
                    self.assertEqual(state['current'], new if health_ok else old)
                    self.assertEqual(state['phase'], 'verified' if health_ok else 'rolled_back')
                    if health_ok:
                        self.assertEqual(board.task_data['coordination']['blocker'], '')


if __name__ == '__main__': unittest.main()
