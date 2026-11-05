'use strict';
// No DDL/new timer/new identity. Registered only in the canonical new-form TX.
const DEADLINE_MS = 300000;
const ALERT = 'Клиент не написал в чат. Свяжитесь удобным для него способом';
const PREFIX = 'palitra-love/order-contact-followup/v1/';
const CONFIG_KEY = 'palitra-love/order-contact-followup/config/v1';
const SHOP = 'https://palitra-love.ru';
const COMPANY = 'palitra-love';
const idOf = value => {
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return null;
  const id = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
const fail = code => { throw Object.assign(new Error(code), { code }); };
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
const keyOf = id => PREFIX + id;
function customerReplied(db, threadId) {
  // Standalone legacy hosts may not have chat request receipts. On the native chat host exclude only
  // its reserved checkout marker; the first real web/Telegram message still counts as an answer.
  const receipts = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_thread_requests'").get();
  return Boolean(db.prepare(`SELECT 1 FROM chat_thread_messages m JOIN chat_threads t ON t.id=m.thread_id
    WHERE m.thread_id=? AND m.direction='in' AND m.author_kind='customer'
    ${receipts ? `AND NOT EXISTS (SELECT 1 FROM chat_thread_requests r WHERE r.message_id=m.id AND r.thread_id=m.thread_id
      AND r.actor_kind='web' AND r.actor_ref='session:' || m.web_session_id AND r.request_id='checkout-order:' || t.order_id)` : ''}
    LIMIT 1`).get(threadId));
}
const latest = (db, key) => db.prepare('SELECT version,body FROM documents WHERE key=? ORDER BY version DESC LIMIT 1').get(key);
function read(db, key) {
  const row = latest(db, key);
  if (!row) return null;
  try { const value = JSON.parse(row.body); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch {}
  fail('CONTACT_FOLLOWUP_DOCUMENT');
}
function write(db, key, value, at) {
  if (db.isTransaction !== true) fail('CONTACT_FOLLOWUP_TRANSACTION_REQUIRED');
  const row = latest(db, key);
  db.prepare('INSERT INTO documents(key,version,created_at,author,body) VALUES(?,?,?,?,?)')
    .run(key, row ? row.version + 1 : 1, new Date(at).toISOString(), 'palitra-contact-followup-system', JSON.stringify(value));
}
function configured(enabled, enabledAfterUtc) { return enabled === true && iso(enabledAfterUtc); }
function canonical(db, orderId, now) {
  const id = idOf(orderId);
  if (!id || !Number.isSafeInteger(now)) return { allowed: false, reason: 'invalid' };
  const order = db.prepare(`SELECT o.id,o.created_at,o.contact_channel,o.contact,w.status AS work_status
    FROM site_orders o LEFT JOIN site_order_work w ON w.order_id=o.id
    WHERE o.id=? AND o.site='palitra' AND o.company_code=?`).get(id, COMPANY);
  if (!order) return { allowed: false, reason: 'order_missing' };
  if (['done', 'cancelled'].includes(order.work_status)) return { allowed: false, reason: 'closed' };
  if (typeof order.created_at !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(order.created_at)
    || !Number.isFinite(Date.parse(order.created_at))) return { allowed: false, reason: 'date' };
  const threads = db.prepare("SELECT id FROM chat_threads WHERE site='palitra' AND company_code=? AND order_id=? LIMIT 2").all(COMPANY, id);
  if (threads.length !== 1 || !idOf(threads[0].id)) return { allowed: false, reason: 'thread' };
  const threadId = threads[0].id;
  if (customerReplied(db, threadId))
    return { allowed: false, reason: 'answered' };
  // A truthful confirmation in the existing funnel also ends the need to chase.
  const work = read(db, 'palitra-love/order-workflow/orders/' + id);
  if (Array.isArray(work?.confirmations) && work.confirmations.some(item => item?.requirement === 'contact_confirmed'))
    return { allowed: false, reason: 'contact_confirmed' };
  return { allowed: true, order, threadId, dueMs: Date.parse(order.created_at) + DEADLINE_MS };
}
function eventVerdict(db, event, now) {
  if (!event || !idOf(event.orderId) || !idOf(event.threadId) || typeof event.eventId !== 'string' || !iso(event.dueAt))
    return { allowed: false, reason: 'event' };
  const row = read(db, keyOf(event.orderId)), config = read(db, CONFIG_KEY);
  if (!row || row.schema !== 1 || row.site !== 'palitra' || row.companyCode !== COMPANY
    || row.orderId !== event.orderId || row.eventId !== event.eventId || row.threadId !== event.threadId || row.dueAt !== event.dueAt
    || row.eventId !== 'contact-followup:' + row.orderId + ':' + Date.parse(row.dueAt) || !idOf(row.sessionId)
    || !['waiting', 'emitted'].includes(row.state) || !config || config.schema !== 1
    || config.enabledAfterUtc !== row.enabledAfterUtc || !iso(row.enabledAfterUtc)) return { allowed: false, reason: 'record' };
  const check = canonical(db, row.orderId, now);
  if (!check.allowed) return check;
  if (check.threadId !== row.threadId || check.dueMs !== Date.parse(row.dueAt)
    || Date.parse(check.order.created_at) < Date.parse(row.enabledAfterUtc)) return { allowed: false, reason: 'identity' };
  const grants = db.prepare(`SELECT s.id,s.created_at,s.revoked_at,s.expires_at,s.site,s.company_code,s.origin,s.scope
    FROM chat_web_grants g JOIN chat_web_sessions s ON s.id=g.session_id WHERE g.thread_id=? ORDER BY s.id LIMIT 101`).all(row.threadId);
  if (grants.length > 100 || !grants.some(s => s.id === row.sessionId && s.created_at === row.sessionCreatedAt
    && !s.revoked_at && Date.parse(s.expires_at) > now && s.site === 'palitra' && s.company_code === COMPANY
    && s.origin === SHOP && s.scope === 'customer_chat')) return { allowed: false, reason: 'customer_identity' };
  if (now < check.dueMs) return { allowed: false, reason: 'not_due' };
  return { allowed: true, row, order: check.order };
}
function eventView(row) { return { orderId: row.orderId, threadId: row.threadId, eventId: row.eventId, dueAt: row.dueAt }; }
function orderUrl(id) { return 'https://synapse.synapsebusiness.ru/cabinet/palitra-orders/cabinet.html#A04?order=native-order%3A' + idOf(id); }
const CHANNEL_LABELS = Object.freeze({ phone: 'Телефон', telegram: 'Telegram', whatsapp: 'WhatsApp', max: 'MAX' });
function contactAction(channel, value) {
  if (typeof value !== 'string' || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) return null;
  value = value.trim();
  const validPhone = /^[+\d\s().-]+$/.test(value);
  let digits = validPhone ? value.replace(/\D/g, '') : '';
  if (digits.length === 11 && digits[0] === '8') digits = '7' + digits.slice(1);
  if (!/^\d{10,15}$/.test(digits)) digits = '';
  if (channel === 'telegram') {
    const nick = /^(?:@|(?:https:\/\/)?t\.me\/)?([a-zA-Z][a-zA-Z0-9_]{4,31})\/?$/.exec(value);
    return nick ? { label: 'Telegram', url: 'https://t.me/' + nick[1] } : digits ? { label: 'Telegram', url: 'https://t.me/+' + digits } : null;
  }
  if (channel === 'whatsapp' && digits) return { label: 'WhatsApp', url: 'https://wa.me/' + digits };
  // Telegram buttons accept HTTPS: phone/MAX open the exact protected order, whose existing CTA handles tel/copy.
  return null;
}
function createFollowupDispatcher({ db, transaction, notify, enabled = false, enabledAfterUtc = '', now = Date.now } = {}) {
  if (!db || typeof transaction !== 'function' || typeof notify !== 'function') throw new TypeError('Existing followup host required');
  const on = configured(enabled, enabledAfterUtc);
  function ready() {
    if (!on) return false;
    try { const previous = read(db, CONFIG_KEY); return !previous || previous.schema === 1 && previous.enabledAfterUtc === enabledAfterUtc; }
    catch { return false; }
  }
  function config() {
    const previous = read(db, CONFIG_KEY);
    if (previous && (previous.schema !== 1 || previous.enabledAfterUtc !== enabledAfterUtc)) fail('CONTACT_FOLLOWUP_CUTOFF_CHANGED');
    if (!previous) write(db, CONFIG_KEY, { schema: 1, enabledAfterUtc }, now());
  }
  function register({ orderId, threadId } = {}) {
    if (!on) return { registered: false, reason: 'disabled' };
    if (db.isTransaction !== true) fail('CONTACT_FOLLOWUP_TRANSACTION_REQUIRED');
    const check = canonical(db, orderId, now());
    if (!check.allowed || check.threadId !== threadId || Date.parse(check.order.created_at) < Date.parse(enabledAfterUtc))
      return { registered: false, reason: check.reason || 'before_cutoff' };
    // At form creation exactly one native session owns this newly created thread.
    const grants = db.prepare(`SELECT s.id,s.created_at FROM chat_web_grants g JOIN chat_web_sessions s ON s.id=g.session_id
      WHERE g.thread_id=? AND s.site='palitra' AND s.company_code=? AND s.origin=? AND s.scope='customer_chat'
      AND s.revoked_at IS NULL AND s.expires_at>? ORDER BY s.id LIMIT 2`).all(threadId, COMPANY, SHOP, new Date(now()).toISOString());
    if (grants.length !== 1) return { registered: false, reason: 'customer_identity' };
    config();
    const key = keyOf(orderId), previous = read(db, key), dueAt = new Date(check.dueMs).toISOString();
    if (previous) {
      if (previous.orderId !== orderId || previous.threadId !== threadId || previous.dueAt !== dueAt) fail('CONTACT_FOLLOWUP_IDENTITY_CHANGED');
      return { registered: false, reason: 'duplicate' };
    }
    const row = { schema: 1, site: 'palitra', companyCode: COMPANY, orderId, threadId, sessionId: grants[0].id,
      sessionCreatedAt: grants[0].created_at, enabledAfterUtc, dueAt, eventId: 'contact-followup:' + orderId + ':' + check.dueMs,
      state: 'waiting', registeredAt: new Date(now()).toISOString(), telegramJobId: null, pushJobs: 0 };
    write(db, key, row, now()); return { registered: true };
  }
  function tick() {
    if (!on) return { examined: 0, emitted: 0, enabled: false };
    return transaction(() => {
      const conf = read(db, CONFIG_KEY);
      if (!conf) return { examined: 0, emitted: 0, enabled: true };
      if (conf.schema !== 1 || conf.enabledAfterUtc !== enabledAfterUtc) fail('CONTACT_FOLLOWUP_CUTOFF_CHANGED');
      const rows = db.prepare(`SELECT d.key,d.body FROM documents d JOIN
        (SELECT key,MAX(version) AS version FROM documents WHERE key LIKE ? GROUP BY key) v ON v.key=d.key AND v.version=d.version
        WHERE json_extract(d.body,'$.state')='waiting' AND json_extract(d.body,'$.dueAt')<=?
        ORDER BY d.key LIMIT 50`).all(PREFIX + '%', new Date(now()).toISOString());
      let emitted = 0;
      for (const item of rows) {
        const row = read(db, item.key);
        if (item.key !== keyOf(row.orderId) || !iso(row.dueAt)) fail('CONTACT_FOLLOWUP_RECORD');
        if (now() < Date.parse(row.dueAt)) continue;
        const event = eventView(row), check = eventVerdict(db, event, now());
        if (!check.allowed) { write(db, item.key, { ...row, state: check.reason === 'answered' || check.reason === 'contact_confirmed' ? 'answered' : 'stopped', reason: check.reason }, now()); continue; }
        const result = notify(event);
        if (!result || !Number.isSafeInteger(result.pushJobs) || result.pushJobs < 0 || !(result.telegramJobId === null || idOf(result.telegramJobId))) fail('CONTACT_FOLLOWUP_NOTIFY_RESULT');
        if (!result.telegramJobId && result.pushJobs === 0) continue; // no destination: durable waiting, not false success
        write(db, item.key, { ...row, state: 'emitted', emittedAt: new Date(now()).toISOString(), ...result }, now()); emitted++;
      }
      return { examined: rows.length, emitted, enabled: true };
    });
  }
  function guardTelegram(job) {
    if (!job || !idOf(job.id)) return null;
    const rows = db.prepare(`SELECT d.body FROM documents d JOIN
      (SELECT key,MAX(version) AS version FROM documents WHERE key LIKE ? GROUP BY key) v ON v.key=d.key AND v.version=d.version
      WHERE json_extract(d.body,'$.telegramJobId')=? LIMIT 2`).all(PREFIX + '%', job.id);
    if (!rows.length) return null;
    if (rows.length !== 1) fail('CONTACT_FOLLOWUP_JOB_MAPPING');
    const row = JSON.parse(rows[0].body);
    const exact = job.kind === 'notice' && job.bot_key === 'palitra' && job.company_code === COMPANY && job.dialog_id === null && job.message_id === null;
    return { allowed: ready() && exact && eventVerdict(db, eventView(row), now()).allowed, reason: 'Уведомление без ответа остановлено: клиент ответил или связь изменилась' };
  }
  return Object.freeze({ register, tick, guardTelegram, get enabled() { return ready(); }, enabledAfterUtc: on ? enabledAfterUtc : null });
}
function createFollowupReader({ db, siteOrders, ownerStillValid, enabled = false, notificationEnabled = () => false, now = Date.now }) {
  return function readForOwner(site, orderId, owner) {
    if (site !== 'palitra' || enabled !== true || typeof ownerStillValid !== 'function' || !owner || !idOf(owner.id)
      || !Number.isSafeInteger(owner.sessionVersion) || ownerStillValid(owner.id, owner.sessionVersion) !== true) return null;
    const id = idOf(orderId), order = id ? siteOrders.orderSummary(site, id) : null;
    if (!order || order.id !== id || ['done', 'cancelled'].includes(order.work?.status)
      || typeof order.createdAt !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(order.createdAt)) return null;
    const created = Date.parse(order.createdAt), current = now();
    if (!Number.isFinite(created) || !Number.isSafeInteger(current)) return null;
    const threads = db.prepare("SELECT id FROM chat_threads WHERE site='palitra' AND company_code=? AND order_id=? LIMIT 2").all(COMPANY, id);
    if (threads.length !== 1 || !idOf(threads[0].id)) return null;
    const threadId = threads[0].id, answered = customerReplied(db, threadId);
    const event = read(db, keyOf(id)), dueAt = new Date(created + DEADLINE_MS).toISOString();
    if (ownerStillValid(owner.id, owner.sessionVersion) !== true) return null;
    return { orderRef: 'native-order:' + id, threadRef: 'thread:' + threadId, dueAt,
      state: answered ? 'answered' : event?.state === 'answered' ? 'handled' : current >= created + DEADLINE_MS ? 'due' : 'waiting', alert: !answered && current >= created + DEADLINE_MS ? ALERT : '',
      notification: { enabled: notificationEnabled() === true, registered: !!event,
        state: answered ? 'answered' : event?.state || 'not_scheduled', telegramQueued: idOf(event?.telegramJobId) !== null, pushQueued: Number(event?.pushJobs) || 0 } };
  };
}
module.exports = { createFollowupReader, createFollowupDispatcher, eventVerdict, eventView, orderUrl, contactAction, CHANNEL_LABELS, DEADLINE_MS, ALERT, PREFIX, CONFIG_KEY };
