'use strict';
/*
 * Palitra — тестовый просмотр интерфейса внутри Telegram (HTTPS, Vercel Node 24 serverless или отдельный Node-сервис).
 * НЕ рабочая CRM: вымышленные данные, роли выбираются переключателем (заголовок X-Demo-Actor — демонстрация, не вход),
 * никаких реальных каналов: почта и уведомления команды выключены и без адаптеров, Telegram-бот/Instagram/SMTP не
 * подключены, initData и данные Telegram не принимаются, не читаются и не хранятся.
 *
 * Каждая браузерная сессия получает СВОЮ базу node:sqlite :memory: с примерами из кода (workspace.seed()); вводы
 * посетителей не смешиваются. Сессия живёт только в памяти процесса: после перезапуска или вытеснения интерфейс
 * получает явный признак сброса (заголовок X-Preview-Session: reset), а изменения на сброшенной сессии отклоняются
 * (423 PREVIEW_RESET), чтобы не выполнить их «вслепую» в новой базе.
 *
 * Поколение базы: у каждой сессии свой несекретный случайный идентификатор (X-Preview-Context). Страница запоминает
 * его из первого ответа и присылает в каждом запросе; другой идентификатор при той же cookie (другая вкладка начала
 * новый тест, ответ о переключении потерялся) → 423 PREVIEW_CONTEXT_CHANGED без изменений и без данных другой базы.
 * Живость сессии проверяется заново после чтения тела: закрытая база ничего не записывает и не возвращает свою cookie.
 *
 * Парный тест с сайтом-черновиком (только если сервер настроен адресом черновика — см. draftFromEnv):
 * - сотрудник нажимает «Проверить с черновиком» → POST /api/draft-test {action:'start', requestId} создаёт НОВУЮ
 *   сессию без примеров, с неизменяемым снимком публичного прайса черновика (data/draft-price.json) и отдельным
 *   вымышленным покупателем (provider preview_test, случайный subject, собственный id — не демонстрационная «Анна»).
 *   Повтор того же requestId после потерянного ответа возвращает уже созданный тест, а не создаёт/уничтожает новый;
 *   новый тест поверх существующего — только отдельным действием restart;
 * - ссылка на черновик несёт только одноразовый ключ (32 случайных байта) во фрагменте #palitra-test=…:
 *   фрагмент не уходит на сервер и в журналы; cookie сотрудника и номер его сессии в ссылку не попадают;
 * - на черновике тот же процесс обслуживает только пространство /_palitra_test/ (отдельный маршрут прокси):
 *   ключ меняется на собственный cookie __Host-palitra_test (HttpOnly, Secure, SameSite=Lax). Cookie на сайте одна,
 *   поэтому у пары есть ещё несекретный идентификатор (X-Palitra-Test-Context): вкладка хранит ожидаемый и
 *   присылает его; изменение без него или с чужим → 423 без записи. X-Demo-Actor там запрещён; изменения — только с
 *   точного Origin черновика;
 * - тест живёт в памяти вместе с сессией сотрудника (не дольше 6 ч, простой 60 мин); после этого, нового теста или
 *   перезапуска любые действия покупателя получают 423 и не выполняются.
 *
 * Модуль не слушает порт и не читает файлы SQLite; статика — только из фиксированного списка.
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { createWorkspace, ACTORS, COMPANY } = require('./lib/workspace');
const { createInquiryEmailFallback } = require('./lib/email-fallback');
const { createApiRoutes } = require('./lib/api-routes');
const { createTeamNotifier } = require('./lib/team-notify');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { sqlite = null; }

const COOKIE = '__Host-palitra_preview';
const TEST_COOKIE = '__Host-palitra_test';
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEST_PREFIX = '/_palitra_test/';
const TEST_FRAGMENT = 'palitra-test';
const BODY_LIMIT = 4_500_000; // как у принятого приложения и у ограничения запроса Vercel
// Сверх лимита тело дочитывается без хранения (память не растёт) — тогда 413 приходит чисто. Поток длиннее этой
// границы считается злоупотреблением: чтение прекращается, соединение закрывается после ответа (клиент может увидеть
// и обрыв вместо 413). Время чтения дополнительно ограничивает сервер (requestTimeout / лимиты платформы).
const DRAIN_LIMIT = 64 * 1024 * 1024;
// Внутренний адрес для модуля заказов сайта (он принимает заявки только с известного адреса). Не открывается.
const WORK_ORIGIN = 'https://palitra-preview.invalid';
const LABEL = 'Тестовый просмотр · вымышленные данные';
const TEST_BUYER_NAME = 'Покупатель черновика · тест';
const TELEGRAM_FRAMES = 'https://web.telegram.org https://telegram.org https://*.telegram.org';
const HTML_CSP = "default-src 'none'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' data:; "
  + "connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; "
  + `frame-ancestors ${TELEGRAM_FRAMES}`;
// Страница тестовых заказов на черновике: только свои скрипты, без SDK Telegram и без встраивания в чужие рамки.
const TEST_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
  + "font-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'";
const PUBLIC = path.join(__dirname, 'public');
const SITE_PUBLIC = path.join(__dirname, '..', '..', 'public');
const JS = 'text/javascript; charset=utf-8', CSS = 'text/css; charset=utf-8', HTML = 'text/html; charset=utf-8';
const STATIC = {
  '/': { file: 'index.html', type: HTML, csp: HTML_CSP },
  '/app.js': { file: 'app.js', type: JS },
  '/app.css': { file: 'app.css', type: CSS },
  '/preview.js': { file: 'preview.js', type: JS },
  '/preview.css': { file: 'preview.css', type: CSS },
  '/draft-pair.js': { file: 'draft-pair.js', type: JS }
};
// Пространство черновика: страница «Мои тестовые заказы» на принятом интерфейсе и (по желанию) сам скрипт моста.
const TEST_STATIC = {
  '/_palitra_test/': { file: 'buyer.html', type: HTML, csp: TEST_CSP },
  '/_palitra_test/app.js': { file: 'app.js', type: JS },
  '/_palitra_test/app.css': { file: 'app.css', type: CSS },
  '/_palitra_test/buyer.js': { file: 'buyer.js', type: JS },
  '/_palitra_test/buyer.css': { file: 'buyer.css', type: CSS },
  '/_palitra_test/draft-bridge.js': { file: 'draft-bridge.js', dir: SITE_PUBLIC, type: JS, optional: true }
};
const fileOf = (entry) => path.join(entry.dir || PUBLIC, entry.file);
const FILES = new Map();
for (const entry of [...Object.values(STATIC), ...Object.values(TEST_STATIC)]) {
  if (FILES.has(fileOf(entry))) continue;
  try { FILES.set(fileOf(entry), fs.readFileSync(fileOf(entry))); } catch (error) { if (!entry.optional) throw error; }
}

/* Снимок публичного прайса черновика: читается один раз и замораживается — это не «живой» прайс. */
const DRAFT_PRICE_FILE = path.join(__dirname, 'data', 'draft-price.json');
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const key of Object.keys(value)) deepFreeze(value[key]); }
  return value;
}
function loadDraftPrice(file = DRAFT_PRICE_FILE) {
  try { const doc = JSON.parse(fs.readFileSync(file, 'utf8')); return doc && Array.isArray(doc.categories) ? deepFreeze(doc) : null; } catch { return null; }
}
const DRAFT_PRICE = loadDraftPrice();

const failure = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
const digest = (value) => createHash('sha256').update(String(value)).digest('hex');
const token = (bytes) => randomBytes(bytes).toString('base64url');
const isStaff = (actor) => ['owner', 'admin'].includes(actor && actor.role);
const header = (req, name) => (typeof req.headers[name] === 'string' ? req.headers[name] : null);

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

/** Адрес сайта-черновика для парного теста: точный https-origin из PALITRA_DRAFT_ORIGIN, иначе тест выключен. */
function draftFromEnv(env = process.env) {
  const raw = String(env.PALITRA_DRAFT_ORIGIN || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.origin === raw ? { origin: raw, url: `${raw}/` } : null;
  } catch { return null; }
}

const MESSAGES = {
  switched: 'Тестовая сессия уже переключена или закрыта другим действием. Это действие не выполнено — обновите страницу.',
  context: 'Эта страница относится к другой тестовой базе (её переключили в другой вкладке или ответ о переключении не дошёл). Действие не выполнено — обновите страницу.',
  contextRequired: 'Страница не сообщила, к какой тестовой базе относится действие. Действие не выполнено — обновите страницу.',
  testExpired: 'Тест с приложением завершён: прошло до 6 часов, создан новый тест или тестовый сервер перезапущен. Действие не выполнено, корзина сохранена. Создайте новый тест в приложении.',
  testNoSession: 'Тестовая ссылка ещё не открыта в этом браузере. Откройте ссылку из приложения заново. Действие не выполнено.',
  testContext: 'В этом браузере открыт другой тест. Эта вкладка относится к прежнему — действие не выполнено, ничего не записано. Перейдите к текущему тесту явно.',
  testContextRequired: 'Вкладка не сообщила, к какому тесту относится действие. Действие не выполнено — обновите страницу.'
};

function createPreviewHandler({ origins = allowedOriginsFromEnv(), draft = draftFromEnv(), draftPrice = DRAFT_PRICE, now = Date.now,
  maxSessions = 60, idleMs = 60 * 60 * 1000, maxAgeMs = 6 * 60 * 60 * 1000 } = {}) {
  const originSet = () => (typeof origins === 'function' ? origins() : origins);
  const draftOf = () => (typeof draft === 'function' ? draft() : draft) || null;
  const testEnabled = () => Boolean(sqlite && draftOf() && draftPrice);
  const sessions = new Map(); // id → сессия; порядок Map = давность использования (LRU)
  const buyers = new Map(); // cookie покупателя черновика → id сессии с парой
  const capabilities = new Map(); // sha256(ключ из ссылки) → id сессии с парой

  const expired = (s) => now() - s.lastAt > idleMs || now() - s.createdAt > maxAgeMs;
  /** Сессия ещё та самая и не просрочена — проверяется заново после каждого ожидания (тело запроса). */
  const alive = (s) => Boolean(s) && sessions.get(s.id) === s && !expired(s);
  function drop(id) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    if (s.pair) { capabilities.delete(s.pair.capHash); if (s.pair.buyerSid) buyers.delete(s.pair.buyerSid); }
    try { s.db.close(); } catch { /* уже закрыта */ }
  }
  function sweep() { for (const [id, s] of [...sessions]) if (expired(s)) drop(id); }
  function touch(session) {
    session.lastAt = now();
    sessions.delete(session.id); sessions.set(session.id, session); // свежая по LRU
  }
  function createSession({ paired = false, lifecycle = null } = {}) {
    sweep();
    while (sessions.size >= maxSessions) drop(sessions.keys().next().value);
    const db = new sqlite.DatabaseSync(':memory:');
    let workspace = null;
    // Почта и уведомления команды выключены, адаптеров отправки нет — как в принятой демонстрации.
    const fallback = createInquiryEmailFallback({ db, now, enabled: false,
      inquiryExists: (id) => workspace.inquiryExists(id), primaryJobs: (id) => workspace.primaryJobs(id) });
    const team = createTeamNotifier({ db, now, enabled: false, inquiryExists: (id) => workspace.inquiryExists(id) });
    workspace = createWorkspace({ db, origin: WORK_ORIGIN, now, notifier: fallback, teamNotifier: team,
      ...(paired ? { priceReader: () => draftPrice } : {}) });
    // Примеры — только у обычного просмотра. Парный тест начинается с пустой базы.
    if (!paired) workspace.seed();
    const routes = createApiRoutes({ workspace, fallback, submitCustomerOrder: (input, actor) => {
      const out = workspace.submitSite(input, { requestOrigin: WORK_ORIGIN, ip: 'preview-visitor', principal: actor.principal, appCustomer: true });
      return { status: out.result.status, body: { ...out.result.body, inquiryId: out.inquiryId, orderId: out.orderId,
        message: out.orderId ? `Тестовый заказ №${out.orderId} записан только в этой тестовой сессии. Никуда не отправлялся.`
          : 'Тестовая заявка записана только в этой тестовой сессии. Никуда не отправлялась.' } };
    } });
    const id = token(32);
    let pair = null;
    if (paired) {
      const capability = token(32);
      pair = { capability, capHash: digest(capability), buyerSid: null, context: token(16),
        // Свой участник: не ACTORS.customer, поэтому демонстрационное исключение «Анны» к нему не относится.
        buyer: Object.freeze({ id: `draft-buyer-${token(12)}`, name: TEST_BUYER_NAME, role: 'customer', companyCode: COMPANY,
          principal: Object.freeze({ provider: 'preview_test', subject: token(16) }) }) };
      capabilities.set(pair.capHash, id);
    }
    const session = { id, generation: token(16), db, workspace, fallback, team, routes, pair, lifecycle, createdAt: now(), lastAt: now() };
    sessions.set(id, session);
    return session;
  }
  function cookieOf(req, name) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return null;
  }
  const setCookie = (session) => `${COOKIE}=${session.id}; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}; HttpOnly; Secure; SameSite=None; Partitioned`;
  const endsAt = (session) => Math.min(session.createdAt + maxAgeMs, session.lastAt + idleMs);
  const testCookie = (session) => `${TEST_COOKIE}=${session.pair.buyerSid}; Path=/; Max-Age=${Math.max(1, Math.floor((session.createdAt + maxAgeMs - now()) / 1000))}; HttpOnly; Secure; SameSite=Lax`;
  const times = (session) => ({ createdAt: new Date(session.createdAt).toISOString(), expiresAt: new Date(endsAt(session)).toISOString(),
    latestEnd: new Date(session.createdAt + maxAgeMs).toISOString(), idleMinutes: Math.round(idleMs / 60000) });
  /** Сведения о паре для приложения. Ссылку с ключом получает только сотрудник и только пока её не открыли. */
  function pairView(session, withLink) {
    const d = draftOf();
    return { ...times(session), claimed: Boolean(session.pair.buyerSid), buyerName: session.pair.buyer.name,
      draftOrigin: d ? d.origin : null,
      draftUrl: withLink && d && session.pair.capability ? `${d.url}#${TEST_FRAGMENT}=${session.pair.capability}` : null,
      price: { snapshot: true, updatedAt: typeof draftPrice?.updatedAt === 'string' ? draftPrice.updatedAt : null } };
  }
  /** Заголовки приложения считаются в момент ответа: закрытая за время запроса сессия не возвращает свою cookie. */
  const previewHeaders = (session, state) => (alive(session)
    ? { 'X-Preview-Session': state, 'Set-Cookie': setCookie(session), 'X-Preview-Context': session.generation, ...(session.pair ? { 'X-Preview-Pair': 'active' } : {}) }
    : { 'X-Preview-Session': 'reset' });

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
  /** Участник демонстрации. В парном тесте «Покупатель» — тот же вымышленный покупатель черновика. */
  function actorOf(req, session) {
    const key = req.headers['x-demo-actor'];
    if (typeof key !== 'string' || !Object.hasOwn(ACTORS, key)) throw failure(403, 'Участник не найден');
    return key === 'customer' && session && session.pair ? session.pair.buyer : ACTORS[key];
  }
  function stillAlive(session) { if (!alive(session)) throw failure(423, MESSAGES.switched, 'PREVIEW_SWITCHED'); }
  function serveStatic(req, res, entry) {
    const content = entry ? FILES.get(fileOf(entry)) : null;
    if (!content) throw failure(404, 'Не найдено');
    if (!['GET', 'HEAD'].includes(req.method)) throw failure(405, 'Метод не поддерживается');
    res.writeHead(200, { 'Content-Type': entry.type, 'Content-Length': content.length, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
      ...(entry.csp ? { 'Content-Security-Policy': entry.csp } : {}) });
    res.end(req.method === 'HEAD' ? undefined : content);
  }

  /* ---------- приложение: запуск, новый тест и выход из парного теста ---------- */
  const LIFECYCLE = ['start', 'restart', 'leave'];
  async function lifecycle(req, res, session, ctx) {
    const body = await readJson(req);
    if (Object.keys(body).length !== 2 || !LIFECYCLE.includes(body.action) || typeof body.requestId !== 'string' || !UUID_V4.test(body.requestId)) {
      throw failure(400, 'Проверьте действие');
    }
    stillAlive(session); // параллельный запрос мог уже переключить эту сессию — тогда ничего не делаем
    const actor = actorOf(req, session);
    const done = (status, target, replayed) => send(res, status, { ok: true, replayed, action: target.lifecycle.action, paired: Boolean(target.pair),
      pair: target.pair ? pairView(target, true) : null }, { ...previewHeaders(target, 'switched') });
    // Повтор после потерянного ответа: браузер уже принял cookie нового теста, а страница прислала прежнее поколение и
    // тот же requestId — возвращаем уже сделанное, ничего не создаём и не закрываем.
    const prior = session.lifecycle;
    if (prior && prior.requestId === body.requestId && prior.action === body.action && ctx === prior.fromGeneration) return done(200, session, true);
    if (ctx !== session.generation) throw failure(423, MESSAGES.context, 'PREVIEW_CONTEXT_CHANGED');
    if (body.action === 'start' && session.pair) throw failure(409, 'Тест с черновиком уже идёт. Новый тест — отдельной кнопкой «Новый тест».', 'PAIR_ACTIVE');
    if (body.action !== 'start' && !session.pair) throw failure(409, 'Парного теста сейчас нет — обновите страницу.', 'PAIR_ABSENT');
    if (body.action !== 'leave') {
      if (!isStaff(actor)) throw failure(403, 'Тест с черновиком запускает сотрудник: Дарья, Варвара или Влад', 'STAFF_ONLY');
      if (!testEnabled()) throw failure(503, 'Тест с черновиком не настроен на этом сервере', 'TEST_DISABLED');
    }
    // Прежняя база закрывается: её ссылка, cookie покупателя и вкладки с прежним поколением больше не действуют.
    drop(session.id);
    const next = createSession({ paired: body.action !== 'leave', lifecycle: { requestId: body.requestId, action: body.action, fromGeneration: session.generation } });
    return done(201, next, false);
  }

  /* ---------- черновик: пространство /_palitra_test/ ---------- */
  const ended = (hadCookie) => (hadCookie ? failure(423, MESSAGES.testExpired, 'TEST_EXPIRED') : failure(423, MESSAGES.testNoSession, 'TEST_NO_SESSION'));
  const testView = (session) => ({ ok: true, active: true, context: session.pair.context, ...times(session), buyer: { name: session.pair.buyer.name } });
  const testHeaders = (session) => ({ 'X-Palitra-Test': 'active', 'X-Palitra-Test-Context': session.pair.context });
  async function claim(req, res) {
    const body = await readJson(req);
    if (Object.keys(body).length !== 1 || typeof body.capability !== 'string' || !CAPABILITY.test(body.capability)) {
      throw failure(400, 'Некорректная тестовая ссылка', 'TEST_LINK_INVALID');
    }
    sweep(); // срок проверяется после чтения тела
    const id = capabilities.get(digest(body.capability));
    const session = id ? sessions.get(id) : null;
    if (!alive(session) || !session.pair) throw failure(423, 'Тестовая ссылка больше не действует: тест завершён, создан новый или сервер перезапущен. Создайте новый тест в приложении.', 'TEST_EXPIRED');
    const pair = session.pair;
    const current = cookieOf(req, TEST_COOKIE);
    if (pair.buyerSid) {
      // Повтор той же ссылки в том же браузере — то же состояние; в другом браузере ключ не переиспользуется.
      if (current !== pair.buyerSid) throw failure(409, 'Эта тестовая ссылка уже открыта в другом браузере. Создайте новый тест в приложении.', 'TEST_LINK_USED');
    } else {
      pair.buyerSid = token(32);
      pair.capability = null; // ссылка больше не выдаётся приложением
      buyers.set(pair.buyerSid, session.id);
    }
    touch(session);
    return send(res, 200, testView(session), { 'Set-Cookie': testCookie(session), ...testHeaders(session) });
  }
  async function testRoute(req, res, url, pathname) {
    if (!testEnabled()) throw failure(404, 'Не найдено');
    // На черновике участника не выбирают: подделанная роль сотрудника отклоняется целиком.
    if (Object.hasOwn(req.headers, 'x-demo-actor')) throw failure(403, 'На сайте роль не выбирается — тест показывает только своего покупателя', 'ROLE_FORBIDDEN');
    const sub = pathname.slice(TEST_PREFIX.length - 1);
    if (!sub.startsWith('/api/')) return serveStatic(req, res, Object.hasOwn(TEST_STATIC, pathname) ? TEST_STATIC[pathname] : null);
    if (url.search) throw failure(400, 'Параметры адреса не принимаются');
    const mutation = !['GET', 'HEAD'].includes(req.method);
    // Изменения — только со страниц черновика. Host и X-Forwarded-* для проверки не используются.
    if (mutation && String(req.headers.origin || '') !== draftOf().origin) throw failure(403, 'Запрос с другого адреса запрещён');
    sweep();
    if (req.method === 'POST' && sub === '/api/claim') return claim(req, res);
    const sid = cookieOf(req, TEST_COOKIE);
    const id = sid && SESSION_ID.test(sid) ? buyers.get(sid) : null;
    const session = id ? sessions.get(id) : null;
    if (!session || !session.pair || session.pair.buyerSid !== sid) throw ended(Boolean(sid));
    // Cookie на сайте одна: вкладка обязана назвать свой тест. Чужой — не читаем и не пишем; без него — не пишем.
    const ctx = header(req, 'x-palitra-test-context');
    if (ctx !== null ? ctx !== session.pair.context : mutation) {
      throw failure(423, ctx !== null ? MESSAGES.testContext : MESSAGES.testContextRequired, ctx !== null ? 'TEST_CONTEXT_CHANGED' : 'TEST_CONTEXT_REQUIRED');
    }
    touch(session);
    const pair = session.pair;
    const still = () => { if (!alive(session) || session.pair.buyerSid !== sid) throw ended(true); };
    if (req.method === 'GET' && sub === '/api/session') return send(res, 200, testView(session), testHeaders(session));
    if (req.method === 'POST' && sub === '/api/orders') {
      const input = await readJson(req);
      still();
      // Нативная форма черновика: тот же модуль заказов сайта, источник «Сайт», покупатель — участник этой пары.
      const out = session.workspace.submitSite(input, { requestOrigin: WORK_ORIGIN, ip: 'draft-test-buyer', principal: pair.buyer.principal, appCustomer: false });
      const body = out.result.body;
      const message = out.orderId
        ? `Тестовый заказ №${out.orderId} принят тестовым сервером. Это не настоящий заказ: никуда не отправлялся и хранится только в памяти, не дольше 6 часов. Откройте «Мой тестовый заказ».`
        : `Тестовая заявка №${out.inquiryId} принята тестовым сервером. Это не настоящая заявка: никуда не отправлялась и хранится только в памяти, не дольше 6 часов.`;
      return send(res, out.result.status, body && body.ok === true && out.inquiryId
        ? { ...body, message, test: true, testOrderId: out.orderId, testInquiryId: out.inquiryId } : body, testHeaders(session));
    }
    // Только своё: список, карточка и согласование фото (остальное workspace закрывает по роли покупателя).
    const allowed = (req.method === 'GET' && (sub === '/api/bootstrap' || /^\/api\/orders\/[1-9]\d{0,14}$/.test(sub)))
      || (req.method === 'POST' && /^\/api\/orders\/[1-9]\d{0,14}\/action$/.test(sub));
    if (!allowed) throw failure(404, 'Действие не найдено');
    const result = await session.routes({ method: req.method, path: sub.slice(4), getActor: () => { still(); return pair.buyer; },
      readBody: () => readJson(req), context: { req } });
    return send(res, result.status, result.body, testHeaders(session));
  }

  return async function handler(req, res) {
    let errorHeaders = () => ({});
    try {
      if (!['GET', 'HEAD', 'POST', 'PUT'].includes(req.method)) throw failure(405, 'Метод не поддерживается');
      const raw = String(req.url || '/');
      if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\x00-\x1f]/.test(raw)) throw failure(400, 'Некорректный адрес');
      const url = new URL(raw, 'http://preview.invalid');
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw failure(400, 'Некорректный адрес'); }
      if (pathname !== url.pathname || pathname.includes('..') || pathname.includes('//')) throw failure(404, 'Не найдено');

      if (pathname.startsWith(TEST_PREFIX)) return await testRoute(req, res, url, pathname);

      if (pathname.startsWith('/api/')) {
        if (url.search) throw failure(400, 'Параметры адреса не принимаются');
        if (req.method === 'GET' && pathname === '/api/health') {
          const d = testEnabled() ? draftOf() : null;
          return send(res, 200, { ok: true, mode: 'telegram-preview', label: LABEL, sqlite: Boolean(sqlite),
            email: 'off', teamTelegram: 'disabled', telegramBot: 'not_connected', instagram: 'not_connected', crm: 'not_connected',
            testConnection: d ? 'enabled' : 'disabled', ...(d ? { draftOrigin: d.origin } : {}),
            sessions: sessions.size, pairs: [...sessions.values()].filter((s) => s.pair).length });
        }
        if (!sqlite) throw failure(503, 'Тестовый просмотр недоступен на этом сервере');
        const mutation = !['GET', 'HEAD'].includes(req.method);
        // Изменения — только со страницы этого развёртывания. Host и X-Forwarded-* для проверки не используются.
        if (mutation && !originSet().has(String(req.headers.origin || ''))) throw failure(403, 'Запрос с другого адреса запрещён');

        sweep();
        const cookieId = cookieOf(req, COOKIE);
        let session = cookieId && SESSION_ID.test(cookieId) ? sessions.get(cookieId) : null;
        let state = 'existing';
        if (session) {
          touch(session);
        } else {
          state = cookieId ? 'reset' : 'new';
          session = createSession();
        }
        const current = session;
        errorHeaders = () => previewHeaders(current, state);
        const ctx = header(req, 'x-preview-context');
        if (mutation && state !== 'existing') {
          // Новая/сброшенная база: прежние карточки и версии на экране к ней не относятся. Не выполняем.
          // 423, а не 409: интерфейс не должен принять это за правку другого сотрудника и перечитывать карточку.
          throw state === 'reset'
            ? failure(423, 'Тестовая сессия сброшена — вымышленные данные начаты заново. Действие не выполнено, нажмите «Начать заново».', 'PREVIEW_RESET')
            : failure(423, 'Тестовая сессия не сохранилась (браузер не принял cookie). Действие не выполнено, нажмите «Начать заново».', 'PREVIEW_NO_SESSION');
        }
        if (req.method === 'POST' && pathname === '/api/draft-test') return await lifecycle(req, res, current, ctx);
        // Страница назвала своё поколение, а cookie уже указывает на другую базу: данные другой базы не отдаём и не меняем.
        if (ctx !== null && ctx !== current.generation) {
          throw state === 'reset' ? failure(423, 'Тестовая сессия сброшена — вымышленные данные начаты заново. Нажмите «Начать заново».', 'PREVIEW_RESET')
            : failure(423, MESSAGES.context, 'PREVIEW_CONTEXT_CHANGED');
        }
        // Парный тест переключается по cookie — изменения без поколения страницы в нём не принимаются.
        if (mutation && ctx === null && current.pair) throw failure(423, MESSAGES.contextRequired, 'PREVIEW_CONTEXT_REQUIRED');
        if (pathname === '/api/draft-test') {
          if (req.method !== 'GET') throw failure(405, 'Метод не поддерживается');
          const actor = actorOf(req, current);
          return send(res, 200, { ok: true, enabled: testEnabled(), paired: Boolean(current.pair),
            pair: current.pair ? pairView(current, isStaff(actor)) : null }, previewHeaders(current, state));
        }
        // Публичная форма сайта: без участника, источник всегда «сайт».
        if (req.method === 'POST' && pathname === '/api/orders' && !Object.hasOwn(req.headers, 'x-demo-actor')) {
          const input = await readJson(req);
          stillAlive(current);
          const out = current.workspace.submitSite(input, { requestOrigin: WORK_ORIGIN, ip: 'preview-visitor' });
          return send(res, out.result.status, { ...out.result.body, message: 'Тестовая заявка записана только в этой тестовой сессии. Никуда не отправлялась.' }, previewHeaders(current, state));
        }
        // getActor вызывается маршрутами ПОСЛЕ чтения тела — там же проверяется, что база ещё та и не закрыта.
        const result = await current.routes({ method: req.method, path: pathname.slice(4), getActor: () => { stillAlive(current); return actorOf(req, current); },
          readBody: () => readJson(req), context: { req } });
        return send(res, result.status, result.body, previewHeaders(current, state));
      }

      return serveStatic(req, res, Object.hasOwn(STATIC, pathname) ? STATIC[pathname] : null);
    } catch (error) {
      // Превышение размера: соединение после ответа закрывается (клиент не переиспользует его); если поток
      // пришлось прервать раньше конца, сокет уничтожается только ПОСЛЕ отправки ответа.
      if (error.destroyAfter) res.once('finish', () => { try { req.socket.destroy(); } catch { /* уже закрыт */ } });
      send(res, error.status || 500, { error: error.status ? error.message : 'Не удалось выполнить действие',
        ...(error.status && typeof error.code === 'string' && /^[A-Z_]{2,32}$/.test(error.code) ? { code: error.code } : {}) },
      { ...errorHeaders(), ...(error.closeConnection ? { Connection: 'close' } : {}) });
    }
  };
}

module.exports = { createPreviewHandler, allowedOriginsFromEnv, draftFromEnv, loadDraftPrice, STATIC, TEST_STATIC, HTML_CSP, TEST_CSP,
  COOKIE, TEST_COOKIE, TEST_PREFIX, TEST_FRAGMENT, LABEL, TEST_BUYER_NAME, BODY_LIMIT, DRAIN_LIMIT };
