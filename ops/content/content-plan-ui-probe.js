'use strict';
// Integration probe: actual cabinet module + actual HTTP services, synthetic model only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
async function runContentPlanUiProbe({through,crmBase,key}){
 const {JSDOM,VirtualConsole}=require('jsdom');
 const scope='?companyCode=avokado',calls=[];
 assert.equal((await through('editor','/media-mentor/brief'+scope,{method:'PUT',body:{revision:0,brief:{
  product:'Синтетическое оформление',audience:'Организаторы праздников',pains:['Не хватает времени']}}})).status,200);
 assert.equal((await through('editor','/media-mentor/inputs'+scope,{method:'PUT',body:{revision:1,profile:{targetAction:'Запросить расчёт'}}})).status,200);
 assert.equal((await through('editor','/media-mentor/inputs/months/2026-10'+scope,{method:'PUT',body:{revision:1,inputs:{platforms:['telegram'],perDay:{telegram:2},
  excludedDays:Array.from({length:30},(_,i)=>'2026-10-'+String(i+2).padStart(2,'0'))}}})).status,200);
 assert.equal((await through('editor','/media-mentor/generation'+scope,{method:'POST',body:{clientRequestId:'offline_probe',month:'2026-10'}})).status,501);
 const pulse=await fetch(crmBase+'/internal/content-plan/pulse',{method:'POST',headers:{'x-api-key':key,'content-type':'application/json'},body:'{"configured":true}'});assert.equal(pulse.status,200);await pulse.text();
 const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM('<div id="content-factory-plan-bar"><button data-factory-action="compose">Составить план</button><span data-factory-bar-status></span><section id="content-factory-compose" hidden></section></div>',
  {url:'https://synthetic.invalid/cabinet.html#content-factory/plan',runScripts:'outside-only',virtualConsole:vc});
 const w=dom.window,d=w.document;
 async function until(check){for(let i=0;i<500;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI condition timed out: '+d.body.textContent);}
 try{
  w.SbCabinet={registerView(){}};
  w.eval(fs.readFileSync(path.join(__dirname,'../../sites/synapse/cabinet/content-factory.js'),'utf8'));
  const ctx={identity:{role:'owner',permissions:[],csrfToken:'synthetic'},selectedProjectId:'avokado',navigate(){},
   csrfOptions:(method,body)=>({method,body:JSON.stringify(body)}),
   crmQuery:async(route,params={},options={})=>{
    const body=options.body?JSON.parse(options.body):undefined;
    const response=await through('editor',route+'?'+new URLSearchParams(params),{method:options.method||'GET',body});
    calls.push({route,method:options.method||'GET',body,response:response.body});
    if(response.status>=400)throw Object.assign(Error(response.body.error),{status:response.status,code:response.body.details?.code});
    return response.body;
   }};
  w.SbCabinet.contentFactory.bindPlanBar(d.getElementById('content-factory-plan-bar'),ctx);
  d.querySelector('[data-factory-action="compose"]').click();await until(()=>d.querySelector('#cf-gen-month'));
  const month=d.querySelector('#cf-gen-month');month.value='2026-10';month.dispatchEvent(new w.Event('change',{bubbles:true}));
  await until(()=>d.querySelector('[data-cf-gen="start"]')&&!d.querySelector('[data-cf-gen="start"]').disabled);
  d.querySelector('[data-cf-gen="start"]').click();
  await until(()=>calls.some(c=>c.method==='POST'&&c.route==='/media-mentor/generation'));
  const created=calls.find(c=>c.method==='POST'&&c.route==='/media-mentor/generation');
  assert.deepEqual(Object.keys(created.body).sort(),['clientRequestId','month']);assert.equal(created.response.job.status,'queued');
  let modelCalls=0;
  const runner=require('./content-plan-runner').createContentPlanRunner({crmUrl:crmBase,crmApiKey:key,fallback:{reply:async payload=>{
   const context=JSON.parse(JSON.parse(payload).messages[0].content);modelCalls++;
   assert.equal(context.workflow.companyCode,'avokado');
   assert.equal(context.workflow.revision,created.response.job.inputs.workflowRevision);
   assert.deepEqual(Object.keys(context.workflow.fields).sort(),['hours','preparationDays','releaseMode','reviewDays']);
   assert.doesNotMatch(JSON.stringify(context.workflow),/publisherName|actorName|approverRole/);
   return {model:'synthetic-integration-only',text:JSON.stringify({proposals:[{...context.slots[0],format:'post',role:'reach',topic:'Синтетическая идея '+context.previousTopics.length,text:'Текст для проверки'}]})};
  }}});
  try{await runner.runOne();}finally{await runner.stop();}
  await until(()=>d.querySelector('[data-cf-gen-status="succeeded"]'));
  d.querySelector('[data-cf-gen="select-visible"]').click();d.querySelector('[data-cf-gen="drafts"]').click();
  await until(()=>calls.some(c=>c.route.endsWith('/drafts')));
  const imported=calls.find(c=>c.route.endsWith('/drafts')).response;
  assert.equal(imported.createdCount,2);assert.equal(modelCalls,2);assert.equal(imported.jobId,created.response.job.id);
  await until(()=>/Создано черновиков: 2/.test(d.body.textContent));
  for(const item of imported.drafts){const post=await through('viewer','/autoposting/posts/'+item.postId+scope);
   assert.equal(post.body.status,'draft');assert.equal(post.body.scheduledAt,null);assert.equal(post.body.approval.approved,false);}
  assert.deepEqual(errors,[]);
  return {proposals:2,drafts:2,modelCalls,uiErrors:errors.length};
 }finally{w.close();}
}
module.exports={runContentPlanUiProbe};
