'use strict';
/* Контент → Подключения: статусы по фикстурам, изоляция компаний, ключи не выходят наружу.
   Компании, ссылки и числа синтетические. */
const test = require('node:test'), assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createContentConnections, createContentConnectionsHandler, declaredFromEnv } = require('./content-connections');

const NOW = Date.parse('2026-11-04T12:00:00Z');
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY, code TEXT UNIQUE COLLATE NOCASE, name TEXT, website_url TEXT, socials TEXT, is_deleted INTEGER DEFAULT 0);
    CREATE TABLE social_accounts(company_code TEXT COLLATE NOCASE, platform TEXT, account_ref TEXT, provider TEXT, enabled INTEGER);
    CREATE TABLE social_snapshots(company_code TEXT COLLATE NOCASE, platform TEXT, date TEXT, metric TEXT, value REAL, provider TEXT);
    CREATE TABLE autoposting_channels(company_code TEXT COLLATE NOCASE, id TEXT, provider TEXT, status TEXT, revision INTEGER, checked_revision INTEGER, encrypted_token TEXT);
    CREATE TABLE external_stats(source TEXT, company_code TEXT COLLATE NOCASE, date TEXT, metrics TEXT);
    CREATE TABLE leads(id INTEGER PRIMARY KEY, created_at TEXT, channel TEXT, source TEXT, company_code TEXT COLLATE NOCASE);
    CREATE TABLE events(id INTEGER PRIMARY KEY, created_at TEXT, company_code TEXT COLLATE NOCASE);
    INSERT INTO companies(id,code,name,website_url,socials) VALUES
      (1,'demo-a','А','https://a.example/','[{"type":"vk","url":"https://vk.com/demo_a"},{"type":"two_gis","url":"https://2gis.ru/x/firm/1"},{"type":"booking","url":"https://n1.yclients.com/company/1"}]'),
      (2,'demo-b','Б',NULL,'[]');
    -- А: Instagram — живые данные Onlypult за последние дни; TikTok — только ручной ввод; YouTube — старые данные.
    INSERT INTO social_snapshots VALUES('demo-a','instagram','2026-11-03','views',120,'onlypult'),
      ('demo-a','tiktok','2026-11-02','views',50,'manual'),('demo-a','youtube','2026-09-01','views',10,'onlypult');
    -- А: Telegram-канал настроен для постинга с ключом, но данных нет.
    INSERT INTO autoposting_channels VALUES('demo-a','telegram','direct','connected',2,2,'{"v":1,"data":"SECRET-ENVELOPE"}');
    INSERT INTO events(created_at,company_code) VALUES('2026-11-04T01:00:00Z','demo-a');
    -- Б: живые данные VK, заявки из Telegram-бота, снимки Директа. Не должны влиять на А.
    INSERT INTO social_snapshots VALUES('demo-b','vk','2026-11-04','views',999,'direct');
    INSERT INTO leads(created_at,channel,source,company_code) VALUES('2026-11-04T02:00:00Z','telegram','telegram','demo-b');
    INSERT INTO external_stats VALUES('yandex-direct','demo-b','2026-11-03','{"cost":1}');`);
  return db;
}
const byId = (result) => Object.fromEntries(result.platforms.map((p) => [p.id, p]));

test('статус считается по факту данных и настроек', () => {
  const svc = createContentConnections(fixture(), { now: () => NOW });
  const a = byId(svc.list('demo-a'));
  assert.equal(a.instagram.status, 'green'); assert.equal(a.instagram.dataMode, 'live');
  assert.equal(a.tiktok.status, 'yellow'); assert.match(a.tiktok.statusText, /ручным вводом/);
  assert.equal(a.youtube.status, 'yellow'); assert.match(a.youtube.statusText, /последние 2026-09-01/);
  assert.equal(a.telegram_channel.status, 'yellow'); assert.equal(a.telegram_channel.settings.publishing.key, true);
  assert.equal(a.website.status, 'green'); assert.equal(a.website.link, 'https://a.example/');
  assert.equal(a.vk.status, 'red'); assert.equal(a.vk.link, 'https://vk.com/demo_a'); assert.match(a.vk.statusText, /только ссылка/);
  assert.equal(a.yclients.status, 'red'); assert.match(a.yclients.next, /YCLIENTS/);
  assert.equal(a.metrika.status, 'red'); assert.equal(a.yandex_direct.status, 'red');
  assert.equal(a.telegram_bot.status, 'red'); assert.equal(a.max.status, 'red');
  assert.equal(svc.list('demo-a').platforms.length, 13);
});

test('изоляция компаний: данные Б не видны в А и наоборот', () => {
  const svc = createContentConnections(fixture(), { now: () => NOW });
  const a = byId(svc.list('demo-a')), b = byId(svc.list('demo-b'));
  assert.equal(b.vk.status, 'green'); assert.equal(a.vk.status, 'red');
  assert.equal(b.telegram_bot.status, 'green'); assert.equal(a.telegram_bot.status, 'red');
  assert.equal(b.yandex_direct.status, 'yellow'); assert.equal(a.yandex_direct.status, 'red');
  assert.equal(b.instagram.status, 'red'); assert.equal(b.website.status, 'red'); assert.equal(b.website.link, null);
  assert.equal(b.telegram_channel.settings.publishing, null);
});

test('подтверждение владельца даёт 🟡, а не 🔴, и только своей компании', () => {
  const declared = declaredFromEnv('{"DEMO-A":{"metrika":{"by":"Владелец","date":"2026-11-04"},"yandex_direct":{"by":"Владелец","date":"2026-11-04"}}}');
  const svc = createContentConnections(fixture(), { now: () => NOW, declared });
  const a = byId(svc.list('demo-a')), b = byId(svc.list('demo-b'));
  assert.equal(a.metrika.status, 'yellow'); assert.equal(a.metrika.statusText, 'Подключено, данные в ЛК ещё не приходят');
  assert.equal(a.yandex_direct.status, 'yellow');
  assert.equal(b.metrika.status, 'red');
  assert.deepEqual(declaredFromEnv('not json'), {}); assert.deepEqual(declaredFromEnv('[1]'), {});
});

test('ключи не выходят наружу, только «есть / нет»', () => {
  const svc = createContentConnections(fixture(), { now: () => NOW });
  const json = JSON.stringify(svc.list('demo-a'));
  assert.doesNotMatch(json, /SECRET|ENVELOPE|encrypted/);
});

test('без таблиц соседних модулей всё 🔴, без падения; неверные входы — ошибка', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE companies(id INTEGER PRIMARY KEY, code TEXT, name TEXT, website_url TEXT, socials TEXT, is_deleted INTEGER DEFAULT 0); INSERT INTO companies(code,name) VALUES('demo-c','В')");
  const svc = createContentConnections(db, { now: () => NOW });
  assert.ok(svc.list('demo-c').platforms.every((p) => p.status === 'red'));
  assert.throws(() => svc.list('нет'), { status: 400 });
  assert.throws(() => svc.list('demo-z'), { status: 404 });
  assert.throws(() => svc.list('demo-c', { days: 0 }), { status: 400 });
});

test('HTTP: только GET, право публикаций или аналитики, чужая компания — 403', async () => {
  const connections = createContentConnections(fixture(), { now: () => NOW });
  const run = async (perms, code, method = 'GET') => {
    let sent;
    const handle = createContentConnectionsHandler({ connections, send: (r, status, payload, headers) => { sent = { status, payload, headers }; },
      companyModuleContext: (req, c, permission) => {
        if (!perms.includes(permission) || c !== 'demo-a') throw Object.assign(Error('Нет доступа'), { status: 403 });
        return { company: { code: c } };
      } });
    try { await handle({ method }, {}, new URL('https://x/content-connections?companyCode=' + code)); } catch (e) { sent = { status: e.status }; }
    return sent;
  };
  assert.equal((await run(['autoposting.view'], 'demo-a')).status, 200);
  const viaAnalytics = await run(['analytics.view'], 'demo-a');
  assert.equal(viaAnalytics.status, 200); assert.equal(viaAnalytics.headers['cache-control'], 'no-store');
  assert.equal((await run(['crm.view'], 'demo-a')).status, 403);
  assert.equal((await run(['autoposting.view', 'analytics.view'], 'demo-b')).status, 403);
  assert.equal((await run(['autoposting.view'], 'demo-a', 'POST')).status, 405);
});
