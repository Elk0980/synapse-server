"""Trusted-main content admission. Only GitHub metadata is read; PR code is never run."""
import argparse
import json
import os
from pathlib import PurePosixPath
import re
import urllib.error
import urllib.request

SHA = re.compile(r'^[0-9a-f]{40}$')
REPO = re.compile(r'^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')
PATH = re.compile(r'^[A-Za-z0-9._/-]+$')
MAX_FILES = 200
MAX_BYTES = 5 * 1024 * 1024
ACTIONS_APP = 15368
REQUIRED_CHECKS = {'guard-tests', 'process-check'}
REQUIRED_STATUS = 'production-sites/path-approval'
DENIED_NAMES = {'server.js', 'server.mjs', 'package.json', 'package-lock.json',
                'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'dockerfile',
                'caddyfile'}
DENIED_PARTS = {'node_modules', 'server', 'ops', 'tools', 'analytics-tests', 'tests', 'test'}


class Refused(ValueError):
    pass


def require(condition, reason):
    if not condition:
        raise Refused(reason)


def path_allowed(path, roots, extensions):
    if not isinstance(path, str) or not PATH.fullmatch(path):
        return False
    parts = PurePosixPath(path).parts
    if str(PurePosixPath(path)) != path or any(p.startswith('.') for p in parts):
        return False
    if any(p.lower() in DENIED_PARTS for p in parts):
        return False
    name = parts[-1].lower() if parts else ''
    if name in DENIED_NAMES or '.test.' in name or '.spec.' in name or '.server.' in name:
        return False
    if name.startswith(('vite.config.', 'webpack.config.', 'rollup.config.', 'next.config.', 'docker-compose', 'compose.')):
        return False
    return (any(path.startswith(root) for root in roots)
            and PurePosixPath(name).suffix in extensions)


def validate_pr(pr, repo):
    require(pr.get('state') == 'open' and not pr.get('draft'), 'not-ready')
    require(pr.get('base', {}).get('ref') == 'main', 'not-main')
    for side in ('head', 'base'):
        require(pr.get(side, {}).get('repo', {}).get('full_name') == repo, 'foreign-repository')
        require(SHA.fullmatch(pr.get(side, {}).get('sha', '')), 'invalid-sha')
    require(pr.get('author_association') in {'OWNER', 'MEMBER', 'COLLABORATOR'}, 'untrusted-author')
    require(pr.get('mergeable') is True and pr.get('mergeable_state') == 'clean', 'not-clean')
    require(type(pr.get('changed_files')) is int and 0 < pr['changed_files'] <= MAX_FILES, 'file-count')


def validate_files(pr, files, tree, roots, extensions):
    require(len(files) == pr['changed_files'], 'incomplete-files')
    require(tree.get('truncated') is False, 'truncated-tree')
    require(tree.get('sha') == pr['head'].get('tree_sha') or pr['head'].get('tree_sha') is None, 'tree-mismatch')
    entries = {e['path']: e for e in tree.get('tree', [])}
    seen = set()
    for item in files:
        path = item.get('filename')
        require(path not in seen, 'duplicate-file')
        seen.add(path)
        require(item.get('status') in {'added', 'modified'}, 'delete-rename-or-unknown')
        require(path_allowed(path, roots, extensions), 'outside-content-scope')
        entry = entries.get(path, {})
        require(entry.get('type') == 'blob' and entry.get('mode') == '100644', 'not-regular-file')
        require(type(entry.get('size')) is int and 0 <= entry['size'] <= MAX_BYTES, 'oversize')
        require(SHA.fullmatch(item.get('sha', '')) and entry.get('sha') == item['sha'], 'blob-mismatch')


def validate_checks(head, checks, statuses, history):
    require(checks.get('total_count') == len(checks.get('check_runs', [])), 'incomplete-checks')
    runs = checks.get('check_runs', [])
    require(REQUIRED_CHECKS.issubset({run.get('name') for run in runs}), 'required-check-missing')
    # GitHub's filter=latest supplies the current set. Do not collapse independent
    # suites/apps with the same job name, or prefer an old success to a queued run.
    for run in runs:
        require(run.get('head_sha') == head, 'wrong-check-head')
        name = run.get('name')
        require(run.get('status') == 'completed', 'check-pending')
        require(run.get('conclusion') in {'success', 'neutral', 'skipped'}, 'check-failed')
        if name in REQUIRED_CHECKS:
            require(run.get('conclusion') == 'success' and run.get('app', {}).get('id') == ACTIONS_APP,
                    'required-check-not-trusted')
    require(statuses.get('sha') == head, 'wrong-status-head')
    values = statuses.get('statuses', [])
    require(statuses.get('total_count') == len(values), 'incomplete-statuses')
    require(values and all(s.get('state') == 'success' for s in values), 'status-not-green')
    protected = [s for s in values if s.get('context') == REQUIRED_STATUS]
    require(len(protected) == 1, 'protection-status-missing')
    # Combined status deliberately omits creator. Read the authenticated history,
    # bind by immutable status ID, and refuse if it changed between the two reads.
    history_latest = {}
    for value in history:
        context = value.get('context')
        require(type(value.get('id')) is int, 'invalid-status-id')
        if context not in history_latest or value['id'] > history_latest[context]['id']:
            history_latest[context] = value
    require(set(history_latest) == {s.get('context') for s in values}, 'status-set-changed')
    for value in values:
        original = history_latest[value['context']]
        require(original['id'] == value.get('id') and original.get('state') == value.get('state'), 'status-changed')
    require(history_latest[REQUIRED_STATUS].get('creator', {}).get('login') == 'github-actions[bot]',
            'protection-status-untrusted')


def validate_reviews(reviews):
    latest = {}
    for review in reviews:
        if review.get('state') not in {'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'}:
            continue
        user = review.get('user', {}).get('id')
        require(type(user) is int, 'review-author-missing')
        key = (review.get('submitted_at') or '', review.get('id', 0))
        if user not in latest or key > latest[user][0]:
            latest[user] = (key, review['state'])
    require(all(state != 'CHANGES_REQUESTED' for _, state in latest.values()), 'changes-requested')


def signature(pr):
    return tuple(pr.get(k) for k in ('state', 'draft', 'changed_files', 'mergeable', 'mergeable_state')) + (
        pr.get('author_association'),
        *((pr.get(side, {}).get('sha'), pr.get(side, {}).get('ref'),
           pr.get(side, {}).get('repo', {}).get('full_name')) for side in ('head', 'base')),
        tuple(sorted(l.get('name', '') for l in pr.get('labels', []))),
    )


class GitHub:
    def __init__(self, repo, token):
        require(REPO.fullmatch(repo), 'invalid-repository')
        self.repo, self.token = repo, token

    def call(self, method, path, body=None):
        require(path.startswith('/') and not path.startswith('//'), 'invalid-api-path')
        request = urllib.request.Request(
            'https://api.github.com/repos/' + self.repo + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization': 'Bearer ' + self.token, 'Accept': 'application/vnd.github+json',
                     'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'synapse-site-content-merge'},
            method=method,
        )
        with urllib.request.urlopen(request, timeout=25) as response:
            return json.load(response)

    def pages(self, path, limit=300):
        result = []
        for page in range(1, limit // 100 + 2):
            values = self.call('GET', f'{path}{"&" if "?" in path else "?"}per_page=100&page={page}')
            require(isinstance(values, list), 'invalid-api-list')
            result.extend(values)
            require(len(result) <= limit, 'api-list-limit')
            if len(values) < 100:
                return result
        raise Refused('api-list-limit')


def consider(api, number, roots, extensions, apply=False):
    endpoint = f'/pulls/{number}'
    pr = api.call('GET', endpoint)
    validate_pr(pr, api.repo)
    head, base = pr['head']['sha'], pr['base']['sha']
    files = api.pages(endpoint + '/files', MAX_FILES)
    # Refuse privileged/out-of-scope PRs before the expensive tree/CI queries.
    require(all(path_allowed(f.get('filename'), roots, extensions) for f in files), 'outside-content-scope')
    commit = api.call('GET', f'/git/commits/{head}')
    require(commit.get('sha') == head and SHA.fullmatch(commit.get('tree', {}).get('sha', '')), 'invalid-head-commit')
    tree_sha = commit['tree']['sha']
    tree = api.call('GET', f'/git/trees/{tree_sha}?recursive=1')
    pr['head']['tree_sha'] = tree_sha
    validate_files(pr, files, tree, roots, extensions)
    compare = api.call('GET', f'/compare/{base}...{head}')
    require(compare.get('merge_base_commit', {}).get('sha') == base and compare.get('status') in {'ahead', 'identical'},
            'branch-needs-update')
    validate_reviews(api.pages(endpoint + '/reviews'))
    validate_checks(head, api.call('GET', f'/commits/{head}/check-runs?per_page=100&filter=latest'),
                    api.call('GET', f'/commits/{head}/status?per_page=100'),
                    api.pages(f'/commits/{head}/statuses'))
    latest = api.call('GET', endpoint)
    validate_pr(latest, api.repo)
    require(signature(pr) == signature(latest), 'pr-changed')
    main = api.call('GET', '/git/ref/heads/main')
    require(main.get('object', {}).get('sha') == base, 'main-changed')
    validate_reviews(api.pages(endpoint + '/reviews'))
    if not apply:
        return {'pr': number, 'head': head, 'eligible': True, 'merged': False}
    # Server-side expected-head CAS and existing main rules remain authoritative.
    result = api.call('PUT', endpoint + '/merge', {'sha': head, 'merge_method': 'squash'})
    require(result.get('merged') is True and SHA.fullmatch(result.get('sha', '')), 'merge-not-confirmed')
    return {'pr': number, 'head': head, 'eligible': True, 'merged': True, 'sha': result['sha']}


def candidates(api, event):
    if isinstance(event.get('pull_request'), dict):
        return [event['pull_request'].get('number') or event.get('number')]
    number = (event.get('inputs') or {}).get('pr_number')
    if number:
        require(str(number).isdigit(), 'invalid-pr-number')
        return [int(number)]
    linked = (event.get('workflow_run') or {}).get('pull_requests') or []
    if linked:
        return [p.get('number') for p in linked]
    return [p['number'] for p in api.pages('/pulls?state=open&base=main', 100)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    roots = json.loads(os.environ['SITE_MERGE_ROOTS'])
    extensions = set(json.loads(os.environ['SITE_MERGE_EXTENSIONS']))
    require(roots and all(isinstance(r, str) and r.startswith('sites/') and r.endswith('/') and '..' not in r for r in roots),
            'invalid-root-policy')
    api = GitHub(os.environ['SITE_MERGE_REPOSITORY'], os.environ['GH_TOKEN'])
    with open(os.environ['GITHUB_EVENT_PATH'], encoding='utf-8') as f:
        event = json.load(f)
    for number in candidates(api, event):
        try:
            require(type(number) is int and number > 0, 'invalid-pr-number')
            print(json.dumps(consider(api, number, roots, extensions, args.apply)), flush=True)
        except Refused as error:
            print(json.dumps({'pr': number, 'merged': False, 'reason': str(error)}), flush=True)
        except urllib.error.HTTPError as error:
            # Never echo API bodies, tokens or untrusted PR text.
            print(json.dumps({'pr': number, 'merged': False, 'http_error': error.code}), flush=True)


if __name__ == '__main__':
    main()
