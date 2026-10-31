'use strict';
const {randomBytes,randomUUID,createHash,createHmac,timingSafeEqual}=require('node:crypto');
const PROTOCOL='palitra-auth-outcome-v1',ACTIONS=new Set(['register','login','logout']);
const hash=value=>createHash('sha256').update(String(value)).digest('hex');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const fault=(status,message,code)=>Object.assign(new Error(message),{status,code});
const publicUser=row=>row?{id:row.id,email:row.email,firstName:row.first_name,lastName:row.last_name,phone:row.phone,address:row.address}:null;
class AuthOutcome {
 constructor(service,scope){
  if(!scope||scope.company!=='palitra-love'||typeof scope.workspace!=='string'||!/^[-\w]{1,128}$/.test(scope.workspace))throw new TypeError('Explicit fixed Palitra auth scope required');
  this.s=service;this.db=service.db;this.scope=Object.freeze({...scope});this.proofPrefix=service.secure?'__Host-PalitraAuthAttempt-':'PalitraAuthAttempt-';
  this.db.exec(`CREATE TABLE IF NOT EXISTS account_auth_outcomes(
   id TEXT PRIMARY KEY,proof_hash TEXT NOT NULL UNIQUE,company TEXT NOT NULL,workspace TEXT NOT NULL,origin TEXT NOT NULL,
   action TEXT NOT NULL,source_session_hash TEXT NOT NULL,source_csrf_hash TEXT NOT NULL,chat_hash TEXT NOT NULL,
   nonce TEXT NOT NULL,fingerprint TEXT,supersedes_id TEXT,state TEXT NOT NULL CHECK(state IN('prepared','account_committed','complete','cancelled')),
   target_user_id TEXT,target_session_hash TEXT,credential_tag TEXT,history_status TEXT,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,completed_at INTEGER
  );`);
  this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS account_auth_one_active ON account_auth_outcomes(company,workspace,origin,source_session_hash,chat_hash) WHERE state IN('prepared','account_committed')");
 }
 raw(cookie,name){const found=String(cookie||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(name+'='));return found.length===1?found[0].slice(name.length+1):'';}
 proofHash(secret){return hash(JSON.stringify([PROTOCOL,this.scope.company,this.scope.workspace,this.s.origin,secret]));}
 chatHash(cookie){return hash(this.raw(cookie,this.s.secure?'__Host-PalitraChat':'PalitraChatLocal'));}
 proofCookie(secret,id,age=86400){return `${this.proofPrefix}${id}=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${this.s.secure?'; Secure':''}`;}
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw error;}}
 requireRequest(h){if(h.origin!==this.s.origin||!/^application\/json(?:\s*;|$)/i.test(h['content-type']||''))throw fault(403,'Откройте форму на сайте.','AUTH_ORIGIN');}
 proofs(h){const result=[],pairs=String(h.cookie||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(this.proofPrefix));
  if(pairs.length>8)throw fault(400,'Слишком много незавершённых попыток. Откройте вход заново.','AUTH_PROOF_LIMIT');
  for(const pair of pairs){const i=pair.indexOf('='),id=pair.slice(this.proofPrefix.length,i),secret=pair.slice(i+1);
   if(!/^[0-9a-f-]{36}$/.test(id)||! /^[a-f0-9]{64}$/.test(secret))continue;
   const row=this.db.prepare('SELECT *,rowid AS sequence FROM account_auth_outcomes WHERE id=? AND proof_hash=? AND company=? AND workspace=? AND origin=?')
    .get(id,this.proofHash(secret),this.scope.company,this.scope.workspace,this.s.origin);
   if(row)result.push({row,secret});
  }return result;
 }
 row(h){const values=this.proofs(h),owned=values.filter(value=>this.own(value,h));
  const priority=value=>value.row.state==='account_committed'?3:value.row.state==='prepared'?2:value.row.state==='complete'?1:0;
  return (owned.length?owned:values).sort((a,b)=>priority(b)-priority(a)||b.row.sequence-a.row.sequence)[0]||null;
 }
 own(found,h){if(!found)return false;const raw=this.raw(h.cookie,this.s.cookieName);const token=/^[a-f0-9]{64}$/.test(raw)?this.s.tokenHash(raw):'';
  return (equal(token,found.row.source_session_hash)||found.row.target_session_hash&&equal(token,found.row.target_session_hash)
    ||found.row.action==='logout'&&found.row.state!=='prepared'&&!raw)&&equal(this.chatHash(h.cookie),found.row.chat_hash);
 }
 live(found){return found&&found.row.state!=='cancelled'&&found.row.expires_at>this.s.now();}
 csrf(found){return createHmac('sha256',found.secret).update(JSON.stringify([PROTOCOL,'csrf',this.s.origin,found.row.id])).digest('hex').slice(0,48);}
 material(found,userId){const base=JSON.stringify([PROTOCOL,this.scope.company,this.scope.workspace,this.s.origin,found.row.action,found.row.id,found.row.nonce,userId]);
  return{token:createHmac('sha256',found.secret).update('session|'+base).digest('hex'),csrf:createHmac('sha256',found.secret).update('session-csrf|'+base).digest('hex').slice(0,48)};
 }
 summary(found){return{protocol:PROTOCOL,attemptId:found.row.id,action:found.row.action,state:found.row.state==='account_committed'?'completion_pending':found.row.state,recoveryCsrf:this.csrf(found),recoverable:this.live(found)};}
 normalProof(h){const session=this.s.current(h.cookie);if(!session||!equal(String(h['x-csrf-token']||''),session.csrf))throw fault(403,'Обновите форму входа.','AUTH_SESSION');return session;}
 prepare(h,body){this.requireRequest(h);const session=this.normalProof(h);
  if(!body||Object.keys(body).join(',')!=='action'||!ACTIONS.has(body.action))throw fault(400,'Неизвестное действие входа.','AUTH_ACTION');
  const prior=this.row(h);
  if(prior&&this.live(prior)&&(prior.row.state==='account_committed'||prior.row.state==='prepared'&&prior.row.fingerprint)
   &&body.action!=='logout'&&(this.own(prior,h)||body.action!=='login'))throw fault(409,'Сначала проверьте исход предыдущей попытки. Если прежняя сессия потеряна, используйте вход по паролю.','AUTH_RECOVERY_REQUIRED');
  if(body.action==='register'&&((prior&&!this.live(prior)&&prior.row.action==='register'&&prior.row.state!=='prepared'&&prior.row.state!=='cancelled')||session.user_id))throw fault(409,'Используйте вход в уже созданный кабинет.','AUTH_USE_LOGIN');
  const secret=randomBytes(32).toString('hex'),id=randomUUID(),at=this.s.now();
  const prepared=this.transaction(()=>{
   const fresh=this.normalProof(h);if(!equal(fresh.token_hash,session.token_hash))throw fault(403,'Сессия изменилась.','AUTH_SESSION');
   let active=this.db.prepare(`SELECT * FROM account_auth_outcomes WHERE company=? AND workspace=? AND origin=? AND source_session_hash=? AND chat_hash=? AND state IN('prepared','account_committed')`)
    .get(this.scope.company,this.scope.workspace,this.s.origin,session.token_hash,this.chatHash(h.cookie));
   if(active?.state==='prepared'&&active.expires_at<=at){this.db.prepare("UPDATE account_auth_outcomes SET state='cancelled' WHERE id=? AND state='prepared'").run(active.id);active=null;}
   if(active){
    if(prior?.row.id===active.id&&active.state==='prepared'&&!active.fingerprint&&active.action===body.action)return{reuse:prior};
    if(active.state!=='prepared'||active.fingerprint)throw fault(409,'Сначала проверьте исход предыдущей попытки.','AUTH_RECOVERY_REQUIRED');
    // No credentials dispatched for this operation. Atomically invalidate it before
    // replacement; a delayed old prepare cookie has a DIFFERENT name and cannot overwrite us.
    this.db.prepare("UPDATE account_auth_outcomes SET state='cancelled' WHERE id=? AND state='prepared' AND fingerprint IS NULL").run(active.id);
   }
   this.db.prepare(`INSERT INTO account_auth_outcomes(id,proof_hash,company,workspace,origin,action,source_session_hash,source_csrf_hash,chat_hash,nonce,supersedes_id,state,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?)`).run(id,this.proofHash(secret),this.scope.company,this.scope.workspace,this.s.origin,body.action,session.token_hash,hash(session.csrf),this.chatHash(h.cookie),randomBytes(16).toString('hex'),prior&&this.own(prior,h)?prior.row.id:null,at,Math.min(at+1800000,session.expires_at));return{created:true};
  });
  if(prepared.reuse)return{status:200,body:{ok:true,authProtocol:PROTOCOL,authRecovery:this.summary(prepared.reuse)}};
  const found=this.row({...h,cookie:this.proofPrefix+id+'='+secret});
  const clear=this.proofs(h).map(value=>this.proofCookie('',value.row.id,0));
  return{status:200,headers:{'Set-Cookie':[...clear,this.proofCookie(secret,id)]},body:{ok:true,authProtocol:PROTOCOL,authRecovery:this.summary(found)}};
 }
 fingerprint(action,body){
  const allowed=action==='register'?new Set(['email','firstName','lastName','phone','address','newsletter','consent','password','passwordConfirm']):action==='login'?new Set(['email','password']):new Set();
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!allowed.has(k))||JSON.stringify(body).length>12000)throw fault(400,'Проверьте данные формы.','AUTH_BODY');
  // Never hash password/passwordConfirm into a fast replay verifier. Credential POSTs
  // always use normal scrypt validation; committed results use cookie-bound readback.
  return hash(JSON.stringify([action,...Object.keys(body).filter(k=>k!=='password'&&k!=='passwordConfirm').sort().map(k=>[k,body[k]])]));
 }
 claim(h,action,body){this.requireRequest(h);const found=this.row(h);
  if(!h['x-palitra-auth-attempt'])throw fault(409,'Эта отправка не выполнена. Обновите страницу и сначала проверьте, выполнен ли вход.','AUTH_UI_UPDATE');
  if(!this.live(found)||!this.own(found,h)||found.row.action!==action||h['x-palitra-auth-attempt']!==found.row.id)throw fault(409,'Подготовьте попытку входа заново.','AUTH_PROOF');
  if(!equal(hash(String(h['x-csrf-token']||'')),found.row.source_csrf_hash))throw fault(403,'Обновите форму входа.','AUTH_CSRF');
  const fingerprint=this.fingerprint(action,body);
  if(found.row.fingerprint&&!equal(found.row.fingerprint,fingerprint))throw fault(409,'Данные прежней попытки изменились. Сначала проверьте её исход.','AUTH_PAYLOAD_CHANGED');
  if(found.row.state!=='prepared')throw fault(409,'Исход уже сохранён. Проверьте результат без повторной регистрации.','AUTH_RESULT_AVAILABLE');
  const session=this.normalProof(h);if(!equal(session.token_hash,found.row.source_session_hash))throw fault(403,'Сессия изменилась.','AUTH_SESSION');
  this.db.prepare('UPDATE account_auth_outcomes SET fingerprint=? WHERE id=? AND state=\'prepared\' AND fingerprint IS NULL').run(fingerprint,found.row.id);
  found.row=this.db.prepare('SELECT * FROM account_auth_outcomes WHERE id=?').get(found.row.id);
  if(!equal(found.row.fingerprint,fingerprint))throw fault(409,'Данные попытки изменились.','AUTH_PAYLOAD_CHANGED');
  return{...found,session,fingerprint};
 }
 assertClaim(claim,h){const now=this.row(h);if(!this.live(now)||!this.own(now,h)||now.row.id!==claim.row.id||now.row.state!=='prepared'||!equal(now.row.fingerprint,claim.fingerprint))throw fault(409,'Попытка или сессия изменились. Проверьте результат.','AUTH_CHANGED');
  const current=this.normalProof(h);if(!equal(current.token_hash,claim.row.source_session_hash))throw fault(403,'Сессия изменилась.','AUTH_SESSION');return now;
 }
 commit(claim,h,write){
  try{this.transaction(()=>{
   this.assertClaim(claim,h);
   const target=write(userId=>this.material(claim,userId));
   if(claim.row.supersedes_id){
    const prior=this.db.prepare('SELECT target_session_hash FROM account_auth_outcomes WHERE id=? AND company=? AND workspace=? AND origin=?').get(claim.row.supersedes_id,this.scope.company,this.scope.workspace,this.s.origin);
    if(prior?.target_session_hash)this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(prior.target_session_hash);
    this.db.prepare("UPDATE account_auth_outcomes SET state='cancelled' WHERE id=? AND company=? AND workspace=? AND origin=?").run(claim.row.supersedes_id,this.scope.company,this.scope.workspace,this.s.origin);
   }
   this.db.prepare(`UPDATE account_auth_outcomes SET state='cancelled' WHERE id<>? AND company=? AND workspace=? AND origin=?
    AND (source_session_hash=? OR target_session_hash=?)`).run(claim.row.id,this.scope.company,this.scope.workspace,this.s.origin,claim.session.token_hash,claim.session.token_hash);
   this.db.prepare(`UPDATE account_auth_outcomes SET state='account_committed',target_user_id=?,target_session_hash=?,credential_tag=? WHERE id=? AND state='prepared'`)
    .run(target.userId,target.sessionHash,target.credentialTag,claim.row.id);
  });}catch(error){
   // COMMIT may have executed before the exception: durable bytes decide, never retry INSERT.
   const persisted=this.row(h);
   if(!persisted||!['account_committed','complete'].includes(persisted.row.state))throw error;
  }
  return this.finish(h,claim.row.id);
 }
 target(found){if(found.row.action==='logout')return null;
  const user=this.db.prepare('SELECT * FROM users WHERE id=?').get(found.row.target_user_id);
  const session=this.db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(found.row.target_session_hash,this.s.now());
  if(!user||!session||session.user_id!==user.id||!equal(hash(user.password_hash),found.row.credential_tag))throw fault(401,'Войдите обычным способом. Доступ к прежнему результату недоступен.','AUTH_RESULT_REVOKED');
  const material=this.material(found,user.id);if(!equal(this.s.tokenHash(material.token),session.token_hash))throw fault(401,'Результат входа не подтверждён.','AUTH_RESULT_REVOKED');
  return{user,session,material};
 }
 finish(h,attemptId){let found=this.row(h);
  if(!this.live(found)||!this.own(found,h)||found.row.id!==attemptId||!['account_committed','complete'].includes(found.row.state))throw fault(401,'Результат этой попытки недоступен. Войдите обычным способом.','AUTH_RECOVERY_UNAVAILABLE');
  const target=this.target(found);let pending=false;
  if(found.row.state!=='complete'){
   try{
    // Exact original chat-cookie hash checked above. A later G2 can never be closed here.
    const completion=this.s.completeAuthContent(h,found.row);
    this.transaction(()=>this.db.prepare("UPDATE account_auth_outcomes SET state='complete',history_status=?,completed_at=? WHERE id=? AND state='account_committed'").run(completion.historyAccess,this.s.now(),attemptId));
   }catch(_){found=this.row(h);pending=found?.row.state!=='complete';}
  }
  found=this.row(h);
  if(!this.live(found)||!this.own(found,h)||!['account_committed','complete'].includes(found.row.state))throw fault(401,'Сессия изменилась.','AUTH_CHANGED');
  if(target)this.target(found); // recheck generation/revocation before returning authority
  return{status:pending?202:200,headers:{'Set-Cookie':target?this.s.cookie(target.material.token,Math.max(0,Math.floor((target.session.expires_at-this.s.now())/1000))):this.s.cookie('',0)},
   body:{ok:!pending,user:target?publicUser(target.user):null,csrf:target?target.session.csrf:this.csrf(found),authProtocol:PROTOCOL,
    authRecovery:pending?this.summary(found):null,authOutcome:{attemptId,state:pending?'completion_pending':'completed',action:found.row.action,historyAccess:found.row.history_status||'pending'},
    ...(pending?{message:'Вход сохранён. Завершение пока не подтверждено; проверьте результат, не регистрируйтесь повторно.'}:{})}};
 }
 recovery(h,body,{cancel=false}={}){this.requireRequest(h);const found=this.row(h);
  if(!body||Object.keys(body).join(',')!=='attemptId'||!this.live(found)||!this.own(found,h)||body.attemptId!==found.row.id||!equal(String(h['x-csrf-token']||''),this.csrf(found)))throw fault(401,'Результат этой попытки недоступен.','AUTH_RECOVERY_UNAVAILABLE');
  if(cancel){if(found.row.state!=='prepared')throw fault(409,'Аккаунт мог быть создан. Сначала проверьте результат.','AUTH_RESULT_AVAILABLE');
   this.db.prepare("UPDATE account_auth_outcomes SET state='cancelled' WHERE id=? AND state='prepared'").run(found.row.id);
   return{status:200,headers:{'Set-Cookie':this.proofCookie('',found.row.id,0)},body:{ok:true,cancelled:true}};
  }
  if(found.row.state==='prepared'){const source=this.s.current(h.cookie);return{status:200,body:{ok:false,user:publicUser(this.s.user(source)),csrf:source?.csrf||this.csrf(found),authProtocol:PROTOCOL,authRecovery:{...this.summary(found),requiresCredentials:true},message:'Вход ещё не подтверждён. Введите данные формы заново или отмените эту попытку.'}};}
  return this.finish(h,found.row.id);
 }
 snapshot(h,existing){const found=this.row(h);if(!found||!this.own(found,h))return null;
  if(!this.live(found)){
   if(found.row.state==='cancelled'||existing?.user_id)return null;
   return{state:'expired',recoverable:false,action:found.row.action,protocol:PROTOCOL};
  }
  if(found.row.action!=='logout'&&['account_committed','complete'].includes(found.row.state)){
   try{this.target(found);}catch(_){return{state:'unavailable',recoverable:false,action:found.row.action,protocol:PROTOCOL};}
  }
  if(found.row.state==='complete'&&(found.row.action==='logout'||existing?.token_hash===found.row.target_session_hash))return null;
  return this.summary(found);
 }
 completed(h,existing){const found=this.row(h);return this.live(found)&&this.own(found,h)&&found.row.state==='complete'&&(found.row.action==='logout'||existing?.token_hash===found.row.target_session_hash)
  ?{attemptId:found.row.id,action:found.row.action,state:'completed',historyAccess:found.row.history_status}:null;}
}
module.exports={AuthOutcome,PROTOCOL};
