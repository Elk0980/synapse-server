import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
import guard

ROOT = Path(__file__).resolve().parents[2]
SOURCES = {path: (ROOT / path).read_text(encoding='utf-8') for path in guard.PUBLIC_ROUTES}


def line_of(path, needle, nth=0):
    found = [i + 1 for i, line in enumerate(SOURCES[path].split('\n')) if needle in line]
    return found[nth]


def modify(path, number, new_text):
    old_text = SOURCES[path].split('\n')[number - 1]
    return '@@ -%d,1 +%d,1 @@\n-%s\n+%s' % (number, number, old_text, new_text)


def insert_after(path, number, new_text):
    return '@@ -%d,0 +%d,1 @@\n+%s' % (number, number + 1, new_text)


# A harmless change far from public routes in each shared server file.
SAFE_PATCH = {
    'ops/content/server.js': modify('ops/content/server.js', 1, SOURCES['ops/content/server.js'].split('\n')[0] + ' '),
    'ops/crm/server.js': modify('ops/crm/server.js', line_of('ops/crm/server.js', 'Испытания моделей живут'),
                                '  // Испытания моделей — тот же owner-only раздел.'),
}


class AdmissionTests(unittest.TestCase):
    def check(self, paths, labels=(), patches=None, **kwargs):
        patches = patches or {}
        files = [{'filename': path, 'status': 'modified',
                  **({'patch': patches.get(path, SAFE_PATCH.get(path))} if path in guard.PUBLIC_ROUTES else {})}
                 for path in paths]
        pr = {'state': 'open', 'head': {'sha': 'a' * 40}, 'changed_files': len(files),
              'labels': [{'name': label} for label in labels]}
        pr.update(kwargs)
        return guard.evaluate(pr, files, 'a' * 40, SOURCES)

    def test_public_routes_inside_shared_servers_require_label(self):
        content, crm = 'ops/content/server.js', 'ops/crm/server.js'
        cases = [
            (content, modify(content, line_of(content, "parts[0] === 'public-content'") + 3,
                             "      const row = latestStmt.get(parts[1]);")),
            (content, modify(content, line_of(content, "parts[0] === 'public-orders'") + 1, '      // changed')),
            (content, insert_after(content, line_of(content, "parts[0] === 'public-company-links'"), '      noop();')),
            (content, insert_after(content, 1, "if (parts[0] === 'public-new') {}")),
            (crm, modify(crm, line_of(crm, "url.pathname === '/leads'") + 2, '    const contact = body.contact;')),
            (crm, insert_after(crm, line_of(crm, "url.pathname === '/events'"), '    noop();')),
            (crm, modify(crm, line_of(crm, 'const publicPost'), "  const publicPost = true;")),
            (crm, modify(crm, line_of(crm, 'function checkPublicOrigin') + 1, '  return;')),
            (content, modify(content, line_of(content, 'const SITES = '), "const SITES = new Set(['alvi']);")),
            (content, modify(content, line_of(content, 'const DOCUMENT_VALIDATORS = '), 'const DOCUMENT_VALIDATORS = {};')),
            (content, modify(content, line_of(content, 'function validatePrice') + 2, '  // changed')),
            (content, modify(content, line_of(content, 'function validateSite') + 1, '  // changed')),
            (content, insert_after(content, 1, 'const ORDER_SITES = {};')),
            (crm, modify(crm, line_of(crm, 'function companyDomains') + 1, '  return new Set();')),
            (crm, None),  # API omitted the patch (too large): fail closed
        ]
        for path, patch in cases:
            files = [{'filename': path, 'status': 'modified', 'patch': patch}]
            pr = {'state': 'open', 'head': {'sha': 'a'}, 'changed_files': 1, 'labels': []}
            with self.subTest(path=path, patch=patch), self.assertRaises(ValueError):
                guard.evaluate(pr, files, 'a', SOURCES)
            pr['labels'] = [{'name': guard.INFRA}]
            guard.evaluate(pr, files, 'a', SOURCES)

    def test_shared_server_changes_outside_public_routes_need_no_label(self):
        content, crm = 'ops/content/server.js', 'ops/crm/server.js'
        for path, patch in ((content, SAFE_PATCH[content]), (crm, SAFE_PATCH[crm]),
                            (crm, insert_after(crm, line_of(crm, 'function checkPublicOrigin') - 1, '// note'))):
            with self.subTest(path=path, patch=patch):
                self.check([path], patches={path: patch})

    def test_shared_server_without_base_source_or_renamed_fails_closed(self):
        pr = {'state': 'open', 'head': {'sha': 'a'}, 'changed_files': 1, 'labels': []}
        files = [{'filename': 'ops/crm/server.js', 'status': 'modified', 'patch': SAFE_PATCH['ops/crm/server.js']}]
        with self.assertRaises(ValueError):
            guard.evaluate(pr, files, 'a', {})
        files = [{'filename': 'ops/crm/server2.js', 'status': 'renamed', 'previous_filename': 'ops/crm/server.js'}]
        with self.assertRaises(ValueError):
            guard.evaluate(pr, files, 'a', SOURCES)

    def test_remote_reads_server_source_at_merge_base(self):
        sha = lambda c: c * 40
        pr = {'state': 'open', 'head': {'sha': sha('a')}, 'base': {'sha': sha('b')}, 'changed_files': 1, 'labels': []}
        files = [{'filename': 'ops/crm/server.js', 'status': 'modified', 'patch': SAFE_PATCH['ops/crm/server.js']}]
        calls = []
        def fake_json(repo, endpoint):
            calls.append(endpoint)
            if endpoint.startswith('/compare/'):
                return {'merge_base_commit': {'sha': sha('c')}}
            return files if '/files' in endpoint else pr
        def fake_text(repo, endpoint):
            calls.append(endpoint)
            return SOURCES['ops/crm/server.js']
        with patch.object(guard, 'fetch_json', side_effect=fake_json), patch.object(guard, 'fetch_text', side_effect=fake_text):
            guard.check_remote('owner/repo', 1, sha('a'))
        self.assertIn('/compare/' + sha('b') + '...' + sha('a'), calls)
        self.assertIn('/contents/ops/crm/server.js?ref=' + sha('c'), calls)

    def test_workshop(self):
        self.check(['ops/tasks-mcp/server.js', 'sites/synapse/cabinet.html'])

    def test_all_github_paths_require_infrastructure_label(self):
        for path in ('.github/workflows/other.yml', '.github/workflows/new-status-writer.yaml',
                     '.github/actions/local/action.yml', '.github/dependabot.yml',
                     '.github/ISSUE_TEMPLATE/bug.md', '.github/copilot-instructions.md'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.check([path])
            self.check([path], [guard.INFRA])

    def test_workshop_code_needs_no_label(self):
        # Решение Влада по №114: код мастерской проходит без метки.
        for path in ('ops/crm/server.js', 'ops/crm/autoposting.js', 'ops/crm/package.json',
                     'ops/crm/README (Мини-CRM — сервис заявок).md', 'ops/content/server.js',
                     'ops/content/auth-store.js', 'ops/content/new-module.js',
                     'ops/content/package-lock.json', 'sites/synapse/permission-help.js',
                     'sites/synapse/cabinet.html', 'specs/100-people-first-password/spec.md',
                     'docs/production-sites/PLAN.md', 'tools/spec-kit/gate.py',
                     'ops/tasks-mcp/server.js', 'ops/content/compose-contract.test.js'):
            with self.subTest(path=path):
                self.assertEqual(guard.required_labels([path]), set())

    def test_pr_only_with_crm_succeeds_without_label(self):
        result = self.check(['ops/crm/server.js', 'ops/crm/crm-permissions.test.js',
                             'ops/content/people.test.js'])
        self.assertEqual(result['requiredLabels'], [])

    def test_client_site_sources_in_workshop_require_label(self):
        for path in ('ops/content/seed/alvi-price.json', 'ops/content/seed/palitra-price.json',
                     'ops/content/seed/new-client-site.json', 'ops/content/site-store.js',
                     'ops/content/site-orders.js', 'ops/content/company-links-reader.js',
                     'ops/content/tag_site.py', 'ops/content/tag_avokado.py',
                     'ops/crm/company-links.js', 'ops/content/client-bot-config.js'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.check([path])
            self.check([path], [guard.INFRA])

    def test_deploy_infrastructure_requires_label(self):
        for path in ('ops/autosync/sync.sh', 'ops/autosync/README.md', 'ops/release/release.py',
                     'ops/crm/Dockerfile', 'ops/content/Dockerfile', 'ops/tasks-mcp/Dockerfile',
                     'Dockerfile', 'ops/chat/Dockerfile.dev', 'ops/web.dockerfile',
                     'Caddyfile', 'caddy/Caddyfile', 'caddy/sites/alvi.caddy',
                     'ops/crm/compose-fragment.yml', 'ops/eva-tasks/compose.eva.yml',
                     'docker-compose.override.yml', 'ops/synapse-sync.README.md'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.check([path])
            self.check([path], [guard.INFRA])

    def test_keys_and_access_require_label(self):
        for path in ('.env', '.env.example', 'ops/content/.env.local', 'ops/content/session-secret.js',
                     'ops/content/passwords.js', 'ops/content/make-password.js',
                     'ops/content/reset-password.js', 'ops/crm/social-analytics-credentials.js'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.check([path])
            self.check([path], [guard.INFRA])

    def test_specs_about_passwords_need_no_label(self):
        self.assertEqual(guard.required_labels(['specs/100-people-first-password/spec.md']), set())

    def test_required_scenarios_from_task_114(self):
        self.check(['ops/crm/server.js'])
        for path, label in (('sites/alvi/index.html', 'сайт alvi'),
                            ('.github/workflows/ci.yml', guard.INFRA),
                            ('ops/autosync/deploy.sh', guard.INFRA)):
            with self.subTest(path=path):
                with self.assertRaises(ValueError):
                    self.check(['ops/crm/server.js', path])
                self.check(['ops/crm/server.js', path], [label])

    def test_bootstrap_workflow_rechecks_label_events(self):
        workflow = (Path(__file__).resolve().parents[2] /
                    '.github/workflows/protect-prod-sites-tests.yml').read_text(encoding='utf-8')
        self.assertRegex(workflow, r'pull_request:\s+types: \[[^\]]*\blabeled\b[^\]]*\bunlabeled\b')

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
                self.check(['ops/tasks-mcp/a'], **kwargs)

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
        files = [{'filename': 'ops/tasks-mcp/a', 'status': 'modified'}]
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
