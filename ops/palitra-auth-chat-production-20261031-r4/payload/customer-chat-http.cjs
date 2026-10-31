'use strict';

/* Palitra PhaseB: HTTP чата сайта внутри фиксированного draftHook магазина (palitra-host-adapter), 14.10.2026.

   Только POST и только точные пути /api/customer-chat/{session,threads,messages,message,telegram-link,revoke}.
   - Origin обязан быть ровно https://<фактический адрес запроса>, и этот адрес — одобренный адрес магазина. X-Forwarded-Host,
     origin/site/user/account/Telegram ID из тела не принимаются.
   - session: доступ подтверждает существующий AccountService этого адреса (cookie магазина + его X-CSRF-Token) — гость
     (user_id = NULL) или зарегистрированный покупатель (UUID users.id); проверка до чтения тела и ещё раз после.
     Старый чат живёт своей cookie (30 дней) и своим CSRF. Новая подтверждённая account-cookie дополнительно требует
     текущую серверную личность на каждом действии; audit старых сессий не присваивает их аккаунту.
   - Остальные маршруты: cookie и CSRF чата проверяются до чтения тела и снова ядром после него.
   - Сырой секрет cookie — только в заголовке Set-Cookie; JSON его не содержит. Тело ограничено, поля — точный список. */

const crypto = require('node:crypto');
const mediaKit = require('./customer-chat-media.cjs');
// PALITRA-WEBCHAT-PHASEE: точные адреса файла покупателя (один разбор для всех слоёв).
const uploadKit = require('./customer-chat-upload.cjs');

const PREFIX = '/api/customer-chat/';
const ROUTES = Object.freeze(['session', 'threads', 'messages', 'message', 'start', 'contact', 'widget-settings', 'preliminary-profile', 'history-status', 'telegram-link', 'revoke']);
const SMALL_BODY = 2 * 1024;
const MESSAGE_BODY = 20 * 1024;         // 4000 символов кириллицы в UTF-8 + поля
const UPLOAD_BODY = 20 * 1024;          // подготовка файла: подпись до 4000 символов + имя, размер, хеш
const CHAT_CSRF_HEADER = 'x-palitra-chat-csrf';
const ACCOUNT_USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BOT_USERNAME = /^[A-Za-z][A-Za-z0-9_]{1,28}bot$/i;
const KNOWN_STATUS = new Set([400, 401, 403, 404, 405, 409, 410, 413, 415, 422, 429, 503]);

const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, code }); };
const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length > 0
  && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function json(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(text);
}
async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, 'Запрос слишком большой', 'TOO_LARGE');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch (_) { fail(400, 'Некорректный JSON', 'VALIDATION'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Ожидался JSON-объект', 'VALIDATION');
  return value;
}
/* Поля тела: обязательные ровно есть, необязательные — только из списка, лишних нет. */
function fields(body, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(body, key)) || Object.keys(body).some((key) => !allowed.has(key))) {
    fail(400, `Допустимые поля: ${[...allowed].join(', ') || 'нет'}`, 'VALIDATION');
  }
  const out = {};
  for (const key of allowed) if (Object.hasOwn(body, key)) out[key] = body[key];
  return out;
}

/**
 * @param {object} options
 * @param {() => object} options.core            принятое ядро customer-chat (через адаптер)
 * @param {string} options.site                  'palitra'
 * @param {string[]} options.origins             одобренные адреса магазина
 * @param {(req) => object|null} options.account AccountService адреса запроса (workspaceFeature.draftAccount)
 * @param {(site:string) => string} options.botUsername  имя клиентского бота (не секрет)
 * @param {boolean} options.enabled
 */
function createCustomerChatHttp({ core, site, origins, account, botUsername, widgetSettings = null, enabled = false, log = console } = {}) {
  if (typeof core !== 'function' || typeof account !== 'function' || typeof botUsername !== 'function' || !Array.isArray(origins)) {
    throw new TypeError('createCustomerChatHttp: неполные зависимости');
  }
  /* PALITRA-WEBCHAT-PHASED1: кроме точных POST-маршрутов — ровно одна форма binary-чтения
     /api/customer-chat/threads/<id>/attachments/thread:<id> (единый строгий разбор в customer-chat-media.cjs). */
  const isChatPath = (pathname) => typeof pathname === 'string' && pathname.startsWith(PREFIX)
    && (ROUTES.includes(pathname.slice(PREFIX.length)) || Boolean(mediaKit.parseBuyerBinaryPath(pathname))
      // PHASEE: ровно четыре формы файла покупателя: uploads, uploads/upload:<UUID>, …/bytes, attachments/upload:<UUID>.
      || Boolean(uploadKit.parseUploadPath(pathname, 'buyer')));
  const exactOrigin = (req, hostname) => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin !== `https://${hostname}` || !origins.includes(origin)) fail(403, 'Запрос с этого адреса не принимается', 'ORIGIN');
    return origin;
  };
  const chatRequest = (req, origin, legacyGuestThreadId = null) => ({ site, origin, cookie: String(req.headers.cookie || ''),
    csrf: String(req.headers[CHAT_CSRF_HEADER] || ''), account: accountIdentity(req, origin).account, legacyGuestThreadId });

  /* Подтверждение доступа к магазину от AccountService этого адреса: гость или проверенный UUID покупателя. */
  function accountIdentity(req, origin, { required = false, csrf = false } = {}) {
    const service = account(req);
    if (!service || service.origin !== origin || typeof service.current !== 'function' || typeof service.user !== 'function') {
      fail(503, 'Вход магазина сейчас недоступен', 'ACCOUNT_UNAVAILABLE');
    }
    const session = service.current(String(req.headers.cookie || ''));
    if (!session) {
      if (required) fail(401, 'Обновите страницу магазина и попробуйте снова', 'ACCOUNT_SESSION');
      return { tokenHash: null, account: { kind: 'guest' } };
    }
    if (csrf && !sameText(String(req.headers['x-csrf-token'] || ''), String(session.csrf || ''))) fail(403, 'Обновите страницу магазина и попробуйте снова', 'ACCOUNT_CSRF');
    if (session.user_id === null || session.user_id === undefined) return { tokenHash: session.token_hash, account: { kind: 'guest' } };
    const user = service.user(session);
    const id = user ? String(user.id) : '';
    if (!user || id !== String(session.user_id) || !ACCOUNT_USER_ID.test(id)) fail(401, 'Войдите в личный кабинет заново', 'ACCOUNT_SESSION');
    return { tokenHash: session.token_hash, account: { kind: 'user', userId: id } };
  }
  const accountProof = (req, origin) => accountIdentity(req, origin, { required: true, csrf: true });

  /* Контекст чата для POST /api/orders: только если страница прислала CSRF чата (новый UI). Cookie — из заголовка. */
  function orderContext(req, hostname) {
    const header = req.headers[CHAT_CSRF_HEADER];
    if (header === undefined) return null;
    if (!enabled) fail(409, 'Чат сайта сейчас недоступен — заявка не отправлена, корзина сохранена', 'CHAT_DISABLED');
    return chatRequest(req, exactOrigin(req, hostname));
  }

  /* PHASED1: файл чата покупателю. Только GET/HEAD, без query. Адрес — фактический одобренный хост запроса (img/audio/video
     браузера могут прийти без Origin; если Origin есть — ровно тот же адрес). Доступ — cookie чата этого адреса (не закрыта,
     не истекла) и доступ к этому чату; CSRF не требуется только этому чтению. Чужое/не сохранённое — отказ до файла. */
  function serveBinary(req, res, url, hostname, { threadId, attachmentId }) {
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { ok: false, code: 'METHOD', error: 'Метод не поддерживается' }, { Allow: 'GET, HEAD' });
    if (url.search) return json(res, 404, { ok: false, code: 'NOT_FOUND', error: 'Не найдено' });
    const origin = `https://${hostname}`;
    if (!origins.includes(origin) || (req.headers.origin !== undefined && req.headers.origin !== origin)) fail(403, 'Запрос с этого адреса не принимается', 'ORIGIN');
    const chat = core();
    const resolveFile = () => chat.webAttachment(chatRequest(req, origin, threadId), { threadId, attachmentId });
    return mediaKit.serveProtected({ request: req, response: res, resolve: resolveFile, open: (meta) => chat.openAttachment(meta) });
  }

  /* PALITRA-WEBCHAT-PHASEE: файл покупателя в свой чат. Без query; методы — точные.
     - status (GET) и file (GET/HEAD) — только чтение: фактический одобренный хост, Origin если есть — тот же, cookie чата и
       доступ к чату; CSRF не требуется только этим чтениям (как у файлов D). Ничего не пишут и не завершают.
     - prepare (POST JSON) и bytes (POST application/octet-stream) — точный Origin, cookie + CSRF чата до чтения тела и снова
       ядром после него; тело bytes читается не больше заявленного размера (лишний байт — 413), неполное — отказ ядра. */
  async function readRaw(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) fail(413, 'Файл больше выбранного — выберите тот же файл', 'TOO_LARGE');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async function serveUpload(req, res, url, hostname, route) {
    if (!route.methods.includes(req.method)) return json(res, 405, { ok: false, code: 'METHOD', error: 'Метод не поддерживается' }, { Allow: route.methods.join(', ') });
    if (url.search) return json(res, 404, { ok: false, code: 'NOT_FOUND', error: 'Не найдено' });
    const chat = core();
    const target = { threadId: route.targetId, uuid: route.uuid };
    if (route.action === 'status' || route.action === 'file') {
      const origin = `https://${hostname}`;
      if (!origins.includes(origin) || (req.headers.origin !== undefined && req.headers.origin !== origin)) fail(403, 'Запрос с этого адреса не принимается', 'ORIGIN');
      if (route.action === 'status') return json(res, 200, chat.webUploadStatus(chatRequest(req, origin, route.targetId), target));
      return mediaKit.serveProtected({ request: req, response: res, resolve: () => chat.webUploadFile(chatRequest(req, origin, route.targetId), target), open: (meta) => chat.openUpload(meta) });
    }
    const origin = exactOrigin(req, hostname);
    if (route.action === 'prepare') {
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) fail(415, 'Ожидался JSON', 'CONTENT_TYPE');
      chat.listMyThreads(chatRequest(req, origin), { limit: 1 });   // cookie и CSRF чата — до чтения тела
      const body = await readBody(req, UPLOAD_BODY);
      const result = chat.prepareWebUpload(chatRequest(req, exactOrigin(req, hostname)), { threadId: route.targetId, body });
      return json(res, result.duplicate ? 200 : 201, result);
    }
    if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/octet-stream') fail(415, 'Ожидался файл', 'CONTENT_TYPE');
    // До тела: своя загрузка этой сессии в этом чате и заявленный размер — предел чтения.
    const begun = chat.beginWebUpload(chatRequest(req, origin), target);
    const length = req.headers['content-length'];
    let bytes;
    try {
      if (length !== undefined && (!/^\d{1,9}$/.test(String(length)) || Number(length) !== begun.declaredSize)) {
        fail(Number(length) > begun.declaredSize ? 413 : 422, 'Размер файла не совпал с выбранным — выберите тот же файл', 'SIZE_MISMATCH');
      }
      bytes = await readRaw(req, begun.declaredSize);
    } catch (error) { if (begun.claim) chat.releaseUpload(route.uuid, begun.claim, error.message); throw error; }
    const result = chat.finishWebUpload(chatRequest(req, exactOrigin(req, hostname)), { ...target, claim: begun.claim || null, bytes });
    return json(res, result.duplicate ? 200 : 201, result);
  }

  async function handle(req, res, hostname) {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname.slice(PREFIX.length);
    const historyHeaders = route === 'history-status' ? { 'Cross-Origin-Resource-Policy': 'same-origin' } : {};
    try {
      if (!enabled || !isChatPath(url.pathname)) return json(res, 404, { ok: false, code: 'NOT_FOUND', error: 'Не найдено' }, historyHeaders);
      const binary = mediaKit.parseBuyerBinaryPath(url.pathname);
      if (binary) return serveBinary(req, res, url, hostname, binary);
      const upload = uploadKit.parseUploadPath(url.pathname, 'buyer');
      if (upload) return await serveUpload(req, res, url, hostname, upload);
      if (route === 'history-status') {
        if (req.method !== 'GET') return json(res, 405, { ok: false, code: 'METHOD', error: 'Метод не поддерживается' }, { ...historyHeaders, Allow: 'GET' });
        if (url.search) fail(400, 'Параметры адреса не поддерживаются', 'VALIDATION');
        if (req.headers['transfer-encoding'] !== undefined || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) {
          fail(400, 'Тело запроса не поддерживается', 'VALIDATION');
        }
        const origin = `https://${hostname}`;
        if (!origins.includes(origin) || (req.headers.origin !== undefined && req.headers.origin !== origin)
          || (req.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) {
          fail(403, 'Запрос с этого адреса не принимается', 'ORIGIN');
        }
        // No AccountService bootstrap, session creation/renewal, CSRF issuance or body read.
        // A missing/expired/revoked cookie is an ordinary absent history, not a new guest.
        let result;
        try { result = core().peekWebHistory(chatRequest(req, origin)); }
        catch (error) {
          if (error?.status !== 401 || !['NO_SESSION', 'EXPIRED', 'REVOKED'].includes(error.code)) throw error;
          result = { hasHistory: false };
        }
        if (!result || typeof result.hasHistory !== 'boolean' || Object.keys(result).length !== 1) fail(503, 'История чата сейчас недоступна', 'STATE');
        return json(res, 200, { ok: true, hasHistory: result.hasHistory }, historyHeaders);
      }
      if (route === 'widget-settings') {
        if (req.method !== 'GET') return json(res, 405, { ok: false, code: 'METHOD', error: 'Метод не поддерживается' }, { Allow: 'GET' });
        if (url.search) fail(400, 'Параметры адреса не поддерживаются', 'VALIDATION');
        const approvedOrigin = `https://${hostname}`;
        if (!origins.includes(approvedOrigin) || (req.headers.origin !== undefined && req.headers.origin !== approvedOrigin)) {
          fail(403, 'Запрос с этого адреса не принимается', 'ORIGIN');
        }
        if (typeof widgetSettings !== 'function') fail(503, 'Настройки чата недоступны', 'STATE');
        return json(res, 200, { ok: true, settings: widgetSettings() });
      }
      if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'METHOD', error: 'Метод не поддерживается' }, { Allow: 'POST' });
      const origin = exactOrigin(req, hostname);
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) fail(415, 'Ожидался JSON', 'CONTENT_TYPE');
      const chat = core();
      if (route === 'session') {
        const before = accountProof(req, origin);
        const input = fields(await readBody(req, SMALL_BODY), [], ['threadId']);
        if (Object.hasOwn(input, 'threadId') && (!Number.isSafeInteger(input.threadId) || input.threadId <= 0)) fail(400, 'Некорректный чат', 'VALIDATION');
        // После чтения тела — та же сессия магазина того же адреса и тот же CSRF.
        const after = accountProof(req, origin);
        if (after.tokenHash !== before.tokenHash || JSON.stringify(after.account) !== JSON.stringify(before.account)) fail(403, 'Обновите страницу магазина и попробуйте снова', 'ACCOUNT_SESSION');
        const result = chat.ensureWebSession({ site, origin, cookie: String(req.headers.cookie || '') }, { account: after.account, threadId: input.threadId });
        return json(res, 200, { ok: true, created: result.created, csrfToken: result.csrfToken, expiresAt: result.expiresAt },
          result.setCookie ? { 'Set-Cookie': result.setCookie } : {});
      }
      // До чтения тела: действующая cookie чата, CSRF и точный адрес (ядро повторит проверку после тела).
      const preliminaryBefore = route === 'preliminary-profile' ? accountProof(req,origin) : null;
      chat.listMyThreads(chatRequest(req, origin), { limit: 1 });
      const body = await readBody(req, route === 'message' || route === 'start' ? MESSAGE_BODY : SMALL_BODY);
      const request = chatRequest(req, exactOrigin(req, hostname));
      if (route === 'preliminary-profile') {
        const after = accountProof(req,origin);
        if (after.tokenHash !== preliminaryBefore.tokenHash || JSON.stringify(after.account) !== JSON.stringify(preliminaryBefore.account)) fail(403,'Вход изменился. Обновите страницу','ACCOUNT_SESSION');
        if (after.account.kind !== 'guest') fail(409,'Используйте личный кабинет текущего аккаунта','VERIFIED_ACCOUNT');
        if (!Object.keys(body).length || Object.keys(body).join(',') === 'threadId') return json(res,200,{ok:true,...chat.preliminaryContactForm(request,fields(body,[],['threadId']))});
        const result = chat.savePreliminaryProfile(request,fields(body,['requestId','phone','consent'],['firstName','threadId']));
        return json(res,result.duplicate?200:201,result);
      }
      if (route === 'start') {
        if (url.search) fail(400, 'Параметры переписки передаются только в JSON', 'VALIDATION');
        const input = fields(body, ['requestId'], ['text', 'phone', 'upload', 'attributionToken']);
        const result = chat.startWebConversation(request, input);
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (route === 'contact') {
        if (url.search) fail(400, 'Параметры контакта передаются только в JSON', 'VALIDATION');
        const result = chat.provideWebContact(request, fields(body, ['threadId', 'requestId', 'phone']));
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (route === 'threads') return json(res, 200, { ok: true, ...chat.listMyThreads(request, fields(body, [], ['before', 'limit'])) });
      if (route === 'messages') {
        const input = fields(body, ['threadId'], ['before', 'limit', 'view']);
        if (Object.hasOwn(input, 'view') && input.view !== 'conversation-v1') fail(400, 'Неизвестный вид переписки', 'VIEW');
        if (input.view === 'conversation-v1' && url.search) fail(400, 'Параметры общей переписки передаются только в JSON', 'VALIDATION');
        const read = input.view === 'conversation-v1' ? chat.listWebConversation : chat.listWebMessages;
        return json(res, 200, { ok: true, ...read(request, input) });
      }
      if (route === 'message') {
        const result = chat.postWebMessage(request, fields(body, ['threadId', 'requestId', 'text']));
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (route === 'telegram-link') {
        const input = fields(body, ['threadId']);
        const username = String(botUsername(site) || '').replace(/^@/, '');
        if (!BOT_USERNAME.test(username)) fail(409, 'Telegram для этого магазина не подключён', 'BOT_DISABLED');
        const link = chat.issueTelegramLink(request, input);
        return json(res, 200, { ok: true, url: `https://t.me/${username}?start=${link.startPayload}`, expiresAt: link.expiresAt });
      }
      // revoke
      fields(body, []);
      const result = chat.revokeWebSession(request);
      return json(res, 200, { ok: true }, { 'Set-Cookie': result.setCookie });
    } catch (error) {
      const status = KNOWN_STATUS.has(error?.status) ? error.status : 500;
      if (status === 500) {
        // Без текста запроса, cookie и токенов: только код ошибки.
        log.error?.(`content: чат сайта: внутренняя ошибка ${String(error?.code || 'INTERNAL').slice(0, 40)}`);
        return json(res, 500, { ok: false, code: 'INTERNAL', error: 'Чат временно недоступен. Повторите позже.' }, historyHeaders);
      }
      return json(res, status, { ok: false, code: String(error.code || 'ERROR'), error: String(error.message || '').slice(0, 300) },
        { ...historyHeaders, ...(status === 429 ? { 'Retry-After': '600' } : {}) });
    }
  }

  return Object.freeze({ isChatPath, handle, orderContext, CHAT_CSRF_HEADER });
}

module.exports = { createCustomerChatHttp, CHAT_CSRF_HEADER, PREFIX, ROUTES };
