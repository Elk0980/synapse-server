'use strict';

// Private documents feature. The caller supplies the current native cabinet
// session and bounded (1 MiB) native JSON reader; API keys are never accepted.
const { validateNotificationTexts } = require('./notification-texts.cjs');
const { createNotificationCopyHttp } = require('./notification-copy-http.cjs');
const COMPANY = 'palitra-love', BOARD = 'palitra-orders';
const KEY = `project-forms/${COMPANY}/${BOARD}`;
const ROOT = '/content/project-forms', BASE = `${ROOT}/${COMPANY}/${BOARD}`;
const MAX_BYTES = 1024 * 1024;
const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'vary': 'Cookie, Origin' };
const ROLES = new Set(['client', 'staff', 'admin']);
const TYPES = new Set(['hero','button','text','website','helpform','order','chat','input','form','status','customer','sales','contactnotice']);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const fail = (status, message, details) => { throw Object.assign(new Error(message), { status, details }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const etag = value => `"${value}"`;

function safeAsset(value, html = false) {
  if (typeof value !== 'string' || value.length > 600 || !/^assets\/[a-zA-Z0-9_./-]+(?:\?[a-zA-Z0-9_=&.-]*)?$/.test(value)
    || value.includes('..') || value.includes('//')) return false;
  return html ? /^assets\/catalog-mobile\.html(?:\?[a-zA-Z0-9_=&.-]*)?$/.test(value) : /\.(?:png|jpe?g|webp|gif|svg)(?:\?|$)/i.test(value);
}
function safeExternal(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      ['palitra-love.ru','palitra-love-draft-1.synapsebusiness.ru','t.me','wa.me','vk.com'].includes(url.hostname);
  } catch { return false; }
}
  const ABSOLUTE_HTTP = /^https?:\/\/[^/\\?#@]/i;
  const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\\\s]/;
  function safeButtonUrl(value) {
    if (typeof value !== 'string') return '';
    const source = value.trim();
    if (!source || source.length > 2048 || !ABSOLUTE_HTTP.test(source) || FORBIDDEN_CHARS.test(source)) return '';
    let url;
    try { url = new URL(source); } catch (_) { return ''; }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return '';
    return url.href;
  }
function validateModel(value) {
  if (!object(value) || value.schema !== 1 || !integer(value.revision) || !Array.isArray(value.frames)
    || value.frames.length < 1 || value.frames.length > 500 || !object(value.flow)) fail(400, 'Неверный формат проекта');
  if (Object.keys(value).some(key => !['schema','revision','appTitle','platformTitle','projectName','subprojectName','frames','flow','menus','notificationTexts'].includes(key))) fail(400, 'Неизвестное поле проекта');
  if (Object.hasOwn(value, 'notificationTexts')) validateNotificationTexts(value.notificationTexts);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) fail(413, 'Проект не должен превышать 1 МБ');
  // Renderers consume plain text and a fixed style vocabulary. Prevent prototype
  // keys, raw DOM/HTML/JS capabilities, excessive nesting and nonfinite values.
  let count = 0;
  const walk = (item, depth = 0) => {
    if (++count > 60000 || depth > 24) fail(400, 'Проект слишком сложный');
    if (typeof item === 'number' && !Number.isFinite(item)) fail(400, 'Неверное число');
    if (typeof item === 'string' && (item.length > 16000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item))) fail(400, 'Неверный текст');
    if (Array.isArray(item)) { if (item.length > 4000) fail(400, 'Слишком большой список'); item.forEach(x => walk(x, depth + 1)); }
    else if (object(item)) for (const [key, child] of Object.entries(item)) {
      if (['__proto__','prototype','constructor','innerHTML','outerHTML','html','script','onclick','onerror','style','css'].includes(key)
        || /^on[a-z]+$/i.test(key)) fail(400, 'Исполняемые поля запрещены');
      if (['src','href','url'].includes(key) && child && !(key === 'url' && item.type === 'button' && item.action === 'link' ? safeButtonUrl(child) : key === 'src' ? safeAsset(child, /\.html(?:\?|$)/i.test(child)) : safeExternal(child))) fail(400, 'Недопустимый адрес');
      walk(child, depth + 1);
    }
  };
  walk(value);
  const frames = new Map(), blocks = new Map();
  for (const frame of value.frames) {
    if (!object(frame) || !ID.test(frame.id || '') || frames.has(frame.id) || !ROLES.has(frame.role) || !Array.isArray(frame.blocks) || frame.blocks.length > 1000) fail(400, 'Неверный экран');
    if (frame.presentation !== undefined && !['','celebration'].includes(frame.presentation)) fail(400, 'Неизвестное оформление');
    if (frame.photoSrc !== undefined && frame.photoSrc !== 'assets/k01-celebration-bg.png') fail(400, 'Недопустимый фон');
    if (frame.categories !== undefined && (!Array.isArray(frame.categories) || frame.categories.length > 3)) fail(400, 'Неверные категории');
    frames.set(frame.id, frame);
    for (const block of frame.blocks) {
      if (!object(block) || !ID.test(block.id || '') || blocks.has(block.id) || !TYPES.has(block.type)) fail(400, 'Неверный блок');
      if (block.action !== undefined && (block.type !== 'button' || !['page','link'].includes(block.action))) fail(400, 'Неверное действие кнопки');
      if (block.type === 'button' && block.action === 'link' && !safeButtonUrl(block.url)) fail(400, 'Недопустимая ссылка кнопки');
      if (block.presentationHidden !== undefined && typeof block.presentationHidden !== 'boolean') fail(400, 'Неверная видимость блока');
      blocks.set(block.id, { block, frame });
      if (block.fields !== undefined) {
        if (!Array.isArray(block.fields) || block.fields.length > 200) fail(400, 'Неверные поля формы');
        const ids = new Set();
        for (const field of block.fields) {
          if (!object(field) || !ID.test(field.id || '') || ids.has(field.id)) fail(400, 'Неверное поле формы');
          ids.add(field.id);
        }
      }
    }
  }
  const target = (id, role) => {
    if (id === undefined || id === '' || ['@site','@works'].includes(id)) return;
    if (typeof id !== 'string' || !frames.has(id) || (role && frames.get(id).role !== role)) fail(400, 'Переход ведёт на недоступный экран');
  };
  for (const { block, frame } of blocks.values()) target(block.target);
  for (const frame of frames.values()) for (const category of frame.categories || []) {
    if (!object(category) || (category.icon !== undefined && !['birthday','baby','event','gift','heart','star'].includes(category.icon))) fail(400, 'Неверная категория');
    target(category.target);
  }
  const nodes = new Map();
  if (!Array.isArray(value.flow.nodes) || !Array.isArray(value.flow.edges)) fail(400, 'Неверная блок-схема');
  for (const node of value.flow.nodes) {
    if (!object(node) || !ID.test(node.id || '') || nodes.has(node.id)) fail(400, 'Неверный узел');
    if (node.role !== undefined && !['client','staff','admin','source','common'].includes(node.role)) fail(400, 'Неверная роль узла');
    if (node.frame !== undefined && !frames.has(node.frame)) fail(400, 'Узел без экрана');
    nodes.set(node.id, node);
  }
  for (const edge of value.flow.edges) {
    if (!object(edge) || !nodes.has(edge.from) || !nodes.has(edge.to) || (edge.blockId && !blocks.has(edge.blockId))) fail(400, 'Неверная связь');
    if (edge.blockId) {
      const source = blocks.get(edge.blockId);
      if (nodes.get(edge.from).frame !== source.frame.id || nodes.get(edge.to).frame !== source.block.target) fail(400, 'Связь не соответствует кнопке');
    }
  }
  if (value.menus !== undefined) {
    if (!object(value.menus) || Object.keys(value.menus).some(role => !ROLES.has(role))) fail(400, 'Неверное меню');
    for (const [role, menu] of Object.entries(value.menus)) {
      if (!object(menu) || !Array.isArray(menu.items) || menu.items.length > 200) fail(400, 'Неверные пункты меню');
      const ids = new Set();
      for (const item of menu.items) {
        if (!object(item) || !ID.test(item.id || '') || ids.has(item.id)) fail(400, 'Неверный пункт меню');
        ids.add(item.id); target(item.target);
      }
    }
  }
  return value;
}

function createProjectFormsFeature({ db, requireSession, requireCsrf, readJson, allowedHost = 'synapse.synapsebusiness.ru' }) {
  if (!db?.prepare || [requireSession, requireCsrf, readJson].some(fn => typeof fn !== 'function')) throw new TypeError('Native documents/session/CSRF/JSON reader required');
  const notificationCopy = createNotificationCopyHttp({ db });
  const latest = db.prepare('SELECT version, created_at, author, body FROM documents WHERE key = ? ORDER BY version DESC LIMIT 1');
  const version = db.prepare('SELECT version, created_at, author, body FROM documents WHERE key = ? AND version = ?');
  const history = db.prepare('SELECT version, created_at, author FROM documents WHERE key = ? ORDER BY version DESC LIMIT 100');
  const insert = db.prepare('INSERT INTO documents (key, version, created_at, author, body) VALUES (?, ?, ?, ?, ?)');
  function owner(request, write = false) {
    if (String(request.headers.host || '').toLowerCase() !== allowedHost) fail(403, 'Формы доступны только в кабинете Synapse');
    const session = requireSession(request);
    const user = session?.user;
    if (!user || user.id == null) fail(401, 'Войдите в кабинет');
    if (user.role !== 'owner' || (Array.isArray(user.companyCodes) && !user.companyCodes.includes(COMPANY))) fail(403, 'Формы доступны владельцу проекта');
    const origin = request.headers.origin;
    if (origin) {
      let parsed; try { parsed = new URL(origin); } catch { fail(403, 'Не удалось подтвердить источник'); }
      if (parsed.origin !== 'https://' + allowedHost) fail(403, 'Другой источник запрещён');
    }
    if (write) {
      if (!origin && request.headers['sec-fetch-site'] !== 'same-origin') fail(403, 'Требуется тот же источник');
      requireCsrf(request, session);
    }
    const fingerprint = JSON.stringify([String(user.id), user.sessionVersion, user.role, user.companyCodes || null, session.epoch ?? session.version ?? null, session.cookieRef ?? null]);
    return { session, user, fingerprint };
  }
  const fresh = (request, before, write = false) => {
    const after = owner(request, write);
    if (after.fingerprint !== before.fingerprint) fail(403, 'Доступ изменился. Откройте кабинет снова');
    return after;
  };
  function project(row) {
    if (!row) fail(404, 'Проект ещё не перенесён на сервер');
    let model; try { model = JSON.parse(row.body); } catch { fail(500, 'Не удалось прочитать проект'); }
    validateModel(model); return { ...model, revision: row.version };
  }
  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  async function mutate(request, restore) {
    const before = owner(request, true);
    const length = request.headers['content-length'];
    if (length && (!/^\d+$/.test(String(length)) || Number(length) > MAX_BYTES)) fail(413, 'Проект не должен превышать 1 МБ');
    const body = await readJson(request);
    fresh(request, before, true);
    if (!object(body) || Buffer.byteLength(JSON.stringify(body)) > MAX_BYTES) fail(413, 'Проект не должен превышать 1 МБ');
    const revision = restore ? body.revision : body.revision;
    if (!integer(revision) || request.headers['if-match'] !== etag(revision)) fail(428, 'Обновите версию перед сохранением');
    if (restore && (Object.keys(body).some(key => !['revision','version'].includes(key)) || !integer(body.version) || body.version < 1)) fail(400, 'Неверная версия');
    if (!restore) validateModel(body);
    return transaction(() => {
      const current = fresh(request, before, true);
      const row = latest.get(KEY);
      if (!row) fail(404, 'Проект ещё не перенесён на сервер');
      if (row.version !== revision) fail(409, 'Проект изменился в другом окне', { project: project(row) });
      const model = restore ? project(version.get(KEY, body.version)) : body;
      const next = row.version + 1;
      const serialized = JSON.stringify({ ...model, revision: next });
      fresh(request, before, true); // Last native identity check immediately before insertion.
      insert.run(KEY, next, new Date().toISOString(), String(current.user.id), serialized);
      const saved = latest.get(KEY);
      if (saved?.version !== next || saved.body !== serialized) fail(500, 'Сохранение не подтверждено');
      return { saved: true, revision: next };
    });
  }
  async function handle(request, url, reply) {
    if (['/content/palitra/notification-texts', '/content/palitra/design'].includes(url.pathname)) {
      const publicHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow' };
      if (String(request.headers.host || '').toLowerCase() !== allowedHost || request.url !== url.pathname) { reply(404, { error: 'Не найдено' }, publicHeaders); return true; }
      if (!['GET','HEAD'].includes(request.method)) { reply(405, { error: 'Метод не поддерживается' }, { ...publicHeaders, allow: 'GET, HEAD' }); return true; }
      try { reply(200, url.pathname === '/content/palitra/design' ? notificationCopy.readVisual() : notificationCopy.read(), publicHeaders); }
      catch { reply(503, { error: 'Тексты уведомлений временно недоступны' }, publicHeaders); }
      return true;
    }
    if (!(url.pathname === ROOT || url.pathname.startsWith(ROOT + '/'))) return false;
    try {
      const identity = owner(request);
      // Intercept the entire namespace, including generic content/history/restore.
      if (url.search || !(url.pathname === BASE + '/session' || url.pathname === BASE + '/project' || url.pathname === BASE + '/history'
        || url.pathname === BASE + '/restore' || new RegExp('^' + BASE + '/version/[1-9][0-9]*$').test(url.pathname))) fail(404, 'Проект не найден');
      if (request.method === 'GET' && url.pathname === BASE + '/session') {
        reply(200, { role: 'owner', company: COMPANY, board: BOARD, display: identity.user.displayName || identity.user.login || 'Владелец',
          identity: { id: String(identity.user.id), version: identity.user.sessionVersion ?? null }, csrfToken: identity.session.csrf }, HEADERS); return true;
      }
      if (request.method === 'GET' && url.pathname === BASE + '/project') {
        const model = project(latest.get(KEY)); fresh(request, identity);
        reply(200, model, { ...HEADERS, etag: etag(model.revision) }); return true;
      }
      if (request.method === 'GET' && url.pathname === BASE + '/history') {
        const versions = history.all(KEY); fresh(request, identity); reply(200, { versions }, HEADERS); return true;
      }
      const match = new RegExp('^' + BASE + '/version/([1-9][0-9]*)$').exec(url.pathname);
      if (request.method === 'GET' && match) {
        if (!Number.isSafeInteger(Number(match[1]))) fail(404, 'Версия не найдена');
        const model = project(version.get(KEY, Number(match[1]))); fresh(request, identity); reply(200, model, HEADERS); return true;
      }
      if ((request.method === 'PUT' && url.pathname === BASE + '/project') || (request.method === 'POST' && url.pathname === BASE + '/restore')) {
        const result = await mutate(request, request.method === 'POST'); reply(200, result, { ...HEADERS, etag: etag(result.revision) }); return true;
      }
      fail(405, 'Этот способ не поддерживается');
    } catch (error) {
      reply(error.status || 500, { error: error.status ? error.message : 'Не удалось обработать проект', ...(error.status === 409 ? error.details : {}) }, HEADERS); return true;
    }
  }
  return { handle };
}

module.exports = { createProjectFormsFeature, validateModel, KEY, BASE, MAX_BYTES };
