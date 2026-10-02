'use strict';
// CF29-UI: «Контент завод → Статистика» — заявки CRM за месяц по поясу проекта (crm.period). Синтетические ответы, только чтение.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');
const settle = async () => { for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 0)); };
const httpError = (status, message, field) => Object.assign(new Error(message), {status, code: 'VALIDATION_ERROR', ...(field ? {details: {field}} : {})});

// Календарь и сам ответ статистики — в поясе Asia/Irkutsk: пояс заявок от них не берётся.
const CALENDAR = {timezone: 'Asia/Irkutsk', posts: [
  {id: 1, effectiveDate: '2026-10-03', meta: {format: 'post', role: 'sale'}, calendarReadiness: {platforms: [{platform: 'telegram', state: 'published'}]}},
  {id: 2, effectiveDate: '2026-10-05', meta: {format: 'reel', role: 'reach'}, calendarReadiness: {platforms: [{platform: 'youtube_shorts', state: 'published'}]}}],
undatedPosts: []};
const cell = (value) => ({value, kind: 'organic', completeness: 'complete', provider: 'telegram_api'});
const MOSCOW = {basis: 'project', timezone: 'Europe/Moscow', from: '2026-10-01', to: '2026-10-31',
  startInclusive: '2026-09-30T21:00:00.000Z', endExclusive: '2026-10-31T21:00:00.000Z'};
// Перевод часов 25.10.2026: начало октября по Берлину — UTC+2, конец — UTC+1. Число часов не фиксированное.
const BERLIN = {basis: 'project', timezone: 'Europe/Berlin', from: '2026-10-01', to: '2026-10-31',
  startInclusive: '2026-09-30T22:00:00.000Z', endExclusive: '2026-10-31T23:00:00.000Z'};
const POSTS = [
  {platform: 'telegram', url: 'https://t.me/x/1', publishedAt: '2026-09-15T12:00:00Z', leads: 4, attribution: 'exact', format: 'post', ovpRole: 'sale'},
  {platform: 'youtube', url: 'https://youtube.com/shorts/2', publishedAt: '2026-10-05T05:00:00Z', leads: 3, attribution: 'exact', format: null, ovpRole: null},
  {platform: 'vk', url: 'https://vk.com/wall-1_3', publishedAt: '2026-10-06T05:00:00Z', leads: 0, attribution: 'none_in_period', format: 'reel', ovpRole: 'reach'}];
function social({period, withPeriod = true, from = '2026-10-01', to = '2026-10-31', label = 'Telegram', posts = POSTS} = {}) {
  const days = {}; for (const date of [`${from.slice(0, 8)}01`, `${from.slice(0, 8)}02`]) days[date] = {views: cell(100), link_clicks: cell(2)};
  return {from, to, timezone: 'Asia/Irkutsk', socialAggregate: {views: 1200, reach: null},
    platforms: {telegram: {label, configured: true, activeInterval: 'Asia/Irkutsk', totals: {views: 700, link_clicks: 12}, lastCollectedAt: '2026-10-20T03:00:00Z', days},
      youtube: {label: 'YouTube', configured: true, totals: {views: 500, link_clicks: 3}, days: {}}},
    crm: {...(withPeriod ? {period: period === undefined ? MOSCOW : period} : {}), posts, bySource: [{source: 'site', leads: 40}]}};
}

function page({permissions = ['autoposting.view', 'analytics.view'], calendar = async () => CALENDAR, stats = async () => social(), project = 'one'} = {}) {
  const errors = [], calls = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM('<main><section id="view"></section></main>', {url: 'https://cabinet.test/cabinet.html#content-factory/stats', runScripts: 'outside-only', virtualConsole: vc, pretendToBeVisual: true});
  const w = dom.window, d = w.document, views = {};
  w.SbCabinet = {registerView(name, def) { views[name] = def; }};
  w.eval(fs.readFileSync(path.join(__dirname, 'content-factory.js'), 'utf8'));
  const crmQuery = async (p, params = {}, options = {}) => {
    calls.push({path: p, params: {...params}, method: options.method || 'GET'});
    if (p === '/media-mentor/inputs') return {companyCode: params.companyCode, timezone: 'Asia/Irkutsk', profile: {revision: 0, fields: {}}};
    if (p === '/autoposting/calendar') return {companyCode: params.companyCode, ...(await calendar(params))};
    if (p === '/social-stats') return {...(await stats(params)), companyCode: params.companyCode};
    throw Object.assign(new Error('Неожиданный адрес ' + p), {status: 404});
  };
  const ctx = {identity: {role: 'owner', permissions}, selectedProjectId: project, crmQuery, navigate() {}};
  const node = d.getElementById('view');
  const text = (selector) => node.querySelector(selector)?.textContent.trim() ?? null;
  return {w, d, node, calls, errors, views, ctx, text, close: () => w.close(),
    render: async (next = ctx) => { views['content-factory-stats'].render(node, next); await settle(); },
    metric: (id) => text(`[data-cf-metric="${id}"] [data-cf-value]`),
    method: (id) => text(`#cf-stats-method [data-cf-method="${id}"]`),
    line: () => text('[data-cf-crm-period]'),
    caption: () => text('[data-cf-posts] caption'),
    cells: () => [...node.querySelectorAll('[data-cf-posts] [data-label="Заявки"]')].map((c) => c.textContent.trim()),
    daily: () => text('[data-cf-daily-note]'),
    bars: () => node.querySelectorAll('[data-cf-day]').length,
    async month(value) { const input = node.querySelector('#cf-stats-month'); input.value = value; input.dispatchEvent(new w.Event('change', {bubbles: true})); await settle(); },
    async filter(id, value) { const s = node.querySelector(`#cf-${id}`); s.value = value; s.dispatchEvent(new w.Event('change', {bubbles: true})); await settle(); }};
}
const numeric = (value) => /^\d[\d\s]*$/.test(value);
const statsCalls = (f) => f.calls.filter((c) => c.path === '/social-stats');

test('CF29: вкладка просит только GET /social-stats с crmPeriod=project, выбранными датами и своей компанией', async () => {
  const f = page({stats: async (params) => social({from: params.from, to: params.to, period: {...MOSCOW, from: params.from, to: params.to}})}); try {
    await f.render(); await f.month('2026-10'); await f.month('2026-02');
    const [, oct, feb] = statsCalls(f);
    assert.deepEqual(oct.params, {companyCode: 'one', from: '2026-10-01', to: '2026-10-31', crmPeriod: 'project'});
    assert.deepEqual(feb.params, {companyCode: 'one', from: '2026-02-01', to: '2026-02-28', crmPeriod: 'project'});
    assert.ok(f.calls.every((c) => c.method === 'GET'), 'никаких сборов, генерации и записей');
    assert.ok(f.calls.every((c) => ['/media-mentor/inputs', '/autoposting/calendar', '/social-stats'].includes(c.path)), 'других маршрутов нет');
    assert.ok(f.calls.filter((c) => c.path === '/autoposting/calendar').every((c) => !('crmPeriod' in c.params)), 'календарь без нового параметра');
  } finally { f.close(); }
  // Общая аналитика и другие разделы кабинета параметр не передают: он есть только в content-factory.js.
  const others = fs.readdirSync(__dirname).filter((name) => name.endsWith('.js') && name !== 'content-factory.js')
    .filter((name) => /crmPeriod['"]?\s*[:=]\s*['"]?project/.test(fs.readFileSync(path.join(__dirname, name), 'utf8')));
  assert.deepEqual(others, []);
});

test('CF29: подтверждённый период Europe/Moscow — методика, строка периода и подпись таблицы по crm.period; пояс ответа и календаря его не подменяют', async () => {
  const f = page(); try {
    await f.render(); await f.month('2026-10');
    assert.deepEqual(['published', 'views', 'clicks', 'leads'].map(f.metric), ['2', '1 200', '15', '7']);
    const method = f.method('leads');
    assert.match(method, /с 01\.10\.2026 по 31\.10\.2026 включительно по поясу проекта Europe\/Moscow/);
    assert.match(method, /с 2026-09-30 21:00 UTC включительно до 2026-10-31 21:00 UTC не включительно/);
    assert.match(method, /просмотры и переходы — по суткам аккаунтов/);
    assert.doesNotMatch(method, /Asia\/Irkutsk|по UTC и связанные/, 'пояс ответа/календаря не подставлен');
    assert.match(f.method('published'), /Asia\/Irkutsk/, 'календарь называет свой пояс');
    assert.equal(f.line(), 'Заявки CRM — 01.10.2026–31.10.2026 по поясу проекта Europe/Moscow; просмотры и переходы — по суткам аккаунтов.');
    assert.match(f.caption(), /не только за этот месяц\) и их заявки за 01\.10\.2026–31\.10\.2026 по поясу проекта Europe\/Moscow/);
    assert.match(f.method('posts'), /до 200 последних/, 'реестр не выдаётся за публикации месяца');
    assert.ok(f.cells().includes('4'), 'сентябрьская публикация с октябрьской заявкой — в таблице, дата выхода по UTC');
    assert.ok([...f.node.querySelectorAll('[data-cf-posts] td')].some((td) => td.textContent === '2026-09-15'));
    assert.match(f.daily(), /по поясу аккаунта Asia\/Irkutsk/, 'сутки графика — аккаунта'); assert.ok(f.bars() > 0);
    const card = f.node.querySelector('[data-cf-metric="leads"]');
    assert.equal(card.querySelector('.cf-note').textContent, 'связанные с публикациями', 'карточка компактна');
    assert.doesNotMatch(card.textContent, /UTC|поясу|Moscow/);
    assert.equal(f.node.querySelector('details#cf-stats-method').open, false, 'методика закрыта');
    assert.match(f.text('#cf-stats-source'), /^Статистика соцсетей: обновлено /);
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('CF29: границы с переводом часов (Europe/Berlin, 25.10) подтверждаются по поясу, а не числом часов', async () => {
  const f = page({stats: async () => social({period: BERLIN})}); try {
    await f.render(); await f.month('2026-10');
    assert.equal(f.metric('leads'), '7');
    assert.match(f.method('leads'), /Europe\/Berlin.*2026-09-30 22:00 UTC.*2026-10-31 23:00 UTC/);
  } finally { f.close(); }
  const g = page({stats: async () => social({period: {...BERLIN, endExclusive: '2026-10-31T22:00:00.000Z'}})}); try {
    await g.render(); await g.month('2026-10');
    assert.equal(g.metric('leads'), 'Период не подтверждён', 'конец со смещением летнего времени — не начало 1 ноября по Берлину');
  } finally { g.close(); }
});

test('CF29: старый сервер без crm.period — заявки по UTC с честной пометкой; timezone ответа не угадывается', async () => {
  const f = page({stats: async () => ({...social({withPeriod: false}), timezone: 'Europe/Moscow'})}); try {
    await f.render(); await f.month('2026-10');
    assert.equal(f.metric('leads'), '7', 'прежнее поведение: число по UTC-месяцу');
    assert.match(f.method('leads'), /созданные с 1 по последнее число месяца по UTC/);
    assert.match(f.method('leads'), /Сервер не вернул период проекта: месяц для заявок — по UTC, пояс проекта не подтверждён/);
    assert.doesNotMatch(f.method('leads') + f.line() + f.caption(), /Europe\/Moscow|поясу проекта Europe/, 'data.timezone не выдаётся за пояс проекта');
    assert.equal(f.line(), 'Заявки CRM — месяц по UTC: сервер не подтвердил пояс проекта.');
    assert.match(f.caption(), /их заявки за месяц по UTC/);
  } finally { f.close(); }
});

const INVALID = [
  ['другой месяц', {...MOSCOW, from: '2026-09-01'}],
  ['другая дата конца', {...MOSCOW, to: '2026-10-30'}],
  ['основание utc', {...MOSCOW, basis: 'utc'}],
  ['неизвестный пояс', {...MOSCOW, timezone: 'Mars/Olympus'}],
  ['пустой пояс', {...MOSCOW, timezone: ' '}],
  ['пояс не совпадает с границами', {...MOSCOW, timezone: 'Asia/Irkutsk'}],
  ['начало сдвинуто на час', {...MOSCOW, startInclusive: '2026-09-30T22:00:00.000Z'}],
  ['конец включительно', {...MOSCOW, endExclusive: '2026-10-31T20:59:59.999Z'}],
  ['граница не ISO UTC', {...MOSCOW, startInclusive: '2026-10-01 00:00'}],
  ['начало позже конца', {...MOSCOW, startInclusive: MOSCOW.endExclusive, endExclusive: MOSCOW.startInclusive}],
  ['period: null', null],
  ['period — массив', []]];
test('CF29: неверный crm.period — заявки не числом ни в показателе, ни в таблице; просмотры, переходы и график остаются', async () => {
  for (const [name, period] of INVALID) {
    const f = page({stats: async () => social({period})}); try {
      await f.render(); await f.month('2026-10');
      assert.equal(f.metric('leads'), 'Период не подтверждён', name);
      assert.ok(f.cells().length && f.cells().every((c) => c === 'Период не подтверждён'), `${name}: ${f.cells()}`);
      assert.deepEqual([f.metric('views'), f.metric('clicks')], ['1 200', '15'], `${name}: пригодные показатели аккаунтов сохранены`);
      assert.ok(f.bars() > 0, `${name}: график на месте`);
      assert.equal(f.line(), 'Период заявок CRM не подтверждён — заявки не показываем числом.', name);
      assert.match(f.caption(), /заявки не показаны: период CRM не подтверждён/, name);
      assert.match(f.method('leads'), /не совпадает с выбранным месяцем или не проходит проверку/, name);
      assert.doesNotMatch(f.method('leads') + f.line(), /по поясу проекта [A-Z]/, `${name}: период проекта подтверждённым не назван`);
      assert.deepEqual(f.errors, [], name);
    } finally { f.close(); }
  }
});

test('CF29: 400 crmPeriod, 400 timezone и 403 — не успех и не ноль, причина названа; календарь работает', async () => {
  for (const error of [httpError(400, 'Неверный параметр crmPeriod', 'crmPeriod'), httpError(400, 'Пояс проекта не задан или неверен', 'timezone'),
    Object.assign(new Error('Недостаточно прав'), {status: 403})]) {
    const f = page({stats: async () => { throw error; }}); try {
      await f.render(); await f.month('2026-10');
      for (const id of ['views', 'clicks', 'leads']) assert.equal(f.metric(id), 'Не загрузилось', `${error.message}: ${id}`);
      assert.equal(f.metric('published'), '2');
      assert.equal(f.cells().length, 0, 'таблицы с нулями нет');
      assert.ok(f.daily().includes(`Причина: ${error.message}.`), f.daily());
      assert.equal(f.text('#cf-stats-source'), '', 'строка источника при сбое пуста (R2)');
      assert.equal(f.line(), '', 'период не называется');
      assert.doesNotMatch(f.method('leads'), /Europe|по UTC и связанные/);
    } finally { f.close(); }
  }
});

test('CF29: поздние ответы — другой месяц, другая компания, закрытый раздел — текущий экран не меняют', async () => {
  // Прежний месяц отвечает позже нового.
  let releaseSep; const sep = new Promise((r) => { releaseSep = r; });
  const f = page({stats: async (params) => {
    if (params.from === '2026-09-01') { await sep; return social({from: '2026-09-01', to: '2026-09-30', period: {...MOSCOW, from: '2026-09-01', to: '2026-09-30', startInclusive: '2026-08-31T21:00:00.000Z', endExclusive: '2026-09-30T21:00:00.000Z'}, posts: [{...POSTS[0], leads: 99}]}); }
    return social(); }}); try {
    await f.render(); await f.month('2026-09'); await f.month('2026-10');
    releaseSep(); await settle();
    assert.equal(f.metric('leads'), '7'); assert.match(f.line(), /01\.10\.2026–31\.10\.2026/);
    assert.equal(f.node.querySelector('#cf-stats-month').value, '2026-10');
  } finally { f.close(); }
  // Ответ прежней компании приходит после переключения.
  let releaseOne; const one = new Promise((r) => { releaseOne = r; });
  const g = page({stats: async (params) => (params.companyCode === 'one' ? (await one, social({posts: [{...POSTS[0], leads: 99}]})) : social({period: BERLIN, label: 'Telegram Два'}))}); try {
    void g.views['content-factory-stats'].render(g.node, g.ctx); await settle();
    await g.render({...g.ctx, selectedProjectId: 'two'}); await g.month('2026-10');
    releaseOne(); await settle();
    assert.equal(g.metric('leads'), '7'); assert.match(g.line(), /Europe\/Berlin/); assert.doesNotMatch(g.node.textContent, /\b99\b/);
  } finally { g.close(); }
  // Раздел закрыт до ответа: ничего не рисуется и ошибок нет.
  let releaseClosed; const closed = new Promise((r) => { releaseClosed = r; });
  const h = page({stats: async () => { await closed; return social(); }}); try {
    void h.views['content-factory-stats'].render(h.node, h.ctx); await settle();
    h.node.innerHTML = '<p data-other>Другой раздел</p>';
    releaseClosed(); await settle();
    assert.equal(h.node.textContent, 'Другой раздел'); assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test('CF29: фильтры площадки, формата и цели ОВП, псевдоним YouTube и nullable-теги работают с периодом проекта и при неподтверждённом', async () => {
  const f = page(); try {
    await f.render(); await f.month('2026-10');
    const fetched = statsCalls(f).length;
    await f.filter('filterPlatform', 'youtube');
    assert.deepEqual(['published', 'views', 'leads'].map(f.metric), ['1', '500', '3'], 'youtube_shorts календаря = youtube статистики');
    await f.filter('filterPlatform', ''); await f.filter('filterFormat', 'post');
    assert.equal(f.metric('leads'), '4', 'null-формат опубликованной версии не угадывается');
    assert.match(f.text('[data-cf-filter-note]'), /Публикаций без известного формата: 1/);
    assert.equal(f.metric('views'), 'Нет разбивки по формату/ОВП');
    await f.filter('filterFormat', ''); await f.filter('filterRole', 'reach');
    assert.equal(f.metric('leads'), '0', 'связь есть, заявок в периоде нет — измеренный ноль');
    assert.match(f.caption(), /по поясу проекта Europe\/Moscow — по фильтрам/);
    assert.equal(statsCalls(f).length, fetched, 'фильтры не делают запросов');
  } finally { f.close(); }
  const g = page({stats: async () => social({period: {...MOSCOW, from: '2026-09-01'}})}); try {
    await g.render(); await g.month('2026-10');
    await g.filter('filterPlatform', 'telegram');
    assert.deepEqual(['views', 'clicks', 'leads'].map(g.metric), ['700', '12', 'Период не подтверждён']);
    assert.ok(g.cells().every((c) => !numeric(c)));
  } finally { g.close(); }
});
