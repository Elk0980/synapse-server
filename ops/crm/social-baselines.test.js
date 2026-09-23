'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createSocialStats } = require('./social-stats');
const { createSocialBaselines } = require('./social-baselines');

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,timezone TEXT,is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies VALUES(1,'alvi','АЛВИ','Asia/Irkutsk',0),(2,'avokado','Авокадо','Asia/Irkutsk',0);
    CREATE TABLE leads(id INTEGER PRIMARY KEY,company_code TEXT,created_at TEXT,stage TEXT,sale_amount REAL,source TEXT,
      utm_source TEXT,utm_content TEXT,utm_campaign TEXT,referrer TEXT,landing_page TEXT);`);
  const clock = { ms: Date.parse('2026-09-23T12:00:00Z') };
  const stats = createSocialStats(db, { now: () => clock.ms, adapters: {} });
  const baseline = createSocialBaselines(db, stats, { now: () => clock.ms });
  return { db, stats, baseline, clock };
}
const request = { cutoverDate: '2026-09-19', from: '2026-09-16', to: '2026-09-18',
  sourceNote: 'Дата начала по внутреннему плану владельца', confirmedStart: true };

test('замер с пустыми источниками сохраняет UNKNOWN, а не нули; компании изолированы', (t) => {
  const { baseline } = fixture(t);
  const frozen = baseline.freeze('alvi', request, { userId: 1 });
  assert.equal(frozen.version, 1);
  assert.equal(frozen.snapshot.status, 'no_data');
  assert.equal(frozen.snapshot.socialAggregate.views, null);
  assert.equal(frozen.snapshot.socialAggregate.reach, null);
  assert.equal(frozen.snapshot.platforms.vk.coverage, 'account_not_configured');
  assert.equal(frozen.snapshot.postsRecorded, 0);
  assert.equal(baseline.get('avokado').latest, null);
  assert.equal(baseline.get('alvi').latest.version, 1);
  assert.throws(() => baseline.get('missing'), (error) => error.code === 'NOT_FOUND');
});

test('дата начала и закрытый период требуют явного подтверждения и источника', (t) => {
  const { baseline } = fixture(t);
  const invalid = [
    { confirmedStart: false }, { sourceNote: '' }, { cutoverDate: '2026-09-18' },
    { from: '2026-09-19' }, { to: '2026-09-23', cutoverDate: '2026-09-24' },
    { cutoverDate: '2026-02-30' }, { from: '2026-01-01' },
  ];
  for (const changes of invalid) assert.throws(() => baseline.freeze('alvi', { ...request, ...changes }),
    (error) => error.code === 'VALIDATION_ERROR', JSON.stringify(changes));
  assert.equal(baseline.get('alvi').latest, null);
});

test('поздняя догрузка меняет только новую версию, а источник исторического поста сохраняется', (t) => {
  const { baseline, stats, db } = fixture(t);
  stats.saveAccounts('alvi', { accounts: [{ platform: 'instagram', accountRef: '@alvi-test', provider: 'manual', revision: 0 }] });
  stats.importManual('alvi', { platform: 'instagram', capturedAt: '2026-09-18T12:00:00Z', sourceNote: 'выгрузка Insights',
    rows: [{ date: '2026-09-17', metric: 'views', value: 250 }],
    posts: [{ platformPostId: 'example-post', url: 'https://www.instagram.com/reel/example/',
      publishedAt: '2026-09-17T04:00:00Z', metrics: [{ date: '2026-09-17', metric: 'views', value: 120 }] }] }, { userId: 1 });
  const first = baseline.freeze('alvi', request, { userId: 1 });
  assert.equal(first.snapshot.platforms.instagram.totals.views, 250);
  assert.equal(first.snapshot.platforms.instagram.coverage, 'partial');
  assert.equal(first.snapshot.platforms.instagram.sources[0].note, 'выгрузка Insights');
  assert.deepEqual(first.snapshot.platforms.instagram.measurements.map((row) => [row.date,row.metric,row.value,row.note]),
    [['2026-09-17','views',250,'выгрузка Insights']]);
  assert.equal(first.snapshot.postsRecorded, 1);
  assert.equal(first.snapshot.posts[0].source.note, 'выгрузка Insights');
  assert.equal(first.snapshot.posts[0].source.capturedAt, '2026-09-18T12:00:00.000Z');
  assert.equal(first.snapshot.posts[0].metrics[0].value, 120);
  assert.equal(first.snapshot.posts[0].metrics[0].note, 'выгрузка Insights');
  assert.equal(baseline.freeze('alvi', request, { userId: 1 }).unchanged, true);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM social_baselines WHERE company_code=?').get('alvi').count, 1);
  assert.throws(() => db.prepare('UPDATE social_baselines SET source_note=? WHERE id=?').run('замена', first.id), /baseline is immutable/);
  assert.throws(() => db.prepare('DELETE FROM social_baselines WHERE id=?').run(first.id), /baseline is immutable/);
  stats.importManual('alvi', { platform: 'instagram', capturedAt: '2026-09-23T12:00:00Z', sourceNote: 'исправленная выгрузка',
    rows: [{ date: '2026-09-17', metric: 'views', value: 300 }],
    posts: [{ platformPostId: 'example-post', publishedAt: '2026-09-17T04:00:00Z', metrics: [{ date: '2026-09-17', metric: 'views', value: 130 }] }] }, { userId: 1 });
  const second = baseline.freeze('alvi', request, { userId: 1 });
  assert.equal(second.version, 2);
  assert.equal(second.supersedesId, first.id);
  assert.equal(second.snapshot.platforms.instagram.totals.views, 300);
  assert.equal(second.snapshot.posts[0].metrics[0].value, 130);
  assert.equal(second.snapshot.posts[0].source.capturedAt, '2026-09-23T12:00:00.000Z');
  assert.equal(first.snapshot.posts[0].source.capturedAt, '2026-09-18T12:00:00.000Z');
  assert.equal(baseline.get('alvi', 1).latest.snapshot.platforms.instagram.totals.views, 250);
  assert.equal(baseline.get('alvi', 1).latest.snapshot.posts[0].metrics[0].value, 120);
  assert.equal(baseline.get('avokado').latest, null);
});

test('публикации другой компании не попадают в замер', (t) => {
  const { baseline, stats } = fixture(t);
  stats.importManual('avokado', { platform: 'vk', capturedAt: '2026-09-18T12:00:00Z', sourceNote: 'архив площадки',
    posts: [{ platformPostId: 'other-post', url: 'https://vk.com/wall-1_2', publishedAt: '2026-09-17T04:00:00Z' }] });
  const alvi = baseline.freeze('alvi', request);
  const avokado = baseline.freeze('avokado', request);
  assert.equal(alvi.snapshot.postsRecorded, 0);
  assert.equal(avokado.snapshot.postsRecorded, 1);
  assert.equal(avokado.snapshot.posts[0].source.note, 'архив площадки');
});

test('миграция старых публикаций сохраняет запись и честно оставляет неизвестный источник', (t) => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,timezone TEXT,is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies VALUES(1,'alvi','АЛВИ','Asia/Irkutsk',0);
    CREATE TABLE leads(id INTEGER PRIMARY KEY,company_code TEXT,created_at TEXT,stage TEXT,sale_amount REAL,source TEXT,
      utm_source TEXT,utm_content TEXT,utm_campaign TEXT,referrer TEXT,landing_page TEXT);
    CREATE TABLE social_posts(id INTEGER PRIMARY KEY AUTOINCREMENT,company_code TEXT NOT NULL COLLATE NOCASE,platform TEXT NOT NULL,
      platform_post_id TEXT NOT NULL,url TEXT NOT NULL DEFAULT '',content_id TEXT NOT NULL DEFAULT '',published_at TEXT,
      provider TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'organic',created_at TEXT NOT NULL,
      UNIQUE(company_code,platform,platform_post_id));
    INSERT INTO social_posts(company_code,platform,platform_post_id,url,published_at,provider,created_at)
      VALUES('alvi','vk','old-1','https://vk.com/wall-1_2','2026-09-17T04:00:00Z','manual','2026-09-18T00:00:00Z');`);
  const now = () => Date.parse('2026-09-23T12:00:00Z');
  const stats = createSocialStats(db, { now, adapters: {} });
  const baseline = createSocialBaselines(db, stats, { now });
  const frozen = baseline.freeze('alvi', request);
  assert.equal(frozen.snapshot.postsRecorded, 1);
  assert.equal(frozen.snapshot.posts[0].source.note, null);
  assert.equal(frozen.snapshot.posts[0].source.capturedAt, '2026-09-18T00:00:00Z');
  assert.equal(db.prepare('SELECT count(*) count FROM social_posts').get().count, 1);
});

test('подтверждения владельца отдельно видны как выход без метрик и не смешивают компании', (t) => {
  const { db, baseline } = fixture(t);
  db.exec(`CREATE TABLE autoposting_posts(id INTEGER PRIMARY KEY,company_id INTEGER);
    INSERT INTO autoposting_posts VALUES(1,1),(2,2);
    CREATE TABLE autoposting_publication_receipts(id INTEGER PRIMARY KEY,company_id INTEGER,post_id INTEGER,platform TEXT,url TEXT,
      published_at TEXT,recorded_at TEXT,note TEXT);
    INSERT INTO autoposting_publication_receipts VALUES
      (1,1,1,'vk','https://vk.com/wall-1_2','2026-09-17T04:00:00Z','2026-09-18T01:00:00Z','ссылка владельца'),
      (2,2,2,'vk','https://vk.com/wall-3_4','2026-09-17T04:00:00Z','2026-09-18T01:00:00Z','другая компания');`);
  const alvi = baseline.freeze('alvi', request).snapshot;
  assert.equal(alvi.postsRecorded, 0);
  assert.equal(alvi.receiptsRecorded, 1);
  assert.equal(alvi.receipts[0].url, 'https://vk.com/wall-1_2');
  assert.equal(alvi.receipts[0].source.type, 'owner_confirmation');
  assert.equal(alvi.receipts[0].metrics, null);
  assert.equal(alvi.socialAggregate.views, null);
  assert.equal(baseline.freeze('avokado', request).snapshot.receipts[0].url, 'https://vk.com/wall-3_4');
});

test('публикация после полуночи по времени компании не попадает в период ДО', (t) => {
  const { stats, baseline } = fixture(t);
  stats.importManual('alvi', { platform: 'telegram', capturedAt: '2026-09-19T01:00:00Z', sourceNote: 'архив канала',
    posts: [{ platformPostId: 'late', publishedAt: '2026-09-18T16:30:00Z', url: 'https://t.me/example/123' }] });
  const frozen = baseline.freeze('alvi', request);
  assert.equal(frozen.snapshot.postsRecorded, 0, 'UTC 18.09 16:30 — уже 19.09 в Иркутске');
});
