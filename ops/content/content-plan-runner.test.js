'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createContentPlanJobs}=require('../crm/content-plan-jobs');
const {createContentPlanDispatch}=require('../crm/content-plan-dispatch');
const {createContentPlanRunner}=require('./content-plan-runner');
test('runner.sync изолирует отказ overdue read, подтверждает generation alerts и прерывает read при stop',async()=>{
 const requests=[],received=[],pending={companyCode:'alpha',eventKey:'generation-event',text:'План готов',id:1};let failures=0,failDelay=true;
 const fetchImpl=async(url,options)=>{
   const action=url.split('/').pop();requests.push({action,headers:options.headers,body:JSON.parse(options.body)});
   if(action==='review-delays'){
     assert.match(url,/\/internal\/content-factory\/review-delays$/);assert.equal('x-synapse-crm-identity' in options.headers,false);
     if(failDelay)return {ok:false,status:503};
     return {ok:true,json:async()=>({detectedAt:'2026-10-02T12:00:00.000Z',items:[],hasMore:false,nextAfterTaskId:0})};
   }
   return {ok:true,json:async()=>action==='alerts'?{alerts:[pending]}:{}};
 };
 const runner=createContentPlanRunner({crmUrl:'https://synthetic.invalid',crmApiKey:'synthetic',fallback:null,alerts:{add:(...args)=>received.push(args)},reviewDelayNotifications:true,onReviewDelayError:()=>failures++,fetchImpl});
 assert.equal(await runner.sync(),true);assert.equal(failures,1);assert.deepEqual(received,[['alpha','generation-event','План готов']]);assert.deepEqual(requests.map(r=>r.action),['pulse','review-delays','alerts','ack-alert']);
 failDelay=false;await runner.sync();assert.equal(failures,1);await runner.stop();assert.equal(await runner.sync(),false);
 let entered;const ready=new Promise(r=>entered=r);
 const stopping=createContentPlanRunner({crmUrl:'https://synthetic.invalid',crmApiKey:'synthetic',fallback:null,alerts:{add(){throw Error('No writes');}},reviewDelayNotifications:true,fetchImpl:async(url,options)=>{
   if(url.endsWith('/pulse'))return {ok:true,json:async()=>({})};
   assert.ok(url.endsWith('/review-delays'));entered();return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
 }});
 const sync=stopping.sync(),rejected=assert.rejects(sync,{name:'AbortError'});await ready;await stopping.stop();await rejected;
});
function fixture(t,{loseResult=false}={}){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec("CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,is_deleted INTEGER DEFAULT 0);INSERT INTO companies VALUES(1,'alpha',0)");
 let now=Date.now();const jobs=createContentPlanJobs(db,{now:()=>now,leaseMs:1000});
 const job=jobs.enqueue('alpha',{clientRequestId:'bridge-test',month:'2026-10',snapshot:{brief:{assets:[]},monthInputs:{platforms:['telegram'],perDay:{telegram:2},excludedDays:Array.from({length:30},(_,i)=>'2026-10-'+String(i+2).padStart(2,'0'))}}});
 const dispatch=createContentPlanDispatch({jobs}),calls=[],requests=[];
 let lost=false;
 const fetchImpl=async(url,options)=>{
  assert.equal(options.headers['x-api-key'],'synthetic-key');
  const action=url.split('/').pop(),body=JSON.parse(options.body);requests.push(action);
  try{const response=dispatch.handle(action,body);
   if(loseResult&&action==='result'&&!lost){lost=true;throw Error('Lost response');}
   return {ok:true,status:200,json:async()=>response};
  }catch(error){if(!error.status)throw error;return {ok:false,status:error.status};}
 };
 const fallback={reply:async(payload)=>{
  const data=JSON.parse(payload),context=JSON.parse(data.messages[0].content),slot=context.slots[0];
  calls.push(context.previousTopics.length);
  return {model:'synthetic-only',text:JSON.stringify({proposals:[{...slot,format:'post',role:'reach',topic:'Тема '+context.previousTopics.length,text:'Проверка'}]})};
 }};
 return {db,jobs,job,dispatch,calls,requests,tick:()=>now+=1001,
  runner:()=>createContentPlanRunner({crmUrl:'https://synthetic.invalid',crmApiKey:'synthetic-key',fallback,fetchImpl})};
}
test('полный протокол очередь → runtime → проверенные части → готовые предложения',async t=>{
 const f=fixture(t),runner=f.runner();await runner.runOne();await runner.stop();
 const result=f.jobs.get('alpha',f.job.id).job;
 assert.equal(result.status,'succeeded');assert.equal(result.proposals.length,2);assert.deepEqual(f.calls,[0,1]);
 assert.equal(result.executor.model,'synthetic-only');assert.deepEqual(f.requests,['claim','result','result']);
});
test('потеря ответа CRM после сохранения: восстановление не платит повторно за первую часть',async t=>{
 const f=fixture(t,{loseResult:true}),first=f.runner();await first.runOne();await first.stop();
 assert.equal(f.jobs.get('alpha',f.job.id).job.status,'running');f.tick();
 const second=f.runner();await second.runOne();await second.stop();
 assert.deepEqual(f.calls,[0,1]);assert.equal(f.jobs.get('alpha',f.job.id).job.status,'succeeded');
});
test('протокол отвергает чужую аренду и не доверяет переданным вводным',t=>{
 const f=fixture(t),task=f.dispatch.handle('claim').task;
 assert.throws(()=>f.dispatch.handle('next',{lease:{...task.lease,token:'wrong'}}),e=>e.details.code==='LEASE_LOST');
 const again=f.dispatch.handle('next',{lease:task.lease,snapshot:{product:'Подмена'}});
 assert.equal(JSON.stringify(again.payload).includes('Подмена'),false);
 assert.throws(()=>f.dispatch.handle('result',{lease:task.lease,partIndex:0,model:'synthetic',text:'{"proposals":[]}'}),e=>e.status===400&&e.details.code==='INVALID_RESULT');
 assert.equal(f.db.prepare('SELECT count(*) n FROM content_plan_parts').get().n,0);
});
test('событие ошибки передаётся в существующую очередь владельца без дубля при потере квитанции',t=>{
 const f=fixture(t),task=f.dispatch.handle('claim').task;
 f.dispatch.handle('error',{lease:task.lease,code:'BUDGET_EXCEEDED'});
 const owner=require('./hugh-owner-alerts').createHughOwnerAlerts({db:f.db});
 const event=f.dispatch.handle('alerts').alerts[0];assert.match(event.text,/остановлена/);
 owner.add(event.companyCode,event.eventKey,event.text);
 // CRM acknowledgement lost: the same durable event is read and inserted again.
 const again=f.dispatch.handle('alerts').alerts[0];owner.add(again.companyCode,again.eventKey,again.text);
 f.dispatch.handle('ack-alert',{id:again.id});
 assert.equal(owner.list('alpha').length,1);assert.equal(owner.list('alpha')[0].status,'pending');
 assert.deepEqual(f.dispatch.handle('alerts').alerts,[]);
});
test('уведомления синхронизируются пока модель готовит план; второй sync не дублируется',async()=>{
 let release,started,alertReads=0;const ready=new Promise(r=>started=r),received=[];
 const runner=createContentPlanRunner({crmUrl:'https://synthetic.invalid',crmApiKey:'synthetic',alerts:{add:(...row)=>received.push(row)},
  fallback:{reply:async()=>{started();await new Promise(r=>release=r);return {text:'{}',model:'synthetic'}}},
  fetchImpl:async url=>{
   const action=url.split('/').pop();
   let data={ok:true};
   if(action==='claim')data={task:{lease:{id:'test',token:'token'},partIndex:0,payload:{}}};
   if(action==='alerts'){alertReads++;data={alerts:[{id:'event',companyCode:'alpha',eventKey:'key',text:'Ошибка другой задачи'}]};}
   if(action==='result')data={done:true};
   return {ok:true,json:async()=>data};
  }});
 const running=runner.runOne();await ready;
 const sync=runner.sync();assert.equal(await runner.sync(),false);await sync;
 assert.equal(alertReads,1);assert.equal(received.length,1);
 release();await running;await runner.stop();assert.equal(await runner.sync(),false);
});
test('нет настроенных провайдеров — окончательное PROVIDER_NOT_CONFIGURED без вызова',async()=>{
 let called=false,code;
 const runner=createContentPlanRunner({crmUrl:'https://synthetic.invalid',crmApiKey:'synthetic',fallback:{providers:[],reply:async()=>{called=true}},
  fetchImpl:async(url,options)=>({ok:true,json:async()=>{
   if(url.endsWith('/claim'))return {task:{lease:{id:'test',token:'token'},payload:{},partIndex:0}};
   if(url.endsWith('/error'))code=JSON.parse(options.body).code;
   return {ok:true};
  }})});
 await runner.runOne();await runner.stop();assert.equal(called,false);assert.equal(code,'PROVIDER_NOT_CONFIGURED');
});


test('политика лимитов не настроена: не исчерпан бюджет, вызовов нет, готовность не объявляется',async()=>{
 let called=false,code,pulse;
 const runner=createContentPlanRunner({crmUrl:'https://synthetic.invalid',crmApiKey:'synthetic',
  fallback:{providers:[{name:'synthetic'}],budget:{planReady:()=>false},reply:async()=>{called=true}},
  fetchImpl:async(url,options)=>({ok:true,json:async()=>{
   if(url.endsWith('/claim'))return {task:{lease:{id:'test',token:'token'},budgetScope:{company:'alpha',job:'test'},payload:{},partIndex:0}};
   if(url.endsWith('/error'))code=JSON.parse(options.body).code;
   if(url.endsWith('/pulse'))pulse=JSON.parse(options.body).configured;
   return {ok:true};
  }})});
 await runner.sync();await runner.runOne();await runner.stop();
 assert.equal(called,false);assert.equal(pulse,false);assert.equal(code,'PROVIDER_NOT_CONFIGURED');
});


test('stop дожидается прерывания модели и освобождает только свою аренду',async()=>{
 let started,aborted=false;const ready=new Promise(r=>started=r),actions=[];
 const runner=createContentPlanRunner({crmUrl:'https://synthetic.invalid',crmApiKey:'synthetic',
  fallback:{reply:async(payload,{signal})=>{started();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('Stopped'))},{once:true}));}},
  fetchImpl:async(url,options)=>{
   const action=url.split('/').pop();actions.push(action);
   if(action==='release'){assert.equal(aborted,true);assert.deepEqual(JSON.parse(options.body).lease,{id:'job1',token:'lease1'});assert.equal(options.signal.aborted,false);}
   return {ok:true,json:async()=>action==='claim'?{task:{lease:{id:'job1',token:'lease1'},payload:{},partIndex:0}}:{ok:true}};
  }});
 const running=runner.runOne();await ready;await runner.stop();await running;
 assert.deepEqual(actions,['claim','release']);assert.equal(await runner.runOne(),false);
});
