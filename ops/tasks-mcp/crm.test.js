'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {createTaskCoordination,migrateTasksMcp} = require('../crm/task-coordination');

const owner = {role:'owner',userId:7,companyCodes:new Set(['alpha'])};
const otherScope = {role:'owner',userId:7,companyCodes:new Set(['beta'])};
const initialTime = Date.parse('2026-11-02T18:00:00Z');

function fixture(t,{migrate=true}={}) {
  const db = new DatabaseSync(':memory:');
  t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companies(code TEXT PRIMARY KEY,is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies VALUES('alpha',0),('beta',0);
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0,deleted_at TEXT,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',
      company_code TEXT NOT NULL DEFAULT '',assignee_role TEXT DEFAULT 'synapse',assignee_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'inbox' CHECK(status IN ('inbox','planned','in_progress','done','cancelled')),
      priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
      due_date TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','chat','telegram','pipeline')),
      source_ref TEXT NOT NULL DEFAULT '',source_author TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL DEFAULT '');
    CREATE INDEX legacy_tasks_title ON tasks(title);
    CREATE TABLE task_audit(id INTEGER);
    CREATE TRIGGER legacy_task_trigger AFTER UPDATE OF title ON tasks BEGIN INSERT INTO task_audit VALUES(NEW.id); END;
    INSERT INTO tasks(id,created_at,updated_at,title,company_code,assignee_name,status,source)
      VALUES(21,'2026-11-02T16:00:00Z','2026-11-02T16:00:00Z','Старая задача','alpha','Codex','in_progress','pipeline'),
        (22,'2026-11-02T16:00:00Z','2026-11-02T16:00:00Z','Чужая задача','beta','Codex','planned','chat');
    INSERT INTO tasks(id,created_at,updated_at,title) VALUES(900,'old','old','Удалённый предел');
    DELETE FROM tasks WHERE id=900;
    CREATE TABLE linked_task(task_id INTEGER REFERENCES tasks(id));
    INSERT INTO linked_task VALUES(21);`);
  const clock={value:initialTime};
  let api = createTaskCoordination(db,{now:()=>clock.value});
  api.save(21,{revision:0,data:{executorName:'Codex',result:'Старый результат',
    milestones:{code:{state:'confirmed',evidence:'Старый тест',checkedAt:'2026-11-02T15:00:00Z'}}}},owner);
  if(migrate) {
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    try { migrateTasksMcp(db);db.exec('COMMIT'); }
    catch(error){db.exec('ROLLBACK');throw error;}
    finally{db.exec('PRAGMA foreign_keys=ON');}
    api = createTaskCoordination(db,{now:()=>clock.value});
  }
  return {db,api,clock,call:(name,args={},actor=owner)=>api.tool(name,args,actor)};
}

test('migration preserves IDs, sequence, foreign keys, indexes, triggers and immutable coordination history',t=>{
  const {db,api,call}=fixture(t);
  assert.deepEqual(db.prepare('SELECT id FROM tasks ORDER BY id').all().map(row=>row.id),[21,22]);
  assert.equal(api.get(21,owner).result,'Старый результат');
  assert.equal(api.get(21,owner).milestones.code.state,'confirmed');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
  assert.equal(db.prepare('SELECT task_id FROM linked_task').get().task_id,21);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_tasks_title'").get());
  db.prepare('UPDATE tasks SET title=? WHERE id=21').run('Сохранённая задача');
  assert.equal(db.prepare('SELECT id FROM task_audit').get().id,21);
  assert.throws(()=>db.exec("UPDATE task_coordination_history SET data='{}'"),/Immutable/);
  const created=call('task_create',{title:'Новая',project:'alpha',source:'gpt',client_ref:'new-sequence'});
  assert.ok(created.task.id>900);
  assert.equal(created.task.source,'gpt');
  assert.equal(created.task.parent_task_id,null);
});

test('atomic client_ref retries create one canonical task, even across source changes',t=>{
  const {call,db}=fixture(t);
  const args={title:'Поручение',project:'alpha',source:'claude',client_ref:'owner-request-1',executor:'Claude',reviewer:'Codex',
    status:'planned',links:[{url:'https://example.test/result',label:'Результат',kind:'link'}]};
  const first=call('task_create',args), second=call('task_create',{...args,source:'gpt',title:'Другой текст'});
  assert.equal(first.created,true);assert.equal(second.created,false);assert.equal(second.task.id,first.task.id);
  assert.equal(second.task.title,'Поручение');
  assert.equal(first.task.status,'planned');assert.equal(second.task.status,'planned');
  assert.deepEqual(first.task.coordination.links,args.links);
  assert.equal(db.prepare('SELECT count(*) n FROM tasks WHERE client_ref=?').get(args.client_ref).n,1);
  assert.throws(()=>call('task_create',{...args,project:'beta'},otherScope),error=>error.status===404);
  assert.throws(()=>call('task_create',{...args,client_ref:''}),error=>error.status===400);
  assert.throws(()=>call('task_create',{...args,client_ref:'invalid-attachment',links:[{url:'javascript:1'}]}),error=>error.status===400);
  assert.equal(db.prepare('SELECT count(*) n FROM tasks WHERE client_ref=?').get('invalid-attachment').n,0);
});

test('reviewer differs from executor in tools, old coordination and legacy SQL, including Russian case',t=>{
  const {call,api,db}=fixture(t);
  assert.throws(()=>call('task_create',{title:'Ошибка',project:'alpha',client_ref:'bad-review',executor:' Claude ',reviewer:'cLaUdE'}),error=>error.status===400);
  const row=call('task_create',{title:'Проверка',project:'alpha',client_ref:'review',executor:'Claude',reviewer:'Codex'}).task;
  assert.throws(()=>call('task_update',{task_id:row.id,executor:'codex'}),error=>error.status===400);
  assert.throws(()=>api.save(row.id,{revision:row.coordination.revision,data:{executorName:'CODEX'}},owner),error=>error.status===400);
  assert.throws(()=>db.prepare('UPDATE tasks SET assignee_name=? WHERE id=?').run('codex',row.id),error=>error.status===400);
  db.prepare('UPDATE tasks SET reviewer_name=? WHERE id=?').run('Влад',row.id);
  assert.throws(()=>db.prepare('UPDATE tasks SET assignee_name=? WHERE id=?').run(' ВЛАД ',row.id),error=>error.status===400);
  const updated=call('task_update',{task_id:row.id,executor:'Gemini'}).task;
  assert.equal(updated.assignee_name,'Gemini');assert.equal(updated.coordination.executorName,'Gemini');
  db.prepare('UPDATE tasks SET assignee_name=? WHERE id=?').run('Claude',row.id);
  assert.equal(call('task_get',{task_id:row.id}).coordination.executorName,'Claude');
  assert.equal(api.get(row.id,owner).executorName,'Claude');
});

test('project isolation covers lists, IDs, parents, comments, updates, retries and fail-closed empty scopes',t=>{
  const {call}=fixture(t);
  assert.deepEqual(call('tasks_list').tasks.map(row=>row.id),[21]);
  for(const name of ['task_get','task_update','task_comment']) {
    assert.throws(()=>call(name,{task_id:22,status:'done',author:'Codex',text:'x'}),error=>error.status===404);
  }
  assert.throws(()=>call('tasks_list',{project:'beta'}),error=>error.status===404);
  assert.throws(()=>call('task_create',{title:'x',project:'beta',client_ref:'foreign'}),error=>error.status===404);
  assert.deepEqual(call('tasks_list',{}, {...owner,companyCodes:new Set()}).tasks,[]);
  assert.throws(()=>call('tasks_list',{}, {role:'editor',userId:7}),error=>error.status===403);
  const core=call('task_create',{title:'Система',project:'synapse-business',client_ref:'core'}).task;
  assert.equal(call('task_get',{task_id:core.id},{...owner,companyCodes:new Set()}).id,core.id);
});

test('subtasks use one level and same project; old CRUD cannot break parent relations',t=>{
  const {call,db}=fixture(t);
  const child=call('task_create',{title:'Подзадача',project:'alpha',client_ref:'child',parent_id:21}).task;
  assert.equal(call('task_get',{task_id:21}).subtask_count,1);
  assert.equal(call('task_get',{task_id:21}).subtasks[0].id,child.id);
  assert.throws(()=>call('task_create',{title:'Внук',project:'alpha',client_ref:'grandchild',parent_id:child.id}),error=>error.status===400);
  assert.throws(()=>call('task_create',{title:'Чужой',project:'alpha',client_ref:'foreign-parent',parent_id:22}),error=>error.status===404);
  for(const sql of ['UPDATE tasks SET company_code=\'beta\' WHERE id=21','UPDATE tasks SET is_deleted=1 WHERE id=21',`UPDATE tasks SET parent_task_id=${child.id} WHERE id=21`]) assert.throws(()=>db.exec(sql),error=>error.status===400);
  call('task_update',{task_id:child.id,status:'done'});
  assert.equal(call('task_get',{task_id:21}).subtask_done,1);
});

test('updates keep independent stage evidence, links, append-only comments and stale revision protection',t=>{
  const {call,db}=fixture(t);
  const before=call('task_get',{task_id:21});
  assert.throws(()=>call('task_update',{task_id:21,stage:'verified'}),error=>error.status===400);
  const updated=call('task_update',{task_id:21,revision:before.coordination.revision,status:'done',stage:'verified',
    evidence:'node --test: PASS',checked_at:'2026-11-02T17:00:00Z',blocker:'',next_step:'Owner',
    links:[{url:'https://example.test/result.png',label:'Фото',kind:'image'}]}).task;
  assert.equal(updated.coordination.milestones.code.state,'confirmed');
  assert.equal(updated.coordination.milestones.connected.state,'pending');
  assert.equal(updated.coordination.milestones.verified.state,'confirmed');
  assert.equal(updated.coordination.milestones.accepted.state,'pending');
  assert.equal(updated.coordination.links.length,1);
  assert.throws(()=>call('task_update',{task_id:21,revision:before.coordination.revision,status:'planned'}),error=>error.status===409);
  assert.throws(()=>call('task_update',{task_id:21,links:[{url:'javascript:alert(1)'}]}),error=>error.status===400);
  call('task_comment',{task_id:21,author:'Codex',text:'Проверено отдельно'});
  assert.equal(call('task_get',{task_id:21}).comments[0].text,'Проверено отдельно');
  assert.throws(()=>db.exec("DELETE FROM task_comments"),/Immutable/);
  assert.throws(()=>db.exec("UPDATE task_comments SET text='подмена'"),/Immutable/);
});

test('day plan uses Bangkok date at UTC boundary, bounded paging and filters',t=>{
  const {call,db}=fixture(t);
  db.prepare('UPDATE tasks SET due_date=? WHERE id=21').run('2026-11-03');
  assert.equal(call('tasks_list',{today:true}).tasks[0].id,21);
  assert.equal(call('tasks_list',{executor:'codex',search:'Старая',status:'in_progress',limit:1}).pagination.total,1);
  assert.deepEqual(call('tasks_list',{offset:1}).tasks,[]);
  assert.throws(()=>call('tasks_list',{limit:101}),error=>error.status===400);
  assert.throws(()=>call('tasks_list',{offset:-1}),error=>error.status===400);
  assert.throws(()=>call('task_update',{task_id:21,due_date:'2026-02-30'}),error=>error.status===400);
});

test('manual agents, overdue task reports, sessions and immutable end activity share the task registry',t=>{
  const {call,clock,db}=fixture(t);
  const session=call('session_start',{agent:'Codex',kind:'codex',request:'Правка сайта'});
  assert.equal(session.agent.state,'work');assert.equal(session.agent.tracking,'manual');
  assert.equal(session.tasks.length,1);
  clock.value+=61*60*1000;
  const agent=call('agents_list').agents[0];
  assert.equal(agent.no_report,true);assert.equal(agent.active_tasks[0].no_report,true);
  call('agent_report',{agent:'Codex',state:'work',last_event:'Всё ещё работаю'});
  call('agent_report',{agent:' codex ',state:'work',last_event:'Всё ещё работаю'});
  assert.equal(call('agents_list').agents.length,1);
  assert.equal(call('agents_list').agents[0].no_report,true,'heartbeat агента не заменяет обновление задачи');
  call('task_update',{task_id:21,blocker:'Жду результат'});
  assert.equal(call('agents_list').agents[0].no_report,false);
  assert.throws(()=>call('session_end',{session_id:session.session_id,summary:'x'},otherScope),error=>error.status===404);
  assert.equal(call('agents_list',{},otherScope).agents[0].last_event,'');
  assert.equal(call('agents_list',{},otherScope).agents[0].state,'unknown');
  assert.throws(()=>call('agent_report',{agent:'Codex',state:'work',last_event:'Подмена области'},otherScope),error=>error.status===404);
  assert.equal(call('agents_list').agents[0].last_event,'Всё ещё работаю');
  assert.equal(call('agents_list',{},otherScope).agents[0].active_tasks[0].id,22);
  const ended=call('session_end',{session_id:session.session_id,summary:'Готово локально',statuses:[{task_id:21,status:'done'}]});
  assert.equal(ended.agent.state,'idle');assert.equal(call('task_get',{task_id:21}).status,'done');
  const repeated=call('session_end',{session_id:session.session_id,summary:'Повтор'});
  assert.equal(repeated.activity.id,ended.activity.id);
  assert.equal(db.prepare('SELECT count(*) n FROM agent_activity').get().n,1);
  assert.throws(()=>db.exec("UPDATE agent_activity SET summary='x'"),/Immutable/);
});

test('failed session end rolls back prior task status changes and leaves session open',t=>{
  const {call,db}=fixture(t);
  const session=call('session_start',{agent:'Codex',kind:'codex',request:'Работа'});
  assert.throws(()=>call('session_end',{session_id:session.session_id,summary:'Не должно сохраниться',statuses:[
    {task_id:21,status:'done'},{task_id:22,status:'done'}]}),error=>error.status===404);
  assert.equal(call('task_get',{task_id:21}).status,'in_progress');
  assert.equal(db.prepare('SELECT ended_at FROM agent_sessions WHERE id=?').get(session.session_id).ended_at,null);
  assert.equal(db.prepare('SELECT count(*) n FROM agent_activity').get().n,0);
});

test('legacy changes advance the shared revision and preserve evidence, so stale open forms cannot overwrite assignment',t=>{
  const {db,api,call}=fixture(t);
  call('task_update',{task_id:21,links:[{url:'https://example.test/proof',kind:'link',label:'Проверка'}]});
  const before=api.get(21,owner);
  const historyBefore=db.prepare('SELECT count(*) n FROM task_coordination_history WHERE task_id=21').get().n;
  db.prepare('UPDATE tasks SET assignee_name=?,status=?,updated_at=? WHERE id=21')
    .run('Gemini','planned','2026-11-02T18:05:00Z');
  const changed=api.get(21,owner);
  assert.equal(changed.revision,before.revision+1);
  assert.equal(changed.updatedBy,0);
  assert.equal(changed.executorName,'Gemini');
  assert.equal(changed.taskStatus,'planned');
  assert.equal(changed.result,before.result);
  assert.deepEqual(changed.milestones,before.milestones);
  assert.deepEqual(changed.links,before.links);
  const event=db.prepare('SELECT * FROM task_coordination_history WHERE task_id=21 ORDER BY revision DESC LIMIT 1').get();
  assert.equal(event.updated_by,0);
  assert.equal(event.updated_at,'2026-11-02T18:05:00Z');
  assert.equal(JSON.parse(event.data).executorName,'Gemini');
  assert.equal(db.prepare('SELECT count(*) n FROM task_coordination_history WHERE task_id=21').get().n,historyBefore+1);
  assert.throws(()=>api.save(21,{revision:before.revision,data:{executorName:'Codex',result:'Старая форма'}},owner),error=>error.status===409);
  assert.equal(call('task_get',{task_id:21}).assignee_name,'Gemini');
  assert.equal(db.prepare('SELECT task_coordinated_write() depth').get().depth,0);

  const data=Object.fromEntries(['module','ownerThreadId','ownerThreadName','executorId','executorName',
    'verifiedModel','scope','acceptance','result','blocker','nextAction','modelCheckedAt','milestones','links'].map(key=>[key,changed[key]]));
  const saved=api.save(21,{revision:changed.revision,data:{...data,executorName:'Claude'}},owner);
  assert.equal(saved.revision,changed.revision+1);
  assert.equal(saved.updatedBy,owner.userId);
  const toolUpdate=call('task_update',{task_id:21,revision:saved.revision,executor:'Codex',status:'done'}).task;
  assert.equal(toolUpdate.coordination.revision,saved.revision+1,'MCP update writes exactly one coordination event');
  assert.equal(db.prepare('SELECT count(*) n FROM task_coordination_history WHERE task_id=21').get().n,historyBefore+3);
  db.exec('UPDATE tasks SET assignee_name=assignee_name WHERE id=21');
  assert.equal(api.get(21,owner).revision,toolUpdate.coordination.revision,'unchanged values do not invent an event');
});

test('legacy revision zero forms conflict after first change, including records without prior coordination',t=>{
  const {db,api}=fixture(t);
  const before=api.get(22,owner);
  assert.equal(before.revision,0);
  db.prepare('UPDATE tasks SET assignee_name=?,updated_at=? WHERE id=22').run('Claude','2026-11-02T18:10:00Z');
  const changed=createTaskCoordination(db).get(22,owner);
  assert.equal(changed.revision,1);assert.equal(changed.updatedBy,0);
  assert.equal(changed.executorName,'Claude');assert.deepEqual(changed.links,[]);
  assert.equal(changed.milestones.accepted.state,'pending');
  assert.throws(()=>api.save(22,{revision:0,data:{executorName:'Codex'}},owner),error=>error.status===409);
  assert.equal(db.prepare('SELECT assignee_name FROM tasks WHERE id=22').get().assignee_name,'Claude');
  assert.equal(db.prepare('SELECT count(*) n FROM task_coordination_history WHERE task_id=22').get().n,1);
});

test('large historical task details remain readable through bounded comment and subtask pages',t=>{
  const {db,call}=fixture(t);
  const comment=db.prepare('INSERT INTO task_comments(task_id,author,text,created_at) VALUES(21,?,?,?)');
  const largeText='旧'.repeat(20000);
  for(let index=0;index<220;index++)comment.run('Codex',largeText,'2026-11-02T18:00:00Z');
  const child=db.prepare(`INSERT INTO tasks(created_at,updated_at,title,description,company_code,parent_task_id)
    VALUES('2026-11-02T18:00:00Z','2026-11-02T18:00:00Z',?,?,'alpha',21)`);
  for(let index=0;index<125;index++)child.run(`Подзадача ${index}`,largeText);
  const initial=call('task_get',{task_id:21});
  assert.equal(initial.comments.length,20);assert.equal(initial.subtasks.length,20);
  assert.deepEqual(initial.comments_pagination,{total:220,limit:20,offset:0});
  assert.deepEqual(initial.subtasks_pagination,{total:125,limit:20,offset:0});
  assert.equal(initial.comments[0].id,220);
  assert.equal(initial.subtasks[0].description,undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(initial))<2*1024*1024);
  const next=call('task_get',{task_id:21,comments_limit:20,comments_offset:20,subtasks_limit:100,subtasks_offset:20});
  assert.equal(next.comments[0].id,200);
  assert.equal(next.subtasks.length,100);
  assert.ok(Buffer.byteLength(JSON.stringify(next))<2*1024*1024);
  for(const params of [{comments_limit:21},{comments_offset:-1},{subtasks_limit:101},{subtasks_offset:1.2}]) {
    assert.throws(()=>call('task_get',{task_id:21,...params}),error=>error.status===400);
  }
  const listing=call('tasks_list',{limit:100});
  assert.equal(listing.tasks.length,100);
  assert.equal(listing.tasks[0].description,undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(listing))<2*1024*1024);
});

test('session_start resumes one open session and closing it cannot incorrectly idle a second session',t=>{
  const {db,call}=fixture(t);
  const first=call('session_start',{agent:'Codex',kind:'codex',request:'Первый запрос'});
  const resumed=call('session_start',{agent:'codex',kind:'codex',request:'Второй запрос'});
  assert.equal(first.resumed,false);assert.equal(resumed.resumed,true);
  assert.equal(first.session_id,resumed.session_id);
  assert.equal(db.prepare('SELECT count(*) n FROM agent_sessions WHERE ended_at IS NULL').get().n,1);
  const ended=call('session_end',{session_id:first.session_id,summary:'Готово'});
  assert.equal(ended.agent.state,'idle');
  const next=call('session_start',{agent:'Codex',kind:'codex',request:'Следующая работа'});
  assert.equal(next.resumed,false);assert.notEqual(next.session_id,first.session_id);
  const replay=call('session_end',{session_id:first.session_id,summary:'Повтор старого итога'});
  assert.equal(replay.agent.state,'work');
  assert.equal(call('agents_list').agents[0].state,'work');
  assert.equal(db.prepare('SELECT count(*) n FROM agent_sessions WHERE ended_at IS NULL').get().n,1);
  assert.throws(()=>call('session_start',{agent:'Codex',kind:'codex',request:'Чужая область'},otherScope),error=>error.status===404);
});

test('migration preserves the old visible executor and archives differing assignments without rewriting coordination bytes',t=>{
  const {db,api}=fixture(t,{migrate:false});
  api.save(21,{revision:1,data:{executorName:'Claude',result:'Сохранить результат',
    milestones:{verified:{state:'confirmed',evidence:'Старая независимая проверка',checkedAt:'2026-11-02T17:00:00Z'}}}},owner);
  db.exec("UPDATE tasks SET assignee_name='' WHERE id=22");
  api.save(22,{revision:0,data:{executorName:'Gemini'}},owner);
  db.exec(`INSERT INTO tasks(id,created_at,updated_at,title,description,company_code,assignee_name,status,source)
    VALUES(23,'old','old','Без координации','Сохранить описание','alpha','Owner','planned','manual'),
      (24,'old','old','Пустое поле координации','Ещё описание','alpha','Дарья','done','telegram');`);
  api.save(24,{revision:0,data:{executorName:''}},owner);
  const oldRows=db.prepare('SELECT * FROM tasks ORDER BY id').all();
  const oldCoordination=db.prepare('SELECT * FROM task_coordination ORDER BY task_id').all();
  const oldHistory=db.prepare('SELECT * FROM task_coordination_history ORDER BY task_id,revision').all();
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try {migrateTasksMcp(db);db.exec('COMMIT');}
  catch(error){db.exec('ROLLBACK');throw error;}
  finally{db.exec('PRAGMA foreign_keys=ON');}
  const migrated=createTaskCoordination(db);
  assert.equal(migrated.get(21,owner).executorName,'Claude');
  assert.equal(migrated.get(22,owner).executorName,'Gemini');
  assert.equal(migrated.get(23,owner).executorName,'Owner');
  assert.equal(migrated.get(24,owner).executorName,'Дарья');
  assert.deepEqual(db.prepare('SELECT * FROM task_coordination ORDER BY task_id').all(),oldCoordination);
  assert.deepEqual(db.prepare('SELECT * FROM task_coordination_history ORDER BY task_id,revision').all(),oldHistory);
  const snapshot=db.prepare('SELECT * FROM task_assignment_migration ORDER BY task_id').all();
  assert.deepEqual(snapshot.map(row=>[row.task_id,row.previous_assignee_name,row.previous_executor_name]),[
    [21,'Codex','Claude'],[22,'','Gemini']]);
  assert.ok(snapshot.every(row=>Number.isFinite(Date.parse(row.migrated_at))));
  assert.throws(()=>db.exec("UPDATE task_assignment_migration SET previous_assignee_name='x'"),/Immutable/);
  assert.throws(()=>db.exec('DELETE FROM task_assignment_migration'),/Immutable/);
  for(const old of oldRows) {
    const row=db.prepare('SELECT * FROM tasks WHERE id=?').get(old.id);
    for(const key of Object.keys(old).filter(key=>key!=='assignee_name'))assert.equal(row[key],old[key],key);
    assert.equal(row.reviewer_name,'');assert.equal(row.parent_task_id,null);assert.equal(row.client_ref,null);
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});
