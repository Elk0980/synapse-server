#!/usr/bin/env python3
"""Автовыпуск статики кабинета Synapse из публичного main.

Что делает один запуск (таймер — раз в 2 минуты):
1. `git fetch` публичного https-репозитория в отдельный каталог (без токенов).
2. Если main сдвинулся с последнего выложенного коммита (база), сравнивает файлы
   белого списка (sites/synapse/cabinet/**, sites/synapse/brand/**, кроме cabinet.html
   и тестов) между базой и новым main.
3. Трёхсторонняя защита: файл на боевом заменяется, только если он побайтно равен
   версии из базы (локально не изменён) или его нет ни на боевом, ни в базе.
   Иначе — пропуск с записью «локальная правка, не трогаю». Удаления не выполняются.
4. Перед заменой — копия прежних файлов; после — HTTP 200 и совпадение байтов на
   публичном адресе. Любая ошибка — автоматический откат из копии.

Не трогает: docker, compose, Caddy, ops/**, cabinet.html, ключи, legacy sync.
"""
import argparse, datetime, fcntl, hashlib, json, os, re, shutil, subprocess, sys, time, urllib.request

REPO_URL = 'https://github.com/Elk0980/synapse-server.git'
BRANCH = 'main'
LIVE_ROOT = '/opt/synapse'
WORK = '/opt/synapse-autosync'
STATE = '/var/lib/synapse-autosync/state.json'
BACKUPS = '/var/backups/synapse-autosync'
LOG = '/var/log/synapse-autosync.log'
LOCK = '/run/synapse-autosync.lock'
PUBLIC = 'https://synapse.synapsebusiness.ru'
ALLOW = re.compile(r'^sites/synapse/(cabinet|brand)/[A-Za-z0-9._/-]+$')
DENY = re.compile(r'(^sites/synapse/cabinet\.html$|\.test\.(c?js|mjs)$|(^|/)\.)')
MAX_FILE = 5 * 1024 * 1024
MAX_FILES = 200


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


class Ctx:
    def __init__(self, a):
        self.live, self.work, self.state, self.backups = a.live_root, a.work, a.state, a.backups
        self.log_path, self.public, self.repo_url = a.log, a.public, a.repo_url
        self.repo = os.path.join(self.work, 'repo')
        self.check_http = not a.no_http

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


def blob(ctx, commit, path):
    try:
        return ctx.git('show', f'{commit}:{path}', binary=True)
    except subprocess.CalledProcessError:
        return None


def read_live(ctx, path):
    full = os.path.join(ctx.live, path)
    if os.path.islink(full):
        raise RuntimeError(f'symlink на боевом: {path}')
    if not os.path.exists(full):
        return None
    with open(full, 'rb') as f:
        return f.read()


def load_state(ctx):
    try:
        with open(ctx.state, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_state(ctx, state):
    os.makedirs(os.path.dirname(ctx.state), exist_ok=True)
    tmp = ctx.state + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
    os.replace(tmp, ctx.state)


def ensure_repo(ctx):
    if not os.path.isdir(os.path.join(ctx.repo, '.git')) and not os.path.isfile(os.path.join(ctx.repo, 'HEAD')):
        os.makedirs(ctx.work, exist_ok=True)
        subprocess.run(['git', 'clone', '--quiet', '--bare', '--filter=blob:none', ctx.repo_url, ctx.repo],
                       check=True, capture_output=True)
    ctx.git('fetch', '--quiet', 'origin', f'+refs/heads/{BRANCH}:refs/heads/{BRANCH}')
    return ctx.git('rev-parse', BRANCH)


def write_atomic(full, data, mode):
    os.makedirs(os.path.dirname(full), mode=0o755, exist_ok=True)
    tmp = os.path.join(os.path.dirname(full), '.' + os.path.basename(full) + '.autosync-new')
    with open(tmp, 'wb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, full)


def http_ok(ctx, path, data):
    if not ctx.check_http:
        return True
    url = ctx.public + '/' + path[len('sites/synapse/'):] + f'?autosync={int(time.time())}'
    req = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'User-Agent': 'synapse-autosync'})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status == 200 and r.read() == data


def plan(ctx, base, head):
    names = ctx.git('diff', '--name-status', '--no-renames', base, head, '--', 'sites/synapse/cabinet', 'sites/synapse/brand')
    rows = []
    for line in filter(None, names.splitlines()):
        status, path = line.split('\t', 1)
        rows.append((status, path))
    return rows


def run_once(ctx, init=False):
    head = ensure_repo(ctx)
    state = load_state(ctx)
    base = state.get('commit')
    if init or not base:
        state.update(commit=head, time=now(), deployed=[], skipped=[], note='baseline')
        save_state(ctx, state)
        ctx.log(f'BASELINE commit={head}')
        return 0
    if base == head:
        return 0
    if state.get('lastError', {}).get('head') == head:
        return 1  # этот коммит уже откатывался; ждём следующего merge, не повторяем каждые 2 минуты
    if subprocess.run(['git', '-C', ctx.repo, 'merge-base', '--is-ancestor', base, head]).returncode != 0:
        ctx.log(f'STOP not-fast-forward base={base} head={head}')
        return 2
    rows = plan(ctx, base, head)
    actions, skipped = [], []
    for status, path in rows:
        if not allowed(path):
            skipped.append({'path': path, 'reason': 'вне белого списка'})
            continue
        if status == 'D':
            skipped.append({'path': path, 'reason': 'удалён в main, на боевом не удаляю'})
            continue
        new = blob(ctx, head, path)
        old = blob(ctx, base, path)
        live = read_live(ctx, path)
        if new is None or len(new) > MAX_FILE:
            skipped.append({'path': path, 'reason': 'нет файла или слишком большой'})
        elif live == new:
            continue
        elif live is None and old is None:
            actions.append((path, None, new))
        elif live is not None and live == old:
            actions.append((path, live, new))
        else:
            skipped.append({'path': path, 'reason': 'локальная правка, не трогаю'})
    if len(actions) > MAX_FILES:
        ctx.log(f'STOP too-many-files {len(actions)}')
        return 2
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    bdir = os.path.join(ctx.backups, f'{stamp}-{head[:8]}')
    done = []
    try:
        if actions:
            os.makedirs(bdir, exist_ok=True)
            manifest = {'base': base, 'head': head, 'files': []}
            for path, live, _ in actions:
                entry = {'path': path, 'existed': live is not None}
                if live is not None:
                    dst = os.path.join(bdir, 'files', path)
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    shutil.copy2(os.path.join(ctx.live, path), dst)
                    entry['sha256'] = hashlib.sha256(live).hexdigest()
                manifest['files'].append(entry)
            with open(os.path.join(bdir, 'manifest.json'), 'w', encoding='utf-8') as f:
                json.dump(manifest, f, ensure_ascii=False, indent=1)
        for path, live, new in actions:
            full = os.path.join(ctx.live, path)
            mode = os.stat(full).st_mode & 0o777 if live is not None else 0o644
            write_atomic(full, new, mode)
            done.append((path, live))
        for path, _, new in actions:
            if not http_ok(ctx, path, new):
                raise RuntimeError(f'health {path}')
        if actions and ctx.check_http and not http_ok_page(ctx):
            raise RuntimeError('health cabinet.html')
    except Exception as error:  # откат всего, что успели заменить
        for path, live in reversed(done):
            full = os.path.join(ctx.live, path)
            if live is None:
                os.unlink(full)
            else:
                write_atomic(full, live, os.stat(full).st_mode & 0o777)
        ctx.log(f'ROLLBACK head={head} reason={error} restored={len(done)} backup={bdir}')
        state.update(lastError={'head': head, 'time': now(), 'reason': str(error)})
        save_state(ctx, state)
        return 1
    state.update(commit=head, time=now(), deployed=[p for p, _, _ in actions], skipped=skipped,
                 backup=bdir if actions else None, note='ok')
    state.pop('lastError', None)
    save_state(ctx, state)
    ctx.log(f'DEPLOYED head={head} base={base} files={len(actions)} skipped={len(skipped)} backup={bdir if actions else "-"}')
    for item in skipped:
        ctx.log(f'SKIP {item["path"]}: {item["reason"]}')
    return 0


def http_ok_page(ctx):
    req = urllib.request.Request(ctx.public + '/cabinet.html', headers={'User-Agent': 'synapse-autosync'})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status == 200


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument('--init', action='store_true', help='принять текущий main базой без выкладки')
    p.add_argument('--live-root', default=LIVE_ROOT)
    p.add_argument('--work', default=WORK)
    p.add_argument('--state', default=STATE)
    p.add_argument('--backups', default=BACKUPS)
    p.add_argument('--log', default=LOG)
    p.add_argument('--public', default=PUBLIC)
    p.add_argument('--repo-url', default=REPO_URL)
    p.add_argument('--lock', default=LOCK)
    p.add_argument('--no-http', action='store_true')
    a = p.parse_args(argv)
    ctx = Ctx(a)
    with open(a.lock, 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        try:
            return run_once(ctx, a.init)
        except Exception as error:
            ctx.log(f'ERROR {type(error).__name__}: {error}')
            return 1


if __name__ == '__main__':
    sys.exit(main())
