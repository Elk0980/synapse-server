'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { createTaskSource } = require('./task-source');

function fixture(t, { coordination = true, dispatch = true, wal = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'eva-task-source-'));
  const dbPath = join(directory, 'crm-fixture.sqlite');
  const writer = new DatabaseSync(dbPath);
  const sources = [];
  t.after(() => {
    for (const source of sources) source.close();
    writer.close();
    // This path is created by this test only, not a repository or runtime data path.
    assert.equal(directory.startsWith(join(tmpdir(), 'eva-task-source-')), true);
    rmSync(directory, { recursive: true, force: true });
  });
  if (wal) writer.exec('PRAGMA journal_mode = WAL');
  writer.exec(`CREATE TABLE tasks (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, company_code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'inbox', due_date TEXT NOT NULL DEFAULT '',
    assignee_role TEXT NOT NULL DEFAULT 'synapse', is_deleted INTEGER NOT NULL DEFAULT 0,
    description TEXT DEFAULT 'PRIVATE DESCRIPTION', source_author TEXT DEFAULT 'PRIVATE AUTHOR');
    CREATE TABLE companies (code TEXT PRIMARY KEY COLLATE NOCASE, name TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0, notes TEXT DEFAULT 'PRIVATE NOTES');
    INSERT INTO companies(code,name) VALUES ('alvi','ALVI'),('avokado','Авокадо');`);
  if (coordination) writer.exec('CREATE TABLE task_coordination(task_id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
  if (dispatch) writer.exec('CREATE TABLE task_dispatch(task_id INTEGER PRIMARY KEY,company_code TEXT,state TEXT)');
  const add = (id, title, company = 'alvi', status = 'inbox', due = '', role = 'synapse', deleted = 0) => writer.prepare(
    'INSERT INTO tasks(id,title,company_code,status,due_date,assignee_role,is_deleted) VALUES(?,?,?,?,?,?,?)'
  ).run(id, title, company, status, due, role, deleted);
  const open = () => { const source = createTaskSource({ dbPath }); sources.push(source); return source; };
  return { dbPath, writer, add, open };
}

test('projects only allowed fields, preserves canonical IDs and dates, excludes deleted tasks', t => {
  const { writer, add, open } = fixture(t);
  add(42, 'Подготовить согласование', 'ALVI', 'planned', '2026-10-02', 'owner');
  add(43, 'Удалённая задача', 'alvi', 'done', '', 'owner', 1);
  writer.prepare('INSERT INTO task_coordination VALUES(?,?)').run(42, JSON.stringify({
    nextAction: '  Получить подтверждение  ', blocker: 'Нужны материалы',
    scope: 'PRIVATE SCOPE', ownerThreadId: 'PRIVATE THREAD', result: 'PRIVATE RESULT',
  }));
  const tasks = open().listTasks();
  assert.deepEqual(tasks, [{ id: 42, title: 'Подготовить согласование', companyCode: 'ALVI',
    companyName: 'ALVI', status: 'planned', dueAt: '2026-10-02',
    nextAction: 'Получить подтверждение', blocker: 'Нужны материалы', waitingForOwner: true }]);
  assert.equal(JSON.stringify(tasks).includes('PRIVATE'), false);
});

test('waiting uses explicit owner signals, never a generic blocker or another company dispatch', t => {
  const { writer, add, open } = fixture(t);
  for (let id = 1; id <= 9; id++) add(id, `Задача ${id}`);
  writer.exec(`UPDATE tasks SET assignee_role='owner' WHERE id IN (1,6,7);
    UPDATE tasks SET status='done' WHERE id=6;
    UPDATE tasks SET status='cancelled' WHERE id=7;
    INSERT INTO task_dispatch VALUES (2,'alvi','needs_input'), (3,'alvi','review'),
      (4,'alvi','blocked'), (5,'alvi','awaiting_executor'), (6,'alvi','needs_input'),
      (8,'avokado','needs_input');
    INSERT INTO task_coordination VALUES (9,'{"blocker":"Ждём стороннего исполнителя"}');`);
  assert.deepEqual(open().listTasks().map(task => task.waitingForOwner),
    [true, true, true, null, null, false, false, null, null]);
});

test('missing optional metadata remains unknown; company labels are not invented', t => {
  const { writer, add, open } = fixture(t, { coordination: false, dispatch: false });
  add(1, 'Без проекта', '');
  add(2, 'Неизвестный код', 'existing-unknown');
  add(3, 'Задача удалённой компании', 'avokado');
  writer.exec("UPDATE companies SET is_deleted=1 WHERE code='avokado'");
  const tasks = open().listTasks();
  assert.deepEqual(tasks.map(task => task.companyName), ['Без проекта', 'existing-unknown', 'avokado']);
  for (const task of tasks) {
    assert.equal(task.nextAction, ''); assert.equal(task.blocker, '');
    assert.equal(task.dueAt, null); assert.equal(task.waitingForOwner, null);
  }
});

test('invalid metadata and calendar dates do not become fabricated facts', t => {
  const { writer, add, open } = fixture(t);
  const dates = ['2026-02-30', '2026-10-02T12:00:00Z', '', '2028-02-29'];
  dates.forEach((date, index) => add(index + 1, 'Дата', 'alvi', 'planned', date));
  const put = writer.prepare('INSERT INTO task_coordination VALUES(?,?)');
  put.run(1, 'not-json'); put.run(2, '{"nextAction":42,"blocker":["not text"]}');
  put.run(3, 'null'); put.run(4, '{"nextAction":"Проверить"}');
  const tasks = open().listTasks();
  assert.deepEqual(tasks.map(task => task.dueAt), ['invalid', 'invalid', null, '2028-02-29']);
  assert.deepEqual(tasks.map(task => task.nextAction), ['', '', '', 'Проверить']);
  assert.deepEqual(tasks.map(task => task.blocker), ['', '', '', '']);
});

test('each read sees current committed WAL data and never retains deleted/moved task context', t => {
  const { writer, add, open } = fixture(t, { wal: true });
  add(1, 'Первая версия');
  writer.exec("INSERT INTO task_dispatch VALUES(1,'alvi','needs_input')");
  const source = open();
  assert.equal(source.listTasks()[0].waitingForOwner, true);
  writer.exec("UPDATE tasks SET title='Текущая версия', company_code='avokado', status='in_progress' WHERE id=1");
  const moved = source.listTasks()[0];
  assert.equal(moved.title, 'Текущая версия'); assert.equal(moved.companyName, 'Авокадо');
  assert.equal(moved.waitingForOwner, null);
  writer.exec('UPDATE tasks SET is_deleted=1 WHERE id=1');
  assert.deepEqual(source.listTasks(), []);
});

test('read-only connection and query_only both prevent writes; database file is unchanged', t => {
  const { dbPath, add, open } = fixture(t);
  add(1, 'Проверка');
  const before = readFileSync(dbPath);
  const originalPrepare = DatabaseSync.prototype.prepare;
  let reader;
  const mock = t.mock.method(DatabaseSync.prototype, 'prepare', function (...args) {
    reader = this;
    return originalPrepare.apply(this, args);
  });
  const source = open();
  mock.mock.restore();
  assert.equal(reader.prepare('PRAGMA query_only').get().query_only, 1);
  assert.throws(() => reader.exec("UPDATE tasks SET title='forbidden'"), /readonly/i);
  // Disabling query_only in this test proves the native open mode is independently read-only.
  reader.exec('PRAGMA query_only = OFF');
  assert.throws(() => reader.exec("UPDATE tasks SET title='still forbidden'"), /readonly/i);
  reader.exec('PRAGMA query_only = ON');
  assert.equal(source.listTasks()[0].title, 'Проверка');
  source.close(); source.close();
  assert.throws(() => source.listTasks(), /closed/);
  assert.deepEqual(readFileSync(dbPath), before);
});

test('missing database fails without creating a new registry; unknown schema fails explicitly', t => {
  const { dbPath } = fixture(t);
  const missing = `${dbPath}.absent`;
  assert.throws(() => createTaskSource({ dbPath: missing }));
  assert.equal(existsSync(missing), false);
  assert.throws(() => createTaskSource({ dbPath: ':memory:' }), /absolute/);
  assert.throws(() => createTaskSource(), /absolute/);
  const wrongSchema = `${dbPath}.wrong`;
  new DatabaseSync(wrongSchema).close();
  assert.throws(() => createTaskSource({ dbPath: wrongSchema }), /schema is unavailable/);
});
