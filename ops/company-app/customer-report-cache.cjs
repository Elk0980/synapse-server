'use strict';
const crypto=require('node:crypto'),R=require('./customer-reports.cjs'),A=require('./customer-report-aggregates.cjs');
const companies=['alvi','avokado'];
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const object=v=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v)));
function fields(value,allowed){if(!object(value)||Object.keys(value).some(k=>!allowed.includes(k)))fail(400,'Неизвестные поля источника');}
const time=s=>typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===(s.includes('.')?s:s.slice(0,-1)+'.000Z');
const id=s=>typeof s==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(s);
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(object(value))return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const unique=rows=>{const ids=new Set();for(const r of rows){if(ids.has(r.id))fail(400,'Источник содержит повторные записи');ids.add(r.id);}};
function checkedSnapshot(company,snapshot,now){
 if(!companies.includes(company))fail(400,'Неизвестная компания отчёта');
 fields(snapshot,['contract','companyCode','branchId','source','capturedAt','observedThrough','coverage','clients','cash','attendedVisits','periods','proofs','metric_source_verified_at']);
 if(snapshot.companyCode!==company||snapshot.branchId!==A.branches[company]||!time(snapshot.capturedAt)||!time(snapshot.observedThrough)||Date.parse(snapshot.observedThrough)>Date.parse(snapshot.capturedAt)||Date.parse(snapshot.capturedAt)>Date.parse(now))fail(400,'Источник не относится к выбранному филиалу или времени');
 if(snapshot.proofs!==undefined&&(!Array.isArray(snapshot.proofs)||snapshot.proofs.length>10||snapshot.proofs.some(p=>typeof p!=='string'||p.length>256||/[\u0000-\u001f]/.test(p))))fail(400,'Некорректная ссылка доказательства');
 if(snapshot.metric_source_verified_at!==undefined){fields(snapshot.metric_source_verified_at,['overview','recency','daily_series']);for(const at of Object.values(snapshot.metric_source_verified_at))if(!time(at)||Date.parse(at)>Date.parse(snapshot.capturedAt))fail(400,'Некорректная дата показателя');}
 if(snapshot.contract==='salon-client-aggregates/v1'){
  if(snapshot.source!=='yclients-ui'||!Array.isArray(snapshot.periods)||snapshot.periods.length>5000||snapshot.cash!==undefined||snapshot.attendedVisits!==undefined||snapshot.coverage!==undefined)fail(400,'Некорректный агрегатный источник');
  snapshot.periods.forEach(row=>fields(row,['from','to','newClients']));
  if(snapshot.clients){fields(snapshot.clients,['asOfDay','total','groups']);if(!Array.isArray(snapshot.clients.groups))fail(400,'Группы клиентов не получены');snapshot.clients.groups.forEach(g=>fields(g,['key','count']));}
 }else if(snapshot.contract==='salon-client-history/v1'){
  if(snapshot.source!=='yclients'||snapshot.periods!==undefined)fail(400,'Некорректная история источника');
  fields(snapshot.coverage,['clients','visits','lifetimeHistory','payments','refunds']);
  if(Object.values(snapshot.coverage).some(v=>typeof v!=='boolean')||!Array.isArray(snapshot.clients)||snapshot.clients.length>250000)fail(400,'Некорректное покрытие истории');
  snapshot.clients.forEach(c=>{fields(c,['id','createdAt','firstPaidVisitAt','lastVisitAt']);if(!id(c.id)||!time(c.createdAt)||[c.firstPaidVisitAt,c.lastVisitAt].some(at=>at!==null&&!time(at)))fail(400,'Некорректная клиентская история');});
  unique(snapshot.clients);
  if(snapshot.cash!==undefined){if(!Array.isArray(snapshot.cash)||snapshot.cash.length>250000)fail(400,'Слишком много финансовых операций');snapshot.cash.forEach(c=>{fields(c,['id','clientId','at','kind','amountKopecks','currency']);if(!id(c.id)||!id(c.clientId)||!time(c.at)||!['payment','refund'].includes(c.kind)||!Number.isSafeInteger(c.amountKopecks)||c.amountKopecks<=0||c.currency!=='RUB')fail(400,'Некорректная финансовая операция');});}
  if(snapshot.attendedVisits!==undefined){if(!Array.isArray(snapshot.attendedVisits)||snapshot.attendedVisits.length>250000)fail(400,'Слишком много посещений');snapshot.attendedVisits.forEach(v=>{fields(v,['id','clientId','at']);if(!id(v.id)||!id(v.clientId)||!time(v.at))fail(400,'Некорректное посещение');});}
  if(snapshot.cash)unique(snapshot.cash);if(snapshot.attendedVisits)unique(snapshot.attendedVisits);
 }else fail(400,'Неизвестный контракт источника');
 const body=JSON.stringify(canonical(snapshot));if(Buffer.byteLength(body)>32*1024*1024)fail(413,'Источник слишком большой');
 const calculate=snapshot.contract==='salon-client-aggregates/v1'?A.report:R.report;
 // Validate the observed month, including old imports. Checking only the current
 // month would return early and fail to inspect an older snapshot's contents.
 calculate({companyCode:company,query:{month:R.isoDay(snapshot.observedThrough).slice(0,7)},snapshot,now});
 return {body,sha256:hash(body),capturedAt:snapshot.capturedAt};
}
// Internal private cache. No external service, authentication, notification or
// existing application table is touched by this module. The host supplies the DB.
function createCache(db,{clock=()=>new Date().toISOString()}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS salon_report_cache_v1(company TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL,sha256 TEXT NOT NULL,captured_at TEXT NOT NULL,received_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS salon_report_history_v1(company TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,sha256 TEXT NOT NULL,captured_at TEXT NOT NULL,received_at TEXT NOT NULL,PRIMARY KEY(company,revision));
 CREATE TABLE IF NOT EXISTS salon_report_import_v1(actor_id TEXT NOT NULL,request_id TEXT NOT NULL,request_sha TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(actor_id,request_id));`);
 const latest=db.prepare('SELECT * FROM salon_report_cache_v1 WHERE company=?');
 return Object.freeze({
  read(company){if(!companies.includes(company))fail(403,'Компания недоступна');const row=latest.get(company);return row?JSON.parse(row.body):null;},
  metadata(company){if(!companies.includes(company))fail(403,'Компания недоступна');const r=latest.get(company);return r?{companyCode:company,revision:r.revision,sha256:r.sha256,capturedAt:r.captured_at,receivedAt:r.received_at}:null;},
  receipt(actorId,requestId){if(!id(String(actorId??''))||!id(requestId))fail(400,'Некорректный ключ обновления');const row=db.prepare('SELECT receipt FROM salon_report_import_v1 WHERE actor_id=? AND request_id=?').get(String(actorId),requestId);return row?JSON.parse(row.receipt):null;},
  publish(entries,{actorId,requestId,beforeCommit=()=>{}}={}){
   if(!id(String(actorId??''))||!id(requestId)||!Array.isArray(entries)||!entries.length||entries.length>2)fail(400,'Нужны актор, ключ запроса и источники');
   const now=clock(),seen=new Set();if(!time(now))fail(503,'Время сервера не подтверждено');
   const checked=entries.map(e=>{fields(e,['companyCode','expectedRevision','snapshot']);if(seen.has(e.companyCode)||!Number.isSafeInteger(e.expectedRevision)||e.expectedRevision<0)fail(400,'Компания повторена или версия некорректна');seen.add(e.companyCode);return{...e,...checkedSnapshot(e.companyCode,e.snapshot,now)};}).sort((a,b)=>a.companyCode.localeCompare(b.companyCode));
   const requestSha=hash(JSON.stringify(checked.map(e=>({companyCode:e.companyCode,expectedRevision:e.expectedRevision,sha256:e.sha256}))));
   db.exec('BEGIN IMMEDIATE');
   try{
    const previous=db.prepare('SELECT * FROM salon_report_import_v1 WHERE actor_id=? AND request_id=?').get(String(actorId),requestId);
    if(previous){if(previous.request_sha!==requestSha)fail(409,'Этот ключ уже использован для другого источника');beforeCommit();db.exec('COMMIT');return{...JSON.parse(previous.receipt),replayed:true};}
    const plans=checked.map(e=>{const old=latest.get(e.companyCode);if((old?.revision||0)!==e.expectedRevision)fail(409,'Отчёт уже обновлён другим запуском');if(old&&Date.parse(e.capturedAt)<Date.parse(old.captured_at))fail(409,'Источник старее сохранённого отчёта');return{...e,changed:old?.sha256!==e.sha256,revision:(old?.revision||0)+(old?.sha256===e.sha256?0:1)};});
    beforeCommit(); // The native host rechecks current session/company/CSRF here.
    for(const p of plans)if(p.changed){const args=[p.companyCode,p.revision,p.body,p.sha256,p.capturedAt,now];db.prepare('INSERT INTO salon_report_cache_v1 VALUES(?,?,?,?,?,?) ON CONFLICT(company) DO UPDATE SET revision=excluded.revision,body=excluded.body,sha256=excluded.sha256,captured_at=excluded.captured_at,received_at=excluded.received_at').run(...args);db.prepare('INSERT INTO salon_report_history_v1 VALUES(?,?,?,?,?,?)').run(...args);}
    const receipt={contract:'salon-report-import-receipt/v1',receivedAt:now,companies:plans.map(p=>({companyCode:p.companyCode,revision:p.revision,sha256:p.sha256,capturedAt:p.capturedAt,changed:p.changed})),notificationSent:false};
    db.prepare('INSERT INTO salon_report_import_v1 VALUES(?,?,?,?)').run(String(actorId),requestId,requestSha,JSON.stringify(receipt));db.exec('COMMIT');return receipt;
   }catch(error){db.exec('ROLLBACK');throw error;}
  }
 });
}
module.exports={createCache,checkedSnapshot};
