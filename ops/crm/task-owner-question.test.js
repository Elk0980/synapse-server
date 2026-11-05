'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {createTaskCoordination,migrateTasksMcp}=require('./task-coordination');
const {OWNER_DEFAULTS,migrateOwnerQuestions}=require('./task-owner-question');
const actor={role:'owner',userId:7,companyCodes:new Set(['alpha'])};
function fixture(t) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE companies(code TEXT PRIMARY KEY,is_deleted INTEGER DEFAULT 0);INSERT INTO companies VALUES('alpha',0),('beta',0);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT,description TEXT DEFAULT '',company_code TEXT,
      status TEXT DEFAULT 'inbox',assignee_name TEXT DEFAULT '',priority TEXT DEFAULT 'normal',due_date TEXT DEFAULT '',
      created_at TEXT,updated_at TEXT,is_deleted INTEGER DEFAULT 0,source TEXT CHECK(source IN ('manual','chat')),created_by TEXT);
    INSERT INTO tasks(id,title,company_code,assignee_name,created_at,updated_at,source) VALUES
      (1,'SAMPLE старый вопрос','alpha','Codex','2026-11-03T00:00:00Z','2026-11-03T00:00:00Z','manual'),
      (2,'SAMPLE другая задача','beta','','2026-11-03T00:00:00Z','2026-11-03T00:00:00Z','manual');
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT);INSERT INTO schema_migrations VALUES(11,'SAMPLE архив');`);
  createTaskCoordination(db);db.exec('BEGIN IMMEDIATE');migrateTasksMcp(db);db.exec('COMMIT');
  const old=' {"blocker":"ждёт Влада: прежний вопрос","executorName":"Codex","custom":{"retained":true}} ';
  db.prepare('INSERT INTO task_coordination VALUES(1,1,?,?,7)').run(old,'2026-11-03T00:00:00Z');
  db.prepare('INSERT INTO task_coordination_history VALUES(1,1,?,?,7)').run(old,'2026-11-03T00:00:00Z');
  const migrate=()=>{db.exec('BEGIN IMMEDIATE');try{migrateOwnerQuestions(db);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}};
  const api=createTaskCoordination(db,{now:()=>Date.parse('2026-11-04T00:00:00Z')});
  return {db,api,migrate,call:(name,args={})=>api.tool(name,args,actor)};
}
test('migration 12 is additive/idempotent: original JSON/history/revisions and archive marker survive byte-for-byte',t=>{
  const f=fixture(t),snapshot=()=>['task_coordination','task_coordination_history','schema_migrations'].map(table=>f.db.prepare(`SELECT * FROM ${table}`).all()),before=snapshot();
  f.migrate();f.migrate();assert.deepEqual(snapshot(),before);
  assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'owner_question_%'").get().n,2);
  const current=f.call('task_get',{task_id:1}).coordination;for(const [key,value] of Object.entries(OWNER_DEFAULTS))assert.equal(current[key],value);
  assert.equal(current.blocker,'ждёт Влада: прежний вопрос');assert.deepEqual(current.custom,{retained:true});
  assert.throws(()=>f.db.exec("UPDATE task_coordination_history SET data='{}'"),/Immutable/);
});
test('question fields roundtrip through CAS/history; old saves preserve questions and unknown previous metadata',t=>{
  const {db,api,migrate,call}=fixture(t);migrate();
  const fields={owner_question:'🙂'.repeat(120),if_yes:'Продолжим',if_no:'Оставим черновик',owner_minutes:0};
  let task=call('task_update',{task_id:1,revision:1,...fields}).task;
  for(const [key,value] of Object.entries(fields))assert.equal(task.coordination[key],value);
  const overview=call('tasks_list',{overview:true}).tasks[0].coordination;for(const key of Object.keys(fields))assert.equal(overview[key],fields[key]);
  assert.equal(call('tasks_list',{}).tasks[0].coordination.owner_question,undefined);
  assert.throws(()=>call('task_update',{task_id:1,revision:1,owner_question:'Устаревший вопрос?'}),e=>e.status===409);
  api.save(1,{revision:task.coordination.revision,data:{result:'Прежний редактор'}},actor);
  task=call('task_get',{task_id:1});assert.equal(task.coordination.owner_question,fields.owner_question);assert.deepEqual(task.coordination.custom,{retained:true});
  api.save(1,{revision:task.coordination.revision,data:{owner_question:'  Начать?  ',owner_minutes:120}},actor);
  assert.equal(call('task_get',{task_id:1}).coordination.owner_question,'Начать?');
  task=call('task_update',{task_id:1,owner_question:'',owner_minutes:null}).task;assert.equal(task.coordination.owner_minutes,null);
  assert.ok(db.prepare('SELECT count(*) n FROM task_coordination_history').get().n>1);
  assert.throws(()=>call('task_update',{task_id:2,owner_question:'Чужой вопрос?'}),e=>e.status===404);
});
test('invalid types, Unicode length and controls are rejected atomically by API and raw SQL triggers',t=>{
  const {db,migrate,call}=fixture(t);migrate();const before=db.prepare('SELECT * FROM task_coordination').all();
  const invalid=[{owner_question:'🙂'.repeat(121)},{owner_question:'\nНачать?'},{owner_question:7},{if_yes:'x'.repeat(201)},
    {if_no:'a\u0000b'},{if_no:'a\u2028b'},...[-1,121,1.2,'1',false].map(owner_minutes=>({owner_minutes}))];
  for(const fields of invalid) {
    assert.throws(()=>call('task_update',{task_id:1,...fields}),e=>e.status===400);
    assert.throws(()=>db.prepare('UPDATE task_coordination SET data=? WHERE task_id=1').run(JSON.stringify(fields)),/OWNER_QUESTION_INVALID/);
  }
  assert.deepEqual(db.prepare('SELECT * FROM task_coordination').all(),before);
  assert.throws(()=>db.prepare('INSERT INTO task_coordination VALUES(2,1,?,?,7)').run('{"owner_minutes":999}','now'),/OWNER_QUESTION_INVALID/);
});
test('async stage permit includes owner fields and still binds the complete normalized body',async t=>{
  const {db,migrate}=fixture(t);migrate();let prepared,recorded=0;
  const watchdog={prepare:async(id,data)=>{prepared=JSON.stringify(data);},guard:(id,data)=>{assert.equal(JSON.stringify(data),prepared);return {};},record:()=>recorded++};
  const api=createTaskCoordination(db,{watchdog,now:()=>Date.parse('2026-11-04T00:00:00Z')});
  const result=await api.toolAsync('task_update',{task_id:1,stage:'code',evidence:'SAMPLE proof',checked_at:'2026-11-03T00:00:00Z',owner_question:'Продолжать?',if_yes:'Продолжим',owner_minutes:2},actor);
  assert.equal(result.task.coordination.owner_question,'Продолжать?');assert.equal(recorded,1);
});
