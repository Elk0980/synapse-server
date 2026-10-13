'use strict';
/* Суточный сбор YouTube: views и engagedViews раздельно, задержанный хвост, закрытые и
   открытые сутки по Pacific с DST, строгий разбор отчёта, общий срок и остановка, отзыв и
   квота при сборе. Ответы — настоящие Response Node 24 с синтетическими данными; сеть не вызывается. */
const test = require('node:test'), assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createSocialAnalyticsCredentials} = require('./social-analytics-credentials');
const {createSocialYoutubeAccess, YOUTUBE_READONLY_SCOPES, YOUTUBE_OAUTH_TOKEN_URL: TOKEN_URL,
  YOUTUBE_DATA_API_CHANNELS: CHANNELS_URL} = require('./social-youtube-access');
const {createSocialYoutubeStats, YOUTUBE_ANALYTICS_REPORTS: REPORTS_URL, YOUTUBE_DAILY_METRICS,
  YOUTUBE_REPORT_DAY_SYSTEM, YOUTUBE_VIEWS_DEFINITION_CHANGE, YOUTUBE_SHORTS_VIEWS_METHOD} = require('./social-youtube-stats');

const CHANNEL = 'UCabcdefghijklmnopqrstuv';
const OTHER_CHANNEL = 'UCzyxwvutsrqponmlkjihgfe';
const SECRET = JSON.stringify({clientId: 'client-123.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-secret-value', refreshToken: '1//refresh-token-value'});
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});
const TOKEN = {access_token: 'ya29.token', expires_in: 3600, scope: YOUTUBE_READONLY_SCOPES.join(' ')};
const channelsBody = (patch = {}) => ({items: [{id: patch.id || CHANNEL, snippet: {title: 'ALVI Spa', customUrl: '@alvispa'},
  statistics: patch.hidden ? {hiddenSubscriberCount: true} : {subscriberCount: '1230'}}]});
// Колонки идут НЕ в том порядке, в котором их просили.
const HEADERS = ['likes', 'day', 'views', 'estimatedMinutesWatched', 'comments', 'shares', 'subscribersGained', 'subscribersLost'];
const header = (name) => ({name, columnType: name === 'day' ? 'DIMENSION' : 'METRIC', dataType: name === 'day' ? 'STRING' : 'INTEGER'});
const reportBody = (rows, headers = HEADERS) => ({kind: 'youtubeAnalytics#resultTable', columnHeaders: headers.map(header), rows});
const params = (url) => new URL(url).searchParams;
const isEngaged = (url) => params(url).get('metrics') === 'engagedViews';
const delay = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

function ok({url}) {
  if (url === TOKEN_URL) return json(TOKEN);
  if (url.startsWith(CHANNELS_URL)) return json(params(url).has('forHandle') ? {items: [{id: CHANNEL}]} : channelsBody());
  if (url.startsWith(REPORTS_URL)) {
    const day = params(url).get('startDate');
    return isEngaged(url) ? json(reportBody([[day, 95]], ['day', 'engagedViews']))
      : json(reportBody([[4, day, 120, 45, 3, 2, 7, 1]]));
  }
  return json({}, 404);
}
// Ответ отчёта для основного запроса; engagedViews и остальное — как в ok.
const mainReport = (make) => ({url}) => (url.startsWith(REPORTS_URL) && !isEngaged(url) ? make(params(url).get('startDate')) : ok({url}));
async function waitFor(check) {
  for (let i = 0; i < 400 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), 'ожидаемое состояние не наступило');
}

function fixture(t, {handler = ok, timeoutMs = 300, collectTimeoutMs, engaged = true, at = '2026-09-30T18:00:00Z'} = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let clock = Date.parse(at);
  const calls = [];
  const credentials = createSocialAnalyticsCredentials(db, {apiKey: 'server-key', now: () => clock});
  const f = {db, credentials, calls, handler};
  const fetchImpl = async (url, init = {}) => {
    calls.push({url: String(url), method: init.method || 'GET', redirect: init.redirect});
    return f.handler({url: String(url), init, f});
  };
  f.access = createSocialYoutubeAccess(db, {credentials, fetchImpl, now: () => clock, timeoutMs});
  f.youtube = createSocialYoutubeStats({access: f.access, now: () => clock, collectEngagedViews: engaged,
    ...(collectTimeoutMs ? {collectTimeoutMs} : {})});
  f.saved = () => f.access.saveAccess('alvi', {revision: f.access.get('alvi').revision, credential: SECRET});
  f.connect = async () => { f.saved(); return f.access.verify('alvi', {accountRef: CHANNEL}); };
  f.advance = (ms) => { clock += ms; };
  f.reports = () => calls.filter((call) => call.url.startsWith(REPORTS_URL));
  f.collect = (date = '2026-09-29', extra = {}) => f.youtube.collectDate('alvi', {date, closed: true, accountRef: CHANNEL, ...extra});
  return f;
}
const byMetric = (result) => new Map(result.snapshots.map((row) => [row.metric, row]));
const dayRows = (result) => result.snapshots.filter((row) => row.period === 'day');

test('views и engagedViews — отдельные запросы и отдельные показатели; закрытый полный день ok без повтора', async (t) => {
  const f = fixture(t);
  await f.connect();
  const result = await f.collect();
  const rows = byMetric(result);
  assert.equal(rows.get('views').value, 120);
  assert.equal(rows.get('views').sourceField, 'reports.query.views');
  assert.equal(rows.get('engaged_views').value, 95);
  assert.equal(rows.get('engaged_views').sourceField, 'reports.query.engagedViews');
  assert.equal(rows.get('watch_time_seconds').value, 45 * 60, 'минуты переведены в секунды');
  assert.equal(rows.get('follower_change').value, 6);
  const followers = rows.get('followers');
  assert.equal(followers.period, 'lifetime');
  assert.equal(followers.date, undefined, 'текущее число подписчиков — состояние, не суточная величина');
  assert.equal(result.status, 'ok');
  assert.equal(result.retryable, false);
  assert.deepEqual(result.missing, [], 'округление подписчиков — оговорка, а не пробел, требующий повторов');
  assert.ok(result.caveats.some((line) => /округлено YouTube вниз/.test(line)));
  assert.ok(dayRows(result).every((row) => row.completeness === 'complete'));
  const [main, engaged] = f.reports().map((call) => params(call.url));
  assert.equal(main.get('metrics'), YOUTUBE_DAILY_METRICS.join(','));
  assert.equal(main.get('metrics').includes('engagedViews'), false, 'views не заменяется engagedViews');
  assert.equal(engaged.get('metrics'), 'engagedViews');
  assert.equal(main.get('ids'), `channel==${CHANNEL}`);
  assert.equal(main.get('startDate'), '2026-09-29');
  assert.equal(main.get('endDate'), '2026-09-29');
  assert.ok(f.reports().every((call) => call.redirect === 'error'));
  assert.equal(result.provenance.timezone, YOUTUBE_REPORT_DAY_SYSTEM);
  assert.equal(result.provenance.nativeAccountId, CHANNEL);
  assert.ok(result.provenance.methodology.sources.includes('https://developers.google.com/youtube/reporting/revision_history'));
});

test('отказ engagedViews не уничтожает остальные показатели; временный отказ оставляет повтор', async (t) => {
  const rejected = fixture(t, {handler: ({url}) => (url.startsWith(REPORTS_URL) && isEngaged(url)
    ? json({error: {code: 400, message: 'Unknown metric'}}, 400) : ok({url}))});
  await rejected.connect();
  const unsupported = await rejected.collect();
  assert.equal(byMetric(unsupported).get('views').value, 120);
  assert.equal(byMetric(unsupported).has('engaged_views'), false);
  assert.ok(unsupported.missing.some((line) => /engagedViews/.test(line) && /не заменяются/.test(line)));
  assert.equal(JSON.stringify(unsupported).includes('Unknown metric'), false, 'текст Google не пересказывается');
  assert.equal(unsupported.status, 'ok');

  const limited = fixture(t, {handler: ({url}) => (url.startsWith(REPORTS_URL) && isEngaged(url)
    ? json({error: {code: 403, errors: [{reason: 'quotaExceeded'}]}}, 403) : ok({url}))});
  await limited.connect();
  const later = await limited.collect();
  assert.equal(byMetric(later).get('views').value, 120);
  assert.equal(later.status, 'partial');
  assert.equal(later.retryable, true);
  assert.equal(limited.access.get('alvi').channelConfirmed, true, 'квота — не отзыв');
});

test('нет строки за запрошенное вчера: partial с повтором, не failed и не нули; подписчики сохраняются', async (t) => {
  const f = fixture(t, {handler: ({url}) => (url.startsWith(REPORTS_URL)
    ? json(isEngaged(url) ? reportBody([], ['day', 'engagedViews']) : reportBody([])) : ok({url}))});
  await f.connect();
  const result = await f.collect('2026-09-29');
  assert.equal(result.status, 'partial');
  assert.equal(result.retryable, true);
  assert.equal('error' in result, false);
  assert.equal(dayRows(result).length, 0, 'суточных строк нет — и нулевых тоже');
  assert.equal(byMetric(result).get('followers').value, 1230);
  assert.ok(result.missing.some((line) => /не нулевые сутки/.test(line)));
  assert.ok(result.missing.some((line) => /ещё не готовы/.test(line)));
  assert.ok(result.provenance.warnings.some((line) => /раньше запрошенной даты/.test(line)));
  assert.equal(result.provenance.coverage, 0);

  const blank = fixture(t, {handler: mainReport((day) => json(reportBody([[null, day, null, null, null, null, null, null]])))});
  await blank.connect();
  const empty = await blank.collect();
  assert.equal(empty.status, 'partial');
  assert.equal(empty.retryable, true);
  assert.ok(empty.missing.some((line) => /источник не дал/.test(line)));
  assert.equal(byMetric(empty).has('views'), false, 'null — неизвестность, а не ноль');
});

test('незакрытые сутки по Pacific с DST: partial с повтором, даже если вызывающий назвал их закрытыми', async (t) => {
  const f = fixture(t);
  await f.connect();
  const open = await f.collect('2026-09-29', {closed: false});
  assert.equal(open.status, 'partial');
  assert.equal(open.retryable, true);
  assert.ok(dayRows(open).every((row) => row.completeness === 'partial'));

  // 06:30Z 13.10 — в Лос-Анджелесе (PDT, UTC−7) ещё 12.10.
  const evening = fixture(t, {at: '2026-10-13T06:30:00Z'});
  await evening.connect();
  assert.equal(evening.youtube.reportDay(Date.parse('2026-10-13T06:30:00Z')), '2026-10-12');
  const today = await evening.collect('2026-10-12');
  assert.equal(today.status, 'partial');
  assert.equal(today.retryable, true);
  assert.ok(today.missing.some((line) => /ещё не закрыты/.test(line)));
  const before = evening.calls.length;
  const future = await evening.collect('2026-10-13');
  assert.equal(future.status, 'missing_access');
  assert.equal(evening.calls.length, before, 'не начавшиеся сутки в сеть не запрашиваются');
  // Одинаковые 07:30Z — разные даты летом (PDT) и зимой (PST).
  assert.equal(f.youtube.reportDay(Date.parse('2026-07-01T07:30:00Z')), '2026-07-01');
  assert.equal(f.youtube.reportDay(Date.parse('2026-12-01T07:30:00Z')), '2026-11-30');
});

test('строгий разбор: чужая/несуществующая/повторная дата и ломаные колонки отклоняют ответ целиком', async (t) => {
  const cases = {
    outside: () => json(reportBody([[4, '2026-09-28', 120, 45, 3, 2, 7, 1]])),
    duplicate: (day) => json(reportBody([[4, day, 120, 45, 3, 2, 7, 1], [5, day, 121, 45, 3, 2, 7, 1]])),
    notDate: () => json(reportBody([[4, '29.09.2026', 120, 45, 3, 2, 7, 1]])),
    shortRow: (day) => json(reportBody([[4, day, 120]])),
    duplicateHeader: (day) => json(reportBody([[day, 120, 121]], ['day', 'views', 'views'])),
    unexpectedColumn: (day) => json(reportBody([[day, 120, 5]], ['day', 'views', 'estimatedRevenue'])),
    dayAsMetric: (day) => json({columnHeaders: [{name: 'day', columnType: 'METRIC', dataType: 'STRING'}, header('views')], rows: [[day, 1]]}),
    rowsNotArray: () => json({columnHeaders: ['day', 'views'].map(header), rows: {}}),
    noHeaders: () => json({rows: []}),
  };
  for (const [name, make] of Object.entries(cases)) {
    const f = fixture(t, {handler: mainReport(make)});
    await f.connect();
    await assert.rejects(() => f.collect(), (error) => {
      assert.equal(error.code, 'RESPONSE_UNCERTAIN', name);
      return true;
    });
    assert.equal(f.access.get('alvi').channelConfirmed, true, `${name}: недостоверный ответ — не отзыв`);
  }
  // Несуществующая календарная дата внутри запрошенного диапазона.
  const feb = fixture(t, {handler: mainReport(() => json(reportBody([[4, '2026-02-30', 120, 45, 3, 2, 7, 1]])))});
  await feb.connect();
  await assert.rejects(() => feb.youtube.dailyReport('alvi', {from: '2026-02-01', to: '2026-03-31'}), {code: 'RESPONSE_UNCERTAIN'});
  await assert.rejects(() => feb.youtube.dailyReport('alvi', {from: '2026-02-30', to: '2026-03-01'}), {code: 'BAD_PERIOD'});
});

test('недопустимые значения не пропускаются молча и не дают полных суток; null — неизвестность', async (t) => {
  // views −5, comments строкой, shares переполнен (1e400 → Infinity), likes дробный.
  const raw = (day) => new Response(`{"columnHeaders":${JSON.stringify(HEADERS.map(header))},"rows":[[2.5,"${day}",-5,45,"3",1e400,7,1]]}`, {status: 200});
  const f = fixture(t, {handler: mainReport(raw)});
  await f.connect();
  const result = await f.collect();
  const rows = byMetric(result);
  for (const metric of ['views', 'comments', 'shares', 'likes']) assert.equal(rows.has(metric), false, metric);
  assert.equal(rows.get('watch_time_seconds').value, 2700);
  assert.equal(rows.get('follower_change').value, 6);
  assert.equal(result.missing.filter((line) => /недопустимом виде/.test(line)).length, 4);
  assert.equal(result.status, 'partial');
  assert.equal(result.retryable, true);

  const minutes = fixture(t, {handler: mainReport((day) => json(reportBody([[4, day, 120, 1.5, 3, 2, 7, 1]])))});
  await minutes.connect();
  const fractional = await minutes.collect();
  assert.equal(byMetric(fractional).get('watch_time_seconds').value, 90, 'дробные минуты допустимы и переводятся точно');
  assert.equal(fractional.status, 'ok');
});

test('методика views: граница Shorts 31.03.2025 и окно внедрения названы; смена viewCount 24.08.2026 к Analytics не приклеена', async (t) => {
  const f = fixture(t);
  await f.connect();
  const before = await f.collect('2025-03-30');
  assert.ok(before.caveats.some((line) => /до смены методики подсчёта просмотров Shorts/.test(line)));
  assert.equal(before.provenance.methodology.views, 'shorts_before_2025_03_31');
  const rollout = await f.collect('2025-04-10');
  assert.ok(rollout.caveats.some((line) => /окно внедрения/.test(line)));
  const recent = await f.collect('2026-09-01');
  assert.equal(byMetric(recent).get('views').value, 120, 'значение views не меняется');
  assert.equal(recent.caveats.some((line) => /viewCount|2026-08-24|24\.08/.test(line)), false);
  assert.equal(recent.status, 'ok');
  assert.equal(YOUTUBE_VIEWS_DEFINITION_CHANGE, '2026-08-24', 'прежний экспорт сохранён');
  assert.match(YOUTUBE_SHORTS_VIEWS_METHOD.dataApiViewCount.analyticsViewsImpact, /не подтверждено/);
});

test('один общий срок на весь сбор, а не на каждый шаг', async (t) => {
  const f = fixture(t, {timeoutMs: 1000, collectTimeoutMs: 250});
  await f.connect();
  f.advance(2 * 3600 * 1000); // токен истёк: сбор сделает обмен, два отчёта и канал
  f.handler = async (context) => delay(200, ok(context));
  const started = Date.now();
  await assert.rejects(() => f.collect(), {code: 'TIMEOUT'});
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 700, `сбор остановлен общим сроком, а не суммой сроков шагов: ${elapsed} мс`);
  assert.equal(f.access.get('alvi').channelConfirmed, true, 'таймаут — не отзыв');

  const deaf = fixture(t, {timeoutMs: 5000, collectTimeoutMs: 200});
  await deaf.connect();
  deaf.handler = ({url}) => (url.startsWith(REPORTS_URL) ? new Promise(() => {}) : ok({url}));
  const begun = Date.now();
  await assert.rejects(() => deaf.collect(), {code: 'TIMEOUT'});
  assert.ok(Date.now() - begun < 1500, 'fetch, игнорирующий отмену, не держит сбор');
});

test('stop и внешний сигнал прерывают сбор; после stop новые сборы не ходят в сеть', async (t) => {
  const f = fixture(t, {timeoutMs: 5000, collectTimeoutMs: 20000});
  await f.connect();
  f.handler = ({url}) => (url.startsWith(REPORTS_URL) ? new Promise(() => {}) : ok({url}));
  const pending = f.collect();
  await waitFor(() => f.reports().length === 1);
  f.youtube.stop();
  await assert.rejects(pending, {code: 'STOPPED'});
  const before = f.calls.length;
  await assert.rejects(() => f.collect(), {code: 'STOPPED'});
  assert.equal(f.calls.length, before);
  assert.equal(f.access.get('alvi').channelConfirmed, true, 'остановка — не отзыв');

  const g = fixture(t, {timeoutMs: 5000, collectTimeoutMs: 20000});
  await g.connect();
  g.handler = f.handler;
  const controller = new AbortController();
  const aborted = g.collect('2026-09-29', {signal: controller.signal});
  await waitFor(() => g.reports().length === 1);
  controller.abort();
  await assert.rejects(aborted, {code: 'STOPPED'});
});

test('отзыв при сборе снимает подтверждение той же ревизии; квота — нет; новый доступ не портится', async (t) => {
  const f = fixture(t);
  await f.connect();
  f.advance(2 * 3600 * 1000);
  f.handler = ({url}) => (url === TOKEN_URL ? json({error: 'invalid_grant'}, 400) : ok({url}));
  await assert.rejects(() => f.collect(), (error) => {
    assert.equal(error.code, 'ACCESS_DENIED');
    assert.equal(/invalid_grant|refresh-token-value|GOCSPX/.test(error.message), false);
    return true;
  });
  const revoked = f.access.get('alvi');
  assert.equal(revoked.status, 'error');
  assert.equal(revoked.statusCode, 'ACCESS_DENIED');
  assert.equal(revoked.channelConfirmed, false);
  const after = await f.collect();
  assert.equal(after.status, 'missing_access', 'без подтверждения сбор не идёт');

  // Доступ сменился во время сбора, затем новый токен отклонён: старая ревизия не отмечает новую.
  const g = fixture(t);
  await g.connect();
  g.handler = ({url, f: self}) => {
    if (url.startsWith(REPORTS_URL) && !isEngaged(url))
      self.access.saveAccess('alvi', {revision: self.access.get('alvi').revision, credential: SECRET});
    if (url === TOKEN_URL) return json({error: 'invalid_grant'}, 400);
    return ok({url});
  };
  await assert.rejects(() => g.collect(), {code: 'ACCESS_DENIED'});
  const fresh = g.access.get('alvi');
  assert.equal(fresh.status, 'unchecked', 'новый сохранённый доступ не испорчен отметкой прежнего');
  assert.equal(fresh.statusCode, '');

  const quota = fixture(t);
  await quota.connect();
  quota.handler = mainReport(() => json({error: {code: 403, errors: [{reason: 'quotaExceeded'}]}}, 403));
  await assert.rejects(() => quota.collect(), {code: 'RATE_LIMITED'});
  assert.equal(quota.access.get('alvi').status, 'connected');
  assert.equal(quota.access.get('alvi').channelConfirmed, true);
});

test('привязка: без подтверждения и с пустой/чужой записью сбор не идёт; подмена канала снимает подтверждение', async (t) => {
  const f = fixture(t);
  f.saved();
  const unconfirmed = await f.collect();
  assert.equal(unconfirmed.status, 'missing_access');
  assert.deepEqual(f.calls, [], 'без подтверждённого канала сети нет');
  await f.access.verify('alvi', {accountRef: CHANNEL});
  const before = f.calls.length;
  for (const accountRef of ['', OTHER_CHANNEL, '@alvispa']) {
    const result = await f.collect('2026-09-29', {accountRef});
    assert.equal(result.status, 'missing_access', accountRef);
    assert.equal(result.hard, true);
  }
  assert.equal(f.calls.length, before, 'расхождение записи обнаружено до сети');
  const byUrl = await f.collect('2026-09-29', {accountRef: `https://www.youtube.com/channel/${CHANNEL}`});
  assert.equal(byUrl.status, 'ok', 'та же привязка в виде официальной ссылки');

  const switched = fixture(t);
  await switched.connect();
  switched.handler = ({url}) => (url.startsWith(CHANNELS_URL) ? json(channelsBody({id: OTHER_CHANNEL})) : ok({url}));
  const result = await switched.collect();
  assert.equal(result.status, 'missing_access');
  assert.equal(result.hard, true);
  assert.equal(result.snapshots, undefined, 'числа другого канала не записываются');
  assert.equal(switched.access.get('alvi').statusCode, 'CHANNEL_MISMATCH');
  assert.equal(switched.access.get('alvi').channelConfirmed, false);
  assert.equal((await switched.youtube.collectDate('avokado', {date: '2026-09-29'})).status, 'missing_access');
});

test('dailyReport сохраняет контракт: разбор по columnHeaders, хвост и пустой отчёт', async (t) => {
  const f = fixture(t);
  await f.connect();
  const report = await f.youtube.dailyReport('alvi', {from: '2026-09-29', to: '2026-09-29'});
  assert.equal(report.daySystem, YOUTUBE_REPORT_DAY_SYSTEM);
  assert.deepEqual(report.days[0].values,
    {likes: 4, views: 120, estimatedMinutesWatched: 45, comments: 3, shares: 2, subscribersGained: 7, subscribersLost: 1});
  assert.equal(report.requestedTailUnknown, false);
  const tail = await f.youtube.dailyReport('alvi', {from: '2026-09-29', to: '2026-09-30'});
  assert.equal(tail.lastCoveredDate, '2026-09-29');
  assert.equal(tail.requestedTailUnknown, true, 'хвост периода неизвестен, а не нулевой');
  assert.deepEqual(f.youtube.recentWindow(3), {from: '2026-09-27', to: '2026-09-30'});
});
