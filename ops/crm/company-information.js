'use strict';

const {publicLinkUrl} = require('./company-links');
const BASE = {name:'name',city:'city',timezone:'timezone',phone:'phone',email:'email',websiteUrl:'website_url',socials:'socials'};
const EXTRA = ['address','hours','description','services','promotions','materials'];
const FIELDS = [...Object.keys(BASE),...EXTRA];
const ARRAY_FIELDS = new Set(['socials','services','promotions','materials']);
function fail(status,message,code='VALIDATION_ERROR') {throw Object.assign(Error(message),{status,details:{code}});}
function object(value, allowed) {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!allowed.includes(key))) fail(400,'Некорректные поля запроса');
}
function text(value,max,required=false) {
  if(typeof value!=='string'||value.length>max||/\x00/.test(value))fail(400,'Некорректный текст');
  const result=value.trim();if(required&&!result)fail(400,'Заполните обязательное поле');return result;
}
function timezone(value) {
  const result=text(value,80,true);
  try{new Intl.DateTimeFormat('en',{timeZone:result}).format();}catch{fail(400,'Укажите часовой пояс IANA');}
  return result;
}
function utcDate(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)||!Number.isFinite(Date.parse(value)))fail(400,'Укажите дату в UTC');
  return new Date(value).toISOString();
}
function revision(value) {if(!Number.isSafeInteger(value)||value<0)fail(400,'Укажите версию данных');return value;}
function url(value) {const result=publicLinkUrl(value);if(!result)fail(400,'Укажите деловую HTTP(S)-ссылку');return result;}
function company(db,code) {
  if(typeof code!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code))fail(400,'Выберите компанию');
  const row=db.prepare('SELECT * FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get(code);
  if(!row)fail(404,'Компания не найдена','NOT_FOUND');return row;
}
function parse(value,fallback) {try{return JSON.parse(value);}catch{return fallback;}}
function empty(value) {return value===null||value===''||(Array.isArray(value)&&!value.length);}
function structured(field,value) {
  if(!Array.isArray(value)||value.length>200)fail(400,'Слишком много записей');
  if(field==='socials') {
    if(Buffer.byteLength(JSON.stringify(value))>40000)fail(400,'Слишком много ссылок');
    // Existing unknown types and additional rows remain intact. Validate without guessing URLs from handles.
    for(const row of value) {
      if(!row||typeof row!=='object'||Array.isArray(row)||Object.values(row).some(v=>typeof v!=='string'))fail(400,'Некорректная ссылка компании');
      for(const value of Object.values(row))text(value,2000);
      if(row.url)url(row.url);
    }
    return structuredClone(value);
  }
  const allowed={services:['id','title','description','price','currency','durationMinutes','bookingIntervalMinutes'],
    promotions:['id','title','description','price','oldPrice','startsAt','endsAt','timezone','serviceIds'],
    materials:['id','title','url','type','serviceIds','promotionIds']}[field];
  const seen=new Set();
  return value.map(row=>{
    object(row,allowed);const out={id:text(row.id,100,true),title:text(row.title,300,true)};
    if(seen.has(out.id))fail(400,'Идентификаторы записей должны отличаться');seen.add(out.id);
    for(const [key,v] of Object.entries(row)){
      if(['id','title'].includes(key))continue;
      if(['price','oldPrice','durationMinutes','bookingIntervalMinutes'].includes(key)) {
        if(v!==null&&(typeof v!=='number'||!Number.isFinite(v)||v<0||v>100000000))fail(400,'Проверьте цену или длительность');out[key]=v;
      }else if(['startsAt','endsAt'].includes(key)){out[key]=v===null||v===''?null:utcDate(v);}
      else if(key==='timezone'){out[key]=v?timezone(v):'';}
      else if(['serviceIds','promotionIds'].includes(key)){
        if(!Array.isArray(v)||v.length>200)fail(400,'Некорректные связанные записи');out[key]=v.map(id=>text(id,100,true));
      }else if(key==='url'){out[key]=url(v);}
      else out[key]=text(v,key==='description'?5000:100);
    }
    if(out.startsAt&&out.endsAt&&out.endsAt<=out.startsAt)fail(400,'Окончание акции должно быть позже начала');
    return out;
  });
}
function normalizeProfile(patch) {
  object(patch,FIELDS);const clean={};
  const limits={name:200,city:200,phone:100,email:254,websiteUrl:2000,address:1000,hours:2000,description:20000};
  for(const [key,value] of Object.entries(patch)){
    if(ARRAY_FIELDS.has(key))clean[key]=structured(key,value);
    else if(key==='timezone')clean[key]=value===''?'':timezone(value);
    else {
      clean[key]=text(value,limits[key],key==='name');
      if(key==='websiteUrl'&&clean[key])clean[key]=url(clean[key]);
      if(key==='email'&&clean[key]&&!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(clean[key]))fail(400,'Проверьте email компании');
    }
  }
  return clean;
}

function createCompanyInformation(db,{now=Date.now,check:checker}={}) {
  db.exec(`CREATE TABLE IF NOT EXISTS company_information (
    company_id INTEGER PRIMARY KEY REFERENCES companies(id), revision INTEGER NOT NULL DEFAULT 0,
    extras TEXT NOT NULL DEFAULT '{}',field_states TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS company_information_versions (
    company_id INTEGER NOT NULL REFERENCES companies(id),revision INTEGER NOT NULL,profile TEXT NOT NULL,
    field_states TEXT NOT NULL,created_at TEXT NOT NULL,actor_id INTEGER,reason TEXT NOT NULL,
    PRIMARY KEY(company_id,revision));
    CREATE TRIGGER IF NOT EXISTS company_information_versions_immutable_update BEFORE UPDATE ON company_information_versions
    BEGIN SELECT RAISE(ABORT,'Immutable company information version'); END;
    CREATE TRIGGER IF NOT EXISTS company_information_versions_immutable_delete BEFORE DELETE ON company_information_versions
    BEGIN SELECT RAISE(ABORT,'Immutable company information version'); END;
    CREATE TABLE IF NOT EXISTS company_information_checks (
    id INTEGER PRIMARY KEY,company_id INTEGER NOT NULL REFERENCES companies(id),revision INTEGER NOT NULL,
    checks TEXT NOT NULL,checked_at TEXT NOT NULL);`);
  const iso=()=>new Date(now()).toISOString();
  function compose(owner,info) {
    const profile={};
    for(const [key,column]of Object.entries(BASE))profile[key]=key==='socials'?parse(owner[column],[]):owner[column]??'';
    if(!Array.isArray(profile.socials))profile.socials=[];
    const extras=parse(info?.extras,'')||{};
    for(const key of EXTRA)profile[key]=extras[key]??(ARRAY_FIELDS.has(key)?[]:'');
    return profile;
  }
  function archive(owner,info,profile,states,actorId,reason) {
    const next=(info?.revision||0)+1,time=iso();
    const extras=Object.fromEntries(EXTRA.map(key=>[key,profile[key]]));
    db.prepare(`INSERT INTO company_information(company_id,revision,extras,field_states) VALUES(?,?,?,?)
      ON CONFLICT(company_id) DO UPDATE SET revision=excluded.revision,extras=excluded.extras,field_states=excluded.field_states`)
      .run(owner.id,next,JSON.stringify(extras),JSON.stringify(states));
    db.prepare('INSERT INTO company_information_versions VALUES(?,?,?,?,?,?,?)')
      .run(owner.id,next,JSON.stringify(profile),JSON.stringify(states),time,actorId,reason);
    return next;
  }
  function refresh(owner,actorId=null,reason='Данные существующей карточки CRM') {
    const info=db.prepare('SELECT * FROM company_information WHERE company_id=?').get(owner.id),profile=compose(owner,info);
    const old=info&&db.prepare('SELECT profile FROM company_information_versions WHERE company_id=? AND revision=?').get(owner.id,info.revision);
    if(!old||JSON.stringify(profile)!==old.profile){
      const previous=old?parse(old.profile,{}):{},states=parse(info?.field_states,{})||{},time=iso();
      for(const key of FIELDS)if(!old||JSON.stringify(previous[key])!==JSON.stringify(profile[key]))states[key]={state:empty(profile[key])?(old?'removed':'unknown'):'confirmed',updatedAt:time,actorId};
      archive(owner,info,profile,states,actorId,reason);
    }
    return db.prepare('SELECT * FROM company_information WHERE company_id=?').get(owner.id);
  }
  function transaction(work){db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
  function get(code) {
    return transaction(()=>{
      const owner=company(db,code),info=refresh(owner),profile=compose(owner,info);
      const history=db.prepare('SELECT revision,created_at createdAt,actor_id actorId,reason FROM company_information_versions WHERE company_id=? ORDER BY revision DESC LIMIT 30').all(owner.id);
      const audit=db.prepare('SELECT revision,checks FROM company_information_checks WHERE company_id=? ORDER BY id DESC LIMIT 1').get(owner.id);
      const checks=audit?parse(audit.checks,[]).map(item=>({...item,revision:audit.revision,...(audit.revision!==info.revision?{status:'needs_review',message:'Данные компании изменились после проверки. Повторите сверку.'}:{})})):[];
      return {companyCode:owner.code.toLowerCase(),revision:info.revision,profile,fieldStates:parse(info.field_states,{}),history,checks};
    });
  }
  function save(code,body,actorId=null) {
    object(body,['revision','profile','reason']);revision(body.revision);
    const patch=normalizeProfile(body.profile),reason=body.reason===undefined?'Сохранено собственником':text(body.reason,500);
    // Reconcile previous writers before checking the caller's revision. Their update remains recorded on a conflict.
    get(code);
    transaction(()=>{
      const owner=company(db,code),info=refresh(owner);
      if(body.revision!==info.revision)fail(409,'Данные уже изменились. Обновите страницу.','REVISION_CONFLICT');
      const profile={...compose(owner,info),...patch};
      if(Buffer.byteLength(JSON.stringify(profile))>200000)fail(400,'Данные компании слишком большие');
      const states=parse(info.field_states,{}),time=iso();
      for(const key of Object.keys(patch))states[key]={state:empty(profile[key])?'removed':'confirmed',updatedAt:time,actorId};
      const baseFields=Object.keys(patch).filter(key=>Object.hasOwn(BASE,key));
      if(baseFields.length)db.prepare(`UPDATE companies SET ${baseFields.map(key=>BASE[key]+'=?').join(',')},updated_at=? WHERE id=?`)
        .run(...baseFields.map(key=>key==='socials'?JSON.stringify(profile[key]):profile[key]),time,owner.id);
      archive(owner,info,profile,states,actorId,reason);
    });
    return get(code);
  }
  async function check(code) {
    if(typeof checker!=='function')fail(503,'Проверка площадок пока не подключена','CHECK_UNAVAILABLE');
    const snapshot=get(code),owner=company(db,code);
    let checks;
    try {
      const result=await checker({companyCode:snapshot.companyCode,revision:snapshot.revision,profile:snapshot.profile});
      checks=result?.checks;
      if(!Array.isArray(checks)||checks.length>50||Buffer.byteLength(JSON.stringify(checks))>200000)throw Error('Invalid check result');
    }catch{
      checks=[{platformId:'check',status:'unavailable',checkedAt:iso(),fields:[],message:'Не удалось проверить площадки. Эталонные данные сохранены.'}];
    }
    company(db,code);
    db.prepare('INSERT INTO company_information_checks(company_id,revision,checks,checked_at) VALUES(?,?,?,?)').run(owner.id,snapshot.revision,JSON.stringify(checks),iso());
    return get(code);
  }
  return {get,save,check};
}
module.exports={createCompanyInformation,company,fail,object,text,timezone,utcDate,revision,url,normalizeProfile};
