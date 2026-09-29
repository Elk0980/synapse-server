'use strict';

// Источники привязаны к конкретному значению, а не ко всей карточке компании.
const LABELS = {name:'Название',city:'Город',timezone:'Часовой пояс',phone:'Телефон',email:'Email',
  websiteUrl:'Сайт',address:'Адрес',hours:'Часы работы',description:'Описание',socials:'Ссылки',
  services:'Услуги',promotions:'Акции',materials:'Материалы',title:'Название',price:'Цена',
  oldPrice:'Прежняя цена',currency:'Валюта',durationMinutes:'Длительность',bookingIntervalMinutes:'Интервал записи',
  startsAt:'Начало',endsAt:'Окончание',url:'Ссылка',type:'Тип',label:'Подпись',serviceIds:'Связанные услуги',promotionIds:'Связанные акции'};
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const clean=(value,max,required=false)=>{
  if(typeof value!=='string'||value.length>max||/\x00/.test(value)||(required&&!value.trim()))fail(400,'Укажите источник и дату проверки');
  return value.trim();
};
function profileFacts(profile) {
  const facts=new Map();
  for(const [field,value] of Object.entries(profile)) {
    if(Array.isArray(value)) {
      value.forEach((row,index)=>{
        // Старые ссылки CRM не имеют ID: перестановка таких строк требует повторной сверки.
        const id=String(row.id??index),title=row.title||row.label||row.type||String(index+1);
        for(const [key,part] of Object.entries(row)) if(key!=='id') {
          facts.set(`${field}/${encodeURIComponent(id)}/${key}`,{label:`${LABELS[field]||field} · ${title} · ${LABELS[key]||key}`,value:part});
        }
      });
    } else facts.set(field,{label:LABELS[field]||field,value});
  }
  return facts;
}
function createCompanyFacts(db,{now=Date.now}={}) {
  db.exec(`CREATE TABLE IF NOT EXISTS company_fact_versions (
    id INTEGER PRIMARY KEY,company_id INTEGER NOT NULL REFERENCES companies(id),fact_key TEXT NOT NULL,
    label TEXT NOT NULL,value_json TEXT NOT NULL,removed INTEGER NOT NULL DEFAULT 0,
    profile_revision INTEGER NOT NULL,status TEXT NOT NULL,source TEXT NOT NULL DEFAULT '',
    source_ref TEXT NOT NULL DEFAULT '',checked_at TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL,actor_id INTEGER,supersedes_id INTEGER REFERENCES company_fact_versions(id));
    CREATE INDEX IF NOT EXISTS company_fact_latest ON company_fact_versions(company_id,fact_key,id);
    CREATE TRIGGER IF NOT EXISTS company_fact_no_update BEFORE UPDATE ON company_fact_versions
    BEGIN SELECT RAISE(ABORT,'Immutable company fact'); END;
    CREATE TRIGGER IF NOT EXISTS company_fact_no_delete BEFORE DELETE ON company_fact_versions
    BEGIN SELECT RAISE(ABORT,'Immutable company fact'); END;`);
  const latest=companyId=>db.prepare(`SELECT f.* FROM company_fact_versions f
    WHERE company_id=? AND id=(SELECT MAX(id) FROM company_fact_versions n WHERE n.company_id=f.company_id AND n.fact_key=f.fact_key) ORDER BY id`).all(companyId);
  function insert(companyId,key,fact,revision,actorId,previous,proof={}) {
    db.prepare(`INSERT INTO company_fact_versions(company_id,fact_key,label,value_json,removed,profile_revision,status,
      source,source_ref,checked_at,note,recorded_at,actor_id,supersedes_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(companyId,key,fact.label,JSON.stringify(fact.value),fact.removed?1:0,revision,proof.source?'confirmed':'unverified',
        proof.source||'',proof.sourceRef||'',proof.checkedAt||'',proof.note||'',new Date(now()).toISOString(),actorId,previous?.id||null);
  }
  function sync(companyId,profile,revision,actorId=null) {
    const old=new Map(latest(companyId).map(row=>[row.fact_key,row])),facts=profileFacts(profile);
    for(const [key,fact] of facts) {
      const previous=old.get(key);
      if(!previous||previous.removed||previous.label!==fact.label||previous.value_json!==JSON.stringify(fact.value))insert(companyId,key,fact,revision,actorId,previous);
      old.delete(key);
    }
    for(const [key,previous] of old) if(!previous.removed)insert(companyId,key,{label:previous.label,value:null,removed:true},revision,actorId,previous);
  }
  const present=row=>({id:row.id,key:row.fact_key,label:row.label,value:JSON.parse(row.value_json),removed:!!row.removed,
    profileRevision:row.profile_revision,status:row.status,source:row.source,sourceRef:row.source_ref,
    checkedAt:row.checked_at,note:row.note,recordedAt:row.recorded_at,actorId:row.actor_id,supersedesId:row.supersedes_id});
  const list=companyId=>latest(companyId).map(present);
  function confirm(companyId,entries,revision,actorId) {
    if(!Array.isArray(entries)||entries.length>200)fail(400,'Слишком много подтверждений');
    const current=new Map(latest(companyId).map(row=>[row.id,row])),seen=new Set();
    for(const proof of entries) {
      if(!proof||typeof proof!=='object'||Array.isArray(proof)||Object.keys(proof).some(k=>!['factId','source','sourceRef','checkedAt','note'].includes(k)))fail(400,'Некорректное подтверждение');
      if(!Number.isSafeInteger(proof.factId)||seen.has(proof.factId))fail(400,'Некорректный идентификатор факта');
      seen.add(proof.factId);
      const row=current.get(proof.factId);
      if(!row)fail(409,'Значение факта изменилось. Сверьте новую версию перед подтверждением');
      const source=clean(proof.source,1000,true),sourceRef=clean(proof.sourceRef,2000,true),note=clean(proof.note??'',2000);
      const checkedAt=clean(proof.checkedAt,40,true);
      if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(checkedAt)||!Number.isFinite(Date.parse(checkedAt))||Date.parse(checkedAt)>now())fail(400,'Проверьте дату: она не может быть в будущем');
      if(new Date(checkedAt).toISOString()!==checkedAt.replace(/(?<!\.\d{3})Z$/,'.000Z'))fail(400,'Некорректная календарная дата');
      insert(companyId,row.fact_key,{label:row.label,value:JSON.parse(row.value_json),removed:!!row.removed},revision,actorId,row,
        {source,sourceRef,note,checkedAt:new Date(checkedAt).toISOString()});
    }
  }
  function history(companyId,key) {
    clean(key,500,true);
    return db.prepare('SELECT * FROM company_fact_versions WHERE company_id=? AND fact_key=? ORDER BY id DESC LIMIT 100').all(companyId,key).map(present);
  }
  return {sync,list,confirm,history};
}
module.exports={createCompanyFacts,profileFacts};
