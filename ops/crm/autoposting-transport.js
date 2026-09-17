'use strict';

const crypto = require('node:crypto');
const {createOnlypultProvider} = require('./onlypult-provider');
const PLATFORMS = Object.freeze({
  telegram: {name: 'Telegram', maxText: 4096, maxMedia: 10, mediaMode: 'photos', maxCaption: 1024},
  vk: {name: 'ВКонтакте', maxText: 15000, maxMedia: 1, mediaMode: 'link'},
});
const fail = (message, status = 400) => {throw Object.assign(new Error(message), {status, ambiguous: false});};
const failure = (code, ambiguous = false) => Object.assign(new Error('Не удалось выполнить действие на площадке'), {code, ambiguous, status: 502});
function publicUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      !/^(localhost|.*\.localhost|.*\.local)$/.test(url.hostname) && !/^[\d.]+$/.test(url.hostname) &&
      !url.hostname.includes(':') && url.hostname.includes('.') ? url.href : null;
  } catch {return null;}
}
function createAutopostingTransport(db, {apiKey, now = Date.now, fetchImpl = fetch} = {}) {
  if (!apiKey) throw new Error('Ключ хранения настроек отсутствует');
  db.exec(`CREATE TABLE IF NOT EXISTS autoposting_channels (
    company_code TEXT NOT NULL COLLATE NOCASE REFERENCES companies(code), id TEXT NOT NULL,
    name TEXT NOT NULL, target TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
    encrypted_token TEXT NOT NULL, revision INTEGER NOT NULL, checked_revision INTEGER,
    status TEXT NOT NULL, checked_at TEXT, updated_at TEXT NOT NULL,
    PRIMARY KEY(company_code,id)
  )`);
  const columns = new Set(db.prepare('PRAGMA table_info(autoposting_channels)').all().map(row => row.name));
  if (!columns.has('provider')) db.exec("ALTER TABLE autoposting_channels ADD COLUMN provider TEXT NOT NULL DEFAULT 'direct'");
  if (!columns.has('profile_display_name')) db.exec('ALTER TABLE autoposting_channels ADD COLUMN profile_display_name TEXT');
  function company(code) {
    if (typeof code !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code)) fail('Выберите компанию');
    const row = db.prepare('SELECT code,timezone FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get(code);
    if (!row) fail('Компания не найдена', 404);
    return row;
  }
  const rowFor = (code, id) => db.prepare('SELECT * FROM autoposting_channels WHERE company_code=? AND id=?').get(code, id);
  function crypt(code, id, value, decrypt = false) {
    const aad = Buffer.from(`synapse/autoposting/v1/${code.toLowerCase()}/${id}`);
    const envelope = decrypt ? JSON.parse(value) : {v: 1, salt: crypto.randomBytes(16).toString('base64'), iv: crypto.randomBytes(12).toString('base64')};
    if (envelope.v !== 1) throw new Error('Invalid credential envelope');
    const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(apiKey), Buffer.from(envelope.salt, 'base64'), aad, 32));
    try {
      const cipher = decrypt ? crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64')) :
        crypto.createCipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      cipher.setAAD(aad);
      if (decrypt) {
        cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        return Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()]).toString('utf8');
      }
      envelope.data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64');
      envelope.tag = cipher.getAuthTag().toString('base64');
      return JSON.stringify(envelope);
    } finally {key.fill(0);}
  }
  function tokenFor(row) {
    if (!row?.encrypted_token) throw failure('CONNECTION_MISSING');
    try {return crypt(row.company_code, row.id, row.encrypted_token, true);}
    catch {throw failure('TOKEN_UNREADABLE');}
  }
  function getSettings(code) {
    const current = company(code);
    return {companyCode: current.code, timezone: current.timezone || 'Asia/Irkutsk', channels: Object.entries(PLATFORMS).map(([id, caps]) => {
      const row = rowFor(current.code, id);
      let hasToken = false;
      if (row) try {hasToken = Boolean(tokenFor(row));} catch {}
      return {id, platform: id, provider: row?.provider || 'direct', name: row?.name || caps.name, target: row?.target || '', enabled: Boolean(row?.enabled),
        connected: Boolean(row && hasToken && row.checked_revision === row.revision && row.status === 'connected'),
        tokenConfigured: hasToken, revision: row?.revision || 0, status: row?.status || 'not_configured',
        checkedAt: row?.checked_at || null, profileDisplayName: row?.profile_display_name || null,
        caps: row?.provider === 'onlypult' ? {...caps, maxMedia: 10, mediaMode: 'photos'} : caps};
    })};
  }
  function saveSettings(code, body) {
    const current = company(code);
    if (!body || !Array.isArray(body.channels) || !body.channels.length || body.channels.length > 2 ||
        new Set(body.channels.map(row => row?.id)).size !== body.channels.length) fail('Проверьте список площадок');
    db.exec('BEGIN IMMEDIATE');
    try {
    const configs = body.channels.map(input => {
      if (!input || !Object.hasOwn(PLATFORMS, input.id) || (input.platform && input.platform !== input.id)) fail('Площадка не поддерживается');
      const previous = rowFor(current.code, input.id);
      const provider = input.provider === undefined ? (previous?.provider || 'direct') : input.provider;
      if (!['direct','onlypult'].includes(provider)) fail('Способ подключения не поддерживается');
      if (input.revision !== (previous?.revision || 0)) fail('Подключение изменилось. Обновите настройки', 409);
      if (input.name !== undefined && typeof input.name !== 'string') fail('Проверьте название площадки');
      const name = input.name?.trim() || PLATFORMS[input.id].name;
      if (name.length > 120 || typeof input.enabled !== 'boolean' || typeof input.target !== 'string') fail('Проверьте настройки площадки');
      let target = input.target.trim();
      if (provider === 'onlypult' && !(target === '' && !input.enabled) && !/^[A-Za-z0-9_-]{1,100}$/.test(target)) fail('Выберите профиль Onlypult');
      if (provider === 'direct' && input.id === 'telegram' && !/^(@[A-Za-z][A-Za-z0-9_]{4,31}|-100\d{5,16})$/.test(target)) fail('Укажите @имя канала Telegram или его ID -100…');
      if (provider === 'direct' && input.id === 'vk') {
        target = target.replace(/^(?:https:\/\/(?:www\.)?vk\.com\/)?(?:club|public)/, '').replace(/\/$/, '');
        if (!/^[1-9]\d{0,14}$/.test(target)) fail('Укажите числовой ID сообщества ВКонтакте');
      }
      if (input.token !== undefined && (typeof input.token !== 'string' || input.token.length > 2048 || /[\s\x00]/.test(input.token))) fail('Проверьте ключ доступа');
      const token = input.token || (previous && previous.provider === provider ? tokenFor(previous) : '');
      if (!token) fail('Введите ключ доступа для этой площадки');
      if (provider === 'direct' && input.id === 'telegram' && !/^\d{5,16}:[A-Za-z0-9_-]{20,}$/.test(token)) fail('Проверьте токен бота Telegram');
      if (provider === 'onlypult' && !/^op_[a-fA-F0-9]{64}$/.test(token)) fail('Проверьте ключ API Onlypult');
      return {id: input.id, provider, name, target, token, enabled: input.enabled};
    });
      for (const config of configs) db.prepare(`INSERT INTO autoposting_channels
        (company_code,id,name,target,enabled,encrypted_token,revision,status,updated_at,provider) VALUES(?,?,?,?,?,?,1,'needs_check',?,?)
        ON CONFLICT(company_code,id) DO UPDATE SET name=excluded.name,target=excluded.target,enabled=excluded.enabled,
          encrypted_token=excluded.encrypted_token,revision=autoposting_channels.revision+1,checked_revision=NULL,
          status='needs_check',checked_at=NULL,profile_display_name=NULL,provider=excluded.provider,updated_at=excluded.updated_at`).run(current.code,config.id,config.name,
            config.target,Number(config.enabled),crypt(current.code,config.id,config.token),new Date(now()).toISOString(),config.provider);
      db.exec('COMMIT');
    } catch (error) {db.exec('ROLLBACK'); throw error;}
    return getSettings(current.code);
  }
  async function readResponse(response, signal) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Response body unavailable');
    const chunks = []; let total = 0, abort;
    const aborted = new Promise((resolve, reject) => {
      abort = () => reject(new Error('Response timed out'));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, {once:true});
    });
    try {
      while (true) {
        const {done,value} = await Promise.race([reader.read(),aborted]);
        if (done) break;
        total += value.byteLength;
        if (total > 1024 * 1024) throw new Error('Response too large');
        chunks.push(value);
      }
      return Buffer.concat(chunks,total).toString('utf8');
    } finally {
      signal.removeEventListener('abort',abort);
      reader.cancel().catch(() => {});
    }
  }
  async function call(row, method, params, publishing = false) {
    const token = tokenFor(row), telegram = row.id === 'telegram';
    const endpoint = telegram ? `https://api.telegram.org/bot${token}/${method}` : `https://api.vk.com/method/${method}`;
    let data, response;
    try {
      const signal = AbortSignal.timeout(20000);
      response = await fetchImpl(endpoint, {method: 'POST', redirect: 'error', signal,
        headers: {'content-type': telegram ? 'application/json' : 'application/x-www-form-urlencoded'},
        body: telegram ? JSON.stringify(params) : new URLSearchParams({...params, access_token: token, v: '5.199'}).toString()});
      const text = await readResponse(response,signal);
      data = JSON.parse(text);
    } catch {throw failure('CONNECTION_UNCERTAIN', publishing);}
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('RESPONSE_UNCERTAIN', publishing);
    const rejected = telegram ? data.ok === false && Number.isInteger(data.error_code) :
      data.error && Number.isInteger(data.error.error_code);
    if (rejected) {
      const errorCode = telegram ? data.error_code : data.error?.error_code;
      // Only a parsed provider rejection establishes that no post was accepted.
      throw failure([401,403,5,7,15,27,28].includes(errorCode) ? 'ACCESS_DENIED' : 'PLATFORM_REJECTED', false);
    }
    if (!response.ok) throw failure('CONNECTION_UNCERTAIN', publishing);
    if (telegram ? data.ok !== true || !Object.hasOwn(data,'result') : !Object.hasOwn(data,'response')) throw failure('RESPONSE_UNCERTAIN', publishing);
    return telegram ? data.result : data.response;
  }
  const onlypult = createOnlypultProvider({failure, readResponse, fetchImpl, tokenFor});
  async function listProfiles(code, id) {
    const current = company(code), row = rowFor(current.code,id);
    if (!row || row.provider !== 'onlypult') fail('Сначала сохраните ключ Onlypult для этой площадки');
    const profiles = await onlypult.listProfiles(row);
    if (rowFor(current.code,id)?.revision !== row.revision) throw failure('SETTINGS_CHANGED');
    return {companyCode: current.code, channelId: id, revision: row.revision, profiles};
  }
  async function checkChannel(code, id) {
    const current = company(code), row = rowFor(current.code, id);
    if (!row) fail('Сначала сохраните подключение');
    let status = 'connected', errorCode = null, profileDisplayName = null;
    try {
      if (row.provider === 'onlypult') {
        profileDisplayName = (await onlypult.check(row)).name;
      } else if (id === 'telegram') {
        const bot = await call(row, 'getMe', {});
        const chat = await call(row, 'getChat', {chat_id: row.target});
        if (chat?.type !== 'channel') throw failure('CHANNEL_REQUIRED');
        const member = await call(row, 'getChatMember', {chat_id: row.target, user_id: bot.id});
        if (member?.status !== 'creator' && !(member?.status === 'administrator' && member.can_post_messages === true)) throw failure('ADMIN_REQUIRED');
      } else {
        const permissions = await call(row, 'account.getAppPermissions', {});
        if (!Number.isInteger(permissions) || (permissions & 8192) !== 8192) throw failure('WALL_PERMISSION_REQUIRED');
        const result = await call(row, 'groups.getById', {group_ids: row.target, fields: 'can_post'});
        const group = (Array.isArray(result) ? result : result?.groups)?.[0];
        if (String(group?.id) !== row.target || group.is_admin !== 1 || group.can_post !== 1) throw failure('ADMIN_REQUIRED');
      }
    } catch (error) {status = 'error'; errorCode = error.code || 'CHECK_FAILED';}
    const changed = db.prepare(`UPDATE autoposting_channels SET status=?,checked_revision=?,checked_at=?,profile_display_name=?
      WHERE company_code=? AND id=? AND revision=?`).run(status,status === 'connected' ? row.revision : null,
        new Date(now()).toISOString(),profileDisplayName,current.code,id,row.revision).changes;
    return {...getSettings(current.code), ok: Boolean(changed && status === 'connected'), code: changed ? errorCode : 'SETTINGS_CHANGED'};
  }
  async function publish({companyCode, post, channelId, channelRevision, beforePublish}) {
    const current = company(companyCode), row = rowFor(current.code, channelId);
    if (!row || !row.enabled || row.status !== 'connected' || row.checked_revision !== row.revision) throw failure('CONNECTION_MISSING');
    if (channelRevision !== undefined && row.revision !== channelRevision) throw failure('CHANNEL_CHANGED');
    const caps = row.provider === 'onlypult' ? {...PLATFORMS[channelId],maxMedia:10} : PLATFORMS[channelId], text = String(post.text || ''), media = post.mediaUrls || [];
    if (!text.trim() || text.length > caps.maxText || !Array.isArray(media) || media.length > caps.maxMedia ||
        media.some(url => !publicUrl(url)) || (channelId === 'telegram' && media.length && text.length > caps.maxCaption)) throw failure('CONTENT_LIMIT');
    if (row.provider === 'onlypult') {
      // No provider POST retry: Onlypult's public contract has no idempotency key.
      // Guard every awaited preflight against owner changes before the first POST.
      const guard = () => {
        const latest = rowFor(current.code,channelId);
        if (!latest || latest.revision !== row.revision || !latest.enabled || latest.status !== 'connected') throw failure('SETTINGS_CHANGED');
        if (beforePublish) beforePublish();
      };
      return onlypult.publish(row,{...post,text,mediaUrls:media},guard);
    }
    if (channelId === 'telegram') {
      const result = media.length > 1 ? await call(row, 'sendMediaGroup', {chat_id: row.target,
        media: media.map((url,index) => ({type: 'photo', media: url, ...(index ? {} : {caption: text})}))}, true) :
        media.length ? await call(row, 'sendPhoto', {chat_id: row.target, photo: media[0], caption: text}, true) :
          await call(row, 'sendMessage', {chat_id: row.target, text}, true);
      const messages = Array.isArray(result) ? result : [result];
      if (!messages.length || messages.some(message => !Number.isSafeInteger(message?.message_id))) throw failure('RESPONSE_UNCERTAIN', true);
      const message = messages[0], chatId = String(message.chat?.id || row.target);
      const url = message.chat?.username ? `https://t.me/${message.chat.username}/${message.message_id}` :
        chatId.startsWith('-100') ? `https://t.me/c/${chatId.slice(4)}/${message.message_id}` : null;
      return {id: messages.map(item => item.message_id).join(','), externalId: String(message.message_id), url, status: 'published'};
    }
    const guid = crypto.createHash('sha256').update(String(post.idempotencyKey || `${current.code}:${post.id}:${post.revision}`)).digest('hex').slice(0,16);
    const result = await call(row, 'wall.post', {owner_id: '-' + row.target, from_group: '1', message: text,
      ...(media.length ? {attachments: media[0]} : {}), guid}, true);
    if (!Number.isSafeInteger(result?.post_id)) throw failure('RESPONSE_UNCERTAIN', true);
    const id = `-${row.target}_${result.post_id}`;
    return {id, externalId: id, url: `https://vk.com/wall${id}`, status: 'published'};
  }
  async function reconcile({companyCode,channelId,channelRevision,providerPostId}) {
    const current = company(companyCode), row = rowFor(current.code,channelId);
    if (!row || row.provider !== 'onlypult' || row.revision !== channelRevision) throw failure('CHANNEL_CHANGED');
    const result = await onlypult.reconcile(row,providerPostId);
    if (rowFor(current.code,channelId)?.revision !== row.revision) throw failure('CHANNEL_CHANGED');
    return result;
  }
  return {getSettings,saveSettings,checkChannel,listProfiles,publish,reconcile};
}

module.exports = {createAutopostingTransport,PLATFORMS,publicUrl};
