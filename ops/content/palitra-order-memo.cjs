'use strict';

// Памятка компании: неизменяемые файлы в существующей private documents.
// Клиент получает только отдельную копию в своём проверенном чате после выдачи.
const crypto = require('node:crypto');
const COMPANY = 'palitra-love', PREFIX = COMPANY + '/order-memo/';
const ROUTE = '/content/palitra/workflow/memo-assets';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BYTES = 2 * 1024 * 1024, MAX_TOTAL = 32 * 1024 * 1024, MAX_ASSETS = 100;
const fail = (status, message, code = 'MEMO') => { throw Object.assign(new Error(message), { status, code }); };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const referenceId = ref => typeof ref === 'string' && ref.startsWith('memo:') && UUID.test(ref.slice(5)) ? ref.slice(5) : null;
function mediaType(bytes) {
  if (bytes.length >= 5 && bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) return { contentType: 'application/pdf', kind: 'document' };
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { contentType: 'image/jpeg', kind: 'photo' };
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { contentType: 'image/png', kind: 'photo' };
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { contentType: 'image/webp', kind: 'photo' };
  fail(415, 'Памятка: выберите PDF, JPG, PNG или WebP.');
}
function safeName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 180 || /[\x00-\x1f\x7f\\/]/.test(value) || !value.trim() || value === '.' || value === '..') fail(400, 'Некорректное имя файла памятки.');
  return value.trim();
}
function createMemoAssets({ db, transaction, getUser, canAccess, now = Date.now } = {}) {
  if (!db || typeof transaction !== 'function' || typeof getUser !== 'function' || typeof canAccess !== 'function') throw new TypeError('Existing private memo host required');
  const get = db.prepare('SELECT version,body FROM documents WHERE key=? ORDER BY version DESC LIMIT 1');
  const all = db.prepare('SELECT key,version,body FROM documents WHERE key LIKE ? ORDER BY created_at DESC LIMIT ?');
  const insert = db.prepare('INSERT INTO documents(key,version,created_at,author,body) VALUES(?,?,?,?,?)');
  function actor(owner) {
    if (!owner || !Number.isSafeInteger(owner.id) || owner.id < 1 || !Number.isSafeInteger(owner.sessionVersion)) fail(403, 'Требуется действующий доступ Палитры.', 'ACCESS');
    const user = getUser(owner.id);
    if (!user || user.id !== owner.id || user.sessionVersion !== owner.sessionVersion || !canAccess(user, 'crm.edit')) fail(403, 'Доступ к памятке изменился.', 'ACCESS');
    return user;
  }
  function decode(row, id) {
    let value; try { value = JSON.parse(row.body); } catch (_) { fail(503, 'Сохранённая памятка повреждена.'); }
    if (row.version !== 1 || value?.schema !== 1 || value.companyCode !== COMPANY || value.id !== id || !UUID.test(id)
      || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_BYTES || typeof value.base64 !== 'string'
      || !Number.isSafeInteger(value.actorId) || value.actorId < 1 || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)
      || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) fail(503, 'Сохранённая памятка повреждена.');
    safeName(value.name);
    const bytes = Buffer.from(value.base64, 'base64');
    if (bytes.length !== value.size || bytes.toString('base64') !== value.base64 || digest(bytes) !== value.sha256) fail(503, 'Контрольная сумма памятки не совпала.');
    const type = mediaType(bytes);
    if (type.kind !== value.kind || type.contentType !== value.contentType) fail(503, 'Тип сохранённой памятки не совпал.');
    return { value, bytes };
  }
  const metadata = value => ({ reference: 'memo:' + value.id, name: value.name, contentType: value.contentType, kind: value.kind, size: value.size, sha256: value.sha256, createdAt: value.createdAt });
  function list(owner) {
    actor(owner);
    const rows = all.all(PREFIX + '%', MAX_ASSETS + 1);
    const assets = rows.map(row => metadata(decode(row, row.key.slice(PREFIX.length)).value));
    actor(owner); return { ok: true, maxBytes: MAX_BYTES, assets };
  }
  function save({ owner, requestId, name, contentType, bytes }) {
    actor(owner);
    if (typeof requestId !== 'string' || !UUID.test(requestId)) fail(400, 'Некорректный запрос загрузки памятки.');
    name = safeName(name);
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_BYTES) fail(413, 'Файл памятки должен быть не больше 2 МБ.');
    const type = mediaType(bytes), sha256 = digest(bytes);
    if (contentType !== type.contentType) fail(415, 'Тип файла не совпал с содержимым памятки.');
    return transaction(() => {
      actor(owner); const key = PREFIX + requestId, old = get.get(key);
      if (old) {
        const { value } = decode(old, requestId);
        if (value.actorId !== owner.id || value.name !== name || value.contentType !== contentType || value.sha256 !== sha256 || value.size !== bytes.length) fail(409, 'Этот запрос уже использован для другой памятки.', 'REQUEST_CONFLICT');
        actor(owner); return { ok: true, duplicate: true, asset: metadata(value) };
      }
      const rows = all.all(PREFIX + '%', MAX_ASSETS + 1);
      const used = rows.reduce((total, row) => total + decode(row, row.key.slice(PREFIX.length)).value.size, 0);
      if (rows.length >= MAX_ASSETS || used + bytes.length > MAX_TOTAL) fail(409, 'Лимит материалов памятки достигнут. Выберите уже загруженный файл.');
      const value = { schema: 1, companyCode: COMPANY, id: requestId, actorId: owner.id, createdAt: new Date(now()).toISOString(), name, ...type, size: bytes.length, sha256, base64: bytes.toString('base64') };
      actor(owner); insert.run(key, 1, value.createdAt, 'palitra-memo:' + owner.id, JSON.stringify(value)); actor(owner);
      return { ok: true, duplicate: false, asset: metadata(value) };
    });
  }
  function read({ owner, reference }) {
    actor(owner); const id = referenceId(reference); if (!id) fail(400, 'Некорректная ссылка памятки.');
    const row = get.get(PREFIX + id); if (!row) fail(404, 'Файл памятки не найден.');
    const { value, bytes } = decode(row, id); actor(owner);
    return { ...metadata(value), bytes };
  }
  return Object.freeze({ actor, list, save, read, maxBytes: MAX_BYTES });
}
function createMemoHttp({ assets, requireSession, requireCsrf, origin } = {}) {
  const ownerOf = session => ({ id: session.user.id, sessionVersion: session.user.sessionVersion });
  return async function handle(request, url, reply) {
    if (url.pathname !== ROUTE) return false;
    const before = requireSession(request), owner = ownerOf(before), headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    assets.actor(owner);
    if (request.method === 'GET') { reply(200, assets.list(owner), headers); return true; }
    if (request.method !== 'POST') fail(405, 'Метод памятки недоступен.');
    if (request.headers.origin !== origin) fail(403, 'Адрес загрузки памятки не совпал.', 'ORIGIN');
    requireCsrf(request, before);
    const requestId = request.headers['x-palitra-memo-request-id'];
    let name; try { name = decodeURIComponent(request.headers['x-palitra-memo-name'] || ''); } catch (_) { fail(400, 'Некорректное имя файла.'); }
    // Проверяем заголовки до чтения потока; новые права или сессии не создаются.
    if (typeof requestId !== 'string' || !UUID.test(requestId)) fail(400, 'Некорректный запрос загрузки.');
    safeName(name);
    const contentType = request.headers['content-type'];
    if (!['application/pdf','image/jpeg','image/png','image/webp'].includes(contentType)) fail(415, 'Выберите PDF, JPG, PNG или WebP.');
    const length = request.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > assets.maxBytes)) fail(413, 'Файл памятки должен быть не больше 2 МБ.');
    const chunks = []; let size = 0;
    for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > assets.maxBytes) fail(413, 'Файл памятки должен быть не больше 2 МБ.'); chunks.push(bytes); }
    const fresh = requireSession(request);
    if (fresh.user.id !== owner.id || fresh.user.sessionVersion !== owner.sessionVersion) fail(403, 'Сессия загрузки изменилась.', 'ACCESS');
    requireCsrf(request, fresh); assets.actor(owner);
    const result = assets.save({ owner, requestId, name, contentType, bytes: Buffer.concat(chunks, size) });
    reply(200, result, headers); return true;
  };
}
module.exports = { createMemoAssets, createMemoHttp, referenceId, mediaType, MAX_BYTES, ROUTE };
