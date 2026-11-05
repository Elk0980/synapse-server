import unittest
import json
import re
import tempfile
from pathlib import Path
from unittest.mock import patch
import guard

ROOT = Path(__file__).resolve().parents[2]
LAYOUT = guard.load_layout(ROOT)

COMPOSE = """services:
  caddy:
    image: caddy:2-alpine
    volumes:
      - ./caddy:/etc/caddy:ro
      - ./sites:/srv/sites:ro
      - caddy_data:/data
  crm:
    volumes:
      - ./other:/srv/sites/crm-only
"""


def layout(caddyfile, compose=COMPOSE):
    return guard.site_layout(caddyfile, compose)


class AdmissionTests(unittest.TestCase):
    def check(self, paths, labels=(), layout=LAYOUT, **kwargs):
        files = [{'filename': path, 'status': 'modified'} for path in paths]
        pr = {'state': 'open', 'head': {'sha': 'a' * 40}, 'changed_files': len(files),
              'labels': [{'name': label} for label in labels]}
        pr.update(kwargs)
        return guard.evaluate(pr, files, 'a' * 40, layout)

    def assert_needs_label(self, paths, layout=LAYOUT):
        with self.assertRaises(ValueError) as error:
            self.check(paths, layout=layout)
        self.assertIn(guard.INFRA, str(error.exception))
        self.assertEqual(self.check(paths, [guard.INFRA], layout=layout)['requiredLabels'], [guard.INFRA])

    # --- Решение Влада 05.11 19:14: четыре обязательных сценария ---

    def test_clean_site_without_label_fails(self):
        for path in ('sites/avokado3/index.html', 'sites/alvi/prices.html',
                     'sites/palitra-love/assets/app.js'):
            with self.subTest(path=path):
                self.assert_needs_label([path])

    def test_workshop_site_without_label_passes(self):
        for path in ('sites/avokado/index.html', 'sites/avokado2/index.html',
                     'sites/taisabai/index.html', 'sites/drafts/peptides/index.html',
                     'sites/drafts/new-client/index.html', 'sites/synapse/cabinet.html',
                     'sites/synapse/track.js', 'sites/synapse/company-links.js',
                     'sites/chat/inbox.html', 'sites/vhod/index.html', 'panel/index.html',
                     'ops/crm/server.js', 'ops/content/server.js', 'ops/content/site-store.js',
                     'ops/content/seed/alvi-price.json', 'ops/crm/company-links.js',
                     'ops/content/client-bot-config.js', 'ops/crm/Dockerfile',
                     'ops/tasks-mcp/server.js', 'specs/100-x/spec.md', 'docs/production-sites/PLAN.md',
                     'tools/spec-kit/gate.py', 'README.md'):
            with self.subTest(path=path):
                self.assertEqual(self.check([path])['requiredLabels'], [])

    def test_protection_itself_without_label_fails(self):
        for path in ('tools/protect-prod-sites/guard.py', 'tools/protect-prod-sites/test_guard.py',
                     '.github/workflows/protect-prod-sites.yml', '.github/workflows/protect-prod-sites-tests.yml',
                     '.github/workflows/new.yaml', '.github/CODEOWNERS', 'caddy/Caddyfile',
                     'caddy/sites/new.caddy', 'Caddyfile', 'docker-compose.yml', 'compose.prod.yaml',
                     'ops/synapse-sync', 'ops/synapse-sync.README.md', 'ops/release/x.sh', 'ops/autosync/x.sh'):
            with self.subTest(path=path):
                self.assert_needs_label([path])

    def test_unknown_folder_is_protected(self):
        for path in ('sites/new-client/index.html', 'sites/board/index.html', 'sites/site-seo.test.cjs'):
            with self.subTest(path=path):
                self.assert_needs_label([path])

    # --- Вывод из Caddyfile ---

    def test_current_caddyfile_mapping(self):
        rows = {row['domain']: row for row in LAYOUT['domains']}
        self.assertEqual(rows['avokado38.ru']['dirs'], ['sites/avokado3'])
        self.assertEqual(rows['spaalvi-38.ru']['dirs'], ['sites/alvi'])
        self.assertEqual(rows['palitra-love.ru']['dirs'], ['sites/palitra-love'])  # через snippet
        for domain in ('avokado38.ru', 'spaalvi-38.ru', 'palitra-love.ru', 'www.avokado38.ru'):
            self.assertTrue(rows[domain]['clean'], domain)
        for domain, row in rows.items():
            if domain.endswith('synapsebusiness.ru'):
                self.assertFalse(row['clean'], domain)
        self.assertTrue({'sites/avokado3', 'sites/alvi', 'sites/palitra-love'} <= LAYOUT['clean'])
        for folder in ('sites/avokado', 'sites/avokado2', 'sites/taisabai', 'sites/synapse', 'sites/chat'):
            self.assertNotIn(folder, LAYOUT['clean'])

    def test_every_bought_domain_in_caddyfile_is_protected(self):
        # Независимая сверка: каждый адрес верхнего уровня без synapse с root/import дал папку.
        text = (ROOT / guard.CADDYFILE).read_text(encoding='utf-8')
        heads = re.findall(r'^([^\s#(][^\n{]*)\{\s*$', text, flags=re.M)
        bought = {h.strip() for head in heads for h in head.replace(',', ' ').split()
                  if 'synapse' not in h}
        rows = {row['domain']: row for row in LAYOUT['domains']}
        self.assertTrue(bought)
        for domain in bought:
            self.assertTrue(rows[domain]['clean'], domain)
            for folder in rows[domain]['dirs']:
                self.assertIn(folder, LAYOUT['clean'])

    def test_new_bought_domain_becomes_protected_automatically(self):
        caddy = ('new.synapsebusiness.ru {\n  root * /srv/sites/nebo\n  file_server\n}\n'
                 'nebo-studio.ru, www.nebo-studio.ru {\n  root * /srv/sites/nebo\n  file_server\n}\n')
        found = layout(caddy)
        self.assertEqual(found['clean'], {'sites/nebo'})
        self.assert_needs_label(['sites/nebo/index.html'], layout=found)
        self.assertEqual(self.check(['sites/other/x'], [guard.INFRA], layout=found)['requiredLabels'], [guard.INFRA])

    def test_snippets_quotes_and_placeholders(self):
        caddy = ('{\n  email a@b\n}\n(site) {\n  root * /srv/sites/shop\n  file_server\n}\n'
                 'shop.synapsebusiness.ru {\n  respond `a { b\n}` 200\n  redir https://x{uri}\n  import site\n}\n'
                 'shop.ru {\n  header X "{ not a block"\n  import site\n}\n')
        found = layout(caddy)
        self.assertEqual(found['clean'], {'sites/shop'})

    def test_whole_tree_root_protects_everything_below(self):
        found = layout('client.ru {\n  root * /srv/sites\n  file_server\n}\n'
                       'x.synapsebusiness.ru {\n  root * /srv/sites/x\n}\n')
        self.assert_needs_label(['sites/x/index.html'], layout=found)

    def test_unmappable_clean_site_fails_closed(self):
        bad = [
            'client.ru {\n  root * {$ROOT}\n  file_server\n}\n',              # placeholder
            'client.ru {\n  root * /srv/elsewhere\n  file_server\n}\n',       # root вне репозитория
            'client.ru {\n  import /data/extra/*.conf\n  file_server\n}\n',   # неизвестный файл
            'client.ru {\n  file_server\n}\n',                                # без root
            'client.ru {\n  root * /srv/sites/a\n',                           # незакрытый блок
            'import /etc/other.caddy\n',                                      # верхний уровень
            '',                                                               # пусто
        ]
        for caddy in bad:
            with self.subTest(caddy=caddy), self.assertRaises(ValueError):
                layout(caddy)
        with self.assertRaises(ValueError):
            guard.site_layout('a.ru {\n  root * /srv/sites/a\n}\n', 'services:\n  web:\n    image: x\n')

    def test_layout_error_requires_label_for_everything(self):
        error = ValueError('broken Caddyfile')
        for path in ('docs/a.md', 'sites/avokado/index.html', 'ops/crm/server.js'):
            with self.subTest(path=path):
                self.assert_needs_label([path], layout=error)
        with patch.object(guard, 'load_layout', side_effect=OSError('missing')):
            self.assertEqual(guard.required_labels(['docs/a.md']), {guard.INFRA})

    def test_workshop_mount_of_other_service_is_ignored(self):
        found = layout('a.synapsebusiness.ru {\n  root * /srv/sites/a\n}\n')
        self.assertNotIn('other', found['trees'])
        self.assertEqual(self.check(['other/x.js'], layout=found)['requiredLabels'], [])

    def test_domain_rule(self):
        for address in ('avokado38.ru', 'https://palitra-love.ru', 'client.ru:443', '{$DOMAIN}', ':80'):
            self.assertTrue(guard.is_bought_domain(address), address)
        for address in ('alvi.synapsebusiness.ru', 'https://SYNAPSE.synapsebusiness.ru:443',
                        'synapse-demo.ru'):
            self.assertFalse(guard.is_bought_domain(address), address)

    # --- Общие свойства допуска ---

    def test_mixed_pr_needs_label_once(self):
        self.check(['ops/crm/server.js', 'sites/avokado/a'])
        self.assert_needs_label(['ops/crm/server.js', 'sites/alvi/index.html'])

    def test_exact_label_only(self):
        for labels in ([], ['сайт alvi'], ['Сайты: инфраструктура'], [guard.INFRA + ' ']):
            with self.subTest(labels=labels), self.assertRaises(ValueError):
                self.check(['sites/alvi/index.html'], labels)

    def test_rename_out_of_clean_site(self):
        pr = {'state': 'open', 'head': {'sha': 'a'}, 'changed_files': 1, 'labels': []}
        files = [{'filename': 'sites/avokado/a', 'status': 'renamed', 'previous_filename': 'sites/alvi/a'}]
        with self.assertRaises(ValueError):
            guard.evaluate(pr, files, 'a', LAYOUT)
        files[0]['previous_filename'] = None
        with self.assertRaises(ValueError):
            guard.evaluate(pr, files, 'a', LAYOUT)
        pr['labels'] = [{'name': guard.INFRA}]
        files[0]['previous_filename'] = 'sites/alvi/a'
        guard.evaluate(pr, files, 'a', LAYOUT)

    def test_deleted_file(self):
        pr = {'state': 'open', 'head': {'sha': 'a'}, 'changed_files': 1, 'labels': []}
        with self.assertRaises(ValueError):
            guard.evaluate(pr, [{'filename': 'sites/alvi/index.html', 'status': 'removed'}], 'a', LAYOUT)

    def test_bootstrap_workflow_rechecks_label_events(self):
        workflow = (ROOT / '.github/workflows/protect-prod-sites-tests.yml').read_text(encoding='utf-8')
        self.assertRegex(workflow, r'pull_request:\s+types: \[[^\]]*\blabeled\b[^\]]*\bunlabeled\b')

    def test_trusted_workflow_reads_base_checkout(self):
        workflow = (ROOT / '.github/workflows/protect-prod-sites.yml').read_text(encoding='utf-8')
        self.assertIn('pull_request_target', workflow)
        self.assertIn('ref: ${{ github.event.pull_request.base.sha }}', workflow)

    def test_partial_stale_closed(self):
        for kwargs in ({'changed_files': 2}, {'changed_files': 3001},
                       {'head': {'sha': 'old'}}, {'state': 'closed'}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.check(['ops/tasks-mcp/a'], **kwargs)

    def test_bad_paths(self):
        for path in ('../sites/alvi/a', '/sites/alvi/a', 'sites\\alvi\\a', ''):
            with self.subTest(path=path), self.assertRaises(ValueError):
                guard.required_labels([path], LAYOUT)

    def test_api_pagination_and_race(self):
        pr = {'state': 'open', 'head': {'sha': 'a'}, 'changed_files': 101,
              'labels': [{'name': guard.INFRA}], 'updated_at': '1'}
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
