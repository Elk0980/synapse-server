'use strict';
// Только локальные синтетические сервисы; настоящий runner и fallback, без внешнего API.
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {DatabaseSync}=require('node:sqlite');
const {createContentPlanJobs}=require('../crm/content-plan-jobs');
const {createContentPlanDispatch}=require('../crm/content-plan-dispatch');
const {createContentPlanRunner}=require('./content-plan-runner');
const {createHughFallback}=require('./hugh-fallback');
async function fixture(t,maxRequests){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec("CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,is_deleted INTEGER DEFAULT 0);INSERT INTO companies VALUES(1,'alpha',0)");
 const jobs=createContentPlanJobs(db),dispatch=createContentPlanDispatch({jobs});let calls=0;
 const snapshot={brief:{assets:[]},monthInputs:{platforms:['telegram'],perDay:{telegram:2},excludedDays:Array.from({length:30},(_,i)=>'2026-10-'+String(i+2).padStart(2,'0'))}};
 const enqueue=key=>jobs.enqueue('alpha',{clientRequestId:key,month:'2026-10',snapshot});
 const server=http.createServer(async(req,res)=>{
  try{
   let raw='';for await(const chunk of req)raw+=chunk;
   const body=JSON.parse(raw);let result;
   if(req.url==='/v1/chat/completions'){
    assert.equal(req.headers.authorization,'Bearer synthetic-key');calls++;
    const context=JSON.parse(body.messages[1].content),slot=context.slots[0];
    result={model:'synthetic-http-model',usage:{prompt_tokens:10,completion_tokens:20},choices:[{message:{content:JSON.stringify({proposals:[{...slot,format:'post',role:'reach',topic:'Идея '+context.previousTopics.length,text:'Тестовый материал'}]})}}]};
   }else{
    assert.equal(req.headers['x-api-key'],'synthetic-crm-key');
    result=dispatch.handle(req.url.split('/').pop(),body);
   }
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
  }catch(error){res.writeHead(error.status||500);res.end('{}');}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));
 const origin='http://127.0.0.1:'+server.address().port;
 const env={HUGH_FALLBACK_PROVIDERS:'synthetic',HUGH_FALLBACK_SYNTHETIC_URL:'https://synthetic.invalid/v1',
 HUGH_FALLBACK_SYNTHETIC_KEY:'synthetic-key',HUGH_FALLBACK_SYNTHETIC_MODEL:'synthetic-model',
 HUGH_FALLBACK_SYNTHETIC_USD_PER_1K_PROMPT:'0.001',HUGH_FALLBACK_SYNTHETIC_USD_PER_1K_COMPLETION:'0.001',
 HUGH_FALLBACK_BUDGET_USD:'100',HUGH_FALLBACK_BUDGET_MAX_REQUESTS:'100',
 CONTENT_PLAN_JOB_BUDGET_USD:'10',CONTENT_PLAN_JOB_MAX_REQUESTS:String(maxRequests),
 CONTENT_PLAN_COMPANY_BUDGET_USD:'20',CONTENT_PLAN_COMPANY_MAX_REQUESTS:'10',
 CONTENT_PLAN_CHAT_RESERVE_USD:'10',CONTENT_PLAN_CHAT_RESERVE_REQUESTS:'10'};
 const fallback=createHughFallback({db,env,fetchImpl:(url,options)=>{
  assert.equal(url,'https://synthetic.invalid/v1/chat/completions');return fetch(origin+'/v1/chat/completions',options);
 }});
 const makeRunner=()=>createContentPlanRunner({crmUrl:origin,crmApiKey:'synthetic-crm-key',fallback});
 return {jobs,enqueue,fallback,makeRunner,calls:()=>calls};
}
test('настоящие HTTP очередь/runner/fallback: две части, фактическая модель и общий учёт расходов',async t=>{
 const f=await fixture(t,3),job=f.enqueue('http-budget-success'),runner=f.makeRunner();
 try{await runner.sync();await runner.runOne();}finally{await runner.stop();}
 const result=f.jobs.get('alpha',job.id).job;
 assert.equal(result.status,'succeeded');assert.equal(result.proposals.length,2);assert.equal(result.executor.model,'synthetic-http-model');
 assert.equal(f.calls(),2);assert.equal(f.fallback.budget.totals().requests,2);
 assert.equal(f.fallback.budget.planTotals('alpha',job.id,null).requests,2);
});
test('HTTP лимит останавливает вторую часть; новая задача и новый runner не обнуляют расходы',async t=>{
 const f=await fixture(t,1),first=f.enqueue('http-budget-limited');let runner=f.makeRunner();
 try{await runner.runOne();}finally{await runner.stop();}
 assert.equal(f.calls(),1);assert.equal(f.jobs.get('alpha',first.id).job.errorCode,'BUDGET_EXCEEDED');
 const resumed=f.enqueue('http-budget-resumed');assert.notEqual(resumed.id,first.id);runner=f.makeRunner();
 try{await runner.runOne();}finally{await runner.stop();}
 assert.equal(f.calls(),1);assert.equal(f.jobs.get('alpha',resumed.id).job.errorCode,'BUDGET_EXCEEDED');
 assert.equal(f.fallback.budget.planTotals('alpha',first.id,null).requests,1);
});
