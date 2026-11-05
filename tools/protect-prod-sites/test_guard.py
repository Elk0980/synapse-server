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


HEAD = 'abcdef12' + '3' * 32
OLD_HEAD = '0123abcd' + '4' * 32
OK = 'ПРИНЯТ PR 161 @' + HEAD


def comment(body, at='2026-11-05T09:00:00Z', association='COLLABORATOR', cid=1):
    return {'id': cid, 'body': body, 'created_at': at, 'author_association': association,
            'user': {'login': 'reviewer'}, 'html_url': 'https://example.invalid/c/' + str(cid)}


class ReviewApprovalTests(unittest.TestCase):
    """Задача №163: независимое ревью точного head вместо метки Влада (с правками ревью 923)."""

    def check(self, comments, paths=('.github/workflows/ci.yml',), labels=(), head=HEAD):
        files = [{'filename': path, 'status': 'modified'} for path in paths]
        pr = {'number': 161, 'state': 'open', 'head': {'sha': head}, 'changed_files': len(files),
              'labels': [{'name': label} for label in labels]}
        return guard.evaluate(pr, files, head, SOURCES, load_review=lambda: comments)

    def red(self, comments, **kwargs):
        with self.assertRaises(ValueError) as error:
            self.check(comments, **kwargs)
        return str(error.exception)

    def test_label_passes_without_review(self):
        self.assertEqual(self.check([], labels=[guard.INFRA])['admission'], 'labels')
        result = self.check([], paths=['sites/alvi/index.html'], labels=['сайт alvi'])
        self.assertEqual(result['admission'], 'labels')

    def test_approval_of_current_head_passes(self):
        for body in (OK, 'ПРИНЯТ PR 161 `@' + HEAD + '`', 'ПРИНЯТ PR 161 @`' + HEAD + '`',
                     'ПРИНЯТ PR 161 ' + HEAD, OK + '  \r\nЗамечаний нет, тесты 38 OK.'):
            with self.subTest(body=body):
                result = self.check([comment(body)])
                self.assertEqual(result['admission'], 'review')
                self.assertEqual(result['review']['by'], 'reviewer')
        # Клиентский сайт тоже принимается ревью, не только инфраструктура.
        self.check([comment(OK)], paths=['sites/alvi/index.html'])

    def test_approval_of_old_head_fails(self):
        for body in ('ПРИНЯТ PR 161 @' + OLD_HEAD, 'ПРИНЯТ PR 160 @' + HEAD):
            with self.subTest(body=body):
                self.red([comment(body)])

    def test_approval_before_push_does_not_carry_to_new_head(self):
        # Одобрение старого head, затем новый push: прежний «ПРИНЯТ» больше не действует.
        self.check([comment('ПРИНЯТ PR 161 @' + OLD_HEAD)], head=OLD_HEAD)
        self.red([comment('ПРИНЯТ PR 161 @' + OLD_HEAD)], head=HEAD)

    def test_bypass_a_prefix_collision_requires_full_sha(self):
        # Обход A (ревью 923): коммит с тем же 8-символьным префиксом и датой задним числом.
        forged = HEAD[:8] + 'f' * 32
        for body in ('ПРИНЯТ PR 161 @' + HEAD[:8], 'ПРИНЯТ PR 161 @' + HEAD[:39]):
            with self.subTest(body=body):
                self.red([comment(body)])
                self.red([comment(body)], head=forged)
        self.red([comment(OK)], head=forged)
        self.red([comment('ПРИНЯТ PR 161 @' + HEAD.upper())])

    def test_bypass_b_quotes_and_instructions_do_not_approve(self):
        # Обход B: цитата ошибки guard, инструкция, цитата и код в первой строке.
        for body in ('CI красный: Отсутствуют метки; нет «' + OK + '»',
                     'Ревьюер, напиши «' + OK + '», если всё ок',
                     '> ' + OK, '```\n' + OK + '\n```', '`' + OK + '`', ' ' + OK,
                     'Итог\n' + OK, OK + ' — замечаний нет', 'КОД ' + OK, '**' + OK + '**'):
            with self.subTest(body=body):
                self.red([comment(body)])
        # Ошибка guard не печатает готовую фразу одобрения.
        message = self.red([])
        self.assertIn('ПРИНЯТ PR <номер> @<полный sha>', message)
        self.assertNotIn(HEAD[:8], message)
        self.assertIsNone(guard.APPROVAL.search(message.replace('<номер>', '161')))

    def test_bypass_c_any_later_rejection_closes(self):
        # Обход C: отказ без sha, с разметкой, с двоеточием, в любом регистре.
        for body in ('НЕ ПРИНЯТ: обход guard.py:178', '**НЕ** ПРИНЯТ PR 161 @' + HEAD,
                     'НЕ: ПРИНЯТ PR 161 @' + HEAD, 'не принят', 'НеПРИНЯТ PR 161',
                     '> НЕ ПРИНЯТ', '  НЕ   ПРИНЯТ PR 161 @' + OLD_HEAD, 'НЕ-ПРИНЯТ',
                     'ПРИНЯТ PR 161 @' + HEAD[:8], 'Принят частично'):
            with self.subTest(body=body):
                self.red([comment(OK, cid=1), comment(body, at='2026-11-05T09:10:00Z', cid=2)])
                self.red([comment(body, at='2026-11-05T09:10:00Z', cid=2), comment(OK, cid=1)])

    def test_bypass_d_rejection_anywhere_after_normalization(self):
        # Обходы ревью 934: отказ не в первой строке, невидимые символы, двойники, разметка.
        for body in ('Ревью PR 161\nНЕ ПРИНЯТ: guard.py:58', '\nНЕ ПРИНЯТ', '\n\n> **не** принят',
                     'Ревью PR 161: НЕ ПРИНЯТ, см. guard.py:58', 'НЕ ПРИ\u00adНЯТ', 'НЕ ПРИ\u200bНЯТ',
                     'НЕ\u200d ПРИНЯТ', 'Н\u2060Е ПРИНЯТ', '\ufeffНЕ ПРИНЯТ', 'HE ПPИHЯT', 'he пpинят',
                     'Итог:\n## НЕ_ПРИНЯТ', 'НЕ~~ПРИНЯТ~~',
                     'не - принят', 'НЕ\u00a0ПРИНЯТ', 'ＨＥ ПРИНЯТ',  # fullwidth -> NFKC -> двойники
                     'Итог\r\nНе принято', 'НЕ\u2028ПРИНЯТ', 'Ревью\n\n— **НЕ**\u00adПРИНЯТ —'):
            with self.subTest(body=body):
                self.red([comment(OK, cid=1), comment(body, at='2026-11-05T09:10:00Z', cid=2)])
        # Одобрение и отказ в любой строке одного комментария — отказ.
        for tail in ('\nНЕ ПРИНЯТ', '\n\nПодробности ниже.\n> не\u00adпринят', '\nHE ПРИНЯТ'):
            with self.subTest(tail=tail):
                self.red([comment(OK + tail)])
        # Точное одобрение без признаков отказа проходит; обычные слова с «не» не мешают.
        self.check([comment(OK + '\r\nЗамечаний нет. Принято без правок, не нашёл проблем.')])
        # Unicode-цифры в номере PR не принимаются.
        self.red([comment('ПРИНЯТ PR ١٦١ @' + HEAD)])
        self.red([comment('ПРИНЯТ PR １６１ @' + HEAD)])

    def test_rejection_fails(self):
        self.red([comment('НЕ ПРИНЯТ PR 161 @' + HEAD)])

    def test_later_rejection_over_approval_fails_and_new_approval_reopens(self):
        approve = comment(OK, at='2026-11-05T09:00:00Z', cid=1)
        reject = comment('НЕ ПРИНЯТ PR 161 @' + HEAD, at='2026-11-05T09:30:00Z', cid=2)
        self.red([approve, reject])
        self.red([reject, approve])  # порядок ответа API не важен, важно время
        again = comment(OK, at='2026-11-05T10:00:00Z', cid=3)
        self.assertEqual(self.check([approve, reject, again])['admission'], 'review')
        # Оба вердикта в одном комментарии в любом порядке — отказ.
        self.red([comment('НЕ ПРИНЯТ\n' + OK)])
        self.red([comment(OK + '\n**НЕ** ПРИНЯТ PR 161 @' + HEAD)])
        self.red([comment(OK, cid=1), comment(OK + '\nНЕ ПРИНЯТ: тесты', at='2026-11-05T09:30:00Z', cid=2)])

    def test_unrelated_comments_and_exact_other_head_do_not_block(self):
        self.check([comment(OK, cid=1),
                    comment('Спасибо, смотрю CI', at='2026-11-05T09:30:00Z', cid=2),
                    comment('ПРИНЯТ PR 161 @' + OLD_HEAD, at='2026-11-05T09:40:00Z', cid=3),
                    comment('ПРИНЯТ PR 999 @' + HEAD, at='2026-11-05T09:50:00Z', cid=4)])

    def test_outsider_cannot_approve_or_block(self):
        for association in ('NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', None):
            with self.subTest(association=association):
                self.red([comment(OK, association=association)])
        self.check([comment(OK, association='OWNER', cid=1),
                    comment('НЕ ПРИНЯТ', at='2026-11-05T09:30:00Z', association='NONE', cid=2)])

    def test_regular_paths_pass_without_review_or_api(self):
        def no_api():
            raise AssertionError('обычные пути не читают комментарии')
        files = [{'filename': 'ops/tasks-mcp/server.js', 'status': 'modified'}]
        pr = {'number': 161, 'state': 'open', 'head': {'sha': HEAD}, 'changed_files': 1, 'labels': []}
        self.assertEqual(guard.evaluate(pr, files, HEAD, SOURCES, load_review=no_api)['admission'], 'labels')

    def test_remote_reads_all_comment_pages_without_client_dates(self):
        pr = {'number': 161, 'state': 'open', 'head': {'sha': HEAD}, 'base': {'sha': 'b' * 40},
              'changed_files': 1, 'labels': []}
        files = [{'filename': '.github/workflows/ci.yml', 'status': 'modified'}]
        page1 = [comment('просто текст', cid=i) for i in range(100)]
        page2 = [comment(OK, cid=200)]
        calls = []
        def fake_json(repo, endpoint):
            calls.append(endpoint)
            if endpoint.endswith('/files?per_page=100&page=1'):
                return files
            if '/comments' in endpoint:
                return page1 if endpoint.endswith('page=1') else page2
            return pr
        with patch.object(guard, 'fetch_json', side_effect=fake_json):
            result = guard.check_remote('owner/repo', 161, HEAD)
        self.assertEqual(result['admission'], 'review')
        self.assertIn('/issues/161/comments?per_page=100&page=2', calls)
        self.assertFalse([c for c in calls if c.startswith('/commits/')])

    def test_issue_comment_event_publishes_on_current_head(self):
        event = {'issue': {'number': 161, 'pull_request': {'url': 'x'}}, 'comment': {'body': 'ПРИНЯТ'}}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'event.json'
            path.write_text(json.dumps(event), encoding='utf-8')
            argv = ['guard', '--event', str(path), '--repo', 'owner/repo', '--publish-status']
            with patch('sys.argv', argv), patch.object(guard, 'publish_status') as status, \
                    patch.object(guard, 'fetch_json', return_value={'head': {'sha': HEAD}}), \
                    patch.object(guard, 'check_remote', return_value={'files': 1}) as remote:
                guard.main()
            remote.assert_called_once_with('owner/repo', 161, HEAD)
            self.assertEqual([c.args for c in status.call_args_list], [
                ('owner/repo', HEAD, 'pending'), ('owner/repo', HEAD, 'success')])
            path.write_text(json.dumps({'issue': {'number': 5}}), encoding='utf-8')
            with patch('sys.argv', argv), patch.object(guard, 'publish_status') as status:
                with self.assertRaises(ValueError):
                    guard.main()
                status.assert_not_called()

    def test_trusted_workflow_reruns_on_review_comments(self):
        workflow = (ROOT / '.github/workflows/protect-prod-sites.yml').read_text(encoding='utf-8')
        self.assertRegex(workflow, r'issue_comment:\s+types: \[created, edited, deleted\]')
        self.assertIn('issues: read', workflow)
        self.assertIn('ref: ${{ github.event.pull_request.base.sha || github.sha }}', workflow)
        self.assertNotIn('head.sha', workflow)


if __name__ == '__main__':
    unittest.main()
