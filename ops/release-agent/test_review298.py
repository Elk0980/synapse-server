import contextlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import agent
import issuer
from board import Outbox
from test_board import Fixture
from test_agent import Backend


class Review298(unittest.TestCase):
    def test_service_markdown_skills_prompts_and_docs_are_runtime(self):
        config = {'services': {'content': {'context': 'ops/content'}, 'crm': {'context': 'ops/crm'}}}
        for path, service in [('ops/content/skills/x/SKILL.md', 'content'),
                              ('ops/content/docs/prompt.md', 'content'),
                              ('ops/crm/instructions.md', 'crm')]:
            with self.subTest(path=path):
                plan = agent.make_plan(config, {}, [path])
                self.assertEqual(plan['outcome'], 'runtime')
                self.assertEqual(plan['services'], [service])
        for path in ('ops/content/README.md', 'ops/content/CHANGELOG.old.md',
                     'ops/content/tests/prompt.md', 'docs/architecture.md', 'specs/x/spec.md', 'README.md'):
            self.assertEqual(agent.make_plan(config, {}, [path])['outcome'], 'no_release')

    def manual_fixture(self, root):
        key = root / 'key'
        key.write_bytes(b'fixture-only')
        key.chmod(0o600)
        config = {'stateDir': str(root / 'native'), 'mirror': 'fixture', 'taskId': 55,
                  'services': {'crm': {'context': 'ops/crm'}}, 'admissionKey': str(key),
                  'boardUrlFile': 'unused', 'reviewerCredentials': {'28': 'claude-credential', '1': 'owner-credential'}}
        plan = {'sha': 'b' * 40, 'parent': 'a' * 40, 'taskId': 55, 'outcome': 'manual',
                'manualPaths': ['docker-compose.yml']}
        registry = [{'id': 28, 'kind': 'claude'}, {'id': 1, 'kind': 'owner'}]
        return config, plan, registry

    def test_manual_ack_requires_exact_sha_and_same_trusted_identity_path(self):
        for kind, agent_id, credential in [('claude', 28, 'claude-credential'), ('owner', 1, 'owner-credential')]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                config, plan, registry = self.manual_fixture(root)
                identity = {'verified': True, 'agentId': agent_id, 'credentialId': credential}
                exact = 'ПРИМЕНЕНО ВРУЧНУЮ ' + plan['sha']
                board = Fixture()
                board.call = lambda *args: {'agents': registry}
                def command(args):
                    if 'rev-parse' in args: return (plan['parent'] + '\n').encode()
                    if 'diff' in args: return b'docker-compose.yml\0'
                    return b''
                with patch.object(issuer, 'Board', return_value=board), patch.object(issuer, 'command', side_effect=command):
                    for text, stamp in [(exact, None), (exact, dict(identity, verified=False)),
                                        (exact, dict(identity, credentialId='forged')),
                                        ('ПРИМЕНЕНО ВРУЧНУЮ ' + 'c' * 40, identity),
                                        ('НЕ ' + exact, identity)]:
                        board.task_data['comments'] = [{'id': 9, 'author': 'Claude', 'text': text, 'identity': stamp or {}}]
                        with self.assertRaisesRegex(agent.Blocked, 'WAITS_TRUSTED_MANUAL_CONFIRMATION'):
                            issuer.confirm_manual(config, plan)
                    board.task_data['comments'] = [{'id': 10, 'text': exact, 'identity': identity}]
                    receipt = issuer.confirm_manual(config, plan)
                    self.assertEqual(receipt['sha'], plan['sha'])
                    self.assertEqual(receipt['commentId'], 10)
                    # Once recorded, an offline board cannot make an applied fact disappear.
                    with patch.object(issuer, 'Board', side_effect=AssertionError('cached proof expected')):
                        self.assertEqual(issuer.confirm_manual(config, plan), receipt)

    def test_tick_manual_confirmation_advances_only_cursor_and_reports(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config, plan, _ = self.manual_fixture(root)
            config.update(stateDir=str(root / 'state'), lock='fixture')
            backend, board = Backend(root / 'unused.sqlite'), Fixture()
            engine = agent.Engine(config['stateDir'], backend)
            engine.save({'phase': 'idle', 'current': plan['parent'], 'cursor': plan['parent']})
            board.task_data['coordination'].update(nextAction='release:' + plan['sha'] + ':manual', blocker='ручное применение: docker-compose.yml')
            def command(args):
                if 'rev-list' in args: return plan['sha'].encode()
                if 'diff' in args: return b'docker-compose.yml\0'
                return b''
            receipt = dict(plan, commentId=10)
            with patch.object(agent, 'ComposeBackend', return_value=backend), \
                 patch.object(agent, 'release_lock', return_value=contextlib.nullcontext()), \
                 patch.object(agent, 'command', side_effect=command), patch('board.Board', return_value=board), \
                 patch.object(issuer, 'confirm_manual', return_value=receipt):
                agent.tick(config)
            state = engine.state()
            self.assertEqual(state['cursor'], plan['sha'])
            self.assertEqual(state['current'], plan['parent'])
            self.assertEqual(state['phase'], 'manual_applied')
            self.assertEqual(backend.events, [])
            self.assertIn('Принято вручную', board.task_data['coordination']['nextAction'])
            self.assertEqual(board.task_data['coordination']['blocker'], '')
            with self.assertRaisesRegex(agent.Blocked, 'MANUAL_CONFIRMATION_MISMATCH'):
                engine.advance(dict(plan, parent=plan['sha'], sha='c' * 40), 'manual_applied', receipt=receipt)

    def test_manually_applied_paths_do_not_block_again_unless_changed_again(self):
        receipt = {'sha': 'b' * 40, 'manualPaths': ['docker-compose.yml']}
        changed = ['docker-compose.yml', 'ops/crm/server.js']
        config = {'mirror': 'fixture'}
        with patch.object(agent, 'command', return_value=b''):
            self.assertEqual(agent.exclude_applied_manual(config, changed, 'c' * 40, [receipt]), ['ops/crm/server.js'])
        with patch.object(agent, 'command', return_value=b'docker-compose.yml\0'):
            self.assertEqual(agent.exclude_applied_manual(config, changed, 'c' * 40, [receipt]), changed)


if __name__ == '__main__': unittest.main()
