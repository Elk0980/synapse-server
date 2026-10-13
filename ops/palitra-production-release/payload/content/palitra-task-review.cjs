'use strict';

/* Owner acceptance of Palitra tasks. Uses the existing central documents table
   and native saveVersion; no new database/table, public-content type or API key. */
const fs = require('node:fs');
const path = require('node:path');

const KEY = 'palitra/review39';
const COMPANY = 'palitra-love';
const NATIVE = '/content/palitra/review39';
const API = '/palitra-review/api/tasks';
const SEED_API = '/palitra-review/api/seed';
const STATUSES = new Set(['not_checked', 'checked', 'needs_fix']);
const STAGES = new Set(['ready', 'in_progress', 'needs_recheck', 'planned', 'waiting_data', 'separate_release']);
const TASK_ID = /^\d{2,3}$/;
const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function safeText(value, limit, { optional = false } = {}) {
  if (optional && value == null) return '';
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    fail(400, 'Текст слишком длинный или содержит недопустимые символы');
  }
  return value.replace(/\r\n?/g, '\n');
}
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }
function etag(version) { return `"${version}"`; }

function initialTask(value) {
  if (!plainObject(value) || typeof value.id !== 'string' || !TASK_ID.test(value.id)) fail(400, 'Неверный номер задачи');
  const title = safeText(value.title, 300).trim();
  const stage = safeText(value.stage, 80).trim();
  if (!title || !stage || !STATUSES.has(value.user_check)) fail(400, 'Неверная задача');
  const stamp = value.user_checked_at == null ? null : safeText(value.user_checked_at, 80);
  if (stamp !== null && !Number.isFinite(Date.parse(stamp))) fail(400, 'Неверная дата проверки');
  // Select only required fields. Evidence, local paths, names and source metadata
  // from the coordinator's seed never enter this document or its responses.
  return { id: value.id, title, stage, user_check: value.user_check,
    user_note: safeText(value.user_note, 1000, { optional: true }),
    user_checked_at: stamp, revision: 1, reviewer: null };
}

function createPalitraTaskReview({ db, requireSession, requireCsrf, readJson, saveVersion,
  initialTasks = [], publicDir = path.join(__dirname, 'palitra-review-public') }) {
  for (const [name, fn] of Object.entries({ requireSession, requireCsrf, readJson, saveVersion })) {
    if (typeof fn !== 'function') throw new TypeError(name + ' must be a native function');
  }
  if (!db || typeof db.prepare !== 'function' || !Array.isArray(initialTasks) || initialTasks.length > 500) {
    throw new TypeError('Existing central db and sanitized initialTasks are required');
  }
  const initial = initialTasks.map(initialTask);
  if (new Set(initial.map(task => task.id)).size !== initial.length) throw new TypeError('Duplicate initial task ids');
  const latest = db.prepare('SELECT version, created_at, body FROM documents WHERE key = ? ORDER BY version DESC LIMIT 1');
  const history = db.prepare('SELECT version, created_at FROM documents WHERE key = ? ORDER BY version DESC LIMIT 50');
  const oldVersion = db.prepare('SELECT version, created_at, body FROM documents WHERE key = ? AND version = ?');

  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function decode(row) {
    if (!row) fail(503, 'Список задач ещё не подготовлен');
    let document;
    try { document = JSON.parse(row.body); }
    catch { fail(500, 'Список задач не удалось прочитать'); }
    if (!plainObject(document) || document.schema !== 1 || document.companyCode !== COMPANY
      || !Array.isArray(document.tasks) || document.tasks.length > 500 || !positiveInteger(row.version)) {
      fail(500, 'Список задач не удалось прочитать');
    }
    const seen = new Set();
    for (const task of document.tasks) {
      if (!plainObject(task) || typeof task.id !== 'string' || !TASK_ID.test(task.id) || seen.has(task.id)
        || typeof task.title !== 'string' || task.title.length > 300
        || typeof task.stage !== 'string' || task.stage.length > 80
        || !STATUSES.has(task.user_check) || typeof task.user_note !== 'string' || task.user_note.length > 1000
        || !positiveInteger(task.revision)) fail(500, 'Список задач не удалось прочитать');
      seen.add(task.id);
    }
    return document;
  }

  // Seed the native document once. On subsequent startup append only missing ids;
  // never overwrite a human's review, note, audit, title or implementation stage.
  transaction(() => {
    const row = latest.get(KEY);
    const document = row ? decode(row) : { schema: 1, companyCode: COMPANY, tasks: [] };
    const ids = new Set(document.tasks.map(task => task.id));
    const missing = initial.filter(task => !ids.has(task.id));
    if (missing.length) {
      const saved = saveVersion(KEY, { ...document, tasks: [...document.tasks, ...missing] }, 'palitra-review-seed');
      const readback = latest.get(KEY);
      if (!saved || !readback || saved.version !== readback.version || readback.version !== (row?.version || 0) + 1) {
        fail(500, 'Список задач не удалось подготовить');
      }
      decode(readback);
    }
  });

  function owner(request, write = false) {
    const session = requireSession(request); // Native function rereads current account/sessionVersion.
    if (session?.user?.role !== 'owner') fail(403, 'Проверку задач может менять только владелец');
    if (session.user.id == null) fail(401, 'Войдите в кабинет снова');
    if (write) requireCsrf(request, session);
    // The central server has CORS for unrelated public storefront routes. This
    // private owner document is same-origin on reads as well as on mutations.
    const origin = request.headers.origin;
    if (origin) {
      let parsed;
      try { parsed = new URL(origin); } catch { fail(403, 'Не удалось подтвердить вход'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host.toLowerCase() !== String(request.headers.host || '').toLowerCase()) {
        fail(403, 'Не удалось подтвердить вход');
      }
    }
    return { session, id: String(session.user.id), sessionVersion: session.user.sessionVersion };
  }

  function snapshot(row = latest.get(KEY)) {
    if (!row) return { schema: 1, companyCode: COMPANY, version: 0, updatedAt: null, tasks: [], needsSeed: true };
    const document = decode(row);
    return { schema: 1, companyCode: COMPANY, version: row.version, updatedAt: row.created_at,
      tasks: document.tasks.map(task => ({ id: task.id, title: task.title, stage: task.stage,
        user_check: task.user_check, user_note: task.user_note, user_checked_at: task.user_checked_at,
        revision: task.revision })) };
  }

  function validatePatch(body, requestedId, requireMatch, request) {
    if (!plainObject(body) || Object.keys(body).some(key => !['baseVersion', 'taskId', 'userCheck', 'userNote'].includes(key))) {
      fail(400, 'Можно менять только свою проверку и комментарий');
    }
    const id = requestedId || body.taskId;
    if (typeof id !== 'string' || !TASK_ID.test(id) || (requestedId && body.taskId !== undefined && body.taskId !== requestedId)) {
      fail(400, 'Неверный номер задачи');
    }
    if (!positiveInteger(body.baseVersion) || !STATUSES.has(body.userCheck)) fail(400, 'Выберите проверку и обновите список');
    const note = body.userNote === undefined ? undefined : safeText(body.userNote, 1000);
    const match = request.headers['if-match'];
    if (requireMatch && match === undefined) fail(428, 'Обновите список перед изменением');
    if (match !== undefined && match !== etag(body.baseVersion)) fail(409, 'Список уже изменился. Обновите его');
    return { id, baseVersion: body.baseVersion, status: body.userCheck, note };
  }

  async function patch(request, requestedId, requireMatch) {
    const before = owner(request, true);
    const body = await readJson(request);
    const fresh = owner(request, true); // Revoke/role/session replacement during await cannot write.
    if (fresh.id !== before.id || fresh.sessionVersion !== before.sessionVersion) fail(403, 'Доступ изменился. Войдите снова');
    const change = validatePatch(body, requestedId, requireMatch, request);
    return transaction(() => {
      // No await between this fresh authorization and CAS/update/saveVersion.
      const finalOwner = owner(request, true);
      if (finalOwner.id !== before.id || finalOwner.sessionVersion !== before.sessionVersion) fail(403, 'Доступ изменился. Войдите снова');
      const row = latest.get(KEY);
      if (!row || row.version !== change.baseVersion) fail(409, 'Список уже изменился. Обновите его');
      const document = decode(row);
      const index = document.tasks.findIndex(task => task.id === change.id);
      if (index === -1) fail(404, 'Задача не найдена');
      const old = document.tasks[index];
      const note = change.note === undefined ? old.user_note : change.note;
      if (old.user_check === change.status && old.user_note === note) {
        return { saved: false, ...snapshot(row) }; // Same-value retry is a no-op, with unchanged audit/version.
      }
      const tasks = document.tasks.slice();
      tasks[index] = { ...old, user_check: change.status, user_note: note,
        user_checked_at: new Date().toISOString(), reviewer: finalOwner.id, revision: old.revision + 1 };
      const saved = saveVersion(KEY, { ...document, tasks }, 'palitra-review-owner:' + finalOwner.id);
      const readback = latest.get(KEY);
      if (readback.version !== saved.version || readback.version !== row.version + 1) fail(500, 'Изменение не удалось подтвердить');
      return { saved: true, ...snapshot(readback) };
    });
  }

  async function seed(request) {
    const before = owner(request, true);
    const body = await readJson(request);
    const fresh = owner(request, true);
    if (fresh.id !== before.id || fresh.sessionVersion !== before.sessionVersion) fail(403, 'Доступ изменился. Войдите снова');
    if (request.headers['if-match'] !== '"0"') fail(409, 'Первичная загрузка разрешена только для пустого списка');
    if (!plainObject(body) || Object.keys(body).some(key => key !== 'tasks')
      || !Array.isArray(body.tasks) || body.tasks.length < 1 || body.tasks.length > 39) fail(400, 'Неверный список задач');
    const seen = new Set();
    const tasks = body.tasks.map(task => {
      if (!plainObject(task) || Object.keys(task).some(key => !['id', 'title', 'stage', 'user_check', 'user_note'].includes(key))
        || typeof task.id !== 'string' || !/^(?:0[1-9]|[12][0-9]|3[0-9])$/.test(task.id)
        || seen.has(task.id) || !STAGES.has(task.stage)) fail(400, 'Неверный список задач');
      seen.add(task.id);
      return initialTask(task);
    });
    return transaction(() => {
      const finalOwner = owner(request, true);
      if (finalOwner.id !== before.id || finalOwner.sessionVersion !== before.sessionVersion) fail(403, 'Доступ изменился. Войдите снова');
      if (latest.get(KEY)) fail(409, 'Список уже загружен. Ваши проверки сохранены');
      const saved = saveVersion(KEY, { schema: 1, companyCode: COMPANY, tasks }, 'palitra-review-seed-owner:' + finalOwner.id);
      const row = latest.get(KEY);
      if (!row || row.version !== 1 || saved?.version !== 1) fail(500, 'Загрузку не удалось подтвердить');
      return { saved: true, ...snapshot(row) };
    });
  }

  async function handle(request, reply, url) {
    const pathname = url.pathname;
    const nativeFamily = pathname === NATIVE || pathname.startsWith(NATIVE + '/');
    const apiFamily = pathname === API || pathname.startsWith(API + '/');
    const seedRoute = pathname === SEED_API;
    if (!nativeFamily && !apiFamily && !seedRoute) return false;
    // Intercept the entire native key family BEFORE generic content routes.
    // Generic PUT/restore/history must never provide a way around narrow owner review.
    try {
      owner(request);
      if (request.method === 'POST' && seedRoute) {
        const result = await seed(request);
        reply(200, result, { ...NO_STORE, etag: etag(result.version) }); return true;
      }
      if (request.method === 'GET' && [NATIVE, API].includes(pathname)) {
        const result = snapshot(); reply(200, result, { ...NO_STORE, etag: etag(result.version) }); return true;
      }
      if (request.method === 'GET' && pathname === NATIVE + '/history') {
        reply(200, { versions: history.all(KEY) }, NO_STORE); return true;
      }
      const versionMatch = nativeFamily && new RegExp('^' + NATIVE + '/version/([1-9][0-9]*)$').exec(pathname);
      if (request.method === 'GET' && versionMatch) {
        const row = oldVersion.get(KEY, Number(versionMatch[1]));
        if (!row) fail(404, 'Версия не найдена');
        reply(200, snapshot(row), { ...NO_STORE, etag: etag(row.version) }); return true;
      }
      const itemMatch = apiFamily && new RegExp('^' + API + '/([0-9]{2,3})$').exec(pathname);
      if (request.method === 'GET' && itemMatch) {
        const result = snapshot(); const task = result.tasks.find(task => task.id === itemMatch[1]);
        if (!task) fail(404, 'Задача не найдена');
        reply(200, { version: result.version, task }, { ...NO_STORE, etag: etag(result.version) }); return true;
      }
      if ((request.method === 'PATCH' && pathname === NATIVE)
        || (request.method === 'PUT' && (pathname === API || itemMatch))) {
        const result = await patch(request, itemMatch ? itemMatch[1] : null, request.method === 'PUT');
        reply(200, result, { ...NO_STORE, etag: etag(result.version) }); return true;
      }
      fail(405, 'Этот способ изменения не поддерживается');
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      reply(status, { error: status >= 500 ? 'Список задач временно недоступен' : error.message }, NO_STORE);
      return true;
    }
  }

  function serve(request, response, url) {
    if (!(url.pathname === '/palitra-review' || url.pathname.startsWith('/palitra-review/'))
      || url.pathname === API || url.pathname.startsWith(API + '/') || url.pathname === SEED_API) return false;
    const headers = { ...NO_STORE, 'content-security-policy': CSP, 'referrer-policy': 'same-origin' };
    try {
      owner(request);
      if (!['GET', 'HEAD'].includes(request.method)) fail(405, 'Этот способ открытия не поддерживается');
      if (url.pathname === '/palitra-review') {
        response.writeHead(302, { ...headers, location: '/palitra-review/' }); response.end(); return true;
      }
      const files = { '/palitra-review/': ['index.html', 'text/html; charset=utf-8'],
        '/palitra-review/app.js': ['app.js', 'text/javascript; charset=utf-8'],
        '/palitra-review/app.css': ['app.css', 'text/css; charset=utf-8'] };
      const target = files[url.pathname];
      if (!target) fail(404, 'Страница не найдена');
      const bytes = fs.readFileSync(path.join(publicDir, target[0]));
      response.writeHead(200, { ...headers, 'content-type': target[1], 'content-length': bytes.length });
      response.end(request.method === 'HEAD' ? undefined : bytes); return true;
    } catch (error) {
      if (error.status === 401) {
        response.writeHead(302, { ...headers, location: '/cabinet.html' }); response.end(); return true;
      }
      const status = Number.isInteger(error.status) ? error.status : 500;
      response.writeHead(status, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : status >= 500 ? 'Страница временно недоступна' : error.message);
      return true;
    }
  }

  return { handle, serve, key: KEY, companyCode: COMPANY };
}

module.exports = { createPalitraTaskReview };
