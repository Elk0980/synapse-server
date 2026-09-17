'use strict';

/* Настоящий стык: Windows-worker (LocalHughWorker + настоящий транспорт + настоящие SQLite)
   против живого сервиса content (ops/content/server.js) с его канонической очередью.
   Подменён только рантайм Codex (FakeRuntime): подписка, сеть и production не нужны.
   Проверяется: bootId/heartbeat-gating, команда входа → код у владельца, ответ → сообщение
   в чате одной транзакцией, renew во время генерации, повтор ACK без дублей, status.json.
   node --test ops/local-hugh/worker-server.integration.test.js */

const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {hashPassword} = require('../content/passwords');
const {createJobStore} = require('../hugh-runtime/job-store');
const {createTransport} = require('./transport');
const {createOutbox} = require('./outbox');
const {createStatusWriter} = require('./status-file');
const {LocalHughWorker} = require('./worker');
const {FakeRuntime, recordingLogger} = require('./test-support/fakes');

const ROOM = 'palitra-love';
const OFFICIAL = 'https://auth.openai.com/codex/device';
const CONTENT_DIR = path.join(__dirname, '..', 'content');

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const {port} = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function waitFor(check, {timeoutMs = 15_000, stepMs = 100, label = 'условие'} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`не дождались: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

test('живой content + настоящий worker: вход, ответ, renew, повтор ACK, status.json', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-hugh-live-'));
  const ownerSecret = crypto.randomBytes(24).toString('hex');
  const workerKey = crypto.randomBytes(32).toString('base64url');
  const port = await freePort();
  const deadRuntimePort = await freePort();
  const child = spawn(process.execPath, [path.join(CONTENT_DIR, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: path.join(dir, 'db.sqlite'),
      ASSETS_DIR: path.join(dir, 'assets'),
      SEED_DIR: path.join(CONTENT_DIR, 'seed'),
      API_KEY: '',
      CHAT_API_KEY: '',
      HUGH_RUNTIME_URL: `http://127.0.0.1:${deadRuntimePort}`,
      HUGH_LOCAL_WORKER_KEY_SHA256: crypto.createHash('sha256').update(workerKey).digest('hex'),
      HUGH_LOCAL_WORKER_COMPANIES: ROOM,
      AUTH_USERS: `owner:owner:${hashPassword(ownerSecret)}`,
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    },
    stdio: 'ignore',
  });
  const cleanups = [];
  t.after(async () => {
    for (const fn of cleanups.reverse()) await fn();
    child.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      fs.rmSync(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
    } catch {
      /* временный каталог */
    }
  });

  const base = `http://127.0.0.1:${port}`;
  const req = (url, session, method = 'GET', body) =>
    fetch(base + url, {
      method,
      headers: {
        ...(session ? {cookie: session.cookie, 'X-CSRF-Token': session.csrf} : {}),
        ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
      },
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
  await waitFor(async () => {
    try {
      return (await req('/health')).ok;
    } catch {
      return false;
    }
  }, {label: 'сервис content запустился', stepMs: 25});
  const loginResponse = await req('/content/login', null, 'POST', {login: 'owner', password: ownerSecret});
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
  const owner = {cookie, csrf: (await (await req('/content/whoami', {cookie})).json()).csrfToken};
  const ownerStatus = async () => (await req(`/content/project-chat-runtime/status?companyCode=${ROOM}`, owner)).json();
  const roomView = async () => (await req(`/content/project-chat/${ROOM}`, owner)).json();

  // Пока компьютер «выключен»: вопрос ждёт, команда входа создана.
  assert.equal((await req(`/content/project-chat/${ROOM}/messages`, owner, 'POST', {text: 'Хью, что со сроками?', clientMessageId: 'live-worker-01'})).status, 201);
  assert.equal((await req('/content/project-chat-runtime/login', owner, 'POST', {companyCode: ROOM})).status, 202);
  assert.equal((await ownerStatus()).state, 'offline');

  // Настоящий worker: транспорт по loopback HTTP (явный флаг), настоящие SQLite, поддельный Codex.
  const runtime = new FakeRuntime({
    snapshot: {state: 'login_required', authenticated: false, connected: false, available: false, errorCode: 'LOGIN_REQUIRED', model: 'gpt-5.5'},
    reply: async () => {
      await new Promise((resolve) => setTimeout(resolve, 900)); // дольше интервала renew
      return {text: 'Сроки: среда.', model: 'gpt-5.5'};
    },
  });
  runtime.authenticated = false;
  const workerDir = path.join(dir, 'worker');
  fs.mkdirSync(workerDir, {recursive: true});
  const statusPath = path.join(workerDir, 'status.json');
  const openWorker = (bootId) => {
    const store = createJobStore(path.join(workerDir, 'state.sqlite'), {leaseMs: 180_000});
    const outbox = createOutbox(path.join(workerDir, 'outbox.sqlite'));
    const logger = recordingLogger();
    const worker = new LocalHughWorker({
      runtime,
      store,
      outbox,
      logger,
      bootId,
      transport: createTransport({endpoint: `${base}/content/project-chat-worker`, token: workerKey, allowInsecureLoopback: true, timeoutMs: 5000}),
      companies: [ROOM],
      statusWriter: createStatusWriter(statusPath),
      settings: {heartbeatIntervalMs: 300, renewIntervalMs: 300, maxRetryAfterSeconds: 1, idleRetryAfterSeconds: 1, backoffBaseMs: 300},
    });
    const close = async () => {
      await worker.stop();
      store.close();
      outbox.close();
    };
    cleanups.push(close);
    return {worker, store, outbox, logger, close};
  };

  const first = openWorker('boot-live-1');
  await first.worker.start();

  // 1. Команда входа выдаётся первой; код попадает владельцу только через complete.
  const withCode = await waitFor(async () => {
    const status = await ownerStatus();
    return status.userCode ? status : null;
  }, {label: 'код входа у владельца'});
  assert.deepEqual([withCode.loginUrl, withCode.userCode, withCode.state], [OFFICIAL, 'ABCD-1234', 'login_required']);
  assert.ok(!JSON.stringify(await roomView()).includes('ABCD-1234'), 'снимок комнаты не содержит код');
  assert.equal(first.outbox.pendingCount(), 0);
  // Ответы без подтверждённого входа не выдаются: генерации не было.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(runtime.replyCalls.length, 0);
  assert.equal((await roomView()).ai.queued, 1);

  // 2. Вход подтверждён: следующий heartbeat открывает claim, ответ ложится в чат.
  runtime.login = {status: 'completed', loginId: null, verificationUrl: null, userCode: null, expiresAt: null, reason: null};
  runtime.authenticated = true;
  runtime.snapshot = {...runtime.snapshot, state: 'connected', authenticated: true, connected: true, available: true, errorCode: null};
  const answered = await waitFor(async () => {
    const view = await roomView();
    const reply = view.messages.find((message) => message.authorType === 'assistant');
    return reply ? view : null;
  }, {label: 'ответ Хью в чате'});
  assert.equal(answered.messages.at(-1).text, 'Сроки: среда.');
  assert.equal(runtime.replyCalls.length, 1);
  assert.equal(runtime.replyCalls[0].jobId.startsWith('project-chat:'), true);
  assert.equal(runtime.replyCalls[0].companyCode, ROOM);
  await waitFor(async () => first.outbox.pendingCount() === 0, {label: 'ACK подтверждён'});
  assert.deepEqual([answered.ai.connected, answered.ai.runtimeState, answered.ai.queued], [true, 'connected', 0]);
  assert.equal((await ownerStatus()).userCode, '', 'после входа код очищен');
  const acked = first.outbox.pending();
  assert.equal(acked.length, 0);
  assert.ok(first.logger.lines.every((line) => !line.includes(workerKey) && !line.includes('ABCD-1234')), 'в журнале нет ключа и кода');
  // Renew шёл параллельно генерации и был принят сервером.
  assert.ok(first.worker.counters.hashUnverified === 0, 'hash сохранённой строки совпал с локальной сверкой');
  assert.ok(first.worker.counters.completesAccepted >= 2, 'приняты complete входа и ответа');

  // status.json — безопасный документ с метриками сервера.
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  assert.equal(status.bootId, 'boot-live-1');
  assert.equal(status.server.lastHeartbeatOk, true);
  assert.equal(typeof status.server.stats.pendingAi, 'number');
  assert.equal(status.runtime.state, 'connected');
  const statusText = JSON.stringify(status);
  assert.ok(!statusText.includes(workerKey) && !statusText.includes('ABCD-1234') && !statusText.includes('127.0.0.1'));

  // 3. Перезапуск с той же очередью: дублей ответа нет, сервер отдаёт idle.
  await first.close();
  cleanups.pop();
  const second = openWorker('boot-live-2');
  await second.worker.start();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const after = await roomView();
  assert.equal(after.messages.filter((message) => message.authorType === 'assistant').length, 1);
  assert.equal(runtime.replyCalls.length, 1);
  assert.equal(second.worker.counters.claims, 0);
  assert.equal(second.worker.server.lastHeartbeatOk, true);

  // 4. Второй вопрос через новую загрузку: проверка renew на живом сервере при долгой генерации.
  assert.equal((await req(`/content/project-chat/${ROOM}/messages`, owner, 'POST', {text: 'Хью, а по цене?', clientMessageId: 'live-worker-02'})).status, 201);
  const secondAnswer = await waitFor(async () => {
    const view = await roomView();
    return view.messages.filter((message) => message.authorType === 'assistant').length === 2 ? view : null;
  }, {label: 'второй ответ'});
  assert.equal(secondAnswer.ai.queued, 0);
  assert.equal(second.worker.counters.claims, 1);
  assert.ok(second.worker.lastTransport, 'транспорт использовался');
  const renewLines = second.logger.lines.filter((line) => line.includes('renew'));
  assert.equal(renewLines.length, 0, 'renew на живом сервере прошёл без отказов');
});
