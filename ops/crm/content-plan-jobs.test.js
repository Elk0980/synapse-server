'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createContentPlanJobs}=require('./content-plan-jobs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,is_deleted INTEGER DEFAULT 0); INSERT INTO companies VALUES(1,'alpha',0),(2,'beta',0)");
  let clock=Date.parse('2026-10-01T00:00:00Z');
  const options={now:()=>clock,leaseMs:1000,maxAttempts:2};
  return {db,options,api:createContentPlanJobs(db,options),tick:n=>clock+=n};
}
const input=(id='request_01')=>({clientRequestId:id,month:'2026-10',snapshot:{briefRevision:1,product:'Оформление'}});
test('read-only lookup возвращает прежнюю задачу до нового snapshot, изолирует компанию и месяц',t=>{
 const f=fixture(t),created=f.api.enqueue('alpha',input());
 const fingerprint=f.db.prepare('SELECT fingerprint FROM content_plan_requests').get().fingerprint;
 assert.equal(f.api.lookupRequest('ALPHA','request_01','2026-10').job.id,created.id);
 assert.equal(f.api.lookupRequest('beta','request_01','2026-10'),null);
 assert.equal(f.api.lookupRequest('alpha','missing_key','2026-10'),null);
 assert.throws(()=>f.api.lookupRequest('alpha','request_01','2026-11'),e=>e.status===409&&e.details.code==='REQUEST_CONFLICT');
 assert.throws(()=>f.api.lookupRequest('alpha','x','2026-10'),e=>e.status===400);
 const restored=createContentPlanJobs(f.db,f.options);
 assert.equal(restored.lookupRequest('alpha','request_01','2026-10').job.id,created.id);
 assert.equal(f.db.prepare('SELECT fingerprint FROM content_plan_requests').get().fingerprint,fingerprint);
 assert.throws(()=>f.api.enqueue('alpha',{...input(),snapshot:{product:'Правка'}}),e=>e.status===409);
});
test('sourceLibrary и lookup сохраняются после закрытия файловой SQLite БД',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cf-source-snapshot-'));
 t.after(()=>{if(!path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep))throw Error('Unsafe cleanup');fs.rmSync(dir,{recursive:true,force:true})});
 const file=path.join(dir,'jobs.sqlite');let db=new DatabaseSync(file),created,manifest;
 try{
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,is_deleted INTEGER DEFAULT 0);INSERT INTO companies VALUES(1,'alpha',0);
    CREATE TABLE telegram_source_items(id INTEGER PRIMARY KEY,company_code TEXT,revision INTEGER,sha256 TEXT,name TEXT,mime TEXT,size INTEGER,declared_size INTEGER,status TEXT,caption TEXT,metadata TEXT);
    INSERT INTO telegram_source_items VALUES(7,'alpha',1,NULL,'','',NULL,NULL,'text','Подпись до закрытия','{}')`);
  manifest=require('../content/content-factory-source-context').createSourceContext({db}).capture('alpha');
  created=createContentPlanJobs(db).enqueue('alpha',{...input(),snapshot:{...input().snapshot,sourceLibrary:manifest}});
 }finally{db.close()}
 db=new DatabaseSync(file);try{
  const helper=require('../content/content-factory-source-context').createSourceContext({db});assert.deepEqual(helper.capture('alpha'),manifest);
  db.exec("UPDATE telegram_source_items SET caption='Правка после открытия',revision=2");assert.notEqual(helper.capture('alpha').hash,manifest.hash);
  const restored=createContentPlanJobs(db);assert.equal(restored.lookupRequest('alpha','request_01','2026-10').job.id,created.id);
  assert.deepEqual(restored.claim().snapshot.sourceLibrary,manifest);
 }finally{db.close()}
});
test('прогресс сбрасывает лимит сбоев; ручное возобновление сохраняет части только при том же контексте и компании',t=>{
 const f=fixture(t),first=f.api.enqueue('alpha',input());
 const part=i=>({executor:{kind:'test',model:'synthetic'},proposals:[{topic:'Идея '+i}]});
 for(let i=0;i<4;i++){
  const lease=f.api.claim();assert.ok(lease);f.api.savePart(lease.id,lease.token,i,part(i));f.tick(1001);
 }
 const final=f.api.claim();assert.ok(final);f.api.reject(final.id,final.token,{errorCode:'INVALID_RESULT'});
 const resumed=f.api.enqueue('alpha',input('resume_request'));
 assert.notEqual(resumed.id,first.id);const lease=f.api.claim();assert.equal(lease.parts.length,4);
 assert.equal(f.api.inspectLease(lease.id,lease.token).budgetJob,first.id);
 assert.equal(f.db.prepare('SELECT resume_from FROM content_plan_jobs WHERE id=?').get(resumed.id).resume_from,first.id);
 f.api.reject(lease.id,lease.token,{errorCode:'INVALID_RESULT'});
 f.api.enqueue('alpha',{...input('changed_request'),snapshot:{product:'Изменено'}});
 assert.deepEqual(f.api.claim().parts,[]);
 f.api.enqueue('beta',input());assert.deepEqual(f.api.claim().parts,[]);
});
test('без живого исполнителя старт недоступен; чтение завершает зависшую очередь и освобождает месяц',t=>{
 const f=fixture(t),strict=createContentPlanJobs(f.db,{...f.options,requireWorker:true});
 assert.equal(strict.canGenerate(),false);strict.pulse(true);assert.equal(strict.canGenerate(),true);
 const job=strict.enqueue('alpha',input());f.tick(90001);
 assert.equal(strict.canGenerate(),false);assert.equal(strict.get('alpha',job.id).job.status,'queued');
 assert.equal(strict.get('alpha',job.id).job.errorCode,'WORKER_INTERRUPTED');
 f.tick(86400000);assert.equal(strict.get('alpha',job.id).job.status,'failed');
 strict.pulse(true);const second=strict.enqueue('alpha',{...input('request_new'),snapshot:{product:'Другой продукт'}});
 assert.equal(second.status,'queued');strict.pulse(false);assert.equal(strict.canGenerate(),false);
});
test('сохранённая часть переживает сбой исполнителя; повтор не перезаписывает её и другой проект её не получает',t=>{
 const f=fixture(t);f.api.enqueue('alpha',input());const old=f.api.claim();
 const part={executor:{kind:'test',model:'synthetic'},proposals:[{topic:'Проверенная идея'}]};
 f.api.savePart(old.id,old.token,0,part);f.api.savePart(old.id,old.token,0,part);
 assert.throws(()=>f.api.savePart(old.id,old.token,0,{...part,proposals:[{topic:'Подмена'}]}),e=>e.details.code==='PART_CONFLICT');
 assert.throws(()=>f.api.savePart(old.id,old.token,2,part),e=>e.details.code==='PART_ORDER');
 f.tick(1001);const restored=createContentPlanJobs(f.db,f.options).claim();assert.deepEqual(restored.parts,[part]);
 assert.throws(()=>f.api.savePart(old.id,old.token,1,part),e=>e.details.code==='LEASE_LOST');
 f.api.enqueue('beta',input());const beta=f.api.claim();assert.deepEqual(beta.parts,[]);
 assert.equal('parts' in f.api.get('alpha',old.id).job,false);
});
test('двойной запрос и повтор с новым ключом не дублируют активную задачу; чужой проект изолирован',t=>{
 const f=fixture(t),a=f.api.enqueue('alpha',input());
 assert.equal(f.api.enqueue('ALPHA',input()).id,a.id);
 assert.equal(f.api.enqueue('alpha',input('request_02')).id,a.id);
 assert.notEqual(f.api.enqueue('beta',input()).id,a.id);
 assert.throws(()=>f.api.get('beta',a.id),e=>e.status===404);
 assert.throws(()=>f.api.enqueue('alpha',{...input(),snapshot:{briefRevision:2}}),e=>e.status===409);
 assert.throws(()=>f.api.enqueue('alpha',{...input('request_03'),snapshot:{briefRevision:2}}),e=>e.details.code==='GENERATION_ACTIVE');
});
test('очередь и результат сохраняются при пересоздании сервиса, snapshot неизменен',t=>{
 const f=fixture(t),i=input(),a=f.api.enqueue('alpha',i);i.snapshot.product='Подмена';
 const second=createContentPlanJobs(f.db,f.options),lease=second.claim();
 assert.equal(lease.snapshot.product,'Оформление'); assert.equal(f.api.claim(),null);
 second.complete(lease.id,lease.token,[{topic:'Идея'}]);
 assert.equal(f.api.get('alpha',a.id).job.status,'succeeded');
 assert.equal(f.api.enqueue('alpha',input()).id,a.id);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM content_plan_job_events WHERE kind=?').get('succeeded').n,1);
 assert.throws(()=>second.complete(lease.id,lease.token,[{}]),e=>e.details.code==='LEASE_LOST');
});
test('просроченный исполнитель не перезаписывает результат нового; лимит восстановлений',t=>{
 const f=fixture(t),a=f.api.enqueue('alpha',input()),old=f.api.claim();f.tick(1001);
 assert.throws(()=>f.api.complete(old.id,old.token,[{}]),e=>e.details.code==='LEASE_LOST');
 const fresh=f.api.claim();assert.equal(fresh.id,a.id);assert.notEqual(fresh.token,old.token);
 assert.throws(()=>f.api.reject(old.id,old.token,{retryable:true}),e=>e.details.code==='LEASE_LOST');
 f.tick(1001);assert.equal(f.api.claim(),null);
 assert.equal(f.api.get('alpha',a.id).job.status,'failed');
 assert.equal(f.api.get('alpha',a.id).job.errorCode,'ATTEMPTS_EXHAUSTED');
});
test('heartbeat продлевает аренду; ошибка провайдера ограничивает повторы и не сохраняет секреты',t=>{
 const f=fixture(t),a=f.api.enqueue('alpha',input()),lease=f.api.claim();
 f.tick(800);f.api.heartbeat(lease.id,lease.token);f.tick(500);
 f.api.reject(lease.id,lease.token,{retryable:true,errorCode:'PROVIDER_UNAVAILABLE'});
 assert.equal(f.api.claim(),null);f.tick(60000);const next=f.api.claim();assert.equal(next.attempt,2);
 f.api.reject(next.id,next.token,{retryable:true,errorCode:'secret_key_from_provider'});
 assert.equal(f.api.get('alpha',a.id).job.errorCode,'GENERATION_FAILED');
 assert.equal(f.api.get('alpha',a.id).job.status,'failed');
});
test('вопросы останавливают запуск; UI DTO не раскрывает snapshot или аренду; удалённая компания не выполняется',t=>{
 const f=fixture(t),a=f.api.enqueue('alpha',{...input(),questions:[{id:'product',target:'brief.product',text:'Какой продукт?',required:true}]});
 assert.equal(a.status,'needs_input');assert.equal(f.api.claim(),null);
 assert.equal('snapshot' in a,false);assert.equal('token' in a,false);
 f.api.enqueue('beta',input());f.db.exec('UPDATE companies SET is_deleted=1 WHERE id=2');assert.equal(f.api.claim(),null);
});
test('плохие входные данные не оставляют записей',t=>{
 const f=fixture(t);
 for(const patch of [{month:'2026-13'},{clientRequestId:'x'},{questions:[{}]},{snapshot:null}]) assert.throws(()=>f.api.enqueue('alpha',{...input(),...patch}),e=>e.status===400);
 assert.equal(f.db.prepare('SELECT count(*) n FROM content_plan_jobs').get().n,0);
});
test('файловая БД переживает закрытие соединения: старый исполнитель не может завершить восстановленную задачу',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cf-jobs-'));
 t.after(()=>{if(!path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep))throw Error('Unsafe cleanup');fs.rmSync(dir,{recursive:true,force:true})});
 const file=path.join(dir,'jobs.sqlite');let clock=Date.now();
 const options={now:()=>clock,leaseMs:1000};let db=new DatabaseSync(file);
 db.exec("CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,is_deleted INTEGER DEFAULT 0);INSERT INTO companies VALUES(1,'alpha',0)");
 let api=createContentPlanJobs(db,options);const job=api.enqueue('alpha',input()),old=api.claim();
 const savedPart={executor:{kind:'test',model:'synthetic'},proposals:[{topic:'Сохранённая идея'}]};
 api.savePart(old.id,old.token,0,savedPart);db.close();
 clock+=1001;db=new DatabaseSync(file);
 try{
  api=createContentPlanJobs(db,options);const next=api.claim();assert.equal(next.id,job.id);assert.equal(next.attempt,2);assert.deepEqual(next.parts,[savedPart]);
  assert.throws(()=>api.complete(old.id,old.token,[{}]),e=>e.details.code==='LEASE_LOST');
  api.complete(next.id,next.token,[{topic:'Сохранённая идея'}]);
 }finally{db.close()}
 db=new DatabaseSync(file);try{api=createContentPlanJobs(db,options);assert.equal(api.get('alpha',job.id).job.proposals[0].topic,'Сохранённая идея')}finally{db.close()}
});



test('ошибка результата через внутренний протокол повторяется ограниченно и не теряет сохранённую часть',t=>{
 const {createContentPlanDispatch}=require('./content-plan-dispatch');
 const f=fixture(t),job=f.api.enqueue('alpha',input()),dispatch=createContentPlanDispatch({jobs:f.api});
 let lease=f.api.claim();
 const part={executor:{kind:'api',model:'synthetic'},proposals:[{topic:'Уже сохранено'}]};
 f.api.savePart(lease.id,lease.token,0,part);
 dispatch.handle('error',{lease:{id:lease.id,token:lease.token},code:'INVALID_RESULT'});
 assert.equal(f.api.get('alpha',job.id).job.status,'queued');assert.equal(f.api.claim(),null);
 f.tick(60000);lease=f.api.claim();assert.deepEqual(lease.parts,[part]);
 // Повторная квитанция сохранённой части не даёт новый лимит попыток.
 f.api.savePart(lease.id,lease.token,0,part);
 dispatch.handle('error',{lease:{id:lease.id,token:lease.token},code:'INVALID_RESULT'});
 assert.equal(f.api.get('alpha',job.id).job.status,'failed');f.tick(60000);assert.equal(f.api.claim(),null);
 assert.equal(f.db.prepare('SELECT count(*) n FROM content_plan_parts WHERE job_id=?').get(job.id).n,1);
});


test('явное отсутствие конфигурации отличается от потери сигнала исполнителя',t=>{
 const f=fixture(t),job=f.api.enqueue('alpha',input());f.api.pulse(false);f.tick(90001);
 const result=f.api.get('alpha',job.id).job;
 assert.equal(result.errorCode,'PROVIDER_NOT_CONFIGURED');assert.equal(result.retryable,false);
});


test('после краткого отсутствия worker очередь восстанавливается без новой задачи и без расхода попытки',t=>{
 const f=fixture(t),job=f.api.enqueue('alpha',input());f.api.pulse(true);f.tick(90001);
 for(let i=0;i<3;i++)assert.equal(f.api.get('alpha',job.id).job.status,'queued');
 assert.equal(f.db.prepare("SELECT count(*) n FROM content_plan_job_events WHERE job_id=? AND kind='delayed'").get(job.id).n,1);
 f.api.pulse(true);const lease=f.api.claim();assert.equal(lease.id,job.id);assert.equal(lease.attempt,1);
 f.api.complete(lease.id,lease.token,[{topic:'Сохранённый результат'}]);
 assert.equal(f.api.get('alpha',job.id).job.status,'succeeded');
});


test('плановая остановка освобождает аренду без расхода попытки и сохраняет части',t=>{
 const f=fixture(t);f.api.enqueue('alpha',input());const old=f.api.claim();
 const part={executor:{kind:'test',model:'synthetic'},proposals:[{topic:'Готово'}]};
 f.api.savePart(old.id,old.token,0,part);f.api.release(old.id,old.token);
 assert.throws(()=>f.api.release(old.id,old.token),e=>e.details.code==='LEASE_LOST');
 const next=f.api.claim();assert.equal(next.attempt,1);assert.deepEqual(next.parts,[part]);assert.notEqual(next.token,old.token);
 assert.throws(()=>f.api.complete(old.id,old.token,[{}]),e=>e.details.code==='LEASE_LOST');
});
