'use strict';
/* specs/217: блок «рилс → переходы → заявки → продажи → выручка» на вкладке Статистика. Данные синтетические. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { JSDOM } = require('jsdom');

const stats = (code) => ({ companyCode: code, from: '2026-10-09', to: '2026-11-07', socialAggregate: {}, platforms: {}, crm: { posts: [] } });
const settings = (over = {}) => ({ companyCode: 'demo-a', enabled: false, label: 'Подробнее:', enabledAt: null, revision: 0, siteUrl: 'https://demo.example.test/', active: false, reason: 'Метки выключены: подписи уходят как есть.', ...over });
const report = (code, over = {}) => ({ companyCode: code, mode: 'LIVE', settings: settings({ enabled: true, active: true, revision: 1 }), unmatched: { leads: 1, visits: 0 },
  totals: { visits: 5, leads: 3, sales: 2, revenue: 15000, salesWithoutAmount: 1 },
  reels: [{ postId: 12, title: 'Как записаться <b>', themeId: 12, visits: 5, leads: 3, sales: 2, revenue: 15000, salesWithoutAmount: 1,
    platforms: [{ platform: 'vk', linkStatus: 'added' }, { platform: 'telegram', linkStatus: 'skipped_limit' }],
    lifetime: { revenue: 15000, cost: 5000, romi: 200, romiReason: '' } },
  { postId: 13, title: 'Без расхода', themeId: 12, visits: 0, leads: 0, sales: 0, revenue: 0, salesWithoutAmount: 0, platforms: [], lifetime: { revenue: 0, cost: null, romi: null, romiReason: 'Расход на рилс не внесён.' } }],
  themes: [{ themeId: 12, title: 'Как записаться', postIds: [12, 13], visits: 5, leads: 3, sales: 2, revenue: 15000, salesWithoutAmount: 1, lifetime: { romi: 200, romiReason: '' } }], ...over });

function setup({ role = 'editor', reply } = {}) {
  const dom = new JSDOM('<div id="el"></div>', { url: 'https://cabinet.example.test/', runScripts: 'outside-only' }), w = dom.window, registered = {}, calls = [];
  w.SynapseModules = { register: (id, def) => { registered[id] = def; } };
  w.eval(fs.readFileSync(__dirname + '/content-stats.js', 'utf8'));
  const ctx = { companyCode: 'demo-a', user: { role }, csrfToken: 'csrf-test', can: () => true, signal: new w.AbortController().signal,
    crm: async (path, params, options = {}) => { calls.push({ path, params, options }); return reply(path, params, options); } };
  return { w, el: w.document.getElementById('el'), def: registered['content-stats'], calls, ctx };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('воронка: рилс → переходы → заявки → продажи → выручка, ROMI только при расходе, LIVE, текст экранирован', async () => {
  const { el, def, ctx, calls } = setup({ reply: (path, params) => path === '/social-stats/reel-attribution' ? report(params.companyCode) : path === '/social-stats' ? stats(params.companyCode) : null });
  await def.mount(el, ctx); await settle();
  assert.ok(calls.some((c) => c.path === '/social-stats/reel-attribution' && c.params.companyCode === 'demo-a' && c.params.from && c.params.to));
  const row = el.querySelector('[data-cs-funnel-reel="12"]');
  const cell = (r, label) => r.querySelector(`td[data-label="${label}"]`).textContent.replace(/\s+/g, ' ').trim();
  assert.equal(cell(row, 'Переходы'), '5'); assert.equal(cell(row, 'Заявки'), '3'); assert.match(cell(row, 'Продажи'), /^2 \(1 без суммы\)/);
  assert.match(cell(row, 'Выручка'), /15\s000 ₽/); assert.match(cell(row, 'ROMI, всё время'), /200%/);
  assert.equal(el.querySelector('[data-cs-funnel] b'), null, 'название рилса экранировано');
  const empty = el.querySelector('[data-cs-funnel-reel="13"]');
  assert.equal(cell(empty, 'ROMI, всё время'), '—'); assert.equal(empty.querySelector('[title]').getAttribute('title'), 'Расход на рилс не внесён.');
  assert.match(el.querySelector('[data-cs-funnel]').textContent, /LIVE · CRM/);
  assert.match(el.querySelector('[data-cs-funnel]').textContent, /без карточки этой компании: заявок 1/);
  assert.ok(el.querySelector('[data-cs-funnel-theme="12"]'));
  assert.equal(el.querySelector('[data-cs-funnel-toggle]'), null, 'не владелец — без переключателя');
});

test('воронка: нет меток и заявок — честное «нет данных»; чужая компания и старый сервер не ломают статистику', async () => {
  const none = setup({ reply: (path, params) => path === '/social-stats/reel-attribution' ? report(params.companyCode, { mode: 'NO_DATA', reels: [], themes: [], unmatched: { leads: 0, visits: 0 }, settings: settings() }) : stats(params.companyCode) });
  await none.def.mount(none.el, none.ctx); await settle();
  assert.match(none.el.querySelector('[data-cs-funnel-empty]').textContent, /Нет данных: метки в подписях не включены/);
  assert.match(none.el.querySelector('[data-cs-funnel]').textContent, /НЕТ ДАННЫХ/);
  const foreign = setup({ reply: (path, params) => path === '/social-stats/reel-attribution' ? report('demo-b') : stats(params.companyCode) });
  await foreign.def.mount(foreign.el, foreign.ctx); await settle();
  assert.equal(foreign.el.querySelector('[data-cs-funnel-reel]'), null);
  const old = setup({ reply: (path, params) => { if (path === '/social-stats/reel-attribution') throw Object.assign(new Error('Адрес не найден'), { status: 404 }); return stats(params.companyCode); } });
  await old.def.mount(old.el, old.ctx); await settle();
  assert.match(old.el.querySelector('[data-cs-funnel-empty]').textContent, /после обновления сервера/);
  assert.ok(old.el.querySelector('[data-cs-pubs-empty]'), 'остальная статистика на месте');
});

test('воронка: владелец включает метки — PUT с ревизией и CSRF, подпись настройки обновляется', async () => {
  let saved = settings();
  const { el, def, ctx, calls } = setup({ role: 'owner', reply: (path, params, options) => {
    if (path === '/social-stats/reel-attribution/settings') { const body = JSON.parse(options.body); saved = settings({ enabled: body.enabled, active: body.enabled, revision: body.revision + 1 }); return saved; }
    if (path === '/social-stats/reel-attribution') return report(params.companyCode, { reels: [], themes: [], mode: 'NO_DATA', settings: saved });
    return stats(params.companyCode); } });
  await def.mount(el, ctx); await settle();
  const button = el.querySelector('[data-cs-funnel-toggle="on"]'); assert.ok(button);
  button.click(); await settle(); await settle();
  const put = calls.find((c) => c.path === '/social-stats/reel-attribution/settings');
  assert.equal(put.options.method, 'PUT'); assert.equal(put.options.headers['X-CSRF-Token'], 'csrf-test');
  assert.deepEqual(JSON.parse(put.options.body), { revision: 0, enabled: true });
  assert.match(el.querySelector('[data-cs-funnel-settings]').textContent, /включены — ссылка на https:\/\/demo\.example\.test\//);
  assert.ok(el.querySelector('[data-cs-funnel-toggle="off"]'));
});
