import contextlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import agent
from board import Outbox
from test_board import Fixture
from test_agent import Backend


class Review260(unittest.TestCase):
    def run_tick(self, paths, expect):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old, new = 'a' * 40, 'b' * 40
            config = {'stateDir': str(root / 'state'), 'boardUrlFile': 'unused-fixture',
                      'lock': 'fixture', 'mirror': 'fixture', 'repository': 'fixture/repo',
                      'admissions': str(root / 'admissions'),
                      'services': {'crm': {'context': 'ops/crm'}}}
            backend = Backend(root / 'unused.sqlite')
            engine = agent.Engine(config['stateDir'], backend)
            engine.save({'phase': 'idle', 'current': old, 'cursor': old})
            board = Fixture()
            def command(args):
                if 'rev-list' in args: return (new + '\n').encode()
                if 'diff' in args: return ('\0'.join(paths) + '\0').encode()
                return b''
            with patch.object(agent, 'ComposeBackend', return_value=backend), \
                 patch.object(agent, 'release_lock', return_value=contextlib.nullcontext()), \
                 patch.object(agent, 'command', side_effect=command), \
                 patch('board.Board', return_value=board), \
                 patch('issuer.issue', side_effect=agent.Blocked('WAITS_AUTHENTICATED_CLAUDE_COMMENT')):
                agent.tick(config)
            state = engine.state()
            if expect == 'no_release':
                self.assertEqual(state['cursor'], new)
            else:
                self.assertEqual(state['cursor'], old)
                self.assertEqual(state['current'], old)
                self.assertEqual(backend.events, [])
                self.assertEqual(state['waiting']['kind'], expect)
            events = agent.load(root / 'state/outbox.json')
            self.assertEqual(events[-1]['kind'], expect)
            self.assertEqual(events[-1]['phase'], 'done')
            if expect == 'manual':
                self.assertIn('ручное применение: docker-compose.yml', events[-1]['detail'])
            if expect == 'waiting':
                self.assertIn('Ожидается приёмка', board.task_data['coordination']['nextAction'])

    def test_unknown_infrastructure_does_not_advance_cursor_or_build_mixed_pr(self):
        self.run_tick(['docker-compose.yml', 'ops/crm/server.js'], 'manual')

    def test_unapproved_runtime_enqueues_waiting_without_advancing_cursor(self):
        self.run_tick(['ops/crm/server.js'], 'waiting')

    def test_allowlisted_docs_still_advance_and_report_no_release(self):
        self.run_tick(['docs/design.md', 'specs/098/spec.md'], 'no_release')

    def test_snapshot_and_preserved_data_have_different_rollback_reports(self):
        for restored in (True, False):
            with self.subTest(restored=restored), tempfile.TemporaryDirectory() as temporary:
                board = Fixture()
                outbox = Outbox(Path(temporary) / 'events.json', board)
                state = {'phase': 'rolled_back', 'restoreDatabase': restored,
                         'plan': {'sha': 'b', 'taskId': 55}}
                agent.report_terminal(state, outbox)
                message = board.task_data['coordination']['nextAction']
                self.assertNotIn('данные сохранены', message)
                self.assertIn('БД восстановлена из снимка' if restored else 'без восстановления снимка', message)

    def test_terminal_receipt_supersedes_stale_pending_waiting_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            board = Fixture()
            outbox = Outbox(Path(temporary) / 'events.json', board)
            outbox.enqueue(55, 'b', 'waiting')
            outbox.enqueue(55, 'b', 'connected')
            outbox.flush()
            self.assertEqual(agent.load(outbox.path)[0]['phase'], 'superseded')
            self.assertEqual(board.calls, 1)


if __name__ == '__main__': unittest.main()
