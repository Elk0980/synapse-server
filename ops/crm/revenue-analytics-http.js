'use strict';
const ERRORS={
  VALIDATION_ERROR:[400,'Проверьте параметры подключения.'],BAD_PERIOD:[400,'Проверьте даты периода.'],BAD_TIMEZONE:[400,'Проверьте часовой пояс.'],
  REVISION_CONFLICT:[409,'Подключение изменилось. Обновите страницу.'],BINDING_CHANGED:[409,'Сохранённые данные относятся к другому филиалу или счётчику. Смена привязки требует отдельной миграции.'],
  MISSING_ACCESS:[409,'Источник не подключён или сбор выключен.'],CREDENTIAL_UNREADABLE:[409,'Сохранённый доступ не читается. Нужен повторный ввод ключа.']
};
function createRevenueHandler({analytics,companyModuleContext,readJson,send}) {
  return async function handle(request,response,url,cors={}) {
    if(!/^\/revenue-analytics(?:\/|$)/.test(url.pathname))return false;
    const headers={...cors,'cache-control':'no-store'};
    const {company,identity}=companyModuleContext(request,url.searchParams.get('companyCode'),request.method==='GET'?'analytics.view':'crm.edit');
    try {
      let result;
      if(url.pathname==='/revenue-analytics'&&request.method==='GET')result=analytics.report(company.code,url.searchParams.get('from'),url.searchParams.get('to'));
      else {
        if(identity.role!=='owner'){send(response,403,{error:'Подключение источников доступно владельцу.',code:'FORBIDDEN'},headers);return true;}
        const p=url.searchParams.get('provider');
        if(url.pathname==='/revenue-analytics/access'&&request.method==='GET')result=analytics.settings(company.code);
        else if(url.pathname==='/revenue-analytics/access'&&request.method==='PUT')result=analytics.save(company.code,p,await readJson(request));
        else if(url.pathname==='/revenue-analytics/collect'&&request.method==='POST') {
          const b=await readJson(request);
          if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['from','to'].includes(k))||Boolean(b.from)!==Boolean(b.to)){send(response,400,{error:ERRORS.VALIDATION_ERROR[1],code:'VALIDATION_ERROR'},headers);return true;}
          result=await analytics.collect(company.code,p,b.from?{from:b.from,to:b.to}:null);
        } else {send(response,405,{error:'Метод не поддерживается.',code:'METHOD_NOT_ALLOWED'},headers);return true;}
      }
      send(response,200,result,headers);
    }catch(e){const known=ERRORS[e.code];send(response,known?.[0]||500,{error:known?.[1]||'Не удалось получить аналитические данные.',code:known?e.code:'INTERNAL_ERROR'},headers);}
    return true;
  };
}
module.exports={createRevenueHandler};
