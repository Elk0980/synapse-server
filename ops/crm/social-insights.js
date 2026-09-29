'use strict';
/* «Что видно по данным»: детерминированные наблюдения по уже сохранённым измерениям.

   Модуль чистый: ни одного запроса к площадкам, ни одного чтения базы, ни одной записи.
   На вход приходят готовые DTO принятой аналитики (overview текущего и сравниваемого
   интервалов, postMetrics, выбранная версия замера «ДО», сводка загруженных отчётов 2ГИС),
   на выход — список наблюдений с датами, происхождением, покрытием и явной причиной, когда
   сравнение недопустимо. Одинаковый вход и одни правила дают одинаковый результат: порядок
   наблюдений и тексты фиксированы, случайности и обращений к текущему времени здесь нет.

   Чего этот модуль НЕ делает и делать не должен:
   — не досчитывает отсутствующее (нет измерения — это результат с причиной, а не 0);
   — не складывает охват ни по дням, ни между площадками;
   — не превращает состояние на дату (lifetime) в результат периода;
   — не приписывает изменение органике, рекламе, контенту или работе команды;
   — не делает выводов о продажах без подтверждённой однозначной связи;
   — не смешивает дату измерения публикации с датой её выхода. */

const INSIGHTS_RULES_VERSION = '2026-09-29';

/* Семь площадок картины. MAX здесь ЕСТЬ, но источника измерений у него нет: об этом
   говорится прямо, а не заменяется нулём и не выводится из настроек публикаций.
   2ГИС стоит отдельным блоком: это загруженные отчёты, а не сбор по API. */
const SOCIAL_PLATFORMS = Object.freeze([
  {key: 'instagram', label: 'Instagram'},
  {key: 'tiktok', label: 'TikTok'},
  {key: 'youtube', label: 'YouTube'},
  {key: 'vk', label: 'ВКонтакте'},
  {key: 'telegram', label: 'Telegram'},
  {key: 'max', label: 'MAX'},
]);
// Площадки, у которых в принятой аналитике нет источника измерений.
const WITHOUT_SOURCE = Object.freeze({
  max: 'источник измерений MAX в аналитике не реализован: настройки публикаций измерениями не являются',
});

const METRIC_LABELS = Object.freeze({
  followers: 'подписчики', follower_change: 'прирост подписчиков', reach: 'охват', impressions: 'показы',
  views: 'просмотры', profile_visits: 'переходы в профиль', likes: 'реакции', comments: 'комментарии',
  shares: 'репосты', saves: 'сохранения', clicks: 'клики', link_clicks: 'переходы по ссылке',
  watch_time_seconds: 'время просмотра, с', avg_watch_seconds: 'среднее время просмотра, с',
  retention_percent: 'удержание, %', posts_published: 'публикаций',
});
/* Метрики, которые нельзя складывать по дням ни при каких условиях. Охват — люди, а не
   события: сумма дней уникальным охватом периода не является. Проценты и средние
   длительности без весов в общий показатель не сводятся. */
const NOT_SUMMABLE = Object.freeze({
  reach: 'охват не суммируется ни по дням, ни между площадками: одни и те же люди могли увидеть материал несколько раз',
  retention_percent: 'удержание — процент: без весов в общий показатель за период не сводится',
  avg_watch_seconds: 'среднее время просмотра без весов в общий показатель за период не сводится',
});
// Состояние на дату: результатом периода не становится.
const STATE_METRICS = Object.freeze(new Set(['followers']));

// Вид измерения — это область показателя, а не украшение: органика и реклама не один ряд.
const KIND_LABELS = Object.freeze({organic: 'органика', paid: 'реклама', mixed: 'смешанное', unknown: 'не размечено'});
const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const dayMs = 86400000;
const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * dayMs).toISOString().slice(0, 10);
const lengthOf = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMs) + 1;

/* Интервал сравнения по умолчанию — непосредственно предшествующий интервал такой же
   календарной длины. Границы называются обе, молча ничего не сдвигается. */
function previousPeriod(from, to) {
  if (!isDay(from) || !isDay(to) || from > to) return null;
  const days = lengthOf(from, to);
  return {from: shift(from, -days), to: shift(from, -1), days};
}

// Даты периода и пропуски конкретной метрики: диапазонами, а не «строк столько-то».
function gapRanges(from, to, known) {
  const have = new Set(known);
  const ranges = [];
  let cursor = from, open = null;
  for (let guard = 0; guard <= lengthOf(from, to); guard += 1) {
    if (cursor > to) break;
    if (have.has(cursor)) { if (open) { ranges.push({from: open, to: shift(cursor, -1)}); open = null; } }
    else if (!open) open = cursor;
    cursor = shift(cursor, 1);
  }
  if (open) ranges.push({from: open, to});
  return ranges;
}
const rangeText = (ranges) => ranges.map((r) => (r.from === r.to ? r.from : `${r.from}—${r.to}`)).join(', ');

/* Сопоставимость двух рядов одной метрики. Неизвестность совпадением не считается:
   если признак не назван ни там, ни там, это не «одинаково», а «неизвестно». */
function comparability(a, b) {
  const reasons = [];
  if (!a || !b) return {ok: false, reasons: ['нет второго интервала для сравнения']};
  if ((a.accountRef || '') !== (b.accountRef || '')) reasons.push('аккаунт площадки в интервалах разный');
  if (!a.accountRef || !b.accountRef) reasons.push('аккаунт площадки не указан хотя бы в одном интервале');
  if ((a.timezone || '') !== (b.timezone || '')) reasons.push('система суток в интервалах разная');
  if (!a.timezone || !b.timezone) reasons.push('система суток не подтверждена хотя бы в одном интервале');
  if ((a.provider || '') !== (b.provider || '')) reasons.push('источник измерений сменился, а эквивалентность методик не доказана');
  if ((a.scope || 'profile') !== (b.scope || 'profile')) reasons.push('область измерения в интервалах разная');
  return {ok: reasons.length === 0, reasons};
}

// Процент считается только от положительной базы. База 0 — абсолютная разница и честное «процент не определён».
function change(before, after) {
  const diff = after - before;
  if (before > 0) return {diff, percent: Math.round((diff / before) * 1000) / 10, percentKnown: true};
  return {diff, percent: null, percentKnown: false};
}

const observation = (item) => ({
  ruleId: item.ruleId, platform: item.platform, platformLabel: item.platformLabel,
  metric: item.metric ?? null, metricLabel: item.metric ? (METRIC_LABELS[item.metric] || item.metric) : null,
  unit: item.unit ?? null, kind: item.kind,
  text: item.text,
  values: item.values ?? null, dates: item.dates ?? null,
  comparison: item.comparison || 'none', reason: item.reason || '',
  sources: item.sources ?? null,
});

/* Покрытие метрики внутри интервала по дневным строкам overview.
   Строка без известного значения покрытием не считается: «строка есть» и «значение есть» — разное. */
function metricDays(platformDto, metric, from, to) {
  const days = platformDto?.days && typeof platformDto.days === 'object' ? platformDto.days : {};
  const known = [], empty = [];
  for (const date of Object.keys(days).sort()) {
    if (date < from || date > to) continue;
    const cell = days[date]?.[metric];
    if (!cell) continue;
    if (num(cell.value) === null) empty.push(date); else known.push(date);
  }
  return {known, empty};
}
const kindsOf = (platformDto, metric, from, to) => {
  const days = platformDto?.days || {}, out = new Set();
  for (const date of Object.keys(days)) {
    if (date < from || date > to) continue;
    const cell = days[date]?.[metric];
    if (cell?.kind) out.add(cell.kind);
  }
  return [...out].sort();
};
const providersOf = (platformDto, metric, from, to) => {
  const days = platformDto?.days || {}, out = new Set();
  for (const date of Object.keys(days)) {
    if (date < from || date > to) continue;
    const cell = days[date]?.[metric];
    if (cell?.provider) out.add(cell.provider);
  }
  return [...out].sort();
};
const completeDays = (platformDto, metric, from, to) => {
  const days = platformDto?.days || {}, out = [];
  for (const date of Object.keys(days).sort()) {
    if (date < from || date > to) continue;
    const cell = days[date]?.[metric];
    if (cell && num(cell.value) !== null && cell.completeness === 'complete') out.push(date);
  }
  return out;
};

/* ---------- наблюдения по одной социальной площадке ---------- */

function socialPlatform({key, label}, {current, previous, period, comparison, today}) {
  const out = [];
  const platformLabel = current?.platforms?.[key]?.label || label;
  const base = {platform: key, platformLabel};

  if (WITHOUT_SOURCE[key]) {
    out.push(observation({...base, ruleId: 'absent.no_source', kind: 'absent',
      text: `${platformLabel}: измерений нет — ${WITHOUT_SOURCE[key]}.`,
      reason: WITHOUT_SOURCE[key]}));
    return out;
  }
  const item = current?.platforms?.[key];
  if (!item) {
    out.push(observation({...base, ruleId: 'absent.not_in_overview', kind: 'absent',
      text: `${platformLabel}: площадка отсутствует в сводке измерений — источник не подключён к расчёту.`,
      reason: 'площадки нет в принятой сводке измерений'}));
    return out;
  }
  if (!item.configured) {
    const missing = Array.isArray(item.access?.missing) && item.access.missing.length ? item.access.missing.join('; ') : 'аккаунт площадки не настроен';
    out.push(observation({...base, ruleId: 'absent.not_configured', kind: 'absent',
      text: `${platformLabel}: аккаунт не настроен, поэтому измерений нет. Недостаёт: ${missing}.`,
      reason: missing}));
    return out;
  }
  const prev = previous?.platforms?.[key] || null;
  const sources = {accountRef: item.accountRef || null, timezone: item.timezone || item.activeInterval || null,
    provider: item.provider || null, lastRunId: null, sourceNote: item.lastRun?.sourceNote || null};

  /* 1. Состояние на дату (подписчики). Одиночный снимок динамику не доказывает. */
  const latest = item.latest && typeof item.latest === 'object' ? item.latest : {};
  for (const metric of Object.keys(latest).sort()) {
    if (!STATE_METRICS.has(metric)) continue;
    const now = latest[metric];
    if (num(now?.value) === null) continue;
    const then = prev?.latest?.[metric] || null;
    const same = then && then.date === now.date;
    if (!then || num(then.value) === null) {
      out.push(observation({...base, ruleId: 'state.single', kind: 'state', metric, unit: current?.metrics?.[metric] || null,
        text: `${platformLabel}: ${METRIC_LABELS[metric]} — ${now.value} на ${now.date} (источник: ${now.provider || 'не указан'}). Это состояние на дату; одним замером динамика не доказана.`,
        values: {value: now.value}, dates: {measuredAt: now.date}, comparison: 'none',
        reason: 'второго сопоставимого замера нет', sources: {...sources, provider: now.provider || null}}));
      continue;
    }
    if (same) {
      out.push(observation({...base, ruleId: 'state.same_measurement', kind: 'state', metric,
        text: `${platformLabel}: ${METRIC_LABELS[metric]} — ${now.value} на ${now.date}. В сравниваемом интервале это же самое измерение, поэтому изменение не считается.`,
        values: {value: now.value}, dates: {measuredAt: now.date}, comparison: 'not_comparable',
        reason: 'в обоих интервалах одно и то же измерение', sources}));
      continue;
    }
    const check = comparability({accountRef: item.accountRef, timezone: item.timezone, provider: now.provider, scope: 'profile'},
      {accountRef: prev.accountRef, timezone: prev.timezone, provider: then.provider, scope: 'profile'});
    if (!check.ok) {
      out.push(observation({...base, ruleId: 'state.not_comparable', kind: 'state', metric,
        text: `${platformLabel}: ${METRIC_LABELS[metric]} — ${now.value} на ${now.date} и ${then.value} на ${then.date}, но сравнивать их нельзя: ${check.reasons.join('; ')}.`,
        values: {value: now.value, previous: then.value}, dates: {measuredAt: now.date, previousMeasuredAt: then.date},
        comparison: 'not_comparable', reason: check.reasons.join('; '), sources}));
      continue;
    }
    const delta = change(then.value, now.value);
    const percent = delta.percentKnown ? `${delta.percent > 0 ? '+' : ''}${delta.percent}%` : 'процент не определён: база равна нулю';
    out.push(observation({...base, ruleId: 'state.change', kind: 'change', metric,
      text: `${platformLabel}: ${METRIC_LABELS[metric]} — ${then.value} на ${then.date} и ${now.value} на ${now.date}: ${delta.diff > 0 ? '+' : ''}${delta.diff} (${percent}). Причина изменения из этих данных не следует.`,
      values: {before: then.value, after: now.value, diff: delta.diff, percent: delta.percent},
      dates: {previousMeasuredAt: then.date, measuredAt: now.date}, comparison: 'ok',
      reason: '', sources}));
  }

  /* 2. Дневные метрики: покрытие, пропуски и сравнение только при полном покрытии обоих интервалов. */
  const metricKeys = [...new Set(Object.keys(item.totals || {}).concat(Object.keys(item.aggregation || {})))]
    .filter((metric) => !STATE_METRICS.has(metric)).sort();
  for (const metric of metricKeys) {
    const unit = current?.metrics?.[metric] || null;
    const mine = metricDays(item, metric, period.from, period.to);
    if (!mine.known.length) {
      if (mine.empty.length) out.push(observation({...base, ruleId: 'coverage.rows_without_values', kind: 'coverage', metric, unit,
        text: `${platformLabel}: ${METRIC_LABELS[metric]} — строки за ${mine.empty.length} дн. сохранены, но значений в них нет. Это отсутствие измерения, а не ноль.`,
        values: {knownDays: 0, emptyDays: mine.empty.length}, dates: {from: period.from, to: period.to},
        comparison: 'none', reason: 'известных значений за период нет', sources}));
      continue;
    }
    const expected = lengthOf(period.from, period.to);
    const gaps = gapRanges(period.from, period.to, mine.known);
    const kinds = kindsOf(item, metric, period.from, period.to);
    const mixed = kinds.some((k) => k === 'unknown' || k === 'mixed') || kinds.length > 1;
    const notSummable = NOT_SUMMABLE[metric] || '';
    const aggregation = item.aggregation?.[metric] || null;
    const mineComplete = completeDays(item, metric, period.from, period.to);
    /* Полным считается интервал, у которого ЗНАЧЕНИЕ есть за каждый день И каждое из этих
       значений подтверждено как полное. partial и unknown полнотой не являются: иначе два
       незакрытых дня сравнивались бы с двумя закрытыми как равные. */
    const full = mine.known.length === expected && mineComplete.length === expected;

    if (notSummable) {
      out.push(observation({...base, ruleId: 'coverage.not_summable', kind: 'coverage', metric, unit,
        text: `${platformLabel}: ${METRIC_LABELS[metric]} известны за ${mine.known.length} из ${expected} дн. (${mine.known[0]}—${mine.known.at(-1)}). Итог за период не считается: ${notSummable}.`,
        values: {knownDays: mine.known.length, expectedDays: expected},
        dates: {from: period.from, to: period.to, firstKnown: mine.known[0], lastKnown: mine.known.at(-1)},
        comparison: 'not_comparable', reason: notSummable, sources}));
      continue;
    }
    if (!full) {
      const unconfirmed = mine.known.filter((date) => !mineComplete.includes(date));
      const why = mine.known.length < expected
        ? `пропуски: ${rangeText(gaps)}`
        : `значения за ${rangeText(gapRanges(period.from, period.to, mineComplete))} не подтверждены как полные`;
      const tail = mine.known.length < expected
        ? `нет данных за ${rangeText(gaps)}`
        : `значения за ${unconfirmed.length} дн. помечены как незавершённые или неизвестной полноты`;
      out.push(observation({...base, ruleId: 'coverage.partial', kind: 'coverage', metric, unit,
        text: `${platformLabel}: ${METRIC_LABELS[metric]} известны за ${mine.known.length} из ${expected} дн., подтверждены как полные ${mineComplete.length}; ${tail}. Итог за период, тренд и прогноз по неполному ряду не считаются.`,
        values: {knownDays: mine.known.length, expectedDays: expected, completeDays: mineComplete.length},
        dates: {from: period.from, to: period.to, gaps}, comparison: 'not_comparable',
        reason: why, sources}));
      continue;
    }
    const total = num(item.totals?.[metric]);
    const complete = mineComplete;
    const totalText = aggregation === 'avg'
      ? `невзвешенное среднее суточных значений`
      : `сумма ${mine.known.length} дн.`;
    const parts = [`${platformLabel}: ${METRIC_LABELS[metric]} известны за все ${expected} дн. периода`];
    if (total !== null) parts.push(`${totalText} — ${total}`);
    if (complete.length < mine.known.length) parts.push(`подтверждённых как полные дней: ${complete.length} из ${mine.known.length}`);
    if (mixed) parts.push('органика и реклама не разделены');
    out.push(observation({...base, ruleId: 'coverage.full', kind: 'coverage', metric, unit,
      text: `${parts.join('; ')}.`,
      values: {knownDays: mine.known.length, expectedDays: expected, total, completeDays: complete.length},
      dates: {from: period.from, to: period.to}, comparison: 'none', reason: '', sources}));

    // Сравнение двух закрытых интервалов — только при полном покрытии обоих и доказанной сопоставимости.
    if (!comparison || !prev) continue;
    if (period.includesToday) {
      out.push(observation({...base, ruleId: 'compare.open_day', kind: 'change', metric, unit,
        text: `${platformLabel}: ${METRIC_LABELS[metric]} за выбранный период с предыдущим не сравниваются: в период входит незавершённый день ${today}.`,
        dates: {from: period.from, to: period.to, openDay: today}, comparison: 'not_comparable',
        reason: 'в выбранный период входит незавершённый день', sources}));
      continue;
    }
    const theirs = metricDays(prev, metric, comparison.from, comparison.to);
    const theirsComplete = completeDays(prev, metric, comparison.from, comparison.to);
    const expectedPrev = lengthOf(comparison.from, comparison.to);
    if (theirs.known.length !== expectedPrev || theirsComplete.length !== expectedPrev) {
      out.push(observation({...base, ruleId: 'compare.previous_partial', kind: 'change', metric, unit,
        text: `${platformLabel}: ${METRIC_LABELS[metric]} сравнить не с чем: за предыдущий период ${comparison.from}—${comparison.to} известно ${theirs.known.length} из ${expectedPrev} дн., подтверждены как полные ${theirsComplete.length}.`,
        values: {knownDays: theirs.known.length, expectedDays: expectedPrev, completeDays: theirsComplete.length},
        dates: {from: comparison.from, to: comparison.to}, comparison: 'not_comparable',
        reason: theirs.known.length !== expectedPrev
          ? 'предыдущий интервал покрыт не полностью'
          : 'значения предыдущего интервала не подтверждены как полные', sources}));
      continue;
    }
    /* Вид измерения (органика/реклама/смешанное/неразмеченное) — это ОБЛАСТЬ показателя.
       Сравнивать органику с рекламой как один ряд нельзя. Одинаковый единственный вид с
       обеих сторон сравнивать можно, если область названа. unknown не доказывает одну
       методику: даже ручные organic_likes и paid_likes могут быть не размечены. До появления
       подтверждённого контракта источника такой ряд не сравнивается. */
    const theirKinds = kindsOf(prev, metric, comparison.from, comparison.to);
    const kindReasons = [];
    if (kinds.length !== 1 || theirKinds.length !== 1) kindReasons.push('в интервале смешаны разные виды измерения (органика, реклама, смешанное или неразмеченное)');
    else if (kinds[0] !== theirKinds[0]) kindReasons.push(`вид измерения сменился: было «${KIND_LABELS[theirKinds[0]] || theirKinds[0]}», стало «${KIND_LABELS[kinds[0]] || kinds[0]}»`);
    else if (kinds[0] === 'unknown') kindReasons.push('область измерения не подтверждена: одинаковая отметка «не размечено» не доказывает сопоставимость');
    const check = comparability(
      {accountRef: item.accountRef, timezone: item.timezone, provider: providersOf(item, metric, period.from, period.to).join('+'), scope: 'profile'},
      {accountRef: prev.accountRef, timezone: prev.timezone, provider: providersOf(prev, metric, comparison.from, comparison.to).join('+'), scope: 'profile'});
    check.reasons.push(...kindReasons);
    if (kindReasons.length) check.ok = false;
    if (!check.ok) {
      out.push(observation({...base, ruleId: 'compare.not_comparable', kind: 'change', metric, unit,
        text: `${platformLabel}: ${METRIC_LABELS[metric]} за ${period.from}—${period.to} и ${comparison.from}—${comparison.to} не сравниваются: ${check.reasons.join('; ')}.`,
        dates: {from: period.from, to: period.to, previousFrom: comparison.from, previousTo: comparison.to},
        comparison: 'not_comparable', reason: check.reasons.join('; '), sources}));
      continue;
    }
    const before = num(prev.totals?.[metric]), after = total;
    if (before === null || after === null) continue;
    if (aggregation === 'avg') {
      out.push(observation({...base, ruleId: 'compare.avg_only', kind: 'change', metric, unit,
        text: `${platformLabel}: ${METRIC_LABELS[metric]} — невзвешенные средние ${before} (${comparison.from}—${comparison.to}) и ${after} (${period.from}—${period.to}). Общим показателем периода такое среднее не является, поэтому разность не выводится.`,
        values: {before, after}, dates: {from: period.from, to: period.to, previousFrom: comparison.from, previousTo: comparison.to},
        comparison: 'not_comparable', reason: 'среднее без весов общим показателем периода не является', sources}));
      continue;
    }
    const delta = change(before, after);
    const percent = delta.percentKnown ? `${delta.percent > 0 ? '+' : ''}${delta.percent}%` : 'процент не определён: база равна нулю';
    const tail = mixed
      ? ' Органика и реклама не разделены, поэтому изменение ни рекламе, ни органике не приписывается.'
      : ` Оба интервала измерены как «${KIND_LABELS[kinds[0]] || kinds[0]}». Причина изменения из этих данных не следует.`;
    out.push(observation({...base, ruleId: 'compare.interval', kind: 'change', metric, unit,
      text: `${platformLabel}: ${METRIC_LABELS[metric]} — ${before} за ${comparison.from}—${comparison.to} и ${after} за ${period.from}—${period.to}: ${delta.diff > 0 ? '+' : ''}${delta.diff} (${percent}).${tail}`,
      values: {before, after, diff: delta.diff, percent: delta.percent},
      dates: {from: period.from, to: period.to, previousFrom: comparison.from, previousTo: comparison.to},
      comparison: 'ok', reason: '', sources}));
  }

  /* 3. Наблюдения другой системы суток или другой области: отдельно, в общий ряд не входят. */
  for (const group of Array.isArray(item.otherIntervals) ? item.otherIntervals : []) {
    out.push(observation({...base, ruleId: 'coverage.other_interval', kind: 'coverage',
      text: `${platformLabel}: есть наблюдения другой системы суток или области (${group.timezone || 'пояс не указан'}, область ${group.scope || 'profile'}) за ${group.days} дн. С основным рядом они не складываются.`,
      values: {days: group.days}, comparison: 'not_comparable',
      reason: 'другая система суток или другая область измерения', sources}));
  }
  if (!out.length) {
    out.push(observation({...base, ruleId: 'absent.no_measurements', kind: 'absent',
      text: `${platformLabel}: аккаунт настроен, но измерений за период нет. Это отсутствие данных, а не ноль.`,
      dates: {from: period.from, to: period.to}, reason: 'измерений за период нет', sources}));
  }
  return out;
}

/* ---------- 2ГИС: отдельный блок ---------- */

function companyMetricsBlock(currentSummary, previousSummary, {period, comparison}) {
  const out = [], limitations = [], nextSteps = [];
  const base = {platform: 'gis', platformLabel: '2ГИС'};
  if (!currentSummary) {
    out.push(observation({...base, ruleId: 'gis.absent', kind: 'absent',
      text: '2ГИС: загруженных отчётов нет или источник не настроен — показателей нет. Это отсутствие данных, а не ноль.',
      reason: 'сводка загруженных отчётов 2ГИС недоступна'}));
    return {observations: out, limitations, nextSteps};
  }
  const scopeSources = {organizationId: currentSummary.organizationId || null, branchId: currentSummary.branchId || null,
    dataRevision: currentSummary.dataRevision ?? null, settingsRevision: currentSummary.settingsRevision ?? null};
  /* Настоящая система суток берётся из отчётов, участвующих ИМЕННО в этой метрике.
     Флага timezoneKnown недостаточно: он говорит лишь «пояс у отчётов назван», но не какой.
     Два отчёта могут быть названными и при этом разными — UTC и Asia/Irkutsk это не один
     ряд, и сравнивать их как один нельзя. */
  const zonesOf = (summary, item) => {
    const byId = new Map((Array.isArray(summary?.reports) ? summary.reports : []).map((row) => [row.id, row]));
    const zones = new Set();
    for (const row of (item?.days || [])) {
      if (!row.hasValue) continue;
      const report = byId.get(row.reportId);
      zones.add(report && report.timezone ? report.timezone : 'unknown');
    }
    return [...zones].sort();
  };
  const sameScope = previousSummary
    && previousSummary.organizationId === currentSummary.organizationId
    && previousSummary.branchId === currentSummary.branchId;
  for (const item of Array.isArray(currentSummary.metrics) ? currentSummary.metrics : []) {
    const reportIds = [...new Set((item.days || []).filter((d) => d.hasValue).map((d) => d.reportId))].sort();
    const sources = {...scopeSources, reportIds, timezones: zonesOf(currentSummary, item)};
    if (!item.daysWithValue) {
      out.push(observation({...base, ruleId: 'gis.no_values', kind: 'absent', metric: item.metric, unit: item.unit,
        text: `2ГИС · ${item.label}: загруженных значений за период нет${item.daysWithoutValue ? ` (строк без значения: ${item.daysWithoutValue})` : ''}. Это отсутствие данных, а не ноль.`,
        values: {daysWithValue: 0, daysWithoutValue: item.daysWithoutValue},
        dates: {from: period.from, to: period.to}, reason: 'значений за период нет', sources}));
      continue;
    }
    const expected = lengthOf(period.from, period.to);
    const gaps = gapRanges(period.from, period.to, (item.days || []).filter((d) => d.hasValue).map((d) => d.date));
    const notes = (item.scopeNotes || []).join('; ');
    const head = `2ГИС · ${item.label}: известно за ${item.daysWithValue} из ${expected} дн.`
      + (item.firstDate ? ` (${item.firstDate}—${item.lastDate})` : '');
    if (item.aggregation === 'daily_only') {
      out.push(observation({...base, ruleId: 'gis.daily_only', kind: 'coverage', metric: item.metric, unit: item.unit,
        text: `${head} Минимум ${item.min}, максимум ${item.max}. ${item.totalNote || 'Этот показатель не суммируется и не усредняется.'}`,
        values: {daysWithValue: item.daysWithValue, expectedDays: expected, min: item.min, max: item.max},
        dates: {from: period.from, to: period.to, gaps}, comparison: 'not_comparable',
        reason: 'показатель не суммируется и не усредняется', sources}));
      continue;
    }
    const parts = [head];
    if (item.totalAvailable) parts.push(`сумма — ${item.total}`);
    else if (item.totalNote) parts.push(item.totalNote);
    if (item.zeroDays) parts.push(`измеренных нулей: ${item.zeroDays} (это значение, а не пропуск)`);
    if (gaps.length) parts.push(`нет данных за ${rangeText(gaps)}`);
    if (notes) parts.push(`ограничение источника: ${notes}`);
    const coverageZones = zonesOf(currentSummary, item);
    if (!coverageZones.length || coverageZones.includes('unknown')) parts.push('часовой пояс отчётов неизвестен, пояс компании ему не подставляется');
    else if (coverageZones.length > 1) parts.push(`отчёты сняты в разных системах суток (${coverageZones.join(', ')}) — в один ряд они не сводятся`);
    else parts.push(`система суток отчётов: ${coverageZones[0]}`);
    out.push(observation({...base, ruleId: 'gis.coverage', kind: 'coverage', metric: item.metric, unit: item.unit,
      text: `${parts.join('; ')}.`,
      values: {daysWithValue: item.daysWithValue, expectedDays: expected, total: item.totalAvailable ? item.total : null, zeroDays: item.zeroDays},
      dates: {from: period.from, to: period.to, gaps}, comparison: 'none', reason: '', sources}));

    // Сравнение интервалов: один организация/филиал, одна метрика, одинаковые известные условия.
    if (!comparison || !previousSummary) continue;
    const prevItem = (previousSummary.metrics || []).find((row) => row.metric === item.metric);
    if (!prevItem || !prevItem.daysWithValue) continue;
    const reasons = [];
    if (!sameScope) reasons.push('организация или филиал в интервалах разные');
    if (item.mixedConditions || prevItem.mixedConditions) reasons.push('внутри интервала условия отчётов разные');
    const myZones = zonesOf(currentSummary, item), theirZones = zonesOf(previousSummary, prevItem);
    if (!myZones.length || !theirZones.length || myZones.includes('unknown') || theirZones.includes('unknown'))
      reasons.push('часовой пояс отчётов неизвестен');
    else if (myZones.length > 1 || theirZones.length > 1)
      reasons.push(`отчёты одного интервала сняты в разных системах суток (${[...new Set(myZones.concat(theirZones))].join(', ')})`);
    else if (myZones[0] !== theirZones[0])
      reasons.push(`система суток отчётов разная: ${theirZones[0]} и ${myZones[0]}`);
    if ((item.scopeNotes || []).join('|') !== (prevItem.scopeNotes || []).join('|')) reasons.push('условия охвата источника в интервалах разные');
    if (item.daysWithValue !== expected) reasons.push('текущий интервал покрыт не полностью');
    if (prevItem.daysWithValue !== lengthOf(comparison.from, comparison.to)) reasons.push('предыдущий интервал покрыт не полностью');
    if (!item.totalAvailable || !prevItem.totalAvailable) reasons.push('итог хотя бы одного интервала не считается');
    if (reasons.length) {
      out.push(observation({...base, ruleId: 'gis.not_comparable', kind: 'change', metric: item.metric, unit: item.unit,
        text: `2ГИС · ${item.label}: интервалы ${period.from}—${period.to} и ${comparison.from}—${comparison.to} не сравниваются: ${reasons.join('; ')}.`,
        dates: {from: period.from, to: period.to, previousFrom: comparison.from, previousTo: comparison.to},
        comparison: 'not_comparable', reason: reasons.join('; '), sources}));
      continue;
    }
    const delta = change(prevItem.total, item.total);
    const percent = delta.percentKnown ? `${delta.percent > 0 ? '+' : ''}${delta.percent}%` : 'процент не определён: база равна нулю';
    out.push(observation({...base, ruleId: 'gis.compare', kind: 'change', metric: item.metric, unit: item.unit,
      text: `2ГИС · ${item.label}: ${prevItem.total} за ${comparison.from}—${comparison.to} и ${item.total} за ${period.from}—${period.to}: ${delta.diff > 0 ? '+' : ''}${delta.diff} (${percent}). Причина изменения из отчётов не следует.`,
      values: {before: prevItem.total, after: item.total, diff: delta.diff, percent: delta.percent},
      dates: {from: period.from, to: period.to, previousFrom: comparison.from, previousTo: comparison.to},
      comparison: 'ok', reason: '', sources}));
  }
  limitations.push('2ГИС — загруженные вручную отчёты, а не автоматический сбор.');
  limitations.push('«Звонки и просмотры телефона» — один общий ряд источника: состоявшиеся звонки из него не выделяются.');
  limitations.push('Категории обращений, действия, переходы и маршруты между собой не складываются: пересечение неизвестно.');
  limitations.push('Воронка между отчётами 2ГИС и объединение их с соцсетями не считаются.');
  for (const line of Array.isArray(currentSummary.summary?.nextStep) ? currentSummary.summary.nextStep : []) nextSteps.push(`2ГИС: ${line}`);
  return {observations: out, limitations, nextSteps};
}

/* ---------- публикации и CRM ---------- */

function postsBlock(postMetrics, {period}) {
  const out = [], limitations = [];
  const base = {platform: 'posts', platformLabel: 'Публикации'};
  if (!postMetrics) return {observations: out, limitations};
  const coverage = postMetrics.coverage || {};
  out.push(observation({...base, ruleId: 'posts.period_meaning', kind: 'posts',
    text: `Публикации: период ${period.from}—${period.to} относится к датам ИЗМЕРЕНИЯ показателей, а не к датам выхода публикаций.`,
    dates: {from: period.from, to: period.to}, reason: '', sources: {postsSelection: coverage.postsSelection || null}}));
  for (const line of Array.isArray(postMetrics.summary?.visible) ? postMetrics.summary.visible : []) {
    out.push(observation({...base, ruleId: 'posts.visible', kind: 'posts', text: `Публикации: ${line}`,
      sources: {measurementDates: coverage.measurementDates || null}}));
  }
  if (coverage.storedPostsTruncated) limitations.push(`Показаны не все публикации архива: прочитано ${coverage.storedPostsRead} из ${coverage.storedPostsTotal}, остальные отрезаны лимитом.`);
  if (coverage.receiptsTruncated) limitations.push(`Показаны не все подтверждения выхода: прочитано ${coverage.receiptsRead} из ${coverage.receiptsTotal}.`);
  if (coverage.receiptsOnly) limitations.push(`Записей только с подтверждением выхода: ${coverage.receiptsOnly} — у них нет показателей площадки.`);
  limitations.push('У метрик публикаций нет признака «за день / за всё время», поэтому прирост, сумма по дням и рейтинг публикаций не считаются.');
  for (const line of Array.isArray(postMetrics.summary?.cannotConclude) ? postMetrics.summary.cannotConclude : []) limitations.push(`Публикации: ${line}`);
  return {observations: out, limitations};
}

function crmBlock(crm) {
  const out = [], limitations = [];
  const base = {platform: 'crm', platformLabel: 'Обращения CRM'};
  if (!crm) return {observations: out, limitations};
  const linked = Array.isArray(crm.posts) ? crm.posts.filter((post) => post.attribution === 'exact') : [];
  const unclear = Array.isArray(crm.posts) ? crm.posts.filter((post) => post.attribution !== 'exact') : [];
  const bySource = Array.isArray(crm.bySource) ? crm.bySource : [];
  if (linked.length) {
    out.push(observation({...base, ruleId: 'crm.linked', kind: 'crm',
      text: `Обращения CRM: однозначно связаны с публикациями ${linked.length} записей (по URL или метке с подтверждённой площадкой).`,
      values: {linked: linked.length}, reason: ''}));
  } else {
    out.push(observation({...base, ruleId: 'crm.none_linked', kind: 'crm',
      text: 'Обращения CRM: однозначно связанных с публикациями обращений нет. Это отсутствие доказанной связи, а не «канал не принёс продаж».',
      values: {linked: 0}, reason: 'однозначной связи нет'}));
  }
  if (unclear.length) {
    out.push(observation({...base, ruleId: 'crm.unclear', kind: 'crm',
      text: `Обращения CRM: записей с неоднозначной или неизвестной связью — ${unclear.length}. Они остаются отдельно и по площадкам не размножаются.`,
      values: {unclear: unclear.length}, comparison: 'not_comparable', reason: 'связь не однозначна'}));
  }
  for (const row of bySource) {
    out.push(observation({...base, ruleId: 'crm.by_source', kind: 'crm', platform: 'crm',
      text: `Обращения CRM по метке источника «${row.source}»: обращений ${row.leads}, продаж ${row.sales}. Метка говорит, что было указано в обращении, и причинность не доказывает.`,
      values: {leads: row.leads, sales: row.sales}, reason: ''}));
  }
  limitations.push('Подтверждение выхода публикации просмотров не даёт и обращением не является.');
  limitations.push('Даже совпадение метки с заявкой не доказывает, что публикация привела к продаже.');
  limitations.push('ROI, ROAS и сквозная конверсия здесь не считаются: для этого нужны подтверждённые расходы и связи.');
  return {observations: out, limitations};
}

/* ---------- сборка ---------- */

function buildInsights({companyCode, period, current, previous = null, comparison = null,
  postMetrics = null, baseline = null, companyMetrics = null, previousCompanyMetrics = null, today = null} = {}) {
  if (!period || !isDay(period.from) || !isDay(period.to) || period.from > period.to) {
    throw Object.assign(new Error('Неверный период выводов'), {code: 'VALIDATION_ERROR', status: 400});
  }
  const openDay = Boolean(today && isDay(today) && period.to >= today);
  const scopePeriod = {...period, includesToday: openDay};
  const observations = [], limitations = [], nextSteps = [];

  if (openDay) {
    limitations.push(`В выбранный период входит незавершённый день ${today}: его показатели ещё меняются и с полными сутками не сравниваются.`);
  }
  for (const platform of SOCIAL_PLATFORMS) {
    observations.push(...socialPlatform(platform, {current, previous, period: scopePeriod, comparison, today}));
  }
  const posts = postsBlock(postMetrics, {period: scopePeriod});
  observations.push(...posts.observations); limitations.push(...posts.limitations);
  const crm = crmBlock(current?.crm || null);
  observations.push(...crm.observations); limitations.push(...crm.limitations);
  const gis = companyMetricsBlock(companyMetrics, previousCompanyMetrics, {period: scopePeriod, comparison});
  limitations.push(...gis.limitations); nextSteps.push(...gis.nextSteps);

  /* Замер «ДО» — неизменяемая версия. Сегодняшние данные в неё не дописываются, и обычное
     сравнение соседних периодов словами «ДО/ПОСЛЕ» не называется. */
  const baselineVersion = baseline?.latest?.version ?? null;
  if (baselineVersion !== null) {
    limitations.push(`Сравнение «ДО/ПОСЛЕ» опирается на зафиксированную версию замера №${baselineVersion} и её доказательства; сегодняшними данными эта версия не дополняется.`);
  } else {
    limitations.push('Замер «ДО» не зафиксирован, поэтому утверждения «ДО/ПОСЛЕ» не делаются: сравнение соседних периодов этим названием не подменяется.');
  }
  limitations.push('Охват не суммируется по дням и не складывается между площадками; общий уникальный охват остаётся неизвестным.');
  limitations.push('Общий рейтинг площадок не строится: методики измерения у них разные.');
  limitations.push('Наблюдения посчитаны из уже сохранённых измерений: при открытии страницы ни один запрос к площадкам не делается.');

  // Следующие шаги — только там, где действие действительно есть.
  const missing = observations.filter((item) => item.kind === 'absent');
  for (const item of missing) nextSteps.push(`${item.platformLabel}: ${item.reason || 'источник не подключён'} — решить, подключаем источник или ведём измерения вручную.`);
  const gaps = observations.filter((item) => item.ruleId === 'coverage.partial');
  for (const item of gaps) nextSteps.push(`${item.platformLabel} · ${item.metricLabel}: догрузить или собрать пропущенные дни (${item.reason.replace('пропуски: ', '')}).`);
  if (!observations.some((item) => item.comparison === 'ok')) {
    nextSteps.push('Для сравнения нужны два сопоставимых закрытых интервала или два сопоставимых замера состояния: пока их нет, показываются только значения на даты и покрытие.');
  }

  return {
    rulesVersion: INSIGHTS_RULES_VERSION,
    companyCode: String(companyCode || '').toLowerCase(),
    requestedPeriod: {from: period.from, to: period.to, timezone: period.timezone || null, includesToday: openDay},
    comparisonPeriod: comparison ? {from: comparison.from, to: comparison.to} : null,
    baselineVersion,
    observations,
    social: observations.filter((item) => SOCIAL_PLATFORMS.some((p) => p.key === item.platform)),
    companyMetrics: gis.observations,
    limitations,
    nextSteps,
  };
}

module.exports = {buildInsights, previousPeriod, comparability, gapRanges, change, INSIGHTS_KIND_LABELS: KIND_LABELS,
  INSIGHTS_RULES_VERSION, INSIGHTS_PLATFORMS: SOCIAL_PLATFORMS, INSIGHTS_METRIC_LABELS: METRIC_LABELS,
  INSIGHTS_NOT_SUMMABLE: NOT_SUMMABLE};
