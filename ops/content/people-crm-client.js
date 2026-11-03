'use strict';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
function createPeopleCrmClient({crmUrl,apiKey,fetchImpl=fetch}) {
  const actions=new Set(['tasks_list','task_get','task_update','mediaMentor','taskRecords','planVariantsDecision']);
  return async function call(action,args,user,companyCode) {
    if(!actions.has(action)||!apiKey)fail(503,'Источник задач не настроен');
    // Внутренний брокер читает существующие Owner tools. Пользователь не получает
    // эту личность: people-tasks проверяет стабильное назначение, компанию и CAS.
    // Произвольные путь, тело, заголовки и права из браузера сюда не поступают.
    const identity={v:1,userId:user.id,userName:user.displayName,role:'owner',permissions:['crm.view','crm.edit'],companyCodes:[companyCode]};
    const readOnly=action==='mediaMentor'||action==='taskRecords';
    const route=action==='mediaMentor'?`/media-mentor?companyCode=${encodeURIComponent(companyCode)}`:
      action==='taskRecords'?`/tasks?companyCode=${encodeURIComponent(companyCode)}&limit=200&offset=${Number(args.offset)||0}`:
      action==='planVariantsDecision'?`/media-mentor/plan/variants/decision?companyCode=${encodeURIComponent(companyCode)}`:`/coordination/mcp/${action}`;
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
