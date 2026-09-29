'use strict';
/* Сквозной офлайн-путь сборщика Onlypult Analytics на настоящих модулях:
   отдельный доступ → выбор an_профиля и native ID → ручной и плановый сбор →
   проекция, покрытие, доказательства → аренда и повторы.

   Сети нет: мок запрещает любой незаданный адрес, разрешает только GET к
   api.onlypult.com и следит, чтобы ни один publishing-путь не был вызван.
   Ключи, профили и числа синтетические. */
const test = require('node:test'), assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createSocialStats} = require('./social-stats');
const {createSocialAdapters} = require('./social-adapters');
const {createSocialAnalyticsCredentials} = require('./social-analytics-credentials');
const {createSocialAnalyticsEvidence} = require('./social-analytics-evidence');
const {createSocialOnlypultAnalytics} = require('./social-onlypult-analytics');

const KEY = 'TEST_ONLY_ANALYTICS_STORAGE_KEY_NOT_LIVE';
const SECRET = 'TEST_ONLY_ANALYTICS_TOKEN_abcdef123456';
const AN = 'an_demo1', NATIVE = '17841400000000001', ZONE = 'Asia/Irkutsk';
const wire = (data, status = 200) => new Response(JSON.stringify({data}), {status, headers: {'content-type': 'application/json'}});

const catalogData = {platforms: ['instagram'], metrics: [
  {key: 'followers_count', title: 'Followers', category: 'audience', unit: 'count', platforms: ['instagram'], source: 'network', formula: null, notes: null},
  {key: 'content_views', title: 'Content views', category: 'profile', unit: 'count', platforms: ['instagram'], source: 'network', formula: null, notes: null},
], charts: [
  {name: 'FollowersCountChart', title: 'Followers', category: 'audience', platforms: ['instagram'], returns: 'series', unit: 'count', params: []},
  {name: 'ContentImpressionsChart', title: 'Content views', category: 'profile', platforms: ['instagram'], returns: 'series', unit: 'count', params: []},
]};
const profileRow = (over = {}) => ({id: AN, platform: 'instagram', platform_id: NATIVE, name: 'ALVI', username: '@alvi',
  status: 'active', timezone: ZONE, capabilities: {endpoints: ['overview'], granularity: ['day']}, ...over});
const series = (chart, points, summary = null) => ({chart, summary, data: points});
const dayData = (date, over = {}) => ({profile_id: AN, platform: 'instagram', platform_id: NATIVE,
  period: {from: date, to: date, granularity: 'day', timezone: ZONE},
  coverage: {covered_from: '2026-09-01', covered_to: date, collecting: false, collection_enabled: true},
  warnings: [],
  metrics: {audience: [series('FollowersCountChart', [{date, value: 136}], 136)],
    profile: [series('ContentImpressionsChart', [{date, value: 0}], 0)]}, ...over});

function fixture(t, {responses = {}, now = Date.parse('2026-09-23T01:00:00Z')} = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY, code TEXT UNIQUE COLLATE NOCASE, name TEXT, timezone TEXT, is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies(id,code,name,timezone) VALUES(1,'alvi','ALVI','${ZONE}'),(2,'avokado','Авокадо','${ZONE}');
    CREATE TABLE leads(id INTEGER PRIMARY KEY, company_code TEXT, created_at TEXT, stage TEXT, sale_amount REAL, source TEXT, utm_source TEXT, utm_content TEXT, utm_campaign TEXT, referrer TEXT, landing_page TEXT);`);
  const clock = {ms: now};
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.onlypult.com');
    assert.equal(options.method, 'GET', 'сборщик делает только GET');
    assert.equal(options.redirect, 'error');
    assert.ok(!/\/v1\/(profiles|posts)(\/|$)/.test(parsed.pathname), 'publishing-путь не вызывается: ' + parsed.pathname);
    calls.push({path: parsed.pathname, search: Object.fromEntries(parsed.searchParams)});
    if (responses[parsed.pathname] !== undefined) {
      const value = responses[parsed.pathname];
      return typeof value === 'function' ? value(parsed) : wire(value);
    }
    if (parsed.pathname === '/v1/analytics/profiles') return wire([profileRow()]);
    if (parsed.pathname === '/v1/analytics/metrics') return wire(catalogData);
    if (parsed.pathname === `/v1/analytics/${AN}/overview`) return wire(dayData(parsed.searchParams.get('date_from')));
    throw new assert.AssertionError({message: 'мок запрещает адрес ' + parsed.pathname});
  };
  const credentials = createSocialAnalyticsCredentials(db, {apiKey: KEY, now: () => clock.ms});
  const evidence = createSocialAnalyticsEvidence(db, {now: () => clock.ms});
  const collector = createSocialOnlypultAnalytics({fetchImpl, now: () => clock.ms, sleep: async () => {},
    resolveCredential: (code) => credentials.resolve(code)});
  const adapters = createSocialAdapters({analytics: {credentials, collector}});
  const stats = createSocialStats(db, {now: () => clock.ms, adapters, evidence, logger: {warn() {}}});
  return {db, clock, calls, credentials, evidence, collector, adapters, stats};
}

const connect = (f) => {
  f.credentials.save('alvi', 'onlypult_analytics', {revision: 0, credential: SECRET}, {userId: 1, userName: 'Влад'});
  const saved = f.credentials.get('alvi');
  f.credentials.markChecked('alvi', 'onlypult_analytics', {revision: saved.revision, status: 'connected'});
  f.stats.saveAccounts('alvi', {accounts: [{platform: 'instagram', accountRef: NATIVE, provider: 'onlypult',
    providerRef: AN, enabled: true, timezone: ZONE, collectHour: 6, kind: 'organic', displayLabel: 'ALVI Instagram'}]});
};

test('без доступа и без профиля сбор честно останавливается и чисел не выдумывает', async (t) => {
  const f = fixture(t);
  f.stats.saveAccounts('alvi', {accounts: [{platform: 'instagram', accountRef: NATIVE, provider: 'onlypult',
    providerRef: '', enabled: true, timezone: ZONE, collectHour: 6, kind: 'organic', displayLabel: 'ALVI'}]});
  const noKey = await f.stats.collect('alvi', 'instagram', {trigger: 'manual', date: '2026-09-22'});
  assert.equal(noKey.status, 'missing_access');
  assert.equal(f.calls.length, 0, 'без сохранённого доступа сети не касаемся');
  f.credentials.save('alvi', 'onlypult_analytics', {revision: 0, credential: SECRET});
  const noProfile = await f.stats.collect('alvi', 'instagram', {trigger: 'manual', date: '2026-09-22'});
  assert.equal(noProfile.status, 'missing_access');
  assert.ok(noProfile.missing.join(' ').includes('an_'), 'причина называет недостающий аналитический профиль');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_snapshots').get().n, 0, 'ни одного числа не записано');
});

test('полный путь: доступ → профиль → ручной сбор → проекция, покрытие и доказательства', async (t) => {
  const f = fixture(t);
  connect(f);
  const listing = await f.collector.listProfiles('alvi');
  assert.deepEqual(listing.profiles.map((item) => [item.id, item.nativeAccountId, item.timezone]), [[AN, NATIVE, ZONE]]);
  const run = await f.stats.collect('alvi', 'instagram', {trigger: 'manual', date: '2026-09-22'});
  assert.equal(run.status, 'ok');
  assert.ok(run.rows >= 2);
  const rows = f.db.prepare("SELECT metric, value, completeness, timezone, scope FROM social_snapshots WHERE date='2026-09-22' ORDER BY metric").all();
  assert.deepEqual(rows.map((r) => [r.metric, r.value]), [['followers', 136], ['views', 0]]);
  assert.ok(rows.every((r) => r.timezone === ZONE && r.scope === 'profile'));
  assert.equal(rows.find((r) => r.metric === 'views').value, 0, 'подтверждённый ноль сохранён как ноль');
  // Доказательство записано в той же транзакции и знает профиль, аккаунт и покрытие.
  const evidence = f.evidence.list({companyCode: 'alvi'});
  assert.ok(evidence.length);
  assert.equal(evidence[0].providerRef, AN);
  assert.equal(evidence[0].nativeAccountId, NATIVE);
  assert.equal(evidence[0].period.timezone, ZONE);
  assert.equal(evidence[0].coverage.collectionEnabled, true);
  assert.equal(evidence[0].kind, 'collector');
  // Ни одного publishing-запроса, только разрешённые GET.
  assert.deepEqual([...new Set(f.calls.map((c) => c.path))].sort(),
    ['/v1/analytics/an_demo1/overview', '/v1/analytics/metrics', '/v1/analytics/profiles']);
  // Сводка показывает активную систему суток и не пустует по свежести.
  const overview = f.stats.overview('alvi', '2026-09-20', '2026-09-23');
  assert.equal(overview.platforms.instagram.activeInterval, ZONE);
  assert.ok(overview.platforms.instagram.lastCollectedAt);
  assert.deepEqual(overview.platforms.instagram.otherIntervals, []);
});

test('повтор сбора не дублирует проекцию, но доказательство каждого ответа остаётся отдельным', async (t) => {
  const f = fixture(t);
  connect(f);
  await f.stats.collect('alvi', 'instagram', {trigger: 'manual', date: '2026-09-22'});
  const firstEvidence = f.evidence.list({companyCode: 'alvi'}).length;
  await f.stats.collect('alvi', 'instagram', {trigger: 'manual', date: '2026-09-22'});
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM social_snapshots WHERE date='2026-09-22'").get().n, 2, 'проекция не задвоилась');
  assert.ok(f.evidence.list({companyCode: 'alvi'}).length > firstEvidence, 'ответ второго сбора сохранён отдельно');
});

test('аренда с ограждением: вернувшийся зависший сборщик не меняет проекцию и не освобождает чужую аренду', async (t) => {
  const f = fixture(t);
  connect(f);
  const key = {code: 'alvi', platform: 'instagram', accountRef: NATIVE, date: '2026-09-22', intervalKey: ZONE};
  // A взял аренду и «завис».
  const a = {...key, ...f.stats.acquireLease({...key, owner: 'A'})};
  assert.equal(a.ok, true);
  // Пока A висит, повторный сбор за те же сутки не начинается.
  const blocked = await f.stats.collect('alvi', 'instagram', {trigger: 'manual', date: '2026-09-22'});
  assert.equal(blocked.status, 'partial');
  assert.ok(blocked.missing.join(' ').includes('уже идёт'));
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM social_snapshots WHERE date='2026-09-22'").get().n, 0);
  // Аренда A истекла, B взял её и сохранил результат.
  f.clock.ms += 11 * 60 * 1000;
  const saved = await f.stats.collect('alvi', 'instagram', {trigger: 'schedule', date: '2026-09-22'});
  assert.equal(saved.status, 'ok');
  const after = f.db.prepare("SELECT COUNT(*) n FROM social_snapshots WHERE date='2026-09-22'").get().n;
  assert.ok(after > 0);
  // A вернулся: его аренда уже чужая — он ничего не меняет и чужую не освобождает.
  assert.equal(f.stats.releaseLease(a), false, 'чужая аренда не освобождается');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM social_snapshots WHERE date='2026-09-22'").get().n, after);
});

test('неполный день ставится в очередь и не забывается после полуночи; отказ доступа в очередь не идёт', async (t) => {
  const f = fixture(t, {responses: {[`/v1/analytics/${AN}/overview`]: (url) => wire(dayData(url.searchParams.get('date_from'), {
    warnings: ['данные за сутки догружаются'],
    coverage: {covered_from: '2026-09-01', covered_to: '2026-09-22', collecting: true, collection_enabled: true}}))}});
  connect(f);
  const run = await f.stats.collect('alvi', 'instagram', {trigger: 'manual', date: '2026-09-22'});
  assert.equal(run.status, 'partial');
  const queued = f.stats.queuedDates('alvi', 'instagram', NATIVE);
  assert.deepEqual(queued.map((item) => item.date), ['2026-09-22']);
  assert.ok(queued[0].nextAttemptAt > new Date(f.clock.ms).toISOString(), 'повтор отложен, а не крутится в цикле');
  // Отказ доступа очередь не наполняет: причина сама не изменится.
  const denied = fixture(t, {responses: {'/v1/analytics/profiles': () => wire({error: 'no'}, 403)}});
  connect(denied);
  const refused = await denied.stats.collect('alvi', 'instagram', {trigger: 'manual', date: '2026-09-22'});
  assert.equal(refused.status, 'missing_access');
  assert.deepEqual(denied.stats.queuedDates('alvi', 'instagram', NATIVE), []);
});

test('прежние ручные измерения переносятся в доказательства без переименования периода и пояса', async (t) => {
  const f = fixture(t);
  // Реальные ручные замеры: 136 подписчиков Telegram и настоящий 0 у YouTube.
  f.stats.saveAccounts('alvi', {accounts: [
    {platform: 'telegram', accountRef: '@spa_stio_alvi', provider: 'manual', enabled: false, timezone: 'Asia/Bangkok', collectHour: 6, kind: 'unknown', displayLabel: 'ALVI Telegram'},
    {platform: 'youtube', accountRef: 'UCwkOrlmN-iSRdlYN35Qiu5w', provider: 'manual', enabled: false, timezone: 'Asia/Bangkok', collectHour: 6, kind: 'unknown', displayLabel: 'ALVI YouTube'}]});
  f.stats.importManual('alvi', {platform: 'telegram', capturedAt: '2026-09-29T08:58:00Z', sourceNote: 'Telegram Web channel header subscribers',
    kind: 'unknown', rows: [{date: '2026-09-29', period: 'lifetime', metric: 'followers', value: 136}]});
  f.stats.importManual('alvi', {platform: 'youtube', capturedAt: '2026-09-29T09:23:00Z', sourceNote: 'YouTube Studio subscribers',
    kind: 'unknown', rows: [{date: '2026-09-29', period: 'lifetime', metric: 'followers', value: 0}]});
  const before = f.db.prepare('SELECT id,date,period,timezone,value FROM social_snapshots ORDER BY id').all();
  const first = f.stats.migrateLegacyEvidence();
  assert.ok(first.migrated >= 2);
  const second = f.stats.migrateLegacyEvidence();
  assert.equal(second.migrated, 0, 'повтор миграции копий не создаёт');
  assert.equal(second.remaining, 0, 'непереносённых строк не осталось');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM social_analytics_evidence WHERE kind='legacy'").get().n, before.length,
    'одно доказательство на одну исходную строку');
  // Исходные строки не тронуты: ни период, ни пояс, ни значения.
  assert.deepEqual(f.db.prepare('SELECT id,date,period,timezone,value FROM social_snapshots ORDER BY id').all(), before);
  const tg = f.evidence.list({companyCode: 'alvi', platform: 'telegram'})[0];
  assert.equal(tg.points[0].value, 136);
  assert.equal(tg.period.granularity, 'lifetime');
  assert.equal(tg.period.timezone, 'Asia/Bangkok');
  assert.equal(tg.kind, 'legacy');
  const yt = f.evidence.list({companyCode: 'alvi', platform: 'youtube'})[0];
  assert.equal(yt.points[0].value, 0, 'настоящий ноль сохранён как ноль');
  assert.equal(yt.nativeAccountId, 'UCwkOrlmN-iSRdlYN35Qiu5w');
  // Свежесть и разметка считаются по lifetime: карточка больше не показывает прочерки.
  const overview = f.stats.overview('alvi', '2026-09-25', '2026-09-30');
  assert.ok(overview.platforms.telegram.lastCollectedAt, 'свежесть известна по lifetime-замеру');
  assert.deepEqual(overview.platforms.telegram.kinds, ['unknown']);
  assert.equal(overview.platforms.telegram.dataStatus, 'lifetime_only');
});

test('компании изолированы: доступ и профиль одной не собирают статистику другой', async (t) => {
  const f = fixture(t);
  connect(f);
  f.stats.saveAccounts('avokado', {accounts: [{platform: 'instagram', accountRef: NATIVE, provider: 'onlypult',
    providerRef: AN, enabled: true, timezone: ZONE, collectHour: 6, kind: 'organic', displayLabel: 'Авокадо'}]});
  const alien = await f.stats.collect('avokado', 'instagram', {trigger: 'manual', date: '2026-09-22'});
  assert.equal(alien.status, 'missing_access', 'чужой доступ не подставляется');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM social_snapshots WHERE company_code='avokado'").get().n, 0);
});

/* Миграция обязана двигаться вперёд. Прежний LIMIT без отбора каждый раз брал первые N
   строк: при количестве больше страницы последние не переносились никогда. */
test('миграция доказательств идёт постранично и доходит до последней строки', (t) => {
  const f = fixture(t);
  f.stats.saveAccounts('alvi', {accounts: [{platform: 'telegram', accountRef: '@spa_stio_alvi', provider: 'manual',
    enabled: false, timezone: 'Asia/Bangkok', collectHour: 6, kind: 'unknown'}]});
  for (const [date, value] of [['2026-09-25', 130], ['2026-09-26', 132], ['2026-09-27', 136]])
    f.stats.importManual('alvi', {platform: 'telegram', capturedAt: `${date}T08:00:00Z`, sourceNote: 'шапка канала',
      kind: 'unknown', rows: [{date, metric: 'followers', value}]});
  const total = f.db.prepare('SELECT COUNT(*) n FROM social_snapshots').get().n;
  assert.equal(total, 3);
  const first = f.stats.migrateLegacyEvidence({limit: 1});
  assert.equal(first.migrated, 1);
  assert.equal(first.remaining, 2, 'страница пройдена, остаток назван честно');
  const second = f.stats.migrateLegacyEvidence({limit: 1});
  assert.equal(second.migrated, 1, 'вторая страница — следующая строка, а не та же самая');
  const third = f.stats.migrateLegacyEvidence({limit: 1});
  assert.equal(third.migrated, 1);
  assert.equal(third.remaining, 0);
  const refs = f.db.prepare("SELECT legacy_ref FROM social_analytics_evidence WHERE kind='legacy' ORDER BY legacy_ref").all().map((r) => r.legacy_ref);
  assert.equal(new Set(refs).size, 3, 'перенесены все три исходные строки без копий');
  assert.equal(f.stats.migrateLegacyEvidence({limit: 1}).migrated, 0, 'повтор ничего не добавляет');
});

/* Проекция идемпотентна и перезаписывает строку. Значит след первого наблюдения может
   остаться только в добавляемом журнале — иначе «20 и ноль доказательств». */
test('повторный ручной импорт за ту же дату сохраняет оба фактических наблюдения', (t) => {
  const f = fixture(t);
  f.stats.saveAccounts('alvi', {accounts: [{platform: 'telegram', accountRef: '@spa_stio_alvi', provider: 'manual',
    enabled: false, timezone: 'Asia/Bangkok', collectHour: 6, kind: 'unknown'}]});
  f.stats.importManual('alvi', {platform: 'telegram', capturedAt: '2026-09-29T08:00:00Z', sourceNote: 'первый замер',
    kind: 'unknown', rows: [{date: '2026-09-29', metric: 'views', value: 10}]});
  f.stats.importManual('alvi', {platform: 'telegram', capturedAt: '2026-09-29T09:00:00Z', sourceNote: 'уточнённый замер',
    kind: 'unknown', rows: [{date: '2026-09-29', metric: 'views', value: 20}]});
  // Проекция одна — последняя.
  const snapshots = f.db.prepare("SELECT value FROM social_snapshots WHERE metric='views'").all().map((r) => r.value);
  assert.deepEqual(snapshots, [20]);
  // Доказательств два — оба наблюдения, в порядке появления, без перезаписи.
  const evidence = f.evidence.list({companyCode: 'alvi', platform: 'telegram'})
    .filter((item) => item.synapseMetric === 'views').sort((a, b) => a.id - b.id);
  assert.deepEqual(evidence.map((item) => item.points[0].value), [10, 20]);
  assert.deepEqual(evidence.map((item) => item.collectedAt), ['2026-09-29T08:00:00.000Z', '2026-09-29T09:00:00.000Z']);
  assert.match(evidence[0].reason, /первый замер/);
  assert.match(evidence[1].reason, /уточнённый замер/);
  assert.deepEqual(evidence.map((item) => item.kind), ['manual', 'manual']);
});

/* Аренда держится по ключу задания (целевая дата), а lifetime-снимок пишется по
   фактическому ключу — сегодняшнему дню. Сбор за вчера и сбор за сегодня берут разные
   аренды и сталкиваются на одной строке, поэтому нужен порядок по времени наблюдения. */
test('задержавшийся сбор за прошлую дату не перезаписывает более свежий lifetime-замер', (t) => {
  const f = fixture(t);
  f.stats.saveAccounts('alvi', {accounts: [{platform: 'telegram', accountRef: '@spa_stio_alvi', provider: 'manual',
    enabled: false, timezone: 'Asia/Bangkok', collectHour: 6, kind: 'unknown'}]});
  const row = {date: '2026-09-29', period: 'lifetime', metric: 'followers', completeness: 'complete'};
  // B: свежее наблюдение записано первым.
  f.stats.writeSnapshots('alvi', 'telegram', '@spa_stio_alvi', [{...row, value: 200}],
    {provider: 'manual', tz: 'Asia/Bangkok', collectedAt: '2026-09-29T10:00:00.000Z'});
  // A: задержавшийся ответ со старым временем наблюдения приходит позже.
  f.stats.writeSnapshots('alvi', 'telegram', '@spa_stio_alvi', [{...row, value: 100}],
    {provider: 'manual', tz: 'Asia/Bangkok', collectedAt: '2026-09-29T09:00:00.000Z'});
  const stored = f.db.prepare("SELECT value, collected_at FROM social_snapshots WHERE metric='followers'").get();
  assert.equal(stored.value, 200, 'старое наблюдение не вытеснило более свежее');
  assert.equal(stored.collected_at, '2026-09-29T10:00:00.000Z');
  // Более позднее наблюдение по-прежнему обновляет строку.
  f.stats.writeSnapshots('alvi', 'telegram', '@spa_stio_alvi', [{...row, value: 205}],
    {provider: 'manual', tz: 'Asia/Bangkok', collectedAt: '2026-09-29T11:00:00.000Z'});
  assert.equal(f.db.prepare("SELECT value FROM social_snapshots WHERE metric='followers'").get().value, 205);
});

/* MAX(date) без учёта системы суток брал максимум по всем поясам, а внешний фильтр
   активного пояса потом отбрасывал найденную чужую строку: правильная, более ранняя,
   уже была потеряна и latest выходил пустым. */
test('последний lifetime-замер ищется внутри своей системы суток, чужая строка его не гасит', (t) => {
  const f = fixture(t);
  f.stats.saveAccounts('alvi', {accounts: [{platform: 'telegram', accountRef: '@spa_stio_alvi', provider: 'manual',
    enabled: false, timezone: 'UTC', collectHour: 6, kind: 'unknown'}]});
  const base = {period: 'lifetime', metric: 'followers', completeness: 'complete'};
  f.stats.writeSnapshots('alvi', 'telegram', '@spa_stio_alvi', [{...base, date: '2026-09-27', value: 10}],
    {provider: 'manual', tz: 'UTC', collectedAt: '2026-09-27T10:00:00.000Z'});
  f.stats.writeSnapshots('alvi', 'telegram', '@spa_stio_alvi', [{...base, date: '2026-09-28', value: 20}],
    {provider: 'manual', tz: 'Asia/Bangkok', collectedAt: '2026-09-28T10:00:00.000Z'});
  const card = f.stats.overview('alvi', '2026-09-27', '2026-09-28').platforms.telegram;
  assert.equal(card.latest.followers?.value, 10, 'взят последний замер активной системы суток');
  assert.equal(card.latest.followers?.date, '2026-09-27');
  assert.equal(card.otherIntervals.length, 1, 'наблюдение другой системы суток показано отдельно');
  assert.equal(card.otherIntervals[0].timezone, 'Asia/Bangkok');
});
