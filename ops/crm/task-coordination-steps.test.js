'use strict';
// specs/101-task-point-a-b: «Точка А → Точка Б», шаги приёмки и процент задачи. Данные — SAMPLE.
const test = require('node:test'), assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const Steps = require('./task-coordination-steps');
const {createTaskCoordination,migrateTasksMcp} = require('./task-coordination');
const owner = {role:'owner',userId:1,userName:'Влад',companyCodes:new Set(['alpha'])};

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(code TEXT PRIMARY KEY,is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies VALUES('alpha',0);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0,deleted_at TEXT,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',
      company_code TEXT NOT NULL DEFAULT '',assignee_name TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'inbox',
      priority TEXT NOT NULL DEFAULT 'normal',due_date TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','chat','pipeline')),created_by TEXT NOT NULL DEFAULT '');`);
  createTaskCoordination(db);
  db.exec('PRAGMA foreign_keys=OFF;BEGIN IMMEDIATE'); migrateTasksMcp(db); db.exec('COMMIT;PRAGMA foreign_keys=ON');
  const api = createTaskCoordination(db,{now:()=>Date.parse('2026-11-04T01:00:00Z')});
  const call = (name,args={},actor=owner) => api.tool(name,args,actor);
  const create = (title,description='',executor='Claude') =>
    call('task_create',{title,description,project:'alpha',executor,client_ref:`sample:${title}`}).task;
  return {db,api,call,create};
}

const LEGACY = `Задача SAMPLE.
Точка А: в карточке только текст
  и без картинок
Точка Б: блок «Было | Будет»
Пример: SAMPLE-карточка
Шаги приёмки:
- [ ] карточка видна на 390px
- [x] текст экранирован
* [X] шаг со звёздочкой
не шаг
Состав: №1`;

test('description parsing: labelled multi-line blocks until next label, [ ]/[x] steps', () => {
  const parsed = Steps.parseDescription(LEGACY);
  assert.equal(parsed.pointA, 'в карточке только текст\n  и без картинок');
  assert.equal(parsed.pointB, 'блок «Было | Будет»');
  assert.equal(parsed.example, 'SAMPLE-карточка');
  assert.deepEqual(parsed.steps.map(step => [step.text, step.state]),
    [['карточка видна на 390px','open'],['текст экранирован','closed'],['шаг со звёздочкой','closed']]);
  assert.equal(parsed.steps[1].legacy, true);
  assert.equal(Steps.parseDescription('Обычное описание\nПример: без блока'), null);
  assert.equal(Steps.parseDescription(''), null);
  assert.equal(Steps.parseDescription('Точка a: латиница\nТочка Б: ок').pointA, 'латиница');
});

test('progress formula: stages x25 without steps, mean of stages and closed-share with steps, done = 100', () => {
  const ms = n => Object.fromEntries(['code','connected','verified','accepted'].map((key,i) => [key,{state:i < n ? 'confirmed' : 'pending'}]));
  assert.equal(Steps.progress('in_progress', ms(2), {total:0,closed:0}), 50);
  assert.equal(Steps.progress('in_progress', ms(2), {total:4,closed:1}), 38); // (50+25)/2
  assert.equal(Steps.progress('in_progress', ms(0), {total:2,closed:2}), 50);
  assert.equal(Steps.progress('in_progress', ms(4), {total:3,closed:3}), 100);
  assert.equal(Steps.progress('done', ms(0), {total:3,closed:0}), 100);
});

test('legacy description steps appear in task_get, list counts and progress without a stored block', t => {
  const {call,create} = fixture(t), task = create('SAMPLE legacy', LEGACY);
  const full = call('task_get',{task_id:task.id});
  assert.equal(full.point_ab.source, 'description');
  assert.deepEqual(full.acceptance_steps, {total:3,closed:2});
  assert.equal(full.progress, 33); // (0 + 66.7)/2
  const listed = call('tasks_list',{overview:true}).tasks[0];
  assert.deepEqual(listed.acceptance_steps, {total:3,closed:2});
  assert.equal(listed.progress, 33);
  assert.equal(listed.point_ab, undefined, 'список отдаёт только счётчики');
});

test('done with open steps -> 409 on every status path; allowed after closing by a reviewer', t => {
  const {db,api,call,create} = fixture(t), task = create('SAMPLE done');
  call('task_point_ab',{task_id:task.id,point_ab:{pointA:'было',pointB:'будет',steps:[{text:'шаг 1'},{text:'шаг 2'}]}});
  assert.throws(() => call('task_update',{task_id:task.id,status:'done'}),
    error => error.status === 409 && /открыты шаги приёмки — 2 из 2/.test(error.message));
  const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id);
  assert.throws(() => api.assertCanFinish(row), error => error.status === 409);
  const revision = call('task_get',{task_id:task.id}).coordination.revision;
  assert.throws(() => api.selfStatus(task.id,{revision,status:'done'},owner,'alpha'), error => error.status === 409);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(task.id).status, 'inbox');
  const steps = call('task_get',{task_id:task.id}).point_ab.steps;
  for (const step of steps) call('task_step_close',{task_id:task.id,step_id:step.id,evidence:'https://example.test/proof'});
  const done = call('task_update',{task_id:task.id,status:'done'}).task;
  assert.equal(done.status, 'done');
  assert.equal(done.progress, 100);
  assert.equal(done.point_ab.pointA, 'было');
});

test('legacy open description steps also block done', t => {
  const {call,create} = fixture(t), task = create('SAMPLE legacy done', LEGACY);
  assert.throws(() => call('task_update',{task_id:task.id,status:'done'}), error => error.status === 409);
});

test('executor cannot close a step; principal name, person:<id> and self-declared agent name are checked', t => {
  const {call,create} = fixture(t);
  const byName = create('SAMPLE executor', '', 'Влад');
  call('task_point_ab',{task_id:byName.id,point_ab:{steps:[{text:'шаг'}]}});
  const stepId = call('task_get',{task_id:byName.id}).point_ab.steps[0].id;
  assert.throws(() => call('task_step_close',{task_id:byName.id,step_id:stepId,evidence:'https://example.test/p'}),
    error => error.status === 403 && /не исполнитель/.test(error.message));
  const byPerson = create('SAMPLE person', '', 'person:1');
  call('task_point_ab',{task_id:byPerson.id,point_ab:{steps:[{text:'шаг'}]}});
  assert.throws(() => call('task_step_close',{task_id:byPerson.id,step_id:'s1',evidence:'https://example.test/p'}), error => error.status === 403);
  const byAgent = create('SAMPLE agent', '', 'Claude');
  call('task_point_ab',{task_id:byAgent.id,point_ab:{steps:[{text:'шаг'}]}});
  assert.throws(() => call('task_step_close',{task_id:byAgent.id,step_id:'s1',evidence:'https://example.test/p',author:' claude '}), error => error.status === 403);
  const closed = call('task_step_close',{task_id:byAgent.id,step_id:'s1',evidence:'https://example.test/p',author:'Codex'}).task;
  assert.equal(closed.point_ab.steps[0].state, 'closed');
  assert.equal(closed.point_ab.steps[0].closedBy, 'Codex');
  assert.equal(closed.point_ab.steps[0].closedById, 1);
});

test('non-https images and evidence are rejected by the server; closing needs evidence', t => {
  const {call,create} = fixture(t), task = create('SAMPLE https');
  for (const bad of ['http://example.test/a.png','javascript:alert(1)','data:image/png;base64,AAAA','https://user:pw@example.test/a.png','ftp://x/a','не ссылка'])
    assert.throws(() => call('task_point_ab',{task_id:task.id,point_ab:{pointAImage:bad}}), error => error.status === 400, bad);
  call('task_point_ab',{task_id:task.id,point_ab:{pointAImage:'https://example.test/a.png',steps:[{text:'шаг'}]}});
  for (const evidence of [undefined,'','http://example.test/p','javascript:alert(1)'])
    assert.throws(() => call('task_step_close',{task_id:task.id,step_id:'s1',...(evidence === undefined ? {} : {evidence})}), error => error.status === 400);
  assert.throws(() => call('task_point_ab',{task_id:task.id,point_ab:{steps:[{text:'x',state:'closed'}]}}), error => error.status === 400,
    'клиент не может сам выставить «закрыт»');
  assert.throws(() => call('task_point_ab',{task_id:task.id,point_ab:{unknown:1}}), error => error.status === 400);
});

test('block survives regular card saves, keeps history, revision conflicts and closed-step protection', t => {
  const {db,call,create} = fixture(t), task = create('SAMPLE history');
  const first = call('task_point_ab',{task_id:task.id,point_ab:{pointA:'А',steps:[{text:'один'},{text:'два'}]}}).task;
  assert.throws(() => call('task_point_ab',{task_id:task.id,revision:first.coordination.revision - 1,point_ab:{pointA:'старое'}}), error => error.status === 409);
  call('task_update',{task_id:task.id,blocker:'SAMPLE помеха',priority:'high'});
  call('task_step_close',{task_id:task.id,step_id:'s1',evidence:'https://example.test/one',kind:'image'});
  const after = call('task_get',{task_id:task.id});
  assert.equal(after.point_ab.pointA, 'А');
  assert.equal(after.point_ab.steps[0].evidenceKind, 'image');
  assert.throws(() => call('task_point_ab',{task_id:task.id,point_ab:{steps:[{id:'s1',text:'переписан'},{id:'s2',text:'два'}]}}), error => error.status === 409);
  const edited = call('task_point_ab',{task_id:task.id,point_ab:{steps:[{id:'s1',text:'один'},{id:'s2',text:'два!'},{text:'три'}]}}).task;
  assert.deepEqual(edited.point_ab.steps.map(step => [step.id,step.state]), [['s1','closed'],['s2','open'],['s3','open']]);
  const reopened = call('task_step_reopen',{task_id:task.id,step_id:'s1'}).task;
  assert.equal(reopened.point_ab.steps[0].state, 'open');
  assert.equal(reopened.point_ab.steps[0].evidence, '');
  const history = db.prepare('SELECT data FROM task_coordination_history WHERE task_id=? ORDER BY revision').all(task.id).map(row => JSON.parse(row.data));
  assert.ok(history.some(data => data.pointAB?.steps?.[0]?.state === 'closed'), 'закрытие остаётся в неизменяемой истории');
  // Сохранённый блок важнее описания.
  db.prepare('UPDATE tasks SET description=? WHERE id=?').run(LEGACY, task.id);
  assert.equal(call('task_get',{task_id:task.id}).point_ab.source, 'card');
});

test('old schema (before MCP migration): regular save keeps a stored block untouched', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE tasks(id INTEGER PRIMARY KEY,title TEXT,company_code TEXT,status TEXT,assignee_name TEXT,description TEXT,is_deleted INTEGER DEFAULT 0);
    INSERT INTO tasks VALUES(1,'SAMPLE','alpha','in_progress','Codex','',0);`);
  const api = createTaskCoordination(db,{now:()=>Date.parse('2026-11-04T01:00:00Z')});
  const block = {pointA:'А',pointB:'Б',example:'',pointAImage:'',pointBImage:'',steps:[{id:'s1',text:'шаг',state:'open'}]};
  db.prepare(`INSERT INTO task_coordination VALUES(1,1,?,'2026-11-04T00:00:00Z',1)`).run(JSON.stringify({links:[],pointAB:block}));
  api.save(1,{revision:1,data:{result:'SAMPLE'}},{role:'owner',userId:1});
  assert.deepEqual(api.get(1,{role:'owner',userId:1}).pointAB, block);
  assert.equal(api.get(1,{role:'owner',userId:1}).result, 'SAMPLE');
});
