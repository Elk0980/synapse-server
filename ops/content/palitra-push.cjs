'use strict';

/* Existing documents + canonical typed chat only. No DDL, new auth, timers or network at construction.
 * Host supplies current staff authorization, existing transaction and real web-push sender.
 * Stored endpoint/key/session/queue details stay encrypted. Only authorized staff previews include canonical customer text.
 * Customer notifications remain generic; private keys and structured contact/order cards never enter the push payload.
 */
const crypto = require('node:crypto');
const contactFollowup = require('./native-contact-followup.cjs');
const { createPalitraNotificationText } = require('./site-orders.js');
const COMPANY = 'palitra-love';
const SHOP = 'https://palitra-love.ru';
const CABINET = 'https://synapse.synapsebusiness.ru';
const PREFIX = 'palitra-push-private/v1/';
const MAX_DEVICES = 8;
const LEASE_MS = 120000;
const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const positive = (value) => Number.isSafeInteger(value) && value > 0;

function actorOf(value) {
  if (!exact(value, ['kind', 'id', 'company', 'origin', 'sessionVersion']) || !['staff', 'customer'].includes(value.kind)
    || value.company !== COMPANY || typeof value.id !== 'string' || !/^[1-9]\d{0,15}$/.test(value.id) || !Number.isSafeInteger(Number(value.id))
    || value.origin !== (value.kind === 'staff' ? CABINET : SHOP)
    || !['string', 'number'].includes(typeof value.sessionVersion) || !String(value.sessionVersion)
    || String(value.sessionVersion).length > 80) fail(403, 'PUSH_ACTOR');
  return { kind: value.kind, id: value.id, company: COMPANY, origin: value.origin, sessionVersion: String(value.sessionVersion) };
}
const sameActor = (a, b) => JSON.stringify(actorOf(a)) === JSON.stringify(actorOf(b));

function endpointOf(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) fail(422, 'PUSH_ENDPOINT');
  let url;
  try { url = new URL(value); } catch { fail(422, 'PUSH_ENDPOINT'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.href !== value) fail(422, 'PUSH_ENDPOINT');
  const host = url.hostname;
  const allowed = host === 'fcm.googleapis.com' && /^\/(?:fcm\/send|wp)\/.+/.test(url.pathname)
    || host === 'updates.push.services.mozilla.com' && /^\/wpush\/v[12]\/.+/.test(url.pathname)
    || /^(?:[a-z0-9-]+\.)*push\.apple\.com$/.test(host) && url.pathname.length > 1
    || /^(?:[a-z0-9-]+\.)*notify\.windows\.com$/.test(host) && url.pathname.length > 1;
  if (!allowed) fail(422, 'PUSH_PROVIDER');
  return value;
}
function subscriptionOf(value) {
  // Some browsers omit an unset expirationTime from PushSubscription.toJSON().
  // Keep both accepted shapes closed, then store the same canonical representation.
  if ((!exact(value, ['endpoint', 'expirationTime', 'keys']) && !exact(value, ['endpoint', 'keys']))
    || !exact(value.keys, ['p256dh', 'auth'])) fail(422, 'PUSH_SUBSCRIPTION');
  const expirationTime = Object.hasOwn(value, 'expirationTime') ? value.expirationTime : null;
  const endpoint = endpointOf(value.endpoint);
  if (expirationTime !== null && (!Number.isFinite(expirationTime) || expirationTime <= 0)) fail(422, 'PUSH_EXPIRATION');
  for (const [name, length] of [['p256dh', 65], ['auth', 16]]) {
    const key = value.keys[name];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(key) || Buffer.from(key, 'base64url').length !== length
      || Buffer.from(key, 'base64url').toString('base64url') !== key) fail(422, 'PUSH_KEY');
  }
  if (Buffer.from(value.keys.p256dh, 'base64url')[0] !== 4) fail(422, 'PUSH_KEY');
  try { crypto.ECDH.convertKey(Buffer.from(value.keys.p256dh, 'base64url'), 'prime256v1'); } catch { fail(422, 'PUSH_KEY'); }
  return { endpoint, expirationTime, keys: { ...value.keys } };
}

function validateVapid(value) {
  if (!exact(value, ['schema', 'subject', 'publicKey', 'privateKey']) || value.schema !== 1
    || value.subject !== SHOP || typeof value.publicKey !== 'string' || typeof value.privateKey !== 'string'
    || !/^[A-Za-z0-9_-]{87}$/.test(value.publicKey) || !/^[A-Za-z0-9_-]{43}$/.test(value.privateKey)) fail(503, 'PUSH_KEYS_UNAVAILABLE');
  const pair = crypto.createECDH('prime256v1');
  try { pair.setPrivateKey(Buffer.from(value.privateKey, 'base64url')); } catch { fail(503, 'PUSH_KEYS_UNAVAILABLE'); }
  if (pair.getPublicKey().toString('base64url') !== value.publicKey) fail(503, 'PUSH_KEYS_UNAVAILABLE');
  return value;
}

function createPalitraPush({ db, transaction, staffStillValid, sender = null, vapid = null, enabled = false, now = Date.now, followupEnabled = () => false } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof transaction !== 'function' || typeof staffStillValid !== 'function') throw new TypeError('Existing DB/transaction/staff authorization required');
  const keys = vapid === null ? null : validateVapid(vapid);
  const configured = Boolean(enabled === true && keys && typeof sender === 'function');
  const storageKey = keys ? crypto.createHash('sha256').update('palitra-push-document-encryption-v1\0').update(keys.privateKey).digest() : null;
  const latest = db.prepare('SELECT version,body FROM documents WHERE key=? ORDER BY version DESC LIMIT 1');
  const insert = db.prepare('INSERT INTO documents(key,version,created_at,author,body) VALUES(?,?,?,?,?)');
  const scan = db.prepare('SELECT d.key,d.body FROM documents d JOIN (SELECT key,MAX(version) AS version FROM documents WHERE key LIKE ? GROUP BY key) v ON v.key=d.key AND v.version=d.version WHERE (?=0 OR json_extract(d.body,\'$.active\')=1) ORDER BY d.key LIMIT 2001');
  const stamp = () => new Date(now()).toISOString();
  function seal(key, value) {
    if (!storageKey) fail(503, 'PUSH_NOT_CONFIGURED');
    const active = key.startsWith(PREFIX + 'job/') ? ['pending', 'sending'].includes(value.status) : value.enabled === true;
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', storageKey, iv);
    cipher.setAAD(Buffer.from(key + '\0' + active));
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return JSON.stringify({ schema: 1, cipher: 'aes-256-gcm', active,
      iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url') });
  }
  function open(key, raw) {
    if (!storageKey) fail(503, 'PUSH_NOT_CONFIGURED');
    try {
      const envelope = JSON.parse(raw);
      if (!exact(envelope, ['schema', 'cipher', 'active', 'iv', 'tag', 'data']) || envelope.schema !== 1 || envelope.cipher !== 'aes-256-gcm' || typeof envelope.active !== 'boolean') fail(503, 'PUSH_STORE');
      const decipher = crypto.createDecipheriv('aes-256-gcm', storageKey, Buffer.from(envelope.iv, 'base64url'));
      decipher.setAAD(Buffer.from(key + '\0' + envelope.active)); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64url')), decipher.final()]).toString());
    } catch { fail(503, 'PUSH_STORE'); }
  }
  function read(key) { const row = latest.get(key); return row ? open(key, row.body) : null; }
  function write(key, value) {
    const row = latest.get(key);
    insert.run(key, row ? row.version + 1 : 1, stamp(), 'palitra-push-system', seal(key, value));
  }
  function all(group, activeOnly = false) {
    const rows = scan.all(PREFIX + group + '/%', activeOnly ? 1 : 0);
    if (rows.length > 2000) fail(503, 'PUSH_STORE_LIMIT');
    return rows.map((row) => ({ key: row.key, value: open(row.key, row.body) }));
  }
  function current(actor, threadId = null) {
    const who = actorOf(actor);
    if (who.kind === 'staff') {
      try { return staffStillValid(who, threadId) === true; } catch { return false; }
    }
    const row = db.prepare("SELECT * FROM chat_web_sessions WHERE id=? AND scope='customer_chat' AND site='palitra' AND company_code=? AND origin=?").get(Number(who.id), COMPANY, SHOP);
    if (!row || row.revoked_at || !(Date.parse(row.expires_at) > now()) || String(row.created_at) !== who.sessionVersion) return false;
    if (threadId !== null && !db.prepare('SELECT 1 FROM chat_web_grants WHERE session_id=? AND thread_id=?').get(Number(who.id), threadId)) return false;
    return true;
  }
  function requireCurrent(actor) { const who = actorOf(actor); if (!current(who)) fail(403, 'PUSH_ACTOR_REVOKED'); return who; }
  function requireReady() { if (!configured) fail(503, 'PUSH_NOT_CONFIGURED'); }
  const subKey = (endpoint) => PREFIX + 'sub/' + hash(endpoint);
  function capability(actor) {
    requireCurrent(actor);
    return { ok: true, supported: true, configured, deliveryReady: configured, publicKey: configured ? keys.publicKey : null,
      reason: configured ? null : enabled !== true ? 'disabled' : !keys ? 'keys_unavailable' : 'transport_unavailable' };
  }
  function status(actor, endpoint = null) {
    const who = requireCurrent(actor);
    if (!configured) return { ok: true, subscribed: false, serverSaved: false };
    const rows = endpoint === null ? all('sub').map((x) => x.value) : [read(subKey(endpointOf(endpoint)))];
    const found = rows.some((row) => row && row.enabled === true && sameActor(row.actor, who));
    return { ok: true, subscribed: found, serverSaved: found };
  }
  function subscribe(actor, value) {
    requireReady(); const who = requireCurrent(actor), subscription = subscriptionOf(value);
    if (subscription.expirationTime !== null && subscription.expirationTime <= now()) fail(422, 'PUSH_EXPIRATION');
    return transaction(() => {
      requireCurrent(who); const key = subKey(subscription.endpoint), before = read(key);
      if (before && !sameActor(before.actor, who)) fail(409, 'PUSH_ENDPOINT_OTHER_ACTOR');
      const owned = all('sub').filter((x) => x.value.enabled && sameActor(x.value.actor, who));
      if ((!before || !before.enabled) && owned.length >= MAX_DEVICES) fail(409, 'PUSH_DEVICE_LIMIT');
      const changed = !before || !before.enabled || JSON.stringify(before.subscription) !== JSON.stringify(subscription);
      if (changed) write(key, { actor: who, subscription, enabled: true, generation: (before?.generation || 0) + 1, savedAt: stamp() });
      return { ok: true, subscribed: true, serverSaved: true };
    });
  }
  function unsubscribe(actor, endpoint) {
    requireReady(); const who = requireCurrent(actor), key = subKey(endpointOf(endpoint));
    return transaction(() => {
      requireCurrent(who); const before = read(key);
      if (before && !sameActor(before.actor, who)) fail(404, 'PUSH_SUBSCRIPTION_NOT_FOUND');
      if (before?.enabled) write(key, { ...before, enabled: false, generation: before.generation + 1, disabledAt: stamp() });
      return { ok: true, subscribed: false, serverSaved: true };
    });
  }
  /* Sync hook called inside SAME canonical message transaction. No network, body/client recipient trusted. */
  function onMessageStored(event) {
    if (!configured) return { enqueued: 0 };
    if (db.isTransaction !== true) fail(409, 'PUSH_TRANSACTION_REQUIRED');
    if (!plain(event) || !positive(event.messageId) || !event.thread || !positive(event.thread.id)) fail(422, 'PUSH_EVENT');
    const message = db.prepare(`SELECT m.id,m.thread_id,m.direction,m.author_kind,m.source_channel,t.site,t.company_code,t.order_id
      FROM chat_thread_messages m JOIN chat_threads t ON t.id=m.thread_id WHERE m.id=?`).get(event.messageId);
    if (!message || message.site !== 'palitra' || message.company_code !== COMPANY || message.thread_id !== event.thread.id
      || message.direction !== event.direction || message.author_kind !== event.author || message.source_channel !== event.source) fail(409, 'PUSH_CANONICAL_EVENT');
    // Exclude system/synthetic source and edits unless actually stored as canonical direction+author.
    const target = message.direction === 'in' && message.author_kind === 'customer' ? 'staff'
      : message.direction === 'out' && ['owner', 'manager'].includes(message.author_kind) ? 'customer' : null;
    if (!target) return { enqueued: 0 };
    let enqueued = 0;
    for (const { key: subscriptionKey, value: sub } of all('sub')) {
      if (!sub.enabled || sub.actor.kind !== target || !current(sub.actor, message.thread_id)
        || (sub.subscription.expirationTime !== null && sub.subscription.expirationTime <= now())) continue;
      const key = PREFIX + 'job/' + message.id + '/' + hash(sub.subscription.endpoint);
      if (read(key)) continue;
      write(key, { status: 'pending', messageId: message.id, threadId: message.thread_id, orderId: message.order_id,
        target, actor: sub.actor, subscriptionKey, generation: sub.generation, attempts: 0, createdAt: stamp(), nextAt: now() });
      enqueued++;
    }
    return { enqueued };
  }
  // Explicit staff reminder. No fabricated canonical chat message or unread count.
  function onOrderFollowup(event) {
    if (!configured || followupEnabled() !== true) return { enqueued: 0 };
    if (db.isTransaction !== true) fail(409, 'PUSH_TRANSACTION_REQUIRED');
    if (!contactFollowup.eventVerdict(db, event, now()).allowed) fail(409, 'PUSH_FOLLOWUP_CANONICAL_EVENT');
    let enqueued = 0;
    for (const { key: subscriptionKey, value: sub } of all('sub')) {
      if (!sub.enabled || sub.actor.kind !== 'staff' || !current(sub.actor, event.threadId)
        || (sub.subscription.expirationTime !== null && sub.subscription.expirationTime <= now())) continue;
      const key = PREFIX + 'job/followup/' + event.orderId + '/' + Date.parse(event.dueAt) + '/' + hash(sub.subscription.endpoint);
      if (read(key)) continue;
      write(key, { kind: 'contact-followup', status: 'pending', event: contactFollowup.eventView(event), threadId: event.threadId,
        orderId: event.orderId, target: 'staff', actor: sub.actor, subscriptionKey, generation: sub.generation,
        attempts: 0, createdAt: stamp(), nextAt: now() }); enqueued++;
    }
    return { enqueued };
  }
  function validJob(job) {
    const sub = read(job.subscriptionKey);
    if (!sub || !sub.enabled || sub.generation !== job.generation || !sameActor(sub.actor, job.actor)
      || !current(job.actor, job.threadId) || (sub.subscription.expirationTime !== null && sub.subscription.expirationTime <= now())) return null;
    if (job.kind === 'contact-followup') return followupEnabled() === true && job.target === 'staff' && job.actor.kind === 'staff'
      && contactFollowup.eventVerdict(db, job.event, now()).allowed ? sub : null;
    const message = db.prepare('SELECT m.direction,m.author_kind,t.company_code,t.site FROM chat_thread_messages m JOIN chat_threads t ON t.id=m.thread_id WHERE m.id=? AND m.thread_id=?').get(job.messageId, job.threadId);
    if (!message || message.company_code !== COMPANY || message.site !== 'palitra'
      || (job.target === 'staff' ? message.direction !== 'in' || message.author_kind !== 'customer'
        : message.direction !== 'out' || !['owner', 'manager'].includes(message.author_kind))) return null;
    return sub;
  }
  function claim() {
    return transaction(() => {
      for (const { key, value: job } of all('job', true)) {
        if (job.status === 'sending' && job.claimedAt + LEASE_MS <= now()) {
          write(key, { ...job, status: 'uncertain', code: 'PUSH_DELIVERY_UNKNOWN', finishedAt: stamp() }); continue;
        }
        if (job.status !== 'pending' || job.nextAt > now()) continue;
        const sub = validJob(job);
        if (!sub) { write(key, { ...job, status: 'stopped', code: 'PUSH_SCOPE_CHANGED', finishedAt: stamp() }); continue; }
        const taken = { ...job, status: 'sending', claim: crypto.randomUUID(), claimedAt: now(), attempts: job.attempts + 1 };
        write(key, taken); return { key, job: taken, subscription: sub.subscription };
      }
      return null;
    });
  }
  async function deliver(row) {
    let outcome;
    const currentGuard = () => Boolean(validJob(row.job));
    try {
      if (!currentGuard()) outcome = { statusCode: 0, stopped: true };
      else {
        const threadOrder = db.prepare("SELECT order_id FROM chat_threads WHERE id=? AND site='palitra' AND company_code=?").get(row.job.threadId, COMPANY);
        const chatEntry = '#chat?' + new URLSearchParams({thread:String(row.job.threadId),...(positive(threadOrder?.order_id)?{order:'native-order:'+threadOrder.order_id}:{})});
        const compact = row.job.target === 'staff' && row.job.kind !== 'contact-followup'
          ? createPalitraNotificationText({ db }).message(row.job.messageId, row.job.threadId, threadOrder?.order_id, 'message') : null;
        outcome = await sender(row.subscription, {
          title: 'Palitra Love Заказы', body: row.job.kind === 'contact-followup' ? 'Клиент не ответил в чате. Откройте заявку для связи.'
            : row.job.target === 'staff' ? 'Клиент написал в чате заказа' : 'Вам ответили по заказу',
          url: row.job.kind === 'contact-followup' ? '/cabinet/palitra-orders/cabinet.html#A04?order=native-order%3A' + row.job.orderId
            : row.job.target === 'staff' ? '/cabinet/palitra-orders/cabinet.html' + chatEntry : '/love-app/shop.html' + chatEntry,
          tag: (row.job.kind === 'contact-followup' ? 'palitra-followup-' : 'palitra-chat-') + row.job.threadId,
          ...(compact || {}),
        }, currentGuard);
      }
    } catch (error) { outcome = { statusCode: Number(error?.statusCode) || 0 }; }
    return transaction(() => {
      const job = read(row.key);
      if (!job || job.status !== 'sending' || job.claim !== row.job.claim) return 'changed';
      const code = outcome?.statusCode;
      let status = 'uncertain', reason = 'PUSH_DELIVERY_UNKNOWN', nextAt = job.nextAt;
      if (outcome?.stopped) { status = 'stopped'; reason = 'PUSH_SCOPE_CHANGED'; }
      else if (code >= 200 && code < 300) { status = 'accepted'; reason = 'PUSH_SERVICE_ACCEPTED'; }
      else if (code === 404 || code === 410) {
        status = 'expired'; reason = 'PUSH_ENDPOINT_EXPIRED';
        const sub = read(job.subscriptionKey);
        if (sub && sub.generation === job.generation && sameActor(sub.actor, job.actor)) write(job.subscriptionKey, { ...sub, enabled: false, generation: sub.generation + 1, disabledAt: stamp() });
      } else if (code === 429 || code >= 500 && code < 600) {
        status = job.attempts < 3 ? 'pending' : 'failed'; reason = 'PUSH_SERVICE_REFUSED'; nextAt = now() + job.attempts * 60000;
      } else if (code >= 300 && code < 500) { status = 'failed'; reason = 'PUSH_SERVICE_REFUSED'; }
      write(row.key, { ...job, status, code: reason, nextAt, finishedAt: status === 'pending' ? null : stamp() });
      return status;
    });
  }
  let running = null;
  async function run() {
    if (!configured) return { processed: 0, configured: false };
    const statuses = [];
    for (let i = 0; i < 20; i++) { const row = claim(); if (!row) break; statuses.push(await deliver(row)); }
    return { processed: statuses.length, configured: true, statuses };
  }
  function drain() {
    if (db.isTransaction) return Promise.reject(Object.assign(new Error('PUSH_DRAIN_TRANSACTION_OPEN'), {code:'PUSH_DRAIN_TRANSACTION_OPEN'}));
    if (!running) running = run().finally(() => { running = null; }); return running;
  }
  let scheduled = false;
  function requestDrain() {
    if (scheduled || !configured) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; void drain().catch(() => { console.warn('content: PUSH_DRAIN_DEFERRED'); }); });
  }
  return Object.freeze({ capability, status, subscribe, unsubscribe, onMessageStored, onOrderFollowup, drain, requestDrain });
}

module.exports = { createPalitraPush, actorOf, endpointOf, subscriptionOf, validateVapid, PREFIX };
