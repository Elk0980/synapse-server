'use strict';
// spec092-vk-events: incoming VK community events (Callback API + Bots Long Poll) into one
// isolated, durable, de-duplicated journal per company/group. Read-only towards VK:
// no messages, posts, payments or permission changes are ever sent from this module.

const crypto = require('node:crypto');

const API_VERSION = '5.199';
const CALLBACK_MAX_BYTES = 256 * 1024;
const LP_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const API_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const LP_MAX_UPDATES = 1000;
const JOURNAL_LIMIT = 10000;
const TRANSPORT = Object.freeze({callback: 1, longpoll: 2});
// Official LP server hosts. groups_long_poll_server.server is only "format: uri" in the schema;
// any other host fails closed (UNKNOWN until documented) instead of becoming an SSRF target.
const LP_HOSTS = new Set(['lp.vk.com', 'lp.vk.ru']);

// Event catalog checked 06.10.2026: docs = dev.vk.ru/ru/api/community-events/json-schema,
// lp = VKCOM vk-api-schema groups/objects.json#groups_long_poll_events (v5.199).
const DOCS_EVENTS = {
  messages: ['message_new', 'message_reply', 'message_edit', 'message_allow', 'message_deny', 'message_typing_state', 'message_read', 'message_event'],
  photos: ['photo_new', 'photo_comment_new', 'photo_comment_edit', 'photo_comment_restore', 'photo_comment_delete'],
  audio: ['audio_new'],
  video: ['video_new', 'video_comment_new', 'video_comment_edit', 'video_comment_restore', 'video_comment_delete'],
  wall: ['wall_post_new', 'wall_repost', 'wall_schedule_post_new', 'wall_schedule_post_delete'],
  wall_comments: ['wall_reply_new', 'wall_reply_edit', 'wall_reply_restore', 'wall_reply_delete'],
  likes: ['like_add', 'like_remove'],
  board: ['board_post_new', 'board_post_edit', 'board_post_restore', 'board_post_delete'],
  market: ['market_comment_new', 'market_comment_edit', 'market_comment_restore', 'market_comment_delete', 'market_order_new', 'market_order_edit'],
  users: ['group_leave', 'group_join', 'user_block', 'user_unblock'],
  other: ['poll_vote_new', 'group_officers_edit', 'group_change_settings', 'group_change_photo', 'vkpay_transaction', 'app_payload'],
  donut: ['donut_subscription_create', 'donut_subscription_prolonged', 'donut_subscription_expired', 'donut_subscription_cancelled',
    'donut_subscription_price_changed', 'donut_money_withdraw', 'donut_money_withdraw_error'],
};
const LP_SCHEMA_EVENTS = new Set(['audio_new', 'board_post_delete', 'board_post_edit', 'board_post_new', 'board_post_restore', 'group_change_photo',
  'group_change_settings', 'group_join', 'group_leave', 'group_officers_edit', 'market_comment_delete', 'market_comment_edit', 'market_comment_new',
  'market_comment_restore', 'message_allow', 'message_deny', 'message_new', 'message_read', 'message_reply', 'message_typing_state', 'message_edit',
  'photo_comment_delete', 'photo_comment_edit', 'photo_comment_new', 'photo_comment_restore', 'photo_new', 'poll_vote_new', 'user_block', 'user_unblock',
  'video_comment_delete', 'video_comment_edit', 'video_comment_new', 'video_comment_restore', 'video_new', 'message_reaction_event', 'wall_post_new',
  'wall_reply_delete', 'wall_reply_edit', 'wall_reply_new', 'wall_reply_restore', 'wall_repost', 'wall_schedule_post_new', 'wall_schedule_post_delete',
  'donut_subscription_create', 'donut_subscription_prolonged', 'donut_subscription_cancelled', 'donut_subscription_expired',
  'donut_subscription_price_changed', 'donut_money_withdraw', 'donut_money_withdraw_error']);
const SECTION = new Map(Object.entries(DOCS_EVENTS).flatMap(([section, types]) => types.map(type => [type, section])));
for (const type of LP_SCHEMA_EVENTS) if (!SECTION.has(type)) SECTION.set(type, 'lp_schema_only');

const VK_EVENTS_ERRORS = Object.freeze({
  INVALID_SETTINGS: 'Проверьте ID сообщества и параметры событий ВК',
  SECRET_REQUIRED: 'Для Callback API введите секретный ключ и строку подтверждения',
  TOKEN_REQUIRED: 'Для Long Poll введите ключ доступа сообщества',
  SETTINGS_CHANGED: 'Настройки событий изменились. Обновите раздел',
  NOT_CONFIGURED: 'Сначала сохраните настройки событий ВК',
  TOKEN_UNREADABLE: 'Не удалось прочитать сохранённый ключ. Введите его заново',
  NOT_CHECKED: 'Сначала проверьте доступ для Long Poll',
  LONGPOLL_DISABLED_IN_VK: 'Long Poll API выключен в настройках сообщества ВК',
  LONGPOLL_NOT_ENABLED: 'Long Poll выключен в настройках Synapse',
  LEASE_HELD: 'Long Poll этого сообщества уже обрабатывает другой процесс',
  ACCESS_DENIED: 'ВКонтакте не предоставил доступ. Проверьте ключ сообщества и его права',
  GROUP_MISMATCH: 'Ответ ВКонтакте не соответствует выбранному сообществу',
  RESPONSE_INVALID: 'ВКонтакте вернул неожиданный ответ',
  CONNECTION_UNCERTAIN: 'Не удалось получить ответ ВКонтакте',
  LP_SERVER_UNTRUSTED: 'Адрес Long Poll сервера не входит в официальный список',
  INVALID_REQUEST: 'Проверьте параметры запроса',
});

const fail = (code, status = 400) => { throw Object.assign(new Error(VK_EVENTS_ERRORS[code] || code), {code, status}); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => integer(value) && value > 0;
const strictKeys = (value, keys) => { if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) fail('INVALID_SETTINGS'); };
const plain = (value, max = 300) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '';
const EVENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const ENDPOINT_ID = /^[A-Za-z0-9_-]{32}$/;
const TS = /^\d{1,20}$/;
const transportsOf = mask => Object.entries(TRANSPORT).filter(([, bit]) => mask & bit).map(([name]) => name);

function lpServerUrl(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (url.protocol !== 'https:' || !LP_HOSTS.has(url.hostname) || url.port || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}
function tsValue(value) {
  const text = typeof value === 'number' && integer(value) ? String(value) : value;
  return typeof text === 'string' && TS.test(text) ? text : null;
}
const defaultSleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, {once: true});
});

function createVkEvents(db, {apiKey, fetchImpl = fetch, now = Date.now, timeoutMs = 15000, wait = 25, leaseMs = 120000,
  sleep = defaultSleep, randomBytes = crypto.randomBytes, onError = () => {}} = {}) {
  if (!apiKey) throw new Error('Ключ хранения настроек отсутствует');
  if (!integer(wait) || wait < 1 || wait > 90) throw new Error('wait must be 1..90 seconds (official maximum 90)');
  db.exec(`CREATE TABLE IF NOT EXISTS vk_events_bindings (
    company_code TEXT PRIMARY KEY COLLATE NOCASE REFERENCES companies(code), group_id TEXT NOT NULL, revision INTEGER NOT NULL,
    endpoint_id TEXT NOT NULL UNIQUE,
    callback_enabled INTEGER NOT NULL DEFAULT 0, encrypted_secret TEXT, encrypted_confirmation TEXT,
    callback_confirmed_at TEXT, callback_last_event_at TEXT, callback_rejected INTEGER NOT NULL DEFAULT 0, callback_reject_code TEXT, callback_reject_at TEXT,
    longpoll_enabled INTEGER NOT NULL DEFAULT 0, encrypted_token TEXT,
    checked_revision INTEGER, check_status TEXT NOT NULL DEFAULT 'needs_check', check_error TEXT, checked_at TEXT, group_name TEXT,
    lp_vk_enabled INTEGER, lp_api_version TEXT, lp_events TEXT,
    lp_status TEXT NOT NULL DEFAULT 'stopped', lp_error TEXT, lp_last_event_at TEXT, lp_gap_at TEXT, lp_gaps INTEGER NOT NULL DEFAULT 0,
    lp_invalid INTEGER NOT NULL DEFAULT 0, lp_ts TEXT, lp_lease_id TEXT, lp_lease_until INTEGER, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS vk_events_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL COLLATE NOCASE REFERENCES companies(code),
    group_id TEXT NOT NULL, revision INTEGER NOT NULL, event_id TEXT NOT NULL, type TEXT NOT NULL, known INTEGER NOT NULL,
    api_version TEXT, transports INTEGER NOT NULL, first_transport TEXT NOT NULL, received_at TEXT NOT NULL,
    duplicate_count INTEGER NOT NULL DEFAULT 0, encrypted_payload TEXT NOT NULL,
    UNIQUE(company_code, group_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS vk_events_journal_company ON vk_events_journal(company_code, group_id, id);
  CREATE TABLE IF NOT EXISTS vk_events_lp_leases (
    group_id TEXT PRIMARY KEY, company_code TEXT NOT NULL COLLATE NOCASE, lease_id TEXT NOT NULL, lease_until INTEGER NOT NULL
  )`);
  // Owner's explicit wish to run Long Poll, separate from "configured/enabled": stop survives restarts.
  if (!db.prepare('PRAGMA table_info(vk_events_bindings)').all().some(column => column.name === 'lp_desired'))
    db.exec('ALTER TABLE vk_events_bindings ADD COLUMN lp_desired INTEGER NOT NULL DEFAULT 0');
  const stamp = () => new Date(now()).toISOString();
  const sessions = new Map();

  function company(code) {
    if (typeof code !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code)) throw Object.assign(new Error('Выберите компанию'), {status: 400});
    const row = db.prepare('SELECT code FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get(code);
    if (!row) throw Object.assign(new Error('Компания не найдена'), {status: 404});
    return row.code;
  }
  const rowFor = code => db.prepare('SELECT * FROM vk_events_bindings WHERE company_code=?').get(code);
  function crypt(code, groupId, field, value, decrypt = false) {
    const aad = Buffer.from(`synapse/vk-events/v1/${code.toLowerCase()}/${groupId}/${field}`);
    const envelope = decrypt ? JSON.parse(value) : {v: 1, salt: randomBytes(16).toString('base64'), iv: randomBytes(12).toString('base64')};
    if (envelope.v !== 1) throw new Error('Invalid envelope');
    const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(apiKey), Buffer.from(envelope.salt, 'base64'), aad, 32));
    try {
      const cipher = decrypt ? crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
        : crypto.createCipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
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
  const readable = (row, field, column) => {
    if (!row?.[column]) return null;
    try { return crypt(row.company_code, row.group_id, field, row[column], true); } catch { return null; }
  };
  const endpointId = () => randomBytes(24).toString('base64url');

  function settingsDto(code) {
    const row = rowFor(code);
    const secret = Boolean(readable(row, 'secret', 'encrypted_secret')), confirmation = Boolean(readable(row, 'confirmation', 'encrypted_confirmation'));
    const token = Boolean(readable(row, 'token', 'encrypted_token'));
    const checked = Boolean(row && token && row.check_status === 'connected' && row.checked_revision === row.revision);
    const lpEvents = (() => { try { const value = JSON.parse(row?.lp_events || '[]'); return Array.isArray(value) ? value.filter(t => EVENT_TYPE.test(t)) : []; } catch { return []; } })();
    const unknownSeen = row ? db.prepare('SELECT DISTINCT type FROM vk_events_journal WHERE company_code=? AND group_id=? AND known=0 ORDER BY type LIMIT 50')
      .all(code, row.group_id).map(item => item.type) : [];
    const running = sessions.has(code);
    return {
      companyCode: code, groupId: row?.group_id || '', revision: row?.revision || 0, configured: Boolean(row),
      group: row?.group_name ? {id: row.group_id, name: row.group_name} : null,
      callback: {enabled: Boolean(row?.callback_enabled), secretConfigured: secret, confirmationConfigured: confirmation,
        endpointPath: row ? `/public-vk-callback/${row.endpoint_id}` : null,
        confirmedAt: row?.callback_confirmed_at || null, lastEventAt: row?.callback_last_event_at || null,
        rejected: row?.callback_rejected || 0, lastRejectCode: row?.callback_reject_code || null, lastRejectAt: row?.callback_reject_at || null},
      longPoll: {enabled: Boolean(row?.longpoll_enabled), tokenConfigured: token, checked, checkStatus: row?.check_status || 'not_configured',
        checkError: row?.check_error || null, checkedAt: row?.checked_at || null, running, desired: Boolean(row?.lp_desired),
        status: running ? (row?.lp_status || 'starting') : (row?.lp_status === 'error' ? 'error' : 'stopped'), error: row?.lp_error || null,
        vkEnabled: row?.lp_vk_enabled === null || row?.lp_vk_enabled === undefined ? null : Boolean(row.lp_vk_enabled),
        apiVersion: row?.lp_api_version || null, apiVersionMatches: row?.lp_api_version ? row.lp_api_version === API_VERSION : null,
        vkEnabledEvents: lpEvents, lastEventAt: row?.lp_last_event_at || null, gaps: row?.lp_gaps || 0, lastGapAt: row?.lp_gap_at || null,
        invalidUpdates: row?.lp_invalid || 0, cursorSaved: Boolean(row?.lp_ts)},
      events: {documented: Object.entries(DOCS_EVENTS).map(([section, types]) => ({section, types: types.map(type => ({type, longPollSetting: LP_SCHEMA_EVENTS.has(type)}))})),
        longPollSchemaOnly: [...LP_SCHEMA_EVENTS].filter(type => SECTION.get(type) === 'lp_schema_only'), unknownSeen},
      // Receiving events proves nothing about market editing, statistics, design or sending.
      capabilities: {callbackEvents: Boolean(row?.callback_enabled && secret && confirmation && row.callback_confirmed_at),
        longPollEvents: running && row?.lp_status === 'listening', market: false, statistics: false, design: false, outgoing: false},
    };
  }
  function getSettings(code) { return settingsDto(company(code)); }

  function saveSettings(code, body) {
    const companyCode = company(code);
    strictKeys(body, ['revision', 'groupId', 'callback', 'longPoll']);
    if (!integer(body.revision) || typeof body.groupId !== 'string' || !/^[1-9]\d{0,14}$/.test(body.groupId) || !Number.isSafeInteger(Number(body.groupId))) fail('INVALID_SETTINGS');
    const callback = body.callback ?? {enabled: false}, longPoll = body.longPoll ?? {enabled: false};
    strictKeys(callback, ['enabled', 'secret', 'confirmationCode']); strictKeys(longPoll, ['enabled', 'communityToken']);
    if (typeof callback.enabled !== 'boolean' || typeof longPoll.enabled !== 'boolean') fail('INVALID_SETTINGS');
    const secretOk = value => value === undefined || value === '' || (typeof value === 'string' && /^[\x21-\x7e]{1,100}$/.test(value));
    if (!secretOk(callback.secret) || !(callback.confirmationCode === undefined || callback.confirmationCode === '' || /^[A-Za-z0-9]{4,64}$/.test(callback.confirmationCode))
      || !(longPoll.communityToken === undefined || longPoll.communityToken === '' || (typeof longPoll.communityToken === 'string' && /^[\x21-\x7e]{1,2048}$/.test(longPoll.communityToken)))) fail('INVALID_SETTINGS');
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = rowFor(companyCode);
      if (body.revision !== (previous?.revision || 0)) fail('SETTINGS_CHANGED', 409);
      const sameGroup = previous?.group_id === body.groupId;
      // Blank fields keep a stored secret only for the same community; a new community needs its own secrets.
      const keep = (value, field, column) => value || (sameGroup ? readable(previous, field, column) : null);
      const secret = keep(callback.secret, 'secret', 'encrypted_secret'), confirmation = keep(callback.confirmationCode, 'confirmation', 'encrypted_confirmation');
      const token = keep(longPoll.communityToken, 'token', 'encrypted_token');
      if (callback.enabled && (!secret || !confirmation)) fail('SECRET_REQUIRED');
      if (longPoll.enabled && !token) fail('TOKEN_REQUIRED');
      const enc = (field, value) => value ? crypt(companyCode, body.groupId, field, value) : null;
      const revision = (previous?.revision || 0) + 1;
      const confirmationChanged = !sameGroup || Boolean(callback.confirmationCode) || Boolean(callback.secret);
      db.prepare(`INSERT INTO vk_events_bindings(company_code,group_id,revision,endpoint_id,callback_enabled,encrypted_secret,encrypted_confirmation,
          longpoll_enabled,encrypted_token,check_status,lp_status,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'needs_check','stopped',?)
        ON CONFLICT(company_code) DO UPDATE SET group_id=excluded.group_id,revision=excluded.revision,
          endpoint_id=CASE WHEN vk_events_bindings.group_id=excluded.group_id THEN vk_events_bindings.endpoint_id ELSE excluded.endpoint_id END,
          callback_enabled=excluded.callback_enabled,encrypted_secret=excluded.encrypted_secret,encrypted_confirmation=excluded.encrypted_confirmation,
          longpoll_enabled=excluded.longpoll_enabled,encrypted_token=excluded.encrypted_token,checked_revision=NULL,check_status='needs_check',
          check_error=NULL,checked_at=NULL,lp_status='stopped',lp_error=NULL,lp_lease_id=NULL,lp_lease_until=NULL,lp_desired=0,updated_at=excluded.updated_at`)
        .run(companyCode, body.groupId, revision, endpointId(), callback.enabled ? 1 : 0, enc('secret', secret), enc('confirmation', confirmation),
          longPoll.enabled ? 1 : 0, enc('token', token), stamp());
      if (!sameGroup) db.prepare(`UPDATE vk_events_bindings SET group_name=NULL,lp_vk_enabled=NULL,lp_api_version=NULL,lp_events=NULL,lp_ts=NULL,
        lp_gaps=0,lp_gap_at=NULL,lp_invalid=0,lp_last_event_at=NULL,callback_last_event_at=NULL,callback_rejected=0,callback_reject_code=NULL,callback_reject_at=NULL WHERE company_code=?`).run(companyCode);
      if (confirmationChanged) db.prepare('UPDATE vk_events_bindings SET callback_confirmed_at=NULL WHERE company_code=?').run(companyCode);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    stopSession(companyCode);
    return settingsDto(companyCode);
  }

  // ---------------------------------------------------------------- VK API (read-only)
  async function readLimited(response, signal, limit) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No body');
    const chunks = []; let size = 0, abort;
    const aborted = new Promise((resolve, reject) => { abort = () => reject(new Error('Aborted')); if (signal.aborted) abort(); else signal.addEventListener('abort', abort, {once: true}); });
    try {
      while (true) {
        const {done, value} = await Promise.race([reader.read(), aborted]);
        if (done) break;
        size += value.byteLength; if (size > limit) throw new Error('Too large'); chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    } finally { signal.removeEventListener('abort', abort); reader.cancel().catch(() => {}); }
  }
  async function call(token, method, params, outerSignal) {
    const signal = outerSignal ? AbortSignal.any([outerSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    let response, data;
    try {
      response = await fetchImpl(`https://api.vk.com/method/${method}`, {method: 'POST', redirect: 'error', signal,
        headers: {'content-type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${token}`},
        body: new URLSearchParams({...params, v: API_VERSION}).toString()});
      data = await readLimited(response, signal, API_RESPONSE_MAX_BYTES);
    } catch { fail('CONNECTION_UNCERTAIN', 502); }
    if (Object.hasOwn(object(data) ? data : {}, 'error')) {
      const providerCode = object(data.error) ? data.error.error_code : null;
      if ([5, 7, 15, 27, 28, 200, 203, 901, 902].includes(providerCode)) fail('ACCESS_DENIED', 502);
      fail('RESPONSE_INVALID', 502);
    }
    if (!response.ok || !object(data) || !Object.hasOwn(data, 'response')) fail('RESPONSE_INVALID', 502);
    return data.response;
  }
  function tokenFor(row) {
    const token = readable(row, 'token', 'encrypted_token');
    if (!token) fail(row?.encrypted_token ? 'TOKEN_UNREADABLE' : 'TOKEN_REQUIRED');
    return token;
  }

  async function checkConnection(code, {revision} = {}) {
    const companyCode = company(code), row = rowFor(companyCode);
    if (!row) fail('NOT_CONFIGURED');
    if (revision !== undefined && revision !== row.revision) fail('SETTINGS_CHANGED', 409);
    const token = tokenFor(row);
    let errorCode = null, groupName = null, lp = null;
    try {
      const permissions = await call(token, 'groups.getTokenPermissions', {});
      if (!object(permissions) || !integer(permissions.mask) || !Array.isArray(permissions.permissions)) fail('RESPONSE_INVALID', 502);
      const result = await call(token, 'groups.getById', {group_id: row.group_id});
      if (!object(result) || !Array.isArray(result.groups) || result.groups.length !== 1 || String(result.groups[0]?.id) !== row.group_id) fail('GROUP_MISMATCH', 502);
      groupName = plain(result.groups[0].name, 200) || null;
      const settings = await call(token, 'groups.getLongPollSettings', {group_id: row.group_id});
      if (!object(settings) || typeof settings.is_enabled !== 'boolean' || !object(settings.events)
        || (settings.api_version !== undefined && typeof settings.api_version !== 'string')) fail('RESPONSE_INVALID', 502);
      lp = {enabled: settings.is_enabled, apiVersion: settings.api_version ? plain(settings.api_version, 20) : null,
        events: Object.entries(settings.events).filter(([type, on]) => EVENT_TYPE.test(type) && (on === true || on === 1)).map(([type]) => type).sort()};
    } catch (error) { errorCode = Object.hasOwn(VK_EVENTS_ERRORS, error.code) ? error.code : 'RESPONSE_INVALID'; }
    const changed = db.prepare(`UPDATE vk_events_bindings SET check_status=?,checked_revision=?,check_error=?,checked_at=?,group_name=COALESCE(?,group_name),
      lp_vk_enabled=COALESCE(?,lp_vk_enabled),lp_api_version=COALESCE(?,lp_api_version),lp_events=COALESCE(?,lp_events) WHERE company_code=? AND revision=?`)
      .run(errorCode ? 'error' : 'connected', errorCode ? null : row.revision, errorCode, stamp(), groupName,
        lp ? (lp.enabled ? 1 : 0) : null, lp?.apiVersion ?? null, lp ? JSON.stringify(lp.events) : null, companyCode, row.revision).changes;
    return {...settingsDto(companyCode), ok: Boolean(changed && !errorCode), code: changed ? errorCode : 'SETTINGS_CHANGED'};
  }

  // ---------------------------------------------------------------- journal
  function ingest(row, update, transport) {
    const known = SECTION.has(update.type) ? 1 : 0;
    const payload = crypt(row.company_code, row.group_id, `event/${update.event_id}`,
      JSON.stringify({type: update.type, event_id: update.event_id, v: update.v ?? null, group_id: update.group_id, object: update.object ?? null}));
    const existing = db.prepare('SELECT transports FROM vk_events_journal WHERE company_code=? AND group_id=? AND event_id=?').get(row.company_code, row.group_id, update.event_id);
    if (existing) {
      db.prepare('UPDATE vk_events_journal SET transports=transports|?,duplicate_count=duplicate_count+1 WHERE company_code=? AND group_id=? AND event_id=?')
        .run(TRANSPORT[transport], row.company_code, row.group_id, update.event_id);
      return 'duplicate';
    }
    db.prepare(`INSERT INTO vk_events_journal(company_code,group_id,revision,event_id,type,known,api_version,transports,first_transport,received_at,encrypted_payload)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(row.company_code, row.group_id, row.revision, update.event_id, update.type, known,
      typeof update.v === 'string' ? plain(update.v, 20) : null, TRANSPORT[transport], transport, stamp(), payload);
    db.prepare(`DELETE FROM vk_events_journal WHERE company_code=? AND id <= (SELECT id FROM vk_events_journal WHERE company_code=? ORDER BY id DESC LIMIT 1 OFFSET ?)`)
      .run(row.company_code, row.company_code, JOURNAL_LIMIT);
    return 'inserted';
  }
  function validUpdate(row, update) {
    return object(update) && typeof update.type === 'string' && EVENT_TYPE.test(update.type) && typeof update.event_id === 'string'
      && EVENT_ID.test(update.event_id) && String(update.group_id) === row.group_id && positive(update.group_id);
  }
  function journal(code, {limit = 50, before} = {}) {
    const companyCode = company(code), row = rowFor(companyCode);
    if (!positive(limit) || limit > 100 || (before !== undefined && !positive(before))) fail('INVALID_REQUEST');
    if (!row) return {companyCode, revision: 0, groupId: '', items: []};
    const items = db.prepare(`SELECT id,event_id,type,known,api_version,transports,first_transport,received_at,duplicate_count,revision FROM vk_events_journal
      WHERE company_code=? AND group_id=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?`).all(companyCode, row.group_id, before ?? null, before ?? null, limit)
      .map(item => ({id: item.id, eventId: item.event_id, type: item.type, known: Boolean(item.known), section: SECTION.get(item.type) || 'unknown',
        apiVersion: item.api_version, transports: transportsOf(item.transports), firstTransport: item.first_transport, receivedAt: item.received_at,
        duplicates: item.duplicate_count, revision: item.revision}));
    return {companyCode, revision: row.revision, groupId: row.group_id, items};
  }

  // ---------------------------------------------------------------- Callback API
  function reject(row, codeName) {
    if (row) db.prepare('UPDATE vk_events_bindings SET callback_rejected=callback_rejected+1,callback_reject_code=?,callback_reject_at=? WHERE company_code=?')
      .run(codeName, stamp(), row.company_code);
    return {status: codeName === 'NOT_FOUND' ? 404 : codeName === 'MALFORMED' ? 400 : codeName === 'TOO_LARGE' ? 413 : 403, body: 'rejected'};
  }
  const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string'
    && crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());

  // Returns {status, body} for a plain-text HTTP response. 'ok' is returned only after the event is durably stored.
  function handleCallback(endpoint, raw) {
    if (typeof endpoint !== 'string' || !ENDPOINT_ID.test(endpoint)) return reject(null, 'NOT_FOUND');
    const row = db.prepare('SELECT * FROM vk_events_bindings WHERE endpoint_id=?').get(endpoint);
    if (!row || !row.callback_enabled || !db.prepare('SELECT 1 FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get(row.company_code)) return reject(null, 'NOT_FOUND');
    if (!Buffer.isBuffer(raw) || raw.length > CALLBACK_MAX_BYTES) return reject(row, 'TOO_LARGE');
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return reject(row, 'MALFORMED'); }
    if (!object(body) || typeof body.type !== 'string' || !EVENT_TYPE.test(body.type)) return reject(row, 'MALFORMED');
    if (!positive(body.group_id) || String(body.group_id) !== row.group_id) return reject(row, 'GROUP_MISMATCH');
    const secret = readable(row, 'secret', 'encrypted_secret'), confirmation = readable(row, 'confirmation', 'encrypted_confirmation');
    if (!secret || !confirmation) return reject(row, 'NOT_CONFIGURED');
    if (body.type === 'confirmation') {
      // UNKNOWN whether VK includes "secret" in the confirmation request; when present it must match.
      if (Object.hasOwn(body, 'secret') && !sameSecret(body.secret, secret)) return reject(row, 'SECRET_MISMATCH');
      db.prepare('UPDATE vk_events_bindings SET callback_confirmed_at=? WHERE company_code=? AND revision=?').run(stamp(), row.company_code, row.revision);
      return {status: 200, body: confirmation};
    }
    if (!sameSecret(body.secret, secret)) return reject(row, 'SECRET_MISMATCH');
    if (typeof body.event_id !== 'string' || !EVENT_ID.test(body.event_id)) return reject(row, 'MALFORMED');
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = rowFor(row.company_code);
        if (!current || current.revision !== row.revision || !current.callback_enabled) { db.exec('ROLLBACK'); return reject(null, 'NOT_FOUND'); }
        ingest(current, body, 'callback');
        db.prepare('UPDATE vk_events_bindings SET callback_last_event_at=? WHERE company_code=?').run(stamp(), row.company_code);
        db.exec('COMMIT');
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    } catch (error) {
      onError('callback_store_failed', error?.code || error?.message);
      return {status: 503, body: 'retry'};
    }
    return {status: 200, body: 'ok'};
  }

  // ---------------------------------------------------------------- Bots Long Poll
  function setStatus(code, leaseId, status, error = null) {
    db.prepare('UPDATE vk_events_bindings SET lp_status=?,lp_error=? WHERE company_code=? AND lp_lease_id=?').run(status, error, code, leaseId);
  }
  const LIVE_COMPANY = 'EXISTS (SELECT 1 FROM companies c WHERE c.code=vk_events_bindings.company_code COLLATE NOCASE AND c.is_deleted=0)';
  // Exclusivity is per VK group across companies and processes: one consumer per group_id (vk_events_lp_leases PK),
  // plus the binding row lease. Both are taken in one IMMEDIATE transaction, so two companies bound to the same
  // community cannot both poll it; each company still has its own journal.
  function acquire(code, groupId, leaseId) {
    const time = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      const held = db.prepare('SELECT lease_id,lease_until FROM vk_events_lp_leases WHERE group_id=?').get(groupId);
      const binding = db.prepare(`SELECT 1 FROM vk_events_bindings WHERE company_code=? AND group_id=? AND longpoll_enabled=1 AND lp_desired=1 AND ${LIVE_COMPANY}
        AND (lp_lease_id IS NULL OR lp_lease_until<? OR lp_lease_id=?)`).get(code, groupId, time, leaseId);
      if (!binding || (held && held.lease_until >= time && held.lease_id !== leaseId)) { db.exec('ROLLBACK'); return false; }
      db.prepare(`INSERT INTO vk_events_lp_leases(group_id,company_code,lease_id,lease_until) VALUES(?,?,?,?)
        ON CONFLICT(group_id) DO UPDATE SET company_code=excluded.company_code,lease_id=excluded.lease_id,lease_until=excluded.lease_until`).run(groupId, code, leaseId, time + leaseMs);
      db.prepare("UPDATE vk_events_bindings SET lp_lease_id=?,lp_lease_until=?,lp_status='starting',lp_error=NULL WHERE company_code=?").run(leaseId, time + leaseMs, code);
      db.exec('COMMIT');
      return true;
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }
  // Renewal fails (and the consumer stops) on: abort, lost lease, new revision, Long Poll disabled,
  // owner's stop (lp_desired=0, also from another process) or a deleted company.
  function renew(code, groupId, leaseId, revision) {
    const until = now() + leaseMs;
    db.exec('BEGIN IMMEDIATE');
    try {
      const ok = db.prepare(`UPDATE vk_events_bindings SET lp_lease_until=? WHERE company_code=? AND group_id=? AND lp_lease_id=? AND revision=?
          AND longpoll_enabled=1 AND lp_desired=1 AND ${LIVE_COMPANY}`).run(until, code, groupId, leaseId, revision).changes === 1
        && db.prepare('UPDATE vk_events_lp_leases SET lease_until=? WHERE group_id=? AND company_code=? AND lease_id=?').run(until, groupId, code, leaseId).changes === 1;
      db.exec(ok ? 'COMMIT' : 'ROLLBACK');
      return ok;
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }
  function release(code, groupId, leaseId, status) {
    db.prepare('DELETE FROM vk_events_lp_leases WHERE group_id=? AND lease_id=?').run(groupId, leaseId);
    db.prepare(`UPDATE vk_events_bindings SET lp_lease_id=NULL,lp_lease_until=NULL,lp_status=CASE WHEN lp_status='error' THEN 'error' ELSE ? END
      WHERE company_code=? AND lp_lease_id=?`).run(status, code, leaseId);
  }
  function startable(code) {
    const row = rowFor(code);
    if (!row) fail('NOT_CONFIGURED');
    if (!row.longpoll_enabled) fail('LONGPOLL_NOT_ENABLED');
    tokenFor(row);
    if (row.check_status !== 'connected' || row.checked_revision !== row.revision) fail('NOT_CHECKED');
    if (row.lp_vk_enabled !== 1) fail('LONGPOLL_DISABLED_IN_VK');
    return row;
  }

  function ensureSession(code) {
    if (sessions.has(code)) return {started: false, running: true};
    const row = startable(code), leaseId = randomBytes(16).toString('hex');
    if (!acquire(code, row.group_id, leaseId)) fail('LEASE_HELD', 409);
    const controller = new AbortController(), session = {leaseId, controller, revision: row.revision, groupId: row.group_id};
    sessions.set(code, session);
    session.done = runSession(code, session).catch(error => onError('longpoll_session_failed', error?.code || error?.message))
      .finally(() => { if (sessions.get(code) === session) sessions.delete(code); release(code, row.group_id, leaseId, 'stopped'); });
    return {started: true, running: true};
  }
  function stopSession(code) {
    const session = sessions.get(code);
    if (!session) return Promise.resolve();
    session.controller.abort();
    return session.done;
  }

  async function runSession(code, session) {
    const abort = session.controller.signal;
    let server = null, key = null, failures = 0;
    const alive = () => !abort.aborted && renew(code, session.groupId, session.leaseId, session.revision);
    while (alive()) {
      const row = rowFor(code);
      let token;
      try { token = tokenFor(row); } catch (error) { setStatus(code, session.leaseId, 'error', error.code); return; }
      try {
        if (!server || !key) {
          const lp = await call(token, 'groups.getLongPollServer', {group_id: row.group_id}, abort);
          if (!alive()) return;
          if (!object(lp) || typeof lp.key !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(lp.key) || !tsValue(lp.ts)) fail('RESPONSE_INVALID', 502);
          const url = lpServerUrl(lp.server);
          if (!url) { setStatus(code, session.leaseId, 'error', 'LP_SERVER_UNTRUSTED'); return; }
          server = url; key = lp.key;
          // A saved cursor survives restarts; only a fresh binding (or failed:3) starts from VK's current ts.
          if (!rowFor(code).lp_ts) db.prepare('UPDATE vk_events_bindings SET lp_ts=? WHERE company_code=? AND lp_lease_id=?').run(tsValue(lp.ts), code, session.leaseId);
          session.freshTs = tsValue(lp.ts);
        }
        setStatus(code, session.leaseId, 'listening');
        const ts = rowFor(code).lp_ts;
        const target = new URL(server.href);
        target.search = new URLSearchParams({act: 'a_check', key, ts, wait: String(wait)}).toString();
        const pollSignal = AbortSignal.any([abort, AbortSignal.timeout((wait + 15) * 1000)]);
        let data;
        try {
          const response = await fetchImpl(target.href, {method: 'GET', redirect: 'error', signal: pollSignal});
          if (!response.ok) throw new Error('LP HTTP ' + response.status);
          data = await readLimited(response, pollSignal, LP_RESPONSE_MAX_BYTES);
        } catch (error) { if (abort.aborted) return; throw Object.assign(new Error('poll'), {code: 'CONNECTION_UNCERTAIN'}); }
        if (!alive()) return;
        if (!object(data)) fail('RESPONSE_INVALID', 502);
        if (Object.hasOwn(data, 'failed')) {
          if (data.failed === 1 && tsValue(data.ts)) {
            db.prepare('UPDATE vk_events_bindings SET lp_ts=?,lp_gaps=lp_gaps+1,lp_gap_at=? WHERE company_code=? AND lp_lease_id=?').run(tsValue(data.ts), stamp(), code, session.leaseId);
          } else if (data.failed === 2) { key = null; }
          else if (data.failed === 3) {
            key = null; server = null;
            db.prepare('UPDATE vk_events_bindings SET lp_ts=NULL,lp_gaps=lp_gaps+1,lp_gap_at=? WHERE company_code=? AND lp_lease_id=?').run(stamp(), code, session.leaseId);
          } else fail('RESPONSE_INVALID', 502);
          failures = 0; continue;
        }
        const nextTs = tsValue(data.ts);
        if (!nextTs || !Array.isArray(data.updates) || data.updates.length > LP_MAX_UPDATES) fail('RESPONSE_INVALID', 502);
        // Events and the new cursor commit together: a storage failure re-reads the same batch next time.
        db.exec('BEGIN IMMEDIATE');
        try {
          const current = rowFor(code);
          const liveCompany = db.prepare('SELECT 1 FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get(code);
          const groupLease = db.prepare('SELECT 1 FROM vk_events_lp_leases WHERE group_id=? AND company_code=? AND lease_id=?').get(session.groupId, code, session.leaseId);
          if (!current || !liveCompany || !groupLease || current.lp_lease_id !== session.leaseId || current.revision !== session.revision
            || current.group_id !== session.groupId || !current.longpoll_enabled || !current.lp_desired) { db.exec('ROLLBACK'); return; }
          let invalid = 0, stored = 0;
          for (const update of data.updates) {
            if (!validUpdate(current, update)) { invalid++; continue; }
            ingest(current, update, 'longpoll'); stored++;
          }
          db.prepare(`UPDATE vk_events_bindings SET lp_ts=?,lp_invalid=lp_invalid+?,lp_last_event_at=CASE WHEN ?>0 THEN ? ELSE lp_last_event_at END
            WHERE company_code=? AND lp_lease_id=?`).run(nextTs, invalid, stored, stamp(), code, session.leaseId);
          db.exec('COMMIT');
        } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw Object.assign(new Error('store'), {code: 'STORE_FAILED'}); }
        failures = 0;
      } catch (error) {
        if (abort.aborted) return;
        if (error.code === 'ACCESS_DENIED' || error.code === 'TOKEN_UNREADABLE' || error.code === 'GROUP_MISMATCH') { setStatus(code, session.leaseId, 'error', error.code); return; }
        failures++;
        setStatus(code, session.leaseId, 'retrying', Object.hasOwn(VK_EVENTS_ERRORS, error.code) ? error.code : error.code === 'STORE_FAILED' ? 'STORE_FAILED' : 'CONNECTION_UNCERTAIN');
        if (error.code === 'RESPONSE_INVALID') { server = null; key = null; }
        await sleep(Math.min(60000, 1000 * 2 ** Math.min(failures - 1, 6)), abort);
      }
    }
  }

  async function longPoll(code, {revision, action} = {}) {
    const companyCode = company(code), row = rowFor(companyCode);
    if (!row) fail('NOT_CONFIGURED');
    if (revision !== row.revision) fail('SETTINGS_CHANGED', 409);
    if (action === 'start') {
      startable(companyCode);
      const previous = row.lp_desired;
      db.prepare('UPDATE vk_events_bindings SET lp_desired=1 WHERE company_code=? AND revision=?').run(companyCode, revision);
      try { ensureSession(companyCode); }
      catch (error) { db.prepare('UPDATE vk_events_bindings SET lp_desired=? WHERE company_code=? AND revision=?').run(previous, companyCode, revision); throw error; }
    } else if (action === 'stop') {
      // Persist the pause first: other processes see it at their next renewal, and resume() will not restart it.
      db.prepare("UPDATE vk_events_bindings SET lp_desired=0 WHERE company_code=? AND revision=?").run(companyCode, revision);
      await stopSession(companyCode);
      db.prepare("UPDATE vk_events_bindings SET lp_status='stopped',lp_error=NULL WHERE company_code=? AND revision=?").run(companyCode, revision);
    } else fail('INVALID_REQUEST');
    return settingsDto(companyCode);
  }

  // Revocation removes the stored credential for one transport and bumps the revision; it is reversible only by re-entering secrets.
  async function revoke(code, {revision, transport} = {}) {
    const companyCode = company(code), row = rowFor(companyCode);
    if (!row) fail('NOT_CONFIGURED');
    if (revision !== row.revision) fail('SETTINGS_CHANGED', 409);
    if (transport === 'longpoll') {
      await stopSession(companyCode);
      db.prepare(`UPDATE vk_events_bindings SET encrypted_token=NULL,longpoll_enabled=0,checked_revision=NULL,check_status='needs_check',lp_status='stopped',
        lp_error=NULL,lp_lease_id=NULL,lp_lease_until=NULL,lp_desired=0,revision=revision+1,updated_at=? WHERE company_code=? AND revision=?`).run(stamp(), companyCode, revision);
    } else if (transport === 'callback') {
      db.prepare(`UPDATE vk_events_bindings SET encrypted_secret=NULL,encrypted_confirmation=NULL,callback_enabled=0,callback_confirmed_at=NULL,
        endpoint_id=?,revision=revision+1,updated_at=? WHERE company_code=? AND revision=?`).run(endpointId(), stamp(), companyCode, revision);
      await stopSession(companyCode);
    } else fail('INVALID_REQUEST');
    return settingsDto(companyCode);
  }

  // Restore after a process restart: only bindings the owner left enabled and checked; never on behalf of other processes' leases.
  function resume() {
    const result = [];
    for (const {company_code: code} of db.prepare(`SELECT b.company_code FROM vk_events_bindings b JOIN companies c ON c.code=b.company_code COLLATE NOCASE
      WHERE c.is_deleted=0 AND b.longpoll_enabled=1 AND b.lp_desired=1 AND b.check_status='connected' AND b.checked_revision=b.revision AND b.lp_vk_enabled=1`).all()) {
      try { result.push({companyCode: code, ...ensureSession(code)}); } catch (error) { result.push({companyCode: code, started: false, code: error.code}); }
    }
    return result;
  }
  async function close() { await Promise.all([...sessions.keys()].map(stopSession)); }

  return {getSettings, saveSettings, checkConnection, journal, handleCallback, longPoll, revoke, resume, close,
    _sessions: sessions, CALLBACK_MAX_BYTES};
}

module.exports = {createVkEvents, VK_EVENTS_ERRORS, CALLBACK_MAX_BYTES, DOCS_EVENTS, LP_SCHEMA_EVENTS, lpServerUrl};
