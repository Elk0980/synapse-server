'use strict';
// The reply function is the existing budgeted provider runtime or its authenticated bridge.
// No keys, provider configuration, or second budget ledger are owned here.
function createContentPlanProvider({reply}){
 if(typeof reply!=='function')return null;
 return {async generate({messages,signal,companyCode}){
  signal?.throwIfAborted();
  const payload=JSON.stringify({companyCode,responseProfile:'structured-draft',maxOutputTokens:1200,
   system:messages.filter(m=>m.role==='system').map(m=>m.content).join('\n')+
    '\nСейчас готовится одна часть плана. Пиши кратко: topic до120 символов, hook до150, text до400, mentorNote до250. Это предложение, не готовый медиаматериал.',
   messages:messages.filter(m=>m.role!=='system')});
  try{
   const result=await reply(payload,{signal,maxAttempts:2});signal?.throwIfAborted();
   if(!result||typeof result.text!=='string'||typeof result.model!=='string'||!result.model.trim()||result.model.length>150)
    throw Object.assign(Error('Invalid provider response'),{code:'INVALID_RESULT'});
   return {output:result.text,executor:{kind:'api',model:result.model}};
  }catch(error){
   signal?.throwIfAborted();
   const code=error.budgetStopped?'BUDGET_EXCEEDED':error.code==='INVALID_RESULT'?'INVALID_RESULT':'PROVIDER_UNAVAILABLE';
   throw Object.assign(Error('Content provider unavailable'),{code});
  }
 }};
}
module.exports={createContentPlanProvider};
