'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createTaskCoordination, migrateTasksMcp} = require('../crm/task-coordination');
const {createModuleArchive} = require('../crm/module-archive');
const {installArchiveSchema} = require('../crm/module-archive-schema');

const owner = {role: 'owner', userId: 7, companyCodes: new Set(['alpha', 'beta'])};
const alphaOwner = {...owner, companyCodes: new Set(['alpha'])};
const initialTime = Date.parse('2026-11-03T11:00:00Z');
function fixture(t, {install = true, actor = owner} = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(code TEXT PRIMARY KEY,is_deleted INTEGER NOT NULL DEFAULT 0);
    INSERT INTO companies(code) VALUES('alpha'),('beta');
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0,deleted_at TEXT,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',
      company_code TEXT NOT NULL DEFAULT '',assignee_role TEXT DEFAULT 'synapse',assignee_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'inbox' CHECK(status IN ('inbox','planned','in_progress','done','cancelled')),
      priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
      due_date TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','chat','telegram','pipeline')),
      source_ref TEXT NOT NULL DEFAULT '',source_author TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL DEFAULT '');
    INSERT INTO tasks(id,created_at,updated_at,title,company_code) VALUES
      (21,'old','old','Прежняя задача','alpha'),(22,'old','old','Задача другого проекта','beta');
    INSERT INTO tasks(id,created_at,updated_at,title,company_code,is_deleted) VALUES
      (23,'old','old','Удалённая задача','alpha',1);`);
  const clock = {value: initialTime};
  createTaskCoordination(db, {now: () => clock.value});
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try { migrateTasksMcp(db); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.exec('PRAGMA foreign_keys=ON'); }
  const tasks = createTaskCoordination(db, {now: () => clock.value});
  if (install) installArchiveSchema(db, {now: () => clock.value});
  const api = createModuleArchive(db, {now: () => clock.value});
  const start = (name = 'Codex fixture', currentActor = actor) => tasks.tool('session_start',
    {agent: name, kind: 'codex', request: 'Архив сайтов'}, currentActor);
  const session = start();
  const args = (extra = {}) => ({session_id: session.session_id, client_ref: 'sample-archive-1',
    module: 'sites', project: 'alpha', type: 'report', text: 'SAMPLE результат проверки', ...extra});
  const call = (name, input = {}, currentActor = actor) => api.tool(name, input, currentActor);
  return {db, api, tasks, clock, session, args, call, start};
}
const status = expected => error => error.status === expected;
const count = (db, table) => db.prepare(`SELECT count(*) n FROM ${table}`).get().n;

test('archive is additive: missing migration returns 503, session hints stay empty, no schema is created', t => {
  const f = fixture(t, {install: false});
  const schemaBefore = f.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
  assert.deepEqual(f.api.hints('Архив сайтов', owner), []);
  for (const [name, args] of [['archive_list', {}], ['archive_read', {id: 1}], ['archive_write', f.args()]]) {
    assert.throws(() => f.call(name, args), status(503));
  }
  assert.deepEqual(f.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(), schemaBefore);
  assert.equal(f.tasks.tool('task_get', {task_id: 21}, owner).title, 'Прежняя задача');
});

test('archive write derives the author from the real open session and preserves task data', t => {
  const f = fixture(t);
  const before = f.db.prepare('SELECT * FROM tasks ORDER BY id').all();
  const result = f.call('archive_write', f.args({task_id: 21,
    links: [{url: 'https://example.test/report.pdf', kind: 'file', label: 'Отчёт'}]}));
  assert.equal(result.created, true);
  assert.equal(result.entry.project, 'alpha');
  assert.equal(result.entry.agent.name, 'Codex fixture');
  assert.equal(result.entry.agent.id, f.session.agent.id);
  assert.equal(result.entry.owner_id, owner.userId);
  assert.equal(result.entry.task_id, 21);
  assert.equal(result.entry.links[0].kind, 'file');
  assert.equal(result.entry.passwordHash, undefined);
  assert.equal(count(f.db, 'module_archive_access'), 1);
  assert.equal(f.db.prepare('SELECT operation,session_id FROM module_archive_access').get().session_id, f.session.session_id);
  assert.deepEqual(f.db.prepare('SELECT * FROM tasks ORDER BY id').all(), before);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('archive rejects missing, ended, foreign-owner and changed-scope sessions without writing', t => {
  const f = fixture(t);
  for (const invalid of [undefined, '', 'not-a-session']) {
    assert.throws(() => f.call('archive_write', f.args({session_id: invalid})), error => [400, 404].includes(error.status));
  }
  assert.throws(() => f.call('archive_write', f.args(), {...owner, userId: 8}), status(404));
  assert.throws(() => f.call('archive_write', f.args(), alphaOwner), status(404));
  f.tasks.tool('session_end', {session_id: f.session.session_id, summary: 'Завершено'}, owner);
  assert.throws(() => f.call('archive_write', f.args()), status(404));
  assert.throws(() => f.call('archive_list', {session_id: f.session.session_id}), status(404));
  assert.equal(count(f.db, 'module_archive_entries'), 0);
  assert.equal(count(f.db, 'module_archive_access'), 0);
});

test('archive does not inherit the implicit Synapse projects of legacy task sessions', t => {
  const f = fixture(t, {actor: alphaOwner});
  const stored = JSON.parse(f.db.prepare('SELECT projects FROM agent_sessions WHERE id=?').get(f.session.session_id).projects);
  assert.ok(stored.includes('synapse-business'));
  assert.throws(() => f.call('archive_write', f.args({project: 'synapse-business'})), status(404));
  assert.throws(() => f.call('archive_write', f.args({project: 'beta'})), status(404));
  assert.throws(() => f.call('archive_list', {project: 'beta'}), status(404));
  const result = f.call('archive_list');
  assert.equal(result.entries.length, 0);
  assert.ok(result.usage.every(item => item.project === 'alpha'));
  const explicit = {...owner, companyCodes: new Set(['synapse-business'])};
  const session = f.start('Root project fixture', explicit);
  assert.equal(f.call('archive_write', f.args({project: 'synapse-business', session_id: session.session_id}), explicit).created, true);
});

test('archive client_ref is durable idempotency, a changed payload conflicts and retries are logged', t => {
  const f = fixture(t);
  const first = f.call('archive_write', f.args());
  const newInstance = createModuleArchive(f.db, {now: () => f.clock.value});
  const second = newInstance.tool('archive_write', f.args({links: [], task_id: null}), owner);
  assert.equal(second.created, false);
  assert.equal(second.entry.id, first.entry.id);
  assert.equal(count(f.db, 'module_archive_entries'), 1);
  assert.equal(count(f.db, 'module_archive_access'), 2);
  assert.throws(() => f.call('archive_write', f.args({text: 'Иное содержание'})), status(409));
  assert.throws(() => f.call('archive_write', f.args({project: 'beta'})), status(409));
  assert.equal(count(f.db, 'module_archive_access'), 2);
});

test('archive entries, open sessions and retry keys survive another SQLite connection', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-module-archive-api-'));
  const databasePath = path.join(dir, 'crm.sqlite');
  t.after(() => {
    const absolute = path.resolve(dir), tempRoot = path.resolve(os.tmpdir());
    if (path.dirname(absolute) !== tempRoot || !path.basename(absolute).startsWith('synapse-module-archive-api-')) {
      throw new Error('Некорректный путь собственного временного стенда');
    }
    fs.rmSync(absolute, {recursive: true, force: true});
  });
  const f = fixture(t);
  const first = f.call('archive_write', f.args()).entry;
  // SQLite делает согласованный снимок всей установленной схемы и открытой сессии.
  // Проверку file-backed миграции с обязательным backup выполняет отдельный набор.
  f.db.prepare('VACUUM INTO ?').run(databasePath);
  const secondDb = new DatabaseSync(databasePath);
  try {
    secondDb.exec('PRAGMA foreign_keys=ON');
    const secondApi = createModuleArchive(secondDb, {now: () => f.clock.value});
    const retried = secondApi.tool('archive_write', f.args(), owner);
    assert.equal(retried.created, false);
    assert.equal(retried.entry.id, first.id);
    assert.equal(secondApi.tool('archive_read', {id: first.id}, owner).entry.text, first.text);
    assert.equal(count(secondDb, 'module_archive_entries'), 1);
    assert.deepEqual(secondDb.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { secondDb.close(); }
});

test('archive task and correction references stay in the same active module/project', t => {
  const f = fixture(t);
  for (const task_id of [22, 23, 999]) assert.throws(() => f.call('archive_write', f.args({task_id})), status(404));
  const original = f.call('archive_write', f.args()).entry;
  const correction = f.call('archive_write', f.args({client_ref: 'sample-correction', type: 'decision',
    text: 'Исправление результата', supersedes_id: original.id}));
  assert.equal(correction.entry.supersedes_id, original.id);
  assert.equal(f.call('archive_read', {id: original.id}).entry.text, 'SAMPLE результат проверки');
  for (const extra of [{module: 'crm'}, {project: 'beta'}, {supersedes_id: 999}]) {
    assert.throws(() => f.call('archive_write', f.args({client_ref: 'sample-invalid-correction', supersedes_id: original.id, ...extra})), status(404));
  }
  assert.equal(count(f.db, 'module_archive_entries'), 2);
});

test('archive list and detail filter projects, log actor identity, paginate and report seven-day usage', t => {
  const f = fixture(t);
  const first = f.call('archive_write', f.args()).entry;
  const foreign = f.call('archive_write', f.args({client_ref: 'sample-beta', project: 'beta', text: 'Чужой проект'})).entry;
  f.call('archive_write', f.args({client_ref: 'sample-alpha-second', text: 'Вторая запись'}));
  assert.throws(() => f.call('archive_read', {id: foreign.id}, alphaOwner), status(404));
  f.call('archive_read', {id: first.id}, alphaOwner);
  f.call('archive_read', {id: first.id, session_id: f.session.session_id});
  const page = f.call('archive_list', {module: 'sites', limit: 1, offset: 1}, alphaOwner);
  assert.deepEqual(page.pagination, {total: 2, limit: 1, offset: 1});
  assert.equal(page.entries[0].id, first.id);
  assert.equal(page.modules.length, 1);
  assert.ok(page.usage.every(item => item.project === 'alpha' && item.module === 'sites'));
  assert.deepEqual(page.usage_pagination, {total: 2, limit: 1, offset: 1});
  const usage = f.call('archive_list', {module: 'sites', project: 'alpha'}, alphaOwner).usage;
  assert.ok(usage.some(item => item.agent?.name === 'Codex fixture' && item.writes === 2));
  assert.ok(usage.some(item => item.agent === null && item.reads >= 1));
  assert.equal(f.db.prepare("SELECT count(*) n FROM module_archive_access WHERE operation='read'").get().n, 2);
  f.clock.value += 8 * 86400000;
  const later = f.call('archive_list', {module: 'sites', project: 'alpha'});
  assert.ok(later.usage.every(item => item.writes === 0));
});

test('archive rechecks project deletion for existing records and hides inactive-project usage', t => {
  const f = fixture(t);
  const entry = f.call('archive_write', f.args({project: 'beta'})).entry;
  f.db.prepare("UPDATE companies SET is_deleted=1 WHERE code='beta'").run();
  assert.throws(() => f.call('archive_read', {id: entry.id}), status(404));
  assert.throws(() => f.call('archive_write', f.args({project: 'beta'})), status(404));
  assert.throws(() => f.call('archive_list', {project: 'beta'}), status(404));
  const result = f.call('archive_list');
  assert.equal(result.entries.length, 0);
  assert.ok(result.usage.every(item => item.project !== 'beta'));
});

test('archive validates direct CRM input and rejects malformed or extra fields before any audit', t => {
  const f = fixture(t);
  const invalid = [
    {author: 'Подмена'}, {client_ref: ''}, {module: 'missing'}, {type: 'update'}, {text: ' '},
    {text: 'x'.repeat(10001)}, {project: '../alpha'}, {task_id: -1},
    {links: [{url: 'http://example.test/file'}]}, {links: [{url: 'https://user:pass@example.test/file'}]},
    {links: [{url: 'javascript:alert(1)'}]}, {links: [{url: 'https://example.test', extra: true}]},
    {links: [{url: 'https://example.test', kind: 'html'}]},
    {links: [{url: 'https://example.test'}, {url: 'https://example.test'}]},
    {links: Array.from({length: 51}, (_, index) => ({url: `https://example.test/${index}`}))}
  ];
  for (const extra of invalid) assert.throws(() => f.call('archive_write', f.args(extra)), error => [400, 404].includes(error.status));
  for (const args of [{limit: 101}, {limit: 0}, {offset: -1}, {offset: 1000001}, {project: 'alpha', sql: 'x'}]) {
    assert.throws(() => f.call('archive_list', args), status(400));
  }
  assert.throws(() => f.call('archive_read', {id: 1, author: 'Подмена'}), status(400));
  assert.throws(() => f.call('archive_list', {}, {...owner, role: 'editor'}), status(403));
  assert.equal(count(f.db, 'module_archive_entries'), 0);
  assert.equal(count(f.db, 'module_archive_access'), 0);
});

test('archive readers see project-scoped author attribution without another session capability or request hash', t => {
  const f = fixture(t);
  const entry = f.call('archive_write', f.args()).entry;
  const anotherOwner = {...alphaOwner, userId: 8};
  const sharedRead = f.call('archive_read', {id: entry.id}, anotherOwner);
  assert.equal(sharedRead.entry.agent.id, f.session.agent.id);
  assert.equal(sharedRead.entry.owner_id, owner.userId);
  assert.equal(sharedRead.entry.session_id, undefined);
  assert.equal(sharedRead.entry.client_ref, undefined);
  assert.equal(sharedRead.entry.request_hash, undefined);
  assert.ok(!JSON.stringify(sharedRead).includes(f.session.session_id));
  assert.throws(() => f.call('archive_read', {id: entry.id, session_id: f.session.session_id}, anotherOwner), status(404));
  assert.throws(() => f.call('archive_list', {session_id: f.session.session_id}, anotherOwner), status(404));
  f.tasks.tool('session_end', {session_id: f.session.session_id, summary: 'Закрыто'}, owner);
  const ownRead = f.call('archive_list', {project: 'alpha'});
  assert.ok(!JSON.stringify(ownRead).includes(f.session.session_id));
  assert.ok(ownRead.usage.every(item => item.project === 'alpha'));
});

test('archive write and read fail atomically if the mandatory access log cannot be appended', t => {
  const f = fixture(t);
  f.db.exec("CREATE TRIGGER fixture_reject_audit BEFORE INSERT ON module_archive_access BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
  assert.throws(() => f.call('archive_write', f.args()), /audit unavailable/);
  assert.equal(count(f.db, 'module_archive_entries'), 0);
  f.db.exec('DROP TRIGGER fixture_reject_audit');
  const entry = f.call('archive_write', f.args()).entry;
  f.db.exec("CREATE TRIGGER fixture_reject_audit BEFORE INSERT ON module_archive_access BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
  assert.throws(() => f.call('archive_read', {id: entry.id}), /audit unavailable/);
  assert.equal(count(f.db, 'module_archive_access'), 1);
});

test('archive corrections append and raw SQL cannot rewrite or delete original entries and audit', t => {
  const f = fixture(t);
  const entry = f.call('archive_write', f.args()).entry;
  assert.throws(() => f.db.prepare('UPDATE module_archive_entries SET text=? WHERE id=?').run('Подмена', entry.id));
  assert.throws(() => f.db.prepare('DELETE FROM module_archive_entries WHERE id=?').run(entry.id));
  assert.throws(() => f.db.prepare('UPDATE module_archive_access SET operation=?').run('read'));
  assert.throws(() => f.db.prepare('DELETE FROM module_archive_access').run());
  assert.equal(f.call('archive_read', {id: entry.id}).entry.text, 'SAMPLE результат проверки');
});

test('archive session hints return real module cards and tool arguments without inventing UI links or audit reads', t => {
  const f = fixture(t);
  const hints = f.api.hints('Сайты и контент-завод: следующий этап', owner);
  assert.ok(hints.some(item => item.code === 'sites'));
  assert.ok(hints.some(item => item.code === 'content-factory'));
  for (const hint of hints) {
    assert.deepEqual(hint.tool, {name: 'archive_list', arguments: {module: hint.code}});
    assert.equal(hint.url, undefined);
    assert.ok(hint.name);
  }
  assert.equal(count(f.db, 'module_archive_access'), 0);
});
