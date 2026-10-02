'use strict';

/* Правка отправленного сообщения Хью на живом сервисе content вместе с настоящим мостом ops/chat
   (specs/082-project-chat-reviewed-edit). Telegram подменён: проверяется, какие методы вызваны.
   node --test ops/content/project-chat-reviewed-edit-http.test.js */

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
const { createProjectChatBridge, AI_SIGNATURE } = require('../chat/project-chat-bridge');
const { parseQuietHours } = require('../chat/quiet-hours');

const ROOM = 'palitra-love';
const GROUP = '-100777000111';

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('кабинет → content → мост → editMessageText → квитанция → текст ЛК; прежний мост правку не получает', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-chat-edit-live-'));
  const ownerSecret = crypto.randomBytes(24).toString('hex');
  const bridgeKey = crypto.randomBytes(24).toString('hex');
  const port = await freePort(), deadRuntimePort = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: path.join(dir, 'db.sqlite'),
      ASSETS_DIR: path.join(dir, 'assets'), SEED_DIR: path.join(__dirname, 'seed'), API_KEY: '',
      CHAT_API_KEY: bridgeKey, HUGH_RUNTIME_URL: `http://127.0.0.1:${deadRuntimePort}`,
      AUTH_USERS: `owner:owner:${hashPassword(ownerSecret)}`, SESSION_SECRET: crypto.randomBytes(32).toString('hex') },
    stdio: 'ignore',
  });
  t.after(() => { child.kill('SIGKILL'); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* временный каталог */ } });
  const base = `http://127.0.0.1:${port}`;
  const req = (url, session, method = 'GET', body) => fetch(base + url, { method,
    headers: { ...(session ? { cookie: session.cookie, ...(session.csrf ? { 'X-CSRF-Token': session.csrf } : {}) } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const internal = (url, method = 'GET', body) => fetch(base + url, { method,
    headers: { 'X-API-Key': bridgeKey, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let ready = false;
  for (let attempt = 0; attempt < 200 && !ready; attempt++) {
    try { ready = (await req('/health')).ok; } catch { /* сервис ещё поднимается */ }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(ready, 'сервис content запустился');
  const login = await req('/content/login', null, 'POST', { login: 'owner', password: ownerSecret });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const owner = { cookie, csrf: (await (await req('/content/whoami', { cookie })).json()).csrfToken };

  // Telegram подменён: мост видит настоящие ответы Bot API по форме, сеть не используется.
  const telegram = [];
  let nextMessageId = 136;
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('https://api.telegram.org/')) {
      const method = target.split('/').pop(), body = JSON.parse(options.body);
      telegram.push({ method, body });
      if (method === 'sendMessage') return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: nextMessageId++, chat: { id: Number(body.chat_id) } } }) };
      if (method === 'editMessageText') return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: body.message_id, chat: { id: Number(body.chat_id) }, text: body.text } }) };
      return { ok: false, status: 400, json: async () => ({ ok: false, description: `неожиданный метод ${method}` }) };
    }
    return fetch(target.replace('http://content:8080', base), options);
  };
  const bridge = createProjectChatBridge({ db: new DatabaseSync(':memory:'), contentUrl: 'http://content:8080', apiKey: bridgeKey,
    telegramToken: '123:bot-token', legacyHandler: async () => {}, fetchImpl, quietHours: parseQuietHours({}) });

  assert.equal((await req(`/content/project-chat/${ROOM}`, owner)).status, 200);
  assert.equal((await req(`/content/project-chat/${ROOM}/settings`, owner, 'PATCH', { telegramChatId: GROUP })).status, 200);
  const sent = await req(`/content/project-chat/${ROOM}/reviewed-messages`, owner, 'POST',
    { text: 'Сводка 13 задач', clientMessageId: 'summary-live-01', expectedChatId: GROUP });
  assert.equal(sent.status, 201);
  const messageId = (await sent.json()).message.id;
  await bridge.tick();
  assert.deepEqual(telegram.map((c) => c.method), ['sendMessage']);
  const delivered = (await (await req(`/content/project-chat/${ROOM}/messages`, owner)).json()).messages.find((m) => m.id === messageId);
  assert.deepEqual(delivered.telegramLinks, [`https://t.me/c/${GROUP.slice(4)}/136`]);

  // Без CSRF правка не принимается.
  assert.equal((await req(`/content/project-chat/${ROOM}/reviewed-messages/${messageId}/edit`, { cookie }, 'POST',
    { text: 'Без токена', expectedText: 'Сводка 13 задач', expectedChatId: GROUP, clientEditId: 'edit-live-0000' })).status, 403);
  const body = { text: 'Сводка 13 задач — обновлено', expectedText: 'Сводка 13 задач', expectedChatId: GROUP, clientEditId: 'edit-live-0001' };
  const created = await req(`/content/project-chat/${ROOM}/reviewed-messages/${messageId}/edit`, owner, 'POST', body);
  assert.equal(created.status, 202);
  // Прежний мост (без capabilities) правку не получает — иначе он отправил бы её новым сообщением.
  assert.deepEqual((await (await internal('/content/internal/project-chat/outbox')).json()).jobs, []);
  assert.deepEqual((await (await internal('/content/internal/project-chat/outbox?capabilities=sticker')).json()).jobs, []);
  await bridge.tick();
  assert.deepEqual(telegram.map((c) => c.method), ['sendMessage', 'editMessageText'], 'новое сообщение не отправлено');
  assert.deepEqual(telegram[1].body, { chat_id: GROUP, message_id: 136, text: `${AI_SIGNATURE}\nСводка 13 задач — обновлено` });
  const after = (await (await req(`/content/project-chat/${ROOM}/messages`, owner)).json()).messages;
  assert.equal(after.length, 1, 'в комнате по-прежнему одно сообщение');
  assert.equal(after[0].text, 'Сводка 13 задач — обновлено');
  assert.equal(after[0].edit.status, 'sent');
  assert.deepEqual(after[0].telegramLinks, delivered.telegramLinks);
  // Повтор того же запроса после выполнения — тот же результат без новой правки и без вызова Telegram.
  const again = await req(`/content/project-chat/${ROOM}/reviewed-messages/${messageId}/edit`, owner, 'POST', body);
  assert.equal(again.status, 200);
  await bridge.tick();
  assert.equal(telegram.length, 2);
});
