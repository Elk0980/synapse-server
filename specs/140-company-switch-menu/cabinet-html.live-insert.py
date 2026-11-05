#!/usr/bin/env python3
"""Точечная вставка PR №140 в живой sites/synapse/cabinet.html (для выпуска).

Меняет ровно шесть мест и ничего больше:
1) нижняя панель телефона: кнопка #mobile-content «Контент» -> «Контент завод» (и её aria-label);
2) левое меню: кнопка #content-category «Контент» -> «Контент завод» (и комментарий над ней);
3) удаляет разметку плашки <div class="workspace-scope" ...>«Сменить компанию»</div>;
4) renderScopeBanner: убирает заполнение плашки, оставляет только заголовок вкладки браузера;
5) удаляет обработчик кнопки «Сменить компанию» (#workspace-change-company);
6) строку версии ресурсов `window.SB_CABINET_ASSET_VERSION = "...";` дополняет суффиксом -menu-140.

Каждый якорь — точный многострочный фрагмент, который должен встретиться ровно один раз.
Любое отклонение (нет якоря, якорь не один, вставка уже сделана) — отказ без записи.
Запуск: python3 cabinet-html.live-insert.py <путь к cabinet.html> [--write]
Без --write — только проверка и вывод diff.
"""
import difflib
import re
import sys

EDITS = [
    ('нижняя панель «Контент»',
     '<button type="button" id="mobile-content" data-open-category="content-menu" aria-label="Открыть разделы контента">Контент</button>',
     '<button type="button" id="mobile-content" data-open-category="content-menu" aria-label="Открыть разделы Контент завода">Контент завод</button>'),
    ('левое меню «Контент»',
     '      <!-- №98: меню «Контент» и «Настройки»; оболочка ставит «Контент» после «Главной», а «Хью» превращает в «Чаты». -->\n'
     '      <button class="nav-category" id="content-category" type="button" aria-expanded="false" aria-controls="content-menu" hidden>Контент</button>',
     '      <!-- №98: меню «Контент завод» (№140: было «Контент») и «Настройки»; оболочка ставит его после «Главной», а «Хью» превращает в «Чаты». -->\n'
     '      <button class="nav-category" id="content-category" type="button" aria-expanded="false" aria-controls="content-menu" hidden>Контент завод</button>'),
    ('разметка плашки',
     '    <div class="workspace-scope" id="workspace-scope"><strong></strong><button type="button" id="workspace-change-company">Сменить компанию</button></div>\n',
     '    <!-- №140: плашки «Компания: … / Сменить компанию» нет — компания меняется только в блоке «Проект» левого меню. -->\n'),
    ('renderScopeBanner',
     "  const renderScopeBanner = () => {\n"
     "    const el=byId('workspace-scope');\n"
     "    el.dataset.scope=SYSTEM_VIEWS.has(currentView)?'system':currentView==='account'?'personal':'company';\n"
     "    const ownerBoard = currentView === 'tasks' && identity?.role === 'owner';\n"
     "    const caption=ownerBoard?'Все проекты · Synapse Задачи':currentView==='trademarks'?'Общая справочная инструкция Synapse'\n"
     "      : SYSTEM_VIEWS.has(currentView)?'Управление всей системой · все компании'\n"
     "      : currentView==='account'?'Личный аккаунт · '+(identity?.displayName||identity?.login||'')\n"
     "      : 'Компания: '+projectContext();\n"
     "    el.querySelector('strong').textContent=caption;\n"
     "    el.querySelector('button').hidden=ownerBoard||SYSTEM_VIEWS.has(currentView)||currentView==='account';\n"
     "    document.title",
     "  // №140: плашка компании над разделами убрана; остаётся только заголовок вкладки браузера.\n"
     "  const renderScopeBanner = () => {\n"
     "    const ownerBoard = currentView === 'tasks' && identity?.role === 'owner';\n"
     "    document.title"),
    ('обработчик «Сменить компанию»',
     "  byId('workspace-change-company').addEventListener('click',event=>{\n"
     "    event.stopPropagation();\n"
     "    if(window.matchMedia('(max-width: 760px)').matches)setDrawer(true);\n"
     "    else if(document.body.classList.contains('menu-collapsed'))document.querySelector('[data-menu-fold]')?.click();\n"
     "    byId('sidebar').scrollTop=0;\n"
     "    openProjectMenu();\n"
     "  });\n",
     ''),
]
VERSION = re.compile(r'(  window\.SB_CABINET_ASSET_VERSION = ")([0-9]{8}-[\w-]+)(";)')
SUFFIX = '-menu-140'


def transform(text):
    if '\r\n' in text:
        raise SystemExit('ОТКАЗ: файл с CRLF — ожидаются переводы строк LF')
    for name, old, new in EDITS:
        count = text.count(old)
        if count != 1:
            raise SystemExit(f'ОТКАЗ: якорь «{name}» найден {count} раз(а), нужен ровно один — вставка не выполнена')
        text = text.replace(old, new)
    for marker in ('id="workspace-scope"', "byId('workspace-scope')", 'workspace-change-company', '>Сменить компанию<'):
        if marker in text:
            raise SystemExit(f'ОТКАЗ: после вставки осталось «{marker}» — разметка отличается от ожидаемой')
    lines = text.split('\n')
    versions = [n for n, line in enumerate(lines) if VERSION.fullmatch(line)]
    if len(versions) != 1:
        raise SystemExit('ОТКАЗ: строка SB_CABINET_ASSET_VERSION не найдена ровно один раз')
    v = versions[0]
    current = VERSION.fullmatch(lines[v]).group(2)
    if current.endswith(SUFFIX):
        raise SystemExit('ОТКАЗ: версия уже содержит ' + SUFFIX)
    lines[v] = VERSION.sub(lambda m: m.group(1) + current + SUFFIX + m.group(3), lines[v])
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
    print('\n'.join(diff))
    if len(sys.argv) == 3:
        with open(path, 'w', encoding='utf-8', newline='') as handle:
            handle.write(after)
        print('ЗАПИСАНО: ' + path)


if __name__ == '__main__':
    main()
