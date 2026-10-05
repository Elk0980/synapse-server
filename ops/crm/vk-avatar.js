'use strict';

const crypto = require('node:crypto');
const { validateImage, validateUploadUrl } = require('./vk-design');
const TTL_MS = 30 * 60 * 1000, MAX_ACTIVE_PREVIEWS = 20;
const WARNINGS = Object.freeze(['AVATAR_MAY_CREATE_PUBLIC_POST', 'AVATAR_APPLY_DISABLED', 'AVATAR_CROP_UNVERIFIED']);
const VK_AVATAR_ERRORS = Object.freeze({
  INVALID_INPUT: 'Проверьте параметры предпросмотра аватара',
  INVALID_IMAGE: 'Выберите квадратное изображение JPEG или PNG размером до 8 МиБ',
  CONNECTION_MISSING: 'Сначала сохраните и проверьте подключение оформления ВКонтакте',
  TOKEN_TYPE_MISMATCH: 'Для аватара требуется проверенное подключение оформления с пользовательским ключом',
  SETTINGS_CHANGED: 'Подключение изменилось. Создайте новый предпросмотр',
  GROUP_MISMATCH: 'ВКонтакте вернул другое сообщество',
  RESPONSE_INVALID: 'ВКонтакте вернул неподтверждённые сведения об аватаре',
  ACCESS_DENIED: 'ВКонтакте не предоставил нужные права',
  CONNECTION_UNCERTAIN: 'Не удалось подтвердить сведения ВКонтакте',
  PREVIEW_LIMIT: 'Слишком много активных предпросмотров. Дождитесь их истечения',
  PREVIEW_NOT_FOUND: 'Предпросмотр аватара не найден',
  PREVIEW_EXPIRED: 'Предпросмотр истёк. Создайте новый',
  REQUEST_CONFLICT: 'Идентификатор запроса уже использован для другого предпросмотра',
  AVATAR_APPLY_DISABLED: 'Применение аватара отключено: ВКонтакте может создать публичную запись',
});
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, status = 400) => { throw Object.assign(new Error(VK_AVATAR_ERRORS[code]), { code, status }); };
const strict = (value, keys) => { if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) fail('INVALID_INPUT'); };
const key = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,100}$/.test(value);
const getCapabilities = () => ({ applyEnabled: false, cropSupported: false });

function photoUrl(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(value)) fail('RESPONSE_INVALID', 502);
  try {
    const url = new URL(validateUploadUrl(value));
    if ([...url.searchParams.keys()].some(name => /^(access_key|access_token|refresh_token|token|authorization)$/i.test(name))) fail('RESPONSE_INVALID', 502);
    return url.href;
  } catch { fail('RESPONSE_INVALID', 502); }
}

// Preparation only. There is deliberately no avatar upload, save transport or enabling option.
// Owner/company authorization is enforced by the HTTP adapter; this service rechecks the binding.
function createVkAvatar(db, { direct, now = Date.now } = {}) {
  if (!direct?.getSettings || !direct?.request) throw new Error('VK direct connector is required');
  db.exec(`CREATE TABLE IF NOT EXISTS vk_avatar_previews (
    company_code TEXT NOT NULL COLLATE NOCASE REFERENCES companies(code), preview_id TEXT NOT NULL,
    group_id TEXT NOT NULL, revision INTEGER NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
    source_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    PRIMARY KEY(company_code,preview_id));
    CREATE TABLE IF NOT EXISTS vk_avatar_actions (
    company_code TEXT NOT NULL COLLATE NOCASE REFERENCES companies(code), request_id TEXT NOT NULL,
    preview_id TEXT NOT NULL, group_id TEXT NOT NULL, revision INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status='blocked'), error_code TEXT NOT NULL CHECK(error_code='AVATAR_APPLY_DISABLED'),
    created_at TEXT NOT NULL, completed_at TEXT NOT NULL,
    PRIMARY KEY(company_code,request_id), UNIQUE(company_code,preview_id),
    FOREIGN KEY(company_code,preview_id) REFERENCES vk_avatar_previews(company_code,preview_id));`);
  const stamp = () => new Date(now()).toISOString();
  function company(code) {
    if (typeof code !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code)) fail('INVALID_INPUT');
    const found = db.prepare('SELECT code FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get(code);
    if (!found) fail('INVALID_INPUT', 404);
    return found.code.toLowerCase();
  }
  function connection(code, revision) {
    const companyCode = company(code), row = direct.getSettings(companyCode, 'design');
    if (!object(row) || row.companyCode !== companyCode || typeof row.groupId !== 'string' || !/^[1-9]\d{0,14}$/.test(row.groupId)
      || !Number.isSafeInteger(row.revision) || row.revision < 1 || row.connected !== true) fail('CONNECTION_MISSING', 409);
    if (revision !== undefined && revision !== row.revision) fail('SETTINGS_CHANGED', 409);
    if (row.tokenType !== 'user') fail('TOKEN_TYPE_MISMATCH', 409);
    // Keep a snapshot even when a connector returns a mutable settings object.
    return { companyCode, groupId: row.groupId, revision: row.revision };
  }
  function guard(row) {
    const current = connection(row.companyCode, row.revision);
    if (current.groupId !== row.groupId) fail('SETTINGS_CHANGED', 409);
  }
  function quota(code) {
    const active = db.prepare(`SELECT COUNT(*) AS count FROM vk_avatar_previews p WHERE company_code=? AND expires_at>?
      AND NOT EXISTS (SELECT 1 FROM vk_avatar_actions a WHERE a.company_code=p.company_code AND a.preview_id=p.preview_id)`).get(code, stamp());
    if (active.count >= MAX_ACTIVE_PREVIEWS) fail('PREVIEW_LIMIT', 409);
  }
  function purge(code) {
    // Audit-linked metadata survives expiry; unused metadata is removed lazily without a worker.
    db.prepare(`DELETE FROM vk_avatar_previews WHERE company_code=? AND expires_at<=? AND NOT EXISTS
      (SELECT 1 FROM vk_avatar_actions a WHERE a.company_code=vk_avatar_previews.company_code AND a.preview_id=vk_avatar_previews.preview_id)`).run(code, stamp());
  }
  const previewFor = (code, id) => db.prepare('SELECT * FROM vk_avatar_previews WHERE company_code=? AND preview_id=?').get(code, id);
  const actionFor = (code, id) => db.prepare('SELECT * FROM vk_avatar_actions WHERE company_code=? AND request_id=?').get(code, id);
  const previewDto = row => ({ companyCode: row.company_code, groupId: row.group_id, revision: row.revision,
    previewId: row.preview_id, operation: 'avatar', before: JSON.parse(row.before_json), after: JSON.parse(row.after_json),
    sourceHash: row.source_hash, warnings: [...WARNINGS], capabilities: getCapabilities(), createdAt: row.created_at, expiresAt: row.expires_at });
  const actionDto = row => ({ ...previewDto(previewFor(row.company_code, row.preview_id)), requestId: row.request_id,
    status: row.status, code: row.error_code, createdAt: row.created_at, completedAt: row.completed_at });

  async function preview(code, body) {
    strict(body, ['revision', 'image']);
    if (!Number.isSafeInteger(body.revision) || body.revision < 1) fail('INVALID_INPUT');
    const row = connection(code, body.revision);
    let image;
    try { image = validateImage(body.image); } catch { fail('INVALID_IMAGE'); }
    if (image.width !== image.height) fail('INVALID_IMAGE');
    const after = { mime: image.mime, width: image.width, height: image.height, sourceHash: image.sourceHash };
    image = null; // Source bytes are not retained in service state or written to SQLite.
    quota(row.companyCode);
    let result;
    try {
      result = await direct.request(row.companyCode, 'design', row.revision, 'groups.getById', { fields: 'photo_200,photo_max,photo_max_orig,has_photo' });
    } catch (error) {
      const known = Object.hasOwn(VK_AVATAR_ERRORS, error?.code) ? error.code : 'CONNECTION_UNCERTAIN';
      fail(known, known === 'SETTINGS_CHANGED' || known === 'CONNECTION_MISSING' ? 409 : 502);
    }
    guard(row);
    if (!object(result) || !Array.isArray(result.groups) || result.groups.length !== 1 || !object(result.groups[0])) fail('RESPONSE_INVALID', 502);
    const group = result.groups[0];
    if (!Number.isSafeInteger(group.id) || String(group.id) !== row.groupId) fail('GROUP_MISMATCH', 502);
    if (group.has_photo !== undefined && ![0, 1].includes(group.has_photo)) fail('RESPONSE_INVALID', 502);
    const before = { hasPhoto: group.has_photo === undefined ? null : group.has_photo === 1,
      photo200: photoUrl(group.photo_200), photoMax: photoUrl(group.photo_max), photoMaxOrig: photoUrl(group.photo_max_orig) };
    const previewId = crypto.randomUUID(), createdAt = stamp(), expiresAt = new Date(now() + TTL_MS).toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      guard(row); purge(row.companyCode); quota(row.companyCode);
      db.prepare(`INSERT INTO vk_avatar_previews(company_code,preview_id,group_id,revision,before_json,after_json,source_hash,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(row.companyCode, previewId, row.groupId, row.revision, JSON.stringify(before), JSON.stringify(after), after.sourceHash, createdAt, expiresAt);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return previewDto(previewFor(row.companyCode, previewId));
  }

  function apply(code, body) {
    strict(body, ['revision', 'previewId', 'requestId', 'confirmPublicPost']);
    if (!Number.isSafeInteger(body.revision) || body.revision < 1 || !key(body.previewId) || !key(body.requestId) || body.confirmPublicPost !== true) fail('INVALID_INPUT');
    const row = connection(code, body.revision), p = previewFor(row.companyCode, body.previewId);
    if (!p) fail('PREVIEW_NOT_FOUND', 404);
    if (p.group_id !== row.groupId || p.revision !== row.revision) fail('SETTINGS_CHANGED', 409);
    function previous() {
      const same = actionFor(row.companyCode, body.requestId);
      if (same && same.preview_id !== p.preview_id) fail('REQUEST_CONFLICT', 409);
      return same || db.prepare('SELECT * FROM vk_avatar_actions WHERE company_code=? AND preview_id=?').get(row.companyCode, p.preview_id);
    }
    const existing = previous();
    if (existing) return actionDto(existing);
    if (now() >= Date.parse(p.expires_at)) fail('PREVIEW_EXPIRED', 409);
    db.exec('BEGIN IMMEDIATE');
    try {
      guard(row);
      const same = previous();
      if (same) { db.exec('COMMIT'); return actionDto(same); }
      const completed = stamp();
      db.prepare(`INSERT INTO vk_avatar_actions(company_code,request_id,preview_id,group_id,revision,status,error_code,created_at,completed_at)
        VALUES(?,?,?,?,?,'blocked','AVATAR_APPLY_DISABLED',?,?)`).run(row.companyCode, body.requestId, p.preview_id, row.groupId, row.revision, completed, completed);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return actionDto(actionFor(row.companyCode, body.requestId));
  }

  function history(code, options = {}) {
    strict(options, ['revision']);
    if (options.revision !== undefined && (!Number.isSafeInteger(options.revision) || options.revision < 1)) fail('INVALID_INPUT');
    const row = connection(code, options.revision);
    return { ...row, capabilities: getCapabilities(), items: db.prepare(`SELECT * FROM vk_avatar_actions
      WHERE company_code=? AND group_id=? AND revision=? ORDER BY created_at DESC,rowid DESC LIMIT 100`).all(row.companyCode, row.groupId, row.revision).map(actionDto) };
  }
  return { preview, apply, history, getCapabilities };
}

module.exports = { createVkAvatar, VK_AVATAR_ERRORS };
