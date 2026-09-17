'use strict';
const {REVIEW_ERRORS}=require('./reviews');
function createReviewsHandler({reviews,companyModuleContext,readJson,send}) {
  return async function handle(request,response,url,cors={}) {
    if(!/^\/reviews(?:\/|$)/.test(url.pathname))return false;
    const {company,identity}=companyModuleContext(request,url.searchParams.get('companyCode'),request.method==='GET'?'crm.view':'crm.edit');
    try {
      let result,status=200;
      const review=/^\/reviews\/([1-9]\d*)$/.exec(url.pathname),platform=/^\/reviews\/platforms\/([a-z_]+)$/.exec(url.pathname);
      if(url.pathname==='/reviews'&&request.method==='GET')result=reviews.list(company.code,{
        ...(url.searchParams.has('limit')?{limit:Number(url.searchParams.get('limit'))}:{}),
        ...(url.searchParams.has('offset')?{offset:Number(url.searchParams.get('offset'))}:{}),
        ...Object.fromEntries(['q','status','platform'].filter(key=>url.searchParams.has(key)).map(key=>[key,url.searchParams.get(key)]))});
      else if(url.pathname==='/reviews'&&request.method==='POST'){result=reviews.create(company.code,await readJson(request),identity);status=result.duplicate?200:201;}
      else if(review&&request.method==='PATCH')result=reviews.update(company.code,review[1],await readJson(request),identity);
      else if(platform&&request.method==='PUT')result=reviews.savePlatform(company.code,platform[1],await readJson(request),identity);
      else {send(response,405,{error:'Метод не поддерживается.',code:'METHOD_NOT_ALLOWED'},{...cors,'cache-control':'no-store'});return true;}
      send(response,status,result,{...cors,'cache-control':'no-store'});
    }catch(error){
      if(!Object.hasOwn(REVIEW_ERRORS,error.code))throw error;
      send(response,error.status,{error:REVIEW_ERRORS[error.code],code:error.code},{...cors,'cache-control':'no-store'});
    }
    return true;
  };
}
module.exports={createReviewsHandler};
