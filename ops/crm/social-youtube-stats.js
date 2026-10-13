'use strict';
/* Сбор измерений YouTube: текущий размер аудитории (Data API) и суточные показатели
   (Analytics API). Ничего не публикует и ничего не меняет на канале.

   Две принципиально разные величины и они не смешиваются:
   - текущее число подписчиков — СОСТОЯНИЕ на момент наблюдения, а не показатель за дату;
   - views / engagedViews / estimatedMinutesWatched / likes / comments / shares /
     subscribersGained|Lost — суточные величины в системе суток отчётов YouTube
     (America/Los_Angeles, с переходом на летнее время). Пояс компании здесь не применяется.

   views и engagedViews — РАЗНЫЕ метрики Analytics и друг друга не заменяют. Data API
   statistics.viewCount этим сборщиком не читается, и его смена 24.08.2026 к Analytics views
   автоматически не относится.

   Отсутствующая строка отчёта — НЕ измеренный ноль: такой день просто не записывается.
   Отчёт может заканчиваться раньше запрошенной даты (задержка данных) — это partial с
   повтором, а не «нет доступа» и не failed. */

const {YOUTUBE_ANALYTICS_REPORTS: ANALYTICS_REPORTS, YOUTUBE_DECISIVE_CODES, YOUTUBE_TEMPORARY_CODES,
  youtubeChannelRef} = require('./social-youtube-access');

const DAY_SYSTEM = 'America/Los_Angeles';
/* Запрашиваемые суточные метрики. Имена — официальные; сопоставление с нашими показателями
   задано явно, позиции колонок из ответа не предполагаются (разбирается columnHeaders). */
const DAILY_METRICS = Object.freeze(['views', 'estimatedMinutesWatched', 'likes', 'comments', 'shares',
  'subscribersGained', 'subscribersLost']);
/* engagedViews запрашивается ОТДЕЛЬНЫМ reports.query: отказ на эту метрику не должен
   уничтожить остальные показатели или обрезать период доступности основного отчёта. */
const ENGAGED_METRIC = 'engagedViews';
const METRIC_MAP = Object.freeze({
  views: {metric: 'views', field: 'views'},
  /* Имя показателя берётся из словаря движка (METRICS в social-stats.js): там это
     watch_time_seconds. Любое другое имя движок отвергает как невалидное, и транзакция
     откатывает ВСЕ снимки запуска, а не только эту строку. */
  estimatedMinutesWatched: {metric: 'watch_time_seconds', field: 'estimatedMinutesWatched', transform: (value) => value * 60},
  likes: {metric: 'likes', field: 'likes'},
  comments: {metric: 'comments', field: 'comments'},
  shares: {metric: 'shares', field: 'shares'},
});
// engaged_views в словаре движка добавляет Root (METRICS/AGGREGATION); до этого сбор отключается опцией.
const ENGAGED_RULE = Object.freeze({metric: 'engaged_views', field: ENGAGED_METRIC});
const COUNT_METRICS = new Set(['views', 'likes', 'comments', 'shares', 'subscribersGained', 'subscribersLost', ENGAGED_METRIC]);
const MINUTE_METRICS = new Set(['estimatedMinutesWatched']);
const NUMERIC_TYPES = Object.freeze(['INTEGER', 'FLOAT']);
/* Изменение подписчиков выводится ТОЛЬКО когда известны оба потока: иначе это не «ноль»,
   а неизвестность, и выдавать её за измеренное изменение нельзя. */
const FOLLOWER_CHANGE = Object.freeze({gained: 'subscribersGained', lost: 'subscribersLost'});
/* 24.08.2026 менялось определение Data API statistics.viewCount. Этот сборщик viewCount не
   читает, и к Analytics reports.query.views граница автоматически не применяется. Прежнее
   имя экспорта сохранено для совместимости. */
const DATA_API_VIEWCOUNT_CHANGE = '2026-08-24';
const VIEWS_DEFINITION_CHANGE = DATA_API_VIEWCOUNT_CHANGE;
/* Методика views для Shorts в Analytics сменилась 31.03.2025; внедрение в данные API шло
   постепенно (цель для targeted queries — до 30.04.2025, для bulk reports — до 30.06.2025).
   Точную границу для конкретной даты окна внедрения источник не подтверждает. */
const SHORTS_VIEWS_METHOD = Object.freeze({
  field: 'reports.query.views', changedOn: '2025-03-31',
  targetedQueriesRolloutTarget: '2025-04-30', bulkReportsRolloutTarget: '2025-06-30',
  engagedViews: 'reports.query.engagedViews — отдельная метрика; views ею не заменяется',
  dataApiViewCount: Object.freeze({changedOn: DATA_API_VIEWCOUNT_CHANGE,
    appliesTo: 'Data API statistics.viewCount — этим сборщиком не читается',
    analyticsViewsImpact: 'влияние на Analytics views не подтверждено первичным источником'}),
  sources: Object.freeze(['https://developers.google.com/youtube/analytics/metrics',
    'https://developers.google.com/youtube/analytics/dimensions',
    'https://developers.google.com/youtube/reporting/revision_history']),
});
// Общий срок одного сбора: все сетевые шаги вместе, а не каждый по отдельности.
const COLLECT_TIMEOUT_MS = 30000;

const failure = (code, message, status = 502) => Object.assign(new Error(message), {code, status});
const fail = (code, message, status = 502) => { throw failure(code, message, status); };
const timeoutError = () => failure('TIMEOUT', 'Сбор измерений YouTube не уложился в общий срок.', 504);
const stopError = () => failure('STOPPED', 'Сбор измерений YouTube остановлен.', 503);
const DECISIVE = new Set(YOUTUBE_DECISIVE_CODES);
const KNOWN = new Set([...YOUTUBE_DECISIVE_CODES, ...YOUTUBE_TEMPORARY_CODES, 'MISSING_ACCESS', 'BAD_PERIOD',
  'BAD_ENDPOINT', 'BAD_REQUEST', 'CHANNEL_UNCONFIRMED', 'REVISION_CONFLICT']);
// Наружу — только наши коды и тексты, без сырого исключения, адреса и текста Google.
const safeError = (error) => (KNOWN.has(error?.code) && typeof error.message === 'string'
  ? failure(error.code, error.message, error.status)
  : failure('UPSTREAM_ERROR', 'Сбор измерений YouTube завершился ошибкой.'));
const abortError = (signal) => (signal?.reason?.code === 'TIMEOUT' || signal?.reason?.name === 'TimeoutError'
  ? timeoutError() : stopError());
function untilAborted(start, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError(signal)); return; }
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, {once: true});
    new Promise((inner) => inner(start())).then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Календарная дата: формат и существование дня (2026-02-30 отвергается).
const calendarDate = (value) => typeof value === 'string' && DATE.test(value)
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
// Локальная дата в системе суток отчётов. Intl сам учитывает переход на летнее время.
const reportDay = (ms) => new Intl.DateTimeFormat('en-CA', {timeZone: DAY_SYSTEM,
  year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(ms));
const shiftDay = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const refKey = (value) => youtubeChannelRef(value).key;

/* Значение метрики. null — честная неизвестность. Отрицательное, дробное (для счётчиков),
   нечисловое, бесконечное или переполненное значение — НЕ пропускается молча: оно помечается
   недопустимым и не даёт закрыть сутки как полные. */
const INVALID = Symbol('invalid');
function metricValue(name, raw) {
  if (raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return INVALID;
  if (COUNT_METRICS.has(name)) return Number.isSafeInteger(raw) ? raw : INVALID;
  if (MINUTE_METRICS.has(name)) return Number.isSafeInteger(Math.ceil(raw * 60)) ? raw : INVALID;
  return INVALID;
}

/* Строгий разбор reports.query. Колонки уникальны и ожидаемы, у day тип DIMENSION/STRING, у
   метрик METRIC/числовой; каждая строка совпадает по длине, дата календарная, внутри
   периода и без повторов. Нарушение структуры — ответ недостоверен целиком. */
function parseReport(body, {from, to, requested}) {
  const bad = (message) => fail('RESPONSE_UNCERTAIN', message);
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.columnHeaders))
    bad('Отчёт YouTube не содержит ожидаемых колонок.');
  const headers = [];
  for (const item of body.columnHeaders) {
    const name = typeof item?.name === 'string' ? item.name : '';
    if (!name || headers.includes(name)) bad('Колонки отчёта YouTube не названы или повторяются.');
    const unexpected = name === 'day'
      ? item.columnType !== 'DIMENSION' || item.dataType !== 'STRING'
      : !requested.includes(name) || item.columnType !== 'METRIC' || !NUMERIC_TYPES.includes(item.dataType);
    if (unexpected) bad('Отчёт YouTube вернул неожиданную колонку или тип колонки.');
    headers.push(name);
  }
  if (!headers.includes('day')) bad('Отчёт YouTube не содержит колонки day.');
  if (body.rows !== undefined && body.rows !== null && !Array.isArray(body.rows))
    bad('Строки отчёта YouTube пришли в неожиданном виде.');
  const dayAt = headers.indexOf('day');
  const days = [], invalid = [], seen = new Set();
  for (const row of body.rows || []) {
    if (!Array.isArray(row) || row.length !== headers.length) bad('Строка отчёта YouTube не совпадает с колонками.');
    const date = row[dayAt];
    if (!calendarDate(date) || date < from || date > to)
      bad('Отчёт YouTube вернул несуществующую дату или дату вне запрошенного периода.');
    if (seen.has(date)) bad('Отчёт YouTube повторил дату.');
    seen.add(date);
    const values = {};
    headers.forEach((name, index) => {
      if (name === 'day') return;
      const value = metricValue(name, row[index]);
      if (value === INVALID) { invalid.push({date, metric: name}); values[name] = null; }
      else values[name] = value;
    });
    days.push({date, values});
  }
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  /* Пустой ответ — это «нет строк», а не «нулевые сутки». Так же и конец данных: он мог
     прийти раньше запрошенного to, и запрошенный хвост остаётся неизвестным. */
  const last = days.length ? days[days.length - 1].date : null;
  return {from, to, daySystem: DAY_SYSTEM, headers, days, invalid,
    lastCoveredDate: last, requestedTailUnknown: last === null || last < to, emptyReport: !days.length};
}

// Методика views для даты: честно называет несопоставимость, без ложной точной границы.
function viewsMethodology(date) {
  if (date < SHORTS_VIEWS_METHOD.changedOn) return {basis: 'shorts_before_2025_03_31',
    caveat: `views за ${date} относятся к периоду до смены методики подсчёта просмотров Shorts 31.03.2025: ряд через эту дату несопоставим`};
  if (date <= SHORTS_VIEWS_METHOD.targetedQueriesRolloutTarget) return {basis: 'shorts_rollout_window',
    caveat: `views за ${date} попадают в окно внедрения новой методики Shorts (31.03–30.04.2025 для reports.query): какой методикой посчитана дата, источник не подтверждает`};
  return {basis: 'shorts_after_targeted_rollout_target', caveat: ''};
}

function createSocialYoutubeStats({access, now = () => Date.now(), collectTimeoutMs = COLLECT_TIMEOUT_MS,
  collectEngagedViews = true} = {}) {
  if (!access?.accessToken || !access?.callApi) throw new Error('Сбор измерений YouTube требует модуля доступа');
  const totalMs = Number.isFinite(collectTimeoutMs) && collectTimeoutMs > 0
    ? Math.min(collectTimeoutMs, COLLECT_TIMEOUT_MS) : COLLECT_TIMEOUT_MS;
  const stopController = new AbortController();

  // Один общий срок на всю операцию плюс остановка модуля и сигнал вызывающего.
  function runScope(signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(timeoutError()), totalMs);
    const sources = [controller.signal, stopController.signal];
    if (signal instanceof AbortSignal) sources.push(signal);
    return {signal: AbortSignal.any(sources), done: () => clearTimeout(timer)};
  }
  const markFailure = (code, revision, failureCode) => {
    try { access.markCollectFailure?.(code, revision, failureCode); } catch { /* отметка не важнее ответа */ }
  };

  async function query(token, channelId, from, to, metrics, signal) {
    const body = await untilAborted(() => access.callApi(ANALYTICS_REPORTS, token, {
      ids: `channel==${channelId}`, startDate: from, endDate: to,
      dimensions: 'day', sort: 'day', metrics: metrics.join(','),
    }, {signal}), signal);
    return parseReport(body, {from, to, requested: metrics});
  }

  /* Суточный отчёт за диапазон закрытых дат. Разбирается по columnHeaders: порядок колонок
     задаёт источник, а не наш код. Дни, которых в ответе нет, не появляются нулями. */
  async function dailyReport(code, {from, to} = {}, {signal} = {}) {
    if (!calendarDate(from) || !calendarDate(to) || from > to)
      fail('BAD_PERIOD', 'Неверный период запроса измерений.', 400);
    const run = runScope(signal);
    try {
      const {token} = await untilAborted(() => access.accessToken(code, {signal: run.signal}), run.signal);
      const state = access.ready(code);
      if (!state.ok) fail('CHANNEL_UNCONFIRMED', `Канал не подтверждён: ${state.reason}`, 409);
      return await query(token, state.channelId, from, to, DAILY_METRICS, run.signal);
    } catch (error) { throw safeError(error); } finally { run.done(); }
  }

  /* Текущий размер аудитории. Датируется днём НАБЛЮДЕНИЯ в системе суток отчётов, а не
     целевой датой сбора: иначе вчерашняя история переписывалась бы сегодняшним числом. */
  async function currentAudience(code, {signal} = {}) {
    const run = runScope(signal);
    try {
      const channel = await untilAborted(() => access.channelOfAccess(code, {signal: run.signal}), run.signal);
      return {...channel, observedDay: reportDay(now())};
    } catch (error) { throw safeError(error); } finally { run.done(); }
  }

  /* Нормализация в строки снимков движка статистики. Здесь не появляется ни одного значения,
     которого не было в ответе: неизвестное остаётся неизвестным и просто отсутствует. */
  function normalizeDay({date, values}, {closed}) {
    const snapshots = [];
    const completeness = closed ? 'complete' : 'partial';
    for (const [name, rule] of Object.entries(METRIC_MAP)) {
      const raw = values[name];
      if (raw === null || raw === undefined) continue;
      snapshots.push({date, period: 'day', metric: rule.metric,
        value: rule.transform ? rule.transform(raw) : raw,
        sourceField: `reports.query.${rule.field}`, scope: 'profile', completeness});
    }
    const gained = values[FOLLOWER_CHANGE.gained], lost = values[FOLLOWER_CHANGE.lost];
    if (gained !== null && gained !== undefined && lost !== null && lost !== undefined) {
      snapshots.push({date, period: 'day', metric: 'follower_change', value: gained - lost,
        sourceField: 'reports.query.subscribersGained-subscribersLost', scope: 'profile', completeness});
    }
    return snapshots;
  }

  const bindingChanged = () => ({status: 'missing_access', hard: true,
    missing: ['привязка канала изменилась во время измерения: значения не записаны, требуется повторное подтверждение']});

  /* Один сбор за одну дату по контракту адаптера. Возвращает статус, строки снимков,
     честный список пробелов (missing) и отдельно оговорки методики (caveats). Все сетевые
     шаги идут под одним общим сроком и отменой (signal / stop). */
  async function collectDate(code, {date, closed = true, accountRef = '', signal} = {}) {
    if (!calendarDate(date)) fail('BAD_PERIOD', 'Неверная дата сбора измерений.', 400);
    if (stopController.signal.aborted) throw stopError();
    const state = access.ready(code);
    if (!state.ok) return {status: 'missing_access', missing: [`измерения YouTube не собираются: ${state.reason}`]};
    /* Актуальная запись аккаунта против ПОДТВЕРЖДЁННОЙ. Пустая подтверждённая запись не
       подтверждает «любой канал mine»; смена записи после подтверждения останавливает сбор
       ДО запроса, чтобы зря не ходить в сеть. */
    const confirmed = refKey(state.accountRef);
    const wanted = refKey(accountRef);
    if (!confirmed) return {status: 'missing_access', hard: true,
      missing: ['подтверждение не связано с точной записью канала (UC…, ссылка канала или @ручка): подтвердите доступ заново']};
    if (wanted !== confirmed) return {status: 'missing_access', hard: true,
      missing: [`аккаунт аналитики называет канал «${wanted || 'не указан'}», а подтверждён «${confirmed}»: подтвердите доступ заново, иначе числа записались бы не тому каналу`]};
    const today = reportDay(now());
    if (date > today) return {status: 'missing_access', missing: ['запрошены сутки, которые в системе суток YouTube ещё не начались']};
    // Сутки закрыты только если они раньше сегодняшних по Pacific, что бы ни сказал вызывающий.
    const closedDay = closed === true && date < today;

    const run = runScope(signal);
    let main, engaged = null, engagedFailure = '', audience;
    try {
      const {revision} = await untilAborted(() => access.accessToken(code, {signal: run.signal}), run.signal);
      if (revision !== state.revision) return bindingChanged();
      const {token} = await untilAborted(() => access.accessToken(code, {signal: run.signal}), run.signal);
      main = await query(token, state.channelId, date, date, DAILY_METRICS, run.signal);
      if (collectEngagedViews) {
        try { engaged = await query(token, state.channelId, date, date, [ENGAGED_METRIC], run.signal); }
        catch (error) {
          const safe = safeError(error);
          if (DECISIVE.has(safe.code) || ['TIMEOUT', 'STOPPED'].includes(safe.code)) throw safe;
          engagedFailure = safe.code;
        }
      }
      audience = await currentAudience(code, {signal: run.signal});
    } catch (error) {
      const safe = safeError(error);
      // Отзыв/отказ снимает подтверждение ТОЙ ревизии, с которой начат сбор; временные причины — нет.
      if (DECISIVE.has(safe.code)) markFailure(code, state.revision, safe.code);
      throw safe;
    } finally { run.done(); }

    /* Привязка не должна была измениться, пока шли запросы: смена доступа, канала или записи
       аккаунта делает уже полученные числа непригодными для записи. */
    const after = access.ready(code);
    if (!after.ok || after.channelId !== state.channelId || refKey(after.accountRef) !== confirmed
      || after.revision !== state.revision
      || (audience.accessRevision !== undefined && audience.accessRevision !== state.revision)) return bindingChanged();
    /* Ответ должен относиться к подтверждённому каналу: доступ мог быть переназначен между
       запросами, и тогда числа принадлежат другому каналу. */
    if (audience.channelId !== state.channelId) {
      markFailure(code, state.revision, 'CHANNEL_MISMATCH');
      return {status: 'missing_access', hard: true,
        missing: ['во время измерения доступ стал показывать другой канал: значения не записаны']};
    }

    const snapshots = [], missing = [], caveats = [];
    const completeness = closedDay ? 'complete' : 'partial';
    const entry = main.days.find((item) => item.date === date) || null;
    const engagedEntry = engaged?.days.find((item) => item.date === date) || null;
    const invalidHere = [...main.invalid, ...(engaged?.invalid || [])].filter((item) => item.date === date);
    const isInvalid = (name) => invalidHere.some((item) => item.metric === name);
    if (entry) snapshots.push(...normalizeDay(entry, {closed: closedDay}));
    const engagedValue = engagedEntry ? engagedEntry.values[ENGAGED_METRIC] : null;
    if (engagedValue !== null && engagedValue !== undefined) {
      snapshots.push({date, period: 'day', metric: ENGAGED_RULE.metric, value: engagedValue,
        sourceField: `reports.query.${ENGAGED_RULE.field}`, scope: 'profile', completeness});
    }

    if (!entry) missing.push(main.emptyReport
      ? `за ${date} отчёт YouTube пуст: это не нулевые сутки, значения остаются неизвестными`
      : `за ${date} строки в отчёте YouTube нет: значения остаются неизвестными`);
    if (!entry && main.requestedTailUnknown) missing.push(`данные за ${date} у YouTube ещё не готовы или не отданы: сбор будет повторён`);
    for (const name of DAILY_METRICS) {
      if (!main.headers.includes(name)) missing.push(`показатель ${name} этот отчёт не вернул`);
      else if (entry && entry.values[name] === null && !isInvalid(name)) missing.push(`показатель ${name} за ${date} источник не дал`);
    }
    for (const item of invalidHere)
      missing.push(`показатель ${item.metric} за ${date} пришёл в недопустимом виде (отрицательный, дробный, нечисловой или переполненный): не записан`);
    if (entry) {
      const gainedKnown = (entry.values[FOLLOWER_CHANGE.gained] ?? null) !== null;
      const lostKnown = (entry.values[FOLLOWER_CHANGE.lost] ?? null) !== null;
      if (gainedKnown !== lostKnown) missing.push('изменение подписчиков не выводится: известен только один из потоков gained/lost');
    }
    if (collectEngagedViews) {
      if (engagedFailure === 'UPSTREAM_ERROR')
        missing.push('показатель engagedViews YouTube для этого отчёта не принял: views записаны отдельно и им не заменяются');
      else if (engagedFailure) missing.push('показатель engagedViews временно не получен: сбор будет повторён');
      else if (!engaged.headers.includes(ENGAGED_METRIC)) missing.push('показатель engagedViews этот отчёт не вернул');
      else if ((engagedValue === null || engagedValue === undefined) && !isInvalid(ENGAGED_METRIC))
        missing.push(`показатель engagedViews за ${date} источник не дал`);
    }
    if (!closedDay) missing.push(`сутки ${date} в системе суток YouTube (${DAY_SYSTEM}) ещё не закрыты: значения предварительные`);

    // Текущее число подписчиков: состояние, а не суточная величина. Движок датирует его днём наблюдения.
    if (audience.subscribers !== null) {
      snapshots.push({period: 'lifetime', metric: 'followers', value: audience.subscribers,
        sourceField: 'channels.list.statistics.subscriberCount', scope: 'profile', completeness: 'complete'});
      caveats.push('число подписчиков округлено YouTube вниз до трёх значащих цифр: это не точное значение');
    } else if (audience.hiddenSubscriberCount) {
      caveats.push(`текущее число подписчиков неизвестно: ${audience.subscribersUnknownReason}`);
    } else {
      missing.push(`текущее число подписчиков неизвестно: ${audience.subscribersUnknownReason || 'источник его не дал'}`);
    }
    const method = viewsMethodology(date);
    if (method.caveat && snapshots.some((row) => row.metric === 'views')) caveats.push(method.caveat);

    /* Полнота считается по СУТОЧНЫМ показателям, а не по наличию строки. Строка со всеми null —
       дата без данных. Текущее число подписчиков сутки не закрывает. Недопустимое значение
       и временно не полученный engagedViews тоже не дают закрыть сутки. */
    const measured = snapshots.filter((row) => row.period === 'day').length;
    const offered = DAILY_METRICS.filter((name) => main.headers.includes(name));
    let expected = offered.filter((name) => name !== FOLLOWER_CHANGE.gained && name !== FOLLOWER_CHANGE.lost).length
      + (offered.includes(FOLLOWER_CHANGE.gained) && offered.includes(FOLLOWER_CHANGE.lost) ? 1 : 0);
    if (collectEngagedViews && engaged?.headers.includes(ENGAGED_METRIC)) expected += 1;
    const engagedBlocking = Boolean(engagedFailure) && engagedFailure !== 'UPSTREAM_ERROR';
    const complete = Boolean(entry) && measured > 0 && measured >= expected && !invalidHere.length && !engagedBlocking;
    if (entry && !measured) missing.push(`строка за ${date} в отчёте есть, но все показатели пусты: данных за эти сутки нет`);
    else if (entry && measured < expected) missing.push(`за ${date} собраны не все суточные показатели (${measured} из ${expected}): пробелы останутся до уточнения источником`);
    const done = closedDay && complete;
    return {
      status: done ? 'ok' : 'partial',
      // Повтор нужен только пока суточные данные неполны; оговорки методики его не требуют.
      retryable: !done,
      snapshots, missing, caveats,
      provenance: {
        nativeAccountId: state.channelId, providerRef: confirmed,
        period: {from: date, to: date}, timezone: DAY_SYSTEM,
        identityConfirmed: true,
        warnings: [...(main.requestedTailUnknown ? ['отчёт YouTube заканчивается раньше запрошенной даты'] : []), ...caveats],
        methodology: {views: method.basis, ...SHORTS_VIEWS_METHOD},
        coverage: expected ? Math.min(measured / expected, 1) : 0,
        blocks: [{chart: 'youtube.reports.query.day', unit: '', summary: null,
          summaryReason: 'итог за период источником не подтверждён',
          points: main.days.map((item) => ({date: item.date, value: item.values.views ?? null,
            ...(item.values.views === null || item.values.views === undefined ? {reason: 'просмотры за эту дату источник не дал'} : {})}))},
        {chart: 'youtube.reports.query.engagedViews.day', unit: '', summary: null,
          summaryReason: engagedFailure ? 'отдельный запрос engagedViews не выполнен' : 'итог за период источником не подтверждён',
          points: (engaged?.days || []).map((item) => ({date: item.date, value: item.values[ENGAGED_METRIC] ?? null}))},
        {chart: 'youtube.channels.list.subscriberCount', unit: 'подписчики',
          summary: audience.subscribers, summaryReason: audience.subscribers === null ? (audience.subscribersUnknownReason || 'источник не дал значение') : '',
          points: [{date: audience.observedDay, value: audience.subscribers,
            ...(audience.subscribers === null ? {reason: audience.subscribersUnknownReason || 'источник не дал значение'} : {})}]}],
      },
    };
  }

  // Остановка процесса: текущие сборы прерываются, новые не начинаются.
  function stop() { if (!stopController.signal.aborted) stopController.abort(stopError()); }

  return {collectDate, dailyReport, currentAudience, reportDay, stop,
    // Готовность без сетевых вызовов — по сохранённому доступу и подтверждению канала.
    ready: (code) => access.ready(code),
    bindingFingerprint: (code) => access.bindingFingerprint(code),
    recentWindow: (days = 3) => { const today = reportDay(now()); return {from: shiftDay(today, -days), to: today}; },
    DAY_SYSTEM, DAILY_METRICS, ENGAGED_METRIC};
}

module.exports = {createSocialYoutubeStats, YOUTUBE_ANALYTICS_REPORTS: ANALYTICS_REPORTS,
  YOUTUBE_DAILY_METRICS: DAILY_METRICS, YOUTUBE_REPORT_DAY_SYSTEM: DAY_SYSTEM,
  YOUTUBE_VIEWS_DEFINITION_CHANGE: VIEWS_DEFINITION_CHANGE,
  YOUTUBE_DATA_API_VIEWCOUNT_CHANGE: DATA_API_VIEWCOUNT_CHANGE, YOUTUBE_ENGAGED_METRIC: ENGAGED_METRIC,
  YOUTUBE_SHORTS_VIEWS_METHOD: SHORTS_VIEWS_METHOD, YOUTUBE_COLLECT_TIMEOUT_MS: COLLECT_TIMEOUT_MS};
