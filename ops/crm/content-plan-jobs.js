'use strict';

// Durable preparation jobs only. No publication, network calls or approval side effects.
const {randomUUID, createHash} = require('node:crypto');
const {company, fail} = require('./company-information');
const ACTIVE = "('queued','running')";
const ERRORS = {PROVIDER_NOT_CONFIGURED:'Исполнитель пока не подключён. Требуется настройка администратора.',
  PROVIDER_UNAVAILABLE:'Сервис подготовки временно недоступен.', INVALID_RESULT:'Результат не прошёл проверку. Требуется повторная подготовка.',
  BUDGET_EXCEEDED:'Лимит подготовки исчерпан. Требуется решение администратора.', GENERATION_FAILED:'Не удалось подготовить план.',
  ATTEMPTS_EXHAUSTED:'Автоматические попытки исчерпаны. Требуется проверка администратора.', WORKER_INTERRUPTED:'Подготовка возобновляется после остановки исполнителя.'};
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function json(value, maxBytes = 300000) {
  const result = JSON.stringify(canonical(value));
  if (!result || Buffer.byteLength(result) > maxBytes) fail(400, 'Превышен размер данных плана', 'INVALID_RESULT');
  return result;
}
function monthKey(month) {
  if (typeof month !== 'string' || !/^(20\d{2}|21\d{2})-(0[1-9]|1[0-2])$/.test(month)) fail(400, 'Выберите месяц плана');
  return month;
}
function validateSourceLibrary(value,code){
  const bad=()=>fail(400,'Некорректный снимок библиотеки исходников','INVALID_SOURCE_CONTEXT');
  const exact=(item,keys)=>item&&typeof item==='object'&&!Array.isArray(item)&&Object.keys(item).length===keys.length&&keys.every(key=>Object.hasOwn(item,key));
  const string=(item,max)=>typeof item==='string'&&item.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item);
  if(!exact(value,['schemaVersion','companyCode','total','truncated','assets','hash'])||value.schemaVersion!==1||
    typeof code!=='string'||value.companyCode!==code.toLowerCase()||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.companyCode)||
    !Number.isSafeInteger(value.total)||value.total<0||typeof value.truncated!=='boolean'||!Array.isArray(value.assets)||
    value.assets.length>100||value.total<value.assets.length||value.truncated!==(value.total>value.assets.length)||
    typeof value.hash!=='string'||! /^[a-f0-9]{64}$/.test(value.hash))bad();
  let previous=Infinity;
  const platforms=['instagram','tiktok','youtube_shorts','vk','telegram','max','two_gis'],formats=['post','story','reel','carousel'];
  for(const asset of value.assets){
    if(!exact(asset,['id','revision','sha256','name','mime','size','status','caption','metadata'])||
      !Number.isSafeInteger(asset.id)||asset.id<1||asset.id>=previous||!Number.isSafeInteger(asset.revision)||asset.revision<1||
      !(asset.sha256===null||typeof asset.sha256==='string'&&/^[a-f0-9]{64}$/.test(asset.sha256))||
      !string(asset.name,180)||!string(asset.mime,80)||!(asset.size===null||Number.isSafeInteger(asset.size)&&asset.size>=0)||
      !['stored','text'].includes(asset.status)||!string(asset.caption,12000)||
      !exact(asset.metadata,['platforms','formats','occasion','eventDate','usageRestrictions','materialState']))bad();
    previous=asset.id;
    const meta=asset.metadata;
    for(const [key,allowed]of [['platforms',platforms],['formats',formats]]){
      if(!Array.isArray(meta[key])||meta[key].length>allowed.length||new Set(meta[key]).size!==meta[key].length||meta[key].some(id=>!allowed.includes(id)))bad();
    }
    if(!string(meta.occasion,500)||!string(meta.eventDate,10)||!string(meta.usageRestrictions,2000)||!['source','ready'].includes(meta.materialState))bad();
    if(meta.eventDate){
      const date=Date.parse(meta.eventDate+'T00:00:00Z');
      if(!/^\d{4}-\d{2}-\d{2}$/.test(meta.eventDate)||!Number.isFinite(date)||new Date(date).toISOString().slice(0,10)!==meta.eventDate)bad();
    }
  }
  const serialized=JSON.stringify(canonical(value));
  if(Buffer.byteLength(serialized)>65536)bad();
  const {hash,...manifest}=value;
  if(createHash('sha256').update(JSON.stringify(canonical(manifest))).digest('hex')!==hash)bad();
  return JSON.parse(serialized);
}
function createContentPlanJobs(db, {now = Date.now, leaseMs = 120000, maxAttempts = 3, requireWorker=false} = {}) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new Error('Invalid job limits');
  db.exec(`CREATE TABLE IF NOT EXISTS content_plan_jobs (
    id TEXT PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), month TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','running','needs_input','succeeded','failed')),
    snapshot TEXT NOT NULL, snapshot_hash TEXT NOT NULL, questions TEXT NOT NULL DEFAULT '[]', result TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER, available_at INTEGER NOT NULL,
    error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS content_plan_active ON content_plan_jobs(company_id,month) WHERE status IN ${ACTIVE};
    CREATE TABLE IF NOT EXISTS content_plan_requests (
      company_id INTEGER NOT NULL REFERENCES companies(id), request_id TEXT NOT NULL,
      job_id TEXT NOT NULL REFERENCES content_plan_jobs(id), fingerprint TEXT NOT NULL,
      PRIMARY KEY(company_id,request_id));
    CREATE TABLE IF NOT EXISTS content_plan_job_events (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES content_plan_jobs(id), company_id INTEGER NOT NULL,
      kind TEXT NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER,
      UNIQUE(job_id,kind));
    CREATE TABLE IF NOT EXISTS content_plan_parts (
      job_id TEXT NOT NULL REFERENCES content_plan_jobs(id), part_index INTEGER NOT NULL,
      payload TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(job_id,part_index));
    CREATE TABLE IF NOT EXISTS content_plan_worker_health(id INTEGER PRIMARY KEY CHECK(id=1),seen_at INTEGER NOT NULL,configured INTEGER NOT NULL);`);
  const columns=new Set(db.prepare('PRAGMA table_info(content_plan_jobs)').all().map(c=>c.name));
    for(const [name,type] of [['started_at','INTEGER'],['finished_at','INTEGER'],['executor','TEXT'],['resume_from','TEXT']]) if(!columns.has(name)) db.exec(`ALTER TABLE content_plan_jobs ADD COLUMN ${name} ${type}`);
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch(e) { db.exec('ROLLBACK'); throw e; } };
  const stamp = () => { const t = now(); if (!Number.isSafeInteger(t)) throw new Error('Invalid clock'); return t; };
  function workerReady(time=stamp()) {const health=db.prepare('SELECT * FROM content_plan_worker_health WHERE id=1').get();return !!health&&health.configured===1&&health.seen_at>time-90000;}
  function pulse(configured){if(typeof configured!=='boolean')fail(400,'Нужен статус исполнителя');
    db.prepare('INSERT INTO content_plan_worker_health VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at,configured=excluded.configured').run(stamp(),Number(configured));return {ok:true};}
  const row = (owner, id) => {
    const result = db.prepare('SELECT * FROM content_plan_jobs WHERE company_id=? AND id=?').get(owner.id, id);
    if (!result) fail(404, 'Задача не найдена', 'NOT_FOUND');
    return result;
  };
  const dto = item => {const snapshot=JSON.parse(item.snapshot), proposals=item.result?JSON.parse(item.result):[];return ({id:item.id,
    companyCode:db.prepare('SELECT code FROM companies WHERE id=?').get(item.company_id).code,
    month:item.month, status:item.status, attempts:item.attempts,maxAttempts,
    createdAt:new Date(item.created_at).toISOString(), updatedAt:new Date(item.updated_at).toISOString(),
    startedAt:item.started_at===null?null:new Date(item.started_at).toISOString(),finishedAt:item.finished_at===null?null:new Date(item.finished_at).toISOString(),
    inputs:snapshot.inputs||{briefRevision:0,profileRevision:0,monthRevision:0},executor:item.executor?JSON.parse(item.executor):null,
    coverage:{requested:snapshot.requested||0,proposed:proposals.length},questions:JSON.parse(item.questions),proposals,errorCode:item.error_code,
    errorMessage:ERRORS[item.error_code]||null,retryable:item.status==='failed'&&['PROVIDER_UNAVAILABLE','INVALID_RESULT','GENERATION_FAILED','ATTEMPTS_EXHAUSTED'].includes(item.error_code)});};
  function event(item, kind, time) {
    db.prepare('INSERT OR IGNORE INTO content_plan_job_events(id,job_id,company_id,kind,created_at) VALUES(?,?,?,?,?)').run(randomUUID(),item.id,item.company_id,kind,time);
  }
  function expire(time) {
    const health=db.prepare('SELECT configured FROM content_plan_worker_health WHERE id=1').get();
    const unavailable=!workerReady(time);
    const stale=db.prepare(`SELECT * FROM content_plan_jobs WHERE status IN ${ACTIVE} AND (created_at<=? OR (status='queued' AND updated_at<=?))`).all(time-86400000,unavailable?time-90000:-1);
    for(const item of stale){
      // A short heartbeat gap must not discard the queue; the overall deadline remains bounded.
      if(item.created_at>time-86400000 && health?.configured!==0){
        db.prepare("UPDATE content_plan_jobs SET error_code='WORKER_INTERRUPTED' WHERE id=?").run(item.id);
        event(item,'delayed',time);continue;
      }
      const code=item.status==='queued'&&health?.configured===0?'PROVIDER_NOT_CONFIGURED':'PROVIDER_UNAVAILABLE';
      db.prepare("UPDATE content_plan_jobs SET status='failed',error_code=?,finished_at=?,updated_at=?,lease_token=NULL,lease_until=NULL WHERE id=?").run(code,time,time,item.id);event(item,'failed',time);
    }
    const expired = db.prepare("SELECT * FROM content_plan_jobs WHERE status='running' AND lease_until<=?").all(time);
    for (const item of expired) {
      const exhausted = item.attempts >= maxAttempts;
      db.prepare('UPDATE content_plan_jobs SET status=?,lease_token=NULL,lease_until=NULL,available_at=?,updated_at=?,error_code=?,finished_at=? WHERE id=?')
        .run(exhausted?'failed':'queued',time,time,exhausted?'ATTEMPTS_EXHAUSTED':'WORKER_INTERRUPTED',exhausted?time:null,item.id);
      event(item, exhausted?'failed':'delayed',time);
    }
  }
  function lookupRequest(code,clientRequestId,month){
    const owner=company(db,code);monthKey(month);
    if(typeof clientRequestId!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(clientRequestId))fail(400,'Нужен идентификатор запроса');
    const previous=db.prepare('SELECT job_id FROM content_plan_requests WHERE company_id=? AND request_id=?').get(owner.id,clientRequestId);
    if(!previous)return null;
    const job=row(owner,previous.job_id);
    if(job.month!==month)fail(409,'Этот запрос уже использован для другого месяца','REQUEST_CONFLICT');
    return {companyCode:owner.code,job:dto(job)};
  }
  function enqueue(code, {clientRequestId, month, snapshot, questions = []}) {
    const owner = company(db, code); monthKey(month);
    if (typeof clientRequestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(clientRequestId)) fail(400,'Нужен идентификатор запроса');
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) fail(400,'Нужны вводные');
    if (!Array.isArray(questions) || questions.length > 10 || questions.some(q => !q || typeof q.id!=='string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(q.id) || typeof q.target!=='string' || !/^(brief|profile|month)\.[a-zA-Z]+$/.test(q.target) || typeof q.text!=='string' || !q.text.trim() || q.text.length>1000 || typeof q.required!=='boolean')) fail(400,'Некорректные вопросы');
    const serialized = json(snapshot), fingerprint = createHash('sha256').update(month+'\n'+serialized).digest('hex');
    return tx(() => {
      const previous = db.prepare('SELECT * FROM content_plan_requests WHERE company_id=? AND request_id=?').get(owner.id,clientRequestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail(409,'Этот запрос уже использован с другими вводными','REQUEST_CONFLICT');
        return dto(row(owner,previous.job_id));
      }
      const time = stamp(); expire(time);
      let job = db.prepare(`SELECT * FROM content_plan_jobs WHERE company_id=? AND month=? AND status IN ${ACTIVE}`).get(owner.id,month);
      if (job && job.snapshot_hash !== fingerprint) fail(409,'План уже составляется. Дождитесь результата перед новой попыткой','GENERATION_ACTIVE');
      if (!job) {
        const id=randomUUID(), status=questions.length?'needs_input':'queued';
        db.prepare('INSERT INTO content_plan_jobs(id,company_id,month,status,snapshot,snapshot_hash,questions,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(id,owner.id,month,status,serialized,fingerprint,JSON.stringify(questions),time,time,time);
        if(!questions.length){
          const source=db.prepare("SELECT id,resume_from FROM content_plan_jobs WHERE company_id=? AND month=? AND snapshot_hash=? AND status='failed' ORDER BY created_at DESC,id DESC LIMIT 1").get(owner.id,month,fingerprint);
          if(source){
            db.prepare('INSERT INTO content_plan_parts(job_id,part_index,payload,created_at) SELECT ?,part_index,payload,? FROM content_plan_parts WHERE job_id=?').run(id,time,source.id);
            db.prepare('UPDATE content_plan_jobs SET resume_from=? WHERE id=?').run(source.resume_from||source.id,id);
          }
        }
        job=row(owner,id); event(job,status,time);
      }
      db.prepare('INSERT INTO content_plan_requests(company_id,request_id,job_id,fingerprint) VALUES(?,?,?,?)').run(owner.id,clientRequestId,job.id,fingerprint);
      return dto(job);
    });
  }
  function claim() {
    return tx(() => {
      const time=stamp(); expire(time);
      const job=db.prepare(`SELECT j.*,c.code FROM content_plan_jobs j JOIN companies c ON c.id=j.company_id WHERE j.status='queued' AND j.available_at<=? AND c.is_deleted=0 ORDER BY j.created_at,j.id LIMIT 1`).get(time);
      if (!job) return null;
      const token=randomUUID();
      db.prepare("UPDATE content_plan_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=?,started_at=COALESCE(started_at,?),error_code=NULL WHERE id=?").run(token,time+leaseMs,time,time,job.id);
      return {id:job.id,companyCode:job.code,month:job.month,token,attempt:job.attempts+1,snapshot:JSON.parse(job.snapshot),
        parts:db.prepare('SELECT payload FROM content_plan_parts WHERE job_id=? ORDER BY part_index').all(job.id).map(p=>JSON.parse(p.payload))};
    });
  }
  function owned(id,token,time) {
    const job=db.prepare("SELECT * FROM content_plan_jobs WHERE id=? AND lease_token=? AND status='running' AND lease_until>?").get(id,token,time);
    if (!job) fail(409,'Исполнитель больше не владеет задачей','LEASE_LOST');
    return job;
  }
  function heartbeat(id,token) { return tx(() => { const time=stamp(); owned(id,token,time); db.prepare('UPDATE content_plan_jobs SET lease_until=?,updated_at=? WHERE id=?').run(time+leaseMs,time,id); }); }
  function release(id,token){return tx(()=>{
    const time=stamp();owned(id,token,time);
    db.prepare("UPDATE content_plan_jobs SET status='queued',lease_token=NULL,lease_until=NULL,attempts=MAX(0,attempts-1),available_at=?,updated_at=?,error_code='WORKER_INTERRUPTED' WHERE id=?").run(time,time,id);
    // Planned shutdown is not a failed generation; paid/unknown reservations stay in the cost ledger.
    return {ok:true};
  });}
  // The worker must validate proposal structure/facts before completing; this internal method is not an HTTP endpoint.
  function complete(id,token,proposals) {
    if (!Array.isArray(proposals) || !proposals.length) fail(400,'Нет предложений плана');
    const result=json(proposals, 16 * 1024 * 1024);
    return tx(() => {const time=stamp(), job=owned(id,token,time);
      db.prepare("UPDATE content_plan_jobs SET status='succeeded',result=?,lease_token=NULL,lease_until=NULL,updated_at=?,finished_at=?,error_code=NULL WHERE id=?").run(result,time,time,id);
      event(job,'succeeded',time);
    });
  }
  function reject(id,token,{retryable=false,errorCode='GENERATION_FAILED'}={}) {
    const allowed=['PROVIDER_NOT_CONFIGURED','PROVIDER_UNAVAILABLE','INVALID_RESULT','BUDGET_EXCEEDED','GENERATION_FAILED'];
    if (!allowed.includes(errorCode)) errorCode='GENERATION_FAILED'; // Never persist provider errors or secrets.
    return tx(() => {const time=stamp(), job=owned(id,token,time), retry=retryable && job.attempts<maxAttempts;
      db.prepare('UPDATE content_plan_jobs SET status=?,lease_token=NULL,lease_until=NULL,error_code=?,available_at=?,updated_at=?,finished_at=? WHERE id=?')
        .run(retry?'queued':'failed',errorCode,time+Math.min(60000*2**(job.attempts-1),900000),time,retry?null:time,id);
      event(job,retry?'delayed':'failed',time);
    });
  }
  function setExecutor(id,token,executor) {
    if(!executor || !['api','test'].includes(executor.kind) || typeof executor.model!=='string' || !executor.model.trim() || executor.model.length>150) fail(400,'Не указан исполнитель');
    return tx(()=>{const time=stamp();owned(id,token,time);db.prepare('UPDATE content_plan_jobs SET executor=?,updated_at=? WHERE id=?').run(JSON.stringify({kind:executor.kind,model:executor.model}),time,id)});
  }
  // Only validated chunks, with the actual responding model, may be checkpointed by a worker.
  function savePart(id,token,index,part) {
    if(!Number.isInteger(index)||index<0||index>=651||!part||!Array.isArray(part.proposals)||!part.proposals.length||
      !part.executor||!['api','test'].includes(part.executor.kind)||typeof part.executor.model!=='string'||
      !part.executor.model.trim()||part.executor.model.length>150)fail(400,'Некорректная часть плана','INVALID_RESULT');
    const payload=json({proposals:part.proposals,executor:{kind:part.executor.kind,model:part.executor.model}});
    return tx(()=>{
      const time=stamp();owned(id,token,time);
      const previous=db.prepare('SELECT payload FROM content_plan_parts WHERE job_id=? AND part_index=?').get(id,index);
      if(previous){if(previous.payload!==payload)fail(409,'Часть плана уже сохранена','PART_CONFLICT');return;}
      const count=db.prepare('SELECT count(*) n,COALESCE(sum(length(CAST(payload AS BLOB))),0) bytes FROM content_plan_parts WHERE job_id=?').get(id);
      if(index!==count.n)fail(409,'Нарушен порядок частей','PART_ORDER');
      if(count.bytes+Buffer.byteLength(payload)>16*1024*1024)fail(400,'Превышен размер плана','INVALID_RESULT');
      db.prepare('INSERT INTO content_plan_parts VALUES(?,?,?,?)').run(id,index,payload,time);
      // A saved part is real progress: the next part has its own bounded retry allowance.
      db.prepare('UPDATE content_plan_jobs SET updated_at=?,attempts=1 WHERE id=?').run(time,id);
    });
  }
  function inspectLease(id,token){
    const item=owned(id,token,stamp()),owner=db.prepare('SELECT code,is_deleted FROM companies WHERE id=?').get(item.company_id);
    if(!owner||owner.is_deleted)fail(409,'Проект недоступен','LEASE_LOST');
    return {id:item.id,budgetJob:item.resume_from||item.id,token,companyCode:owner.code,month:item.month,snapshot:JSON.parse(item.snapshot),
      parts:db.prepare('SELECT payload FROM content_plan_parts WHERE job_id=? ORDER BY part_index').all(id).map(p=>JSON.parse(p.payload))};
  }
  function pendingEvents(){
    const labels={failed:'Подготовка плана остановлена. Требуется проверка администратора.',delayed:'Подготовка плана задерживается; задача сохранена.',
      needs_input:'Для составления плана нужны уточнения в настройках модуля.',succeeded:'Предложения контент-плана готовы к просмотру. Публикация не запускалась.'};
    return db.prepare(`SELECT e.id,e.kind,j.id job_id,j.month,c.code FROM content_plan_job_events e
      JOIN content_plan_jobs j ON j.id=e.job_id JOIN companies c ON c.id=e.company_id
      WHERE e.delivered_at IS NULL AND e.kind IN ('failed','delayed','needs_input','succeeded') AND c.is_deleted=0
      ORDER BY e.created_at,e.id LIMIT 30`).all().map(e=>({id:e.id,companyCode:e.code,eventKey:'content-plan:'+e.id,
        text:`Контент завод · ${e.code} · ${e.month}: ${labels[e.kind]} Задача ${e.job_id}.`}));
  }
  // Acknowledges durable insertion into the existing owner notification queue, not Telegram delivery.
  function acknowledgeEvent(id){if(typeof id!=='string')fail(400,'Нужен идентификатор события');
    db.prepare('UPDATE content_plan_job_events SET delivered_at=COALESCE(delivered_at,?) WHERE id=?').run(stamp(),id);return {ok:true};}
  return {enqueue,lookupRequest,claim,heartbeat,release,complete,reject,setExecutor,savePart,inspectLease,pendingEvents,acknowledgeEvent,pulse,
    canGenerate:()=>!requireWorker||workerReady(),
    get:(code,id)=>{const owner=company(db,code);row(owner,id);if(db.isTransaction)expire(stamp());else tx(()=>expire(stamp()));return {companyCode:owner.code,job:dto(row(owner,id))};},
    list:(code,month)=>{const owner=company(db,code);monthKey(month);if(db.isTransaction)expire(stamp());else tx(()=>expire(stamp()));return {companyCode:owner.code,jobs:db.prepare('SELECT * FROM content_plan_jobs WHERE company_id=? AND month=? ORDER BY created_at DESC,id LIMIT 20').all(owner.id,month).map(dto)};}};
}
module.exports={createContentPlanJobs,validateSourceLibrary};
