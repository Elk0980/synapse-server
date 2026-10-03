'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createTaskSource, TaskSourceError } = require('./socket-source');

const SOCKET = path.join(os.tmpdir(), 'eva-test-never-connect.sock');
const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const privateText = 'PRIVATE_PAYLOAD_TOKEN_EXAMPLE_98765';
const task = (id = 5) => ({ id, title: 'Fixture task', companyCode: 'SYNAPSE', companyName: 'Synapse',
  status: 'in_progress', dueAt: '2026-10-02', nextAction: 'Review fixture', blocker: '', waitingForOwner: true });
const envelope = (tasks = [task()]) => ({ version: 1, readAt: new Date(NOW).toISOString(), tasks });

// No TCP, real Unix socket or credentials are used by these transport doubles.
function mockHttp(scripts) {
  const calls = [];
  const requests = [];
  const responses = [];
  const requestImpl = (options, callback) => {
    const script = scripts[calls.length];
    calls.push(options);
    assert.ok(script, 'unexpected extra request');
    const request = new EventEmitter();
    request.destroyed = false;
    request.destroy = () => { request.destroyed = true; request.emit('close'); };
    request.end = () => queueMicrotask(() => script({ request, callback, reply({ status = 200,
      headers = { 'content-type': 'application/json; charset=utf-8' }, body = JSON.stringify(envelope()),
      chunks, complete = true, ending = 'end' } = {}) {
      const response = new EventEmitter();
      response.statusCode = status;
      response.headers = headers;
      response.complete = complete;
      response.destroyed = false;
      response.destroy = () => { response.destroyed = true; response.emit('close'); };
      responses.push(response);
      callback(response);
      for (const chunk of chunks || [Buffer.isBuffer(body) ? body : Buffer.from(body)]) response.emit('data', chunk);
      if (ending === 'error') response.emit('error', new Error(privateText));
      else if (ending) response.emit(ending);
      return response;
    } }));
    requests.push(request);
    return request;
  };
  return { requestImpl, calls, requests, responses };
}

function sourceFrom(mock, options = {}) {
  return createTaskSource({ socketPath: SOCKET, requestImpl: mock.requestImpl, now: () => NOW, ...options });
}

async function rejectedEnvelope(value) {
  const mock = mockHttp([({ reply }) => reply({ body: JSON.stringify(value) })]);
  const source = sourceFrom(mock);
  try {
    await assert.rejects(source.listTasks(), error => error instanceof TaskSourceError && error.message === 'task_source_unavailable');
  } finally { source.close(); }
}

test('requires an absolute socket path and bounded timeout; does not offer host, URL or credential fallback', () => {
  for (const socketPath of [undefined, '', '.', 'tasks.sock', 'http://localhost/v1/tasks', `${SOCKET}\0other`]) {
    assert.throws(() => createTaskSource({ socketPath }), TaskSourceError);
  }
  for (const timeoutMs of [0, -1, 10001, Infinity, '100']) {
    assert.throws(() => createTaskSource({ socketPath: SOCKET, timeoutMs }), TaskSourceError);
  }
});

test('uses only fixed UDS GET projection and returns a new freshly fetched task array on every call', async () => {
  const mock = mockHttp([
    ({ reply }) => reply(),
    ({ reply }) => reply({ body: JSON.stringify(envelope([{ ...task(), nextAction: 'Changed in CRM' }])) }),
  ]);
  const source = sourceFrom(mock);
  const first = await source.listTasks();
  const second = await source.listTasks();
  assert.deepEqual(first, [task()]);
  assert.equal(second[0].nextAction, 'Changed in CRM');
  assert.notEqual(first, second);
  assert.deepEqual(mock.calls, [0, 1].map(() => ({ socketPath: SOCKET, method: 'GET', path: '/v1/tasks', agent: false,
    headers: { accept: 'application/json', 'cache-control': 'no-store' } })));
  for (const options of mock.calls) {
    for (const key of ['host', 'hostname', 'port', 'auth', 'protocol']) assert.equal(Object.hasOwn(options, key), false);
    assert.equal(options.headers.authorization, undefined);
  }
  source.close();
});

test('valid empty task set is distinct from failure and malformed deadline remains unknown', async () => {
  const mock = mockHttp([
    ({ reply }) => reply({ body: JSON.stringify(envelope([])) }),
    ({ reply }) => reply({ body: JSON.stringify(envelope([
      { ...task(1), dueAt: null, waitingForOwner: null },
      { ...task(2), dueAt: 'invalid', waitingForOwner: false },
      { ...task(3), dueAt: '2024-02-29', status: 'future_status' },
    ])) }),
  ]);
  const source = sourceFrom(mock);
  assert.deepEqual(await source.listTasks(), []);
  const result = await source.listTasks();
  assert.deepEqual(result.map(item => item.dueAt), [null, 'invalid', '2024-02-29']);
  assert.equal(result[2].status, 'future_status');
  source.close();
});

test('envelope must contain exactly version, ISO readAt and tasks, with no unapproved fields', async () => {
  const good = envelope();
  for (const value of [null, [], 'task', { ...good, version: 2 }, { ...good, version: '1' },
    { ...good, secret: privateText }, { ...good, tasks: {} }, { readAt: good.readAt, tasks: [] }]) {
    await rejectedEnvelope(value);
  }
});

test('every task must contain exactly the minimal projection and correct primitive types', async () => {
  const mutations = [
    { id: '5' }, { id: 0 }, { id: -1 }, { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 },
    { title: null }, { companyCode: '' }, { companyCode: ' ' }, { companyCode: 123 },
    { companyName: [] }, { status: null }, { nextAction: {} }, { blocker: false },
    { waitingForOwner: 'true' }, { waitingForOwner: 1 }, { dueAt: '2026-02-30' },
    { dueAt: '2026-10-02T12:00:00Z' }, { dueAt: '' }, { dueAt: false },
    { apiKey: privateText }, { description: privateText }, { sourceRef: privateText },
  ];
  for (const mutation of mutations) await rejectedEnvelope(envelope([{ ...task(), ...mutation }]));
  const missing = task();
  delete missing.blocker;
  await rejectedEnvelope(envelope([missing]));
  await rejectedEnvelope(envelope([task(), task()]));
  await rejectedEnvelope(envelope([task(), { ...task(), companyCode: 'ALVI' }]));
});

test('field lengths and total task count are bounded before exposing any task', async () => {
  for (const [key, length] of Object.entries({ title: 4097, companyCode: 257, companyName: 4097, status: 129, nextAction: 65537, blocker: 32769 })) {
    await rejectedEnvelope(envelope([{ ...task(), [key]: 'x'.repeat(length) }]));
  }
  await rejectedEnvelope(envelope(Array.from({ length: 10001 }, (_, index) => ({ ...task(index + 1), title: '' }))));
});

test('readAt must be canonical ISO, recent, finite and not unexpectedly in the future', async () => {
  for (const readAt of ['', '2026-10-02', '2026-10-02T12:00:00Z', '2026-02-30T12:00:00.000Z',
    new Date(NOW - 180001).toISOString(), new Date(NOW + 30001).toISOString(), 123]) {
    await rejectedEnvelope({ ...envelope(), readAt });
  }
  for (const timestamp of [NOW - 180000, NOW + 30000]) {
    const mock = mockHttp([({ reply }) => reply({ body: JSON.stringify({ ...envelope(), readAt: new Date(timestamp).toISOString() }) })]);
    const source = sourceFrom(mock);
    assert.equal((await source.listTasks()).length, 1);
    source.close();
  }
  const mock = mockHttp([({ reply }) => reply()]);
  const source = sourceFrom(mock, { now: () => NaN });
  await assert.rejects(source.listTasks(), TaskSourceError);
  source.close();
});

test('non-200 status including redirects fails without following Location or exposing error body', async () => {
  for (const status of [201, 204, 301, 302, 307, 401, 403, 500]) {
    const mock = mockHttp([({ reply }) => reply({ status, headers: {
      'content-type': 'application/json', location: `https://example.invalid/${privateText}`,
    }, body: privateText })]);
    const source = sourceFrom(mock);
    await assert.rejects(source.listTasks(), error => {
      assert.equal(error.message, 'task_source_unavailable');
      assert.equal(error.cause, undefined);
      assert.ok(!error.stack.includes(privateText));
      return true;
    });
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.responses[0].destroyed, true);
    source.close();
  }
});

test('rejects wrong content type, compression, malformed Content-Length, and oversized announced bodies', async () => {
  const invalidHeaders = [
    {}, { 'content-type': 'text/html' }, { 'content-type': 'application/json; charset=latin1' },
    { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    ...['-1', 'abc', '1.5', String(4 * 1024 * 1024 + 1)].map(length => ({ 'content-type': 'application/json', 'content-length': length })),
  ];
  for (const headers of invalidHeaders) {
    const mock = mockHttp([({ reply }) => reply({ headers })]);
    const source = sourceFrom(mock);
    await assert.rejects(source.listTasks(), TaskSourceError);
    source.close();
  }
});

test('bounds streamed bytes even without Content-Length and rejects mismatched/truncated bodies', async () => {
  const titleParts = JSON.stringify(envelope()).split('Fixture task');
  assert.equal(titleParts.length, 2, 'replace exactly the title string, preserving JSON structure');
  const [beforeTitle, afterTitle] = titleParts;
  const malformedUtf8 = Buffer.concat([Buffer.from(beforeTitle), Buffer.from([0xff]), Buffer.from(afterTitle)]);
  const lossyText = malformedUtf8.toString('utf8');
  const expectedLossyTask = { ...task(), title: '\uFFFD' };
  assert.deepEqual(JSON.parse(lossyText), envelope([expectedLossyTask]), 'only the title encoding is damaged');
  const control = sourceFrom(mockHttp([({ reply }) => reply({ body: lossyText })]));
  assert.deepEqual(await control.listTasks(), [expectedLossyTask], 'the same JSON and schema pass after lossy decoding');
  control.close();
  const scenarios = [
    { chunks: [Buffer.alloc(3 * 1024 * 1024, 32), Buffer.alloc(2 * 1024 * 1024, 32)] },
    { headers: { 'content-type': 'application/json', 'content-length': '2' } },
    { complete: false }, { ending: 'close' }, { ending: 'aborted' }, { ending: 'error' },
    { body: `${privateText}{invalid json` },
    { body: Buffer.from([0xff, 0xfe, 0xfd]) },
    { body: malformedUtf8 },
  ];
  for (const scenario of scenarios) {
    const mock = mockHttp([({ reply }) => reply(scenario)]);
    const source = sourceFrom(mock);
    await assert.rejects(source.listTasks(), error => error instanceof TaskSourceError && !error.stack.includes(privateText));
    assert.equal(mock.requests[0].destroyed, true);
    source.close();
  }
});

test('socket failures and synchronous transport exceptions are generic, without fallback or retries', async () => {
  const mock = mockHttp([({ request }) => request.emit('error', new Error(`/private/path ${privateText}`))]);
  const source = sourceFrom(mock);
  await assert.rejects(source.listTasks(), error => error instanceof TaskSourceError && !error.stack.includes(privateText));
  assert.equal(mock.calls.length, 1);
  source.close();
  const throwing = createTaskSource({ socketPath: SOCKET, requestImpl: () => { throw new Error(privateText); } });
  await assert.rejects(throwing.listTasks(), error => error instanceof TaskSourceError && error.cause === undefined && !error.stack.includes(privateText));
  throwing.close();
});

test('total read timeout aborts a stalled request and close aborts all pending reads', async () => {
  const stalled = mockHttp([() => {}]);
  const timeoutSource = sourceFrom(stalled, { timeoutMs: 15 });
  await assert.rejects(timeoutSource.listTasks(), TaskSourceError);
  assert.equal(stalled.requests[0].destroyed, true);
  timeoutSource.close();

  const mock = mockHttp([() => {}, () => {}]);
  const source = sourceFrom(mock);
  const first = source.listTasks();
  const second = source.listTasks();
  source.close();
  source.close();
  await assert.rejects(first, TaskSourceError);
  await assert.rejects(second, TaskSourceError);
  await assert.rejects(source.listTasks(), TaskSourceError);
  assert.equal(mock.calls.length, 2);
  assert.ok(mock.requests.every(request => request.destroyed));
});

test('runtime can render the async socket projection through the real bot without database access', async () => {
  const { createBot } = require('./bot');
  const { processBatch } = require('./runtime');
  const owner = 123456789;
  const mock = mockHttp([({ reply }) => reply()]);
  const source = sourceFrom(mock);
  const bot = createBot({ ownerUserId: owner, source, timeZone: 'Etc/UTC', now: () => new Date(NOW) });
  const sent = [];
  const state = { lastUpdateId: -1, save(id) { this.lastUpdateId = id; } };
  await processBatch({ updates: [{ update_id: 1, message: { message_id: 2, from: { id: owner },
    chat: { id: owner, type: 'private' }, text: '/tasks' } }], bot, state, ownerUserId: owner,
    transport: async (method, params) => sent.push({ method, params }) });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'sendMessage');
  assert.match(sent[0].params.text, /Eva/);
  assert.equal(mock.calls.length, 1);
  assert.ok(!Object.keys(require.cache).some(filename => filename === path.join(__dirname, 'task-source.js')));
  source.close();
});
