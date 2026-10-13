'use strict';
/* Читающий сбор статистики MAX (specs/094-max-native-analytics, T003). Ничего не публикует,
   не создаёт ботов, подписок и прав; сеть и токен — только внутри модуля доступа MAX.

   Две разные величины, и они не смешиваются:
   - Chat.participants_count — ТЕКУЩИЙ состав канала на момент наблюдения. Датируется днём
     наблюдения в поясе аккаунта, а не целевой датой сбора: вчерашняя история сегодняшним
     числом не переписывается;
   - Message.stat.views — ТЕКУЩИЕ накопленные (lifetime) просмотры конкретного поста. Это не
     просмотры за дату публикации и не дневной ряд. Повторные замеры одного поста не
     складываются: в запуске остаётся последнее наблюдение.

   Чего здесь нет и не появляется: дневной истории MAX (в контракте её нет), охвата, реакций,
   репостов (MessageStat в OpenAPI 0.0.33 определяет только views), текста, отправителя,
   вложений, адресов и user ID. Отсутствующий stat/views — неизвестность (null), не ноль.

   Перечень постов за сутки идёт по before/after/count из официальной OpenAPI, но живая
   семантика этих параметров (включительность границ, пагинация) не подтверждена. Поэтому
   даже аккуратно пройденный перечень — bounded_period, а не полная история, и статус
   сбора не поднимается выше partial. Неразрешимая граница, пределы и срок оставляют
   перечень partial и ничего не выдают за ноль. */

const VIEWS_FIELD = 'MAX.Message.stat.views';
const FOLLOWERS_FIELD = 'MAX.Chat.participants_count';
// count GET /messages по OpenAPI 0.0.33: 1..100. Полная страница — ровно PAGE_SIZE сообщений.
const PAGE_SIZE = 100;
const ID_BATCH = 100;
const HOUR = 3600000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
/* Время MAX — документированные миллисекунды UTC. Не угадываем единицу по величине числа. */
const MIN_NATIVE_TIMESTAMP_MS = 0; // Документированное UTC ms, без эвристики «это секунды».
const MID = /^(?:mid\.)?[A-Za-z0-9_-]{1,200}$/;
const CHAT_ID = /^-?(?:0|[1-9]\d{0,18})$/;
const COMPANY = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const TIMEZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const INPUT_KEYS = Object.freeze(['companyCode', 'date', 'timezone', 'signal']);
const KNOWN_KEYS = Object.freeze(['platformPostId', 'publishedAt']);
const INT64_MIN = -(2n ** 63n), INT64_MAX = 2n ** 63n - 1n;
const LIMITS = Object.freeze({maxPages: 1000, maxPosts: 100000, deadlineMs: 10 * 60 * 1000});
const LIST_LIMIT = 20;

// Наружу — только фиксированные коды и русские тексты, без ответа площадки и исключений доступа.
const PUBLIC = Object.freeze({
  BAD_REQUEST: ['Неверные параметры сбора MAX.', 400],
  BAD_PERIOD: ['Неверная или ещё не наступившая дата сбора MAX.', 400],
  STOPPED: ['Сбор MAX остановлен.', 503],
  ABORTED: ['Сбор MAX отменён вызывающей стороной.', 503],
  TIMEOUT: ['Сбор MAX не уложился в общий срок и не получил ни одного наблюдения.', 504],
  UPSTREAM_ERROR: ['Сбор MAX не получил ни одного достоверного наблюдения.', 502],
});
const failure = (code) => Object.assign(new Error(PUBLIC[code][0]), {code, status: PUBLIC[code][1]});
const ABORT = Symbol('maxStatsAbort');
// Отказ привязки или области ответа: наружу уходит только как missing_access без чисел.
const refusal = (reason) => Object.assign(new Error(reason), {code: 'REFUSED', refusal: reason});

const REFUSAL = Object.freeze({
  binding: 'привязка канала MAX изменилась во время сбора: значения не записаны, требуется повторное подтверждение',
  scope: 'ответ MAX относится не к подтверждённой компании, каналу или ревизии доступа: значения не записаны',
  foreign: 'MAX вернул сообщение не из подтверждённого канала: значения не записаны',
  inactive: 'подтверждённый чат MAX больше не является активным каналом: значения не записаны',
  state: 'состояние доступа MAX не прочитано: сбор не начат',
  chat: 'привязанный канал MAX не задан точным int64-идентификатором: подтвердите доступ заново',
  revision: 'ревизия доступа MAX не распознана: подтвердите доступ заново',
  fingerprint: 'отпечаток привязки MAX недоступен: подтвердите доступ заново',
  notReady: 'доступ и канал MAX ещё не подтверждены',
});
const NOTE = Object.freeze({
  history: 'MAX не даёт дневной истории: просмотры постов — текущие накопленные значения на момент снятия, а не просмотры за дату публикации',
  semantics: 'семантика before/after в GET /messages живой проверкой не подтверждена: перечень постов за сутки не считается полной историей',
  metrics: 'охват, реакции и репосты схема MessageStat не определяет: они не собираются и нулями не считаются',
  followersTemporary: 'текущее число участников канала MAX временно не получено: сбор будет повторён',
  followersDeadline: 'текущее число участников канала MAX не получено до общего срока сбора',
  followersInvalid: 'ответ MAX о канале не распознан: число участников неизвестно, а не нулевое',
  emptyWindow: 'в границах суток постов не найдено: при неподтверждённой семантике перечня это не подтверждённый ноль',
  knownAbsent: 'обновление ранее сохранённых постов не подключено: обновлены только посты, найденные в границах суток',
  knownUnreadable: 'список ранее сохранённых постов не прочитан: они не обновлялись',
  knownAsync: 'список ранее сохранённых постов должен выдаваться синхронно: они не обновлялись',
  knownDeadline: 'ранее сохранённые посты не обновлены до общего срока сбора',
  knownTemporary: 'часть ранее сохранённых постов временно не обновлена: сбор будет повторён',
  knownInvalid: 'ответ MAX по известным постам не распознан: эта часть не обновлена',
  knownForeign: 'MAX вернул по известным постам ID, которых не запрашивали: эта часть ответа отклонена',
});
const INDEX_STOP = Object.freeze({
  maxPages: 'перечень постов остановлен на пределе страниц: часть постов суток могла остаться непрочитанной',
  maxPosts: 'перечень постов остановлен на пределе числа постов: остальные посты не прочитаны',
  boundary: 'на границе страницы слишком много постов с одним временем: граница не разрешена, перечень неполный',
  noProgress: 'постраничный перечень не продвинулся: тот же запрос повторно не выполнялся, перечень неполный',
  temporal: 'MAX вернул посты вне запрошенного интервала before/after: граница суток не подтверждена, перечень неполный',
  order: 'MAX вернул страницу не в обратном порядке времени: продолжение перечня недостоверно',
  units: 'время постов MAX похоже на секунды, а не миллисекунды: границы суток не подтверждены',
  invalid: 'страница постов MAX не распознана: перечень неполный, сбор будет повторён',
  temporary: 'страница постов MAX временно недоступна: перечень неполный, сбор будет повторён',
  deadline: 'сбор MAX не уложился в общий срок: перечень постов неполный, сбор будет повторён',
});
// Причины, которые могут пройти сами: только они оставляют дату в очереди повторов.
const TEMPORARY_STOPS = new Set(['invalid', 'temporary', 'deadline']);

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
// Native ID канала — каноническая десятичная строка signed int64; Number здесь запрещён.
function canonicalChatId(value) {
  if (typeof value !== 'string' || !CHAT_ID.test(value) || value === '-0') return null;
  const big = BigInt(value);
  return big >= INT64_MIN && big <= INT64_MAX ? value : null;
}
const validRevision = (value) => (Number.isSafeInteger(value) && value >= 0)
  || (typeof value === 'string' && value.length > 0 && value.length <= 200);
const iso = (ms) => new Date(ms).toISOString();
const calendarDate = (value) => typeof value === 'string' && DATE.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && iso(Date.parse(`${value}T00:00:00Z`)).slice(0, 10) === value;
const shiftDay = (date, days) => iso(Date.parse(`${date}T00:00:00Z`) + days * 86400000).slice(0, 10);

const formatters = new Map();
function localDay(ms, tz) {
  let format = formatters.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'});
    if (formatters.size < 64) formatters.set(tz, format);
  }
  const parts = format.formatToParts(new Date(ms));
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year').padStart(4, '0')}-${get('month')}-${get('day')}`;
}
function validTimezone(value) {
  if (typeof value !== 'string' || value.length > 64 || !TIMEZONE.test(value)) return false;
  try { return Boolean(new Intl.DateTimeFormat('en-US', {timeZone: value}).resolvedOptions().timeZone); }
  catch { return false; }
}
/* Первый момент UTC, когда в поясе tz уже наступила дата date. Двоичный поиск по миллисекундам
   учитывает переход на летнее время, в том числе пропущенную полночь: тогда сутки начинаются
   с первого существующего местного времени этой даты. */
function firstInstant(date, tz) {
  const base = Date.parse(`${date}T00:00:00Z`);
  let lo = base - 18 * HOUR, hi = base + 18 * HOUR;
  if (localDay(lo, tz) >= date || localDay(hi, tz) < date) throw failure('BAD_PERIOD');
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (localDay(mid, tz) >= date) hi = mid; else lo = mid;
  }
  return hi;
}
// Полуоткрытые границы локальных суток [startMs, endMs) в UTC.
function dayBounds(date, tz) {
  const startMs = firstInstant(date, tz), endMs = firstInstant(shiftDay(date, 1), tz);
  if (!(endMs > startMs) || startMs < MIN_NATIVE_TIMESTAMP_MS) throw failure('BAD_PERIOD');
  return {startMs, endMs};
}

function readInput(input) {
  if (!isPlain(input) || Object.keys(input).some((key) => !INPUT_KEYS.includes(key))) throw failure('BAD_REQUEST');
  const {companyCode, date, timezone, signal} = input;
  if (typeof companyCode !== 'string' || !COMPANY.test(companyCode)) throw failure('BAD_REQUEST');
  if (!validTimezone(timezone)) throw failure('BAD_REQUEST');
  if (!calendarDate(date)) throw failure('BAD_PERIOD');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw failure('BAD_REQUEST');
  return {companyCode, date, timezone, signal};
}

function untilAborted(start, signal, reason) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(reason()); return; }
    const onAbort = () => reject(reason());
    signal.addEventListener('abort', onAbort, {once: true});
    let inner;
    try { inner = Promise.resolve(start(signal)); } catch (error) { inner = Promise.reject(error); }
    inner.then((value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

function createSocialMaxStats({access, now = Date.now, maxPages = 30, maxPosts = 2000, deadlineMs = 60000, knownPosts} = {}) {
  for (const name of ['ready', 'bindingFingerprint', 'readChannel', 'readMessages'])
    if (typeof access?.[name] !== 'function') throw new Error('Сбор MAX требует модуля доступа MAX');
  if (typeof now !== 'function') throw new Error('Сбор MAX требует часов now()');
  const within = (value, max) => Number.isSafeInteger(value) && value >= 1 && value <= max;
  if (!within(maxPages, LIMITS.maxPages) || !within(maxPosts, LIMITS.maxPosts) || !within(deadlineMs, LIMITS.deadlineMs))
    throw new Error('Пределы сбора MAX заданы неверно');
  if (knownPosts !== undefined && knownPosts !== null && typeof knownPosts !== 'function')
    throw new Error('knownPosts должен быть синхронной функцией');
  const stopController = new AbortController();
  const active = new Set();
  const clock = () => { const value = now(); if (!Number.isFinite(value)) throw failure('UPSTREAM_ERROR'); return value; };

  // Состояние привязки без сети: до сбора, после ошибки и после всего сбора.
  function binding(code) {
    let state, fingerprint;
    try { state = access.ready(code); fingerprint = access.bindingFingerprint(code); }
    catch { return {ok: false, reason: REFUSAL.state}; }
    if (!isPlain(state) || state.ok !== true) {
      const reason = typeof state?.reason === 'string' && state.reason && state.reason.length <= 200
        && !/[\u0000-\u001f\u007f]/.test(state.reason) ? state.reason : REFUSAL.notReady;
      return {ok: false, reason};
    }
    const chatId = canonicalChatId(state.chatId);
    if (!chatId) return {ok: false, reason: REFUSAL.chat};
    if (!validRevision(state.accessRevision)) return {ok: false, reason: REFUSAL.revision};
    if (typeof fingerprint !== 'string' || !fingerprint) return {ok: false, reason: REFUSAL.fingerprint};
    return {ok: true, chatId, accountRef: typeof state.accountRef === 'string' ? state.accountRef : '',
      accessRevision: state.accessRevision, fingerprint};
  }
  const sameBinding = (a, b) => Boolean(a?.ok && b?.ok) && a.chatId === b.chatId && a.accountRef === b.accountRef
    && a.accessRevision === b.accessRevision && a.fingerprint === b.fingerprint;

  // Один общий срок на весь сбор плюс остановка модуля и сигнал вызывающего.
  function runScope(caller) {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), deadlineMs);
    const sources = [deadline.signal, stopController.signal];
    if (caller) sources.push(caller);
    return {signal: AbortSignal.any(sources), done: () => clearTimeout(timer)};
  }
  const abortFailure = (ctx) => Object.assign(failure(stopController.signal.aborted ? 'STOPPED'
    : ctx.caller?.aborted ? 'ABORTED' : 'TIMEOUT'), {[ABORT]: true});
  const throwIfStopped = (ctx) => {
    if (stopController.signal.aborted) throw failure('STOPPED');
    if (ctx.caller?.aborted) throw failure('ABORTED');
  };

  /* Вызов модуля доступа под общим сроком. Остановка и отмена прерывают весь сбор; истёкший
     срок — нет: уже полученные наблюдения остаются, перечень помечается неполным. Иная
     ошибка — временная, если привязка не изменилась; иначе сбор отказывается целиком. */
  async function guarded(ctx, start) {
    try { return {ok: true, value: await untilAborted(start, ctx.signal, () => abortFailure(ctx))}; }
    catch (error) {
      if (error?.[ABORT] || ctx.signal.aborted) {
        const abort = error?.[ABORT] ? error : abortFailure(ctx);
        if (abort.code !== 'TIMEOUT') throw abort;
        ctx.deadline = true; ctx.temporary = true;
        return {ok: false, deadline: true};
      }
      ctx.errors += 1; ctx.temporary = true;
      if (!sameBinding(ctx.base, binding(ctx.code))) throw refusal(REFUSAL.binding);
      return {ok: false};
    }
  }

  // Конверт ответа доступа: компания, канал и ревизия — те, с которыми начат сбор.
  function envelope(ctx, value) {
    if (!isPlain(value)) return null;
    if (typeof value.companyCode !== 'string' || value.companyCode.toLowerCase() !== ctx.code.toLowerCase()
      || canonicalChatId(value.chatId) !== ctx.base.chatId || value.accessRevision !== ctx.base.accessRevision)
      throw refusal(REFUSAL.scope);
    const observedMs = typeof value.observedAt === 'string' && value.observedAt.endsWith('Z') ? Date.parse(value.observedAt) : NaN;
    if (!Number.isFinite(observedMs) || observedMs < ctx.startedMs - CLOCK_SKEW_MS || observedMs > clock() + CLOCK_SKEW_MS) return null;
    return {observedMs, data: value.data};
  }

  /* Из сообщения берутся только native mid, время и stat.views. Отправитель, текст, вложения,
     адрес и user ID не читаются. Чужой получатель — отказ всего сбора, а не пропуск строки. */
  function parseMessage(ctx, raw) {
    if (!isPlain(raw) || !isPlain(raw.recipient)) return null;
    if (canonicalChatId(raw.recipient.chat_id) !== ctx.base.chatId || raw.recipient.chat_type !== 'channel')
      throw refusal(REFUSAL.foreign);
    if (!isPlain(raw.body)) return null;
    const ts = raw.timestamp, mid = raw.body.mid;
    if (!Number.isSafeInteger(ts) || ts < 0 || typeof mid !== 'string' || !MID.test(mid)) return null;
    let value = null, invalid = false;
    if (raw.stat !== undefined && raw.stat !== null) {
      if (!isPlain(raw.stat)) invalid = true;
      else if (raw.stat.views !== undefined && raw.stat.views !== null) {
        if (Number.isSafeInteger(raw.stat.views) && raw.stat.views >= 0) value = raw.stat.views;
        else invalid = true;
      }
    }
    return {mid, ts, value, invalid};
  }
  function messagesOf(ctx, value, maxCount) {
    const env = envelope(ctx, value);
    if (!env || !isPlain(env.data) || !Array.isArray(env.data.messages) || env.data.messages.length > maxCount) return null;
    const messages = [];
    for (const raw of env.data.messages) {
      const message = parseMessage(ctx, raw);
      if (!message) { if(!ctx.indexStop)ctx.indexStop='invalid'; ctx.missing.add('MAX не дал native ID части постов: индекс неполон'); continue; }
      messages.push(message);
    }
    return {observedMs: env.observedMs, messages};
  }

  // Один и тот же ID с другим временем публикации — не тот же пост: такой пост отклоняется.
  function conflict(ctx, mid) { ctx.conflicts.add(mid); ctx.posts.delete(mid); }
  /* Повтор того же поста (граница страниц, проба, известный ID) не складывается: остаётся
     последнее наблюдение одного lifetime-значения. */
  function remember(ctx, message, observedMs) {
    if (ctx.conflicts.has(message.mid)) return;
    const known = ctx.posts.get(message.mid);
    if (known && known.ts !== message.ts) { conflict(ctx, message.mid); return; }
    if (!known && ctx.posts.size >= maxPosts) { ctx.overflow = true; return; }
    if (!known || observedMs >= known.observedMs)
      ctx.posts.set(message.mid, {ts: message.ts, value: message.value, invalid: message.invalid, observedMs});
  }
  function stopIndex(ctx, reason) {
    if (!ctx.indexStop) ctx.indexStop = reason;
    if (TEMPORARY_STOPS.has(reason)) ctx.temporary = true;
  }

  async function readPage(ctx, query) {
    const key = `${query.after}|${query.before}|${query.count}`;
    // Тот же запрос вслепую не повторяется: он дал бы ту же страницу.
    if (ctx.asked.has(key)) { stopIndex(ctx, 'noProgress'); return null; }
    ctx.asked.add(key); ctx.pages += 1;
    const answer = await guarded(ctx, (signal) => access.readMessages(ctx.code, {...query}, {signal}));
    if (!answer.ok) { stopIndex(ctx, answer.deadline ? 'deadline' : 'temporary'); return null; }
    const list = messagesOf(ctx, answer.value, query.count);
    if (!list) { stopIndex(ctx, 'invalid'); return null; }
    const {observedMs, messages} = list;
    if (messages.some((message) => message.ts < MIN_NATIVE_TIMESTAMP_MS)) { stopIndex(ctx, 'units'); return null; }
    // Точное окно суток фильтруется здесь, какой бы ни оказалась включительность before/after.
    for (const message of messages)
      if (message.ts >= ctx.bounds.startMs && message.ts < ctx.bounds.endMs) remember(ctx, message, observedMs);
    if (ctx.overflow) { stopIndex(ctx, 'maxPosts'); return null; }
    if (messages.some((message) => message.ts < query.after || message.ts > query.before)) { stopIndex(ctx, 'temporal'); return null; }
    for (let index = 1; index < messages.length; index += 1)
      if (messages[index].ts > messages[index - 1].ts) { stopIndex(ctx, 'order'); return null; }
    return messages;
  }

  /* Перечень постов суток: страницы от конца суток к началу (обратный порядок MAX). Полная
     страница кончается временем T, и посты с тем же T могли разойтись по страницам. Поэтому
     граница проверяется отдельной ограниченной пробой [T-1, T+1]: если и она полная, граница
     не разрешена и перечень остаётся partial. Курсор обязан строго уменьшаться. */
  async function enumerate(ctx) {
    const {startMs, endMs} = ctx.bounds;
    const after = Math.max(0,startMs - 1);
    let before = endMs;
    for (;;) {
      if (ctx.pages >= maxPages) { stopIndex(ctx, 'maxPages'); return; }
      const page = await readPage(ctx, {after, before, count: PAGE_SIZE});
      if (!page) return;
      if (page.length < PAGE_SIZE) { ctx.indexComplete = true; return; }
      const oldest = page[page.length - 1].ts;
      if (oldest < startMs) { ctx.indexComplete = true; return; }
      if (ctx.pages >= maxPages) { stopIndex(ctx, 'maxPages'); return; }
      const probe = await readPage(ctx, {after: oldest - 1, before: oldest + 1, count: PAGE_SIZE});
      if (!probe) return;
      if (probe.length >= PAGE_SIZE) { stopIndex(ctx, 'boundary'); return; }
      if (oldest >= before) { stopIndex(ctx, 'noProgress'); return; }
      before = oldest;
    }
  }

  async function readFollowers(ctx) {
    const answer = await guarded(ctx, (signal) => access.readChannel(ctx.code, {signal}));
    if (!answer.ok) { ctx.missing.add(answer.deadline ? NOTE.followersDeadline : NOTE.followersTemporary); return; }
    const env = envelope(ctx, answer.value);
    const data = env && isPlain(env.data) ? env.data : null;
    if (!data) { ctx.temporary = true; ctx.missing.add(NOTE.followersInvalid); return; }
    if (canonicalChatId(data.chat_id) !== ctx.base.chatId) throw refusal(REFUSAL.scope);
    if (data.type !== 'channel' || data.status !== 'active') throw refusal(REFUSAL.inactive);
    const count = data.participants_count;
    if (!Number.isSafeInteger(count) || count < 0) { ctx.temporary = true; ctx.missing.add(NOTE.followersInvalid); return; }
    // Дата — день НАБЛЮДЕНИЯ в поясе аккаунта, не целевая дата сбора.
    ctx.snapshots.push({date: localDay(env.observedMs, ctx.tz), period: 'lifetime', metric: 'followers', value: count,
      sourceField: FOLLOWERS_FIELD, scope: 'profile', kind: 'organic', completeness: 'complete'});
  }

  async function readKnownBatch(ctx, batch, lost) {
    const ids = batch.map((item) => item.id);
    const answer = await guarded(ctx, (signal) => access.readMessages(ctx.code, {messageIds: [...ids]}, {signal}));
    if (!answer.ok) { ctx.missing.add(answer.deadline ? NOTE.knownDeadline : NOTE.knownTemporary); return false; }
    const list = messagesOf(ctx, answer.value, ids.length);
    if (!list) { ctx.temporary = true; ctx.missing.add(NOTE.knownInvalid); return false; }
    const expected = new Map(batch.map((item) => [item.id, item.ts]));
    if (list.messages.some((message) => !expected.has(message.mid))) { ctx.missing.add(NOTE.knownForeign); return false; }
    const returned = new Map();
    for (const message of list.messages) {
      const previous = returned.get(message.mid);
      if (previous && previous.ts !== message.ts) conflict(ctx, message.mid);
      returned.set(message.mid, message);
    }
    let complete = true;
    for (const [id, ts] of expected) {
      const message = returned.get(id);
      if (!message) { lost.push(id); complete = false; continue; }
      if (ctx.conflicts.has(id) || message.ts !== ts) { conflict(ctx, id); complete = false; continue; }
      remember(ctx, message, list.observedMs);
    }
    return complete;
  }

  /* Отдельное обновление уже сохранённых постов по точным native ID. Оно не расширяет перечень
     суток: полный индекс из одних известных ID не выводится. Не возвращённый ID — явный
     пробел (удалён или недоступен), а не ноль. */
  async function refreshKnown(ctx) {
    if (!knownPosts) { ctx.missing.add(NOTE.knownAbsent); return false; }
    if (ctx.deadline) { ctx.missing.add(NOTE.knownDeadline); return false; }
    let list;
    try { list = knownPosts(ctx.code); } catch { ctx.missing.add(NOTE.knownUnreadable); return false; }
    if (list && typeof list.then === 'function') {
      Promise.resolve(list).catch(() => {});
      ctx.missing.add(NOTE.knownAsync); return false;
    }
    if (!Array.isArray(list)) { ctx.missing.add(NOTE.knownUnreadable); return false; }
    let complete = true, invalid = 0;
    const wanted = new Map();
    for (const item of list) {
      const ts = isPlain(item) && typeof item.publishedAt === 'string' && ISO_TIME.test(item.publishedAt) ? Date.parse(item.publishedAt) : NaN;
      if (!isPlain(item) || Object.keys(item).some((key) => !KNOWN_KEYS.includes(key)) || typeof item.platformPostId !== 'string'
        || !MID.test(item.platformPostId) || !Number.isSafeInteger(ts) || ts < MIN_NATIVE_TIMESTAMP_MS || ts > ctx.startedMs + CLOCK_SKEW_MS) {
        invalid += 1; continue;
      }
      if (wanted.has(item.platformPostId) && wanted.get(item.platformPostId) !== ts) { conflict(ctx, item.platformPostId); continue; }
      wanted.set(item.platformPostId, ts);
    }
    if (invalid) { complete = false; ctx.missing.add(`${invalid} записей списка известных постов не распознаны: они не обновлялись`); }
    const pending = [];
    for (const [id, ts] of wanted) {
      if (ctx.conflicts.has(id)) { complete = false; continue; }
      const seen = ctx.posts.get(id);
      // Уже наблюдённый в этом запуске пост повторно не запрашивается, но время публикации сверяется.
      if (seen) { if (seen.ts !== ts) { conflict(ctx, id); complete = false; } continue; }
      pending.push({id, ts});
    }
    pending.sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const room = Math.max(0, maxPosts - ctx.posts.size);
    if (pending.length > room) {
      complete = false;
      ctx.missing.add(`${pending.length - room} ранее сохранённых постов не обновлены: достигнут предел числа постов`);
      pending.length = room;
    }
    const lost = [];
    for (let index = 0; index < pending.length; index += ID_BATCH) {
      if (ctx.deadline) { complete = false; ctx.missing.add(NOTE.knownDeadline); break; }
      if (!(await readKnownBatch(ctx, pending.slice(index, index + ID_BATCH), lost))) complete = false;
    }
    if (lost.length) {
      const shown = lost.slice(0, LIST_LIMIT).join(', ');
      ctx.missing.add(`ранее сохранённые посты не возвращены MAX (удалены или недоступны), просмотры неизвестны: ${shown}${lost.length > LIST_LIMIT ? ` и ещё ${lost.length - LIST_LIMIT}` : ''}`);
    }
    return complete;
  }

  const refused = (coverage, base, reason) => ({status: 'missing_access', snapshots: [], posts: [], missing: [reason],
    retryable: false, coverage: {...coverage, postIndex: 'partial', knownPostRefresh: 'partial'},
    accessRevision: base?.accessRevision ?? null, bindingFingerprint: base?.fingerprint ?? null});

  async function collect(input) {
    if (stopController.signal.aborted) throw failure('STOPPED');
    const {companyCode, date, timezone, signal} = readInput(input);
    const startedMs = clock();
    if (date > localDay(startedMs, timezone)) throw failure('BAD_PERIOD');
    const bounds = dayBounds(date, timezone);
    const coverage = {postIndex: 'partial', from: date, to: date, dayStartUtc: iso(bounds.startMs), dayEndUtc: iso(bounds.endMs),
      historyDaily: 'unavailable', knownPostRefresh: 'partial'};
    const base = binding(companyCode);
    if (!base.ok) return refused(coverage, null, base.reason);
    if (signal?.aborted) throw failure('ABORTED');
    const scope = runScope(signal);
    const ctx = {code: companyCode, tz: timezone, bounds, base, startedMs, signal: scope.signal, caller: signal,
      snapshots: [], posts: new Map(), conflicts: new Set(), missing: new Set(), asked: new Set(), pages: 0,
      errors: 0, temporary: false, deadline: false, overflow: false, indexStop: '', indexComplete: false};
    let knownComplete = false;
    try {
      await readFollowers(ctx);
      await enumerate(ctx);
      knownComplete = await refreshKnown(ctx);
    } catch (error) {
      if (error?.code === 'REFUSED') { throwIfStopped(ctx); return refused(coverage, base, error.refusal); }
      if (error?.[ABORT]) throw failure(error.code);
      throw failure('UPSTREAM_ERROR');
    } finally { scope.done(); }

    // Поздний результат после остановки, отмены или смены привязки не выдаётся.
    throwIfStopped(ctx);
    if (!sameBinding(base, binding(companyCode))) return refused(coverage, base, REFUSAL.binding);
    if (!ctx.snapshots.length && !ctx.posts.size) {
      if (ctx.deadline) throw failure('TIMEOUT');
      if (ctx.errors) throw failure('UPSTREAM_ERROR');
    }

    const indexBounded = ctx.indexComplete && !ctx.indexStop && !ctx.conflicts.size;
    const entries = [...ctx.posts.entries()].sort(([a, x], [b, y]) => y.ts - x.ts || (a < b ? -1 : a > b ? 1 : 0));
    const posts = entries.map(([mid, post]) => ({platformPostId: mid, publishedAt: iso(post.ts), kind: 'organic',
      metrics: [{date: localDay(post.observedMs, ctx.tz), period: 'lifetime', metric: 'views', value: post.value,
        sourceField: VIEWS_FIELD, completeness: post.value === null ? 'partial' : 'complete'}]}));

    const missing = [];
    if (ctx.indexStop) missing.push(INDEX_STOP[ctx.indexStop]);
    missing.push(...ctx.missing);
    if (ctx.conflicts.size) {
      const ids = [...ctx.conflicts];
      missing.push(`MAX вернул разное время публикации для одного ID, такие посты отклонены: ${ids.slice(0, LIST_LIMIT).join(', ')}${ids.length > LIST_LIMIT ? ` и ещё ${ids.length - LIST_LIMIT}` : ''}`);
    }
    const unknownViews = entries.filter(([, post]) => post.value === null && !post.invalid).length;
    const invalidViews = entries.filter(([, post]) => post.invalid).length;
    if (unknownViews) missing.push(`у ${unknownViews} постов MAX не вернул stat.views: просмотры неизвестны, а не нулевые`);
    if (invalidViews) missing.push(`у ${invalidViews} постов stat.views пришёл в недопустимом виде: просмотры не записаны`);
    if (indexBounded && !entries.some(([, post]) => post.ts >= bounds.startMs && post.ts < bounds.endMs)) missing.push(NOTE.emptyWindow);
    missing.push(NOTE.history, NOTE.semantics, NOTE.metrics);

    return {
      // Статус не выше partial: живая семантика перечня не подтверждена, дневной истории нет.
      status: 'partial', snapshots: ctx.snapshots, posts, missing,
      // Повтор нужен только при временных причинах; ограничения источника повтором не лечатся.
      retryable: ctx.temporary,
      coverage: {...coverage, postIndex: indexBounded ? 'bounded_period' : 'partial',
        knownPostRefresh: knownComplete && !ctx.conflicts.size ? 'complete' : 'partial'},
      accessRevision: base.accessRevision, bindingFingerprint: base.fingerprint,
    };
  }

  function collectDate(input) {
    const pending = collect(input);
    active.add(pending);
    const forget = () => { active.delete(pending); };
    pending.then(forget, forget);
    return pending;
  }
  // Остановка: текущие сборы прерываются и не выдают поздний результат, новые не начинаются.
  function stop() {
    if (!stopController.signal.aborted) stopController.abort();
    return Promise.allSettled([...active]).then(() => undefined);
  }

  return {collectDate, stop,
    ready: (code) => access.ready(code),
    bindingFingerprint: (code) => access.bindingFingerprint(code)};
}

module.exports = {createSocialMaxStats};
