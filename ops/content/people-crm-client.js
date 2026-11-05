'use strict';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const {personAliases}=require('./people-aliases');
function createPeopleCrmClient({crmUrl,apiKey,fetchImpl=fetch,authStore=null}) {
  const actions=new Set(['ownerDecisionEvents','tasks_list','task_get','task_update','teamChatTask','teamChatContext','mediaMentor','taskRecords','planVariantsDecision',
    'hughTask','myBoard','myBoardAction','taskChatComment']);
  const writes=['task_update','teamChatTask','hughTask','myBoardAction','taskChatComment'];
  return async function call(action,args,user,companyCode) {
    if(!actions.has(action)||!apiKey)fail(503,'Источник задач не настроен');
    const permission=['mediaMentor','planVariantsDecision'].includes(action)?'content-plan.approve':
      writes.includes(action)?'tasks.self.edit':'tasks.self.view';
    if(!user||!['owner','editor'].includes(user.role)||!Number.isSafeInteger(user.id)||user.id<1||
      typeof companyCode!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(companyCode)||
      !user.companyCodes?.includes(companyCode)||user.role!=='owner'&&!user.permissions?.includes(permission))fail(403,'Недостаточно прав в выбранной компании');
    // Реальная роль и одна нужная операция; CRM повторно проверяет эти права,
    // компанию и назначение. Человек никогда не представляется владельцем.
    const permissions=[permission];
    if(action==='teamChatContext'&&user.permissions?.includes('content-plan.approve'))permissions.push('content-plan.approve');
    // Однозначные в компании имена человека: исполнитель на доске часто записан именем.
    const userAliases=authStore?personAliases(authStore.list(),user,companyCode):[];
    const identity={v:1,userId:user.id,userName:user.displayName,role:user.role,permissions,companyCodes:[companyCode],
      ...(userAliases.length?{userAliases}:{})};
    const readOnly=['ownerDecisionEvents','mediaMentor','taskRecords','teamChatContext','myBoard'].includes(action);
    const route=`/internal/people/${action}?companyCode=${encodeURIComponent(companyCode)}`+
      (action==='ownerDecisionEvents'?`&offset=${Number(args.offset)||0}${args.taskId?`&taskId=${Number(args.taskId)}`:''}`:'')+
      (action==='taskRecords'?`&offset=${Number(args.offset)||0}`:'');
    let response;
    try {response=await fetchImpl(`${crmUrl}${route}`,{method:readOnly?'GET':'POST',
      headers:{'content-type':'application/json','x-api-key':apiKey,'x-synapse-crm-identity':Buffer.from(JSON.stringify(identity)).toString('base64url')},
      ...(readOnly?{}:{body:JSON.stringify(args)}),redirect:'error',signal:AbortSignal.timeout(15000)});
    } catch{fail(503,'Источник недоступен; результат операции не подтверждён');}
    let data;
    try {
      const reader=response.body.getReader();let size=0;const chunks=[];
      try {for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>4*1024*1024){await reader.cancel();fail(502,'Слишком большой ответ источника');}chunks.push(Buffer.from(item.value));}}
      finally{reader.releaseLock();}
      data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }catch(error){if(error.status)throw error;fail(502,'Источник вернул некорректные данные');}
    if(!response.ok)fail(response.status>=500?503:response.status,response.status===409?'Задача изменилась. Обновите карточку':'Источник отклонил запрос');
    return data;
  };
}
module.exports={createPeopleCrmClient};
