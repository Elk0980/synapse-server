"""Read-only PR admission; never imports or executes PR contents.

Решение Влада 05.11.2026 19:14: метка «сайты: инфраструктура» нужна только для чистовых
сайтов — папок, которые Caddy отдаёт на купленных доменах без «synapse» в имени, — и для
самой защиты (правила, Caddy, Compose, workflows, выкладка). Сайты на доменах с «synapse»,
ЛК, чаты и инструменты проходят без метки, с обычными проверками CI.
Список чистовых папок выводится из caddy/Caddyfile и docker-compose.yml базовой ветки.
"""
import argparse
import json
import os
import posixpath
import re
import urllib.request
from pathlib import PurePosixPath, Path

INFRA = 'сайты: инфраструктура'
STATUS_CONTEXT = 'production-sites/path-approval'
REPO_ROOT = Path(__file__).resolve().parents[2]
CADDYFILE = 'caddy/Caddyfile'
COMPOSE = 'docker-compose.yml'
# Домен с этой подстрокой — служебный адрес Synapse, а не купленный домен клиента.
WORKSHOP_DOMAIN_MARK = 'synapse'
# Сама защита и путь выкладки на боевой сервер: правка меняет правила или обходит их.
PROTECTION_PREFIXES = ('.github/', 'caddy/', 'tools/protect-prod-sites/',
                       'ops/release/', 'ops/autosync/', 'ops/synapse-sync')


def is_protection(path, parts):
    lower = parts[-1].lower()
    return (path.startswith(PROTECTION_PREFIXES) or parts[0] in {'.github', 'caddy'}
            or lower.startswith('caddyfile')
            or re.fullmatch(r'(docker-)?compose[^/]*\.ya?ml', lower) is not None)


# --- Caddyfile -> домены и папки ------------------------------------------------------------

def caddy_lines(text):
    """Caddyfile as token lines; quoted/backtick strings stay inside one token."""
    lines, tokens, token, i = [], [], None, 0
    while i < len(text):
        ch = text[i]
        if token is None and ch == '#':
            while i < len(text) and text[i] != '\n':
                i += 1
            continue
        if ch in '"`':
            end = i + 1
            while end < len(text) and text[end] != ch:
                end += 2 if ch == '"' and text[end] == '\\' else 1
            if end >= len(text):
                raise ValueError('Незакрытая кавычка в Caddyfile')
            token = (token or '') + text[i:end + 1]
            i = end + 1
            continue
        if ch.isspace():
            if token is not None:
                tokens.append(token)
                token = None
            if ch == '\n' and tokens:
                lines.append(tokens)
                tokens = []
            i += 1
            continue
        token = (token or '') + ch
        i += 1
    if token is not None:
        tokens.append(token)
    if tokens:
        lines.append(tokens)
    return lines


def caddy_tree(lines):
    """[(head tokens, children or None)]; only the `head {` ... `}` block form is accepted."""
    top = []
    stack = [top]
    for tokens in lines:
        if tokens == ['}']:
            if len(stack) == 1:
                raise ValueError('Лишняя } в Caddyfile')
            stack.pop()
            continue
        opens = tokens[-1] == '{'
        head = tokens[:-1] if opens else tokens
        if '{' in head or '}' in head:
            raise ValueError('Неподдерживаемая запись блока в Caddyfile: ' + ' '.join(tokens))
        node = (head, [] if opens else None)
        stack[-1].append(node)
        if opens:
            stack.append(node[1])
    if len(stack) != 1:
        raise ValueError('Незакрытый блок в Caddyfile')
    return top


def block_roots(body, snippets, seen=()):
    """Roots of a site block with its snippets; None = unknown (file import, no root)."""
    roots, serves = [], False
    for head, children in body:
        name = head[0] if head else ''
        if name == 'root':
            roots.append(head[-1] if len(head) > 1 else None)
        elif name == 'file_server':
            serves = True
        elif name == 'import':
            target = head[1] if len(head) > 1 else ''
            if target in seen:
                raise ValueError('Циклический import в Caddyfile: ' + target)
            if target in snippets:
                more, more_serves = block_roots(snippets[target], snippets, seen + (target,))
                roots.extend(more)
                serves = serves or more_serves
            else:
                roots.append(None)  # файл вне репозитория: содержимое неизвестно
        if children:
            more, more_serves = block_roots(children, snippets, seen)
            roots.extend(more)
            serves = serves or more_serves
    return roots, serves


def caddy_sites(text):
    snippets, sites = {}, []
    for head, body in caddy_tree(caddy_lines(text)):
        if body is None:
            raise ValueError('Директива верхнего уровня Caddyfile не поддерживается: ' + ' '.join(head))
        if not head:
            continue  # глобальные настройки
        if len(head) == 1 and re.fullmatch(r'\([^()\s]+\)', head[0]):
            snippets[head[0][1:-1]] = body
            continue
        hosts = [part for token in head for part in token.split(',') if part]
        sites.append((hosts, body))
    if not sites:
        raise ValueError('В Caddyfile не найдено ни одного сайта')
    return snippets, sites


def host_of(address):
    host = re.sub(r'^[a-z][a-z0-9+.-]*://', '', address.strip().lower()).split('/', 1)[0]
    return re.sub(r':\d*$', '', host)


def is_bought_domain(address):
    """«Чистовой» домен по правилу Влада: в имени нет synapse. Пустое/непонятное — чистовой."""
    host = host_of(address)
    return not host or WORKSHOP_DOMAIN_MARK not in host


def caddy_mounts(text):
    """Bind mounts of the caddy service in docker-compose.yml: container path -> repo dir."""
    mounts, in_services, in_caddy, in_volumes = {}, False, False, False
    for line in text.split('\n'):
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        indent = len(line) - len(line.lstrip())
        stripped = line.strip()
        if indent == 0:
            in_services, in_caddy, in_volumes = stripped == 'services:', False, False
            continue
        if not in_services:
            continue
        if indent == 2:
            in_caddy, in_volumes = stripped == 'caddy:', False
            continue
        if not in_caddy:
            continue
        if indent == 4:
            in_volumes = stripped == 'volumes:'
            continue
        if in_volumes:
            match = re.fullmatch(r'-\s*["\']?\./([^:"\'\s]*):(/[^:"\'\s]*)(?::[a-z,]+)?["\']?', stripped)
            if match:
                source = posixpath.normpath(match.group(1)) if match.group(1) else '.'
                mounts[posixpath.normpath(match.group(2))] = '' if source == '.' else source
    if not mounts:
        raise ValueError('Не найдены каталоги сервиса caddy в docker-compose.yml')
    return mounts


def repo_dir(root, mounts):
    if not isinstance(root, str) or '{' in root or not root.startswith('/'):
        raise ValueError('Корень сайта нельзя определить: ' + str(root))
    root = posixpath.normpath(root)
    for target in sorted(mounts, key=len, reverse=True):
        if root == target or root.startswith(target.rstrip('/') + '/'):
            rest = root[len(target):].strip('/')
            path = '/'.join(p for p in (mounts[target], rest) if p)
            if path == '..' or path.startswith('../'):
                break
            return path
    raise ValueError('Корень сайта вне каталогов репозитория: ' + root)


def site_layout(caddyfile_text, compose_text):
    """Clean (bought-domain) and workshop folders; raises when a clean site cannot be mapped."""
    mounts = caddy_mounts(compose_text)
    snippets, sites = caddy_sites(caddyfile_text)
    clean, served, table = set(), set(), []
    for hosts, body in sites:
        roots, serves = block_roots(body, snippets)
        bought = any(is_bought_domain(host) for host in hosts)
        if bought and serves and not roots:
            raise ValueError('Чистовой домен без root: ' + ', '.join(hosts))
        dirs = []
        for root in roots:
            try:
                dirs.append(repo_dir(root, mounts))
            except ValueError as error:
                if bought:
                    raise ValueError(', '.join(hosts) + ': ' + str(error))
        (clean if bought else served).update(dirs)
        for host in hosts:
            table.append({'domain': host, 'dirs': sorted(set(dirs)), 'clean': is_bought_domain(host)})
    return {'trees': {d for d in mounts.values() if d != 'caddy'}, 'clean': clean,
            'served': served, 'domains': table}


def load_layout(root=REPO_ROOT):
    return site_layout((root / CADDYFILE).read_text(encoding='utf-8'),
                       (root / COMPOSE).read_text(encoding='utf-8'))


def under(path, folder):
    return folder == '' or path == folder or path.startswith(folder + '/')


# --- Допуск PR ------------------------------------------------------------------------------

def protected_paths(paths, layout=None):
    """{path: reason} for every path that needs the owner's label (fail closed)."""
    for path in paths:
        p = PurePosixPath(path) if path else None
        if not path or p.is_absolute() or '..' in p.parts or '\\' in path:
            raise ValueError('Некорректный путь')
    if layout is None:
        try:
            layout = load_layout()
        except (OSError, ValueError) as error:
            layout = error
    found = {}
    for path in sorted(paths):
        if is_protection(path, PurePosixPath(path).parts):
            found[path] = 'защита или выкладка'
        elif isinstance(layout, Exception):
            found[path] = 'чистовые сайты не определены (' + str(layout) + ')'
        elif any(under(path, d) for d in layout['trees']):
            if any(under(path, d) for d in layout['clean']):
                found[path] = 'чистовой сайт'
            elif not any(under(path, d) for d in layout['served']):
                found[path] = 'папка без домена в Caddyfile'
    return found


def required_labels(paths, layout=None):
    return {INFRA} if protected_paths(paths, layout) else set()


def evaluate(pr, files, expected_sha, layout=None):
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
    found = protected_paths(paths, layout)
    required = {INFRA} if found else set()
    actual = {label['name'] for label in pr.get('labels', [])}
    missing = required - actual
    if missing:
        sample = '; '.join(path + ' — ' + reason for path, reason in list(found.items())[:5])
        raise ValueError('Отсутствуют метки: ' + ', '.join(sorted(missing)) + '. Файлы: ' + sample)
    return {'head': expected_sha, 'requiredLabels': sorted(required), 'files': count,
            'protectedFiles': len(found)}


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


def print_domains():
    layout = load_layout()
    print('| Домен | Папка | Чистовой |\n|---|---|---|')
    for row in layout['domains']:
        print('| %s | %s | %s |' % (row['domain'], ', '.join(row['dirs']) or '— (без папки)',
                                    'да' if row['clean'] else 'нет'))
    print('\nЧистовые папки (метка нужна): ' + ', '.join(sorted(layout['clean'])))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--event')
    parser.add_argument('--repo')
    parser.add_argument('--publish-status', action='store_true')
    parser.add_argument('--domains', action='store_true', help='таблица домен → папка → чистовой')
    args = parser.parse_args()
    if args.domains:
        print_domains()
        return
    if not args.event or not args.repo:
        parser.error('нужны --event и --repo')
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
