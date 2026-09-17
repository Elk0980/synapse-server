'use strict';

/* Telegram Mini App на живом сервисе content: маршрут входа с production-ключом Telegram
   (подделка отвергается, тестовых ключей в окружении нет), room-токен по договорённому формату,
   тот же ACL для вложений, закрытые владельческие маршруты, отсутствие запасного входа через cookie.
   Привязка Telegram ID создаётся напрямую в базе сервиса: выдать её через /session без подписи
   Telegram нельзя, а сам маршрут привязки проверяется владельческим cookie.
   node --test ops/content/project-chat-miniapp-integration.test.js */

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

const ROOM = 'palitra-love';
const OTHER = 'alvi';
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32, 1)]);
const TG = '5001';

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
/* Формат room-токена сервиса: room.<payload>.<HMAC на SESSION_SECRET с префиксом room.>. */
function mintRoomToken(secret, claims) {
  const payload = Buffer.from(JSON.stringify({ k: 'room', ...claims })).toString('base64url');
  return `room.${payload}.${crypto.createHmac('sha256', secret).update(`room.${payload}`).digest('base64url')}`;
}

test('живой content: вход Mini App с production-ключом, room-токен, вложения, закрытые маршруты владельца', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniapp-live-'));
  const ownerSecret = crypto.randomBytes(24).toString('hex');
  const sessionSecret = crypto.randomBytes(32).toString('hex');
  const dbPath = path.join(dir, 'db.sqlite');
  const port = await freePort();
  const deadRuntimePort = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, ASSETS_DIR: path.join(dir, 'assets'),
      SEED_DIR: path.join(__dirname, 'seed'), API_KEY: '', CHAT_API_KEY: '', HUGH_RUNTIME_URL: `http://127.0.0.1:${deadRuntimePort}`,
      TELEGRAM_BOT_ID: '777000', AUTH_USERS: `owner:owner:${hashPassword(ownerSecret)}`, SESSION_SECRET: sessionSecret },
    stdio: 'ignore',
  });
  t.after(() => { child.kill('SIGKILL'); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* временный каталог */ } });
  const base = `http://127.0.0.1:${port}`;
  const req = (url, session, method = 'GET', body, extra = {}) => fetch(base + url, { method,
    headers: { ...(session ? { cookie: session.cookie, ...(session.csrf ? { 'X-CSRF-Token': session.csrf } : {}) } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const withToken = (url, token, method = 'GET', body, extra = {}) => req(url, null, method, body, { authorization: `Bearer ${token}`, ...extra });
  let ready = false;
  for (let attempt = 0; attempt < 200 && !ready; attempt++) {
    try { ready = (await req('/health')).ok; } catch { /* сервис ещё поднимается */ }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(ready, 'сервис content запустился');
  const login = async (name, secret) => {
    const response = await req('/content/login', null, 'POST', { login: name, password: secret });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    return { cookie, csrf: (await (await req('/content/whoami', { cookie })).json()).csrfToken };
  };
  const owner = await login('owner', ownerSecret);

  // Маршрут входа: только POST, подпись проверяется production-ключом — подделка не проходит.
  assert.equal((await req('/content/project-chat-miniapp/session')).status, 405);
  const forgedInit = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 5001, first_name: 'Дарья' }),
    signature: crypto.randomBytes(64).toString('base64url') }).toString();
  const rejected = await req('/content/project-chat-miniapp/session', null, 'POST', { initData: forgedInit });
  assert.equal(rejected.status, 401);
  assert.equal((await rejected.json()).linkCode, undefined, 'без подписи код не выдаётся');

  // Участник и её привязка: аккаунт и членство создаёт владелец, привязку — база сервиса (см. шапку файла).
  const memberSecret = crypto.randomBytes(24).toString('hex');
  const created = await req('/content/admin/accounts', owner, 'POST', { login: 'daria', displayName: 'Дарья', password: memberSecret, companies: [ROOM], permissions: [] });
  assert.equal(created.status, 201);
  const account = await created.json();
  const dariaId = account.id ?? account.userId;
  assert.equal((await req(`/content/project-chat/${ROOM}/members`, owner, 'PUT', { userIds: [dariaId] })).status, 200);
  const links = await req(`/content/project-chat/${ROOM}/telegram-links`, owner);
  assert.equal(links.status, 200);
  assert.deepEqual(await links.json(), { links: [], pending: [] });
  const daria = await login('daria', memberSecret);
  assert.equal((await req(`/content/project-chat/${ROOM}/telegram-links`, daria)).status, 403, 'привязки видит только владелец');
  const db = new DatabaseSync(dbPath);
  db.prepare('INSERT INTO project_chat_telegram_links(telegram_user_id,user_id,linked_by,linked_at) VALUES(?,?,?,?)').run(TG, dariaId, 1, new Date().toISOString());
  const sessionVersion = db.prepare('SELECT session_version FROM auth_users WHERE id=?').get(dariaId).session_version;
  db.close();
  const now = Math.floor(Date.now() / 1000);
  const token = mintRoomToken(sessionSecret, { uid: dariaId, sv: sessionVersion, lv: 1, tg: TG, iat: now, exp: now + 3600 });

  // Room-токен: комната участника, сообщение и файл без CSRF, чтение файла тем же ACL.
  const view = await withToken(`/content/project-chat/${ROOM}`, token);
  assert.equal(view.status, 200);
  const snapshot = await view.json();
  assert.deepEqual([snapshot.access.owner, snapshot.access.canReply], [false, true]);
  assert.equal((await withToken(`/content/project-chat/${ROOM}/messages`, token, 'POST', { text: 'Из Telegram', clientMessageId: 'tg-live-01' })).status, 201);
  const upload = await fetch(`${base}/content/project-chat/${ROOM}/attachments`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'Content-Type': 'image/png', 'X-Filename': encodeURIComponent('фото.png') }, body: PNG });
  assert.equal(upload.status, 201);
  const attachment = (await upload.json()).attachment;
  const file = await withToken(`/content/project-chat/${ROOM}/attachments/${attachment.id}`, token);
  assert.equal(file.status, 200);
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(PNG));
  assert.equal((await fetch(`${base}/content/project-chat/${ROOM}/attachments/${attachment.id}`)).status, 401, 'без токена и cookie файла нет');
  // Владельческие маршруты и чужая компания закрыты; вне комнаты токен не принимается вовсе.
  assert.equal((await withToken(`/content/project-chat/${ROOM}/settings`, token, 'PATCH', { replyMode: 'delegate' })).status, 403);
  assert.equal((await withToken(`/content/project-chat/${ROOM}/telegram-links`, token)).status, 403);
  assert.equal((await withToken(`/content/project-chat/${OTHER}`, token)).status, 403);
  assert.equal((await withToken(`/content/project-chat-runtime/status?companyCode=${ROOM}`, token)).status, 401);
  assert.equal((await withToken('/content/whoami', token)).status, 401);
  assert.equal((await withToken('/content/admin/hugh-settings', token)).status, 401);
  // Поддельный токен вместе с cookie владельца не получает запасного входа.
  const forged = mintRoomToken('wrong-secret', { uid: dariaId, sv: sessionVersion, lv: 1, tg: TG, iat: now, exp: now + 3600 });
  assert.equal((await req(`/content/project-chat/${ROOM}`, owner, 'GET', undefined, { authorization: `Bearer ${forged}` })).status, 401);
  assert.equal((await req(`/content/project-chat/${ROOM}`, owner)).status, 200, 'обычный вход владельца не изменился');
  // Отвязка владельцем закрывает токен немедленно.
  const unlinked = await req(`/content/project-chat/${ROOM}/telegram-links/${TG}`, owner, 'DELETE');
  assert.equal(unlinked.status, 200);
  assert.equal((await withToken(`/content/project-chat/${ROOM}`, token)).status, 401);
});
