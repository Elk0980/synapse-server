"""Read-only PR admission; never imports or executes PR contents."""
import argparse
import json
import os
import re
import urllib.request
from pathlib import PurePosixPath, Path

INFRA = 'сайты: инфраструктура'
WORKSHOP = {'synapse', 'chat', 'board', 'vhod'}
SHARED_JS = {'sites/synapse/track.js', 'sites/synapse/company-links.js'}
STATUS_CONTEXT = 'production-sites/path-approval'


def required_labels(paths):
    required = set()
    for path in paths:
        p = PurePosixPath(path)
        if not path or p.is_absolute() or '..' in p.parts or '\\' in path:
            raise ValueError('Некорректный путь')
        parts = p.parts
        if (path in SHARED_JS or parts[0] == 'caddy'
                or re.fullmatch(r'(docker-)?compose[^/]*\.ya?ml', path)
                or path.startswith('ops/synapse-sync')
                or path.startswith('tools/protect-prod-sites/')
                or path.startswith('.github/workflows/protect-prod-sites')
                or path == '.github/CODEOWNERS'):
            required.add(INFRA)
        elif parts[0] == 'sites':
            if len(parts) < 3:
                required.add(INFRA)
            elif parts[1] not in WORKSHOP:
                slug = '/'.join(parts[1:3]) if parts[1] == 'drafts' and len(parts) >= 4 else parts[1]
                required.add('сайт ' + slug)
    return required


def evaluate(pr, files, expected_sha):
    if pr.get('state') != 'open' or pr.get('head', {}).get('sha') != expected_sha:
        raise ValueError('PR закрыт или событие относится к прежнему SHA')
    count = pr.get('changed_files')
    if not isinstance(count, int) or count <= 0 or count > 3000 or len(files) != count:
        raise ValueError('Неполный список файлов PR; закрытый отказ')
    paths = set()
    filenames = set()
    for f in files:
        name = f['filename']
        if name in filenames:
            raise ValueError('Повтор файла в ответе API')
        filenames.add(name)
        paths.add(name)
        if f.get('status') == 'renamed':
            if not f.get('previous_filename'):
                raise ValueError('Неизвестен исходный путь переименования')
            paths.add(f['previous_filename'])
    required = required_labels(paths)
    actual = {label['name'] for label in pr.get('labels', [])}
    missing = required - actual
    if missing:
        raise ValueError('Отсутствуют метки: ' + ', '.join(sorted(missing)))
    return {'head': expected_sha, 'requiredLabels': sorted(required), 'files': count}


def fetch_json(repo, endpoint):
    request = urllib.request.Request(
        'https://api.github.com/repos/' + repo + endpoint,
        headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
                 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def check_remote(repo, number, expected_sha):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo) or not str(number).isdigit():
        raise ValueError('Некорректный репозиторий/PR')
    endpoint = '/pulls/' + str(number)
    pr = fetch_json(repo, endpoint)
    if not 0 < pr.get('changed_files', 0) <= 3000:
        raise ValueError('Размер PR неизвестен или превышает лимит API')
    files = []
    for page in range(1, (pr['changed_files'] + 99) // 100 + 1):
        files.extend(fetch_json(repo, endpoint + '/files?per_page=100&page=' + str(page)))
    # Detect changes while paging (including labels removed during the check).
    latest = fetch_json(repo, endpoint)
    def admission_state(value):
        # Repository metadata also changes on unrelated branch pushes.
        return (value.get('head', {}).get('sha'), value.get('base', {}).get('sha'),
                value.get('changed_files'), value.get('state'),
                sorted(label['name'] for label in value.get('labels', [])))
    if admission_state(latest) != admission_state(pr):
        raise ValueError('PR изменился во время проверки; повторите CI')
    return evaluate(latest, files, expected_sha)


def publish_status(repo, sha, state):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo) or not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('Некорректная цель статуса')
    payload = json.dumps({'state': state, 'context': STATUS_CONTEXT,
                          'description': 'Проверка путей и меток клиентских сайтов: ' + state}).encode()
    request = urllib.request.Request(
        'https://api.github.com/repos/' + repo + '/statuses/' + sha,
        data=payload, method='POST',
        headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
                 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json',
                 'X-GitHub-Api-Version': '2022-11-28'})
    with urllib.request.urlopen(request, timeout=30) as response:
        json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--event', required=True)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--publish-status', action='store_true')
    args = parser.parse_args()
    event = json.loads(Path(args.event).read_text(encoding='utf-8'))
    pr = event['pull_request']
    sha = pr['head']['sha']
    if args.publish_status:
        publish_status(args.repo, sha, 'pending')
    try:
        result = check_remote(args.repo, pr['number'], sha)
    except Exception:
        if args.publish_status:
            publish_status(args.repo, sha, 'failure')
        raise
    if args.publish_status:
        publish_status(args.repo, sha, 'success')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
