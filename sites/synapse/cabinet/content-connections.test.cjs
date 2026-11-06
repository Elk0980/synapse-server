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
  telegram: { totals: { views: 500, likes: 10 }, latest: {}, days: { '2026-11-03': { views: { value: 500, provider: 'manual' } } }, access: { missing: ['бот не администратор'] }, lastRun: { date: '2026-11-04', status: 'missing_access' } },
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
  assert.match(el.querySelector('[data-cs-platform="telegram"]').textContent, /04\.11\.2026, нет доступа/);
  assert.match(el.querySelector('.cs-daily').textContent, /ручн\./);
  assert.equal(el.querySelector('a[href="#content-factory/stats"]'), null, 'старая «По публикациям» перенесена сюда');
  const select = el.querySelector('[data-cs-days]'); select.value = '7'; select.dispatchEvent(new w.Event('change', { bubbles: true }));
  await new Promise((r) => setImmediate(r));
  const statCalls = calls.filter((c) => c.path === '/social-stats');
  assert.equal(statCalls.length, 2);
  assert.equal((Date.parse(statCalls[1].params.to) - Date.parse(statCalls[1].params.from)) / 86400000, 6);
  w.SbCabinet.contentStats.state.tab = 'summary'; w.SbCabinet.contentStats.state.days = 30;
  const noRights = setup({ perms: ['autoposting.view'] });
  await noRights.registered['content-stats'].mount(noRights.el, noRights.ctx);
  assert.equal(noRights.calls.length, 0); assert.match(noRights.el.textContent, /Аналитика: просмотр/);
});

/* №208 (пакет E, макет 07.11): шапка CfKit, действия «Подключить»/«Проверить», публикации в статистике. */
function setupKit({ perms = ['autoposting.view', 'autoposting.edit', 'analytics.view'], role = 'editor', reply = null, kit = true } = {}) {
  const dom = new JSDOM('<div id="el"></div><div id="elsewhere"></div>', { url: 'https://cabinet.example.test/', runScripts: 'outside-only', pretendToBeVisual: true }), w = dom.window, registered = {}, calls = [], navigated = [];
  w.SynapseModules = { register: (id, def) => { registered[id] = def; } };
  const files = [...(kit ? ['cf-kit.js'] : []), 'content-connections.js', 'content-stats.js'];
  for (const file of files) w.eval(fs.readFileSync(__dirname + '/' + file, 'utf8'));
  const ctx = { companyCode: 'demo-a', user: { role }, can: (p) => role === 'owner' || perms.includes(p), signal: new w.AbortController().signal,
    navigate: (to) => navigated.push(to),
    crm: async (path, params) => { calls.push({ path, params }); return reply ? reply(path, params) : path === '/content-connections' ? connections(params.companyCode) : stats(params.companyCode); } };
  return { w, el: w.document.getElementById('el'), registered, calls, ctx, navigated };
}
const withSettings = (code) => { const data = connections(code);
  data.platforms[0].settings = { publishing: { provider: 'onlypult', key: true, connected: true } };
  data.platforms.push({ id: 'tiktok', label: 'TikTok', status: 'yellow', statusText: 'Настроено, данных нет', dataMode: 'none', lastDataDate: null, link: null, facts: [], next: 'Профиль TikTok', settings: { publishing: { provider: 'onlypult', key: true, connected: false } } });
  data.platforms.push({ id: 'two_gis', label: '2ГИС', status: 'red', statusText: 'Не подключено', dataMode: 'none', lastDataDate: null, link: null, facts: [], next: '', settings: {} });
  data.platforms.push({ id: 'metrika_x', label: 'Яндекс Метрика 2', status: 'red', statusText: 'Не подключено', dataMode: 'none', lastDataDate: null, link: null, facts: [], next: 'Доступ к API', settings: {} });
  return data; };

test('Подключения: шапка CfKit без календаря (▦, ⇅), сортировка по статусу по умолчанию и по названию', async () => {
  const { el, registered, ctx } = setupKit({ reply: () => withSettings('demo-a') });
  await registered['content-connections'].mount(el, ctx);
  const head = el.querySelector('.cfk-head');
  assert.ok(head); assert.equal(head.querySelector('.cfk-title').textContent, 'Подключения');
  assert.equal(head.querySelector('[data-cfk-act="calendar"]'), null);
  assert.ok(head.querySelector('[data-cfk-act="sheet"]')); assert.ok(head.querySelector('[data-cfk-act="sort"]'));
  const order = () => [...el.querySelectorAll('[data-cc-platform]')].map((n) => n.dataset.ccStatus);
  assert.deepEqual(order(), ['red', 'red', 'red', 'red', 'yellow', 'yellow', 'green']);
  head.querySelector('[data-cfk-act="sort"]').click();
  el.querySelector('[data-cfk-sort="name"]').click();
  const names = [...el.querySelectorAll('[data-cc-platform] h3')].map((n) => n.textContent);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'ru')));
  assert.ok(el.querySelector('.cc-list'), 'карточки — одним списком (одна колонка)');
});

test('Подключения: «Подключить» ведёт к вводу ключа, «Проверить» — к существующей проверке доступа', async () => {
  const { el, registered, ctx, navigated, w } = setupKit({ reply: () => withSettings('demo-a') });
  await registered['content-connections'].mount(el, ctx);
  const btn = (id, act) => el.querySelector(`[data-cc-platform="${id}"] [data-cc-act="${act}"]`);
  assert.ok(btn('instagram', 'check'), 'подключённый канал: «Проверить»');
  assert.equal(btn('instagram', 'connect'), null);
  assert.ok(btn('tiktok', 'connect') && btn('tiktok', 'check'), 'ключ есть, но не проверен: оба действия');
  assert.equal(btn('vk', 'connect').dataset.ccTarget, 'vk');
  assert.equal(btn('max', 'connect').dataset.ccTarget, 'max');
  assert.ok(btn('two_gis', 'gis'));
  assert.equal(el.querySelector('[data-cc-platform="metrika_x"] [data-cc-act]'), null, 'без существующего ввода ключа кнопки нет');
  assert.equal(el.querySelector('[data-cc-platform="metrika"] [data-cc-act]'), null);
  // Форма Постинга появляется после перехода: раскрывается «Подключение площадок» и фокус встаёт в поле ключа.
  const other = w.document.getElementById('elsewhere');
  other.innerHTML = '<details class="autoposting-connections"><summary>Подключение площадок</summary><div id="autoposting-channels"><form data-channel="vk"><input data-channel-field="token" type="password"><button type="button" data-check-channel="vk">Проверить доступ</button></form></div></details>';
  btn('vk', 'connect').click();
  assert.deepEqual(navigated, ['content/posting']);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(other.querySelector('details').open, true);
  assert.equal(w.document.activeElement, other.querySelector('[data-channel-field="token"]'));
  let checked = 0; other.querySelector('[data-check-channel]').addEventListener('click', () => { checked += 1; });
  other.querySelector('form').dataset.channel = 'instagram';
  btn('instagram', 'check').click();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(checked, 1);
});

test('Подключения: без права на каналы кнопки выключены; статистика ВК без канала ведёт к аккаунтам (владелец)', async () => {
  const viewer = setupKit({ perms: ['autoposting.view'], reply: () => withSettings('demo-a') });
  await viewer.registered['content-connections'].mount(viewer.el, viewer.ctx);
  assert.equal(viewer.el.querySelector('[data-cc-platform="vk"] [data-cc-act="connect"]').disabled, true);
  const data = withSettings('demo-a'); data.platforms.find((p) => p.id === 'vk').settings = { publishing: { key: true, connected: true } };
  const owner = setupKit({ role: 'owner', reply: () => data });
  await owner.registered['content-connections'].mount(owner.el, owner.ctx);
  const stats = owner.el.querySelector('[data-cc-platform="vk"] [data-cc-act="stats"]');
  assert.ok(stats); assert.equal(stats.disabled, false); stats.click();
  assert.deepEqual(owner.navigated, ['social-stats']);
});

const statsWithPosts = (code) => { const data = stats(code);
  data.crm = { posts: [
    { platform: 'instagram', url: 'https://example.test/p/1', publishedAt: '2026-11-03T05:00:00Z', attribution: 'exact', leads: 2, autopostingId: 7 },
    { platform: 'vk', url: 'https://example.test/vk/1', publishedAt: '2026-11-03T06:00:00Z', attribution: 'none_in_period', leads: 0, autopostingId: 7 },
    { platform: 'telegram', url: 'https://example.test/tg/9', publishedAt: '2026-11-01T06:00:00Z', attribution: 'unknown', leads: 0, autopostingId: null }] };
  const meas = (metric, value) => ({ metric, value, hasValue: value !== null });
  data.postMetrics = { posts: [
    { platform: 'instagram', url: 'https://example.test/p/1', publishedAt: '2026-11-03T05:00:00Z', sources: [{ measurements: [meas('views', 900), meas('likes', 30), meas('comments', 4)] }] },
    { platform: 'vk', url: 'https://example.test/vk/1', publishedAt: '2026-11-03T06:00:00Z', sources: [{ measurements: [meas('views', null)] }] },
    { platform: 'telegram', url: 'https://example.test/tg/9', publishedAt: '2026-11-01T06:00:00Z', sources: [{ measurements: [meas('views', 1200)] }] }] };
  return data; };

test('Статистика: шапка CfKit (календарь, ▦, ⇅ с 4 пунктами), публикации — реальные числа, нет данных — прочерк', async () => {
  const { el, registered, ctx, calls } = setupKit({ reply: (path, params) => path === '/autoposting/calendar' ? { companyCode: params.companyCode, posts: [{ id: 7, title: 'Первый визит' }] } : statsWithPosts(params.companyCode) });
  await registered['content-stats'].mount(el, ctx);
  assert.ok(calls.some((c) => c.path === '/autoposting/calendar'));
  const head = el.querySelector('.cfk-head');
  assert.ok(head.querySelector('[data-cfk-act="calendar"]') && head.querySelector('[data-cfk-act="sheet"]'));
  head.querySelector('[data-cfk-act="sort"]').click();
  assert.deepEqual([...el.querySelectorAll('[data-cfk-sort]')].map((n) => n.dataset.cfkSort), ['date', 'views', 'engagement', 'leads']);
  const rows = [...el.querySelectorAll('[data-cs-pub]')];
  assert.equal(rows.length, 2, 'один материал на двух площадках — одна строка');
  const reel = el.querySelector('[data-cs-pub="card:7"]'), cell = (row, label) => row.querySelector(`td[data-label="${label}"]`).textContent.trim();
  assert.match(reel.querySelector('th').textContent, /Первый визит/);
  assert.equal(cell(reel, 'Instagram'), '900'); assert.equal(cell(reel, 'ВКонтакте'), '—'); assert.equal(cell(reel, 'TikTok'), '·');
  assert.equal(reel.querySelector('td[data-label="ВКонтакте"] .cs-dash').title, 'нет данных с площадки');
  assert.equal(cell(reel, 'Просмотры'), '900'); assert.equal(cell(reel, 'Вовлечённость'), '34'); assert.equal(cell(reel, 'Заявки'), '2');
  const tg = rows.find((r) => r !== reel);
  assert.equal(cell(tg, 'Заявки'), '—', 'связь с заявками не подтверждена — не ноль');
  assert.equal(rows[0], reel, 'по умолчанию — новые публикации сверху');
  el.querySelector('[data-cfk-sort="views"]').click();
  assert.equal(el.querySelector('[data-cs-pub]').dataset.csPub, tg.dataset.csPub, 'по просмотрам — 1200 выше 900');
  assert.ok(el.querySelector('[data-cs-summary]'), 'сводная таблица по площадкам остаётся');
});

test('Статистика: календарь показывает полосу дат с отметками публикаций; вкладка площадки — её публикации', async () => {
  const { el, registered, ctx } = setupKit({ reply: (path, params) => statsWithPosts(params.companyCode) });
  await registered['content-stats'].mount(el, ctx);
  const strip = el.querySelector('.cfk-dates');
  assert.ok(strip); assert.equal(strip.hidden, true);
  el.querySelector('[data-cfk-act="calendar"]').click();
  assert.equal(el.querySelector('.cfk-dates').hidden, false);
  assert.ok(el.querySelector('.cfk-day.has[data-cfk-day="2026-11-03"]'));
  el.querySelector('[data-cs-tab="instagram"]').click();
  assert.equal(el.querySelector('.cfk-dates').hidden, false, 'полоса дат не пропадает при смене вкладки');
  const rows = el.querySelectorAll('[data-cs-platform="instagram"] [data-cs-pub]');
  assert.equal(rows.length, 1); assert.match(rows[0].querySelector('th').textContent, /Материал №7/);
  assert.equal(rows[0].querySelector('td[data-label="Заявки"]').textContent.trim(), '2');
  el.querySelector('[data-cs-tab="tiktok"]').click();
  assert.ok(el.querySelector('[data-cs-pubs-empty]'));
});

test('Статистика и Подключения работают без CfKit (прежний заголовок)', async () => {
  const { el, registered, ctx } = setupKit({ kit: false, reply: (path, params) => path === '/content-connections' ? withSettings(params.companyCode) : statsWithPosts(params.companyCode) });
  await registered['content-stats'].mount(el, ctx);
  assert.equal(el.querySelector('h1').textContent, 'Статистика'); assert.equal(el.querySelectorAll('[data-cs-pub]').length, 2);
  await registered['content-connections'].mount(el, ctx);
  assert.equal(el.querySelector('h1').textContent, 'Подключения');
});
