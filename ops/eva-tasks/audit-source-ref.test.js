'use strict';

// Regression tests for the existing CRM route, executed with its actual task schema,
// validation, serialization and handler in an isolated VM. No server is started.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

const source = readFileSync(join(__dirname, '..', 'crm', 'server.js'), 'utf8');
function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'Review CRM extraction boundaries when functions move');
  return source.slice(start, end);
}
const routeCode = [
  `const ENTITY_CONFIG = {${section('  tasks: {', '  legalEntities: {')}};`,
  section('const SYSTEM_FIELDS =', 'function entityId('),
  section('function column(', 'function checkedString('),
  section('function validDay(', 'function validateArray('),
  section('const TASK_ENUMS =', 'function validateEntity('),
  section('function serializeEntity(', 'function sharedCompanyCount('),
  section('function scopedCompany(', 'function entityInCompany('),
  section('async function handleEntityRoutes(', 'async function handleRelationRoutes('),
  'this.handle = handleEntityRoutes;',
].join('\n');

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(section('CREATE TABLE IF NOT EXISTS tasks (', 'CREATE INDEX IF NOT EXISTS tasks_company_code_idx'));
  db.exec(`CREATE TABLE companies(code TEXT PRIMARY KEY COLLATE NOCASE,is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies(code) VALUES('alvi'),('avokado');`);
  const context = {
    db,
    readJson: async request => request.body,
    send: (response, status, body) => { Object.assign(response, { status, body }); },
    fail: (status, message) => { throw Object.assign(new Error(message), { status }); },
    conflict: error => { throw error; },
  };
  vm.createContext(context);
  // Delegate only the task-specific validation; other entities/authentication are outside scope.
  vm.runInContext(`${routeCode}\nfunction validateEntity(_config, body) { return validateTask(body, false); }`, context);
  async function post(overrides = {}, companyScope = null) {
    const response = {};
    const body = { title: 'Фиктивное поручение', companyCode: 'alvi', source: 'chat',
      sourceRef: 'fixture-channel:request-7', ...overrides };
    const url = new URL('http://fixture/tasks');
    if (companyScope !== null) url.searchParams.set('companyCode', companyScope);
    await context.handle({ method: 'POST', body }, response, url, {});
    return response;
  }
  return { db, post, count: () => db.prepare('SELECT count(*) AS n FROM tasks').get().n };
}

test('same company and source repeat returns the original ID without changing the task', async t => {
  const { db, post, count } = fixture(t);
  const first = await post();
  db.prepare("UPDATE tasks SET status='done',company_code='ALVI' WHERE id=?").run(first.body.id);
  const repeated = await post({ title: 'Повтор с другим текстом' }, 'ALVI');
  assert.equal(first.status, 201); assert.equal(repeated.status, 200);
  assert.equal(repeated.body.id, first.body.id); assert.equal(repeated.body.duplicate, true);
  assert.equal(repeated.body.title, first.body.title); assert.equal(repeated.body.status, 'done');
  assert.equal(count(), 1);
});

test('equal sourceRef in another company creates a distinct task using the effective request scope', async t => {
  const { post, count } = fixture(t);
  const alvi = await post();
  const avokado = await post({}, 'avokado');
  assert.equal(avokado.status, 201);
  assert.notEqual(avokado.body.id, alvi.body.id);
  assert.equal(avokado.body.companyCode, 'avokado');
  assert.equal(avokado.body.duplicate, undefined); assert.equal(count(), 2);
});

test('equal sourceRef from another valid source creates a distinct task in the same company', async t => {
  const { post, count } = fixture(t);
  const chat = await post();
  const telegram = await post({ source: 'telegram' });
  assert.equal(telegram.status, 201);
  assert.notEqual(telegram.body.id, chat.body.id);
  assert.equal(telegram.body.source, 'telegram'); assert.equal(count(), 2);
  assert.equal((await post({ source: 'telegram' })).body.id, telegram.body.id);
});

test('deleted tasks do not suppress a replacement and remain deleted', async t => {
  const { db, post, count } = fixture(t);
  const first = await post();
  db.prepare('UPDATE tasks SET is_deleted=1 WHERE id=?').run(first.body.id);
  const replacement = await post();
  assert.equal(replacement.status, 201); assert.notEqual(replacement.body.id, first.body.id);
  assert.equal(db.prepare('SELECT is_deleted FROM tasks WHERE id=?').get(first.body.id).is_deleted, 1);
  assert.equal((await post()).body.id, replacement.body.id); assert.equal(count(), 2);
});

test('empty sourceRef keeps the existing create-every-time behavior', async t => {
  const { post, count } = fixture(t);
  const first = await post({ sourceRef: '' });
  const second = await post({ sourceRef: '' });
  assert.equal(second.status, 201); assert.notEqual(second.body.id, first.body.id);
  assert.equal(count(), 2);
});

test('unassigned company remains a separate idempotency scope', async t => {
  const { post, count } = fixture(t);
  await post();
  const unassigned = await post({ companyCode: '' });
  assert.equal(unassigned.status, 201); assert.equal(unassigned.body.companyCode, '');
  const repeated = await post({ companyCode: '' });
  assert.equal(repeated.status, 200); assert.equal(repeated.body.id, unassigned.body.id);
  assert.equal(count(), 2);
});

test('concurrent requests within this single synchronous SQLite handler keep one ID', async t => {
  const { post, count } = fixture(t);
  const responses = await Promise.all(Array.from({ length: 8 }, () => post()));
  assert.equal(responses.filter(response => response.status === 201).length, 1);
  assert.equal(new Set(responses.map(response => response.body.id)).size, 1);
  assert.equal(count(), 1);
});
