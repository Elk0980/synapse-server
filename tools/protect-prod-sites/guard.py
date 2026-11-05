"""Read-only PR admission; never imports or executes PR contents."""
import argparse
import json
import os
import re
import urllib.parse
import urllib.request
from pathlib import PurePosixPath, Path

INFRA = 'сайты: инфраструктура'
WORKSHOP = {'synapse', 'chat', 'board', 'vhod'}
# Файлы кабинета, которые загружают сами клиентские сайты.
SHARED_JS = {'sites/synapse/track.js', 'sites/synapse/company-links.js'}
# Код мастерской (ops/crm, ops/content) метку не требует, кроме модулей, которые отдают
# клиентским сайтам цены, тексты, ссылки и заказы (ревью 224 п.3, решение Влада по №114).
# Публичные обработчики внутри общих server.js проверяются по строкам diff (PUBLIC_ROUTES).
CLIENT_SITE_SOURCES = {
    'ops/content/site-store.js', 'ops/content/site-orders.js',
    'ops/content/company-links-reader.js', 'ops/content/tag_site.py',
    'ops/content/tag_avokado.py', 'ops/crm/company-links.js',
}
CLIENT_SITE_PREFIXES = ('ops/content/seed/',)
# Выкладка на боевой сервер и создание ключей.
INFRA_PREFIXES = ('.github/', 'caddy/', 'ops/release/', 'ops/autosync/', 'ops/synapse-sync',
                  'tools/protect-prod-sites/')
SECRET_NAME = re.compile(r'secret|password|credential', re.IGNORECASE)
STATUS_CONTEXT = 'production-sites/path-approval'
# Публичные маршруты клиентских сайтов внутри общих server.js (ревью 647): /api/price,
# /api/site, /api/company-links, /api/orders -> public-*; /leads, /events -> CRM.
# Блок маршрута ищется в версии файла на merge-base; правка внутри блока или строка с
# этими маркерами требует метку. Нет patch, нет исходника, переименование — тоже метка.
PUBLIC_ROUTES = {
    'ops/content/server.js': [re.compile(r"parts\[0\]\s*===\s*'public-")],
    'ops/crm/server.js': [
        re.compile(r"request\.method\s*===\s*'POST'\s*&&\s*url\.pathname\s*===\s*'/(?:leads|events)'"),
        re.compile(r'\bconst\s+publicPost\b'),
        re.compile(r'\bfunction\s+checkPublicOrigin\b'),
    ],
}
PUBLIC_TOKENS = {
    'ops/content/server.js': re.compile(r"'public-|public-content|public-orders|public-company-links"),
    'ops/crm/server.js': re.compile(r"'/leads'|'/events'|\bpublicPost\b|\bcheckPublicOrigin\b"),
}
HUNK = re.compile(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@')


def protected_blocks(path, source):
    """Line ranges (1-based, inclusive) of public route handlers in the base file."""
    lines = source.split('\n')
    blocks = []
    for index, line in enumerate(lines):
        if not any(pattern.search(line) for pattern in PUBLIC_ROUTES[path]):
            continue
        start = index + 1
        if not line.rstrip().endswith('{'):
            blocks.append((start, start))
            continue
        indent = len(line) - len(line.lstrip())
        end = None
        for later in range(index + 1, len(lines)):
            text = lines[later]
            if text.strip().startswith('}') and len(text) - len(text.lstrip()) == indent:
                end = later + 1
                break
        if end is None:
            raise ValueError('Не найден конец публичного маршрута в ' + path)
        blocks.append((start, end))
    if not blocks:
        raise ValueError('Публичные маршруты не найдены в ' + path + '; закрытый отказ')
    return blocks


def touches_public_route(path, patch, source):
    """True when the diff changes a public client-site handler (fail closed on doubt)."""
    if not isinstance(patch, str) or not patch or not isinstance(source, str):
        return True
    blocks = protected_blocks(path, source)
    inside = lambda line: any(start <= line <= end for start, end in blocks)
    strictly_inside = lambda line: any(start < line <= end for start, end in blocks)
    old = None
    for line in patch.split('\n'):
        header = HUNK.match(line)
        if header:
            old = int(header.group(1))
            if header.group(2) == '0':
                old += 1  # pure insertion after line N
            continue
        if old is None:
            return True
        if line.startswith('\\'):
            continue
        marker, text = line[:1], line[1:]
        if marker in '+-' and PUBLIC_TOKENS[path].search(text):
            return True
        if marker == '-':
            if inside(old):
                return True
            old += 1
        elif marker == '+':
            if strictly_inside(old):
                return True
        else:
            old += 1
    return False


def is_infrastructure(path, parts):
    name = parts[-1]
    lower = name.lower()
    return (path in SHARED_JS or path in CLIENT_SITE_SOURCES
            or path.startswith(CLIENT_SITE_PREFIXES) or path.startswith(INFRA_PREFIXES)
            or parts[0] in {'.github', 'caddy'}
            or lower.startswith(('caddyfile', 'dockerfile')) or lower.endswith('.dockerfile')
            or re.fullmatch(r'(docker-)?compose[^/]*\.ya?ml', lower) is not None
            or name.startswith('.env')
            or (parts[0] == 'ops' and SECRET_NAME.search(name) is not None))


def required_labels(paths):
    required = set()
    for path in paths:
        p = PurePosixPath(path)
        if not path or p.is_absolute() or '..' in p.parts or '\\' in path:
            raise ValueError('Некорректный путь')
        parts = p.parts
        if is_infrastructure(path, parts):
            required.add(INFRA)
        elif parts[0] == 'sites':
            if len(parts) < 3:
                required.add(INFRA)
            elif parts[1] not in WORKSHOP:
                slug = '/'.join(parts[1:3]) if parts[1] == 'drafts' and len(parts) >= 4 else parts[1]
                required.add('сайт ' + slug)
    return required


def evaluate(pr, files, expected_sha, base_sources=None):
    if pr.get('state') != 'open' or pr.get('head', {}).get('sha') != expected_sha:
        raise ValueError('PR закрыт или событие относится к прежнему SHA')
    count = pr.get('changed_files')
    if not isinstance(count, int) or count <= 0 or count > 3000 or len(files) != count:
        raise ValueError('Неполный список файлов PR; закрытый отказ')
    paths = set()
    filenames = set()
    route_change = False
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
        for path in {name, f.get('previous_filename')} & set(PUBLIC_ROUTES):
            if (f.get('status') != 'modified' or f.get('previous_filename')
                    or touches_public_route(path, f.get('patch'), (base_sources or {}).get(path))):
                route_change = True
    required = required_labels(paths)
    if route_change:
        required.add(INFRA)
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


def fetch_text(repo, endpoint):
    request = urllib.request.Request(
        'https://api.github.com/repos/' + repo + endpoint,
        headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
                 'Accept': 'application/vnd.github.raw', 'X-GitHub-Api-Version': '2022-11-28'})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode('utf-8')


def merge_base_sources(repo, pr, files):
    """Base versions of shared server files at the merge-base the API patch is computed from."""
    wanted = sorted({name for f in files for name in (f['filename'], f.get('previous_filename'))
                     if name in PUBLIC_ROUTES})
    if not wanted:
        return {}
    base, head = pr.get('base', {}).get('sha'), pr.get('head', {}).get('sha')
    if not all(isinstance(v, str) and re.fullmatch(r'[0-9a-f]{40}', v) for v in (base, head)):
        return {}
    merge_base = fetch_json(repo, '/compare/' + base + '...' + head).get('merge_base_commit', {}).get('sha')
    if not isinstance(merge_base, str) or not re.fullmatch(r'[0-9a-f]{40}', merge_base):
        return {}
    sources = {}
    for path in wanted:
        try:
            sources[path] = fetch_text(repo, '/contents/' + urllib.parse.quote(path) + '?ref=' + merge_base)
        except Exception:
            pass  # missing source -> touches_public_route fails closed
    return sources


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
    sources = merge_base_sources(repo, pr, files)
    # Detect changes while paging (including labels removed during the check).
    latest = fetch_json(repo, endpoint)
    def admission_state(value):
        # Repository metadata also changes on unrelated branch pushes.
        return (value.get('head', {}).get('sha'), value.get('base', {}).get('sha'),
                value.get('changed_files'), value.get('state'),
                sorted(label['name'] for label in value.get('labels', [])))
    if admission_state(latest) != admission_state(pr):
        raise ValueError('PR изменился во время проверки; повторите CI')
    return evaluate(latest, files, expected_sha, sources)


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
