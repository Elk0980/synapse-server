from pathlib import Path
import tempfile
import unittest
from board import Outbox
from agent import Blocked, load, report_terminal


class Fixture:
    def __init__(self):
        self.calls = 0
        self.fail = False
        self.task_data = {'coordination': {'revision': 3, 'milestones': {'connected': {'evidence': ''}}}, 'comments': []}

    def task(self, task_id): return self.task_data

    def call(self, method, args):
        self.calls += 1
        if method == 'task_update':
            self.task_data['coordination']['milestones']['connected']['evidence'] = args['evidence']
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
            with self.assertRaises(Blocked): out.flush()
            self.assertEqual(load(out.path)['phase'], 'unknown')
            out.flush()
            self.assertEqual(load(out.path)['phase'], 'done')
            self.assertEqual(board.calls, 1)
            out.enqueue(55, 'b', 'connected')
            out.flush()
            self.assertEqual(board.calls, 1)

    def test_unknown_absent_result_never_blindly_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            board = Fixture()
            out = Outbox(Path(directory) / 'out.json', board)
            out.enqueue(55, 'b', 'rolled_back')
            board.fail = True
            with self.assertRaises(Blocked): out.flush()
            board.task_data['comments'] = []
            with self.assertRaisesRegex(Blocked, 'BOARD_UNKNOWN'): out.flush()
            self.assertEqual(board.calls, 1)


if __name__ == '__main__': unittest.main()
