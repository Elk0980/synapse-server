'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {randomUUID} = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Worker} = require('node:worker_threads');
const {createTaskCoordination,migrateTasksMcp,migrateTasksMcpPortable} = require('../crm/task-coordination');
const {createTaskDispatch} = require('../crm/task-dispatch');
const {createAgentLaunch} = require('../crm/agent-launch');
const owner = {role:'owner',userId:7,companyCodes:new Set(['alpha'])};

function fixture(t,{databasePath=':memory:',closeAfter=true}={}) {
  const db = new DatabaseSync(databasePath);
  if (closeAfter) t.after(() => db.close());
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
      source_ref TEXT NOT NULL DEFAULT '',source_author TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL DEFAULT '');`);
  createTaskCoordination(db);
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  migrateTasksMcp(db);migrateTasksMcpPortable(db);db.exec('COMMIT; PRAGMA foreign_keys=ON');
  const clock = {at:Date.parse('2026-11-03T12:00:00Z')};
  const coordination = createTaskCoordination(db,{now:() => clock.at});
  const dispatch = createTaskDispatch(db,{now:() => clock.at});
  const launch = createAgentLaunch(db,{coordination,now:() => clock.at});
  const call = (name,args={},actor=owner) => launch.tool(name,args,actor);
  const create = (title='Исправить код',project='alpha',description='Локальный патч и проверка') => coordination.tool('task_create',
    {client_ref:randomUUID(),title,description,project,executor:'Codex',reviewer:'Claude'},
    {...owner,companyCodes:['alpha','beta']}).task;
  const update = (job,event,extra={}) => call('agent_worker_update',{
    run_id:job.run_id,worker_id:job.worker_id,lease_token:job.lease_token,event,...extra});
  const claim = (worker_id=randomUUID()) => {
    const {job} = call('agent_worker_claim',{worker_id});
    return job && {...job,worker_id};
  };
  return {db,clock,coordination,dispatch,call,create,update,claim};
}

test('server requires explicit code-only consent and frozen repository paths before launch',t => {
  const {db,call,create} = fixture(t);
  const target = create();
  for (const args of [{task_id:target.id},{task_id:target.id,code_only:false,allowed_paths:['ops/']},
    {task_id:target.id,code_only:1,allowed_paths:['ops/']},{task_id:target.id,code_only:true}]) {
    assert.throws(() => call('agent_launch',args),error => [400,403].includes(error.status));
  }
  for (const allowed_paths of [[],['.'],['/'],['../ops/'],['ops/../secret'],['ops//'],['ops\\crm/'],['C:/ops/'],['ops/*'],[' ops/'],['ops/\n'],['ops/[a]'],Array(101).fill('ops/')]) {
    assert.throws(() => call('agent_launch',{task_id:target.id,code_only:true,allowed_paths}),{status:400});
  }
  assert.equal(db.prepare('SELECT count(*) n FROM task_dispatch_agent_runs').get().n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM task_dispatch').get().n,0);
  const {run} = call('agent_launch',{task_id:target.id,code_only:true,allowed_paths:['ops/crm/','README.md'],client_ref:'scoped-launch'});
  assert.equal(run.code_only,true);assert.deepEqual(run.allowed_paths,['ops/crm/','README.md']);
  assert.throws(() => call('agent_launch',{task_id:target.id,code_only:true,allowed_paths:['sites/'],client_ref:'scoped-launch'}),{status:409});
  assert.throws(() => call('agent_launch',{task_id:target.id,code_only:true,allowed_paths:['sites/']}),{status:409});
  assert.deepEqual(call('agent_status',{run_id:run.run_id}).run.allowed_paths,['ops/crm/','README.md']);
  assert.throws(() => db.prepare('UPDATE task_dispatch_agent_runs SET allowed_paths=? WHERE run_id=?').run('["sites/"]',run.run_id),/Immutable agent scope/);
  assert.throws(() => db.prepare('UPDATE task_dispatch_agent_runs SET code_only=0 WHERE run_id=?').run(run.run_id),/Immutable agent scope/);
});

test('add-only consent migration leaves legacy queued and resumed work unauthorized',t => {
  const {db,call,create,claim,update,coordination,clock} = fixture(t);
  const a = create('Очередь'), b = create('Процесс'), c = create('Контекст');
  const runs = [a,b,c].map(task => call('agent_launch',{task_id:task.id,code_only:true,allowed_paths:['ops/']}).run);
  const jobs = [claim(),claim(),claim()];
  const byTask = new Map(jobs.map(job => [job.task_id,job]));
  update(byTask.get(c.id),'started',{session_id:randomUUID()});update(byTask.get(c.id),'complete');
  // A pre-feature snapshot has the old run columns, including a queued job.
  db.prepare("UPDATE task_dispatch_agent_runs SET state='queued',worker_id='',lease_token='',lease_until=0 WHERE run_id=?").run(runs[0].run_id);
  db.exec('DROP TRIGGER task_dispatch_agent_scope_immutable; ALTER TABLE task_dispatch_agent_runs DROP COLUMN code_only; ALTER TABLE task_dispatch_agent_runs DROP COLUMN allowed_paths;');
  createAgentLaunch(db,{coordination,now:()=>clock.at});
  assert.ok(db.prepare('SELECT code_only,allowed_paths FROM task_dispatch_agent_runs').all().every(row => row.code_only===0 && row.allowed_paths==='[]'));
  assert.equal(claim(),null);
  assert.equal(call('agent_status',{run_id:runs[0].run_id}).run.state,'failed');
  assert.equal(call('agent_status',{run_id:runs[1].run_id}).run.stop_requested,true);
  assert.throws(() => call('agent_message',{run_id:runs[2].run_id,text:'Продолжи'}),{status:403});
  const replacement = call('agent_launch',{task_id:a.id,code_only:true,allowed_paths:['ops/']}).run;
  assert.notEqual(replacement.run_id,runs[0].run_id);
  assert.equal(db.prepare('SELECT code_only FROM task_dispatch_agent_runs WHERE run_id=?').get(runs[0].run_id).code_only,0);
  assert.equal(replacement.code_only,true);
  assert.equal(update(byTask.get(b.id),'stopped').run.state,'stopped');
});

test('existing dispatcher stages are rejected without changing any task, dispatch or history bytes',t => {
  const {db,call,create,dispatch} = fixture(t);
  for (const state of ['review','needs_input','blocked','queued','running','failed','done','cancelled']) {
    const target = create(`Существующий этап ${state}`);
    dispatch.enqueue(target.id,{revision:0},owner);
    db.prepare("UPDATE task_dispatch SET state=?,revision=17,question='SAMPLE question',result='SAMPLE result',review=? WHERE task_id=?")
      .run(state,JSON.stringify({verdict:'passed',note:'SAMPLE прежняя проверка'}),target.id);
    const snapshot = () => JSON.stringify({task:db.prepare('SELECT * FROM tasks WHERE id=?').get(target.id),
      dispatch:db.prepare('SELECT * FROM task_dispatch WHERE task_id=?').get(target.id),
      history:db.prepare('SELECT * FROM task_dispatch_history WHERE task_id=? ORDER BY id').all(target.id),
      comments:db.prepare('SELECT * FROM task_comments WHERE task_id=? ORDER BY id').all(target.id),
      coordination:db.prepare('SELECT * FROM task_coordination WHERE task_id=?').get(target.id)});
    const before = snapshot();
    assert.throws(() => call('agent_launch',{task_id:target.id,code_only:true,allowed_paths:['ops/']}),{status:409},state);
    assert.equal(snapshot(),before,state);
  }
});

test('external dispatcher takeover stops live agent without changing shared row or history',t => {
  const {db,call,create,claim,update,coordination,clock} = fixture(t);
  for (const state of ['review','needs_input','blocked']) {
    const target = create(`Изменённая очередь ${state}`);
    const {run} = call('agent_launch',{task_id:target.id,code_only:true,allowed_paths:['ops/']});
    const job = claim(), session_id = randomUUID();
    update(job,'started',{session_id});
    db.prepare("UPDATE task_dispatch SET state=?,revision=91,question='SAMPLE внешний вопрос',result='SAMPLE внешний результат',review=? WHERE task_id=?")
      .run(state,JSON.stringify({verdict:'passed',note:'SAMPLE внешняя проверка'}),target.id);
    coordination.tool('task_update',{task_id:target.id,status:'planned'},owner);
    const snapshot = () => JSON.stringify({dispatch:db.prepare('SELECT * FROM task_dispatch WHERE task_id=?').get(target.id),
      history:db.prepare('SELECT * FROM task_dispatch_history WHERE task_id=? ORDER BY id').all(target.id)});
    const before = snapshot();
    const status = call('agent_status',{run_id:run.run_id}).run;
    assert.equal(status.stop_requested,true);assert.equal(status.state,'running');assert.equal(snapshot(),before);
    assert.equal(update(job,'heartbeat').run.stop_requested,true);assert.equal(snapshot(),before);
    update(job,'started',{session_id});
    assert.equal(coordination.tool('task_get',{task_id:target.id},owner).status,'planned');
    call('agent_stop',{run_id:run.run_id});assert.equal(snapshot(),before);
    clock.at+=120001;
    assert.equal(call('agent_status',{run_id:run.run_id}).run.state,'unknown');assert.equal(snapshot(),before);
    assert.equal(update(job,'stopped').run.state,'stopped');assert.equal(snapshot(),before);
    assert.equal(update(job,'stopped').run.state,'stopped');assert.equal(snapshot(),before);
  }
});

test('external dispatcher takeover cancels unstarted work and old run cannot take a newer run queue',t => {
  const {db,call,create,claim,update,coordination} = fixture(t);
  const unstarted = create();
  const queued = call('agent_launch',{task_id:unstarted.id,code_only:true,allowed_paths:['ops/']}).run;
  db.prepare("UPDATE task_dispatch SET state='review',revision=7,result='SAMPLE shared' WHERE task_id=?").run(unstarted.id);
  const saved = JSON.stringify(db.prepare('SELECT * FROM task_dispatch WHERE task_id=?').get(unstarted.id));
  assert.equal(call('agent_status',{run_id:queued.run_id}).run.state,'stopped');assert.equal(claim(),null);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM task_dispatch WHERE task_id=?').get(unstarted.id)),saved);
  const target = create();
  const old = call('agent_launch',{task_id:target.id,code_only:true,allowed_paths:['ops/']}).run;
  const job = claim();update(job,'started',{session_id:randomUUID()});update(job,'failed');
  const newer = call('agent_launch',{task_id:target.id,code_only:true,allowed_paths:['ops/']}).run;
  claim();
  const snapshot = JSON.stringify(db.prepare('SELECT * FROM task_dispatch WHERE task_id=?').get(target.id));
  assert.throws(() => call('agent_message',{run_id:old.run_id,text:'Старый контекст'}),{status:409});
  call('agent_stop',{run_id:old.run_id});
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM task_dispatch WHERE task_id=?').get(target.id)),snapshot);
  assert.equal(call('agent_status',{run_id:newer.run_id}).run.state,'running');
  assert.equal(coordination.tool('agents_list',{},owner).agents.find(agent => agent.name===`Codex — задача #${target.id}`).state,'work');
});

test('launch uses existing dispatch, is idempotent, assigns the agent, preserves legacy records',t => {
  const {db,coordination,dispatch,call,create,claim} = fixture(t);
  const legacy = create('Старое поручение');
  dispatch.enqueue(legacy.id,{revision:0},owner);
  const old = db.prepare('SELECT * FROM task_dispatch WHERE task_id=?').get(legacy.id);
  const target = create();
  const first = call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:target.id,client_ref:'launch-1'});
  assert.equal(first.created,true);
  assert.equal(first.run.state,'queued');
  assert.match(first.run.branch,/^codex\/agent-task-/);
  assert.equal(call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:target.id,client_ref:'launch-1'}).run.run_id,first.run.run_id);
  assert.equal(call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:target.id}).created,false);
  assert.deepEqual(db.prepare('SELECT * FROM task_dispatch WHERE task_id=?').get(legacy.id),old);
  assert.equal(db.prepare('SELECT count(*) n FROM task_dispatch_agent_runs').get().n,1);
  assert.equal(coordination.tool('agents_list',{},owner).agents.find(a => a.name===`Codex — задача #${target.id}`).active_tasks[0].id,target.id);
  assert.equal(coordination.tool('task_get',{task_id:target.id},owner).reviewer_name,'Claude');
  const job = claim();
  assert.equal(job.run_id,first.run.run_id);
  assert.equal(job.code_only,true);assert.deepEqual(job.allowed_paths,['ops/']);
  assert.equal(job.lease_until,'2026-11-03T12:02:00.000Z');
  assert.equal(dispatch.claim().taskId,legacy.id); // Server text dispatch cannot steal agent work.
  assert.throws(() => db.exec("UPDATE task_dispatch_history SET note='replace'"),/Immutable/);
});

test('Owner identity, explicit project scope, unknown profiles and closed tasks are enforced',t => {
  const {call,create,coordination} = fixture(t);
  const target = create(), foreign = create('Чужая задача','beta');
  assert.throws(() => call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:target.id},{...owner,role:'editor'}),{status:403});
  assert.throws(() => call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:target.id},{...owner,companyCodes:[]}),{status:404});
  assert.throws(() => call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:foreign.id}),{status:404});
  assert.throws(() => call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:target.id,executor_profile:'claude-code'}),{status:400});
  const {run} = call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:target.id});
  assert.throws(() => call('agent_status',{run_id:run.run_id},{...owner,userId:8}),{status:404});
  assert.equal('lease_token' in call('agent_status',{run_id:run.run_id}).run,false);
  coordination.tool('task_update',{task_id:foreign.id,status:'done'},{...owner,companyCodes:['beta']});
  assert.throws(() => call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:foreign.id},{...owner,companyCodes:['beta']}),{status:409});
});

test('three process slots are atomic across worker identities; expired leases remain reserved',t => {
  const {call,create,claim,clock,update} = fixture(t);
  for (let i=0;i<4;i++) call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:create(`Код ${i}`).id});
  const jobs = [claim(),claim(),claim()];
  assert.equal(new Set(jobs.map(j => j.run_id)).size,3);
  assert.equal(claim(),null);
  clock.at+=120001;
  assert.equal(call('agent_status',{run_id:jobs[0].run_id}).run.state,'unknown');
  assert.equal(claim(),null);
  assert.throws(() => update({...jobs[0],lease_token:randomUUID()},'heartbeat'),{status:409});
  update(jobs[0],'heartbeat');
  assert.equal(call('agent_status',{run_id:jobs[0].run_id}).run.state,'running');
  call('agent_stop',{run_id:jobs[0].run_id});
  assert.equal(claim(),null);
  update(jobs[0],'stopped');
  assert.ok(claim());
});

test('concurrent independent SQLite connections cannot claim a fourth process',async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'agent-slots-'));
  const databasePath = path.join(directory,'sample.sqlite');
  const {db,create,call} = fixture(t,{databasePath,closeAfter:false});
  const workers = [];
  try {
    for (let i=0;i<8;i++) call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:create(`Код ${i}`).id});
    const barrier = new SharedArrayBuffer(4), flag = new Int32Array(barrier);
    const source = `const {parentPort,workerData}=require('node:worker_threads');
      const {DatabaseSync}=require('node:sqlite');
      const {createTaskCoordination}=require(workerData.coordination);
      const {createAgentLaunch}=require(workerData.launch);
      const db=new DatabaseSync(workerData.path);db.exec('PRAGMA busy_timeout=5000');
      const coordination=createTaskCoordination(db);
      const api=createAgentLaunch(db,{coordination});
      parentPort.postMessage({ready:true});
      Atomics.wait(new Int32Array(workerData.barrier),0,0);
      const value=api.tool('agent_worker_claim',{worker_id:workerData.id},
        {role:'owner',userId:7,companyCodes:['alpha']});
      db.close();parentPort.postMessage({result:value});`;
    const ready = [], results = [];
    for (let i=0;i<8;i++) {
      const worker = new Worker(source,{eval:true,workerData:{barrier,path:databasePath,id:randomUUID(),
        coordination:require.resolve('../crm/task-coordination'),launch:require.resolve('../crm/agent-launch')}});
      workers.push(worker);
      ready.push(new Promise((resolve,reject) => {
        worker.on('message',message => { if(message.ready) resolve(); });worker.on('error',reject);
      }));
      results.push(new Promise((resolve,reject) => {
        worker.on('message',message => { if(message.result) resolve(message.result); });worker.on('error',reject);
        worker.on('exit',code => { if(code) reject(new Error(`sample worker exit ${code}`)); });
      }));
    }
    await Promise.all(ready);
    Atomics.store(flag,0,1);Atomics.notify(flag,0);
    const jobs = (await Promise.all(results)).map(value => value.job).filter(Boolean);
    assert.equal(jobs.length,3);assert.equal(new Set(jobs.map(job => job.run_id)).size,3);
    assert.equal(db.prepare("SELECT count(*) n FROM task_dispatch_agent_runs WHERE state='running'").get().n,3);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    db.close();
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('Небезопасный тестовый путь');
    fs.rmSync(directory,{recursive:true,force:true});
  }
});

test('complete and resume preserve run, branch and session; retries cannot duplicate turns',t => {
  const {call,create,claim,update,coordination} = fixture(t);
  const target = create();
  const {run} = call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:target.id});
  const job = claim(), session_id = randomUUID();
  update(job,'started');
  update(job,'started',{session_id});
  update(job,'complete',{session_id,exit_code:0,summary:'TURN_COMPLETE'});
  const count = coordination.tool('task_get',{task_id:target.id},owner).comments_pagination.total;
  update(job,'complete',{session_id,exit_code:0,summary:'TURN_COMPLETE'});
  assert.equal(coordination.tool('task_get',{task_id:target.id},owner).comments_pagination.total,count);
  assert.equal(call('agent_status',{run_id:run.run_id}).run.state,'waiting');
  assert.equal(coordination.tool('task_get',{task_id:target.id},owner).status,'in_progress');
  const follow = call('agent_message',{run_id:run.run_id,text:'Исправь тест',client_ref:'fix-1'});
  assert.equal(follow.queued,true);
  assert.equal(call('agent_message',{run_id:run.run_id,text:'Исправь тест',client_ref:'fix-1'}).queued,false);
  const resume = claim();
  assert.equal(resume.run_id,run.run_id);
  assert.equal(resume.session_id,session_id);
  assert.equal(resume.branch,run.branch);
  assert.equal(resume.message,'Исправь тест');
  assert.equal(resume.code_only,true);assert.deepEqual(resume.allowed_paths,['ops/']);
  assert.ok(Number.isSafeInteger(resume.message_id));
  assert.throws(() => update(job,'complete'),{status:409});
  assert.throws(() => update(resume,'started',{session_id:randomUUID()}),{status:409});
});

test('stop waits for process acknowledgement and queued stop never spawns',t => {
  const {call,create,claim,update} = fixture(t);
  const first = call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:create().id}).run;
  call('agent_stop',{run_id:first.run_id});
  assert.equal(claim(),null);
  const second = call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:create().id}).run;
  const job = claim();
  const stopping = call('agent_stop',{run_id:second.run_id}).run;
  assert.equal(stopping.state,'running');assert.equal(stopping.stop_requested,true);
  assert.deepEqual(call('agent_stop',{run_id:second.run_id}).run,stopping);
  assert.equal(update(job,'complete',{summary:'PROCESS_EXIT'}).run.state,'stopped');
});

test('production directions in task, comments, continuation or changed live context fail closed',t => {
  const {call,create,claim,update,coordination,db} = fixture(t);
  for (const title of ['Изменить боевой сервер','deploy release','Сделать merge','Без merge; сделай deploy','Не трогай production и выполни merge',
    'Залей на прод','Выкати на сервер','Установи на сервер','Смена продуктивного режима','git push origin main','git push origin HEAD:main','git push origin HEAD:refs/heads/main',
    'pгoд','рrоd','prоd','продакшн','upload to server','roll out to server']) {
    assert.throws(() => call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:create(title).id}),{status:403});
  }
  const target = create();
  coordination.tool('task_comment',{task_id:target.id,author:'Owner',text:'Обновить боевой'},owner);
  assert.throws(() => call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:target.id}),{status:403});
  const changing = create();
  const r = call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:changing.id}).run;
  const job = claim();
  update(job,'started',{session_id:randomUUID()});
  update(job,'complete');
  assert.throws(() => call('agent_message',{run_id:r.run_id,text:'deploy сейчас'}),{status:403});
  call('agent_message',{run_id:r.run_id,text:'Продолжить проверку'});
  const resumed = claim();
  coordination.tool('task_comment',{task_id:changing.id,author:'Owner',text:'Обновить production'},owner);
  assert.equal(update(resumed,'heartbeat').run.stop_requested,true);
  assert.equal(update(resumed,'stopped').run.state,'stopped');
  assert.equal(db.prepare('SELECT count(*) n FROM task_dispatch_agent_runs WHERE task_id=?').get(changing.id).n,1);
});

test('normal PR-without-merge report does not poison heartbeat or subsequent resume',t => {
  const {call,create,claim,update,coordination} = fixture(t);
  const target = create('Код и PR без merge','alpha','Локальная проверка. Не трогать боевой сервер; deploy запрещён.');
  const {run} = call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:target.id});
  const job = claim();
  update(job,'started',{session_id:randomUUID()});
  coordination.tool('task_comment',{task_id:target.id,author:'Codex',text:'PR без merge/deploy. Production не трогал. Боевой сервер не менял.'},owner);
  assert.equal(update(job,'heartbeat').run.stop_requested,false);
  update(job,'complete');
  assert.equal(call('agent_message',{run_id:run.run_id,text:'Проверь ещё раз, без merge/deploy'}).queued,true);
  assert.equal(claim().run_id,run.run_id);
});

test('task closure or company move requests stop while original worker may acknowledge safely',t => {
  const {call,create,claim,update,coordination,db} = fixture(t);
  const target = create();
  const {run} = call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:target.id});
  const job = claim();
  coordination.tool('task_update',{task_id:target.id,status:'cancelled'},owner);
  assert.equal(update(job,'heartbeat').run.stop_requested,true);
  assert.equal(update(job,'stopped').run.state,'stopped');
  const other = create();
  call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:other.id});
  const moved = claim();
  db.prepare('UPDATE tasks SET company_code=? WHERE id=?').run('beta',other.id);
  assert.throws(() => call('agent_status',{run_id:moved.run_id}),{status:404});
  assert.equal(update(moved,'heartbeat').run.stop_requested,true);
  assert.equal(update(moved,'stopped').run.state,'stopped');
  assert.equal(call('agent_status',{run_id:run.run_id}).run.state,'stopped');
});

test('expired stopping processes become unknown after closed or unsafe task and keep their slots',t => {
  const {call,create,claim,update,coordination,clock} = fixture(t);
  const closed = create('Первая проверка'), unsafe = create('Вторая проверка'), third = create('Третья проверка'), queued = create('Четвёртая проверка');
  const runs = [closed,unsafe,third].map(task => call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:task.id}).run);
  const jobs = [claim(),claim(),claim()];
  const byTask = new Map(jobs.map(job => [job.task_id,job]));
  call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:queued.id});
  coordination.tool('task_update',{task_id:closed.id,status:'cancelled'},owner);
  coordination.tool('task_comment',{task_id:unsafe.id,author:'Owner',text:'Обновить production'},owner);
  for (const r of runs.slice(0,2)) {
    const status = call('agent_status',{run_id:r.run_id}).run;
    assert.equal(status.state,'running');assert.equal(status.stop_requested,true);
  }
  const closedCommentCount = coordination.tool('task_get',{task_id:closed.id},owner).comments_pagination.total;
  clock.at+=120001;
  for (const r of runs.slice(0,2)) {
    const status = call('agent_status',{run_id:r.run_id}).run;
    assert.equal(status.state,'unknown');assert.equal(status.stop_requested,true);
  }
  assert.equal(coordination.tool('task_get',{task_id:closed.id},owner).comments_pagination.total,closedCommentCount);
  assert.equal(claim(),null);
  assert.equal(update(byTask.get(closed.id),'stopped').run.state,'stopped');
  assert.ok(claim());
  assert.equal(update(byTask.get(unsafe.id),'stopped').run.state,'stopped');
});

test('moved process expiry changes registry state without auditing into the new company',t => {
  const {call,create,claim,update,coordination,clock,db} = fixture(t);
  const target = create();
  const {run} = call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:target.id});
  const job = claim();
  const count = coordination.tool('task_get',{task_id:target.id},owner).comments_pagination.total;
  db.prepare('UPDATE tasks SET company_code=? WHERE id=?').run('beta',target.id);
  clock.at+=120001;
  assert.equal(claim(),null); // Reconcile without reading a task outside the actor's scope.
  const row = db.prepare('SELECT state,stop_requested FROM task_dispatch_agent_runs WHERE run_id=?').get(run.run_id);
  assert.equal(row.state,'unknown');assert.equal(row.stop_requested,1);
  const other = {...owner,companyCodes:['beta']};
  assert.equal(coordination.tool('task_get',{task_id:target.id},other).comments_pagination.total,count);
  assert.equal(update(job,'stopped').run.state,'stopped');
});

test('existing dispatcher cancel/mirror cannot silently cancel or requeue local code',t => {
  const {call,claim,coordination,dispatch,db} = fixture(t);
  const mirrored = dispatch.mirror({room:'alpha',sourceId:1,sourceVersion:1,companyCode:'alpha',title:'Проверить модуль',note:'Локальная проверка'});
  const serverJob = dispatch.claim();
  dispatch.complete(serverJob,{state:'awaiting_executor',department:'engineering',result:'Нужен код',provider:'sample',model:'sample'});
  const {run} = call('agent_launch',{code_only:true,allowed_paths:['ops/'],task_id:mirrored.taskId});
  const revision = dispatch.get(mirrored.taskId,owner).revision;
  assert.throws(() => dispatch.act(mirrored.taskId,{revision,action:'cancel'},owner),{status:409});
  dispatch.mirror({room:'alpha',sourceId:1,sourceVersion:2,companyCode:'alpha',title:'Проверить модуль',note:'Проверить ещё один файл'});
  assert.equal(db.prepare('SELECT state FROM task_dispatch WHERE task_id=?').get(mirrored.taskId).state,'agent_queued');
  assert.equal(dispatch.claim(),null);
  assert.equal(claim().run_id,run.run_id);
  assert.ok(coordination.tool('task_get',{task_id:mirrored.taskId},owner).comments.length);
});
