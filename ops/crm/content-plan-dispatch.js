'use strict';
const {fail}=require('./company-information');
const {slotsFor,validateProposals,promptFor}=require('./content-plan-worker');
// Service-only protocol. Inputs are always loaded from the leased CRM row.
function createContentPlanDispatch({jobs}){
 function read(lease){
  if(!lease||typeof lease.id!=='string'||typeof lease.token!=='string')fail(400,'Нужна аренда задачи');
  return jobs.inspectLease(lease.id,lease.token);
 }
 function next(lease){
  const job=read(lease),slots=slotsFor(job.month,job.snapshot.monthInputs),previous=[];
  if(job.parts.length>slots.length)fail(400,'Некорректные части плана','INVALID_RESULT');
  job.parts.forEach((p,i)=>previous.push(...validateProposals({proposals:p.proposals},job,{slots:[slots[i]],offset:i,previous})));
  if(previous.length===slots.length){jobs.complete(job.id,job.token,previous);return {done:true};}
  jobs.heartbeat(job.id,job.token);
  const messages=promptFor(job,[slots[previous.length]],previous);
  return {done:false,lease:{id:job.id,token:job.token},partIndex:previous.length,
   budgetScope:{company:job.companyCode,job:job.budgetJob},
   payload:{companyCode:job.companyCode,responseProfile:'structured-draft',maxOutputTokens:1200,
    system:messages[0].content+' Пиши кратко: topic до120, hook до150, text до400, mentorNote до250 символов. Это предложение, не готовое медиа.',
    messages:messages.slice(1)}};
 }
 function result({lease,partIndex,text,model}){
  const job=read(lease),slots=slotsFor(job.month,job.snapshot.monthInputs);
  if(!Number.isInteger(partIndex)||partIndex<0||partIndex>=slots.length||partIndex>job.parts.length||
   typeof text!=='string'||Buffer.byteLength(text)>300000||typeof model!=='string'||!model.trim()||model.length>150)fail(400,'Некорректный результат','INVALID_RESULT');
  let value;try{value=JSON.parse(text)}catch{fail(400,'Результат не является JSON','INVALID_RESULT')}
  const previous=job.parts.slice(0,partIndex).flatMap(p=>p.proposals);
  const proposals=validateProposals(value,job,{slots:[slots[partIndex]],offset:partIndex,previous});
  const executor={kind:'api',model};
  jobs.savePart(job.id,job.token,partIndex,{proposals,executor});
  jobs.setExecutor(job.id,job.token,executor);
  return next(lease);
 }
 return {handle(action,body={}){
  if(action==='pulse')return jobs.pulse(body.configured);
  if(action==='alerts')return {alerts:jobs.pendingEvents()};
  if(action==='ack-alert')return jobs.acknowledgeEvent(body.id);
  if(action==='claim'){const job=jobs.claim();return {task:job?next({id:job.id,token:job.token}):null};}
  if(action==='next')return next(body.lease);
  if(action==='release'){const job=read(body.lease);return jobs.release(job.id,job.token);}
  if(action==='renew'){const job=read(body.lease);jobs.heartbeat(job.id,job.token);return {ok:true};}
  if(action==='result'){try{return result(body)}catch(error){if(error.code==='INVALID_RESULT')fail(400,'Результат не прошёл проверку','INVALID_RESULT');throw error;}}
  if(action==='error'){const job=read(body.lease);jobs.reject(job.id,job.token,{errorCode:body.code,
   retryable:['PROVIDER_UNAVAILABLE','GENERATION_FAILED','INVALID_RESULT'].includes(body.code)});return {ok:true};}
  fail(404,'Адрес не найден');
 }};
}
module.exports={createContentPlanDispatch};
