'use strict';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const validBody=b=>Boolean(b&&typeof b==='object'&&!Array.isArray(b)&&Object.keys(b).sort().join(',')==='entries,requestId'&&Array.isArray(b.entries)&&b.entries.length>0&&b.entries.length<=2);
const id=s=>typeof s==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(s);
// Mount only inside the existing authenticated cabinet host. It grants no new
// role, exposes no raw source GET, and never claims to send a push notification.
async function handle({request,url,reply,requireSession,requireCsrf,readJson,origin,cache}){
 const paths=['/content/customer-reports/source','/content/customer-reports/source/status','/content/customer-reports/source/receipt'];
 if(!paths.includes(url.pathname))return false;
 if(url.pathname!==paths[0]){
  if(request.method!=='GET')fail(405,'Результат обновления доступен только для чтения');
  const first=requireSession(request);if(first.user.role!=='owner')fail(403,'Источник отчётов проверяет владелец');
  const allowed=['alvi','avokado'].filter(c=>Array.isArray(first.user.companyCodes)&&first.user.companyCodes.includes(c));
  if(!allowed.length)fail(403,'Нет доступа к источникам отчётов');
  let result,scope;
  if(url.pathname===paths[1]){
   if(url.search)fail(400,'Параметры статуса не поддерживаются');
   scope=allowed;result={contract:'salon-report-source-status/v1',companies:allowed.map(companyCode=>({companyCode,metadata:cache.metadata(companyCode)}))};
  }else{
   if([...url.searchParams.keys()].join(',')!=='requestId'||!id(url.searchParams.get('requestId')))fail(400,'Нужен один ключ обновления');
   result=cache.receipt(first.user.id,url.searchParams.get('requestId'));
   scope=result?result.companies.map(c=>c.companyCode):allowed;
  }
  const fresh=requireSession(request);
  if(fresh.user.id!==first.user.id||fresh.user.sessionVersion!==first.user.sessionVersion||fresh.user.role!=='owner'||!Array.isArray(fresh.user.companyCodes)||scope.some(c=>!allowed.includes(c)||!fresh.user.companyCodes.includes(c)))fail(403,'Доступ к источникам отчётов изменился');
  if(!result)fail(404,'Результат обновления пока не найден');
  reply(200,result,{'cache-control':'private, no-store','vary':'Cookie','x-content-type-options':'nosniff'});return true;
 }
 if(request.method!=='POST')fail(405,'Импорт доступен только для записи источника');
 if(url.search)fail(400,'Параметры импорта не поддерживаются');
 const first=requireSession(request);if(first.user.role!=='owner')fail(403,'Источник отчётов обновляет владелец');
 if(!origin||request.headers.origin!==origin)fail(403,'Запрос с другого адреса запрещён');requireCsrf(request,first);
 const body=await readJson(request);if(!validBody(body))fail(400,'Нужны только ключ запроса и источники');
 const verify=()=>{const fresh=requireSession(request);if(fresh.user.id!==first.user.id||fresh.user.sessionVersion!==first.user.sessionVersion||fresh.user.role!=='owner'||!Array.isArray(fresh.user.companyCodes)||body.entries.some(e=>!e||!['alvi','avokado'].includes(e.companyCode)||!fresh.user.companyCodes.includes(e.companyCode)))fail(403,'Доступ к источникам отчётов изменился');requireCsrf(request,fresh);};
 verify();const result=cache.publish(body.entries,{actorId:first.user.id,requestId:body.requestId,beforeCommit:verify});reply(200,result,{'cache-control':'private, no-store'});return true;
}
module.exports={handle};
