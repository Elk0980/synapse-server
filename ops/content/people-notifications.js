'use strict';

const {createHash} = require('node:crypto');
const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
const hash = value => createHash('sha256').update(value).digest('hex');
const ownObject = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(400, label);
  return value;
};

// Only browser push providers, never a caller-selected HTTP target. No arbitrary
// domain, IP literal, credentials, nonstandard port, fragment or redirect is used.
function validatePushSubscription(input, at = Date.now()) {
  if (!ownObject(input) || Object.keys(input).some(key => !['endpoint','expirationTime','keys'].includes(key))) fail(400, 'Некорректная подписка уведомлений');
  let endpoint;
  try { endpoint = new URL(input.endpoint); } catch { fail(400, 'Некорректный адрес push-службы'); }
  const exact = new Set(['fcm.googleapis.com','updates.push.services.mozilla.com','push.services.mozilla.com','web.push.apple.com']);
  const trusted = exact.has(endpoint.hostname) || /^[a-z0-9-]+\.notify\.windows\.com$/.test(endpoint.hostname);
  if (typeof input.endpoint !== 'string' || input.endpoint.length > 4096 || endpoint.protocol !== 'https:' || !trusted ||
      endpoint.username || endpoint.password || endpoint.hash || endpoint.port && endpoint.port !== '443' ||
      /[\x00-\x20\\]/.test(input.endpoint)) fail(400, 'Недопустимый адрес push-службы');
  if (!ownObject(input.keys) || Object.keys(input.keys).sort().join(',') !== 'auth,p256dh') fail(400, 'Некорректные ключи подписки');
  for (const [key, size] of [['auth',16],['p256dh',65]]) {
    const value = input.keys[key];
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || Buffer.from(value,'base64url').length !== size ||
        Buffer.from(value,'base64url').toString('base64url') !== value) fail(400, 'Некорректные ключи подписки');
  }
  if (Buffer.from(input.keys.p256dh,'base64url')[0] !== 4) fail(400, 'Некорректные ключи подписки');
  if (input.expirationTime !== undefined && input.expirationTime !== null &&
      (!Number.isFinite(input.expirationTime) || input.expirationTime <= at)) fail(400, 'Подписка уведомлений истекла');
  return {endpoint:endpoint.href, expirationTime:input.expirationTime ?? null,
    keys:{auth:input.keys.auth,p256dh:input.keys.p256dh}};
}

function localUrl(value) {
  if (typeof value !== 'string' || value.length > 1024 || !/^\/(?!\/)/.test(value) || /[\x00-\x20\\]/.test(value)) fail(400, 'Нужна внутренняя ссылка кабинета');
  const parsed = new URL(value,'https://cabinet.invalid');
  if (parsed.origin !== 'https://cabinet.invalid') fail(400, 'Нужна внутренняя ссылка кабинета');
  return parsed.pathname + parsed.search + parsed.hash;
}

function createPeopleNotifications({db, authStore, now = Date.now, enabled = false, sendPush, sendTelegram, resolveTelegram,
  canReceive = () => true, validateEvent = async () => true} = {}) {
  if (!db || !authStore) throw new Error('Нужны база и существующий реестр учётных записей');
  if (typeof canReceive !== 'function' || typeof validateEvent !== 'function') throw new Error('Нужны проверки доступа и актуальности уведомления');
  const deliveryEnabled = enabled === true;
  const stamp = () => new Date(now()).toISOString();
  db.exec(`CREATE TABLE IF NOT EXISTS people_notification_preferences (
    user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    company_code TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    push INTEGER NOT NULL DEFAULT 0 CHECK(push IN (0,1)), telegram INTEGER NOT NULL DEFAULT 0 CHECK(telegram IN (0,1)),
    updated_at TEXT NOT NULL, PRIMARY KEY(user_id,company_code));
    CREATE TABLE IF NOT EXISTS people_push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      company_code TEXT NOT NULL, endpoint_hash TEXT NOT NULL, subscription TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(user_id,company_code,endpoint_hash));
    CREATE INDEX IF NOT EXISTS people_push_endpoint_idx ON people_push_subscriptions(endpoint_hash);
    CREATE TABLE IF NOT EXISTS people_notification_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      company_code TEXT NOT NULL, event_key TEXT NOT NULL, channel TEXT NOT NULL CHECK(channel IN ('push','telegram')),
      target_key TEXT NOT NULL, subscription_id INTEGER REFERENCES people_push_subscriptions(id) ON DELETE SET NULL,
      payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','uncertain','error','cancelled')),
      error_code TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, UNIQUE(user_id,company_code,event_key,channel,target_key));`);
  // A worker can have died after provider acceptance but before its local receipt.
  // Never turn this into a second send. Single-writer service owns this database.
  db.prepare("UPDATE people_notification_outbox SET status='uncertain',error_code='SEND_OUTCOME_UNKNOWN',updated_at=? WHERE status='sending'").run(stamp());
  let active = null;

  function user(userId, companyCode) {
    if (!Number.isSafeInteger(userId) || userId < 1 || typeof companyCode !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(companyCode)) fail(400, 'Укажите человека и компанию');
    const current = authStore.getById(userId);
    if (!current || !['owner','editor'].includes(current.role) || !current.companyCodes?.includes(companyCode)) fail(403, 'Нет доступа к компании');
    let permitted = false;
    try { permitted = canReceive(userId,companyCode) === true; } catch {}
    if (!permitted) fail(403, 'Нет права получать уведомления');
    return current;
  }
  const prefs = (id, code) => db.prepare('SELECT enabled,push,telegram FROM people_notification_preferences WHERE user_id=? AND company_code=?').get(id,code);
  const allowed = (row) => {
    try { user(row.user_id,row.company_code); } catch { return false; }
    const preference = prefs(row.user_id,row.company_code);
    return preference?.enabled === 1 && preference[row.channel] === 1;
  };
  const status = (id, state, error = '') => db.prepare('UPDATE people_notification_outbox SET status=?,error_code=?,updated_at=? WHERE id=? AND status=\'sending\'').run(state,error,stamp(),id);
  function getPreferences(userId, companyCode) {
    user(userId,companyCode);
    const preference = prefs(userId,companyCode);
    return {enabled:preference?.enabled === 1,push:preference?.push === 1,telegram:preference?.telegram === 1,
      subscriptionCount:db.prepare('SELECT count(*) n FROM people_push_subscriptions WHERE user_id=? AND company_code=?').get(userId,companyCode).n,
      deliveryEnabled};
  }
  function setPreferences(userId, companyCode, input) {
    user(userId,companyCode);
    if (!ownObject(input) || Object.keys(input).sort().join(',') !== 'enabled,push,telegram' ||
        ['enabled','push','telegram'].some(key => typeof input[key] !== 'boolean')) fail(400, 'Выберите способы получения уведомлений');
    db.prepare(`INSERT INTO people_notification_preferences(user_id,company_code,enabled,push,telegram,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id,company_code) DO UPDATE SET enabled=excluded.enabled,push=excluded.push,telegram=excluded.telegram,updated_at=excluded.updated_at`)
      .run(userId,companyCode,Number(input.enabled),Number(input.push),Number(input.telegram),stamp());
    for (const channel of ['push','telegram']) if (!input.enabled || !input[channel]) {
      db.prepare("UPDATE people_notification_outbox SET status='cancelled',error_code='OPTED_OUT',updated_at=? WHERE user_id=? AND company_code=? AND channel=? AND status='pending'")
        .run(stamp(),userId,companyCode,channel);
    }
    return getPreferences(userId,companyCode);
  }
  function subscribe(userId, companyCode, input) {
    user(userId,companyCode);
    const subscription = validatePushSubscription(input,now()), key = hash(subscription.endpoint);
    const other = db.prepare('SELECT 1 FROM people_push_subscriptions WHERE endpoint_hash=? AND user_id<>?').get(key,userId);
    if (other) fail(409, 'Эта подписка уже используется другой учётной записью');
    if (!db.prepare('SELECT 1 FROM people_push_subscriptions WHERE user_id=? AND company_code=? AND endpoint_hash=?').get(userId,companyCode,key) &&
        db.prepare('SELECT count(*) n FROM people_push_subscriptions WHERE user_id=? AND company_code=?').get(userId,companyCode).n >= 10) fail(409, 'Достигнут лимит устройств для уведомлений');
    db.prepare(`INSERT INTO people_push_subscriptions(user_id,company_code,endpoint_hash,subscription,created_at,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id,company_code,endpoint_hash) DO UPDATE SET subscription=excluded.subscription,updated_at=excluded.updated_at`)
      .run(userId,companyCode,key,JSON.stringify(subscription),stamp(),stamp());
    return getPreferences(userId,companyCode);
  }
  function unsubscribe(userId, companyCode, input) {
    user(userId,companyCode);
    if (!ownObject(input) || Object.keys(input).join(',') !== 'endpoint' || typeof input.endpoint !== 'string') fail(400, 'Укажите подписку этого устройства');
    let endpoint;
    try { endpoint = new URL(input.endpoint).href; } catch { fail(400, 'Некорректная подписка'); }
    const key = hash(endpoint);
    db.prepare("UPDATE people_notification_outbox SET status='cancelled',error_code='UNSUBSCRIBED',updated_at=? WHERE user_id=? AND company_code=? AND channel='push' AND target_key=? AND status='pending'")
      .run(stamp(),userId,companyCode,key);
    db.prepare('DELETE FROM people_push_subscriptions WHERE user_id=? AND company_code=? AND endpoint_hash=?').run(userId,companyCode,key);
    return getPreferences(userId,companyCode);
  }
  function enqueue({userId,companyCode,eventKey,title,body,url = '/people.html',pushOnly=false}) {
    user(userId,companyCode);
    text(eventKey,300,'Некорректное событие');
    const payload = JSON.stringify({audienceUserId:userId,companyCode,eventKey,title:text(title,120,'Некорректный заголовок'),body:text(body,2000,'Некорректный текст'),url:localUrl(url)});
    if (Buffer.byteLength(payload,'utf8') > 3072) fail(400, 'Текст уведомления слишком длинный');
    const preference = prefs(userId,companyCode);
    if (preference?.enabled !== 1) return {queued:0};
    const targets = [];
    if (preference.push === 1) for (const subscription of db.prepare('SELECT id,endpoint_hash FROM people_push_subscriptions WHERE user_id=? AND company_code=?').all(userId,companyCode)) {
      targets.push({channel:'push',key:subscription.endpoint_hash,subscriptionId:subscription.id});
    }
    if (!pushOnly && preference.telegram === 1) targets.push({channel:'telegram',key:'linked-user',subscriptionId:null});
    let queued = 0;
    // These two failures occurred before any provider call. A fresh scheduler
    // snapshot can safely replace their stale payload without creating another
    // slot/event. All attempted/accepted/unknown sends and consent/access revokes
    // keep their original terminal state; never replay them through this path.
    const insert = db.prepare(`INSERT INTO people_notification_outbox(user_id,company_code,event_key,channel,target_key,subscription_id,payload,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,company_code,event_key,channel,target_key) DO UPDATE SET
        payload=excluded.payload,subscription_id=excluded.subscription_id,status='pending',error_code='',updated_at=excluded.updated_at
      WHERE (people_notification_outbox.status='cancelled' AND people_notification_outbox.error_code='SOURCE_CHANGED')
         OR (people_notification_outbox.status='error' AND people_notification_outbox.error_code='SOURCE_UNAVAILABLE')`);
    for (const target of targets) queued += Number(insert.run(userId,companyCode,eventKey,target.channel,target.key,target.subscriptionId,payload,stamp(),stamp()).changes);
    return {queued};
  }
  async function sourceCurrent(row, payload) {
    let valid;
    try { valid = await validateEvent({userId:row.user_id,companyCode:row.company_code,eventKey:row.event_key,payload}); }
    catch { status(row.id,'error','SOURCE_UNAVAILABLE'); return false; }
    if (valid !== true) { status(row.id,'cancelled','SOURCE_CHANGED'); return false; }
    // Source lookup may await CRM. A previously valid membership or permission
    // must not survive its revocation while that request was in flight.
    if (!allowed(row)) { status(row.id,'cancelled','ACCESS_OR_CONSENT_REVOKED'); return false; }
    return true;
  }
  async function deliver(row) {
    if (!allowed(row)) { status(row.id,'cancelled','ACCESS_OR_CONSENT_REVOKED'); return; }
    const payload = JSON.parse(row.payload);
    if (!await sourceCurrent(row,payload)) return;
    try {
      let result;
      if (row.channel === 'push') {
        const stored = db.prepare('SELECT * FROM people_push_subscriptions WHERE id=? AND user_id=? AND company_code=?').get(row.subscription_id,row.user_id,row.company_code);
        if (!stored) { status(row.id,'cancelled','UNSUBSCRIBED'); return; }
        const subscription = validatePushSubscription(JSON.parse(stored.subscription),now());
        if (typeof sendPush !== 'function') { status(row.id,'error','PUSH_NOT_CONFIGURED'); return; }
        if (!allowed(row)) { status(row.id,'cancelled','ACCESS_OR_CONSENT_REVOKED'); return; }
        result = await sendPush({subscription,payload});
      } else {
        if (typeof resolveTelegram !== 'function' || typeof sendTelegram !== 'function') { status(row.id,'error','TELEGRAM_NOT_CONFIGURED'); return; }
        const recipient = await resolveTelegram({userId:row.user_id,companyCode:row.company_code});
        if (!recipient || recipient.userId !== row.user_id || recipient.companyCode !== row.company_code ||
            !/^\d{1,20}$/.test(String(recipient.chatId)) || !recipient.botToken) { status(row.id,'cancelled','TELEGRAM_NOT_LINKED'); return; }
        // Re-read after async recipient lookup; never send with revoked consent.
        if (!allowed(row)) { status(row.id,'cancelled','ACCESS_OR_CONSENT_REVOKED'); return; }
        // Recipient resolution may also await a project bot configuration.
        // Reassignment or an edited Friday rule during it invalidates the text.
        if (!await sourceCurrent(row,payload)) return;
        result = await sendTelegram({recipient,payload});
      }
      if (result?.ok === true) status(row.id,'sent');
      else status(row.id,'uncertain','SEND_OUTCOME_UNKNOWN');
    } catch (error) {
      const code = Number(error?.statusCode);
      if (row.channel === 'push' && [404,410].includes(code)) {
        db.prepare("UPDATE people_notification_outbox SET status='cancelled',error_code='SUBSCRIPTION_EXPIRED',updated_at=? WHERE subscription_id=? AND status='pending'").run(stamp(),row.subscription_id);
        db.prepare('DELETE FROM people_push_subscriptions WHERE id=?').run(row.subscription_id);
        status(row.id,'error','SUBSCRIPTION_EXPIRED');
      } else if (Number.isInteger(code) && code >= 300 && code < 600) status(row.id,'error','PROVIDER_REJECTED');
      else if (error?.status === 400) status(row.id,'error','INVALID_SUBSCRIPTION');
      else status(row.id,'uncertain','SEND_OUTCOME_UNKNOWN');
    }
  }
  function runOnce() {
    if (!deliveryEnabled) return Promise.resolve({enabled:false,processed:0});
    if (active) return active;
    active = (async () => {
      let processed = 0;
      for (let i = 0; i < 100; i++) {
        const row = db.prepare("SELECT * FROM people_notification_outbox WHERE status='pending' ORDER BY id LIMIT 1").get();
        if (!row) break;
        const claimed = db.prepare("UPDATE people_notification_outbox SET status='sending',attempts=attempts+1,updated_at=? WHERE id=? AND status='pending'").run(stamp(),row.id);
        if (!claimed.changes) continue;
        await deliver(row); processed++;
      }
      return {enabled:true,processed};
    })().finally(() => { active = null; });
    return active;
  }
  function preview(userId, companyCode) {
    user(userId,companyCode);
    return {deliveryEnabled,items:db.prepare(`SELECT id,event_key eventKey,channel,status,error_code errorCode,attempts,created_at createdAt,updated_at updatedAt
      FROM people_notification_outbox WHERE user_id=? AND company_code=? ORDER BY id DESC LIMIT 50`).all(userId,companyCode)};
  }
  return {getPreferences,setPreferences,subscribe,unsubscribe,enqueue,runOnce,preview};
}

module.exports = {createPeopleNotifications,validatePushSubscription};
