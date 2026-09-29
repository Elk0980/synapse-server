'use strict';

const {publicLinkUrl} = require('./company-links');
const {createCompanyFacts} = require('./company-facts');
const {companyKnowledge,serviceQuote} = require('./company-knowledge');
const {createHash}=require('node:crypto');
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
  const allowed={services:['id','title','description','price','currency','priceUnit','guestCount','visitDurationMinutes','procedureCount','durationMinutes','bookingIntervalMinutes'],
    promotions:['id','title','description','price','oldPrice','startsAt','endsAt','timezone','serviceIds'],
    materials:['id','title','url','type','serviceIds','promotionIds']}[field];
  const seen=new Set();
  return value.map(row=>{
    object(row,allowed);const out={id:text(row.id,100,true),title:text(row.title,300,true)};
    if(seen.has(out.id))fail(400,'Идентификаторы записей должны отличаться');seen.add(out.id);
    for(const [key,v] of Object.entries(row)){
      if(['id','title'].includes(key))continue;
      if(key==='priceUnit') {
        if(!['','procedures','program'].includes(v))fail(400,'Выберите цену за процедуры или за программу');out[key]=v;
      }else if(['guestCount','visitDurationMinutes'].includes(key)) {
        if(v!==null&&(!Number.isSafeInteger(v)||v<1||v>10000))fail(400,'Число гостей и длительность визита должны быть положительными целыми числами');out[key]=v;
      }else if(key==='procedureCount') {
        if(v!==null&&(!Number.isSafeInteger(v)||v<1||v>1000))fail(400,'Количество процедур должно быть целым числом от 1 до 1000');out[key]=v;
      }else if(['price','oldPrice','durationMinutes','bookingIntervalMinutes'].includes(key)) {
        if(v!==null&&(typeof v!=='number'||!Number.isFinite(v)||v<0||v>100000000))fail(400,'Проверьте цену или длительность');out[key]=v;
      }else if(['startsAt','endsAt'].includes(key)){out[key]=v===null||v===''?null:utcDate(v);}
      else if(key==='timezone'){out[key]=v?timezone(v):'';}
      else if(['serviceIds','promotionIds'].includes(key)){
        if(!Array.isArray(v)||v.length>200)fail(400,'Некорректные связанные записи');out[key]=v.map(id=>text(id,100,true));
      }else if(key==='url'){out[key]=url(v);}
      else out[key]=text(v,key==='description'?5000:100);
    }
    if(field==='services') {
      const present=key=>out[key]!==undefined&&out[key]!==null&&out[key]!=='';
      if(out.priceUnit==='program'&&['procedureCount','durationMinutes'].some(present))fail(400,'Для программы укажите число гостей и длительность всего визита, без количества и длительности отдельных процедур');
      if(out.priceUnit!=='program'&&['guestCount','visitDurationMinutes'].some(present))fail(400,'Для числа гостей и длительности всего визита выберите цену за программу');
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
  const facts=createCompanyFacts(db,{now});
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
    checks TEXT NOT NULL,checked_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS company_catalog_imports (
    company_id INTEGER NOT NULL REFERENCES companies(id),client_import_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,actor_id INTEGER,
    PRIMARY KEY(company_id,client_import_id));`);
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
    facts.sync(owner.id,profile,next,actorId);
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
  function transaction(work){
    // Каталог проверяется и внутри атомарного сохранения записи на услугу.
    const nested=db.isTransaction;
    db.exec(nested?'SAVEPOINT company_information':'BEGIN IMMEDIATE');
    try{const result=work();db.exec(nested?'RELEASE company_information':'COMMIT');return result;}
    catch(error){db.exec(nested?'ROLLBACK TO company_information; RELEASE company_information':'ROLLBACK');throw error;}
  }
  function get(code) {
    return transaction(()=>{
      const owner=company(db,code),info=refresh(owner),profile=compose(owner,info);
      facts.sync(owner.id,profile,info.revision);
      const history=db.prepare('SELECT revision,created_at createdAt,actor_id actorId,reason FROM company_information_versions WHERE company_id=? ORDER BY revision DESC LIMIT 30').all(owner.id);
      const audit=db.prepare('SELECT revision,checks FROM company_information_checks WHERE company_id=? ORDER BY id DESC LIMIT 1').get(owner.id);
      const checks=audit?parse(audit.checks,[]).map(item=>({...item,revision:audit.revision,...(audit.revision!==info.revision?{status:'needs_review',message:'Данные компании изменились после проверки. Повторите сверку.'}:{})})):[];
      return {companyCode:owner.code.toLowerCase(),revision:info.revision,profile,fieldStates:parse(info.field_states,{}),history,checks,facts:facts.list(owner.id)};
    });
  }
  function save(code,body,actorId=null) {
    object(body,['revision','profile','reason','factConfirmations']);revision(body.revision);
    const patch=normalizeProfile(body.profile),reason=body.reason===undefined?'Сохранено собственником':text(body.reason,500);
    // Reconcile previous writers before checking the caller's revision. Their update remains recorded on a conflict.
    get(code);
    transaction(()=>{
      const owner=company(db,code),info=refresh(owner);
      if(body.revision!==info.revision)fail(409,'Данные уже изменились. Обновите страницу.','REVISION_CONFLICT');
      if(!Object.keys(patch).length&&body.factConfirmations!==undefined){
        // Добавление доказательства не меняет содержимое профиля и не останавливает согласованные публикации.
        facts.confirm(owner.id,body.factConfirmations,info.revision,actorId);return;
      }
      const profile={...compose(owner,info),...patch};
      if(Buffer.byteLength(JSON.stringify(profile))>200000)fail(400,'Данные компании слишком большие');
      const states=parse(info.field_states,{}),time=iso();
      for(const key of Object.keys(patch))states[key]={state:empty(profile[key])?'removed':'confirmed',updatedAt:time,actorId};
      const baseFields=Object.keys(patch).filter(key=>Object.hasOwn(BASE,key));
      if(baseFields.length)db.prepare(`UPDATE companies SET ${baseFields.map(key=>BASE[key]+'=?').join(',')},updated_at=? WHERE id=?`)
        .run(...baseFields.map(key=>key==='socials'?JSON.stringify(profile[key]):profile[key]),time,owner.id);
      const next=archive(owner,info,profile,states,actorId,reason);
      if(body.factConfirmations!==undefined)facts.confirm(owner.id,body.factConfirmations,next,actorId);
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
  function factHistory(code,key) {get(code);return {companyCode:company(db,code).code.toLowerCase(),facts:facts.history(company(db,code).id,key)};}
  function prepareImport(code,body) {
    object(body,['companyCode','clientImportId','revision','entries']);revision(body.revision);
    if(body.companyCode!==String(code).toLowerCase())fail(400,'Компания файла не совпадает с выбранной компанией');
    if(typeof body.clientImportId!=='string'||!/^[-a-zA-Z0-9_]{8,100}$/.test(body.clientImportId))fail(400,'Нужен уникальный идентификатор импорта');
    if(!Array.isArray(body.entries)||!body.entries.length||body.entries.length>200)fail(400,'Нужно от 1 до 200 услуг');
    const services=structured('services',body.entries.map(entry=>entry?.service));
    const entries=body.entries.map((entry,index)=>{
      object(entry,['service','source','sourceRef','checkedAt']);
      const service=services[index];
      if(service.price===undefined||service.price===null||!service.currency)fail(400,'Укажите цену и валюту для каждой услуги');
      if(service.priceUnit==='program') {
        if(!service.guestCount||!service.visitDurationMinutes)fail(400,'Укажите число гостей и длительность всего визита для каждой программы');
      }else if(!service.procedureCount)fail(400,'Укажите количество процедур для каждой услуги');
      const source=text(entry.source,1000,true),sourceRef=text(entry.sourceRef,2000,true),checkedAt=utcDate(entry.checkedAt);
      if(checkedAt!==entry.checkedAt.replace(/(?<!\.\d{3})Z$/,'.000Z')||Date.parse(checkedAt)>now())fail(400,'Проверьте дату источника');
      return {service,source,sourceRef,checkedAt};
    });
    // Повтор файла после перезагрузки получает свежую revision, но это тот же импорт.
    const requestHash=createHash('sha256').update(JSON.stringify({companyCode:body.companyCode,clientImportId:body.clientImportId,entries})).digest('hex');
    const snapshot=get(code),owner=company(db,code);
    const receipt=db.prepare('SELECT * FROM company_catalog_imports WHERE company_id=? AND client_import_id=?').get(owner.id,body.clientImportId);
    if(receipt){if(receipt.request_hash!==requestHash)fail(409,'Этот идентификатор уже использован для другого импорта');return {snapshot,owner,entries,requestHash,duplicate:true,added:0};}
    if(snapshot.revision!==body.revision)fail(409,'Каталог изменился. Сначала обновите сведения');
    const byId=new Map(snapshot.profile.services.map(row=>[row.id,row]));
    let added=0;
    for(const {service}of entries){
      const existing=byId.get(service.id);
      const same=existing&&Object.keys({...existing,...service}).every(key=>JSON.stringify(existing[key])===JSON.stringify(service[key]));
      if(existing&&!same)fail(409,'Услуга с таким идентификатором уже отличается: импорт не заменяет существующие значения');
      if(!existing){byId.set(service.id,service);added++;}
    }
    if(byId.size>200)fail(400,'После импорта будет больше 200 услуг');
    const merged=[...byId.values()];
    if(Buffer.byteLength(JSON.stringify({...snapshot.profile,services:merged}))>200000)fail(400,'Данные компании слишком большие');
    return {snapshot,owner,entries,requestHash,duplicate:false,added,merged};
  }
  function importPreview(code,body) {
    const prepared=prepareImport(code,body);
    return {companyCode:prepared.snapshot.companyCode,revision:prepared.snapshot.revision,added:prepared.added,
      unchanged:prepared.entries.length-prepared.added,duplicate:prepared.duplicate,entries:prepared.entries};
  }
  function importCatalog(code,body,actorId=null) {
    const prepared=prepareImport(code,body);let added=0;
    if(!prepared.duplicate)transaction(()=>{
      const {entries,requestHash,merged}=prepared,owner=company(db,code),info=refresh(owner);
      if(info.revision!==body.revision)fail(409,'Каталог изменился. Сначала обновите сведения');
      const profile={...compose(owner,info),services:merged},states=parse(info.field_states,{});
      let next=info.revision;
      if(prepared.added){states.services={state:'confirmed',updatedAt:iso(),actorId};next=archive(owner,info,profile,states,actorId,'Импорт услуг с проверенными источниками');}
      const latest=new Map(facts.list(owner.id).map(f=>[f.key,f]));
      const proofs=entries.flatMap(entry=>Object.entries(entry.service).filter(([key,value])=>key!=='id'&&value!==null&&value!=='').map(([key])=>({
        factId:latest.get(`services/${encodeURIComponent(entry.service.id)}/${key}`).id,source:entry.source,sourceRef:entry.sourceRef,checkedAt:entry.checkedAt})));
      for(let index=0;index<proofs.length;index+=200)facts.confirm(owner.id,proofs.slice(index,index+200),next,actorId);
      db.prepare('INSERT INTO company_catalog_imports VALUES(?,?,?,?,?,?)').run(owner.id,body.clientImportId,requestHash,next,iso(),actorId);
      added=prepared.added;
    });
    return {...get(code),importResult:{clientImportId:body.clientImportId,duplicate:prepared.duplicate,added}};
  }
  return {get,save,check,factHistory,importPreview,importCatalog,knowledge:code=>companyKnowledge(get(code)),
    quote:(code,serviceId,expectedRevision)=>serviceQuote(companyKnowledge(get(code)),serviceId,expectedRevision)};
}
module.exports={createCompanyInformation,company,fail,object,text,timezone,utcDate,revision,url,normalizeProfile};
