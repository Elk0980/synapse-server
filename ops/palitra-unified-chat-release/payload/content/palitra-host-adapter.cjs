'use strict';
/* Palitra ↔ существующий сервис content (Synapse). Единственная точка подключения магазина и MVP CRM к хосту.
   Phase 2 (CRM) + Phase 3 (узкое оформление заказа) + MAIN (основной домен), 13.10.2026.
   Основа — утверждённый ROOT_RELEASE palitra-host-adapter.cjs sha256 248876a5…995f; изменения помечены PALITRA-MAIN.

   ВСЁ ВЫКЛЮЧЕНО ПО УМОЛЧАНИЮ. Один фиксированный магазин site-44bbe13f1bad5e005b2a / palitra-love, одна SQLite хоста,
   один siteOrders, один центральный прайс palitra/price и одна база аккаунтов магазина.
   Одобренные адреса магазина (только они, без * и без произвольных хостов):
   - PALITRA_SHOP_ORIGIN — адрес черновика, по умолчанию ровно https://palitra-love-draft-1.synapsebusiness.ru;
   - PALITRA_MAIN_ORIGIN — явно одобренный основной домен (например https://palitra-love.ru), по умолчанию нет.
     www и прочие варианты не принимаются: их Root перенаправляет обычным redirect.
   1) Оформление (PALITRA_CHECKOUT_ENABLED==='true') на каждом одобренном адресе: живой центральный прайс
      (GET/HEAD /api/price, /data/price.json), публичные фото прайса /api/assets/* из существующего ASSETS_DIR/palitra
      (тот же каталог, что у /content/palitra/assets), и POST /api/orders → тот же siteOrders.submit, что у
      /public-orders/palitra. Origin заявки обязан быть ровно адресом ТОГО ЖЕ хоста, на который пришёл запрос.
      Ссылка клиентского бота — тот же issueOrderLink только для новой (201) заявки. Бот CRM и сотрудники не нужны.
   2) CRM (PALITRA_CRM_ENABLED==='true' + явный PALITRA_CRM_BOT_ID): без изменений по смыслу; покупатель — только
      проверенная сессия аккаунта магазина того же адреса (cookie и CSRF этого адреса).
   Новой сущности заказа, outbox, БД, бота, опроса и транспорта нет. Сопоставления по имени, телефону, номеру заказа нет. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FIXED = Object.freeze({ draftId: 'site-44bbe13f1bad5e005b2a', companyCode: 'palitra-love', hostname: 'palitra-love-draft-1.synapsebusiness.ru' });
const DEFAULT_SYNAPSE_ORIGIN = 'https://synapse.synapsebusiness.ru';
const EDITOR_URL = 'https://synapse.synapsebusiness.ru/cabinet/palitra-editor.html';
const ORDER_BODY_LIMIT = 32 * 1024;
const ORDER_ERRORS = [400, 403, 409, 429, 503];
const HEX64 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TELEGRAM_SUBJECT = /^[1-9]\d{0,19}$/;
const SYNAPSE_SUBJECT = /^synapse:([1-9]\d{0,9})$/;
const DRAFT_SUBJECT = new RegExp(`^draft:${FIXED.draftId}:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`);
const PRICE_PATHS = new Set(['/api/price', '/data/price.json']);
const ORIGIN_REFUSED = Object.freeze({ ok: false, code: 'ORIGIN', error: 'Запрос с этого адреса не принимается' });
// PALITRA-MAIN: те же имена и типы, что у существующего /content/:site/assets/:name (загрузка фото прайса: JPEG/PNG/WebP).
const ASSET_PREFIX = '/api/assets/';
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
const ASSET_TYPES = Object.freeze({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' });
/* PALITRA-WEBCHAT-PHASEC: оболочка чата сайта — ровно три точных адреса и три постоянных имени файла в отдельном
   каталоге deps.chatPublicDir. Имя файла из адреса не строится; история и доступ — только через HTTP чата. */
const CHAT_STATIC = Object.freeze({
  '/chat': Object.freeze({ file: 'palitra-chat.html', type: 'text/html; charset=utf-8', page: true }),
  '/assets/palitra-chat.js': Object.freeze({ file: 'palitra-chat.js', type: 'application/javascript; charset=utf-8', page: false }),
  '/assets/palitra-chat.css': Object.freeze({ file: 'palitra-chat.css', type: 'text/css; charset=utf-8', page: false }),
});
// PALITRA-WEBCHAT-PHASED1: media-src 'self' — защищённые голосовые/аудио/видео чата с того же адреса (единственное изменение D1 здесь).
const CHAT_PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/* Точный https-origin без порта, учётных данных, пути и *; иначе null. */
function exactHttpsOrigin(raw) {
  let parsed = null;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.origin !== raw || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
    || raw.includes('*') || !/^[a-z0-9.-]+$/.test(parsed.hostname)) return null;
  return parsed;
}

/* Адреса магазина: черновик (по умолчанию ровно текущий) и необязательный явно одобренный основной домен. */
function parseShop(env = {}) {
  const raw = String(env.PALITRA_SHOP_ORIGIN ?? '').trim() || `https://${FIXED.hostname}`;
  const url = exactHttpsOrigin(raw);
  if (!url) return { ok: false, reason: 'PALITRA_SHOP_ORIGIN должен быть точным https-origin без порта, пути и *' };
  // PALITRA-MAIN: основной домен — только явная настройка; не черновик, не *.synapsebusiness.ru, не тот же адрес.
  const mainRaw = String(env.PALITRA_MAIN_ORIGIN ?? '').trim();
  let main = null;
  if (mainRaw) {
    main = exactHttpsOrigin(mainRaw);
    if (!main || main.hostname === url.hostname || main.hostname === FIXED.hostname
      || main.hostname === 'synapsebusiness.ru' || main.hostname.endsWith('.synapsebusiness.ru')) {
      return { ok: false, reason: 'PALITRA_MAIN_ORIGIN должен быть точным https-origin основного домена (не черновик и не Synapse), без порта, пути и *' };
    }
  }
  const origins = Object.freeze(main ? [raw, mainRaw] : [raw]);
  return { ok: true, shop: Object.freeze({ origin: raw, hostname: url.hostname, canonicalHostname: FIXED.hostname,
    draftId: FIXED.draftId, companyCode: FIXED.companyCode, mainOrigin: main ? mainRaw : null, mainHostname: main ? main.hostname : null,
    origins, hostnames: Object.freeze(origins.map((o) => new URL(o).hostname)) }) };
}
/* Оформление заказа: только явный флаг и корректные адреса магазина. Бот CRM и сотрудники не нужны. */
function parseCheckout(env = {}) {
  if (env.PALITRA_CHECKOUT_ENABLED !== 'true') return { enabled: false, reason: 'PALITRA_CHECKOUT_ENABLED не равен true' };
  const shop = parseShop(env);
  return shop.ok ? { enabled: true, shop: shop.shop } : { enabled: false, reason: shop.reason };
}
/* Настройка CRM. Значения не придумываются: без явного включения и botId — выключено. */
function parseConfig(env = {}) {
  if (env.PALITRA_CRM_ENABLED !== 'true') return { enabled: false, reason: 'PALITRA_CRM_ENABLED не равен true' };
  const botId = String(env.PALITRA_CRM_BOT_ID ?? '').trim();
  if (!/^[1-9]\d{0,19}$/.test(botId)) return { enabled: false, reason: 'PALITRA_CRM_BOT_ID не задан или не положительное число' };
  const parsedShop = parseShop(env);
  if (!parsedShop.ok) return { enabled: false, reason: parsedShop.reason };
  const shop = parsedShop.shop;
  const synapseRaw = String(env.PALITRA_CRM_SYNAPSE_ORIGIN ?? '').trim() || DEFAULT_SYNAPSE_ORIGIN;
  const synapseUrl = exactHttpsOrigin(synapseRaw);
  if (!synapseUrl || shop.hostnames.includes(synapseUrl.hostname)) {
    return { enabled: false, reason: 'PALITRA_CRM_SYNAPSE_ORIGIN должен быть точным https-origin, отличным от адресов магазина' };
  }
  const staff = new Map();
  const rawStaff = String(env.PALITRA_CRM_STAFF ?? '').trim();
  if (rawStaff) {
    for (const part of rawStaff.split(',')) {
      const match = /^\s*([1-9]\d{0,9}):(owner|admin)\s*$/.exec(part);
      if (!match || staff.has(Number(match[1]))) return { enabled: false, reason: 'PALITRA_CRM_STAFF: ожидается «id:owner|admin» через запятую без повторов' };
      staff.set(Number(match[1]), match[2]);
    }
  }
  const clientBotOrders = String(env.PALITRA_CRM_CLIENT_BOT_ORDERS ?? '').trim();
  if (clientBotOrders && !['true', 'false'].includes(clientBotOrders)) return { enabled: false, reason: 'PALITRA_CRM_CLIENT_BOT_ORDERS: только true или false' };
  return { enabled: true, botId, synapseOrigin: synapseRaw, staff, shop, clientBotOrders: clientBotOrders === 'true' };
}
/* Для рабочего пространства и siteOrders: адреса магазина, если включено оформление или CRM; иначе null. */
function shopConfig(env = {}) {
  const crm = parseConfig(env);
  if (crm.enabled) return crm.shop;
  const checkout = parseCheckout(env);
  return checkout.enabled ? checkout.shop : null;
}
/* Существующий список Origin заявок Palitra дополняется ровно одобренными адресами магазина — только при включении.
   Прежний основной адрес в списке сохраняется; другие сайты, outbox, проверка прайса и requestId не меняются. */
function withShopOrigin(orderSites, env = {}) {
  const shop = shopConfig(env);
  const palitra = orderSites && Object.hasOwn(orderSites, 'palitra') ? orderSites.palitra : null;
  if (!shop || !palitra || !Array.isArray(palitra.origins) || palitra.companyCode !== FIXED.companyCode) return orderSites;
  const missing = shop.origins.filter((origin) => !palitra.origins.includes(origin));
  if (!missing.length) return orderSites;
  return { ...orderSites, palitra: { ...palitra, origins: [...palitra.origins, ...missing] } };
}

const off = (reason) => Object.freeze({ enabled: false, checkoutEnabled: false, crmEnabled: false, reason, draftHook: null,
  handleSynapse: async () => false, revokeHostSession: () => false, health: () => Object.freeze({ enabled: false }) });
const oneLine = (error) => String(error?.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 300);
const hostOf = (req) => String(req.headers.host || '').toLowerCase().split(':')[0];

function createPalitraHostAdapter(deps = {}) {
  const env = deps.env || {};
  const crmConfig = parseConfig(env), checkout = parseCheckout(env);
  if (!crmConfig.enabled && !checkout.enabled) return off(`${checkout.reason}; ${crmConfig.reason}`);
  try {
    return enable({ crmConfig, checkout }, deps);
  } catch (error) {
    // Ошибка настройки не роняет сервис content: модуль остаётся выключенным, заявки — как в BASE.
    console.error(`content: Palitra не включена — ${oneLine(error)}`);
    return off('ошибка инициализации, см. журнал');
  }
}

function enable({ crmConfig, checkout }, deps) {
  for (const name of ['priceRow', 'clientIp', 'originOf']) {
    if (typeof deps[name] !== 'function') throw new TypeError(`нет зависимости хоста ${name}`);
  }
  if (!deps.siteOrders || typeof deps.siteOrders.submit !== 'function') throw new TypeError('нет siteOrders хоста');
  // PALITRA-WEBCHAT-PHASEB: необязательный серверный чат сайта; передан — значит целиком (HTTP и общая заявка).
  if (deps.customerChat && (typeof deps.customerChat.submitWithChat !== 'function' || !deps.customerChat.http
    || typeof deps.customerChat.http.handle !== 'function' || typeof deps.customerChat.http.isChatPath !== 'function'
    || typeof deps.customerChat.http.orderContext !== 'function')) throw new TypeError('неполный чат сайта хоста');
  const shop = crmConfig.enabled ? crmConfig.shop : checkout.shop;
  const clock = typeof deps.now === 'function' ? () => deps.now() : () => Date.now();
  let crmPart = null, crmReason = crmConfig.enabled ? '' : crmConfig.reason;
  if (crmConfig.enabled) {
    try { crmPart = enableCrm(crmConfig, deps, shop, clock); }
    catch (error) {
      if (!checkout.enabled) throw error;
      // Оформление не зависит от CRM: при сбое CRM работает только существующий приём заявок.
      crmReason = `CRM не включена — ${oneLine(error)}`;
      console.error(`content: Palitra ${crmReason}; оформление заказа работает без CRM`);
    }
  }
  const assetsDir = typeof deps.palitraAssetsDir === 'string' && path.isAbsolute(deps.palitraAssetsDir) ? deps.palitraAssetsDir : null;
  const chatPublicDir = typeof deps.chatPublicDir === 'string' && path.isAbsolute(deps.chatPublicDir) ? deps.chatPublicDir : null;

  const json = (res, status, body, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(body));
  };
  async function readLimited(req, limit) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error('Заявка слишком большая'), { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  /* Живой прайс магазина: та же последняя версия palitra/price, что у редактора и публичного маршрута, ETag — версия. */
  function servePrice(req, res) {
    const row = deps.priceRow();
    if (!row || typeof row.body !== 'string') return json(res, 404, { message: 'Прайс не найден' });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(row.body),
      'Cache-Control': 'no-store', ETag: `"${row.version}"` });
    res.end(req.method === 'HEAD' ? undefined : row.body);
  }
  /* PALITRA-MAIN: фото прайса из существующего ASSETS_DIR/palitra (туда пишет редактор прайса), а не из снимка черновика.
     Только одно имя файла JPEG/PNG/WebP без каталогов, %-кодирования и «..»; путь проверяется realpath внутри каталога.
     Неверное имя — 404. Нет файла в живом каталоге — false: прежняя выдача из снимка черновика решает сама. */
  function serveAsset(req, res, url) {
    const name = url.pathname.slice(ASSET_PREFIX.length);
    const ext = path.extname(name).toLowerCase();
    if (!ASSET_NAME.test(name) || name.includes('..') || !Object.hasOwn(ASSET_TYPES, ext)) { json(res, 404, { message: 'Файл не найден' }); return true; }
    let real;
    try {
      real = fs.realpathSync(path.join(assetsDir, name));
      if (!real.startsWith(fs.realpathSync(assetsDir) + path.sep) || !fs.statSync(real).isFile()) return false;
    } catch { return false; }
    const bytes = fs.readFileSync(real);
    res.writeHead(200, { 'Content-Type': ASSET_TYPES[ext], 'Content-Length': bytes.length, 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
    return true;
  }
  /* PALITRA-WEBCHAT-PHASEC: GET/HEAD оболочки /chat. Файл — постоянное имя прямо в каталоге chatPublicDir: realpath
     обязан лежать непосредственно в realpath каталога и называться так же (ссылка наружу или на другой файл — 404).
     Нет каталога или файла — 404 без путей. HEAD — тот же статус, заголовки и длина, без тела. Сессия не нужна:
     это только оболочка, история приходит из HTTP чата по своей cookie. */
  function serveChatStatic(req, res, entry) {
    const plain = { 'X-Content-Type-Options': 'nosniff' };
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { message: 'Метод не поддерживается' }, { ...plain, Allow: 'GET, HEAD' });
    let bytes = null;
    if (chatPublicDir) {
      try {
        const root = fs.realpathSync(chatPublicDir);
        const real = fs.realpathSync(path.join(root, entry.file));
        if (path.dirname(real) === root && path.basename(real) === entry.file && fs.statSync(real).isFile()) bytes = fs.readFileSync(real);
      } catch { bytes = null; }
    }
    if (!bytes) return json(res, 404, { message: 'Не найдено' }, plain);
    const headers = { 'Content-Type': entry.type, 'Content-Length': bytes.length, 'Cache-Control': 'no-store', ...plain, 'Referrer-Policy': 'no-referrer' };
    if (entry.page) Object.assign(headers, { 'Content-Security-Policy': CHAT_PAGE_CSP, 'X-Robots-Tag': 'noindex, nofollow', 'X-Frame-Options': 'DENY' });
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : bytes);
    return true;
  }
  /* POST /api/orders магазина = существующий /public-orders/palitra: тот же siteOrders.submit (CRM — через
     workspace.submitSite, внутри тот же вызов, один раз), те же ответы и ссылка клиентского бота только для 201.
     PALITRA-MAIN: Origin обязан быть ровно адресом того хоста, на который пришёл запрос (черновик ↔ основной не смешиваются). */
  async function submitOrder(req, res, hostname) {
    const origin = deps.originOf(req);
    if (origin !== `https://${hostname}` || !shop.origins.includes(origin)) return json(res, 403, ORIGIN_REFUSED);
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return json(res, 415, { error: 'Ожидался JSON' });
    let body;
    try { body = JSON.parse((await readLimited(req, ORDER_BODY_LIMIT)).toString('utf8')); }
    catch (error) { return error.status === 413 ? json(res, 413, { error: error.message }) : json(res, 400, { error: 'Некорректный JSON' }); }
    const ip = deps.clientIp(req);
    try {
      const submit = () => {
        if (crmPart) {
          // Сессия покупателя проверяется ПОСЛЕ чтения тела: выход во время загрузки не закрепляет заявку за аккаунтом.
          const buyer = crmPart.buyerSession(req);
          const principal = buyer ? { provider: 'site', subject: `draft:${FIXED.draftId}:${buyer.user.id}` } : null;
          return crmPart.crm.submitPublicOrder({ body, origin, ip, principal });
        }
        return deps.siteOrders.submit({ site: 'palitra', body, origin, ip });
      };
      // PALITRA-WEBCHAT-PHASEB: контекст чата — только из заголовков этого запроса (cookie, X-Palitra-Chat-CSRF, точный Origin).
      // Native submit вызывается ровно один раз; заявка, чат и доступ — одной транзакцией хоста (submitWithChat).
      const chat = deps.customerChat || null;
      const chatRequest = chat ? chat.http.orderContext(req, hostname) : null;
      const outcome = chat ? chat.submitWithChat({ chatRequest, submit }) : { result: submit(), chat: null };
      const result = outcome.result;
      if (outcome.chat) result.body = { ...result.body, chat: { threadId: outcome.chat.threadId } };
      // Прежняя ссылка o_ — только прежнему оформлению без чата сайта: у новой заявки с чатом одна история (c_ из чата).
      if (!chatRequest && result.status === 201 && typeof deps.issueOrderLink === 'function') {
        try { const link = deps.issueOrderLink({ site: 'palitra', orderId: result.body.orderId }); if (link) result.body.telegram = link; }
        catch (error) { console.error('content: ссылка на клиентский бот не выдана:', error.message); }
      }
      return json(res, result.status, result.body);
    } catch (error) {
      // PALITRA-WEBCHAT-PHASEB: отказ контекста чата (сессия, CSRF, выключен) — заявка не принята, корзина остаётся на странице.
      // 403/409 (CSRF, адрес, выключен, чат уже есть) отвечают ниже тем же форматом ORDER_ERRORS; здесь — 401/404 чата.
      if (error && error.chat === true && [401, 404].includes(error.status)) {
        return json(res, error.status, { ok: false, code: error.code || 'CHAT', error: error.message });
      }
      if (!ORDER_ERRORS.includes(error.status)) {
        console.error('content: заявка Palitra не принята:', oneLine(error).slice(0, 200));
        return json(res, 500, { error: 'Не удалось принять заявку. Повторите отправку позже.' });
      }
      return json(res, error.status, { ok: false, code: error.code || 'VALIDATION', error: error.message, ...(error.itemId ? { itemId: error.itemId } : {}) },
        error.status === 429 ? { 'Retry-After': '600' } : {});
    }
  }

  const draftHook = Object.freeze({ draftId: FIXED.draftId, companyCode: FIXED.companyCode, hostname: shop.hostnames[0], hostnames: shop.hostnames,
    async handle({ request, response, url, draft, hostname }) {
      // Повторная точная проверка: хук не открывается для других черновиков, компаний и адресов.
      if (!shop.hostnames.includes(hostname) || draft?.id !== FIXED.draftId || draft?.company_code !== FIXED.companyCode) return false;
      // PALITRA-WEBCHAT-PHASEC: только точные адреса оболочки чата (без префиксов, вариантов и %-кодирования).
      if (Object.hasOwn(CHAT_STATIC, url.pathname)) { serveChatStatic(request, response, CHAT_STATIC[url.pathname]); return true; }
      if (PRICE_PATHS.has(url.pathname) && ['GET', 'HEAD'].includes(request.method)) { servePrice(request, response); return true; }
      if (assetsDir && url.pathname.startsWith(ASSET_PREFIX) && ['GET', 'HEAD'].includes(request.method)) return serveAsset(request, response, url);
      if (url.pathname === '/api/orders' && request.method === 'POST') { await submitOrder(request, response, hostname); return true; }
      // PALITRA-WEBCHAT-PHASEB: чат сайта — только точные POST /api/customer-chat/* внутри этого же фиксированного хука.
      if (deps.customerChat && deps.customerChat.http.isChatPath(url.pathname)) { await deps.customerChat.http.handle(request, response, hostname); return true; }
      if (crmPart && crmPart.isCrmPath(url.pathname)) return crmPart.crm.handle(request, response);
      return false;
    } });
  return Object.freeze({ enabled: true, checkoutEnabled: checkout.enabled, crmEnabled: Boolean(crmPart), reason: crmReason, draftHook,
    handleSynapse: crmPart ? crmPart.handleSynapse : async () => false,
    revokeHostSession: crmPart ? crmPart.revokeHostSession : () => false,
    // Только для серверной диагностики, не публичный маршрут: без контактов и секретов.
    health: () => Object.freeze({ enabled: true, checkout: checkout.enabled, crm: Boolean(crmPart), shopOrigin: shop.origin, shopOrigins: shop.origins,
      liveAssets: Boolean(assetsDir), ...(crmPart ? { ...crmPart.crm.health(), staffConfigured: crmConfig.staff.size } : {}) }),
    // Только для серверного кода и тестов: тот же объект интеграции (admin — SERVER-ONLY).
    crm: crmPart ? crmPart.crm : null });
}

function enableCrm(config, deps, shop, clock) {
  for (const name of ['transaction', 'sessionData', 'requireCsrf', 'draftAccount', 'loadIntegration']) {
    if (typeof deps[name] !== 'function') throw new TypeError(`нет зависимости хоста ${name}`);
  }
  if (!deps.db || typeof deps.db.prepare !== 'function' || !deps.authStore || typeof deps.authStore.getById !== 'function') throw new TypeError('нет SQLite или authStore хоста');
  if (!Buffer.isBuffer(deps.refKey) || deps.refKey.length < 32) throw new TypeError('нет серверного ключа ссылки сессии');
  const db = deps.db;
  const synapseHost = new URL(config.synapseOrigin).hostname;
  const refOf = (value) => crypto.createHmac('sha256', deps.refKey).update(value).digest('hex');
  const sameHex = (a, b) => typeof a === 'string' && typeof b === 'string' && HEX64.test(a) && HEX64.test(b)
    && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length > 0
    && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const isCrmPath = (p) => p === '/api/crm' || p.startsWith('/api/crm/') || p === '/palitra-app' || p.startsWith('/palitra-app/');

  // Только при включении CRM: ссылка CRM-сессии сотрудника на конкретную cookie кабинета (без самой cookie).
  db.exec(`CREATE TABLE IF NOT EXISTS palitra_crm_host_sessions (
    cookie_ref TEXT PRIMARY KEY, user_id INTEGER NOT NULL, session_version INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
  )`);

  /* Роль сотрудника: явная настройка И текущее назначение аккаунта Synapse на palitra-love (или глобальный владелец
     Synapse, если он сам указан в PALITRA_CRM_STAFF). Имя, логин и прочие поля роль не дают. */
  function staffRoleOf(user) {
    if (!user || !Number.isSafeInteger(user.id)) return null;
    const role = config.staff.get(user.id);
    if (!role) return null;
    const assigned = user.role === 'owner' || (Array.isArray(user.companyCodes) && user.companyCodes.includes(FIXED.companyCode));
    return assigned ? role : null;
  }

  /* ---------- сотрудник: cookie кабинета Synapse ---------- */
  function staffSession(req) {
    if (req.headers.origin !== config.synapseOrigin) return null;
    const session = deps.sessionData(req);
    if (!session || !HEX64.test(String(session.cookieRef || '')) || !Number.isFinite(Number(session.exp))) return null;
    try { deps.requireCsrf(req, session); } catch { return null; }
    const user = deps.authStore.getById(session.user.id);
    if (!user || user.sessionVersion !== session.user.sessionVersion) return null;
    return { session, user };
  }
  // Строка ссылки создаётся один раз на cookie; отозванная, истёкшая или чужая — вход не выдаётся.
  function linkHostSession(user, session) {
    const ref = String(session.cookieRef), expiresAt = Number(session.exp) * 1000;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= clock()) return null;
    db.prepare('INSERT OR IGNORE INTO palitra_crm_host_sessions(cookie_ref,user_id,session_version,expires_at,created_at) VALUES(?,?,?,?,?)')
      .run(ref, user.id, user.sessionVersion, expiresAt, clock());
    const row = db.prepare('SELECT * FROM palitra_crm_host_sessions WHERE cookie_ref=?').get(ref);
    if (!row || row.revoked_at !== null || row.user_id !== user.id || row.session_version !== user.sessionVersion || row.expires_at <= clock()) return null;
    return ref;
  }
  // Выход из кабинета: отзывается только CRM-доступ этой cookie; другие устройства и права аккаунта не меняются.
  function revokeHostSession(cookieRef) {
    if (!HEX64.test(String(cookieRef || ''))) return false;
    return Number(db.prepare('UPDATE palitra_crm_host_sessions SET revoked_at=? WHERE cookie_ref=? AND revoked_at IS NULL').run(clock(), cookieRef).changes) === 1;
  }

  /* ---------- покупатель: существующий AccountService магазина того же адреса (PALITRA-MAIN) ---------- */
  const account = (req = null) => deps.draftAccount(req);
  function buyerSession(req) {
    const host = hostOf(req);
    if (!shop.hostnames.includes(host) || req.headers.origin !== `https://${host}`) return null;
    const service = account(req);
    if (!service || service.origin !== `https://${host}`) return null;
    const session = service.current(String(req.headers.cookie || ''));
    if (!session || !session.user_id || !sameText(String(req.headers['x-csrf-token'] || ''), session.csrf)) return null;
    const user = service.user(session);
    if (!user || !UUID.test(String(user.id))) return null;
    return { session, user };
  }

  /* ---------- сотрудник: проверенная привязка Telegram Mini App чата проекта ---------- */
  const linkOf = (telegramId) => { try { return db.prepare('SELECT telegram_user_id,user_id FROM project_chat_telegram_links WHERE telegram_user_id=?').get(telegramId) || null; } catch { return null; } };
  const linkVersion = (userId) => { try { return db.prepare('SELECT version FROM project_chat_telegram_link_versions WHERE user_id=?').get(userId)?.version || 1; } catch { return null; } };
  function telegramStaff(subject) {
    if (!TELEGRAM_SUBJECT.test(String(subject))) return null;
    const link = linkOf(String(subject));
    if (!link) return null;
    const user = deps.authStore.getById(link.user_id);
    const version = user ? linkVersion(user.id) : null;
    const role = staffRoleOf(user);
    if (!user || user.id !== link.user_id || version === null || !role) return null;
    return { role, ref: refOf(`tg:${subject}:${user.id}:${user.sessionVersion}:${version}`) };
  }
  // Вызывается crm-access только после проверки подписи initData ботом PALITRA_CRM_BOT_ID.
  const telegramBind = ({ subject }) => telegramStaff(subject)?.ref ?? null;
  // Роль — пока та же привязка, та же версия привязки и та же версия аккаунта; иначе обычный покупатель.
  const telegramRole = ({ subject, ref }) => { const state = telegramStaff(subject); return state && sameHex(ref, state.ref) ? state.role : null; };
  /* Необязательно (PALITRA_CRM_CLIENT_BOT_ORDERS=true, по умолчанию выключено и НЕ включать — см. REPORT_MAIN):
     заказ, чья одноразовая ссылка клиентского бота была использована личным чатом этого Telegram ID. */
  const hostOrders = config.clientBotOrders ? ({ provider, subject }) => {
    if (provider !== 'telegram' || !TELEGRAM_SUBJECT.test(String(subject))) return [];
    try {
      return db.prepare(`SELECT o.id FROM client_order_links l
        JOIN client_dialogs d ON d.id=l.dialog_id AND d.bot_key=l.bot_key AND d.order_id=l.order_id AND d.company_code=?
        JOIN palitra_crm_orders o ON o.site_order_id=l.order_id AND o.company_code=?
        WHERE l.site='palitra' AND l.used_at IS NOT NULL AND d.telegram_user_id=?`).all(FIXED.companyCode, FIXED.companyCode, String(subject)).map((row) => row.id);
    } catch { return []; }
  } : null;

  /* ---------- проверка исходной сессии при КАЖДОМ использовании CRM-сессии ---------- */
  function validateSiteSession({ subject, sessionRef }) {
    const staff = SYNAPSE_SUBJECT.exec(subject);
    if (staff) {
      const row = db.prepare('SELECT * FROM palitra_crm_host_sessions WHERE cookie_ref=?').get(String(sessionRef));
      if (!row || row.revoked_at !== null || row.expires_at <= clock() || row.user_id !== Number(staff[1])) return false;
      const user = deps.authStore.getById(row.user_id);
      return Boolean(user && user.sessionVersion === row.session_version && staffRoleOf(user));
    }
    const buyer = DRAFT_SUBJECT.exec(subject);
    if (buyer) {
      const service = account();
      if (!service) return false;
      // Только чтение существующей таблицы сессий магазина (одна база для всех адресов): выход и истечение закрывают доступ.
      const rows = service.db.prepare('SELECT token_hash FROM sessions WHERE user_id=? AND expires_at>?').all(buyer[1], service.now());
      return rows.some((row) => sameHex(sessionRef, refOf(`draft:${FIXED.draftId}:${row.token_hash}`)));
    }
    return false;
  }
  const siteRole = ({ subject }) => {
    const staff = SYNAPSE_SUBJECT.exec(subject);
    return staff ? staffRoleOf(deps.authStore.getById(Number(staff[1]))) : null;
  };
  const siteStaff = () => [...config.staff.keys()].map((id) => deps.authStore.getById(id)).filter((user) => staffRoleOf(user))
    .map((user) => ({ provider: 'site', subject: `synapse:${user.id}`, name: String(user.displayName || user.login || 'Сотрудник').slice(0, 128), role: staffRoleOf(user) }));

  // Личность определяет только сервер; JSON клиента сюда не попадает (crm-http принимает лишь пустое тело).
  async function resolveSitePrincipal(req) {
    const host = hostOf(req);
    if (shop.hostnames.includes(host)) {
      const found = buyerSession(req);
      if (!found) return null;
      return { provider: 'site', subject: `draft:${FIXED.draftId}:${found.user.id}`,
        name: `${found.user.first_name || ''} ${found.user.last_name || ''}`.trim().slice(0, 128),
        sessionRef: refOf(`draft:${FIXED.draftId}:${found.session.token_hash}`) };
    }
    if (host === synapseHost) {
      const found = staffSession(req);
      if (!found) return null;
      if (!staffRoleOf(found.user)) throw Object.assign(new Error('Доступ к приложению Palitra для этого аккаунта не настроен'), { status: 403 });
      const ref = linkHostSession(found.user, found.session);
      if (!ref) return null;
      return { provider: 'site', subject: `synapse:${found.user.id}`, name: String(found.user.displayName || found.user.login || '').slice(0, 128), sessionRef: ref };
    }
    return null;
  }

  const { createPalitraCrm } = deps.loadIntegration();
  const crm = createPalitraCrm({ db, transact: deps.transaction, siteOrders: deps.siteOrders,
    priceReader: (site) => (site === 'palitra' ? deps.priceRow()?.body ?? null : null),
    botId: config.botId, ...(deps.telegramPublicKeyHex ? { publicKeyHex: deps.telegramPublicKeyHex } : {}), now: clock,
    validateSiteSession, resolveSitePrincipal, siteRole, siteStaff, telegramBind, telegramRole, hostOrders,
    staffEditorUrl: EDITOR_URL, ...(deps.publicDir ? { publicDir: deps.publicDir } : {}),
    allowedOrigins: [...shop.origins, config.synapseOrigin], clientIp: deps.clientIp,
    email: { enabled: false }, teamNotify: { enabled: false }, telegramIngest: null, instagram: null });

  async function handleSynapse(request, response) {
    if (hostOf(request) !== synapseHost) return false;
    const url = new URL(request.url, 'http://localhost');
    if (!isCrmPath(url.pathname)) return false;
    return crm.handle(request, response);
  }
  return { crm, buyerSession, revokeHostSession, handleSynapse, isCrmPath };
}

module.exports = { createPalitraHostAdapter, parseConfig, parseCheckout, parseShop, shopConfig, withShopOrigin, FIXED, EDITOR_URL };
