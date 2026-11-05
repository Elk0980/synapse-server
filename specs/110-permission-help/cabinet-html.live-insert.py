#!/usr/bin/env python3
"""Точечная вставка PR 523 в живой sites/synapse/cabinet.html (для выпуска).

Меняет ровно две вещи и ничего больше:
1) в списке cabinetAssets вставляет "permission-help" перед "account"
   (якорь `"site-orders", "account"` — ровно одно вхождение в строке cabinetAssets);
2) строку версии ресурсов `window.SB_CABINET_ASSET_VERSION = "...";` (ровно одна)
   заменяет на версию с суффиксом -permission-help-110.

Любое отклонение (нет якоря, якорь не один, permission-help уже есть) — отказ без записи.
Запуск: python3 cabinet-html.live-insert.py <путь к cabinet.html> [--write]
Без --write — только проверка и вывод diff.
"""
import difflib
import re
import sys

ANCHOR = '"site-orders", "account"'
VERSION = re.compile(r'(  window\.SB_CABINET_ASSET_VERSION = ")([0-9]{8}-[\w-]+)(";)')


def transform(text):
    lines = text.split('\n')
    asset_lines = [i for i, line in enumerate(lines) if ANCHOR in line]
    # cabinetAssets — двухстрочный массив; якорь во второй строке.
    if len(asset_lines) != 1 or lines[asset_lines[0]].count(ANCHOR) != 1:
        raise SystemExit('ОТКАЗ: якорь "site-orders", "account" не найден ровно один раз')
    if '"permission-help"' in text:
        raise SystemExit('ОТКАЗ: "permission-help" уже подключён — вставка не нужна')
    start = max(i for i in range(asset_lines[0] + 1) if 'const cabinetAssets = [' in lines[i])
    if asset_lines[0] - start > 1:
        raise SystemExit('ОТКАЗ: якорь не в списке cabinetAssets')
    i = asset_lines[0]
    lines[i] = lines[i].replace(ANCHOR, '"site-orders", "permission-help", "account"')
    versions = [n for n, line in enumerate(lines) if VERSION.fullmatch(line)]
    if len(versions) != 1:
        raise SystemExit('ОТКАЗ: строка SB_CABINET_ASSET_VERSION не найдена ровно один раз')
    v = versions[0]
    current = VERSION.fullmatch(lines[v]).group(2)
    if current.endswith('-permission-help-110'):
        raise SystemExit('ОТКАЗ: версия уже содержит -permission-help-110')
    lines[v] = VERSION.sub(lambda m: m.group(1) + current + '-permission-help-110' + m.group(3), lines[v])
    return '\n'.join(lines)


def main():
    if len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != '--write'):
        raise SystemExit(__doc__)
    path = sys.argv[1]
    with open(path, encoding='utf-8', newline='') as handle:
        before = handle.read()
    after = transform(before)
    diff = list(difflib.unified_diff(before.split('\n'), after.split('\n'),
                                     'a/sites/synapse/cabinet.html', 'b/sites/synapse/cabinet.html', lineterm=''))
    changed = [line for line in diff if line[:1] in '+-' and not line.startswith(('+++', '---'))]
    if len(changed) != 4:
        raise SystemExit('ОТКАЗ: ожидалось ровно 2 изменённые строки, получено ' + str(len(changed) // 2))
    print('\n'.join(diff))
    if len(sys.argv) == 3:
        with open(path, 'w', encoding='utf-8', newline='') as handle:
            handle.write(after)
        print('ЗАПИСАНО: ' + path)


if __name__ == '__main__':
    main()
