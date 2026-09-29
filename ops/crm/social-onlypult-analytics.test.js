'use strict';
/* Сборщик Onlypult Analytics: офлайн. Любой незаданный URL мок запрещает,
   POST и publishing-пути не вызываются вовсе. Ключи и числа синтетические. */
const test = require('node:test'), assert = require('node:assert/strict');
const {createSocialOnlypultAnalytics, normalizeProfile, normalizeCoverage, normalizePeriod,
  normalizeBlocks, indexCatalog, ANALYTICS_REGISTRY, FORBIDDEN_MAPPING,
  ANALYTICS_MAPPING_VERSION} = require('./social-onlypult-analytics');

const SECRET = 'TEST_ONLY_ANALYTICS_TOKEN_abcdef123456';
const AN = 'an_demo1', NATIVE = '17841400000000001';
const wire = (data, status = 200) => new Response(JSON.stringify({data}), {status, headers: {'content-type': 'application/json'}});

/* Каталог источника — контрактная фикстура по форме реальных каталогов: unit и source
   у каждого определения, returns у графика. Проекция обязана их проверять. */
const catalogData = {platforms: ['instagram', 'tiktok'], metrics: [
  {key: 'followers_count', title: 'Followers', category: 'audience', unit: 'count', platforms: ['instagram', 'tiktok'], source: 'network', formula: null, notes: 'Последнее значение в интервале, не сумма.'},
  {key: 'followers_change', title: 'Followers change', category: 'audience', unit: 'count', platforms: ['instagram', 'tiktok'], source: 'derived', formula: 'last-first', notes: null},
  {key: 'posts_count', title: 'Posts', category: 'posts', unit: 'count', platforms: ['instagram', 'tiktok'], source: 'derived', formula: null, notes: null},
  {key: 'content_views', title: 'Content views', category: 'profile', unit: 'count', platforms: ['instagram'], source: 'network', formula: null, notes: null},
  {key: 'reach', title: 'Reach', category: 'profile', unit: 'count', platforms: ['instagram'], source: 'network', formula: null, notes: null},
], charts: [
  {name: 'FollowersCountChart', title: 'Followers', category: 'audience', platforms: ['instagram', 'tiktok'], returns: 'series', unit: 'count', params: []},
  {name: 'FollowersChangeChart', title: 'Followers change', category: 'audience', platforms: ['instagram', 'tiktok'], returns: 'series', unit: 'count', params: []},
  {name: 'PostsCountChart', title: 'Posts', category: 'posts', platforms: ['instagram'], returns: 'series', unit: 'count', params: []},
  {name: 'ContentImpressionsChart', title: 'Content views', category: 'profile', platforms: ['instagram'], returns: 'series', unit: 'count', params: []},
  {name: 'ReachChart', title: 'Reach', category: 'profile', platforms: ['instagram'], returns: 'series', unit: 'count', params: []},
  {name: 'PostsLikesChart', title: 'Likes', category: 'posts', platforms: ['instagram'], returns: 'series', unit: 'count', params: []},
]};
const profile = (over = {}) => ({id: AN, platform: 'instagram', platform_id: NATIVE, name: 'ALVI', username: '@alvi',
  status: 'active', timezone: 'Asia/Irkutsk', capabilities: {endpoints: ['overview', 'audience', 'chart'], granularity: ['day']}, ...over});
const block = (chart, points, summary = null) => ({chart, summary, data: points});
const overview = (over = {}) => ({profile_id: AN, platform: 'instagram', platform_id: NATIVE,
  period: {from: '2026-09-20', to: '2026-09-22', granularity: 'day', timezone: 'Asia/Irkutsk'},
  coverage: {covered_from: '2026-09-20', covered_to: '2026-09-22', collecting: false, collection_enabled: true},
  warnings: [],
  metrics: {
    audience: [block('FollowersCountChart', [{date: '2026-09-20', value: 130}, {date: '2026-09-21', value: 133}, {date: '2026-09-22', value: 136}], 136),
      block('FollowersChangeChart', [{date: '2026-09-21', value: 3}, {date: '2026-09-22', value: 3}], 6)],
    profile: [block('ContentImpressionsChart', [{date: '2026-09-21', value: 0}, {date: '2026-09-22', value: 40}], 40),
      block('ReachChart', [{date: '2026-09-21', value: 12}, {date: '2026-09-22', value: 15}], 27)],
    posts: [block('PostsCountChart', [{date: '2026-09-21', value: 1}], 1),
      block('PostsLikesChart', [{date: '2026-09-21', value: 7}], 7)],
  }, ...over});

function fixture({profiles = [profile()], data = overview(), catalog = catalogData, fail: failWith = null, now = Date.parse('2026-09-23T04:00:00Z')} = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({path: parsed.pathname, search: Object.fromEntries(parsed.searchParams), options});
    assert.equal(parsed.origin, 'https://api.onlypult.com', 'обращения только к api.onlypult.com');
    assert.equal(options.method, 'GET', 'коллектор делает только GET');
    assert.equal(options.redirect, 'error', 'за редиректом с Authorization не идём');
    assert.equal(options.headers.authorization, `Bearer ${SECRET}`);
    assert.ok(!parsed.pathname.includes('/posts/limits') && !parsed.pathname.startsWith('/v1/profiles'),
      'publishing-пути не вызываются: ' + parsed.pathname);
    if (failWith) { const out = failWith({path: parsed.pathname, calls}); if (out) return out; }
    if (parsed.pathname === '/v1/analytics/profiles') return wire(profiles);
    if (parsed.pathname === '/v1/analytics/metrics') return wire(catalog);
    if (parsed.pathname === `/v1/analytics/${AN}/overview`) return wire(data);
    throw new assert.AssertionError({message: 'мок запрещает адрес ' + parsed.pathname});
  };
  const api = createSocialOnlypultAnalytics({fetchImpl, now: () => now,
    resolveCredential: () => ({companyCode: 'alvi', provider: 'onlypult_analytics', revision: 4, credential: SECRET, unreadable: false}),
    sleep: async () => {}});
  return {api, calls};
}

test('каталог даёт словарь, а запрещённые сопоставления в registry не входят', () => {
  const ig = indexCatalog({data: {metrics: [{key: 'followers_count', platforms: ['instagram'], source: 'network', unit: 'count', title: 'Followers', category: 'audience', formula: null, notes: 'x'}], charts: [{name: 'FollowersCountChart', platforms: ['instagram'], returns: 'series', unit: 'count', title: 'Followers', category: 'audience'}]}}, 'instagram');
  assert.equal(ig.metrics.get('followers_count').source, 'network');
  assert.equal(ig.charts.has('FollowersCountChart'), true);
  assert.deepEqual(Object.keys(ANALYTICS_REGISTRY).sort(),
    ['content_views', 'followers_change', 'followers_count', 'posts_count', 'reach']);
  for (const key of FORBIDDEN_MAPPING) assert.equal(Object.hasOwn(ANALYTICS_REGISTRY, key), false, key + ' не сопоставляется');
});

test('профилем аналитики считается только an_ID с платформой и подтверждённым native ID', () => {
  assert.equal(normalizeProfile(profile()).nativeAccountId, NATIVE);
  // Publishing ID и связанный профиль публикаций за аналитический не принимаются.
  assert.equal(normalizeProfile(profile({id: '1863531'})), null);
  assert.equal(normalizeProfile({id: AN, platform: 'instagram', linked_publish_profile: '1863531'}), null, 'без native ID профиль не годится');
  assert.equal(normalizeProfile(profile({platform: 'telegram'})), null, 'Onlypult Analytics не покрывает Telegram');
  assert.equal(normalizeProfile(profile({timezone: 'Mars/Olympus'})).timezone, null, 'выдуманная зона не подтверждается');
});

test('возвращённый период и покрытие не достраиваются по запросу', () => {
  const asked = {from: '2026-09-20', to: '2026-09-22'};
  const confirmed = normalizePeriod({from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'}, asked);
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.matchesRequested, true);
  const silent = normalizePeriod(undefined, asked);
  assert.equal(silent.confirmed, false, 'запрошенный период за возвращённый не выдаётся');
  assert.equal(silent.timezoneConfirmed, false);
  const narrowed = normalizePeriod({from: '2026-09-21', to: '2026-09-22'}, asked);
  assert.equal(narrowed.matchesRequested, false, 'источник сузил период — это видно');
  assert.equal(normalizeCoverage(undefined).known, false);
  assert.equal(normalizeCoverage({covered_from: '2026-09-20', collecting: true}).collecting, true);
});

test('формы ответа разбираются по контракту: overview — объект категорий, audience и chart — массив', () => {
  const asObject = normalizeBlocks(overview(), 'overview');
  assert.equal(asObject.shapeOk, true);
  assert.equal(asObject.blocks.length, 6);
  // Массив в overview — неподтверждённая структура, а не «почти то же самое».
  assert.equal(normalizeBlocks({metrics: [block('FollowersCountChart', [])]}, 'overview').shapeOk, false);
  const asArray = normalizeBlocks({metrics: [block('FollowersCountChart', [{date: '2026-09-21', value: 5}])]}, 'audience');
  assert.equal(asArray.shapeOk, true);
  assert.equal(asArray.blocks[0].points[0].value, 5);
  assert.equal(normalizeBlocks({metrics: {audience: []}}, 'audience').shapeOk, false);
  // Выдуманных metric.key и series в контракте нет: блок без chart не считается блоком.
  assert.equal(normalizeBlocks({metrics: [{metric: {key: 'followers_count'}, series: []}]}, 'audience').blocks.length, 0);
});

test('дневной сбор: подтверждённые метрики пишутся, незнакомые графики остаются в missing', async () => {
  const f = fixture();
  const result = await f.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  assert.equal(result.status, 'ok');
  assert.equal(result.accessRevision, 4);
  const followers = result.measurements.filter((item) => item.metric === 'followers');
  assert.deepEqual(followers.map((item) => item.value), [130, 133, 136]);
  assert.equal(followers[0].kind, 'unknown', 'органика/реклама источником не подтверждена');
  assert.equal(followers[0].scope, 'profile');
  // Настоящий ноль внутри покрытия остаётся нулём.
  const views = result.measurements.filter((item) => item.metric === 'views');
  assert.deepEqual(views.map((item) => item.value), [0, 40]);
  // Просмотры берутся только из одного источника: PostsLikesChart и видео-подмножество не подмешиваются.
  assert.equal(result.measurements.filter((item) => item.metric === 'views').length, 2);
  assert.ok(result.missing.some((line) => /PostsLikesChart/.test(line)), 'необъяснённый график честно назван');
  assert.equal(result.measurements.some((item) => item.metric === 'likes'), false, 'по названию графика метрика не угадывается');
  assert.equal(result.measurements.some((item) => item.metric === 'retention_percent'), false, 'ER удержанием не подменяется');
  // followers_change остаётся кандидатом: в дневную проекцию не идёт.
  assert.equal(result.measurements.some((item) => item.metric === 'follower_change'), false);
  assert.ok(result.missing.some((line) => /FollowersChangeChart[^]*семантика точек не подтверждена/.test(line)));
  // Каталог загружается до проекции, затем один overview. Ни одного POST.
  assert.deepEqual(f.calls.map((call) => call.path), ['/v1/analytics/metrics', `/v1/analytics/${AN}/overview`]);
  assert.equal(f.calls[1].search.granularity, 'day');
  assert.equal(f.calls[1].search.date_to, '2026-09-22');
});

test('нули до начала покрытия — неизвестность, а текущие сутки остаются partial', async () => {
  const f = fixture({data: overview({
    coverage: {covered_from: '2026-09-22', covered_to: '2026-09-23', collecting: true, collection_enabled: true},
    period: {from: '2026-09-20', to: '2026-09-23', granularity: 'day', timezone: 'Asia/Irkutsk'},
    warnings: ['данные за последние сутки догружаются'],
    metrics: {audience: [block('FollowersCountChart', [
      {date: '2026-09-20', value: 0}, {date: '2026-09-21', value: 0},
      {date: '2026-09-22', value: 136}, {date: '2026-09-23', value: 137}], 137)]},
  })});
  const result = await f.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-23', timezone: 'Asia/Irkutsk'});
  const dates = result.measurements.map((item) => item.date);
  assert.deepEqual(dates, ['2026-09-22', '2026-09-23'], 'нули вне покрытия в показатели не попали');
  assert.ok(result.missing.some((line) => /2026-09-20/.test(line) && /покрытия/.test(line)));
  // Текущие сутки в часовом поясе аккаунта (2026-09-23 в Иркутске) — partial.
  assert.equal(result.measurements.find((item) => item.date === '2026-09-23').completeness, 'partial');
  assert.equal(result.measurements.find((item) => item.date === '2026-09-22').completeness, 'partial', 'идущий сбор и предупреждение не дают complete');
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.warnings, ['данные за последние сутки догружаются']);
});

test('пустой ответ, null и неподтверждённая структура не превращаются в нули', async () => {
  const empty = fixture({data: overview({metrics: {audience: [block('FollowersCountChart', [], null)]}})});
  const first = await empty.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  assert.equal(first.measurements.length, 0);
  assert.ok(first.missing.some((line) => /не вернул ряд/.test(line)));
  const nulls = fixture({data: overview({metrics: {audience: [block('FollowersCountChart',
    [{date: '2026-09-21', value: null}, {date: '2026-09-22', value: 136}], 136)]}})});
  const second = await nulls.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  /* null не стал числом, но и не пропал: он записывается как снятое измерение, иначе в
     проекции осталась бы прежняя цифра и продолжала бы считаться подтверждённой. */
  assert.deepEqual(second.measurements.map((item) => item.value), [null, 136]);
  const cleared = second.measurements.find((item) => item.date === '2026-09-21');
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.completeness, 'unknown', 'у снятого значения полноты быть не может');
  assert.ok(second.missing.some((line) => /больше не возвращает значение/.test(line)));
  assert.equal(second.blocks[0].points[0].value, null);
  assert.match(second.blocks[0].points[0].reason, /null/);
  const broken = fixture({data: overview({metrics: [block('FollowersCountChart', [{date: '2026-09-21', value: 1}])]})});
  const third = await broken.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  assert.equal(third.status, 'partial');
  assert.equal(third.measurements, undefined);
  assert.ok(third.missing.some((line) => /неподтверждённой структуре/.test(line)));
});

test('чужой профиль, сменившийся аккаунт и отсутствие capability не записываются', async () => {
  const alien = fixture({data: overview({profile_id: 'an_other'})});
  await assert.rejects(alien.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22'}), (error) => error.code === 'PROFILE_CHANGED');
  const moved = fixture({data: overview({platform_id: '17841400000000999'})});
  await assert.rejects(moved.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22'}), (error) => error.code === 'ACCOUNT_CHANGED');
  const limited = fixture();
  const result = await limited.api.collectDay({companyCode: 'alvi',
    profile: normalizeProfile(profile({capabilities: {endpoints: ['posts'], granularity: ['month']}})),
    from: '2026-09-20', to: '2026-09-22'});
  assert.equal(result.status, 'unsupported');
  assert.ok(result.missing[0].includes('overview'));
  assert.equal(limited.calls.length, 0, 'неподдерживаемый endpoint не вызывается');
});

test('отсутствие доступа и отказы источника честны и не дают чисел', async () => {
  const noAccess = createSocialOnlypultAnalytics({fetchImpl: async () => { throw new Error('сети быть не должно'); },
    resolveCredential: () => null, now: () => Date.now(), sleep: async () => {}});
  await assert.rejects(noAccess.listProfiles('alvi'), (error) => error.code === 'MISSING_ACCESS');
  const denied = fixture({fail: ({path}) => (path.endsWith('/overview') ? wire({error: 'no'}, 403) : null)});
  await assert.rejects(denied.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22'}), (error) => error.code === 'ACCESS_DENIED');
  const unsupported = fixture({fail: ({path}) => (path.endsWith('/overview') ? wire({error: 'no'}, 422) : null)});
  await assert.rejects(unsupported.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22'}), (error) => error.code === 'UNSUPPORTED');
  // 429 повторяется ограниченно и затем честно отдаёт причину.
  let attempts = 0;
  const limited = fixture({fail: ({path}) => (path.endsWith('/overview') ? (attempts += 1, wire({error: 'slow'}, 429)) : null)});
  await assert.rejects(limited.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22'}), (error) => error.code === 'RATE_LIMITED');
  assert.equal(attempts, 3, 'повтор ограничен');
});

test('профилей нет — это «не подключено», а не повод выбрать что-то автоматически', async () => {
  const f = fixture({profiles: []});
  const result = await f.api.listProfiles('alvi');
  assert.deepEqual(result.profiles, []);
  assert.equal(result.rejected, 0);
  const publishingOnly = fixture({profiles: [{id: '1863531', platform: 'instagram', name: 'ALVI'}]});
  const second = await publishingOnly.api.listProfiles('alvi');
  assert.deepEqual(second.profiles, [], 'ID публикаций аналитическим профилем не становится');
  assert.equal(second.rejected, 1, 'отклонённые записи видны отдельно');
});

/* Регрессии ревью 29.09: P1-1, P1-2, P1-3, P1-4. Ключи и числа синтетические, сети нет. */

test('P1-1 неподтверждённый период, чужая детализация, чужой пояс и точки вне запроса в дневную проекцию не идут', async () => {
  // Источник не назвал возвращённый период.
  const silent = fixture({data: overview({period: undefined})});
  const first = await silent.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  assert.equal(first.measurements.length, 0, 'без подтверждённых границ дневной проекции нет');
  assert.equal(first.projectable, false);
  assert.ok(first.missing.some((line) => /не назвал возвращённый период/.test(line)));
  assert.ok(first.blocks.length, 'значения остались в доказательствах');
  // Месячная детализация вместо дневной.
  const monthly = fixture({data: overview({period: {from: '2026-09-20', to: '2026-09-22', granularity: 'month', timezone: 'Asia/Irkutsk'}})});
  const second = await monthly.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  assert.equal(second.measurements.length, 0);
  assert.ok(second.missing.some((line) => /детализацию month/.test(line)));
  // UTC вместо запрошенного пояса аккаунта — другая система суток.
  const utc = fixture({data: overview({period: {from: '2026-09-20', to: '2026-09-22', granularity: 'day', timezone: 'UTC'}})});
  const third = await utc.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  assert.equal(third.measurements.length, 0);
  assert.ok(third.missing.some((line) => /часовой пояс UTC вместо запрошенного Asia\/Irkutsk/.test(line)));
  // Точка за пределами запроса: период подтверждён, но дата чужая.
  const outside = fixture({data: overview({metrics: {audience: [block('FollowersCountChart',
    [{date: '2026-09-19', value: 120}, {date: '2026-09-21', value: 133}], 133)]}})});
  const fourth = await outside.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  assert.deepEqual(fourth.measurements.map((item) => item.date), ['2026-09-21']);
  assert.ok(fourth.missing.some((line) => /2026-09-19[^]*вне запрошенного периода/.test(line)));
});

test('P1-2 пустые capabilities разрешением не являются, а ответ обязан назвать профиль и аккаунт', async () => {
  const blank = fixture();
  const result = await blank.api.collectDay({companyCode: 'alvi',
    profile: {...normalizeProfile(profile()), endpoints: [], granularity: []},
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  assert.equal(result.status, 'unsupported');
  assert.ok(result.missing[0].includes('не сообщил список доступных разделов'));
  assert.equal(blank.calls.length, 0, 'синтетический профиль сети не касается');
  const noGranularity = fixture();
  const second = await noGranularity.api.collectDay({companyCode: 'alvi',
    profile: {...normalizeProfile(profile()), granularity: []},
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  assert.equal(second.status, 'unsupported');
  assert.ok(second.missing[0].includes('не сообщил доступную детализацию'));
});

/* Документированная форма overview: data.profile — объект, рядом period/coverage/metrics.
   Плоских profile_id/platform/platform_id в официальном контракте нет, и требовать их —
   значит отвергать допустимый ответ. Принадлежность обеспечивают настоящий listProfiles и
   адрес запроса; отклоняется только явное противоречие. */
test('принадлежность ответа: документированная форма принимается, противоречие отклоняется, молчание не подтверждает', async () => {
  const documented = fixture({data: (() => { const {profile_id, platform, platform_id, ...rest} = overview();
    return {...rest, profile: {id: profile_id, platform, platform_id, name: 'ALVI'}}; })()});
  const ok = await documented.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  assert.equal(ok.status, 'ok');
  assert.equal(ok.identityConfirmed, true);
  assert.deepEqual(ok.measurements.filter((item) => item.metric === 'followers').map((item) => item.value), [130, 133, 136]);
  // Ответ вовсе без принадлежности допустим, но подтверждением не считается.
  const silent = fixture({data: (() => { const {profile_id, platform, platform_id, ...rest} = overview(); return rest; })()});
  const quiet = await silent.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  assert.equal(quiet.status, 'ok');
  assert.equal(quiet.identityConfirmed, false, 'молчание принадлежность не подтверждает');
  // Противоречие внутри вложенного объекта отклоняется так же, как плоское.
  const alienNested = fixture({data: (() => { const {profile_id, platform, platform_id, ...rest} = overview();
    return {...rest, profile: {id: 'an_other', platform, platform_id}}; })()});
  await assert.rejects(alienNested.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'}), (error) => error.code === 'PROFILE_CHANGED');
  const movedNested = fixture({data: (() => { const {profile_id, platform, platform_id, ...rest} = overview();
    return {...rest, profile: {id: profile_id, platform, platform_id: '17841400000000999'}}; })()});
  await assert.rejects(movedNested.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'}), (error) => error.code === 'ACCOUNT_CHANGED');
});

test('P1-3 одного covered_from мало: без состояния сбора и при выключенном сборе ноль измерением не считается', async () => {
  const onlyFrom = fixture({data: overview({
    coverage: {covered_from: '2026-09-20', covered_to: '2026-09-22'},
    metrics: {profile: [block('ContentImpressionsChart', [{date: '2026-09-21', value: 0}], 0)]}})});
  const first = await onlyFrom.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  assert.equal(first.measurements.length, 0, 'ноль без подтверждённого состояния сбора измерением не стал');
  assert.ok(first.missing.some((line) => /состояние сбора источником не подтверждено/.test(line)));
  /* Остановленный сбор говорит о настоящем, а не о прошлом: подтверждённая история внутри
     названных границ сохраняется, но с честным ограничением. Без верхней границы история
     не ограничена ничем — тогда дата измерением не считается. */
  const disabled = fixture({data: overview({
    coverage: {covered_from: '2026-09-20', covered_to: '2026-09-22', collecting: false, collection_enabled: false},
    metrics: {profile: [block('ContentImpressionsChart', [{date: '2026-09-21', value: 0}], 0)]}})});
  const second = await disabled.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  assert.deepEqual(second.measurements.map((item) => item.value), [0], 'историческое наблюдение внутри покрытия сохранено');
  assert.equal(second.measurements[0].historicalCoverage, true);
  assert.ok(second.missing.some((line) => /сбор по профилю остановлен/.test(line)));
  const unbounded = fixture({data: overview({
    coverage: {covered_from: '2026-09-20', collecting: false, collection_enabled: false},
    metrics: {profile: [block('ContentImpressionsChart', [{date: '2026-09-21', value: 0}], 0)]}})});
  const openEnded = await unbounded.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  assert.equal(openEnded.measurements.length, 0);
  assert.ok(openEnded.missing.some((line) => /конец покрытия не назван/.test(line)));
  // Подтверждённое состояние — ноль сохраняется как измерение.
  const enabled = fixture({data: overview({
    coverage: {covered_from: '2026-09-20', covered_to: '2026-09-22', collecting: false, collection_enabled: true},
    metrics: {profile: [block('ContentImpressionsChart', [{date: '2026-09-21', value: 0}], 0)]}})});
  const third = await enabled.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  assert.deepEqual(third.measurements.map((item) => item.value), [0]);
  assert.equal(third.measurements[0].completeness, 'complete');
});

test('P1-4 каталог проверяется: чужие unit и source не дают метрику, а кандидатный график остаётся доказательством', async () => {
  // Каталог называет проценты и неизвестный источник — это другой смысл, метрика не пишется.
  const skewed = fixture({catalog: {...catalogData,
    metrics: catalogData.metrics.map((item) => (item.key === 'followers_count' ? {...item, unit: 'percent', source: 'unknown'} : item))}});
  const result = await skewed.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  assert.equal(result.measurements.some((item) => item.metric === 'followers'), false);
  assert.ok(result.missing.some((line) => /единица каталога percent/.test(line)));
  // FollowersChangeChart остаётся кандидатом при любом каталоге.
  assert.equal(result.measurements.some((item) => item.metric === 'follower_change'), false);
  assert.ok(result.missing.some((line) => /FollowersChangeChart[^]*семантика точек не подтверждена/.test(line)));
  assert.ok(result.blocks.some((item) => item.chart === 'FollowersChangeChart'), 'кандидат остался в доказательствах');
});

/* Полнота: каждый неизвестный флаг проверяется отдельно. Прежняя проверка требовала,
   чтобы отсутствовали ОБА флага, и covered_from вместе с collection_enabled=true при
   отсутствующем collecting давали complete, хотя состояние догрузки неизвестно. */
test('частично неизвестные флаги покрытия не дают complete', async () => {
  const noCollecting = fixture({data: overview({
    coverage: {covered_from: '2026-09-20', covered_to: '2026-09-22', collection_enabled: true},
    metrics: {profile: [block('ContentImpressionsChart', [{date: '2026-09-21', value: 40}], 40)]}})});
  const first = await noCollecting.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  assert.deepEqual(first.measurements.map((item) => item.value), [40], 'значение измерено');
  assert.equal(first.measurements[0].completeness, 'unknown', 'состояние догрузки не названо — complete невозможен');
  const noEnabled = fixture({data: overview({
    coverage: {covered_from: '2026-09-20', covered_to: '2026-09-22', collecting: false},
    metrics: {profile: [block('ContentImpressionsChart', [{date: '2026-09-21', value: 40}], 40)]}})});
  const second = await noEnabled.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  assert.equal(second.measurements[0].completeness, 'unknown');
  const noCoveredTo = fixture({data: overview({
    coverage: {covered_from: '2026-09-20', collecting: false, collection_enabled: true},
    metrics: {profile: [block('ContentImpressionsChart', [{date: '2026-09-21', value: 40}], 40)]}})});
  const third = await noCoveredTo.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  assert.equal(third.measurements[0].completeness, 'unknown', 'верхняя граница истории не названа');
  // Все флаги названы и день закрыт — только тогда complete.
  const full = fixture({data: overview({
    coverage: {covered_from: '2026-09-20', covered_to: '2026-09-22', collecting: false, collection_enabled: true},
    metrics: {profile: [block('ContentImpressionsChart', [{date: '2026-09-21', value: 40}], 40)]}})});
  const fourth = await full.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  assert.equal(fourth.measurements[0].completeness, 'complete');
});

/* Ответ, из которого не выходит ни одного показателя, всё равно остаётся доказательством:
   кандидатные графики, итоги и null-ряды сохраняются независимо от проекции. */
test('candidate-only и null-ответ отдают исходные блоки для доказательств', async () => {
  const candidateOnly = fixture({data: overview({metrics: {audience: [
    block('FollowersChangeChart', [{date: '2026-09-21', value: 3}], 6)]}})});
  const result = await candidateOnly.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  assert.equal(result.measurements.length, 0, 'кандидат в показатели не идёт');
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].chart, 'FollowersChangeChart');
  assert.equal(result.blocks[0].summary, 6, 'итог источника сохранён');
  assert.equal(result.catalogVersion.length > 0, true);
  assert.equal(result.mappingVersion, ANALYTICS_MAPPING_VERSION);
  const nullOnly = fixture({data: overview({metrics: {audience: [
    block('FollowersCountChart', [{date: '2026-09-21', value: null}], null)]}})});
  const empty = await nullOnly.api.collectDay({companyCode: 'alvi', profile: normalizeProfile(profile()),
    from: '2026-09-20', to: '2026-09-22', timezone: 'Asia/Irkutsk'});
  assert.equal(empty.blocks[0].points[0].value, null);
  assert.match(empty.blocks[0].summaryReason, /null/);
  assert.deepEqual(empty.measurements.map((item) => item.value), [null]);
});
