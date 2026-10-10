'use strict';
/*
 * Palitra — тестовый просмотр интерфейса внутри Telegram (HTTPS, Vercel Node 24 serverless).
 * НЕ рабочая CRM: вымышленные данные, роли выбираются переключателем (заголовок X-Demo-Actor — демонстрация, не вход),
 * никаких реальных каналов: почта и уведомления команды выключены и без адаптеров, Telegram-бот/Instagram/SMTP не
 * подключены, initData и данные Telegram не принимаются, не читаются и не хранятся.
 *
 * Каждая браузерная сессия получает СВОЮ базу node:sqlite :memory: с примерами из кода (workspace.seed()); вводы
 * посетителей не смешиваются. Сессия живёт только в памяти экземпляра функции: после холодного старта или вытеснения
 * интерфейс получает явный признак сброса (заголовок X-Preview-Session: reset), а изменения на сброшенной сессии
 * отклоняются (409 PREVIEW_RESET), чтобы не выполнить их «вслепую» в новой базе.
 *
 * Модуль не слушает порт и не читает файлы SQLite; статика — только из фиксированного списка.
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createWorkspace, ACTORS } = require('./lib/workspace');
const { createInquiryEmailFallback } = require('./lib/email-fallback');
const { createApiRoutes } = require('./lib/api-routes');
const { createTeamNotifier } = require('./lib/team-notify');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { sqlite = null; }

const COOKIE = '__Host-palitra_preview';
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;
const BODY_LIMIT = 4_500_000; // как у принятого приложения и у ограничения запроса Vercel
// Сверх лимита тело дочитывается без хранения (память не растёт) — тогда 413 приходит чисто. Поток длиннее этой
// границы считается злоупотреблением: чтение прекращается, соединение закрывается после ответа (клиент может увидеть
// и обрыв вместо 413). Время чтения дополнительно ограничивает сервер (requestTimeout / лимиты платформы).
const DRAIN_LIMIT = 64 * 1024 * 1024;
// Внутренний адрес для модуля заказов сайта (он принимает заявки только с известного адреса). Не открывается.
const WORK_ORIGIN = 'https://palitra-preview.invalid';
const LABEL = 'Тестовый просмотр · вымышленные данные';
const TELEGRAM_FRAMES = 'https://web.telegram.org https://telegram.org https://*.telegram.org';
const HTML_CSP = "default-src 'none'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' data:; "
  + "connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; "
  + `frame-ancestors ${TELEGRAM_FRAMES}`;
const PUBLIC = path.join(__dirname, 'public');
const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8', csp: HTML_CSP },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/preview.js': { file: 'preview.js', type: 'text/javascript; charset=utf-8' },
  '/preview.css': { file: 'preview.css', type: 'text/css; charset=utf-8' }
};
const FILES = new Map(Object.values(STATIC).map((entry) => [entry.file, fs.readFileSync(path.join(PUBLIC, entry.file))]));

const failure = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

/**
 * Разрешённые Origin для изменений. Только из окружения сервера (системные переменные Vercel о ЭТОМ развёртывании и
 * необязательный список PREVIEW_ORIGINS, например собственный домен с www), никогда из Host/X-Forwarded-* запроса.
 */
function allowedOriginsFromEnv(env = process.env) {
  const out = new Set();
  for (const key of ['VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL']) {
    const host = String(env[key] || '').trim().toLowerCase();
    if (/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host)) out.add(`https://${host}`);
  }
  for (const raw of String(env.PREVIEW_ORIGINS || '').split(',').map((v) => v.trim()).filter(Boolean)) {
    try {
      const url = new URL(raw);
      const loopback = url.protocol === 'http:' && url.hostname === '127.0.0.1';
      if (url.origin === raw && (url.protocol === 'https:' || loopback)) out.add(raw);
    } catch { /* некорректная запись пропускается */ }
  }
  return out;
}

function createPreviewHandler({ origins = allowedOriginsFromEnv(), now = Date.now, maxSessions = 60,
  idleMs = 60 * 60 * 1000, maxAgeMs = 6 * 60 * 60 * 1000 } = {}) {
  const originSet = () => (typeof origins === 'function' ? origins() : origins);
  const sessions = new Map(); // id → сессия; порядок Map = давность использования (LRU)

  function close(session) { try { session.db.close(); } catch { /* уже закрыта */ } }
  function sweep() {
    const t = now();
    for (const [id, s] of sessions) if (t - s.lastAt > idleMs || t - s.createdAt > maxAgeMs) { sessions.delete(id); close(s); }
  }
  function createSession() {
    sweep();
    while (sessions.size >= maxSessions) {
      const [oldest, s] = sessions.entries().next().value;
      sessions.delete(oldest); close(s);
    }
    const db = new sqlite.DatabaseSync(':memory:');
    let workspace = null;
    // Почта и уведомления команды выключены, адаптеров отправки нет — как в принятой демонстрации.
    const fallback = createInquiryEmailFallback({ db, now, enabled: false,
      inquiryExists: (id) => workspace.inquiryExists(id), primaryJobs: (id) => workspace.primaryJobs(id) });
    const team = createTeamNotifier({ db, now, enabled: false, inquiryExists: (id) => workspace.inquiryExists(id) });
    workspace = createWorkspace({ db, origin: WORK_ORIGIN, now, notifier: fallback, teamNotifier: team });
    workspace.seed(); // только вымышленные примеры из кода
    const routes = createApiRoutes({ workspace, fallback, submitCustomerOrder: (input, actor) => {
      const out = workspace.submitSite(input, { requestOrigin: WORK_ORIGIN, ip: 'preview-visitor', principal: actor.principal, appCustomer: true });
      return { status: out.result.status, body: { ...out.result.body, inquiryId: out.inquiryId, orderId: out.orderId,
        message: out.orderId ? `Тестовый заказ №${out.orderId} записан только в этой тестовой сессии. Никуда не отправлялся.`
          : 'Тестовая заявка записана только в этой тестовой сессии. Никуда не отправлялась.' } };
    } });
    const id = randomBytes(32).toString('base64url');
    const session = { id, db, workspace, fallback, team, routes, createdAt: now(), lastAt: now() };
    sessions.set(id, session);
    return session;
  }
  function cookieOf(req) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return null;
  }
  const setCookie = (session) => `${COOKIE}=${session.id}; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}; HttpOnly; Secure; SameSite=None; Partitioned`;

  function send(res, status, body, headers = {}) {
    if (res.headersSent || res.destroyed) return;
    const payload = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', ...headers });
    res.end(payload);
  }
  /**
   * Тело JSON не больше BODY_LIMIT. При превышении данные дальше НЕ накапливаются, но поток не обрывается посреди
   * загрузки: остаток дочитывается и выбрасывается (не больше DRAIN_LIMIT), затем 413 с «Connection: close», чтобы
   * клиент не переиспользовал это соединение. Раньше выход из for await уничтожал запрос (и сокет) до ответа.
   */
  function readJson(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return Promise.reject(failure(415, 'Ожидался JSON'));
    const declared = Number(req.headers['content-length']);
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0, over = false, done = false;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        req.removeListener('data', onData); req.removeListener('end', onEnd); req.removeListener('error', onError); req.removeListener('aborted', onAborted);
        if (error) reject(error); else resolve(value);
      };
      const tooLarge = () => Object.assign(failure(413, 'Файл слишком большой'), { closeConnection: true });
      function onData(chunk) {
        size += chunk.length;
        if (!over && size > BODY_LIMIT) { over = true; chunks.length = 0; }
        if (over) {
          // Дочитывание ограничено: слишком большой поток закрываем после ответа (см. send → Connection: close).
          if (size > DRAIN_LIMIT) { req.pause(); finish(Object.assign(tooLarge(), { destroyAfter: true })); }
          return;
        }
        chunks.push(chunk);
      }
      function onEnd() {
        if (over) return finish(tooLarge());
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return finish(failure(400, 'Некорректные данные')); }
        if (!value || typeof value !== 'object' || Array.isArray(value)) return finish(failure(400, 'Некорректные данные'));
        finish(null, value);
      }
      function onError() { finish(Object.assign(failure(400, 'Запрос прерван'), { closeConnection: true })); }
      function onAborted() { finish(Object.assign(failure(400, 'Запрос прерван'), { closeConnection: true })); }
      // Заявленный размер больше дочитываемого — сразу 413, без чтения.
      if (Number.isFinite(declared) && declared > DRAIN_LIMIT) { req.pause(); finish(Object.assign(tooLarge(), { destroyAfter: true })); return; }
      req.on('data', onData); req.on('end', onEnd); req.on('error', onError); req.on('aborted', onAborted);
    });
  }
  function actorOf(req) {
    const key = req.headers['x-demo-actor'];
    if (typeof key !== 'string' || !Object.hasOwn(ACTORS, key)) throw failure(403, 'Участник не найден');
    return ACTORS[key];
  }

  return async function handler(req, res) {
    let extra = {};
    try {
      if (!['GET', 'HEAD', 'POST', 'PUT'].includes(req.method)) throw failure(405, 'Метод не поддерживается');
      const raw = String(req.url || '/');
      if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\x00-\x1f]/.test(raw)) throw failure(400, 'Некорректный адрес');
      const url = new URL(raw, 'http://preview.invalid');
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw failure(400, 'Некорректный адрес'); }
      if (pathname !== url.pathname || pathname.includes('..') || pathname.includes('//')) throw failure(404, 'Не найдено');

      if (pathname.startsWith('/api/')) {
        if (url.search) throw failure(400, 'Параметры адреса не принимаются');
        if (req.method === 'GET' && pathname === '/api/health') {
          return send(res, 200, { ok: true, mode: 'telegram-preview', label: LABEL, sqlite: Boolean(sqlite),
            email: 'off', teamTelegram: 'disabled', telegramBot: 'not_connected', instagram: 'not_connected', crm: 'not_connected',
            sessions: sessions.size });
        }
        if (!sqlite) throw failure(503, 'Тестовый просмотр недоступен на этом сервере');
        const mutation = !['GET', 'HEAD'].includes(req.method);
        // Изменения — только со страницы этого развёртывания. Host и X-Forwarded-* для проверки не используются.
        if (mutation && !originSet().has(String(req.headers.origin || ''))) throw failure(403, 'Запрос с другого адреса запрещён');

        sweep();
        const cookieId = cookieOf(req);
        let session = cookieId && SESSION_ID.test(cookieId) ? sessions.get(cookieId) : null;
        let state = 'existing';
        if (session) {
          session.lastAt = now();
          sessions.delete(session.id); sessions.set(session.id, session); // свежая по LRU
        } else {
          state = cookieId ? 'reset' : 'new';
          session = createSession();
        }
        extra = { 'X-Preview-Session': state, 'Set-Cookie': setCookie(session) };
        if (mutation && state !== 'existing') {
          // Новая/сброшенная база: прежние карточки и версии на экране к ней не относятся. Не выполняем.
          // 423, а не 409: интерфейс не должен принять это за правку другого сотрудника и перечитывать карточку.
          throw state === 'reset'
            ? failure(423, 'Тестовая сессия сброшена — вымышленные данные начаты заново. Действие не выполнено, нажмите «Начать заново».', 'PREVIEW_RESET')
            : failure(423, 'Тестовая сессия не сохранилась (браузер не принял cookie). Действие не выполнено, нажмите «Начать заново».', 'PREVIEW_NO_SESSION');
        }
        // Публичная форма сайта: без участника, источник всегда «сайт».
        if (req.method === 'POST' && pathname === '/api/orders' && !Object.hasOwn(req.headers, 'x-demo-actor')) {
          const out = session.workspace.submitSite(await readJson(req), { requestOrigin: WORK_ORIGIN, ip: 'preview-visitor' });
          return send(res, out.result.status, { ...out.result.body, message: 'Тестовая заявка записана только в этой тестовой сессии. Никуда не отправлялась.' }, extra);
        }
        const result = await session.routes({ method: req.method, path: pathname.slice(4), getActor: () => actorOf(req),
          readBody: () => readJson(req), context: { req } });
        return send(res, result.status, result.body, extra);
      }

      const entry = Object.hasOwn(STATIC, pathname) ? STATIC[pathname] : null;
      if (!entry) throw failure(404, 'Не найдено');
      if (!['GET', 'HEAD'].includes(req.method)) throw failure(405, 'Метод не поддерживается');
      const content = FILES.get(entry.file);
      res.writeHead(200, { 'Content-Type': entry.type, 'Content-Length': content.length, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
        ...(entry.csp ? { 'Content-Security-Policy': entry.csp } : {}) });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      // Превышение размера: соединение после ответа закрывается (клиент не переиспользует его); если поток
      // пришлось прервать раньше конца, сокет уничтожается только ПОСЛЕ отправки ответа.
      if (error.destroyAfter) res.once('finish', () => { try { req.socket.destroy(); } catch { /* уже закрыт */ } });
      send(res, error.status || 500, { error: error.status ? error.message : 'Не удалось выполнить действие',
        ...(error.status && typeof error.code === 'string' && /^[A-Z_]{2,32}$/.test(error.code) ? { code: error.code } : {}) },
      { ...extra, ...(error.closeConnection ? { Connection: 'close' } : {}) });
    }
  };
}

module.exports = { createPreviewHandler, allowedOriginsFromEnv, STATIC, HTML_CSP, COOKIE, LABEL, BODY_LIMIT, DRAIN_LIMIT };
