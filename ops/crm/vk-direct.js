'use strict';

// Internal transport only: callers must enforce owner/company authorization.
// Independent rows deliberately never read or change autoposting_channels.
const crypto = require('node:crypto');
const MAX_BYTES = 2 * 1024 * 1024;
const METHODS = Object.freeze({
  analytics: Object.freeze(['groups.getById', 'stats.get']),
  design: Object.freeze(['groups.getById', 'groups.edit', 'photos.getOwnerCoverPhotoUploadServer', 'photos.saveOwnerCoverPhoto']),
});
const MUTATIONS = new Set(['groups.edit', 'photos.saveOwnerCoverPhoto']);
const PARAMETERS = Object.freeze({
  'groups.getById': ['group_id', 'fields'],
  'stats.get': ['group_id', 'timestamp_from', 'timestamp_to', 'interval', 'stats_groups'],
  'groups.edit': ['group_id', 'description'],
  'photos.getOwnerCoverPhotoUploadServer': ['group_id', 'crop_x', 'crop_y', 'crop_x2', 'crop_y2', 'is_video_cover'],
  'photos.saveOwnerCoverPhoto': ['hash', 'photo', 'is_video_cover'],
});
const ERRORS = Object.freeze({
  VALIDATION_ERROR: 'Проверьте параметры подключения ВКонтакте',
  COMPANY_NOT_FOUND: 'Компания не найдена',
  CONNECTION_MISSING: 'Сохраните и проверьте отдельное подключение ВКонтакте',
  CONNECTION_DISABLED: 'Подключение ВКонтакте выключено',
  SETTINGS_CHANGED: 'Подключение изменилось. Обновите страницу',
  TOKEN_UNREADABLE: 'Сохранённый ключ не читается. Сохраните его заново',
  TOKEN_TYPE_MISMATCH: 'Тип ключа не подтверждён',
  GROUP_MISMATCH: 'Ответ относится к другому сообществу',
  METHOD_DENIED: 'Метод не разрешён для этого подключения',
  ACCESS_DENIED: 'ВКонтакте отклонил доступ',
  PLATFORM_REJECTED: 'ВКонтакте отклонил запрос',
  RESPONSE_INVALID: 'Ответ ВКонтакте не подтверждён',
  CONNECTION_UNCERTAIN: 'Результат запроса ВКонтакте неизвестен',
});
const failure = (code, uncertain = false) => Object.assign(new Error(ERRORS[code] || ERRORS.PLATFORM_REJECTED), {
  code, status: code === 'SETTINGS_CHANGED' ? 409 : code === 'COMPANY_NOT_FOUND' ? 404
    : ['VALIDATION_ERROR', 'METHOD_DENIED', 'CONNECTION_MISSING', 'CONNECTION_DISABLED'].includes(code) ? 400 : 502,
  uncertain, ambiguous: uncertain,
});
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const groupId = x => typeof x === 'string' && /^[1-9]\d{0,14}$/.test(x) && Number.isSafeInteger(Number(x));
const purposeOf = p => { if (!Object.hasOwn(METHODS, p)) throw failure('VALIDATION_ERROR'); return p; };

function createVkDirect(db, { apiKey, fetchImpl = fetch, now = Date.now, timeoutMs = 15000 } = {}) {
  if (!apiKey) throw new Error('Ключ хранения настроек отсутствует');
  db.exec(`CREATE TABLE IF NOT EXISTS vk_direct_connections (
    company_code TEXT NOT NULL COLLATE NOCASE REFERENCES companies(code), purpose TEXT NOT NULL,
    group_id TEXT NOT NULL, token_type TEXT NOT NULL, encrypted_token TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL, checked_revision INTEGER,
    status TEXT NOT NULL, checked_at TEXT, error_code TEXT, updated_at TEXT NOT NULL,
    PRIMARY KEY(company_code,purpose)
  )`);
  const stamp = () => new Date(now()).toISOString();
  const company = code => {
    if (typeof code !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code)) throw failure('VALIDATION_ERROR');
    const row = db.prepare('SELECT code FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get(code);
    if (!row) throw failure('COMPANY_NOT_FOUND');
    return row.code.toLowerCase();
  };
  const rowFor = (code, purpose) => db.prepare('SELECT * FROM vk_direct_connections WHERE company_code=? COLLATE NOCASE AND purpose=?').get(code, purpose);
  function crypt(row, value, decrypt = false) {
    const aad = Buffer.from(`synapse/vk-direct/v1/${row.company_code}/${row.purpose}/${row.group_id}/${row.token_type}`);
    const envelope = decrypt ? JSON.parse(value) : { v: 1, salt: crypto.randomBytes(16).toString('base64'), iv: crypto.randomBytes(12).toString('base64') };
    if (envelope.v !== 1) throw new Error('Invalid envelope');
    const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(apiKey), Buffer.from(envelope.salt, 'base64'), aad, 32));
    try {
      const cipher = decrypt ? crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64')) : crypto.createCipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      cipher.setAAD(aad);
      if (decrypt) {
        cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        return Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()]).toString('utf8');
      }
      envelope.data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64');
      envelope.tag = cipher.getAuthTag().toString('base64');
      return JSON.stringify(envelope);
    } finally { key.fill(0); }
  }
  const tokenFor = row => { try { return crypt(row, row.encrypted_token, true); } catch { throw failure('TOKEN_UNREADABLE'); } };
  function getSettings(code, purpose) {
    const current = company(code), p = purposeOf(purpose), row = rowFor(current, p);
    const connected = Boolean(row?.enabled && row.status === 'connected' && row.checked_revision === row.revision);
    return { companyCode: current, purpose: p, groupId: row?.group_id || '', tokenType: row?.token_type || '',
      revision: row?.revision || 0, checkedRevision: row?.checked_revision ?? null,
      configured: Boolean(row), tokenConfigured: Boolean(row?.encrypted_token), enabled: Boolean(row?.enabled), connected,
      status: row?.status || 'not_configured', checkedAt: row?.checked_at || null, errorCode: row?.error_code || null,
      group: connected ? { id: row.group_id } : null,
      capabilities: { statistics: p === 'analytics' && connected, communityInfo: connected, design: p === 'design' && connected,
        editingRightsVerified: false, messages: false, publishing: false },
    };
  }
  function saveSettings(code, purpose, body) {
    const current = company(code), p = purposeOf(purpose);
    if (!object(body) || Object.keys(body).some(k => !['revision', 'groupId', 'tokenType', 'accessToken', 'enabled'].includes(k))
      || !Number.isSafeInteger(body.revision) || body.revision < 0 || !groupId(body.groupId)
      || !['user', 'group'].includes(body.tokenType) || (p === 'analytics' && body.tokenType !== 'user')
      || (body.enabled !== undefined && typeof body.enabled !== 'boolean')
      || (body.accessToken !== undefined && (typeof body.accessToken !== 'string' || body.accessToken.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(body.accessToken)))) throw failure('VALIDATION_ERROR');
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = rowFor(current, p);
      if (body.revision !== (previous?.revision || 0)) throw failure('SETTINGS_CHANGED');
      const sameBinding = previous && previous.group_id === body.groupId && previous.token_type === body.tokenType;
      const token = body.accessToken || (sameBinding ? tokenFor(previous) : '');
      if (!token) throw failure('VALIDATION_ERROR');
      const enabled = body.enabled === undefined ? (previous ? previous.enabled : 1) : Number(body.enabled);
      const binding = { company_code: current, purpose: p, group_id: body.groupId, token_type: body.tokenType };
      db.prepare(`INSERT INTO vk_direct_connections(company_code,purpose,group_id,token_type,encrypted_token,enabled,revision,status,updated_at)
        VALUES(?,?,?,?,?,?,1,?,?) ON CONFLICT(company_code,purpose) DO UPDATE SET
        group_id=excluded.group_id,token_type=excluded.token_type,encrypted_token=excluded.encrypted_token,enabled=excluded.enabled,
        revision=vk_direct_connections.revision+1,checked_revision=NULL,status=excluded.status,checked_at=NULL,error_code=NULL,updated_at=excluded.updated_at`)
        .run(current, p, body.groupId, body.tokenType, crypt(binding, token), enabled, enabled ? 'needs_check' : 'disabled', stamp());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return getSettings(current, p);
  }
  function guard(row, checked = false) {
    company(row.company_code);
    const fresh = rowFor(row.company_code, row.purpose);
    if (!fresh || fresh.revision !== row.revision || fresh.group_id !== row.group_id || fresh.token_type !== row.token_type) throw failure('SETTINGS_CHANGED');
    if (!fresh.enabled) throw failure('CONNECTION_DISABLED');
    if (checked && (fresh.checked_revision !== fresh.revision || fresh.status !== 'connected')) throw failure('CONNECTION_MISSING');
  }
  async function call(row, method, params = {}, mutation = false) {
    guard(row);
    const token = tokenFor(row), controller = new AbortController();
    let timer, reader;
    const aborted = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure('CONNECTION_UNCERTAIN', mutation)); }, timeoutMs); });
    try {
      const response = await Promise.race([fetchImpl(`https://api.vk.com/method/${method}`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${token}` },
        body: new URLSearchParams({ ...params, v: '5.199' }).toString(),
      }), aborted]);
      reader = response.body?.getReader?.();
      if (!reader) throw failure('RESPONSE_INVALID', mutation);
      const chunks = []; let size = 0;
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw failure('RESPONSE_INVALID', mutation);
        chunks.push(Buffer.from(value));
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch { throw failure('RESPONSE_INVALID', mutation); }
      // A server failure can arrive AFTER a mutation took effect. An error-shaped
      // body is not proof that the action was rejected; only explicit known
      // access/validation/rate errors on a non-5xx reply are definite failures.
      if (response.status >= 500) throw failure('CONNECTION_UNCERTAIN', mutation);
      if (Object.hasOwn(data || {}, 'error')) {
        const providerCode = object(data.error) ? data.error.error_code : null;
        if (!Number.isSafeInteger(providerCode)) throw failure('CONNECTION_UNCERTAIN', mutation);
        if ([5,7,15,27,28,200,203].includes(providerCode)) throw failure('ACCESS_DENIED');
        if ([6,100].includes(providerCode)) throw failure('PLATFORM_REJECTED');
        throw failure('CONNECTION_UNCERTAIN', mutation);
      }
      if (!response.ok) throw failure('CONNECTION_UNCERTAIN', mutation);
      if (!object(data) || !Object.hasOwn(data, 'response')) throw failure('RESPONSE_INVALID', mutation);
      // A dispatched mutation may already be accepted. The design journal records
      // that receipt before checking its preview revision; never discard acceptance.
      if (!mutation) guard(row);
      return data.response;
    } catch (error) {
      if (error?.code && Object.hasOwn(ERRORS, error.code)) throw error;
      throw failure('CONNECTION_UNCERTAIN', mutation);
    } finally { clearTimeout(timer); if (reader) reader.cancel().catch(() => {}); }
  }
  const exactGroup = (result, id) => {
    const groups = Array.isArray(result?.groups) ? result.groups : Array.isArray(result) ? result : null;
    if (!groups || groups.length !== 1 || !Number.isSafeInteger(groups[0]?.id) || String(groups[0].id) !== id) throw failure('GROUP_MISMATCH');
    return groups[0];
  };
  async function checkConnection(code, purpose) {
    const current = company(code), p = purposeOf(purpose), row = rowFor(current, p);
    if (!row) throw failure('CONNECTION_MISSING');
    guard(row);
    let errorCode = null;
    try {
      if (row.token_type === 'user') {
        // users.get also accepts group/service tokens; this method is user-only.
        // Inspect the numeric identity only; never persist personal profile fields.
        const profile = await call(row, 'account.getProfileInfo');
        if (!object(profile) || !Number.isSafeInteger(profile.id) || profile.id <= 0) throw failure('TOKEN_TYPE_MISMATCH');
      } else {
        const permission = await call(row, 'groups.getTokenPermissions');
        if (!object(permission) || !Number.isSafeInteger(permission.mask) || permission.mask < 0 || !Array.isArray(permission.permissions)) throw failure('TOKEN_TYPE_MISMATCH');
      }
      exactGroup(await call(row, 'groups.getById', { group_id: row.group_id, fields: 'members_count' }), row.group_id);
      if (p === 'analytics') {
        if (row.token_type !== 'user') throw failure('TOKEN_TYPE_MISMATCH');
        const result = await call(row, 'stats.get', { group_id: row.group_id,
          timestamp_from: Math.floor(now() / 1000) - 86400, timestamp_to: Math.floor(now() / 1000), interval: 'day', stats_groups: 'visitors,reach,activity' });
        if (!Array.isArray(result)) throw failure('RESPONSE_INVALID');
      }
      guard(row);
    } catch (error) { errorCode = Object.hasOwn(ERRORS, error?.code) ? error.code : 'CONNECTION_UNCERTAIN'; }
    const changed = db.prepare(`UPDATE vk_direct_connections SET checked_revision=?,status=?,checked_at=?,error_code=?
      WHERE company_code=? COLLATE NOCASE AND purpose=? AND revision=?`)
      .run(errorCode ? null : row.revision, errorCode ? 'failed' : 'connected', stamp(), errorCode, current, p, row.revision).changes;
    return { ...getSettings(current, p), ok: Boolean(changed && !errorCode), code: changed ? errorCode : 'SETTINGS_CHANGED' };
  }
  function connectionRevision(code, purpose) {
    const s = getSettings(code, purpose);
    return { provider: 'vk_direct', purpose: s.purpose, revision: s.revision, target: s.groupId, tokenType: s.tokenType,
      enabled: s.enabled, checkedRevision: s.checkedRevision, connected: s.connected };
  }
  async function request(code, purpose, revision, method, params = {}) {
    const current = company(code), p = purposeOf(purpose), row = rowFor(current, p);
    if (!METHODS[p].includes(method)) throw failure('METHOD_DENIED');
    if (!row) throw failure('CONNECTION_MISSING');
    if (revision !== row.revision) throw failure('SETTINGS_CHANGED');
    guard(row, true);
    if (!object(params) || Object.keys(params).some(k => !PARAMETERS[method].includes(k))
      || Object.values(params).some(v => typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v)))
      || (params.is_video_cover !== undefined && params.is_video_cover !== 0 && params.is_video_cover !== '0')
      || (method === 'groups.edit' && typeof params.description !== 'string')) throw failure('VALIDATION_ERROR');
    const bounded = { ...params };
    if (method === 'photos.saveOwnerCoverPhoto') {
      if (Object.hasOwn(params, 'group_id')) throw failure('VALIDATION_ERROR');
    } else {
      if (Object.hasOwn(params, 'group_id') && String(params.group_id) !== row.group_id) throw failure('GROUP_MISMATCH');
      bounded.group_id = row.group_id;
    }
    const result = await call(row, method, bounded, MUTATIONS.has(method));
    if (method === 'groups.getById') exactGroup(result, row.group_id);
    return result;
  }
  return { getSettings, saveSettings, checkConnection, connectionRevision, request };
}
module.exports = { createVkDirect, VK_DIRECT_ERRORS: ERRORS };
