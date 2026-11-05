#!/usr/bin/env python3
"""Автовыпуск статики кабинета Synapse из публичного main.

Один запуск (таймер — раз в минуту):
1. `git fetch` публичного https-репозитория в собственный bare-клон (без токенов).
2. Новый коммит main выкладывается, только если проверки зелёные (GitHub без токена,
   только при новом коммите; ожидающий — не чаще раза в CI_RECHECK секунд):
   а) быстрый путь: коммит — слияние PR в main, его дерево равно дереву head PR, и все
      проверки head PR, начатые до слияния, завершены успешно (то же дерево уже проверено);
   б) иначе — все check-runs самого коммита main завершены успешно.
3. Сравниваются файлы белого списка (sites/synapse/cabinet/**, sites/synapse/brand/**,
   кроме cabinet.html, shell-version.json, тестов, скрытых файлов, симлинков и подмодулей)
   между последним выложенным коммитом (база) и новым main.
4. Трёхсторонняя защита: файл на боевом заменяется, только если он побайтно равен
   версии из базы (локально не изменён) или его нет ни на боевом, ни в базе.
   Иначе — пропуск «локальная правка, не трогаю». Удаления не выполняются.
5. Перед заменой — копия прежних файлов (хранятся 10 последних); после — HTTP 200 и
   совпадение байтов на публичном адресе. Любая ошибка — автоматический откат из копии.
6. После успешной выкладки пишет cabinet/shell-version.json {"commit": "<sha>"}.

Не трогает: docker, compose, Caddy, ops/**, cabinet.html, ключи, legacy sync.
"""
import argparse, datetime, fcntl, hashlib, json, os, re, shutil, subprocess, sys, time, urllib.request

REPO = 'Elk0980/synapse-server'
REPO_URL = f'https://github.com/{REPO}.git'
API = f'https://api.github.com/repos/{REPO}'
BRANCH = 'main'
LIVE_ROOT = '/opt/synapse'
STATE_DIR = '/var/lib/synapse-autosync'
BACKUPS = '/var/backups/synapse-autosync'
LOG = '/var/log/synapse-autosync/autosync.log'
LOCK = '/run/synapse-autosync/lock'
PUBLIC = 'https://synapse.synapsebusiness.ru'
ROOTS = ('sites/synapse/cabinet', 'sites/synapse/brand')
ALLOW = re.compile(r'^sites/synapse/(cabinet|brand)/[A-Za-z0-9._/-]+$')
DENY = re.compile(r'(^sites/synapse/cabinet\.html$|^sites/synapse/cabinet/shell-version\.json$'
                  r'|\.test\.(c?js|mjs)$|(^|/)\.)')
SHELL_VERSION = 'sites/synapse/cabinet/shell-version.json'
GOOD = {'success', 'neutral', 'skipped'}
CI_RECHECK = 120
KEEP_BACKUPS = 10
MAX_FILE = 5 * 1024 * 1024
MAX_FILES = 200


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


class Ctx:
    def __init__(self, a):
        self.live = os.path.realpath(a.live_root)
        self.state_path = os.path.join(a.state_dir, 'state.json')
        self.repo = os.path.join(a.state_dir, 'repo')
        self.state_dir, self.backups, self.log_path = a.state_dir, a.backups, a.log
        self.public, self.repo_url, self.api = a.public, a.repo_url, a.api
        self.check_http, self.check_ci = not a.no_http, not a.no_ci

    def log(self, msg):
        line = f'{now()} {msg}'
        print(line)
        os.makedirs(os.path.dirname(self.log_path), exist_ok=True)
        with open(self.log_path, 'a', encoding='utf-8') as f:
            f.write(line + '\n')

    def git(self, *args, binary=False):
        out = subprocess.run(['git', '-C', self.repo, *args], check=True, capture_output=True)
        return out.stdout if binary else out.stdout.decode().strip()


def allowed(path):
    return bool(ALLOW.match(path)) and not DENY.search(path) and '..' not in path.split('/')


def is_js(path):
    return path.lower().endswith(('.js', '.cjs', '.mjs'))


def tree_mode(ctx, commit, path):
    out = ctx.git('ls-tree', commit, '--', path)
    return out.split(' ', 1)[0] if out else None


def blob(ctx, commit, path):
    try:
        return ctx.git('show', f'{commit}:{path}', binary=True)
    except subprocess.CalledProcessError:
        return None


def live_path(ctx, path):
    """Абсолютный путь на боевом; отказ, если путь уходит из белого списка через симлинки."""
    full = os.path.normpath(os.path.join(ctx.live, path))
    roots = [os.path.normpath(os.path.join(ctx.live, r)) + os.sep for r in ROOTS]
    if not any(full.startswith(r) for r in roots):
        raise RuntimeError(f'путь вне белого списка: {path}')
    parent = os.path.dirname(full)
    probe = parent
    while not os.path.exists(probe):
        probe = os.path.dirname(probe)
    if os.path.realpath(probe) != probe or os.path.islink(full):
        raise RuntimeError(f'symlink на пути: {path}')
    return full


def read_live(ctx, path):
    full = live_path(ctx, path)
    if not os.path.exists(full):
        return None
    with open(full, 'rb') as f:
        return f.read()


def load_state(ctx):
    try:
        with open(ctx.state_path, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_state(ctx, state):
    os.makedirs(ctx.state_dir, exist_ok=True)
    tmp = ctx.state_path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
    os.replace(tmp, ctx.state_path)


def stop(ctx, state, message):
    """Записать STOP в журнал только при смене причины."""
    if state.get('stop') != message:
        ctx.log(f'STOP {message}')
        state['stop'] = message
        save_state(ctx, state)


def ensure_repo(ctx):
    if not os.path.isfile(os.path.join(ctx.repo, 'HEAD')):
        os.makedirs(ctx.state_dir, exist_ok=True)
        subprocess.run(['git', 'clone', '--quiet', '--bare', '--filter=blob:none', ctx.repo_url, ctx.repo],
                       check=True, capture_output=True)
    ctx.git('fetch', '--quiet', 'origin', f'+refs/heads/{BRANCH}:refs/heads/{BRANCH}')
    return ctx.git('rev-parse', BRANCH)


def ci_status(ctx, sha):
    """'ok' | 'pending' | 'fail:<имя>' по check-runs коммита (без токена)."""
    req = urllib.request.Request(f'{ctx.api}/commits/{sha}/check-runs?per_page=100',
                                 headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'synapse-autosync'})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.load(r)
    runs = data.get('check_runs', [])
    if not runs or data.get('total_count', 0) > len(runs):
        return 'pending'
    for run in runs:
        if run.get('status') != 'completed':
            return 'pending'
    for run in runs:
        if run.get('conclusion') not in GOOD:
            return f'fail:{run.get("name")}:{run.get("conclusion")}'
    return 'ok'


def api_json(ctx, path):
    req = urllib.request.Request(ctx.api + path,
                                 headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'synapse-autosync'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def fast_status(ctx, head):
    """Быстрый путь: 'ok' | 'pending' | 'no:<причина>'.

    Коммит main — слияние PR, дерево которого побайтно равно дереву head PR, значит
    pull_request-проверки head PR проверили ровно это содержимое. Учитываются прогоны,
    начатые до слияния (после закрытия охрана PR падает с «PR закрыт»); по каждому имени
    берётся последний такой прогон, и он должен быть завершён успешно.
    """
    pulls = api_json(ctx, f'/commits/{head}/pulls')
    pr = next((p for p in pulls if isinstance(p, dict) and p.get('merge_commit_sha') == head
               and p.get('merged_at') and (p.get('base') or {}).get('ref') == BRANCH), None)
    if pr is None:
        return 'no:pr'
    number, pr_head, merged = int(pr['number']), (pr.get('head') or {}).get('sha', ''), pr['merged_at']
    if not re.fullmatch(r'[0-9a-f]{40}', pr_head):
        return 'no:pr-head'
    ctx.git('fetch', '--quiet', 'origin', f'+refs/pull/{number}/head:refs/autosync/pr')
    if ctx.git('rev-parse', 'refs/autosync/pr') != pr_head:
        return 'no:pr-head-moved'
    if ctx.git('rev-parse', f'{head}^{{tree}}') != ctx.git('rev-parse', f'{pr_head}^{{tree}}'):
        return 'no:tree'
    data = api_json(ctx, f'/commits/{pr_head}/check-runs?per_page=100')
    runs = data.get('check_runs', [])
    if data.get('total_count', 0) > len(runs):
        return 'no:too-many-runs'
    latest = {}
    for run in runs:
        started = run.get('started_at') or ''
        if not started or started > merged:
            continue
        key = (started, run.get('id') or 0)
        name = run.get('name')
        if name not in latest or key >= latest[name][0]:
            latest[name] = (key, run)
    if not latest:
        return 'no:no-runs'
    if any(run.get('status') != 'completed' for _, run in latest.values()):
        return 'pending'
    for name, (_, run) in sorted(latest.items()):
        if run.get('conclusion') not in GOOD:
            return f'no:fail:{name}:{run.get("conclusion")}'
    return 'ok'


def ci_gate(ctx, state, head):
    if not ctx.check_ci:
        return True
    ci = state.get('ci') or {}
    if ci.get('sha') == head and ci.get('result') == 'ok':
        return True
    fast = state.get('fast') or {}
    if fast.get('sha') == head and fast.get('result') == 'ok':
        return True
    if fast.get('sha') != head or (fast.get('result') == 'pending'
                                   and time.time() - fast.get('checked', 0) >= CI_RECHECK):
        result = fast_status(ctx, head)
        state['fast'] = {'sha': head, 'result': result, 'checked': int(time.time())}
        save_state(ctx, state)
        if result == 'ok':
            ctx.log(f'CI fast-path head={head}: дерево равно проверенному head PR')
            return True
    if ci.get('sha') == head and (ci.get('result', '').startswith('fail')
                                  or time.time() - ci.get('checked', 0) < CI_RECHECK):
        stop(ctx, state, f'ci {ci.get("result")} head={head}')
        return False
    result = ci_status(ctx, head)
    state['ci'] = {'sha': head, 'result': result, 'checked': int(time.time())}
    save_state(ctx, state)
    if result != 'ok':
        stop(ctx, state, f'ci {result} head={head}')
        return False
    return True


def write_atomic(ctx, full, data, mode):
    roots = [os.path.normpath(os.path.join(ctx.live, r)) for r in ROOTS]
    root = next((r for r in roots if full.startswith(r + os.sep)), None)
    if root is None or not os.path.isdir(root):
        raise RuntimeError('public root должен быть подготовлен при установке')
    missing, parent = [], os.path.dirname(full)
    while not os.path.exists(parent):
        missing.append(parent)
        parent = os.path.dirname(parent)
    if parent != root and not parent.startswith(root + os.sep):
        raise RuntimeError('нет существующего публичного предка')
    for directory in reversed(missing):
        os.mkdir(directory, mode=0o2775)
        os.chmod(directory, 0o2775)  # Defeat UMask only for OUR new public dirs.
    tmp = os.path.join(os.path.dirname(full), '.' + os.path.basename(full) + '.autosync-new')
    with open(tmp, 'wb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, full)


def node_check(path, data):
    """Синтаксис JS: отсутствие обязательного checker — отказ, а не успех."""
    if not is_js(path):
        return True
    if not shutil.which('node'):
        return False
    import tempfile
    # Close the source before node opens it (NamedTemporaryFile locks on Windows).
    with tempfile.TemporaryDirectory(prefix='synapse-autosync-check-') as directory:
        filename = os.path.join(directory, 'asset' + os.path.splitext(path)[1].lower())
        with open(filename, 'wb') as f:
            f.write(data)
        try:
            return subprocess.run(['node', '--check', filename], capture_output=True, timeout=30).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            return False


def http_ok(ctx, path, data):
    if not ctx.check_http:
        return True
    url = ctx.public + '/' + path[len('sites/synapse/'):] + f'?autosync={int(time.time())}'
    req = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'User-Agent': 'synapse-autosync'})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status == 200 and r.read() == data


def http_ok_page(ctx):
    if not ctx.check_http:
        return True
    req = urllib.request.Request(ctx.public + '/cabinet.html', headers={'User-Agent': 'synapse-autosync'})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status == 200


def prune_backups(ctx):
    try:
        dirs = sorted(d for d in os.listdir(ctx.backups) if re.match(r'^\d{8}T\d{6}Z-[0-9a-f]{8}$', d))
    except FileNotFoundError:
        return
    for d in dirs[:-KEEP_BACKUPS]:
        shutil.rmtree(os.path.join(ctx.backups, d), ignore_errors=True)


def plan(ctx, base, head):
    names = ctx.git('diff', '--name-status', '--no-renames', base, head, '--', *ROOTS)
    return [tuple(line.split('\t', 1)) for line in names.splitlines() if line]


def run_once(ctx, init=False):
    head = ensure_repo(ctx)
    state = load_state(ctx)
    base = state.get('commit')
    if init or not base:
        state.update(commit=head, time=now(), deployed=[], skipped=[], note='baseline')
        state.pop('stop', None)
        save_state(ctx, state)
        ctx.log(f'BASELINE commit={head}')
        return 0
    if base == head:
        return 0
    if state.get('lastError', {}).get('head') == head:
        return 1  # коммит уже отклонён/откатывался; ждём следующего merge
    if subprocess.run(['git', '-C', ctx.repo, 'merge-base', '--is-ancestor', base, head]).returncode != 0:
        stop(ctx, state, f'not-fast-forward base={base} head={head}')
        return 2
    if not ci_gate(ctx, state, head):
        return 0
    actions, skipped, syntax_errors = [], [], []
    for status, path in plan(ctx, base, head):
        if not allowed(path):
            skipped.append({'path': path, 'reason': 'вне белого списка'})
            continue
        if status == 'D':
            skipped.append({'path': path, 'reason': 'удалён в main, на боевом не удаляю'})
            continue
        if tree_mode(ctx, head, path) not in ('100644', '100755'):
            skipped.append({'path': path, 'reason': 'симлинк или подмодуль'})
            continue
        # Inspect immutable Git metadata before reading an oversized new blob.
        if int(ctx.git('cat-file', '-s', f'{head}:{path}')) > MAX_FILE:
            if is_js(path):
                syntax_errors.append(path)
            else:
                skipped.append({'path': path, 'reason': 'слишком большой'})
            continue
        new, old = blob(ctx, head, path), blob(ctx, base, path)
        live = read_live(ctx, path)
        if new is None or len(new) > MAX_FILE:
            if is_js(path):
                syntax_errors.append(path)
            else:
                skipped.append({'path': path, 'reason': 'нет файла или слишком большой'})
        elif not node_check(path, new):
            syntax_errors.append(path)
        elif live == new:
            continue
        elif live is None and old is None:
            actions.append((path, None, new))
        elif live is not None and live == old:
            actions.append((path, live, new))
        else:
            skipped.append({'path': path, 'reason': 'локальная правка, не трогаю'})
    if syntax_errors:
        # Batch preflight: reject the HEAD before backups/asset/version writes.
        # Keep the deployed commit/metadata intact, remembering only the failure.
        reason = 'не пройдена проверка JS (синтаксис, node или лимит): ' + ', '.join(syntax_errors)
        state['lastError'] = {'head': head, 'time': now(), 'reason': reason}
        save_state(ctx, state)
        stop(ctx, state, f'js-preflight head={head} files={len(syntax_errors)}')
        return 1
    if len(actions) > MAX_FILES:
        stop(ctx, state, f'too-many-files {len(actions)} head={head}')
        return 2
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    bdir = os.path.join(ctx.backups, f'{stamp}-{head[:8]}')
    done = []
    try:
        if actions:
            os.makedirs(bdir, mode=0o700, exist_ok=True)
            manifest = {'base': base, 'head': head, 'files': []}
            for path, live, _ in actions + [(SHELL_VERSION, read_live(ctx, SHELL_VERSION), None)]:
                entry = {'path': path, 'existed': live is not None}
                if live is not None:
                    dst = os.path.join(bdir, 'files', path)
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    with open(dst, 'wb') as f:
                        f.write(live)
                    entry['sha256'] = hashlib.sha256(live).hexdigest()
                manifest['files'].append(entry)
            with open(os.path.join(bdir, 'manifest.json'), 'w', encoding='utf-8') as f:
                json.dump(manifest, f, ensure_ascii=False, indent=1)
        for path, live, new in actions:
            full = live_path(ctx, path)
            mode = os.stat(full).st_mode & 0o777 if live is not None else 0o644
            write_atomic(ctx, full, new, mode)
            done.append((path, live))
        for path, _, new in actions:
            if not http_ok(ctx, path, new):
                raise RuntimeError(f'health {path}')
        if actions and not http_ok_page(ctx):
            raise RuntimeError('health cabinet.html')
        if actions:
            previous = read_live(ctx, SHELL_VERSION)
            write_atomic(ctx, live_path(ctx, SHELL_VERSION), json.dumps({'commit': head}).encode() + b'\n', 0o644)
            done.append((SHELL_VERSION, previous))
    except Exception as error:  # откат всего, что успели заменить
        for path, live in reversed(done):
            full = live_path(ctx, path)
            if live is None:
                os.unlink(full)
            else:
                write_atomic(ctx, full, live, os.stat(full).st_mode & 0o777)
        ctx.log(f'ROLLBACK head={head} reason={error} restored={len(done)} backup={bdir}')
        state.update(lastError={'head': head, 'time': now(), 'reason': str(error)})
        save_state(ctx, state)
        return 1
    state.update(commit=head, time=now(), deployed=[p for p, _, _ in actions], skipped=skipped,
                 backup=bdir if actions else None, note='ok')
    state.pop('lastError', None)
    state.pop('stop', None)
    save_state(ctx, state)
    prune_backups(ctx)
    ctx.log(f'DEPLOYED head={head} base={base} files={len(actions)} skipped={len(skipped)} backup={bdir if actions else "-"}')
    for item in skipped:
        ctx.log(f'SKIP {item["path"]}: {item["reason"]}')
    return 0


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument('--init', action='store_true', help='принять текущий main базой без выкладки')
    p.add_argument('--live-root', default=LIVE_ROOT)
    p.add_argument('--state-dir', default=STATE_DIR)
    p.add_argument('--backups', default=BACKUPS)
    p.add_argument('--log', default=LOG)
    p.add_argument('--public', default=PUBLIC)
    p.add_argument('--repo-url', default=REPO_URL)
    p.add_argument('--api', default=API)
    p.add_argument('--lock', default=LOCK)
    p.add_argument('--no-http', action='store_true', help='только для тестов')
    p.add_argument('--no-ci', action='store_true', help='только для тестов')
    a = p.parse_args(argv)
    ctx = Ctx(a)
    os.makedirs(os.path.dirname(a.lock), exist_ok=True)
    with open(a.lock, 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        try:
            rc = run_once(ctx, a.init)
        except Exception as error:
            # Одинаковая ошибка (например, symlink на пути) пишется в журнал один раз.
            message = f'ERROR {type(error).__name__}: {error}'
            try:
                state = load_state(ctx)
                if state.get('error') == message:
                    return 1
                state['error'] = message
                save_state(ctx, state)
            except Exception:
                pass
            ctx.log(message)
            return 1
        state = load_state(ctx)
        if 'error' in state:
            state.pop('error')
            save_state(ctx, state)
            ctx.log('RECOVERED')
        return rc


if __name__ == '__main__':
    sys.exit(main())
