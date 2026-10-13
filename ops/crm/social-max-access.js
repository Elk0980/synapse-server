'use strict';
/* Доступ к ИЗМЕРЕНИЯМ канала MAX выбранной компании и подтверждение привязки к нему
   (specs/094-max-native-analytics, FR001–FR003, FR007).

   Это не подключение публикаций и не управление ботом. Токен бота лежит в существующем
   зашифрованном складе social_analytics_credentials под ОТДЕЛЬНЫМ провайдером max_analytics;
   модуль только читает его через resolve и никогда не возвращает наружу. Бот, права,
   подписки, сообщения и новые ключи здесь не создаются: используются только читающие
   GET /me, GET /chats/{chatId}, GET /chats/{chatId}/members/me и GET /messages
   (официальная OpenAPI max-messenger/api-schema 0.0.33). Список GET /chats не используется.

   Сетевые правила: единственный адрес https://platform-api2.max.ru, токен — сырой заголовок
   Authorization (без Bearer и никогда в строке запроса), TLS без обходов, redirect:'error',
   а 3xx/redirected/opaque/чужой url отклоняются без чтения тела. Тело читается только потоком
   с пределом в байтах, срок и отмена охватывают ожидание fetch и чтение тела. Повторов нет:
   их делает существующая очередь.

   Идентификаторы MAX — signed int64 и превышают точность Number. Ответ разбирается строгим
   разборщиком, который хранит числа исходной записью: ID сверяются как канонические
   десятичные строки, счётчики принимаются только как безопасные неотрицательные целые. */

const MAX_PROVIDER = 'max_analytics';
const MAX_API_ORIGIN = 'https://platform-api2.max.ru';
const TIMEOUT_MS = 15000;
const TIMEOUT_CAP_MS = 60000;
// Предел ответа в БАЙТАХ: многобайтный текст постов иначе считался бы вдвое короче предела.
const MAX_BYTES = 1048576;
const MAX_BYTES_CAP = 8 * 1048576;
// Токен уходит в заголовок: пробелы и управляющие символы недопустимы.
const TOKEN_FORMAT = /^[\x21-\x7e]{1,4096}$/;
// Формат ID сообщения по общему интерфейсу MAX_ACCESS/MAX_STATS; длина ограничена ради адреса запроса.
const MESSAGE_ID = /^(?:mid\.)?[A-Za-z0-9_-]{1,200}$/;
const MESSAGE_BATCH = 100;
// count по OpenAPI getMessages: 1..100, по умолчанию 50.
const DEFAULT_COUNT = 50;
const JSON_DEPTH = 64;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INTEGER_LEXEME = /^-?(?:0|[1-9]\d{0,18})$/;
const COUNT_LEXEME = /^(?:0|[1-9]\d{0,15})$/;

/* Постоянные причины: доступ ЭТОЙ ревизии больше не подтверждает канал, подтверждение
   снимается. Временные причины подтверждение не трогают: перегрузка, обрыв или непонятный
   ответ — не отзыв. */
const DECISIVE_CODES = Object.freeze(['ACCESS_DENIED', 'CREDENTIAL_UNREADABLE', 'CHANNEL_REF_REQUIRED',
  'CHANNEL_REF_INVALID', 'CHANNEL_NOT_FOUND', 'NOT_A_CHANNEL', 'CHANNEL_INACTIVE', 'NOT_A_BOT',
  'MEMBERSHIP_MISMATCH', 'NOT_ADMIN', 'CHANNEL_TAKEN']);
const TEMPORARY_CODES = Object.freeze(['RATE_LIMITED', 'TIMEOUT', 'STOPPED', 'CONNECTION_UNCERTAIN',
  'UPSTREAM_ERROR', 'UPSTREAM_REDIRECT', 'RESPONSE_UNCERTAIN', 'RESPONSE_TOO_LARGE', 'RESPONSE_SCOPE_MISMATCH']);
const DECISIVE = new Set(DECISIVE_CODES);
const KNOWN = new Set([...DECISIVE_CODES, ...TEMPORARY_CODES, 'MISSING_ACCESS', 'BINDING_UNCONFIRMED',
  'REVISION_CONFLICT', 'BAD_REQUEST', 'NOT_FOUND', 'STORAGE_ERROR']);

const failure = (code, message, status = 502) => Object.assign(new Error(message), {code, status});
const fail = (code, message, status = 502) => { throw failure(code, message, status); };
const timeoutError = () => failure('TIMEOUT', 'MAX не ответил вовремя.', 504);
const stopError = () => failure('STOPPED', 'Обращение к MAX остановлено.', 503);
const uncertain = () => failure('RESPONSE_UNCERTAIN', 'Ответ MAX не разобран.');
const scopeMismatch = () => failure('RESPONSE_SCOPE_MISMATCH',
  'MAX вернул данные не того канала, что подтверждён: ответ не принят.');
const revisionConflict = () => failure('REVISION_CONFLICT',
  'Доступ или привязка канала MAX изменились во время обращения: результат не принят, повторите.', 409);
// Код отмены по причине сигнала: срок — TIMEOUT, остановка модуля и внешний сигнал — STOPPED.
const abortError = (signal) => {
  const reason = signal?.reason;
  return reason?.code === 'TIMEOUT' || reason?.name === 'TimeoutError' ? timeoutError() : stopError();
};
// Наружу — только наши коды и тексты: сырое исключение могло бы нести адрес, тело ответа или токен.
const ownError = (error) => (KNOWN.has(error?.code) && typeof error.message === 'string'
  ? failure(error.code, error.message, error.status) : failure('UPSTREAM_ERROR', 'Обращение к MAX завершилось ошибкой.'));

/* Ожидание, которое отменяется сигналом, даже если само обещание abort не слышит: поддельный
   fetch или поток, игнорирующий отмену, не удержит вызов дольше срока. */
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
const signalsOf = (list) => list.filter((item) => item instanceof AbortSignal);
// Сигнал одного запроса: свой срок, сигнал вызывающего и остановка модуля.
function callScope(ms, signals) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(timeoutError()), ms);
  return {signal: AbortSignal.any([controller.signal, ...signalsOf(signals)]), done: () => clearTimeout(timer)};
}
// Закрытие тела без ожидания: зависший cancel не должен держать вызов.
const discard = (response) => {
  try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch { /* тело уже недоступно */ }
};

/* Число из ответа MAX в исходной записи. Number из него получается только там, где значение
   доказанно безопасно; идентификаторы остаются строками. */
class NativeNumber {
  constructor(lexeme) { this.lexeme = lexeme; Object.freeze(this); }
}

/* Строгий JSON: те же правила, что у JSON.parse, плюс отказ от повторяющихся ключей и
   ограничение вложенности. Строки декодирует сам JSON.parse по точно выделенной лексеме. */
const STRING_TOKEN = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const NUMBER_TOKEN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const LITERALS = [['true', true], ['false', false], ['null', null]];
function parseNativeJson(text) {
  let at = 0;
  const space = () => { while (at < text.length && ' \t\n\r'.includes(text[at])) at += 1; };
  const token = (pattern) => {
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (!match) throw uncertain();
    at = pattern.lastIndex;
    return match[0];
  };
  function value(depth) {
    if (depth > JSON_DEPTH) throw uncertain();
    space();
    const char = text[at];
    if (char === '{') {
      at += 1;
      const object = Object.create(null);
      space();
      if (text[at] === '}') { at += 1; return object; }
      for (;;) {
        space();
        if (text[at] !== '"') throw uncertain();
        const key = JSON.parse(token(STRING_TOKEN));
        // Повтор ключа: какое из значений «настоящее», неизвестно — ответ не принимается.
        if (Object.hasOwn(object, key)) throw uncertain();
        space();
        if (text[at] !== ':') throw uncertain();
        at += 1;
        object[key] = value(depth + 1);
        space();
        if (text[at] === ',') { at += 1; continue; }
        if (text[at] === '}') { at += 1; return object; }
        throw uncertain();
      }
    }
    if (char === '[') {
      at += 1;
      const list = [];
      space();
      if (text[at] === ']') { at += 1; return list; }
      for (;;) {
        list.push(value(depth + 1));
        space();
        if (text[at] === ',') { at += 1; continue; }
        if (text[at] === ']') { at += 1; return list; }
        throw uncertain();
      }
    }
    if (char === '"') return JSON.parse(token(STRING_TOKEN));
    if (char === '-' || (char >= '0' && char <= '9')) return new NativeNumber(token(NUMBER_TOKEN));
    for (const [word, literal] of LITERALS) if (text.startsWith(word, at)) { at += word.length; return literal; }
    throw uncertain();
  }
  const result = value(0);
  space();
  if (at !== text.length) throw uncertain();
  return result;
}

/* signed int64 → каноническая десятичная строка; иначе null. Number принимается только
   безопасным целым: округлённое значение могло бы совпасть с чужим каналом. */
function normalizeMaxId(value) {
  let lexeme;
  if (value instanceof NativeNumber || typeof value === 'string') lexeme = typeof value === 'string' ? value : value.lexeme;
  else if (typeof value === 'bigint') lexeme = value.toString();
  else if (typeof value === 'number' && Number.isSafeInteger(value)) lexeme = String(value);
  else return null;
  if (!INTEGER_LEXEME.test(lexeme)) return null;
  const number = BigInt(lexeme);
  return number < INT64_MIN || number > INT64_MAX ? null : number.toString();
}
// ID из ответа MAX: только числовая лексема, строка "123" за идентификатор не принимается.
const idOf = (value) => (value instanceof NativeNumber ? normalizeMaxId(value) : null);
// Счётчик или время: только неотрицательное безопасное целое без дробной части и экспоненты.
const integerOf = (value) => (value instanceof NativeNumber && COUNT_LEXEME.test(value.lexeme)
  && Number.isSafeInteger(Number(value.lexeme)) ? Number(value.lexeme) : null);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && !(value instanceof NativeNumber);

/* Запись канала в аккаунте аналитики → однозначный ключ. Принимается только нативный chat_id:
   ссылку или имя канала в chat_id без списка GET /chats не разрешить, а угадывать нельзя. */
function maxChatRef(value) {
  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw === '' || raw === null || raw === undefined) return {kind: 'none', key: ''};
  const chatId = normalizeMaxId(raw);
  return chatId === null ? {kind: 'invalid', key: ''} : {kind: 'id', key: chatId, chatId};
}

/* Перенаправление не исполняется и не читается: заголовок с токеном не должен уйти по
   чужому адресу, а ответ чужого адреса — стать «ответом MAX». */
function acceptResponse(response, requested) {
  if (!response || typeof response !== 'object') fail('RESPONSE_UNCERTAIN', 'Ответ MAX не распознан.');
  const status = response.status;
  const moved = response.type === 'opaqueredirect' || response.type === 'opaque' || response.redirected === true
    || (Number.isInteger(status) && status >= 300 && status < 400)
    || (typeof response.url === 'string' && response.url !== '' && response.url !== requested);
  if (moved) {
    discard(response);
    fail('UPSTREAM_REDIRECT', 'MAX ответил перенаправлением: запрос по другому адресу не выполнялся.');
  }
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    discard(response);
    fail('RESPONSE_UNCERTAIN', 'Ответ MAX не распознан.');
  }
  return status;
}

/* Отказ MAX по коду ответа. Тело отказа не читается вовсе: наружу уходит только наш код.
   404 канала и членства означает, что бот канал не видит, — это постоянная причина. */
function upstreamFailure(status, kind) {
  if (status === 401) return failure('ACCESS_DENIED', 'MAX не принял сохранённый доступ: токен недействителен или отозван.');
  if (status === 403) return failure('ACCESS_DENIED', 'MAX отказал в доступе к каналу: бот не участник, не администратор или приостановлен.');
  if (status === 404 && (kind === 'chat' || kind === 'membership'))
    return failure('CHANNEL_NOT_FOUND', 'MAX не показывает боту указанный канал.');
  if (status === 429) return failure('RATE_LIMITED', 'MAX временно ограничил обращения: повторите позже.', 503);
  if (status >= 200 && status < 300) return failure('RESPONSE_UNCERTAIN', 'Ответ MAX не распознан.');
  return failure('UPSTREAM_ERROR', 'MAX вернул ошибку.');
}

/* Ограниченное чтение ответа. Только поток: response.text() материализует тело целиком до
   любой проверки размера. Объявленная длина сверх предела отклоняется до чтения. */
async function readJsonLimited(response, signal, limit) {
  let declared = NaN;
  try { declared = Number(response.headers?.get?.('content-length')); } catch { declared = NaN; }
  if (Number.isFinite(declared) && declared > limit) {
    discard(response);
    fail('RESPONSE_TOO_LARGE', 'Ответ MAX слишком большой.');
  }
  let reader = null;
  try { reader = typeof response.body?.getReader === 'function' ? response.body.getReader() : null; }
  catch { reader = null; }
  if (!reader) fail('RESPONSE_UNCERTAIN', 'Ответ MAX пришёл без потока: без предела размера он не читается.');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await untilAborted(() => reader.read(), signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) fail('RESPONSE_UNCERTAIN', 'Ответ MAX пришёл в неожиданном виде.');
      size += value.byteLength;
      if (size > limit) fail('RESPONSE_TOO_LARGE', 'Ответ MAX слишком большой.');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    Promise.resolve().then(() => reader.cancel()).catch(() => {});
    if (['RESPONSE_TOO_LARGE', 'RESPONSE_UNCERTAIN', 'TIMEOUT', 'STOPPED'].includes(error?.code)) throw error;
    fail('CONNECTION_UNCERTAIN', 'MAX не дочитал ответ.', 504);
  }
  let text;
  try { text = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)); }
  catch { return fail('RESPONSE_UNCERTAIN', 'Ответ MAX не разобран.'); }
  return parseNativeJson(text);
}

/* Очищенный канал: только идентичность, тип, состояние и числовые счётчики. Название,
   описание, ссылка, владелец и участники не выходят из модуля. */
function channelOf(body, chatId) {
  if (!isObject(body)) throw uncertain();
  const id = idOf(body.chat_id);
  if (id === null) throw uncertain();
  if (id !== chatId) throw scopeMismatch();
  if (typeof body.type !== 'string' || typeof body.status !== 'string') throw uncertain();
  if (body.type !== 'channel') fail('NOT_A_CHANNEL', 'Указанный chat_id в MAX не является каналом.', 409);
  if (body.status !== 'active') fail('CHANNEL_INACTIVE', 'Бот не активен в канале MAX (удалён, вышел или канал закрыт).', 409);
  const participants = integerOf(body.participants_count);
  if (participants === null) throw uncertain();
  const data = {chat_id: id, type: 'channel', status: 'active', participants_count: participants};
  // messages_count необязателен и nullable: отсутствие — неизвестность, не ноль.
  if (body.messages_count !== undefined && body.messages_count !== null) {
    const messages = integerOf(body.messages_count);
    if (messages === null) throw uncertain();
    data.messages_count = messages;
  }
  return data;
}

// Бот текущего токена: только его ID и признак бота, имя и описание отбрасываются.
function botOf(body) {
  if (!isObject(body)) throw uncertain();
  const id = idOf(body.user_id);
  if (id === null || typeof body.is_bot !== 'boolean') throw uncertain();
  if (!body.is_bot) fail('NOT_A_BOT', 'Сохранённый доступ MAX принадлежит не боту.', 409);
  return id;
}

// Членство именно этого бота и права администратора, без которых GET /messages по каналу недоступен.
function checkMembership(body, botId) {
  if (!isObject(body)) throw uncertain();
  const id = idOf(body.user_id);
  if (id === null || typeof body.is_bot !== 'boolean' || typeof body.is_admin !== 'boolean') throw uncertain();
  if (id !== botId || !body.is_bot)
    fail('MEMBERSHIP_MISMATCH', 'MAX вернул членство другого участника, а не бота сохранённого доступа.', 409);
  if (!body.is_admin) fail('NOT_ADMIN', 'Бот не администратор канала MAX: посты канала ему недоступны.', 409);
}

/* Запрос сообщений: ровно документированные параметры. Время — before/after/count по OpenAPI,
   известные посты — message_ids. chat_id, адрес, компания и токен снаружи не принимаются. */
function messagePlan(query) {
  const badRequest = () => fail('BAD_REQUEST', 'Запрос постов MAX задан недопустимо.', 400);
  if (!isObject(query)) badRequest();
  const keys = Object.keys(query);
  if (keys.includes('messageIds')) {
    const ids = query.messageIds;
    if (keys.length !== 1 || !Array.isArray(ids) || !ids.length || ids.length > MESSAGE_BATCH) badRequest();
    if (ids.some((id) => typeof id !== 'string' || !MESSAGE_ID.test(id)) || new Set(ids).size !== ids.length) badRequest();
    return {ids: [...ids], params: [`message_ids=${ids.join(',')}`], limit: ids.length};
  }
  const params = [];
  for (const key of keys) if (!['before', 'after', 'count'].includes(key)) badRequest();
  for (const key of ['before', 'after']) {
    const value = query[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) badRequest();
    params.push(`${key}=${value}`);
  }
  const count = query.count;
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > MESSAGE_BATCH)) badRequest();
  if (count !== undefined) params.push(`count=${count}`);
  return {ids: null, params, limit: count ?? DEFAULT_COUNT};
}

/* Очищенные посты. Каждый получатель обязан быть сохранённым каналом. Отправитель, текст,
   вложения, разметка, ссылка и user_id не выходят из модуля. Нет stat или views — неизвестно,
   не ноль; испорченный счётчик отклоняет весь ответ. Недокументированные поля stat игнорируются. */
function messagesOf(body, chatId, plan) {
  if (!isObject(body) || !Array.isArray(body.messages)) throw uncertain();
  if (body.messages.length > plan.limit) throw uncertain();
  const requested = plan.ids ? new Set(plan.ids) : null;
  const seen = new Set();
  return body.messages.map((item) => {
    if (!isObject(item) || !isObject(item.recipient) || (item.body !== null && !isObject(item.body))) throw uncertain();
    const rawChat = item.recipient.chat_id;
    const recipient = rawChat === undefined || rawChat === null ? null : idOf(rawChat);
    if (rawChat !== undefined && rawChat !== null && recipient === null) throw uncertain();
    if (recipient !== chatId || item.recipient.chat_type !== 'channel') throw scopeMismatch();
    const timestamp = integerOf(item.timestamp);
    if (item.body === null) { if (timestamp === null) throw uncertain(); return {recipient:{chat_id:chatId,chat_type:'channel'},timestamp,body:null,stat:null}; }
    const mid = item.body.mid;
    if (timestamp === null || typeof mid !== 'string' || !MESSAGE_ID.test(mid)) throw uncertain();
    if (requested && !requested.has(mid)) throw scopeMismatch();
    if (seen.has(mid)) throw uncertain();
    seen.add(mid);
    let stat = null;
    if (item.stat !== undefined && item.stat !== null) {
      if (!isObject(item.stat)) throw uncertain();
      if (item.stat.views !== undefined && item.stat.views !== null) {
        const views = integerOf(item.stat.views);
        if (views === null) throw uncertain();
        stat = {views};
      }
    }
    return {recipient: {chat_id: chatId, chat_type: 'channel'}, timestamp, body: {mid}, stat};
  });
}

/* Сохранённая привязка компании к каналу. chat_id не секрет, хранится канонической строкой
   (без потери точности int64). Один канал — одна компания: частичный уникальный индекс. */
function createSocialMaxAccess(db, {credentials, fetchImpl = globalThis.fetch, now = Date.now,
  timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES} = {}) {
  if (!credentials?.resolve || !credentials?.get || !credentials?.markChecked)
    throw new Error('Доступ к измерениям MAX требует склада аналитических доступов');
  if (typeof fetchImpl !== 'function') throw new Error('Доступ к измерениям MAX требует fetch');
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, TIMEOUT_CAP_MS) : TIMEOUT_MS;
  const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, MAX_BYTES_CAP) : MAX_BYTES;
  db.exec(`CREATE TABLE IF NOT EXISTS social_max_channels (
    company_code TEXT PRIMARY KEY COLLATE NOCASE,
    chat_id TEXT NOT NULL DEFAULT '', access_revision INTEGER NOT NULL DEFAULT 0,
    account_ref TEXT NOT NULL DEFAULT '', checked_at TEXT, actor_id INTEGER, actor_name TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS social_max_channels_chat ON social_max_channels(chat_id) WHERE chat_id<>'';`);

  const code = (value) => {
    if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)) fail('NOT_FOUND', 'Компания не найдена', 404);
    return value.toLowerCase();
  };
  const stamp = () => new Date(now()).toISOString();
  const channelRow = (company) => db.prepare(
    'SELECT * FROM social_max_channels WHERE company_code=? COLLATE NOCASE').get(company) || null;
  // Остановка модуля: прерывает ожидания и не даёт начать новые обращения.
  const stopController = new AbortController();
  const active = new Set();
  let closing = false;

  const ensureOpen = (signal) => {
    if (closing) throw stopError();
    if (signal?.aborted) throw abortError(signal);
  };

  // Изменения базы одной точкой сохранения: привязка и отметка склада применяются вместе или никак.
  function atomically(name, work) {
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = work();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw error;
    }
  }

  function get(current) {
    const company = code(current);
    const access = credentials.get(company, MAX_PROVIDER) || {};
    const row = channelRow(company);
    const configured = Boolean(access.configured);
    const confirmed = configured && access.checked === true && Boolean(row?.chat_id)
      && row.access_revision === access.revision;
    return {
      companyCode: company, provider: MAX_PROVIDER, configured,
      status: access.status || 'not_configured', statusCode: access.statusCode || '',
      revision: access.revision ?? 0, checked: access.checked === true,
      channelConfirmed: confirmed, channelId: confirmed ? row.chat_id : '',
      channelAccountRef: row?.account_ref || '', checkedAt: access.checkedAt || null,
      channelReason: confirmed ? ''
        : !configured ? 'доступ к измерениям MAX не сохранён'
          : access.status === 'error' ? `доступ не подтверждён (${access.statusCode || 'ошибка'}): исправьте доступ или канал и повторите проверку`
            : !row?.chat_id ? 'канал не подтверждён: выполните проверку доступа'
              : row.access_revision !== access.revision ? 'доступ изменился после подтверждения: проверьте заново'
                : 'проверка доступа не подтвердила подключение',
    };
  }

  // Готовность к сбору без сетевых вызовов: по сохранённому состоянию.
  function ready(current) {
    const state = get(current);
    return {ok: state.channelConfirmed, reason: state.channelReason, chatId: state.channelId,
      accountRef: state.channelAccountRef, accessRevision: state.revision};
  }

  /* Отпечаток привязки без секрета: провайдер, ревизия, канал, исходная запись аккаунта и
     подтверждённость. Любая смена между началом и концом обращения отбрасывает результат. */
  function bindingFingerprint(current) {
    const state = get(current);
    if (!state.configured) return null;
    return `${MAX_PROVIDER}:${state.revision}:${state.channelId || 'unconfirmed'}:${state.channelAccountRef || 'unset'}:${state.channelConfirmed ? 'confirmed' : 'unconfirmed'}`;
  }

  // Токен той ревизии, с которой начато обращение. Наружу не уходит.
  function tokenOf(company, revision) {
    const access = credentials.resolve(company, MAX_PROVIDER);
    if (!access) fail('MISSING_ACCESS', 'Доступ к измерениям MAX не настроен.', 409);
    if (access.revision !== revision) throw revisionConflict();
    if (access.unreadable || typeof access.credential !== 'string' || !TOKEN_FORMAT.test(access.credential))
      fail('CREDENTIAL_UNREADABLE', 'Сохранённый доступ MAX не читается: сохраните токен заново.', 409);
    return access.credential;
  }

  /* Один GET к фиксированному адресу MAX. Путь собирается только из канонического chat_id,
     строка запроса — только из проверенных параметров. Срок держится до конца чтения тела. */
  async function request(token, path, params, signals, kind) {
    const target = new URL(`${path}${params.length ? `?${params.join('&')}` : ''}`, MAX_API_ORIGIN).href;
    const scope = callScope(deadline, [stopController.signal, ...signals]);
    try {
      let response;
      try {
        response = await untilAborted(() => fetchImpl(target, {method: 'GET',
          headers: {authorization: token, accept: 'application/json'}, redirect: 'error', signal: scope.signal}), scope.signal);
      } catch (error) {
        if (scope.signal.aborted) throw abortError(scope.signal);
        if (['TIMEOUT', 'STOPPED'].includes(error?.code)) throw error;
        throw failure('CONNECTION_UNCERTAIN', 'MAX не ответил.', 504);
      }
      const status = acceptResponse(response, target);
      if (status !== 200) {
        discard(response);
        throw upstreamFailure(status, kind);
      }
      return await readJsonLimited(response, scope.signal, limit);
    } finally { scope.done(); }
  }

  /* Снятие подтверждения ровно той ревизии, на которой получен постоянный отказ. Отметка
     склада — CAS по ревизии, строка привязки очищается только для этой же ревизии: новый
     сохранённый доступ и другие компании не затрагиваются. Сбой записи не подменяет
     исходную безопасную причину. */
  function withdraw(company, revision, failureCode) {
    try {
      atomically('social_max_withdraw', () => {
        credentials.markChecked(company, MAX_PROVIDER, {revision, status: 'error', code: failureCode});
        db.prepare(`UPDATE social_max_channels SET chat_id='',checked_at=NULL
          WHERE company_code=? COLLATE NOCASE AND access_revision=?`).run(company, revision);
      });
    } catch { /* отзыв не записан; наружу уходит исходная причина */ }
  }

  /* Проверка привязки. accountRef — запись канала из СОХРАНЁННОГО аккаунта аналитики компании,
     модуль её не угадывает и идентичность канала из тела ответа не берёт. accountRefNow —
     необязательное чтение актуальной записи после сети. */
  async function verifyRun(current, {accountRef = '', accountRefNow, actor = {}, signal} = {}) {
    const company = code(current);
    ensureOpen(signal);
    const before = credentials.get(company, MAX_PROVIDER);
    if (!before?.configured) fail('MISSING_ACCESS', 'Доступ к измерениям MAX не настроен.', 409);
    const revision = before.revision;
    const ref = maxChatRef(accountRef);
    // Поздняя проверка: остановка, отмена, новая ревизия или другая запись аккаунта отбрасывают результат.
    const late = () => {
      if (closing || signal?.aborted) return stopError();
      const after = credentials.get(company, MAX_PROVIDER);
      if (!after?.configured || after.revision !== revision) return revisionConflict();
      if (typeof accountRefNow === 'function') {
        let key = null;
        try { key = maxChatRef(accountRefNow()).key; } catch { key = null; }
        if (key !== ref.key) return revisionConflict();
      }
      return null;
    };
    const reject = (error) => {
      const safe = ownError(error);
      if (DECISIVE.has(safe.code)) {
        const stale = late();
        if (stale) throw stale;
        withdraw(company, revision, safe.code);
      }
      throw safe;
    };
    try {
      if (ref.kind === 'none') fail('CHANNEL_REF_REQUIRED', 'Укажите в аккаунте аналитики числовой chat_id канала MAX. Без точного канала доступ не подтверждается.', 409);
      if (ref.kind === 'invalid') fail('CHANNEL_REF_INVALID', 'Запись канала в аккаунте аналитики не распознана: нужен числовой chat_id канала MAX.', 409);
      const token = tokenOf(company, revision);
      const botId = botOf(await request(token, '/me', [], [signal], 'me'));
      channelOf(await request(token, `/chats/${ref.chatId}`, [], [signal], 'chat'), ref.chatId);
      checkMembership(await request(token, `/chats/${ref.chatId}/members/me`, [], [signal], 'membership'), botId);
    } catch (error) { reject(error); }
    const stale = late();
    if (stale) throw stale;
    let taken = false;
    try {
      atomically('social_max_bind', () => {
        const other = db.prepare(`SELECT company_code FROM social_max_channels
          WHERE chat_id=? AND company_code<>? COLLATE NOCASE`).get(ref.chatId, company);
        if (other) { taken = true; throw failure('CHANNEL_TAKEN', 'Канал MAX уже привязан к другой компании.', 409); }
        db.prepare(`INSERT INTO social_max_channels(company_code,chat_id,access_revision,account_ref,checked_at,actor_id,actor_name)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT(company_code) DO UPDATE SET chat_id=excluded.chat_id,
          access_revision=excluded.access_revision,account_ref=excluded.account_ref,checked_at=excluded.checked_at,
          actor_id=excluded.actor_id,actor_name=excluded.actor_name`)
          .run(company, ref.chatId, revision, ref.key, stamp(),
            Number.isSafeInteger(actor?.userId) ? actor.userId : null,
            typeof actor?.userName === 'string' ? actor.userName.slice(0, 200) : null);
        const marked = credentials.markChecked(company, MAX_PROVIDER, {revision, status: 'connected'});
        if (!marked?.applied) throw revisionConflict();
      });
    } catch (error) {
      if (taken) reject(error);
      if (error?.code === 'REVISION_CONFLICT') throw revisionConflict();
      throw failure('STORAGE_ERROR', 'Привязку канала MAX не удалось сохранить.', 500);
    }
    return get(company);
  }

  /* Привязка, с которой начинается чтение. Без подтверждённого канала сети нет. */
  function boundAccess(company) {
    const state = get(company);
    if (!state.configured) fail('MISSING_ACCESS', 'Доступ к измерениям MAX не настроен.', 409);
    if (!state.channelConfirmed) fail('BINDING_UNCONFIRMED', 'Канал MAX не подтверждён: выполните проверку доступа.', 409);
    return {chatId: state.channelId, revision: state.revision, fingerprint: bindingFingerprint(company)};
  }
  const readLate = (company, binding, signal) => {
    if (closing || signal?.aborted) return stopError();
    return bindingFingerprint(company) === binding.fingerprint ? null : revisionConflict();
  };
  // Постоянный отказ снимает только ту привязку, с которой начато чтение, и только если она не сменилась.
  function readFailure(company, binding, signal, error) {
    const safe = ownError(error);
    if (DECISIVE.has(safe.code)) {
      const stale = readLate(company, binding, signal);
      if (stale) throw stale;
      withdraw(company, binding.revision, safe.code);
    }
    throw safe;
  }

  async function readChannelRun(current, {signal} = {}) {
    const company = code(current);
    ensureOpen(signal);
    const binding = boundAccess(company);
    let data;
    try {
      const token = tokenOf(company, binding.revision);
      data = channelOf(await request(token, `/chats/${binding.chatId}`, [], [signal], 'chat'), binding.chatId);
    } catch (error) { readFailure(company, binding, signal, error); }
    const stale = readLate(company, binding, signal);
    if (stale) throw stale;
    return {companyCode: company, chatId: binding.chatId, accessRevision: binding.revision, observedAt: stamp(), data};
  }

  async function readMessagesRun(current, query, {signal} = {}) {
    const company = code(current);
    ensureOpen(signal);
    const plan = messagePlan(query);
    const binding = boundAccess(company);
    // Режим времени всегда идёт по СОХРАНЁННОМУ chat_id; известные ID — только message_ids.
    const params = plan.ids ? plan.params : [`chat_id=${binding.chatId}`, ...plan.params];
    let messages;
    try {
      const token = tokenOf(company, binding.revision);
      messages = messagesOf(await request(token, '/messages', params, [signal], 'messages'), binding.chatId, plan);
    } catch (error) { readFailure(company, binding, signal, error); }
    const stale = readLate(company, binding, signal);
    if (stale) throw stale;
    return {companyCode: company, chatId: binding.chatId, accessRevision: binding.revision, observedAt: stamp(),
      data: {messages}};
  }

  // Каждое обращение учитывается: stop() дожидается их завершения, наружу — только безопасные ошибки.
  const tracked = (run) => (...args) => {
    if (closing) return Promise.reject(stopError());
    const promise = Promise.resolve().then(() => run(...args)).catch((error) => { throw ownError(error); });
    active.add(promise);
    promise.then(() => active.delete(promise), () => active.delete(promise));
    return promise;
  };

  // Остановка процесса: текущие ожидания прерываются, поздние результаты не записываются.
  function stop() {
    closing = true;
    if (!stopController.signal.aborted) stopController.abort(stopError());
    return Promise.allSettled([...active]).then(() => undefined);
  }

  return {get, ready, bindingFingerprint, verify: tracked(verifyRun), readChannel: tracked(readChannelRun),
    readMessages: tracked(readMessagesRun), stop};
}

module.exports = {createSocialMaxAccess, maxChatRef, normalizeMaxId, MAX_PROVIDER, MAX_API_ORIGIN,
  MAX_DECISIVE_CODES: DECISIVE_CODES, MAX_TEMPORARY_CODES: TEMPORARY_CODES};
