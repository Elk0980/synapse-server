'use strict';
/* Сбор статистики Instagram и TikTok через REST API Onlypult Analytics.

   Модуль изолирован: ни одного обращения к подключениям публикаций, ни одного POST.
   Разрешены только перечисленные ниже GET по фиксированному origin. Всё, что приходит
   от источника, проверяется, а не достраивается по аналогии: запрошенный период нельзя
   выдавать за возвращённый, а отсутствующую структуру — дополнять догадками.

   Главное правило чисел: настоящий 0 — это измерение, а null, отсутствующее поле и
   пустой массив — отсутствие измерения с причиной. Одно другим не подменяется нигде. */

const ORIGIN = 'https://api.onlypult.com';
const BASE = '/v1';
const MAPPING_VERSION = '2026-09-29';
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 3;
const MAX_RANGE_DAYS = 92;

/* Ровно эти GET и никакие другие. Пути строятся здесь, а не приходят снаружи:
   иначе произвольный путь мог бы утащить Authorization на чужой endpoint. */
const ENDPOINTS = Object.freeze({
  profiles: 'profiles',
  metrics: 'metrics',
  overview: 'overview',
  audience: 'audience',
  posts: 'posts',
  profileMetrics: 'profile-metrics',
  chart: 'chart',
});
// Платформы, которые этот коллектор обслуживает. Остальные пять площадок семи —
// не «пока не настроены», а не поддерживаются Onlypult Analytics в принципе.
const PLATFORMS = Object.freeze({instagram: 'instagram', tiktok: 'tiktok'});
const UNSUPPORTED_NOTE = 'Onlypult Analytics не покрывает эту площадку: нужен отдельный источник.';

/* Подтверждённый смыслом каталога registry. Только эти ключи попадают в показатели.
   Всё остальное (в том числе валидные, но необъяснённые графики) остаётся в доказательствах
   и в missing — не исчезает и не превращается в ноль.
   scope отделяет аккаунтную область от области публикаций: нынешний уникальный ключ
   проекции их не различает, поэтому post_views сюда не поднимается. */
const REGISTRY = Object.freeze({
  followers_count: {metric: 'followers', source: 'network', unit: 'count', scope: 'profile', aggregation: 'last',
    note: 'Последнее значение интервала, не сумма. Историческая точка остаётся состоянием на свою дату.'},
  /* followers_change ОСТАЁТСЯ КАНДИДАТОМ: каталог даёт формулу за интервал, но семантика точек
     FollowersChangeChart не установлена — неизвестно, прирост это за день, накопленный счётчик
     или что-то третье. candidate:true означает «в доказательства, но не в дневную проекцию». */
  followers_change: {metric: 'follower_change', source: 'derived', unit: 'count', scope: 'profile', aggregation: 'interval',
    candidate: true,
    note: 'followers_count(last) − followers_count(first) за запрошенный интервал; семантика точек графика не подтверждена.'},
  posts_count: {metric: 'posts_published', source: 'derived', unit: 'count', scope: 'profile', aggregation: 'sum',
    note: 'Наблюдаемый сервисом архив публикаций интервала, не доказательство полного числа выходов.'},
  content_views: {metric: 'views', source: 'network', unit: 'count', scope: 'profile', aggregation: 'sum',
    platforms: ['instagram'],
    note: 'Просмотры профиля, включая повторные. Не складывать с просмотрами публикаций и видео-подмножеством.'},
  reach: {metric: 'reach', source: 'network', unit: 'count', scope: 'profile', aggregation: 'daily_only',
    platforms: ['instagram'],
    note: 'Охват за интервал. Сумма дней уникальным охватом периода не является.'},
});
/* Явно НЕ сопоставляем: ER не является удержанием, gained/lost не равны follower_change,
   контактные графики не заменяют все переходы, stories_count не входит в posts_published. */
const FORBIDDEN_MAPPING = Object.freeze(['posts_er', 'profile_er', 'reach_er', 'reach_rate', 'stories_completion_rate',
  'followers_gained', 'followers_lost', 'post_follows', 'interactions', 'stories_count', 'post_views', 'post_profile_visits']);

const failure = (code, message, extra = {}) => Object.assign(new Error(message), {code, ...extra});
const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
/* an_ID и native ID проверяются по форме строго: подставить сюда publishing-ID нельзя. */
const isAnalyticsId = (value) => typeof value === 'string' && /^an_[A-Za-z0-9_-]{1,64}$/.test(value);
const isNativeId = (value) => typeof value === 'string' && /^[A-Za-z0-9_.@:-]{1,120}$/.test(value);
const zoneOk = (value) => {
  if (typeof value !== 'string' || !value) return false;
  try { new Intl.DateTimeFormat('en-US', {timeZone: value}); return true; } catch { return false; }
};
const daysBetween = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);

/* ---------- чистые функции разбора (без сети, тестируются отдельно) ---------- */

/* Профиль аналитики. Требуется an_ID, платформа и подтверждённый native ID.
   linked_publish_profile и любой publishing-ID профилем аналитики не являются. */
function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = raw.id;
  if (!isAnalyticsId(id)) return null;
  const platform = typeof raw.platform === 'string' ? raw.platform : '';
  if (!Object.hasOwn(PLATFORMS, platform)) return null;
  const nativeId = raw.platform_id;
  if (!isNativeId(nativeId)) return null;
  const timezone = zoneOk(raw.timezone) ? raw.timezone : null;
  const endpoints = Array.isArray(raw.capabilities?.endpoints)
    ? raw.capabilities.endpoints.filter((item) => typeof item === 'string' && item.length <= 40) : [];
  const granularity = Array.isArray(raw.capabilities?.granularity)
    ? raw.capabilities.granularity.filter((item) => typeof item === 'string' && item.length <= 20) : [];
  return {
    id, platform, nativeAccountId: nativeId,
    name: typeof raw.name === 'string' ? raw.name.slice(0, 200) : '',
    username: typeof raw.username === 'string' ? raw.username.slice(0, 120) : null,
    status: typeof raw.status === 'string' ? raw.status.slice(0, 40) : 'unknown',
    timezone, endpoints, granularity,
    // Неактивный профиль позволяет прочитать доступную историю, но не даёт заявлять,
    // что сбор продолжается.
    collecting: raw.status === 'active',
  };
}

/* Покрытие. covered_from сам по себе не доказывает измерение каждого следующего дня:
   сервис может заполнять пропуски нулями, поэтому вывод о полноте делается только вместе
   с collecting/collection_enabled/warnings. */
function normalizeCoverage(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  const coveredFrom = isDay(source?.covered_from) ? source.covered_from : null;
  const coveredTo = isDay(source?.covered_to) ? source.covered_to : null;
  return {
    coveredFrom, coveredTo,
    collecting: typeof source?.collecting === 'boolean' ? source.collecting : null,
    collectionEnabled: typeof source?.collection_enabled === 'boolean' ? source.collection_enabled : null,
    known: Boolean(coveredFrom),
  };
}

const normalizeWarnings = (raw) => (Array.isArray(raw) ? raw : [])
  .map((item) => (typeof item === 'string' ? item : typeof item?.message === 'string' ? item.message : null))
  .filter(Boolean).map((item) => item.slice(0, 300)).slice(0, 20);

/* Возвращённый период. Запрошенный период выдавать за возвращённый нельзя:
   если источник его не назвал, period.confirmed=false и это видно в доказательстве. */
function normalizePeriod(raw, requested) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  const from = isDay(source?.from) ? source.from : isDay(source?.date_from) ? source.date_from : null;
  const to = isDay(source?.to) ? source.to : isDay(source?.date_to) ? source.date_to : null;
  const timezone = zoneOk(source?.timezone) ? source.timezone : null;
  const granularity = typeof source?.granularity === 'string' ? source.granularity.slice(0, 20) : null;
  return {
    from: from || requested?.from || null, to: to || requested?.to || null,
    timezone: timezone || null, granularity: granularity || null,
    confirmed: Boolean(from && to),
    timezoneConfirmed: Boolean(timezone),
    matchesRequested: Boolean(from && to && requested && from === requested.from && to === requested.to),
  };
}

/* Блок графика по контракту: {chart, summary, data:[{date,value}]}.
   Ни metric.key, ни series здесь не выдумываются — их в контракте нет. */
function normalizeBlock(raw, {category = '', endpoint = ''} = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const chart = typeof raw.chart === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(raw.chart) ? raw.chart : null;
  if (!chart) return null;
  const data = Array.isArray(raw.data) ? raw.data : null;
  const points = (data || []).slice(0, 1000).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (!isDay(item.date)) return null;
    const value = num(item.value);
    return value === null
      ? {date: item.date, value: null, reason: item.value === null ? 'источник вернул null за эту дату' : 'источник не вернул числового значения за эту дату'}
      : {date: item.date, value};
  }).filter(Boolean);
  return {
    chart, category: String(category || '').slice(0, 40), endpoint,
    summary: num(raw.summary),
    // Пустой массив — это не ноль: данных за период источник не дал.
    summaryReason: num(raw.summary) === null ? (raw.summary === null ? 'источник вернул null в итоге' : 'источник не вернул итог за период') : '',
    points,
    pointsPresent: Array.isArray(data),
    unit: typeof raw.unit === 'string' ? raw.unit.slice(0, 40) : '',
  };
}

/* overview: data.metrics — ОБЪЕКТ category → ChartBlock[].
   audience и chart: data.metrics — МАССИВ блоков. Форма разбирается по контракту,
   а не угадывается: чужая форма отклоняется с причиной. */
function normalizeBlocks(payload, endpoint) {
  const metrics = payload?.metrics;
  if (endpoint === ENDPOINTS.overview) {
    if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return {blocks: [], shapeOk: false};
    const blocks = [];
    for (const [category, list] of Object.entries(metrics)) {
      if (!Array.isArray(list)) continue;
      for (const item of list.slice(0, 200)) { const block = normalizeBlock(item, {category, endpoint}); if (block) blocks.push(block); }
    }
    return {blocks, shapeOk: true};
  }
  if (!Array.isArray(metrics)) return {blocks: [], shapeOk: false};
  const blocks = [];
  for (const item of metrics.slice(0, 200)) { const block = normalizeBlock(item, {endpoint}); if (block) blocks.push(block); }
  return {blocks, shapeOk: true};
}

/* Каталог сервиса. Соответствие metric.key → chart.name каталогом не задано, поэтому
   график связывается с ключом только через наш явный registry и подтверждённый смысл. */
function indexCatalog(payload, platform) {
  const data = payload && typeof payload === 'object' ? (payload.data || payload) : null;
  const metrics = Array.isArray(data?.metrics) ? data.metrics : [];
  const charts = Array.isArray(data?.charts) ? data.charts : [];
  const forPlatform = (item) => !Array.isArray(item?.platforms) || item.platforms.includes(platform);
  const byKey = new Map();
  for (const item of metrics) {
    if (!item || typeof item.key !== 'string' || !forPlatform(item)) continue;
    byKey.set(item.key, {key: item.key, title: String(item.title || '').slice(0, 200),
      category: String(item.category || '').slice(0, 40), unit: item.unit === null ? '' : String(item.unit || '').slice(0, 40),
      source: item.source === 'network' || item.source === 'derived' ? item.source : 'unknown',
      formula: item.formula === null ? '' : String(item.formula || '').slice(0, 300),
      notes: item.notes === null ? '' : String(item.notes || '').slice(0, 500)});
  }
  const chartNames = new Map();
  for (const item of charts) {
    if (!item || typeof item.name !== 'string' || !forPlatform(item)) continue;
    chartNames.set(item.name, {name: item.name, title: String(item.title || '').slice(0, 200),
      category: String(item.category || '').slice(0, 40), returns: String(item.returns || '').slice(0, 40),
      unit: item.unit === null ? '' : String(item.unit || '').slice(0, 40)});
  }
  return {platform, metrics: byKey, charts: chartNames,
    version: `${platform}:${byKey.size}m:${chartNames.size}c`};
}

/* Ожидаемые графики подтверждённых ключей. Связь кандидатская: если график с таким именем
   в ответе не пришёл, ключ не подставляется по названию блока — остаётся missing с причиной. */
const EXPECTED_CHART = Object.freeze({
  followers_count: ['FollowersCountChart'],
  followers_change: ['FollowersChangeChart'],
  posts_count: ['PostsCountChart', 'TiktokPostsCountChart'],
  content_views: ['ContentImpressionsChart'],
  reach: ['ReachChart'],
});

/* Проекция: из блоков выбираются ТОЛЬКО подтверждённые registry ключи, по имени графика
   из явного списка. Незнакомый блок в показатели не идёт — он попадает в доказательства
   и в missing с причиной «смысл графика не подтверждён». */
/* Подтверждено ли покрытие ДАТЫ как измерение.

   Ключевое различие: covered_from/covered_to говорят, ЗА КАКИЕ ДАТЫ у источника есть
   наблюдения, а collection_enabled — включён ли сбор СЕЙЧАС. Выключенный сейчас сбор не
   отменяет того, что уже измерено внутри покрытия: история остаётся историей. Но верхняя
   граница тогда обязана быть названа — иначе неизвестно, докуда эта история доходит, и
   дата за её пределами выдавалась бы за измеренную.

   Одного covered_from по-прежнему мало: сервис может заполнять пропуски нулями. Поэтому
   при неизвестном состоянии сбора дата измерением не считается и уходит в доказательства
   с причиной. Полнота дня решается отдельно, в completeness: «измерено» и «измерено
   целиком» — разные вопросы. */
/* Сверка принадлежности ответа профилю запроса.

   Документированный overview отдаёт data.profile (объект) рядом с period/coverage/metrics;
   плоских profile_id/platform/platform_id в контракте нет. Поэтому здесь: ищем
   принадлежность там, где она может быть названа; если названа и противоречит — отказ;
   если не названа — ответ допустим, но принадлежность считается НЕподтверждённой
   (confirmed=false) и это уходит в доказательство. */
function identityValue(data, keys) {
  const holders = [data, data?.profile];
  for (const holder of holders) {
    if (!holder || typeof holder !== 'object' || Array.isArray(holder)) continue;
    for (const key of keys) {
      const value = holder[key];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      return String(value);
    }
  }
  return null;
}
function checkIdentity(data, profile) {
  const id = identityValue(data, ['id', 'profile_id', 'analytics_id']);
  const platform = identityValue(data, ['platform', 'platform_name']);
  const native = identityValue(data, ['platform_id', 'account_id', 'native_account_id', 'external_id']);
  if (id !== null && id !== profile.id)
    return {ok: false, code: 'PROFILE_CHANGED', message: 'Ответ назвал другой аналитический профиль'};
  if (platform !== null && platform !== profile.platform)
    return {ok: false, code: 'PROFILE_CHANGED', message: 'Ответ назвал другую площадку'};
  if (native !== null && String(native) !== String(profile.nativeAccountId))
    return {ok: false, code: 'ACCOUNT_CHANGED', message: 'Ответ назвал другой аккаунт площадки'};
  return {ok: true, code: '', message: '',
    // Принадлежность подтверждена, только если источник её действительно назвал.
    confirmed: Boolean(id !== null || native !== null)};
}

function measuredDate(coverage, date) {
  if (!coverage.known) return {ok: false, reason: 'покрытие источника не подтверждено'};
  if (date < coverage.coveredFrom) return {ok: false, reason: 'дата раньше начала покрытия источника'};
  if (coverage.coveredTo && date > coverage.coveredTo) return {ok: false, reason: 'дата позже конца покрытия источника'};
  if (coverage.collectionEnabled === false) {
    if (!coverage.coveredTo) return {ok: false, reason: 'сбор по профилю остановлен, а конец покрытия не назван: границы подтверждённой истории неизвестны'};
    // Дата внутри названных границ: наблюдение историческое, но подтверждённое.
    return {ok: true, reason: '', historical: true, limit: 'сбор по профилю остановлен: значение историческое, новых измерений за эту дату не будет'};
  }
  if (coverage.collectionEnabled === null && coverage.collecting === null)
    return {ok: false, reason: 'состояние сбора источником не подтверждено: значение не считается измерением'};
  return {ok: true, reason: ''};
}

/* Проекция.

   Ни одно значение не попадает в дневную проекцию, пока не подтверждено ВСЁ:
   возвращённые границы периода, дневная детализация, запрошенный часовой пояс,
   принадлежность даты точки запросу, покрытие даты, наличие графика и метрики в каталоге
   источника и совпадение unit/source каталога с нашим registry. Любое расхождение —
   причина в missing и место в доказательствах, но не число в показателях. */
function project({blocks, platform, coverage, period, catalog = null, requested = null, timezone = null}) {
  const out = {measurements: [], missing: [], projectable: true};
  const block = (name) => blocks.find((item) => item.chart === name) || null;
  // Неподтверждённые границы, детализация и часовой пояс закрывают проекцию целиком.
  if (!period.confirmed) { out.projectable = false; out.missing.push('источник не назвал возвращённый период: дневная проекция не строится'); }
  else if (requested && !period.matchesRequested) { out.projectable = false; out.missing.push(`источник вернул период ${period.from}—${period.to} вместо запрошенного ${requested.from}—${requested.to}: дневная проекция не строится`); }
  if (period.granularity && period.granularity !== 'day') { out.projectable = false; out.missing.push(`источник вернул детализацию ${period.granularity}, а не day: дневная проекция не строится`); }
  if (timezone) {
    if (!period.timezoneConfirmed) { out.projectable = false; out.missing.push('источник не подтвердил часовой пояс ответа: дневная проекция не строится'); }
    else if (period.timezone !== timezone) { out.projectable = false; out.missing.push(`источник вернул часовой пояс ${period.timezone} вместо запрошенного ${timezone}: дневная проекция не строится`); }
  }
  /* Каталог обязателен: без него нечем проверить unit и source графика, а угадывать
     по названию нельзя. */
  if (!catalog) { out.projectable = false; out.missing.push('каталог метрик источника не получен: смысл графиков не проверен, проекция не строится'); }
  const seenMetric = new Set();
  for (const [key, rule] of Object.entries(REGISTRY)) {
    if (Array.isArray(rule.platforms) && !rule.platforms.includes(platform)) continue;
    const name = (EXPECTED_CHART[key] || []).find((item) => block(item));
    if (!name) { out.missing.push(`${key}: источник не вернул подтверждённый график этой метрики`); continue; }
    const found = block(name);
    if (rule.candidate) { out.missing.push(`${name}: семантика точек не подтверждена контрактом, значение осталось только в доказательствах`); continue; }
    if (catalog) {
      const definition = catalog.metrics.get(key), chartDef = catalog.charts.get(name);
      if (!definition) { out.missing.push(`${key}: метрики нет в каталоге источника для этой площадки`); continue; }
      if (!chartDef) { out.missing.push(`${name}: графика нет в каталоге источника для этой площадки`); continue; }
      // unit и source каталога должны совпасть с нашим сопоставлением, иначе это другой смысл.
      if (definition.unit && definition.unit !== rule.unit) { out.missing.push(`${key}: единица каталога ${definition.unit} не совпадает с ожидаемой ${rule.unit}`); continue; }
      if (definition.source !== rule.source) { out.missing.push(`${key}: источник значения в каталоге ${definition.source}, ожидался ${rule.source}`); continue; }
      if (chartDef.unit && chartDef.unit !== rule.unit) { out.missing.push(`${name}: единица графика ${chartDef.unit} не совпадает с ожидаемой ${rule.unit}`); continue; }
      if (chartDef.returns && chartDef.returns !== 'series') { out.missing.push(`${name}: график возвращает ${chartDef.returns}, а не дневной ряд`); continue; }
    }
    if (seenMetric.has(rule.metric)) { out.missing.push(`${key}: метрика ${rule.metric} уже получена из другого графика`); continue; }
    seenMetric.add(rule.metric);
    if (!found.points.length) { out.missing.push(`${rule.metric}: источник не вернул ряд за период`); continue; }
    for (const point of found.points) {
      // Точка вне запрошенного интервала в дневную проекцию не идёт: это другой период.
      if (requested && (point.date < requested.from || point.date > requested.to)) {
        out.missing.push(`${rule.metric} за ${point.date}: дата вне запрошенного периода`);
        continue;
      }
      const measured = measuredDate(coverage, point.date);
      if (!measured.ok) { out.missing.push(`${rule.metric} за ${point.date}: ${measured.reason}`); continue; }
      if (!out.projectable) continue;
      /* Источник перестал отдавать значение за уже записанную дату. Молча пропустить
         такую точку нельзя: в проекции осталась бы прежняя цифра и продолжала бы
         считаться подтверждённой. Записывается явное отсутствие измерения. */
      if (point.value === null) {
        out.missing.push(`${rule.metric} за ${point.date}: источник больше не возвращает значение — прежнее число снято`);
        out.measurements.push({date: point.date, period: 'day', metric: rule.metric, value: null,
          sourceField: `${name}:${key}`, scope: rule.scope, unit: rule.unit, aggregation: rule.aggregation,
          kind: 'unknown', cleared: true, completenessFloor: 'unknown'});
        continue;
      }
      if (measured.limit) out.missing.push(`${rule.metric} за ${point.date}: ${measured.limit}`);
      out.measurements.push({date: point.date, period: 'day', metric: rule.metric, value: point.value,
        sourceField: `${name}:${key}`, scope: rule.scope, unit: rule.unit, aggregation: rule.aggregation,
        kind: 'unknown', ...(measured.historical ? {historicalCoverage: true} : {})});
    }
  }
  for (const item of blocks) {
    const mapped = Object.entries(REGISTRY).some(([key, rule]) => !rule.candidate && (EXPECTED_CHART[key] || []).includes(item.chart));
    if (!mapped) out.missing.push(`${item.chart}: смысл графика не подтверждён, значение в показатели не записано`);
  }
  out.period = period;
  return out;
}

/* ---------- сетевой слой ---------- */

function createSocialOnlypultAnalytics({fetchImpl = fetch, now = () => Date.now(), resolveCredential,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))} = {}) {
  if (typeof resolveCredential !== 'function') throw new Error('Нужен резолвер аналитического доступа');

  async function readBody(response, signal) {
    const reader = response.body?.getReader?.();
    if (!reader) {
      const text = await response.text();
      if (text.length > MAX_BYTES) throw failure('RESPONSE_TOO_LARGE', 'Ответ источника слишком большой');
      return text;
    }
    const chunks = []; let size = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw failure('RESPONSE_TOO_LARGE', 'Ответ источника слишком большой'); }
      chunks.push(value);
    }
    if (signal?.aborted) throw failure('TIMEOUT', 'Источник не ответил вовремя');
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  }

  /* Один GET. redirect:'error' обязателен: следовать за редиректом с заголовком
     Authorization — значит отдать ключ туда, куда нас перенаправили. */
  async function request(credential, endpointPath, query = {}) {
    const url = new URL(ORIGIN + BASE + endpointPath);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    if (url.origin !== ORIGIN) throw failure('BAD_ENDPOINT', 'Недопустимый адрес источника');
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response, body;
      const signal = AbortSignal.timeout(TIMEOUT_MS);
      try {
        response = await fetchImpl(url.href, {method: 'GET', redirect: 'error', signal,
          headers: {authorization: `Bearer ${credential}`, accept: 'application/json'}});
        body = await readBody(response, signal);
      } catch (error) {
        if (error?.code === 'RESPONSE_TOO_LARGE') throw error;
        lastError = failure('CONNECTION_UNCERTAIN', 'Источник не ответил');
        if (attempt < MAX_ATTEMPTS) { await sleep(attempt * 500); continue; }
        throw lastError;
      }
      if (response.status === 401 || response.status === 403) throw failure('ACCESS_DENIED', 'Источник отклонил доступ к аналитике');
      if (response.status === 404) throw failure('NOT_FOUND', 'Аналитический профиль или раздел не найден');
      if (response.status === 422) throw failure('UNSUPPORTED', 'Источник не поддерживает такой запрос для этого профиля');
      if (response.status === 429 || response.status >= 500) {
        lastError = failure(response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR', 'Источник временно недоступен');
        if (attempt < MAX_ATTEMPTS) { await sleep(attempt * 1000); continue; }
        throw lastError;
      }
      if (!response.ok) throw failure('UPSTREAM_ERROR', 'Источник вернул неизвестную ошибку');
      let parsed;
      try { parsed = JSON.parse(body); } catch { throw failure('RESPONSE_UNCERTAIN', 'Ответ источника не разобран'); }
      if (!parsed || typeof parsed !== 'object' || !Object.hasOwn(parsed, 'data')) throw failure('RESPONSE_UNCERTAIN', 'Ответ источника без поля data');
      return parsed.data;
    }
    throw lastError || failure('CONNECTION_UNCERTAIN', 'Источник не ответил');
  }

  const credentialFor = (companyCode) => {
    const resolved = resolveCredential(companyCode);
    if (!resolved || !resolved.credential) throw failure('MISSING_ACCESS', 'Аналитический доступ не настроен');
    if (resolved.unreadable) throw failure('CREDENTIAL_UNREADABLE', 'Сохранённый доступ не читается: сохраните ключ заново');
    return resolved;
  };

  /* Список аналитических профилей. profiles=[] — это «аналитический профиль не подключён»,
     а не ошибка и не повод выбрать что-то автоматически. */
  async function listProfiles(companyCode) {
    const access = credentialFor(companyCode);
    const data = await request(access.credential, `/analytics/${ENDPOINTS.profiles}`);
    const raw = Array.isArray(data) ? data : Array.isArray(data?.profiles) ? data.profiles : null;
    if (!raw) throw failure('RESPONSE_UNCERTAIN', 'Список профилей не разобран');
    const profiles = raw.slice(0, 500).map(normalizeProfile).filter(Boolean);
    return {accessRevision: access.revision, profiles,
      // Отличаем «профилей нет» от «пришли записи, но ни одна не является профилем аналитики».
      rejected: raw.length - profiles.length};
  }

  async function catalog(companyCode, platform) {
    if (!Object.hasOwn(PLATFORMS, platform)) throw failure('UNSUPPORTED', UNSUPPORTED_NOTE);
    const access = credentialFor(companyCode);
    const data = await request(access.credential, `/analytics/${ENDPOINTS.metrics}`, {platform});
    return indexCatalog({data}, platform);
  }

  /* Дневной сбор по одному профилю. Ревизия доступа проверяется снаружи до и после:
     сюда она приходит и возвращается, чтобы вызывающий мог сверить. */
  async function collectDay({companyCode, profile, from, to, timezone, catalog: catalogIndex}) {
    if (!profile || !isAnalyticsId(profile.id)) throw failure('MISSING_ACCESS', 'Аналитический профиль не выбран');
    if (!Object.hasOwn(PLATFORMS, profile.platform)) throw failure('UNSUPPORTED', UNSUPPORTED_NOTE);
    if (!isDay(from) || !isDay(to) || from > to) throw failure('BAD_PERIOD', 'Неверный период запроса');
    if (daysBetween(from, to) > MAX_RANGE_DAYS) throw failure('BAD_PERIOD', 'Слишком длинный период за один запрос');
    if (timezone && !zoneOk(timezone)) throw failure('BAD_TIMEZONE', 'Неизвестный часовой пояс');
    const access = credentialFor(companyCode);
    /* Отсутствие capabilities — НЕ разрешение. Пустой список означает «профиль не сообщил,
       что умеет», и тогда запрос не делается вовсе: иначе достаточно было бы подставить
       синтетический профиль с пустыми полями, чтобы обойти проверку. */
    if (!profile.endpoints.includes(ENDPOINTS.overview)) {
      return {status: 'unsupported', accessRevision: access.revision,
        missing: [profile.endpoints.length
          ? `профиль ${profile.id} не поддерживает раздел overview: подходящего пути для дневного ряда нет`
          : `профиль ${profile.id} не сообщил список доступных разделов: без подтверждённой capability запрос не делается`],
        blocks: [], warnings: []};
    }
    if (!profile.granularity.includes('day')) {
      return {status: 'unsupported', accessRevision: access.revision,
        missing: [profile.granularity.length
          ? `профиль ${profile.id} не отдаёт дневную детализацию`
          : `профиль ${profile.id} не сообщил доступную детализацию: дневной ряд не запрашивается`],
        blocks: [], warnings: []};
    }
    /* Каталог обязателен до проекции: без него unit и source графиков не проверить. */
    const catalogIndexUsed = catalogIndex && catalogIndex.platform === profile.platform
      ? catalogIndex : await catalog(companyCode, profile.platform);
    const data = await request(access.credential, `/analytics/${encodeURIComponent(profile.id)}/${ENDPOINTS.overview}`,
      {include_series: 1, date_from: from, date_to: to, granularity: 'day', ...(timezone ? {timezone} : {})});
    /* Принадлежность ответа. Она уже обеспечена двумя вещами: профиль взят из настоящего
       listProfiles, и адрес запроса содержит именно его an_ID. Требовать сверх этого
       недокументированные top-level profile_id/platform/platform_id было ошибкой —
       официальный overview отдаёт объект data.profile рядом с period/coverage/metrics.
       Поэтому здесь отклоняется только ЯВНОЕ противоречие: если источник назвал свою
       принадлежность и она не наша. Молчание ответа само по себе не отвергает допустимый
       ответ, но и не считается подтверждением — это видно по identityConfirmed. */
    const identity = checkIdentity(data, profile);
    if (!identity.ok) throw failure(identity.code, identity.message);
    const coverage = normalizeCoverage(data?.coverage);
    const warnings = normalizeWarnings(data?.warnings);
    const period = normalizePeriod(data?.period, {from, to});
    const {blocks, shapeOk} = normalizeBlocks(data, ENDPOINTS.overview);
    if (!shapeOk) return {status: 'partial', accessRevision: access.revision, coverage, warnings, period, blocks: [],
      missing: ['ответ overview пришёл в неподтверждённой структуре: значения не записаны']};
    const projected = project({blocks, platform: profile.platform, coverage, period,
      catalog: catalogIndexUsed, requested: {from, to}, timezone: timezone || null});
    /* Полнота. complete — сильное утверждение: «за эти сутки источник домерил всё».
       Каждый неизвестный флаг проверяется ОТДЕЛЬНО: прежняя проверка требовала, чтобы
       оба флага отсутствовали, и covered_from вместе с collection_enabled=true при
       отсутствующем collecting давали complete, хотя состояние догрузки неизвестно.
       Неизвестно — значит unknown, а не complete. */
    const todayLocal = localDay(now(), timezone || profile.timezone || 'UTC');
    const completeness = (date) => {
      if (date >= todayLocal) return 'partial';           // текущие сутки не закрыты
      if (coverage.collecting === true) return 'partial'; // источник сам говорит, что ещё догружает
      if (warnings.length) return 'partial';              // источник предупредил о неполноте
      if (!coverage.known) return 'unknown';              // границ покрытия нет
      if (coverage.collecting === null) return 'unknown'; // состояние догрузки не названо
      if (coverage.collectionEnabled === null) return 'unknown';
      if (!coverage.coveredTo) return 'unknown';          // верхняя граница истории не названа
      if (date > coverage.coveredTo) return 'unknown';
      return 'complete';
    };
    return {
      status: projected.measurements.length ? (warnings.length || coverage.collecting === true ? 'partial' : 'ok') : 'partial',
      accessRevision: access.revision, coverage, warnings, period, blocks,
      catalogVersion: catalogIndexUsed ? catalogIndexUsed.version : '', mappingVersion: MAPPING_VERSION,
      projectable: projected.projectable,
      identityConfirmed: identity.confirmed,
      measurements: projected.measurements.map((item) => ({...item,
        // Снятое значение не может быть «полным»: у него вообще нет значения.
        completeness: item.completenessFloor === 'unknown' ? 'unknown' : completeness(item.date)})),
      missing: projected.missing,
    };
  }

  return {listProfiles, catalog, collectDay};
}

/* Локальная дата в часовом поясе аккаунта: «сегодня» у профиля и у сервера могут отличаться,
   и текущий день должен оставаться partial именно по времени аккаунта. */
function localDay(ms, timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'})
      .format(new Date(ms));
  } catch { return new Date(ms).toISOString().slice(0, 10); }
}

module.exports = {createSocialOnlypultAnalytics, ANALYTICS_REGISTRY: REGISTRY, ANALYTICS_ENDPOINTS: ENDPOINTS,
  ANALYTICS_PLATFORMS: PLATFORMS, ANALYTICS_MAPPING_VERSION: MAPPING_VERSION, FORBIDDEN_MAPPING,
  normalizeProfile, normalizeCoverage, normalizePeriod, normalizeBlocks, normalizeBlock, indexCatalog, project, localDay,
  measuredDate, checkIdentity};
