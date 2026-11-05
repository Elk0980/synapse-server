'use strict';
const crypto = require('node:crypto');
const COMPANY = 'palitra-love', SITE = 'palitra', SCHEMA = 'palitra-attribution/v1';
const UTM_FIELDS = Object.freeze(['utm_source','utm_medium','utm_campaign','utm_content','utm_term']);
const SOURCES = Object.freeze(['vk','telegram','instagram','youtube','tiktok','other','unknown']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROOF = /^[0-9a-f]{64}$/i;
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{64}$/i;
const TTL = 30*86400000;
const TABLES = Object.freeze({
  palitra_attribution_meta_v1: `CREATE TABLE IF NOT EXISTS palitra_attribution_meta_v1 (company_code TEXT PRIMARY KEY CHECK(company_code='palitra-love'),started_at TEXT NOT NULL) WITHOUT ROWID`,
  palitra_attribution_visits_v1: `CREATE TABLE IF NOT EXISTS palitra_attribution_visits_v1 (company_code TEXT NOT NULL CHECK(company_code='palitra-love'),visit_hash TEXT NOT NULL,origin TEXT NOT NULL,proof_hash TEXT NOT NULL UNIQUE,first_json TEXT NOT NULL,last_json TEXT NOT NULL,previous_hash TEXT,created_at TEXT NOT NULL,PRIMARY KEY(company_code,visit_hash)) WITHOUT ROWID`,
  palitra_attribution_leads_v1: `CREATE TABLE IF NOT EXISTS palitra_attribution_leads_v1 (company_code TEXT NOT NULL CHECK(company_code='palitra-love'),target_kind TEXT NOT NULL CHECK(target_kind IN ('order','thread','legacy')),target_id INTEGER NOT NULL CHECK(target_id>0),entry_kind TEXT NOT NULL CHECK(entry_kind IN ('site_order','site_chat','telegram')),first_json TEXT,last_json TEXT,visit_hash TEXT,created_at TEXT NOT NULL,PRIMARY KEY(company_code,target_kind,target_id)) WITHOUT ROWID`,
  palitra_attribution_pending_v1: `CREATE TABLE IF NOT EXISTS palitra_attribution_pending_v1 (company_code TEXT NOT NULL CHECK(company_code='palitra-love'),thread_id INTEGER NOT NULL CHECK(thread_id>0),visit_hash TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(company_code,thread_id)) WITHOUT ROWID`
});
// Only the client-generated random proof HASH is stored. Lost-response retries present
// the same nonce and recover the same receipt. This is never an identity or access grant.
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const positive = n => Number.isSafeInteger(n)&&n>0;
const object = x => x!==null&&typeof x==='object'&&!Array.isArray(x);
const fail = (status,code,message) => { throw Object.assign(new Error(message),{status,code}); };
const normalized = sql => sql.replace(/\bIF\s+NOT\s+EXISTS\s+/i,'').replace(/\s+/g,'').toLowerCase();
function ready(db) {
  for(const [name,sql] of Object.entries(TABLES)) {
    const row=db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(name);
    if(!row) fail(503,'ATTRIBUTION_NOT_READY','Учёт источников ещё не запущен');
    if(normalized(row.sql)!==normalized(sql)) fail(503,'ATTRIBUTION_SCHEMA','Учёт источников временно недоступен');
  }
  const meta=db.prepare('SELECT started_at FROM palitra_attribution_meta_v1 WHERE company_code=?').get(COMPANY);
  if(!meta||!Number.isFinite(Date.parse(meta.started_at))) fail(503,'ATTRIBUTION_NOT_READY','Учёт источников ещё не запущен');
  return meta.started_at;
}
// Explicit local installer primitive ONLY. No request, factory, read, callback, or tracker calls this.
function initializeAttributionSchema(db,{now=Date.now}={}) {
  const at=new Date(now()).toISOString();
  db.exec('SAVEPOINT palitra_attribution_install_v1');
  try {
    for(const sql of Object.values(TABLES)) db.exec(sql);
    db.prepare('INSERT OR IGNORE INTO palitra_attribution_meta_v1(company_code,started_at) VALUES(?,?)').run(COMPANY,at);
    const startedAt=ready(db);db.exec('RELEASE palitra_attribution_install_v1');
    return {schema:SCHEMA,startedAt,businessRowsChanged:0};
  } catch(e) {db.exec('ROLLBACK TO palitra_attribution_install_v1');db.exec('RELEASE palitra_attribution_install_v1');throw e;}
}
function cleanUtm(value,{strict=true}={}) {
  if(!object(value)) {if(strict) fail(400,'ATTRIBUTION_UTM','Некорректные метки источника');return {};}
  if(strict&&Object.keys(value).some(k=>!UTM_FIELDS.includes(k))) fail(400,'ATTRIBUTION_UTM','Лишние метки источника');
  const out={};
  for(const key of UTM_FIELDS) {
    if(!Object.hasOwn(value,key))continue;
    const v=value[key];
    const phoneLike=typeof v==='string'&&/^\+?[\d\s().-]+$/.test(v.trim())&&v.replace(/\D/g,'').length>=10&&v.replace(/\D/g,'').length<=15;
    const valid=typeof v==='string'&&v.length<=200&&!/[\x00-\x1f\x7f<>@]|(?:https?:|www\.|\/\/)/i.test(v)&&!phoneLike;
    if(!valid) {if(strict) fail(400,'ATTRIBUTION_UTM','Некорректная метка источника');continue;}
    if(v.trim())out[key]=v.trim();
  }
  return out;
}
function trafficSource(utm) {
  const s=String(utm.utm_source||'').trim().toLowerCase();if(!s)return null;
  if(['vk','vkontakte','vkads','вконтакте'].includes(s))return 'vk';
  if(['tg','telegram','t.me'].includes(s))return 'telegram';
  if(['ig','insta','instagram'].includes(s))return 'instagram';
  if(['yt','youtube'].includes(s))return 'youtube';
  if(['tt','tiktok','tik_tok','tik-tok'].includes(s))return 'tiktok';
  return 'other';
}
const touch = utm => ({trafficSource:trafficSource(utm),utm});
const parseJson = s => {try{return JSON.parse(s);}catch{return null;}};
function createPalitraAttribution({db,transaction,getUser,canAccess,origins,now=Date.now,randomBytes=crypto.randomBytes,rate={}}={}) {
  if(!db||typeof transaction!=='function'||typeof getUser!=='function'||typeof canAccess!=='function'||!Array.isArray(origins)||!origins.length||origins.some(x=>typeof x!=='string'||new URL(x).origin!==x||!x.startsWith('https://')))
    throw new TypeError('Existing Palitra transaction, authentication and exact origins required');
  const originSet=new Set(origins),buckets=new Map(),salt=randomBytes(32);
  const windowMs=rate.windowMs??60000,limit=rate.limit??30,maxKeys=rate.maxKeys??4096;
  if(![windowMs,limit,maxKeys].every(positive))throw new TypeError('Bounded rate limits required');
  function clock(){const n=now();if(!Number.isSafeInteger(n)||n<0)fail(503,'ATTRIBUTION_CLOCK','Учёт источников временно недоступен');return n;}
  const stamp=()=>new Date(clock()).toISOString();
  function authorize(who){
    const u=object(who)&&positive(who.id)&&Number.isSafeInteger(who.sessionVersion)?getUser(who.id):null;
    if(!u||u.id!==who.id||u.sessionVersion!==who.sessionVersion||canAccess(u,'crm.view')!==true)fail(403,'ATTRIBUTION_ACCESS','Нет доступа к статистике Палитры');
    return u.id;
  }
  function originOf(origin){if(!originSet.has(origin))fail(403,'ATTRIBUTION_ORIGIN','Запрос с этого адреса не принимается');return origin;}
  function rateCheck(ip) {
    const at=clock();for(const [k,v]of buckets)if(at-v.at>=windowMs)buckets.delete(k);
    const key=crypto.createHmac('sha256',salt).update(String(ip||'unknown').slice(0,128)).digest('hex');
    const b=buckets.get(key);
    if(!b&&buckets.size>=maxKeys||b&&b.n>=limit)fail(429,'ATTRIBUTION_RATE','Слишком много запросов');
    buckets.set(key,{at:b?.at??at,n:(b?.n??0)+1});
  }
  function receipt(token,origin,{fresh=true}={}) {
    if(typeof token!=='string'||!TOKEN.test(token))return null;
    const [id,proof]=token.toLowerCase().split('.');
    const row=db.prepare('SELECT * FROM palitra_attribution_visits_v1 WHERE company_code=? AND visit_hash=? AND proof_hash=? AND origin=?').get(COMPANY,hash(id),hash(proof),origin);
    if(!row||fresh&&(clock()-Date.parse(row.created_at)>TTL||Date.parse(row.created_at)>clock()))return null;
    return row;
  }
  function visit({origin,ip,body}) {
    originOf(origin);ready(db);
    if(!object(body)||Object.keys(body).some(k=>!['visitId','visitProof','utm','consent','previousToken'].includes(k))||typeof body.visitId!=='string'||!UUID.test(body.visitId)||typeof body.visitProof!=='string'||!PROOF.test(body.visitProof)||body.consent!=='accepted'||!Object.hasOwn(body,'utm')
      ||Object.hasOwn(body,'previousToken')&&(typeof body.previousToken!=='string'||!TOKEN.test(body.previousToken)))fail(400,'ATTRIBUTION_VISIT','Некорректное событие перехода');
    const utm=cleanUtm(body.utm),last=touch(utm),visitHash=hash(body.visitId.toLowerCase());
    rateCheck(ip); // Memory only, including retries; restart never writes rate/IP metadata.
    return transaction(()=>{
      ready(db);const prior=receipt(body.previousToken,origin),priorForRetry=receipt(body.previousToken,origin,{fresh:false}),previousHash=priorForRetry?.visit_hash??null;
      const existing=db.prepare('SELECT * FROM palitra_attribution_visits_v1 WHERE company_code=? AND visit_hash=?').get(COMPANY,visitHash);
      const lastJson=JSON.stringify(last);
      if(existing){
        if(existing.origin!==origin||existing.proof_hash!==hash(body.visitProof.toLowerCase())||existing.last_json!==lastJson||existing.previous_hash!==previousHash)fail(409,'ATTRIBUTION_VISIT_MISMATCH','Этот переход уже записан с другими метками');
        return {ok:true,visitToken:body.visitId.toLowerCase()+'.'+body.visitProof.toLowerCase(),duplicate:true};
      }
      if(db.prepare('SELECT 1 n FROM palitra_attribution_visits_v1 WHERE proof_hash=?').get(hash(body.visitProof.toLowerCase())))fail(409,'ATTRIBUTION_VISIT_MISMATCH','Метка перехода уже использована');
      const token=body.visitId.toLowerCase()+'.'+body.visitProof.toLowerCase();
      db.prepare('INSERT INTO palitra_attribution_visits_v1 VALUES(?,?,?,?,?,?,?,?)').run(COMPANY,visitHash,origin,hash(body.visitProof.toLowerCase()),prior?.first_json??lastJson,lastJson,previousHash,stamp());
      return {ok:true,visitToken:token,duplicate:false};
    });
  }
  function atomic(){if(db.isTransaction!==true)throw new Error('Attribution must share the accepted business transaction');ready(db);}
  function saveLead({kind,id,entryKind,last=null,first=null,visitHash=null,createdAt}) {
    const startedAt=ready(db);if(Date.parse(createdAt)<Date.parse(startedAt))return false;
    return Number(db.prepare('INSERT OR IGNORE INTO palitra_attribution_leads_v1 VALUES(?,?,?,?,?,?,?,?)')
      .run(COMPANY,kind,id,entryKind,first?JSON.stringify(first):null,last?JSON.stringify(last):null,visitHash,createdAt).changes)>0;
  }
  function recordOrder({orderId,origin,token}={}) {
    atomic();if(!positive(orderId))throw new TypeError('Accepted order required');
    const o=db.prepare('SELECT * FROM site_orders WHERE id=? AND site=? AND company_code=?').get(orderId,SITE,COMPANY);if(!o)fail(409,'ATTRIBUTION_TARGET','Принятая заявка не найдена');
    const v=originSet.has(origin)?receipt(token,origin):null,utm=cleanUtm(parseJson(o.utm_json),{strict:false});
    // The accepted form may carry a newer URL campaign than its retained visit receipt.
    // Keep that actual current form fact rather than silently substituting an older touch.
    return saveLead({kind:'order',id:o.id,entryKind:'site_order',first:v?parseJson(v.first_json):null,last:Object.keys(utm).length?touch(utm):(v?parseJson(v.last_json):null),visitHash:v?.visit_hash??null,createdAt:o.created_at});
  }
  function rememberThread({thread,origin,token}={}) {
    if(!thread||thread.site!==SITE||thread.company_code!==COMPANY)return false;atomic();
    const t=db.prepare('SELECT id,order_id FROM chat_threads WHERE id=? AND site=? AND company_code=?').get(thread.id,SITE,COMPANY);
    if(!t||t.order_id!==null)return false;
    if(db.prepare("SELECT id FROM chat_thread_messages WHERE thread_id=? AND direction='in' AND author_kind='customer' LIMIT 1").get(t.id))return false;
    const v=originSet.has(origin)?receipt(token,origin):null;if(!v)return false;
    db.prepare('INSERT OR IGNORE INTO palitra_attribution_pending_v1 VALUES(?,?,?,?)').run(COMPANY,t.id,v.visit_hash,stamp());return true;
  }
  function recordThread({thread,messageId,source}={}) {
    if(!thread||thread.site!==SITE||thread.company_code!==COMPANY)return false;atomic();
    const t=db.prepare('SELECT * FROM chat_threads WHERE id=? AND site=? AND company_code=?').get(thread.id,SITE,COMPANY);if(!t||t.order_id!==null)return false;
    const m=db.prepare("SELECT id,source_channel,created_at FROM chat_thread_messages WHERE thread_id=? AND direction='in' AND author_kind='customer' ORDER BY id LIMIT 1").get(t.id);
    if(!m||m.id!==messageId||m.source_channel!==source||!['web','telegram'].includes(source))return false;
    const v=db.prepare(`SELECT v.* FROM palitra_attribution_pending_v1 p JOIN palitra_attribution_visits_v1 v ON v.company_code=p.company_code AND v.visit_hash=p.visit_hash WHERE p.company_code=? AND p.thread_id=?`).get(COMPANY,t.id);
    const valid=v&&clock()-Date.parse(v.created_at)<=TTL&&Date.parse(v.created_at)<=clock();
    const saved=saveLead({kind:'thread',id:t.id,entryKind:source==='web'?'site_chat':'telegram',first:valid?parseJson(v.first_json):null,last:valid?parseJson(v.last_json):null,visitHash:valid?v.visit_hash:null,createdAt:m.created_at});
    db.prepare('DELETE FROM palitra_attribution_pending_v1 WHERE company_code=? AND thread_id=?').run(COMPANY,t.id);return saved;
  }
  function recordLegacy({dialogId,messageId}={}) {
    atomic();if(!positive(dialogId)||!positive(messageId))throw new TypeError('Accepted Telegram message required');
    const d=db.prepare('SELECT * FROM client_dialogs WHERE id=? AND company_code=?').get(dialogId,COMPANY);if(!d)return false;
    const m=db.prepare("SELECT id,created_at FROM client_dialog_messages WHERE dialog_id=? AND company_code=? AND bot_key=? AND direction='in' AND author_type='client' ORDER BY id LIMIT 1").get(d.id,COMPANY,d.bot_key);
    if(!m||m.id!==messageId)return false;
    // Linked conversations belong to their canonical order; never count the same order twice.
    if(positive(d.order_id)&&db.prepare('SELECT id FROM site_orders WHERE id=? AND site=? AND company_code=?').get(d.order_id,SITE,COMPANY))return false;
    return saveLead({kind:'legacy',id:d.id,entryKind:'telegram',createdAt:m.created_at});
  }
  function projection(row,basis){const last=row.last_json?parseJson(row.last_json):null,first=row.first_json?parseJson(row.first_json):null;return {entryKind:row.entry_kind,trafficSource:last?.trafficSource??null,utm:last?.utm??{},firstTouch:first,lastTouch:last,basis};}
  function projectSource({kind,id}={}) {
    if(!['order','thread','legacy'].includes(kind)||!positive(id))return {entryKind:'unknown',trafficSource:null,utm:{},firstTouch:null,lastTouch:null,basis:'unknown'};
    const o=kind==='order'?db.prepare('SELECT * FROM site_orders WHERE id=? AND site=? AND company_code=?').get(id,SITE,COMPANY):null;
    const t=kind==='thread'?db.prepare('SELECT * FROM chat_threads WHERE id=? AND site=? AND company_code=?').get(id,SITE,COMPANY):null;
    const d=kind==='legacy'?db.prepare('SELECT * FROM client_dialogs WHERE id=? AND company_code=?').get(id,COMPANY):null;
    const target=o||t||d;if(!target)return {entryKind:'unknown',trafficSource:null,utm:{},firstTouch:null,lastTouch:null,basis:'unknown'};
    if(!o&&positive(target.order_id)&&db.prepare('SELECT id FROM site_orders WHERE id=? AND site=? AND company_code=?').get(target.order_id,SITE,COMPANY))return projectSource({kind:'order',id:target.order_id});
    // Optional enrichment works before migration, without fabricating new recorded analytics.
    const exists=db.prepare("SELECT 1 n FROM sqlite_schema WHERE type='table' AND name='palitra_attribution_leads_v1'").get();
    const row=exists?db.prepare('SELECT * FROM palitra_attribution_leads_v1 WHERE company_code=? AND target_kind=? AND target_id=?').get(COMPANY,kind,id):null;
    if(row)return projection(row,'recorded');
    if(o){const utm=cleanUtm(parseJson(o.utm_json),{strict:false}),last=Object.keys(utm).length?touch(utm):null;return {entryKind:'site_order',trafficSource:trafficSource(utm),utm,firstTouch:null,lastTouch:last,basis:'legacy_order'};}
    const firstMessage=t?db.prepare("SELECT source_channel FROM chat_thread_messages WHERE thread_id=? AND direction='in' AND author_kind='customer' ORDER BY id LIMIT 1").get(t.id):null;
    const entryKind=d?'telegram':firstMessage?.source_channel==='telegram'?'telegram':firstMessage?.source_channel==='web'?'site_chat':'unknown';
    return {entryKind,trafficSource:null,utm:{},firstTouch:null,lastTouch:null,basis:entryKind==='unknown'?'unknown':'channel_only'};
  }
  function summary(who,{from,until}={}) {
    authorize(who);const startedAt=ready(db),asOf=stamp();
    const valid=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(Date.parse(s)).toISOString()===s;
    const lo=from??startedAt,hi=until??asOf;
    if(!valid(lo)||!valid(hi)||lo>hi||hi>asOf||Date.parse(hi)-Date.parse(lo)>366*86400000)fail(400,'ATTRIBUTION_RANGE','Некорректный период статистики');
    const visits=db.prepare('SELECT last_json FROM palitra_attribution_visits_v1 WHERE company_code=? AND created_at>=? AND created_at<?').all(COMPANY,lo,hi);
    const leads=db.prepare('SELECT last_json,visit_hash FROM palitra_attribution_leads_v1 WHERE company_code=? AND created_at>=? AND created_at<?').all(COMPANY,lo,hi);
    const observed=hi>startedAt,rows=new Map(SOURCES.map(source=>[source,{source,visits:observed?0:null,leads:observed?0:null,linkedLeads:observed?0:null}]));
    for(const r of visits)rows.get(parseJson(r.last_json)?.trafficSource??'unknown').visits++;
    for(const r of leads){const s=rows.get(parseJson(r.last_json)?.trafficSource??'unknown');s.leads++;if(r.visit_hash)s.linkedLeads++;}
    authorize(who);
    return {schema:SCHEMA,companyCode:COMPANY,startedAt,asOf,from:lo,until:hi,status:!observed?'not_observed':visits.length||leads.length?'ready':'empty',coverage:{visits:'consented_only',leads:'new_accepted_only',historicalVisits:'not_backfilled'},sources:[...rows.values()],totals:observed?{visits:visits.length,leads:leads.length,linkedLeads:leads.filter(r=>r.visit_hash).length}:null};
  }
  return Object.freeze({authorize,visit,recordOrder,rememberThread,recordThread,recordLegacy,projectSource,summary});
}
module.exports={createPalitraAttribution,initializeAttributionSchema,SCHEMA,TABLES,UTM_FIELDS,SOURCES,cleanUtm,trafficSource};
