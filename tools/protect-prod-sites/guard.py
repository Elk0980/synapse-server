"""Read-only PR admission; never imports or executes PR contents."""
import argparse
import json
import os
import re
import unicodedata
from datetime import datetime
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
    'ops/content/client-bot-config.js',  # заказы и боты клиентских сайтов (ревью 660)
}
CLIENT_SITE_PREFIXES = ('ops/content/seed/',)
# Выкладка на боевой сервер и создание ключей.
INFRA_PREFIXES = ('.github/', 'caddy/', 'ops/release/', 'ops/autosync/', 'ops/synapse-sync',
                  'tools/protect-prod-sites/')
SECRET_NAME = re.compile(r'secret|password|credential', re.IGNORECASE)
STATUS_CONTEXT = 'production-sites/path-approval'
# Публичные маршруты клиентских сайтов внутри общих server.js (ревью 647, 660): /api/price,
# /api/site, /api/company-links, /api/orders -> public-*, SITES, DOCUMENT_VALIDATORS,
# ORDER_SITES, validateSite/validatePrice; /leads, /events, checkPublicOrigin, companyDomains -> CRM.
# Блок маршрута ищется в версии файла на merge-base; правка внутри блока или строка с
# этими маркерами требует метку. Нет patch, нет исходника, переименование — тоже метка.
PUBLIC_ROUTES = {
    'ops/content/server.js': [
        re.compile(r"parts\[0\]\s*===\s*'public-"),
        # Какие сайты и документы (прайс, тексты) отдаются публично и как проверяются (ревью 660).
        re.compile(r'^const\s+(?:SITES|DOCUMENT_VALIDATORS|ORDER_SITES)\s*='),
        re.compile(r'^function\s+(?:validateSite|validatePrice)\b'),
    ],
    'ops/crm/server.js': [
        re.compile(r"request\.method\s*===\s*'POST'\s*&&\s*url\.pathname\s*===\s*'/(?:leads|events)'"),
        re.compile(r'\bconst\s+publicPost\b'),
        re.compile(r'\bfunction\s+checkPublicOrigin\b'),
        re.compile(r'\bfunction\s+companyDomains\b'),  # домены, с которых принимаются заявки (ревью 660)
    ],
}
PUBLIC_TOKENS = {
    'ops/content/server.js': re.compile(r"'public-|public-content|public-orders|public-company-links|\b(?:SITES|DOCUMENT_VALIDATORS|ORDER_SITES)\b"),
    'ops/crm/server.js': re.compile(r"'/leads'|'/events'|\bpublicPost\b|\bcheckPublicOrigin\b|\bcompanyDomains\b"),
}
HUNK = re.compile(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@')
# Независимое ревью вместо метки Влада (поручение 05.11 15:37, задача №163, ревью 923):
# «отказ ищется везде, одобрение — строго» (ревью 923, 934). Одобрение: первая строка исходного
# текста комментария участника репозитория целиком «ПРИНЯТ PR <номер> @<полный sha>» на текущий
# head и ни одного признака отказа в комментарии. Полный 40-символьный sha нельзя подобрать и
# нельзя знать до push, поэтому дата коммита (её задаёт клиент) не нужна. Отказ: «не принят» /
# «непринят» где угодно в нормализованном тексте (NFKC, без невидимых символов и разметки,
# латинские двойники -> кириллица) или иной неоднозначный вердикт со словом «принят» в первой
# строке. Более поздний отказ закрывает проверку независимо от sha; новый коммит — новый «ПРИНЯТ».
APPROVAL = re.compile(r'ПРИНЯТ PR ([0-9]+) `?@?`?([0-9a-f]{40})`?')
REJECTION = re.compile(r'(?:^| )не ?принят')
VERDICT_WORD = re.compile(r'(?:^| )принят(?: |$)')
LOOKALIKES = str.maketrans('HEPATOMKCXaeopcx', 'НЕРАТОМКСХаеорсх')
TRUSTED_ASSOCIATIONS = {'OWNER', 'MEMBER', 'COLLABORATOR'}
MAX_COMMENT_PAGES = 30


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


def parse_time(value):
    if not isinstance(value, str) or not value:
        raise ValueError('Нет времени комментария; закрытый отказ')
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def normalized(text):
    """Text for verdict search: invisible chars, markup, lookalikes, case and punctuation removed."""
    text = unicodedata.normalize('NFKC', text)
    # Невидимые символы (soft hyphen U+00AD, zero-width U+200B–U+200F, U+2060, BOM — категория Cf)
    # и разметка удаляются, а не заменяются пробелом: «ПРИ\u00adНЯТ», «**НЕ**ПРИНЯТ».
    text = ''.join(ch for ch in text if unicodedata.category(ch) != 'Cf' and ch not in '*_~`#')
    text = text.translate(LOOKALIKES).lower().replace('ё', 'е')
    return re.sub(r'[^0-9a-zа-я]+', ' ', text).strip()


def comment_verdict(body, number, head_sha):
    """'reject' for any rejection or ambiguous verdict, 'approve' for the exact template, else None."""
    if not isinstance(body, str):
        return None
    if REJECTION.search(normalized(body)):
        return 'reject'  # отказ ищется во всём комментарии, в том числе рядом с одобрением
    first = body.split('\n', 1)[0].rstrip('\r \t')
    match = APPROVAL.fullmatch(first)
    if match:
        if int(match.group(1)) != int(number) or match.group(2) != head_sha:
            return None  # точное одобрение другого PR/head — не вердикт этому head
        return 'approve'
    if VERDICT_WORD.search(normalized(first)):
        return 'reject'  # неоднозначный вердикт первой строкой — закрытый отказ
    return None


def review_approval(number, head_sha, comments):
    """Approval comment for the exact current head, or ValueError."""
    if not isinstance(head_sha, str) or not re.fullmatch(r'[0-9a-f]{40}', head_sha):
        raise ValueError('Неизвестен head sha для ревью')
    verdicts = []
    for comment in comments:
        if comment.get('author_association') not in TRUSTED_ASSOCIATIONS:
            continue  # публичный репозиторий: посторонний не принимает и не блокирует
        kind = comment_verdict(comment.get('body'), number, head_sha)
        if kind is None:
            continue
        verdicts.append((parse_time(comment.get('created_at')), comment.get('id') or 0, kind, comment))
    if not verdicts:
        raise ValueError('Нет метки и нет комментария первой строкой «ПРИНЯТ PR <номер> @<полный sha>»'
                         ' на текущий head')
    created, _, kind, comment = max(verdicts, key=lambda item: (item[0], item[1]))
    if kind != 'approve':
        raise ValueError('Последний вердикт ревью — «НЕ ПРИНЯТ» или неоднозначный; нужен новый'
                         ' «ПРИНЯТ PR <номер> @<полный sha>»')
    return {'by': (comment.get('user') or {}).get('login', ''), 'at': comment.get('created_at'),
            'comment': comment.get('html_url', '')}


def evaluate(pr, files, expected_sha, base_sources=None, load_review=None):
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
    result = {'head': expected_sha, 'requiredLabels': sorted(required), 'files': count,
              'admission': 'labels'}
    if missing:
        if load_review is None:
            raise ValueError('Отсутствуют метки: ' + ', '.join(sorted(missing)))
        try:
            result['review'] = review_approval(pr.get('number'), expected_sha, load_review())
        except ValueError as error:
            raise ValueError('Отсутствуют метки: ' + ', '.join(sorted(missing)) + '; ' + str(error))
        result['admission'] = 'review'
    return result


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


def fetch_review(repo, number):
    """All PR conversation comments (read-only API)."""
    comments = []
    for page in range(1, MAX_COMMENT_PAGES + 1):
        chunk = fetch_json(repo, '/issues/' + str(number) + '/comments?per_page=100&page=' + str(page))
        if not isinstance(chunk, list):
            raise ValueError('Некорректный ответ API комментариев')
        comments.extend(chunk)
        if len(chunk) < 100:
            break
    else:
        raise ValueError('Слишком много комментариев PR; закрытый отказ')
    return comments


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
    return evaluate(latest, files, expected_sha, sources,
                    load_review=lambda: fetch_review(repo, number))


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
    if 'pull_request' in event:
        number = event['pull_request']['number']
        sha = event['pull_request']['head']['sha']
    else:
        # issue_comment: ревью-комментарий перезапускает проверку; статус — на текущий head.
        issue = event.get('issue') or {}
        if not issue.get('pull_request') or not str(issue.get('number', '')).isdigit():
            raise ValueError('Событие не относится к PR')
        number = issue['number']
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repo):
            raise ValueError('Некорректный репозиторий/PR')
        sha = fetch_json(args.repo, '/pulls/' + str(number)).get('head', {}).get('sha')
        if not isinstance(sha, str) or not re.fullmatch(r'[0-9a-f]{40}', sha):
            raise ValueError('Неизвестен head sha PR')
    if args.publish_status:
        publish_status(args.repo, sha, 'pending')
    try:
        result = check_remote(args.repo, number, sha)
    except Exception:
        if args.publish_status:
            publish_status(args.repo, sha, 'failure')
        raise
    if args.publish_status:
        publish_status(args.repo, sha, 'success')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
