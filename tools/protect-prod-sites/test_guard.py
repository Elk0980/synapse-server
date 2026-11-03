import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
import guard


class AdmissionTests(unittest.TestCase):
    def check(self, paths, labels=(), **kwargs):
        files = [{'filename': path, 'status': 'modified'} for path in paths]
        pr = {'state': 'open', 'head': {'sha': 'a' * 40}, 'changed_files': len(files),
              'labels': [{'name': label} for label in labels]}
        pr.update(kwargs)
        return guard.evaluate(pr, files, 'a' * 40)

    def test_workshop(self):
        self.check(['ops/crm/server.js', 'sites/synapse/cabinet.html'])

    def test_client_requires_exact_label(self):
        for labels in ([], ['сайт alvi2'], ['Сайт alvi'], ['сайт alvi ']):
            with self.subTest(labels=labels), self.assertRaises(ValueError):
                self.check(['sites/alvi/index.html'], labels)
        self.check(['sites/alvi/index.html'], ['сайт alvi'])

    def test_every_client(self):
        with self.assertRaises(ValueError):
            self.check(['sites/alvi/a', 'sites/avokado3/a'], ['сайт alvi'])

    def test_new_client_and_draft(self):
        for slug in ('nebo', 'novy-etap', 'drafts/peptides'):
            with self.subTest(slug=slug), self.assertRaises(ValueError):
                self.check(['sites/' + slug + '/index.html'])
            self.check(['sites/' + slug + '/index.html'], ['сайт ' + slug])

    def test_shared_inputs(self):
        for path in ('caddy/Caddyfile', 'docker-compose.yml', 'compose.prod.yaml',
                     'sites/synapse/track.js', 'sites/synapse/company-links.js',
                     'ops/synapse-sync', 'tools/protect-prod-sites/guard.py',
                     '.github/workflows/protect-prod-sites.yml', '.github/CODEOWNERS',
                     'sites/shared.js'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.check([path])
            self.check([path], [guard.INFRA])

    def test_rename_out_or_between_clients(self):
        pr = {'state': 'open', 'head': {'sha': 'a'}, 'changed_files': 1, 'labels': []}
        files = [{'filename': 'sites/synapse/a', 'status': 'renamed',
                  'previous_filename': 'sites/alvi/a'}]
        with self.assertRaises(ValueError):
            guard.evaluate(pr, files, 'a')
        pr['labels'] = [{'name': 'сайт alvi'}]
        guard.evaluate(pr, files, 'a')
        files[0]['filename'] = 'sites/avokado/a'
        with self.assertRaises(ValueError):
            guard.evaluate(pr, files, 'a')

    def test_deleted_file(self):
        pr = {'state': 'open', 'head': {'sha': 'a'}, 'changed_files': 1, 'labels': []}
        with self.assertRaises(ValueError):
            guard.evaluate(pr, [{'filename': 'sites/alvi/index.html', 'status': 'removed'}], 'a')

    def test_partial_stale_closed(self):
        for kwargs in ({'changed_files': 2}, {'changed_files': 3001},
                       {'head': {'sha': 'old'}}, {'state': 'closed'}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.check(['ops/crm/a'], **kwargs)

    def test_bad_paths(self):
        for path in ('../sites/alvi/a', '/sites/alvi/a', 'sites\\alvi\\a', ''):
            with self.subTest(path=path), self.assertRaises(ValueError):
                guard.required_labels([path])

    def test_api_pagination_and_race(self):
        pr = {'state': 'open', 'head': {'sha': 'a'}, 'changed_files': 101,
              'labels': [{'name': 'сайт alvi'}], 'updated_at': '1'}
        files = [{'filename': 'sites/alvi/' + str(i), 'status': 'modified'} for i in range(101)]
        with patch.object(guard, 'fetch_json', side_effect=[pr, files[:100], files[100:], pr]) as api:
            guard.check_remote('owner/repo', 1, 'a')
            self.assertEqual(api.call_count, 4)
        with patch.object(guard, 'fetch_json', side_effect=[pr, files[:100], files[100:], {**pr, 'labels': []}]):
            with self.assertRaises(ValueError):
                guard.check_remote('owner/repo', 1, 'a')

    def test_status_targets_exact_head(self):
        event = {'pull_request': {'number': 1, 'head': {'sha': 'a' * 40}}}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'event.json'
            path.write_text(json.dumps(event), encoding='utf-8')
            argv = ['guard', '--event', str(path), '--repo', 'owner/repo', '--publish-status']
            with patch('sys.argv', argv), patch.object(guard, 'publish_status') as status:
                with patch.object(guard, 'check_remote', side_effect=ValueError('missing label')):
                    with self.assertRaises(ValueError):
                        guard.main()
                self.assertEqual([c.args for c in status.call_args_list], [
                    ('owner/repo', 'a' * 40, 'pending'), ('owner/repo', 'a' * 40, 'failure')])
            with patch('sys.argv', argv), patch.object(guard, 'publish_status') as status:
                with patch.object(guard, 'check_remote', return_value={'files': 1}):
                    guard.main()
                self.assertEqual(status.call_args_list[-1].args, ('owner/repo', 'a' * 40, 'success'))

    def test_unrelated_repo_metadata_does_not_change_admission(self):
        pr = {'state': 'open', 'head': {'sha': 'a', 'repo': {'pushed_at': '1'}},
              'base': {'sha': 'b'}, 'changed_files': 1, 'labels': [], 'updated_at': '1'}
        latest = {**pr, 'head': {'sha': 'a', 'repo': {'pushed_at': '2'}}, 'updated_at': '2'}
        files = [{'filename': 'ops/crm/a', 'status': 'modified'}]
        with patch.object(guard, 'fetch_json', side_effect=[pr, files, latest]):
            guard.check_remote('owner/repo', 1, 'a')
        latest['base'] = {'sha': 'changed'}
        with patch.object(guard, 'fetch_json', side_effect=[pr, files, latest]):
            with self.assertRaises(ValueError):
                guard.check_remote('owner/repo', 1, 'a')

    def test_status_rejects_invalid_target(self):
        with self.assertRaises(ValueError):
            guard.publish_status('owner/repo', '../main', 'success')


if __name__ == '__main__':
    unittest.main()
