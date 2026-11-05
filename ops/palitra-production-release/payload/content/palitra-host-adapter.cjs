'use strict';
/* Palitra ↔ существующий сервис content (Synapse). Единственная точка подключения магазина и MVP CRM к хосту.
   Phase 2 (CRM) + Phase 3 (узкое оформление заказа), 13.10.2026.

   ВСЁ ВЫКЛЮЧЕНО ПО УМОЛЧАНИЮ. Две независимые части с общим адресом магазина (PALITRA_SHOP_ORIGIN):
   1) Оформление (PALITRA_CHECKOUT_ENABLED==='true'): на точном хосте фиксированного магазина
      site-44bbe13f1bad5e005b2a / palitra-love — живой центральный прайс (GET/HEAD /api/price, /data/price.json) и
      POST /api/orders → тот же существующий siteOrders.submit, что у /public-orders/palitra: тело до 32 КБ, requestId,
      проверка, цены из прайса, outbox — внутри siteOrders; ссылка клиентского бота — тот же issueOrderLink только для
      новой (201) заявки. Не требует бота CRM, сотрудников и пакета CRM. Новой сущности заказа, outbox, БД, бота,
      опроса и транспорта нет. Origin обязан быть ровно адресом магазина.
   2) CRM (PALITRA_CRM_ENABLED==='true' + явный PALITRA_CRM_BOT_ID): тот же хук и та же заявка — один раз, через
      workspace.submitSite (внутри тот же siteOrders.submit), плюс /api/crm/* и /palitra-app/* (см. ниже).
      Сбой инициализации CRM не выключает оформление: оно продолжает работать без CRM, причина в журнале.

   CRM:
   - Одна SQLite хоста и вложенная транзакция projectChat.transaction (как у siteOrders).
   - Сотрудник Synapse: cookie кабинета (HMAC, срок exp, sessionVersion) + CSRF кабинета + точный Origin приложения.
     CRM-сессия ссылается на ЭТУ cookie (cookieRef — server-only HMAC) строкой palitra_crm_host_sessions: срок cookie,
     выход из кабинета (/content/logout отзывает именно эту cookie), смена sessionVersion и снятие роли закрывают доступ.
   - Сотрудник в Telegram: только существующая проверенная привязка project_chat_telegram_links (Mini App чата проекта)
     к живому аккаунту + PALITRA_CRM_STAFF + назначение на palitra-love; перепроверяется при каждом запросе.
   - Роль сотрудника — только явный PALITRA_CRM_STAFF (id аккаунта Synapse → owner|admin). Без него сотрудников нет.
   - Никаких отправок, polling/webhook, второго планировщика, чтения секретов, выдачи прав и сопоставления по имени,
     телефону или номеру заказа. Почта/уведомления команды/приём Telegram и Instagram — выключены. */
const crypto = require('node:crypto');

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

/* Точный https-origin без порта, учётных данных, пути и *; иначе null. */
function exactHttpsOrigin(raw) {
  let parsed = null;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.origin !== raw || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
    || raw.includes('*') || !/^[a-z0-9.-]+$/.test(parsed.hostname)) return null;
  return parsed;
}

/* Общий адрес магазина: по умолчанию ровно текущий черновик; перенос домена — только этой настройкой. */
function parseShop(env = {}) {
  const raw = String(env.PALITRA_SHOP_ORIGIN ?? '').trim() || `https://${FIXED.hostname}`;
  const url = exactHttpsOrigin(raw);
  if (!url) return { ok: false, reason: 'PALITRA_SHOP_ORIGIN должен быть точным https-origin без порта, пути и *' };
  return { ok: true, shop: Object.freeze({ origin: raw, hostname: url.hostname, canonicalHostname: FIXED.hostname,
    draftId: FIXED.draftId, companyCode: FIXED.companyCode }) };
}
/* Оформление заказа: только явный флаг и корректный адрес магазина. Бот CRM и сотрудники не нужны. */
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
  if (!synapseUrl || synapseUrl.hostname === shop.hostname) {
    return { enabled: false, reason: 'PALITRA_CRM_SYNAPSE_ORIGIN должен быть точным https-origin, отличным от адреса магазина' };
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
/* Для рабочего пространства и siteOrders: адрес магазина, если включено оформление или CRM; иначе null. */
function shopConfig(env = {}) {
  const crm = parseConfig(env);
  if (crm.enabled) return crm.shop;
  const checkout = parseCheckout(env);
  return checkout.enabled ? checkout.shop : null;
}
/* Существующий список Origin заявок Palitra дополняется ровно адресом магазина — только при включении.
   Другие сайты, общий outbox, проверка прайса и requestId не меняются; без настройки возвращается тот же объект. */
function withShopOrigin(orderSites, env = {}) {
  const shop = shopConfig(env);
  const palitra = orderSites && Object.hasOwn(orderSites, 'palitra') ? orderSites.palitra : null;
  if (!shop || !palitra || !Array.isArray(palitra.origins) || palitra.companyCode !== FIXED.companyCode) return orderSites;
  if (palitra.origins.includes(shop.origin)) return orderSites;
  return { ...orderSites, palitra: { ...palitra, origins: [...palitra.origins, shop.origin] } };
}

const off = (reason) => Object.freeze({ enabled: false, checkoutEnabled: false, crmEnabled: false, reason, draftHook: null,
  handleSynapse: async () => false, revokeHostSession: () => false, health: () => Object.freeze({ enabled: false }) });
const oneLine = (error) => String(error?.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 300);

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
  /* POST /api/orders магазина = существующий /public-orders/palitra: тот же siteOrders.submit (CRM — через
     workspace.submitSite, внутри тот же вызов, один раз), те же ответы и ссылка клиентского бота только для 201.
     Гость принимается как раньше; покупатель CRM закрепляется только проверенной сессией (только при CRM). */
  async function submitOrder(req, res) {
    const origin = deps.originOf(req);
    if (origin !== shop.origin) return json(res, 403, ORIGIN_REFUSED);
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return json(res, 415, { error: 'Ожидался JSON' });
    let body;
    try { body = JSON.parse((await readLimited(req, ORDER_BODY_LIMIT)).toString('utf8')); }
    catch (error) { return error.status === 413 ? json(res, 413, { error: error.message }) : json(res, 400, { error: 'Некорректный JSON' }); }
    const ip = deps.clientIp(req);
    try {
      let result;
      if (crmPart) {
        // Сессия покупателя проверяется ПОСЛЕ чтения тела: выход во время загрузки не закрепляет заявку за аккаунтом.
        const buyer = crmPart.buyerSession(req);
        const principal = buyer ? { provider: 'site', subject: `draft:${FIXED.draftId}:${buyer.user.id}` } : null;
        result = crmPart.crm.submitPublicOrder({ body, origin, ip, principal });
      } else {
        result = deps.siteOrders.submit({ site: 'palitra', body, origin, ip });
      }
      if (result.status === 201 && typeof deps.issueOrderLink === 'function') {
        try { const link = deps.issueOrderLink({ site: 'palitra', orderId: result.body.orderId }); if (link) result.body.telegram = link; }
        catch (error) { console.error('content: ссылка на клиентский бот не выдана:', error.message); }
      }
      return json(res, result.status, result.body);
    } catch (error) {
      if (!ORDER_ERRORS.includes(error.status)) {
        console.error('content: заявка Palitra не принята:', oneLine(error).slice(0, 200));
        return json(res, 500, { error: 'Не удалось принять заявку. Повторите отправку позже.' });
      }
      return json(res, error.status, { ok: false, code: error.code || 'VALIDATION', error: error.message, ...(error.itemId ? { itemId: error.itemId } : {}) },
        error.status === 429 ? { 'Retry-After': '600' } : {});
    }
  }

  const draftHook = Object.freeze({ draftId: FIXED.draftId, companyCode: FIXED.companyCode, hostname: shop.hostname,
    async handle({ request, response, url, draft, hostname }) {
      // Повторная точная проверка: хук не открывается для других черновиков, компаний и адресов.
      if (hostname !== shop.hostname || draft?.id !== FIXED.draftId || draft?.company_code !== FIXED.companyCode) return false;
      if (PRICE_PATHS.has(url.pathname) && ['GET', 'HEAD'].includes(request.method)) { servePrice(request, response); return true; }
      if (url.pathname === '/api/orders' && request.method === 'POST') { await submitOrder(request, response); return true; }
      if (crmPart && crmPart.isCrmPath(url.pathname)) return crmPart.crm.handle(request, response);
      return false;
    } });
  return Object.freeze({ enabled: true, checkoutEnabled: checkout.enabled, crmEnabled: Boolean(crmPart), reason: crmReason, draftHook,
    handleSynapse: crmPart ? crmPart.handleSynapse : async () => false,
    revokeHostSession: crmPart ? crmPart.revokeHostSession : () => false,
    // Только для серверной диагностики, не публичный маршрут: без контактов и секретов.
    health: () => Object.freeze({ enabled: true, checkout: checkout.enabled, crm: Boolean(crmPart), shopOrigin: shop.origin,
      ...(crmPart ? { ...crmPart.crm.health(), staffConfigured: crmConfig.staff.size } : {}) }),
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
  const hostOf = (req) => String(req.headers.host || '').toLowerCase().split(':')[0];
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

  /* ---------- покупатель: существующий AccountService магазина ---------- */
  const account = () => deps.draftAccount();
  function buyerSession(req) {
    if (req.headers.origin !== shop.origin) return null;
    const service = account();
    if (!service) return null;
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
  /* Необязательно (PALITRA_CRM_CLIENT_BOT_ORDERS=true): заказ, чья одноразовая ссылка клиентского бота была
     использована личным чатом этого Telegram ID (client_order_links.used_at + тот же диалог и та же заявка).
     Ручная связь менеджера, телефон, имя и номер заказа доступа не дают. */
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
      // Только чтение существующей таблицы сессий магазина: выход и истечение сессии закрывают доступ.
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
    if (host === shop.hostname) {
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
    allowedOrigins: [shop.origin, config.synapseOrigin], clientIp: deps.clientIp,
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
