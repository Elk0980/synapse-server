'use strict';
/* specs/217: маршруты «рилс → заявки → продажи → выручка». Живут под /social-stats, поэтому кабинетный прокси
   применяет уже существующие права раздела аналитики: чтение — analytics.view в своей компании,
   изменение настройки меток — только владелец (как настройки аккаунтов соцсетей). Новых прав нет. */
const {fail}=require('./company-information');
function createReelAttributionHandler({attribution,companyModuleContext,readJson,send}){
  return async function handle(request,response,url,cors={}){
    if(!/^\/social-stats\/reel-attribution(?:\/settings)?$/.test(url.pathname))return false;
    const headers={...cors,'cache-control':'no-store'},settingsPath=url.pathname.endsWith('/settings');
    const readOnly=request.method==='GET';
    if(!readOnly&&!(settingsPath&&request.method==='PUT'))fail(405,'Метод не поддерживается');
    const initial=companyModuleContext(request,url.searchParams.get('companyCode'),readOnly?'analytics.view':'crm.edit');
    let result;
    if(!settingsPath){
      const to=url.searchParams.get('to')||new Date().toISOString().slice(0,10);
      const from=url.searchParams.get('from')||new Date(Date.parse(to+'T00:00:00Z')-29*86400000).toISOString().slice(0,10);
      result=attribution.report(initial.company.code,from,to);
    }else if(readOnly)result=attribution.getSettings(initial.company.code);
    else{
      if(initial.identity.role!=='owner')fail(403,'Метки в подписях включает владелец','FORBIDDEN');
      const body=await readJson(request),fresh=companyModuleContext(request,url.searchParams.get('companyCode'),'crm.edit');
      if(fresh.identity.userId!==initial.identity.userId||fresh.identity.role!=='owner')fail(403,'Доступ изменился во время операции','FORBIDDEN');
      result=attribution.saveSettings(fresh.company.code,body,fresh.identity);
    }
    send(response,200,result,headers);return true;
  };
}
module.exports={createReelAttributionHandler};
