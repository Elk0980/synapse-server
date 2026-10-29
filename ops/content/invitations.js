'use strict';

/* Приглашения с самостоятельной установкой пароля (specs/085-safe-invitations).

   Пилот: только компания palitra-love и ровно три права sites.view, price.view, price.edit, роль editor.
   Владелец (действующая сессия + CSRF) назначает логин, имя и подтверждённого получателя; сервер фиксирует
   компанию и права — запрос их не задаёт. Секрет — 32 случайных байта, в БД только SHA-256, срок 24 ч,
   однократно; повторная выдача на тот же логин отзывает прежнюю. Просмотр (preview) ничего не меняет.
   Принятие атомарно создаёт ровно одного нового пользователя штатным хешем (auth-store.create с within):
   существующий логин не перезаписывается, сессия не выдаётся — дальше обычный вход.

   Доставка — только в подтверждённый личный канал получателя (invitation_recipients), записанный
   серверным проверяющим кодом, не HTTP-запросом: произвольных chatId/to нет. Без получателя —
   recipient_unverified, без включённого канала — channel_disabled; ни то, ни другое ничего не отправляет.
   Секрет нигде не возвращается владельцу/агенту: DTO, аудит и ошибки содержат только номер и состояния. */

const crypto = require('node:crypto');

const PILOT_COMPANY = 'palitra-love';
const PILOT_PERMISSIONS = Object.freeze(['price.edit', 'price.view', 'sites.view']);
const TTL_MS = 24 * 60 * 60 * 1000;
const SECRET_BYTES = 32;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const LOGIN = /^[a-z0-9_-]{1,64}$/;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 20;

const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, ...(code ? { code } : {}) }); };
const hashSecret = (secret) => crypto.createHash('sha256').update(String(secret), 'utf8').digest('hex');

function createInvitations({ db, authStore, hashPassword, companies = {}, now = () => Date.now(),
  randomBytes = crypto.randomBytes, delivery = null, acceptOrigin = 'https://synapse.synapsebusiness.ru' }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invitation_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_code TEXT NOT NULL, display_name TEXT NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('telegram')), sender_id TEXT NOT NULL, address TEXT NOT NULL,
      verified_by TEXT NOT NULL, verified_at TEXT NOT NULL, revoked_at TEXT,
      UNIQUE(company_code, channel, sender_id, address)
    );
    CREATE TABLE IF NOT EXISTS invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_code TEXT NOT NULL, permissions TEXT NOT NULL, login TEXT NOT NULL COLLATE NOCASE, display_name TEXT NOT NULL,
      recipient_id INTEGER REFERENCES invitation_recipients(id),
      token_hash TEXT NOT NULL UNIQUE, created_by INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','revoked')),
      delivery TEXT NOT NULL CHECK(delivery IN ('recipient_unverified','channel_disabled','queued','sending','delivered','uncertain','failed','not_sent')),
      delivery_payload TEXT, delivery_message_id TEXT, delivery_error TEXT, claimed_at TEXT, delivered_at TEXT,
      accepted_user_id INTEGER, accepted_at TEXT, revoked_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS invitations_one_pending ON invitations(login) WHERE status = 'pending';
    CREATE TABLE IF NOT EXISTS invitation_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, invitation_id INTEGER NOT NULL, event TEXT NOT NULL,
      actor TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}', at TEXT NOT NULL
    );
  `);
  const stamp = (at = now()) => new Date(at).toISOString();
  const audit = (id, event, actor, details = {}) => db.prepare('INSERT INTO invitation_audit(invitation_id,event,actor,details,at) VALUES(?,?,?,?,?)')
    .run(id, event, String(actor), JSON.stringify(details), stamp());
  const tx = (callback) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const issuerAllowed = (userId) => {
    const user = authStore.getById(userId);
    return Boolean(user && user.role === 'owner');
  };

  /* --- получатели: только серверный проверяющий код (не HTTP) ---------------------------------- */
  function registerVerifiedRecipient({ company, displayName, channel, senderId, address, verifiedBy }) {
    if (company !== PILOT_COMPANY) fail(400, 'Пилот приглашений — только palitra-love');
    if (channel !== 'telegram' || !/^[1-9]\d{0,19}$/.test(String(address)) || !/^[1-9]\d{0,19}$/.test(String(senderId))) fail(400, 'Некорректный личный канал');
    if (typeof displayName !== 'string' || !displayName.trim() || !verifiedBy) fail(400, 'Нужны имя и источник проверки');
    const row = db.prepare(`INSERT INTO invitation_recipients(company_code,display_name,channel,sender_id,address,verified_by,verified_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(company_code,channel,sender_id,address) DO UPDATE SET display_name=excluded.display_name,
      verified_by=excluded.verified_by, verified_at=excluded.verified_at, revoked_at=NULL RETURNING id`)
      .get(company, displayName.trim(), channel, String(senderId), String(address), String(verifiedBy), stamp());
    return row.id;
  }
  const recipient = (id) => (id ? db.prepare('SELECT * FROM invitation_recipients WHERE id=?').get(id) || null : null);
  const recipientUsable = (r, company) => Boolean(r && !r.revoked_at && r.company_code === company);
  const channelReady = (r) => Boolean(delivery && delivery.enabled === true && delivery.key && delivery.transport
    && r && r.channel === 'telegram' && String(delivery.senderId) === r.sender_id);
  const mask = (r) => (r ? { id: r.id, displayName: r.display_name, channel: r.channel, address: `•••${String(r.address).slice(-3)}`, verified: !r.revoked_at } : null);

  /* --- шифрование транспортного payload (ключ передаётся конфигурацией; в production не задан) ---- */
  function seal(secret) {
    const iv = randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', delivery.key, iv);
    const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), body].map((part) => part.toString('base64url')).join('.');
  }
  function unseal(payload) {
    const [iv, tag, body] = String(payload).split('.').map((part) => Buffer.from(part, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', delivery.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }

  const effectiveStatus = (row) => (row.status === 'pending' && Date.parse(row.expires_at) <= now() ? 'expired' : row.status);
  const dto = (row) => ({ id: row.id, company: row.company_code, permissions: JSON.parse(row.permissions), login: row.login,
    displayName: row.display_name, status: effectiveStatus(row), delivery: row.delivery,
    recipient: mask(recipient(row.recipient_id)), createdAt: row.created_at, expiresAt: row.expires_at,
    deliveredAt: row.delivered_at || null, deliveryMessageId: row.delivery_message_id || null,
    acceptedAt: row.accepted_at || null, acceptedUserId: row.accepted_user_id || null, revokedAt: row.revoked_at || null });
  const byId = (id) => db.prepare('SELECT * FROM invitations WHERE id=?').get(id);

  /* --- владелец ----------------------------------------------------------------------------------- */
  function issue(owner, input) {
    if (!owner || owner.role !== 'owner') fail(403, 'Приглашать может только владелец');
    const keys = Object.keys(input || {}).sort().join(',');
    if (!['displayName,login', 'displayName,login,recipientId'].includes(keys)) fail(400, 'Переданы лишние или отсутствуют обязательные поля');
    const login = String(input.login), displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
    if (!LOGIN.test(login)) fail(400, 'Некорректный login');
    if (!displayName || displayName.length > 120) fail(400, 'Некорректное имя');
    if (authStore.getByLogin(login)) fail(409, 'Этот login уже занят — приглашение не меняет существующую учётную запись', 'login_taken');
    const r = input.recipientId === undefined || input.recipientId === null ? null : recipient(Number(input.recipientId));
    if (input.recipientId !== undefined && input.recipientId !== null && !recipientUsable(r, PILOT_COMPANY)) fail(404, 'Подтверждённый получатель не найден');
    const secret = randomBytes(SECRET_BYTES).toString('base64url');
    const state = !r ? 'recipient_unverified' : channelReady(r) ? 'queued' : delivery && delivery.enabled === true ? 'recipient_unverified' : 'channel_disabled';
    const id = tx(() => {
      for (const old of db.prepare("SELECT id FROM invitations WHERE login=? AND status='pending'").all(login)) {
        db.prepare("UPDATE invitations SET status='revoked', revoked_at=?, delivery=CASE WHEN delivery IN ('queued') THEN 'not_sent' ELSE delivery END, delivery_payload=NULL WHERE id=?").run(stamp(), old.id);
        audit(old.id, 'revoked', owner.id, { reason: 'reissued' });
      }
      const at = now();
      const result = db.prepare(`INSERT INTO invitations(company_code,permissions,login,display_name,recipient_id,token_hash,created_by,created_at,expires_at,delivery,delivery_payload)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(PILOT_COMPANY, JSON.stringify(PILOT_PERMISSIONS), login, displayName, r ? r.id : null,
        hashSecret(secret), owner.id, stamp(at), stamp(at + TTL_MS), state, state === 'queued' ? seal(secret) : null);
      const newId = Number(result.lastInsertRowid);
      audit(newId, 'created', owner.id, { company: PILOT_COMPANY, permissions: PILOT_PERMISSIONS, recipientId: r ? r.id : null, delivery: state });
      return newId;
    });
    // Секрет возвращается только внутреннему вызову (серверный код), HTTP-ответ его не содержит.
    return { invitation: dto(byId(id)), secret };
  }
  function list(owner) {
    if (!owner || owner.role !== 'owner') fail(403, 'Только владелец');
    return db.prepare('SELECT * FROM invitations WHERE company_code=? ORDER BY id DESC').all(PILOT_COMPANY).map(dto);
  }
  function revoke(owner, id) {
    if (!owner || owner.role !== 'owner') fail(403, 'Только владелец');
    const row = byId(Number(id));
    if (!row || row.company_code !== PILOT_COMPANY) fail(404, 'Приглашение не найдено');
    if (row.status !== 'pending') fail(409, 'Приглашение уже не действует');
    db.prepare("UPDATE invitations SET status='revoked', revoked_at=?, delivery=CASE WHEN delivery='queued' THEN 'not_sent' ELSE delivery END, delivery_payload=NULL WHERE id=? AND status='pending'").run(stamp(), row.id);
    audit(row.id, 'revoked', owner.id);
    return dto(byId(row.id));
  }

  /* --- получатель: просмотр и принятие ----------------------------------------------------------- */
  function findPending(secret) {
    if (typeof secret !== 'string' || !SECRET.test(secret)) fail(400, 'Ссылка приглашения недействительна', 'invalid');
    const row = db.prepare('SELECT * FROM invitations WHERE token_hash=?').get(hashSecret(secret));
    if (!row) fail(404, 'Ссылка приглашения недействительна', 'invalid');
    const status = effectiveStatus(row);
    if (status === 'accepted') fail(410, 'Приглашение уже использовано', 'used');
    if (status === 'revoked') fail(410, 'Приглашение отозвано', 'revoked');
    if (status === 'expired') fail(410, 'Срок приглашения истёк', 'expired');
    return row;
  }
  function preview(secret) {
    const row = findPending(secret);
    return { company: { id: row.company_code, title: companies[row.company_code]?.name || row.company_code },
      login: row.login, displayName: row.display_name, permissions: JSON.parse(row.permissions), expiresAt: row.expires_at };
  }
  function accept(secret, password) {
    const row = findPending(secret);
    if (!issuerAllowed(row.created_by)) fail(410, 'Приглашение больше не действует', 'issuer');
    const passwordHash = hashPassword(password);
    let user;
    try {
      user = authStore.create(row.created_by, { login: row.login, displayName: row.display_name, password: '-',
        companies: [row.company_code], permissions: JSON.parse(row.permissions) }, passwordHash, {
        auditSource: `invitation:${row.id}`,
        within: (userId) => {
          // Полномочия выдавшего — ещё раз внутри той же транзакции (BEGIN IMMEDIATE держит запись):
          // роль, сменённая другим подключением или триггером до этой точки, откатывает учётную запись,
          // права, аудит и погашение целиком.
          const issuer = db.prepare('SELECT role FROM auth_users WHERE id=?').get(row.created_by);
          if (!issuer || issuer.role !== 'owner') fail(410, 'Приглашение больше не действует', 'issuer');
          // Ещё раз внутри транзакции: не погашено, не отозвано, не истекло — иначе откат без учётной записи.
          const done = db.prepare(`UPDATE invitations SET status='accepted', accepted_user_id=?, accepted_at=?, delivery_payload=NULL
            WHERE id=? AND status='pending' AND expires_at>?`).run(userId, stamp(), row.id, stamp());
          if (done.changes !== 1) fail(410, 'Приглашение уже не действует', 'used');
          audit(row.id, 'accepted', `user:${userId}`, { userId });
        },
      });
    } catch (error) {
      if (error.status === 409) fail(409, 'Этот login уже занят — существующая учётная запись не изменена', 'login_taken');
      throw error;
    }
    return { ok: true, login: user.login, company: row.company_code };
  }

  /* --- HTTP ---------------------------------------------------------------------------------------- */
  const attempts = new Map();
  function limited(ip) {
    const at = now(), list = (attempts.get(ip) || []).filter((time) => at - time < RATE_WINDOW_MS);
    list.push(at); attempts.set(ip, list);
    return list.length > RATE_LIMIT;
  }
  async function handle(request, response, url, ctx) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'content') return false;
    if (parts[1] === 'admin' && parts[2] === 'invitations') {
      const session = ctx.requireSession(request);
      if (session.user.role !== 'owner') fail(403, 'Приглашать может только владелец');
      if (request.method !== 'GET') ctx.requireCsrf(request, session);
      if (request.method === 'GET' && parts.length === 3) return ctx.reply(200, { invitations: list(session.user), pilot: { company: PILOT_COMPANY, permissions: PILOT_PERMISSIONS },
        recipients: db.prepare('SELECT * FROM invitation_recipients WHERE company_code=? AND revoked_at IS NULL ORDER BY id').all(PILOT_COMPANY).map(mask),
        channel: delivery && delivery.enabled === true ? 'enabled' : 'disabled' }), true;
      if (request.method === 'POST' && parts.length === 3) return ctx.reply(201, { invitation: issue(session.user, await ctx.readJson(request)).invitation }), true;
      if (request.method === 'POST' && parts.length === 5 && parts[4] === 'revoke') return ctx.reply(200, { invitation: revoke(session.user, parts[3]) }), true;
      fail(404, 'Не найдено');
    }
    if (parts[1] === 'invitations' && parts.length === 3 && ['preview', 'accept'].includes(parts[2])) {
      if (request.method !== 'POST') fail(405, 'Только POST');
      // Публичная страница принятия: только с утверждённого адреса кабинета, только JSON, с ограничением частоты.
      if (String(request.headers.origin || '') !== acceptOrigin) fail(403, 'Запрос не с адреса кабинета');
      if (!String(request.headers['content-type'] || '').startsWith('application/json')) fail(415, 'Ожидался JSON');
      if (limited(ctx.clientIp(request))) fail(429, 'Слишком много попыток, подождите 10 минут');
      const body = await ctx.readJson(request);
      const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
      if (parts[2] === 'preview') return ctx.reply(200, preview(body && body.token), headers), true;
      return ctx.reply(201, accept(body && body.token, body && body.password), headers), true;
    }
    return false;
  }

  return { PILOT_COMPANY, PILOT_PERMISSIONS, registerVerifiedRecipient, issue, list, revoke, preview, accept, handle,
    seal: (s) => seal(s), unseal: (p) => unseal(p), channelReady, recipient, recipientUsable, issuerAllowed, byId, audit, stamp, effectiveStatus };
}

module.exports = { createInvitations, PILOT_COMPANY, PILOT_PERMISSIONS, hashSecret };
