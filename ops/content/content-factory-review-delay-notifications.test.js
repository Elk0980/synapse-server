'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{DatabaseSync}=require('node:sqlite');
const {createHughOwnerAlerts}=require('./hugh-owner-alerts'),{createContentFactoryReviewDelayNotifications}=require('./content-factory-review-delay-notifications');
const {createContentFactoryReviewDelays}=require('../crm/content-factory-review-delays');
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'review-delay-alerts-')),file=path.join(dir,'content.sqlite');let db=new DatabaseSync(file),clock=Date.parse('2026-10-02T12:00:00.000Z'),alerts,consumer,afterInsert=false,override;
  const crmDb=new DatabaseSync(':memory:');t.after(()=>{db.close();crmDb.close();fs.rmSync(dir,{recursive:true,force:true});});
  crmDb.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,timezone TEXT,is_deleted INTEGER);INSERT INTO companies VALUES(1,'palitra-love','Europe/Moscow',0);
    CREATE TABLE autoposting_posts(id INTEGER PRIMARY KEY,company_id INTEGER,content_revision INTEGER,status TEXT,archived_at TEXT,review_state TEXT,approved_revision INTEGER,platform_ids TEXT);INSERT INTO autoposting_posts VALUES(9,1,3,'draft',NULL,'rejected',NULL,'[]');
    CREATE TABLE autoposting_platform_reviews(post_id INTEGER,platform_id TEXT,state TEXT,content_revision INTEGER,PRIMARY KEY(post_id,platform_id));
    CREATE TABLE tasks(id INTEGER PRIMARY KEY,company_code TEXT,is_deleted INTEGER,status TEXT,assignee_role TEXT,assignee_name TEXT,due_date TEXT);
    INSERT INTO tasks VALUES(14,'palitra-love',0,'in_progress','marketer','Назначенный редактор','2026-10-01');
    CREATE TABLE autoposting_review_tasks(post_id INTEGER,post_revision INTEGER,content_revision INTEGER,company_id INTEGER,task_id INTEGER UNIQUE,PRIMARY KEY(post_id,post_revision));
    INSERT INTO autoposting_review_tasks VALUES(9,6,3,1,14);`);
  const collector=createContentFactoryReviewDelays({db:crmDb,now:()=>clock}),requests=[];
  function restart(){
    alerts=createHughOwnerAlerts({db,now:()=>clock});consumer=createContentFactoryReviewDelayNotifications({request:async(action,body,signal)=>{
      requests.push({action,body,signal});signal?.throwIfAborted();return override===undefined?collector.pending(body):override;
    },alerts:{add:(...args)=>{alerts.add(...args);if(afterInsert){afterInsert=false;throw Object.assign(Error('Квитанция INSERT потеряна'),{status:503});}}}});
  }restart();
  return {crmDb,collector,requests,get db(){return db;},get alerts(){return alerts;},get consumer(){return consumer;},set afterInsert(value){afterInsert=value;},set override(value){override=value;},
    set clock(value){clock=Date.parse(value);},restart(){db.close();db=new DatabaseSync(file);restart();},rows(){return db.prepare('SELECT * FROM hugh_owner_alerts ORDER BY id').all();}};
}
test('настоящий collector → existing durable OWNER queue, только служебный request и без клиентского адреса',async t=>{
  const f=fixture(t),controller=new AbortController(),result=await f.consumer.sync({signal:controller.signal});assert.deepEqual(result,{queued:1,hasMore:false,detectedAt:'2026-10-02T12:00:00.000Z'});
  assert.deepEqual(f.requests,[{action:'review-delays',body:{afterTaskId:0,limit:100},signal:controller.signal}]);const row=f.rows()[0];assert.equal(row.status,'pending');assert.equal(row.company_code,'palitra-love');
  assert.equal(row.event_key,'content-review-delay:palitra-love:9:14:2026-10-01:3');assert.match(row.text,/№9/);assert.match(row.text,/2026-10-02T12:00:00.000Z/);assert.match(row.text,/2026-10-01/);assert.match(row.text,/Назначенный редактор/);assert.match(row.text,/задачу №14/);assert.match(row.text,/факт на время проверки/);
  const job=f.alerts.pending().jobs[0];assert.equal(job.audience,'owner');assert.equal(job.chatId,null);assert.deepEqual(job.attachments,[]);assert.equal(f.rows()[0].status,'sending');
  f.alerts.acknowledge(job.id,{ok:true,externalMessageIds:['synthetic-owner-receipt']});assert.equal(f.rows()[0].status,'sent');assert.equal(result.queued,1,'queued — число предложенных фактов, не доставленных сообщений');
});
test('потерянная квитанция после INSERT и реальный restart не дублируют/не перезаписывают первый факт',async t=>{
  const f=fixture(t);f.afterInsert=true;await assert.rejects(f.consumer.sync(),{status:503});assert.equal(f.rows().length,1);const first=f.rows()[0];
  f.clock='2026-10-03T12:00:00.000Z';f.crmDb.prepare("UPDATE tasks SET assignee_name='Другой ответственный' WHERE id=14").run();f.restart();await f.consumer.sync();
  assert.equal(f.rows().length,1);assert.deepEqual(f.rows()[0],first);assert.match(f.rows()[0].text,/Назначенный редактор/);assert.ok(!f.rows()[0].text.includes('Другой ответственный'));
  f.crmDb.prepare("UPDATE tasks SET status='done' WHERE id=14").run();assert.equal((await f.consumer.sync()).queued,0);const job=f.alerts.pending().jobs[0];assert.match(job.text,/2026-10-02T12:00:00.000Z/);assert.match(job.text,/текущее состояние уточните/);
});
test('изменённый срок/new deadline и contentRevision создают новые факты только при реальной просрочке',async t=>{
  const f=fixture(t);await f.consumer.sync();f.crmDb.prepare("UPDATE tasks SET due_date='2026-10-04' WHERE id=14").run();assert.equal((await f.consumer.sync()).queued,0);assert.equal(f.rows().length,1);
  f.clock='2026-10-05T12:00:00.000Z';await f.consumer.sync();assert.equal(f.rows().length,2);assert.notEqual(f.rows()[1].event_key,f.rows()[0].event_key);
  f.crmDb.prepare('UPDATE autoposting_posts SET content_revision=4 WHERE id=9').run();assert.equal((await f.consumer.sync()).queued,0);
  f.crmDb.prepare('UPDATE autoposting_review_tasks SET content_revision=4 WHERE task_id=14').run();await f.consumer.sync();assert.equal(f.rows().length,3);assert.match(f.rows()[2].event_key,/:4$/);
});
test('pending/sent/uncertain не смешиваются; неизвестная отправка после restart не повторяется вслепую',async t=>{
  const f=fixture(t);await f.consumer.sync();assert.equal(f.rows()[0].status,'pending');const first=f.alerts.pending().jobs[0];assert.ok(first);
  f.clock='2026-10-02T12:06:00.000Z';f.restart();await f.consumer.sync();assert.deepEqual(f.alerts.pending().jobs,[]);assert.equal(f.rows().length,1);assert.equal(f.rows()[0].status,'uncertain');
  f.alerts.acknowledge(first.id,{ok:true,externalMessageIds:['late-synthetic-receipt']});assert.equal(f.rows()[0].status,'sent');await f.consumer.sync();assert.deepEqual(f.alerts.pending().jobs,[]);assert.equal(f.rows().length,1);
});
test('весь DTO проверяется до записи: scope/key/дата/timezone/status/адрес/private поля и cap',async t=>{
  const f=fixture(t),good=f.collector.pending(),item=good.items[0];
  for(const patch of [{eventKey:'forged'},{companyCode:'OTHER'},{taskId:0},{contentRevision:'3'},{taskStatus:'done'},{assigneeName:'Редактор\nподмена'},{timezoneSource:'guess'},
    {assigneeRole:'customer'},{dueDate:'2026-02-30'},{dueDate:'2026-10-03'},{timezone:'Unknown/Zone'},{asOfDate:'2026-10-04'},{detectedAt:'2026-10-03T12:00:00.000Z'},
    {chatId:'client-address'},{description:'private content'},{annotations:[]}]){
    f.override={...good,items:[item,{...item,...patch}]};await assert.rejects(f.consumer.sync(),{status:502});assert.equal(f.rows().length,0);
  }
  for(const summary of [null,{...good,privateText:'no'},{...good,hasMore:'false'},{...good,detectedAt:'invalid'},{...good,items:Array(101).fill(item)},
    {...good,items:[item,item]}]){f.override=summary;await assert.rejects(f.consumer.sync(),{status:502});assert.equal(f.rows().length,0);}
});
test('отказ request/aborted signal не пишет очередь; пустая сводка не выдумывает задачу/срок',async t=>{
  const f=fixture(t),controller=new AbortController();controller.abort();await assert.rejects(f.consumer.sync({signal:controller.signal}),{name:'AbortError'});assert.equal(f.requests.length,0);assert.equal(f.rows().length,0);
  const denied=createContentFactoryReviewDelayNotifications({request:async()=>{throw Object.assign(Error('CRM unavailable'),{status:503});},alerts:f.alerts});await assert.rejects(denied.sync(),{status:503});assert.equal(f.rows().length,0);
  f.crmDb.prepare("UPDATE tasks SET due_date='' WHERE id=14").run();assert.equal((await f.consumer.sync()).queued,0);assert.equal(f.rows().length,0);
});
test('пустое имя не отменяет реальный срок: текст не назначает человека по assigneeRole; UTC fallback явен',async t=>{
  const f=fixture(t);f.crmDb.prepare("UPDATE tasks SET assignee_name='',assignee_role='synapse' WHERE id=14").run();f.crmDb.prepare("UPDATE companies SET timezone='' WHERE id=1").run();
  await f.consumer.sync();assert.match(f.rows()[0].text,/ответственный не назначен/);assert.match(f.rows()[0].text,/UTC — часовой пояс компании не задан/);assert.ok(!f.rows()[0].text.includes('ответственный synapse'));
});
function pages(f,total){
  const sample=f.collector.pending(),template=sample.items[0];
  return afterTaskId=>{const ids=Array.from({length:Math.min(100,total-afterTaskId)},(_,i)=>afterTaskId+i+1),hasMore=afterTaskId+ids.length<total;
    return {detectedAt:sample.detectedAt,hasMore,nextAfterTaskId:hasMore?ids.at(-1):0,items:ids.map(taskId=>({...template,taskId,eventKey:`content-review-delay:palitra-love:9:${taskId}:2026-10-01:3`}))};};
}
test('paging >100: один sync до10 страниц, следующий продолжает tail; конец/reset/restart дедуплицированы',async t=>{
  const f=fixture(t),page=pages(f,1005),calls=[];
  let consumer=createContentFactoryReviewDelayNotifications({request:async(action,body)=>{assert.equal(action,'review-delays');assert.equal(body.limit,100);calls.push(body.afterTaskId);return page(body.afterTaskId);},alerts:f.alerts});
  const first=await consumer.sync();assert.equal(first.queued,1000);assert.equal(first.hasMore,true);assert.equal(f.rows().length,1000);assert.deepEqual(calls,[0,100,200,300,400,500,600,700,800,900]);
  const next=await consumer.sync();assert.equal(next.queued,5);assert.equal(next.hasMore,false);assert.equal(calls.at(-1),1000);assert.equal(f.rows().length,1005);
  await consumer.sync();assert.equal(calls.at(-10),0);assert.equal(f.rows().length,1005);
  f.restart();consumer=createContentFactoryReviewDelayNotifications({request:async(action,body)=>page(body.afterTaskId),alerts:f.alerts});await consumer.sync();assert.equal(f.rows().length,1005);
});
test('ошибка записи/invalid page/abort сохраняют cursor страницы; retry не дублирует частичный INSERT',async t=>{
  const f=fixture(t),page=pages(f,205),calls=[];let fault='write',controller;
  const consumer=createContentFactoryReviewDelayNotifications({request:async(action,body)=>{calls.push(body.afterTaskId);if(body.afterTaskId===100&&fault==='invalid')return {...page(100),nextAfterTaskId:99};return page(body.afterTaskId);},
    alerts:{add:(code,key,text)=>{f.alerts.add(code,key,text);if(key.split(':')[3]==='150'&&fault==='write'){fault='invalid';throw Object.assign(Error('Запись без квитанции'),{status:503});}if(key.split(':')[3]==='160'&&fault==='abort')controller.abort();}}});
  await assert.rejects(consumer.sync(),{status:503});assert.deepEqual(calls,[0,100]);assert.equal(f.rows().length,150);
  await assert.rejects(consumer.sync(),{status:502});assert.equal(calls.at(-1),100);assert.equal(f.rows().length,150);
  fault='abort';controller=new AbortController();await assert.rejects(consumer.sync({signal:controller.signal}),{name:'AbortError'});assert.equal(calls.at(-1),100);assert.equal(f.rows().length,160);
  fault=null;await consumer.sync();assert.equal(calls.at(-2),100);assert.equal(calls.at(-1),200);assert.equal(f.rows().length,205);assert.equal((await consumer.sync()).hasMore,false);assert.equal(f.rows().length,205);
});
