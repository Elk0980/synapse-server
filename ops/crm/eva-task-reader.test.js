'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { mkdtempSync, chmodSync, lstatSync, existsSync, rmdirSync } = require('node:fs');
const { homedir } = require('node:os');
const { join, dirname, basename } = require('node:path');
const http = require('node:http');
const { parseConfig, createProjection, createHandler, startTaskReader } = require('./eva-task-reader');

// These tests use synthetic project data only. On Linux, one integration test
// opens an isolated local UNIX socket; no test contacts TCP/Telegram, reads
// runtime configuration, or attaches the production database.
const validEnv = overrides => ({
  EVA_TASK_SOCKET_PATH: '/run/synapse-eva/tasks.sock',
  EVA_TASK_PROJECTS: '["alvi"]',
  ...overrides,
});
const validTask = overrides => ({ id: 1, title: 'Проверка', companyCode: 'alvi', companyName: 'ALVI',
  status: 'planned', dueAt: null, nextAction: '', blocker: '', waitingForOwner: null, ...overrides });

function fixture(t, { coordination = true, dispatch = true } = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE tasks (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, company_code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'inbox', due_date TEXT NOT NULL DEFAULT '',
    assignee_role TEXT NOT NULL DEFAULT 'synapse', is_deleted INTEGER NOT NULL DEFAULT 0,
    description TEXT DEFAULT 'PRIVATE_DESCRIPTION', source_author TEXT DEFAULT 'PRIVATE_AUTHOR');
    CREATE TABLE companies (code TEXT PRIMARY KEY COLLATE NOCASE, name TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0, notes TEXT DEFAULT 'PRIVATE_COMPANY_NOTES');
    INSERT INTO companies(code,name) VALUES ('alvi','ALVI'),('avokado','Авокадо'),
      ('synapse-business','SynapseBusiness');`);
  if (coordination) db.exec('CREATE TABLE task_coordination(task_id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
  if (dispatch) db.exec(`CREATE TABLE task_dispatch(task_id INTEGER PRIMARY KEY,
    company_code TEXT,state TEXT,lease_token TEXT DEFAULT 'PRIVATE_LEASE',
    lease_until INTEGER DEFAULT 0,attempts INTEGER DEFAULT 2,revision INTEGER DEFAULT 1);
    CREATE TABLE task_dispatch_history(id INTEGER PRIMARY KEY,task_id INTEGER,note TEXT);
    CREATE TABLE task_dispatch_alerts(id INTEGER PRIMARY KEY,task_id INTEGER,text TEXT);`);
  const add = (id, { title = `Задача ${id}`, company = 'alvi', status = 'inbox', due = '',
    role = 'synapse', deleted = 0 } = {}) => db.prepare(
    'INSERT INTO tasks(id,title,company_code,status,due_date,assignee_role,is_deleted) VALUES(?,?,?,?,?,?,?)'
  ).run(id, title, company, status, due, role, deleted);
  return { db, add };
}

async function invoke(handler, { method = 'GET', url = '/v1/tasks', headers = {} } = {}) {
  const req = new EventEmitter();
  Object.assign(req, { method, url, headers, socket: {}, resume() { return this; } });
  const res = new EventEmitter();
  const responseHeaders = {};
  let body = '';
  Object.assign(res, {
    statusCode: 200,
    setHeader(name, value) { responseHeaders[name.toLowerCase()] = value; return this; },
    getHeader(name) { return responseHeaders[name.toLowerCase()]; },
    writeHead(status, extraHeaders = {}) {
      this.statusCode = status;
      for (const [key, value] of Object.entries(extraHeaders)) this.setHeader(key, value);
      return this;
    },
    end(chunk = '') { body += chunk.toString(); this.writableEnded = true; this.emit('finish'); },
  });
  await handler(req, res);
  assert.equal(res.writableEnded, true, 'Every request has a complete response');
  return { status: res.statusCode, headers: responseHeaders, body,
    json: body ? JSON.parse(body) : null };
}

function fakeTransport({ bindError = false } = {}) {
  const socketPath = '/run/synapse-eva/tasks.sock';
  const stat = (kind, mode, uid, ino) => ({ kind, mode, uid, dev: 1, ino,
    isDirectory() { return this.kind === 'directory'; },
    isSymbolicLink() { return this.kind === 'symlink'; },
    isSocket() { return this.kind === 'socket'; },
  });
  const files = new Map([
    ['/', stat('directory', 0o755, 0, 1)],
    ['/run', stat('directory', 0o755, 0, 2)],
    ['/run/synapse-eva', stat('directory', 0o700, 1000, 3)],
  ]);
  const operations = [];
  const fsImpl = {
    lstatSync(path) {
      operations.push(['lstat', path]);
      const entry = files.get(path);
      if (!entry) throw Object.assign(new Error('PRIVATE_MISSING_PATH'), { code: 'ENOENT' });
      return { ...entry };
    },
    readdirSync(path) {
      operations.push(['readdir', path]);
      return [...files.keys()].filter(entry => entry !== path && dirname(entry) === path).map(entry => basename(entry));
    },
    chmodSync(path, mode) { operations.push(['chmod', path, mode]); files.get(path).mode = mode; },
    unlinkSync(path) { operations.push(['unlink', path]); files.delete(path); },
  };
  const server = new EventEmitter();
  Object.assign(server, {
    listening: false,
    listen(path, callback) {
      operations.push(['listen', path]);
      if (bindError) { queueMicrotask(() => server.emit('error', new Error('PRIVATE_BIND_DETAILS'))); return this; }
      files.set(path, stat('socket', 0o755, 1000, 4));
      this.listening = true;
      queueMicrotask(callback);
      return this;
    },
    close(callback) { operations.push(['close']); this.listening = false; queueMicrotask(callback); },
    closeAllConnections() { operations.push(['closeAllConnections']); },
  });
  let handler;
  const httpImpl = { createServer(value) { operations.push(['createServer']); handler = value; return server; } };
  return { socketPath, stat, files, operations, fsImpl, httpImpl, server,
    get handler() { return handler; } };
}

test('task reader is opt-in; disabled mode touches neither database nor filesystem', async () => {
  assert.equal(parseConfig({}, 'win32'), null);
  const forbidden = new Proxy({}, { get() { throw new Error('Unexpected access while disabled'); } });
  assert.equal(await startTaskReader({ db: forbidden, env: {}, platform: 'win32',
    fsImpl: forbidden, httpImpl: forbidden }), null);
});

test('valid configuration preserves a normalized Unix path and explicit lowercase project scope', () => {
  assert.deepEqual(parseConfig(validEnv({ EVA_TASK_PROJECTS: '["ALVI","synapse-business"]' }), 'linux'),
    { socketPath: '/run/synapse-eva/tasks.sock', projects: ['alvi', 'synapse-business'] });
});

test('partial configuration and unsupported platforms fail closed', () => {
  assert.throws(() => parseConfig({ EVA_TASK_SOCKET_PATH: '/run/synapse-eva/tasks.sock' }, 'linux'));
  assert.throws(() => parseConfig({ EVA_TASK_PROJECTS: '["alvi"]' }, 'linux'));
  for (const platform of ['win32', 'darwin', 'freebsd']) {
    assert.throws(() => parseConfig(validEnv(), platform), `enabled reader must reject ${platform}`);
  }
});

test('unsafe, non-normalized or oversized socket paths are rejected before filesystem access', () => {
  for (const socketPath of [
    'tasks.sock', 'C:\\run\\tasks.sock', '/run/synapse-eva/../tasks.sock',
    '/run//synapse-eva/tasks.sock', '/run/synapse-eva/./tasks.sock',
    '/run/synapse-eva/tasks', '/run/synapse-eva/tasks.sock/',
    '/run/synapse-eva/task\0s.sock', `/run/${'x'.repeat(100)}/tasks.sock`,
  ]) {
    assert.throws(() => parseConfig(validEnv({ EVA_TASK_SOCKET_PATH: socketPath }), 'linux'),
      `must reject path ${JSON.stringify(socketPath)}`);
  }
});

test('project scope rejects wildcard, blank, non-ASCII, malformed and injection input', () => {
  for (const projects of [
    '', 'alvi', 'null', '{}', '[]', '[null]', '[1]', '[""]', '[" "]', '["*"]',
    '["alvi", ""]', '["alvi,avokado"]', '["альви"]', '[" alvi"]',
    '["alvi "]', '["alvi/avokado"]', '["alvi\u0000"]',
    JSON.stringify(["alvi') OR 1=1 --"]), JSON.stringify(['x'.repeat(65)]), '["alvi","ALVI"]',
    JSON.stringify(Array.from({ length: 101 }, (_, i) => `project${i}`)),
  ]) {
    assert.throws(() => parseConfig(validEnv({ EVA_TASK_PROJECTS: projects }), 'linux'),
      `must reject projects ${JSON.stringify(projects)}`);
  }
});

test('projection returns only the approved task fields and matches scope using NOCASE', t => {
  const { db, add } = fixture(t);
  add(42, { title: 'Проверить согласование', company: 'ALVI', status: 'planned',
    due: '2026-10-02', role: 'owner' });
  add(43, { company: 'alvi', deleted: 1 });
  add(44, { company: 'avokado' });
  add(45, { company: '' });
  add(46, { company: 'alvi-extra' });
  db.prepare('INSERT INTO task_coordination VALUES(?,?)').run(42, JSON.stringify({
    nextAction: '  Получить подтверждение  ', blocker: ' Нужны материалы ',
    scope: 'PRIVATE_SCOPE', result: 'PRIVATE_RESULT', ownerThreadId: 'PRIVATE_THREAD',
  }));
  const tasks = createProjection(db, ['alvi'])();
  assert.deepEqual(tasks, [{ id: 42, title: 'Проверить согласование', companyCode: 'ALVI',
    companyName: 'ALVI', status: 'planned', dueAt: '2026-10-02',
    nextAction: 'Получить подтверждение', blocker: 'Нужны материалы', waitingForOwner: true }]);
  assert.equal(JSON.stringify(tasks).includes('PRIVATE_'), false);
});

test('configured project codes must refer to existing active companies', t => {
  const { db } = fixture(t);
  assert.throws(() => createProjection(db, ['nonexistent']));
  db.exec("UPDATE companies SET is_deleted=1 WHERE code='avokado'");
  assert.throws(() => createProjection(db, ['avokado']));
});

test('waiting status follows explicit owner signals, excluding other companies and closed tasks', t => {
  const { db, add } = fixture(t);
  for (let id = 1; id <= 10; id++) add(id);
  db.exec(`UPDATE tasks SET assignee_role='owner' WHERE id IN (1,6,7);
    UPDATE tasks SET status='done' WHERE id=6;
    UPDATE tasks SET status='cancelled' WHERE id=7;
    INSERT INTO task_dispatch(task_id,company_code,state) VALUES
      (2,'ALVI','needs_input'),(3,'alvi','review'),(4,'alvi','blocked'),
      (5,'alvi','awaiting_executor'),(6,'alvi','needs_input'),
      (8,'avokado','needs_input'),(10,'alvi','running');
    INSERT INTO task_coordination VALUES(9,'{"blocker":"Ждём стороннего исполнителя"}');`);
  assert.deepEqual(createProjection(db, ['alvi'])().map(task => task.waitingForOwner),
    [true, true, true, null, null, false, false, null, null, null]);
});

test('optional metadata tables may be absent without inventing a next action or waiting state', t => {
  const { db, add } = fixture(t, { coordination: false, dispatch: false });
  add(1);
  assert.deepEqual(createProjection(db, ['alvi'])(), [{ id: 1, title: 'Задача 1',
    companyCode: 'alvi', companyName: 'ALVI', status: 'inbox', dueAt: null,
    nextAction: '', blocker: '', waitingForOwner: null }]);
});

test('invalid metadata and invalid calendar dates remain explicit unknowns', t => {
  const { db, add } = fixture(t);
  const dates = ['2026-02-30', '2026-10-02T12:00:00Z', '', '2028-02-29', '2026-13-01', '2026-2-01'];
  dates.forEach((due, index) => add(index + 1, { due }));
  const put = db.prepare('INSERT INTO task_coordination VALUES(?,?)');
  put.run(1, 'not-json');
  put.run(2, '{"nextAction":42,"blocker":["not text"]}');
  put.run(3, 'null');
  put.run(4, '{"nextAction":"Проверить"}');
  put.run(5, '["PRIVATE_ARRAY"]');
  const tasks = createProjection(db, ['alvi'])();
  assert.deepEqual(tasks.map(task => task.dueAt), ['invalid', 'invalid', null, '2028-02-29', 'invalid', 'invalid']);
  assert.deepEqual(tasks.map(task => task.nextAction), ['', '', '', 'Проверить', '', '']);
  assert.deepEqual(tasks.map(task => task.blocker), ['', '', '', '', '', '']);
});

test('each read uses current tasks and scope after a title edit, project move or deletion', t => {
  const { db, add } = fixture(t);
  add(1, { title: 'Первая версия' });
  const read = createProjection(db, ['alvi']);
  assert.equal(read()[0].title, 'Первая версия');
  db.exec("UPDATE tasks SET title='Текущая версия' WHERE id=1");
  assert.equal(read()[0].title, 'Текущая версия');
  db.exec("UPDATE tasks SET company_code='avokado' WHERE id=1");
  assert.deepEqual(read(), []);
  db.exec("UPDATE tasks SET company_code='alvi', is_deleted=1 WHERE id=1");
  assert.deepEqual(read(), []);
});

test('pure SELECT projection cannot reconcile expired leases or mutate CRM/history', t => {
  const { db, add } = fixture(t);
  add(1);
  db.exec("INSERT INTO task_dispatch(task_id,company_code,state) VALUES(1,'alvi','running')");
  const before = db.prepare('SELECT total_changes() AS n').get().n;
  const original = db.prepare('SELECT * FROM task_dispatch').all();
  db.exec('PRAGMA query_only=ON');
  const read = createProjection(db, ['alvi']);
  read(); read();
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
  assert.deepEqual(db.prepare('SELECT * FROM task_dispatch').all(), original);
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_dispatch_history').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_dispatch_alerts').get().n, 0);
});

test('deleting a configured company immediately revokes its tasks from the projection', t => {
  const { db, add } = fixture(t);
  add(1);
  const read = createProjection(db, ['alvi']);
  assert.equal(read().length, 1);
  db.exec("UPDATE companies SET is_deleted=1 WHERE code='alvi'");
  assert.deepEqual(read(), []);
});

test('literal GET returns a fresh bounded envelope with no-cache headers', async () => {
  let calls = 0;
  const handler = createHandler({ readTasks: () => [validTask({ id: ++calls })],
    now: () => new Date('2026-10-02T12:34:56.000Z') });
  for (const id of [1, 2]) {
    const response = await invoke(handler);
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { version: 1, readAt: '2026-10-02T12:34:56.000Z', tasks: [validTask({ id })] });
    assert.match(response.headers['content-type'], /^application\/json/);
    assert.match(response.headers['cache-control'], /no-store/);
  }
});

test('non-GET methods are rejected without reading tasks', async () => {
  let calls = 0;
  const handler = createHandler({ readTasks: () => { calls++; return []; } });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    assert.equal((await invoke(handler, { method })).status, 405);
  }
  assert.equal(calls, 0);
});

test('query strings, encodings and unrelated paths cannot expand the task endpoint', async () => {
  let calls = 0;
  const handler = createHandler({ readTasks: () => { calls++; return []; } });
  for (const url of ['/v1/tasks?companyCode=avokado', '/v1/tasks?', '/v1/tasks/',
    '/v1/%74asks', '/tasks', '/coordination/tasks', 'http://localhost/v1/tasks', '/v1/tasks#fragment']) {
    assert.equal((await invoke(handler, { url })).status, 404, url);
  }
  assert.equal(calls, 0);
});

test('GET with a body framing header fails before source access', async () => {
  let calls = 0;
  const handler = createHandler({ readTasks: () => { calls++; return []; } });
  for (const headers of [{ 'content-length': '1' }, { 'content-length': 'invalid' },
    { 'transfer-encoding': 'chunked' }, { 'content-length': '0', 'transfer-encoding': 'chunked' }]) {
    assert.equal((await invoke(handler, { headers })).status, 400);
  }
  assert.equal(calls, 0);
});

test('source errors are static and never expose exception details or task data', async () => {
  const response = await invoke(createHandler({ readTasks() {
    throw new Error('PRIVATE_DB_PATH PRIVATE_TASK_TEXT PRIVATE_TOKEN_SENTINEL');
  } }));
  assert.equal(response.status, 503);
  assert.deepEqual(response.json, { error: 'tasks_unavailable' });
  assert.equal(response.body.includes('PRIVATE_'), false);
});

test('oversized task counts and response payloads fail without sending partial task lists', async () => {
  for (const tasks of [Array.from({ length: 10001 }, (_, index) => validTask({ id: index + 1 })),
    Array.from({ length: 70 }, (_, index) => validTask({ id: index + 1, nextAction: 'x'.repeat(65536) }))]) {
    const response = await invoke(createHandler({ readTasks: () => tasks }));
    assert.equal(response.status, 503);
    assert.deepEqual(response.json, { error: 'tasks_unavailable' });
    assert.ok(response.body.length < 100);
  }
});

test('handler strips accidental extra internal fields and rejects malformed DTOs', async () => {
  const response = await invoke(createHandler({ readTasks: () => [validTask({
    description: 'PRIVATE_DESCRIPTION', lease_token: 'PRIVATE_LEASE', ownerThreadId: 'PRIVATE_THREAD',
  })] }));
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.tasks, [validTask()]);
  assert.equal(response.body.includes('PRIVATE_'), false);
  for (const tasks of [null, {}, [null], [validTask({ id: 0 })], [validTask({ id: Number.MAX_SAFE_INTEGER + 1 })],
    [validTask({ nextAction: {} })], [validTask({ dueAt: '2026-02-30' })], [validTask({ waitingForOwner: 'yes' })]]) {
    const rejected = await invoke(createHandler({ readTasks: () => tasks }));
    assert.equal(rejected.status, 503);
    assert.deepEqual(rejected.json, { error: 'tasks_unavailable' });
  }
});

test('startup binds only the configured socket, applies restrictive mode and closes idempotently', async t => {
  const { db, add } = fixture(t);
  add(1);
  const transport = fakeTransport();
  const reader = await startTaskReader({ db, env: validEnv(), platform: 'linux', uid: 1000,
    fsImpl: transport.fsImpl, httpImpl: transport.httpImpl });
  assert.deepEqual(transport.operations.filter(([op]) => op === 'listen'), [['listen', transport.socketPath]]);
  assert.deepEqual(transport.operations.filter(([op]) => op === 'chmod'), [['chmod', transport.socketPath, 0o600]]);
  assert.equal(transport.files.get(transport.socketPath).mode, 0o600);
  assert.equal(transport.server.maxConnections, 4);
  assert.equal(transport.server.maxRequestsPerSocket, 1);
  assert.equal(db.prepare('PRAGMA query_only').get().query_only, 0, 'Shared CRM connection remains writable');
  assert.equal((await invoke(transport.handler)).json.tasks[0].id, 1);
  await reader.close(); await reader.close();
  assert.equal(transport.operations.filter(([op]) => op === 'close').length, 1);
  assert.deepEqual(transport.operations.filter(([op]) => op === 'unlink'), [['unlink', transport.socketPath]]);
  assert.equal(transport.files.has(transport.socketPath), false);
});

test('startup rejects unsafe ancestors, missing/private directory violations and any existing path', async t => {
  const { db } = fixture(t);
  const modifications = [
    transport => transport.files.delete('/run/synapse-eva'),
    transport => { transport.files.get('/run/synapse-eva').mode = 0o755; },
    transport => { transport.files.get('/run/synapse-eva').uid = 0; },
    transport => { transport.files.get('/run').mode = 0o777; },
    transport => { transport.files.get('/run').uid = 2000; },
    transport => { transport.files.get('/run').kind = 'symlink'; },
    transport => { transport.files.get('/run/synapse-eva').kind = 'file'; },
    transport => { transport.files.set('/run/synapse-eva/crm.sqlite', transport.stat('file', 0o600, 1000, 79)); },
    ...['socket', 'file', 'symlink'].map(kind => transport => {
      transport.files.set(transport.socketPath, transport.stat(kind, 0o600, 1000, 80));
    }),
  ];
  for (const modify of modifications) {
    const transport = fakeTransport();
    modify(transport);
    await assert.rejects(startTaskReader({ db, env: validEnv(), platform: 'linux', uid: 1000,
      fsImpl: transport.fsImpl, httpImpl: transport.httpImpl }), { message: 'socket_unavailable' });
    assert.equal(transport.operations.some(([op]) => ['listen', 'chmod', 'unlink', 'createServer'].includes(op)), false);
  }
});

test('startup requires a verifiable uid and valid source before creating transport', async t => {
  const { db } = fixture(t);
  for (const uid of [null, -1, 1.5, '1000']) {
    const transport = fakeTransport();
    await assert.rejects(startTaskReader({ db, env: validEnv(), platform: 'linux', uid,
      fsImpl: transport.fsImpl, httpImpl: transport.httpImpl }), { message: 'socket_unavailable' });
    assert.equal(transport.operations.some(([op]) => op === 'createServer'), false);
  }
  const transport = fakeTransport();
  await assert.rejects(startTaskReader({ db, env: validEnv({ EVA_TASK_PROJECTS: '["unknown"]' }),
    platform: 'linux', uid: 1000, fsImpl: transport.fsImpl, httpImpl: transport.httpImpl }),
  { message: 'socket_unavailable' });
  assert.equal(transport.operations.some(([op]) => op === 'createServer'), false);
});

test('bind failure is redacted and does not unlink paths it did not create', async t => {
  const { db } = fixture(t);
  const transport = fakeTransport({ bindError: true });
  await assert.rejects(startTaskReader({ db, env: validEnv(), platform: 'linux', uid: 1000,
    fsImpl: transport.fsImpl, httpImpl: transport.httpImpl }), { message: 'socket_unavailable' });
  assert.equal(transport.operations.some(([op]) => op === 'unlink'), false);
});

test('failed socket permissions close the listener and remove only its own socket', async t => {
  const { db } = fixture(t);
  const transport = fakeTransport();
  transport.fsImpl.chmodSync = () => { throw new Error('PRIVATE_PERMISSION_DETAILS'); };
  await assert.rejects(startTaskReader({ db, env: validEnv(), platform: 'linux', uid: 1000,
    fsImpl: transport.fsImpl, httpImpl: transport.httpImpl }), { message: 'socket_unavailable' });
  assert.equal(transport.server.listening, false);
  assert.deepEqual(transport.operations.filter(([op]) => op === 'unlink'), [['unlink', transport.socketPath]]);
});

test('explicit fallback cleanup skips replaced inode (mock transport)', async t => {
  // This mock proves only the module's explicit unlink check. Node/libuv close
  // itself unlinks the bound pathname. The real transport therefore depends on
  // its private 0700 directory and the operator stopping it before touching files.
  const { db } = fixture(t);
  const duringStartup = fakeTransport();
  duringStartup.fsImpl.chmodSync = (path, mode) => {
    duringStartup.files.set(path, duringStartup.stat('socket', mode, 1000, 99));
  };
  await assert.rejects(startTaskReader({ db, env: validEnv(), platform: 'linux', uid: 1000,
    fsImpl: duringStartup.fsImpl, httpImpl: duringStartup.httpImpl }), { message: 'socket_unavailable' });
  assert.equal(duringStartup.files.get(duringStartup.socketPath).ino, 99);
  assert.equal(duringStartup.operations.some(([op]) => op === 'unlink'), false);

  const duringShutdown = fakeTransport();
  const reader = await startTaskReader({ db, env: validEnv(), platform: 'linux', uid: 1000,
    fsImpl: duringShutdown.fsImpl, httpImpl: duringShutdown.httpImpl });
  duringShutdown.files.set(duringShutdown.socketPath, duringShutdown.stat('socket', 0o600, 1000, 100));
  await reader.close();
  assert.equal(duringShutdown.files.get(duringShutdown.socketPath).ino, 100);
  assert.equal(duringShutdown.operations.some(([op]) => op === 'unlink'), false);
});

test('malformed transport clients are closed without replies; runtime failure closes the listener', async t => {
  const { db } = fixture(t);
  const transport = fakeTransport();
  const reader = await startTaskReader({ db, env: validEnv(), platform: 'linux', uid: 1000,
    fsImpl: transport.fsImpl, httpImpl: transport.httpImpl });
  let destroyed = false;
  transport.server.emit('clientError', new Error('PRIVATE_PROTOCOL_DETAILS'), { destroy() { destroyed = true; } });
  assert.equal(destroyed, true);
  transport.server.emit('error', new Error('PRIVATE_RUNTIME_DETAILS'));
  await reader.close();
  assert.equal(transport.server.listening, false);
  assert.equal(transport.files.has(transport.socketPath), false);
});

test('Linux integration: actual private UNIX socket serves scoped tasks and is removed on stop',
  { skip: process.platform !== 'linux' ? 'Requires Linux filesystem ownership and UNIX sockets' : false }, async t => {
    // Use a private parent rather than /tmp, whose writable ancestry the reader rejects.
    const base = homedir();
    const directory = mkdtempSync(join(base, '.eva-task-reader-test-'));
    assert.equal(dirname(directory), base);
    assert.ok(basename(directory).startsWith('.eva-task-reader-test-'));
    let reader;
    t.after(async () => {
      try { await reader?.close(); }
      finally {
        // Never recursively remove a computed path or any directory we did not create.
        assert.equal(dirname(directory), base);
        assert.ok(basename(directory).startsWith('.eva-task-reader-test-'));
        rmdirSync(directory);
      }
    });
    chmodSync(directory, 0o700);
    const socketPath = join(directory, 'tasks.sock');
    const { db, add } = fixture(t);
    add(1, { title: 'Разрешённая задача' });
    add(2, { title: 'Чужая задача', company: 'avokado' });
    reader = await startTaskReader({ db, env: validEnv({ EVA_TASK_SOCKET_PATH: socketPath }) });
    assert.equal(lstatSync(directory).mode & 0o777, 0o700);
    const socket = lstatSync(socketPath);
    assert.equal(socket.isSocket(), true);
    assert.equal(socket.mode & 0o777, 0o600);
    assert.equal(socket.uid, process.getuid());
    const request = path => new Promise((resolve, reject) => {
      const req = http.get({ socketPath, path, agent: false }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('error', reject);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
          catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.setTimeout(2000, () => req.destroy(new Error('Local test request timed out')));
    });
    const current = await request('/v1/tasks');
    assert.equal(current.status, 200);
    assert.deepEqual(current.body.tasks.map(task => task.id), [1]);
    assert.equal((await request('/v1/tasks?companyCode=avokado')).status, 404);
    await reader.close();
    assert.equal(existsSync(socketPath), false);
    assert.equal(existsSync(directory), true, 'Shutdown keeps its dedicated directory');
  });
