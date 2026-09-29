'use strict';

/* Подключение клиентского бота Palitra в сервисе chat: без токена он выключен целиком (маршрута нет,
   опроса нет), с токеном — свой getUpdates своим токеном, своя отметка и события в службу диалогов.
   Настоящий server.js, поддельные Telegram и content на локальном порту; сети наружу нет.
   node --test ops/chat/client-bot-server.test.js */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');

const CLIENT_TOKEN = '111:palitra-client';
const SYNAPSE_TOKEN = '222:synapse';
const CLIENT_NAME = 'palitra_love_orders_bot';

function waitFor(check, timeout = 8000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (check()) { clearInterval(timer); resolve(); }
      else if (Date.now() - started >= timeout) { clearInterval(timer); reject(new Error('Истекло время ожидания условия')); }
    }, 20);
  });
}

async function startMock({ clientBotName = CLIENT_NAME } = {}) {
  const seen = { telegram: [], content: [] };
  let served = false;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      const reply = (payload) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload)); };
      if (request.url.startsWith('/bot')) {
        const [, token, method] = request.url.match(/^\/bot([^/]+)\/(\w+)/);
        seen.telegram.push({ token, method, body });
        if (method === 'getMe') return reply({ ok: true, result: token === CLIENT_TOKEN ? { id: 111, is_bot: true, username: clientBotName } : { id: 222, is_bot: true, username: 'synapse_sb_bot' } });
        if (method === 'getUpdates' && token === CLIENT_TOKEN && !served) {
          served = true;
          return reply({ ok: true, result: [{ update_id: 70, message: { message_id: 5, date: 1, chat: { id: 900, type: 'private' }, from: { id: 900, first_name: 'Анна' }, text: 'Здравствуйте' } }] });
        }
        if (method === 'getUpdates') return setTimeout(() => reply({ ok: true, result: [] }), 200);
        return reply({ ok: true, result: true });
      }
      seen.content.push({ url: request.url, key: request.headers['x-api-key'], body });
      if (request.url.startsWith('/content/internal/client-bot/receive')) return reply({ ok: true, downloads: [] });
      if (request.url.startsWith('/content/internal/client-bot/outbox')) return reply({ jobs: [] });
      if (request.url.startsWith('/content/internal/project-chat/outbox')) return reply({ jobs: [] });
      return reply({ ok: true });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` };
}
/* Остановка поддельного сервера: открытые соединения закрываются, ожидание до полного закрытия. */
async function stopMock(mock) {
  mock.server.closeAllConnections?.();
  await new Promise((resolve) => mock.server.close(resolve));
}

async function startChat(t, mockUrl, environment) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'client-bot-server-'));
  // Подмена Telegram сохраняет путь запроса: так видно, каким токеном и каким методом вызван Bot API.
  const preload = path.join(directory, 'telegram-mock.js');
  fs.writeFileSync(preload, `const native = global.fetch;
global.fetch = (input, options) => { const url = String(input);
  if (url.startsWith('https://api.telegram.org/')) return native(${JSON.stringify(mockUrl)} + new URL(url).pathname, options);
  return native(input, options); };`);
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ['--experimental-sqlite', '-r', preload, 'server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), DATABASE_PATH: path.join(directory, 'chat.sqlite'), API_KEY: 'service-key',
      CHAT_ADMIN_KEY: 'admin', TELEGRAM_BOT_TOKEN: SYNAPSE_TOKEN, TELEGRAM_WEBHOOK_SECRET: 'synapse-hook', TELEGRAM_OWNER_ID: '1',
      PROJECT_CONTENT_URL: mockUrl, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('Чат слушает')) resolve(); });
    child.once('exit', (code) => reject(new Error(`chat завершился: ${code}\n${stderr}`)));
  });
  // Windows не даёт удалить папку с открытой базой: сначала дожидаемся выхода процесса (он закрывает базу),
  // затем удаляем только свою временную папку. Ошибки удаления не подавляются.
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { base: `http://127.0.0.1:${port}`, database: path.join(directory, 'chat.sqlite') };
}
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('без токена клиентский бот выключен: маршрута нет, опроса нет, бот Synapse работает как раньше', async (t) => {
  const mock = await startMock();
  t.after(() => stopMock(mock));
  const chat = await startChat(t, mock.url, {});
  const response = await post(`${chat.base}/telegram/client-bot/palitra/webhook`, { update_id: 1 }, { 'x-telegram-bot-api-secret-token': 'x' });
  assert.equal(response.status, 404);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(mock.seen.telegram.filter((call) => call.token === CLIENT_TOKEN).length, 0);
  assert.equal(mock.seen.content.filter((call) => call.url.includes('client-bot')).length, 0);
});

test('с токеном: свой опрос своим токеном и своя отметка; событие уходит в службу диалогов по ключу службы; webhook с секретом', async (t) => {
  const mock = await startMock();
  t.after(() => stopMock(mock));
  const chat = await startChat(t, mock.url, { PALITRA_CLIENT_BOT_TOKEN: CLIENT_TOKEN, PALITRA_CLIENT_BOT_USERNAME: CLIENT_NAME,
    PALITRA_CLIENT_BOT_POLLING: '1', PALITRA_CLIENT_BOT_WEBHOOK_SECRET: 'client-hook' });
  await waitFor(() => mock.seen.content.some((call) => call.url.startsWith('/content/internal/client-bot/receive')));
  const receive = mock.seen.content.find((call) => call.url.startsWith('/content/internal/client-bot/receive'));
  assert.equal(receive.key, 'service-key');
  assert.match(receive.url, /botKey=palitra/);
  assert.equal(receive.body.update.message.text, 'Здравствуйте');
  const beat = mock.seen.content.find((call) => call.url.startsWith('/content/internal/client-bot/heartbeat'));
  assert.deepEqual([beat.body.ok, beat.body.username], [true, CLIENT_NAME], 'готовность подтверждена в content после getMe');
  const polls = mock.seen.telegram.filter((call) => call.method === 'getUpdates');
  assert.ok(polls.length >= 1 && polls.every((call) => call.token === CLIENT_TOKEN), 'бот Synapse без TELEGRAM_POLLING не опрашивается');
  assert.deepEqual(mock.seen.telegram.filter((call) => call.method === 'deleteWebhook').map((call) => call.token), [CLIENT_TOKEN]);
  await waitFor(() => {
    const db = new DatabaseSync(chat.database, { readOnly: true });
    try { return db.prepare("SELECT offset FROM client_bot_checkpoint WHERE bot_key='palitra'").get()?.offset === 71; } finally { db.close(); }
  });
  const db = new DatabaseSync(chat.database, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM telegram_checkpoint').get().n, 0, 'отметка бота Synapse не тронута');
  } finally { db.close(); }
  assert.equal((await post(`${chat.base}/telegram/client-bot/palitra/webhook`, { update_id: 80 }, { 'x-telegram-bot-api-secret-token': 'wrong' })).status, 401);
  // Неизвестная компания и неверный секрет отклоняются до разбора даже некорректного тела.
  for (const key of ['alvi', 'constructor']) {
    const unknown = await fetch(`${chat.base}/telegram/client-bot/${key}/webhook`, {
      method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'client-hook' }, body: '{invalid',
    });
    assert.equal(unknown.status, 404);
  }
  const unauthorized = await fetch(`${chat.base}/telegram/client-bot/palitra/webhook`, {
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'wrong' }, body: '{invalid',
  });
  assert.equal(unauthorized.status, 401);
  const accepted = await post(`${chat.base}/telegram/client-bot/palitra/webhook`,
    { update_id: 81, message: { message_id: 6, chat: { id: 901, type: 'private' }, from: { id: 901 }, text: 'webhook' } },
    { 'x-telegram-bot-api-secret-token': 'client-hook' });
  assert.deepEqual([accepted.status, await accepted.json()], [200, { ok: true, queued: true }]);
  // Webhook бота Synapse по-прежнему принимает только свой секрет.
  assert.equal((await post(`${chat.base}/telegram/webhook`, { update_id: 1 }, { 'x-telegram-bot-api-secret-token': 'client-hook' })).status, 401);
});

test('токен относится к другому боту: webhook и опрос не трогаются, в content уходит честная неготовность', async (t) => {
  const mock = await startMock({ clientBotName: 'someone_else_bot' });
  t.after(() => stopMock(mock));
  await startChat(t, mock.url, { PALITRA_CLIENT_BOT_TOKEN: CLIENT_TOKEN, PALITRA_CLIENT_BOT_USERNAME: CLIENT_NAME, PALITRA_CLIENT_BOT_POLLING: '1' });
  await waitFor(() => mock.seen.content.some((call) => call.url.startsWith('/content/internal/client-bot/heartbeat')));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const beat = mock.seen.content.find((call) => call.url.startsWith('/content/internal/client-bot/heartbeat')).body;
  assert.equal(beat.ok, false);
  assert.match(beat.error, /someone_else_bot/);
  assert.deepEqual(mock.seen.telegram.filter((call) => call.token === CLIENT_TOKEN).map((call) => call.method).filter((method) => method !== 'getMe'), [],
    'deleteWebhook, getUpdates и отправки чужим токеном не вызываются');
  assert.equal(mock.seen.content.filter((call) => /client-bot\/(outbox|receive)/.test(call.url)).length, 0);
});

test('без имени бота токен не используется вовсе', async (t) => {
  const mock = await startMock();
  t.after(() => stopMock(mock));
  await startChat(t, mock.url, { PALITRA_CLIENT_BOT_TOKEN: CLIENT_TOKEN, PALITRA_CLIENT_BOT_POLLING: '1' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(mock.seen.telegram.filter((call) => call.token === CLIENT_TOKEN).length, 0);
});

test('ALVI использует собственную конфигурацию и маршрут без включения Palitra', async (t) => {
  const mock = await startMock();
  t.after(() => stopMock(mock));
  const chat = await startChat(t, mock.url, { PALITRA_CLIENT_BOT_TOKEN: '', ALVI_CLIENT_BOT_TOKEN: CLIENT_TOKEN,
    ALVI_CLIENT_BOT_USERNAME: CLIENT_NAME, ALVI_CLIENT_BOT_POLLING: '1', ALVI_CLIENT_BOT_WEBHOOK_SECRET: 'alvi-hook' });
  await waitFor(() => mock.seen.content.some(call => call.url.startsWith('/content/internal/client-bot/receive')));
  const receive = mock.seen.content.find(call => call.url.startsWith('/content/internal/client-bot/receive'));
  assert.match(receive.url, /botKey=alvi/);
  assert.equal((await post(`${chat.base}/telegram/client-bot/palitra/webhook`, {}, { 'x-telegram-bot-api-secret-token': 'alvi-hook' })).status, 404);
  assert.equal((await post(`${chat.base}/telegram/client-bot/alvi/webhook`, { update_id: 81,
    message: { message_id: 6, chat: { id: 901, type: 'private' }, from: { id: 901 }, text: 'ALVI' } },
    { 'x-telegram-bot-api-secret-token': 'alvi-hook' })).status, 200);
  assert.ok(mock.seen.telegram.every(call => call.token === CLIENT_TOKEN));
});
