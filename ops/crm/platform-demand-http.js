'use strict';
const {PLATFORM_DEMAND_ERRORS}=require('./platform-demand');
const {PLATFORM_COMPANY_METRICS_ERRORS}=require('./platform-company-metrics');
function createPlatformDemandHandler({demand,companyMetrics,companyModuleContext,readJson,send}) {
  return async function handle(request,response,url,cors={}) {
    if(!/^\/platform-demand(?:\/|$)/.test(url.pathname))return false;
    const {company,identity}=companyModuleContext(request,url.searchParams.get('companyCode'),request.method==='GET'?'analytics.view':'crm.edit');
    try {
      let result,status=200;const dataset=/^\/platform-demand\/datasets\/([1-9]\d*)$/.exec(url.pathname);
      // Фактические показатели компании живут в том же пространстве 2ГИС, но отдельным разделом:
      // спрос по рубрикам ими не подменяется. Проверки компании и прав — те же, что выше.
      const report=/^\/platform-demand\/company-metrics\/reports\/([1-9]\d*)$/.exec(url.pathname);
      if(companyMetrics&&url.pathname==='/platform-demand/company-metrics'&&request.method==='GET')
        result=companyMetrics.summary(company.code,url.searchParams.get('from'),url.searchParams.get('to'));
      else if(companyMetrics&&report&&request.method==='GET')result=companyMetrics.getReport(company.code,report[1]);
      else if(companyMetrics&&url.pathname==='/platform-demand/company-metrics/preview'&&request.method==='POST')
        result=companyMetrics.preview(company.code,await readJson(request),identity);
      else if(companyMetrics&&url.pathname==='/platform-demand/company-metrics/import'&&request.method==='POST'){
        result=companyMetrics.importReports(company.code,await readJson(request),identity);status=result.imported.length?201:200;}
      else
      if(url.pathname==='/platform-demand'&&request.method==='GET')result=demand.get(company.code);
      else if(dataset&&request.method==='GET')result=demand.getDataset(company.code,dataset[1]);
      else if(url.pathname==='/platform-demand/potential'&&request.method==='GET')result=demand.potential(company.code,url.searchParams.get('from'),url.searchParams.get('to'));
      else if(url.pathname==='/platform-demand/settings'&&request.method==='PUT')result=demand.saveSettings(company.code,await readJson(request),identity);
      else if(url.pathname==='/platform-demand/categories'&&request.method==='PUT')result=demand.saveCategories(company.code,await readJson(request),identity);
      else if(url.pathname==='/platform-demand/import'&&request.method==='POST'){result=demand.importDataset(company.code,await readJson(request),identity);status=result.duplicate?200:201;}
      else{send(response,405,{error:'Метод не поддерживается.',code:'METHOD_NOT_ALLOWED'},{...cors,'cache-control':'no-store'});return true;}
      send(response,status,result,{...cors,'cache-control':'no-store'});
    }catch(error){const message=PLATFORM_DEMAND_ERRORS[error.code]??PLATFORM_COMPANY_METRICS_ERRORS[error.code];
      if(message===undefined)throw error;send(response,error.status,{error:message,code:error.code},{...cors,'cache-control':'no-store'});}
    return true;
  };
}
module.exports={createPlatformDemandHandler};
