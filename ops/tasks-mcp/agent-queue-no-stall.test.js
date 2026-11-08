'use strict';

// №194: видимость обработчика, передача зависших запусков запасному, профиль ревью и слияния.
const test = require('node:test');
const assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');
const {randomUUID} = require('node:crypto');
const {createTaskCoordination,migrateTasksMcp,migrateTasksMcpPortable} = require('../crm/task-coordination');
const {createTaskDispatch} = require('../crm/task-dispatch');
const {createAgentLaunch,BACKUP_EXECUTOR} = require('../crm/agent-launch');
const {createTaskWatchdog} = require('../crm/task-watchdog');
const owner = {role:'owner',userId:7,companyCodes:new Set(['alpha'])};
const MINUTE = 60000;

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


const comments = (db,id) => db.prepare('SELECT text FROM task_comments WHERE task_id=? ORDER BY id').all(id).map(row => row.text);

test('presence: heartbeat without a run marks the worker online, silence for 3+ minutes marks it offline',t => {
  const {call,clock} = fixture(t);
  const empty = call('agent_workers_status');
  assert.equal(empty.online,false);assert.equal(empty.last_seen_at,'');assert.equal(empty.minutes_ago,null);
  const worker_id = randomUUID();
  assert.equal(call('agent_worker_update',{worker_id,event:'presence',platform:'win32',active_runs:0}).worker.online,true);
  let status = call('agent_workers_status');
  assert.equal(status.online,true);assert.equal(status.minutes_ago,0);assert.equal(status.workers[0].worker,worker_id.slice(0,8));
  assert.equal(status.workers[0].platform,'win32');
  clock.at += 2 * MINUTE;
  assert.equal(call('agent_workers_status').online,true);
  clock.at += 2 * MINUTE;
  status = call('agent_workers_status');
  assert.equal(status.online,false);assert.equal(status.minutes_ago,4);
  // Опрос очереди тоже считается сигналом.
  call('agent_worker_claim',{worker_id});
  assert.equal(call('agent_workers_status').online,true);
});

test('presence rejects run fields and run updates reject presence fields',t => {
  const {call} = fixture(t);
  const worker_id = randomUUID();
  assert.throws(() => call('agent_worker_update',{worker_id,event:'presence',run_id:randomUUID()}),{status:400});
  assert.throws(() => call('agent_worker_update',{worker_id,event:'presence',active_runs:-1}),{status:400});
  assert.throws(() => call('agent_worker_update',{worker_id:'x',event:'presence'}),{status:400});
  assert.throws(() => call('agent_worker_update',{worker_id,event:'heartbeat',run_id:randomUUID(),lease_token:randomUUID(),platform:'win32'}),{status:400});
});

test('a run nobody claimed for 10 minutes is handed to the backup executor with a task comment',t => {
  const {db,call,create,clock,coordination} = fixture(t);
  const target = create('Исправить код очереди');
  const {run} = call('agent_launch',{task_id:target.id,code_only:true,allowed_paths:['ops/']});
  assert.match(comments(db,target.id).at(-1),/ни разу не выходил на связь/);
  clock.at += 9 * MINUTE;
  assert.equal(call('agent_status',{run_id:run.run_id}).run.state,'queued');
  assert.equal(call('agent_workers_status').queued[0].waiting_minutes,9);
  clock.at += MINUTE;
  const status = call('agent_status',{run_id:run.run_id}).run;
  assert.equal(status.state,'stopped');assert.match(status.summary,/Не стартовал за 10 мин/);
  const text = comments(db,target.id).at(-1);
  assert.match(text,/Не стартовал за 10 мин: обработчик Codex ни разу не выходил на связь/);
  assert.match(text,/запасному исполнителю/);
  const view = coordination.get(target.id,{...owner,companyCodes:['alpha']});
  assert.equal(view.executorName,BACKUP_EXECUTOR);
  assert.match(view.nextAction,/Запасной исполнитель/);
  assert.equal(db.prepare("SELECT state FROM task_dispatch WHERE task_id=?").get(target.id).state,'agent_stopped');
  assert.equal(call('agent_workers_status').handoffs_24h.length,1);
  // Повторный запуск после передачи разрешён обычным путём.
  assert.equal(call('agent_launch',{task_id:target.id,code_only:true,allowed_paths:['ops/']}).created,true);
});

test('handoff reason distinguishes an online but busy worker; claimed runs are never handed off',t => {
  const {db,call,create,clock,claim} = fixture(t);
  const worker_id = randomUUID();
  const tasks = [1,2,3,4].map(n => create(`Код ${n}`));
  for (const task of tasks) call('agent_launch',{task_id:task.id,code_only:true,allowed_paths:['ops/']});
  const jobs = [claim(worker_id),claim(worker_id),claim(worker_id)];
  assert.equal(claim(worker_id),null); // лимит три процесса
  for (let i = 0; i < 10; i++) {
    clock.at += MINUTE;
    for (const job of jobs) call('agent_worker_update',{run_id:job.run_id,worker_id,lease_token:job.lease_token,event:'heartbeat'});
  }
  call('agent_workers_status');
  for (const job of jobs) assert.equal(call('agent_status',{run_id:job.run_id}).run.state,'running');
  const waiting = tasks.find(task => !jobs.some(job => job.task_id === task.id));
  assert.match(comments(db,waiting.id).at(-1),/в сети, но не забрал запуск/);
});

test('sweep hands off stale runs without any agent request and the morning digest gets one line',t => {
  const {db,call,create,clock} = fixture(t);
  const target = create('Код без опроса');
  call('agent_launch',{task_id:target.id,code_only:true,allowed_paths:['ops/']});
  const launch = createAgentLaunch(db,{coordination:createTaskCoordination(db,{now:() => clock.at}),now:() => clock.at});
  assert.deepEqual(launch.sweep(),{handoffs:0});
  clock.at += 11 * MINUTE;
  assert.deepEqual(launch.sweep(),{handoffs:1});
  assert.deepEqual(launch.sweep(),{handoffs:0});
  const watchdog = createTaskWatchdog(db,{now:() => clock.at});
  assert.match(watchdog.digest().text,new RegExp(`переданы запасному: 1 \\(№${target.id}\\)`));
});

test('review-merge profile: needs only a PR number, skips the merge word gate, never accepts paths or continuation',t => {
  const {db,call,create,claim,update} = fixture(t);
  const target = create('Ревью и слияние PR 621','alpha','Независимое ревью, «КОД ПРИНЯТ», merge при зелёном CI. Без deploy.');
  assert.throws(() => call('agent_launch',{task_id:target.id,executor_profile:'codex-review-merge'}),{status:400});
  assert.throws(() => call('agent_launch',{task_id:target.id,executor_profile:'codex-review-merge',pr_number:621,code_only:true}),{status:400});
  assert.throws(() => call('agent_launch',{task_id:target.id,executor_profile:'codex-review-merge',pr_number:621,allowed_paths:['ops/']}),{status:400});
  assert.throws(() => call('agent_launch',{task_id:target.id,code_only:true,allowed_paths:['ops/']}),{status:403}); // merge в задаче
  assert.throws(() => call('agent_launch',{task_id:target.id,code_only:true,allowed_paths:['ops/'],pr_number:5}),{status:400});
  const {run} = call('agent_launch',{task_id:target.id,executor_profile:'codex-review-merge',pr_number:621,client_ref:'review-621'});
  assert.equal(run.executor_profile,'codex-review-merge');assert.equal(run.pr_number,621);assert.equal(run.code_only,false);
  assert.match(run.branch,/^review\/pr-621-/);
  assert.throws(() => call('agent_launch',{task_id:target.id,executor_profile:'codex-review-merge',pr_number:622,client_ref:'review-621'}),{status:409});
  assert.throws(() => call('agent_launch',{task_id:target.id,code_only:true,allowed_paths:['ops/']}),error => [403,409].includes(error.status));
  assert.throws(() => db.prepare('UPDATE task_dispatch_agent_runs SET pr_number=1 WHERE run_id=?').run(run.run_id),/Immutable agent profile/);
  const job = claim();
  assert.equal(job.executor_profile,'codex-review-merge');assert.equal(job.pr_number,621);
  assert.equal(job.code_only,false);assert.deepEqual(job.allowed_paths,[]);
  update(job,'started',{session_id:randomUUID()});update(job,'complete',{summary:'Ревью завершено'});
  assert.throws(() => call('agent_message',{run_id:run.run_id,text:'Ещё раз'}),{status:409});
});

test('review-merge profile refuses deploy instructions in the task',t => {
  const {call,create} = fixture(t);
  const target = create('Ревью PR 700 и deploy на сервер');
  assert.throws(() => call('agent_launch',{task_id:target.id,executor_profile:'codex-review-merge',pr_number:700}),{status:403});
  const ok = create('Ревью PR 701','alpha','merge без deploy');
  assert.equal(call('agent_launch',{task_id:ok.id,executor_profile:'codex-review-merge',pr_number:701}).created,true);
});
