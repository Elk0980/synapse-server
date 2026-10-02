'use strict';
const {fail}=require('./company-information');
const positive=(raw)=>{
 if(raw===null)return undefined;
 if(!/^[1-9]\d*$/.test(raw)||!Number.isSafeInteger(Number(raw)))fail(400,'Курсор и размер страницы должны быть положительными целыми числами');
 return Number(raw);
};
function createContentFactoryCompletionHandler({autoposting,companyModuleContext,readJson,send}){
 return async function handle(request,response,url,cors={}){
  const route=/^\/autoposting\/posts\/([1-9]\d*)\/(history|variants)$/.exec(url.pathname);
  if(!route)return false;
  const id=Number(route[1]);if(!Number.isSafeInteger(id))fail(404,'Материал не найден');
  const history=route[2]==='history';
  if(request.method!==(history?'GET':'POST'))fail(405,'Метод не поддерживается');
  const code=url.searchParams.get('companyCode'),permission=`autoposting.${history?'view':'edit'}`;
  const initial=companyModuleContext(request,code,permission);let result;
  if(history)result=autoposting.history(id,initial.company.code,{before:positive(url.searchParams.get('before')),limit:positive(url.searchParams.get('limit'))});
  else{
   const body=await readJson(request),fresh=companyModuleContext(request,code,permission);
   if(fresh.identity.userId!==initial.identity.userId)fail(403,'Доступ изменился во время операции');
   result=autoposting.createVariant(id,fresh.company.code,body,fresh.identity);
  }
  send(response,!history&&result.created?201:200,result,{...cors,'cache-control':'no-store'});return true;
 };
}
module.exports={createContentFactoryCompletionHandler};
