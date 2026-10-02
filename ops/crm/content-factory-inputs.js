'use strict';

/* Вводные контент-завода (CF1): постоянный профиль покупателей и пожелания на конкретный месяц.
   Бриф Медиа-наставника остаётся источником продукта, аудитории, ситуаций покупателя и площадок
   и здесь не меняется: новые поля живут отдельно, поэтому их правка не создаёт новую версию брифа
   и не снимает согласования плана. Модуль ничего не генерирует, не публикует и не ходит в сеть.
   Неизвестное хранится пустым: пол и возраст не превращаются в догадки о доходе и интересах. */

const {company,fail,object,text,revision}=require('./company-information');
const {CAPTION_PLATFORMS,FORMATS,ROLES}=require('./autoposting');

const GENDERS=Object.freeze({women:'Женщины',men:'Мужчины'});
const AGE_MIN=0,AGE_MAX=120,MAX_PER_DAY=3;
const PROFILE_FIELDS=['genders','ageFrom','ageTo','geography','targetAction','targetUrl','occasions','questions','proofs','sourcesNote','styleNotes'];
const MONTH_FIELDS=['priorities','events','excludedDays','platforms','perDay','formats','roles','note'];
const EMPTY_PROFILE=Object.freeze({genders:[],ageFrom:null,ageTo:null,geography:'',targetAction:'',targetUrl:'',
  occasions:[],questions:[],proofs:[],sourcesNote:'',styleNotes:''});
const EMPTY_MONTH=Object.freeze({priorities:[],events:[],excludedDays:[],platforms:[],perDay:{},formats:[],roles:[],note:''});
const MONTH_RE=/^(\d{4})-(0[1-9]|1[0-2])$/,DATE_RE=/^\d{4}-\d{2}-\d{2}$/;

function parse(value,fallback){try{return JSON.parse(value);}catch{return fallback;}}
const clone=value=>JSON.parse(JSON.stringify(value));
function texts(value,{max,length,label}){
  if(!Array.isArray(value)||value.length>max)fail(400,`Слишком много записей: ${label}`);
  const out=value.map(item=>text(item,length,true));
  if(new Set(out).size!==out.length)fail(400,`Записи не должны повторяться: ${label}`);
  return out;
}
function age(value){
  if(value===null)return null;
  if(!Number.isInteger(value)||value<AGE_MIN||value>AGE_MAX)fail(400,`Возраст — целое число от ${AGE_MIN} до ${AGE_MAX} или пусто`);
  return value;
}
function link(value){
  const result=text(value,2000);
  if(!result)return '';
  let url;try{url=new URL(result);}catch{fail(400,'Ссылка целевого действия — адрес http(s)');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)fail(400,'Ссылка целевого действия — адрес http(s)');
  return url.href;
}
function normalizeProfile(patch){
  object(patch,PROFILE_FIELDS);
  if(!Object.keys(patch).length)fail(400,'Укажите, что изменить во вводных');
  const clean={};
  for(const [key,value] of Object.entries(patch)){
    if(key==='genders'){
      if(!Array.isArray(value)||value.some(item=>typeof item!=='string'||!Object.hasOwn(GENDERS,item))||new Set(value).size!==value.length)
        fail(400,'Пол: отметьте «Женщины», «Мужчины», обе или ни одной');
      clean.genders=Object.keys(GENDERS).filter(id=>value.includes(id));
    }else if(key==='ageFrom'||key==='ageTo')clean[key]=age(value);
    else if(key==='targetUrl')clean[key]=link(value);
    else if(['occasions','questions'].includes(key))clean[key]=texts(value,{max:30,length:300,label:key==='occasions'?'поводы покупки':'вопросы и сомнения'});
    else if(key==='proofs')clean[key]=texts(value,{max:30,length:500,label:'преимущества и доказательства'});
    else clean[key]=text(value,['sourcesNote','styleNotes'].includes(key)?2000:500);
  }
  return clean;
}
function checkProfile(fields){
  if(fields.ageFrom!==null&&fields.ageTo!==null&&fields.ageFrom>fields.ageTo)fail(400,'Возраст «от» не больше возраста «до»');
}
function monthOf(value){
  const match=typeof value==='string'?MONTH_RE.exec(value):null;
  if(!match)fail(400,'Месяц — в формате ГГГГ-ММ');
  const days=new Date(Date.UTC(Number(match[1]),Number(match[2]),0)).getUTCDate();
  return {month:value,days};
}
function dayIn(value,month,label){
  if(typeof value!=='string'||!DATE_RE.test(value))fail(400,`${label}: дата в формате ГГГГ-ММ-ДД`);
  const time=Date.parse(`${value}T00:00:00Z`);
  if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==value)fail(400,`${label}: такой даты не существует`);
  if(!value.startsWith(month+'-'))fail(400,`${label}: дата вне выбранного месяца`);
  return value;
}
function normalizeMonth(patch,month){
  object(patch,MONTH_FIELDS);
  if(!Object.keys(patch).length)fail(400,'Укажите, что изменить в пожеланиях месяца');
  const clean={},allowed=Object.keys(CAPTION_PLATFORMS);
  for(const [key,value] of Object.entries(patch)){
    if(key==='priorities')clean.priorities=texts(value,{max:30,length:300,label:'приоритеты'});
    else if(key==='note')clean.note=text(value,2000);
    else if(key==='events'){
      if(!Array.isArray(value)||value.length>30)fail(400,'Слишком много событий месяца');
      clean.events=value.map(row=>{
        object(row,['title','date','conditions','confirmed']);
        if(typeof row.confirmed!=='boolean')fail(400,'Подтверждение условий события — да или нет');
        const date=row.date===''||row.date===undefined||row.date===null?'':dayIn(row.date,month,'Дата события');
        return {title:text(row.title,300,true),date,conditions:text(row.conditions??'',1000),confirmed:row.confirmed};
      });
    }else if(key==='excludedDays'){
      if(!Array.isArray(value)||value.length>31)fail(400,'Слишком много дней-исключений');
      const days=value.map(item=>dayIn(item,month,'День без публикаций'));
      if(new Set(days).size!==days.length)fail(400,'Дни-исключения не должны повторяться');
      clean.excludedDays=[...days].sort();
    }else if(key==='platforms'){
      if(!Array.isArray(value)||value.some(item=>typeof item!=='string'||!allowed.includes(item))||new Set(value).size!==value.length)
        fail(400,`Площадка: ${allowed.join(', ')}`);
      clean.platforms=allowed.filter(id=>value.includes(id));
    }else if(key==='formats'||key==='roles'){
      const vocabulary=key==='formats'?FORMATS:ROLES,ids=Object.keys(vocabulary);
      if(!Array.isArray(value)||value.some(id=>typeof id!=='string'||!Object.hasOwn(vocabulary,id))||new Set(value).size!==value.length)
        fail(400,`${key==='formats'?'Форматы':'Цели ОВП'}: выберите уникальные значения из ${ids.join(', ')}`);
      clean[key]=ids.filter(id=>value.includes(id));
    }else if(key==='perDay'){
      if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'Объём по площадкам задаётся объектом');
      const out={};
      for(const [platform,count] of Object.entries(value)){
        if(!allowed.includes(platform))fail(400,`Площадка: ${allowed.join(', ')}`);
        if(!Number.isInteger(count)||count<0||count>MAX_PER_DAY)fail(400,`Объём в день — целое число от 0 до ${MAX_PER_DAY}`);
        out[platform]=count;
      }
      clean.perDay=out;
    }
  }
  return clean;
}
function checkMonth(inputs){
  for(const platform of Object.keys(inputs.perDay))
    if(!inputs.platforms.includes(platform))fail(400,'Объём задан для невыбранной площадки');
}
const publications=(inputs,days)=>(days-inputs.excludedDays.length)*inputs.platforms.reduce((sum,id)=>sum+(inputs.perDay[id]||0),0);

function createContentFactoryInputs(db,{now=Date.now}={}){
  db.exec(`CREATE TABLE IF NOT EXISTS content_factory_profile_versions (
    company_id INTEGER NOT NULL REFERENCES companies(id),revision INTEGER NOT NULL,profile TEXT NOT NULL,
    created_at TEXT NOT NULL,actor_id INTEGER,actor_name TEXT NOT NULL DEFAULT '',reason TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(company_id,revision));
    CREATE TRIGGER IF NOT EXISTS content_factory_profile_versions_immutable_update BEFORE UPDATE ON content_factory_profile_versions
    BEGIN SELECT RAISE(ABORT,'Immutable content factory profile version'); END;
    CREATE TRIGGER IF NOT EXISTS content_factory_profile_versions_immutable_delete BEFORE DELETE ON content_factory_profile_versions
    BEGIN SELECT RAISE(ABORT,'Immutable content factory profile version'); END;
    CREATE TABLE IF NOT EXISTS content_factory_profiles (
    company_id INTEGER PRIMARY KEY REFERENCES companies(id),revision INTEGER NOT NULL,profile TEXT NOT NULL,updated_at TEXT NOT NULL,
    FOREIGN KEY(company_id,revision) REFERENCES content_factory_profile_versions(company_id,revision));
    CREATE TABLE IF NOT EXISTS content_factory_month_versions (
    company_id INTEGER NOT NULL REFERENCES companies(id),month TEXT NOT NULL,revision INTEGER NOT NULL,inputs TEXT NOT NULL,
    created_at TEXT NOT NULL,actor_id INTEGER,actor_name TEXT NOT NULL DEFAULT '',reason TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(company_id,month,revision));
    CREATE TRIGGER IF NOT EXISTS content_factory_month_versions_immutable_update BEFORE UPDATE ON content_factory_month_versions
    BEGIN SELECT RAISE(ABORT,'Immutable content factory month version'); END;
    CREATE TRIGGER IF NOT EXISTS content_factory_month_versions_immutable_delete BEFORE DELETE ON content_factory_month_versions
    BEGIN SELECT RAISE(ABORT,'Immutable content factory month version'); END;
    CREATE TABLE IF NOT EXISTS content_factory_months (
    company_id INTEGER NOT NULL REFERENCES companies(id),month TEXT NOT NULL,revision INTEGER NOT NULL,inputs TEXT NOT NULL,
    updated_at TEXT NOT NULL,PRIMARY KEY(company_id,month),
    FOREIGN KEY(company_id,month,revision) REFERENCES content_factory_month_versions(company_id,month,revision));`);
  const iso=()=>new Date(now()).toISOString();
  function transaction(work){db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
  function who(actor={}){
    return {userId:Number.isSafeInteger(actor.userId)?actor.userId:null,userName:typeof actor.userName==='string'?actor.userName.slice(0,200):''};
  }
  function profileOf(owner){
    const row=db.prepare('SELECT revision,profile,updated_at updatedAt FROM content_factory_profiles WHERE company_id=?').get(owner.id);
    const fields={...clone(EMPTY_PROFILE),...(row?parse(row.profile,{}):{})};
    const history=db.prepare(`SELECT revision,created_at createdAt,actor_name actorName,reason FROM content_factory_profile_versions
      WHERE company_id=? ORDER BY revision DESC LIMIT 20`).all(owner.id).map(item=>({...item}));
    return {revision:row?.revision||0,updatedAt:row?.updatedAt||null,fields,history};
  }
  function vocabulary(){
    return {genders:Object.entries(GENDERS).map(([id,label])=>({id,label})),
      platforms:Object.entries(CAPTION_PLATFORMS).map(([id,item])=>({id,label:item.label||id})),
      formats:Object.entries(FORMATS).map(([id,label])=>({id,label})),
      roles:Object.entries(ROLES).map(([id,label])=>({id,label})),
      maxPerDay:MAX_PER_DAY,ageMin:AGE_MIN,ageMax:AGE_MAX};
  }
  const snapshot=owner=>({companyCode:owner.code.toLowerCase(),timezone:owner.timezone||'',profile:profileOf(owner),vocabulary:vocabulary(),
    notice:'Вводные влияют на следующие предложения плана и не меняют сохранённые публикации. Генерация и публикация этим разделом не запускаются.'});
  function get(code){return snapshot(company(db,code));}
  function saveProfile(code,body,actor={}){
    object(body,['revision','profile','reason']);revision(body.revision);
    const patch=normalizeProfile(body.profile);
    const reason=body.reason===undefined?'Вводные обновлены':text(body.reason,500,true),person=who(actor);
    return transaction(()=>{
      const owner=company(db,code),current=profileOf(owner);
      if(body.revision!==current.revision)fail(409,'Вводные уже изменили. Обновите страницу.','REVISION_CONFLICT');
      const fields={...current.fields,...patch};
      checkProfile(fields);
      if(JSON.stringify(fields)===JSON.stringify(current.fields))return snapshot(owner);
      const next=current.revision+1,time=iso();
      db.prepare('INSERT INTO content_factory_profile_versions(company_id,revision,profile,created_at,actor_id,actor_name,reason) VALUES(?,?,?,?,?,?,?)')
        .run(owner.id,next,JSON.stringify(fields),time,person.userId,person.userName,reason);
      db.prepare(`INSERT INTO content_factory_profiles(company_id,revision,profile,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(company_id) DO UPDATE SET revision=excluded.revision,profile=excluded.profile,updated_at=excluded.updated_at`)
        .run(owner.id,next,JSON.stringify(fields),time);
      return snapshot(owner);
    });
  }
  function monthState(owner,month,days){
    const row=db.prepare('SELECT revision,inputs,updated_at updatedAt FROM content_factory_months WHERE company_id=? AND month=?').get(owner.id,month);
    const inputs={...clone(EMPTY_MONTH),...(row?parse(row.inputs,{}):{})};
    const history=db.prepare(`SELECT revision,created_at createdAt,actor_name actorName FROM content_factory_month_versions
      WHERE company_id=? AND month=? ORDER BY revision DESC LIMIT 20`).all(owner.id,month).map(item=>({...item}));
    return {companyCode:owner.code.toLowerCase(),month,daysInMonth:days,revision:row?.revision||0,updatedAt:row?.updatedAt||null,
      inputs,publicationCount:publications(inputs,days),history};
  }
  function month(code,value){const {month:m,days}=monthOf(value);return monthState(company(db,code),m,days);}
  function saveMonth(code,value,body,actor={}){
    const {month:m,days}=monthOf(value);
    object(body,['revision','inputs','reason']);revision(body.revision);
    const patch=normalizeMonth(body.inputs,m);
    const reason=body.reason===undefined?'Пожелания месяца обновлены':text(body.reason,500,true),person=who(actor);
    return transaction(()=>{
      const owner=company(db,code),current=monthState(owner,m,days);
      if(body.revision!==current.revision)fail(409,'Пожелания месяца уже изменили. Обновите страницу.','REVISION_CONFLICT');
      const inputs={...current.inputs,...patch};
      checkMonth(inputs);
      if(JSON.stringify(inputs)===JSON.stringify(current.inputs))return current;
      const next=current.revision+1,time=iso();
      db.prepare('INSERT INTO content_factory_month_versions(company_id,month,revision,inputs,created_at,actor_id,actor_name,reason) VALUES(?,?,?,?,?,?,?,?)')
        .run(owner.id,m,next,JSON.stringify(inputs),time,person.userId,person.userName,reason);
      db.prepare(`INSERT INTO content_factory_months(company_id,month,revision,inputs,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(company_id,month) DO UPDATE SET revision=excluded.revision,inputs=excluded.inputs,updated_at=excluded.updated_at`)
        .run(owner.id,m,next,JSON.stringify(inputs),time);
      return monthState(owner,m,days);
    });
  }
  return {get,saveProfile,month,saveMonth};
}

module.exports={createContentFactoryInputs,EMPTY_PROFILE,EMPTY_MONTH,GENDERS,MAX_PER_DAY,PROFILE_FIELDS,MONTH_FIELDS};
