'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {RuntimeError, unavailable} = require('../hugh-runtime/errors');
const {CONTRACT_ERROR_CODES} = require('./error-codes');
const {
  START_TIME,
  FakeClock,
  FakeTransport,
  networkError,
  sha256,
  replyPayload,
  claimedJob,
  createHarness,
} = require('./test-support/fakes');

const HEARTBEAT_FIELDS = ['state', 'authenticated', 'connected', 'available', 'limited', 'retryAfter', 'provider', 'model', 'safety', 'errorCode'];

/* Транспорт «один claim с заданием, дальше пусто; complete принимается». */
function scriptedTransport(job, options = {}) {
  const transport = new FakeTransport();
  transport.on('claim', async (body, index) => {
    if (index === 1 && job) return {status: 200, body: {job}};
    return {status: 200, body: {job: null, retryAfter: options.retryAfter ?? 5}};
  });
  transport.on('complete', options.complete || (async () => ({status: 200, body: {ok: true}})));
  transport.on('renew', options.renew || (async () => ({status: 200, body: {ok: true, leaseExpiresAt: new Date(START_TIME + 400_000).toISOString()}})));
  transport.on('heartbeat', options.heartbeat || (async () => ({status: 200, body: {ok: true, serverTime: new Date(START_TIME).toISOString(), stats: {}}})));
  return transport;
}

test('heartbeat уходит с ограниченными полями и никогда не содержит кодов входа', async () => {
  const transport = new FakeTransport();
  transport.on('heartbeat', async () => ({
    status: 200,
    body: {
      ok: true,
      serverTime: '2026-09-17T10:00:01.000Z',
      stats: {lastSeen: '2026-09-17T09:59:00.000Z', offline: false, pendingAi: 2, oldestPendingAgeSeconds: 41.9, humanMessagesWhileOffline24h: 3, aiRequestsWhileOffline24h: 1, secret: 'x'},
    },
  }));
  const harness = createHarness({transport});
  try {
    await harness.runtime.startLogin(); // вход ожидает подтверждения: в снимке есть код и ссылка
    assert.equal(harness.runtime.statusSnapshot().userCode, 'ABCD-1234');
    await harness.worker.heartbeatOnce();
    const call = transport.callsFor('heartbeat')[0];
    assert.equal(call.body.bootId, 'boot-0001');
    assert.deepEqual(Object.keys(call.body.status).sort(), [...HEARTBEAT_FIELDS].sort());
    const serialized = JSON.stringify(call.body);
    assert.ok(!serialized.includes('ABCD-1234'));
    assert.ok(!serialized.includes('auth.openai.com'));
    assert.ok(!serialized.includes('Текст ошибки'));
    assert.deepEqual(call.body.status.safety, {toolIsolationVerified: true, reason: 'proof_ok'});
    const status = harness.lastStatus();
    assert.equal(status.server.lastHeartbeatOk, true);
    assert.equal(status.server.serverTime, '2026-09-17T10:00:01.000Z');
    assert.deepEqual(status.server.stats, {
      lastSeen: '2026-09-17T09:59:00.000Z',
      offline: false,
      pendingAi: 2,
      oldestPendingAgeSeconds: 41,
      humanMessagesWhileOffline24h: 3,
      aiRequestsWhileOffline24h: 1,
    });
    assert.equal(status.runtime.loginPending, true);
    assert.ok(!JSON.stringify(status).includes('ABCD-1234'));
  } finally {
    await harness.cleanup();
  }
});

test('claim → генерация → outbox → complete с эхом payloadHash и результатом контракта', async () => {
  const job = claimedJob();
  const transport = scriptedTransport(job);
  const harness = createHarness({transport});
  try {
    const outcome = await harness.worker.claimOnce();
    assert.equal(outcome.kind, 'job');
    assert.equal(harness.outbox.readActiveJob().jobId, '42'); // задание на диске сразу после claim
    const result = await harness.worker.processJob(outcome.job);
    assert.deepEqual(result, {ok: true, text: 'Готово.', provider: 'codex', model: 'gpt-5.5'});
    const complete = transport.callsFor('complete');
    assert.equal(complete.length, 1);
    assert.deepEqual(complete[0].body, {jobId: '42', leaseToken: 'lease-token-0001', payloadHash: job.payloadHash, result});
    assert.equal(harness.outbox.pendingCount(), 0);
    assert.equal(harness.outbox.readActiveJob(), null);
    assert.equal(harness.outbox.get('42').outcome, 'accepted');
    assert.equal(harness.store.get('palitra-love', 'project-chat:42').status, 'completed');
    assert.deepEqual(harness.runtime.replyCalls[0], replyPayload());
    const status = harness.lastStatus();
    assert.equal(status.worker.counters.claims, 1);
    assert.equal(status.worker.counters.completesAccepted, 1);
    assert.equal(status.worker.counters.hashUnverified, 0);
    assert.equal(status.worker.activeJob, null);
  } finally {
    await harness.cleanup();
  }
});

/* processJob принимает задание в нормализованном виде (как после parseClaimedJob). */
function normalize(raw) {
  return {
    jobId: raw.id,
    kind: raw.kind,
    companyCode: raw.companyCode,
    payload: raw.payload,
    payloadHash: raw.payloadHash,
    leaseToken: raw.leaseToken,
    leaseExpiresAt: raw.leaseExpiresAt,
  };
}

test('идемпотентность: повтор того же задания не запускает вторую генерацию', async () => {
  const job = claimedJob();
  const harness = createHarness({transport: scriptedTransport(job)});
  try {
    const first = await harness.worker.processJob(normalize(job));
    const second = await harness.worker.processJob(normalize({...job, leaseToken: 'lease-token-0002'}));
    assert.equal(harness.runtime.replyCalls.length, 1);
    assert.deepEqual(second, first);
    assert.equal(harness.lastStatus().worker.counters.repliesReused, 1);
    // Второй complete ушёл с новой арендой, но с тем же результатом.
    const completes = harness.transport.callsFor('complete');
    assert.equal(completes[1].body.leaseToken, 'lease-token-0002');
    assert.deepEqual(completes[1].body.result, first);
  } finally {
    await harness.cleanup();
  }
});

test('hash: payloadHash сервера уходит обратно без изменений, даже если локальная сверка не сошлась', async () => {
  // Ключи в другом порядке: JSON.stringify даёт другую строку, чем сохранил сервер.
  const payload = replyPayload();
  const reordered = {system: payload.system, messages: payload.messages, companyCode: payload.companyCode, jobId: payload.jobId};
  const serverHash = sha256(JSON.stringify(payload));
  const job = claimedJob({payload: reordered, payloadHash: serverHash});
  const harness = createHarness({transport: scriptedTransport(job)});
  try {
    await harness.worker.processJob(normalize(job));
    const complete = harness.transport.callsFor('complete')[0];
    assert.equal(complete.body.payloadHash, serverHash);
    assert.equal(harness.lastStatus().worker.counters.hashUnverified, 1);
    assert.ok(harness.logger.lines.some((line) => line.includes('payload_hash_unverified')));
  } finally {
    await harness.cleanup();
  }
});

test('claim с невалидным заданием (плохой hash, чужой kind) не берётся', async () => {
  const transport = new FakeTransport();
  const bad = [claimedJob({payloadHash: 'not-a-hash'}), claimedJob({kind: 'shell'}), {...claimedJob(), leaseToken: 'x'}];
  transport.on('claim', async (body, index) => ({status: 200, body: {job: bad[index - 1] || null}}));
  const harness = createHarness({transport});
  try {
    for (let index = 0; index < bad.length; index += 1) {
      assert.equal((await harness.worker.claimOnce()).kind, 'error');
    }
    assert.equal(harness.lastStatus().worker.counters.invalidClaims, 3);
    assert.equal(harness.outbox.readActiveJob(), null);
    assert.equal(harness.runtime.replyCalls.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('complete недоступен: результат остаётся в outbox, новых claim нет до подтверждения', async () => {
  const job = claimedJob();
  const transport = scriptedTransport(job, {
    complete: async (body, index) => (index === 1 ? networkError() : {status: 200, body: {ok: true}}),
  });
  const harness = createHarness({transport});
  try {
    await harness.worker.start();
    await harness.clock.advance(0);
    const operations = transport.calls.map((call) => call.operation);
    const firstComplete = operations.indexOf('complete');
    const secondComplete = operations.indexOf('complete', firstComplete + 1);
    assert.ok(firstComplete > 0, 'первый complete отправлен');
    assert.equal(operations.slice(0, firstComplete).filter((op) => op === 'claim').length, 1);
    // После сбоя цикл ждёт backoff; за это время claim не идёт.
    assert.equal(secondComplete, -1);
    assert.equal(harness.outbox.pendingCount(), 1);
    assert.equal(harness.outbox.get('42').attempts, 1);
    assert.equal(harness.outbox.get('42').lastCategory, 'network');
    await harness.clock.advance(5_000);
    const after = transport.calls.map((call) => call.operation);
    const retry = after.indexOf('complete', firstComplete + 1);
    assert.ok(retry > firstComplete, 'повторный complete отправлен');
    assert.equal(after.slice(firstComplete, retry).filter((op) => op === 'claim').length, 0);
    assert.ok(after.indexOf('claim', retry) > retry, 'claim возобновился после подтверждения');
    assert.equal(harness.outbox.pendingCount(), 0);
    assert.equal(harness.lastStatus().worker.counters.completesAccepted, 1);
  } finally {
    await harness.cleanup();
  }
});

test('complete: 409 — окончательный отказ без повторов, 401/5xx — ждать и повторять', async () => {
  const job = claimedJob();
  const statuses = [409];
  const harness = createHarness({transport: scriptedTransport(job, {complete: async () => ({status: statuses.shift() ?? 200, body: {}})})});
  try {
    await harness.worker.processJob(normalize(job));
    assert.equal(harness.outbox.pendingCount(), 0);
    assert.equal(harness.outbox.get('42').outcome, 'rejected');
    assert.equal(harness.lastStatus().worker.counters.completesRejected, 1);

    statuses.push(401, 503, 200);
    const second = claimedJob({id: '43', payload: replyPayload({jobId: 'project-chat:43'})});
    await harness.worker.processJob(normalize(second));
    assert.equal(harness.outbox.pendingCount(), 1);
    assert.equal(harness.outbox.get('43').lastCategory, 'http_401');
    assert.equal(await harness.worker.flushOutbox(), 1);
    assert.equal(harness.outbox.get('43').lastCategory, 'http_503');
    assert.equal(await harness.worker.flushOutbox(), 0);
    assert.equal(harness.outbox.get('43').outcome, 'accepted');
  } finally {
    await harness.cleanup();
  }
});

test('перезапуск: неподтверждённый результат отправляется раньше любого claim', async () => {
  const job = claimedJob();
  const first = createHarness({transport: scriptedTransport(job, {complete: async () => networkError()})});
  await first.worker.processJob(normalize(job));
  assert.equal(first.outbox.pendingCount(), 1);
  await first.cleanup(true);

  const transport = scriptedTransport(null);
  const second = createHarness({dir: first.dir, transport, bootId: 'boot-0002'});
  try {
    await second.worker.start();
    await second.clock.advance(0);
    const operations = transport.calls.map((call) => call.operation);
    assert.equal(operations.indexOf('complete') >= 0, true);
    assert.ok(operations.indexOf('complete') < operations.indexOf('claim'));
    assert.equal(second.outbox.pendingCount(), 0);
    assert.equal(transport.callsFor('complete')[0].body.leaseToken, 'lease-token-0001');
    assert.equal(second.runtime.replyCalls.length, 0); // повторной генерации нет
  } finally {
    await second.cleanup();
  }
});

test('перезапуск во время генерации: аренда подтверждается renew и задание доводится', async () => {
  const job = claimedJob();
  const first = createHarness({
    transport: scriptedTransport(job),
    runtimeOptions: {reply: () => new Promise(() => {})}, // «падение» посреди генерации
  });
  const claim = await first.worker.claimOnce();
  assert.equal(claim.kind, 'job');
  first.worker.processJob(claim.job).catch(() => {});
  await first.clock.advance(0);
  assert.equal(first.store.get('palitra-love', 'project-chat:42').status, 'pending');
  first.store.close();
  first.outbox.close();

  const transport = scriptedTransport(null);
  const second = createHarness({dir: first.dir, transport, bootId: 'boot-0002'});
  try {
    const recovered = await second.worker.recover();
    assert.equal(recovered.jobId, '42');
    assert.equal(transport.callsFor('renew').length, 1);
    assert.deepEqual(transport.callsFor('renew')[0].body, {jobId: '42', leaseToken: 'lease-token-0001'});
    await second.worker.processJob(recovered);
    assert.equal(second.runtime.replyCalls.length, 1);
    const complete = transport.callsFor('complete')[0];
    assert.equal(complete.body.leaseToken, 'lease-token-0001');
    assert.equal(complete.body.result.ok, true);
    assert.equal(second.outbox.readActiveJob(), null);
  } finally {
    await second.cleanup();
  }
});

test('перезапуск: заменённая или истёкшая аренда отпускается без генерации', async () => {
  const job = claimedJob();
  const first = createHarness({transport: scriptedTransport(job), runtimeOptions: {reply: () => new Promise(() => {})}});
  const claim = await first.worker.claimOnce();
  first.worker.processJob(claim.job).catch(() => {});
  await first.clock.advance(0);
  first.store.close();
  first.outbox.close();

  const rejected = scriptedTransport(null, {renew: async () => ({status: 409, body: {}})});
  const second = createHarness({dir: first.dir, transport: rejected, bootId: 'boot-0002'});
  assert.equal(await second.worker.recover(), null);
  assert.equal(second.outbox.readActiveJob(), null);
  assert.equal(second.store.get('palitra-love', 'project-chat:42'), null); // аренда job-store снята
  assert.equal(rejected.callsFor('complete').length, 0);
  assert.equal(second.runtime.replyCalls.length, 0);
  await second.cleanup(true);

  // Истёкшая по локальным часам аренда даже не спрашивает сервер.
  const third = createHarness({transport: scriptedTransport(job), runtimeOptions: {reply: () => new Promise(() => {})}, dir: first.dir});
  const again = await third.worker.claimOnce();
  third.worker.processJob(again.job).catch(() => {});
  await third.clock.advance(0);
  third.store.close();
  third.outbox.close();
  const lateClock = new FakeClock(START_TIME + 10 * 60 * 1000);
  const late = scriptedTransport(null);
  const fourth = createHarness({dir: first.dir, transport: late, clock: lateClock, bootId: 'boot-0003'});
  try {
    assert.equal(await fourth.worker.recover(), null);
    assert.equal(late.callsFor('renew').length, 0);
    assert.ok(fourth.logger.lines.some((line) => line.includes('recovery_dropped reason="lease_expired"')));
  } finally {
    await fourth.cleanup();
  }
});

test('таймеры: heartbeat каждые 20 с продолжается во время генерации, renew каждые 20 с только пока идёт ход', async () => {
  let resolveReply = null;
  const job = claimedJob();
  const transport = scriptedTransport(job);
  const harness = createHarness({transport, runtimeOptions: {reply: () => new Promise((resolve) => (resolveReply = resolve))}});
  try {
    await harness.worker.start();
    await harness.clock.advance(0);
    assert.equal(transport.callsFor('heartbeat').length, 1);
    assert.equal(transport.callsFor('claim').length, 1);
    assert.equal(harness.lastStatus().worker.activeJob.kind, 'reply');

    await harness.clock.advance(20_000);
    assert.equal(transport.callsFor('heartbeat').length, 2);
    assert.equal(transport.callsFor('renew').length, 1);
    assert.deepEqual(transport.callsFor('renew')[0].body, {jobId: '42', leaseToken: 'lease-token-0001'});

    await harness.clock.advance(20_000);
    assert.equal(transport.callsFor('heartbeat').length, 3);
    assert.equal(transport.callsFor('renew').length, 2);
    assert.equal(transport.callsFor('complete').length, 0);

    resolveReply({text: 'Ответ.', model: 'gpt-5.5'});
    await harness.clock.advance(0);
    assert.equal(transport.callsFor('complete').length, 1);
    assert.equal(harness.lastStatus().worker.activeJob, null);

    await harness.clock.advance(40_000);
    assert.equal(transport.callsFor('renew').length, 2, 'после завершения хода renew не идёт');
    assert.equal(transport.callsFor('heartbeat').length, 5);
    assert.ok(transport.callsFor('claim').length >= 2, 'после ответа claim продолжается');

    await harness.worker.stop();
    assert.equal(harness.clock.pendingTimers(), 0, 'после остановки таймеров нет');
  } finally {
    await harness.cleanup();
  }
});

test('renew с 409 помечает потерю аренды, но результат всё равно доводится до complete', async () => {
  let resolveReply = null;
  const job = claimedJob();
  const transport = scriptedTransport(job, {renew: async () => ({status: 409, body: {}})});
  const harness = createHarness({transport, runtimeOptions: {reply: () => new Promise((resolve) => (resolveReply = resolve))}});
  try {
    await harness.worker.start();
    await harness.clock.advance(0);
    await harness.clock.advance(20_000);
    assert.equal(harness.lastStatus().worker.activeJob.leaseLost, true);
    resolveReply({text: 'Ответ.', model: 'gpt-5.5'});
    await harness.clock.advance(0);
    assert.equal(transport.callsFor('complete').length, 1);
  } finally {
    await harness.cleanup();
  }
});

test('login: код и ссылка уходят только через complete и только пока вход ожидается', async () => {
  const job = claimedJob({id: 'login:7', kind: 'login', payload: {}});
  const transport = scriptedTransport(job);
  // Как у настоящего рантайма при ожидающем входе: connecting, не авторизован, LOGIN_REQUIRED.
  const harness = createHarness({transport, runtimeOptions: {snapshot: {state: 'connecting', authenticated: false, connected: false, available: false, errorCode: 'LOGIN_REQUIRED'}}});
  try {
    const result = await harness.worker.processJob(normalize(job));
    assert.equal(result.ok, true);
    assert.equal(result.status.loginUrl, 'https://auth.openai.com/codex/device');
    assert.equal(result.status.userCode, 'ABCD-1234');
    assert.equal(result.status.expiresAt, new Date(harness.runtime.login.expiresAt).toISOString());
    assert.equal(result.status.errorCode, 'LOGIN_REQUIRED');
    assert.equal(result.status.authenticated, false);
    // Сервер принимает код только при состоянии входа; рантайм в это время показывает connecting.
    assert.equal(result.status.state, 'login_pending');
    for (const field of HEARTBEAT_FIELDS) assert.ok(field in result.status, field);
    assert.equal(transport.callsFor('complete')[0].body.jobId, 'login:7');
    // В heartbeat состояние остаётся тем, что показал рантайм.
    await harness.worker.heartbeatOnce();
    assert.equal(transport.callsFor('heartbeat').at(-1).body.status.state, 'connecting');

    // Heartbeat сразу после — по-прежнему без кода.
    await harness.worker.heartbeatOnce();
    assert.ok(!JSON.stringify(transport.callsFor('heartbeat').at(-1).body).includes('ABCD-1234'));
    assert.ok(!JSON.stringify(harness.lastStatus()).includes('ABCD-1234'));

    // Срок вышел — поля пустые, ничего не выдумывается.
    await harness.clock.advance(16 * 60 * 1000);
    const expired = harness.worker.loginStatus();
    assert.equal(expired.loginUrl, null);
    assert.equal(expired.userCode, null);
    assert.equal(expired.expiresAt, null);
  } finally {
    await harness.cleanup();
  }
});

test('login: отказ рантайма превращается в конверт закрытого списка', async () => {
  const job = claimedJob({id: 'login:8', kind: 'login', payload: {}});
  const harness = createHarness({
    transport: scriptedTransport(job),
    runtimeOptions: {startLogin: async () => {
      throw unavailable('LOGIN_FAILED', 'Сырое сообщение с адресом https://auth.example/?code=SECRET');
    }},
  });
  try {
    const result = await harness.worker.processJob(normalize(job));
    assert.deepEqual(result, {ok: false, errorCode: 'UNAVAILABLE', retryAfter: 60});
    assert.ok(!harness.logger.lines.join('\n').includes('SECRET'));
  } finally {
    await harness.cleanup();
  }
});

test('коды отказа reply строго из закрытого списка, аренда job-store снимается для временных', async () => {
  const cases = [
    {error: new RuntimeError(429, 'RATE_LIMITED', 'лимит', {retryAfterSeconds: 900}), expect: {errorCode: 'RATE_LIMITED', retryAfter: 900}, released: true},
    {error: unavailable('LOGIN_REQUIRED', 'вход'), expect: {errorCode: 'LOGIN_REQUIRED', retryAfter: 120}, released: false},
    {error: unavailable('TOOL_ISOLATION_UNVERIFIED', 'изоляция'), expect: {errorCode: 'SAFETY_REJECTED', retryAfter: 600}, released: false},
    {error: unavailable('UPSTREAM_ERROR', 'модель'), expect: {errorCode: 'UNAVAILABLE', retryAfter: 60}, released: false},
    {error: new RuntimeError(429, 'BUSY', 'занят', {retryAfterSeconds: 5}), expect: {errorCode: 'BUSY', retryAfter: 5}, released: true},
    {error: new TypeError('stack and raw text'), expect: {errorCode: 'INTERNAL_ERROR', retryAfter: 60}, released: false},
  ];
  for (const [index, entry] of cases.entries()) {
    const id = String(100 + index);
    const job = claimedJob({id, payload: replyPayload({jobId: `project-chat:${id}`})});
    const harness = createHarness({transport: scriptedTransport(job), runtimeOptions: {reply: async () => {
      throw entry.error;
    }}});
    try {
      const result = await harness.worker.processJob(normalize(job));
      assert.deepEqual(result, {ok: false, ...entry.expect});
      assert.ok(CONTRACT_ERROR_CODES.includes(result.errorCode));
      const row = harness.store.get('palitra-love', `project-chat:${id}`);
      if (entry.released) assert.equal(row, null);
      else assert.equal(row.status, 'failed');
      assert.deepEqual(harness.transport.callsFor('complete')[0].body.result, result);
      assert.ok(!harness.logger.lines.join('\n').includes('stack and raw text'));
    } finally {
      await harness.cleanup();
    }
  }
});

test('невалидный payload — INVALID_PAYLOAD без обращения к модели', async () => {
  const job = claimedJob({payload: {jobId: 'project-chat:42', companyCode: 'palitra-love', messages: []}});
  const harness = createHarness({transport: scriptedTransport(job)});
  try {
    const result = await harness.worker.processJob(normalize(job));
    assert.deepEqual(result, {ok: false, errorCode: 'INVALID_PAYLOAD', retryAfter: 0});
    assert.equal(harness.runtime.replyCalls.length, 0);
    const mismatch = claimedJob({id: '44', payload: replyPayload({jobId: 'project-chat:44', companyCode: 'other-co'})});
    const mismatched = await harness.worker.processJob(normalize(mismatch));
    assert.equal(mismatched.errorCode, 'INVALID_PAYLOAD');
    assert.equal(harness.runtime.replyCalls.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('scope: задание чужой компании не выполняется и не завершается, claim замирает на время', async () => {
  const job = claimedJob({companyCode: 'other-co', payload: replyPayload({companyCode: 'other-co'})});
  const harness = createHarness({transport: scriptedTransport(job)});
  try {
    const outcome = await harness.worker.claimOnce();
    assert.equal(outcome.kind, 'job');
    assert.equal(await harness.worker.processJob(outcome.job), null);
    assert.equal(harness.runtime.replyCalls.length, 0);
    assert.equal(harness.transport.callsFor('complete').length, 0);
    assert.equal(harness.outbox.readActiveJob(), null);
    assert.equal(harness.lastStatus().worker.counters.scopeRejected, 1);
    assert.equal((await harness.worker.claimOnce()).kind, 'blocked');
    await harness.clock.advance(300_000);
    assert.equal((await harness.worker.claimOnce()).kind, 'idle');
  } finally {
    await harness.cleanup();
  }
});

test('offline: сбои heartbeat и claim не роняют worker и не раскрывают ничего лишнего', async () => {
  const transport = new FakeTransport();
  transport.on('heartbeat', async () => networkError());
  transport.on('claim', async () => networkError());
  const harness = createHarness({transport});
  try {
    await harness.worker.start();
    await harness.clock.advance(0);
    const status = harness.lastStatus();
    assert.equal(status.server.lastHeartbeatOk, false);
    assert.equal(status.server.lastHeartbeatStatus, null);
    assert.equal(status.worker.lastTransport.category, 'network');
    assert.ok(status.worker.counters.transportErrors >= 2);
    await harness.clock.advance(60_000);
    assert.ok(transport.callsFor('claim').length >= 2, 'после backoff claim повторяется');
    assert.ok(transport.callsFor('heartbeat').length >= 3);
    const text = harness.logger.lines.join('\n');
    assert.ok(text.includes('heartbeat_transport_error category="network"'));
    assert.ok(!/Bearer|https?:\/\//.test(text));
  } finally {
    await harness.cleanup();
  }
});

test('обслуживание: прогрев остановленного процесса и периодическое перечитывание учётной записи', async () => {
  const harness = createHarness({transport: scriptedTransport(null), runtimeOptions: {clientRunning: false}});
  try {
    await harness.worker.start();
    await harness.clock.advance(0);
    assert.equal(harness.runtime.warmUps, 1);
    assert.equal(harness.runtime.refreshes, 0);
    await harness.clock.advance(60_000);
    assert.equal(harness.runtime.refreshes, 1);
    await harness.clock.advance(60_000);
    assert.equal(harness.runtime.refreshes, 1, 'учётная запись перечитывается не чаще раза в 5 минут');
    await harness.clock.advance(240_000);
    assert.equal(harness.runtime.refreshes, 2);
  } finally {
    await harness.cleanup();
  }
});

test('status.json: снимок не содержит ключа, кодов входа, путей и текстов ошибок', async () => {
  const harness = createHarness({transport: scriptedTransport(null), runtimeOptions: {snapshot: {state: 'login_required', errorCode: 'LOGIN_REQUIRED', connected: false, available: false}}});
  try {
    await harness.runtime.startLogin();
    await harness.worker.heartbeatOnce();
    const status = harness.lastStatus();
    assert.equal(status.schema, 1);
    assert.equal(status.runtime.state, 'login_required');
    assert.equal(status.runtime.errorCode, 'LOGIN_REQUIRED');
    assert.equal(status.runtime.loginPending, true);
    assert.equal('loginUrl' in status.runtime, false);
    assert.equal('userCode' in status.runtime, false);
    assert.equal('error' in status.runtime, false);
    const text = JSON.stringify(status);
    assert.ok(!text.includes('ABCD-1234'));
    assert.ok(!text.includes('Текст ошибки'));
    assert.ok(!text.includes(harness.dir.replace(/\\/g, '\\\\')));
  } finally {
    await harness.cleanup();
  }
});
