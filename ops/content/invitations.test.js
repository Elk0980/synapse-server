'use strict';

/* Приглашения (specs/085): хранилище, права, принятие, доставка на синтетическом транспорте.
   Все люди, каналы, ключи и пароли синтетические. node --test ops/content/invitations.test.js */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore, COMPANIES } = require('./auth-store');
const { hashPassword, verifyPassword } = require('./passwords');
const { createInvitations, hashSecret } = require('./invitations');
const { createInvitationDelivery, LEASE_MS } = require('./invitation-delivery');

const OWNER_HASH = hashPassword('owner-synthetic-password');
const PASSWORD = 'synthetic-password-42';
const BOT = '700000001', CHAT = '500000777';

function setup({ channel = true, transport } = {}) {
  const db = new DatabaseSync(':memory:');
  const auth = createAuthStore(db, `owner:owner:${OWNER_HASH}`);
  const clock = { at: Date.parse('2026-10-02T12:00:00Z') };
  const sent = [];
  const delivery = channel ? { enabled: true, key: crypto.randomBytes(32), senderId: BOT, acceptUrl: 'https://cabinet.test/accept-invitation.html',
    transport: transport || { send: async (message) => { sent.push(message); return { messageId: String(9000 + sent.length), address: message.address }; } } } : null;
  const inv = createInvitations({ db, authStore: auth, hashPassword, companies: COMPANIES, now: () => clock.at, delivery });
  const worker = createInvitationDelivery({ db, invitations: inv, delivery, now: () => clock.at });
  const owner = auth.getByLogin('owner');
  const recipientId = () => inv.registerVerifiedRecipient({ company: 'palitra-love', displayName: 'Синтетическая Варя', channel: 'telegram', senderId: BOT, address: CHAT, verifiedBy: 'test-verifier' });
  return { db, auth, inv, worker, owner, clock, sent, delivery, recipientId };
}
const secretFrom = (message) => /#invite=([A-Za-z0-9_-]{43})$/.exec(message.text)[1];
const users = (db) => db.prepare('SELECT count(*) n FROM auth_users').get().n;
const status = (value, code) => (error) => { assert.equal(error.status, value, error.message); if (code) assert.equal(error.code, code); return true; };
const dump = (db) => JSON.stringify([db.prepare('SELECT * FROM invitation_audit').all(), db.prepare('SELECT * FROM auth_audit').all()]);

test('владелец: компания и три права фиксированы сервером; лишние поля, не-владелец, занятый логин отклоняются без записей', () => {
  const { inv, auth, owner, db } = setup();
  const editor = auth.create(owner.id, { login: 'editor1', displayName: 'Редактор', password: '-', companies: ['palitra-love'], permissions: ['price.view'] }, hashPassword(PASSWORD));
  assert.throws(() => inv.issue(editor, { login: 'newbie', displayName: 'Новичок' }), status(403));
  for (const extra of [{ permissions: ['account.edit'] }, { companies: ['alvi'] }, { chatId: '1' }, { to: 'x@y' }, { role: 'owner' }]) {
    assert.throws(() => inv.issue(owner, { login: 'newbie', displayName: 'Новичок', ...extra }), status(400), JSON.stringify(extra));
  }
  assert.throws(() => inv.issue(owner, { login: 'editor1', displayName: 'Захват' }), status(409, 'login_taken'), 'существующая учётная запись не перевыпускается');
  assert.throws(() => inv.issue(owner, { login: 'newbie', displayName: 'Новичок', recipientId: 999 }), status(404));
  assert.equal(db.prepare('SELECT count(*) n FROM invitations').get().n, 0);
  const { invitation, secret } = inv.issue(owner, { login: 'newbie', displayName: 'Новичок' });
  assert.deepEqual([invitation.company, invitation.permissions, invitation.status, invitation.delivery], ['palitra-love', ['price.edit', 'price.view', 'sites.view'], 'pending', 'recipient_unverified']);
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/, '32 случайных байта');
  assert.ok(!JSON.stringify(invitation).includes(secret) && !JSON.stringify(inv.list(owner)).includes(secret), 'секрета нет в DTO');
  assert.equal(db.prepare('SELECT token_hash FROM invitations').get().token_hash, hashSecret(secret), 'в БД только SHA-256');
  assert.ok(!dump(db).includes(secret));
  assert.equal(Date.parse(invitation.expiresAt) - Date.parse(invitation.createdAt), 24 * 3600 * 1000);
});

test('просмотр ничего не погашает; неверный, отозванный, истёкший и повторно выданный секрет не создают учётную запись', () => {
  const { inv, owner, db, clock } = setup();
  const first = inv.issue(owner, { login: 'newbie', displayName: 'Новичок' });
  for (let i = 0; i < 3; i++) assert.equal(inv.preview(first.secret).login, 'newbie');
  assert.equal(inv.list(owner)[0].status, 'pending');
  assert.throws(() => inv.accept('x'.repeat(43), PASSWORD), status(404, 'invalid'));
  assert.throws(() => inv.accept('short', PASSWORD), status(400, 'invalid'));
  const second = inv.issue(owner, { login: 'newbie', displayName: 'Новичок' });
  assert.throws(() => inv.preview(first.secret), status(410, 'revoked'), 'повторная выдача отзывает прежнюю ссылку');
  inv.revoke(owner, second.invitation.id);
  assert.throws(() => inv.accept(second.secret, PASSWORD), status(410, 'revoked'));
  const third = inv.issue(owner, { login: 'newbie', displayName: 'Новичок' });
  clock.at += 24 * 3600 * 1000;
  assert.throws(() => inv.accept(third.secret, PASSWORD), status(410, 'expired'));
  assert.equal(users(db), 1, 'только владелец');
});

test('принятие: ровно один пользователь editor, только palitra-love и три права, штатный хеш; повтор и занятый логин ничего не меняют', () => {
  const { inv, auth, owner, db } = setup();
  const { secret, invitation } = inv.issue(owner, { login: 'newbie', displayName: 'Новичок' });
  assert.throws(() => inv.accept(secret, 'short'), status(400), 'пароль короче 12 — отказ, приглашение цело');
  assert.equal(inv.accept(secret, PASSWORD).login, 'newbie');
  assert.throws(() => inv.accept(secret, PASSWORD), status(410, 'used'), 'повтор той же ссылки');
  const user = auth.getByLogin('newbie');
  assert.deepEqual([user.role, user.companyCodes, [...user.permissions].sort()], ['editor', ['palitra-love'], ['price.edit', 'price.view', 'sites.view']]);
  assert.ok(verifyPassword(PASSWORD, user.passwordHash), 'штатная проверка пароля');
  assert.equal(users(db), 2);
  assert.equal(inv.list(owner)[0].status, 'accepted');
  assert.equal(inv.list(owner)[0].acceptedUserId, user.id);
  assert.ok(!dump(db).includes(secret) && !dump(db).includes(PASSWORD));
  // Логин заняли после выдачи: существующая учётная запись не меняется, приглашение остаётся действующим.
  const other = inv.issue(owner, { login: 'second', displayName: 'Второй' });
  const taken = auth.create(owner.id, { login: 'second', displayName: 'Чужой', password: '-', companies: ['alvi'], permissions: [] }, hashPassword('other-synthetic-pass'));
  assert.throws(() => inv.accept(other.secret, PASSWORD), status(409, 'login_taken'));
  const after = auth.getById(taken.id);
  assert.deepEqual([after.displayName, after.companyCodes, after.passwordHash], ['Чужой', ['alvi'], taken.passwordHash]);
  assert.equal(invitation.id, 1);
});

test('атомарность: сбой внутри транзакции и потеря полномочий выдавшего — ноль частичных учётных записей', () => {
  const { inv, owner, db } = setup();
  const { secret, invitation } = inv.issue(owner, { login: 'newbie', displayName: 'Новичок' });
  // Отзыв «в середине» принятия (триггер срабатывает после вставки пользователя): всё откатывается.
  db.exec(`CREATE TEMP TRIGGER revoke_midway BEFORE INSERT ON auth_user_permissions BEGIN
    UPDATE invitations SET status='revoked' WHERE id=${invitation.id}; END`);
  assert.throws(() => inv.accept(secret, PASSWORD), status(410));
  db.exec('DROP TRIGGER revoke_midway');
  assert.equal(users(db), 1);
  assert.equal(db.prepare('SELECT count(*) n FROM auth_user_permissions').get().n, 0);
  assert.equal(inv.list(owner)[0].status, 'pending', 'откат вернул и приглашение');
  // Выдавший больше не владелец — принятие отклоняется.
  db.prepare('UPDATE invitations SET created_by=999 WHERE id=?').run(invitation.id);
  assert.throws(() => inv.accept(secret, PASSWORD), status(410, 'issuer'));
  assert.equal(users(db), 1);
});

test('полномочия выдавшего внутри транзакции: роль снята после вставки пользователя (триггер) — откат аккаунта, прав, аудита и погашения', () => {
  const { inv, owner, db } = setup();
  const { secret, invitation } = inv.issue(owner, { login: 'newbie', displayName: 'Новичок' });
  const counts = () => ['auth_users', 'auth_user_companies', 'auth_user_permissions', 'auth_audit']
    .map((table) => db.prepare(`SELECT count(*) n FROM ${table}`).get().n);
  const before = counts();
  // Как в воспроизведении root: AFTER INSERT на auth_users снимает роль владельца в той же транзакции.
  db.exec(`CREATE TEMP TRIGGER demote_issuer AFTER INSERT ON auth_users BEGIN
    UPDATE auth_users SET role='editor' WHERE id=${owner.id}; END`);
  assert.throws(() => inv.accept(secret, PASSWORD), status(410, 'issuer'));
  db.exec('DROP TRIGGER demote_issuer');
  assert.deepEqual(counts(), before, 'ни пользователя, ни прав, ни аудита');
  assert.equal(db.prepare('SELECT role FROM auth_users WHERE id=?').get(owner.id).role, 'owner', 'откатилась и смена роли из триггера');
  assert.equal(inv.list(owner)[0].status, 'pending');
  assert.equal(db.prepare("SELECT count(*) n FROM invitation_audit WHERE event='accepted'").get().n, 0);
  assert.equal(inv.accept(secret, PASSWORD).login, 'newbie', 'при сохранённой роли то же приглашение принимается');
  assert.equal(invitation.id, 1);
});

test('конкурентные подключения к одной базе: роль выдавшего снята другим подключением после предпроверки — отказ; двойное принятие — один пользователь', () => {
  const file = require('node:path').join(require('node:os').tmpdir(), `invitations-race-${process.pid}-${Date.now()}.sqlite`);
  try {
    const dbA = new DatabaseSync(file), dbB = new DatabaseSync(file);
    dbB.exec('PRAGMA busy_timeout = 2000');
    const authA = createAuthStore(dbA, `owner:owner:${OWNER_HASH}`);
    const invA = createInvitations({ db: dbA, authStore: authA, hashPassword, companies: COMPANIES });
    const owner = authA.getByLogin('owner');
    const first = invA.issue(owner, { login: 'racer', displayName: 'Гонка' });
    // Подключение B снимает роль между предпроверкой (вне транзакции) и транзакцией создания в A.
    const create = authA.create.bind(authA);
    authA.create = (...args) => { dbB.prepare("UPDATE auth_users SET role='editor' WHERE id=?").run(owner.id); return create(...args); };
    assert.throws(() => invA.accept(first.secret, PASSWORD), status(410, 'issuer'));
    assert.equal(dbA.prepare("SELECT count(*) n FROM auth_users WHERE login='racer'").get().n, 0);
    assert.equal(dbA.prepare('SELECT status FROM invitations WHERE id=?').get(first.invitation.id).status, 'pending');
    authA.create = create;
    dbB.prepare("UPDATE auth_users SET role='owner' WHERE id=?").run(owner.id);
    // Двойное принятие одной ссылки из двух подключений: ровно один пользователь, второй — 410/409.
    const authB = createAuthStore(dbB, '');
    const invB = createInvitations({ db: dbB, authStore: authB, hashPassword, companies: COMPANIES });
    assert.equal(invA.accept(first.secret, PASSWORD).login, 'racer');
    assert.throws(() => invB.accept(first.secret, PASSWORD), (error) => [409, 410].includes(error.status));
    assert.equal(dbB.prepare("SELECT count(*) n FROM auth_users WHERE login='racer'").get().n, 1);
    dbA.close(); dbB.close();
  } finally { for (const suffix of ['', '-wal', '-shm', '-journal']) { try { require('node:fs').rmSync(file + suffix); } catch { /* нет */ } } }
});

test('доставка: только подтверждённый получатель и включённый канал; одно взятие, message_id, payload зашифрован и стирается', async () => {
  const { inv, owner, db, worker, sent, recipientId } = setup();
  const unverified = inv.issue(owner, { login: 'nobody', displayName: 'Без канала' });
  assert.equal(unverified.invitation.delivery, 'recipient_unverified');
  const { invitation, secret } = inv.issue(owner, { login: 'newbie', displayName: 'Новичок', recipientId: recipientId() });
  assert.equal(invitation.delivery, 'queued');
  const payload = db.prepare('SELECT delivery_payload p FROM invitations WHERE id=?').get(invitation.id).p;
  assert.ok(payload && !payload.includes(secret), 'секрет в очереди только в зашифрованном виде');
  assert.deepEqual(await worker.tick(), { id: invitation.id, delivery: 'delivered' });
  assert.equal(await worker.tick(), null, 'второго взятия нет');
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].channel, sent[0].senderId, sent[0].address], ['telegram', BOT, CHAT]);
  assert.equal(secretFrom(sent[0]), secret);
  const row = db.prepare('SELECT * FROM invitations WHERE id=?').get(invitation.id);
  assert.deepEqual([row.delivery, row.delivery_message_id, row.delivery_payload, row.status], ['delivered', '9001', null, 'pending'], 'доставлено ≠ принято');
  assert.equal(inv.list(owner).find((x) => x.id === invitation.id).recipient.address, '•••777', 'адрес маскирован');
  assert.ok(!dump(db).includes(secret));
});

test('доставка: отзыв до отправки, отозванный получатель, выключенный канал, потеря полномочий — ни одной отправки', async () => {
  const a = setup();
  const r1 = a.inv.issue(a.owner, { login: 'one', displayName: 'Один', recipientId: a.recipientId() });
  a.inv.revoke(a.owner, r1.invitation.id);
  assert.equal(await a.worker.tick(), null);
  assert.equal(a.inv.list(a.owner)[0].delivery, 'not_sent');
  const r2 = a.inv.issue(a.owner, { login: 'two', displayName: 'Два', recipientId: a.recipientId() });
  a.db.prepare('UPDATE invitation_recipients SET revoked_at=?').run('2026-10-02T12:00:00Z');
  assert.deepEqual(await a.worker.tick(), { id: r2.invitation.id, delivery: 'recipient_unverified' });
  const r3 = a.inv.issue(a.owner, { login: 'three', displayName: 'Три', recipientId: a.inv.registerVerifiedRecipient({ company: 'palitra-love', displayName: 'Тр', channel: 'telegram', senderId: BOT, address: '500000778', verifiedBy: 't' }) });
  a.db.prepare('UPDATE invitations SET created_by=999 WHERE id=?').run(r3.invitation.id);
  assert.deepEqual(await a.worker.tick(), { id: r3.invitation.id, delivery: 'not_sent' });
  assert.equal(a.sent.length, 0);
  // Канал выключен (production по умолчанию): даже подтверждённый получатель — channel_disabled, очереди нет.
  const b = setup({ channel: false });
  const r4 = b.inv.issue(b.owner, { login: 'four', displayName: 'Четыре', recipientId: b.recipientId() });
  assert.equal(r4.invitation.delivery, 'channel_disabled');
  assert.equal(await b.worker.tick(), null);
  // Получатель другого отправителя (бота) при включённом канале — recipient_unverified.
  const c = setup();
  const foreign = c.inv.registerVerifiedRecipient({ company: 'palitra-love', displayName: 'Чужой бот', channel: 'telegram', senderId: '700000002', address: CHAT, verifiedBy: 't' });
  assert.equal(c.inv.issue(c.owner, { login: 'five', displayName: 'Пять', recipientId: foreign }).invitation.delivery, 'recipient_unverified');
  assert.throws(() => c.inv.registerVerifiedRecipient({ company: 'alvi', displayName: 'X', channel: 'telegram', senderId: BOT, address: CHAT, verifiedBy: 't' }), status(400));
});

test('доставка: неизвестный исход и перезапуск после аренды — uncertain без повтора и без новой ссылки', async () => {
  let calls = 0;
  const a = setup({ transport: { send: async () => { calls += 1; throw new Error('обрыв связи'); } } });
  a.inv.issue(a.owner, { login: 'one', displayName: 'Один', recipientId: a.recipientId() });
  assert.equal((await a.worker.tick()).delivery, 'uncertain');
  assert.equal(await a.worker.tick(), null);
  assert.equal(calls, 1);
  assert.equal(a.db.prepare('SELECT delivery_payload p FROM invitations').get().p, null, 'секрет стёрт');
  // «Перезапуск»: задание осталось sending после падения процесса — после аренды uncertain, отправки нет.
  const b = setup();
  const { invitation } = b.inv.issue(b.owner, { login: 'two', displayName: 'Два', recipientId: b.recipientId() });
  b.db.prepare("UPDATE invitations SET delivery='sending', claimed_at=? WHERE id=?").run(new Date(b.clock.at).toISOString(), invitation.id);
  const restarted = createInvitationDelivery({ db: b.db, invitations: b.inv, delivery: b.delivery, now: () => b.clock.at });
  assert.equal(await restarted.tick(), null);
  b.clock.at += LEASE_MS + 1;
  await restarted.tick();
  assert.equal(b.inv.list(b.owner)[0].delivery, 'uncertain');
  assert.equal(b.sent.length, 0);
  // Ответ транспорта без message_id или про другой адрес — не доставлено.
  const c = setup({ transport: { send: async () => ({ messageId: '77', address: '999' }) } });
  c.inv.issue(c.owner, { login: 'three', displayName: 'Три', recipientId: c.recipientId() });
  assert.equal((await c.worker.tick()).delivery, 'uncertain');
});

test('полный путь на синтетическом транспорте: доставка → просмотр → принятие → штатная проверка пароля', async () => {
  const { inv, owner, worker, sent, auth, recipientId } = setup();
  inv.issue(owner, { login: 'newbie', displayName: 'Новичок', recipientId: recipientId() });
  await worker.tick();
  const secret = secretFrom(sent[0]);
  assert.equal(inv.preview(secret).company.title, 'Palitra');
  inv.accept(secret, PASSWORD);
  assert.ok(verifyPassword(PASSWORD, auth.getByLogin('newbie').passwordHash));
  const row = inv.list(owner)[0];
  assert.deepEqual([row.status, row.delivery, row.deliveryMessageId], ['accepted', 'delivered', '9001']);
});
