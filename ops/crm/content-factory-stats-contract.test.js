'use strict';
/* CF1-R1: подписи вкладки «Статистика» контент-завода сверены с реальными контрактами, на которые она опирается.
   Только чтение существующих модулей на синтетической базе в памяти: ни сбора, ни публикации, ни внешних запросов.
   Тест фиксирует семантику, которую интерфейс обязан описывать честно:
   - реестр публикаций attribution() — последние до 200 известных публикаций компании, не только за выбранный период;
   - заявки отбираются по created_at строками from+'T00:00:00' … to+'T23:59:59.999', то есть сутками UTC, а не поясом проекта;
   - дата карточки календаря — дата расписания или плана в поясе компании, ответ несёт этот пояс. */
const test = require('node:test');
const assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createSocialStats} = require('./social-stats');
const {createCompanyInformation} = require('./company-information');
const {createAutoposting} = require('./autoposting');

function statsFixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY, code TEXT UNIQUE COLLATE NOCASE, name TEXT, timezone TEXT, is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies(id,code,name,timezone) VALUES(1,'qa','Синтетическая компания','Asia/Irkutsk');
    CREATE TABLE leads(id INTEGER PRIMARY KEY, company_code TEXT, created_at TEXT, stage TEXT, sale_amount REAL, source TEXT, utm_source TEXT, utm_content TEXT, utm_campaign TEXT, referrer TEXT, landing_page TEXT);`);
  const stats = createSocialStats(db, {now: () => Date.parse('2026-10-15T00:00:00Z'), adapters: {}, logger: {warn() {}}});
  const lead = (at, referrer) => db.prepare('INSERT INTO leads(company_code,created_at,stage,referrer) VALUES(?,?,?,?)').run('qa', at, 'новая', referrer);
  return {db, stats, lead};
}

test('реестр attribution не фильтруется периодом: августовская публикация есть в отчёте за октябрь', (t) => {
  const f = statsFixture(t);
  f.stats.writePosts('qa', 'telegram', [{platformPostId: 'aug-1', url: 'https://t.me/synthetic/1', publishedAt: '2026-08-20T05:00:00Z', metrics: []}], {provider: 'manual'});
  f.stats.writePosts('qa', 'telegram', [{platformPostId: 'oct-1', url: 'https://t.me/synthetic/2', publishedAt: '2026-10-03T05:00:00Z', metrics: []}], {provider: 'manual'});
  const crm = f.stats.attribution('qa', '2026-10-01', '2026-10-31');
  assert.deepEqual(crm.posts.map((p) => p.publishedAt), ['2026-10-03T05:00:00Z', '2026-08-20T05:00:00Z']);
});

test('реестр ограничен 200 последними записями', (t) => {
  const f = statsFixture(t);
  const posts = Array.from({length: 205}, (_, i) => ({platformPostId: `p-${i}`, url: `https://t.me/synthetic/${i + 10}`,
    publishedAt: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 86400000).toISOString(), metrics: []}));
  f.stats.writePosts('qa', 'telegram', posts, {provider: 'manual'});
  assert.equal(f.stats.attribution('qa', '2026-10-01', '2026-10-31').posts.length, 200);
});

test('заявки периода — сутки UTC: 31.10 20:00Z считается, 30.09 20:00Z (уже 1 октября в Иркутске) — нет; заявка к старой публикации считается', (t) => {
  const f = statsFixture(t);
  f.stats.writePosts('qa', 'telegram', [{platformPostId: 'aug-1', url: 'https://t.me/synthetic/1', publishedAt: '2026-08-20T05:00:00Z', metrics: []}], {provider: 'manual'});
  f.lead('2026-09-30T20:00:00.000Z', 'https://t.me/synthetic/1'); // 01.10 04:00 по Иркутску, но 30.09 по UTC
  f.lead('2026-10-31T20:00:00.000Z', 'https://t.me/synthetic/1'); // 01.11 04:00 по Иркутску, но 31.10 по UTC
  f.lead('2026-10-10T05:00:00.000Z', 'https://t.me/synthetic/1');
  const post = f.stats.attribution('qa', '2026-10-01', '2026-10-31').posts[0];
  assert.equal(post.publishedAt, '2026-08-20T05:00:00Z');
  assert.equal(post.attribution, 'exact');
  assert.equal(post.leads, 2, 'учтены заявки 10.10 и 31.10 20:00Z; заявка 30.09 20:00Z не учтена');
});

test('публикация без адреса и метки — attribution unknown (связь не определяется), а не ноль заявок', (t) => {
  const f = statsFixture(t);
  f.stats.writePosts('qa', 'vk', [{platformPostId: 'no-link', publishedAt: '2026-10-05T05:00:00Z', metrics: []}], {provider: 'manual'});
  assert.equal(f.stats.attribution('qa', '2026-10-01', '2026-10-31').posts[0].attribution, 'unknown');
});

test('календарь: дата карточки — дата расписания в поясе компании, ответ несёт пояс; публикация не выполняется', async (t) => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,
      timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'qa','Синтетическая компания','Asia/Irkutsk','[]');`);
  const now = () => Date.parse('2026-10-15T00:00:00Z');
  const information = createCompanyInformation(db, {now});
  const api = createAutoposting(db, {information, now, transport: {getSettings: () => ({channels: []}), publish: () => assert.fail('календарь не публикует')}});
  const late = api.create('qa', {scheduledAt: '2026-10-31T20:00:00.000Z'}); // 01.11 04:00 по Иркутску
  const inside = api.create('qa', {scheduledAt: '2026-10-31T10:00:00.000Z'}); // 31.10 18:00 по Иркутску
  const october = await api.calendar('qa', {from: '2026-10-01', to: '2026-10-31'});
  assert.equal(october.timezone, 'Asia/Irkutsk');
  const ids = october.posts.map((p) => p.id);
  assert.ok(ids.includes(inside.id));
  assert.ok(!ids.includes(late.id), 'карточка на 01.11 по поясу компании не попадает в октябрь, хотя по UTC это 31.10');
  assert.equal(october.posts.find((p) => p.id === inside.id).dateKind, 'schedule');
});
