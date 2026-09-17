'use strict';

/* Общий чат проекта на живом сервисе content: маршруты кабинета, внутренний ключ моста
   и фактический запуск обработчика заданий Хью. Проверяет сборку, а не только модуль.
   node --test ops/content/project-chat-integration.test.js */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { hashPassword } = require('./passwords');

const ROOM = 'palitra-love';
const OTHER = 'alvi';
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32, 1)]);

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('живой content обслуживает комнату проекта, мост и обработчик заданий', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-chat-live-'));
  const ownerSecret = crypto.randomBytes(24).toString('hex');
  const bridgeKey = crypto.randomBytes(24).toString('hex');
  const port = await freePort();
  const deadRuntimePort = await freePort();   // служба Хью намеренно не запущена
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: path.join(dir, 'db.sqlite'),
      ASSETS_DIR: path.join(dir, 'assets'), SEED_DIR: path.join(__dirname, 'seed'), API_KEY: '',
      CHAT_API_KEY: bridgeKey, HUGH_RUNTIME_URL: `http://127.0.0.1:${deadRuntimePort}`,
      AUTH_USERS: `owner:owner:${hashPassword(ownerSecret)}`,
      SESSION_SECRET: crypto.randomBytes(32).toString('hex') },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const req = (url, session, method = 'GET', body, extra = {}) => fetch(base + url, { method,
    headers: { ...(session ? { cookie: session.cookie, ...(session.csrf ? { 'X-CSRF-Token': session.csrf } : {}) } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const internal = (url, key = bridgeKey, method = 'GET', body) => fetch(base + url, { method,
    headers: { ...(key === null ? {} : { 'X-API-Key': key }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const login = async (name, secret) => {
    const response = await req('/content/login', null, 'POST', { login: name, password: secret });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const profile = await (await req('/content/whoami', { cookie })).json();
    return { cookie, csrf: profile.csrfToken, profile };
  };
  t.after(() => { child.kill('SIGKILL'); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* временный каталог */ } });

  let ready = false;
  for (let attempt = 0; attempt < 200 && !ready; attempt++) {
    try { ready = (await req('/health')).ok; } catch { /* сервис ещё поднимается */ }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(ready, 'сервис content запустился');

  // Кабинет: без сессии комната недоступна.
  assert.equal((await req(`/content/project-chat/${ROOM}`)).status, 401);

  // Внутренние маршруты моста: только по ключу и только известные маршруты.
  assert.equal((await internal(`/content/internal/project-chat/binding?chatId=-100500`, null)).status, 401);
  // Значения заголовков в фикстурах только ASCII: HTTP-заголовок не принимает кириллицу.
  assert.equal((await internal(`/content/internal/project-chat/binding?chatId=-100500`, 'short-key')).status, 401);
  assert.equal((await internal(`/content/internal/project-chat/binding?chatId=-100500`, `${bridgeKey}x`)).status, 401);
  const binding = await internal('/content/internal/project-chat/binding?chatId=-100500');
  assert.equal(binding.status, 200);
  assert.deepEqual(await binding.json(), { room: null });
  assert.equal((await internal('/content/internal/project-chat/unknown')).status, 404);

  const owner = await login('owner', ownerSecret);
  const snapshot = await req(`/content/project-chat/${ROOM}`, owner);
  assert.equal(snapshot.status, 200);
  const view = await snapshot.json();
  assert.deepEqual(view.messages, []);
  assert.equal(view.hasMore, false);
  assert.equal(view.access.owner, true);
  assert.equal(view.ai.configured, true, 'адрес и ключ службы заданы');
  assert.equal(view.ai.connected, false, 'но подключения нет');
  assert.equal(view.ai.runtimeState, 'unavailable');

  // CSRF обязателен для записи.
  assert.equal((await req(`/content/project-chat/${ROOM}/messages`, { cookie: owner.cookie, csrf: 'forged-csrf-token' },
    'POST', { text: 'Привет', clientMessageId: 'live-0001' })).status, 403);
  const posted = await req(`/content/project-chat/${ROOM}/messages`, owner, 'POST',
    { text: 'Привет команде', clientMessageId: 'live-0001' });
  assert.equal(posted.status, 201);
  const repeat = await req(`/content/project-chat/${ROOM}/messages`, owner, 'POST',
    { text: 'Привет команде', clientMessageId: 'live-0001' });
  assert.equal(repeat.status, 200, 'повтор того же клиентского идентификатора не задваивает');

  // Участник компании без членства в комнате не получает историю.
  const memberSecret = crypto.randomBytes(24).toString('hex');
  const created = await req('/content/admin/accounts', owner, 'POST',
    { login: 'qa_room', displayName: 'QA Комната', password: memberSecret, companies: [ROOM], permissions: [] });
  assert.equal(created.status, 201);
  const account = await created.json();
  const accountId = account.id ?? account.userId;
  assert.ok(Number.isInteger(accountId));
  const guest = await login('qa_room', memberSecret);
  assert.equal((await req(`/content/project-chat/${ROOM}`, guest)).status, 403, 'компания без членства не открывает комнату');
  assert.equal((await req(`/content/project-chat/${OTHER}`, guest)).status, 403);
  assert.equal((await req(`/content/project-chat/${ROOM}/candidates`, guest)).status, 403);

  // Членство выдаёт владелец; глобальные права чата CRM для этого не нужны.
  const joined = await req(`/content/project-chat/${ROOM}/members`, owner, 'PUT', { userIds: [accountId] });
  assert.equal(joined.status, 200);
  const guestView = await req(`/content/project-chat/${ROOM}`, guest);
  assert.equal(guestView.status, 200);
  const guestPayload = await guestView.json();
  assert.equal(guestPayload.access.owner, false);
  assert.equal(guestPayload.ai.runtimeError, '', 'подробности подключения только владельцу');
  assert.equal((await req(`/content/project-chat/${ROOM}/candidates`, guest)).status, 403);
  assert.equal((await req(`/content/project-chat/${ROOM}/settings`, guest, 'PATCH', { replyMode: 'delegate' })).status, 403);

  // Вложение: загрузка и выдача только своей комнате.
  const upload = await fetch(`${base}/content/project-chat/${ROOM}/attachments`, { method: 'POST',
    headers: { cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'image/png',
      'X-Filename': encodeURIComponent('афиша.png') }, body: PNG });
  assert.equal(upload.status, 201);
  const attachment = (await upload.json()).attachment;
  const file = await req(`/content/project-chat/${ROOM}/attachments/${attachment.id}`, owner);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(PNG));
  assert.equal((await req(`/content/project-chat/${OTHER}/attachments/${attachment.id}`, owner)).status, 404);

  // Привязка группы и полный круг моста по внутреннему ключу.
  const bound = await req(`/content/project-chat/${ROOM}/settings`, owner, 'PATCH', { telegramChatId: '-100777' });
  assert.equal(bound.status, 200);
  assert.equal((await (await internal('/content/internal/project-chat/binding?chatId=-100777')).json()).room.companyCode, ROOM);
  const incoming = await internal('/content/internal/project-chat/receive', bridgeKey, 'POST',
    { chatId: '-100777', messageId: '4242', authorId: '777', authorName: 'Дарья', text: 'Из группы' });
  assert.equal(incoming.status, 200);
  assert.equal((await incoming.json()).duplicate, false);
  const again = await internal('/content/internal/project-chat/receive', bridgeKey, 'POST',
    { chatId: '-100777', messageId: '4242', authorId: '777', authorName: 'Дарья', text: 'Из группы' });
  assert.equal((await again.json()).duplicate, true, 'повторная доставка события не создаёт второе сообщение');
  // Исходящие в группу появляются только у сообщений, написанных после привязки.
  assert.equal((await req(`/content/project-chat/${ROOM}/messages`, owner, 'POST',
    { text: 'После привязки', clientMessageId: 'live-0003' })).status, 201);
  const outbox = await (await internal('/content/internal/project-chat/outbox')).json();
  assert.equal(outbox.jobs.length, 1, 'комната выдаёт по одному заданию');
  assert.equal(outbox.jobs[0].chatId, '-100777');
  const acknowledged = await internal('/content/internal/project-chat/acknowledge', bridgeKey, 'POST',
    { jobId: outbox.jobs[0].id, ok: true, externalMessageIds: ['7001'] });
  assert.equal(acknowledged.status, 200);
  const migrated = await internal('/content/internal/project-chat/migrate', bridgeKey, 'POST',
    { chatId: '-100777', newChatId: '-100888' });
  assert.equal(migrated.status, 200);
  assert.equal((await migrated.json()).migrated, true);
  assert.equal((await (await internal('/content/internal/project-chat/binding?chatId=-100888')).json()).room.companyCode, ROOM);

  // Прокси службы Хью: только владельцу и без чужого текста в ответе.
  assert.equal((await req('/content/project-chat-runtime/status', guest)).status, 403);
  const runtime = await req('/content/project-chat-runtime/status', owner);
  assert.equal(runtime.status, 503);
  const runtimeBody = await runtime.json();
  assert.equal(runtimeBody.connected, false);
  assert.ok(!JSON.stringify(runtimeBody).includes(bridgeKey), 'ключ не утекает наружу');

  // Обработчик заданий действительно запущен вместе с сервисом.
  const asked = await req(`/content/project-chat/${ROOM}/messages`, owner, 'POST',
    { text: 'Хью, что со сроками?', clientMessageId: 'live-0002' });
  assert.equal(asked.status, 201);
  let waiting = 0;
  for (let attempt = 0; attempt < 60 && waiting === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    waiting = (await (await req(`/content/project-chat/${ROOM}`, owner)).json()).ai.waiting;
  }
  assert.equal(waiting, 1, 'обработчик перевёл вопрос в ожидание подключения Хью');
  const finalView = await (await req(`/content/project-chat/${ROOM}`, owner)).json();
  assert.equal(finalView.ai.failed, 0, 'отсутствие подключения не считается отказом');
  assert.equal(finalView.messages.at(-1).aiStatus, 'pending');
  const requeued = await req(`/content/project-chat/${ROOM}/retry-ai`, owner, 'POST', {});
  assert.equal(requeued.status, 200);
  assert.equal((await requeued.json()).requeued, 1, 'владелец возвращает ожидающее задание в очередь');
  assert.equal((await req(`/content/project-chat/${ROOM}/retry-ai`, guest, 'POST', {})).status, 403);
});
