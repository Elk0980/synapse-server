'use strict';
const {report,period}=require('./customer-reports.cjs');
const aggregates=require('./customer-report-aggregates.cjs');
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const permitted=(user,company)=>Boolean(user&&['owner','editor'].includes(user.role)&&Array.isArray(user.companyCodes)&&user.companyCodes.includes(company)&&(user.role==='owner'||Array.isArray(user.permissions)&&user.permissions.includes('analytics.view')));
// Read only. The installed provider must verify source identity and historical coverage.
// Missing provider deliberately returns unknown metrics, never synthetic customer data.
async function handle({request,url,reply,requireSession,readSnapshot=async()=>null,readTraffic=async()=>null,now=()=>new Date().toISOString()}){
 const match=/^\/content\/(alvi|avokado)\/customer-reports$/.exec(url.pathname);if(!match)return false;
 if(request.method!=='GET')fail(405,'Отчёт доступен только для чтения');
 const company=match[1],session=requireSession(request);
 if(!permitted(session.user,company))fail(403,'Нет доступа к отчётам этой компании');
 for(const key of url.searchParams.keys())if(url.searchParams.getAll(key).length!==1)fail(400,'Фильтр задан несколько раз');
 const query=Object.fromEntries(url.searchParams),at=now();period(query,at);
 const snapshot=await readSnapshot(company,query,at);
 const traffic=await readTraffic(company,query,at);
 const fresh=requireSession(request);
 if(fresh.user.id!==session.user.id||fresh.user.sessionVersion!==session.user.sessionVersion||!permitted(fresh.user,company))fail(403,'Доступ к отчётам изменился');
 const calculate=snapshot?.contract==='salon-client-aggregates/v1'?aggregates.report:report;
 const result=calculate({companyCode:company,query,snapshot,now:at});
 if(traffic!==null){if(traffic.companyCode!==company||traffic.contract!=='app-entry-statistics/v1'||traffic.period?.fromAt!==result.period.fromAt||traffic.period?.untilAt!==result.period.untilAt)fail(502,'Статистика входов не соответствует выбранной компании или периоду');result.traffic=traffic;}
 reply(200,result,{'cache-control':'private, no-store','vary':'Cookie','x-content-type-options':'nosniff'});return true;
}
module.exports={handle,permitted};
