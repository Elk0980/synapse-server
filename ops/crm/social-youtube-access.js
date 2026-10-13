'use strict';
/* Доступ к ИЗМЕРЕНИЯМ YouTube выбранной компании и подтверждение её канала.

   Это не подключение публикаций. Ключ публикаций (Onlypult) сюда не попадает и в Google API
   не отправляется: у измерений свой доступ, своя ревизия и своя проверка. Хранение
   переиспользует существующий зашифрованный склад social_analytics_credentials под ОТДЕЛЬНЫМ
   провайдером youtube_analytics — его AAD включает имя провайдера, поэтому конверт аналитики
   Onlypult и конверт YouTube не расшифровываются друг за друга даже одним серверным ключом.

   Секреты не покидают модуль: наружу уходят только «настроен/не настроен», состояние проверки,
   подтверждённый channel ID и его название. Access token не сохраняется в базу вообще — он
   живёт в памяти процесса до истечения и привязан к ревизии доступа.

   Приложение Google, OAuth-согласие и права здесь не создаются: модуль принимает уже
   выданный владельцем refresh token и работает только на чтение.

   Сетевые правила (spec 092 FR001): запросы уходят только на фиксированные адреса Google,
   перенаправления не исполняются (redirect:'error', а 3xx/redirected/opaque от любой
   реализации fetch отклоняются без чтения Location), тело читается только потоком с пределом
   в байтах, срок и отмена охватывают ожидание fetch, чтение и закрытие тела. */

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DATA_API_CHANNELS = 'https://www.googleapis.com/youtube/v3/channels';
const ANALYTICS_REPORTS = 'https://youtubeanalytics.googleapis.com/v2/reports';
/* Единственные адреса, куда уходит доступ, и разрешённые параметры каждого. Адрес и параметры
   снаружи не расширяются: ни учётных данных в URL, ни ключа в строке запроса. */
const API_PARAMS = Object.freeze({
  [DATA_API_CHANNELS]: Object.freeze(['part', 'mine', 'forHandle', 'maxResults']),
  [ANALYTICS_REPORTS]: Object.freeze(['ids', 'startDate', 'endDate', 'dimensions', 'sort', 'metrics']),
});
/* channels.list принимает ровно один фильтр (developers.google.com/youtube/v3/docs/channels/list,
   сверено Root 13.10): ручка разрешается отдельным запросом forHandle, свой канал — отдельным mine. */
const CHANNEL_FILTERS = Object.freeze(['mine', 'forHandle']);
// Минимально необходимые области чтения. Ничего, что позволяет публиковать или менять канал.
const SCOPES = Object.freeze(['https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly']);
const PROVIDER = 'youtube_analytics';
const TIMEOUT_MS = 10000;
// Предел ответа в БАЙТАХ: многобайтный текст иначе считается вдвое короче предела.
const MAX_BYTES = 256 * 1024;
// Запас до истечения access token: на границе срока параллельный запрос не должен уйти с мёртвым токеном.
const EXPIRY_SKEW_MS = 60000;
const MAX_TOKEN_TTL_MS = 24 * 3600 * 1000;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const HANDLE = /^[\p{L}\p{M}\p{N}._-]{3,30}$/u;
// Токен уходит в заголовок: управляющие символы и пробелы недопустимы.
const TOKEN_FORMAT = /^[\x21-\x7e]{1,4096}$/;
const CHANNEL_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com']);

/* Постоянные причины: доступ ЭТОЙ ревизии больше не подтверждает канал, и подтверждение
   снимается. Временные причины подтверждение не трогают: квота или зависший ответ — не отзыв. */
const DECISIVE_CODES = Object.freeze(['ACCESS_DENIED', 'CREDENTIAL_UNREADABLE', 'NOT_FOUND', 'SCOPE_MISMATCH',
  'CHANNEL_MISMATCH', 'CHANNEL_AMBIGUOUS', 'CHANNEL_HANDLE_UNRESOLVED', 'CHANNEL_REF_REQUIRED', 'CHANNEL_REF_INVALID']);
const TEMPORARY_CODES = Object.freeze(['RATE_LIMITED', 'TIMEOUT', 'STOPPED', 'CONNECTION_UNCERTAIN', 'UPSTREAM_ERROR',
  'UPSTREAM_REDIRECT', 'RESPONSE_UNCERTAIN', 'RESPONSE_TOO_LARGE', 'SCOPE_UNCONFIRMED']);
const DECISIVE = new Set(DECISIVE_CODES);
const KNOWN = new Set([...DECISIVE_CODES, ...TEMPORARY_CODES, 'MISSING_ACCESS', 'REVISION_CONFLICT',
  'BAD_ENDPOINT', 'BAD_REQUEST', 'VALIDATION_ERROR']);

const failure = (code, message, status = 502) => Object.assign(new Error(message), {code, status});
const fail = (code, message, status = 502) => { throw failure(code, message, status); };
const timeoutError = () => failure('TIMEOUT', 'Google не ответил вовремя.', 504);
const stopError = () => failure('STOPPED', 'Обращение к Google остановлено.', 503);
// Код отмены по причине сигнала: срок — TIMEOUT, остановка модуля и внешний сигнал — STOPPED.
const abortError = (signal) => {
  const reason = signal?.reason;
  return reason?.code === 'TIMEOUT' || reason?.name === 'TimeoutError' ? timeoutError() : stopError();
};
const ownAbort = (error) => (error?.code === 'TIMEOUT' || error?.name === 'TimeoutError' ? timeoutError()
  : error?.code === 'STOPPED' || error?.name === 'AbortError' ? stopError() : null);
// Наружу — только наши коды и тексты: сырое исключение могло бы нести адрес или текст Google.
const ownError = (error) => (KNOWN.has(error?.code) && typeof error.message === 'string' ? error
  : failure('UPSTREAM_ERROR', 'Обращение к Google завершилось ошибкой.'));

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
// Сигнал одного вызова: свой срок, общий срок/отмена вызывающего и остановка модуля.
function callScope(ms, signals) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(timeoutError()), ms);
  return {signal: AbortSignal.any([controller.signal, ...signalsOf(signals)]), done: () => clearTimeout(timer)};
}
// Закрытие тела без ожидания: зависший cancel не должен держать вызов.
const discard = (response) => {
  try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch { /* тело уже недоступно */ }
};

/* Ограниченное чтение ответа. Только поток: ответ без потока не читается вовсе, потому что
   response.text() материализует тело целиком до любой проверки размера. Объявленная длина
   сверх предела отклоняется до чтения; фактический размер проверяется на каждом куске. */
async function readJsonLimited(response, signal) {
  let declared = NaN;
  try { declared = Number(response.headers?.get?.('content-length')); } catch { declared = NaN; }
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    discard(response);
    fail('RESPONSE_TOO_LARGE', 'Ответ Google слишком большой.');
  }
  let reader = null;
  try { reader = typeof response.body?.getReader === 'function' ? response.body.getReader() : null; }
  catch { reader = null; }
  if (!reader) fail('RESPONSE_UNCERTAIN', 'Ответ Google пришёл без потока: без предела размера он не читается.');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await untilAborted(() => reader.read(), signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) fail('RESPONSE_UNCERTAIN', 'Ответ Google пришёл в неожиданном виде.');
      size += value.byteLength;
      if (size > MAX_BYTES) fail('RESPONSE_TOO_LARGE', 'Ответ Google слишком большой.');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    // Отмена без ожидания: поддельный или зависший поток может не завершить cancel никогда.
    Promise.resolve().then(() => reader.cancel()).catch(() => {});
    if (['RESPONSE_TOO_LARGE', 'RESPONSE_UNCERTAIN', 'TIMEOUT', 'STOPPED'].includes(error?.code)) throw error;
    fail('CONNECTION_UNCERTAIN', 'Google не дочитал ответ.', 504);
  }
  let text;
  try { text = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)); }
  catch { return fail('RESPONSE_UNCERTAIN', 'Ответ Google не разобран.'); }
  try { return JSON.parse(text); } catch { return fail('RESPONSE_UNCERTAIN', 'Ответ Google не разобран.'); }
}

/* Перенаправление не исполняется и не читается: тело с секретом не должно уйти по чужому
   адресу, а ответ чужого адреса — стать «ответом Google». */
function acceptResponse(response, requested) {
  if (!response || typeof response !== 'object') fail('RESPONSE_UNCERTAIN', 'Ответ Google не распознан.');
  const status = response.status;
  const moved = response.type === 'opaqueredirect' || response.type === 'opaque' || response.redirected === true
    || (Number.isInteger(status) && status >= 300 && status < 400)
    || (typeof response.url === 'string' && response.url !== '' && response.url !== requested);
  if (moved) {
    discard(response);
    fail('UPSTREAM_REDIRECT', 'Google ответил перенаправлением: запрос по другому адресу не повторялся.');
  }
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    discard(response);
    fail('RESPONSE_UNCERTAIN', 'Ответ Google не распознан.');
  }
  return status;
}

/* Разбор ТОЛЬКО известных причин отказа из ограниченно прочитанного JSON. Наружу уходит
   лишь наш код: ни тела ответа, ни токена, ни адреса. Квота — временная причина, поэтому
   отличать её от отсутствия прав обязательно: иначе дата снималась бы с повторов навсегда. */
const TEMPORARY_REASONS = new Set(['quotaexceeded', 'ratelimitexceeded', 'dailylimitexceeded',
  'userratelimitexceeded', 'backenderror', 'internalerror', 'servicerestricted']);
function failureReason(body) {
  const error = body && typeof body === 'object' && !Array.isArray(body) ? body.error : null;
  if (!error || typeof error !== 'object') return '';
  const list = Array.isArray(error.errors) ? error.errors : [];
  for (const item of list.slice(0, 5)) {
    const reason = typeof item?.reason === 'string' ? item.reason.toLowerCase() : '';
    if (reason) return reason;
  }
  const status = typeof error.status === 'string' ? error.status.toLowerCase() : '';
  return status === 'resource_exhausted' ? 'quotaexceeded' : '';
}

// Отказы OAuth: отзыв/недействительный grant — постоянный отказ, прочее 400 — ошибка обмена.
const OAUTH_DENIED = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'access_denied']);
function oauthFailure(status, body) {
  const error = body && typeof body === 'object' && !Array.isArray(body) && typeof body.error === 'string'
    ? body.error.toLowerCase() : '';
  if (OAUTH_DENIED.has(error) || status === 401)
    return failure('ACCESS_DENIED', 'Google отклонил обновление доступа: refresh token недействителен или отозван, нужна новая авторизация владельца.');
  if (status === 429 || TEMPORARY_REASONS.has(failureReason(body)))
    return failure('RATE_LIMITED', 'Google временно ограничил обновление доступа: повторите позже.', 503);
  if (status === 403) return failure('ACCESS_DENIED', 'Google отказал в обновлении доступа к измерениям YouTube.');
  return failure('UPSTREAM_ERROR', 'Google вернул ошибку при обновлении доступа.');
}
const API_REASON = Object.freeze({
  400: ['UPSTREAM_ERROR', 'YouTube отклонил запрос измерений.'],
  401: ['ACCESS_DENIED', 'YouTube не принял доступ к измерениям: требуется новая авторизация владельца.'],
  403: ['ACCESS_DENIED', 'YouTube отказал в доступе: не хватает прав чтения.'],
  404: ['NOT_FOUND', 'YouTube не нашёл канал по выданному доступу.'],
  429: ['RATE_LIMITED', 'YouTube временно ограничил обращения: повторите позже.'],
});
/* 403 у YouTube означает и «нет прав», и «квота исчерпана». Это РАЗНЫЕ состояния: отсутствие
   прав постоянно, квота временна. Различие берётся из известной причины ответа. */
function apiFailure(status, body) {
  if (TEMPORARY_REASONS.has(failureReason(body)))
    return failure('RATE_LIMITED', 'YouTube временно ограничил обращения (квота или частота): повторите позже.', 503);
  const known = API_REASON[status];
  if (known) return failure(known[0], known[1], known[0] === 'RATE_LIMITED' ? 503 : 502);
  return failure('UPSTREAM_ERROR', 'YouTube вернул ошибку.');
}

/* Области доступа из ответа Google. Пустой ответ ничего не подтверждает; лишняя область
   (например, полное управление каналом) делает доступ шире чтения и не принимается. */
function checkScopes(scope) {
  const granted = typeof scope === 'string' ? scope.split(/\s+/).filter(Boolean) : [];
  if (!granted.length) fail('SCOPE_UNCONFIRMED', 'Google не подтвердил области доступа: измерения не запрашиваются.', 409);
  if (granted.some((item) => !SCOPES.includes(item)))
    fail('SCOPE_MISMATCH', 'Выданный доступ шире чтения измерений: выдайте доступ только youtube.readonly и yt-analytics.readonly.', 409);
  if (SCOPES.some((item) => !granted.includes(item)))
    fail('SCOPE_MISMATCH', 'Выданному доступу не хватает прав чтения youtube.readonly и yt-analytics.readonly.', 409);
}

/* Разбор введённого доступа. Принимается компактный JSON владельца с уже выданным
   refresh token; ни одного поля больше — незнакомое поле отклоняется, чтобы в зашифрованный
   конверт не попало то, о чём модуль не знает. */
function parseCredential(raw) {
  let value;
  try { value = JSON.parse(raw); }
  catch { return fail('CREDENTIAL_UNREADABLE', 'Доступ к измерениям YouTube ожидается в виде JSON с полями clientId, clientSecret, refreshToken.', 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('CREDENTIAL_UNREADABLE', 'Доступ к измерениям YouTube ожидается объектом JSON.', 400);
  const allowed = ['clientId', 'clientSecret', 'refreshToken'];
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) fail('CREDENTIAL_UNREADABLE', `Неизвестное поле доступа «${extra[0]}».`, 400);
  for (const key of allowed) {
    if (typeof value[key] !== 'string' || !value[key].trim())
      fail('CREDENTIAL_UNREADABLE', `Заполните поле ${key}.`, 400);
    if (/[\u0000-\u001f\u007f]/.test(value[key])) fail('CREDENTIAL_UNREADABLE', `Поле ${key} содержит недопустимые символы.`, 400);
  }
  // Компактная запись без пробелов: существующий склад не принимает пробелы в значении ключа.
  return {clientId: value.clientId.trim(), clientSecret: value.clientSecret.trim(), refreshToken: value.refreshToken.trim()};
}

/* Запись канала в аккаунте аналитики → однозначный ключ. Принимаются UC-идентификатор,
   официальная ссылка youtube.com/channel/UC… и @ручка (в том числе ссылкой youtube.com/@…).
   Ручка сама по себе канал не подтверждает: её разрешает отдельный запрос forHandle. */
const INVALID_REF = Object.freeze({kind: 'invalid', key: ''});
const handleRef = (name) => (HANDLE.test(name)
  ? {kind: 'handle', key: `@${name.toLowerCase()}`, handle: name} : INVALID_REF);
function youtubeChannelRef(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return {kind: 'none', key: ''};
  if (CHANNEL_ID.test(raw)) return {kind: 'id', key: raw, channelId: raw};
  if (raw.startsWith('@')) return handleRef(raw.slice(1));
  if (!/^https:\/\//i.test(raw)) return INVALID_REF;
  let url;
  try { url = new URL(raw); } catch { return INVALID_REF; }
  if (url.protocol !== 'https:' || !CHANNEL_HOSTS.has(url.hostname) || url.username || url.password || url.port)
    return INVALID_REF;
  const path = url.pathname.replace(/\/+$/, '');
  const id = /^\/channel\/(UC[A-Za-z0-9_-]{22})$/.exec(path);
  if (id) return {kind: 'id', key: id[1], channelId: id[1]};
  const handle = /^\/@([^/]+)$/.exec(path);
  if (!handle) return INVALID_REF;
  try { return handleRef(decodeURIComponent(handle[1])); } catch { return INVALID_REF; }
}

/* Сохранённая ссылка на канал компании. ID канала секретом не является и показывается
   владельцу — поэтому он лежит открытым текстом рядом с подтверждением, а не в конверте. */
/* Срок ответа настраиваемый, но по умолчанию боевой. Он нужен проверкам: без него офлайн
   тест зависшего тела ждал бы полные десять секунд и тормозил весь набор. Снаружи запроса
   значение не принимается — только при создании модуля на сервере. */
function createSocialYoutubeAccess(db, {credentials, fetchImpl = fetch, now = () => Date.now(),
  timeoutMs = TIMEOUT_MS} = {}) {
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, TIMEOUT_MS) : TIMEOUT_MS;
  if (!credentials?.resolve) throw new Error('Доступ к измерениям YouTube требует склада аналитических доступов');
  db.exec(`CREATE TABLE IF NOT EXISTS social_youtube_channels (
    company_code TEXT PRIMARY KEY COLLATE NOCASE,
    channel_id TEXT NOT NULL DEFAULT '', channel_title TEXT NOT NULL DEFAULT '',
    access_revision INTEGER NOT NULL DEFAULT 0, account_ref TEXT NOT NULL DEFAULT '',
    checked_at TEXT, actor_id INTEGER, actor_name TEXT);`);

  const code = (value) => {
    if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)) fail('NOT_FOUND', 'Компания не найдена', 404);
    return value.toLowerCase();
  };
  const stamp = () => new Date(now()).toISOString();
  const channelRow = (current) => db.prepare(
    'SELECT * FROM social_youtube_channels WHERE company_code=? COLLATE NOCASE').get(current) || null;
  // Остановка модуля: прерывает все ожидания и не даёт начать новые запросы.
  const stopController = new AbortController();

  /* Access token в памяти: в базу он не пишется. Ключ кэша включает ревизию доступа —
     после смены refresh token прежний access token к нему не относится и не переиспользуется. */
  const tokens = new Map();
  const inflight = new Map();

  /* Один запрос к фиксированному адресу Google. Срок держится до конца чтения тела: иначе
     зависшее тело осталось бы без срока и держало последовательный обход расписания. */
  async function exchange(target, init, signals, onError) {
    const scope = callScope(deadline, [stopController.signal, ...signals]);
    try {
      let response;
      try {
        response = await untilAborted(() => fetchImpl(target, {...init, redirect: 'error', signal: scope.signal}), scope.signal);
      } catch (error) { throw ownAbort(error) || failure('CONNECTION_UNCERTAIN', 'Google не ответил.', 504); }
      const status = acceptResponse(response, target);
      if (status < 200 || status > 299) {
        // Тело читается ограниченно и только чтобы отличить временную квоту от отказа в правах.
        let body = null;
        try { body = await readJsonLimited(response, scope.signal); }
        catch (error) { if (['TIMEOUT', 'STOPPED'].includes(error?.code)) throw error; body = null; }
        throw onError(status, body);
      }
      return await readJsonLimited(response, scope.signal);
    } finally { scope.done(); }
  }

  async function fetchToken(current, secret, revision) {
    const body = await exchange(OAUTH_TOKEN_URL, {method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json'},
      body: new URLSearchParams({client_id: secret.clientId, client_secret: secret.clientSecret,
        refresh_token: secret.refreshToken, grant_type: 'refresh_token'}).toString()}, [], oauthFailure);
    const token = typeof body?.access_token === 'string' ? body.access_token : '';
    if (!TOKEN_FORMAT.test(token)) fail('RESPONSE_UNCERTAIN', 'Google не вернул рабочий доступ.');
    // Области проверяются ДО первого запроса к API: широкий или неподтверждённый доступ не используется.
    checkScopes(body.scope);
    const ttl = Number.isFinite(body.expires_in) && body.expires_in > 0
      ? Math.min(body.expires_in * 1000, MAX_TOKEN_TTL_MS) : 300000;
    const entry = {token, expiresAt: now() + ttl, revision};
    if (!stopController.signal.aborted) tokens.set(current, entry);
    return entry;
  }

  /* Обновление токена под одним замком на компанию: параллельные сборы не выпускают
     несколько обновлений подряд (Google считает это подозрительной активностью и может
     отозвать refresh token). Ждущие получают тот же результат, включая ошибку; каждый ждёт
     не дольше своего срока и своей отмены. */
  async function accessToken(current, {signal} = {}) {
    const company = code(current);
    const wait = AbortSignal.any(signalsOf([stopController.signal, signal]));
    if (wait.aborted) throw abortError(wait);
    const access = credentials.resolve(company, PROVIDER);
    if (!access) fail('MISSING_ACCESS', 'Доступ к измерениям YouTube не настроен.', 409);
    if (access.unreadable) fail('CREDENTIAL_UNREADABLE', 'Сохранённый доступ к измерениям YouTube не читается: сохраните его заново.', 409);
    const cached = tokens.get(company);
    if (cached && cached.revision === access.revision && cached.expiresAt - EXPIRY_SKEW_MS > now())
      return {token: cached.token, revision: access.revision};
    const key = `${company}|${access.revision}`;
    let pending = inflight.get(key);
    if (!pending) {
      const secret = parseCredential(access.credential);
      pending = fetchToken(company, secret, access.revision).finally(() => inflight.delete(key));
      // Ожидающий мог уйти по своему сроку: отказ общего обмена не должен стать необработанным.
      pending.catch(() => {});
      inflight.set(key, pending);
    }
    const entry = await untilAborted(() => pending, wait);
    return {token: entry.token, revision: access.revision};
  }

  // Запрос к официальному хосту с уже полученным токеном. Адрес снаружи не принимается.
  async function callApi(url, token, params, {signal} = {}) {
    const allowed = typeof url === 'string' && Object.hasOwn(API_PARAMS, url) ? API_PARAMS[url] : null;
    if (!allowed) fail('BAD_ENDPOINT', 'Адрес запроса не входит в разрешённые адреса YouTube.', 500);
    if (typeof token !== 'string' || !TOKEN_FORMAT.test(token)) fail('BAD_REQUEST', 'Доступ для запроса YouTube не годится.', 500);
    if (!params || typeof params !== 'object' || Array.isArray(params)) fail('BAD_REQUEST', 'Параметры запроса YouTube не заданы.', 500);
    const target = new URL(url);
    for (const [key, value] of Object.entries(params)) {
      if (!allowed.includes(key)) fail('BAD_REQUEST', `Параметр ${key} не разрешён для этого запроса.`, 500);
      if (!['string', 'number', 'boolean'].includes(typeof value) || /[\u0000-\u001f\u007f]/.test(String(value)))
        fail('BAD_REQUEST', `Параметр ${key} задан недопустимо.`, 500);
      target.searchParams.set(key, String(value));
    }
    if (url === DATA_API_CHANNELS && CHANNEL_FILTERS.filter((key) => Object.hasOwn(params, key)).length !== 1)
      fail('BAD_REQUEST', 'Запрос каналов допускает ровно один фильтр: mine или forHandle.', 500);
    return exchange(target.toString(), {method: 'GET',
      headers: {authorization: `Bearer ${token}`, accept: 'application/json'}}, [signal], apiFailure);
  }

  const forgetDenied = (company, revision, error) => {
    if (error?.code === 'ACCESS_DENIED' && tokens.get(company)?.revision === revision) tokens.delete(company);
  };

  /* Свой канал по выданному доступу. mine=true намеренно: угадывать чужой канал по строке
     из настроек нельзя, подтверждение даёт сам доступ. */
  async function channelOfAccess(current, {signal} = {}) {
    const company = code(current);
    const {token, revision} = await accessToken(company, {signal});
    let body;
    try { body = await callApi(DATA_API_CHANNELS, token, {part: 'snippet,statistics', mine: 'true', maxResults: 5}, {signal}); }
    catch (error) { forgetDenied(company, revision, error); throw error; }
    const items = Array.isArray(body?.items) ? body.items : [];
    if (!items.length) fail('NOT_FOUND', 'Выданный доступ не показывает ни одного канала YouTube.');
    if (items.length > 1) fail('CHANNEL_AMBIGUOUS', 'Выданный доступ показывает несколько каналов: выдайте доступ ровно к одному каналу компании.', 409);
    const item = items[0];
    const id = typeof item?.id === 'string' ? item.id : '';
    if (!CHANNEL_ID.test(id)) fail('RESPONSE_UNCERTAIN', 'YouTube не вернул идентификатор канала в ожидаемом виде.');
    const stats = item.statistics || {};
    // customUrl — только справочно: идентичность канала подтверждается нативным UC ID.
    const customUrl = typeof item.snippet?.customUrl === 'string' ? item.snippet.customUrl.trim() : '';
    /* subscriberCount округляется вниз до трёх значащих цифр; скрытое или отсутствующее
       поле — НЕ ноль, а неизвестность. Здесь это различие сохраняется как есть. */
    const hidden = stats.hiddenSubscriberCount === true;
    const rawSubscribers = typeof stats.subscriberCount === 'string' && /^\d+$/.test(stats.subscriberCount)
      && Number.isSafeInteger(Number(stats.subscriberCount)) ? Number(stats.subscriberCount) : null;
    return {
      channelId: id,
      handle: customUrl.replace(/^@/, '').toLowerCase(),
      title: typeof item.snippet?.title === 'string' ? item.snippet.title.slice(0, 200) : '',
      subscribers: hidden ? null : rawSubscribers,
      hiddenSubscriberCount: hidden,
      subscribersUnknownReason: hidden ? 'канал скрывает число подписчиков'
        : rawSubscribers === null ? 'YouTube не вернул число подписчиков' : '',
      accessRevision: revision,
      observedAt: stamp(),
    };
  }

  /* Разрешение @ручки в UC ID отдельным официальным запросом forHandle. Сравнивать ручку
     с snippet.customUrl нельзя: их соответствие для всех каналов не доказано. */
  async function resolveHandle(current, handle, {signal} = {}) {
    const company = code(current);
    const ref = handleRef(typeof handle === 'string' ? handle.replace(/^@/, '') : '');
    if (ref.kind !== 'handle') fail('CHANNEL_REF_INVALID', 'Ручка канала записана в недопустимом виде.', 409);
    const {token, revision} = await accessToken(company, {signal});
    let body;
    try { body = await callApi(DATA_API_CHANNELS, token, {part: 'id', forHandle: `@${ref.handle}`}, {signal}); }
    catch (error) { forgetDenied(company, revision, error); throw error; }
    const items = Array.isArray(body?.items) ? body.items : [];
    if (!items.length) fail('CHANNEL_HANDLE_UNRESOLVED', 'YouTube не нашёл канал по указанной @ручке: проверьте её или укажите идентификатор вида UC….', 409);
    if (items.length > 1) fail('CHANNEL_AMBIGUOUS', 'Ручка указывает на несколько каналов: укажите идентификатор вида UC….', 409);
    const id = typeof items[0]?.id === 'string' ? items[0].id : '';
    if (!CHANNEL_ID.test(id)) fail('RESPONSE_UNCERTAIN', 'YouTube не вернул идентификатор канала в ожидаемом виде.');
    return {channelId: id, accessRevision: revision};
  }

  /* Сохранение доступа владельцем. Валидация формата — до шифрования, чтобы в конверт
     не попал непригодный ключ. Подтверждение канала после смены доступа сбрасывается:
     прежнее «канал подтверждён» к новому доступу не относится. */
  function saveAccess(current, body, actor = {}) {
    const company = code(current);
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('VALIDATION_ERROR', 'Проверьте поля доступа', 400);
    const extra = Object.keys(body).filter((key) => !['revision', 'credential'].includes(key));
    if (extra.length) fail('VALIDATION_ERROR', `Неизвестное поле доступа «${extra[0]}»`, 400);
    const raw = typeof body.credential === 'string' ? body.credential.trim() : '';
    const payload = raw ? JSON.stringify(parseCredential(raw)) : '';
    const saved = credentials.save(company, PROVIDER, {revision: body.revision, credential: payload}, actor);
    if (payload) {
      tokens.delete(company);
      db.prepare(`UPDATE social_youtube_channels SET channel_id='',channel_title='',access_revision=0,checked_at=NULL
        WHERE company_code=? COLLATE NOCASE`).run(company);
    }
    return saved && get(company);
  }

  function removeAccess(current, body, actor = {}) {
    const company = code(current);
    const result = credentials.remove(company, PROVIDER, body, actor);
    tokens.delete(company);
    /* История измерений и доказательства не трогаются, но подтверждение канала снимается:
       без доступа оно ничего не подтверждает. */
    db.prepare(`UPDATE social_youtube_channels SET channel_id='',channel_title='',access_revision=0,checked_at=NULL
      WHERE company_code=? COLLATE NOCASE`).run(company);
    return {...get(company), removed: Boolean(result)};
  }

  /* Проверка: доступ живой, области только чтения, канал свой и ровно тот, что записан в
     аккаунте аналитики. accountRef передаёт вызывающий (аккаунт аналитики компании) — модуль
     его не угадывает. Пустая запись не подтверждает «любой канал mine». accountRefNow —
     необязательное чтение актуальной записи после сети: смена записи во время проверки
     старую привязку не подтверждает. */
  async function verify(current, {accountRef = '', actor = {}, signal, accountRefNow} = {}) {
    const company = code(current);
    const before = credentials.get(company, PROVIDER);
    if (!before.configured) fail('MISSING_ACCESS', 'Доступ к измерениям YouTube не настроен.', 409);
    // Отметка с CAS по ревизии: результат прежнего доступа не портит новый сохранённый.
    const mark = (failureCode) => credentials.markChecked(company, PROVIDER,
      {revision: before.revision, status: 'error', code: failureCode});
    const ref = youtubeChannelRef(accountRef);
    if (ref.kind === 'none') {
      mark('CHANNEL_REF_REQUIRED');
      fail('CHANNEL_REF_REQUIRED', 'Укажите в аккаунте аналитики канал: идентификатор вида UC…, ссылку youtube.com/channel/UC… или @ручку. Без точного канала доступ не подтверждается.', 409);
    }
    if (ref.kind === 'invalid') {
      mark('CHANNEL_REF_INVALID');
      fail('CHANNEL_REF_INVALID', 'Запись канала в аккаунте аналитики не распознана: нужен идентификатор вида UC…, ссылка youtube.com/channel/UC… или @ручка.', 409);
    }
    let expected = ref.channelId || '';
    let resolvedRevision = before.revision;
    let channel;
    try {
      if (ref.kind === 'handle') {
        const resolved = await resolveHandle(company, ref.handle, {signal});
        expected = resolved.channelId;
        resolvedRevision = resolved.accessRevision;
      }
      channel = await channelOfAccess(company, {signal});
    } catch (error) {
      const safe = ownError(error);
      if (DECISIVE.has(safe.code)) mark(safe.code);
      throw safe;
    }
    // Ревизия могла измениться, пока шли запросы: результат прежнего доступа новый не подтверждает.
    const after = credentials.get(company, PROVIDER);
    if (!after.configured || after.revision !== before.revision
      || channel.accessRevision !== before.revision || resolvedRevision !== before.revision)
      fail('REVISION_CONFLICT', 'Доступ к измерениям изменился во время проверки: повторите проверку.', 409);
    if (typeof accountRefNow === 'function' && youtubeChannelRef(accountRefNow()).key !== ref.key)
      fail('REVISION_CONFLICT', 'Запись канала в аккаунте аналитики изменилась во время проверки: повторите проверку.', 409);
    if (channel.channelId !== expected) {
      mark('CHANNEL_MISMATCH');
      fail('CHANNEL_MISMATCH', 'Доступ выдан к другому каналу, чем указан в аккаунте аналитики: измерения не собираются.', 409);
    }
    db.prepare(`INSERT INTO social_youtube_channels(company_code,channel_id,channel_title,access_revision,account_ref,checked_at,actor_id,actor_name)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(company_code) DO UPDATE SET channel_id=excluded.channel_id,
      channel_title=excluded.channel_title,access_revision=excluded.access_revision,account_ref=excluded.account_ref,
      checked_at=excluded.checked_at,actor_id=excluded.actor_id,actor_name=excluded.actor_name`)
      .run(company, channel.channelId, channel.title, before.revision, ref.key, stamp(),
        Number.isSafeInteger(actor?.userId) ? actor.userId : null,
        typeof actor?.userName === 'string' ? actor.userName.slice(0, 200) : null);
    credentials.markChecked(company, PROVIDER, {revision: before.revision, status: 'connected'});
    return {...get(company), channel};
  }

  /* Отказ планового сбора. Постоянная причина (отзыв, отказ в правах, чужой или
     неоднозначный канал) снимает подтверждение именно той ревизии, с которой начат сбор;
     новый сохранённый доступ остаётся непроверенным, а временная причина ничего не меняет. */
  function markCollectFailure(current, revision, failureCode) {
    const company = code(current);
    if (!DECISIVE.has(failureCode) || !Number.isSafeInteger(revision) || revision < 0)
      return {...get(company), applied: false};
    if (tokens.get(company)?.revision === revision) tokens.delete(company);
    const result = credentials.markChecked(company, PROVIDER, {revision, status: 'error', code: failureCode});
    return {...get(company), applied: Boolean(result?.applied)};
  }

  /* Публичный вид. Ни одного поля, по которому можно восстановить доступ: только состояние,
     подтверждённый канал и явная причина, если подтверждения нет. */
  function get(current) {
    const company = code(current);
    const access = credentials.get(company, PROVIDER);
    const row = channelRow(company);
    const confirmed = Boolean(row?.channel_id) && row.access_revision === access.revision && access.checked;
    return {
      companyCode: company, provider: PROVIDER, scopes: [...SCOPES],
      configured: access.configured, status: access.status, statusCode: access.statusCode,
      revision: access.revision, checked: access.checked, checkedAt: access.checkedAt,
      channelId: confirmed ? row.channel_id : '',
      channelTitle: confirmed ? row.channel_title : '',
      channelAccountRef: row?.account_ref || '',
      channelConfirmed: confirmed,
      channelReason: confirmed ? ''
        : !access.configured ? 'доступ к измерениям не сохранён'
          : access.status === 'error' ? `доступ не подтверждён (${access.statusCode || 'ошибка'}): авторизуйте заново или исправьте канал и повторите проверку`
            : !row?.channel_id ? 'канал не подтверждён: выполните проверку доступа'
              : row.access_revision !== access.revision ? 'доступ изменился после подтверждения: проверьте заново'
                : 'проверка доступа не подтвердила подключение',
      subscriberPrecision: 'YouTube округляет число подписчиков вниз до трёх значащих цифр; скрытое значение остаётся неизвестным',
      daySystem: 'America/Los_Angeles',
    };
  }

  /* Отпечаток привязки для сборщика: ревизия доступа и подтверждённый канал, без секрета.
     По нему запоздавший ответ отбрасывается, а смена доступа или канала останавливает запись. */
  const bindingFingerprint = (current) => {
    const state = get(current);
    if (!state.configured) return null;
    /* В отпечаток входит и подтверждённая запись аккаунта: пересогласование привязки на другой
       канал во время сбора обязано отбросить ответ, а не переписать его под новой записью. */
    return `youtube_analytics:${state.revision}:${state.channelId || 'unconfirmed'}:${state.channelAccountRef || 'unset'}`;
  };

  // Готовность к сбору без сетевых вызовов: по сохранённому состоянию.
  const ready = (current) => {
    const state = get(current);
    /* accountRef — запись канала, С КОТОРОЙ подтверждение было получено. Сборщик обязан
       сверить её с актуальной настройкой аккаунта: иначе после смены записи на другой канал
       данные подтверждённого канала записались бы под новой записью. */
    return {ok: state.channelConfirmed, reason: state.channelReason, channelId: state.channelId,
      accountRef: state.channelAccountRef, revision: state.revision, state};
  };

  // Остановка процесса: текущие ожидания прерываются, новые запросы не начинаются.
  function stop() {
    if (!stopController.signal.aborted) stopController.abort(stopError());
    tokens.clear();
  }

  return {get, saveAccess, removeAccess, verify, accessToken, callApi, channelOfAccess, resolveHandle,
    markCollectFailure, bindingFingerprint, ready, stop, PROVIDER, SCOPES};
}

module.exports = {createSocialYoutubeAccess, youtubeChannelRef, YOUTUBE_ANALYTICS_PROVIDER: PROVIDER,
  YOUTUBE_READONLY_SCOPES: SCOPES, YOUTUBE_OAUTH_TOKEN_URL: OAUTH_TOKEN_URL,
  YOUTUBE_DATA_API_CHANNELS: DATA_API_CHANNELS, YOUTUBE_ANALYTICS_REPORTS: ANALYTICS_REPORTS,
  YOUTUBE_DAY_SYSTEM: 'America/Los_Angeles', YOUTUBE_MAX_RESPONSE_BYTES: MAX_BYTES,
  YOUTUBE_DECISIVE_CODES: DECISIVE_CODES, YOUTUBE_TEMPORARY_CODES: TEMPORARY_CODES};
