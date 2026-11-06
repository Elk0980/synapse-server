'use strict';
/* №205: общий набор CfKit — этапы, шапка, полоса дат, стартовая точка ленты; подключение из content-factory.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');

const kitSource = fs.readFileSync(path.join(__dirname, 'cf-kit.js'), 'utf8');
const factorySource = fs.readFileSync(path.join(__dirname, 'content-factory.js'), 'utf8');
const kitCss = fs.readFileSync(path.join(__dirname, 'cf-kit.css'), 'utf8');

function load(html = '<div id="root"></div>', {storage = true} = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><title>t</title></head><body>${html}</body></html>`, {url: 'https://cabinet.test/', runScripts: 'outside-only', pretendToBeVisual: true});
  const {window} = dom;
  if (!storage) Object.defineProperty(window, 'localStorage', {get() { throw new Error('blocked'); }});
  window.eval(kitSource);
  return window;
}

test('этапы: ровно 13 в порядке цепочки, без «Снимается», чип с неярким тоном', () => {
  const w = load();
  const ids = [...w.CfKit.STAGES].map((s) => s.id);
  assert.deepEqual(ids, ['draft', 'script_review', 'script_rework', 'planned', 'shot', 'editing', 'edit_review', 'edit_rework', 'ready', 'scheduled', 'published', 'publish_error', 'unpublished']);
  assert.equal(w.CfKit.STAGES.find((s) => s.id === 'script_review').label, 'Сценарий на согласовании');
  assert.ok(w.CfKit.STAGES.every((s) => s.label && s.tone));
  assert.ok(!w.CfKit.STAGES.some((s) => /Снимается/.test(s.label)));
  const box = w.document.createElement('div');
  box.innerHTML = w.CfKit.stageChip('edit_rework');
  const chip = box.firstElementChild;
  assert.equal(chip.textContent, 'Монтаж на доработке');
  assert.match(chip.className, /cfk-chip cfk-tone-coral/);
  assert.equal(chip.dataset.stage, 'edit_rework');
  box.innerHTML = w.CfKit.stageChip('<b>x</b>');
  assert.equal(box.querySelector('b'), null, 'неизвестный этап экранируется');
  assert.throws(() => { w.CfKit.STAGES.push({}); });
});

test('шапка: название и иконки в одну строку, без ⚙; таблица неактивна без ссылки', () => {
  const w = load();
  const head = w.CfKit.header({title: 'Публикации', actions: ['calendar', 'sheet', 'sort'], sortOptions: [{id: 'date', label: 'По дате выхода'}, {id: 'status', label: 'По статусу'}], sortKey: 'plan'});
  w.document.body.append(head);
  const row = head.querySelector('.cfk-head-row');
  assert.equal(row.querySelector('.cfk-title').textContent, 'Публикации');
  assert.equal(row.querySelectorAll('.cfk-ico').length, 3);
  assert.ok(!head.textContent.includes('⚙'));
  const sheet = row.querySelector('[data-cfk-act="sheet"]');
  assert.equal(sheet.tagName, 'BUTTON');
  assert.ok(sheet.disabled);
  assert.match(sheet.title, /не подключена/);
  const linked = w.CfKit.header({title: 'Монтаж', sheetUrl: 'https://docs.google.com/spreadsheets/d/EXAMPLE', sortOptions: []});
  const a = linked.querySelector('a[data-cfk-act="sheet"]');
  assert.equal(a.getAttribute('target'), '_blank');
  assert.equal(a.getAttribute('rel'), 'noopener');
  assert.equal(linked.querySelector('[data-cfk-act="sort"]'), null, 'без пунктов меню сортировки нет');
  const unsafe = w.CfKit.header({title: 'x', sheetUrl: 'javascript:alert(1)'});
  assert.equal(unsafe.querySelector('a'), null);
  assert.match(kitCss, /\.cfk-title \{[^}]*text-overflow: ellipsis/);
  assert.match(kitCss, /\.cfk-head-row \{[^}]*flex-wrap: nowrap/);
});

test('шапка: календарь переключается, сортировка запоминается по ключу вкладки', () => {
  const w = load();
  const calls = [], sorts = [];
  const options = [{id: 'date', label: 'По дате выхода'}, {id: 'status', label: 'По статусу'}, {id: 'platform', label: 'По площадке'}];
  const head = w.CfKit.header({title: 'Публикации', sortOptions: options, sortKey: 'plan', onSort: (id) => sorts.push(id), onCalendar: (open) => calls.push(open)});
  w.document.body.append(head);
  const cal = head.querySelector('[data-cfk-act="calendar"]');
  cal.click(); cal.click();
  assert.deepEqual(calls, [true, false]);
  assert.equal(cal.getAttribute('aria-pressed'), 'false');
  head.querySelector('[data-cfk-act="sort"]').click();
  const items = [...head.querySelectorAll('[data-cfk-sort]')];
  assert.equal(items.length, 3);
  assert.match(items[0].textContent, /по умолчанию/);
  assert.equal(items[0].getAttribute('aria-checked'), 'true');
  items[1].click();
  assert.deepEqual(sorts, ['status']);
  assert.equal(head.querySelector('.cfk-sort-menu'), null, 'меню закрывается после выбора');
  assert.equal(w.localStorage.getItem('cfkit.sort.plan'), 'status');
  assert.equal(w.CfKit.getSort('plan', options), 'status');
  const again = w.CfKit.header({title: 'Публикации', sortOptions: options, sortKey: 'plan'});
  assert.equal(again.dataset.sort, 'status');
  w.localStorage.setItem('cfkit.sort.plan', 'deleted-option');
  assert.equal(w.CfKit.getSort('plan', options), 'date', 'неизвестный сохранённый выбор — по умолчанию');
  // Повторное нажатие на ⇅ закрывает меню; щелчок вне шапки тоже.
  head.querySelector('[data-cfk-act="sort"]').click();
  head.querySelector('[data-cfk-act="sort"]').click();
  assert.equal(head.querySelector('.cfk-sort-menu'), null);
  head.querySelector('[data-cfk-act="sort"]').click();
  w.document.body.click();
  assert.equal(head.querySelector('.cfk-sort-menu'), null);
});

test('шапка работает без localStorage', () => {
  const w = load('<div></div>', {storage: false});
  const sorts = [];
  const head = w.CfKit.header({title: 'x', sortOptions: [{id: 'a', label: 'A'}, {id: 'b', label: 'B'}], sortKey: 'k', onSort: (id) => sorts.push(id)});
  head.querySelector('[data-cfk-act="sort"]').click();
  head.querySelector('[data-cfk-sort="b"]').click();
  assert.deepEqual(sorts, ['b']);
  assert.equal(w.CfKit.getSort('k', [{id: 'a'}, {id: 'b'}]), 'a');
});

test('полоса дат: скрыта по умолчанию, заголовок, точки рилсов, стрелки на неделю', () => {
  const w = load();
  const picked = [];
  const strip = w.CfKit.dateStrip({tz: 'Иркутское время', marked: new Set(['2026-11-05', '2026-11-14']), selected: new w.Date(2026, 10, 7), onSelect: (d) => picked.push(w.CfKit.dayKey(d))});
  w.document.body.append(strip);
  assert.equal(strip.hidden, true);
  assert.equal(strip.querySelector('.cfk-dates-title').textContent, '7 ноября 2026 г.');
  assert.equal(strip.querySelector('.cfk-tz').textContent, 'Иркутское время');
  assert.ok(strip.querySelector('[data-cfk-day="2026-11-05"]').classList.contains('has'));
  assert.ok(!strip.querySelector('[data-cfk-day="2026-11-06"]').classList.contains('has'));
  assert.ok(strip.querySelector('[data-cfk-day="2026-11-07"]').classList.contains('on'));
  strip.setOpen(true);
  assert.equal(strip.hidden, false);
  strip.querySelector('[data-cfk-week="1"]').click();
  assert.equal(strip.querySelector('.cfk-dates-title').textContent, '14 ноября 2026 г.');
  strip.querySelector('[data-cfk-day="2026-11-05"]').click();
  assert.deepEqual(picked, ['2026-11-14', '2026-11-05']);
  strip.setSelected('2026-11-20');
  assert.deepEqual(picked, ['2026-11-14', '2026-11-05'], 'программный выбор не вызывает onSelect');
  assert.equal(w.CfKit.dayKey(strip.getSelected()), '2026-11-20');
  assert.match(kitCss, /\.cfk-dates \{[^}]*user-select: none/);
  assert.match(kitCss, /scroll-snap-type: x mandatory/);
});

test('месячный календарь: пн–вс, сегодня пунктиром, выбранный, точка, «Сегодня», ✕', () => {
  const w = load();
  const picked = [];
  const strip = w.CfKit.dateStrip({tz: 'Иркутское время', marked: new Set(['2026-12-03']), selected: new w.Date(2026, 11, 10), onSelect: (d) => picked.push(w.CfKit.dayKey(d))});
  w.document.body.append(strip);
  strip.setOpen(true);
  strip.querySelector('[data-cfk-month]').click();
  const cal = w.document.querySelector('.cfk-cal');
  assert.ok(cal);
  assert.equal(cal.getAttribute('role'), 'dialog');
  assert.deepEqual([...cal.querySelectorAll('.cfk-cal-w')].map((x) => x.textContent), ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс']);
  assert.equal(cal.querySelector('.cfk-cal-t').textContent, 'Декабрь 2026 г.');
  // 1 декабря 2026 — вторник: одна пустая клетка перед ним.
  const grid = cal.querySelector('.cfk-cal-g');
  assert.equal(grid.children[7].tagName, 'SPAN');
  assert.equal(grid.children[8].textContent, '1');
  assert.ok(cal.querySelector('[data-cfk-pick="2026-12-10"]').classList.contains('on'));
  assert.ok(cal.querySelector('[data-cfk-pick="2026-12-03"]').classList.contains('has'));
  const todayKey = w.CfKit.dayKey(new w.Date());
  cal.querySelector('[data-cfk-mon="-1"]').click();
  assert.equal(cal.querySelector('.cfk-cal-t').textContent, 'Ноябрь 2026 г.');
  if (todayKey.startsWith('2026-11')) assert.ok(cal.querySelector(`.cfk-cal-d[data-cfk-pick="${todayKey}"]`).classList.contains('td'));
  cal.querySelector('[data-cfk-pick="2026-11-21"]').click();
  assert.equal(w.document.querySelector('.cfk-cal'), null, 'выбор дня закрывает календарь');
  assert.deepEqual(picked, ['2026-11-21']);
  assert.equal(strip.querySelector('.cfk-dates-title').textContent, '21 ноября 2026 г.');
  strip.openMonth();
  assert.ok(w.document.querySelector('.cfk-cal-today'));
  w.document.querySelector('[data-cfk-close]').click();
  assert.equal(w.document.querySelector('.cfk-cal'), null);
  assert.match(kitCss, /\.cfk-cal \{[^}]*position: fixed; inset: 0/);
  assert.match(kitCss, /\.cfk-cal-d\.td \{[^}]*dashed/);
});

test('лента: старт на первом неопубликованном, пунктир над ним, пометка «впереди»', () => {
  const w = load(`<div id="feed">${['published', 'published', 'edit_review', 'planned', 'draft'].map((s, i) => `<article data-stage="${s}" class="${i > 2 ? 'later' : ''}">№${i + 1}</article>`).join('')}</div>`);
  const feed = w.document.getElementById('feed');
  const state = w.CfKit.feedStart(feed, {isAbove: (el) => el.dataset.stage === 'published', aheadSelector: '.later', aheadLabel: '↓ впереди — ещё без материалов'});
  assert.equal(state.target.textContent, '№3');
  const sep = feed.querySelector('.cfk-feed-sep');
  assert.equal(sep.nextElementSibling, state.target);
  assert.equal(sep.textContent, '↑ выше — опубликованные');
  assert.ok(feed.classList.contains('cfk-feed'));
  assert.equal(feed.querySelector('.cfk-feed-ahead').nextElementSibling.textContent, '№4');
  // Повторный вызов не плодит разделители.
  w.CfKit.feedStart(feed, {isAbove: (el) => el.dataset.stage === 'published'});
  assert.equal(feed.querySelectorAll('.cfk-feed-sep').length, 1);
  assert.equal(feed.querySelectorAll('.cfk-feed-ahead').length, 0);
  // Подпись появляется только при прокрутке вверх (класс ленты).
  assert.match(kitCss, /\.cfk-feed\.cfk-feed-up \.cfk-feed-sep span \{[^}]*opacity: 1/);
  assert.match(kitCss, /\.cfk-feed-sep span \{[^}]*opacity: 0/);
});

test('лента-таблица: разделитель строкой на все колонки; без опубликованных — без разделителя', () => {
  const w = load(`<table id="t"><thead><tr><th>Дата</th><th>Тема</th><th>Статус</th></tr></thead><tbody>
    <tr data-p="1"><td>1</td><td>a</td><td>x</td></tr><tr><td>2</td><td>b</td><td>y</td></tr></tbody></table><div id="none"><p>1</p><p>2</p></div>`);
  const table = w.document.getElementById('t');
  w.CfKit.feedStart(table, {isAbove: (row) => row.dataset.p === '1'});
  const sep = table.querySelector('tr.cfk-feed-sep');
  assert.ok(sep);
  assert.equal(sep.querySelector('td').getAttribute('colspan'), '3');
  const ol = w.document.createElement('ol');
  ol.innerHTML = '<li data-p="1">1</li><li>2</li>';
  w.document.body.append(ol);
  w.CfKit.feedStart(ol, {isAbove: (li) => li.dataset.p === '1'});
  assert.equal(ol.querySelector('.cfk-feed-sep').tagName, 'LI');
  const none = w.document.getElementById('none');
  const state = w.CfKit.feedStart(none, {isAbove: () => false});
  assert.equal(state.separator, null);
  assert.equal(none.querySelector('.cfk-feed-sep'), null);
});

test('content-factory.js подключает cf-kit и переименовывает «Материалы» в «Монтаж» без смены адреса', () => {
  const dom = new JSDOM(`<!doctype html><html><head><title>Материалы — Авокадо</title></head><body>
    <nav><a class="nav-link" href="#content/materials" data-view-link="content-materials">Материалы</a></nav><h1 id="mobile-title">Материалы</h1></body></html>`,
  {url: 'https://cabinet.test/cabinet.html', runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window;
  w.SB_CABINET_ASSET_VERSION = 'v1';
  w.SbCabinet = {registerView() {}};
  w.eval(factorySource);
  const script = w.document.querySelector('script[data-cf-kit-asset]');
  const link = w.document.querySelector('link[data-cf-kit-asset]');
  assert.equal(script.getAttribute('src'), 'cabinet/cf-kit.js?v=v1');
  assert.equal(link.getAttribute('href'), 'cabinet/cf-kit.css?v=v1');
  const nav = w.document.querySelector('[data-view-link="content-materials"]');
  assert.equal(nav.textContent, 'Монтаж');
  assert.equal(nav.getAttribute('href'), '#content/materials');
  assert.equal(w.document.getElementById('mobile-title').textContent, 'Монтаж');
  assert.equal(w.document.title, 'Монтаж — Авокадо');
  // Повторный вызов не добавляет второй набор файлов.
  w.SbCabinet.contentFactory.ensureCfKit(w.document);
  assert.equal(w.document.querySelectorAll('script[data-cf-kit-asset]').length, 1);
  assert.equal(typeof w.SbCabinet.contentFactory.relabelMaterials, 'function');
});

test('CfKit загружается один раз и сообщает о готовности', () => {
  const dom = new JSDOM('<!doctype html><body></body>', {runScripts: 'outside-only'});
  const w = dom.window;
  let ready = 0;
  w.addEventListener('cfkit:ready', () => { ready += 1; });
  w.eval(kitSource);
  const first = w.CfKit;
  w.eval(kitSource);
  assert.equal(w.CfKit, first);
  assert.equal(ready, 1);
  assert.ok(Object.isFrozen(w.CfKit));
});

test('лента: scroll:false не сбрасывает позицию пользователя при перерисовке', async () => {
  const w = load('<div id="f"><p data-p="1">1</p><p>2</p><p>3</p></div>');
  const feed = w.document.getElementById('f');
  let setCalls = 0;
  const desc = Object.getOwnPropertyDescriptor(w.Element.prototype, 'scrollTop');
  Object.defineProperty(feed, 'scrollTop', {get() { return desc.get.call(this); }, set(v) { setCalls += 1; desc.set.call(this, v); }, configurable: true});
  const state = w.CfKit.feedStart(feed, {isAbove: (el) => el.dataset.p === '1', scroll: false});
  await new Promise((resolve) => w.requestAnimationFrame(() => resolve()));
  assert.ok(state.separator);
  assert.equal(setCalls, 0);
  assert.equal(typeof state.refresh, 'function');
});

/* Пакет H: короткая лента после стартовой точки. Эмуляция ленты с max-height 600: окно растёт вместе с содержимым,
   пока не упрётся в предел (как content-box с max-height), прокрутка ограничена диапазоном. */
function shortFeed(w, {maxH = 600, itemH = 100, overflow = 'auto'} = {}) {
  const feed = w.document.getElementById('f');
  feed.style.overflowY = overflow;
  const kids = () => [...feed.children];
  const heightOf = (node) => node.classList.contains('cfk-feed-pad') ? parseFloat(node.style.height) || 0 : node.classList.contains('cfk-feed-sep') ? 0 : itemH;
  const content = () => kids().reduce((sum, node) => sum + heightOf(node), 0);
  const client = () => Math.min(content(), maxH);
  let top = 0;
  Object.defineProperty(feed, 'clientHeight', {get: client, configurable: true});
  Object.defineProperty(feed, 'scrollHeight', {get: () => Math.max(client(), content()), configurable: true});
  Object.defineProperty(feed, 'scrollTop', {get: () => top, set: (v) => { top = Math.max(0, Math.min(v, feed.scrollHeight - feed.clientHeight)); }, configurable: true});
  const rectOf = (node) => { let y = -top; for (const kid of kids()) { if (kid === node) break; y += heightOf(kid); } return {top: y, left: 0, width: 390, height: heightOf(node)}; };
  w.Element.prototype.getBoundingClientRect = function () { return this === feed ? {top: 0, left: 0, width: 390, height: client()} : rectOf(this); };
  return feed;
}
const frame = (w) => new Promise((resolve) => w.requestAnimationFrame(() => resolve()));

test('лента: короткая лента после стартовой точки встаёт наверх (распорка, а не padding по scrollHeight)', async () => {
  const w = load(`<div id="f">${['published', 'published', 'edit_review'].map((s, i) => `<article data-stage="${s}">№${i + 1}</article>`).join('')}</div>`);
  const feed = shortFeed(w);
  const state = w.CfKit.feedStart(feed, {isAbove: (el) => el.dataset.stage === 'published'});
  await frame(w);
  assert.equal(state.start, 200);
  assert.equal(feed.scrollTop, 200, 'первый неопубликованный — у верха ленты');
  const pad = feed.querySelector('.cfk-feed-pad');
  assert.ok(pad, 'распорка добавлена последним элементом');
  assert.equal(feed.lastElementChild, pad);
  assert.equal(pad.getAttribute('aria-hidden'), 'true');
  assert.equal(feed.scrollHeight - feed.clientHeight, 200, 'распорка ровно по нужному диапазону, без лишнего хвоста');
  assert.equal(feed.style.paddingBottom, '', 'padding-bottom ленты не трогаем');
  // Повторный вызов не плодит распорки.
  w.CfKit.feedStart(feed, {isAbove: (el) => el.dataset.stage === 'published'});
  await frame(w);
  assert.equal(feed.querySelectorAll('.cfk-feed-pad').length, 1);
  assert.equal(feed.scrollTop, 200);
});

test('лента: длинной ленте и ленте без своей прокрутки распорка не нужна', async () => {
  const long = load(`<div id="f">${[1, 1, 0, 0, 0, 0, 0, 0, 0, 0].map((p) => `<article data-p="${p}">x</article>`).join('')}</div>`);
  const feed = shortFeed(long);
  long.CfKit.feedStart(feed, {isAbove: (el) => el.dataset.p === '1'});
  await frame(long);
  assert.equal(feed.querySelector('.cfk-feed-pad'), null);
  assert.equal(feed.scrollTop, 200);
  const page = load('<div id="f"><article data-p="1">1</article><article>2</article></div>');
  const flat = shortFeed(page, {overflow: 'visible'});
  page.CfKit.feedStart(flat, {isAbove: (el) => el.dataset.p === '1'});
  await frame(page);
  assert.equal(flat.querySelector('.cfk-feed-pad'), null, 'без overflow:auto лента не получает хвост');
  assert.match(kitCss, /\.cfk-feed-pad \{[^}]*grid-column: 1 \/ -1/);
});
