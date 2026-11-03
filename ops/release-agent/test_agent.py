import copy
import contextlib
import hashlib
import hmac
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import agent


class Backend:
    def __init__(self, db):
        self.db = db
        self.image = 'old'
        self.fail = None
        self.events = []

    def event(self, name):
        self.events.append(name)
        if self.fail == name:
            raise RuntimeError('private diagnostic must not leak')

    def capture(self, current, plan):
        self.event('capture')
        return {'sha': current, 'image': self.image}

    def build(self, plan): self.event('build')
    def stop(self, plan): self.event('stop')
    def backup(self, plan):
        self.event('backup')
        agent.verified_backup(self.db, self.db.parent / (plan['sha'] + '.sqlite'))

    def switch(self, plan):
        self.event('switch')
        self.image = plan['sha']
        # A real write arrives after startup, before health. It MUST survive rollback.
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.execute('INSERT INTO messages(text) VALUES (?)', ('new request',))

    def health(self): self.event('health')
    def commit(self, plan): self.event('commit')

    def restore(self, previous, plan):
        self.event('restore')
        self.image = previous['image']
        if self.fail == 'health': self.fail = None


class Transactions(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.db = self.root / 'live.sqlite'
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.execute('CREATE TABLE messages(id INTEGER PRIMARY KEY,text TEXT)')
            db.execute("INSERT INTO messages(text) VALUES ('draft / old conversation')")
        self.backend = Backend(self.db)
        self.engine = agent.Engine(self.root / 'state', self.backend)
        self.engine.save({'phase': 'idle', 'current': 'a'})
        self.plan = {'sha': 'b', 'parent': 'a'}

    def rows(self, path=None):
        with contextlib.closing(sqlite3.connect(path or self.db)) as db:
            return db.execute('SELECT text FROM messages ORDER BY id').fetchall()

    def test_success_and_two_prs_are_sequential(self):
        self.engine.deploy(self.plan)
        self.assertEqual(self.engine.state()['current'], 'b')
        self.engine.deploy({'sha': 'c', 'parent': 'b'})
        self.assertEqual(self.engine.state()['current'], 'c')
        self.assertEqual(len(self.rows()), 3)
        self.assertEqual(self.backend.events.count('backup'), 2)

    def test_health_failure_rolls_back_image_preserving_new_and_old_data(self):
        self.backend.fail = 'health'
        with self.assertRaisesRegex(agent.Blocked, 'RELEASE_ROLLED_BACK'):
            self.engine.deploy(self.plan)
        self.assertEqual(self.backend.image, 'old')
        self.assertEqual(self.engine.state()['phase'], 'rolled_back')
        self.assertEqual(self.engine.state()['current'], 'a')
        self.assertEqual(self.rows(), [('draft / old conversation',), ('new request',)])
        self.assertEqual(self.rows(self.root / 'b.sqlite'), [('draft / old conversation',)])
        with self.assertRaisesRegex(agent.Blocked, 'OUT_OF_ORDER'):
            self.engine.deploy(self.plan)

    def test_backup_failure_never_switches(self):
        self.backend.fail = 'backup'
        with self.assertRaises(agent.Blocked): self.engine.deploy(self.plan)
        self.assertNotIn('switch', self.backend.events)
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(self.backend.image, 'old')

    def test_build_failure_leaves_runtime_untouched(self):
        self.backend.fail = 'build'
        with self.assertRaises(agent.Blocked): self.engine.deploy(self.plan)
        self.assertNotIn('stop', self.backend.events)
        self.assertEqual(self.backend.image, 'old')

    def test_out_of_order_rejected_before_capture(self):
        with self.assertRaisesRegex(agent.Blocked, 'OUT_OF_ORDER'):
            self.engine.deploy({'sha': 'c', 'parent': 'b'})
        self.assertEqual(self.backend.events, [])

    def test_crash_recovery_each_mutating_phase(self):
        for phase in ('stopping', 'backing_up', 'switching', 'checking', 'rolling_back'):
            with self.subTest(phase=phase):
                self.engine.save({'phase': phase, 'current': 'a', 'plan': self.plan,
                                  'previous': {'sha': 'a', 'image': 'old'}})
                self.backend.image = 'unknown'
                self.engine.recover()
                self.assertEqual(self.backend.image, 'old')
                self.assertTrue(self.engine.state()['recovered'])

    def test_rollback_failure_is_durable_and_blocks(self):
        self.backend.fail = 'restore'
        self.engine.save({'phase': 'checking', 'plan': self.plan,
                          'previous': {'sha': 'a', 'image': 'old'}})
        with self.assertRaisesRegex(agent.Blocked, 'ROLLBACK_NEEDS_REVIEW'): self.engine.recover()
        self.assertEqual(self.engine.state()['phase'], 'rollback_failed')
        with self.assertRaises(agent.Blocked): self.engine.recover()

    def test_manual_rollback_keeps_requests_after_release(self):
        self.engine.deploy(self.plan)
        self.engine.rollback()
        self.assertEqual(self.backend.image, 'old')
        self.assertEqual(len(self.rows()), 2)
        with self.assertRaisesRegex(agent.Blocked, 'ROLLBACK_NOT_CURRENT_VERIFIED'):
            self.engine.rollback()

    def test_correcting_pr_after_rollback_uses_cursor_not_runtime_sha(self):
        self.backend.fail = 'health'
        with self.assertRaises(agent.Blocked): self.engine.deploy(self.plan)
        self.assertEqual(self.engine.state()['cursor'], 'b')
        self.assertEqual(self.engine.state()['current'], 'a')
        self.engine.deploy({'sha': 'c', 'parent': 'b'})
        self.assertEqual(self.engine.state()['current'], 'c')

    def test_build_failed_prepared_and_docs_do_not_stop_future_pr(self):
        self.backend.fail = 'build'
        with self.assertRaises(agent.Blocked): self.engine.deploy(self.plan)
        self.backend.fail = None
        self.engine.advance({'sha': 'docs', 'parent': 'b'}, 'no_release')
        self.engine.deploy({'sha': 'fixed', 'parent': 'docs'})
        self.assertEqual(self.engine.state()['current'], 'fixed')
        self.engine.save({'phase': 'prepared', 'current': 'fixed', 'cursor': 'fixed',
                          'plan': {'sha': 'interrupted', 'parent': 'fixed'}})
        self.engine.recover()
        self.engine.deploy({'sha': 'after', 'parent': 'interrupted'})
        self.assertEqual(self.engine.state()['current'], 'after')

    def test_lock_excludes_second_writer(self):
        if agent.os.name != 'posix': self.skipTest('flock requires Linux')
        with agent.release_lock(self.root / 'lease'):
            with self.assertRaisesRegex(agent.Blocked, 'RELEASE_BUSY'):
                with agent.release_lock(self.root / 'lease'): pass


class Gates(unittest.TestCase):
    def setUp(self):
        self.body = {'sha': 'b', 'parent': 'a', 'reviewerRole': 'claude', 'codeAccepted': True,
                     'taskId': 55, 'expires': 100, 'migration': 'forward-compatible', 'reconciled': True}

    def signed(self, body=None):
        body = body or self.body
        return {'body': body, 'signature': hmac.new(b'fixture', agent.canonical(body), hashlib.sha256).hexdigest()}

    def test_valid_exact_sha_admission(self):
        self.assertEqual(agent.verify_admission(self.signed(), b'fixture', 'b', 'a', now=1), self.body)

    def test_forged_author_expired_wrong_sha_migration_and_baseline_denied(self):
        cases = [({'reviewerRole': 'editor'}, 'ADMISSION_REVIEWER'),
                 ({'expires': 0}, 'ADMISSION_EXPIRED'), ({'sha': 'c'}, 'ADMISSION_COMMIT'),
                 ({'migration': 'irreversible'}, 'WAITS_OWNER_MIGRATION'),
                 ({'reconciled': False}, 'BASELINE_NOT_RECONCILED')]
        for change, code in cases:
            with self.subTest(change=change), self.assertRaisesRegex(agent.Blocked, code):
                agent.verify_admission(self.signed(dict(self.body, **change)), b'fixture', 'b', 'a', now=1)
        with self.assertRaisesRegex(agent.Blocked, 'ADMISSION_SIGNATURE'):
            agent.verify_admission(self.signed(), b'wrong', 'b', 'a', now=1)

    def test_nonruntime_is_consumed_and_sites_are_deferred(self):
        config = {'services': {'crm': {'context': 'ops/crm', 'writers': ['content']},
                               'content': {'context': 'ops/content'}}}
        plan = agent.make_plan(config, {}, ['ops/crm/server.js'])
        self.assertEqual(plan['writers'], ['content', 'crm'])
        self.assertEqual(plan['outcome'], 'runtime')
        for path in ('docs/a.md', 'specs/a.md', 'AI_HANDOFF/a.md', 'docker-compose.yml', 'ops/crm-evil/a'):
            self.assertEqual(agent.make_plan(config, {}, [path])['outcome'], 'no_release')
        self.assertEqual(agent.make_plan(config, {}, ['sites/alvi/index.html'])['outcome'], 'site_deferred')

    def test_ci_accepts_pr_head_checks_and_requires_merge_spec_kit(self):
        api = agent.GitHub('fixture/repo')
        pr = {'number': 1, 'merged_at': 'now', 'merge_commit_sha': 'b', 'base': {'ref': 'main'}, 'head': {'sha': 'h'}}
        check = {'head_sha': 'h', 'name': 'test', 'status': 'completed', 'conclusion': 'success'}
        spec = dict(check, head_sha='b', name='process-check')
        admission = {'pr': 1, 'headSha': 'h', 'requiredChecks': ['test']}
        responses = [[pr], {'total_count': 1, 'check_runs': [check]}, {'total_count': 1, 'check_runs': [spec]}, {'total_count': 0}]
        with patch.object(api, 'get', side_effect=responses): api.gate('b', admission)
        for field, value in [('head_sha', 'old'), ('conclusion', 'failure'), ('status', 'queued')]:
            with self.subTest(field=field), patch.object(api, 'get', side_effect=[
                [pr], {'total_count': 1, 'check_runs': [dict(check, **{field: value})]}]):
                with self.assertRaises(agent.Blocked): api.gate('b', admission)
        with patch.object(api, 'get', side_effect=[[pr], {'total_count': 1, 'check_runs': [check]}, {'total_count': 0, 'check_runs': []}]):
            with self.assertRaisesRegex(agent.Blocked, 'MERGE_SPEC_KIT'): api.gate('b', admission)


if __name__ == '__main__': unittest.main()
