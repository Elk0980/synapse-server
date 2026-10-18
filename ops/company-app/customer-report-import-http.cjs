'use strict';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const validBody=b=>Boolean(b&&typeof b==='object'&&!Array.isArray(b)&&Object.keys(b).sort().join(',')==='entries,requestId'&&Array.isArray(b.entries)&&b.entries.length>0&&b.entries.length<=2);
// Mount only inside the existing authenticated cabinet host. It grants no new
// role, exposes no raw source GET, and never claims to send a push notification.
async function handle({request,url,reply,requireSession,requireCsrf,readJson,origin,cache}){
 if(url.pathname!=='/content/customer-reports/source')return false;
 if(request.method!=='POST')fail(405,'Импорт доступен только для записи источника');
 if(url.search)fail(400,'Параметры импорта не поддерживаются');
 const first=requireSession(request);if(first.user.role!=='owner')fail(403,'Источник отчётов обновляет владелец');
 if(!origin||request.headers.origin!==origin)fail(403,'Запрос с другого адреса запрещён');requireCsrf(request,first);
 const body=await readJson(request);if(!validBody(body))fail(400,'Нужны только ключ запроса и источники');
 const verify=()=>{const fresh=requireSession(request);if(fresh.user.id!==first.user.id||fresh.user.sessionVersion!==first.user.sessionVersion||fresh.user.role!=='owner'||!Array.isArray(fresh.user.companyCodes)||body.entries.some(e=>!e||!['alvi','avokado'].includes(e.companyCode)||!fresh.user.companyCodes.includes(e.companyCode)))fail(403,'Доступ к источникам отчётов изменился');requireCsrf(request,fresh);};
 verify();const result=cache.publish(body.entries,{actorId:first.user.id,requestId:body.requestId,beforeCommit:verify});reply(200,result,{'cache-control':'private, no-store'});return true;
}
module.exports={handle};
