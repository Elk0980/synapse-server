#!/usr/bin/env python3
"""Точечное переключение уже существующего Palitra preview и тестового prefix.

Только для согласованной серверной консоли. Никаких прав, сертификатов или API
общего приложения не меняет. Stage готовит BASE/candidate; validate выполняет
оператор штатным Caddy. Apply/revert отказывают при чужой новой версии.
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path

def sha(data):
    return hashlib.sha256(data).hexdigest()

def candidate(data, port):
    text = data.decode('utf-8')
    if '/_palitra_test/' in text or '@palitra_test_pair' in text:
        raise ValueError('Тестовый маршрут уже существует — требуется чтение текущего результата')
    pattern = r'(?m)^(?P<i>[ \t]+)handle @project_draft \{\r?\n(?P<j>[ \t]+)reverse_proxy content:8080\r?\n[ \t]+\}\r?\n'
    matches = list(re.finditer(pattern, text))
    if len(matches) != 1 or 'https:// {' not in text[:matches[0].start()]:
        raise ValueError('Не найден единственный ожидаемый обработчик черновиков')
    m = matches[0]
    i, j = m.group('i'), m.group('j')
    extra = (f'{i}@palitra_test_pair {{\n{j}host palitra-love-draft-1.synapsebusiness.ru\n'
             f'{j}path /_palitra_test/*\n{i}}}\n{i}handle @palitra_test_pair {{\n'
             f'{j}reverse_proxy 127.0.0.1:{port}\n{i}}}\n')
    inserted = text[:m.start()] + extra + text[m.start():]
    old = 'palitra-bot-preview.synapsebusiness.ru {\n  reverse_proxy 127.0.0.1:8799\n}'
    new = f'palitra-bot-preview.synapsebusiness.ru {{\n  reverse_proxy 127.0.0.1:{port}\n}}'
    if inserted.count(old) != 1:
        raise ValueError('Существующий preview изменён — требуется новый BASE')
    result = inserted.replace(old, new, 1)
    if result.replace(new, old, 1).replace(extra, '', 1) != text:
        raise ValueError('Изменения выходят за два точечных маршрута')
    return result.encode('utf-8')

def write_existing(path, data):
    # Сохраняем inode: Caddyfile уже bind-mounted в работающий контейнер.
    with path.open('r+b') as f:
        f.write(data)
        f.truncate()
        f.flush()
        os.fsync(f.fileno())

def main():
    p = argparse.ArgumentParser()
    p.add_argument('action', choices=['stage', 'apply', 'revert'])
    p.add_argument('--expected', required=True)
    p.add_argument('--port', type=int, default=8796)
    p.add_argument('--file', default='/opt/synapse/caddy/Caddyfile')
    p.add_argument('--state', default='/tmp/palitra-pair-20261011')
    a = p.parse_args()
    if not re.fullmatch('[a-f0-9]{64}', a.expected) or not 8790 <= a.port <= 8809:
        p.error('Не подходит контрольная сумма или порт')
    live, state = Path(a.file), Path(a.state)
    actual = live.read_bytes()
    if sha(actual) != a.expected:
        raise SystemExit('STOP: текущая конфигурация не совпадает с лично прочитанной версией')
    if a.action == 'stage':
        out = candidate(actual, a.port)
        state.mkdir(mode=0o700)
        (state / 'BASE').write_bytes(actual)
        (state / 'CANDIDATE').write_bytes(out)
        (state / 'meta.json').write_text(json.dumps({'base':sha(actual),'candidate':sha(out),'port':a.port}), encoding='utf-8')
        print(json.dumps({'base':sha(actual),'candidate':sha(out),'state':str(state)}, ensure_ascii=False))
        return
    meta = json.loads((state / 'meta.json').read_text(encoding='utf-8'))
    base, out = (state / 'BASE').read_bytes(), (state / 'CANDIDATE').read_bytes()
    if sha(base) != meta['base'] or sha(out) != meta['candidate'] or out != candidate(base, meta['port']):
        raise SystemExit('STOP: BASE/candidate изменён')
    expected = meta['base'] if a.action == 'apply' else meta['candidate']
    if sha(actual) != expected:
        raise SystemExit('STOP: чужая версия, автоматический откат/применение запрещены')
    chosen = out if a.action == 'apply' else base
    write_existing(live, chosen)
    if live.read_bytes() != chosen:
        raise SystemExit('STOP: readback не совпал')
    print(json.dumps({'action':a.action,'sha256':sha(chosen)}, ensure_ascii=False))

if __name__ == '__main__':
    main()
