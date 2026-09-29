'use strict';
/* Выводы «Что видно по данным»: детерминированный расчёт по сохранённым измерениям.
   Все данные синтетические, ни одного обращения к сети и к базе. Проверяется содержание
   вывода и его происхождение, а не наличие текста. */
const test = require('node:test'), assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { buildInsights, previousPeriod, comparability, gapRanges, change, INSIGHTS_RULES_VERSION } = require('./social-insights');
const { createSocialStats } = require('./social-stats');
const { createSocialAnalyticsEvidence } = require('./social-analytics-evidence');
const { createPlatformDemand } = require('./platform-demand');
const { createPlatformCompanyMetrics } = require('./platform-company-metrics');

/* Сводка строится настоящим overview: контракт выводов проверяется против принятой
   аналитики, а не против выдуманного DTO. */
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY, code TEXT UNIQUE COLLATE NOCASE, name TEXT, timezone TEXT, is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies(id,code,name,timezone) VALUES(1,'alvi','АЛВИ','Asia/Irkutsk');
    CREATE TABLE leads(id INTEGER PRIMARY KEY, company_code TEXT, created_at TEXT, stage TEXT, sale_amount REAL, source TEXT, utm_source TEXT, utm_content TEXT, utm_campaign TEXT, referrer TEXT, landing_page TEXT);`);
  const clock = { ms: Date.parse('2026-09-29T02:00:00Z') };
  const evidence = createSocialAnalyticsEvidence(db, { now: () => clock.ms });
  const stats = createSocialStats(db, { now: () => clock.ms, evidence, adapters: {}, logger: { warn() {} } });
  return { db, stats, clock, evidence };
}
const account = (stats, over = {}) => stats.saveAccounts('alvi', { accounts: [{ platform: 'instagram',
  accountRef: '@alvi', provider: 'manual', enabled: false, kind: 'organic', timezone: 'Asia/Irkutsk', collectHour: 6, revision: 0, ...over }] });
const write = (stats, rows, over = {}) => stats.writeSnapshots('alvi', over.platform || 'instagram', over.accountRef ?? '@alvi', rows,
  { provider: over.provider || 'manual', tz: over.tz || 'Asia/Irkutsk', collectedAt: over.collectedAt || '2026-09-28T10:00:00.000Z' });
const day = (date, metric, value, extra = {}) => ({ date, metric, value, period: 'day', completeness: 'complete', kind: 'organic', ...extra });

function insights(f, { from, to, today = '2026-09-29', compare = true, companyMetrics = null, previousCompanyMetrics = null, baseline = null } = {}) {
  const comparison = compare ? previousPeriod(from, to) : null;
  return buildInsights({
    companyCode: 'alvi', period: { from, to, timezone: 'Asia/Irkutsk' },
    current: f.stats.overview('alvi', from, to),
    previous: comparison ? f.stats.overview('alvi', comparison.from, comparison.to) : null,
    comparison, postMetrics: f.stats.postMetrics('alvi', from, to),
    baseline, companyMetrics, previousCompanyMetrics, today,
  });
}
const rule = (out, ruleId, platform = 'instagram', metric = null) => out.observations.find((item) =>
  item.ruleId === ruleId && item.platform === platform && (metric === null || item.metric === metric));

test('чистые помощники: предыдущий интервал, пропуски, процент от нулевой базы, сопоставимость', () => {
  assert.deepEqual(previousPeriod('2026-09-22', '2026-09-28'), { from: '2026-09-15', to: '2026-09-21', days: 7 });
  assert.equal(previousPeriod('2026-09-28', '2026-09-22'), null);
  assert.deepEqual(gapRanges('2026-09-01', '2026-09-05', ['2026-09-01', '2026-09-04']),
    [{ from: '2026-09-02', to: '2026-09-03' }, { from: '2026-09-05', to: '2026-09-05' }]);
  // База 0 — абсолютная разница и честное «процент не определён», без Infinity.
  assert.deepEqual(change(0, 5), { diff: 5, percent: null, percentKnown: false });
  assert.deepEqual(change(100, 150), { diff: 50, percent: 50, percentKnown: true });
  assert.equal(Number.isFinite(change(0, 5).diff), true);
  // Неизвестность совпадением не считается.
  assert.equal(comparability({ accountRef: '@a', timezone: '', provider: 'manual' }, { accountRef: '@a', timezone: '', provider: 'manual' }).ok, false);
  assert.equal(comparability({ accountRef: '@a', timezone: 'UTC', provider: 'manual' }, { accountRef: '@a', timezone: 'UTC', provider: 'manual' }).ok, true);
});

test('семь площадок названы всегда: MAX без источника и ненастроенные аккаунты дают причину, а не ноль', (t) => {
  const f = fixture(t);
  const out = insights(f, { from: '2026-09-22', to: '2026-09-28' });
  assert.equal(out.rulesVersion, INSIGHTS_RULES_VERSION);
  assert.equal(out.companyCode, 'alvi');
  for (const platform of ['instagram', 'tiktok', 'youtube', 'vk', 'telegram', 'max']) {
    assert.ok(out.observations.some((item) => item.platform === platform), platform + ' назван');
  }
  const max = rule(out, 'absent.no_source', 'max');
  assert.ok(max, 'MAX назван отдельно');
  assert.match(max.text, /измерений нет/);
  assert.match(max.text, /настройки публикаций измерениями не являются/);
  assert.doesNotMatch(max.text, /\b0\b/, 'отсутствие источника нулём не называется');
  assert.match(rule(out, 'absent.not_configured', 'vk').text, /аккаунт не настроен/);
  // Ни одного вывода о влиянии на продажи без подтверждённых связей.
  assert.ok(out.observations.some((item) => item.ruleId === 'crm.none_linked'));
  assert.match(rule(out, 'crm.none_linked', 'crm').text, /не «канал не принёс продаж»/);
  // Уникальный охват не складывается.
  assert.ok(out.limitations.some((line) => /Охват не суммируется/.test(line)));
  assert.ok(out.limitations.some((line) => /Замер «ДО» не зафиксирован/.test(line)));
});

test('одиночный замер состояния динамику не доказывает, два сопоставимых — описываются как изменение между датами', (t) => {
  const f = fixture(t);
  account(f.stats);
  write(f.stats, [{ date: '2026-09-28', metric: 'followers', value: 136, period: 'lifetime', completeness: 'complete' }]);
  const single = insights(f, { from: '2026-09-22', to: '2026-09-28' });
  const one = rule(single, 'state.single', 'instagram', 'followers');
  assert.ok(one, 'одиночное состояние показано');
  assert.match(one.text, /136 на 2026-09-28/);
  assert.match(one.text, /одним замером динамика не доказана/);
  assert.equal(one.comparison, 'none');
  // Второй замер в предыдущем интервале — теперь сравнение допустимо.
  write(f.stats, [{ date: '2026-09-15', metric: 'followers', value: 100, period: 'lifetime', completeness: 'complete' }],
    { collectedAt: '2026-09-15T10:00:00.000Z' });
  const both = insights(f, { from: '2026-09-22', to: '2026-09-28' });
  const changed = rule(both, 'state.change', 'instagram', 'followers');
  assert.ok(changed, 'изменение между двумя датами');
  assert.deepEqual(changed.values, { before: 100, after: 136, diff: 36, percent: 36 });
  assert.deepEqual(changed.dates, { previousMeasuredAt: '2026-09-15', measuredAt: '2026-09-28' });
  assert.match(changed.text, /Причина изменения из этих данных не следует/);
  assert.equal(changed.comparison, 'ok');
});

test('смена системы суток и смена аккаунта делают состояния несопоставимыми с явной причиной', (t) => {
  const f = fixture(t);
  account(f.stats);
  write(f.stats, [{ date: '2026-09-15', metric: 'followers', value: 100, period: 'lifetime', completeness: 'complete' }],
    { tz: 'Asia/Bangkok', collectedAt: '2026-09-15T10:00:00.000Z' });
  write(f.stats, [{ date: '2026-09-28', metric: 'followers', value: 136, period: 'lifetime', completeness: 'complete' }]);
  const out = insights(f, { from: '2026-09-22', to: '2026-09-28' });
  // Прежний пояс в активный ряд не входит: у предыдущего интервала сопоставимого состояния нет.
  assert.ok(rule(out, 'state.single', 'instagram', 'followers'), 'сравнивать не с чем — показан одиночный замер');
  assert.ok(rule(out, 'coverage.other_interval', 'instagram'), 'наблюдение другой системы суток названо отдельно');
  assert.match(rule(out, 'coverage.other_interval', 'instagram').text, /С основным рядом они не складываются/);
});

test('покрытие: известно N из M дней, пропуски диапазонами, итог и тренд по неполному ряду не считаются', (t) => {
  const f = fixture(t);
  account(f.stats);
  write(f.stats, [day('2026-09-22', 'views', 10), day('2026-09-23', 'views', 20), day('2026-09-26', 'views', 30)]);
  const out = insights(f, { from: '2026-09-22', to: '2026-09-28' });
  const partial = rule(out, 'coverage.partial', 'instagram', 'views');
  assert.ok(partial);
  assert.match(partial.text, /известны за 3 из 7 дн/);
  assert.match(partial.text, /2026-09-24—2026-09-25/);
  assert.match(partial.text, /2026-09-27—2026-09-28/);
  assert.match(partial.text, /Итог за период, тренд и прогноз по неполному ряду не считаются/);
  assert.equal(partial.comparison, 'not_comparable');
  assert.ok(out.nextSteps.some((line) => /догрузить или собрать пропущенные дни/.test(line)));
  // Пропуск ОДНОЙ метрики не скрывает наличие другой.
  write(f.stats, [day('2026-09-22', 'likes', 1), day('2026-09-23', 'likes', 2), day('2026-09-24', 'likes', 3),
    day('2026-09-25', 'likes', 4), day('2026-09-26', 'likes', 5), day('2026-09-27', 'likes', 6), day('2026-09-28', 'likes', 7)]);
  const mixed = insights(f, { from: '2026-09-22', to: '2026-09-28' });
  assert.match(rule(mixed, 'coverage.full', 'instagram', 'likes').text, /известны за все 7 дн/);
  assert.ok(rule(mixed, 'coverage.partial', 'instagram', 'views'), 'пропуск просмотров по-прежнему назван');
});

test('сравнение двух полных интервалов считается, при неполном предыдущем — отказ с причиной', (t) => {
  const f = fixture(t);
  account(f.stats);
  const week = (start, value) => Array.from({ length: 7 }, (_, i) =>
    day(new Date(Date.parse(start + 'T00:00:00Z') + i * 86400000).toISOString().slice(0, 10), 'views', value));
  write(f.stats, week('2026-09-22', 20));
  const half = insights(f, { from: '2026-09-22', to: '2026-09-28' });
  const noPrev = rule(half, 'compare.previous_partial', 'instagram', 'views');
  assert.ok(noPrev, 'без предыдущего интервала сравнения нет');
  assert.match(noPrev.text, /известно 0 из 7 дн/);
  write(f.stats, week('2026-09-15', 10), { collectedAt: '2026-09-21T10:00:00.000Z' });
  const out = insights(f, { from: '2026-09-22', to: '2026-09-28' });
  const cmp = rule(out, 'compare.interval', 'instagram', 'views');
  assert.ok(cmp);
  assert.deepEqual(cmp.values, { before: 70, after: 140, diff: 70, percent: 100 });
  assert.deepEqual(cmp.dates, { from: '2026-09-22', to: '2026-09-28', previousFrom: '2026-09-15', previousTo: '2026-09-21' });
  assert.equal(out.comparisonPeriod.from, '2026-09-15');
  assert.match(cmp.text, /Причина изменения из этих данных не следует/);
});

test('нулевая база даёт абсолютную разницу без Infinity, а подтверждённый 0 отличается от null и от отсутствия строки', (t) => {
  const f = fixture(t);
  account(f.stats);
  const week = (start, value) => Array.from({ length: 7 }, (_, i) =>
    day(new Date(Date.parse(start + 'T00:00:00Z') + i * 86400000).toISOString().slice(0, 10), 'views', value));
  write(f.stats, week('2026-09-15', 0), { collectedAt: '2026-09-21T10:00:00.000Z' });
  write(f.stats, week('2026-09-22', 5));
  const out = insights(f, { from: '2026-09-22', to: '2026-09-28' });
  const cmp = rule(out, 'compare.interval', 'instagram', 'views');
  assert.equal(cmp.values.before, 0);
  assert.equal(cmp.values.diff, 35);
  assert.equal(cmp.values.percent, null);
  assert.match(cmp.text, /процент не определён: база равна нулю/);
  assert.doesNotMatch(JSON.stringify(out), /Infinity|null%/);
  // Строки с null: это отсутствие измерения, а не ноль.
  const g = fixture(t);
  account(g.stats);
  write(g.stats, [day('2026-09-22', 'likes', null, { completeness: 'unknown' })]);
  const empty = insights(g, { from: '2026-09-22', to: '2026-09-28' });
  const rows = rule(empty, 'coverage.rows_without_values', 'instagram', 'likes');
  assert.ok(rows);
  assert.match(rows.text, /Это отсутствие измерения, а не ноль/);
});

test('незавершённый день не сравнивается с полными сутками и границы периода молча не меняются', (t) => {
  const f = fixture(t);
  account(f.stats);
  write(f.stats, [day('2026-09-28', 'views', 10), day('2026-09-29', 'views', 4, { completeness: 'partial' })]);
  const out = insights(f, { from: '2026-09-23', to: '2026-09-29', today: '2026-09-29' });
  assert.equal(out.requestedPeriod.to, '2026-09-29', 'границы не сдвинуты');
  assert.equal(out.requestedPeriod.includesToday, true);
  assert.ok(out.limitations.some((line) => /незавершённый день 2026-09-29/.test(line)));
  assert.equal(out.observations.some((item) => item.ruleId === 'compare.interval'), false, 'сравнения с полными сутками нет');
});

test('охват не суммируется, среднее без весов общим показателем не становится, рейтинг площадок не строится', (t) => {
  const f = fixture(t);
  account(f.stats);
  const week = (start, metric, value) => Array.from({ length: 7 }, (_, i) =>
    day(new Date(Date.parse(start + 'T00:00:00Z') + i * 86400000).toISOString().slice(0, 10), metric, value));
  write(f.stats, week('2026-09-22', 'reach', 12));
  write(f.stats, week('2026-09-22', 'retention_percent', 40));
  const out = insights(f, { from: '2026-09-22', to: '2026-09-28' });
  const reach = rule(out, 'coverage.not_summable', 'instagram', 'reach');
  assert.ok(reach);
  assert.match(reach.text, /Итог за период не считается/);
  assert.match(reach.text, /одни и те же люди могли увидеть материал несколько раз/);
  assert.equal(reach.values.knownDays, 7);
  assert.equal(reach.comparison, 'not_comparable');
  assert.equal(rule(out, 'coverage.full', 'instagram', 'reach'), undefined, 'суммы охвата в выводах нет');
  assert.ok(rule(out, 'coverage.not_summable', 'instagram', 'retention_percent'));
  assert.ok(out.limitations.some((line) => /Общий рейтинг площадок не строится/.test(line)));
});

test('вид измерения — область показателя: одинаковый вид сравнивается, смена и неоднозначность — нет', (t) => {
  const week = (start, value, kind) => Array.from({ length: 2 }, (_, i) =>
    day(new Date(Date.parse(start + 'T00:00:00Z') + i * 86400000).toISOString().slice(0, 10), 'likes', value, { kind }));
  // Органика против рекламы при одном аккаунте, провайдере и поясе — это разные области.
  const swapped = fixture(t);
  account(swapped.stats);
  write(swapped.stats, week('2026-09-25', 10, 'organic'), { collectedAt: '2026-09-26T10:00:00.000Z' });
  write(swapped.stats, week('2026-09-27', 20, 'paid'));
  const out = insights(swapped, { from: '2026-09-27', to: '2026-09-28' });
  assert.equal(rule(out, 'compare.interval', 'instagram', 'likes'), undefined, 'органику с рекламой не сравниваем');
  const refused = rule(out, 'compare.not_comparable', 'instagram', 'likes');
  assert.ok(refused);
  assert.match(refused.reason, /вид измерения сменился: было «органика», стало «реклама»/);
  // Несколько видов внутри интервала — неоднозначность, а не «смешанное как один ряд».
  const ambiguous = fixture(t);
  account(ambiguous.stats);
  write(ambiguous.stats, week('2026-09-25', 10, 'organic'), { collectedAt: '2026-09-26T10:00:00.000Z' });
  write(ambiguous.stats, [day('2026-09-27', 'likes', 20, { kind: 'organic' }), day('2026-09-28', 'likes', 20, { kind: 'paid' })]);
  const mixedOut = insights(ambiguous, { from: '2026-09-27', to: '2026-09-28' });
  assert.match(rule(mixedOut, 'compare.not_comparable', 'instagram', 'likes').reason,
    /в интервале смешаны разные виды измерения/);
  assert.match(rule(mixedOut, 'coverage.full', 'instagram', 'likes').text, /органика и реклама не разделены/);
  // Один и тот же вид с обеих сторон — сравнение допустимо, вид назван прямо.
  const same = fixture(t);
  account(same.stats);
  write(same.stats, week('2026-09-25', 10, 'organic'), { collectedAt: '2026-09-26T10:00:00.000Z' });
  write(same.stats, week('2026-09-27', 20, 'organic'));
  const ok = insights(same, { from: '2026-09-27', to: '2026-09-28' });
  const cmp = rule(ok, 'compare.interval', 'instagram', 'likes');
  assert.ok(cmp);
  assert.deepEqual(cmp.values, { before: 20, after: 40, diff: 20, percent: 100 });
  assert.match(cmp.text, /Оба интервала измерены как «органика»/);
  assert.doesNotMatch(cmp.text, /реклам[аы] дал|благодаря контенту|работа команды/);
  // Неразмеченное с обеих сторон не доказывает одну область показателя.
  const unknownBoth = fixture(t);
  account(unknownBoth.stats);
  write(unknownBoth.stats, week('2026-09-25', 10, 'unknown'), { collectedAt: '2026-09-26T10:00:00.000Z' });
  write(unknownBoth.stats, week('2026-09-27', 20, 'unknown'));
  const unknownOut = insights(unknownBoth, { from: '2026-09-27', to: '2026-09-28' });
  assert.equal(rule(unknownOut, 'compare.interval', 'instagram', 'likes'), undefined);
  assert.match(rule(unknownOut, 'compare.not_comparable', 'instagram', 'likes').reason, /область измерения не подтверждена/);
});

test('ручной импорт: неизвестный вид не делает organic_likes и paid_likes сопоставимыми', (t) => {
  const f = fixture(t);
  account(f.stats, {kind: 'unknown'});
  for (const [dates, value, sourceField] of [
    [['2026-09-25', '2026-09-26'], 10, 'organic_likes'],
    [['2026-09-27', '2026-09-28'], 20, 'paid_likes'],
  ]) f.stats.importManual('alvi', {platform: 'instagram', capturedAt: '2026-09-28T10:00:00Z',
    sourceNote: 'Синтетический отчёт источника', kind: 'unknown',
    rows: dates.map(date => day(date, 'likes', value, {kind: 'unknown', sourceField}))}, {userId: 1});
  const out = f.stats.insights('alvi', '2026-09-27', '2026-09-28');
  assert.equal(rule(out, 'compare.interval', 'instagram', 'likes'), undefined);
  assert.match(rule(out, 'compare.not_comparable', 'instagram', 'likes').reason, /область измерения не подтверждена/);
});

test('публикации: период относится к датам измерения, прирост и рейтинг публикаций не считаются', (t) => {
  const f = fixture(t);
  account(f.stats);
  f.stats.writePosts('alvi', 'instagram', [{ platformPostId: 'ig-1', url: 'https://www.instagram.com/p/abc/',
    publishedAt: '2026-09-10T08:00:00.000Z', date: '2026-09-24', metrics: [{ metric: 'views', value: 50, date: '2026-09-24' }] }],
    { provider: 'manual' });
  const out = insights(f, { from: '2026-09-22', to: '2026-09-28' });
  const meaning = out.observations.find((item) => item.ruleId === 'posts.period_meaning');
  assert.ok(meaning);
  assert.match(meaning.text, /датам ИЗМЕРЕНИЯ показателей, а не к датам выхода/);
  assert.ok(out.limitations.some((line) => /прирост, сумма по дням и рейтинг публикаций не считаются/.test(line)));
  assert.ok(out.limitations.some((line) => /Подтверждение выхода публикации просмотров не даёт/.test(line)));
});

/* 2ГИС считается по НАСТОЯЩЕЙ сводке platform-company-metrics: придуманный DTO не
   доказывает, что реальные пояса отчётов различаются и попадают в проверку. */
function gisFixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(id INTEGER PRIMARY KEY, code TEXT UNIQUE COLLATE NOCASE, name TEXT, is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies(id,code,name) VALUES(1,'alvi','АЛВИ');`);
  const clock = { ms: Date.parse('2026-09-30T05:00:00Z') };
  const demand = createPlatformDemand(db, { now: () => clock.ms });
  const metrics = createPlatformCompanyMetrics(db, { now: () => clock.ms });
  demand.saveSettings('alvi', { revision: demand.get('alvi').settings.revision, organizationId: '70000000000000001',
    organizationName: 'АЛВИ', city: 'Иркутск', cabinetUrl: 'https://account.2gis.com/orgs/70000000000000001/stats',
    branchId: '70000000000000002' }, { userId: 1, userName: 'Владелец' });
  const load = (list) => {
    const seen = metrics.preview('alvi', { reports: list }, { userId: 1, userName: 'Владелец' });
    return metrics.importReports('alvi', { settingsRevision: demand.get('alvi').settings.revision,
      dataRevision: seen.dataRevision, packageHash: seen.packageHash, confirmReplace: false, reports: list },
      { userId: 1, userName: 'Владелец' });
  };
  const report = (from, to, timezone, values) => ({ reportKind: 'appearance', periodStart: from, periodEnd: to,
    granularity: 'day', timezone, capturedDate: '2026-09-29', capturedAt: null, sourceKind: 'official_xlsx',
    sourceUrl: 'https://account.2gis.com/orgs/70000000000000001/stats', originalFilename: 'appearance.xlsx',
    originalFileSha256: 'a'.repeat(64), scopeNote: null,
    rows: values.map((value, index) => ({ date: new Date(Date.parse(from + 'T00:00:00Z') + index * 86400000).toISOString().slice(0, 10),
      metric: 'appearance_views', value, sourcePosition: `A${index + 2}` })) });
  return { db, metrics, load, report };
}

test('2ГИС: сравнение идёт по реальным системам суток отчётов, а не по флагу «пояс назван»', (t) => {
  const f = gisFixture(t);
  // Оба отчёта с НАЗВАННЫМ поясом, но пояса разные: UTC и Asia/Irkutsk.
  f.load([f.report('2026-09-25', '2026-09-26', 'UTC', [20, 20])]);
  f.load([f.report('2026-09-27', '2026-09-28', 'Asia/Irkutsk', [40, 40])]);
  const current = f.metrics.summary('alvi', '2026-09-27', '2026-09-28');
  const previous = f.metrics.summary('alvi', '2026-09-25', '2026-09-26');
  const views = current.metrics.find((item) => item.metric === 'appearance_views');
  assert.equal(views.timezoneKnown, true, 'флаг источника говорит лишь, что пояс назван');
  assert.equal(previous.metrics.find((item) => item.metric === 'appearance_views').timezoneKnown, true);
  const out = buildInsights({ companyCode: 'alvi', period: { from: '2026-09-27', to: '2026-09-28' },
    current: { platforms: {}, metrics: {}, crm: null }, comparison: previousPeriod('2026-09-27', '2026-09-28'),
    companyMetrics: current, previousCompanyMetrics: previous, today: '2026-09-30' });
  assert.equal(out.companyMetrics.some((item) => item.ruleId === 'gis.compare'), false, 'разные пояса не сравниваются');
  const refused = out.companyMetrics.find((item) => item.ruleId === 'gis.not_comparable' && item.metric === 'appearance_views');
  assert.ok(refused);
  assert.match(refused.reason, /система суток отчётов разная: UTC и Asia\/Irkutsk/);
  const coverage = out.companyMetrics.find((item) => item.ruleId === 'gis.coverage' && item.metric === 'appearance_views');
  assert.match(coverage.text, /система суток отчётов: Asia\/Irkutsk/);
  assert.deepEqual(coverage.sources.timezones, ['Asia/Irkutsk']);
  assert.ok(coverage.sources.reportIds.length);
});

test('2ГИС: одинаковый реальный пояс сравнивается, неизвестный — нет', (t) => {
  const same = gisFixture(t);
  same.load([same.report('2026-09-25', '2026-09-26', 'Asia/Irkutsk', [20, 20])]);
  same.load([same.report('2026-09-27', '2026-09-28', 'Asia/Irkutsk', [40, 40])]);
  const out = buildInsights({ companyCode: 'alvi', period: { from: '2026-09-27', to: '2026-09-28' },
    current: { platforms: {}, metrics: {}, crm: null }, comparison: previousPeriod('2026-09-27', '2026-09-28'),
    companyMetrics: same.metrics.summary('alvi', '2026-09-27', '2026-09-28'),
    previousCompanyMetrics: same.metrics.summary('alvi', '2026-09-25', '2026-09-26'), today: '2026-09-30' });
  const cmp = out.companyMetrics.find((item) => item.ruleId === 'gis.compare' && item.metric === 'appearance_views');
  assert.ok(cmp, 'один и тот же пояс — сравнение допустимо');
  assert.deepEqual(cmp.values, { before: 40, after: 80, diff: 40, percent: 100 });
  // Позиция в выдаче из загруженных отчётов не суммируется и не усредняется.
  assert.equal(out.companyMetrics.some((item) => item.metric === 'search_position' && item.ruleId === 'gis.compare'), false);
  // Неназванный пояс сравнение закрывает.
  const unknown = gisFixture(t);
  unknown.load([unknown.report('2026-09-25', '2026-09-26', null, [20, 20])]);
  unknown.load([unknown.report('2026-09-27', '2026-09-28', 'Asia/Irkutsk', [40, 40])]);
  const blocked = buildInsights({ companyCode: 'alvi', period: { from: '2026-09-27', to: '2026-09-28' },
    current: { platforms: {}, metrics: {}, crm: null }, comparison: previousPeriod('2026-09-27', '2026-09-28'),
    companyMetrics: unknown.metrics.summary('alvi', '2026-09-27', '2026-09-28'),
    previousCompanyMetrics: unknown.metrics.summary('alvi', '2026-09-25', '2026-09-26'), today: '2026-09-30' });
  assert.match(blocked.companyMetrics.find((item) => item.ruleId === 'gis.not_comparable' && item.metric === 'appearance_views').reason,
    /часовой пояс отчётов неизвестен/);
});

test('2ГИС не настроен: соцсети считаются дальше, а у 2ГИС честная причина отсутствия', (t) => {
  const f = fixture(t);
  account(f.stats);
  write(f.stats, [{ date: '2026-09-28', metric: 'followers', value: 136, period: 'lifetime', completeness: 'complete' }]);
  const out = insights(f, { from: '2026-09-22', to: '2026-09-28', companyMetrics: null });
  const gis = out.companyMetrics.find((item) => item.ruleId === 'gis.absent');
  assert.ok(gis);
  assert.match(gis.text, /Это отсутствие данных, а не ноль/);
  assert.ok(rule(out, 'state.single', 'instagram', 'followers'), 'соцсети посчитаны несмотря на отсутствие 2ГИС');
});

test('замер «ДО» только ссылается на зафиксированную версию и её дополнение сегодняшним не обещает', (t) => {
  const f = fixture(t);
  account(f.stats);
  const out = insights(f, { from: '2026-09-22', to: '2026-09-28', baseline: { latest: { version: 2 } } });
  assert.equal(out.baselineVersion, 2);
  assert.ok(out.limitations.some((line) => /версию замера №2/.test(line) && /не дополняется/.test(line)));
});

test('расчёт детерминирован: одинаковый вход даёт побайтно одинаковый результат', (t) => {
  const f = fixture(t);
  account(f.stats);
  write(f.stats, [day('2026-09-22', 'views', 10), day('2026-09-23', 'views', 20)]);
  write(f.stats, [{ date: '2026-09-28', metric: 'followers', value: 136, period: 'lifetime', completeness: 'complete' }]);
  const first = insights(f, { from: '2026-09-22', to: '2026-09-28' });
  const second = insights(f, { from: '2026-09-22', to: '2026-09-28' });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  // Ни одного секрета и ни одного персонального поля заявок в сводке.
  assert.doesNotMatch(JSON.stringify(first), /token|bearer|secret|password|@mail|\+7\d{10}/i);
});

/* Воспроизведение приёмки: все дни обоих интервалов представлены, но текущие помечены
   partial. Строка есть и значение есть — а полнота не подтверждена; сравнивать нельзя. */
test('полнота каждого дня обязательна: partial и unknown не равны complete', (t) => {
  const f = fixture(t);
  account(f.stats);
  write(f.stats, [day('2026-09-25', 'views', 10), day('2026-09-26', 'views', 10)],
    { collectedAt: '2026-09-26T10:00:00.000Z' });
  write(f.stats, [day('2026-09-27', 'views', 20, { completeness: 'partial' }),
    day('2026-09-28', 'views', 20, { completeness: 'partial' })]);
  const out = insights(f, { from: '2026-09-27', to: '2026-09-28' });
  assert.equal(rule(out, 'compare.interval', 'instagram', 'views'), undefined,
    'незакрытые сутки с закрытыми не сравниваются');
  const partial = rule(out, 'coverage.partial', 'instagram', 'views');
  assert.ok(partial, 'интервал назван неполным');
  assert.equal(partial.values.knownDays, 2);
  assert.equal(partial.values.completeDays, 0);
  assert.match(partial.text, /подтверждены как полные 0/);
  assert.match(partial.reason, /не подтверждены как полные/);
  assert.equal(rule(out, 'coverage.full', 'instagram', 'views'), undefined, 'итог по неподтверждённому ряду не считается');
  // Зеркальный случай: текущий интервал полный, предыдущий — нет.
  const g = fixture(t);
  account(g.stats);
  write(g.stats, [day('2026-09-25', 'views', 10, { completeness: 'unknown' }), day('2026-09-26', 'views', 10)],
    { collectedAt: '2026-09-26T10:00:00.000Z' });
  write(g.stats, [day('2026-09-27', 'views', 20), day('2026-09-28', 'views', 20)]);
  const mirror = insights(g, { from: '2026-09-27', to: '2026-09-28' });
  assert.equal(rule(mirror, 'compare.interval', 'instagram', 'views'), undefined);
  const refused = rule(mirror, 'compare.previous_partial', 'instagram', 'views');
  assert.ok(refused);
  assert.equal(refused.values.completeDays, 1);
  assert.match(refused.reason, /не подтверждены как полные/);
  // Оба интервала полные и подтверждённые — сравнение проходит.
  const ok = fixture(t);
  account(ok.stats);
  write(ok.stats, [day('2026-09-25', 'views', 10), day('2026-09-26', 'views', 10)],
    { collectedAt: '2026-09-26T10:00:00.000Z' });
  write(ok.stats, [day('2026-09-27', 'views', 20), day('2026-09-28', 'views', 20)]);
  const cmp = rule(insights(ok, { from: '2026-09-27', to: '2026-09-28' }), 'compare.interval', 'instagram', 'views');
  assert.ok(cmp);
  assert.deepEqual(cmp.values, { before: 20, after: 40, diff: 20, percent: 100 });
});
