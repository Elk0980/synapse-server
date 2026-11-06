'use strict';

// Per-staff read state only. Existing orders/messages, workflow and shared legacy unread are never changed.
const COMPANY = 'palitra-love';
const SITE = 'palitra';
const SCHEMA = 'palitra-order-unread/v1';
const TABLE = 'palitra_staff_message_reads_v1';
const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS palitra_staff_message_reads_v1 (
  company_code TEXT NOT NULL CHECK(company_code='palitra-love'),
  actor_user_id INTEGER NOT NULL CHECK(actor_user_id>0),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('thread','legacy')),
  target_id INTEGER NOT NULL CHECK(target_id>0),
  through_message_id INTEGER NOT NULL CHECK(through_message_id>0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(company_code,actor_user_id,source_kind,target_id)
) WITHOUT ROWID`;
const positive = n => Number.isSafeInteger(n) && n > 0;
const object = n => n && typeof n === 'object' && !Array.isArray(n);
function fail(status, code, message) { throw Object.assign(new Error(message), { status, code }); }
function schemaReady(db) {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(TABLE);
  if (!row) fail(503, 'UNREAD_NOT_READY', 'Счётчик сообщений пока недоступен');
  const normalize = value => String(value).replace(/\bIF\s+NOT\s+EXISTS\s+/i, '').replace(/\s+/g, '').toLowerCase();
  if (normalize(row.sql) !== normalize(SCHEMA_SQL)) fail(503, 'UNREAD_SCHEMA', 'Счётчик сообщений пока недоступен');
}
// Explicit installation/migration primitive. Never called by a read, ack, or HTTP factory.
function initializeReadStateSchema(db) {
  if (!db || typeof db.exec !== 'function') throw new TypeError('SQLite database required');
  db.exec(SCHEMA_SQL);
  schemaReady(db);
  return { schema: SCHEMA, table: TABLE, businessRowsChanged: 0 };
}
function createPalitraOrderReadState({ db, transaction, getUser, canAccess, now = Date.now } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof transaction !== 'function' || typeof getUser !== 'function' || typeof canAccess !== 'function' || typeof now !== 'function')
    throw new TypeError('Existing Palitra host authentication and transaction required');
  function actor(who) {
    if (!object(who) || !positive(who.id) || !Number.isSafeInteger(who.sessionVersion)) fail(403, 'UNREAD_ACCESS', 'Требуется действующая сессия');
    const user = getUser(who.id);
    if (!user || user.id !== who.id || user.sessionVersion !== who.sessionVersion || canAccess(user, 'crm.view') !== true)
      fail(403, 'UNREAD_ACCESS', 'Доступ к заказам изменился');
    return user.id;
  }
  const at = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) fail(503, 'UNREAD_CLOCK', 'Счётчик сообщений временно недоступен');
    return new Date(value).toISOString();
  };
  function parseAck(body) {
    if (!object(body) || Object.keys(body).sort().join(',') !== 'id,kind,throughMessageId'
      || !['thread', 'legacy'].includes(body.kind) || !positive(body.id) || !positive(body.throughMessageId))
      fail(400, 'UNREAD_ACK', 'Некорректное подтверждение прочтения');
    return body;
  }
  function target(kind, id) {
    const row = kind === 'thread'
      ? db.prepare('SELECT id FROM chat_threads WHERE id=? AND site=? AND company_code=?').get(id, SITE, COMPANY)
      : db.prepare('SELECT id FROM client_dialogs WHERE id=? AND company_code=?').get(id, COMPANY);
    if (!row) fail(404, 'UNREAD_TARGET', 'Переписка не найдена');
  }
  function incoming(kind, id, messageId) {
    const row = kind === 'thread'
      ? db.prepare(`SELECT m.id FROM chat_thread_messages m JOIN chat_threads t ON t.id=m.thread_id
          WHERE m.id=? AND t.id=? AND t.site=? AND t.company_code=? AND m.direction='in' AND m.author_kind='customer'`)
        .get(messageId, id, SITE, COMPANY)
      : db.prepare(`SELECT m.id FROM client_dialog_messages m JOIN client_dialogs d ON d.id=m.dialog_id
          WHERE m.id=? AND d.id=? AND d.company_code=? AND m.company_code=d.company_code AND m.bot_key=d.bot_key
            AND m.direction='in' AND m.author_type='client'`).get(messageId, id, COMPANY);
    if (!row) fail(409, 'UNREAD_MESSAGE', 'Подтверждаемое сообщение не найдено в этой переписке');
  }
  function remaining(kind, id, through) {
    const row = kind === 'thread'
      ? db.prepare(`SELECT COUNT(*) AS n FROM chat_thread_messages m JOIN chat_threads t ON t.id=m.thread_id
          WHERE t.id=? AND t.site=? AND t.company_code=? AND m.direction='in' AND m.author_kind='customer' AND m.id>?`)
        .get(id, SITE, COMPANY, through)
      : db.prepare(`SELECT COUNT(*) AS n FROM client_dialog_messages m JOIN client_dialogs d ON d.id=m.dialog_id
          WHERE d.id=? AND d.company_code=? AND m.company_code=d.company_code AND m.bot_key=d.bot_key
            AND m.direction='in' AND m.author_type='client' AND m.id>?`).get(id, COMPANY, through);
    if (!row || !Number.isSafeInteger(row.n) || row.n < 0) fail(503, 'UNREAD_COUNT', 'Счётчик сообщений временно недоступен');
    return row.n;
  }
  function summary(who) {
    const userId = actor(who); schemaReady(db); const asOf = at();
    const rows = db.prepare(`
      SELECT 'thread' AS kind,t.id,t.order_id,
        CASE WHEN o.id IS NULL THEN 'thread:'||t.id ELSE 'order:'||o.id END AS ref,COUNT(m.id) AS n
      FROM chat_threads t
      JOIN chat_thread_messages m ON m.thread_id=t.id AND m.direction='in' AND m.author_kind='customer'
      LEFT JOIN site_orders o ON o.id=t.order_id AND o.site=? AND o.company_code=?
      LEFT JOIN palitra_staff_message_reads_v1 r ON r.company_code=? AND r.actor_user_id=? AND r.source_kind='thread' AND r.target_id=t.id
      WHERE t.site=? AND t.company_code=? AND m.id>COALESCE(r.through_message_id,0)
      GROUP BY t.id,t.order_id,o.id
      UNION ALL
      SELECT 'legacy' AS kind,d.id,d.order_id,
        CASE WHEN o.id IS NULL THEN 'legacy:'||d.id ELSE 'order:'||o.id END AS ref,COUNT(m.id) AS n
      FROM client_dialogs d
      JOIN client_dialog_messages m ON m.dialog_id=d.id AND m.company_code=d.company_code AND m.bot_key=d.bot_key
        AND m.direction='in' AND m.author_type='client'
      LEFT JOIN site_orders o ON o.id=d.order_id AND o.site=? AND o.company_code=?
      LEFT JOIN palitra_staff_message_reads_v1 r ON r.company_code=? AND r.actor_user_id=? AND r.source_kind='legacy' AND r.target_id=d.id
      WHERE d.company_code=? AND m.id>COALESCE(r.through_message_id,0)
      GROUP BY d.id,d.order_id,o.id`)
      .all(SITE, COMPANY, COMPANY, userId, SITE, COMPANY, SITE, COMPANY, COMPANY, userId, COMPANY);
    const grouped = new Map(); let unreadMessages = 0;
    for (const row of rows) {
      if (!Number.isSafeInteger(row.n) || row.n < 1 || !/^(order|thread|legacy):[1-9]\d*$/.test(row.ref)) fail(503, 'UNREAD_COUNT', 'Счётчик сообщений временно недоступен');
      const value = (grouped.get(row.ref) || 0) + row.n;
      unreadMessages += row.n;
      if (!Number.isSafeInteger(value) || !Number.isSafeInteger(unreadMessages)) fail(503, 'UNREAD_COUNT', 'Счётчик сообщений временно недоступен');
      grouped.set(row.ref, value);
    }
    actor(who);
    return { schema: SCHEMA, companyCode: COMPANY, asOf, unreadMessages,
      items: [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([ref, unreadMessages]) => ({ ref, unreadMessages })) };
  }
  function acknowledge(who, body) {
    const input = parseAck(body); actor(who);
    return transaction(() => {
      const userId = actor(who); schemaReady(db);
      target(input.kind, input.id); incoming(input.kind, input.id, input.throughMessageId);
      const stamp = at();
      db.prepare(`INSERT INTO palitra_staff_message_reads_v1(company_code,actor_user_id,source_kind,target_id,through_message_id,updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(company_code,actor_user_id,source_kind,target_id) DO UPDATE SET
        through_message_id=MAX(palitra_staff_message_reads_v1.through_message_id,excluded.through_message_id),
        updated_at=CASE WHEN excluded.through_message_id>palitra_staff_message_reads_v1.through_message_id THEN excluded.updated_at ELSE palitra_staff_message_reads_v1.updated_at END`)
        .run(COMPANY, userId, input.kind, input.id, input.throughMessageId, stamp);
      const stored = db.prepare(`SELECT through_message_id FROM palitra_staff_message_reads_v1
        WHERE company_code=? AND actor_user_id=? AND source_kind=? AND target_id=?`).get(COMPANY, userId, input.kind, input.id);
      const unreadMessages = remaining(input.kind, input.id, stored.through_message_id);
      actor(who);
      return { ok: true, schema: SCHEMA, companyCode: COMPANY, kind: input.kind, id: input.id,
        throughMessageId: stored.through_message_id, unreadMessages };
    });
  }
  return Object.freeze({ summary, acknowledge, authorize: actor });
}
module.exports = { createPalitraOrderReadState, initializeReadStateSchema, SCHEMA_SQL, SCHEMA, TABLE };
