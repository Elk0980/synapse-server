'use strict';

/* Приглашения на живом сервисе content (specs/085): HTTP владельца и публичные маршруты, штатный вход.
   В production-сборке канал выключен — приглашение через HTTP остаётся recipient_unverified и ничего не
   отправляет. Синтетическая доставка выполняется в процессе теста над той же базой: подтверждённый
   получатель, синтетический ключ и транспорт; ссылка из «сообщения» принимается через HTTP сервера.
   node --test ops/content/invitations-http.test.js */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./passwords');
const { createAuthStore, COMPANIES } = require('./auth-store');
const { createInvitations } = require('./invitations');
const { createInvitationDelivery } = require('./invitation-delivery');

const ORIGIN = 'https://synapse.synapsebusiness.ru';
const PASSWORD = 'synthetic-invited-pass-1';

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('HTTP: владелец/CSRF/подмена прав, канал выключен; синтетическая доставка → просмотр → принятие → обычный вход → только Palitra', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invitations-http-'));
  const ownerSecret = crypto.randomBytes(18).toString('hex');
  const port = await freePort();
  const database = path.join(dir, 'db.sqlite');
  const logs = [];
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: database, ASSETS_DIR: path.join(dir, 'assets'),
      SEED_DIR: path.join(__dirname, 'seed'), API_KEY: '', AUTH_USERS: `owner:owner:${hashPassword(ownerSecret)}`,
      SESSION_SECRET: crypto.randomBytes(32).toString('hex') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));
  t.after(() => { child.kill('SIGKILL'); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* временный каталог */ } });
  const base = `http://127.0.0.1:${port}`;
  const req = (url, session, method = 'GET', body, headers = {}) => fetch(base + url, { method,
    headers: { ...(session ? { cookie: session.cookie, ...(session.csrf ? { 'X-CSRF-Token': session.csrf } : {}) } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let ready = false;
  for (let attempt = 0; attempt < 200 && !ready; attempt++) {
    try { ready = (await req('/health')).ok; } catch { /* поднимается */ }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(ready);
  const login = async (name, secret) => {
    const response = await req('/content/login', null, 'POST', { login: name, password: secret });
    if (response.status !== 200) return { status: response.status };
    const cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: 200, cookie, csrf: (await (await req('/content/whoami', { cookie })).json()).csrfToken };
  };
  const owner = await login('owner', ownerSecret);
  const pub = (kind, body, origin = ORIGIN) => req(`/content/invitations/${kind}`, null, 'POST', body, origin ? { Origin: origin } : {});

  // Владелец: CSRF, лишние поля (права/компания/адресат) — отказ без записей; канал выключен.
  assert.equal((await req('/content/admin/invitations', { cookie: owner.cookie }, 'POST', { login: 'newbie', displayName: 'Новичок' })).status, 403);
  for (const extra of [{ permissions: ['account.edit'] }, { companies: ['alvi'] }, { chatId: '1' }]) {
    assert.equal((await req('/content/admin/invitations', owner, 'POST', { login: 'newbie', displayName: 'Новичок', ...extra })).status, 400);
  }
  const created = await req('/content/admin/invitations', owner, 'POST', { login: 'plain', displayName: 'Без канала' });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.deepEqual([createdBody.invitation.delivery, createdBody.invitation.permissions], ['recipient_unverified', ['price.edit', 'price.view', 'sites.view']]);
  assert.deepEqual(Object.keys(createdBody), ['invitation'], 'ответ владельцу — только DTO');
  assert.deepEqual(Object.keys(createdBody.invitation).filter((key) => /token|secret|hash|payload|link/i.test(key)), []);
  const strings = []; JSON.stringify(createdBody, (key, value) => { if (typeof value === 'string') strings.push(value); return value; });
  assert.deepEqual(strings.filter((value) => /^[A-Za-z0-9_-]{43}$/.test(value) || /^[0-9a-f]{64}$/.test(value)), [], 'ни секрета, ни его хеша');
  let listed = await (await req('/content/admin/invitations', owner)).json();
  assert.equal(listed.channel, 'disabled', 'production-сборка без канала доставки');
  // Не-владелец не видит и не создаёт приглашения.
  const editorSecret = crypto.randomBytes(12).toString('hex');
  assert.equal((await req('/content/admin/accounts', owner, 'POST', { login: 'qa_editor', displayName: 'QA', password: editorSecret, companies: ['palitra-love'], permissions: ['price.view'] })).status, 201);
  const editor = await login('qa_editor', editorSecret);
  assert.equal((await req('/content/admin/invitations', editor)).status, 403);
  assert.equal((await req('/content/admin/invitations', editor, 'POST', { login: 'x1', displayName: 'X' })).status, 403);

  // Синтетическая доставка в процессе теста над той же базой.
  const db = new DatabaseSync(database);
  db.exec('PRAGMA busy_timeout = 5000');
  const auth = createAuthStore(db, '');
  const sent = [];
  const delivery = { enabled: true, key: crypto.randomBytes(32), senderId: '700000001', acceptUrl: `${ORIGIN}/accept-invitation.html`,
    transport: { send: async (message) => { sent.push(message); return { messageId: '4242', address: message.address }; } } };
  const local = createInvitations({ db, authStore: auth, hashPassword, companies: COMPANIES, delivery });
  const recipientId = local.registerVerifiedRecipient({ company: 'palitra-love', displayName: 'Синтетический получатель', channel: 'telegram', senderId: '700000001', address: '500000777', verifiedBy: 'synthetic-verifier' });
  const issued = local.issue(auth.getByLogin('owner'), { login: 'newbie', displayName: 'Новичок', recipientId });
  assert.equal((await createInvitationDelivery({ db, invitations: local, delivery }).tick()).delivery, 'delivered');
  const secret = /#invite=([A-Za-z0-9_-]{43})$/.exec(sent[0].text)[1];
  assert.equal(secret, issued.secret);

  // Публичные маршруты: только Origin кабинета и JSON; просмотр не погашает.
  assert.equal((await pub('preview', { token: secret }, 'https://evil.example')).status, 403);
  assert.equal((await pub('preview', { token: secret }, null)).status, 403);
  assert.equal((await req('/content/invitations/preview', null, 'GET')).status, 405);
  for (let i = 0; i < 2; i++) {
    const preview = await pub('preview', { token: secret });
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('cache-control'), 'no-store');
    assert.equal(preview.headers.get('referrer-policy'), 'no-referrer');
    assert.deepEqual(await preview.json(), { company: { id: 'palitra-love', title: 'Palitra' }, login: 'newbie', displayName: 'Новичок',
      permissions: ['price.edit', 'price.view', 'sites.view'], expiresAt: issued.invitation.expiresAt });
  }
  listed = await (await req('/content/admin/invitations', owner)).json();
  assert.deepEqual(listed.invitations.filter((x) => x.login === 'newbie').map((x) => [x.status, x.delivery, x.deliveryMessageId]), [['pending', 'delivered', '4242']]);
  assert.ok(!JSON.stringify(listed).includes(secret));

  // Принятие: короткий пароль — отказ; затем один успех; повтор — 410; вход до принятия невозможен.
  assert.equal((await login('newbie', PASSWORD)).status, 401);
  assert.equal((await pub('accept', { token: secret, password: 'short' })).status, 400);
  const accepted = await pub('accept', { token: secret, password: PASSWORD });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.headers.get('set-cookie'), null, 'сессия автоматически не выдаётся');
  assert.equal((await pub('accept', { token: secret, password: PASSWORD })).status, 410);

  // Обычный вход и ровно три права в одной компании; администрирование и чужие компании закрыты.
  const invited = await login('newbie', PASSWORD);
  assert.equal(invited.status, 200);
  const who = await (await req('/content/whoami', invited)).json();
  assert.deepEqual([who.role, [...who.permissions].sort(), who.companies.map((c) => c.id)], ['editor', ['price.edit', 'price.view', 'sites.view'], ['palitra-love']]);
  assert.equal((await req('/content/admin/accounts', invited)).status, 403);
  assert.equal((await req('/content/admin/invitations', invited)).status, 403);
  assert.ok([403, 404].includes((await req('/content/alvi/price', invited)).status), 'чужая компания закрыта');
  listed = await (await req('/content/admin/invitations', owner)).json();
  assert.deepEqual(listed.invitations.filter((x) => x.login === 'newbie').map((x) => [x.status, x.delivery]), [['accepted', 'delivered']]);

  // Лимит попыток публичных маршрутов.
  let limited = 0;
  for (let i = 0; i < 25; i++) if ((await pub('preview', { token: 'x'.repeat(43) })).status === 429) limited += 1;
  assert.ok(limited > 0, 'частые попытки ограничиваются');
  db.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const output = logs.join('');
  assert.ok(!output.includes(secret) && !output.includes(PASSWORD), 'секрет и пароль не попали в журналы сервиса');
});
