'use strict';
// Вход и права Palitra CRM. Область — только palitra-love/palitra; глобальной роли Synapse здесь нет.
// Всё, что пришло по HTTP (initData, токены, orderId, actor из JSON), считается недоверенным.
// Функции с пометкой SERVER-ONLY не подключаются к публичным маршрутам: их вызывает только
// интеграционный код после собственной проверки полномочий инициатора. Модуль сам права инициатора не проверяет.
const {createHash,createPublicKey,randomBytes,verify}=require('node:crypto');
const SITE='palitra', COMPANY='palitra-love';
// Production-ключ Telegram для проверки initData третьей стороной (core.telegram.org/bots/webapps, Validating data for Third-Party Use).
const TELEGRAM_PUBLIC_KEY_HEX='e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d';
const ROLES=['owner','admin','customer'], STAFF=['owner','admin'];
const MAX_INIT_DATA=8192, MAX_PARAMS=32, MAX_AGE_S=300, MAX_FUTURE_S=60, CLAIM_TTL_MS=15*60*1000;
const SESSION_RE=/^pcrm\.[A-Za-z0-9_-]{43}$/, CLAIM_RE=/^pclm\.[A-Za-z0-9_-]{43}$/;
const SITE_SESSION_REF_RE=/^[a-f0-9]{64}$/;
const SUBJECT_RE={telegram:/^[1-9]\d{0,15}$/,site:/^[A-Za-z0-9_.:@-]{1,128}$/};
function fail(status,message){throw Object.assign(new Error(message),{status});}
const sha256=(value)=>createHash('sha256').update(value).digest('hex');
const newToken=(prefix)=>`${prefix}.${randomBytes(32).toString('base64url')}`;
function principalOf(p){
  if(!p||typeof p!=='object'||typeof p.provider!=='string'||!Object.hasOwn(SUBJECT_RE,p.provider)||typeof p.subject!=='string'||!SUBJECT_RE[p.provider].test(p.subject))fail(400,'Проверьте пользователя');
  if(p.provider==='telegram'&&!Number.isSafeInteger(Number(p.subject)))fail(400,'Проверьте пользователя');
  return {provider:p.provider,subject:p.subject};
}
function nameOf(value){if(value===undefined||value===null)return '';if(typeof value!=='string'||value.length>128)fail(400,'Проверьте имя');return value.trim();}
function parseOrderId(value){const id=typeof value==='number'?value:typeof value==='string'&&/^\d{1,15}$/.test(value)?Number(value):NaN;return Number.isSafeInteger(id)&&id>0?id:null;}
function orderIdOf(value){const id=parseOrderId(value);if(!id)fail(404,'Заказ не найден');return id;}
function auditOf(actor){if(!actor||typeof actor!=='object'||typeof actor.id!=='string'||!actor.id.trim()||actor.id.length>128)fail(400,'Нужен инициатор изменения');return actor.id.trim();}

/* PRODUCTION-INTEGRATION 13.10.2026 (Phase 2). Все функции ниже — HOST-ONLY, синхронные, вызываются при КАЖДОМ
   использовании CRM-сессии; ошибка или async-ответ хоста роли/доступа не дают.
   siteRole({provider:'site',subject})          → 'owner'|'admin'|null по текущему серверному праву хоста.
   siteStaff()                                  → [{provider:'site',subject,name,role}] действующих сотрудников хоста.
   telegramBind({provider:'telegram',subject})  → 64 hex или null: ссылка хоста на ТЕКУЩУЮ проверенную привязку
                                                  Telegram→аккаунт (вызывается только после проверки подписи initData).
   telegramRole({provider:'telegram',subject,ref}) → 'owner'|'admin'|null, только пока та же привязка действует.
   hostOrders({provider,subject})              → id заказов CRM, принадлежность которых хост подтвердил сам
                                                  (например, использованная одноразовая ссылка клиентского бота). */
function createCrmAccess({db,botId,publicKeyHex=TELEGRAM_PUBLIC_KEY_HEX,now=Date.now,sessionTtlMs=12*60*60*1000,validateSiteSession=null,
  siteRole=null,siteStaff=null,telegramBind=null,telegramRole=null,hostOrders=null}){
  const bot=String(botId??'');
  if(!/^[1-9]\d{0,19}$/.test(bot))throw new Error('createCrmAccess: botId required');
  if(typeof publicKeyHex!=='string'||!/^[0-9a-fA-F]{64}$/.test(publicKeyHex))throw new Error('createCrmAccess: invalid publicKeyHex');
  if(!Number.isSafeInteger(sessionTtlMs)||sessionTtlMs<60000)throw new Error('createCrmAccess: invalid sessionTtlMs');
  for(const [name,fn] of Object.entries({validateSiteSession,siteRole,siteStaff,telegramBind,telegramRole,hostOrders})){
    if(fn!==null&&typeof fn!=='function')throw new TypeError(`createCrmAccess: invalid ${name}`);
  }
  const publicKey=createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:Buffer.from(publicKeyHex,'hex').toString('base64url')},format:'jwk'});
  const clock=()=>Math.floor(now());
  db.exec(`
    CREATE TABLE IF NOT EXISTS palitra_crm_memberships(company_code TEXT NOT NULL, provider TEXT NOT NULL, subject TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','admin','customer')), active INTEGER NOT NULL CHECK(active IN (0,1)), version INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(company_code,provider,subject));
    CREATE TABLE IF NOT EXISTS palitra_crm_sessions(token_hash TEXT PRIMARY KEY, company_code TEXT NOT NULL, provider TEXT NOT NULL, subject TEXT NOT NULL, name TEXT NOT NULL, membership_version INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, site_session_ref TEXT);
    CREATE TABLE IF NOT EXISTS palitra_crm_nonces(nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS palitra_crm_grants(company_code TEXT NOT NULL, provider TEXT NOT NULL, subject TEXT NOT NULL, order_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(company_code,provider,subject,order_id));
    CREATE TABLE IF NOT EXISTS palitra_crm_claims(token_hash TEXT PRIMARY KEY, company_code TEXT NOT NULL, order_id INTEGER NOT NULL, provider TEXT NOT NULL, subject TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
    CREATE TABLE IF NOT EXISTS palitra_crm_audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, provider TEXT, subject TEXT, order_id INTEGER, details TEXT NOT NULL);
  `);
  // Старые site-сессии без ссылки на исходную сессию после миграции закрыты, Telegram не меняется.
  if(!db.prepare('PRAGMA table_info(palitra_crm_sessions)').all().some(c=>c.name==='site_session_ref'))
    db.exec('ALTER TABLE palitra_crm_sessions ADD COLUMN site_session_ref TEXT');
  let depth=0;
  const tx=(fn)=>{const savepoint=`pcrm_${++depth}`;db.exec(`SAVEPOINT ${savepoint}`);try{const result=fn();db.exec(`RELEASE ${savepoint}`);return result;}catch(error){db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);throw error;}finally{depth--;}};
  // Выданные resolve() объекты actor → хэш сессии. Объект, собранный из клиентского JSON, сюда не попадает.
  const issued=new WeakMap();
  const audit=(actor,action,p,orderId,details={})=>db.prepare('INSERT INTO palitra_crm_audit(at,actor,action,provider,subject,order_id,details) VALUES(?,?,?,?,?,?,?)').run(clock(),actor,action,p?.provider??null,p?.subject??null,orderId??null,JSON.stringify(details));
  const membership=(p)=>db.prepare('SELECT * FROM palitra_crm_memberships WHERE company_code=? AND provider=? AND subject=?').get(COMPANY,p.provider,p.subject);
  // Заказ — запись CRM Palitra (palitra_crm_orders, создаётся workspace). Пока таблицы нет, заказов нет.
  const orderExists=(id)=>{try{return !!db.prepare('SELECT 1 AS ok FROM palitra_crm_orders WHERE id=? AND company_code=?').get(id,COMPANY);}catch{return false;}};
  const requireOrder=(id)=>{if(!orderExists(id))fail(404,'Заказ не найден');};
  const hasGrant=(p,id)=>!!db.prepare('SELECT 1 AS ok FROM palitra_crm_grants WHERE company_code=? AND provider=? AND subject=? AND order_id=?').get(COMPANY,p.provider,p.subject,id);
  // Синхронный ответ хоста; обещание/исключение — отказ (роли и доступа нет), без unhandled rejection.
  const hostCall=(fn,arg)=>{try{const value=fn(Object.freeze(arg));if(value&&typeof value.then==='function'){Promise.resolve(value).catch(()=>{});return undefined;}return value;}catch{return undefined;}};
  const hostOrderIds=(p)=>{
    if(typeof hostOrders!=='function')return [];
    const value=hostCall(hostOrders,{provider:p.provider,subject:p.subject});
    return Array.isArray(value)?value.filter(id=>Number.isSafeInteger(id)&&id>0):[];
  };
  const grantedOrders=(p)=>[...new Set([...db.prepare('SELECT order_id FROM palitra_crm_grants WHERE company_code=? AND provider=? AND subject=? ORDER BY order_id').all(COMPANY,p.provider,p.subject).map(r=>r.order_id),...hostOrderIds(p)])]
    .filter(orderExists).sort((a,b)=>a-b);
  // Роль хоста: site — по текущему праву аккаунта; telegram — только по ссылке на действующую проверенную привязку.
  function hostRole(p,ref){
    let role;
    if(p.provider==='site'&&typeof siteRole==='function')role=hostCall(siteRole,{provider:'site',subject:p.subject});
    else if(p.provider==='telegram'&&typeof telegramRole==='function'&&typeof ref==='string'&&SITE_SESSION_REF_RE.test(ref))role=hostCall(telegramRole,{provider:'telegram',subject:p.subject,ref});
    return STAFF.includes(role)?role:null;
  }
  function telegramRef(p){
    if(typeof telegramBind!=='function')return null;
    const value=hostCall(telegramBind,{provider:'telegram',subject:p.subject});
    return typeof value==='string'&&SITE_SESSION_REF_RE.test(value)?value:null;
  }

  // HOST-ONLY: validateSiteSession({provider:'site', subject, sessionRef}) синхронно возвращает
  // строго true, если исходная сессия сайта и её пользователь всё ещё действуют. Хост Synapse
  // хранит вход в HMAC-cookie synapse_session с sessionVersion (server.js requireSession/requireCsrf);
  // sessionRef — 64 hex, которые хост сам выводит из уже проверенной сессии, НЕ cookie и не токен. Адаптер
  // хоста при каждом вызове заново проверяет исходную сессию (срок, выход, отзыв, версию аккаунта).
  // Никаких полей HTTP JSON, имён и контактов для этой проверки.
  function validSiteSession(p,sessionRef){
    if(typeof validateSiteSession!=='function'||typeof sessionRef!=='string'||!SITE_SESSION_REF_RE.test(sessionRef))return false;
    return hostCall(validateSiteSession,{provider:'site',subject:p.subject,sessionRef})===true;
  }

  function verifyTelegram(initData){
    const deny=()=>fail(401,'Не удалось подтвердить вход через Telegram');
    if(typeof initData!=='string'||!initData||initData.length>MAX_INIT_DATA)deny();
    const fields=new Map();
    for(const [key,value] of new URLSearchParams(initData)){
      if(fields.size>=MAX_PARAMS||fields.has(key)||!/^[a-z][a-z0-9_]{0,63}$/.test(key)||value.length>4096||/[\r\n\0]/.test(value))deny();
      fields.set(key,value);
    }
    const signature=fields.get('signature'), authDate=fields.get('auth_date');
    if(!signature||!/^[A-Za-z0-9_-]{86}={0,2}$/.test(signature)||!authDate||!/^[1-9]\d{0,11}$/.test(authDate))deny();
    const age=clock()/1000-Number(authDate);
    if(age>MAX_AGE_S||age<-MAX_FUTURE_S)deny();
    const check=[...fields].filter(([key])=>key!=='hash'&&key!=='signature').sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>`${key}=${value}`).join('\n');
    const data=Buffer.from(`${bot}:WebAppData\n${check}`);
    let valid=false;try{valid=verify(null,data,publicKey,Buffer.from(signature,'base64url'));}catch{valid=false;}
    if(!valid)deny();
    let user;try{user=JSON.parse(fields.get('user')??'');}catch{deny();}
    if(!user||typeof user!=='object'||typeof user.id!=='number'||!Number.isSafeInteger(user.id)||user.id<1)deny();
    const name=[user.first_name,user.last_name].filter(v=>typeof v==='string').join(' ').trim().slice(0,128)||'Telegram';
    // nonce зависит только от подписанного содержимого: порядок параметров, hash и кодирование его не меняют.
    return {provider:'telegram',subject:String(user.id),name,nonce:sha256(data),authDate:Number(authDate)};
  }

  function openSession(p,name,siteSessionRef=null){
    if(p.provider==='site'&&!validSiteSession(p,siteSessionRef))fail(401,'Войдите в аккаунт сайта заново');
    const m=membership(p);if(m&&!m.active)fail(403,'Доступ закрыт');
    // Telegram: ссылка на привязку берётся ТОЛЬКО после проверки подписи initData этим ботом (exchangeTelegram).
    const ref=p.provider==='site'?siteSessionRef:p.provider==='telegram'?telegramRef(p):null;
    const value=newToken('pcrm'), at=clock();
    db.prepare('DELETE FROM palitra_crm_sessions WHERE expires_at<=?').run(at);
    db.prepare('INSERT INTO palitra_crm_sessions(token_hash,company_code,provider,subject,name,membership_version,created_at,expires_at,site_session_ref) VALUES(?,?,?,?,?,?,?,?,?)').run(sha256(value),COMPANY,p.provider,p.subject,name,m?.version??0,at,at+sessionTtlMs,ref);
    return {token:value,expiresAt:at+sessionTtlMs};
  }
  // Роль не выводится из имени, username, start_param или полей клиента: только из palitra_crm_memberships
  // либо из текущего серверного права хоста (siteRole / проверенная привязка telegramRole).
  // Неизвестный подтверждённый пользователь — customer без чужих заказов.
  function exchangeTelegram(initData){
    const v=verifyTelegram(initData);
    return tx(()=>{
      db.prepare('DELETE FROM palitra_crm_nonces WHERE expires_at<?').run(clock());
      const used=db.prepare('INSERT OR IGNORE INTO palitra_crm_nonces(nonce,expires_at) VALUES(?,?)').run(v.nonce,(v.authDate+MAX_AGE_S+1)*1000);
      if(Number(used.changes)!==1)fail(401,'Не удалось подтвердить вход через Telegram');
      return openSession({provider:'telegram',subject:v.subject},v.name);
    });
  }
  // SERVER-ONLY: {provider:'site',subject,name?,sessionRef}. Сначала host проверяет HMAC-cookie и CSRF,
  // затем передаёт id аккаунта и выведенный им sessionRef. validateSiteSession дополнительно проверяет
  // эту связь при выдаче и каждом использовании CRM-сессии; не передавать сюда клиентский JSON.
  function exchangeSite(principal){
    if(principal?.provider!=='site'||Object.keys(principal).some(k=>!['provider','subject','name','sessionRef'].includes(k)))fail(400,'Проверьте пользователя');
    const p=principalOf(principal);
    return tx(()=>openSession(p,nameOf(principal.name),principal.sessionRef));
  }

  function load(tokenHash){
    const s=db.prepare('SELECT * FROM palitra_crm_sessions WHERE token_hash=? AND company_code=?').get(tokenHash,COMPANY);
    if(!s||s.revoked_at!==null||s.expires_at<=clock())return null;
    const p={provider:s.provider,subject:s.subject}, m=membership(p);
    if(p.provider==='site'&&!validSiteSession(p,s.site_session_ref))return null;
    // Любая смена роли/деактивация повышает version → все ранее выданные сессии сразу недействительны.
    if((m?.version??0)!==s.membership_version||(m&&!m.active))return null;
    // Роль хоста перечитывается при каждом использовании: снятие права, отвязка Telegram, смена версии аккаунта
    // действуют сразу и на уже выданные сессии.
    return {p,role:hostRole(p,s.site_session_ref)??m?.role??'customer',name:m?.name||s.name};
  }
  function resolve(token){
    if(typeof token!=='string'||!SESSION_RE.test(token))return null;
    const hash=sha256(token), state=load(hash);if(!state)return null;
    const actor=Object.freeze({id:`${state.p.provider}:${state.p.subject}`,name:state.name,role:state.role,companyCode:COMPANY,
      principal:Object.freeze({...state.p}),allowedOrderIds:Object.freeze(state.role==='customer'?grantedOrders(state.p):[])});
    issued.set(actor,hash);return actor;
  }
  // Повторно проверяет сессию, membership, scope заказа, grants и подтверждения хоста. actor.role/allowedOrderIds не используются.
  function hasOrderAccess(orderId,actor){
    const hash=actor&&typeof actor==='object'?issued.get(actor):undefined;if(!hash)return false;
    const state=load(hash), id=parseOrderId(orderId);
    if(!state||!id||!orderExists(id))return false;
    return STAFF.includes(state.role)||hasGrant(state.p,id)||hostOrderIds(state.p).includes(id);
  }
  // Сотрудники Palitra для выбора ответственного: действующие membership owner/admin и сотрудники хоста (siteStaff),
  // не username и не имя. Повтор того же principal не дублируется.
  function staffMembers(){
    const list=db.prepare("SELECT provider,subject,name,role FROM palitra_crm_memberships WHERE company_code=? AND active=1 AND role IN ('owner','admin') ORDER BY role DESC,name")
      .all(COMPANY).map(m=>({id:`${m.provider}:${m.subject}`,name:m.name||'Сотрудник',role:m.role}));
    if(typeof siteStaff!=='function')return list;
    const value=hostCall(siteStaff,{}), extra=Array.isArray(value)?value:[];
    const seen=new Set(list.map(m=>m.id));
    for(const m of extra){
      if(!m||m.provider!=='site'||typeof m.subject!=='string'||!SUBJECT_RE.site.test(m.subject)||!STAFF.includes(m.role))continue;
      // Только тот, кому хост сейчас даёт эту роль.
      if(hostRole({provider:'site',subject:m.subject},null)!==m.role)continue;
      const id=`site:${m.subject}`;if(seen.has(id))continue;seen.add(id);
      list.push({id,name:typeof m.name==='string'&&m.name.trim()?m.name.trim().slice(0,128):'Сотрудник',role:m.role});
    }
    return list;
  }
  // Текущая роль по выданной сессии (с повторной проверкой сессии и membership), а не по полю actor.
  function currentRole(actor){const hash=actor&&typeof actor==='object'?issued.get(actor):undefined;if(!hash)return null;const state=load(hash);return state?state.role:null;}
  function revokeSession(token){
    if(typeof token!=='string'||!SESSION_RE.test(token))return false;
    return Number(db.prepare('UPDATE palitra_crm_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL').run(clock(),sha256(token)).changes)===1;
  }

  // SERVER-ONLY, не публичный маршрут и не проверка прав: вызывать только после проверки владельца ресурса в интеграции.
  // Роль owner действует лишь внутри palitra-love. Смена роли или active повышает version и отзывает прежние сессии.
  function setMembership(input,auditActor){
    const by=auditOf(auditActor), p=principalOf(input);
    if(!ROLES.includes(input.role))fail(400,'Проверьте роль');
    if(typeof input.active!=='boolean')fail(400,'Проверьте статус доступа');
    const name=nameOf(input.name), active=input.active?1:0, at=clock();
    return tx(()=>{
      const prev=membership(p);
      const version=prev?prev.version+(prev.role!==input.role||prev.active!==active?1:0):1;
      if(prev)db.prepare('UPDATE palitra_crm_memberships SET name=?,role=?,active=?,version=?,updated_at=? WHERE company_code=? AND provider=? AND subject=?').run(name,input.role,active,version,at,COMPANY,p.provider,p.subject);
      else db.prepare('INSERT INTO palitra_crm_memberships(company_code,provider,subject,name,role,active,version,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(COMPANY,p.provider,p.subject,name,input.role,active,version,at);
      audit(by,'membership.set',p,null,{role:input.role,active:input.active,version});
      return {...p,name,role:input.role,active:input.active,version};
    });
  }
  // SERVER-ONLY: доступ клиента к одной существующей заявке Palitra. Совпадение контакта на другие заявки не переносится.
  function grantOrder(input,auditActor){
    const by=auditOf(auditActor), p=principalOf(input), id=orderIdOf(input.orderId);
    return tx(()=>{requireOrder(id);
      const created=Number(db.prepare('INSERT OR IGNORE INTO palitra_crm_grants(company_code,provider,subject,order_id,created_at) VALUES(?,?,?,?,?)').run(COMPANY,p.provider,p.subject,id,clock()).changes)===1;
      audit(by,'order.grant',p,id,{created});return {ok:true,orderId:id,created};});
  }
  // SERVER-ONLY: действует сразу, в том числе на уже выданные сессии.
  function revokeOrder(input,auditActor){
    const by=auditOf(auditActor), p=principalOf(input), id=orderIdOf(input.orderId);
    return tx(()=>{const removed=Number(db.prepare('DELETE FROM palitra_crm_grants WHERE company_code=? AND provider=? AND subject=? AND order_id=?').run(COMPANY,p.provider,p.subject,id).changes)===1;
      audit(by,'order.revoke',p,id,{removed});return {ok:true,orderId:id,removed};});
  }
  // SERVER-ONLY: одноразовая ссылка на конкретный заказ для заранее известного principal.
  // Владение заказом и вторую личность доказывает вызывающий код; модуль это не изобретает. В БД только SHA-256 токена.
  function issueClaim(input,auditActor){
    const by=auditOf(auditActor), id=orderIdOf(input?.orderId), p=principalOf(input.expectedPrincipal);
    return tx(()=>{requireOrder(id);
      const value=newToken('pclm'), at=clock();
      db.prepare('INSERT INTO palitra_crm_claims(token_hash,company_code,order_id,provider,subject,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(sha256(value),COMPANY,id,p.provider,p.subject,at,at+CLAIM_TTL_MS);
      audit(by,'claim.issue',p,id);return {token:value,orderId:id,expiresAt:at+CLAIM_TTL_MS};});
  }
  // Чужой principal ссылку не расходует; все отказы одинаковы и не раскрывают заказ.
  function claimOrder(claimToken,sessionToken){
    const actor=resolve(sessionToken);if(!actor)fail(401,'Войдите заново');
    const invalid=()=>fail(404,'Ссылка недействительна или устарела');
    if(typeof claimToken!=='string'||!CLAIM_RE.test(claimToken))invalid();
    const hash=sha256(claimToken), p=actor.principal;
    return tx(()=>{
      const c=db.prepare('SELECT * FROM palitra_crm_claims WHERE token_hash=? AND company_code=?').get(hash,COMPANY);
      if(!c||c.used_at!==null||c.expires_at<=clock()||c.provider!==p.provider||c.subject!==p.subject||!orderExists(c.order_id))invalid();
      if(Number(db.prepare('UPDATE palitra_crm_claims SET used_at=? WHERE token_hash=? AND used_at IS NULL').run(clock(),hash).changes)!==1)invalid();
      db.prepare('INSERT OR IGNORE INTO palitra_crm_grants(company_code,provider,subject,order_id,created_at) VALUES(?,?,?,?,?)').run(COMPANY,p.provider,p.subject,c.order_id,clock());
      audit(actor.id,'claim.use',p,c.order_id);return {ok:true,orderId:c.order_id};
    });
  }
  return {verifyTelegram,exchangeTelegram,exchangeSite,resolve,hasOrderAccess,currentRole,staffMembers,revokeSession,setMembership,grantOrder,revokeOrder,issueClaim,claimOrder};
}
module.exports={createCrmAccess,TELEGRAM_PUBLIC_KEY_HEX,COMPANY,SITE};
