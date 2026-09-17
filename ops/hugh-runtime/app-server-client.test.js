'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {AppServerClient} = require('./app-server-client');
const {FAKE_APP_SERVER, tempDir, removeDir, writeScenario} = require('./test-support/harness');

function startClient(scenario, options = {}) {
  const dir = tempDir('hugh-rpc-');
  const scenarioPath = writeScenario(dir, scenario);
  const recordPath = path.join(dir, 'received.jsonl');
  const client = new AppServerClient({
    executable: process.execPath,
    args: [FAKE_APP_SERVER],
    env: {...process.env, HUGH_FAKE_SCENARIO: scenarioPath, HUGH_FAKE_RECORD: recordPath},
    cwd: dir,
    requestTimeoutMs: options.requestTimeoutMs || 3000,
    maxStderrBytes: options.maxStderrBytes || 1024,
    maxLineBytes: options.maxLineBytes,
  });
  client.start();
  return {
    client,
    dir,
    received: () => (fs.existsSync(recordPath) ? fs.readFileSync(recordPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
    async cleanup() {
      await client.stop('test');
      await removeDir(dir);
    },
  };
}

test('ответы сопоставляются по идентификатору даже при разрезанных строках', async (t) => {
  const harness = startClient({
    chunkBytes: 3,
    methods: {
      alpha: {result: {value: 'a'}, delayMs: 20},
      beta: {result: {value: 'b'}},
    },
  });
  t.after(() => harness.cleanup());
  const [alpha, beta] = await Promise.all([
    harness.client.request('alpha', {}),
    harness.client.request('beta', {}),
  ]);
  assert.deepEqual(alpha, {value: 'a'});
  assert.deepEqual(beta, {value: 'b'});
  const sent = harness.received();
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].id, sent[1].id);
  assert.ok(!Object.hasOwn(sent[0], 'jsonrpc'), 'поле jsonrpc не отправляется');
});

test('битый JSON и чужие идентификаторы не ломают клиента', async (t) => {
  const harness = startClient({
    preludeLines: ['{это не json', '{"id":9999,"result":{}}', '{"method":"warning","params":{"text":"x"}}'],
    methods: {ping: {result: {ok: true}}},
  });
  t.after(() => harness.cleanup());
  const errors = [];
  harness.client.on('protocolError', (reason) => errors.push(reason));
  const notifications = [];
  harness.client.on('notification', (method) => notifications.push(method));
  assert.deepEqual(await harness.client.request('ping', {}), {ok: true});
  assert.ok(errors.includes('invalid_json'));
  assert.ok(errors.includes('unexpected_response_id'));
  assert.deepEqual(notifications, ['warning']);
});

test('уведомления чужого потока доходят отдельно от ответа', async (t) => {
  const harness = startClient({
    methods: {
      'turn/start': {
        result: {turn: {id: 'turn-1'}},
        after: [
          {method: 'item/completed', params: {threadId: 'другой-поток', item: {type: 'agentMessage', id: 'x', text: 'чужое'}}},
          {method: 'turn/completed', params: {threadId: '__THREAD_ID__', turn: {id: 'turn-1', status: 'completed'}}},
        ],
        afterDelayMs: 2,
      },
    },
  });
  t.after(() => harness.cleanup());
  const seen = [];
  harness.client.on('notification', (method, params) => seen.push([method, params.threadId]));
  await harness.client.request('turn/start', {threadId: 'мой-поток'});
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(seen, [
    ['item/completed', 'другой-поток'],
    ['turn/completed', 'мой-поток'],
  ]);
});

test('ошибка app-server превращается в отказ запроса', async (t) => {
  const harness = startClient({methods: {fail: {error: {code: -32602, message: 'плохие параметры'}}}});
  t.after(() => harness.cleanup());
  await assert.rejects(harness.client.request('fail', {}), (error) => error.rpcCode === -32602);
});

test('запрос без ответа завершается по таймауту', async (t) => {
  const harness = startClient({methods: {slow: {result: {}, delayMs: 5000}}}, {requestTimeoutMs: 120});
  t.after(() => harness.cleanup());
  await assert.rejects(harness.client.request('slow', {}), (error) => error.rpcCode === 'timeout');
});

test('падение процесса отклоняет все ожидающие запросы', async (t) => {
  const harness = startClient({
    methods: {boom: {result: {}, delayMs: 5000}, kick: {result: {}, exitDelayMs: 10}},
    exitAfter: 'kick',
  });
  t.after(() => harness.cleanup());
  const pending = harness.client.request('boom', {});
  await harness.client.request('kick', {});
  await assert.rejects(pending, (error) => error.rpcCode === 'process_exit');
  assert.equal(harness.client.running, false);
});

test('поток ошибок ограничен и наружу не отдаётся', async (t) => {
  const harness = startClient({stderrBytes: 50_000, methods: {ping: {result: {}}}}, {maxStderrBytes: 1024});
  t.after(() => harness.cleanup());
  await harness.client.request('ping', {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(harness.client.stderrTail.length <= 1024);
});

test('слишком длинная строка без перевода строки останавливает процесс', async (t) => {
  const harness = startClient({preludeLines: [], methods: {ping: {result: {}}}}, {maxLineBytes: 64});
  t.after(() => harness.cleanup());
  const errors = [];
  harness.client.on('protocolError', (reason) => errors.push(reason));
  const exited = new Promise((resolve) => harness.client.once('exit', resolve));
  harness.client.child.stdout.emit('data', 'x'.repeat(200));
  assert.ok(errors.includes('stdout_line_too_long'));
  await exited;
});

test('запросы сервера к клиенту приходят отдельным событием', async (t) => {
  const harness = startClient({
    methods: {
      'turn/start': {
        result: {turn: {id: 'turn-1'}},
        serverRequests: [{id: 77, method: 'item/commandExecution/requestApproval', params: {threadId: '__THREAD_ID__'}}],
        afterDelayMs: 2,
      },
    },
  });
  t.after(() => harness.cleanup());
  const requests = [];
  harness.client.on('serverRequest', (request) => requests.push(request));
  await harness.client.request('turn/start', {threadId: 'thread-1'});
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'item/commandExecution/requestApproval');
  harness.client.respondError(requests[0].id, -32601, 'disabled');
  await new Promise((resolve) => setTimeout(resolve, 30));
  const answer = harness.received().find((message) => message.id === 77);
  assert.deepEqual(answer, {id: 77, error: {code: -32601, message: 'disabled'}});
});
