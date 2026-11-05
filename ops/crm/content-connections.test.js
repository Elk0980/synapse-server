'use strict';
/* Контент → Подключения: статусы по фикстурам, изоляция компаний, ключи не выходят наружу.
   Компании, ссылки и числа синтетические. */
const test = require('node:test'), assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createContentConnections, declaredFromEnv } = require('./content-connections');
const { createMetrikaSiteSource, counterIn, PUBLISHED_SITE_DIRS } = require('./metrika-site-source'), fs = require('node:fs'), path = require('node:path');

const NOW = Date.parse('2026-11-04T12:00:00Z');
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY, code TEXT UNIQUE COLLATE NOCASE, name TEXT, website_url TEXT, socials TEXT, is_deleted INTEGER DEFAULT 0);
    CREATE TABLE social_accounts(company_code TEXT COLLATE NOCASE, platform TEXT, account_ref TEXT, provider TEXT, enabled INTEGER);
    CREATE TABLE social_snapshots(company_code TEXT COLLATE NOCASE, platform TEXT, date TEXT, metric TEXT, value REAL, provider TEXT);
    CREATE TABLE autoposting_channels(company_code TEXT COLLATE NOCASE, id TEXT, provider TEXT, status TEXT, revision INTEGER, checked_revision INTEGER, encrypted_token TEXT);
    CREATE TABLE external_stats(source TEXT, company_code TEXT COLLATE NOCASE, date TEXT, metrics TEXT);
    CREATE TABLE leads(id INTEGER PRIMARY KEY, created_at TEXT, channel TEXT, source TEXT, company_code TEXT COLLATE NOCASE);
    CREATE TABLE events(id INTEGER PRIMARY KEY, created_at TEXT, type TEXT DEFAULT 'visit', company_code TEXT COLLATE NOCASE, page TEXT, landing_page TEXT, utm_source TEXT, utm_medium TEXT);
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

test('статус считается по факту данных и настроек', async () => {
  const svc = createContentConnections(fixture(), { now: () => NOW });
  const a = byId(await svc.list('demo-a'));
  assert.equal(a.instagram.status, 'green'); assert.equal(a.instagram.dataMode, 'live');
  assert.equal(a.tiktok.status, 'yellow'); assert.match(a.tiktok.statusText, /ручным вводом/);
  assert.equal(a.youtube.status, 'yellow'); assert.match(a.youtube.statusText, /последние 2026-09-01/);
  assert.equal(a.telegram_channel.status, 'yellow'); assert.equal(a.telegram_channel.settings.publishing.key, true);
  assert.equal(a.website.status, 'green'); assert.equal(a.website.link, 'https://a.example/');
  assert.equal(a.vk.status, 'red'); assert.equal(a.vk.link, 'https://vk.com/demo_a'); assert.match(a.vk.statusText, /только ссылка/);
  assert.equal(a.yclients.status, 'red'); assert.match(a.yclients.next, /YCLIENTS/);
  assert.equal(a.metrika.status, 'red'); assert.equal(a.yandex_direct.status, 'red');
  assert.equal(a.telegram_bot.status, 'red'); assert.equal(a.max.status, 'red');
  assert.equal((await svc.list('demo-a')).platforms.length, 13);
});

test('изоляция компаний: данные Б не видны в А и наоборот', async () => {
  const svc = createContentConnections(fixture(), { now: () => NOW });
  const a = byId(await svc.list('demo-a')), b = byId(await svc.list('demo-b'));
  assert.equal(b.vk.status, 'green'); assert.equal(a.vk.status, 'red');
  assert.equal(b.telegram_bot.status, 'green'); assert.equal(a.telegram_bot.status, 'red');
  assert.equal(b.yandex_direct.status, 'green'); assert.equal(a.yandex_direct.status, 'red');
  assert.equal(b.instagram.status, 'red'); assert.equal(b.website.status, 'red'); assert.equal(b.website.link, null);
  assert.equal(b.telegram_channel.settings.publishing, null);
});

test('Директ: серверный признак — 🟢 за 7 дн., старее — 🟡; платные визиты Яндекса тоже признак', async () => {
  const db = fixture();
  db.exec(`INSERT INTO external_stats VALUES('yandex-direct','demo-a','2026-10-20','{"cost":1}');`);
  const svc = createContentConnections(db, { now: () => NOW });
  let a = byId(await svc.list('demo-a')), b = byId(await svc.list('demo-b'));
  assert.equal(b.yandex_direct.status, 'green'); assert.equal(b.yandex_direct.dataMode, 'live');
  assert.equal(a.yandex_direct.status, 'yellow'); assert.match(a.yandex_direct.statusText, /за 7 дн\. нет \(последние 2026-10-20\)/);
  db.exec(`INSERT INTO events(created_at,company_code,type,utm_source,utm_medium) VALUES('2026-11-03T05:00:00Z','demo-a','visit','yandex','cpc')`);
  a = byId(await svc.list('demo-a'));
  assert.equal(a.yandex_direct.status, 'green'); assert.match(a.yandex_direct.facts.join(' '), /рекламы Яндекса.*: 1/);
  db.exec(`INSERT INTO events(created_at,company_code,type,landing_page) VALUES('2026-11-04T05:00:00Z','demo-c-none','visit','https://x/?yclid=1')`);
  assert.equal(byId(await svc.list('demo-b')).yandex_direct.facts.some((f) => /рекламы Яндекса/.test(f)), false, 'визиты чужой компании не учитываются');
});

test('Метрика: счётчик в исходниках своего сайта — 🟡 «вне ЛК», нет сайта — 🔴; без сети', async (t) => {
  const realFetch = globalThis.fetch; let network = 0; t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = () => { network++; throw Error('сетевой вызов запрещён'); };
  const siteSource = createMetrikaSiteSource({ sitesDir: path.join(__dirname, '../../sites'), dirs: { 'demo-a': 'avokado3', 'demo-b': 'alvi', 'demo-c': '../ops' } });
  const db = fixture(); db.exec("INSERT INTO companies(id,code,name) VALUES(3,'demo-c','В'),(4,'demo-d','Г')");
  const svc = createContentConnections(db, { now: () => NOW, siteSource });
  const a = byId(await svc.list('demo-a')), b = byId(await svc.list('demo-b'));
  assert.equal(a.metrika.status, 'yellow'); assert.equal(a.metrika.statusText, 'Подключено вне ЛК, не проверено системой');
  assert.equal(a.metrika.settings.siteCounter.counterId, '112772817'); assert.match(a.metrika.facts.join(' '), /avokado3\/attribution\.js/);
  assert.equal(b.metrika.settings.siteCounter.counterId, '112777602');
  assert.doesNotMatch(JSON.stringify(await svc.list('demo-a')), /112777602|alvi/, 'счётчик и сайт другой компании не попадают в ответ');
  assert.equal(byId(await svc.list('demo-c')).metrika.status, 'red', 'путь за пределы каталога сайтов не читается');
  assert.equal(byId(await svc.list('demo-d')).metrika.status, 'red');
  const noDir = createContentConnections(fixture(), { now: () => NOW, siteSource: createMetrikaSiteSource({ dirs: { 'demo-a': 'avokado3' } }) });
  assert.equal(byId(await noDir.list('demo-a')).metrika.status, 'red', 'каталог не задан — источника нет');
  db.exec(`INSERT INTO external_stats VALUES('metrika','demo-a','2026-11-03','{"visits":5}')`);
  assert.equal(byId(await svc.list('demo-a')).metrika.status, 'green'); assert.equal(network, 0);
});

test('папки опубликованных сайтов совпадают с карточками site-store и существуют', () => {
  const store = fs.readFileSync(path.join(__dirname, '../content/site-store.js'), 'utf8');
  const published = [...store.matchAll(/\['[^']+', '([^']+)', '[^']+', 'published'/g)].map((m) => m[1]).sort();
  assert.deepEqual(Object.keys(PUBLISHED_SITE_DIRS).sort(), published);
  for (const dir of Object.values(PUBLISHED_SITE_DIRS)) assert.ok(fs.existsSync(path.join(__dirname, '../../sites', dir, 'index.html')), dir);
  assert.equal(counterIn("ym(7788990, 'init', {})"), '7788990');
  assert.equal(counterIn('const counterId = 123456;'), null, 'номер без загрузчика Метрики не засчитывается');
});

test('подтверждение владельца даёт 🟡, а не 🔴, и только своей компании', async () => {
  const declared = declaredFromEnv('{"DEMO-A":{"metrika":{"by":"Владелец","date":"2026-11-04"},"yandex_direct":{"by":"Владелец","date":"2026-11-04"}}}');
  const svc = createContentConnections(fixture(), { now: () => NOW, declared });
  const a = byId(await svc.list('demo-a')), b = byId(await svc.list('demo-b'));
  assert.equal(a.metrika.status, 'yellow'); assert.equal(a.metrika.statusText, 'Подключено, данные в ЛК ещё не приходят');
  assert.equal(a.yandex_direct.status, 'yellow');
  assert.equal(b.metrika.status, 'red');
  assert.deepEqual(declaredFromEnv('not json'), {}); assert.deepEqual(declaredFromEnv('[1]'), {});
});

test('ключи не выходят наружу, только «есть / нет»', async () => {
  const json = JSON.stringify(await createContentConnections(fixture(), { now: () => NOW }).list('demo-a'));
  assert.doesNotMatch(json, /SECRET|ENVELOPE|encrypted/);
});

test('без таблиц соседних модулей всё 🔴, без падения; неверные входы — ошибка', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE companies(id INTEGER PRIMARY KEY, code TEXT, name TEXT, website_url TEXT, socials TEXT, is_deleted INTEGER DEFAULT 0); INSERT INTO companies(code,name) VALUES('demo-c','В')");
  const svc = createContentConnections(db, { now: () => NOW });
  assert.ok((await svc.list('demo-c')).platforms.every((p) => p.status === 'red'));
  await assert.rejects(svc.list('нет'), { status: 400 });
  await assert.rejects(svc.list('demo-z'), { status: 404 });
  await assert.rejects(svc.list('demo-c', { days: 0 }), { status: 400 });
});
