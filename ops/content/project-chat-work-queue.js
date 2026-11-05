 'use strict';
// Separate task queue. Existing chat history and text-only AI queues are never replayed.
const crypto=require('node:crypto');
const digest=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
const HEX=/^[a-f0-9]{64}$/;const KEY=/^[a-zA-Z0-9_.:-]{8,128}$/;
const addressed=text=>/^\s*(?:@?codex|кодекс)\s*[,!:]/iu.test(String(text||''));
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const positive=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):fail(400,'Некорректный идентификатор');
function createWorkQueue({db,verifyActor,clock=()=>Date.now(),leaseMs=60000,onResult=()=>null}){
 if(typeof verifyActor!=='function')throw new Error('Fresh actor validation is required');
 const stamp=()=>new Date(clock()).toISOString();
 db.exec(`CREATE TABLE IF NOT EXISTS project_chat_work_connections(
  company_code TEXT PRIMARY KEY REFERENCES project_chat_rooms(company_code),activation_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,key_sha256 TEXT NOT NULL,workspace_sha256 TEXT NOT NULL,product_sha256 TEXT NOT NULL,
  allowed_actor_ids TEXT NOT NULL,after_message_id INTEGER NOT NULL,owner_id INTEGER NOT NULL,activated_at TEXT NOT NULL,worker_boot_id TEXT,last_seen INTEGER,worker_ready INTEGER NOT NULL DEFAULT 0,worker_model TEXT,worker_version TEXT);
 CREATE TABLE IF NOT EXISTS project_chat_work_jobs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,company_code TEXT NOT NULL REFERENCES project_chat_rooms(company_code),
  activation_id TEXT NOT NULL,message_id INTEGER NOT NULL REFERENCES project_chat_messages(id),actor_id INTEGER NOT NULL,actor_session_version INTEGER,
  text_sha256 TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN('queued','claimed','running','waiting','review_required','needs_review','completed','failed','cancelled')),
  boot_id TEXT,lease_hash TEXT,lease_until INTEGER,last_seq INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,result_sha256 TEXT,error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  reviewed_by INTEGER,review_note TEXT,UNIQUE(company_code,message_id));
 CREATE TABLE IF NOT EXISTS project_chat_work_replies(job_id INTEGER PRIMARY KEY REFERENCES project_chat_work_jobs(id),message_id INTEGER NOT NULL UNIQUE REFERENCES project_chat_messages(id));
 CREATE TABLE IF NOT EXISTS project_chat_work_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,job_id INTEGER NOT NULL REFERENCES project_chat_work_jobs(id),
  request_id TEXT NOT NULL,seq INTEGER NOT NULL,body_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(job_id,request_id));
 CREATE TABLE IF NOT EXISTS project_chat_work_connection_events(id INTEGER PRIMARY KEY AUTOINCREMENT,company_code TEXT NOT NULL,activation_id TEXT NOT NULL,action TEXT NOT NULL,actor_id INTEGER,detail_json TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS project_chat_work_next ON project_chat_work_jobs(company_code,status,id);`);
 if(!db.prepare('PRAGMA table_info(project_chat_work_jobs)').all().some(c=>c.name==='actor_session_version'))db.exec('ALTER TABLE project_chat_work_jobs ADD COLUMN actor_session_version INTEGER');
 function tx(fn){db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}}
 function fresh(company,userId,owner=false){
  const user=verifyActor(company,positive(userId));if(!user||!['owner','editor'].includes(user.role)||(owner&&user.role!=='owner'))fail(403,'Нет действующего доступа к рабочему чату');return user;
 }
 function connection(company){return db.prepare('SELECT * FROM project_chat_work_connections WHERE company_code=?').get(company);}
 function status(company,userId){fresh(company,userId);const c=connection(company),connected=!!(c?.enabled&&c.last_seen&&clock()-c.last_seen<45000);return {enabled:!!c?.enabled,canAssign:!!(c?.enabled&&JSON.parse(c.allowed_actor_ids).includes(Number(userId))),connected,ready:connected&&c.worker_ready===1,activationId:c?.enabled?c.activation_id:null,productSha256:c?.enabled?c.product_sha256:null,lastSeen:c?.last_seen?new Date(c.last_seen).toISOString():null,model:connected?c.worker_model:null,version:connected?c.worker_version:null};}
 function activate({company,ownerId,keySha256,workspaceSha256,productSha256,allowedActorIds}){
  fresh(company,ownerId,true);if(!HEX.test(keySha256)||!HEX.test(workspaceSha256)||!HEX.test(productSha256))fail(400,'Нужны точные отпечатки подключения');
  if(!Array.isArray(allowedActorIds)||!allowedActorIds.length||allowedActorIds.length>20)fail(400,'Нужен список допущенных участников');
  const actors=[...new Set(allowedActorIds.map(positive))];for(const id of actors)fresh(company,id);
  if(!actors.includes(Number(ownerId)))fail(400,'Владелец должен входить в список');
  return tx(()=>{
   if(db.prepare("SELECT 1 FROM project_chat_work_jobs WHERE company_code=? AND status IN('claimed','running','needs_review') LIMIT 1").get(company))fail(409,'Сначала проверьте незавершённую работу');
   db.prepare("UPDATE project_chat_work_jobs SET status='cancelled',updated_at=? WHERE company_code=? AND status IN('queued','waiting')").run(stamp(),company);
   const activationId=crypto.randomUUID(),after=Number(db.prepare('SELECT COALESCE(MAX(id),0) id FROM project_chat_messages WHERE company_code=?').get(company).id);
   db.prepare(`INSERT INTO project_chat_work_connections(company_code,activation_id,enabled,key_sha256,workspace_sha256,product_sha256,allowed_actor_ids,after_message_id,owner_id,activated_at) VALUES(?,?,1,?,?,?,?,?,?,?) ON CONFLICT(company_code) DO UPDATE SET
    activation_id=excluded.activation_id,enabled=1,key_sha256=excluded.key_sha256,workspace_sha256=excluded.workspace_sha256,product_sha256=excluded.product_sha256,
    allowed_actor_ids=excluded.allowed_actor_ids,after_message_id=excluded.after_message_id,owner_id=excluded.owner_id,activated_at=excluded.activated_at,worker_boot_id=NULL,last_seen=NULL,worker_ready=0,worker_model=NULL,worker_version=NULL`)
    .run(company,activationId,keySha256,workspaceSha256,productSha256,JSON.stringify(actors),after,Number(ownerId),stamp());
   db.prepare('INSERT INTO project_chat_work_connection_events(company_code,activation_id,action,actor_id,detail_json,created_at) VALUES(?,?,?,?,?,?)').run(company,activationId,'activated',Number(ownerId),JSON.stringify({workspaceSha256,productSha256,allowedActorIds:actors,afterMessageId:after}),stamp());
   return {activationId,afterMessageId:after};
  });
 }
 function enqueueMessage(message){
  const c=connection(message.company_code);
  if(!c?.enabled||message.id<=c.after_message_id||message.author_type!=='human'||!addressed(message.text))return null;
  if(!/^\d+$/.test(String(message.author_id)))return null;
  const actor=positive(message.author_id),person=fresh(message.company_code,actor),actorVersion=Number.isSafeInteger(person.sessionVersion)?person.sessionVersion:null;
  if(!JSON.parse(c.allowed_actor_ids).includes(actor))return null;
  const sha=digest(message.text),existing=db.prepare('SELECT * FROM project_chat_work_jobs WHERE company_code=? AND message_id=?').get(message.company_code,message.id);
  if(existing){if(existing.text_sha256!==sha||existing.actor_id!==actor)fail(409,'Поручение уже сохранено с другим содержимым');return view(existing);}
  const id=Number(db.prepare(`INSERT INTO project_chat_work_jobs(company_code,activation_id,message_id,actor_id,actor_session_version,text_sha256,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
   .run(message.company_code,c.activation_id,message.id,actor,actorVersion,sha,stamp(),stamp()).lastInsertRowid);
  return view(db.prepare('SELECT * FROM project_chat_work_jobs WHERE id=?').get(id));
 }
 function authorizeWorker(company,token){const c=connection(company),sha=digest(typeof token==='string'?token:'');
  if(!c?.enabled||!HEX.test(c.key_sha256)||!crypto.timingSafeEqual(Buffer.from(sha,'hex'),Buffer.from(c.key_sha256,'hex')))fail(401,'Подключение исполнителя недействительно');return c;}
 function authenticate({company,activationId,token}){const c=authorizeWorker(company,token);if(c.activation_id!==activationId)fail(401,'Подключение исполнителя недействительно');return c;}
 function routeMessage(company,actorId,text){const c=connection(company);if(!c?.enabled||!addressed(text))return false;fresh(company,actorId);return JSON.parse(c.allowed_actor_ids).includes(Number(actorId));}
 function heartbeat(options){const c=authenticate(options),b=options.body;
  if(!KEY.test(options.bootId)||!b||b.workspaceSha256!==c.workspace_sha256||b.productSha256!==c.product_sha256||typeof b.ready!=='boolean'||typeof b.model!=='string'||b.model.length>100||typeof b.version!=='string'||b.version.length>40)fail(409,'Исполнитель не подтвердил точное подключение');
  db.prepare('UPDATE project_chat_work_connections SET worker_boot_id=?,last_seen=?,worker_ready=?,worker_model=?,worker_version=? WHERE company_code=? AND activation_id=?').run(options.bootId,clock(),b.ready?1:0,b.model,b.version,options.company,options.activationId);return {received:true};
 }
 function disable({company,ownerId}){fresh(company,ownerId,true);return tx(()=>{const c=connection(company);if(!c)return {disabled:true};
  db.prepare('UPDATE project_chat_work_connections SET enabled=0,worker_ready=0 WHERE company_code=?').run(company);
  db.prepare("UPDATE project_chat_work_jobs SET status=CASE WHEN status IN('claimed','running') THEN 'needs_review' ELSE 'cancelled' END,error='CONNECTION_DISABLED',updated_at=? WHERE company_code=? AND status IN('queued','claimed','running','waiting')").run(stamp(),company);
  db.prepare('INSERT INTO project_chat_work_connection_events(company_code,activation_id,action,actor_id,detail_json,created_at) VALUES(?,?,?,?,?,?)').run(company,c.activation_id,'disabled',Number(ownerId),'{}',stamp());return {disabled:true};
 });}
 function resolveUnknown({company,ownerId,jobId,note}){fresh(company,ownerId,true);if(typeof note!=='string'||!note.trim()||note.length>4000)fail(400,'Нужен факт проверки неизвестного результата');
  const changed=db.prepare("UPDATE project_chat_work_jobs SET status='failed',reviewed_by=?,review_note=?,updated_at=? WHERE id=? AND company_code=? AND status='needs_review'").run(Number(ownerId),note,stamp(),positive(jobId),company);if(changed.changes!==1)fail(409,'Нет работы с неизвестным результатом');return view(db.prepare('SELECT * FROM project_chat_work_jobs WHERE id=?').get(Number(jobId)));
 }
 function stillAllowed(c,job){try{const person=fresh(job.company_code,job.actor_id);if(job.actor_session_version!==null&&person.sessionVersion!==job.actor_session_version)throw new Error('session revoked');if(!JSON.parse(c.allowed_actor_ids).includes(job.actor_id))throw new Error('revoked');return true;}catch{
  db.prepare("UPDATE project_chat_work_jobs SET status='needs_review',error='ACTOR_ACCESS_REVOKED',updated_at=? WHERE id=? AND status NOT IN('completed','failed','cancelled')").run(stamp(),job.id);return false;
 }}
 function expire(company){db.prepare("UPDATE project_chat_work_jobs SET status='needs_review',error='LEASE_EXPIRED_UNKNOWN_EFFECTS',updated_at=? WHERE company_code=? AND status IN('claimed','running') AND lease_until<=?").run(stamp(),company,clock());}
 function claim(options){const c=authenticate(options);if(!KEY.test(options.bootId))fail(400,'Нужен идентификатор запуска');return tx(()=>{
  const live=authenticate(options);if(live.worker_boot_id!==options.bootId||live.worker_ready!==1||!live.last_seen||clock()-live.last_seen>=45000)fail(409,'Нет свежего подтверждения готовности исполнителя');
  expire(options.company);
  if(db.prepare("SELECT 1 FROM project_chat_work_jobs WHERE company_code=? AND status IN('claimed','running','needs_review') LIMIT 1").get(options.company))return null;
  const jobs=db.prepare("SELECT * FROM project_chat_work_jobs WHERE company_code=? AND activation_id=? AND status='queued' ORDER BY id LIMIT 20").all(options.company,c.activation_id);
  for(const job of jobs){
   if(!stillAllowed(c,job))return null;
   const message=db.prepare('SELECT * FROM project_chat_messages WHERE id=? AND company_code=?').get(job.message_id,job.company_code);
   if(!message||digest(message.text)!==job.text_sha256){db.prepare("UPDATE project_chat_work_jobs SET status='needs_review',error='MESSAGE_CHANGED',updated_at=? WHERE id=?").run(stamp(),job.id);return null;}
   const leaseToken=crypto.randomBytes(32).toString('base64url'),until=clock()+leaseMs;
   db.prepare("UPDATE project_chat_work_jobs SET status='claimed',boot_id=?,lease_hash=?,lease_until=?,updated_at=? WHERE id=? AND status='queued'").run(options.bootId,digest(leaseToken),until,stamp(),job.id);
   return {...view(job),status:'claimed',text:message.text,leaseToken,leaseUntil:until,workspaceSha256:c.workspace_sha256,productSha256:c.product_sha256};
  }return null;
 });}
 function leased(options){const c=authenticate(options);const j=db.prepare('SELECT * FROM project_chat_work_jobs WHERE id=? AND company_code=? AND activation_id=?').get(positive(options.jobId),options.company,options.activationId);
  if(!j||j.boot_id!==options.bootId||!j.lease_hash||j.lease_hash!==digest(options.leaseToken||''))fail(409,'Поручение принадлежит другому запуску');
  if(!stillAllowed(c,j))fail(403,'Доступ автора отозван');return j;
 }
 function renew(options){const j=leased(options);if(!['claimed','running'].includes(j.status)||j.lease_until<=clock()){
  if(['claimed','running'].includes(j.status))db.prepare("UPDATE project_chat_work_jobs SET status='needs_review',error='LEASE_EXPIRED_UNKNOWN_EFFECTS',updated_at=? WHERE id=?").run(stamp(),j.id);
  fail(409,'Работа требует проверки; повтор не запущен');}
  const until=clock()+leaseMs;db.prepare('UPDATE project_chat_work_jobs SET lease_until=?,updated_at=? WHERE id=?').run(until,stamp(),j.id);return {leaseUntil:until};
 }
 function validateResult(value){
  if(!value||value.turnStatus!=='completed'||typeof value.model!=='string'||!value.model||value.model.length>100||typeof value.summary!=='string'||!value.summary.trim()||value.summary.length>12000)fail(400,'Нет подтверждённого результата Codex');
  if(!Array.isArray(value.artifacts)||value.artifacts.length>100||!Array.isArray(value.checks)||value.checks.length>100)fail(400,'Нужны артефакты и проверки');
  for(const a of value.artifacts){if(!a||typeof a.path!=='string'||!a.path||a.path.length>240||a.path.startsWith('/')||/[:\\\x00]/.test(a.path)||a.path.split('/').some(s=>!s||s==='.'||s==='..')||!HEX.test(a.sha256))fail(400,'Некорректный артефакт');}
  for(const c of value.checks){if(!c||typeof c.name!=='string'||!c.name||c.name.length>100||!['pass','fail','not_run'].includes(c.status))fail(400,'Некорректная проверка');}
  const result=JSON.stringify(value);if(Buffer.byteLength(result)>128*1024)fail(413,'Результат слишком велик');return result;
 }
 function report(options){const j=leased(options),body=options.body;
  if(!body||!KEY.test(body.requestId)||!Number.isSafeInteger(body.seq)||body.seq<1||!['running','waiting','review_required','needs_review','failed'].includes(body.status))fail(400,'Некорректное состояние работы');
  const result=body.status==='review_required'?validateResult(body.result):null;
  const bodySha=digest(JSON.stringify(body));const old=db.prepare('SELECT body_sha256 FROM project_chat_work_events WHERE job_id=? AND request_id=?').get(j.id,body.requestId);
  if(old){if(old.body_sha256!==bodySha)fail(409,'Ключ квитанции уже использован');return view(db.prepare('SELECT * FROM project_chat_work_jobs WHERE id=?').get(j.id));}
  if(!['claimed','running'].includes(j.status)||j.lease_until<=clock())fail(409,'Истёкшая или завершённая работа не повторяется');
  if(body.seq!==j.last_seq+1)fail(409,'Нарушен порядок состояния');
  return tx(()=>{
   db.prepare('INSERT INTO project_chat_work_events(job_id,request_id,seq,body_sha256,created_at) VALUES(?,?,?,?,?)').run(j.id,body.requestId,body.seq,bodySha,stamp());
   db.prepare('UPDATE project_chat_work_jobs SET status=?,last_seq=?,result_json=?,result_sha256=?,error=?,updated_at=? WHERE id=?').run(body.status,body.seq,result,result?digest(result):null,String(body.error||'').slice(0,500),stamp(),j.id);
   const completed=db.prepare('SELECT * FROM project_chat_work_jobs WHERE id=?').get(j.id);
   if(body.status==='review_required'){const replyId=onResult(view(completed));if(replyId)db.prepare('INSERT INTO project_chat_work_replies(job_id,message_id) VALUES(?,?)').run(j.id,positive(replyId));}
   return view(completed);
  });
 }
 function accept({company,ownerId,jobId,resultSha256,note}){fresh(company,ownerId,true);const j=db.prepare('SELECT * FROM project_chat_work_jobs WHERE id=? AND company_code=?').get(positive(jobId),company);
  if(!j||j.status!=='review_required'||!HEX.test(resultSha256)||resultSha256!==j.result_sha256||typeof note!=='string'||!note.trim()||note.length>4000)fail(409,'Нужна проверка точного результата');
  db.prepare("UPDATE project_chat_work_jobs SET status='completed',reviewed_by=?,review_note=?,updated_at=? WHERE id=?").run(Number(ownerId),note,stamp(),j.id);return view(db.prepare('SELECT * FROM project_chat_work_jobs WHERE id=?').get(j.id));
 }
 function list(company,userId){fresh(company,userId);return db.prepare('SELECT * FROM project_chat_work_jobs WHERE company_code=? ORDER BY id DESC LIMIT 100').all(company).map(view);}
 function messageJobs(ids){if(!Array.isArray(ids)||!ids.length)return new Map();const marks=ids.map(()=>'?').join(',');return new Map(db.prepare(`SELECT j.*,r.message_id reply_id FROM project_chat_work_jobs j LEFT JOIN project_chat_work_replies r ON r.job_id=j.id WHERE j.message_id IN (${marks}) OR r.message_id IN (${marks})`).all(...ids,...ids).flatMap(j=>[[j.message_id,{kind:'request',jobId:j.id,status:j.status}],...(j.reply_id?[[j.reply_id,{kind:'codex-work',jobId:j.id,status:j.status,model:j.result_json?JSON.parse(j.result_json).model:null,resultSha256:j.result_sha256}]]:[])]));}
 function view(j){return {id:j.id,companyCode:j.company_code,messageId:j.message_id,actorId:j.actor_id,status:j.status,result:j.result_json?JSON.parse(j.result_json):null,resultSha256:j.result_sha256||null,error:j.error||'',createdAt:j.created_at,updatedAt:j.updated_at};}
 return {status,authorizeWorker,activate,disable,resolveUnknown,routeMessage,heartbeat,messageJobs,enqueueMessage,claim,renew,report,accept,list};
}
module.exports={createWorkQueue,addressed,digest};
