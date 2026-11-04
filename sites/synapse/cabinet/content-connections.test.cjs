'use strict';
/* Контент → Подключения и Статистика: монтирование по контракту А, статусы и метки по фикстурам,
   права и отброс ответа чужой компании. Данные синтетические. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { JSDOM } = require('jsdom');

const connections = (code) => ({ companyCode: code, days: 14, checkedAt: '2026-11-04T12:00:00Z', note: 'Ключи не показываются.', platforms: [
  { id: 'instagram', label: 'Instagram', status: 'green', statusText: 'Подключено, данные приходят', dataMode: 'live', lastDataDate: '2026-11-03', link: null, facts: ['Постинг: Onlypult, ключ есть, проверен.'], next: '' },
  { id: 'metrika', label: 'Яндекс Метрика', status: 'yellow', statusText: 'Подключено, данные в ЛК ещё не приходят', dataMode: 'none', lastDataDate: null, link: null, facts: [], next: 'Доступ к API Метрики (ждёт Влада).' },
  { id: 'vk', label: 'ВКонтакте', status: 'red', statusText: 'Не подключено (в CRM есть только ссылка)', dataMode: 'none', lastDataDate: null, link: 'https://vk.com/demo', facts: [], next: 'Ключ сообщества.' },
  { id: 'max', label: 'MAX', status: 'red', statusText: 'Не подключено', dataMode: 'none', lastDataDate: null, link: 'javascript:alert(1)', facts: ['<img src=x onerror=alert(1)>'], next: '' }] });
const stats = (code) => ({ companyCode: code, from: '2026-10-06', to: '2026-11-04', socialAggregate: { views: 1500, likes: 30, comments: 5 }, platforms: {
  instagram: { totals: { views: 1000, reach: 700, likes: 20, comments: 5 }, latest: { followers: { value: 4200, date: '2026-11-04', provider: 'onlypult' } }, days: { '2026-11-04': { views: { value: 1000, provider: 'onlypult' } } } },
  telegram: { totals: { views: 500, likes: 10 }, latest: {}, days: { '2026-11-03': { views: { value: 500, provider: 'manual' } } }, access: { missing: ['бот не администратор'] } },
  vk: { totals: {}, latest: {}, days: {}, access: { missing: ['аккаунт площадки не настроен в кабинете'] } } } });

function setup({ perms = ['autoposting.view', 'analytics.view'], reply = null } = {}) {
  const dom = new JSDOM('<div id="el"></div>', { url: 'https://cabinet.example.test/', runScripts: 'outside-only' }), w = dom.window, registered = {}, calls = [];
  w.SynapseModules = { register: (id, def) => { registered[id] = def; } };
  for (const file of ['content-connections.js', 'content-stats.js']) w.eval(fs.readFileSync(__dirname + '/' + file, 'utf8'));
  const ctx = { companyCode: 'demo-a', user: { role: 'editor' }, can: (p) => perms.includes(p), signal: new w.AbortController().signal,
    crm: async (path, params) => { calls.push({ path, params }); return reply ? reply(path, params) : path === '/content-connections' ? connections(params.companyCode) : stats(params.companyCode); } };
  return { w, el: w.document.getElementById('el'), registered, calls, ctx };
}

test('регистрация по контракту А: content-connections и content-stats', () => {
  const { registered } = setup();
  assert.deepEqual(Object.keys(registered).sort(), ['content-connections', 'content-stats']);
  assert.equal(registered['content-connections'].title, 'Подключения');
  assert.equal(typeof registered['content-stats'].mount, 'function');
});

test('Подключения: статусы 🟢/🟡/🔴, ссылки только http(s), текст экранируется', async () => {
  const { el, registered, ctx, calls } = setup();
  await registered['content-connections'].mount(el, ctx);
  assert.equal(JSON.stringify(calls[0]), JSON.stringify({ path: '/content-connections', params: { companyCode: 'demo-a' } }));
  const status = (id) => el.querySelector(`[data-cc-platform="${id}"]`).dataset.ccStatus;
  assert.equal(status('instagram'), 'green'); assert.equal(status('metrika'), 'yellow'); assert.equal(status('vk'), 'red');
  assert.match(el.querySelector('[data-cc-summary]').textContent, /🟢 1 .*🟡 1 .*🔴 2/);
  assert.match(el.querySelector('[data-cc-platform="metrika"]').textContent, /данные в ЛК ещё не приходят/);
  assert.equal(el.querySelector('[data-cc-platform="vk"] a').href, 'https://vk.com/demo');
  assert.equal(el.querySelector('[data-cc-platform="max"] a'), null);
  assert.equal(el.querySelector('img'), null);
  assert.match(el.querySelector('[data-cc-platform="instagram"]').textContent, /LIVE/);
});

test('Подключения: без прав — сообщение, без запроса; ответ чужой компании отброшен', async () => {
  const noRights = setup({ perms: [] });
  await noRights.registered['content-connections'].mount(noRights.el, noRights.ctx);
  assert.equal(noRights.calls.length, 0); assert.match(noRights.el.textContent, /по праву/);
  const foreign = setup({ reply: () => connections('demo-b') });
  await foreign.registered['content-connections'].mount(foreign.el, foreign.ctx);
  assert.equal(foreign.el.querySelector('[data-cc-platform]'), null);
});

test('Статистика: сводная таблица и метки LIVE / РУЧНОЙ ВВОД / НЕТ ДАННЫХ', async () => {
  const { el, registered, ctx, calls } = setup();
  await registered['content-stats'].mount(el, ctx);
  assert.equal(calls[0].path, '/social-stats'); assert.equal(calls[0].params.companyCode, 'demo-a');
  const cell = (id, label) => el.querySelector(`[data-cs-row="${id}"] td[data-label="${label}"]`).textContent.replace(/\s/g, ' ');
  assert.equal(cell('instagram', 'Подписчики'), '4 200'); assert.equal(cell('instagram', 'Вовлечённость'), '25');
  assert.equal(cell('instagram', 'Источник'), 'LIVE'); assert.equal(cell('telegram', 'Источник'), 'РУЧНОЙ ВВОД');
  assert.equal(cell('vk', 'Источник'), 'НЕТ ДАННЫХ'); assert.equal(cell('vk', 'Просмотры'), '—'); assert.equal(cell('tiktok', 'Охват'), '—');
  assert.match(el.querySelector('tfoot').textContent, /не суммируется/);
});

test('Статистика: вкладка площадки, период, право analytics.view', async () => {
  const { el, registered, ctx, calls, w } = setup();
  await registered['content-stats'].mount(el, ctx);
  el.querySelector('[data-cs-tab="telegram"]').click();
  assert.match(el.querySelector('[data-cs-platform="telegram"]').textContent, /бот не администратор/);
  assert.match(el.querySelector('.cs-daily').textContent, /ручн\./);
  const select = el.querySelector('[data-cs-days]'); select.value = '7'; select.dispatchEvent(new w.Event('change', { bubbles: true }));
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 2);
  assert.equal((Date.parse(calls[1].params.to) - Date.parse(calls[1].params.from)) / 86400000, 6);
  w.SbCabinet.contentStats.state.tab = 'summary'; w.SbCabinet.contentStats.state.days = 30;
  const noRights = setup({ perms: ['autoposting.view'] });
  await noRights.registered['content-stats'].mount(noRights.el, noRights.ctx);
  assert.equal(noRights.calls.length, 0); assert.match(noRights.el.textContent, /Аналитика: просмотр/);
});
