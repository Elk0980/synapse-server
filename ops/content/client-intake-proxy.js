'use strict';
function createClientIntakeProxy({crmUrl,apiKey,identityHeader,fetchImpl=fetch}){
  return async(source,identity)=>{
    if(!apiKey)throw Object.assign(Error('CRM не подключена'),{status:503});
    let response;
    try{response=await fetchImpl(`${crmUrl}/client-dialog-intakes?companyCode=${encodeURIComponent(source.companyCode)}`,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{'content-type':'application/json','x-api-key':apiKey,'x-synapse-crm-identity':identityHeader(identity)},body:JSON.stringify(source.body)});
    }catch{throw Object.assign(Error('Ответ CRM не получен. Повторное открытие найдёт ту же карточку.'),{status:503});}
    const result=await response.json().catch(()=>null);
    if(!response.ok)throw Object.assign(Error(response.status===409?'Связь с карточкой требует проверки владельцем.':'Не удалось открыть карточку CRM.'),{status:[400,403,404,409].includes(response.status)?response.status:502});
    if(result?.companyCode?.toLowerCase()!==source.companyCode.toLowerCase()||!Number.isSafeInteger(result.leadId)||result.leadId<1)
      throw Object.assign(Error('CRM вернула неподходящую карточку'),{status:502});
    return result;
  };
}
module.exports={createClientIntakeProxy};
