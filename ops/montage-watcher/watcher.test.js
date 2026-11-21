'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {createStore}=require('./store'),{createWatcher,snapshot}=require('./watcher');
const {parseDecision,createRuntimeClassifier,createBudgetedClassifier}=require('./classifier');
const {safeLogger,configure}=require('./main');
const CLOCK=Date.parse('2026-11-21T10:00:00Z');
const request=(over={})=>({companyCode:'alpha',id:1,reelId:21,status:'accepted',createdAt:new Date(CLOCK).toISOString(),kind:'message',text:'SAMPLE вопрос',title:'SAMPLE ролик',reply:'',...over});
const edit=(over={})=>({companyCode:'alpha',id:2,reelId:21,status:'pending',createdAt:new Date(CLOCK).toISOString(),kind:'edl',baseVersion:1,...over});
function fixture(t,{requests=[],edits=[],classify,executor,reply,task}={}){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());let clock=CLOCK;
  const calls={model:[],dispatch:[],reply:[],tasks:[],logs:[]},tasks=new Map();
  const crm={requests:async()=>({requests}),queue:async()=>({edits}),reply:async(item,body)=>{
    calls.reply.push({item,body});if(reply)return reply(item,body);item.status=body.status;item.reply=body.reply;return body;
  },task:async(body)=>{calls.tasks.push(body);if(task)return task(body);if(!tasks.has(body.sourceRef))tasks.set(body.sourceRef,{id:100+tasks.size});return tasks.get(body.sourceRef);}};
  const store=createStore(db,{now:()=>clock});
  const options={store,crm,now:()=>clock,log:e=>calls.logs.push(e),classify:async item=>{calls.model.push(item);return classify?classify(item):{action:'reply',status:'ready',reply:'SAMPLE ответ'};},
    executor:executor===null?null:async(item,meta)=>{calls.dispatch.push({item,meta});return executor?executor(item,meta):{accepted:true,companyCode:item.companyCode,id:item.id,type:item.type};}};
  return {db,store,crm,calls,requests,edits,tasks,options,watcher:createWatcher(options),advance:ms=>clock+=ms};
}
test('пустая очередь: оба GET, ноль модели/dispatch/reply/tasks',async t=>{
  const f=fixture(t);await f.watcher.tick();assert.equal(f.calls.model.length,0);assert.equal(f.calls.tasks.length,0);assert.deepEqual(f.calls.logs,[{code:'EMPTY',count:0}]);
});
test('простой ответ один раз; рестарт не запускает модель заново',async t=>{
  const f=fixture(t,{requests:[request()]});await f.watcher.tick();await f.watcher.tick();
  await createWatcher(f.options).tick();assert.equal(f.calls.model.length,1);assert.equal(f.calls.reply.length,1);assert.equal(f.calls.tasks.length,0);
});
test('redo и EDL — один dispatch без модели; claim не имитируется, 10 минут без подхвата → Claude',async t=>{
  const f=fixture(t,{requests:[request({kind:'redo',editId:2})],edits:[edit()]});
  await f.watcher.tick();await f.watcher.tick();assert.equal(f.calls.model.length,0);assert.equal(f.calls.dispatch.length,1);
  assert.equal(f.edits[0].status,'pending');f.advance(600000);await f.watcher.tick();await f.watcher.tick();
  assert.equal(f.tasks.size,1);assert.match(f.calls.tasks[0].description,/NOT_PICKED_UP/);assert.match(f.calls.tasks[0].description,/reel\/21/);
});
test('старые pending, in_progress и waiting_owner: эскалация только невзятого, без модели',async t=>{
  const old=new Date(CLOCK-600000).toISOString();
  const f=fixture(t,{requests:[request({createdAt:old}),request({id:2,status:'in_progress',createdAt:old}),request({id:3,status:'waiting_owner',createdAt:old})]});
  await f.watcher.tick();assert.equal(f.calls.model.length,0);assert.equal(f.tasks.size,1);
});
test('нет монтажёра или сбой модели → постоянная задача, без ложного статуса в работе',async t=>{
  const f=fixture(t,{edits:[edit()],executor:null});await f.watcher.tick();await createWatcher(f.options).tick();
  assert.equal(f.tasks.size,1);assert.equal(f.calls.dispatch.length,0);assert.match(f.calls.tasks[0].description,/EXECUTOR_UNAVAILABLE/);
  const g=fixture(t,{requests:[request()],classify:()=>{throw Error('SAMPLE секретная ошибка');}});await g.watcher.tick();assert.equal(g.tasks.size,1);
});
test('потеря ответа reply: не отправляется повторно, создаётся задача с безопасным описанием',async t=>{
  const f=fixture(t,{requests:[request()],reply:()=>{throw Error('SAMPLE KEY text');}});
  await f.watcher.tick();await createWatcher(f.options).tick();assert.equal(f.calls.reply.length,1);assert.equal(f.tasks.size,1);
  assert.ok(!JSON.stringify(f.calls.tasks).includes('SAMPLE KEY'));assert.match(f.calls.tasks[0].description,/REPLY_UNCONFIRMED/);
});
test('неизвестный dispatch после падения не запускается заново',async t=>{
  const f=fixture(t,{edits:[edit()]});const item={...edit(),type:'edit'};
  f.store.claim('alpha:edit:2',item);f.store.save('alpha:edit:2','dispatching');await f.watcher.tick();
  assert.equal(f.calls.dispatch.length,0);assert.equal(f.tasks.size,1);assert.match(f.calls.tasks[0].description,/DISPATCH_UNCONFIRMED/);
});
test('потеря ответа создания задачи: один sourceRef, следующий тик подтверждает прежний номер',async t=>{
  let calls=0;const refs=[];
  const f=fixture(t,{edits:[edit()],executor:null,task:body=>{refs.push(body.sourceRef);if(++calls===1)throw Error('lost');return {id:88};}});
  await f.watcher.tick();await f.watcher.tick();await f.watcher.tick();assert.equal(calls,2);assert.equal(new Set(refs).size,1);
});
test('две компании с тем же id изолированы; чужое подтверждение исполнителя отклоняется',async t=>{
  const f=fixture(t,{edits:[edit(),edit({companyCode:'beta'})],executor:item=>({accepted:true,companyCode:'evil',id:item.id,type:item.type})});
  await f.watcher.tick();assert.equal(f.calls.dispatch.length,2);assert.equal(f.tasks.size,2);assert.deepEqual(new Set(f.calls.tasks.map(t=>t.companyCode)),new Set(['alpha','beta']));
});
test('единственный владелец БД и отсутствие параллельных тиков',async t=>{
  let done;const f=fixture(t,{requests:[request()],classify:()=>new Promise(resolve=>done=resolve)});
  const a=f.watcher.tick();await new Promise(r=>setImmediate(r));assert.equal(f.watcher.tick(),a);
  await createWatcher({...f.options,store:createStore(f.db,{now:()=>CLOCK})}).tick();assert.equal(f.calls.model.length,1);
  done({action:'reply',status:'ready',reply:'Ответ'});await a;
});
test('очередь больше лимита не голодает за уже переданными записями',async t=>{
  const f=fixture(t,{edits:Array.from({length:21},(_,i)=>edit({id:i+1}))});
  await f.watcher.tick();assert.equal(f.calls.dispatch.length,20);await f.watcher.tick();assert.equal(f.calls.dispatch.length,21);
});
test('сбой GET → задача и ноль модели; повреждённая компания/связка не обрабатывается',async t=>{
  const f=fixture(t);f.crm.requests=async()=>{throw Error('SECRET_URL');};await f.watcher.tick();assert.equal(f.tasks.size,1);assert.equal(f.calls.model.length,0);
  assert.throws(()=>snapshot({requests:[request({companyCode:'../beta'})]},{edits:[]}),/INVALID_QUEUE/);
  assert.throws(()=>snapshot({requests:[request({editId:2,reelId:99})]},{edits:[edit()]}),/INVALID_QUEUE/);
});

test('после восстановления следующая авария получает новый постоянный ключ, повторы и рестарт не дублируют',async t=>{
  const f=fixture(t);let failed=true;
  f.crm.requests=async()=>{if(failed)throw Error('SAMPLE');return {requests:[]};};
  await f.watcher.tick();await f.watcher.tick();assert.equal(f.tasks.size,1);
  failed=false;await f.watcher.tick();
  const restarted=createWatcher({...f.options,store:createStore(f.db,{now:()=>CLOCK})});
  failed=true;await restarted.tick();await restarted.tick();assert.equal(f.tasks.size,2);
  assert.deepEqual([...f.tasks.keys()],['montage-watcher:v1:synapse-business:system:1','montage-watcher:v1:synapse-business:system:2']);
  assert.ok(f.store.row('synapse-business:system:1').task_id,'прежняя квитанция сохранена');
});

test('миграция прежней одноразовой тревоги: история сохраняется, восстановление открывает следующий эпизод',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());let store=createStore(db,{now:()=>CLOCK});
  store.claim('synapse-business:system:1',{companyCode:'synapse-business',type:'system',id:1,reelId:null});store.save('synapse-business:system:1','escalated',{taskId:71});
  db.exec('DROP TABLE montage_watcher_queue_incident');
  store=createStore(db,{now:()=>CLOCK});assert.equal(store.queueIncident(),1);store.queueRecovered();assert.equal(store.queueIncident(),2);
  assert.equal(store.row('synapse-business:system:1').task_id,71);
});

test('non-message просьбы передаются или эскалируются без модели, прежние обработанные записи не запускаются заново',async t=>{
  const requests=['reschedule','replace_text','remove_from_plan','publish','redo'].map((kind,i)=>request({id:i+1,kind}));
  const f=fixture(t,{requests,executor:null});await f.watcher.tick();await createWatcher(f.options).tick();
  assert.equal(f.calls.model.length,0);assert.equal(f.tasks.size,5);
});
test('журнал: только разрешённый код/число/время; никакой переписки, ключей и ошибок',()=>{
  const lines=[],log=safeLogger(line=>lines.push(line));log({code:'REPLIED',count:1,text:'SECRET',key:'TOKEN'});log({code:'SECRET',count:2});
  assert.equal(lines.length,1);assert.deepEqual(Object.keys(JSON.parse(lines[0])),['at','code','count']);assert.ok(!lines[0].includes('SECRET'));
  assert.throws(()=>configure({CRM_API_KEY:'secret',MONTAGE_RUNTIMES_JSON:'secret'}));
});

test('SQLite-журнал без переписки, health только после успешного poll; остановка дожидается запроса',async t=>{
  const f=fixture(t,{requests:[request({text:'PRIVATE_REQUEST_CANARY'})],classify:()=>({action:'reply',status:'ready',reply:'PRIVATE_REPLY_CANARY'})});
  const {isHealthy}=require('./health');assert.equal(isHealthy(f.db,CLOCK),false);await f.watcher.tick();assert.equal(isHealthy(f.db,CLOCK),true);assert.equal(isHealthy(f.db,CLOCK+360001),false);
  const rows=JSON.stringify(f.db.prepare('SELECT * FROM montage_watcher_work').all());assert.ok(!rows.includes('PRIVATE_REQUEST_CANARY'));assert.ok(!rows.includes('PRIVATE_REPLY_CANARY'));
  let done;const g=fixture(t,{requests:[request()],classify:()=>new Promise(resolve=>done=resolve)});const tick=g.watcher.tick();await new Promise(r=>setImmediate(r));
  let stopped=false;const stop=g.watcher.stop().then(()=>{stopped=true;});await new Promise(r=>setImmediate(r));assert.equal(stopped,false);
  done({action:'reply',status:'ready',reply:'Ответ'});await tick;await stop;assert.equal(stopped,true);
});
test('строгий ответ модели; самая дешёвая известная цена, отсутствие модели при пустой очереди',async()=>{
  assert.throws(()=>parseDecision('{"action":"publish","status":"published","reply":"готово"}'));
  const calls=[],ready={authenticated:true,connected:true,replyEnabled:true,model:'sample-model'};
  const runtime=(name,p)=>({name,price:{promptMicroUsdPer1k:p,completionMicroUsdPer1k:p},status:async()=>ready,reply:async payload=>{calls.push({name,payload});return {model:ready.model,text:'{"action":"reply","status":"ready","reply":"SAMPLE ответ"}'};}});
  const classify=createRuntimeClassifier([runtime('expensive',10),runtime('cheap',1)]);await classify(request());assert.equal(calls[0].name,'cheap');
  assert.equal(calls[0].payload.jobId,'montage:alpha:request:1');assert.ok(!JSON.stringify(calls[0].payload).includes('api-key'));
  await assert.rejects(createRuntimeClassifier([])(request()),/NO_MODEL/);
  await assert.rejects(createRuntimeClassifier([runtime('known',1),{...runtime('unknown',2),price:null}])(request()),/UNKNOWN_MODEL_PRICE/);
});
test('бюджетный адаптер переиспользует fallback и исключает дорогую модель',async()=>{
  let options;const fallback={providers:[{name:'a',model:'model-a'},{name:'b',model:'model-b'}],available:()=>fallback.providers,
    budget:{priceFor:name=>({promptMicroUsdPer1k:name==='a'?10:1,completionMicroUsdPer1k:1})},
    reply:async(body,o)=>{options=o;return {provider:'b',model:'model-b',text:'{"action":"reply","status":"ready","reply":"Ответ"}'};}};
  await createBudgetedClassifier(fallback)(request());assert.deepEqual(options.excludeProviders,['a']);assert.equal(options.maxAttempts,1);
});
