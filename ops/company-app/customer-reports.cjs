'use strict';
// Pure report calculation. Only a server-verified, normalized YCLIENTS snapshot is accepted.
// No API access, guessing visit/payment links, contacts, storage, or cross-company merging.
const TZ='Asia/Irkutsk', COMPANY=new Set(['alvi','avokado']);
const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'});
const local=at=>Object.fromEntries(fmt.formatToParts(new Date(at)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
const isoDay=at=>{const p=local(at);return `${p.year}-${p.month}-${p.day}`;};
const instant=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)&&Number.isFinite(Date.parse(value));
const fail=message=>{throw Object.assign(new Error(message),{status:400});};
function day(value){if(typeof value!=='string'||!/^\d{4}-\d\d-\d\d$/.test(value))fail('Укажите существующую дату');const date=new Date(value+'T00:00:00Z');if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)fail('Укажите существующую дату');return value;}
function shiftDay(value,n){return new Date(Date.parse(value+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);}
function shiftMonth(value,n){const [y,m,d]=value.split('-').map(Number),date=new Date(Date.UTC(y,m-1+n,1));const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(Math.min(d,last)).padStart(2,'0')}`;}
function midnight(value){const [y,m,d]=value.split('-').map(Number),wall=Date.UTC(y,m-1,d);let guess=wall;for(let n=0;n<4;n++){const p=local(guess),represented=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour);const delta=wall-represented;if(!delta)return guess;guess+=delta;}return guess;}
function period(query={},now=new Date().toISOString()){
 if(!instant(now))fail('Нужно точное время отчёта');
 if(Object.keys(query).some(k=>!['mode','month','day','basis'].includes(k)))fail('Неизвестный фильтр');
 const mode=query.mode||'month',basis=query.basis||'lastVisit';
 if(!['month','day'].includes(mode)||!['firstPaidVisit','lastVisit'].includes(basis))fail('Неизвестный режим');
 const selected=query.month||isoDay(now).slice(0,7);
 if(typeof selected!=='string'||!/^\d{4}-\d\d$/.test(selected))fail('Укажите месяц');
 const start=mode==='month'?day(selected+'-01'):day(query.day||isoDay(now));
 if(mode==='day'&&query.month&&start.slice(0,7)!==query.month)fail('День не относится к выбранному месяцу');
 if(mode==='month'&&query.day!==undefined)fail('Для месячного отчёта день не задаётся');
 const end=mode==='month'?shiftMonth(start,1):shiftDay(start,1);
 return Object.freeze({mode,basis,month:start.slice(0,7),day:mode==='day'?start:null,from:start,to:shiftDay(end,-1),fromAt:new Date(midnight(start)).toISOString(),untilAt:new Date(midnight(end)).toISOString(),timezone:TZ});
}
const GROUPS=[['under3','До 3 месяцев'],['3to6','3–6 месяцев'],['6to12','6–12 месяцев'],['1to2','1–2 года'],['over2','2 года и более'],['noVisit','Без подтверждённого визита']];
function group(at,asOf){if(!at)return 'noVisit';const date=isoDay(at),end=isoDay(asOf);if(date>shiftMonth(end,-3))return 'under3';if(date>shiftMonth(end,-6))return '3to6';if(date>shiftMonth(end,-12))return '6to12';if(date>shiftMonth(end,-24))return '1to2';return 'over2';}
const metric=(value,reason)=>({value,complete:value!==null,reason:reason||null});
function skeleton(company,p){return{contract:'salon-customer-report/v1',companyCode:company,period:p,source:{kind:'yclients',status:'unavailable',updatedAt:null,asOf:null},newClients:metric(null,'SOURCE_UNAVAILABLE'),clients:metric(null,'SOURCE_UNAVAILABLE'),groups:GROUPS.map(([key,label])=>({key,label,count:null,percent:null})),ltv:{...metric(null,'SOURCE_UNAVAILABLE'),netKopecks:null,payingClients:null,definition:'Фактические оплаты минус возвраты за всю подтверждённую историю до конца выбранного периода / число клиентов, имевших оплаченный состоявшийся визит. Это выручка на клиента, не прибыль и не прогноз.'},newSeries:[],ltvSeries:[]};}
function report({companyCode,query={},snapshot=null,now=new Date().toISOString()}={}){
 if(!COMPANY.has(companyCode))fail('Компания не поддерживается отчётом');
 const p=period(query,now),out=skeleton(companyCode,p);
 if(!snapshot)return out;
 if(snapshot.contract!=='salon-client-history/v1'||snapshot.companyCode!==companyCode||snapshot.source!=='yclients'||!instant(snapshot.capturedAt)||!instant(snapshot.observedThrough)||Date.parse(snapshot.observedThrough)>Date.parse(snapshot.capturedAt)||Date.parse(snapshot.capturedAt)>Date.parse(now))fail('История не относится к этому источнику, компании или времени');
 const asOf=Math.min(Date.parse(now),Date.parse(snapshot.observedThrough),Date.parse(p.untilAt)-1);
 out.source={kind:'yclients',status:'partial',updatedAt:snapshot.capturedAt,asOf:new Date(asOf).toISOString()};
 if(asOf<Date.parse(p.fromAt)){out.newClients.reason=out.clients.reason=out.ltv.reason='PERIOD_NOT_OBSERVED';return out;}
 const c=snapshot.coverage||{};
 if(c.clients!==true||c.visits!==true||c.lifetimeHistory!==true||!Array.isArray(snapshot.clients)){out.newClients.reason=out.clients.reason=out.ltv.reason='HISTORY_INCOMPLETE';return out;}
 const clients=new Map();
 for(const row of snapshot.clients){
  if(!row||typeof row.id!=='string'||!row.id||row.id.length>128||clients.has(row.id)||!instant(row.createdAt)||!Object.hasOwn(row,'firstPaidVisitAt')||!Object.hasOwn(row,'lastVisitAt')||[row.firstPaidVisitAt,row.lastVisitAt].some(v=>v!==null&&!instant(v)))fail('Клиентская история некорректна или дублируется');
  if(row.firstPaidVisitAt&&Date.parse(row.firstPaidVisitAt)<Date.parse(row.createdAt)||row.lastVisitAt&&Date.parse(row.lastVisitAt)<Date.parse(row.createdAt)||row.firstPaidVisitAt&&row.lastVisitAt&&Date.parse(row.firstPaidVisitAt)>Date.parse(row.lastVisitAt))fail('Даты визитов не согласованы');
  clients.set(row.id,row);
 }
 const active=[...clients.values()].filter(r=>Date.parse(r.createdAt)<=asOf);
 const first=r=>r.firstPaidVisitAt&&Date.parse(r.firstPaidVisitAt)<=asOf?Date.parse(r.firstPaidVisitAt):null;
 // Historical recency requires actual attended visits before the cut, never today's last-visit date.
 const visits=new Map(),visitIds=new Set();
 if(snapshot.attendedVisits!==undefined){
  if(!Array.isArray(snapshot.attendedVisits))fail('История посещений некорректна');
  for(const v of snapshot.attendedVisits){
   if(!v||typeof v.id!=='string'||!v.id||visitIds.has(v.id)||!clients.has(v.clientId)||!instant(v.at)||Date.parse(v.at)<Date.parse(clients.get(v.clientId).createdAt)||Date.parse(v.at)>Date.parse(snapshot.observedThrough))fail('Посещение некорректно или дублируется');
   visitIds.add(v.id);const at=Date.parse(v.at);if(at<=asOf&&(!visits.has(v.clientId)||at>visits.get(v.clientId)))visits.set(v.clientId,at);
  }
  // A supplied complete history must contain the latest confirmed visit for every client.
  for(const r of clients.values())if(r.lastVisitAt&&!snapshot.attendedVisits.some(v=>v.clientId===r.id&&v.at===r.lastVisitAt))fail('История посещений неполная');
 }
 const historicLast=p.basis==='lastVisit'&&!Array.isArray(snapshot.attendedVisits)&&active.some(r=>r.lastVisitAt&&Date.parse(r.lastVisitAt)>asOf);
 const counts=new Map(GROUPS.map(([key])=>[key,0]));
 for(const row of active){const at=p.basis==='lastVisit'?(snapshot.attendedVisits?visits.has(row.id)?new Date(visits.get(row.id)).toISOString():null:row.lastVisitAt):(first(row)===null?null:row.firstPaidVisitAt);const key=group(at,new Date(asOf).toISOString());counts.set(key,counts.get(key)+1);}
 const newClients=active.filter(r=>first(r)!==null&&first(r)>=Date.parse(p.fromAt));
 out.newClients=metric(newClients.length);out.clients=metric(active.length);
 out.groups=GROUPS.map(([key,label])=>({key,label,count:historicLast?null:counts.get(key),percent:historicLast?null:active.length?Math.round(counts.get(key)/active.length*1000)/10:0}));
 if(historicLast)out.groupsReason='HISTORICAL_LAST_VISIT_UNAVAILABLE';
 const dates=p.mode==='month'?Array.from({length:Math.round((midnight(shiftDay(p.to,1))-midnight(p.from))/86400000)},(_,i)=>shiftDay(p.from,i)):Array.from({length:24},(_,i)=>String(i).padStart(2,'0'));
 const newCounts=new Map();for(const row of newClients){const key=p.mode==='month'?isoDay(row.firstPaidVisitAt):local(row.firstPaidVisitAt).hour;newCounts.set(key,(newCounts.get(key)||0)+1);}
 out.newSeries=dates.map(date=>({key:date,value:p.mode==='month'?(date>isoDay(asOf)?null:newCounts.get(date)||0):(+date>+local(asOf).hour?null:newCounts.get(date)||0)}));
 if(c.payments!==true||c.refunds!==true||!Array.isArray(snapshot.cash)){out.ltv.reason='CASH_HISTORY_INCOMPLETE';return out;}
 const events=[],seen=new Set();let unsafe=false;
 for(const event of snapshot.cash){
  if(!event||typeof event.id!=='string'||!event.id||seen.has(event.id)||!instant(event.at)||!['payment','refund'].includes(event.kind)||event.currency!=='RUB'||!Number.isSafeInteger(event.amountKopecks)||event.amountKopecks<=0)fail('Платёж или возврат некорректен или дублируется');
  seen.add(event.id);
  if(!clients.has(event.clientId)){unsafe=true;continue;}
  events.push({...event,atMs:Date.parse(event.at),amount:BigInt(event.amountKopecks)*(event.kind==='refund'?-1n:1n)});
 }
 if(unsafe){out.ltv.reason='CASH_CLIENT_UNMATCHED';return out;}
 function lifetime(cut){const eligible=new Set(active.filter(r=>r.firstPaidVisitAt&&Date.parse(r.firstPaidVisitAt)<=cut).map(r=>r.id));let net=0n;for(const e of events)if(e.atMs<=cut&&eligible.has(e.clientId))net+=e.amount;const n=BigInt(eligible.size);const mean=n?(net>=0n?(net+n/2n)/n:-((-net+n/2n)/n)).toString():null;return{mean,net:net.toString(),n:Number(n)};}
 const ltv=lifetime(asOf);out.ltv={...out.ltv,...metric(ltv.mean,ltv.n?null:'NO_PAYING_CLIENTS'),netKopecks:ltv.net,payingClients:ltv.n};
 out.ltvSeries=Array.from({length:12},(_,i)=>shiftMonth(p.to.slice(0,7)+'-01',i-11)).map(month=>{const cut=Math.min(asOf,midnight(shiftMonth(month,1))-1);return{key:month.slice(0,7),value:lifetime(cut).mean};});
 out.source.status=historicLast?'partial':'complete';return out;
}
module.exports={report,period,isoDay,shiftDay,shiftMonth,midnight,group};
