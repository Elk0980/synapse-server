# -*- coding: utf-8 -*-
"""Размечает главную АВОКАДО и собирает seed-документ avokado/site.

Скрипт намеренно работает с исходной HTML-разметкой (как tag_site.py) и
идемпотентен: перед новым проходом удаляет созданные data-edit/id атрибуты.
"""
import html
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'sites/avokado/index.html'
OUT_JSON = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / 'ops/content/seed/avokado-site.json'

s = SRC.read_text(encoding='utf-8')
s = re.sub(r' data-edit="[^"]*"', '', s)
s = re.sub(r' id="method-(?:intro|[0-5])"', '', s)
# Bare text nodes that cannot carry attributes get stable semantic wrappers.
s = s.replace('<div class="method-intro rv">АВОКАДО — студия дизайна тела<span',
              '<div class="method-intro rv"><span class="method-intro-title">АВОКАДО — студия дизайна тела</span><span')
s = s.replace('<footer id="site-footer">АВОКАДО · студия дизайна тела · Иркутск, ул. Красноказачья, 84 · ежедневно, по предварительной записи<br>',
              '<footer id="site-footer"><span class="footer-copy">АВОКАДО · студия дизайна тела · Иркутск, ул. Красноказачья, 84 · ежедневно, по предварительной записи</span><br>')
s = s.replace('<br>Индивидуальный предприниматель Петрук Татьяна Александровна · ИНН 381497453085 · ОГРНИП 324385000056520</footer>',
              '<br><span class="footer-legal">Индивидуальный предприниматель Петрук Татьяна Александровна · ИНН 381497453085 · ОГРНИП 324385000056520</span></footer>')

# key, title, opening marker, closing marker, optional background
specs = [
    ('top', 'Хиро', r'<section class="hero" id="top"', '</section>', 'assets/hero-poster.jpg'),
    ('pain', 'Сколько раз вы мечтали…', r'<section class="landing-block pain-block[^>]* id="pain"', '</section>', ''),
    ('method-intro', 'Метод · липкий подзаголовок', r'<div class="method-intro rv"', '</div>', None),
]
for i, title in enumerate([
    '01 · Почему АВОКАДО', '02 · Вы просто лежите', '03 · Лазерная эпиляция',
    '04 · Скажем честно', '05 · Отзывы', '06 · Как мы работаем',
]):
    specs.append((f'method-{i}', title, rf'<article class="method-scene[^"]*" data-method-scene="{i}"', '</article>', 'assets/consult-green-wall.webp' if i == 3 else None))
specs += [
    ('price', 'Цены', r'<section class="landing-block price[^>]* id="price"', '<div class="certificate block-subsection"', None),
    ('certificate', 'Подарочный сертификат', r'<div class="certificate block-subsection" id="certificate"', '</section>', None),
    ('contacts', 'Контакты', r'<section class="landing-block contacts" id="contacts"', '</section>', None),
    ('faq', 'Частые вопросы', r'<section class="landing-block faq" id="faq"', '</section>', None),
    ('finale', 'Финал', r'<section class="finale" id="finale"', '</section>', 'assets/hero-poster.jpg'),
    ('footer', 'Подвал', r'<footer id="site-footer"', '</footer>', None),
    ('cta', 'Липкая кнопка', r'<a class="sticky-cta gold-cta" id="cta"', '</a>', None),
]

def bounds(pattern, closer):
    match = re.search(pattern, s)
    if not match:
        raise RuntimeError(f'Не найден блок: {pattern}')
    end = s.find(closer, match.end())
    if end < 0:
        raise RuntimeError(f'Не найден конец блока: {pattern}')
    return match.start(), end + len(closer)

def value_of(inner):
    value = re.sub(r'\s*\n\s*', ' ', inner.strip())
    value = re.sub(r'<br\s*/?>', '\n', value, flags=re.I)
    value = re.sub(r'<(?!/?(?:em|strong|b|i|sup)\b)[^>]+>', '', value)
    return html.unescape(value).strip()

def label(tag, attrs):
    cls = (re.search(r'class="([^"]*)"', attrs) or [None, ''])[1].split()
    known = {'kicker': 'Подпись', 't-slogan': 'Слоган', 't-script-text': 'Скриптовая строка',
             'quote': 'Цитата героини', 'lead': 'Лид', 'note': 'Оговорка',
             'block-subtitle': 'Заголовок группы', 'booking-consent': 'Подпись',
             'certificate-validity': 'Срок действия', 'contact-hours': 'Часы работы'}
    for name in cls:
        if name in known:
            return known[name]
    return {'h1': 'Заголовок', 'h2': 'Заголовок', 'h3': 'Подзаголовок', 'p': 'Текст',
            'summary': 'Вопрос', 'a': 'Кнопка или ссылка', 'span': 'Текст', 'b': 'Акцент'}.get(tag, 'Текст')

sections = []
edits = []
for key, title, pattern, closer, background in specs:
    start, end = bounds(pattern, closer)
    segment = s[start:end]
    # Stable DOM ids let site-apply find stacked method scenes.
    opening = re.search(pattern, segment)
    if key.startswith('method-') and opening and ' id=' not in opening.group(0):
        pos = start + opening.end()
        edits.append((pos, pos, f' id="{key}"'))
    candidates = []
    for tag in ('h1', 'h2', 'h3', 'p', 'summary', 'a', 'button', 'span', 'b', 'div'):
      for match in re.finditer(r'<' + tag + r'(\s[^>]*)?>(.*?)</' + tag + r'>', segment, re.S | re.I):
        attrs, inner = match.group(1) or '', match.group(2)
        inner_tags = {x.lower() for x in re.findall(r'<\s*/?\s*([a-zA-Z0-9]+)', inner)}
        if not inner_tags <= {'br', 'em', 'strong', 'b', 'i', 'sup'}:
            continue
        if not value_of(inner):
            continue
        # Service controls, arrows, generated value and all actual price positions stay immutable.
        if any(x in attrs for x in ('flow-next', 'certificate-value', 'certificate-choice', 'data-chat-link', 'aria-hidden="true"')):
            continue
        if tag == 'div' and not any(x in attrs for x in ('kicker', 't-slogan')):
            continue
        if key == 'price' and not ('id="price-title"' in attrs or any(x in attrs.split('class="')[-1].split('"')[0].split() for x in ('kicker', 'block-subtitle', 'lead', 'note'))):
            continue
        candidates.append((match.start(), match.end(), tag, attrs, inner))
    if key == 'top':
        for match in re.finditer(r'<span class="t-script-text">(.*?)</span>', segment, re.S):
            if not any(item[0] == match.start() for item in candidates):
                candidates.append((match.start(), match.end(), 'span', ' class="t-script-text"', match.group(1)))
    for match in re.finditer(r'<div class="kicker rv">(.*?)</div>', segment, re.S):
        if not any(item[0] == match.start() for item in candidates):
            candidates.append((match.start(), match.end(), 'div', ' class="kicker rv"', match.group(1)))
    # Keep outer editable nodes rather than nested b/span elements.
    candidates = [item for item in candidates if not any(item[0] > other[0] and item[1] <= other[1] for other in candidates if item is not other)]
    fields = []
    counts = {}
    for st, en, tag, attrs, inner in candidates:
        cls = (re.search(r'class="([^"]*)"', attrs) or [None, tag])[1].split()[0]
        base = re.sub('[^a-z0-9]+', '-', cls.lower()).strip('-') or tag
        counts[base] = counts.get(base, 0) + 1
        field_key = f'{key}.{base}-{counts[base]}'
        fields.append({'key': field_key, 'label': label(tag, attrs), 'value': value_of(inner),
                       'multiline': '\n' in value_of(inner) or len(value_of(inner)) > 90})
        edits.append((start + st, start + en, f'<{tag}{attrs} data-edit="{field_key}">{inner}</{tag}>'))
    section = {'id': key, 'title': title, 'fields': fields}
    if background is not None:
        section['background'] = {'default': background, 'image': None, 'opacity': None}
    sections.append(section)

for start, end, replacement in sorted(edits, reverse=True):
    s = s[:start] + replacement + s[end:]

SRC.write_text(s, encoding='utf-8')
OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
OUT_JSON.write_text(json.dumps({'version': 1, 'sections': sections}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('sections', len(sections), 'fields', sum(len(section['fields']) for section in sections))
for section in sections:
    print(' ', section['id'], len(section['fields']), section.get('background'))
