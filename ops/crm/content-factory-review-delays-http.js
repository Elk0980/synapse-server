'use strict';
function createContentFactoryReviewDelaysHandler({delays,readJson,send}){
 return async(request,response,url)=>{
   if(url.pathname!=='/internal/content-factory/review-delays')return false;
   if(request.headers['x-synapse-crm-identity'])throw Object.assign(Error('Только серверный обработчик'),{status:403});
   if(request.method!=='POST')throw Object.assign(Error('Метод не поддерживается'),{status:405});
   const body=await readJson(request);
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==2||!Object.hasOwn(body,'afterTaskId')||!Object.hasOwn(body,'limit')||url.search)
     throw Object.assign(Error('Некорректные параметры служебной сводки'),{status:400});
   send(response,200,delays.pending(body),{'cache-control':'no-store'});return true;
 };
}
module.exports={createContentFactoryReviewDelaysHandler};
