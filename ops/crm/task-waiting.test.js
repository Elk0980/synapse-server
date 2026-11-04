'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {waitingPrefix,waitingForVlad,deriveWaitingSince}=require('./task-waiting');
const {createTaskCoordination,migrateTasksMcp}=require('./task-coordination');
const times=['2026-11-03T08:00:00.000Z','2026-11-03T09:00:00.000Z','2026-11-03T10:00:00.000Z','2026-11-03T11:00:00.000Z'];
const owner={role:'owner',userId:7,companyCodes:new Set(['alpha'])};
const snapshot=(revision,time,data)=>({revision,updated_at:time,data:JSON.stringify({blocker:'',nextAction:'',executorName:'Codex',...data})});
const derive=(history,extra={})=>deriveWaitingSince({id:1,created_at:times[0],assignee_name:'Codex',...extra.task},
  {revision:history[0]?.revision || 0,updatedAt:history[0]?.updated_at || '',blocker:'ждёт Влада: решение',nextAction:'',...extra.coordination},history,Date.parse(times[3]));

test('waiting markers start the field, normalize case/ё and retain Cyrillic word boundaries',()=>{
  for(const value of [' ждёт Влада: выбор ','ЖДЁТ ВЛАДА','Ждет Влада — ответ','ВОПРОС → Влад: срок','  вопрос → влад\nПодробности'])assert.equal(waitingPrefix(value),true,value);
  for(const value of ['Не ждёт Влада','Дальше ждёт Влада','Ждёт Владамира','ВОПРОС → Владислав','ВОПРОС → Владу','ждётвлада','',null,42])assert.equal(waitingPrefix(value),false,String(value));
  assert.equal(waitingForVlad({assignee_name:'  ВЛАД  '},{}),true);
  for(const value of ['Владислав','Влад — проверка','Команда Влад'])assert.equal(waitingForVlad({assignee_name:value},{}),false);
  for(const status of ['inbox','planned','in_progress','done','cancelled'])assert.equal(waitingForVlad({status,assignee_name:'Влад'},{}),true);
});

test('current continuous waiting chain survives unrelated edits and resets after work resumes',()=>{
  const start=snapshot(2,times[1],{blocker:'ждёт Влада: решение'});
  const initial=snapshot(1,times[0],{});
  assert.equal(derive([start,initial]),times[1]);
  const unrelated=snapshot(3,times[2],{blocker:'ждёт Влада: решение',result:'Новый отчёт'});
  assert.equal(derive([unrelated,start,initial]),times[1]);
  const resumed=snapshot(3,times[2],{}),again=snapshot(4,times[3],{blocker:'ждёт Влада: решение'});
  assert.equal(derive([again,resumed,start,initial]),times[3]);
  assert.equal(derive([resumed,start,initial],{coordination:{blocker:''}}),null);
});

test('initial creation or explicit assignment transition can establish the waiting start',()=>{
  assert.equal(derive([snapshot(1,times[0],{blocker:'ждёт Влада: решение'})]),times[0]);
  const history=[snapshot(3,times[2],{executorName:'Влад'}),snapshot(2,times[1],{executorName:'Влад'}),snapshot(1,times[0],{})];
  assert.equal(derive(history,{task:{assignee_name:'Влад'},coordination:{blocker:''}}),times[1]);
  assert.equal(deriveWaitingSince({assignee_name:'Влад',created_at:times[0]}, {revision:0,updatedAt:times[2]},[],Date.parse(times[3])),null);
  assert.equal(derive([snapshot(1,times[1],{blocker:'ждёт Влада: решение'})]),null,'an old task first observed waiting has no proven start');
});

test('unknown legacy assignments, gaps, corrupted history and unreliable timestamps yield null',()=>{
  const current=snapshot(3,times[2],{blocker:'ждёт Влада: решение'}),initial=snapshot(1,times[0],{});
  assert.equal(derive([current,initial]),null,'a missing revision could hide a reset');
  assert.equal(derive([current,snapshot(2,times[1],{executorName:''}),initial]),null,'legacy empty executor does not prove an unassignment');
  assert.equal(derive([{...current,data:'invalid JSON'},snapshot(2,times[1],{}),initial]),null);
  assert.equal(derive([{...current,updated_at:'unknown'},snapshot(2,times[1],{}),initial]),null);
  assert.equal(derive([snapshot(2,'2026-02-30T09:00:00.000Z',{blocker:'ждёт Влада: решение'}),snapshot(1,'2026-02-01T00:00:00.000Z',{})],{task:{created_at:'2026-02-01T00:00:00.000Z'}}),null);
  assert.equal(derive([snapshot(2,'2026-11-03T09:00:00',{blocker:'ждёт Влада: решение'}),initial]),null);
  assert.equal(derive([snapshot(2,times[1],{blocker:'ждёт Влада: решение'}),{...initial,data:'{}'}]),null);
  assert.equal(derive([snapshot(1,times[1],{blocker:'ждёт Влада: решение'}),snapshot(0,times[0],{})]),null);
  assert.equal(derive([current,snapshot(2,'2099-01-01T00:00:00Z',{}),initial]),null);
  assert.equal(derive([current,snapshot(2,times[3],{}),initial]),null,'history timestamps cannot move backwards');
  assert.equal(derive([current,snapshot(2,times[1],{}),initial],{coordination:{revision:4}}),null);
  assert.equal(derive([current,snapshot(2,times[1],{}),initial],{coordination:{blocker:'ждёт Влада: изменено без истории'}}),null);
  assert.equal(derive([snapshot(1,times[0],{executorName:'Codex'})],{task:{assignee_name:'Влад'},coordination:{blocker:''}}),null);
});

function fixture(t) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(code TEXT PRIMARY KEY,is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies VALUES('alpha',0),('beta',0);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0,deleted_at TEXT,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',
      company_code TEXT NOT NULL DEFAULT '',assignee_name TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'inbox',
      priority TEXT NOT NULL DEFAULT 'normal',due_date TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','chat','pipeline')),created_by TEXT NOT NULL DEFAULT '');`);
  createTaskCoordination(db);
  db.exec('PRAGMA foreign_keys=OFF;BEGIN IMMEDIATE');migrateTasksMcp(db);db.exec('COMMIT;PRAGMA foreign_keys=ON');
  const clock={value:Date.parse(times[0])},api=createTaskCoordination(db,{now:()=>clock.value});
  const call=(name,args={},actor=owner)=>api.tool(name,args,actor);
  const create=(title,project='alpha',executor='Codex')=>call('task_create',{title,description:'SAMPLE описание',project,executor,client_ref:`sample:${title}`},project==='beta'?{...owner,companyCodes:new Set(['beta'])}:owner).task;
  return {db,api,clock,call,create};
}

test('tasks_list supplies detail-free waiting data and legacy edits cannot invent or reset a start',t=>{
  const {db,api,clock,call,create}=fixture(t),task=create('SAMPLE ожидание');
  clock.value=Date.parse(times[1]);call('task_update',{task_id:task.id,blocker:'ЖДЁТ ВЛАДА: ответ'});
  clock.value=Date.parse(times[2]);call('task_update',{task_id:task.id,next_step:'Продолжу после решения',priority:'high'});
  const list=call('tasks_list',{overview:true}).tasks[0];
  assert.equal(list.description,'SAMPLE описание');assert.equal(list.created_at,times[0]);assert.equal(list.waiting_since,times[1]);
  assert.equal(list.coordination.blocker,'ЖДЁТ ВЛАДА: ответ');assert.equal(list.coordination.nextAction,'Продолжу после решения');assert.equal(list.coordination.updatedAt,times[2]);
  assert.equal(call('task_get',{task_id:task.id}).waiting_since,times[1]);
  db.prepare("UPDATE tasks SET title='SAMPLE обновлено',updated_at=? WHERE id=?").run(times[3],task.id);
  clock.value=Date.parse(times[3]);assert.equal(call('tasks_list',{overview:true}).tasks[0].waiting_since,times[1]);
  const assigned=create('SAMPLE назначение','alpha','Влад');
  api.save(assigned.id,{revision:assigned.coordination.revision,data:{result:'Старый редактор сохранил отчёт'}},owner);
  assert.equal(call('task_get',{task_id:assigned.id}).waiting_since,assigned.created_at,'partial save preserves the existing executor and proven start');
  // Emulate a snapshot made by the legacy save, which could erase executorName.
  const revision=call('task_get',{task_id:assigned.id}).coordination.revision;
  api.save(assigned.id,{revision,data:{executorName:'',result:'SAMPLE legacy empty executor snapshot'}},owner);
  assert.equal(call('task_get',{task_id:assigned.id}).waiting_since,null,'legacy empty executor is uncertain even if actual assignment remains Vlad');
  clock.value+=1000;call('task_update',{task_id:assigned.id,next_step:'Проверить'});
  assert.equal(call('task_get',{task_id:assigned.id}).waiting_since,null,'a later touch must not pretend that waiting just began');
});

test('direct legacy assignment changes use immutable revisions while prehistory assignments stay undated',t=>{
  const {db,clock,call,create}=fixture(t),task=create('SAMPLE прямое назначение');
  clock.value=Date.parse(times[1]);db.prepare("UPDATE tasks SET assignee_name='Влад',updated_at=? WHERE id=?").run(times[1],task.id);
  assert.equal(call('tasks_list',{overview:true}).tasks[0].waiting_since,times[1]);
  clock.value=Date.parse(times[2]);db.prepare("UPDATE tasks SET description='SAMPLE новый текст',updated_at=? WHERE id=?").run(times[2],task.id);
  assert.equal(call('task_get',{task_id:task.id}).waiting_since,times[1]);
  db.prepare("UPDATE tasks SET assignee_name='Codex',updated_at=? WHERE id=?").run(times[2],task.id);
  clock.value=Date.parse(times[3]);db.prepare("UPDATE tasks SET assignee_name='Влад',updated_at=? WHERE id=?").run(times[3],task.id);
  assert.equal(call('task_get',{task_id:task.id}).waiting_since,times[3]);
  const inserted=db.prepare(`INSERT INTO tasks(created_at,updated_at,title,company_code,assignee_name)
    VALUES(?,?,'SAMPLE старая задача без истории','alpha','Влад')`).run(times[0],times[3]);
  assert.equal(call('task_get',{task_id:Number(inserted.lastInsertRowid)}).waiting_since,null);
});

test('waiting reads keep owner/project scope, never scan nonwaiting history and perform no DDL or writes',t=>{
  const {db,call,create,clock}=fixture(t),waiting=create('SAMPLE доступное ожидание'),ordinary=create('SAMPLE обычная'),foreign=create('SAMPLE чужое ожидание','beta');
  clock.value=Date.parse(times[1]);call('task_update',{task_id:waiting.id,next_step:'ВОПРОС → Влад: решение'});
  call('task_update',{task_id:foreign.id,blocker:'ждёт Влада'},{...owner,companyCodes:new Set(['beta'])});
  const before=db.prepare('SELECT total_changes() n').get().n,schema=db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all();
  const prepare=db.prepare.bind(db),exec=db.exec.bind(db),scanned=[];
  db.exec=()=>assert.fail('reading must not execute DDL or mutation');
  db.prepare=sql=>{
    assert.match(sql,/^\s*(SELECT|PRAGMA)\b/i);
    const statement=prepare(sql);
    if(sql.includes('FROM task_coordination_history')) {
      const iterate=statement.iterate.bind(statement);statement.iterate=(id)=>{scanned.push(id);return iterate(id);};
    }
    return statement;
  };
  try {
    const result=call('tasks_list',{overview:true});assert.deepEqual(new Set(result.tasks.map(row=>row.id)),new Set([waiting.id,ordinary.id]));
    assert.deepEqual(scanned,[waiting.id]);assert.equal(result.tasks.find(row=>row.id===ordinary.id).waiting_since,null);
    const legacy=call('tasks_list',{});assert.equal(legacy.tasks[0].waiting_since,undefined);assert.deepEqual(scanned,[waiting.id]);
    assert.throws(()=>call('task_get',{task_id:foreign.id}),error=>error.status===404);
    assert.throws(()=>call('tasks_list',{}, {role:'editor',userId:7}),error=>error.status===403);
    assert.equal(prepare('SELECT total_changes() n').get().n,before);
    assert.deepEqual(prepare('SELECT sql FROM sqlite_master ORDER BY name').all(),schema);
  } finally {db.prepare=prepare;db.exec=exec;}
});

test('overview is opt-in and bounded by Unicode codepoints while task_get retains the full description',t=>{
  const {db,call,create}=fixture(t),task=create('SAMPLE длинное описание');
  const full='🙂'.repeat(1200)+'\nСостав: полный текст\nЦКП: результат';
  db.prepare('UPDATE tasks SET description=? WHERE id=?').run(full,task.id);
  const insert=db.prepare(`INSERT INTO tasks(created_at,updated_at,title,description,company_code)
    VALUES(?,?,'SAMPLE старая длинная задача',?,'alpha')`);
  for(let index=0;index<99;index++)insert.run(times[0],times[0],full);
  const legacy=call('tasks_list',{});assert.equal(legacy.tasks[0].description,undefined);assert.equal(legacy.tasks[0].created_at,undefined);
  assert.equal(legacy.tasks[0].coordination.blocker,undefined);assert.deepEqual(call('tasks_list',{overview:false}),legacy);
  const overview=call('tasks_list',{overview:true});assert.equal(overview.tasks.length,100);
  for(const row of overview.tasks) {
    assert.equal(Array.from(row.description).length,1000);assert.equal(row.description,'🙂'.repeat(1000));assert.equal(row.description_truncated,true);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(overview))<1024*1024);
  assert.equal(call('task_get',{task_id:task.id}).description,full);
  for(const value of ['true',1,null,{},[]])assert.throws(()=>call('tasks_list',{overview:value}),error=>error.status===400);
});
