'use strict';
const {DatabaseSync}=require('node:sqlite');
const {randomBytes,randomUUID,createHash,scrypt,timingSafeEqual}=require('node:crypto');
const {promisify}=require('node:util');
const derive=promisify(scrypt);
const ID=/^[a-z0-9][a-z0-9_-]{0,79}$/i;
const digest=value=>createHash('sha256').update(value).digest('hex');
const SCRYPT={N:32768,r:8,p:3,maxmem:64*1024*1024};
const text=(value,max,required=true)=>{if(typeof value!=='string'||value.length>max||(required&&!value.trim()))throw fault(400,'Проверьте заполнение полей.');return value.trim();};
function fault(status,message){return Object.assign(new Error(message),{status});}
function email(value){const v=text(value,160).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))throw fault(400,'Проверьте E-Mail.');return v;}
function profile(body){const p={firstName:text(body.firstName,80),lastName:text(body.lastName,80),phone:text(body.phone,32),address:text(body.address,500)};const digits=p.phone.replace(/\D/g,'');if(digits.length<10||digits.length>15)throw fault(400,'Проверьте телефон.');return p;}
function password(value){if(typeof value!=='string'||value.length<12||value.length>128)throw fault(400,'Пароль должен содержать от 12 до 128 символов.');return value;}
async function hashPassword(value){const salt=randomBytes(16).toString('hex');const hash=await derive(value,salt,64,SCRYPT);return salt+':'+hash.toString('hex');}
async function matches(value,stored){const [salt,key]=stored.split(':');const actual=await derive(value,salt,64,SCRYPT);const expected=Buffer.from(key,'hex');return expected.length===actual.length&&timingSafeEqual(expected,actual);}
function publicUser(row){return row?{id:row.id,email:row.email,firstName:row.first_name,lastName:row.last_name,phone:row.phone,address:row.address}:null;}

class AccountService {
  constructor({database=':memory:',origin,now=Date.now,sessionSeconds=86400*7,approvedOrigin=null}={}){
    if(!origin)throw new Error('An explicit independent draft origin is required');
    const parsed=new URL(origin);const local=['127.0.0.1','localhost','[::1]'].includes(parsed.hostname);
    // PALITRA: a protected production/shared hostname is allowed only when the host passes exactly this origin as approvedOrigin.
    if(parsed.origin!==origin||parsed.username||parsed.password||(!local&&parsed.protocol!=='https:')||(approvedOrigin!==origin&&['palitra-love.ru','www.palitra-love.ru','palitra-love.synapsebusiness.ru'].includes(parsed.hostname)))throw new Error('Production and shared-alias origins are forbidden');
    this.origin=origin;this.secure=!local;this.cookieName=this.secure?'__Host-PalitraDraftSession':'PalitraDraftSession';
    this.now=now;this.sessionSeconds=sessionSeconds;this.db=new DatabaseSync(database);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,first_name TEXT NOT NULL,last_name TEXT NOT NULL,phone TEXT NOT NULL,address TEXT NOT NULL,newsletter INTEGER NOT NULL DEFAULT 0,consented_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS wishlist(user_id TEXT NOT NULL REFERENCES users(id),item_id TEXT NOT NULL,PRIMARY KEY(user_id,item_id));
      CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,reset_at INTEGER NOT NULL);`);
    this.dummy=hashPassword(randomBytes(24).toString('hex'));
    this.expensivePending=0;
  }
  close(){this.db.close();}
  cookie(token,age=this.sessionSeconds){return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${this.secure?'; Secure':''}`;}
  current(cookie=''){
    const match=String(cookie).split(';').map(v=>v.trim()).find(v=>v.startsWith(this.cookieName+'='));const token=match?.slice(this.cookieName.length+1)||'';
    if(!/^[a-f0-9]{64}$/.test(token))return null;
    const session=this.db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(digest(token),this.now());
    return session?{...session,token}:null;
  }
  user(session){return session?.user_id?this.db.prepare('SELECT * FROM users WHERE id=?').get(session.user_id):null;}
  issue(userId=null,old=null){
    if(old)this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(old.token_hash);
    this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(this.now());
    const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(token),userId,csrf,this.now()+(userId?this.sessionSeconds:1800)*1000);
    return {token,csrf,user_id:userId,token_hash:digest(token)};
  }
  rate(key,max,seconds){
    const now=this.now();this.db.prepare('DELETE FROM rate_limits WHERE reset_at<=?').run(now);
    const row=this.db.prepare('SELECT * FROM rate_limits WHERE key=?').get(key);
    if(row&&row.count>=max)throw fault(429,'Слишком много попыток. Попробуйте позже.');
    if(row)this.db.prepare('UPDATE rate_limits SET count=count+1 WHERE key=?').run(key);
    else this.db.prepare('INSERT INTO rate_limits VALUES(?,?,?)').run(key,1,now+seconds*1000);
  }
  async expensive(fn){if(this.expensivePending>=4)throw fault(429,'Попробуйте ещё раз немного позже.');this.expensivePending++;try{return await fn();}finally{this.expensivePending--;}}
  async dispatch({method='GET',path,headers={},body={},ip='local'}={}){
    const h=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v]));
    try {
      const existing=this.current(h.cookie);
      if(method==='GET'&&path==='/session'){
        this.rate('session:'+ip,120,60);
        const session=existing||this.issue();return {status:200,headers:existing?{}:{'Set-Cookie':this.cookie(session.token,1800)},body:{user:publicUser(this.user(session)),csrf:session.csrf}};
      }
      if(method!=='GET'){
        if(h.origin!==this.origin||!/^application\/json(?:\s*;|$)/i.test(h['content-type']||''))throw fault(403,'Запрос не принят. Откройте форму на сайте.');
        if(!existing||typeof h['x-csrf-token']!=='string'||h['x-csrf-token']!==existing.csrf)throw fault(403,'Обновите страницу и попробуйте снова.');
        if(!body||typeof body!=='object'||Array.isArray(body))throw fault(400,'Проверьте данные.');
        this.rate('write:'+ip,100,60);
      }
      if(method==='POST'&&path==='/register'){
        this.rate('register:'+ip,5,3600);
        const p=profile(body),mail=email(body.email),pw=password(body.password);
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
        const p=profile(body);this.db.prepare('UPDATE users SET first_name=?,last_name=?,phone=?,address=? WHERE id=?').run(p.firstName,p.lastName,p.phone,p.address,user.id);
        return {status:200,body:{user:publicUser(this.user(existing))}};
      }
      throw fault(404,'Страница не найдена.');
    }catch(error){return {status:error.status||500,body:{message:error.status?error.message:'Сервис временно недоступен.'}};}
  }
}
module.exports={AccountService,hashPassword,matches};
