'use strict';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const exact=(body,keys)=>body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===keys.length&&keys.every(key=>Object.hasOwn(body,key));
function createContentFactoryContextHandler({generation,jobs,companyModuleContext,readJson,send,planningInsights=null}){
 return async function handle(request,response,url){
  const lookup=url.pathname==='/internal/content-factory/plan-lookup',start=url.pathname==='/internal/content-factory/plan-start';
  if(!lookup&&!start)return false;
  if(request.method!=='POST')fail(405,'Метод не поддерживается');
  const code=url.searchParams.get('companyCode'),initial=companyModuleContext(request,code,'autoposting.edit'),body=await readJson(request);
  if(!exact(body,lookup?['month','clientRequestId']:['request','sourceLibrary']))fail(400,'Некорректные параметры подготовки плана');
  if(start&&!exact(body.request,['month','clientRequestId']))fail(400,'Нужны месяц и ключ запроса');
  const current=companyModuleContext(request,code,'autoposting.edit');
  if(current.identity.userId!==initial.identity.userId)fail(403,'Доступ изменился во время операции');
  let result;
  if(lookup)result=jobs.lookupRequest(current.company.code,body.clientRequestId,body.month)||{companyCode:current.company.code,job:null};
  else{
    const previous=jobs.lookupRequest(current.company.code,body.request.clientRequestId,body.request.month);
    if(previous)result=previous;
    else{
      const allowed=current.identity.role==='owner'||current.identity.permissions?.has('analytics.view');
      const context=allowed&&planningInsights?planningInsights.capture(current.company.code,body.request.month):null;
      result=generation.create(current.company.code,body.request,body.sourceLibrary,context);
    }
  }
  send(response,200,result,{'cache-control':'no-store'});return true;
 };
}
module.exports={createContentFactoryContextHandler};
