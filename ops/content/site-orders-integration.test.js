'use strict';

/* Заявки Palitra на живом сервисе content: публичный маршрут /public-orders/palitra (Origin, лимит
   тела, тип содержимого), маршруты владельца в ЛК, выдача order:<n> мосту по внутреннему ключу
   и подтверждение строковым id. Telegram не вызывается.
   node --test ops/content/site-orders-integration.test.js */

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

const ORIGIN = 'https://palitra-love.synapsebusiness.ru';

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('живой content: приём заявки Palitra, маршруты владельца, выдача и подтверждение уведомления через мост', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-orders-live-'));
  const ownerSecret = crypto.randomBytes(24).toString('hex');
  const bridgeKey = crypto.randomBytes(24).toString('hex');
  const port = await freePort();
  const deadRuntimePort = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: path.join(dir, 'db.sqlite'), ASSETS_DIR: path.join(dir, 'assets'),
      SEED_DIR: path.join(__dirname, 'seed'), API_KEY: '', CHAT_API_KEY: bridgeKey, HUGH_RUNTIME_URL: `http://127.0.0.1:${deadRuntimePort}`,
      AUTH_USERS: `owner:owner:${hashPassword(ownerSecret)}`, SESSION_SECRET: crypto.randomBytes(32).toString('hex') },
    stdio: 'ignore',
  });
  t.after(() => { child.kill('SIGKILL'); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* временный каталог */ } });
  const base = `http://127.0.0.1:${port}`;
  const req = (url, session, method = 'GET', body, extra = {}) => fetch(base + url, { method,
    headers: { ...(session ? { cookie: session.cookie, ...(session.csrf ? { 'X-CSRF-Token': session.csrf } : {}) } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  const internal = (url, method = 'GET', body) => fetch(base + url, { method, headers: { 'X-API-Key': bridgeKey, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
  const priceDoc = await (await req('/public-content/palitra/price')).json();
  const itemId = priceDoc.categories[0].items[0].id;
  const order = { requestId: crypto.randomUUID(), kind: 'cart', name: 'Анна', phone: '89140001122', consent: true, items: [{ id: itemId, qty: 1 }], page: '/catalog/', website: '' };

  // Публичный маршрут: только POST + JSON + разрешённый Origin; тело ограничено 32 КиБ.
  assert.equal((await req('/public-orders/palitra')).status, 404);
  assert.equal((await req('/public-orders/alvi', null, 'POST', order, { Origin: ORIGIN })).status, 404);
  assert.equal((await req('/public-orders/palitra', null, 'POST', order)).status, 403);
  assert.equal((await req('/public-orders/palitra', null, 'POST', order, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${base}/public-orders/palitra`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' }, body: JSON.stringify(order) })).status, 415);
  assert.equal((await req('/public-orders/palitra', null, 'POST', JSON.stringify({ ...order, comment: 'x'.repeat(40000) }), { Origin: ORIGIN })).status, 413);
  assert.equal((await req('/public-orders/palitra', null, 'POST', '{bad', { Origin: ORIGIN })).status, 400);
  const created = await req('/public-orders/palitra', null, 'POST', order, { Origin: ORIGIN });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.deepEqual([createdBody.ok, createdBody.status, createdBody.requestId], [true, 'accepted', order.requestId]);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const repeated = await req('/public-orders/palitra', null, 'POST', order, { Origin: ORIGIN });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).duplicate, true);
  const mismatch = await req('/public-orders/palitra', null, 'POST', { ...order, name: 'Иное' }, { Origin: ORIGIN });
  assert.deepEqual([mismatch.status, (await mismatch.json()).code], [409, 'REQUEST_MISMATCH']);
  const unknown = await req('/public-orders/palitra', null, 'POST', { ...order, requestId: crypto.randomUUID(), items: [{ id: 'nope-9', qty: 1 }] }, { Origin: ORIGIN });
  assert.deepEqual([unknown.status, (await unknown.json()).code], [400, 'ITEM_UNKNOWN']);

  // Владелец: список и получатель; посторонний аккаунт и запрос без CSRF отклоняются; другой сайт — 404.
  assert.equal((await req('/content/palitra/orders')).status, 401);
  const memberSecret = crypto.randomBytes(24).toString('hex');
  assert.equal((await req('/content/admin/accounts', owner, 'POST', { login: 'daria', displayName: 'Дарья', password: memberSecret, companies: ['palitra-love'], permissions: [] })).status, 201);
  const daria = await login('daria', memberSecret);
  assert.equal((await req('/content/palitra/orders', daria)).status, 403);
  assert.equal((await req('/content/alvi/orders', owner)).status, 404);
  const listed = await req('/content/palitra/orders', owner);
  assert.equal(listed.status, 200);
  const listBody = await listed.json();
  assert.equal(listBody.orders.length, 1);
  assert.equal(listBody.nextCursor, null);
  assert.equal((await req('/content/palitra/orders?limit=0', owner)).status, 400);
  assert.deepEqual((await (await req(`/content/palitra/orders?limit=1&beforeId=${listBody.orders[0].id}`, owner)).json()).orders, []);
  assert.deepEqual([listBody.orders[0].id, listBody.orders[0].status, listBody.orders[0].notify, listBody.recipient.configured, listBody.recipient.unnotifiedOrders],
    [createdBody.orderId, 'accepted', null, false, 1]);
  assert.equal((await req('/content/palitra/order-recipient', { cookie: owner.cookie, csrf: 'forged' }, 'PUT', { telegramChatId: '123456789', label: 'Дарья' })).status, 403);
  const recipient = await req('/content/palitra/order-recipient', owner, 'PUT', { telegramChatId: '123456789', label: 'Дарья' });
  assert.equal(recipient.status, 200);
  assert.deepEqual([(await recipient.json()).version, (await (await req('/content/palitra/order-recipient', owner)).json()).verifiedAt], [1, null]);
  const renotified = await req(`/content/palitra/orders/${createdBody.orderId}/renotify`, owner, 'POST');
  assert.equal(renotified.status, 202);
  assert.equal((await renotified.json()).jobId, 'order:1');

  // Мост: задание выдаётся по внутреннему ключу со строковым id и подтверждается тем же id.
  const outbox = await (await internal('/content/internal/project-chat/outbox')).json();
  assert.equal(outbox.jobs.length, 1);
  assert.deepEqual([outbox.jobs[0].id, outbox.jobs[0].chatId, outbox.jobs[0].authorName, outbox.jobs[0].authorType], ['order:1', '123456789', 'Заявка с сайта', 'system']);
  assert.match(outbox.jobs[0].text, /Заявка №1 · Palitra/);
  assert.equal((await internal('/content/internal/project-chat/outbox')).ok, true);
  assert.equal((await (await internal('/content/internal/project-chat/outbox')).json()).jobs.length, 0, 'задание в аренде');
  assert.equal((await internal('/content/internal/project-chat/acknowledge', 'POST', { jobId: 'order:1', ok: true, externalMessageIds: ['5'] })).status, 200);
  const after = await (await req('/content/palitra/orders', owner)).json();
  assert.deepEqual([after.orders[0].status, after.orders[0].notify.status, after.recipient.unnotifiedOrders], ['notified', 'sent', 0]);
  const testJob = await req('/content/palitra/order-recipient/test', owner, 'POST');
  assert.equal(testJob.status, 202);
  assert.equal((await testJob.json()).jobId, 'order:2');
});
