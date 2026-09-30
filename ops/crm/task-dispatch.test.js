'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createTaskDispatch}=require('./task-dispatch');
const owner={role:'owner',userId:1};
function fixture(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());let time=1000000;
 db.exec(`CREATE TABLE companies(code TEXT PRIMARY KEY,is_deleted INTEGER DEFAULT 0); INSERT INTO companies VALUES('alpha',0),('beta',0);
 CREATE TABLE tasks(id INTEGER PRIMARY KEY,title TEXT,description TEXT DEFAULT '',company_code TEXT,status TEXT DEFAULT 'inbox',is_deleted INTEGER DEFAULT 0,created_at TEXT,updated_at TEXT,source TEXT,source_ref TEXT,source_author TEXT,created_by TEXT,assignee_name TEXT DEFAULT '');
 INSERT INTO tasks(id,title,description,company_code) VALUES(1,'Черновик','Подготовить текст','alpha'),(2,'Код','Исправление','beta');`);
 const api=createTaskDispatch(db,{now:()=>time});return {db,api,tick:n=>time+=n};}
test('owner opt-in, one lease, bounded retry and stale completion rejection',t=>{const {api,tick}=fixture(t);
 assert.equal(api.claim(),null);assert.throws(()=>api.enqueue(1,{revision:0},null),e=>e.status===403);
 api.enqueue(1,{revision:0},owner);assert.throws(()=>api.enqueue(1,{revision:0},owner),e=>e.status===409);
 const one=api.claim();assert.equal(one.taskId,1);assert.equal(api.claim(),null);tick(181000);
 assert.throws(()=>api.complete(one,{state:'review',result:'x',department:'marketing',provider:'deepseek',model:'verified'}),e=>e.status===409);
 const two=api.claim();assert.notEqual(two.leaseToken,one.leaseToken);tick(181000);assert.equal(api.claim(),null);
 assert.equal(api.get(1,owner).state,'blocked');assert.equal(api.alerts().length,1);
});
test('question, owner answer, draft review and acceptance survive restart',t=>{const {api,db}=fixture(t);api.enqueue(1,{revision:0},owner);
 const job=api.claim();api.complete(job,{state:'needs_input',question:'Для какой аудитории?',department:'marketing',provider:'deepseek',model:'flash'});
 let saved=api.get(1,owner);api.act(1,{revision:saved.revision,action:'answer',text:'Для новых клиентов'},owner);
 const next=api.claim();assert.match(next.answer,/новых/);api.complete(next,{state:'review',result:'Готовый черновик',department:'marketing',provider:'deepseek',model:'flash'});
 saved=createTaskDispatch(db).get(1,owner);assert.equal(saved.state,'review');assert.equal(saved.model,'flash');
 assert.equal(db.prepare('SELECT status FROM tasks WHERE id=1').get().status,'inbox');
 api.act(1,{revision:saved.revision,action:'accept'},owner);assert.equal(db.prepare('SELECT status FROM tasks WHERE id=1').get().status,'done');
 assert.ok(api.get(1,owner).history.length>=5);
});
test('company change/deletion cancels lease and does not apply old result',t=>{const {api,db}=fixture(t);api.enqueue(1,{revision:0},owner);const job=api.claim();
 db.prepare("UPDATE tasks SET company_code='beta' WHERE id=1").run();assert.throws(()=>api.complete(job,{state:'review',result:'stale',department:'marketing',provider:'p',model:'m'}),e=>e.status===409);
 assert.equal(api.get(1,owner).state,'cancelled');});
test('mirror deduplicates by room and ID; notification handoff is idempotent',t=>{const {api,db}=fixture(t);
 const input={room:'alpha',sourceId:7,companyCode:'alpha',title:'Новая просьба',note:'Точные правки'};
 const a=api.mirror(input),b=api.mirror(input);assert.equal(a.taskId,b.taskId);assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n,3);
 assert.throws(()=>api.mirror({...input,companyCode:'unknown'}),e=>e.status===400);
 const j=api.claim();api.complete(j,{state:'awaiting_executor',result:'Нужен разработчик',department:'engineering',provider:'p',model:'m'});
 assert.equal(api.alerts().length,1);api.ackAlert(api.alerts()[0].id);api.ackAlert(api.alerts()[0]?.id||1);assert.equal(api.alerts().length,0);
});
test('invalid decisions and model-free completion do not mutate work',t=>{const {api}=fixture(t);api.enqueue(1,{revision:0},owner);const j=api.claim();
 for(const bad of [{state:'done',result:'done',provider:'p',model:'m'}, {state:'review',result:'text'}, {state:'review',result:'text',provider:'p',model:'m',department:'unknown'}]) assert.throws(()=>api.complete(j,bad),e=>e.status===400);
 assert.equal(api.get(1,owner).state,'running');});

 test('new chat clarification supersedes old lease without creating another CRM task',t=>{const {api,db}=fixture(t);const data={room:'alpha',sourceId:8,sourceVersion:1,companyCode:'alpha',title:'Правки',note:'Первый вариант'};const first=api.mirror(data),job=api.claim();
 const second=api.mirror({...data,sourceVersion:2,note:'Новая точная правка'});assert.equal(first.taskId,second.taskId);assert.throws(()=>api.complete(job,{state:'review',result:'Устаревший',department:'support',provider:'p',model:'m'}),e=>e.status===409);const fresh=api.claim();assert.match(fresh.description,/Новая точная правка/);assert.equal(db.prepare('SELECT count(*) n FROM task_dispatch_mirrors').get().n,1);});

test('revision preserves the previous draft and question in immutable history',t=>{const {api,db}=fixture(t);api.enqueue(1,{revision:0},owner);api.complete(api.claim(),{state:'review',result:'Первый результат',department:'support',provider:'p',model:'m'});const saved=api.get(1,owner);api.act(1,{revision:saved.revision,action:'revise',text:'Исправить формулировку'},owner);const revised=api.get(1,owner);assert.equal(revised.result,'');assert.ok(revised.history.some(h=>h.result==='Первый результат'&&h.model==='m'));assert.throws(()=>db.exec("DELETE FROM task_dispatch_history"),/Immutable/);});

test('provider cooldown delays the next claim and explains the delay',t=>{const {api,tick}=fixture(t);api.enqueue(1,{revision:0},owner);api.error(api.claim(),{code:'provider',delay:600});assert.match(api.get(1,owner).result,/Провайдеры API/);tick(61000);assert.equal(api.claim(),null);tick(540000);assert.equal(api.claim().taskId,1);});

test('independent review persists on restart and history, clears on revision',t=>{
 const {api,db}=fixture(t);api.enqueue(1,{revision:0},owner);
 const review={verdict:'passed',note:'Проверено по задаче',provider:'second',model:'reviewer',usage:{promptTokens:30,completionTokens:12}};
 api.complete(api.claim(),{state:'review',result:'Черновик',department:'marketing',provider:'first',model:'writer',review});
 let saved=createTaskDispatch(db).get(1,owner);assert.deepEqual(saved.review,review);assert.deepEqual(saved.history[0].review,review);
 api.act(1,{revision:saved.revision,action:'revise',text:'Уточнить условия'},owner);saved=api.get(1,owner);
 assert.equal(saved.review,null);assert.ok(saved.history.some(h=>h.review?.model==='reviewer'));
});
test('same model or provider cannot self-review and rejected review leaves lease intact',t=>{
 const {api}=fixture(t);api.enqueue(1,{revision:0},owner);const job=api.claim();
 const result={state:'review',result:'Черновик',department:'marketing',provider:'first',model:'writer'};
 for(const review of [{provider:'first',model:'reviewer'},{provider:'second',model:'writer'},{provider:'second',model:'WRITER'},{provider:'second',model:''}]){
  assert.throws(()=>api.complete(job,{...result,review:{verdict:'passed',note:'ok',...review}}),e=>e.status===400);
  assert.equal(api.get(1,owner).state,'running');
 }
 api.complete(job,{...result,review:{verdict:'unavailable',note:'Проверка недоступна'}});assert.equal(api.get(1,owner).review.verdict,'unavailable');
});
test('new chat clarification clears obsolete review without removing evidence',t=>{
 const {api}=fixture(t);const input={room:'alpha',sourceId:55,companyCode:'alpha',title:'Текст',note:'Первая версия',sourceVersion:1};const {taskId}=api.mirror(input);
 api.complete(api.claim(),{state:'review',result:'Черновик',department:'marketing',provider:'a',model:'writer',review:{verdict:'changes',note:'Нужно уточнить',provider:'b',model:'checker'}});
 api.mirror({...input,note:'Вторая версия',sourceVersion:2});const r=api.get(taskId,owner);assert.equal(r.state,'queued');assert.equal(r.review,null);assert.ok(r.history.some(h=>h.review?.verdict==='changes'));
});
