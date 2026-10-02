'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createMediaMentor}=require('./media-mentor');
const {createContentPlanJobs}=require('./content-plan-jobs');
const {createContentPlanService}=require('./content-plan-service');
const {createContentPlanWorker}=require('./content-plan-worker');
test('сервис собирает версии реального брифа/профиля/месяца, не принимает контекст от клиента',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec("CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,name TEXT,timezone TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0); INSERT INTO companies VALUES(1,'alpha','Альфа','Asia/Irkutsk','[]',0)");
 const mentor=createMediaMentor(db),jobs=createContentPlanJobs(db),service=createContentPlanService({mentor,jobs});
 const start={clientRequestId:'service_test_01',month:'2026-10'};
 assert.equal(service.create('alpha',start).job.status,'needs_input');
 mentor.saveBrief('alpha',{revision:0,brief:{product:'Оформление шарами',audience:'Организаторы праздников',pains:['Нет времени'],
  confirmedFacts:[{id:'unapproved',statement:'Не подтверждено',source:'гипотеза'},{id:'confirmed',statement:'Есть каталог',source:'Владелец',approvedForContent:true}]}});
 mentor.inputs.saveProfile('alpha',{revision:0,profile:{targetAction:'Запросить расчёт'}});
 mentor.inputs.saveMonth('alpha','2026-10',{revision:0,inputs:{platforms:['telegram'],perDay:{telegram:1}}});
 const created=service.create('alpha',{...start,clientRequestId:'service_test_02'});
 assert.equal(created.job.status,'queued');assert.equal(created.job.coverage.requested,31);
 assert.deepEqual(created.job.inputs,{briefRevision:1,profileRevision:1,monthRevision:1});
 const lease=jobs.claim();assert.equal(lease.snapshot.brief.confirmedFacts.length,1);assert.equal(lease.snapshot.brief.confirmedFacts[0].id,'confirmed');
 assert.equal(lease.snapshot.timezone,'Asia/Irkutsk');
 assert.throws(()=>service.create('alpha',{...start,snapshot:{}}),e=>e.status===400);
 assert.equal(service.get('alpha',created.job.id).job.status,'running');
});


test('необязательное целевое действие не блокирует план и не подставляется сервером',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec("CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,name TEXT,timezone TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0); INSERT INTO companies VALUES(1,'alpha','Альфа','Asia/Irkutsk','[]',0)");
 const mentor=createMediaMentor(db),jobs=createContentPlanJobs(db),service=createContentPlanService({mentor,jobs});
 mentor.saveBrief('alpha',{revision:0,brief:{product:'Оформление',audience:'Родители',pains:['Нет времени']}});
 mentor.inputs.saveMonth('alpha','2026-10',{revision:0,inputs:{platforms:['telegram'],perDay:{telegram:1}}});
 const job=service.create('alpha',{clientRequestId:'optional_action_01',month:'2026-10'}).job;
 assert.equal(job.status,'queued');assert.deepEqual(job.questions,[]);
 assert.equal(jobs.claim().snapshot.profile.targetAction,'');
});


test('полный ввод не ставится в очередь без живого исполнителя через настоящий service',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec("CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,name TEXT,timezone TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0); INSERT INTO companies VALUES(1,'alpha','Альфа','Asia/Irkutsk','[]',0)");
 const mentor=createMediaMentor(db),jobs=createContentPlanJobs(db,{requireWorker:true}),service=createContentPlanService({mentor,jobs});
 mentor.saveBrief('alpha',{revision:0,brief:{product:'Оформление',audience:'Родители',pains:['Нет времени']}});
 mentor.inputs.saveMonth('alpha','2026-10',{revision:0,inputs:{platforms:['telegram'],perDay:{telegram:1}}});
 assert.throws(()=>service.create('alpha',{clientRequestId:'no_worker_01',month:'2026-10'}),e=>e.status===501&&e.details.code==='PROVIDER_NOT_CONFIGURED');
 assert.equal(db.prepare('SELECT count(*) n FROM content_plan_jobs').get().n,0);
 jobs.pulse(true);assert.equal(service.create('alpha',{clientRequestId:'ready_worker_01',month:'2026-10'}).job.status,'queued');
});

function choicesFixture(t,{requireWorker=false}={}){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec("CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,name TEXT,timezone TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0); INSERT INTO companies VALUES(1,'alpha','Альфа','Asia/Irkutsk','[]',0),(2,'beta','Бета','Asia/Irkutsk','[]',0)");
 const mentor=createMediaMentor(db),jobs=createContentPlanJobs(db,{requireWorker}),service=createContentPlanService({mentor,jobs});
 mentor.saveBrief('alpha',{revision:0,brief:{product:'Оформление',audience:'Родители',pains:['Нет времени']}});
 return {db,mentor,jobs,service};
}

function sourceManifest(t,code='alpha'){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE telegram_source_items(id INTEGER PRIMARY KEY,company_code TEXT,revision INTEGER,sha256 TEXT,name TEXT,mime TEXT,size INTEGER,declared_size INTEGER,status TEXT,caption TEXT,metadata TEXT);
 INSERT INTO telegram_source_items VALUES(7,'${code}',1,NULL,'','',NULL,NULL,'text','Исходная подпись','{}')`);
 return {db,capture:()=>require('../content/content-factory-source-context').createSourceContext({db}).capture(code)};
}
test('серверный manifest сохраняется точно, не принимается из body и не раскрывается другой компании',t=>{
 const f=choicesFixture(t),library=sourceManifest(t);f.mentor.inputs.saveMonth('alpha','2026-10',{revision:0,inputs:{platforms:['telegram'],perDay:{telegram:1}}});
 const manifest=library.capture(),copy=structuredClone(manifest),body={clientRequestId:'source_context_01',month:'2026-10'};
 assert.throws(()=>f.service.create('alpha',{...body,sourceLibrary:manifest}),e=>e.status===400);
 assert.throws(()=>f.service.create('alpha',body,{...manifest,companyCode:'beta'}),e=>e.status===400);
 assert.equal(f.db.prepare('SELECT count(*) n FROM content_plan_jobs').get().n,0);
 const created=f.service.create('alpha',body,manifest).job;manifest.assets[0].caption='Правка вызывающего';
 const lease=f.jobs.claim();assert.equal(lease.id,created.id);assert.deepEqual(lease.snapshot.sourceLibrary,copy);
 assert.throws(()=>f.service.get('beta',created.id),e=>e.status===404);
});
test('повтор после правок библиотеки и вводных возвращает старую задачу до чтения нового context',t=>{
 const f=choicesFixture(t),library=sourceManifest(t),body={clientRequestId:'source_replay_01',month:'2026-10'};
 f.mentor.inputs.saveMonth('alpha','2026-10',{revision:0,inputs:{platforms:['telegram'],perDay:{telegram:1}}});
 const manifest=library.capture(),created=f.service.create('alpha',body,manifest).job;
 const before=f.db.prepare('SELECT snapshot,snapshot_hash FROM content_plan_jobs WHERE id=?').get(created.id);
 library.db.exec("UPDATE telegram_source_items SET caption='После запуска',revision=2");
 f.mentor.inputs.saveMonth('alpha','2026-10',{revision:1,inputs:{formats:['reel']}});
 f.mentor.saveBrief('alpha',{revision:1,brief:{product:'Другая ручная правка'}});
 const afterLibrary=library.capture();assert.notEqual(afterLibrary.hash,manifest.hash);
 assert.equal(f.service.create('alpha',body,afterLibrary).job.id,created.id);
 const throwing=new Proxy({}, {ownKeys(){throw Error('Контекст повторно прочитан');}});
 const noReads=createContentPlanService({mentor:{get(){throw Error('Вводные повторно прочитаны');}},jobs:f.jobs});
 assert.equal(noReads.create('alpha',body,throwing).job.id,created.id);
 assert.throws(()=>f.service.create('alpha',{...body,month:'2026-11'},afterLibrary),e=>e.status===409);
 assert.deepEqual(f.db.prepare('SELECT snapshot,snapshot_hash FROM content_plan_jobs WHERE id=?').get(created.id),before);
 const restoredJobs=createContentPlanJobs(f.db),restored=createContentPlanService({mentor:f.mentor,jobs:restoredJobs});
 assert.equal(restored.create('alpha',body,afterLibrary).job.id,created.id);assert.equal(restoredJobs.claim().snapshot.sourceLibrary.hash,manifest.hash);
});

test('снимок сохраняет ограничения месяца после его изменения и не раскрывается другой компании',t=>{
 const f=choicesFixture(t);
 f.mentor.inputs.saveMonth('alpha','2026-10',{revision:0,inputs:{platforms:['telegram'],perDay:{telegram:1},formats:['carousel','post'],roles:['sale']}});
 const first=f.service.create('alpha',{clientRequestId:'choices_snapshot_01',month:'2026-10'}).job;
 f.mentor.inputs.saveMonth('alpha','2026-10',{revision:1,inputs:{formats:[],roles:['reach']}});
 const lease=f.jobs.claim();assert.equal(lease.id,first.id);
 assert.deepEqual(lease.snapshot.monthInputs.formats,['post','carousel']);assert.deepEqual(lease.snapshot.monthInputs.roles,['sale']);
 assert.equal(lease.snapshot.inputs.monthRevision,1);assert.equal(f.mentor.inputs.month('alpha','2026-10').revision,2);
 assert.throws(()=>f.service.get('beta',first.id),e=>e.status===404);
});

test('Shorts без выбранного reel создаёт needs_input даже без исполнителя и не вызывает модель',async t=>{
 const f=choicesFixture(t,{requireWorker:true});
 f.mentor.inputs.saveMonth('alpha','2026-10',{revision:0,inputs:{platforms:['youtube_shorts'],perDay:{youtube_shorts:1},formats:['post'],roles:['sale']}});
 const result=f.service.create('alpha',{clientRequestId:'shorts_choices_01',month:'2026-10'}).job;
 assert.equal(result.status,'needs_input');assert.equal(result.questions.length,1);
 assert.equal(result.questions[0].target,'month.formats');assert.match(result.questions[0].text,/YouTube Shorts/);
 assert.match(result.questions[0].text,/Reels \/ Shorts \/ клип/);
 assert.deepEqual(f.mentor.inputs.month('alpha','2026-10').inputs.formats,['post']);
 let calls=0;
 const worker=createContentPlanWorker({jobs:f.jobs,provider:{generate:async()=>{calls++;}},authorize:async()=>true});
 assert.equal(await worker.runOne(),false);await worker.stop();assert.equal(calls,0);
 assert.equal(f.db.prepare('SELECT snapshot FROM content_plan_jobs WHERE id=?').get(result.id).snapshot.includes('"formats":["post"]'),true);
});

test('Shorts: пустые форматы, выбранный reel и нулевой объём совместимы с генерацией',t=>{
 for(const [suffix,platforms,perDay,formats]of [
  ['all',['youtube_shorts'],{youtube_shorts:1},[]],
  ['reel',['youtube_shorts'],{youtube_shorts:1},['reel']],
  ['zero',['telegram','youtube_shorts'],{telegram:1,youtube_shorts:0},['post']],
 ]){
  const f=choicesFixture(t);
  f.mentor.inputs.saveMonth('alpha','2026-10',{revision:0,inputs:{platforms,perDay,formats}});
  const result=f.service.create('alpha',{clientRequestId:'shorts_allowed_'+suffix,month:'2026-10'}).job;
  assert.equal(result.status,'queued');assert.deepEqual(result.questions,[]);
 }
});

function workflowFixture(t){
 const f=choicesFixture(t),workflow=require('./content-factory-workflow').createContentFactoryWorkflow(f.db);
 f.mentor.inputs.saveMonth('alpha','2026-10',{revision:0,inputs:{platforms:['telegram'],perDay:{telegram:1}}});
 return {...f,workflow,service:createContentPlanService({mentor:f.mentor,jobs:f.jobs,workflow})};
}
test('workflow snapshot сохраняет operational whitelist без имени/актора, прежнее задание неизменно после правок',t=>{
 const f=workflowFixture(t),name='PRIVATE_PUBLISHER_CF22',body={clientRequestId:'workflow_snapshot_01',month:'2026-10'};
 f.workflow.save('alpha',{revision:0,fields:{releaseMode:'scheduled',publisherName:name,hours:['18:30','09:00'],preparationDays:3,reviewDays:2}},{userId:17,userName:'PRIVATE_ACTOR_CF22'});
 const created=f.service.create('alpha',body).job;
 assert.equal(created.inputs.workflowRevision,1);
 const before=f.db.prepare('SELECT snapshot,snapshot_hash FROM content_plan_jobs WHERE id=?').get(created.id);
 assert.doesNotMatch(before.snapshot,/PRIVATE_|publisherName|actor|approverRole/);
 const expected={companyCode:'alpha',revision:1,configured:true,fields:{releaseMode:'scheduled',hours:['09:00','18:30'],preparationDays:3,reviewDays:2}};
 assert.deepEqual(JSON.parse(before.snapshot).workflow,expected);
 f.workflow.save('alpha',{revision:1,fields:{releaseMode:'manual',hours:[],publisherName:'Другое имя'}});
 const read=f.workflow.get('alpha');read.fields.hours.push('22:00');
 assert.equal(f.service.create('alpha',body).job.id,created.id);
 const lease=f.jobs.claim();assert.deepEqual(lease.snapshot.workflow,expected);
 assert.deepEqual(f.db.prepare('SELECT snapshot,snapshot_hash FROM content_plan_jobs WHERE id=?').get(created.id),before);
 assert.throws(()=>f.service.get('beta',created.id),e=>e.status===404);
 assert.throws(()=>f.service.create('alpha',{...body,clientRequestId:'client_workflow_01',workflow:expected}),e=>e.status===400);
});
test('workflow defaults и optional dependency: configured=false сохраняется, старый путь не добавляет поля',t=>{
 const f=workflowFixture(t),job=f.service.create('alpha',{clientRequestId:'workflow_default_01',month:'2026-10'}).job;
 assert.equal(job.inputs.workflowRevision,0);
 const lease=f.jobs.claim();assert.deepEqual(lease.snapshot.workflow,{companyCode:'alpha',revision:0,configured:false,
  fields:{releaseMode:'manual',hours:[],preparationDays:0,reviewDays:0}});
 const old=workflowFixture(t),legacy=createContentPlanService({mentor:old.mentor,jobs:old.jobs});
 const oldJob=legacy.create('alpha',{clientRequestId:'workflow_legacy_01',month:'2026-10'}).job;
 assert.equal(Object.hasOwn(oldJob.inputs,'workflowRevision'),false);
 assert.equal(Object.hasOwn(old.jobs.claim().snapshot,'workflow'),false);
});
test('workflow revision race отклоняет enqueue; повтор idempotency не читает новые настройки',t=>{
 const f=workflowFixture(t);let reads=0;
 const racing=createContentPlanService({mentor:f.mentor,jobs:f.jobs,workflow:{get(code){
  if(++reads===2)f.workflow.save(code,{revision:0,fields:{releaseMode:'manual'}});
  return f.workflow.get(code);
 }}});
 assert.throws(()=>racing.create('alpha',{clientRequestId:'workflow_race_01',month:'2026-10'}),e=>e.status===409&&e.details.code==='INPUTS_CHANGED');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM content_plan_jobs').get().n,0);
 const body={clientRequestId:'workflow_replay_01',month:'2026-10'},created=f.service.create('alpha',body).job;
 const replay=createContentPlanService({jobs:f.jobs,mentor:{get(){throw Error('Unexpected mentor read');}},workflow:{get(){throw Error('Unexpected workflow read');}}});
 assert.equal(replay.create('alpha',body).job.id,created.id);
});
test('workflow чужой компании или неверных типов не может попасть в новое задание',t=>{
 const f=workflowFixture(t);
 for(const saved of [f.workflow.get('beta'),{...f.workflow.get('alpha'),revision:'0'},
  {...f.workflow.get('alpha'),fields:{...f.workflow.get('alpha').fields,reviewDays:'2'}}]){
  const service=createContentPlanService({mentor:f.mentor,jobs:f.jobs,workflow:{get:()=>saved}});
  assert.throws(()=>service.create('alpha',{clientRequestId:'workflow_bad_scope_01',month:'2026-10'}),e=>e.status===400);
 }
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM content_plan_jobs').get().n,0);
});
