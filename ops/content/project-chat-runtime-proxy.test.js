'use strict';

/* Границы ожидания у прокси службы Хью. Вход и проверка состояния ждут по-разному:
   рантайм запрашивает код устройства у Codex до 30 секунд, поэтому короткая общая граница
   обрывала именно вход — владелец видел сетевую ошибку вместо выданных ссылки и кода.
   Проверка состояния, наоборот, обязана отвечать быстро и не держать вкладку.

   Внешних обращений нет: вместо рантайма поднимается локальная заглушка на loopback.
   node --test ops/content/project-chat-runtime-proxy.test.js */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { hashPassword } = require('./passwords');

// Заглушка отвечает на /login дольше прежней общей границы в 12 с и вовсе не отвечает
// на /status. Окно проверки состояния — прежние 12 с плюс запас на медленную машину.
const LOGIN_DELAY_MS = 14_000;
const STATUS_WINDOW = [11_000, 13_000];

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('вход ждёт дольше проверки состояния: медленный рантайм не обрывается на полпути', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-proxy-'));
  const ownerSecret = crypto.randomBytes(24).toString('hex');
  const bridgeKey = crypto.randomBytes(24).toString('hex');

  const seen = [];
  const pendingResponses = [];
  const runtime = http.createServer((request, response) => {
    // Помимо запросов кабинета сервис сам опрашивает /status для блока «ai» в снимке комнаты
    // и для обработчика заданий (project-chat.js: runtimeStatus, своя граница в 2,5 с).
    // Это законный фон, поэтому вызовы различаются, а не запрещаются: фоновый опрос узнаётся
    // по своей паре заголовков (accept: application/json и без content-type), всё остальное
    // считается запросом прокси.
    const probe = request.headers.accept === 'application/json' && !request.headers['content-type'];
    seen.push({
      route: `${request.method} ${request.url}`,
      proxied: !probe,
      key: request.headers['x-api-key'] || '',
      bearer: request.headers.authorization || '',
    });
    pendingResponses.push(response);
    if (request.method === 'POST' && request.url === '/login') {
      const timer = setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ connected: false, authenticated: false, provider: 'codex', state: 'login_required',
          loginUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' }));
      }, LOGIN_DELAY_MS);
      if (typeof timer.unref === 'function') timer.unref();
      return;
    }
    // /status намеренно остаётся без ответа: прокси обязан закрыть его сам.
  });
  runtime.listen(0, '127.0.0.1');
  await once(runtime, 'listening');
  const runtimePort = runtime.address().port;

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: path.join(dir, 'db.sqlite'),
      ASSETS_DIR: path.join(dir, 'assets'), SEED_DIR: path.join(__dirname, 'seed'), API_KEY: '',
      CHAT_API_KEY: bridgeKey, HUGH_RUNTIME_URL: `http://127.0.0.1:${runtimePort}`,
      AUTH_USERS: `owner:owner:${hashPassword(ownerSecret)}`,
      SESSION_SECRET: crypto.randomBytes(32).toString('hex') },
    stdio: 'ignore',
  });
  t.after(async () => {
    child.kill('SIGKILL');
    for (const response of pendingResponses) response.destroy();
    if (typeof runtime.closeAllConnections === 'function') runtime.closeAllConnections();
    await new Promise((resolve) => runtime.close(resolve));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* временный каталог */ }
  });

  const base = `http://127.0.0.1:${port}`;
  const call = (url, session, method = 'GET') => fetch(base + url, { method,
    headers: { cookie: session.cookie, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: '{}' } : {}) });

  let ready = false;
  for (let attempt = 0; attempt < 200 && !ready; attempt++) {
    try { ready = (await fetch(`${base}/health`)).ok; } catch { /* сервис ещё поднимается */ }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(ready, 'сервис content запустился');

  const loginResponse = await fetch(`${base}/content/login`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'owner', password: ownerSecret }) });
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
  const profile = await (await fetch(`${base}/content/whoami`, { headers: { cookie } })).json();
  const owner = { cookie, csrf: profile.csrfToken };

  // Оба запроса уходят одновременно: одно окно ожидания на обе границы.
  const started = Date.now();
  const timed = async (promise) => ({ response: await promise, elapsed: Date.now() - started });
  const [status, login] = await Promise.all([
    timed(call('/content/project-chat-runtime/status', owner)),
    timed(call('/content/project-chat-runtime/login', owner, 'POST')),
  ]);

  // Проверка состояния сдаётся первой и честно говорит о недоступности.
  assert.equal(status.response.status, 503);
  const statusBody = await status.response.json();
  assert.equal(statusBody.state, 'unavailable');
  assert.equal(statusBody.connected, false);
  assert.ok(status.elapsed >= STATUS_WINDOW[0] && status.elapsed < STATUS_WINDOW[1],
    `проверка состояния ждала ${status.elapsed} мс, ожидалось около 12 000 мс`);

  // Вход дожидается ответа рантайма и доносит выданные ссылку и код до кабинета.
  assert.equal(login.response.status, 200);
  const loginBody = await login.response.json();
  assert.equal(loginBody.state, 'login_required');
  assert.equal(loginBody.loginUrl, 'https://auth.openai.com/codex/device');
  assert.equal(loginBody.userCode, 'ABCD-1234');
  assert.ok(login.elapsed >= LOGIN_DELAY_MS, `вход завершился за ${login.elapsed} мс — ответ рантайма не дождались`);
  assert.ok(!JSON.stringify(loginBody).includes(bridgeKey), 'ключ не утекает наружу');

  // Прокси ходит ровно по двум известным маршрутам: вход — один раз, проверка — один раз.
  // Фоновый опрос состояния при этом не запрещается: его вызовы считаются отдельно.
  const proxied = seen.filter((entry) => entry.proxied);
  const background = seen.filter((entry) => !entry.proxied);
  assert.deepEqual(proxied.map((entry) => entry.route).sort(), ['GET /status', 'POST /login'],
    `прокси обратился к рантайму не так, как ожидалось: ${JSON.stringify(seen)}`);
  assert.ok(background.every((entry) => entry.route === 'GET /status'),
    `фоновый опрос трогает посторонние маршруты: ${JSON.stringify(background)}`);
  // Внутренний ключ уходит только вверх по течению — в оба заголовка, которые понимает рантайм.
  assert.ok(proxied.every((entry) => entry.key === bridgeKey && entry.bearer === `Bearer ${bridgeKey}`),
    'прокси обязан представляться рантайму внутренним ключом');
});
