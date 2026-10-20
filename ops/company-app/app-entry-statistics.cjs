'use strict';
const {labels}=require('./app-entry-source.js');
const {period,isoDay,shiftDay}=require('./customer-reports.cjs');
const sources=Object.keys(labels),companies=['palitra-love','alvi','avokado'];
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const validTime=s=>typeof s==='string'&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s;
// Own table only. Call from a reviewed migration against the native DB; constructing
// this module does not open a DB or install a collector. No identity/IP/URL is saved.
function createStore(db,{enabledAt,clock=()=>new Date().toISOString()}={}){
 db.exec('CREATE TABLE IF NOT EXISTS app_entry_collection_v1 (key TEXT PRIMARY KEY, enabled_at TEXT NOT NULL)');
 const saved=db.prepare("SELECT enabled_at FROM app_entry_collection_v1 WHERE key='start'").get();
 if(saved){if(enabledAt&&enabledAt!==saved.enabled_at)throw new TypeError('Дата начала сбора не меняется при перезапуске');enabledAt=saved.enabled_at;}
 if(!validTime(enabledAt))throw new TypeError('Нужна фактическая дата начала сбора');
 if(!saved)db.prepare("INSERT INTO app_entry_collection_v1(key,enabled_at) VALUES('start',?)").run(enabledAt);
 db.exec(`CREATE TABLE IF NOT EXISTS app_entry_events_v1 (
  company TEXT NOT NULL CHECK(company IN ('palitra-love','alvi','avokado')),
  event_id TEXT NOT NULL, source TEXT NOT NULL, evidence TEXT NOT NULL,
  received_at TEXT NOT NULL, PRIMARY KEY(company,event_id)
 ); CREATE INDEX IF NOT EXISTS app_entry_events_v1_period ON app_entry_events_v1(company,received_at);`);
 const insert=db.prepare('INSERT OR IGNORE INTO app_entry_events_v1(company,event_id,source,evidence,received_at) VALUES(?,?,?,?,?)');
 return Object.freeze({
  record(company,body){
   if(!companies.includes(company)||!body||Array.isArray(body)||Object.keys(body).some(k=>!['eventId','source','evidence'].includes(k))||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.eventId||'')||!sources.includes(body.source)||!['link_tag','referrer','unavailable','ambiguous_tag'].includes(body.evidence)||['unavailable','ambiguous_tag'].includes(body.evidence)&&body.source!=='unknown')fail(400,'Некорректный вход в приложение');
   const at=clock();if(!validTime(at)||at<enabledAt)fail(503,'Сбор статистики ещё не начался');
   return {recorded:insert.run(company,body.eventId,body.source,body.evidence,at).changes===1};
  },
  read(company,query={},now=clock()){
   if(!companies.includes(company))fail(403,'Компания недоступна');
   const p=period(query,now),full=enabledAt<=p.fromAt,observed=Date.parse(now)>=Date.parse(p.fromAt)&&enabledAt<p.untilAt;
   const rows=db.prepare('SELECT source,COUNT(*) AS entrances FROM app_entry_events_v1 WHERE company=? AND received_at>=? AND received_at<? AND received_at<=? GROUP BY source').all(company,p.fromAt,p.untilAt,now);
   const total=rows.reduce((n,r)=>n+r.entrances,0),count=new Map(rows.map(r=>[r.source,r.entrances]));
   const byDay=db.prepare('SELECT received_at FROM app_entry_events_v1 WHERE company=? AND received_at>=? AND received_at<? AND received_at<=?').all(company,p.fromAt,p.untilAt,now),days=new Map();
   for(const r of byDay){const key=isoDay(r.received_at);days.set(key,(days.get(key)||0)+1);}
   const availableDay=isoDay(now),startDay=isoDay(enabledAt);
   return {contract:'app-entry-statistics/v1',companyCode:company,period:p,enabledAt,updatedAt:now,status:!observed?'unobserved':full?'complete':'partial',metric:'entrances',total:observed?total:null,
    sources:sources.map(key=>({key,label:labels[key],count:observed?count.get(key)||0:null,percent:observed?(total?Math.round((count.get(key)||0)/total*1000)/10:0):null})),
    series:p.mode==='month'?Array.from({length:Number(p.to.slice(-2))},(_,i)=>{const key=shiftDay(p.from,i);return{key,value:key<startDay||key>availableDay?null:days.get(key)||0};}):[],
    definition:'Входы в приложение по метке ссылки или доступному источнику перехода. Это не число людей, записей или оплат.'};
  }
 });
}
// Public ingestion must receive a company resolved by the trusted host/route,
// with an exact allowed Origin and a functioning rate limiter before body read.
async function collect({request,company,allowedOrigin,rateLimit,readJson,store,reply}){
 if(!companies.includes(company)||!allowedOrigin||request.headers.origin!==allowedOrigin)fail(403,'Источник входа не подтверждён');
 if(request.method!=='POST')fail(405,'Метод не поддерживается');
 if(typeof rateLimit!=='function'||!rateLimit(request))fail(429,'Слишком много запросов');
 const result=store.record(company,await readJson(request,{maxBytes:512}));reply(202,result,{'cache-control':'no-store'});
}
module.exports={createStore,collect};
