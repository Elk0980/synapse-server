'use strict';
/* Возобновляемый обход всей истории native постов канала MAX (specs/094-max-native-analytics,
   T009, FR005/FR008). Только метаданные: native ID поста, время публикации и текущие накопленные
   просмотры, датированные днём НАБЛЮДЕНИЯ в поясе аккаунта. Отправитель, текст, ссылки, вложения
   и user ID не читаются и не выходят из модуля.

   Обход идёт назад от снимка верхней границы прохода (upper) страницами GET /messages
   {after:0,before:cursor,count:100}. Каждый плановый сбор делает один ограниченный шаг
   (maxPages, deadlineMs, сигнал, stop). collectStep базу НЕ пишет: он возвращает посты и
   непрозрачный prepared. Root в своей транзакции записывает посты в индекс и вызывает commit():
   CAS по ревизии состояния и сверка привязки отклоняют поздний, повторный и чужой шаг, а курсор
   двигается только вместе с принятыми постами.

   Включительность before/after официально не подтверждена. Поэтому полная страница с самым
   старым временем T проверяется пробой {after:T-1,before:T+1}; ≥100 постов в пробе — неразрешённая
   граница: пробел сохраняется, обход продолжается к более старой истории. Охват всегда partial,
   а конец истории — лишь наблюдённая короткая страница, не complete. Пробелы только добавляются. */

const {createHash} = require('node:crypto');

const PAGE_SIZE = 100;
// Предел Date: время вне него не является допустимым UTC.
const MAX_TIMESTAMP_MS = 8640000000000000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const LIMITS = Object.freeze({maxPages: 100, deadlineMs: 10 * 60 * 1000});
const LIST_LIMIT = 50;
const VIEWS_FIELD = 'MAX.Message.stat.views';
const MID = /^(?:mid\.)?[A-Za-z0-9_-]{1,200}$/;
const CHAT_ID = /^-?(?:0|[1-9]\d{0,18})$/;
const COMPANY = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const TIMEZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,3}$/;
const OBSERVED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const INPUT_KEYS = Object.freeze(['companyCode', 'timezone', 'signal']);
const PHASES = Object.freeze(['listing', 'probe', 'done']);
const INT64_MIN = -(2n ** 63n), INT64_MAX = 2n ** 63n - 1n;
// Отказы доступа и области: шаг отклоняется целиком, без чисел.
const REFUSING = new Set(['ACCESS_DENIED', 'CREDENTIAL_UNREADABLE', 'CHANNEL_REF_REQUIRED', 'CHANNEL_REF_INVALID',
  'CHANNEL_NOT_FOUND', 'NOT_A_CHANNEL', 'CHANNEL_INACTIVE', 'NOT_A_BOT', 'MEMBERSHIP_MISMATCH', 'NOT_ADMIN',
  'CHANNEL_TAKEN', 'MISSING_ACCESS', 'BINDING_UNCONFIRMED', 'REVISION_CONFLICT', 'RESPONSE_SCOPE_MISMATCH']);

const failure = (code, message, status) => Object.assign(new Error(message), {code, status});
const PUBLIC = Object.freeze({
  BAD_REQUEST: ['Неверные параметры шага обхода истории MAX.', 400],
  STOPPED: ['Обход истории MAX остановлен.', 503],
  ABORTED: ['Обход истории MAX отменён вызывающей стороной.', 503],
  UPSTREAM_ERROR: ['Шаг обхода истории MAX завершился ошибкой.', 502],
  MAX_BACKFILL_TOKEN: ['Шаг обхода истории MAX выдан не этим модулем: он не принят.', 409],
  MAX_BACKFILL_TRANSACTION: ['Шаг обхода истории MAX принимается только внутри транзакции с индексом.', 409],
  MAX_BACKFILL_STALE: ['Шаг обхода истории MAX устарел: состояние или привязка изменились, курсор не сдвинут.', 409],
  MAX_BACKFILL_INDEX: ['Посты шага обхода MAX не записаны в индекс этой же транзакцией: шаг не принят.', 409],
  MAX_BACKFILL_CONTEXT: ['Неверные параметры принятия шага обхода истории MAX.', 400],
});
const publicFailure = (code) => failure(code, PUBLIC[code][0], PUBLIC[code][1]);
const ABORT = Symbol('maxBackfillAbort');
const refusal = (reason) => Object.assign(new Error(reason), {code: 'REFUSED', refusal: reason});

const REFUSAL = Object.freeze({
  binding: 'привязка канала MAX изменилась во время шага обхода: значения не записаны',
  scope: 'ответ MAX относится не к подтверждённой компании, каналу или ревизии доступа: шаг не принят',
  foreign: 'MAX вернул сообщение не из подтверждённого канала: шаг обхода отклонён целиком',
  denied: 'доступ MAX отклонён или не подтверждён во время шага обхода: значения не записаны',
  state: 'состояние доступа MAX не прочитано: обход не начат',
  chat: 'привязанный канал MAX не задан точным int64-идентификатором: подтвердите доступ заново',
  revision: 'ревизия доступа MAX не распознана: подтвердите доступ заново',
  fingerprint: 'отпечаток привязки MAX недоступен: подтвердите доступ заново',
  notReady: 'доступ и канал MAX ещё не подтверждены',
});
const STOP = Object.freeze({
  maxPages: 'шаг обхода истории MAX остановлен на пределе страниц: продолжение — со следующим плановым сбором',
  deadline: 'шаг обхода истории MAX не уложился в срок: принятые страницы сохраняются, остальное — следующим сбором',
  temporary: 'страница истории MAX временно недоступна: курсор не сдвинут дальше последней принятой страницы',
  invalid: 'страница истории MAX не распознана: она не принята, курсор не сдвинут дальше',
  observed: 'время наблюдения в ответе MAX вне допустимых границ (будущее или устаревшее): страница не принята',
  temporal: 'MAX вернул посты вне запрошенного интервала before/after: страница не принята, курсор не сдвинут',
  order: 'MAX вернул страницу истории не в обратном порядке времени: страница не принята, курсор не сдвинут',
});
const TEMPORARY = new Set(['deadline', 'temporary', 'invalid', 'observed']);
const NOTE = Object.freeze({
  semantics: 'включительность before/after в GET /messages официально не подтверждена: обход истории MAX остаётся partial даже после короткой последней страницы',
  epochZero: 'посты со временем ровно 0 мс могли быть исключены запросом after:0: начало истории не подтверждено',
  history: 'просмотры постов MAX — текущие накопленные значения на день снятия, а не просмотры за дату публикации',
  metrics: 'охват, реакции и репосты схема MessageStat не определяет: они не собираются и нулями не считаются',
  done: 'обход истории MAX для текущей привязки уже дошёл до наблюдённого конца: новых шагов нет',
  corrupt: 'сохранённое состояние обхода истории MAX не распознано: шаг не выполнен',
  dense: 'на одной отметке времени не меньше 100 постов: граница не разрешена, пробел сохранён, обход продолжен к более старой истории',
  inconsistent: 'проба границы страницы противоречит странице: пробел сохранён, обход продолжен к более старой истории',
  epoch: 'обход дошёл до времени 0 мс: посты ровно на этой отметке не подтверждены, пробел сохранён',
  unidentified: 'MAX вернул сообщения без native ID (body:null): они не индексируются, пробел сохранён',
  conflict: 'MAX вернул разное время публикации для одного native ID: такие посты отклонены, пробел сохранён',
});

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function canonicalChatId(value) {
  if (typeof value !== 'string' || !CHAT_ID.test(value) || value === '-0') return null;
  const big = BigInt(value);
  return big >= INT64_MIN && big <= INT64_MAX ? value : null;
}
const validRevision = (value) => (Number.isSafeInteger(value) && value >= 0)
  || (typeof value === 'string' && value.length > 0 && value.length <= 200);
const validTs = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP_MS;
const iso = (ms) => new Date(ms).toISOString();

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
function readInput(input) {
  if (!isPlain(input) || Object.keys(input).some((key) => !INPUT_KEYS.includes(key))) throw publicFailure('BAD_REQUEST');
  const {companyCode, timezone, signal} = input;
  if (typeof companyCode !== 'string' || !COMPANY.test(companyCode) || !validTimezone(timezone)) throw publicFailure('BAD_REQUEST');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw publicFailure('BAD_REQUEST');
  return {code: companyCode.toLowerCase(), timezone, signal};
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

function createSocialMaxBackfill(db, {access, now = Date.now, maxPages = 3, deadlineMs = 20000} = {}) {
  if (typeof db?.prepare !== 'function' || typeof db?.exec !== 'function') throw new Error('Обход истории MAX требует базы SQLite');
  for (const name of ['ready', 'bindingFingerprint', 'readMessages'])
    if (typeof access?.[name] !== 'function') throw new Error('Обход истории MAX требует модуля доступа MAX');
  if (typeof now !== 'function') throw new Error('Обход истории MAX требует часов now()');
  const within = (value, max) => Number.isSafeInteger(value) && value >= 1 && value <= max;
  if (!within(maxPages, LIMITS.maxPages) || !within(deadlineMs, LIMITS.deadlineMs))
    throw new Error('Пределы шага обхода истории MAX заданы неверно');

  /* Состояние на компанию и native канал. binding_key — хэш привязки (канал, аккаунт, ревизия,
     отпечаток) без секретов; его смена начинает новый проход. Пробелы и итоги прежних проходов
     лежат отдельно и не удаляются. */
  db.exec(`CREATE TABLE IF NOT EXISTS social_max_backfill_state(
    company_code TEXT NOT NULL COLLATE NOCASE, chat_id TEXT NOT NULL, binding_key TEXT NOT NULL,
    pass INTEGER NOT NULL, upper_ms INTEGER NOT NULL, cursor_ms INTEGER NOT NULL, phase TEXT NOT NULL,
    probe_ms INTEGER, tail TEXT NOT NULL, revision INTEGER NOT NULL, pages_total INTEGER NOT NULL,
    posts_total INTEGER NOT NULL, pass_started_at TEXT, updated_at TEXT, last_run_id INTEGER,
    PRIMARY KEY(company_code, chat_id));
  CREATE TABLE IF NOT EXISTS social_max_backfill_gaps(
    company_code TEXT NOT NULL COLLATE NOCASE, chat_id TEXT NOT NULL, pass INTEGER NOT NULL, kind TEXT NOT NULL,
    from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL, count INTEGER NOT NULL, recorded_at TEXT NOT NULL, run_id INTEGER,
    PRIMARY KEY(company_code, chat_id, pass, kind, from_ms, to_ms));`);
  const sql = {
    state: db.prepare('SELECT * FROM social_max_backfill_state WHERE company_code=? COLLATE NOCASE AND chat_id=?'),
    gaps: db.prepare(`SELECT pass,kind,from_ms,to_ms,count FROM social_max_backfill_gaps WHERE company_code=? COLLATE NOCASE
      AND chat_id=? AND kind<>'previous_pass' ORDER BY pass DESC,to_ms DESC,kind LIMIT ?`),
    gapCount: db.prepare(`SELECT COUNT(*) AS n FROM social_max_backfill_gaps WHERE company_code=? COLLATE NOCASE
      AND chat_id=? AND kind<>'previous_pass'`),
    passes: db.prepare(`SELECT pass,from_ms,to_ms,count FROM social_max_backfill_gaps WHERE company_code=? COLLATE NOCASE
      AND chat_id=? AND kind='previous_pass' ORDER BY pass DESC LIMIT ?`),
    insert: db.prepare(`INSERT INTO social_max_backfill_state(company_code,chat_id,binding_key,pass,upper_ms,cursor_ms,phase,
      probe_ms,tail,revision,pages_total,posts_total,pass_started_at,updated_at,last_run_id)
      VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,?,?) ON CONFLICT DO NOTHING`),
    update: db.prepare(`UPDATE social_max_backfill_state SET binding_key=?,pass=?,upper_ms=?,cursor_ms=?,phase=?,probe_ms=?,
      tail=?,pages_total=?,posts_total=?,pass_started_at=?,updated_at=?,last_run_id=?,revision=revision+1
      WHERE company_code=? COLLATE NOCASE AND chat_id=? AND revision=? AND binding_key=? AND pass=?`),
    gap: db.prepare(`INSERT INTO social_max_backfill_gaps(company_code,chat_id,pass,kind,from_ms,to_ms,count,recorded_at,run_id)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`),
    indexTable: db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='social_max_post_index'"),
  };
  // Индекс создаёт модуль индекса; запрос к нему готовится, когда таблица уже есть.
  const indexed = (code, chat, mid) => (sql.indexTable.get() ? db.prepare(`SELECT published_at FROM social_max_post_index
    WHERE company_code=? COLLATE NOCASE AND chat_id=? AND native_post_id=?`).get(code, chat, mid) : undefined);

  const tokens = new WeakMap();
  const stopController = new AbortController();
  const active = new Set();
  const clock = () => {
    const value = now();
    if (!validTs(value)) throw publicFailure('UPSTREAM_ERROR');
    return value;
  };

  // Состояние привязки без сети: до шага, после ошибки, после шага и при принятии.
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
  const bindingKey = (b) => createHash('sha256')
    .update(JSON.stringify([b.chatId, b.accountRef, b.accessRevision, b.fingerprint])).digest('hex');

  function validState(row) {
    return PHASES.includes(row.phase) && validTs(row.upper_ms) && validTs(row.cursor_ms) && row.cursor_ms <= row.upper_ms
      && Number.isSafeInteger(row.pass) && row.pass >= 1 && typeof row.tail === 'string'
      && Number.isSafeInteger(row.revision) && row.revision>=1
      && Number.isSafeInteger(row.pages_total) && row.pages_total>=0
      && Number.isSafeInteger(row.posts_total) && row.posts_total>=0
      && (row.phase !== 'probe' || (validTs(row.probe_ms) && row.probe_ms <= row.cursor_ms));
  }

  // Охват для чтения: только состояние, пробелы и итоги проходов, без отпечатка и токена.
  function describe(code, chat) {
    const stored=sql.state.get(code,chat)||null,corrupt=stored&&!validState(stored);
    const row = corrupt?null:stored;
    let current = null;
    if (row) { const b = binding(code); current = b.ok && b.chatId === chat && bindingKey(b) === row.binding_key; }
    return {
      companyCode: code, chatId: chat, status: 'partial', postIndex: 'partial', historyComplete: false,
      phase: corrupt?'corrupt':row?.phase ?? 'not_started', pass: row?.pass ?? 0, stateRevision: row?.revision ?? 0,
      upperBound: row ? iso(row.upper_ms) : null, cursor: row ? iso(row.cursor_ms) : null,
      probeAt: row && row.probe_ms !== null ? iso(row.probe_ms) : null,
      tailEnumerated: row?.tail ?? 'not_reached', pagesTotal: row?.pages_total ?? 0, postsObserved: row?.posts_total ?? 0,
      passStartedAt: row?.pass_started_at ?? null, updatedAt: row?.updated_at ?? null, boundToCurrentAccess: current,
      gaps: sql.gaps.all(code, chat, LIST_LIMIT).map((g) => ({pass: g.pass, kind: g.kind, from: iso(g.from_ms), to: iso(g.to_ms), count: g.count})),
      gapsTotal: Number(sql.gapCount.get(code, chat).n),
      previousPasses: sql.passes.all(code, chat, LIST_LIMIT).map((p) => ({pass: p.pass, coveredFrom: iso(p.from_ms), coveredTo: iso(p.to_ms), postsObserved: p.count})),
      uncertainty: [NOTE.semantics, NOTE.epochZero],
    };
  }
  function coverage(companyCode, chatId) {
    if (typeof companyCode !== 'string' || !COMPANY.test(companyCode)) throw publicFailure('BAD_REQUEST');
    const chat = canonicalChatId(chatId);
    if (!chat) throw publicFailure('BAD_REQUEST');
    return describe(companyCode.toLowerCase(), chat);
  }

  function runScope(caller) {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), deadlineMs);
    const sources = [deadline.signal, stopController.signal];
    if (caller) sources.push(caller);
    return {signal: AbortSignal.any(sources), done: () => clearTimeout(timer)};
  }
  const abortFailure = (ctx) => Object.assign(failure(stopController.signal.aborted ? 'STOPPED'
    : ctx.caller?.aborted ? 'ABORTED' : 'TIMEOUT', 'abort'), {[ABORT]: true});
  const throwIfStopped = (ctx) => {
    if (stopController.signal.aborted) throw publicFailure('STOPPED');
    if (ctx.caller?.aborted) throw publicFailure('ABORTED');
  };
  function halt(ctx, reason) {
    if (!ctx.stop) ctx.stop = reason;
    if (TEMPORARY.has(reason)) ctx.temporary = true;
    return null;
  }
  function gap(ctx, kind, from, to, count = 1) { ctx.gaps.push({pass: ctx.pass, kind, from, to, count}); ctx.changed = true; }

  /* Один запрос страницы под общим сроком. Остановка и отмена прерывают весь шаг; срок — только
     дальнейшие страницы. Отказ доступа или смена привязки отклоняют шаг целиком. */
  async function call(ctx, query) {
    ctx.pages += 1;
    try { return await untilAborted((signal) => access.readMessages(ctx.code, {...query}, {signal}), ctx.signal, () => abortFailure(ctx)); }
    catch (error) {
      if (error?.[ABORT] || ctx.signal.aborted) {
        const abort = error?.[ABORT] ? error : abortFailure(ctx);
        if (abort.code !== 'TIMEOUT') throw abort;
        return halt(ctx, 'deadline');
      }
      if (!sameBinding(ctx.base, binding(ctx.code))) throw refusal(REFUSAL.binding);
      if (error?.code === 'STOPPED') throw Object.assign(failure('STOPPED', 'abort'), {[ABORT]: true});
      if (REFUSING.has(error?.code)) throw refusal(error.code === 'RESPONSE_SCOPE_MISMATCH' ? REFUSAL.scope : REFUSAL.denied);
      return halt(ctx, 'temporary');
    }
  }

  // Время наблюдения конверта: UTC 'Z' в пределах [начало шага − допуск, сейчас + допуск].
  function observedOf(ctx, value) {
    const a = value.observedAtISO, b = value.observedAt;
    if (a !== undefined && b !== undefined && a !== b) return null;
    const text = a ?? b;
    if (typeof text !== 'string' || !OBSERVED_TIME.test(text)) return null;
    const ms = Date.parse(text), nowMs = clock();
    if (!validTs(ms) || ms < ctx.startedMs - CLOCK_SKEW_MS || ms > nowMs + CLOCK_SKEW_MS) return null;
    // В пределах допуска часов наблюдение не датируется будущим днём.
    return Math.min(ms, nowMs);
  }

  /* Страница принимается целиком или не принимается вовсе. Сначала получатель КАЖДОГО сообщения,
     включая body:null: чужой канал отклоняет весь шаг. Из сообщения берутся только время, mid и
     stat.views. */
  function parsePage(ctx, value, query) {
    if (!isPlain(value)) return halt(ctx, 'invalid');
    if (typeof value.companyCode !== 'string' || value.companyCode.toLowerCase() !== ctx.code
      || canonicalChatId(value.chatId) !== ctx.chat || value.accessRevision !== ctx.base.accessRevision)
      throw refusal(REFUSAL.scope);
    const observedMs = observedOf(ctx, value);
    if (observedMs === null) return halt(ctx, 'observed');
    const data = value.data;
    if (!isPlain(data) || !Array.isArray(data.messages) || data.messages.length > query.count) return halt(ctx, 'invalid');
    if (data.messages.some((raw) => isPlain(raw) && isPlain(raw.recipient)
      && (canonicalChatId(raw.recipient.chat_id) !== ctx.chat || raw.recipient.chat_type !== 'channel')))
      throw refusal(REFUSAL.foreign);
    const messages = [];
    for (const raw of data.messages) {
      if (!isPlain(raw) || !isPlain(raw.recipient)) return halt(ctx, 'invalid');
      const ts = raw.timestamp;
      if (!validTs(ts) || ts > observedMs + CLOCK_SKEW_MS) return halt(ctx, 'invalid');
      if (ts < query.after || ts > query.before) return halt(ctx, 'temporal');
      let mid = null;
      if (raw.body !== null) {
        if (!isPlain(raw.body) || typeof raw.body.mid !== 'string' || !MID.test(raw.body.mid)) return halt(ctx, 'invalid');
        mid = raw.body.mid;
      }
      let views = null, invalid = false;
      if (raw.stat !== undefined && raw.stat !== null) {
        if (!isPlain(raw.stat)) invalid = true;
        else if (raw.stat.views !== undefined && raw.stat.views !== null) {
          if (Number.isSafeInteger(raw.stat.views) && raw.stat.views >= 0) views = raw.stat.views;
          else invalid = true;
        }
      }
      messages.push({ts, mid, views, invalid});
    }
    for (let index = 1; index < messages.length; index += 1)
      if (messages[index].ts > messages[index - 1].ts) return halt(ctx, 'order');
    return {observedMs, messages};
  }
  async function readPage(ctx, query) {
    const answer = await call(ctx, query);
    return answer === null ? null : parsePage(ctx, answer, query);
  }

  /* Повтор поста (стык страниц, проба) не складывается, более старое наблюдение не заменяет
     новое. Тот же mid с другим временем — не тот же пост: он отклоняется, пробел сохраняется. */
  function remember(ctx, message, observedMs) {
    const times = ctx.conflicts.get(message.mid);
    if (times) { times.add(message.ts); return; }
    const known = ctx.posts.get(message.mid);
    if (known && known.ts !== message.ts) {
      ctx.posts.delete(message.mid);
      ctx.conflicts.set(message.mid, new Set([known.ts, message.ts]));
      return;
    }
    if (!known || observedMs >= known.observedMs)
      ctx.posts.set(message.mid, {ts: message.ts, views: message.views, invalid: message.invalid, observedMs});
  }
  function accept(ctx, page) {
    ctx.changed = true; ctx.acceptedPages += 1;
    let lo = Infinity, hi = -Infinity, unnamed = 0;
    for (const message of page.messages) {
      if (message.mid === null) { unnamed += 1; lo = Math.min(lo, message.ts); hi = Math.max(hi, message.ts); continue; }
      remember(ctx, message, page.observedMs);
    }
    if (unnamed) gap(ctx, 'unidentified_message', lo, hi, unnamed);
  }

  /* Ограниченный шаг обхода. Фаза, курсор и отметка пробы меняются только после принятой
     страницы; курсор строго убывает, поэтому один и тот же запрос не повторяется вечно. */
  async function walk(ctx, plan) {
    let expect = null;
    while (plan.phase !== 'done') {
      if (plan.phase === 'listing' && plan.cursor <= 0) {
        // Раньше 0 мс постов нет, а ровно 0 мс запрос after:0 мог исключить.
        gap(ctx, 'epoch_boundary', 0, 0);
        plan.phase = 'done'; plan.tail = 'epoch_reached_unverified';
        break;
      }
      if (ctx.pages >= maxPages) { halt(ctx, 'maxPages'); break; }
      if (plan.phase === 'listing') {
        const page = await readPage(ctx, {after: 0, before: plan.cursor, count: PAGE_SIZE});
        if (!page) break;
        accept(ctx, page);
        if (page.messages.length < PAGE_SIZE) { plan.phase = 'done'; plan.tail = 'short_page_unverified'; break; }
        const oldest = page.messages[PAGE_SIZE - 1].ts;
        expect = page.messages.filter((message) => message.ts === oldest && message.mid).map((message) => message.mid);
        // Посты страницы принимаются сейчас; проба той же отметки — следующий запрос или следующий шаг.
        plan.phase = 'probe'; plan.probe = oldest;
        continue;
      }
      const t = plan.probe, from = Math.max(0, t - 1);
      // После перезапуска прежняя listing-страница уже принята в native index.
      // Восстанавливаем проверяемые IDs границы, чтобы empty probe не скрыла их
      // исчезновение и не превратилась в доказательство разрешённой границы.
      if(expect===null&&sql.indexTable.get())expect=db.prepare(`SELECT native_post_id FROM social_max_post_index
        WHERE company_code=? COLLATE NOCASE AND chat_id=? AND published_at=? LIMIT 101`)
        .all(ctx.code,ctx.chat,iso(t)).map(r=>r.native_post_id);
      const page = await readPage(ctx, {after: from, before: t + 1, count: PAGE_SIZE});
      if (!page) break;
      accept(ctx, page);
      let next = t;
      if (page.messages.length >= PAGE_SIZE) { gap(ctx, 'dense_timestamp', from, t); next = t - 1; }
      else if (t >= plan.cursor || (expect && t > 0 && expect.some((mid) => !page.messages.some((message) => message.mid === mid)))) {
        gap(ctx, 'inconsistent_boundary', from, t); next = t - 1;
      }
      expect = null;
      plan.phase = 'listing'; plan.probe = null; plan.cursor = Math.max(0, next);
    }
  }

  // Пост, уже записанный в индекс с другим временем, — тоже конфликт идентичности.
  function checkIndex(ctx) {
    for (const [mid, post] of [...ctx.posts]) {
      const row = indexed(ctx.code, ctx.chat, mid);
      if (row && row.published_at !== iso(post.ts)) {
        ctx.posts.delete(mid);
        const before = Date.parse(row.published_at);
        ctx.conflicts.set(mid, new Set(validTs(before) ? [post.ts, before] : [post.ts]));
      }
    }
    for (const times of ctx.conflicts.values()) gap(ctx, 'identity_conflict', Math.min(...times), Math.max(...times));
  }
  function mergeGaps(list) {
    const merged = new Map();
    for (const item of list) {
      const key = `${item.pass}|${item.kind}|${item.from}|${item.to}`;
      const known = merged.get(key);
      if (!known || item.count > known.count) merged.set(key, item);
    }
    return [...merged.values()];
  }
  const refused = (code, chat, reason) => ({status: 'missing_access', posts: [], prepared: null,
    coverage: chat ? describe(code, chat) : null, missing: [reason], retryable: false});

  async function run(input) {
    if (stopController.signal.aborted) throw publicFailure('STOPPED');
    const {code, timezone, signal} = readInput(input);
    const startedMs = clock();
    const base = binding(code);
    if (!base.ok) return refused(code, null, base.reason);
    if (signal?.aborted) throw publicFailure('ABORTED');
    const chat = base.chatId, key = bindingKey(base);
    // Только чтение: отсутствующее состояние — проход по умолчанию, запись появится в commit.
    const stored = sql.state.get(code, chat) || null;
    const standing = [NOTE.semantics, NOTE.epochZero, NOTE.history, NOTE.metrics];
    if (stored && !validState(stored))
      return {status: 'partial', posts: [], prepared: null, coverage: describe(code, chat), missing: [NOTE.corrupt], retryable: false};
    const fresh = !stored || stored.binding_key !== key;
    const plan = fresh
      ? {pass: (stored?.pass ?? 0) + 1, upper: startedMs, cursor: startedMs, phase: 'listing', probe: null, tail: 'not_reached'}
      : {pass: stored.pass, upper: stored.upper_ms, cursor: stored.cursor_ms, phase: stored.phase, probe: stored.probe_ms, tail: stored.tail};
    if (plan.phase === 'done')
      return {status: 'partial', posts: [], prepared: null, coverage: describe(code, chat), missing: [NOTE.done, ...standing], retryable: false};

    const scope = runScope(signal);
    const ctx = {code, chat, tz: timezone, base, startedMs, pass: plan.pass, signal: scope.signal, caller: signal,
      pages: 0, acceptedPages: 0, posts: new Map(), conflicts: new Map(), gaps: [], stop: '', temporary: false, changed: false};
    try { await walk(ctx, plan); }
    catch (error) {
      if (error?.code === 'REFUSED') { throwIfStopped(ctx); return refused(code, chat, error.refusal); }
      if (error?.[ABORT]) throw publicFailure(error.code);
      throw publicFailure('UPSTREAM_ERROR');
    } finally { scope.done(); }
    // Поздний результат после остановки, отмены или смены привязки не выдаётся.
    throwIfStopped(ctx);
    if (!sameBinding(base, binding(code))) return refused(code, chat, REFUSAL.binding);
    checkIndex(ctx);

    const entries = [...ctx.posts].sort(([a, x], [b, y]) => y.ts - x.ts || (a < b ? -1 : a > b ? 1 : 0));
    const posts = entries.map(([mid, post]) => ({platformPostId: mid, publishedAt: iso(post.ts), kind: 'organic',
      metrics: [{date: localDay(post.observedMs, ctx.tz), period: 'lifetime', metric: 'views', value: post.views,
        sourceField: VIEWS_FIELD, completeness: post.views === null ? 'partial' : 'complete'}]}));
    const gaps = mergeGaps(ctx.gaps);
    const missing = [];
    if (ctx.stop) missing.push(STOP[ctx.stop]);
    for (const [kind, note] of [['dense_timestamp', NOTE.dense], ['inconsistent_boundary', NOTE.inconsistent],
      ['epoch_boundary', NOTE.epoch], ['unidentified_message', NOTE.unidentified], ['identity_conflict', NOTE.conflict]])
      if (gaps.some((item) => item.kind === kind)) missing.push(note);
    const unknown = entries.filter(([, post]) => post.views === null && !post.invalid).length;
    const invalid = entries.filter(([, post]) => post.invalid).length;
    if (unknown) missing.push(`у ${unknown} постов MAX не вернул stat.views: просмотры неизвестны, а не нулевые`);
    if (invalid) missing.push(`у ${invalid} постов stat.views пришёл в недопустимом виде: просмотры не записаны`);
    missing.push(...standing);

    let prepared = null;
    if (ctx.changed) {
      prepared = Object.freeze(Object.create(null));
      tokens.set(prepared, {code, chat, base, key, fresh, next: {...plan}, pages: ctx.acceptedPages, gaps,
        expected: stored ? {revision: stored.revision, pass: stored.pass, key: stored.binding_key} : null,
        // Прежний проход сохраняется как свидетельство: какой диапазон он покрыл и сколько постов видел.
        evidence: fresh && stored ? {pass: stored.pass, kind: 'previous_pass', from: stored.phase === 'done' ? 0 : stored.cursor_ms,
          to: stored.upper_ms, count: stored.posts_total} : null,
        posts: entries.map(([mid, post]) => ({mid, publishedAt: iso(post.ts)}))});
    }
    return {status: 'partial', posts, prepared, missing, retryable: ctx.temporary,
      coverage: {...describe(code, chat), pendingStep: prepared ? {pass: plan.pass, phase: plan.phase,
        cursor: iso(plan.cursor), probeAt: plan.probe === null ? null : iso(plan.probe), tailEnumerated: plan.tail,
        newGaps: gaps.length} : null}};
  }

  function collectStep(input) {
    const pending = run(input);
    active.add(pending);
    const forget = () => { active.delete(pending); };
    pending.then(forget, forget);
    return pending;
  }

  /* Принятие шага внутри транзакции Root вместе с индексом. BEGIN/COMMIT делает Root; откат его
     транзакции откатывает и курсор, а повтор того же prepared проходит CAS заново. */
  function commit(prepared, {runId = null, collectedAt} = {}) {
    const data = prepared !== null && typeof prepared === 'object' ? tokens.get(prepared) : undefined;
    if (!data) throw publicFailure('MAX_BACKFILL_TOKEN');
    if (db.isTransaction !== true) throw publicFailure('MAX_BACKFILL_TRANSACTION');
    if (stopController.signal.aborted) throw publicFailure('STOPPED');
    if ((runId !== null && !Number.isSafeInteger(runId)) || typeof collectedAt !== 'string' || !ISO_TIME.test(collectedAt)
      || !Number.isFinite(Date.parse(collectedAt))) throw publicFailure('MAX_BACKFILL_CONTEXT');
    const at = iso(Date.parse(collectedAt));
    if (!sameBinding(data.base, binding(data.code))) throw publicFailure('MAX_BACKFILL_STALE');
    const row = sql.state.get(data.code, data.chat) || null;
    const expected = data.expected;
    if (expected ? !row || row.revision !== expected.revision || row.pass !== expected.pass || row.binding_key !== expected.key : row)
      throw publicFailure('MAX_BACKFILL_STALE');
    // Курсор двигается только вместе с постами, уже записанными в индекс этой транзакцией.
    for (const post of data.posts) {
      const stored = indexed(data.code, data.chat, post.mid);
      if (!stored || stored.published_at !== post.publishedAt) throw publicFailure('MAX_BACKFILL_INDEX');
    }
    const next = data.next;
    const pages = (data.fresh ? 0 : row.pages_total) + data.pages;
    const posts = (data.fresh ? 0 : row.posts_total) + data.posts.length;
    const started = data.fresh ? at : row.pass_started_at;
    const result = expected
      ? sql.update.run(data.key, next.pass, next.upper, next.cursor, next.phase, next.probe, next.tail, pages, posts, started, at,
        runId, data.code, data.chat, expected.revision, expected.key, expected.pass)
      : sql.insert.run(data.code, data.chat, data.key, next.pass, next.upper, next.cursor, next.phase, next.probe, next.tail,
        pages, posts, started, at, runId);
    if (Number(result.changes) !== 1) throw publicFailure('MAX_BACKFILL_STALE');
    for (const item of data.evidence ? [...data.gaps, data.evidence] : data.gaps)
      sql.gap.run(data.code, data.chat, item.pass, item.kind, item.from, item.to, item.count, at, runId);
    return {pass: next.pass, phase: next.phase, stateRevision: expected ? expected.revision + 1 : 1};
  }

  // Остановка: текущие шаги прерываются без позднего результата, новые шаги и принятия не начинаются.
  function stop() {
    if (!stopController.signal.aborted) stopController.abort();
    return Promise.allSettled([...active]).then(() => undefined);
  }

  return {collectStep, commit, coverage, stop};
}

module.exports = {createSocialMaxBackfill};
