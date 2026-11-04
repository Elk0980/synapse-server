'use strict';

/* Личное напоминание на живом сервисе content вместе с настоящим мостом ops/chat (specs/083).
   Подпись Mini App выпускает только Telegram (production-ключ), поэтому привязка участника и его
   разрешение писать лично записываются в базу теста напрямую — это фикстура вместо Telegram.
   Всё остальное идёт штатно: учётная запись, членство, задача, маршрут, очередь, мост, квитанция.
   node --test ops/content/personal-reminders-http.test.js */

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
const BOT_ID = '123';
const TG = '5001';

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('кабинет → content → мост → один sendMessage получателю → квитанция; прежний мост задание не получает', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-reminders-live-'));
  const ownerSecret = crypto.randomBytes(24).toString('hex'), memberSecret = crypto.randomBytes(24).toString('hex');
  const bridgeKey = crypto.randomBytes(24).toString('hex');
  const port = await freePort(), deadRuntimePort = await freePort();
  const database = path.join(dir, 'db.sqlite');
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: database, ASSETS_DIR: path.join(dir, 'assets'),
      SEED_DIR: path.join(__dirname, 'seed'), API_KEY: '', CHAT_API_KEY: bridgeKey, HUGH_RUNTIME_URL: `http://127.0.0.1:${deadRuntimePort}`,
      AUTH_USERS: `owner:owner:${hashPassword(ownerSecret)}`, SESSION_SECRET: crypto.randomBytes(32).toString('hex'), TELEGRAM_BOT_ID: BOT_ID },
    stdio: 'ignore',
  });
  t.after(() => { child.kill('SIGKILL'); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* временный каталог */ } });
  const base = `http://127.0.0.1:${port}`;
  const req = (url, session, method = 'GET', body) => fetch(base + url, { method,
    headers: { ...(session ? { cookie: session.cookie, ...(session.csrf ? { 'X-CSRF-Token': session.csrf } : {}) } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const internal = (url) => fetch(base + url, { headers: { 'X-API-Key': bridgeKey } });
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
  assert.equal((await req(`/content/project-chat/${ROOM}`, owner)).status, 200);
  const account = await (await req('/content/admin/accounts', owner, 'POST',
    { login: 'qa_daria', displayName: 'QA Дарья', password: memberSecret, companies: [ROOM], permissions: [] })).json();
  const memberId = account.id ?? account.userId;
  assert.equal((await req(`/content/project-chat/${ROOM}/members`, owner, 'PUT', { userIds: [memberId] })).status, 200);
  const created = await req(`/content/project-chat/${ROOM}/tasks`, owner, 'POST', { title: 'Подтвердить состав набора' });
  const taskId = (await created.json()).task.id;

  // До привязки: получатель виден владельцу, но писать ему лично нельзя.
  let view = await (await req(`/content/project-chat/${ROOM}/personal-reminders?taskId=${taskId}`, owner)).json();
  assert.deepEqual(view.recipients.map((item) => [item.userId, item.state]), [[memberId, 'no_link']]);
  const member = await login('qa_daria', memberSecret);
  assert.equal((await req(`/content/project-chat/${ROOM}/personal-reminders`, member)).status, 403, 'участнику маршрут закрыт');

  // Фикстура вместо Telegram: привязка владельцем и затем подписанное разрешение того же бота.
  // Подписанный auth_date (секунды) не раньше чем через 61 с после привязки (допуск часов Telegram + секунда): иначе stale_permission.
  const linkedAt = '2026-10-02T08:00:00.000Z', signedAfterLink = Math.floor(Date.parse(linkedAt) / 1000) + 120;
  const fixture = new DatabaseSync(database);
  fixture.prepare('INSERT INTO project_chat_telegram_links(telegram_user_id,user_id,linked_by,linked_at) VALUES(?,?,?,?)')
    .run(TG, memberId, 1, linkedAt);
  fixture.prepare(`INSERT INTO project_chat_telegram_write_access(telegram_user_id,bot_id,allowed,auth_date,received_at,reason)
    VALUES(?,?,1,?,?,?)`).run(TG, BOT_ID, signedAfterLink, '2026-10-02T08:01:00.000Z', 'miniapp_allowed');
  fixture.close();
  view = await (await req(`/content/project-chat/${ROOM}/personal-reminders?taskId=${taskId}`, owner)).json();
  assert.deepEqual(view.recipients.map((item) => [item.state, item.telegramUserId]), [['ready', TG]]);

  const body = { recipientUserId: memberId, taskId, text: 'Пришлите состав набора.', dependency: 'цена на сайте',
    expectedTelegramUserId: TG, clientReminderId: 'live-personal-0001' };
  assert.equal((await req(`/content/project-chat/${ROOM}/personal-reminders`, { cookie: owner.cookie }, 'POST', body)).status, 403, 'без CSRF');
  const queued = await req(`/content/project-chat/${ROOM}/personal-reminders`, owner, 'POST', body);
  assert.equal(queued.status, 202);
  const reminder = (await queued.json()).reminder;
  assert.match(reminder.text, new RegExp(`^Напоминание по задаче №${taskId} «Подтвердить состав набора»`));
  // Прежний мост (без флага или только с правкой PR441) задание не получает.
  assert.deepEqual((await (await internal('/content/internal/project-chat/outbox')).json()).jobs, []);
  assert.deepEqual((await (await internal('/content/internal/project-chat/outbox?capabilities=edit')).json()).jobs, []);

  const telegram = [];
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('https://api.telegram.org/')) {
      const method = target.split('/').pop(), payload = JSON.parse(options.body);
      telegram.push({ method, payload });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 9001, chat: { id: Number(payload.chat_id), type: 'private' } } }) };
    }
    return fetch(target.replace('http://content:8080', base), options);
  };
  const bridge = createProjectChatBridge({ db: new DatabaseSync(':memory:'), contentUrl: 'http://content:8080', apiKey: bridgeKey,
    telegramToken: `${BOT_ID}:bot-token`, legacyHandler: async () => {}, fetchImpl, quietHours: parseQuietHours({}) });
  await bridge.tick();
  await bridge.tick();
  assert.deepEqual(telegram, [{ method: 'sendMessage', payload: { chat_id: TG, text: `${AI_SIGNATURE}\n${reminder.text}` } }], 'ровно одно личное сообщение');
  view = await (await req(`/content/project-chat/${ROOM}/personal-reminders?taskId=${taskId}`, owner)).json();
  assert.deepEqual(view.reminders.map((item) => [item.status, item.telegramMessageId]), [['sent', '9001']]);
  // Повтор того же запроса — прежний результат, без нового сообщения.
  assert.equal((await req(`/content/project-chat/${ROOM}/personal-reminders`, owner, 'POST', body)).status, 200);
  await bridge.tick();
  assert.equal(telegram.length, 1);
  // В переписке комнаты ничего не появилось: напоминание не групповое.
  assert.deepEqual((await (await req(`/content/project-chat/${ROOM}/messages`, owner)).json()).messages, []);

  // Постановка → снятие задачи → мост: задание закрывается ошибкой, Telegram не вызывается.
  const second = (await (await req(`/content/project-chat/${ROOM}/tasks`, owner, 'POST', { title: 'Уточнить сроки' })).json()).task.id;
  const queuedSecond = await req(`/content/project-chat/${ROOM}/personal-reminders`, owner, 'POST',
    { ...body, taskId: second, clientReminderId: 'live-personal-0002' });
  assert.equal(queuedSecond.status, 202);
  assert.equal((await req(`/content/project-chat/${ROOM}/tasks/${second}`, owner, 'PATCH',
    { status: 'cancelled', publication: 'not_required' })).status, 200);
  await bridge.tick();
  await bridge.tick();
  assert.equal(telegram.length, 1, 'снятая задача не дала второго sendMessage');
  view = await (await req(`/content/project-chat/${ROOM}/personal-reminders?taskId=${second}`, owner)).json();
  assert.deepEqual(view.reminders.map((item) => [item.status, item.telegramMessageId]), [['error', null]]);
  assert.match(view.reminders[0].error, /Задача снята/);
});
