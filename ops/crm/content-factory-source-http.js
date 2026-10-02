'use strict';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
// Service key и trusted CRM identity проверяет сервер; внешний browser proxy сюда не ведёт.
function createContentFactorySourceHandler({autoposting,companyModuleContext,readJson,send}){
  return async function handle(request,response,url){
    const attach=url.pathname==='/internal/content-factory/source-attach',lookup=url.pathname==='/internal/content-factory/source-attach-lookup',usage=url.pathname==='/internal/content-factory/source-usage';
    if(!attach&&!lookup&&!usage)return false;
    if(request.method!=='POST')fail(405,'Метод не поддерживается');
    const code=url.searchParams.get('companyCode'),permission=attach||lookup?'autoposting.edit':'autoposting.view';
    const initial=companyModuleContext(request,code,permission),body=await readJson(request);
    if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'Ожидался объект запроса');
    if(usage&&(Object.keys(body).length!==1||!Object.hasOwn(body,'sourceId')||!Number.isSafeInteger(body.sourceId)||body.sourceId<1))fail(400,'Нужен положительный целый sourceId');
    const fresh=companyModuleContext(request,code,permission);
    if(fresh.identity.userId!==initial.identity.userId)fail(403,'Доступ изменился во время операции');
    const result=attach?await autoposting.attachSource(fresh.company.code,body,fresh.identity):lookup?
      {companyCode:fresh.company.code.toLowerCase(),receipt:await autoposting.lookupSourceAttachment(fresh.company.code,body)}:
      await autoposting.sourceUsage(fresh.company.code,body.sourceId);
    send(response,200,result,{'cache-control':'no-store'});return true;
  };
}
module.exports={createContentFactorySourceHandler};
