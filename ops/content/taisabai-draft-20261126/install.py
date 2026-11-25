#!/usr/bin/env python3
"""ТайСабай · черновик сайта v4 → taisabai-draft-1.synapsebusiness.ru (задача №329).

Запуск на сервере synapse-core (root), из клона ветки claude/taisabai-site-20261126:
  python3 install.py inspect    # только чтение: черновики ТайСабай, исходник, план, размер пакета
  python3 install.py apply      # inspect → бэкап content.sqlite → черновик (клон, если его нет) → ревизия с сайтом → verify
  python3 install.py verify     # живые адреса: 200, noindex, robots, медиа 206; В2 не изменился
  python3 install.py rollback   # вернуть прежнюю ревизию (или скрыть черновик, если он создан этим выпуском)

Меняется ТОЛЬКО черновик ТайСабай в site_workspaces. taisabai.synapsebusiness.ru (В2), другие сайты,
Caddy, ключи и права не трогаются; ничего не удаляется.
"""
from pathlib import Path
import hashlib, json, subprocess, sys, time, urllib.request, urllib.error

HERE = Path(__file__).resolve().parent
PAYLOAD = HERE / 'payload'
RELEASE = HERE / 'release.cjs'
STATE = HERE / 'STATE.json'
REMOTE = '/tmp/taisabai-draft-20261126'
WANT_HOST = 'taisabai-draft-1.synapsebusiness.ru'
V2 = 'https://taisabai.synapsebusiness.ru/'


def run(*a, check=True):
    r = subprocess.run(a, text=True, capture_output=True)
    if check and r.returncode:
        sys.stderr.write(r.stdout + r.stderr)
        raise SystemExit(f'COMMAND_FAILED: {" ".join(a[:3])}')
    return r


def container():
    names = run('docker', 'ps', '--format', '{{.Names}}').stdout.split()
    hits = [n for n in names if n in ('synapse-content-1', 'synapse_content_1')] or [n for n in names if n.endswith('content-1')]
    if len(hits) != 1:
        raise SystemExit(f'CONTENT_CONTAINER_NOT_FOUND: {names}')
    return hits[0]


def push(c):
    """Копия пакета и скрипта в контейнер (только /tmp контейнера)."""
    if run('docker', 'exec', c, 'test', '-d', REMOTE + '/payload', check=False).returncode:
        run('docker', 'exec', c, 'mkdir', '-p', REMOTE)
        run('docker', 'cp', str(PAYLOAD), f'{c}:{REMOTE}/payload')
    run('docker', 'cp', str(RELEASE), f'{c}:{REMOTE}/release.cjs')


def node(c, mode):
    r = run('docker', 'exec', c, 'node', f'{REMOTE}/release.cjs', mode, f'{REMOTE}/payload', f'{REMOTE}/STATE.json', check=False)
    sys.stdout.write(r.stdout)
    if r.returncode:
        sys.stderr.write(r.stderr)
        raise SystemExit(f'RELEASE_{mode.upper()}_FAILED')
    if r.stderr.strip():
        sys.stderr.write(r.stderr)
    return json.loads(r.stdout)


def get(url, rng=None):
    req = urllib.request.Request(url, headers={'User-Agent': 'synapse-release-check', **({'Range': rng} if rng else {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, dict(resp.headers), resp.read(4096 if rng is None else 2048)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), b''


def v2_sha():
    status, _, _ = get(V2)
    with urllib.request.urlopen(V2, timeout=30) as resp:
        return status, hashlib.sha256(resp.read()).hexdigest()


def verify(host=None):
    host = host or (json.loads(STATE.read_text())['hostname'] if STATE.exists() else WANT_HOST)
    base = f'https://{host}/'
    checks = []
    def add(name, ok, detail): checks.append({'check': name, 'ok': bool(ok), 'detail': detail})
    s, h, body = get(base)
    add('index 200', s == 200, s)
    add('X-Robots-Tag noindex', 'noindex' in h.get('X-Robots-Tag', h.get('x-robots-tag', '')), h.get('X-Robots-Tag'))
    add('страница ТайСабай', 'ТайСабай' in body.decode('utf-8', 'ignore'), 'title')
    s, _, body = get(base + 'robots.txt'); add('robots Disallow', s == 200 and b'Disallow: /' in body, s)
    for path in ('flats.json', 'img/inna.jpg', 'img/GK-61-0.webp', 'v/hero.jpg', 'views/pool-p.jpg', 'r/final-01-depozit.jpg'):
        s, _, _ = get(base + path); add(path + ' 200', s == 200, s)
    for path in ('v/hero.mp4', 'v/GK-61.mp4', 'views/pool.mp4', 'r/final-01-depozit.mp4'):
        s, h, _ = get(base + path, 'bytes=0-1023')
        add(path + ' 206', s == 206 and 'video/mp4' in h.get('Content-Type', ''), f"{s} {h.get('Content-Range')}")
    s, sha = v2_sha()
    before = json.loads(STATE.read_text()).get('v2Sha') if STATE.exists() else None
    add('В2 taisabai.synapsebusiness.ru жив и не изменён', s == 200 and (before is None or before == sha), f'{s} {sha[:12]}')
    print(json.dumps({'url': base, 'checks': checks}, ensure_ascii=False, indent=2))
    if not all(c['ok'] for c in checks):
        raise SystemExit('VERIFY_FAILED')
    print('VERIFY_OK', base)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'inspect'
    if mode == 'verify':
        return verify()
    c = container()
    push(c)
    if mode == 'inspect':
        return node(c, 'inspect')
    if mode == 'apply':
        facts = node(c, 'inspect')
        if str(facts.get('plan', '')).startswith('STOP'):
            raise SystemExit('PRECHECK_STOP: ' + facts['plan'])
        _, v2 = v2_sha()
        result = node(c, 'apply')
        if result.get('unchanged'):
            print('UNCHANGED: этот пакет уже стоит на', result['hostname'])
            return verify(result['hostname'])
        run('docker', 'cp', f'{c}:{REMOTE}/STATE.json', str(STATE))
        state = json.loads(STATE.read_text()); state['v2Sha'] = v2
        STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2))
        time.sleep(2)
        return verify(result['hostname'])
    if mode == 'rollback':
        if not STATE.exists():
            raise SystemExit('NO_STATE_JSON')
        run('docker', 'cp', str(STATE), f'{c}:{REMOTE}/STATE.json')
        return node(c, 'rollback')
    raise SystemExit('MODE: inspect | apply | verify | rollback')


if __name__ == '__main__':
    main()
