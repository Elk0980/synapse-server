'use strict';

// Защищённый обработчик /api/crm/*. Хост отвечает за TLS, лимиты входа, проверенную сессию сайта и развёртывание.
// Модуль не слушает сокет, не выдаёт ролей, не читает секреты бота и не запускает фоновых процессов.
const { isIP } = require('node:net');
const { createApiRoutes } = require('./api-routes');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const COMPANY = 'palitra-love';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createCrmHttp({ db, access, workspace, fallback, allowedOrigins, prefix = '/api/crm', resolveSitePrincipal = null, clientIp }) {
  if (!access || !workspace || !fallback || !Array.isArray(allowedOrigins) || !allowedOrigins.length) throw new TypeError('Требуются серверные зависимости CRM');
  if (typeof clientIp !== 'function') throw new TypeError('Требуется проверенный определитель адреса клиента от сервера');
  const origins = new Set(allowedOrigins.map((value) => {
    const parsed = new URL(value);
    if (parsed.origin !== value || !['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('Нужен точный Origin');
    return value;
  }));
  if (!/^\/[a-z0-9/-]+$/.test(prefix) || prefix.endsWith('/')) throw new TypeError('Некорректный префикс');
  db.exec(`CREATE TABLE IF NOT EXISTS palitra_crm_submissions (
    request_id TEXT PRIMARY KEY, company_code TEXT NOT NULL CHECK(company_code='palitra-love'),
    provider TEXT NOT NULL, subject TEXT NOT NULL, site_order_id INTEGER NOT NULL
  )`);
  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  };
  const body = async (req) => {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'Ожидались данные JSON');
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 4500000) fail(413, 'Данные слишком большие'); chunks.push(chunk); }
    let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'Некорректные данные'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Некорректные данные');
    return value;
  };
  const tokenOf = (req) => {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer pcrm\.[A-Za-z0-9_-]+$/.test(header)) fail(401, 'Откройте приложение заново');
    return header.slice(7);
  };

  /** Заказ покупателя из приложения: тот же контракт и ограничения, что у формы сайта, плюс проверенный аккаунт.
   * Доступ к созданному заказу выдаётся этому аккаунту в той же транзакции (workspace → onOrderCreated). */
  function submitForActor(input, actor, { req }) {
    if (!actor?.principal || actor.companyCode !== COMPANY || actor.role !== 'customer') fail(403, 'Доступ закрыт');
    // Хост применяет собственную политику доверенных прокси. X-Forwarded-For здесь не читается.
    const ip = clientIp(req);
    if (typeof ip !== 'string' || !isIP(ip)) fail(503, 'Не удалось проверить источник заявки');
    const requestId = String(input?.requestId || '').toLowerCase();
    if (!UUID_V4.test(requestId)) fail(400, 'Обновите страницу и повторите отправку');
    return workspace.tx(() => {
      const previous = db.prepare('SELECT * FROM palitra_crm_submissions WHERE request_id=?').get(requestId);
      if (previous && (previous.provider !== actor.principal.provider || previous.subject !== actor.principal.subject)) fail(409, 'Эту отправку нельзя повторить из другого аккаунта');
      const out = workspace.submitSite(input, { requestOrigin: req.headers.origin, ip, principal: actor.principal, appCustomer: true });
      const siteId = out.result.body.orderId;
      if (!siteId) return out.result;
      // Совпавший requestId публичной/гостевой заявки не доказывает, что она принадлежит этому аккаунту.
      if (out.result.status !== 201 && !previous) fail(409, 'Откройте исходную заявку через подтверждённый аккаунт');
      if (out.result.status === 201) {
        db.prepare('INSERT INTO palitra_crm_submissions(request_id,company_code,provider,subject,site_order_id) VALUES(?,?,?,?,?)')
          .run(requestId, COMPANY, actor.principal.provider, actor.principal.subject, siteId);
      }
      return { status: out.result.status, body: { ok: true, duplicate: out.result.status !== 201, requestId, inquiryId: out.inquiryId, orderId: out.orderId,
        message: out.orderId ? `Заказ №${out.orderId} сохранён. Менеджер свяжется с вами и подтвердит детали.` : 'Заявка сохранена. Менеджер свяжется с вами.' } };
    });
  }
  const routes = createApiRoutes({ workspace, fallback, submitCustomerOrder: submitForActor });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return false;
    const route = url.pathname.slice(prefix.length);
    try {
      if (Object.hasOwn(req.headers, 'x-demo-actor')) fail(403, 'Демонстрационный вход здесь недоступен');
      if (!['GET', 'POST', 'PUT'].includes(req.method)) fail(405, 'Метод не поддерживается');
      if (req.method !== 'GET' && !origins.has(req.headers.origin)) fail(403, 'Запрос с другого адреса запрещён');
      if (url.search) fail(400, 'Параметры адреса не принимаются');
      if (req.method === 'POST' && route === '/session/telegram') {
        const input = await body(req);
        if (Object.keys(input).some((key) => key !== 'initData')) fail(400, 'Некорректные данные входа');
        json(res, 200, access.exchangeTelegram(input.initData)); return true;
      }
      if (req.method === 'POST' && route === '/session/site') {
        // Адаптер ОБЯЗАН проверить исходную cookie, активный аккаунт и CSRF; личность из JSON не принимается.
        if (!resolveSitePrincipal) fail(503, 'Вход через сайт пока не подключён');
        const input = await body(req);
        if (Object.keys(input).length) fail(400, 'Личность определяется сервером');
        const identity = await resolveSitePrincipal(req);
        if (!identity || identity.provider !== 'site') fail(401, 'Войдите в аккаунт сайта');
        json(res, 200, access.exchangeSite(identity)); return true;
      }
      const token = tokenOf(req);
      // Каждый вызов заново проверяет сессию, membership и исходную сессию сайта.
      const getActor = () => { const actor = access.resolve(token); if (!actor) fail(401, 'Откройте приложение заново'); return actor; };
      getActor();
      if (route === '/session' && req.method === 'POST') { access.revokeSession(token); json(res, 200, { ok: true }); return true; }
      const result = await routes({ method: req.method, path: route, getActor, readBody: () => body(req), context: { req } });
      json(res, result.status, result.body);
      return true;
    } catch (error) {
      json(res, error.status || 500, { error: error.status ? error.message : 'Не удалось выполнить действие',
        ...(error.status && typeof error.code === 'string' && /^[A-Z_]{2,32}$/.test(error.code) ? { code: error.code } : {}) });
      return true;
    }
  }
  return { handle };
}

module.exports = { createCrmHttp };
