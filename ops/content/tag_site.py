# -*- coding: utf-8 -*-
"""Размечает редактируемые тексты главной ALVI атрибутом data-edit и собирает seed-документ alvi/site."""
import re, json, html, sys

SRC = sys.argv[1] if len(sys.argv) > 1 else '/tmp/alvi_v2/v8.html'
OUT_HTML = SRC
OUT_JSON = '/tmp/ed/site.json'

s = open(SRC, encoding='utf-8').read()
# убираем прошлую разметку, чтобы скрипт был идемпотентным
s = re.sub(r' data-edit="[^"]*"', '', s)

TAGS = ['h1', 'h2', 'h3', 'h4', 'p', 'span', 'li', 'summary', 'dd', 'dt', 'a', 'button', 'legend', 'label', 'small', 'footer', 'strong']
ALLOWED_INNER = {'br', 'em', 'strong', 'b', 'i', 'sup'}
LABELS = [
    ('hero-title', 'Заголовок'), ('scene-title', 'Заголовок сцены'), ('scene-quote', 'Цитата сцены'), ('scene-copy', 'Текст сцены'),
    ('hero-review', 'Отзыв'), ('final-price-line', 'Строка цен'), ('need-card__pain', 'Карточка: боль'), ('need-card__fix', 'Карточка: решение'),
    ('need-card__proof', 'Карточка: цитата'), ('final-signature', 'Подпись'), ('rating-pill', 'Плашка рейтинга'),
    ('content-title', 'Заголовок'), ('content-subtitle', 'Подзаголовок'), ('content-lead', 'Вводный текст'), ('content-copy', 'Текст'),
    ('content-quote', 'Цитата'), ('content-button', 'Кнопка'), ('trust-score', 'Оценка'), ('trust-copy', 'Текст'), ('text-link', 'Ссылка'),
    ('proof-note', 'Ссылка на отзывы'), ('floating-cta__button', 'Плавающая кнопка'), ('floating-cta__note', 'Подпись под кнопками'),
    ('site-footer__brand', 'Подвал: название'), ('site-footer__links', 'Подвал: ссылки'), ('price-all__button', 'Кнопка прайса'),
    ('program-note', 'Примечание'), ('quiz-option', 'Вариант ответа'), ('contact-label', 'Подпись контакта'),
]
SECTIONS = []  # (key, title, start, end)

def add_section(key, title, start_re, end_str):
    m = re.search(start_re, s)
    if not m:
        return
    end = s.find(end_str, m.start())
    SECTIONS.append((key, title, m.start(), end))

for n, title in [('0', 'Хиро · сцена 1 «Верни себе баланс»'), ('1', 'Хиро · сцена 2'), ('3', 'Хиро · сцена 3'), ('5', 'Хиро · сцена 4'), ('7', 'Хиро · финальная сцена')]:
    add_section('hero-' + n, title, r'<article class="hero-scene[^"]*" data-scene="' + n + '"', '</article>')
for sid, title in [('trust', 'Отзывы и рейтинг'), ('for-self', 'Проведи день для себя'), ('for-two', 'Один ритм на двоих'), ('gift', 'Сертификат в подарок'),
                   ('space', 'Оставьте тревоги за стенами ALVI'), ('quiz', 'Подобрать ритуал за 3 вопроса'), ('faq', 'Частые вопросы'), ('contacts', 'Контакты')]:
    add_section(sid, title, r'<section[^>]*id="' + sid + '"', '</section>')
add_section('footer', 'Подвал', r'<footer class="site-footer"', '</footer>')
add_section('floating', 'Плавающие кнопки', r'<div class="floating-cta">', '</div>\n  </div>')

def label_for(tag, attrs, inner_text):
    cls = re.search(r'class="([^"]*)"', attrs)
    cls = cls.group(1) if cls else ''
    for c, lab in LABELS:
        if c in cls.split():
            return lab
    return {'h1': 'Заголовок', 'h2': 'Заголовок', 'h3': 'Подзаголовок', 'p': 'Текст', 'summary': 'Вопрос', 'dd': 'Значение', 'dt': 'Подпись',
            'a': 'Ссылка', 'button': 'Кнопка', 'legend': 'Вопрос', 'li': 'Пункт', 'span': 'Текст', 'small': 'Мелкий текст', 'footer': 'Подпись', 'strong': 'Акцент', 'label': 'Подпись'}.get(tag, tag)

def skip_region(section_html, pos):
    """Внутри динамических блоков не размечаем."""
    before = section_html[:pos]
    for opener, closer in [('<div class="program-grid">', '\n        </div>'), ('<div class="price-all">', '</div>'), ('<dl class="program-facts">', '</dl>'), ('<div class="quiz-options">', '\n            </div>')]:
        i = before.rfind(opener)
        if i >= 0 and section_html.find(closer, i) > pos:
            return True
    return False

edits = []  # (abs_start, abs_end, new_html)
doc = {'version': 1, 'sections': []}
for key, title, start, end in SECTIONS:
    seg = s[start:end]
    fields = []
    counters = {}
    found = []
    for tag in TAGS:
        for m in re.finditer(r'<' + tag + r'(\s[^>]*)?>(.*?)</' + tag + r'>', seg, re.S):
            attrs = m.group(1) or ''
            inner = m.group(2)
            if '<' + tag in inner:
                continue
            inner_tags = set(t.lower() for t in re.findall(r'<\s*/?\s*([a-zA-Z0-9]+)', inner))
            if not inner_tags <= ALLOWED_INNER:
                continue
            text = re.sub(r'<[^>]+>', '', inner).strip()
            if not text or 'data-edit' in attrs:
                continue
            if skip_region(seg, m.start()):
                continue
            if tag == 'label' and '<input' in inner:
                continue
            found.append((m.start(), m.end(), tag, attrs, inner, text))
    found.sort()
    # вложенные совпадения (strong внутри p) — оставляем внешний
    filtered = []
    for f in found:
        if any(f[0] > g[0] and f[1] <= g[1] for g in found if g is not f):
            continue
        filtered.append(f)
    for st, en, tag, attrs, inner, text in filtered:
        base = re.sub(r'[^a-z0-9]+', '-', (re.search(r'class="([^"]*)"', attrs).group(1).split()[0] if 'class="' in attrs else tag).lower()).strip('-')
        counters[base] = counters.get(base, 0) + 1
        fkey = f'{key}.{base}-{counters[base]}'
        value = re.sub(r'\s*\n\s*', ' ', inner.strip())
        value = re.sub(r'<br\s*/?>', '\n', value)
        value = html.unescape(re.sub(r'<(?!/?(em|strong|b|i|sup)\b)[^>]+>', '', value))
        fields.append({'key': fkey, 'label': label_for(tag, attrs, text), 'value': value, 'multiline': len(value) > 90 or '\n' in value})
        new = f'<{tag}{attrs} data-edit="{fkey}">{inner}</{tag}>'
        edits.append((start + st, start + en, new))
    bg = None
    mb = re.search(r'<div class="section-backdrop" style="background-image:url\(\'([^\']+)\'\)"', seg)
    if mb:
        bg = mb.group(1)
    sec = {'id': key, 'title': title, 'fields': fields}
    if not key.startswith('hero') and key not in ('floating', 'footer'):
        sec['background'] = {'default': bg, 'image': None, 'opacity': None}
    doc['sections'].append(sec)

for st, en, new in sorted(edits, reverse=True):
    s = s[:st] + new + s[en:]

open(OUT_HTML, 'w', encoding='utf-8').write(s)
json.dump(doc, open(OUT_JSON, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('sections', len(doc['sections']), 'fields', sum(len(x['fields']) for x in doc['sections']))
for x in doc['sections']:
    print(' ', x['id'], len(x['fields']), x.get('background'))
