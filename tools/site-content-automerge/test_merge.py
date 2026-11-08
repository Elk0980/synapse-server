import copy
import importlib.util
import json
from pathlib import Path
import re
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('content_merge', HERE / 'merge.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
WORKFLOW = (HERE.parent.parent / '.github/workflows/site-content-automerge.yml').read_text(encoding='utf-8')
ROOTS = json.loads(re.search(r"SITE_MERGE_ROOTS: '([^']+)'", WORKFLOW)[1])
EXT = set(json.loads(re.search(r"SITE_MERGE_EXTENSIONS: '([^']+)'", WORKFLOW)[1]))
HEAD, BASE, TREE, BLOB, MERGED = (c * 40 for c in 'abcde')
REPO = 'example/project'
FILE = 'sites/drafts/demo/index.html'


def fixtures():
    pr = {'number': 1, 'state': 'open', 'draft': False, 'author_association': 'OWNER',
          'mergeable': True, 'mergeable_state': 'clean', 'changed_files': 1, 'labels': [],
          'head': {'sha': HEAD, 'repo': {'full_name': REPO}},
          'base': {'sha': BASE, 'ref': 'main', 'repo': {'full_name': REPO}}}
    files = [{'filename': FILE, 'status': 'added', 'sha': BLOB}]
    tree = {'sha': TREE, 'truncated': False, 'tree': [
        {'path': FILE, 'type': 'blob', 'mode': '100644', 'sha': BLOB, 'size': 12}]}
    checks = {'total_count': 2, 'check_runs': [
        {'id': i, 'name': name, 'head_sha': HEAD, 'started_at': '2026-11-08T00:00:00Z',
         'status': 'completed', 'conclusion': 'success', 'app': {'id': m.ACTIONS_APP}}
        for i, name in enumerate(sorted(m.REQUIRED_CHECKS), 1)]}
    statuses = {'sha': HEAD, 'total_count': 1, 'statuses': [
        {'context': m.REQUIRED_STATUS, 'state': 'success', 'creator': {'login': 'github-actions[bot]'}}]}
    return pr, files, tree, checks, statuses


class FakeAPI:
    repo = REPO

    def __init__(self):
        self.pr, self.files, self.tree, self.checks, self.statuses = fixtures()
        self.main = BASE
        self.ancestor = BASE
        self.latest = None
        self.reviews = []
        self.calls = []

    def pages(self, path, limit=300):
        return copy.deepcopy(self.files if path.endswith('/files') else self.reviews)

    def call(self, method, path, body=None):
        self.calls.append((method, path, body))
        if method == 'PUT':
            return {'merged': True, 'sha': MERGED}
        values = {
            '/pulls/1': self.latest if self.latest is not None and sum(p == '/pulls/1' for _, p, _ in self.calls) > 1 else self.pr,
            f'/git/commits/{HEAD}': {'sha': HEAD, 'tree': {'sha': TREE}},
            f'/git/trees/{TREE}?recursive=1': self.tree,
            f'/compare/{BASE}...{HEAD}': {'status': 'ahead', 'merge_base_commit': {'sha': self.ancestor}},
            f'/commits/{HEAD}/check-runs?per_page=100&filter=latest': self.checks,
            f'/commits/{HEAD}/status?per_page=100': self.statuses,
            '/git/ref/heads/main': {'object': {'sha': self.main}},
        }
        return copy.deepcopy(values[path])


class AdmissionTests(unittest.TestCase):
    def test_paths(self):
        for path in (FILE, 'sites/alvi/hero.js', 'sites/avokado/video/intro.mp4', 'sites/nebo/index.html'):
            with self.subTest(path=path):
                self.assertTrue(m.path_allowed(path, ROOTS, EXT))
        for path in ('ops/server.js', '.github/workflows/x.yml', 'sites/synapse/cabinet/a.js',
                     'sites/chat/index.html', 'sites/drafts/../alvi/index.html', '/'+FILE,
                     'sites/drafts/a/.env', 'sites/drafts/a/server.js', 'sites/drafts/a/api.server.js',
                     'sites/drafts/a/server/api.js', 'sites/drafts/a/package.json',
                     'sites/drafts/a/node_modules/a.js', 'sites/drafts/a/x.test.js',
                     'sites/drafts/a/script.py', 'sites/drafts/a/vite.config.js',
                     'sites/drafts/a/sw.js', 'sites/drafts/a/Caddyfile', 'sites/drafts/a//index.html',
                     'sites/unknown/index.html', 'sites/drafts/a/secret.pem'):
            with self.subTest(path=path):
                self.assertFalse(m.path_allowed(path, ROOTS, EXT))

    def assert_refused(self, api):
        with self.assertRaises(m.Refused):
            m.consider(api, 1, ROOTS, EXT, apply=True)
        self.assertFalse(any(method == 'PUT' for method, _, _ in api.calls))

    def test_squash_exact_head(self):
        api = FakeAPI()
        result = m.consider(api, 1, ROOTS, EXT, apply=True)
        self.assertEqual(result['sha'], MERGED)
        self.assertEqual(api.calls[-1], ('PUT', '/pulls/1/merge', {'sha': HEAD, 'merge_method': 'squash'}))

    def test_dry_run_has_no_mutations(self):
        api = FakeAPI()
        self.assertTrue(m.consider(api, 1, ROOTS, EXT)['eligible'])
        self.assertFalse(any(method != 'GET' for method, _, _ in api.calls))

    def test_outside_or_mixed_pr_never_merges(self):
        for path in ('ops/crm/server.js', '.github/workflows/x.yml', 'sites/synapse/cabinet.html'):
            api = FakeAPI()
            api.files.append({'filename': path, 'status': 'added', 'sha': BLOB})
            api.pr['changed_files'] = 2
            self.assert_refused(api)

    def test_pr_states(self):
        for key, value in [('draft', True), ('state', 'closed'), ('mergeable', None),
                           ('mergeable', False), ('mergeable_state', 'blocked'),
                           ('changed_files', 201), ('changed_files', 0), ('author_association', 'NONE')]:
            api = FakeAPI()
            api.pr[key] = value
            self.assert_refused(api)

    def test_fork_and_other_base_refused(self):
        for side in ('head', 'base'):
            api = FakeAPI()
            api.pr[side]['repo']['full_name'] = 'other/repo'
            self.assert_refused(api)
        api = FakeAPI()
        api.pr['base']['ref'] = 'release'
        self.assert_refused(api)

    def test_incomplete_and_duplicate_files(self):
        api = FakeAPI()
        api.pr['changed_files'] = 2
        self.assert_refused(api)
        api.files *= 2
        self.assert_refused(api)

    def test_no_rename_delete_symlink_or_oversized(self):
        for status in ('removed', 'renamed', 'copied'):
            api = FakeAPI()
            api.files[0]['status'] = status
            self.assert_refused(api)
        for key, value in [('mode', '120000'), ('mode', '100755'), ('type', 'commit'),
                           ('size', m.MAX_BYTES + 1), ('sha', 'f'*40)]:
            api = FakeAPI()
            api.tree['tree'][0][key] = value
            self.assert_refused(api)
        api = FakeAPI()
        api.tree['truncated'] = True
        self.assert_refused(api)

    def test_tree_sha_is_bound_to_commit(self):
        api = FakeAPI()
        api.tree['sha'] = 'f'*40
        self.assert_refused(api)

    def test_checks_pending_failed_missing_or_spoofed(self):
        for key, value in [('status', 'in_progress'), ('conclusion', 'failure'),
                           ('conclusion', 'skipped'), ('head_sha', BASE), ('app', {'id': 123})]:
            api = FakeAPI()
            api.checks['check_runs'][0][key] = value
            self.assert_refused(api)
        api = FakeAPI()
        api.checks['check_runs'].pop()
        api.checks['total_count'] = 1
        self.assert_refused(api)
        api = FakeAPI()
        api.checks['total_count'] = 3
        self.assert_refused(api)

    def test_optional_pending_check_also_blocks(self):
        api = FakeAPI()
        extra = copy.deepcopy(api.checks['check_runs'][0])
        extra.update(name='new-client-test', status='queued', id=5)
        api.checks['check_runs'].append(extra)
        api.checks['total_count'] += 1
        self.assert_refused(api)

    def test_latest_check_not_earlier_green(self):
        api = FakeAPI()
        extra = copy.deepcopy(api.checks['check_runs'][0])
        extra.update(id=8, started_at='2026-11-08T01:00:00Z', conclusion='failure')
        api.checks['check_runs'].append(extra)
        api.checks['total_count'] += 1
        self.assert_refused(api)

    def test_protection_status_required_and_trusted(self):
        for key, value in [('state', 'pending'), ('context', 'unrelated'),
                           ('creator', {'login': 'someone'})]:
            api = FakeAPI()
            api.statuses['statuses'][0][key] = value
            self.assert_refused(api)
        api = FakeAPI()
        api.statuses['sha'] = BASE
        self.assert_refused(api)

    def test_head_labels_and_main_races_refused(self):
        for key, value in [('labels', [{'name': 'changed'}]), ('draft', True)]:
            api = FakeAPI()
            api.latest = copy.deepcopy(api.pr)
            api.latest[key] = value
            self.assert_refused(api)
        api = FakeAPI()
        api.latest = copy.deepcopy(api.pr)
        api.latest['head']['sha'] = 'f'*40
        self.assert_refused(api)
        api = FakeAPI()
        api.main = 'f'*40
        self.assert_refused(api)
        api = FakeAPI()
        api.ancestor = 'f'*40
        self.assert_refused(api)

    def test_review_request_blocks_until_dismissed_or_approved(self):
        api = FakeAPI()
        api.reviews = [{'state': 'CHANGES_REQUESTED', 'user': {'id': 3}, 'id': 1}]
        self.assert_refused(api)
        api.reviews.append({'state': 'COMMENTED', 'user': {'id': 3}, 'id': 2})
        self.assert_refused(api)
        api.reviews.append({'state': 'APPROVED', 'user': {'id': 3}, 'id': 3})
        self.assertTrue(m.consider(api, 1, ROOTS, EXT)['eligible'])

    def test_event_number_and_fallback(self):
        self.assertEqual(m.candidates(None, {'pull_request': {'number': 9}}), [9])
        self.assertEqual(m.candidates(None, {'inputs': {'pr_number': '12'}}), [12])
        self.assertEqual(m.candidates(None, {'workflow_run': {'pull_requests': [{'number': 8}]}}), [8])
        with self.assertRaises(m.Refused):
            m.candidates(None, {'inputs': {'pr_number': '1; rm'}})

    def test_write_job_never_checks_out_pr(self):
        job = WORKFLOW.split('  merge-content:', 1)[1]
        self.assertIn('ref: main', job)
        self.assertIn('persist-credentials: false', job)
        self.assertNotIn('pull_request.head', job)
        self.assertIn('--apply', job)
        self.assertNotIn('secrets.', WORKFLOW)


if __name__ == '__main__':
    unittest.main()
