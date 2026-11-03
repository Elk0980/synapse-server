from pathlib import Path
import tempfile
import unittest
from board import Outbox
from agent import Blocked, load, report_terminal
from unittest.mock import patch


class Fixture:
    def __init__(self):
        self.calls = 0
        self.fail = False
        self.task_data = {'coordination': {'revision': 3, 'milestones': {'connected': {'evidence': ''}}}, 'comments': []}

    def task(self, task_id): return self.task_data

    def call(self, method, args):
        if 'checked_at' in args:
            assert args['checked_at'].endswith('Z'), 'MCP z.iso.datetime requires UTC Z'
        self.calls += 1
        if method == 'task_update':
            if 'evidence' in args:
                self.task_data['coordination']['milestones']['connected']['evidence'] = args['evidence']
            if 'next_step' in args:
                self.task_data['coordination']['nextAction'] = args['next_step']
        else:
            self.task_data['comments'].append({'text': args['text']})
        if self.fail: raise Blocked('BOARD_RESULT_UNCONFIRMED')


class Reporting(unittest.TestCase):
    def test_failed_preflight_never_reports_new_sha_as_connected(self):
        with tempfile.TemporaryDirectory() as directory:
            board = Fixture()
            out = Outbox(Path(directory) / 'out.json', board)
            # Previous successful state remains if next capture or preflight fails.
            state = {'phase': 'verified', 'plan': {'sha': 'old', 'taskId': 55}}
            report_terminal(state, out, expected_sha='new')
            self.assertFalse(out.path.exists())
            self.assertEqual(board.calls, 0)
            report_terminal(state, out, expected_sha='old')
            self.assertEqual(board.calls, 1)

    def test_unknown_write_reconciles_readback_without_duplicate(self):
        with tempfile.TemporaryDirectory() as directory:
            board = Fixture()
            out = Outbox(Path(directory) / 'out.json', board)
            out.enqueue(55, 'b', 'connected')
            board.fail = True
            with patch('time.time', return_value=100): out.flush()
            self.assertEqual(load(out.path)[0]['phase'], 'unknown')
            with patch('time.time', return_value=200): out.flush()
            self.assertEqual(load(out.path)[0]['phase'], 'done')
            self.assertEqual(board.calls, 1)
            out.enqueue(55, 'b', 'connected')
            out.flush()
            self.assertEqual(board.calls, 1)

    def test_unavailable_board_retains_multiple_reports_and_retries_after_backoff(self):
        with tempfile.TemporaryDirectory() as directory:
            board = Fixture()
            out = Outbox(Path(directory) / 'out.json', board)
            out.enqueue(55, 'b', 'rolled_back')
            out.enqueue(55, 'c', 'connected')
            with patch.object(board, 'task', side_effect=Blocked('offline')), patch('time.time', return_value=100):
                out.flush()  # no exception escapes into release loop
            self.assertEqual(len(load(out.path)), 2)
            self.assertTrue(all(e['nextAttempt'] > 100 for e in load(out.path)))
            with patch('time.time', return_value=200): out.flush()
            self.assertTrue(all(e['phase'] == 'done' for e in load(out.path)))
            self.assertEqual(board.calls, 2)


if __name__ == '__main__': unittest.main()
