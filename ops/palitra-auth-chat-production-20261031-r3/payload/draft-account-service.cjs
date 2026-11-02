'use strict';
const {DatabaseSync}=require('node:sqlite');
const {randomBytes,randomUUID,createHash,scrypt,timingSafeEqual}=require('node:crypto');
const {promisify}=require('node:util');
const {AuthOutcome,PROTOCOL}=require('./account-auth-outcome.cjs');
const derive=promisify(scrypt);
const ID=/^[a-z0-9][a-z0-9_-]{0,79}$/i;
const digest=value=>createHash('sha256').update(value).digest('hex');
const SCRYPT={N:32768,r:8,p:3,maxmem:64*1024*1024};
const text=(value,max,required=true)=>{if(typeof value!=='string'||value.length>max||(required&&!value.trim()))throw fault(400,'Проверьте заполнение полей.');return value.trim();};
function fault(status,message){return Object.assign(new Error(message),{status});}
function email(value){const v=text(value,160).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))throw fault(400,'Проверьте E-Mail.');return v;}
function profile(body,previous=null,optionalDemographics=false){const demographic=(key,max)=>optionalDemographics?text(body[key]===undefined?(previous?.[key]??''):body[key],max,false):text(body[key],max);const p={firstName:text(body.firstName,80),lastName:demographic('lastName',80),phone:text(body.phone,32),address:demographic('address',500)};const digits=p.phone.replace(/\D/g,'');if(digits.length<10||digits.length>15)throw fault(400,'Проверьте телефон.');return p;}
function password(value){if(typeof value!=='string'||value.length<12||value.length>128)throw fault(400,'Пароль должен содержать от 12 до 128 символов.');return value;}
async function hashPassword(value){const salt=randomBytes(16).toString('hex');const hash=await derive(value,salt,64,SCRYPT);return salt+':'+hash.toString('hex');}
async function matches(value,stored){const [salt,key]=stored.split(':');const actual=await derive(value,salt,64,SCRYPT);const expected=Buffer.from(key,'hex');return expected.length===actual.length&&timingSafeEqual(expected,actual);}
function publicUser(row){return row?{id:row.id,email:row.email,firstName:row.first_name,lastName:row.last_name,phone:row.phone,address:row.address}:null;}

class AccountService {
  #optionalDemographics=false;
  #preliminary=null;
  #outcome=null;
  constructor({database=':memory:',origin,now=Date.now,sessionSeconds=86400*7,approvedOrigin=null,sessionScope=null,optionalDemographics=false,preliminary=null,authOutcomeScope=null}={}){
    if(!origin)throw new Error('An explicit independent draft origin is required');
    const parsed=new URL(origin);const local=['127.0.0.1','localhost','[::1]'].includes(parsed.hostname);
    // PALITRA: a protected production/shared hostname is allowed only when the host passes exactly this origin as approvedOrigin.
    if(parsed.origin!==origin||parsed.username||parsed.password||(!local&&parsed.protocol!=='https:')||(approvedOrigin!==origin&&['palitra-love.ru','www.palitra-love.ru','palitra-love.synapsebusiness.ru'].includes(parsed.hostname)))throw new Error('Production and shared-alias origins are forbidden');
    this.origin=origin;this.secure=!local;this.cookieName=this.secure?'__Host-PalitraDraftSession':'PalitraDraftSession';
    this.#optionalDemographics=optionalDemographics===true;
    if(preliminary!==null&&(typeof preliminary.read!=='function'||typeof preliminary.transition!=='function'||typeof preliminary.rename!=='function'||typeof preliminary.registerOutcome!=='function'))throw new TypeError('Incomplete preliminary provider');
    if(preliminary!==null&&(!authOutcomeScope||authOutcomeScope.company!=='palitra-love'||typeof authOutcomeScope.workspace!=='string'||!/^[-\w]{1,128}$/.test(authOutcomeScope.workspace)))throw new TypeError('Explicit fixed Palitra auth scope required');
    this.#preliminary=preliminary;
    this.now=now;this.sessionSeconds=sessionSeconds;this.db=new DatabaseSync(database);
    // PALITRA-MAIN: another approved origin of the same account database stores its session hashes in its own scope.
    this.sessionScope=typeof sessionScope==='string'&&sessionScope?sessionScope:null;
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,first_name TEXT NOT NULL,last_name TEXT NOT NULL,phone TEXT NOT NULL,address TEXT NOT NULL,newsletter INTEGER NOT NULL DEFAULT 0,consented_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS wishlist(user_id TEXT NOT NULL REFERENCES users(id),item_id TEXT NOT NULL,PRIMARY KEY(user_id,item_id));
      CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,reset_at INTEGER NOT NULL);`);
    if(this.#preliminary)this.#outcome=new AuthOutcome(this,authOutcomeScope);
    this.dummy=hashPassword(randomBytes(24).toString('hex'));
    this.expensivePending=0;
  }
  close(){this.db.close();}
  tokenHash(token){return digest(this.sessionScope?this.sessionScope+'|'+token:token);}
  cookie(token,age=this.sessionSeconds){return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${this.secure?'; Secure':''}`;}
  current(cookie=''){
    const match=String(cookie).split(';').map(v=>v.trim()).find(v=>v.startsWith(this.cookieName+'='));const token=match?.slice(this.cookieName.length+1)||'';
    if(!/^[a-f0-9]{64}$/.test(token))return null;
    const session=this.db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(this.tokenHash(token),this.now());
    return session?{...session,token}:null;
  }
  user(session){return session?.user_id?this.db.prepare('SELECT * FROM users WHERE id=?').get(session.user_id):null;}
  issue(userId=null,old=null,material=null){
    const token=material?.token||randomBytes(32).toString('hex'),csrf=material?.csrf||randomBytes(24).toString('hex');
    if(!/^[a-f0-9]{64}$/.test(token)||!/^[a-f0-9]{48}$/.test(csrf))throw new TypeError('Invalid server session material');
    if(old)this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(old.token_hash);
    this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(this.now());
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(this.tokenHash(token),userId,csrf,this.now()+(userId?this.sessionSeconds:1800)*1000);
    return {token,csrf,user_id:userId,token_hash:this.tokenHash(token)};
  }
  rate(key,max,seconds){
    const now=this.now();this.db.prepare('DELETE FROM rate_limits WHERE reset_at<=?').run(now);
    const row=this.db.prepare('SELECT * FROM rate_limits WHERE key=?').get(key);
    if(row&&row.count>=max)throw fault(429,'Слишком много попыток. Попробуйте позже.');
    if(row)this.db.prepare('UPDATE rate_limits SET count=count+1 WHERE key=?').run(key);
    else this.db.prepare('INSERT INTO rate_limits VALUES(?,?,?)').run(key,1,now+seconds*1000);
  }
  async expensive(fn){if(this.expensivePending>=4)throw fault(429,'Попробуйте ещё раз немного позже.');this.expensivePending++;try{return await fn();}finally{this.expensivePending--;}}
  // Palitra-only injected bridge. No phone lookup; preliminary never changes users/user_id.
  preliminarySnapshot(cookie,user){
    if(!this.#preliminary)return {};
    if(user)return {preliminary:null};
    return {preliminary:this.#preliminary.read({cookie:String(cookie||''),origin:this.origin})};
  }
  completeAuthContent(headers,outcome){
    const context={cookie:String(headers.cookie||''),origin:this.origin};
    if(outcome.action==='register')return this.#preliminary.registerOutcome(context,{userId:outcome.target_user_id,outcomeId:outcome.id});
    this.#preliminary.transition(context,()=>({ok:true}));return{historyAccess:'separate'};
  }
  async durableAuth({method,path,h,body,ip,existing}){
    if(method==='GET'&&path==='/session'){
      if(h.origin!==undefined&&h.origin!==this.origin)throw Object.assign(fault(403,'Откройте кабинет на сайте.'),{code:'AUTH_ORIGIN'});
      const recovery=this.#outcome.snapshot(h,existing);
      if(recovery&&['completion_pending','complete'].includes(recovery.state)){
        this.rate('session:'+ip,120,60);
        const user=publicUser(this.user(existing));
        return{status:200,body:{user,csrf:existing?.csrf||recovery.recoveryCsrf,authProtocol:PROTOCOL,authRecovery:recovery,...this.preliminarySnapshot(h.cookie,user)}};
      }
      return null;
    }
    if(method!=='POST'||!['/auth-prepare','/auth-resume','/auth-cancel','/register','/login','/logout'].includes(path))return null;
    this.#outcome.requireRequest(h);this.rate('write:'+ip,100,60);
    if(path==='/auth-prepare')return this.#outcome.prepare(h,body);
    if(path==='/auth-resume'||path==='/auth-cancel')return this.#outcome.recovery(h,body,{cancel:path==='/auth-cancel'});
    const action=path.slice(1),claim=this.#outcome.claim(h,action,body);
    if(action==='register'){
      this.rate('register:'+ip,5,3600);
      const p=profile(body,null,this.#optionalDemographics),mail=email(body.email),pw=password(body.password);
      if(body.passwordConfirm!==pw||body.consent!==true)throw fault(400,'Проверьте пароли и согласие на обработку данных.');
      if(body.newsletter!==undefined&&typeof body.newsletter!=='boolean')throw fault(400,'Проверьте настройки подписки.');
      if(this.db.prepare('SELECT id FROM users WHERE email=?').get(mail))throw fault(409,'Не удалось зарегистрироваться с этими данными.');
      const hash=await this.expensive(()=>hashPassword(pw)),id=randomUUID();
      let answer;
      try{answer=this.#outcome.commit(claim,h,material=>{
        this.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?)').run(id,mail,hash,p.firstName,p.lastName,p.phone,p.address,body.newsletter===true?1:0,this.now());
        const s=this.issue(id,claim.session,material(id));return{userId:id,sessionHash:s.token_hash,credentialTag:digest(hash)};
      });}catch(e){if(String(e.code).includes('CONSTRAINT')||e.errcode===2067)throw fault(409,'Не удалось зарегистрироваться с этими данными.');throw e;}
      if(answer.status===200)answer.status=201;return answer;
    }
    if(action==='login'){
      this.rate('login:'+ip,20,900);const mail=email(body.email);this.rate('login-email:'+digest(mail),10,900);
      const row=this.db.prepare('SELECT * FROM users WHERE email=?').get(mail),pw=typeof body.password==='string'&&body.password.length<=128?body.password:'';
      const stored=row?.password_hash||await this.dummy;
      const valid=await this.expensive(()=>matches(pw,stored));
      if(!row||!valid)throw fault(401,'Неверный E-Mail или пароль.');
      return this.#outcome.commit(claim,h,material=>{
        const fresh=this.db.prepare('SELECT password_hash FROM users WHERE id=?').get(row.id);
        if(!fresh||fresh.password_hash!==row.password_hash)throw fault(401,'Вход изменился. Введите пароль снова.');
        const s=this.issue(row.id,claim.session,material(row.id));return{userId:row.id,sessionHash:s.token_hash,credentialTag:digest(row.password_hash)};
      });
    }
    return this.#outcome.commit(claim,h,()=>{this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(claim.session.token_hash);return{userId:null,sessionHash:null,credentialTag:null};});
  }
  async dispatch({method='GET',path,headers={},body={},ip='local'}={}){
    const h=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v]));
    try {
      let existing=this.current(h.cookie);
      if(this.#outcome){const handled=await this.durableAuth({method,path,h,body,ip,existing});if(handled)return handled;}
      existing=this.current(h.cookie);
      if(method==='GET'&&path==='/session'){
        this.rate('session:'+ip,120,60);
        const session=existing||this.issue(),user=publicUser(this.user(session));
        return {status:200,headers:existing?{}:{'Set-Cookie':this.cookie(session.token,1800)},body:{user,csrf:session.csrf,...this.preliminarySnapshot(h.cookie,user),...(this.#outcome?{authProtocol:PROTOCOL,authRecovery:this.#outcome.snapshot(h,existing),authOutcome:this.#outcome.completed(h,existing)}:{})}};
      }
      if(method!=='GET'){
        if(h.origin!==this.origin||!/^application\/json(?:\s*;|$)/i.test(h['content-type']||''))throw fault(403,'Запрос не принят. Откройте форму на сайте.');
        if(!existing||typeof h['x-csrf-token']!=='string'||h['x-csrf-token']!==existing.csrf)throw fault(403,'Обновите страницу и попробуйте снова.');
        if(!body||typeof body!=='object'||Array.isArray(body))throw fault(400,'Проверьте данные.');
        this.rate('write:'+ip,100,60);
      }
      if(method==='POST'&&path==='/register'){
        this.rate('register:'+ip,5,3600);
        const p=profile(body,null,this.#optionalDemographics),mail=email(body.email),pw=password(body.password);
        if(body.passwordConfirm!==pw||body.consent!==true)throw fault(400,'Проверьте пароли и согласие на обработку данных.');
        if(body.newsletter!==undefined&&typeof body.newsletter!=='boolean')throw fault(400,'Проверьте настройки подписки.');
        if(this.db.prepare('SELECT id FROM users WHERE email=?').get(mail))throw fault(409,'Не удалось зарегистрироваться с этими данными.');
        const hash=await this.expensive(()=>hashPassword(pw)),id=randomUUID();
        try {this.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?)').run(id,mail,hash,p.firstName,p.lastName,p.phone,p.address,body.newsletter===true?1:0,this.now());}
        catch(e){if(String(e.code).includes('CONSTRAINT')||e.errcode===2067)throw fault(409,'Не удалось зарегистрироваться с этими данными.');throw e;}
        const s=this.issue(id,existing);return {status:201,headers:{'Set-Cookie':this.cookie(s.token)},body:{user:publicUser(this.user(s)),csrf:s.csrf}};
      }
      if(method==='POST'&&path==='/login'){
        this.rate('login:'+ip,20,900);const mail=email(body.email);
        this.rate('login-email:'+digest(mail),10,900);
        const pw=typeof body.password==='string'&&body.password.length<=128?body.password:'';
        const row=this.db.prepare('SELECT * FROM users WHERE email=?').get(mail);
        const stored=row?.password_hash||await this.dummy;
        const valid=await this.expensive(()=>matches(pw,stored));
        if(!row||!valid)throw fault(401,'Неверный E-Mail или пароль.');
        const s=this.issue(row.id,existing);return {status:200,headers:{'Set-Cookie':this.cookie(s.token)},body:{user:publicUser(row),csrf:s.csrf}};
      }
      const user=this.user(existing);
      if(method==='POST'&&path==='/preliminary-name'&&this.#preliminary){
        if(user||existing.user_id!==null)throw fault(409,'Используйте профиль текущего аккаунта.');
        const fresh=this.current(h.cookie);
        if(!fresh||fresh.token_hash!==existing.token_hash)throw fault(403,'Вход изменился. Обновите страницу.');
        const result=this.#preliminary.rename({cookie:String(h.cookie||''),origin:this.origin},body);
        return{status:200,body:{user:null,csrf:existing.csrf,...result}};
      }
      if(method==='POST'&&path==='/logout'){
        this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(existing.token_hash);return {status:200,headers:{'Set-Cookie':this.cookie('',0)},body:{ok:true}};
      }
      if(!user)throw fault(401,'Войдите в личный кабинет.');
      if(path==='/wishlist'&&method==='GET')return {status:200,body:{ids:this.db.prepare('SELECT item_id FROM wishlist WHERE user_id=? ORDER BY item_id').all(user.id).map(row=>row.item_id)}};
      if(path==='/wishlist'&&method==='PUT'){
        if(!Array.isArray(body.ids)||body.ids.length>100||body.ids.some(id=>typeof id!=='string'||!ID.test(id)))throw fault(400,'Проверьте список избранного.');
        this.db.exec('BEGIN');try{this.db.prepare('DELETE FROM wishlist WHERE user_id=?').run(user.id);for(const id of new Set(body.ids))this.db.prepare('INSERT INTO wishlist VALUES(?,?)').run(user.id,id);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
        return {status:200,body:{ids:[...new Set(body.ids)]}};
      }
      if(path==='/profile'&&method==='PUT'){
        const p=profile(body,publicUser(user),this.#optionalDemographics);this.db.prepare('UPDATE users SET first_name=?,last_name=?,phone=?,address=? WHERE id=?').run(p.firstName,p.lastName,p.phone,p.address,user.id);
        return {status:200,body:{user:publicUser(this.user(existing))}};
      }
      throw fault(404,'Страница не найдена.');
    }catch(error){return {status:error.status||500,body:{message:error.status?error.message:'Исход операции пока не подтверждён. Проверьте результат перед повтором.',...(error.status&&error.code?{code:error.code}:{})}};}
  }
}
module.exports={AccountService,hashPassword,matches};
