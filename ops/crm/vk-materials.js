'use strict';

const crypto = require('node:crypto');
const { validateImage, validateUploadUrl, VK_DESIGN_ERRORS } = require('./vk-design');
const TTL_MS = 30 * 60 * 1000, MAX_RESPONSE_BYTES = 2 * 1024 * 1024, PAGE_SIZE = 100;
const ERRORS = Object.freeze({
  ...VK_DESIGN_ERRORS,
  INVALID_INPUT: 'Проверьте параметры фото и альбома',
  TOKEN_TYPE_MISMATCH: 'Для альбомов требуется проверенное подключение оформления с пользовательским ключом',
  ALBUM_NOT_FOUND: 'Выбранный альбом этого сообщества не найден',
  STATE_CHANGED: 'Выбранный альбом изменился. Создайте новый предпросмотр',
  UPLOAD_FAILED: 'Сервер ВКонтакте не подтвердил загрузку фото',
});
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, status = 400) => { throw Object.assign(new Error(ERRORS[code] || ERRORS.RESPONSE_INVALID), { code, status }); };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const strict = (value, keys) => { if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) fail('INVALID_INPUT'); };
const key = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,100}$/.test(value);
const albumId = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);

// MATERIALS_SCOPE: internal service; owner/company authorization belongs to the HTTP adapter.
// Official method contracts: VKCOM/vk-api-schema@333481bd082ad747d4873ef4a77f9247097eeef0.
function createVkMaterials(db, { direct, fetchImpl = fetch, now = Date.now, timeoutMs = 15000 } = {}) {
  if (!direct?.getSettings || !direct?.request) throw new Error('VK direct connector is required');
  db.exec(`CREATE TABLE IF NOT EXISTS vk_material_previews (
    company_code TEXT NOT NULL COLLATE NOCASE REFERENCES companies(code), preview_id TEXT NOT NULL,
    group_id TEXT NOT NULL, revision INTEGER NOT NULL, album_id INTEGER NOT NULL, album_title TEXT NOT NULL,
    caption TEXT NOT NULL, image_json TEXT NOT NULL, source_hash TEXT NOT NULL, image_bytes BLOB,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(company_code,preview_id));
    CREATE TABLE IF NOT EXISTS vk_material_actions (
    company_code TEXT NOT NULL COLLATE NOCASE REFERENCES companies(code), request_id TEXT NOT NULL,
    preview_id TEXT NOT NULL, group_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
    error_code TEXT, photo_json TEXT, created_at TEXT NOT NULL, completed_at TEXT,
    PRIMARY KEY(company_code,request_id), UNIQUE(company_code,preview_id),
    FOREIGN KEY(company_code,preview_id) REFERENCES vk_material_previews(company_code,preview_id));`);
  const stamp = () => new Date(now()).toISOString();
  function company(code) {
    if (typeof code !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code)) fail('INVALID_INPUT');
    const row = db.prepare('SELECT code FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get(code);
    if (!row) fail('INVALID_INPUT', 404);
    return row.code.toLowerCase();
  }
  function purge(code) {
    // Lazy housekeeping: no background worker. Retain audit metadata, never expired source bytes.
    db.prepare('UPDATE vk_material_previews SET image_bytes=NULL WHERE company_code=? AND expires_at<=? AND image_bytes IS NOT NULL').run(code, stamp());
  }
  function connection(code, revision) {
    const companyCode = company(code), row = direct.getSettings(companyCode, 'design');
    if (row.companyCode !== companyCode || typeof row.groupId !== 'string' || !/^[1-9]\d{0,14}$/.test(row.groupId)) fail('CONNECTION_MISSING', 409);
    if (revision !== undefined && revision !== row.revision) fail('SETTINGS_CHANGED', 409);
    if (!row.connected) fail('CONNECTION_MISSING', 409);
    if (row.tokenType !== 'user') fail('TOKEN_TYPE_MISMATCH', 409);
    return row;
  }
  function guard(row) {
    const current = connection(row.companyCode, row.revision);
    if (current.groupId !== row.groupId) fail('SETTINGS_CHANGED', 409);
  }
  async function request(row, method, params) {
    guard(row);
    return direct.request(row.companyCode, 'design', row.revision, method, params);
  }
  function albums(result, row) {
    if (!object(result) || !Number.isSafeInteger(result.count) || result.count < 0 || !Array.isArray(result.items) || result.items.length > PAGE_SIZE || result.count < result.items.length) fail('RESPONSE_INVALID', 502);
    const ids = new Set();
    return result.items.map(item => {
      if (!object(item) || !Number.isSafeInteger(item.owner_id) || String(item.owner_id) !== `-${row.groupId}`) fail('GROUP_MISMATCH', 502);
      if (!albumId(item.id) || ids.has(item.id) || !text(item.title, 2000) || !Number.isSafeInteger(item.size) || item.size < 0) fail('RESPONSE_INVALID', 502);
      ids.add(item.id);
      return { id: item.id, title: item.title, size: item.size };
    });
  }
  async function readAlbum(row, id) {
    const result = await request(row, 'photos.getAlbums', { album_ids: String(id), count: 1 });
    guard(row);
    const items = albums(result, row);
    if (items.length !== 1 || items[0].id !== id) fail('ALBUM_NOT_FOUND', 409);
    return items[0];
  }
  async function listAlbums(code, options = {}) {
    strict(options, ['revision', 'offset']);
    const row = connection(code, options.revision), offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) fail('INVALID_INPUT');
    purge(row.companyCode);
    const result = await request(row, 'photos.getAlbums', { offset, count: PAGE_SIZE });
    guard(row);
    const items = albums(result, row);
    return { companyCode: row.companyCode, groupId: row.groupId, revision: row.revision,
      total: result.count, offset, nextOffset: items.length && offset + items.length < result.count ? offset + items.length : null, albums: items };
  }
  const previewFor = (code, id) => db.prepare('SELECT * FROM vk_material_previews WHERE company_code=? AND preview_id=?').get(code, id);
  const actionFor = (code, id) => db.prepare('SELECT * FROM vk_material_actions WHERE company_code=? AND request_id=?').get(code, id);
  const previewDto = row => ({ companyCode: row.company_code, groupId: row.group_id, revision: row.revision,
    previewId: row.preview_id, operation: 'album_photo', album: { id: row.album_id, title: row.album_title },
    caption: row.caption, image: JSON.parse(row.image_json), createdAt: row.created_at, expiresAt: row.expires_at });
  const actionDto = row => ({ ...previewDto(previewFor(row.company_code, row.preview_id)), requestId: row.request_id,
    status: row.status, code: row.error_code || null, photo: row.photo_json ? JSON.parse(row.photo_json) : null,
    createdAt: row.created_at, completedAt: row.completed_at || null });

  async function preview(code, body) {
    strict(body, ['revision', 'albumId', 'caption', 'image']);
    const row = connection(code, body.revision), caption = body.caption ?? '';
    if (body.revision !== row.revision || !albumId(body.albumId) || !text(caption, 2000)) fail('INVALID_INPUT');
    const image = validateImage(body.image), album = await readAlbum(row, body.albumId);
    guard(row);
    const imageInfo = { mime: image.mime, width: image.width, height: image.height, size: image.bytes.length, sourceHash: image.sourceHash };
    const previewId = crypto.randomUUID(), created = stamp(), expires = new Date(now() + TTL_MS).toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      guard(row); purge(row.companyCode);
      const usage = db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(LENGTH(image_bytes)),0) AS bytes FROM vk_material_previews
        WHERE company_code=? AND image_bytes IS NOT NULL`).get(row.companyCode);
      if (usage.count >= 20 || usage.bytes + image.bytes.length > 128 * 1024 * 1024) fail('PREVIEW_LIMIT', 409);
      db.prepare(`INSERT INTO vk_material_previews(company_code,preview_id,group_id,revision,album_id,album_title,caption,image_json,source_hash,image_bytes,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.companyCode, previewId, row.groupId, row.revision, album.id, album.title,
          caption, JSON.stringify(imageInfo), image.sourceHash, image.bytes, created, expires);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return previewDto(previewFor(row.companyCode, previewId));
  }

  async function upload(url, body) {
    const controller = new AbortController(); let timer, reader;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Upload timeout')); }, timeoutMs); });
    try {
      const response = await Promise.race([fetchImpl(url, { method: 'POST', body, redirect: 'error', signal: controller.signal }), timeout]);
      if (!response.ok || response.redirected) fail('UPLOAD_FAILED', 502);
      reader = response.body?.getReader?.(); if (!reader) fail('UPLOAD_FAILED', 502);
      const chunks = []; let size = 0;
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), timeout]);
        if (done) break;
        size += value.byteLength; if (size > MAX_RESPONSE_BYTES) fail('UPLOAD_FAILED', 502);
        chunks.push(Buffer.from(value));
      }
      const result = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
      if (!object(result) || Object.hasOwn(result, 'error') || !Number.isSafeInteger(result.server) || result.server <= 0
        || !text(result.hash, 4096) || !result.hash || typeof result.photos_list !== 'string' || !result.photos_list || result.photos_list.length > 1024 * 1024) fail('UPLOAD_FAILED', 502);
      // Do not persist opaque server/hash/photos_list or disclose them in a DTO.
      return result;
    } catch { fail('UPLOAD_FAILED', 502); }
    finally { clearTimeout(timer); if (reader) reader.cancel().catch(() => {}); }
  }
  function savedPhoto(result, row, p) {
    if (!Array.isArray(result) || result.length !== 1 || !object(result[0]) || !Number.isSafeInteger(result[0].id) || result[0].id <= 0) fail('RESPONSE_INVALID', 502);
    const photo = result[0];
    if (!Number.isSafeInteger(photo.owner_id) || String(photo.owner_id) !== `-${row.groupId}` || photo.album_id !== p.album_id) fail('GROUP_MISMATCH', 502);
    return { id: photo.id, ownerId: photo.owner_id, albumId: photo.album_id };
  }
  async function apply(code, body) {
    strict(body, ['revision', 'previewId', 'requestId']);
    if (!key(body.previewId) || !key(body.requestId)) fail('INVALID_INPUT');
    const row = connection(code, body.revision);
    if (body.revision !== row.revision) fail('SETTINGS_CHANGED', 409);
    purge(row.companyCode);
    const p = previewFor(row.companyCode, body.previewId);
    if (!p) fail('PREVIEW_NOT_FOUND', 404);
    if (p.revision !== row.revision || p.group_id !== row.groupId) fail('SETTINGS_CHANGED', 409);
    function previous() {
      const same = actionFor(row.companyCode, body.requestId);
      if (same && same.preview_id !== p.preview_id) fail('REQUEST_CONFLICT', 409);
      return same || db.prepare('SELECT * FROM vk_material_actions WHERE company_code=? AND preview_id=?').get(row.companyCode, p.preview_id);
    }
    const existing = previous(); if (existing) return actionDto(existing);
    if (now() >= Date.parse(p.expires_at)) fail('PREVIEW_EXPIRED', 409);
    // Claim before all awaits/writes. A crash remains non-retryable even with a new request ID.
    db.exec('BEGIN IMMEDIATE');
    try {
      guard(row); const same = previous(); if (same) { db.exec('COMMIT'); return actionDto(same); }
      if (db.prepare("SELECT 1 FROM vk_material_actions WHERE group_id=? AND status='applying'").get(row.groupId)) fail('OPERATION_BUSY', 409);
      db.prepare(`INSERT INTO vk_material_actions(company_code,request_id,preview_id,group_id,revision,status,created_at)
        VALUES(?,?,?,?,?,'applying',?)`).run(row.companyCode, body.requestId, p.preview_id, row.groupId, row.revision, stamp());
      // The operation owns the in-memory snapshot now. A process crash must not
      // leave reusable source bytes behind an already-dispatched durable claim.
      db.prepare('UPDATE vk_material_previews SET image_bytes=NULL WHERE company_code=? AND preview_id=?').run(row.companyCode, p.preview_id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    let status = 'failed', errorCode = null, dispatched = false, accepted = false, photo = null;
    try {
      const album = await readAlbum(row, p.album_id);
      if (album.title !== p.album_title) fail('STATE_CHANGED', 409);
      const destination = await request(row, 'photos.getUploadServer', { album_id: p.album_id });
      guard(row);
      if (!object(destination) || (destination.album_id !== undefined && destination.album_id !== p.album_id)) fail('RESPONSE_INVALID', 502);
      const url = validateUploadUrl(destination.upload_url), bytes = Buffer.from(p.image_bytes || []), image = JSON.parse(p.image_json);
      if (!bytes.length || digest(bytes) !== p.source_hash) fail('INVALID_IMAGE');
      const multipart = new FormData();
      // Single-file field from official VKCOM/vk-java-sdk Upload.photo().
      multipart.append('photo', new Blob([bytes], { type: image.mime }), image.mime === 'image/png' ? 'photo.png' : 'photo.jpg');
      guard(row); dispatched = true;
      const uploaded = await upload(url, multipart);
      if (uploaded.aid !== undefined && uploaded.aid !== p.album_id) fail('RESPONSE_INVALID', 502);
      guard(row);
      const currentAlbum = await readAlbum(row, p.album_id);
      if (currentAlbum.title !== p.album_title) fail('STATE_CHANGED', 409);
      const result = await request(row, 'photos.save', { album_id: p.album_id, caption: p.caption,
        server: uploaded.server, photos_list: uploaded.photos_list, hash: uploaded.hash });
      photo = savedPhoto(result, row, p); accepted = true;
      status = 'applied_unverified';
      const observed = await request(row, 'photos.getById', { photos: `${photo.ownerId}_${photo.id}` });
      guard(row);
      const readback = savedPhoto(observed, row, p);
      if (readback.id === photo.id && observed[0].text === p.caption) status = 'verified';
      else errorCode = 'READBACK_MISMATCH';
    } catch (error) {
      errorCode = Object.hasOwn(ERRORS, error?.code) ? error.code : 'CONNECTION_UNCERTAIN';
      const definite = ['ACCESS_DENIED', 'PLATFORM_REJECTED', 'SETTINGS_CHANGED', 'CONNECTION_MISSING', 'TOKEN_TYPE_MISMATCH', 'STATE_CHANGED', 'ALBUM_NOT_FOUND'].includes(errorCode)
        && error?.ambiguous !== true && error?.uncertain !== true;
      status = accepted ? 'applied_unverified' : dispatched && !definite ? 'uncertain' : 'failed';
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE vk_material_actions SET status=?,error_code=?,photo_json=?,completed_at=? WHERE company_code=? AND request_id=?')
        .run(status, errorCode, photo ? JSON.stringify(photo) : null, stamp(), row.companyCode, body.requestId);
      db.prepare('UPDATE vk_material_previews SET image_bytes=NULL WHERE company_code=? AND preview_id=?').run(row.companyCode, p.preview_id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return actionDto(actionFor(row.companyCode, body.requestId));
  }
  function history(code, options = {}) {
    strict(options, ['revision']);
    const companyCode = company(code), current = direct.getSettings(companyCode, 'design');
    if (options.revision !== undefined && options.revision !== current.revision) fail('SETTINGS_CHANGED', 409);
    purge(companyCode);
    return { companyCode, groupId: current.groupId, revision: current.revision,
      items: db.prepare('SELECT * FROM vk_material_actions WHERE company_code=? ORDER BY created_at DESC,rowid DESC LIMIT 100').all(companyCode).map(actionDto) };
  }
  return { listAlbums, preview, apply, history };
}

module.exports = { createVkMaterials, VK_MATERIAL_ERRORS: ERRORS };
