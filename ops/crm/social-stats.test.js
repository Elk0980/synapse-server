'use strict';
/* Аналитика соцсетей: идемпотентные снимки, UNKNOWN ≠ 0, границы локального дня по поясу аккаунта, изоляция компаний, честные статусы
   адаптеров без клиентских идентификаторов, ежедневный сбор (итог за закрытый день, текущий — partial с обновлением), ручной импорт
   с источником, атрибуция без задвоения по площадкам. Все идентификаторы в тестах вымышленные. */
const test = require('node:test'), assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createSocialStats, localDay, dayBounds } = require('./social-stats');
const { createSocialAdapters, NEED } = require('./social-adapters');

function fixture(t, { adapters, transport } = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY, code TEXT UNIQUE COLLATE NOCASE, name TEXT, timezone TEXT, is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies(id,code,name,timezone) VALUES(1,'demo-a','Компания А','Asia/Bangkok'),(2,'demo-b','Компания Б','Asia/Irkutsk');
    CREATE TABLE leads(id INTEGER PRIMARY KEY, company_code TEXT, created_at TEXT, stage TEXT, sale_amount REAL, source TEXT, utm_source TEXT, utm_content TEXT, utm_campaign TEXT, referrer TEXT, landing_page TEXT);`);
  const clock = { ms: Date.parse('2026-09-18T01:30:00Z') }; // 08:30 Бангкок
  const stats = createSocialStats(db, { now: () => clock.ms, adapters: adapters || createSocialAdapters({ transport }), logger: { warn() {} } });
  return { db, stats, clock };
}
const rejects = (fn, code) => { try { fn(); } catch (e) { assert.equal(e.code, code, e.message); return e; } assert.fail('expected ' + code); };
const lead = (db, values) => db.prepare(`INSERT INTO leads(company_code,created_at,stage,sale_amount,source,utm_source,utm_content,utm_campaign,referrer,landing_page) VALUES(?,?,?,?,?,?,?,?,?,?)`)
  .run(values.code || 'demo-a', values.at || '2026-09-17T05:00:00.000Z', values.stage || 'новая', values.amount ?? null, values.source ?? null, values.utmSource ?? null, values.content ?? null, values.campaign ?? null, values.referrer ?? null, values.landing ?? null);

test('локальный день и его границы считаются в часовом поясе аккаунта, а не в UTC и не в фиксированном +07:00', () => {
  assert.equal(localDay(Date.parse('2026-09-17T18:30:00Z'), 'Asia/Bangkok'), '2026-09-18', '01:30 Бангкок — уже следующий день');
  assert.equal(localDay(Date.parse('2026-09-17T18:30:00Z'), 'UTC'), '2026-09-17');
  assert.deepEqual(dayBounds('2026-09-17', 'Asia/Bangkok'), { startMs: Date.parse('2026-09-16T17:00:00Z'), endMs: Date.parse('2026-09-17T17:00:00Z') });
  assert.deepEqual(dayBounds('2026-09-17', 'Asia/Irkutsk'), { startMs: Date.parse('2026-09-16T16:00:00Z'), endMs: Date.parse('2026-09-17T16:00:00Z') }, 'другой пояс — другие границы');
  assert.deepEqual(dayBounds('2026-03-29', 'Europe/Berlin'), { startMs: Date.parse('2026-03-28T23:00:00Z'), endMs: Date.parse('2026-03-29T22:00:00Z') }, 'день перехода на летнее время длится 23 часа');
  assert.throws(() => dayBounds('2026-9-1', 'UTC'));
});

test('снимки идемпотентны, null остаётся UNKNOWN (не ноль), отток подписчиков — законное отрицательное число; чужая компания изолирована', (t) => {
  const f = fixture(t);
  f.stats.saveAccounts('demo-a', { accounts: [{ platform: 'telegram', accountRef: '@demo_channel', provider: 'manual', revision: 0 }] });
  const rows = [{ date: '2026-09-17', metric: 'views', value: 120, sourceField: 'views', completeness: 'complete', kind: 'organic' }, { date: '2026-09-17', metric: 'reach', value: null, completeness: 'unknown' }];
  f.stats.writeSnapshots('demo-a', 'telegram', '@demo_channel', rows, { provider: 'manual', tz: 'Asia/Bangkok' });
  f.stats.writeSnapshots('demo-a', 'telegram', '@demo_channel', [{ ...rows[0], value: 130 }], { provider: 'manual', tz: 'Asia/Bangkok' });
  assert.equal(f.db.prepare('SELECT count(*) n FROM social_snapshots').get().n, 2, 'повтор обновляет, не дублирует');
  assert.equal(f.stats.writeSnapshots('demo-a', 'telegram', '@demo_channel', [{ date: '2026-09-17', metric: 'follower_change', value: -7, completeness: 'complete' }], { provider: 'manual', tz: 'Asia/Bangkok' }), 1, 'отток записывается');
  rejects(() => f.stats.writeSnapshots('demo-a', 'telegram', '@demo_channel', [{ date: '2026-09-17', metric: 'views', value: -1 }], { provider: 'manual', tz: 'Asia/Bangkok' }), 'VALIDATION_ERROR');
  f.stats.writeSnapshots('demo-a', 'vk', 'club1', [{ date: '2026-09-17', metric: 'views', value: 70, kind: 'paid' }, { date: '2026-09-17', metric: 'reach', value: 50 }], { provider: 'manual', tz: 'Asia/Bangkok' });
  const view = f.stats.overview('demo-a', '2026-09-17', '2026-09-17');
  assert.equal(view.platforms.telegram.totals.views, 130); assert.equal(view.platforms.telegram.totals.reach, null, 'нет данных — null');
  assert.equal(view.platforms.telegram.totals.follower_change, -7);
  assert.equal(view.platforms.telegram.dataStatus, 'partial');
  assert.equal(view.socialAggregate.views, 200); assert.equal(view.socialAggregate.reach, null, 'уникальный охват не выдумывается');
  assert.match(view.socialAggregate.reachNote, /не суммируется/);
  assert.deepEqual(view.platforms.vk.kinds.sort(), ['paid', 'unknown']);
  assert.equal(view.platforms.instagram.dataStatus, 'no_data'); assert.equal(view.platforms.instagram.access.status, 'not_configured');
  const other = f.stats.overview('demo-b', '2026-09-17', '2026-09-17');
  assert.equal(other.socialAggregate.views, null); assert.equal(other.platforms.telegram.configured, false);
  rejects(() => f.stats.overview('nope', '2026-09-17', '2026-09-17'), 'NOT_FOUND');
  rejects(() => f.stats.writeSnapshots('demo-a', 'vk', '', [{ date: '2026-09-17', metric: 'magic', value: 1 }], { provider: 'manual', tz: 'Asia/Bangkok' }), 'VALIDATION_ERROR');
  rejects(() => f.stats.writeSnapshots('demo-a', 'vk', '', [{ date: '2026-9-17', metric: 'views', value: 1 }], { provider: 'manual', tz: 'Asia/Bangkok' }), 'VALIDATION_ERROR');
});

test('сводка: проценты и средние усредняются, не суммируются; подписчики — состояние; история прежнего account_ref не смешивается с текущим', (t) => {
  const f = fixture(t);
  f.stats.saveAccounts('demo-a', { accounts: [{ platform: 'youtube', accountRef: 'channel-new', provider: 'manual', revision: 0 }] });
  const write = (ref, rows) => f.stats.writeSnapshots('demo-a', 'youtube', ref, rows, { provider: 'manual', tz: 'Asia/Bangkok' });
  write('channel-new', [{ date: '2026-09-16', metric: 'retention_percent', value: 40 }, { date: '2026-09-17', metric: 'retention_percent', value: 60 },
    { date: '2026-09-16', metric: 'avg_watch_seconds', value: 10 }, { date: '2026-09-17', metric: 'avg_watch_seconds', value: 30 }, { date: '2026-09-16', metric: 'views', value: 5 }, { date: '2026-09-17', metric: 'views', value: 7 },
    { date: '2026-09-17', metric: 'followers', value: 100, period: 'lifetime' }]);
  write('channel-old', [{ date: '2026-09-16', metric: 'views', value: 1000 }, { date: '2026-09-17', metric: 'followers', value: 9000, period: 'lifetime' }]);
  const yt = f.stats.overview('demo-a', '2026-09-16', '2026-09-17').platforms.youtube;
  assert.equal(yt.totals.retention_percent, 50, 'среднее, а не 100');
  assert.equal(yt.totals.avg_watch_seconds, 20); assert.equal(yt.totals.views, 12);
  assert.deepEqual(yt.aggregation, { retention_percent: 'avg', avg_watch_seconds: 'avg', views: 'sum' });
  assert.equal(yt.latest.followers.value, 100, 'подписчики текущего аккаунта, не прежнего');
  assert.equal(yt.accountRef, 'channel-new');
  assert.deepEqual(yt.history, [{ accountRef: 'channel-old', totals: { views: 1000 }, days: 1 }], 'прежний аккаунт — отдельной группой');
  const view = f.stats.overview('demo-a', '2026-09-16', '2026-09-17');
  assert.equal(view.socialAggregate.views, 12, 'история прежнего аккаунта в общий агрегат не попадает');
  assert.equal(view.aggregation.retention_percent, 'avg');
});

test('адаптеры честно сообщают, чего недостаёт, подставляя аккаунт компании, а не зашитые идентификаторы; Onlypult — не подключён; журнал запусков это хранит', async (t) => {
  const f = fixture(t, { transport: null });
  f.stats.saveAccounts('demo-a', { accounts: ['instagram', 'tiktok', 'youtube'].map((platform) => ({ platform, accountRef: `@demo_${platform}`, provider: 'direct', revision: 0 })).concat([{ platform: 'vk', accountRef: 'club777', provider: 'onlypult', revision: 0 }]) });
  for (const platform of ['instagram', 'tiktok', 'youtube']) {
    const run = await f.stats.collect('demo-a', platform);
    assert.equal(run.status, 'missing_access'); assert.ok(run.missing.length >= 2, platform); assert.match(run.missing.join(' '), /решение владельца/);
    assert.match(run.missing.join(' '), new RegExp(`@demo_${platform}`), 'аккаунт из настроек компании');
    assert.doesNotMatch(run.missing.join(' '), /\{account\}/);
  }
  assert.doesNotMatch(JSON.stringify(NEED), /taisabai|UCT|club240/i, 'в общих шаблонах нет клиентских идентификаторов');
  const vk = await f.stats.collect('demo-a', 'vk'); assert.equal(vk.status, 'unsupported'); assert.match(vk.missing[0], /не покрывает ВКонтакте/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM social_snapshots').get().n, 0, 'без доступа — ни одной цифры');
  const view = f.stats.overview('demo-a', '2026-09-01', '2026-09-18');
  assert.equal(view.runs.length, 4); assert.equal(view.platforms.instagram.lastRun.status, 'missing_access');
  assert.doesNotMatch(JSON.stringify(view), /token|Bearer/i);
  const none = await f.stats.collect('demo-a', 'telegram'); assert.equal(none.status, 'unsupported');
  assert.match(none.missing[0], /не настроен/);
  const b = f.stats.accounts('demo-b').accounts.find((a) => a.platform === 'vk');
  assert.equal(b.access.status, 'not_configured');
});

test('Telegram и ВКонтакте через сохранённые подключения: подписчики и суточные показатели в поясе аккаунта; отток отрицателен; отказ площадки → missing_access без чисел', async (t) => {
  const calls = [];
  const transport = { async readStats(code, id, method, params) { calls.push({ code, id, method, params });
    if (id === 'telegram') return { provider: 'direct', target: '@demo_channel', result: 1234 };
    if (method === 'groups.getById') return { provider: 'direct', target: '777', result: { groups: [{ id: 777, members_count: 87 }] } };
    if (method === 'stats.get') return { provider: 'direct', target: '777', result: [{ period_from: 1, visitors: { views: 40, visitors: 30 }, reach: { reach: 25 }, activity: { likes: 3, comments: 1, copies: 2, subscribed: 1, unsubscribed: 4 } }] };
    return null; } };
  const f = fixture(t, { transport });
  f.stats.saveAccounts('demo-b', { accounts: [{ platform: 'telegram', accountRef: '@demo_channel', provider: 'direct', timezone: 'Asia/Irkutsk', revision: 0 }, { platform: 'vk', accountRef: 'club777', provider: 'direct', timezone: 'Asia/Irkutsk', revision: 0 }] });
  const tg = await f.stats.collect('demo-b', 'telegram', { date: '2026-09-17' });
  assert.equal(tg.status, 'partial'); assert.equal(tg.rows, 1); assert.match(tg.missing[0], /Bot API/); assert.equal(tg.closed, true);
  const vk = await f.stats.collect('demo-b', 'vk', { date: '2026-09-17' });
  assert.equal(vk.status, 'ok'); assert.equal(vk.rows, 7);
  const stats = calls.find((c) => c.method === 'stats.get').params;
  assert.equal(stats.timestamp_from, Math.floor(Date.parse('2026-09-17T00:00:00+08:00') / 1000), 'сутки в поясе аккаунта (Иркутск), а не +07:00');
  assert.equal(stats.timestamp_to, Math.floor(Date.parse('2026-09-17T23:59:59+08:00') / 1000));
  const view = f.stats.overview('demo-b', '2026-09-17', '2026-09-18');
  assert.equal(view.platforms.telegram.latest.followers.date, '2026-09-18', 'подписчики датированы днём снятия');
  assert.equal(view.platforms.telegram.latest.followers.value, 1234); assert.equal(view.platforms.vk.latest.followers.value, 87);
  assert.equal(view.platforms.vk.totals.views, 40); assert.equal(view.platforms.vk.totals.reach, 25); assert.equal(view.platforms.vk.totals.follower_change, -3, 'отток не роняет сбор');
  assert.equal(view.platforms.vk.dataStatus, 'complete', 'закрытый день — итог');
  assert.equal(view.socialAggregate.reach, null);
  const denied = fixture(t, { transport: { async readStats() { throw Object.assign(new Error('x'), { code: 'ACCESS_DENIED' }); } } });
  denied.stats.saveAccounts('demo-a', { accounts: [{ platform: 'vk', accountRef: 'club1', provider: 'direct', revision: 0 }] });
  const run = await denied.stats.collect('demo-a', 'vk'); assert.equal(run.status, 'missing_access'); assert.match(run.missing[0], /ACCESS_DENIED/); assert.match(run.missing[1], /club1/);
  assert.equal(denied.db.prepare('SELECT count(*) n FROM social_snapshots').get().n, 0);
  await assert.rejects(denied.stats.collect('demo-a', 'vk', { date: '2026-09-19' }), (e) => e.code === 'VALIDATION_ERROR', 'будущий день не собирается');
});

test('текущий день — только partial и обновляется; закрытый день — complete один раз после часа сбора; lifetime отдельно; повтор ничего не дублирует', async (t) => {
  let served = 0;
  const transport = { async readStats(code, id, method) { served += 1;
    if (method === 'groups.getById') return { provider: 'direct', target: '1', result: { groups: [{ id: 1, members_count: 100 + served }] } };
    if (method === 'stats.get') return { provider: 'direct', target: '1', result: [{ visitors: { views: 10 * served }, reach: { reach: 5 }, activity: {} }] };
    return null; } };
  const f = fixture(t, { transport });
  f.stats.saveAccounts('demo-a', { accounts: [{ platform: 'vk', accountRef: 'club1', provider: 'direct', collectHour: 9, revision: 0 }, { platform: 'telegram', accountRef: '@m', provider: 'manual', revision: 0 }] });
  const early = await f.stats.collectDue(); // 08:30 Бангкок — до часа сбора: итог за вчера рано, текущий день обновляется
  assert.deepEqual(early.map((r) => [r.date, r.closed, r.status]), [['2026-09-18', false, 'partial']]);
  assert.deepEqual(await f.stats.collectDue(), [], 'повтор через минуты — ничего');
  f.clock.ms = Date.parse('2026-09-18T02:05:00Z'); // 09:05 Бангкок
  const morning = await f.stats.collectDue();
  assert.deepEqual(morning.map((r) => [r.date, r.closed, r.status]), [['2026-09-17', true, 'ok']], 'итог за вчера; текущий день обновлён меньше часа назад');
  f.clock.ms = Date.parse('2026-09-18T12:00:00Z'); // 19:00 Бангкок — вечер
  const evening = await f.stats.collectDue();
  assert.deepEqual(evening.map((r) => [r.date, r.closed, r.status]), [['2026-09-18', false, 'partial']], 'вечерняя активность попадает в текущий день');
  const view = f.stats.overview('demo-a', '2026-09-17', '2026-09-18').platforms.vk;
  assert.equal(view.days['2026-09-17'].views.completeness, 'complete'); assert.equal(view.days['2026-09-18'].views.completeness, 'partial');
  assert.equal(view.days['2026-09-18'].views.value, 10 * served, 'обновлено последним сбором');
  assert.deepEqual(f.db.prepare("SELECT date, value FROM social_snapshots WHERE period='lifetime' AND metric='followers' ORDER BY date").all().map((r) => ({ ...r })), [{ date: '2026-09-18', value: 100 + served - 1 }],
    'подписчики датированы днём снятия (сегодня), сбор итога за вчера не создал вчерашней строки');
  assert.equal(f.db.prepare("SELECT count(*) n FROM social_snapshots WHERE period='day' AND metric='views'").get().n, 2, 'обновления дня не плодят строки');
  f.clock.ms = Date.parse('2026-09-19T03:00:00Z');
  const next = await f.stats.collectDue();
  assert.deepEqual(next.map((r) => [r.date, r.closed]), [['2026-09-18', true], ['2026-09-19', false]], 'на следующий день вчерашний становится итогом');
  assert.equal(f.stats.overview('demo-a', '2026-09-18', '2026-09-18').platforms.vk.days['2026-09-18'].views.completeness, 'complete');
  assert.equal(f.db.prepare("SELECT count(*) n FROM social_snapshots WHERE period='lifetime' AND metric='followers'").get().n, 2, 'на следующий день — вторая точка истории подписчиков');
});

test('сбор итога за вчера не переписывает историю подписчиков: lifetime датируется моментом снятия', async (t) => {
  const transport = { async readStats() { return { provider: 'direct', target: '@c', result: 900 }; } };
  const f = fixture(t, { transport });
  f.stats.saveAccounts('demo-a', { accounts: [{ platform: 'telegram', accountRef: '@c', provider: 'direct', revision: 0 }] });
  f.stats.writeSnapshots('demo-a', 'telegram', '@c', [{ date: '2026-09-17', metric: 'followers', value: 850, period: 'lifetime', completeness: 'complete' }], { provider: 'direct', tz: 'Asia/Bangkok' });
  const run = await f.stats.collect('demo-a', 'telegram', { date: '2026-09-17' });
  assert.equal(run.closed, true); assert.equal(run.rows, 1);
  assert.deepEqual(f.db.prepare("SELECT date, value FROM social_snapshots WHERE metric='followers' ORDER BY date").all().map((r) => ({ ...r })), [{ date: '2026-09-17', value: 850 }, { date: '2026-09-18', value: 900 }],
    'вчерашние 850 сохранены, сегодняшние 900 — новой датой');
  const view = f.stats.overview('demo-a', '2026-09-17', '2026-09-17');
  assert.equal(view.platforms.telegram.latest.followers.value, 850, 'на дату 17.09 показывается снимок 17.09');
});

test('ответ, пришедший после смены подключения площадки (токен/цель) без изменения social_accounts, отбрасывается', async (t) => {
  let release, fingerprint = 'direct:1:@c';
  const transport = { readStats: () => new Promise((resolve) => { release = () => resolve({ provider: 'direct', target: '@c', result: 5 }); }), connectionRevision: () => ({ provider: 'direct', revision: Number(fingerprint.split(':')[1]), target: fingerprint.split(':')[2] }) };
  const f = fixture(t, { transport });
  f.stats.saveAccounts('demo-a', { accounts: [{ platform: 'telegram', accountRef: '@c', provider: 'direct', revision: 0 }] });
  const pending = f.stats.collect('demo-a', 'telegram', { date: '2026-09-17' });
  await new Promise((r) => setImmediate(r));
  fingerprint = 'direct:2:@c'; // владелец пересохранил токен — ревизия подключения выросла, social_accounts не менялись
  release();
  const run = await pending;
  assert.equal(run.status, 'failed'); assert.match(run.error, /Подключение площадки изменилось/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM social_snapshots').get().n, 0);
  const ok = f.stats.collect('demo-a', 'telegram', { date: '2026-09-17' }); // без смены — принимается
  await new Promise((r) => setImmediate(r)); release();
  assert.equal((await ok).status, 'partial');
});

test('после смены аккаунта прежний missing_access не блокирует сбор до завтра: запуски привязаны к ревизии', async (t) => {
  let served = 0, denied = true;
  const transport = { async readStats() { served += 1; if (denied) throw Object.assign(new Error('x'), { code: 'ACCESS_DENIED' }); return { provider: 'direct', target: '@ok', result: 42 }; } };
  const f = fixture(t, { transport });
  const saved = f.stats.saveAccounts('demo-a', { accounts: [{ platform: 'telegram', accountRef: '@old', provider: 'direct', collectHour: 0, revision: 0 }] });
  const first = await f.stats.collectDue();
  assert.deepEqual(first.map((r) => r.status), ['missing_access', 'missing_access'], 'вчера и сегодня — без доступа');
  assert.deepEqual(await f.stats.collectDue(), [], 'без изменений повтор не дёргает площадку');
  denied = false;
  f.stats.saveAccounts('demo-a', { accounts: [{ platform: 'telegram', accountRef: '@ok', provider: 'direct', collectHour: 0, revision: saved.accounts.find((a) => a.platform === 'telegram').revision }] });
  const after = await f.stats.collectDue();
  assert.deepEqual(after.map((r) => [r.date, r.status]), [['2026-09-17', 'partial'], ['2026-09-18', 'partial']], 'новый аккаунт собирается сразу, не завтра');
  assert.equal(served, 4);
  assert.equal(f.db.prepare("SELECT value FROM social_snapshots WHERE metric='followers' AND account_ref='@ok'").get().value, 42);
});

test('пересохранённое подключение площадки снимает подавление после missing_access в тот же день: в журнале — необратимый отпечаток ревизии', async (t) => {
  let revision = 1, denied = true, served = 0;
  const transport = { connectionRevision: () => ({ provider: 'direct', revision, target: '@c' }),
    async readStats() { served += 1; if (denied) throw Object.assign(new Error('x'), { code: 'ACCESS_DENIED' }); return { provider: 'direct', target: '@c', result: 77 }; } };
  const f = fixture(t, { transport });
  f.stats.saveAccounts('demo-a', { accounts: [{ platform: 'telegram', accountRef: '@c', provider: 'direct', collectHour: 0, revision: 0 }] });
  const first = await f.stats.collectDue();
  assert.deepEqual(first.map((r) => r.status), ['missing_access', 'missing_access'], 'вчера и сегодня — без доступа');
  assert.deepEqual(await f.stats.collectDue(), [], 'ревизия подключения не менялась — площадку не дёргаем');
  assert.equal(served, 2);
  denied = false; revision = 2; // владелец пересохранил токен подключения: social_accounts не менялись, account_ref и revision прежние
  const after = await f.stats.collectDue();
  assert.deepEqual(after.map((r) => [r.date, r.status]), [['2026-09-17', 'partial'], ['2026-09-18', 'partial']], 'после восстановления подключения сбор идёт в тот же день, а не завтра');
  assert.equal(served, 4);
  assert.equal(f.db.prepare("SELECT value FROM social_snapshots WHERE metric='followers'").get().value, 77);
  const fps = f.db.prepare('SELECT connection_fp FROM social_collect_runs ORDER BY id').all().map((r) => r.connection_fp);
  for (const fp of fps) assert.match(fp, /^[0-9a-f]{64}$/, 'в журнале только SHA256, не сама ревизия');
  assert.notEqual(fps[0], fps.at(-1), 'другая ревизия подключения — другой отпечаток');
  assert.equal(new Set(fps.slice(0, 2)).size, 1, 'одна ревизия — один отпечаток');
  assert.doesNotMatch(JSON.stringify(fps), /direct|@c|:/, 'отпечаток необратим: исходной ревизии и цели в журнале нет');
});

test('при неизменной ревизии подключения расписание не делает лишних повторов', async (t) => {
  let served = 0;
  const transport = { connectionRevision: () => ({ provider: 'direct', revision: 7, target: '@c' }), async readStats() { served += 1; return { provider: 'direct', target: '@c', result: 100 + served }; } };
  const f = fixture(t, { transport });
  f.stats.saveAccounts('demo-a', { accounts: [{ platform: 'telegram', accountRef: '@c', provider: 'direct', collectHour: 0, revision: 0 }] });
  assert.deepEqual((await f.stats.collectDue()).map((r) => [r.date, r.closed]), [['2026-09-17', true], ['2026-09-18', false]]);
  assert.deepEqual(await f.stats.collectDue(), [], 'повтор сразу — ничего');
  f.clock.ms += 30 * 60 * 1000;
  assert.deepEqual(await f.stats.collectDue(), [], 'через полчаса текущий день ещё не обновляется');
  f.clock.ms += 31 * 60 * 1000;
  assert.deepEqual((await f.stats.collectDue()).map((r) => [r.date, r.closed]), [['2026-09-18', false]], 'через час обновляется только текущий день, итог за вчера не пересобирается');
  assert.equal(served, 3);
  assert.equal(f.db.prepare('SELECT count(DISTINCT connection_fp) n FROM social_collect_runs').get().n, 1, 'ревизия не менялась — отпечаток стабилен');
  assert.equal(f.db.prepare('SELECT count(*) n FROM social_collect_runs').get().n, 3, 'лишних запусков в журнале нет');
});

test('нечитаемая ревизия подключения — это не «подключения нет»: failed без чисел и без запроса к площадке; расписание доводит остальные аккаунты', async (t) => {
  const served = [];
  const transport = {
    connectionRevision(code, platform) { if (platform === 'telegram') throw Object.assign(new Error('хранилище подключений недоступно: token=abc'), { code: 'VAULT_UNAVAILABLE' }); return { provider: 'direct', revision: 3, target: 'club1' }; },
    async readStats(code, id, method) { served.push(`${id}.${method}`);
      if (method === 'groups.getById') return { provider: 'direct', target: '1', result: { groups: [{ id: 1, members_count: 50 }] } };
      if (method === 'stats.get') return { provider: 'direct', target: '1', result: [{ visitors: { views: 10 }, reach: { reach: 5 }, activity: {} }] };
      return { provider: 'direct', target: '@c', result: 900 }; } };
  const f = fixture(t, { transport });
  f.stats.saveAccounts('demo-a', { accounts: [{ platform: 'telegram', accountRef: '@c', provider: 'direct', collectHour: 0, revision: 0 }, { platform: 'vk', accountRef: 'club1', provider: 'direct', collectHour: 0, revision: 0 }] });
  const runs = await f.stats.collectDue();
  assert.deepEqual(runs.map((r) => [r.platform, r.date, r.status]).sort(), [['telegram', '2026-09-17', 'failed'], ['telegram', '2026-09-18', 'failed'], ['vk', '2026-09-17', 'ok'], ['vk', '2026-09-18', 'partial']],
    'сбойный аккаунт не отменяет расписание следующего, исправного');
  assert.equal(f.db.prepare("SELECT count(*) n FROM social_snapshots WHERE platform='telegram'").get().n, 0, 'ревизия не прочитана — ни одной цифры');
  assert.deepEqual(served.filter((c) => c.startsWith('telegram')), [], 'площадку без читаемой ревизии не дёргаем');
  assert.equal(f.db.prepare("SELECT value FROM social_snapshots WHERE platform='vk' AND metric='followers'").get().value, 50, 'исправный аккаунт собран');
  const failed = f.db.prepare("SELECT error, status, connection_fp FROM social_collect_runs WHERE platform='telegram' ORDER BY id").all();
  assert.deepEqual(failed.map((r) => r.status), ['failed', 'failed'], 'оба запуска в журнале — failed');
  assert.match(failed[0].error, /Ревизия подключения площадки не прочитана/);
  assert.doesNotMatch(JSON.stringify(failed), /token|VAULT|хранилище/i, 'ни исключения, ни секретов в журнале');
});

test('чтение ревизии подключения сорвалось после ответа провайдера: ответ отброшен, а не засчитан как совпавшая ревизия', async (t) => {
  let release, broken = false;
  const transport = { connectionRevision: () => { if (broken) throw Object.assign(new Error('x'), { code: 'VAULT_UNAVAILABLE' }); return { provider: 'direct', revision: 1, target: '@c' }; },
    readStats: () => new Promise((resolve) => { release = () => resolve({ provider: 'direct', target: '@c', result: 5 }); }) };
  const f = fixture(t, { transport });
  f.stats.saveAccounts('demo-a', { accounts: [{ platform: 'telegram', accountRef: '@c', provider: 'direct', revision: 0 }] });
  const pending = f.stats.collect('demo-a', 'telegram', { date: '2026-09-17' });
  await new Promise((r) => setImmediate(r));
  broken = true; // пока ждали ответ, подключение стало нечитаемым: подтвердить прежнюю ревизию нечем
  release();
  const run = await pending;
  assert.equal(run.status, 'failed'); assert.match(run.error, /не прочитана после ответа/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM social_snapshots').get().n, 0, 'два сбоя чтения не считаются совпавшей ревизией');
  broken = false;
  const ok = f.stats.collect('demo-a', 'telegram', { date: '2026-09-17' }); // ревизия снова читается — ответ принимается
  await new Promise((r) => setImmediate(r)); release();
  assert.equal((await ok).status, 'partial');
});

test('миграция старой таблицы запусков: колонки добавляются, прежние записи целы, сбор работает', async (t) => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY, code TEXT UNIQUE COLLATE NOCASE, name TEXT, timezone TEXT, is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies(id,code,name,timezone) VALUES(1,'demo-a','Компания А','Asia/Bangkok');
    CREATE TABLE leads(id INTEGER PRIMARY KEY, company_code TEXT, created_at TEXT, stage TEXT, sale_amount REAL, source TEXT, utm_source TEXT, utm_content TEXT, utm_campaign TEXT, referrer TEXT, landing_page TEXT);
    CREATE TABLE social_collect_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL COLLATE NOCASE, platform TEXT NOT NULL, provider TEXT NOT NULL, trigger TEXT NOT NULL,
      date TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL DEFAULT 'failed', rows INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '', missing TEXT NOT NULL DEFAULT '[]');
    INSERT INTO social_collect_runs(company_code,platform,provider,trigger,date,started_at,finished_at,status,missing)
      VALUES('demo-a','telegram','direct','schedule','2026-09-17','2026-09-17T01:00:00.000Z','2026-09-17T01:00:01.000Z','missing_access','["бот не администратор канала"]');`);
  const clock = { ms: Date.parse('2026-09-18T01:30:00Z') };
  const transport = { connectionRevision: () => ({ provider: 'direct', revision: 1, target: '@c' }), async readStats() { return { provider: 'direct', target: '@c', result: 500 }; } };
  const stats = createSocialStats(db, { now: () => clock.ms, adapters: createSocialAdapters({ transport }), logger: { warn() {} } });
  const columns = db.prepare("SELECT name FROM pragma_table_info('social_collect_runs')").all().map((r) => r.name);
  for (const name of ['closed', 'account_ref', 'account_revision', 'connection_fp']) assert.ok(columns.includes(name), 'добавлена колонка ' + name);
  const old = db.prepare('SELECT * FROM social_collect_runs WHERE id=1').get();
  assert.equal(old.status, 'missing_access'); assert.equal(old.missing, '["бот не администратор канала"]', 'прежняя запись не переписана');
  assert.equal(old.connection_fp, '', 'у записей до миграции отпечатка нет');
  assert.equal(old.account_ref, ''); assert.equal(old.account_revision, 0); assert.equal(old.closed, 1);
  stats.saveAccounts('demo-a', { accounts: [{ platform: 'telegram', accountRef: '@c', provider: 'direct', collectHour: 0, revision: 0 }] });
  assert.deepEqual((await stats.collectDue()).map((r) => [r.date, r.status]), [['2026-09-17', 'partial'], ['2026-09-18', 'partial']], 'запись без отпечатка не подавляет сбор после миграции');
  assert.match(db.prepare('SELECT connection_fp FROM social_collect_runs ORDER BY id DESC LIMIT 1').get().connection_fp, /^[0-9a-f]{64}$/, 'новые запуски пишут отпечаток');
  createSocialStats(db, { now: () => clock.ms, adapters: createSocialAdapters({ transport }), logger: { warn() {} } });
  assert.equal(db.prepare("SELECT count(*) n FROM pragma_table_info('social_collect_runs') WHERE name='connection_fp'").get().n, 1, 'повторный запуск миграции не дублирует колонку');
  assert.equal(db.prepare('SELECT count(*) n FROM social_collect_runs').get().n, 3, 'миграция не создаёт и не теряет записи');
});

test('ответ провайдера, пришедший после смены аккаунта или подключения, отбрасывается', async (t) => {
  let release;
  const transport = { readStats: () => new Promise((resolve) => { release = () => resolve({ provider: 'direct', target: '@old', result: 5 }); }) };
  const f = fixture(t, { transport });
  const saved = f.stats.saveAccounts('demo-a', { accounts: [{ platform: 'telegram', accountRef: '@old', provider: 'direct', revision: 0 }] });
  const pending = f.stats.collect('demo-a', 'telegram', { date: '2026-09-17' });
  await new Promise((r) => setImmediate(r));
  const rev = saved.accounts.find((a) => a.platform === 'telegram').revision;
  f.stats.saveAccounts('demo-a', { accounts: [{ platform: 'telegram', accountRef: '@new', provider: 'direct', revision: rev }] });
  release();
  const run = await pending;
  assert.equal(run.status, 'failed'); assert.match(run.error, /изменились во время сбора/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM social_snapshots').get().n, 0, 'старый ответ не записан новому аккаунту');
});

test('ручной импорт: только с датой снятия и источником; без чисел — отказ; атрибуция считает обращения и продажи только по utm/URL', (t) => {
  const f = fixture(t);
  f.stats.saveAccounts('demo-a', { accounts: [{ platform: 'instagram', accountRef: '@demo_ig', provider: 'manual', revision: 0 }] });
  rejects(() => f.stats.importManual('demo-a', { platform: 'instagram', capturedAt: '2026-09-18T01:00:00Z', sourceNote: 'скриншот', rows: [{ date: '2026-09-17', metric: 'views', value: null }] }), 'VALIDATION_ERROR');
  rejects(() => f.stats.importManual('demo-a', { platform: 'instagram', capturedAt: 'вчера', sourceNote: 'скриншот', rows: [{ date: '2026-09-17', metric: 'views', value: 10 }] }), 'VALIDATION_ERROR');
  const imported = f.stats.importManual('demo-a', { platform: 'instagram', capturedAt: '2026-09-18T01:00:00Z', sourceNote: 'скриншот статистики 18.09', rows: [{ date: '2026-09-17', metric: 'views', value: 900 }, { date: '2026-09-17', metric: 'reach', value: 600 }],
    posts: [{ platformPostId: 'ig-1', url: 'https://example.test/reel/abc/', contentId: '12', publishedAt: '2026-09-17T01:00:00Z', metrics: [{ date: '2026-09-17', metric: 'views', value: 900 }] }] }, { userId: 1, userName: 'Владелец' });
  assert.equal(imported.rows, 3); assert.equal(imported.provider, 'manual');
  lead(f.db, { stage: 'продажа', amount: 15000, source: 'instagram', content: '12' });
  lead(f.db, { at: '2026-09-17T06:00:00.000Z', source: 'instagram', referrer: 'https://example.test/reel/abc/' });
  lead(f.db, { at: '2026-09-17T07:00:00.000Z', stage: 'продажа', amount: 9000, source: 'instagram' });
  lead(f.db, { code: 'demo-b', at: '2026-09-17T07:00:00.000Z', stage: 'продажа', amount: 5000, source: 'instagram', content: '12' });
  const view = f.stats.overview('demo-a', '2026-09-17', '2026-09-17');
  const post = view.crm.posts[0];
  assert.equal(post.leads, 2); assert.equal(post.sales, 1); assert.equal(post.revenue, 15000, 'третье обращение без метки не приписывается посту');
  assert.equal(post.confidence, 'url'); assert.equal(post.attribution, 'exact');
  assert.deepEqual(view.crm.bySource, [{ source: 'instagram', leads: 3, sales: 2, revenue: 24000 }]);
  assert.deepEqual(view.crm.byContent, []);
  assert.equal(f.stats.overview('demo-b', '2026-09-17', '2026-09-17').crm.posts.length, 0, 'посты другой компании не видны');
  assert.match(view.runs[0].error, /Источник: скриншот статистики/);
  rejects(() => f.stats.saveAccounts('demo-a', { accounts: [{ platform: 'instagram', accountRef: '@x', revision: 0 }] }), 'REVISION_CONFLICT');
  rejects(() => f.stats.saveAccounts('demo-a', { accounts: [{ platform: 'vk', accountRef: 'token=abc', revision: 0 }] }), 'VALIDATION_ERROR');
});

test('атрибуция: один contentId на пяти площадках не размножает обращение; площадка из utm_source/source делает связь однозначной; URL post1 не матчит post10', (t) => {
  const f = fixture(t);
  const posts = ['instagram', 'tiktok', 'youtube', 'vk', 'telegram'].map((platform, i) => ({ platformPostId: `${platform}-1`, url: `https://example.test/${platform}/post1`, contentId: 'D1', publishedAt: '2026-09-17T01:00:00Z', metrics: [] }));
  posts.push({ platformPostId: 'vk-10', url: 'https://example.test/vk/post10', contentId: 'D10', publishedAt: '2026-09-17T02:00:00Z', metrics: [] });
  for (const post of posts) f.stats.writePosts('demo-a', post.platformPostId.split('-')[0], [post], { provider: 'manual' });
  lead(f.db, { stage: 'продажа', amount: 1000, content: 'D1' }); // площадка неизвестна → только по контенту
  lead(f.db, { stage: 'продажа', amount: 2000, content: 'D1', utmSource: 'vk' }); // однозначно посту ВКонтакте
  lead(f.db, { campaign: 'D1', source: 'Telegram' }); // источник CRM тоже годится
  lead(f.db, { content: 'D1', utmSource: 'facebook' }); // площадка не совпадает ни с одним постом → по контенту
  lead(f.db, { referrer: 'https://example.test/vk/post10?utm=1' }); // префикс post1 не должен забрать post10
  lead(f.db, { landing: 'https://example.test/vk/post1/' }); // продолжение через «/» — post1
  lead(f.db, { referrer: 'https://example.test/vk/post123' }); // ни один пост
  const crm = f.stats.attribution('demo-a', '2026-09-17', '2026-09-17');
  const by = Object.fromEntries(crm.posts.map((p) => [p.platformPostId, p]));
  assert.deepEqual([by['vk-1'].leads, by['vk-1'].sales, by['vk-1'].revenue], [2, 1, 2000]);
  assert.equal(by['telegram-1'].leads, 1); assert.equal(by['vk-10'].leads, 1);
  for (const id of ['instagram-1', 'tiktok-1', 'youtube-1']) assert.equal(by[id].leads, 0, id + ': без однозначной площадки ничего не приписано');
  assert.equal(crm.posts.reduce((s, p) => s + p.leads, 0), 4, 'каждое обращение засчитано не более одного раза');
  assert.deepEqual(crm.byContent, [{ contentId: 'D1', url: '', platforms: ['instagram', 'tiktok', 'youtube', 'vk', 'telegram'], leads: 2, sales: 1, revenue: 1000, attribution: 'content_only', note: crm.byContent[0].note }]);
  assert.equal(crm.posts.reduce((s, p) => s + p.revenue, 0) + crm.byContent[0].revenue, 3000, 'выручка не задвоена');
});
