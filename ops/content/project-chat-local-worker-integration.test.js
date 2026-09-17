'use strict';

/* Локальный обработчик Хью на живом сервисе content: маршруты worker по отдельному ключу,
   owner-ветка status/login для local company до проверки общего CHAT_API_KEY, полный круг
   вход → heartbeat → claim → complete без серверной службы Хью.
   node --test ops/content/project-chat-local-worker-integration.test.js */

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
const OFFICIAL = 'https://auth.openai.com/codex/device';
// Так heartbeat выглядит у настоящего Windows-обработчика (ops/local-hugh/status-file.js).
const READY = { state: 'connected', authenticated: true, connected: true, available: true, limited: false, retryAfter: null,
  provider: 'codex', model: 'gpt-5-codex', safety: { toolIsolationVerified: true, reason: 'proof_ok' }, errorCode: null };

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('живой content: worker-маршруты по своему ключу, owner-ветка local company без CHAT_API_KEY, полный круг ответа', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-worker-live-'));
  const ownerSecret = crypto.randomBytes(24).toString('hex');
  const workerKey = crypto.randomBytes(32).toString('base64url');
  const port = await freePort();
  const deadRuntimePort = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: path.join(dir, 'db.sqlite'),
      ASSETS_DIR: path.join(dir, 'assets'), SEED_DIR: path.join(__dirname, 'seed'), API_KEY: '',
      // Общий ключ службы намеренно пуст: local company обязана работать и без него.
      CHAT_API_KEY: '', HUGH_RUNTIME_URL: `http://127.0.0.1:${deadRuntimePort}`,
      HUGH_LOCAL_WORKER_KEY_SHA256: crypto.createHash('sha256').update(workerKey).digest('hex'),
      HUGH_LOCAL_WORKER_COMPANIES: ` ${ROOM} `,
      AUTH_USERS: `owner:owner:${hashPassword(ownerSecret)}`,
      SESSION_SECRET: crypto.randomBytes(32).toString('hex') },
    stdio: 'ignore',
  });
  t.after(() => { child.kill('SIGKILL'); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* временный каталог */ } });
  const base = `http://127.0.0.1:${port}`;
  const req = (url, session, method = 'GET', body) => fetch(base + url, { method,
    headers: { ...(session ? { cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const worker = (route, body, { key = workerKey, method = 'POST' } = {}) => fetch(`${base}/content/project-chat-worker/${route}`, { method,
    headers: { ...(key === null ? {} : { authorization: `Bearer ${key}` }), 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });

  let ready = false;
  for (let attempt = 0; attempt < 200 && !ready; attempt++) {
    try { ready = (await req('/health')).ok; } catch { /* сервис ещё поднимается */ }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(ready, 'сервис content запустился');
  const loginResponse = await req('/content/login', null, 'POST', { login: 'owner', password: ownerSecret });
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
  const owner = { cookie, csrf: (await (await req('/content/whoami', { cookie })).json()).csrfToken };

  // Маршруты обработчика: без ключа, с чужим ключом и без сессии — 401; не POST — 405; чужой путь — 404.
  assert.equal((await worker('claim', { bootId: 'b1' }, { key: null })).status, 401);
  assert.equal((await worker('claim', { bootId: 'b1' }, { key: `${workerKey}x` })).status, 401);
  assert.equal((await worker('claim', { bootId: 'b1' }, { method: 'GET' })).status, 405);
  assert.equal((await worker('unknown', {})).status, 404);
  assert.equal((await worker('claim', {})).status, 400);

  // Owner-ветка local company отвечает сама, хотя CHAT_API_KEY пуст; чужая компания — прежний 503.
  assert.equal((await fetch(`${base}/content/project-chat-runtime/status?companyCode=${ROOM}`)).status, 401);
  const local = await req(`/content/project-chat-runtime/status?companyCode=${ROOM}`, owner);
  assert.equal(local.status, 200);
  const localBody = await local.json();
  assert.deepEqual([localBody.local, localBody.state, localBody.offline, localBody.connected], [true, 'offline', true, false]);
  assert.equal(typeof localBody.stats.pendingAi, 'number');
  const other = await req(`/content/project-chat-runtime/status?companyCode=${OTHER}`, owner);
  assert.equal(other.status, 503);
  assert.equal((await other.json()).state, 'unconfigured');
  assert.equal((await req('/content/project-chat-runtime/status?companyCode=..%2Fetc', owner)).status, 400);
  // Вход: CSRF проверяется до тела, команда создаётся один раз и ждёт компьютер.
  assert.equal((await req('/content/project-chat-runtime/login', { cookie, csrf: 'forged' }, 'POST', { companyCode: ROOM })).status, 403);
  const started = await req('/content/project-chat-runtime/login', owner, 'POST', { companyCode: ROOM });
  assert.equal(started.status, 202);
  const startedBody = await started.json();
  assert.deepEqual([startedBody.state, startedBody.loginPending], ['offline', true]);
  assert.equal((await req('/content/project-chat-runtime/login', owner, 'POST', { companyCode: ROOM })).status, 202);

  // Вопрос при выключенном компьютере ждёт: серверный обработчик (без службы) его не блокирует.
  assert.equal((await req(`/content/project-chat/${ROOM}/messages`, owner, 'POST', { text: 'Хью, что со сроками?', clientMessageId: 'live-local-01' })).status, 201);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  let view = await (await req(`/content/project-chat/${ROOM}`, owner)).json();
  assert.deepEqual([view.ai.local, view.ai.runtimeState, view.ai.queued, view.ai.waiting, view.ai.failed], [true, 'offline', 1, 0, 0]);
  assert.equal(view.messages.at(-1).aiStatus, 'pending');
  assert.equal(view.ai.offline, true);

  // Компьютер вышел на связь: сначала команда входа, ответы — только после подтверждённого входа.
  const beat = await worker('heartbeat', { bootId: 'b1', status: { state: 'login_required', authenticated: false, connected: false, available: false } });
  assert.equal(beat.status, 200);
  const beatBody = await beat.json();
  assert.deepEqual(Object.keys(beatBody).sort(), ['ok', 'serverTime', 'stats']);
  assert.equal(beatBody.stats.pendingAi, 1);
  assert.equal(beatBody.stats.aiRequestsWhileOffline24h, 1);
  const loginClaim = await (await worker('claim', { bootId: 'b1' })).json();
  assert.equal(loginClaim.job.kind, 'login');
  assert.equal((await req(`/content/project-chat-runtime/status?companyCode=${ROOM}`, owner).then((r) => r.json())).state, 'login_pending');
  const loginDone = await worker('complete', { jobId: loginClaim.job.id, leaseToken: loginClaim.job.leaseToken, payloadHash: loginClaim.job.payloadHash,
    result: { ok: true, status: { state: 'login_required', authenticated: false, connected: false, available: false, loginUrl: OFFICIAL, userCode: 'ABCD-1234' } } });
  assert.equal(loginDone.status, 200);
  const withCode = await (await req(`/content/project-chat-runtime/status?companyCode=${ROOM}`, owner)).json();
  assert.deepEqual([withCode.loginUrl, withCode.userCode], [OFFICIAL, 'ABCD-1234']);
  view = await (await req(`/content/project-chat/${ROOM}`, owner)).json();
  assert.ok(!JSON.stringify(view).includes('ABCD-1234'), 'снимок комнаты не содержит код входа');
  assert.equal((await (await worker('claim', { bootId: 'b1' })).json()).job, null, 'без подтверждённого входа ответы не выдаются');

  // Вход подтверждён: задание ответа выдаётся, продлевается и закрывается одной транзакцией.
  await worker('heartbeat', { bootId: 'b1', status: READY });
  const claim = await (await worker('claim', { bootId: 'b1' })).json();
  assert.equal(claim.job.kind, 'reply');
  assert.equal(claim.job.companyCode, ROOM);
  assert.match(claim.job.payload.jobId, /^project-chat:\d+$/);
  assert.equal(claim.job.payloadHash, crypto.createHash('sha256').update(JSON.stringify(claim.job.payload), 'utf8').digest('hex'));
  const renew = await worker('renew', { jobId: claim.job.id, leaseToken: claim.job.leaseToken });
  assert.equal(renew.status, 200);
  assert.equal((await renew.json()).ok, true);
  const ack = { jobId: claim.job.id, leaseToken: claim.job.leaseToken, payloadHash: claim.job.payloadHash,
    result: { ok: true, text: 'Сроки: среда', provider: 'codex', model: 'gpt-5-codex' } };
  const done = await worker('complete', ack);
  assert.equal(done.status, 200);
  assert.equal((await done.json()).status, 'done');
  const repeat = await worker('complete', ack);
  assert.equal(repeat.status, 200);
  assert.equal((await repeat.json()).duplicate, true);
  assert.equal((await worker('complete', { ...ack, result: { ...ack.result, text: 'Другой ответ' } })).status, 409);
  view = await (await req(`/content/project-chat/${ROOM}`, owner)).json();
  assert.equal(view.messages.filter((m) => m.authorType === 'assistant').length, 1);
  assert.equal(view.messages.at(-1).text, 'Сроки: среда');
  assert.deepEqual([view.ai.connected, view.ai.runtimeState, view.ai.queued], [true, 'connected', 0]);
  assert.equal((await req('/content/project-chat-runtime/login', owner, 'POST', { companyCode: ROOM })).status, 200, 'при подтверждённом входе команда не создаётся');
});
