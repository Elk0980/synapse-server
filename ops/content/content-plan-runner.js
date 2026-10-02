'use strict';
function createContentPlanRunner({crmUrl,crmApiKey,fallback,alerts=null,fetchImpl=globalThis.fetch,intervalMs=5000,renewMs=20000,reviewDelayNotifications=false,onReviewDelayError=()=>{}}){
 let timer=null,stopping=false,active=null,controller=null,syncActive=null,syncController=null;
 async function request(action,body={},signal){
  const route=action==='review-delays'?'/internal/content-factory/review-delays':`/internal/content-plan/${action}`;
  const response=await fetchImpl(`${crmUrl}${route}`,{method:'POST',redirect:'error',
   headers:{'x-api-key':crmApiKey,'content-type':'application/json'},body:JSON.stringify(body),
   signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});
  if(!response.ok)throw Object.assign(Error('Content queue unavailable'),{status:response.status});
  return response.json();
 }
 const reviewDelays=reviewDelayNotifications&&alerts?require('./content-factory-review-delay-notifications').createContentFactoryReviewDelayNotifications({request,alerts}):null;
 async function processOne(){
  if(stopping||!crmApiKey)return false;
  let task,renew,stage='transport';controller=new AbortController();
  try{
   task=(await request('claim',{},controller.signal)).task;if(!task)return false;
   const lease=task.lease,leaseController=controller;
   renew=setInterval(()=>{void request('renew',{lease},leaseController.signal).catch(()=>leaseController.abort());},renewMs);renew.unref?.();
   for(let part=0;!task.done&&part<651;part++){
    stage='provider';controller.signal.throwIfAborted();
    if(!fallback||typeof fallback.reply!=='function'||(Array.isArray(fallback.providers)&&!fallback.providers.length))throw Object.assign(Error('No provider'),{notConfigured:true});
    if(fallback.budget && (!fallback.budget.planReady?.() || !task.budgetScope))throw Object.assign(Error('Plan limits unavailable'),{notConfigured:true});
    const answer=await fallback.reply(JSON.stringify(task.payload),{signal:controller.signal,maxAttempts:2,contentPlan:task.budgetScope});
    controller.signal.throwIfAborted();stage='transport';
    task=await request('result',{lease,partIndex:task.partIndex,text:answer.text,model:answer.model},controller.signal);
   }
   return true;
  }catch(error){
   if(stopping&&task?.lease){clearInterval(renew);await request('release',{lease:task.lease}).catch(()=>{});}
   // A lost CRM response may have saved the part. Leave its lease to recover instead of regenerating blindly.
   if(task?.lease&&!stopping&&!controller.signal.aborted&&(stage==='provider'||error.status===400)){
    const code=error.status===400?'INVALID_RESULT':error.budgetStopped?'BUDGET_EXCEEDED':error.notConfigured?'PROVIDER_NOT_CONFIGURED':'PROVIDER_UNAVAILABLE';
    await request('error',{lease:task.lease,code}).catch(()=>{});
   }
   return Boolean(task);
  }finally{clearInterval(renew);controller.abort();controller=null;}
 }
 function runOne(){if(active||stopping)return Promise.resolve(false);const task=processOne();active=task;
  void task.finally(()=>{if(active===task)active=null}).catch(()=>{});return task;}
 function sync(){
  if(stopping||syncActive||!crmApiKey)return Promise.resolve(false);
  const ownController=new AbortController();syncController=ownController;
  const task=(async()=>{
   const providerConfigured=Array.isArray(fallback?.providers)?fallback.providers.length>0:typeof fallback?.reply==='function';
   const configured=providerConfigured&&(!fallback?.budget||fallback.budget.planReady?.()===true);
   await request('pulse',{configured},ownController.signal);
   if(reviewDelays){try{await reviewDelays.sync({signal:ownController.signal});}catch{
     ownController.signal.throwIfAborted();onReviewDelayError(); // A failed read does not block generation event acknowledgement.
   }}
   if(alerts){const pending=await request('alerts',{},ownController.signal);
    for(const event of pending.alerts){alerts.add(event.companyCode,event.eventKey,event.text);await request('ack-alert',{id:event.id},ownController.signal);}}
   return true;
  })();syncActive=task;
  void task.finally(()=>{if(syncActive===task){syncActive=null;syncController=null}}).catch(()=>{});return task;
 }
 function start(){if(timer||stopping||!crmApiKey)return;void sync().catch(()=>{});timer=setInterval(()=>{void sync().catch(()=>{});void runOne().catch(()=>{});},intervalMs);timer.unref?.();}
 async function stop(){stopping=true;clearInterval(timer);timer=null;controller?.abort();syncController?.abort();await Promise.allSettled([active,syncActive]);}
 return {start,stop,runOne,sync};
}
module.exports={createContentPlanRunner};
