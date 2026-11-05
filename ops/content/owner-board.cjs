'use strict';

// Private board adapter. It neither creates accounts nor reads authentication secrets.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_BODY = 64 * 1024 * 1024;
const MAX_STATE = 64 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const SCHEMA = 'synapse-owner-board/v1';
const queues = new Map();
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const STATIC = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8', 'mobile.css': 'text/css; charset=utf-8',
  'operator.html': 'text/html; charset=utf-8', 'operator.js': 'text/javascript; charset=utf-8' };

function problem(status, message) { return Object.assign(new Error(message), { status }); }
function need(ok, status, message) { if (!ok) throw problem(status, message); }
function plain(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype; }
function int(v) { return Number.isSafeInteger(v) && v >= 0; }
function copy(v) { return JSON.parse(JSON.stringify(v)); }
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function string(v, limit, field, fallback = '') {
  if (v === undefined) return fallback;
  need(typeof v === 'string' && v.length <= limit && !v.includes('\0'), 400, 'Неверное поле: ' + field);
  return v;
}
function isoDate(value) {
  if (typeof value !== 'string' || value.length > 40) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && hour <= 23 && minute <= 59 && second <= 59;
}
function reportStatus(value) {
  need(plain(value) && isoDate(value.updatedAt), 400, 'Нужна корректная дата status.updatedAt в формате ISO');
  need(value.nextReportAt === undefined || value.nextReportAt === null || isoDate(value.nextReportAt), 400, 'Неверная дата status.nextReportAt');
  for (const field of ['current', 'nextAction', 'nextReport']) {
    if (value[field] !== undefined) string(value[field], 16000, 'status.' + field);
  }
  need(value.todayDone === undefined || (Array.isArray(value.todayDone) && value.todayDone.length <= 500
    && value.todayDone.every(item => typeof item === 'string' && item.length <= 4000 && !item.includes('\0'))), 400, 'status.todayDone должен быть списком строк');
  need(Buffer.byteLength(JSON.stringify(value)) <= 2 * 1024 * 1024, 413, 'Статус слишком большой');
  return copy(value);
}
function relative(v) {
  need(typeof v === 'string' && v.length > 0 && v.length <= 500 && !/[\\%?#:\x00-\x1f]/.test(v), 400, 'Недопустимый путь файла');
  const pieces = v.split('/');
  need(pieces.every(p => p && p !== '.' && p !== '..' && !p.startsWith('.') && !/[. ]$/.test(p)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)), 400, 'Недопустимый путь файла');
  return pieces;
}
function noLinks(absolute, allowMissing = false) {
  const resolved = path.resolve(absolute), parsed = path.parse(resolved);
  let at = parsed.root;
  for (const piece of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    at = path.join(at, piece);
    let stat;
    try { stat = fs.lstatSync(at); } catch (e) { if (allowMissing && e.code === 'ENOENT') return; throw e; }
    need(!stat.isSymbolicLink(), 403, 'Ссылки файловой системы запрещены');
  }
}
function directory(absolute, create = false) {
  noLinks(absolute, create);
  if (create) fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
  noLinks(absolute);
  need(fs.lstatSync(absolute).isDirectory(), 503, 'Каталог доски недоступен');
}
function inside(root, rel) {
  const target = path.join(root, ...relative(rel));
  const fromRoot = path.relative(root, target);
  need(fromRoot && !fromRoot.startsWith('..' + path.sep) && !path.isAbsolute(fromRoot), 403, 'Путь за пределами доски');
  noLinks(target, true);
  return target;
}
function readFile(target, limit = MAX_STATE) {
  noLinks(target);
  const before = fs.lstatSync(target);
  need(before.isFile() && before.nlink === 1 && before.size <= limit, 403, 'Файл недоступен');
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const during = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.lstatSync(target);
    noLinks(target);
    need(bytes.length <= limit && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(k => before[k] === during[k] && during[k] === after[k])
      && during.nlink === 1, 409, 'Файл изменился во время чтения');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function fsyncDir(dir) {
  // Directory fsync is unavailable on Windows. The file itself is always flushed.
  let fd;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); }
  catch (e) { if (!['EINVAL', 'EISDIR', 'EPERM', 'EACCES', 'ENOTSUP', 'EBADF'].includes(e.code)) throw e; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function atomic(target, bytes) {
  noLinks(target, true);
  const temp = path.join(path.dirname(target), '.' + crypto.randomUUID() + '.tmp');
  let fd, renamed = false;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    noLinks(target, true); fs.renameSync(temp, target); renamed = true;
    // No failure after the commit may trigger media rollback.
    try { fsyncDir(path.dirname(target)); } catch (_) { /* State was committed; keep its referenced media. */ }
  } finally { if (fd !== undefined) fs.closeSync(fd); if (!renamed) { try { fs.unlinkSync(temp); } catch (_) {} } }
}
function image(bytes, mime, filename) {
  need(bytes.length > 0 && bytes.length <= MAX_IMAGE, 413, 'Изображение должно быть не больше 8 МБ');
  let ext;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ext = '.png';
  else if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) ext = '.jpg';
  else if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) ext = '.gif';
  else if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') ext = '.webp';
  need(ext && TYPES[ext] === mime, 400, 'Нужен PNG, JPEG, WebP или GIF с верным типом');
  if (filename !== undefined) need(TYPES[path.extname(filename).toLowerCase()] === mime, 400, 'Расширение не совпадает с изображением');
  return ext;
}
function decodeImage(value, mime, name) {
  need(typeof value === 'string' && value.length <= Math.ceil(MAX_IMAGE / 3) * 4, 413, 'Изображение должно быть не больше 8 МБ');
  // Avoid a repeated-group regexp: multi-megabyte images can exhaust its stack.
  need(value.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(value), 400, 'Неверные данные изображения');
  const bytes = Buffer.from(value, 'base64');
  need(bytes.toString('base64') === value, 400, 'Неверные данные изображения');
  const ext = image(bytes, mime, name);
  return { bytes, ext, mime };
}
async function readBody(req) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  need(contentType === 'application/json' && !req.headers['transfer-encoding'], 415, 'Нужен JSON известного размера');
  const length = String(req.headers['content-length'] || '');
  need(/^\d+$/.test(length), 411, 'Не указан размер запроса');
  need(Number(length) <= MAX_BODY, 413, 'Пакет слишком большой');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; need(size <= MAX_BODY && size <= Number(length), 413, 'Пакет слишком большой'); chunks.push(chunk); }
  need(size === Number(length), 400, 'Пакет получен не полностью');
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    need(plain(parsed), 400, 'Нужен объект JSON');
    return parsed;
  } catch (e) { if (e.status) throw e; throw problem(400, 'Не удалось прочитать JSON'); }
}

function createOwnerBoard(options) {
  const { requireSession, requireCsrf, ownerId = 1, prefix = '/content/owner-board/' } = options;
  need(typeof requireSession === 'function' && typeof requireCsrf === 'function', 500, 'Нужна штатная авторизация');
  need(Number.isSafeInteger(ownerId) && ownerId > 0 && /^\/(?:[a-zA-Z0-9_-]+\/)+$/.test(prefix), 500, 'Неверная область доски');
  const origin = new URL(options.publicOrigin);
  need(origin.protocol === 'https:' && origin.origin === options.publicOrigin && !origin.username && !origin.password, 500, 'Нужен точный HTTPS origin');
  const dataDir = path.resolve(options.dataDir), assetsDir = path.resolve(options.assetsDir);
  const nested = (a, b) => { const r = path.relative(a, b); return !r || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); };
  need(!nested(dataDir, assetsDir) && !nested(assetsDir, dataDir), 500, 'Данные и интерфейс должны храниться отдельно');
  directory(assetsDir); directory(dataDir, true); directory(path.join(dataDir, 'media'), true);
  const statePath = path.join(dataDir, 'state.json'), previousPath = path.join(dataDir, 'state.previous.json');

  function authenticate(req) {
    const session = requireSession(req);
    need(session?.user?.id === ownerId, 403, 'Доска доступна только владельцу');
    return session;
  }
  function fresh(req, initial, write = false) {
    const current = authenticate(req);
    need(current.user.sessionVersion === initial.user.sessionVersion, 403, 'Доступ изменился');
    if (write) requireCsrf(req, current);
    return current;
  }
  function security(req, write) {
    need(String(req.headers.host || '').toLowerCase() === origin.host.toLowerCase(), 403, 'Недопустимый адрес доски');
    if (req.headers.origin !== undefined || write) need(req.headers.origin === origin.origin, 403, 'Недопустимый источник запроса');
    if (write) need(!['cross-site', 'none'].includes(req.headers['sec-fetch-site']), 403, 'Недопустимый источник запроса');
  }
  function headers(res, status, mime, length, extra = {}) {
    res.writeHead(status, { 'content-type': mime, 'content-length': length, 'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'vary': 'Cookie',
      'content-security-policy': "default-src 'self'; img-src 'self' blob: data:; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      ...extra });
  }
  function send(req, res, status, value, extra = {}) {
    const bytes = Buffer.from(JSON.stringify(value));
    headers(res, status, 'application/json; charset=utf-8', bytes.length, extra);
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }
  function mediaName(value) {
    if (value.startsWith(prefix + 'media/')) value = value.slice(prefix.length);
    else if (value.startsWith('/media/')) value = value.slice(1);
    else if (!value.startsWith('media/')) value = 'media/' + value;
    relative(value);
    need(value.startsWith('media/') && Object.hasOwn(TYPES, path.extname(value).toLowerCase()), 400, 'Недопустимый путь изображения');
    return value;
  }
  function attachment(item) {
    need(plain(item) && ['request', 'proof'].includes(item.role), 400, 'Неверное вложение');
    need(typeof item.url === 'string' && (item.url.startsWith('/media/') || item.url.startsWith(prefix + 'media/')), 400, 'Недопустимый адрес вложения');
    const file = mediaName(item.url);
    const id = string(item.id, 240, 'attachment.id', file);
    need(id.length > 0 && !/[\x00-\x1f]/.test(id), 400, 'Неверный номер вложения');
    return { id, role: item.role, url: '/' + file, caption: string(item.caption, 4000, 'caption'), originalName: string(item.originalName, 255, 'originalName') };
  }
  function task(item, defaultOrder) {
    need(plain(item) && typeof item.id === 'string' && ID.test(item.id), 400, 'Неверный номер задачи');
    need(item.priority === undefined || (int(item.priority) && item.priority >= 1 && item.priority <= 4), 400, 'Приоритет должен быть от 1 до 4');
    need(item.paused === undefined || typeof item.paused === 'boolean', 400, 'Неверная пауза');
    need(item.closed === undefined || typeof item.closed === 'boolean', 400, 'Неверное состояние задачи');
    need(item.order === undefined || (Number.isSafeInteger(item.order) && Math.abs(item.order) <= 1000000), 400, 'Неверный порядок задачи');
    need(item.attachments === undefined || (Array.isArray(item.attachments) && item.attachments.length <= 1000), 400, 'Неверные вложения задачи');
    const result = { id: item.id, title: string(item.title, 1000, 'title', item.id), status: string(item.status, 200, 'status', 'Не начато'),
      detail: string(item.detail, 16000, 'detail'), closed: item.closed === true, order: item.order ?? defaultOrder,
      priority: item.priority ?? 3, paused: item.paused ?? false, attachments: (item.attachments || []).map(attachment) };
    for (const field of ['requestText', 'acceptance']) if (item[field] !== undefined) result[field] = string(item[field], 16000, field);
    need(new Set(result.attachments.map(a => a.id)).size === result.attachments.length, 400, 'Повторный номер вложения');
    return result;
  }
  function empty() { return { schema: SCHEMA, revision: 0, status: {}, tasks: [], rules: [], controls: {}, events: [], history: [] }; }
  function state() {
    let bytes;
    try { bytes = readFile(statePath); } catch (e) { if (e.code === 'ENOENT') return empty(); throw e; }
    let v;
    try { v = JSON.parse(bytes.toString('utf8')); } catch (_) { throw problem(503, 'Сохранённая доска повреждена; требуется проверка'); }
    need(plain(v) && v.schema === SCHEMA && int(v.revision) && plain(v.status) && Array.isArray(v.tasks)
      && Array.isArray(v.rules) && plain(v.controls) && Array.isArray(v.events) && Array.isArray(v.history), 503, 'Неверный формат сохранённой доски');
    return v;
  }
  function board(v, session) {
    const result = { status: copy(v.status), tasks: v.tasks.map((t, index) => {
      const normalized = task(t, index), control = v.controls[t.id];
      need(plain(control) && int(control.priority) && control.priority >= 1 && control.priority <= 4 && typeof control.paused === 'boolean', 503, 'Управление задачей повреждено');
      return { ...normalized, priority: control.priority, paused: control.paused,
        attachments: normalized.attachments.map(a => ({ ...a, url: prefix + a.url.slice(1) })) };
    }), rules: copy(v.rules), controlsRevision: v.revision };
    if (session !== undefined) {
      result.csrfToken = session.csrf;
      const login = session.user.login || session.user.username || null;
      result.actor = { id: session.user.id, login: typeof login === 'string' ? login.slice(0, 120) : null };
    }
    return result;
  }
  function expect(v, payload) {
    need(int(payload.expectedRevision), 400, 'Нужна версия expectedRevision');
    need(payload.expectedRevision === v.revision, 409, 'Доска изменилась. Обновите данные перед новым действием.');
  }
  function commit(before, after, action, details) {
    after.revision = before.revision + 1;
    after.events.push({ id: crypto.randomUUID(), revision: after.revision, at: new Date().toISOString(), action, details });
    const bytes = Buffer.from(JSON.stringify(after));
    need(bytes.length <= MAX_STATE, 507, 'Журнал доски заполнен; требуется архивирование с сохранением истории');
    const previous = Buffer.from(JSON.stringify(before));
    atomic(previousPath, previous); atomic(statePath, bytes);
  }
  function serialized(work) {
    const previous = queues.get(dataDir) || Promise.resolve();
    const running = previous.catch(() => {}).then(work);
    const tail = running.catch(() => {});
    queues.set(dataDir, tail);
    tail.finally(() => { if (queues.get(dataDir) === tail) queues.delete(dataDir); });
    return running;
  }
  function saveMedia(name, bytes, written) {
    const target = inside(dataDir, name);
    directory(path.dirname(target), true);
    try {
      const existing = readFile(target, MAX_IMAGE);
      need(existing.equals(bytes), 409, 'Файл с таким именем уже существует и отличается');
      return;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    const opened = fs.fstatSync(fd);
    const record = { target, dev: opened.dev, ino: opened.ino, hash: null };
    written.push(record);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); record.hash = digest(bytes); }
    finally { fs.closeSync(fd); }
  }
  function rollback(written) {
    for (const file of written) {
      try {
        noLinks(file.target); const stat = fs.lstatSync(file.target);
        if (stat.dev === file.dev && stat.ino === file.ino && stat.nlink === 1 && (file.hash === null || digest(readFile(file.target, MAX_IMAGE)) === file.hash)) fs.unlinkSync(file.target);
      } catch (_) { /* Never remove an existing or replaced file. */ }
    }
  }
  function verifyAttachments(tasks) {
    const checked = new Set();
    for (const t of tasks) for (const a of t.attachments) {
      const name = mediaName(a.url); if (checked.has(name)) continue;
      const bytes = readFile(inside(dataDir, name), MAX_IMAGE);
      image(bytes, TYPES[path.extname(name).toLowerCase()], name); checked.add(name);
    }
  }
  function rules(value) {
    need(Array.isArray(value) && value.length <= 200, 400, 'Неверные правила');
    const result = value.map(r => {
      need(plain(r) && typeof r.id === 'string' && ID.test(r.id), 400, 'Неверное правило');
      need(r.items === undefined || (Array.isArray(r.items) && r.items.length <= 100), 400, 'Неверные пункты правила');
      return { id: r.id, title: string(r.title, 1000, 'rule.title'), detail: string(r.detail ?? r.description, 16000, 'rule.detail'),
        items: (r.items || []).map(t => string(t, 16000, 'rule.item')) };
    });
    need(new Set(result.map(r => r.id)).size === result.length, 400, 'Повторный номер правила');
    return result;
  }
  function mergedAttachments(old, incoming) {
    const byId = new Map(old.map(a => [a.id, a]));
    for (const a of incoming) {
      if (byId.has(a.id)) need(JSON.stringify(byId.get(a.id)) === JSON.stringify(a), 409, 'Существующее доказательство нельзя заменить отчётом');
      else byId.set(a.id, a);
    }
    return [...byId.values()];
  }

  return async function handle(req, res, url) {
    const rawPath = String(req.url || url?.pathname || '').split('?')[0];
    const bare = prefix.slice(0, -1);
    if (rawPath !== bare && !rawPath.startsWith(prefix)) return false;
    let route = '', session;
    try {
      const write = !['GET', 'HEAD'].includes(req.method);
      security(req, write);
      session = authenticate(req);
      if (write) requireCsrf(req, session);
      let decoded;
      try { decoded = decodeURIComponent(rawPath); } catch (_) { throw problem(400, 'Недопустимый адрес'); }
      need(!/[\\%\x00-\x1f]/.test(decoded) && !decoded.split('/').some(p => p === '.' || p === '..'), 403, 'Недопустимый адрес');
      need(decoded === bare || decoded.startsWith(prefix), 403, 'Недопустимый адрес');
      route = decoded === bare ? '' : decoded.slice(prefix.length);
      if (rawPath === bare && ['GET', 'HEAD'].includes(req.method)) {
        headers(res, 308, 'text/plain; charset=utf-8', 0, { location: prefix }); res.end(); return true;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (route === 'api/board' || route === 'api/export') {
          await serialized(() => {
            const current = fresh(req, session), value = board(state(), route === 'api/board' ? current : undefined);
            send(req, res, 200, value, route === 'api/export' ? { 'content-disposition': 'attachment; filename="synapse-owner-board.json"' } : {});
          });
        } else {
          let target, mime;
          if (route.startsWith('media/')) {
            const name = mediaName(route); target = inside(dataDir, name); mime = TYPES[path.extname(name).toLowerCase()];
          } else {
            const name = route || 'index.html';
            need(Object.hasOwn(STATIC, name), 404, 'Файл не найден'); target = inside(assetsDir, name); mime = STATIC[name];
          }
          const bytes = readFile(target, route.startsWith('media/') ? MAX_IMAGE : 2 * 1024 * 1024);
          if (route.startsWith('media/')) image(bytes, mime, target);
          fresh(req, session); headers(res, 200, mime, bytes.length); res.end(req.method === 'HEAD' ? undefined : bytes);
        }
        return true;
      }
      const patchMatch = /^api\/tasks\/([A-Za-z0-9_-]+)$/.exec(route);
      const uploadMatch = /^api\/tasks\/([A-Za-z0-9_-]+)\/attachments$/.exec(route);
      need((req.method === 'PATCH' && patchMatch) || (req.method === 'POST' && (uploadMatch || route === 'api/report')), 405, 'Метод не поддерживается');
      const payload = await readBody(req);
      await serialized(() => {
        const currentSession = fresh(req, session, true), before = state(); expect(before, payload);
        const after = copy(before), written = [];
        let action, details, committed = false;
        try {
          if (patchMatch) {
            need(Object.keys(payload).every(k => ['priority', 'paused', 'expectedRevision'].includes(k)) && ('priority' in payload || 'paused' in payload), 400, 'Укажите приоритет или паузу');
            const id = patchMatch[1]; need(ID.test(id) && after.tasks.some(t => t.id === id), 404, 'Задача не найдена');
            if ('priority' in payload) need(int(payload.priority) && payload.priority >= 1 && payload.priority <= 4, 400, 'Приоритет должен быть от 1 до 4');
            if ('paused' in payload) need(typeof payload.paused === 'boolean', 400, 'Пауза должна быть true или false');
            details = { taskId: id };
            for (const k of ['priority', 'paused']) if (k in payload) { after.controls[id][k] = payload[k]; details[k] = payload[k]; }
            action = 'task-controls';
          } else if (uploadMatch) {
            need(Object.keys(payload).length === 5 && ['role', 'name', 'mime', 'dataBase64', 'expectedRevision'].every(k => Object.hasOwn(payload, k)), 400, 'Неверное вложение');
            const id = uploadMatch[1], target = after.tasks.find(t => t.id === id);
            need(ID.test(id) && target, 404, 'Задача не найдена');
            need(['request', 'proof'].includes(payload.role), 400, 'Неверная роль вложения');
            const name = string(payload.name, 255, 'name'); need(name.length > 0 && !/[\x00-\x1f]/.test(name), 400, 'Неверное имя файла');
            const decodedImage = decodeImage(payload.dataBase64, payload.mime), uuid = crypto.randomUUID();
            const file = 'media/uploads/' + uuid + decodedImage.ext;
            saveMedia(file, decodedImage.bytes, written);
            target.attachments.push({ id: uuid, role: payload.role, url: '/' + file, caption: name, originalName: name });
            action = 'task-attachment'; details = { taskId: id, attachmentId: uuid, role: payload.role, bytes: decodedImage.bytes.length };
          } else {
            need(Object.keys(payload).length === 2 && Object.hasOwn(payload, 'report'), 400, 'Нужны только report и expectedRevision');
            const report = payload.report;
            need(plain(report) && Object.keys(report).every(k => ['status', 'tasks', 'rules', 'media'].includes(k)) && plain(report.status)
              && Array.isArray(report.tasks) && report.tasks.length <= 5000 && Array.isArray(report.media || []), 400, 'Неверный пакет отчёта');
            const incomingStatus = reportStatus(report.status);
            const incoming = report.tasks.map(task);
            need(new Set(incoming.map(t => t.id)).size === incoming.length, 400, 'Повторный номер задачи');
            const incomingRules = rules(report.rules);
            const files = new Map(); let total = 0;
            need((report.media || []).length <= 512, 413, 'Слишком много изображений');
            for (const m of report.media || []) {
              need(plain(m) && Object.keys(m).length === 3 && ['name', 'mime', 'dataBase64'].every(k => Object.hasOwn(m, k)) && typeof m.name === 'string', 400, 'Неверное изображение отчёта');
              const name = mediaName(m.name), decodedImage = decodeImage(m.dataBase64, m.mime, name);
              need(!files.has(name), 400, 'Повторный путь изображения'); files.set(name, decodedImage.bytes); total += decodedImage.bytes.length;
              need(total <= 32 * 1024 * 1024, 413, 'Суммарный размер изображений больше 32 МБ');
            }
            // Validate every collision before writing any file.
            for (const [name, bytes] of files) {
              try { need(readFile(inside(dataDir, name), MAX_IMAGE).equals(bytes), 409, 'Файл с таким именем уже существует и отличается'); }
              catch (e) { if (e.code !== 'ENOENT') throw e; }
            }
            const byId = new Map(after.tasks.map(t => [t.id, t]));
            for (const incomingTask of incoming) {
              const existing = byId.get(incomingTask.id);
              if (existing) incomingTask.attachments = mergedAttachments(existing.attachments, incomingTask.attachments);
              else after.controls[incomingTask.id] = { priority: incomingTask.priority, paused: incomingTask.paused };
              byId.set(incomingTask.id, incomingTask);
            }
            // Omitted tasks and uploaded evidence remain present. Controls are never imported for an existing ID.
            after.tasks = [...byId.values()]; after.status = incomingStatus; after.rules = incomingRules;
            after.history.push({ revision: before.revision, at: new Date().toISOString(), status: copy(before.status), tasks: copy(before.tasks), rules: copy(before.rules) });
            for (const [name, bytes] of files) saveMedia(name, bytes, written);
            verifyAttachments(after.tasks);
            action = 'report'; details = { incomingTasks: incoming.length, tasks: after.tasks.length, images: files.size };
          }
          fresh(req, session, true);
          commit(before, after, action, details); committed = true;
          send(req, res, 200, board(after, currentSession));
        } finally { if (!committed) rollback(written); }
      });
      return true;
    } catch (error) {
      const status = [400, 401, 403, 404, 405, 409, 411, 413, 415, 507].includes(error.status) ? error.status : error.code === 'ENOENT' ? 404 : 503;
      if (res.headersSent || res.destroyed) { if (!res.writableEnded) res.end(); return true; }
      if (status === 401 && !rawPath.slice(prefix.length).startsWith('api/') && ['GET', 'HEAD'].includes(req.method)) {
        // /cabinet.html is the verified cabinet entry, not an invented login redirect.
        const bytes = Buffer.from('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Вход в Synapse</title><h1>Нужен личный вход</h1><p>Войдите в Synapse и вернитесь к доске.</p><a href="/cabinet.html">Открыть вход Synapse</a></html>');
        headers(res, 401, 'text/html; charset=utf-8', bytes.length); res.end(req.method === 'HEAD' ? undefined : bytes);
      } else send(req, res, status, { error: status === 503 ? 'Не удалось прочитать или сохранить доску. Проверьте состояние перед повтором.' : status === 404 ? 'Адрес не найден' : error.message });
      return true;
    }
  };
}

module.exports = { createOwnerBoard };
