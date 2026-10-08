'use strict';
const crypto=require('node:crypto');
const {createRevenueAccess,company,provider,id,range,localDay,shiftDay,fail}=require('./revenue-analytics-access');
const {createRevenueAdapters}=require('./revenue-analytics-adapters');
const OFFSETS={'Asia/Irkutsk':'+08:00','Asia/Bangkok':'+07:00','Europe/Moscow':'+03:00',UTC:'Z'};
const KNOWN_ERRORS=new Set(['MISSING_ACCESS','CREDENTIAL_UNREADABLE','ACCESS_DENIED','RATE_LIMITED','UPSTREAM_ERROR','CONNECTION_UNCERTAIN','RESPONSE_TOO_LARGE','RESPONSE_UNCERTAIN','INCOMPLETE','PROFILE_CHANGED','LEASE_LOST','REVISION_CONFLICT','TOKEN_REAUTH_REQUIRED','TOKEN_REFRESH_UNCERTAIN','TOKEN_REFRESH_BUSY']);
function dateTime(v,tz) {
  if(typeof v!=='string')fail('RESPONSE_UNCERTAIN',502);
  let s=v.replace(' ','T'); if(!/(?:Z|[+-]\d{2}:?\d{2})$/.test(s))s+=OFFSETS[tz];
  const n=Date.parse(s); if(!Number.isFinite(n))fail('RESPONSE_UNCERTAIN',502); return new Date(n).toISOString();
}
function kopecks(v) {
  const s=String(v); if(!/^-?\d{1,12}(?:\.\d{1,2})?$/.test(s))fail('RESPONSE_UNCERTAIN',502);
  const [whole,fraction='']=s.replace('-','').split('.'); const result=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if(!Number.isSafeInteger(result))fail('RESPONSE_UNCERTAIN',502);return s.startsWith('-')?-result:result;
}
function attribution(url) {
  const result={}; let parsed; try {parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol))return result;}catch{return result;}
  for(const k of ['source','medium','campaign','content','term']) {
    const v=parsed.searchParams.get('utm_'+k);
    // Не сохранять случайно попавшие в метки контакты или целый адрес страницы.
    if(v && v.length<=200 && !/[@:\/?\x00-\x1f]|\d{7,}/.test(v))result[k]=v;
  }
  return result;
}
function createRevenueAnalytics(db,{apiKey,now=Date.now,adapters=createRevenueAdapters()}={}) {
  const access=createRevenueAccess(db,{apiKey,now});
  const active=new Set();let closing=false;
  db.exec('CREATE TABLE IF NOT EXISTS revenue_jobs(company TEXT NOT NULL,provider TEXT NOT NULL,lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,last_attempt TEXT,last_success TEXT,success_revision INTEGER,error_code TEXT NOT NULL DEFAULT \'\',failures INTEGER NOT NULL DEFAULT 0,history_from TEXT,PRIMARY KEY(company,provider));'+
    'CREATE TABLE IF NOT EXISTS revenue_records(company TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(company,id));'+
    'CREATE TABLE IF NOT EXISTS revenue_cash(company TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(company,id));'+
    'CREATE TABLE IF NOT EXISTS revenue_metrika(company TEXT NOT NULL,from_day TEXT NOT NULL,to_day TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,collected_at TEXT NOT NULL,PRIMARY KEY(company,from_day,to_day));');
  const stamp=()=>new Date(now()).toISOString();
  const job=(c,p)=>db.prepare('SELECT * FROM revenue_jobs WHERE company=? AND provider=?').get(c,p);
  const keyed=(c,clientId)=>clientId && Number(clientId)>0 ? crypto.createHmac('sha256',apiKey).update('revenue-client/v1/'+c+'/'+id(clientId)).digest('hex') : null;
  const readRows=(table,c)=>db.prepare('SELECT payload FROM '+table+' WHERE company=?').all(c).map(r=>JSON.parse(r.payload));
  function normalizeRecord(c,config,r) {
    if(r.company_id!==undefined && String(r.company_id)!==config.externalId)fail('PROFILE_CHANGED',502);
    if(![-1,0,1,2].includes(r.attendance) || typeof r.deleted!=='boolean')fail('RESPONSE_UNCERTAIN',502);
    return {id:id(r.id),visitId:r.visit_id&&Number(r.visit_id)>0?id(r.visit_id):null,client:keyed(c,r.client?.id),
      createdAt:dateTime(r.create_date,config.timezone),visitAt:dateTime(r.datetime||r.date,config.timezone),
      changedAt:dateTime(r.last_change_date||r.create_date,config.timezone),attendance:r.attendance,deleted:r.deleted,
      utm:attribution(r.from_url),online:r.online===true};
  }
  function normalizeCash(c,config,r) {
    if(r.company_id!==undefined && String(r.company_id)!==config.externalId)fail('PROFILE_CHANGED',502);
    return {id:id(r.id),recordId:r.record_id&&Number(r.record_id)>0?id(r.record_id):null,visitId:r.visit_id&&Number(r.visit_id)>0?id(r.visit_id):null,
      client:keyed(c,r.client?.id),at:dateTime(r.date,config.timezone),amount:kopecks(r.amount),expenseId:r.expense?.id?id(r.expense.id):null,deleted:r.deleted===true};
  }
  function status(c,p) {
    const connection=access.get(c,p),j=job(c,p);
    const successCurrent=Boolean(j?.last_success && j.success_revision===connection.revision);
    return {...connection,lastAttempt:j?.last_attempt||null,lastSuccess:j?.last_success||null,nextCheckAt:j?.next_at?new Date(j.next_at).toISOString():null,
      running:Boolean(j?.lease && j.lease_until>now()),errorCode:j?.error_code||null,
      current:successCurrent,stale:!successCurrent || now()-Date.parse(j.last_success)>(p==='metrika'?3:30)*3600000};
  }
  const settings=c=>({companyCode:company(c),providers:['metrika','yclients'].map(p=>status(c,p))});
  function save(c,p,b) {
    const result=access.save(c,p,b);
    db.prepare('INSERT INTO revenue_jobs(company,provider,next_at) VALUES(?,?,0) ON CONFLICT(company,provider) DO UPDATE SET next_at=0').run(c,p);
    return result;
  }
  async function prepareBinding(c,p) {
    let binding=access.resolve(c,p);
    if(p!=='metrika' || !binding.credential.refreshToken)return binding;
    const key=binding.credential;
    const issued=Date.parse(key.refreshedAt),expiry=Date.parse(key.expiresAt);
    const advance=Math.min(86400000,(expiry-issued)/10);
    const due=Math.min(expiry-advance,issued+90*86400000);
    if(now()<due)return binding;
    const context=access.beginRefresh(binding);
    try {
      const next=await adapters.refreshMetrika(key);
      access.finishRefresh(context,next);
    } catch(e) {
      access.abortRefresh(context,e?.code);throw e;
    }
    binding=access.resolve(c,p);
    return binding;
  }
  async function performCollect(c,p,requested=null) {
    company(c);provider(p);if(requested)range(requested.from,requested.to);
    const token=crypto.randomUUID(),at=now();
    const acquired=db.prepare('INSERT INTO revenue_jobs(company,provider,lease,lease_until,last_attempt) VALUES(?,?,?,?,?) ON CONFLICT(company,provider) DO UPDATE SET lease=excluded.lease,lease_until=excluded.lease_until,last_attempt=excluded.last_attempt WHERE revenue_jobs.lease_until<=?')
      .run(c,p,token,at+30*60*1000,stamp(),at).changes;
    if(!acquired)return {companyCode:c,provider:p,busy:true};
    const before=job(c,p);
    try {
      const binding=await prepareBinding(c,p),config=binding.config;
      const today=localDay(at,config.timezone);
      if(config.historyFrom>today)fail('BAD_PERIOD');
      let records,cash,reports=[];
      if(p==='yclients') {
        if(adapters.verifyYclients)await adapters.verifyYclients(binding);
        // Первая выгрузка — исходная история; после неё перекрываем изменения на три дня.
        const initial=!before.last_success || before.history_from!==config.historyFrom;
        const since=initial ? config.historyFrom : new Date(Math.max(Date.parse(config.historyFrom),Date.parse(before.last_success)-3*86400000)).toISOString();
        records=await adapters.ycPages('/api/v1/records/'+config.externalId,{changed_after:since,changed_before:new Date(at).toISOString(),with_deleted:1,include_finance_transactions:0},binding.credential,r=>normalizeRecord(c,config,r));
        // Полный перечень активных реальных денежных операций: исчезнувшие/удалённые
        // операции не остаются доходом после атомарной замены. Услуги/цены не являются оплатой.
        cash=await adapters.ycPages('/api/v1/transactions/'+config.externalId,{start_date:config.historyFrom,end_date:today,real_money:1,deleted:0},binding.credential,r=>normalizeCash(c,config,r));
        const known=new Set([...readRows('revenue_records',c),...records].map(r=>r.id));
        const missing=[...new Set(cash.map(t=>t.recordId).filter(v=>v&&!known.has(v)))];
        if(missing.length>100)fail('INCOMPLETE',502);
        for(const rid of missing) {
          let b;
          try{b=await adapters.json(new URL('/api/v1/record/'+config.externalId+'/'+rid,'https://api.yclients.ru'),adapters.ycHeaders(binding.credential));}
          catch(e){if(e.code==='NOT_FOUND')continue;throw e;}
          if(b.success!==true||!b.data||String(b.data.id)!==rid)fail('RESPONSE_UNCERTAIN',502);
          records.push(normalizeRecord(c,config,b.data));
        }
      } else {
        const periods=requested?[requested]:[{from:today,to:today},{from:shiftDay(today,-6),to:today},{from:shiftDay(today,-29),to:today},{from:config.historyFrom,to:today}];
        const seen=new Set();
        for(const r of periods) {
          const clipped={from:r.from,to:r.to};range(clipped.from,clipped.to);
          const key=clipped.from+'/'+clipped.to;if(seen.has(key))continue;seen.add(key);
          reports.push({r:clipped,payload:await adapters.metrika(binding,clipped)});
        }
      }
      // Никаких await внутри транзакции: проверка ревизии/аренды и запись одного поколения.
      db.exec('BEGIN IMMEDIATE');
      try {
        if(access.get(c,p).revision!==binding.revision || !access.get(c,p).enabled)fail('REVISION_CONFLICT',409);
        const j=job(c,p);if(j.lease!==token||j.lease_until<=now())fail('LEASE_LOST',409);
        if(p==='yclients') {
          if(!before.last_success || before.history_from!==config.historyFrom)db.prepare('DELETE FROM revenue_records WHERE company=?').run(c);
          const insert=db.prepare('INSERT INTO revenue_records VALUES(?,?,?) ON CONFLICT(company,id) DO UPDATE SET payload=excluded.payload');
          for(const r of records)insert.run(c,r.id,JSON.stringify(r));
          db.prepare('DELETE FROM revenue_cash WHERE company=?').run(c);
          const add=db.prepare('INSERT INTO revenue_cash VALUES(?,?,?)');for(const t of cash)add.run(c,t.id,JSON.stringify(t));
        } else {
          const add=db.prepare('INSERT INTO revenue_metrika VALUES(?,?,?,?,?,?) ON CONFLICT(company,from_day,to_day) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,collected_at=excluded.collected_at');
          for(const r of reports)add.run(c,r.r.from,r.r.to,binding.revision,JSON.stringify(r.payload),stamp());
          db.prepare('DELETE FROM revenue_metrika WHERE company=? AND collected_at<?').run(c,new Date(now()-90*86400000).toISOString());
        }
        db.prepare('UPDATE revenue_jobs SET lease=NULL,lease_until=0,last_success=?,success_revision=?,next_at=?,error_code=\'\',failures=0,history_from=? WHERE company=? AND provider=? AND lease=?')
          .run(stamp(),binding.revision,now()+(p==='metrika'?3600000:86400000),config.historyFrom,c,p,token);
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
      return {companyCode:c,provider:p,collected:true,status:status(c,p)};
    }catch(e) {
      const error=KNOWN_ERRORS.has(e?.code)?e.code:'COLLECTION_FAILED';const n=Math.min(6,(job(c,p)?.failures||0)+1);
      db.prepare('UPDATE revenue_jobs SET lease=NULL,lease_until=0,error_code=?,failures=?,next_at=? WHERE company=? AND provider=? AND lease=?')
        .run(error,n,now()+Math.min(3600000,60000*2**n),c,p,token);
      // Не журналировать ответ API, URL с секретом или объект исключения fetch.
      return {companyCode:c,provider:p,collected:false,errorCode:error,status:status(c,p)};
    }
  }
  function collect(c,p,requested=null) {
    if(closing)return Promise.reject(Object.assign(new Error('SERVER_STOPPING'),{code:'SERVER_STOPPING'}));
    const work=performCollect(c,p,requested);active.add(work);
    work.then(()=>active.delete(work),()=>active.delete(work));return work;
  }
  let inFlight=null;
  function collectDue() {
    if(closing)return Promise.resolve([]);
    if(inFlight)return inFlight;
    inFlight=(async()=>{
      const results=[];for(const b of access.list()) { if(closing)break;const j=job(b.companyCode,b.provider);if(j?.next_at>now()||j?.lease_until>now())continue;results.push(await collect(b.companyCode,b.provider)); }
      return results;
    })().finally(()=>{inFlight=null;});return inFlight;
  }
  function report(c,from,to) {
    company(c);const period=range(from,to),state=settings(c);
    const yc=state.providers.find(p=>p.provider==='yclients');const mc=state.providers.find(p=>p.provider==='metrika');
    const m=db.prepare('SELECT * FROM revenue_metrika WHERE company=? AND from_day=? AND to_day=?').get(c,from,to);
    const sourceKey=u=>u.source?JSON.stringify([u.source,u.medium||'',u.campaign||'',u.content||'',u.term||'']):'unknown';
    const groups=new Map();
    const group=u=>{const key=sourceKey(u);if(!groups.has(key))groups.set(key,{utm:u.source?u:null,bookings:0,attendedVisits:0,paymentKopecks:0,refundKopecks:0,payingClients:new Set()});return groups.get(key);};
    let yclients=null;
    if(yc.lastSuccess) {
      const config=yc.config;const r=readRows('revenue_records',c);const tx=readRows('revenue_cash',c);const byId=new Map(r.map(v=>[v.id,v]));
      const historyFrom=job(c,'yclients').history_from||config.historyFrom;
      const byVisit=new Map();for(const v of r)if(v.visitId){const a=byVisit.get(v.visitId)||[];a.push(v);byVisit.set(v.visitId,a);}
      const inside=at=>{const d=localDay(Date.parse(at),config.timezone);return d>=from&&d<=to;};
      const stats={createdBookings:0,activeBookings:0,cancelledBookings:0,noShows:0,attendedVisits:0,paymentKopecks:0,refundKopecks:0,netCashKopecks:0,payingClients:0,unknownExpenseTransactions:0,unmatchedTransactions:0,bookingsWithSource:0,bookingsWithoutSource:0,clientIdentityMissing:0};
      const attended=new Map(),paying=new Set();
      for(const v of r) {
        if(inside(v.createdAt)){stats.createdBookings++;if(v.deleted)stats.cancelledBookings++;else stats.activeBookings++;
          if(v.utm.source)stats.bookingsWithSource++;else stats.bookingsWithoutSource++;group(v.utm).bookings++;}
        if(!v.deleted && inside(v.visitAt)) {
          if(v.attendance===-1)stats.noShows++;
          const key=v.visitId||'record:'+v.id;
          if(v.attendance===1){const entries=attended.get(key)||[];entries.push(v.utm);attended.set(key,entries);}
        }
      }
      for(const entries of attended.values()){stats.attendedVisits++;const keys=new Set(entries.map(sourceKey));group(keys.size===1?entries[0]:{}).attendedVisits++;}
      const rules=new Map(config.cashRules.map(v=>[v.expenseId,v.kind]));
      for(const t of tx) {
        if(t.deleted||!inside(t.at))continue;const rule=rules.get(t.expenseId);
        if(!rule){stats.unknownExpenseTransactions++;continue;}if(rule==='exclude')continue;
        const amount=rule==='payment'?Math.abs(t.amount):rule==='refund'?-Math.abs(t.amount):t.amount;
        let record=t.recordId?byId.get(t.recordId):null;
        if(!record && !t.recordId && t.visitId && byVisit.get(t.visitId)?.length===1)record=byVisit.get(t.visitId)[0];
        if(record && ((t.visitId&&record.visitId&&t.visitId!==record.visitId)||(t.client&&record.client&&t.client!==record.client)))record=null;
        if(!record)stats.unmatchedTransactions++;
        const g=group(record?.utm||{}),client=t.client||record?.client;
        if(amount>0){stats.paymentKopecks+=amount;g.paymentKopecks+=amount;if(client){paying.add(client);g.payingClients.add(client);}else stats.clientIdentityMissing++;}
        else{stats.refundKopecks-=amount;g.refundKopecks-=amount;}
      }
      stats.netCashKopecks=stats.paymentKopecks-stats.refundKopecks;stats.payingClients=paying.size;
      yclients={...stats,historyFrom,partialHistory:from<historyFrom,currency:'RUB',sources:[...groups.values()].map(g=>({...g,payingClients:g.payingClients.size,netCashKopecks:g.paymentKopecks-g.refundKopecks})),
        financialClassificationComplete:stats.unknownExpenseTransactions===0 && config.cashRules.length>0,
        sourceCoveragePercent:stats.createdBookings?100*stats.bookingsWithSource/stats.createdBookings:null};
    }
    return {companyCode:c,period,state,metrika:m?{...JSON.parse(m.payload),collectedAt:m.collected_at,current:m.revision===mc.revision}:null,yclients,
      economics:{cac:null,romi:null,reason:'Расходы, первичные клиенты за всю историю и себестоимость ещё не подтверждены.'},
      definitions:{bookings:'Дата создания записи; отмены отдельно.',visits:'Фактическое посещение по дате визита; один visit_id считается один раз.',cash:'Реальные деньги по дате транзакции, с вычетом возвратов; неизвестные статьи не считаются доходом.',attribution:'UTM из from_url конкретной записи. Неизвестный источник не назначается рекламе. Итоги Метрики не связывают человека с оплатой сами по себе.'}};
  }
  async function stop(){closing=true;adapters.stop?.();await Promise.allSettled([...active,...(inFlight?[inFlight]:[])]);}
  return {access,settings,save,status,collect,collectDue,report,stop};
}
module.exports={createRevenueAnalytics,dateTime,kopecks,attribution};
