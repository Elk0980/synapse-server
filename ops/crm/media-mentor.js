'use strict';

/* Медиа-наставник Хью, этап основы. Хранилище брифа компании и контент-плана на 7–14 дней.
   Здесь нет публикаций, расписаний, доставок, обращений к моделям и к сети: модуль только
   принимает, проверяет, версионирует и согласовывает текст, который ввёл человек.
   Словарь площадок, форматов и ролей берётся из autoposting, чтобы следующий этап
   переносил согласованный план в очередь публикаций без переименования значений. */

const {company,fail,object,text,revision}=require('./company-information');
const {FORMATS,ROLES,CAPTION_PLATFORMS}=require('./autoposting');

const COMFORT=Object.freeze({unknown:'Не выяснено',off_camera:'В кадр не готов',voice_only:'Только голос',
  hands_only:'Руки и процесс без лица',on_camera:'Готов в кадр'});
const ASSET_KINDS=Object.freeze({photo:'Фото',video:'Видео',audio:'Аудио',text:'Текст',document:'Документ'});
const BRIEF_FIELDS=['goal','product','audience','pains','confirmedFacts','assets','shootingComfort','platforms'];
const DAY_FIELDS=['date','platform','format','role','topic','hook','assetId','mentorNote'];
const MAX_FEEDBACK_PER_PLAN=200;
const EMPTY_BRIEF=Object.freeze({goal:'',product:'',audience:'',pains:[],confirmedFacts:[],assets:[],
  shootingComfort:Object.freeze({level:'unknown',notes:''}),platforms:[]});
const MIN_DAYS=7,MAX_DAYS=14,MAX_ITEMS_PER_DAY=3;
const NOTICE='Этап основы медиа-наставника: бриф и план хранятся только в CRM. Публикация не выполняется, '+
  'модели не вызываются, HTTP-маршрутов и интерфейса кабинета у раздела ещё нет.';

function parse(value,fallback) {try{return JSON.parse(value);}catch{return fallback;}}
function labels(source) {return Object.entries(source).map(([id,label])=>({id,label:typeof label==='string'?label:label.label}));}

function uniqueTexts(value,{max,length,tooMany,duplicate}) {
  if(!Array.isArray(value)||value.length>max)fail(400,tooMany);
  const out=value.map(item=>text(item,length,true));
  if(new Set(out).size!==out.length)fail(400,duplicate);
  return out;
}
/* Подтверждённый факт обязан называть источник: иначе «подтверждение» ничего не значит
   и следующий этап примет за проверенные сведения обычную догадку. */
function confirmedFacts(value) {
  if(!Array.isArray(value)||value.length>50)fail(400,'Слишком много подтверждённых фактов');
  const seen=new Set();
  return value.map(row=>{
    object(row,['id','statement','source']);
    const out={id:text(row.id,100,true),statement:text(row.statement,1000,true),source:text(row.source,500,true)};
    if(seen.has(out.id))fail(400,'Идентификаторы фактов должны отличаться');
    seen.add(out.id);return out;
  });
}
/* Исходники описываются словами: ни ссылок, ни путей, ни выгрузки файлов на этом этапе нет. */
function assets(value) {
  if(!Array.isArray(value)||value.length>100)fail(400,'Слишком много исходников');
  const seen=new Set();
  return value.map(row=>{
    object(row,['id','title','kind','note']);
    if(!Object.hasOwn(ASSET_KINDS,row.kind))fail(400,'Тип исходника: photo, video, audio, text или document');
    const out={id:text(row.id,100,true),title:text(row.title,300,true),kind:row.kind,note:text(row.note??'',1000)};
    if(seen.has(out.id))fail(400,'Идентификаторы исходников должны отличаться');
    seen.add(out.id);return out;
  });
}
function shootingComfort(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'Опишите комфорт съёмки');
  object(value,['level','notes']);
  if(!Object.hasOwn(COMFORT,value.level))fail(400,'Комфорт съёмки: unknown, off_camera, voice_only, hands_only или on_camera');
  return {level:value.level,notes:text(value.notes??'',2000)};
}
function platforms(value) {
  const allowed=Object.keys(CAPTION_PLATFORMS);
  if(!Array.isArray(value)||value.length>allowed.length)fail(400,'Слишком много площадок');
  const out=value.map(item=>{
    if(typeof item!=='string'||!allowed.includes(item))fail(400,`Площадка: ${allowed.join(', ')}`);
    return item;
  });
  if(new Set(out).size!==out.length)fail(400,'Площадки не должны повторяться');
  return out;
}
function normalizeBrief(patch) {
  object(patch,BRIEF_FIELDS);
  if(!Object.keys(patch).length)fail(400,'Укажите, что изменить в брифе');
  const limits={goal:2000,product:2000,audience:2000},clean={};
  for(const [key,value] of Object.entries(patch)) {
    if(key==='pains')clean[key]=uniqueTexts(value,{max:30,length:500,tooMany:'Слишком много болей клиента',duplicate:'Боли клиента не должны повторяться'});
    else if(key==='confirmedFacts')clean[key]=confirmedFacts(value);
    else if(key==='assets')clean[key]=assets(value);
    else if(key==='shootingComfort')clean[key]=shootingComfort(value);
    else if(key==='platforms')clean[key]=platforms(value);
    else clean[key]=text(value,limits[key]);
  }
  return clean;
}
function calendarDate(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))fail(400,'Дата дня плана — YYYY-MM-DD');
  const time=Date.parse(`${value}T00:00:00Z`);
  if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==value)fail(400,'Такой даты не существует');
  return {value,time};
}
/* Календарные даты без времени: этап основы ничего не планирует к отправке,
   поэтому часовой пояс и минуты выхода остаются задачей этапа публикации. */
function normalizeDays(value,brief) {
  if(!brief.platforms.length)fail(400,'Сначала укажите площадки компании в брифе','BRIEF_INCOMPLETE');
  if(!Array.isArray(value)||!value.length||value.length>MAX_DAYS*MAX_ITEMS_PER_DAY)fail(400,'Проверьте состав плана');
  const assetIds=new Set(brief.assets.map(asset=>asset.id)),perDate=new Map();
  let previous=-Infinity;
  const days=value.map(row=>{
    object(row,DAY_FIELDS);
    const date=calendarDate(row.date);
    if(date.time<previous)fail(400,'Дни плана должны идти по возрастанию даты');
    previous=date.time;
    const count=(perDate.get(date.value)||0)+1;
    if(count>MAX_ITEMS_PER_DAY)fail(400,`На один день не больше ${MAX_ITEMS_PER_DAY} материалов`);
    perDate.set(date.value,count);
    if(!brief.platforms.includes(row.platform))fail(400,'Площадка дня не выбрана в брифе компании');
    if(!Object.hasOwn(FORMATS,row.format))fail(400,'Формат: post, story, reel или carousel');
    if(!Object.hasOwn(ROLES,row.role))fail(400,'Роль: reach, affection или sale');
    const assetId=row.assetId===undefined||row.assetId===null||row.assetId===''?'':text(row.assetId,100,true);
    if(assetId&&!assetIds.has(assetId))fail(400,'Исходник дня отсутствует в брифе компании');
    return {date:date.value,platform:row.platform,format:row.format,role:row.role,topic:text(row.topic,300,true),
      hook:text(row.hook??'',500),assetId,mentorNote:text(row.mentorNote??'',2000)};
  });
  const startDate=days[0].date,endDate=days.at(-1).date;
  const windowDays=Math.round((Date.parse(`${endDate}T00:00:00Z`)-Date.parse(`${startDate}T00:00:00Z`))/86400000)+1;
  if(windowDays<MIN_DAYS||windowDays>MAX_DAYS)fail(400,`План охватывает от ${MIN_DAYS} до ${MAX_DAYS} дней подряд`);
  return {days,startDate,endDate,windowDays};
}
/* Согласование именное: без имени решение нельзя предъявить владельцу. */
function person(actor,required=false) {
  const value=actor===null||actor===undefined?{}:actor;
  if(typeof value!=='object'||Array.isArray(value))fail(400,'Некорректный автор изменения');
  object(value,['userId','userName']);
  if(value.userId!==undefined&&value.userId!==null&&(!Number.isSafeInteger(value.userId)||value.userId<1))fail(400,'Некорректный автор изменения');
  const userName=text(value.userName??'',200);
  if(required&&!userName)fail(400,'Укажите автора действия');
  return {userId:value.userId??null,userName};
}

function createMediaMentor(db,{now=Date.now}={}) {
  db.exec(`CREATE TABLE IF NOT EXISTS media_mentor_brief_versions (
    company_id INTEGER NOT NULL REFERENCES companies(id),revision INTEGER NOT NULL,brief TEXT NOT NULL,
    created_at TEXT NOT NULL,actor_id INTEGER,actor_name TEXT NOT NULL DEFAULT '',reason TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(company_id,revision));
    CREATE TRIGGER IF NOT EXISTS media_mentor_brief_versions_immutable_update BEFORE UPDATE ON media_mentor_brief_versions
    BEGIN SELECT RAISE(ABORT,'Immutable media mentor brief version'); END;
    CREATE TRIGGER IF NOT EXISTS media_mentor_brief_versions_immutable_delete BEFORE DELETE ON media_mentor_brief_versions
    BEGIN SELECT RAISE(ABORT,'Immutable media mentor brief version'); END;
    CREATE TABLE IF NOT EXISTS media_mentor_briefs (
    company_id INTEGER PRIMARY KEY REFERENCES companies(id),revision INTEGER NOT NULL,brief TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(company_id,revision) REFERENCES media_mentor_brief_versions(company_id,revision));
    CREATE TABLE IF NOT EXISTS media_mentor_plan_versions (
    company_id INTEGER NOT NULL REFERENCES companies(id),revision INTEGER NOT NULL,brief_revision INTEGER NOT NULL,
    plan TEXT NOT NULL,created_at TEXT NOT NULL,actor_id INTEGER,actor_name TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',PRIMARY KEY(company_id,revision),
    FOREIGN KEY(company_id,brief_revision) REFERENCES media_mentor_brief_versions(company_id,revision));
    CREATE TRIGGER IF NOT EXISTS media_mentor_plan_versions_immutable_update BEFORE UPDATE ON media_mentor_plan_versions
    BEGIN SELECT RAISE(ABORT,'Immutable media mentor plan version'); END;
    CREATE TRIGGER IF NOT EXISTS media_mentor_plan_versions_immutable_delete BEFORE DELETE ON media_mentor_plan_versions
    BEGIN SELECT RAISE(ABORT,'Immutable media mentor plan version'); END;
    CREATE TABLE IF NOT EXISTS media_mentor_plans (
    company_id INTEGER PRIMARY KEY REFERENCES companies(id),revision INTEGER NOT NULL,brief_revision INTEGER NOT NULL,
    plan TEXT NOT NULL,updated_at TEXT NOT NULL,
    FOREIGN KEY(company_id,revision) REFERENCES media_mentor_plan_versions(company_id,revision));
    CREATE TABLE IF NOT EXISTS media_mentor_plan_approvals (
    id INTEGER PRIMARY KEY,company_id INTEGER NOT NULL REFERENCES companies(id),plan_revision INTEGER NOT NULL,
    brief_revision INTEGER NOT NULL,decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
    comment TEXT NOT NULL DEFAULT '',decided_at TEXT NOT NULL,actor_id INTEGER,actor_name TEXT NOT NULL,
    FOREIGN KEY(company_id,plan_revision) REFERENCES media_mentor_plan_versions(company_id,revision),
    FOREIGN KEY(company_id,brief_revision) REFERENCES media_mentor_brief_versions(company_id,revision));
    CREATE INDEX IF NOT EXISTS media_mentor_plan_approvals_idx ON media_mentor_plan_approvals(company_id,plan_revision,id);
    CREATE TRIGGER IF NOT EXISTS media_mentor_plan_approvals_immutable_update BEFORE UPDATE ON media_mentor_plan_approvals
    BEGIN SELECT RAISE(ABORT,'Immutable media mentor approval'); END;
    CREATE TRIGGER IF NOT EXISTS media_mentor_plan_approvals_immutable_delete BEFORE DELETE ON media_mentor_plan_approvals
    BEGIN SELECT RAISE(ABORT,'Immutable media mentor approval'); END;
    CREATE TABLE IF NOT EXISTS media_mentor_plan_feedback (
    id INTEGER PRIMARY KEY,company_id INTEGER NOT NULL REFERENCES companies(id),
    plan_revision INTEGER NOT NULL,day_index INTEGER NOT NULL CHECK(day_index>=0),
    message TEXT NOT NULL,created_at TEXT NOT NULL,actor_id INTEGER,actor_name TEXT NOT NULL,
    FOREIGN KEY(company_id,plan_revision) REFERENCES media_mentor_plan_versions(company_id,revision));
    CREATE INDEX IF NOT EXISTS media_mentor_plan_feedback_idx
    ON media_mentor_plan_feedback(company_id,plan_revision,day_index,id);
    CREATE TRIGGER IF NOT EXISTS media_mentor_plan_feedback_immutable_update BEFORE UPDATE ON media_mentor_plan_feedback
    BEGIN SELECT RAISE(ABORT,'Immutable media mentor feedback'); END;
    CREATE TRIGGER IF NOT EXISTS media_mentor_plan_feedback_immutable_delete BEFORE DELETE ON media_mentor_plan_feedback
    BEGIN SELECT RAISE(ABORT,'Immutable media mentor feedback'); END;`);
  const iso=()=>new Date(now()).toISOString();
  function transaction(work){db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}

  function briefOf(owner) {
    const row=db.prepare('SELECT revision,brief,updated_at updatedAt FROM media_mentor_briefs WHERE company_id=?').get(owner.id);
    if(!row)return {revision:0,updatedAt:null,fields:structuredClone(EMPTY_BRIEF)};
    return {revision:row.revision,updatedAt:row.updatedAt,fields:{...structuredClone(EMPTY_BRIEF),...parse(row.brief,{})}};
  }
  function planOf(owner) {
    const row=db.prepare('SELECT revision,brief_revision briefRevision,plan,updated_at updatedAt FROM media_mentor_plans WHERE company_id=?').get(owner.id);
    if(!row)return null;
    const stored=parse(row.plan,{days:[],startDate:null,endDate:null,windowDays:0});
    return {revision:row.revision,briefRevision:row.briefRevision,updatedAt:row.updatedAt,days:stored.days,
      startDate:stored.startDate,endDate:stored.endDate,windowDays:stored.windowDays};
  }
  // Строки SQLite копируются в обычные объекты: ответ модуля не зависит от прототипа драйвера.
  const rows=list=>list.map(row=>({...row}));
  function decisionOf(owner,planRevision) {
    const row=db.prepare(`SELECT plan_revision planRevision,brief_revision briefRevision,decision,comment,
      decided_at decidedAt,actor_id actorId,actor_name actorName FROM media_mentor_plan_approvals
      WHERE company_id=? AND plan_revision=? ORDER BY id DESC LIMIT 1`).get(owner.id,planRevision);
    return row?{...row}:null;
  }
  /* Состояние согласования выводится, а не хранится: изменившийся бриф сам по себе
     переводит план в «нужно пересогласовать», даже если решение уже было принято. */
  function approvalOf(owner,brief,plan) {
    const blank={planRevision:null,briefRevision:null,decision:null,decidedAt:null,actorId:null,actorName:null,comment:''};
    if(!plan)return {...blank,status:'absent',requiresReapproval:false,reason:'План ещё не составлен'};
    const last=decisionOf(owner,plan.revision);
    const base={planRevision:plan.revision,briefRevision:last?last.briefRevision:null,decision:last?last.decision:null,
      decidedAt:last?last.decidedAt:null,actorId:last?last.actorId:null,actorName:last?last.actorName:null,comment:last?last.comment:''};
    if(plan.briefRevision!==brief.revision)return {...base,status:'needs_reapproval',requiresReapproval:true,
      reason:`Бриф изменён до версии ${brief.revision}, план составлен по версии ${plan.briefRevision}. Обновите план и согласуйте заново.`};
    if(!last)return {...base,status:'pending',requiresReapproval:true,reason:'Эта версия плана ещё не согласована'};
    if(last.decision==='rejected')return {...base,status:'rejected',requiresReapproval:true,reason:'Эта версия плана отклонена'};
    return {...base,status:'approved',requiresReapproval:false,reason:''};
  }
  const briefHistory=owner=>rows(db.prepare(`SELECT revision,created_at createdAt,actor_id actorId,actor_name actorName,reason
    FROM media_mentor_brief_versions WHERE company_id=? ORDER BY revision DESC LIMIT 30`).all(owner.id));
  const planHistory=owner=>rows(db.prepare(`SELECT revision,brief_revision briefRevision,created_at createdAt,actor_id actorId,
    actor_name actorName,reason FROM media_mentor_plan_versions WHERE company_id=? ORDER BY revision DESC LIMIT 30`).all(owner.id));
  const approvalHistory=owner=>rows(db.prepare(`SELECT plan_revision planRevision,brief_revision briefRevision,decision,comment,
    decided_at decidedAt,actor_id actorId,actor_name actorName FROM media_mentor_plan_approvals
    WHERE company_id=? ORDER BY id DESC LIMIT 30`).all(owner.id));
  const feedbackOf=(owner,planRevision)=>rows(db.prepare(`SELECT id,plan_revision planRevision,day_index dayIndex,
    message,created_at createdAt,actor_id actorId,actor_name actorName FROM media_mentor_plan_feedback
    WHERE company_id=? AND plan_revision=? ORDER BY id ASC`).all(owner.id,planRevision));

  function snapshot(owner) {
    const brief=briefOf(owner),plan=planOf(owner);
    return {companyCode:owner.code.toLowerCase(),notice:NOTICE,
      brief:{revision:brief.revision,updatedAt:brief.updatedAt,fields:brief.fields,history:briefHistory(owner)},
      plan:plan?{...plan,history:planHistory(owner)}:null,
      feedback:plan?feedbackOf(owner,plan.revision):[],
      approval:approvalOf(owner,brief,plan),approvals:approvalHistory(owner),
      vocabulary:{platforms:labels(CAPTION_PLATFORMS),formats:labels(FORMATS),roles:labels(ROLES),
        shootingComfort:labels(COMFORT),assetKinds:labels(ASSET_KINDS),minDays:MIN_DAYS,maxDays:MAX_DAYS},
      capabilities:{publishing:false,modelSuggestions:false,httpApi:false,cabinetUi:false}};
  }

  function get(code){return transaction(()=>snapshot(company(db,code)));}

  function saveBrief(code,body,actor={}) {
    object(body,['revision','brief','reason']);revision(body.revision);
    const patch=normalizeBrief(body.brief);
    const reason=body.reason===undefined?'Бриф обновлён владельцем':text(body.reason,500,true);
    const who=person(actor);
    return transaction(()=>{
      const owner=company(db,code),current=briefOf(owner);
      if(body.revision!==current.revision)fail(409,'Бриф уже изменили. Обновите страницу.','REVISION_CONFLICT');
      const fields={...current.fields,...patch};
      if(Buffer.byteLength(JSON.stringify(fields))>200000)fail(400,'Бриф слишком большой');
      // Сохранение без фактических изменений не создаёт версию: иначе согласованный
      // план возвращался бы на пересогласование от одного нажатия «Сохранить».
      if(JSON.stringify(fields)===JSON.stringify(current.fields))return snapshot(owner);
      const next=current.revision+1,time=iso();
      db.prepare('INSERT INTO media_mentor_brief_versions(company_id,revision,brief,created_at,actor_id,actor_name,reason) VALUES(?,?,?,?,?,?,?)')
        .run(owner.id,next,JSON.stringify(fields),time,who.userId,who.userName,reason);
      db.prepare(`INSERT INTO media_mentor_briefs(company_id,revision,brief,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(company_id) DO UPDATE SET revision=excluded.revision,brief=excluded.brief,updated_at=excluded.updated_at`)
        .run(owner.id,next,JSON.stringify(fields),time);
      return snapshot(owner);
    });
  }

  function savePlan(code,body,actor={}) {
    object(body,['planRevision','briefRevision','days','reason']);
    revision(body.planRevision);revision(body.briefRevision);
    const reason=body.reason===undefined?'План обновлён':text(body.reason,500,true);
    const who=person(actor);
    return transaction(()=>{
      const owner=company(db,code),brief=briefOf(owner),current=planOf(owner);
      if(!brief.revision)fail(409,'Сначала заполните бриф компании','BRIEF_REQUIRED');
      if(body.briefRevision!==brief.revision)fail(409,'Бриф изменился. Составьте план по свежему брифу.','BRIEF_CHANGED');
      if(body.planRevision!==(current?current.revision:0))fail(409,'План уже изменили. Обновите страницу.','REVISION_CONFLICT');
      const normalized=normalizeDays(body.days,brief.fields),payload=JSON.stringify(normalized);
      if(Buffer.byteLength(payload)>200000)fail(400,'План слишком большой');
      // Повторное сохранение того же плана по тому же брифу — не новая версия.
      if(current&&current.briefRevision===brief.revision&&JSON.stringify(normalized.days)===JSON.stringify(current.days))return snapshot(owner);
      const next=(current?current.revision:0)+1,time=iso();
      db.prepare(`INSERT INTO media_mentor_plan_versions(company_id,revision,brief_revision,plan,created_at,actor_id,actor_name,reason)
        VALUES(?,?,?,?,?,?,?,?)`).run(owner.id,next,brief.revision,payload,time,who.userId,who.userName,reason);
      db.prepare(`INSERT INTO media_mentor_plans(company_id,revision,brief_revision,plan,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(company_id) DO UPDATE SET revision=excluded.revision,brief_revision=excluded.brief_revision,
        plan=excluded.plan,updated_at=excluded.updated_at`).run(owner.id,next,brief.revision,payload,time);
      return snapshot(owner);
    });
  }

  /* Согласуется конкретная версия плана вместе с версией брифа, по которой она составлена. */
  function decide(code,body,actor={}) {
    object(body,['planRevision','briefRevision','decision','comment']);
    revision(body.planRevision);revision(body.briefRevision);
    if(body.decision!=='approved'&&body.decision!=='rejected')fail(400,'Решение: approved или rejected');
    const comment=text(body.comment??'',2000);
    if(body.decision==='rejected'&&!comment)fail(400,'Укажите, что исправить в плане');
    const who=person(actor,true);
    return transaction(()=>{
      const owner=company(db,code),brief=briefOf(owner),plan=planOf(owner);
      if(!plan)fail(404,'План ещё не составлен','NOT_FOUND');
      if(body.planRevision!==plan.revision)fail(409,'Версия плана уже изменилась. Обновите страницу.','STALE_PLAN');
      if(body.briefRevision!==brief.revision||plan.briefRevision!==brief.revision)
        fail(409,'Бриф изменился. Обновите план и согласуйте заново.','BRIEF_CHANGED');
      const last=decisionOf(owner,plan.revision);
      // Повтор того же решения по той же версии идемпотентен: журнал не засоряется.
      if(last&&last.decision===body.decision&&last.comment===comment)return snapshot(owner);
      db.prepare(`INSERT INTO media_mentor_plan_approvals(company_id,plan_revision,brief_revision,decision,comment,decided_at,actor_id,actor_name)
        VALUES(?,?,?,?,?,?,?,?)`).run(owner.id,plan.revision,brief.revision,body.decision,comment,iso(),who.userId,who.userName);
      return snapshot(owner);
    });
  }

  // Предложение привязано к неизменяемой версии и индексу строки в ней. Оно не меняет
  // план, согласование, очередь публикаций или уже перенесённые черновики.
  function addFeedback(code,body,actor={}) {
    object(body,['planRevision','dayIndex','message']);revision(body.planRevision);
    if(!Number.isSafeInteger(body.dayIndex)||body.dayIndex<0)fail(400,'Выберите строку плана');
    const message=text(body.message,1000,true),who=person(actor,true);
    return transaction(()=>{
      const owner=company(db,code),plan=planOf(owner);
      if(!plan)fail(404,'План ещё не составлен','NOT_FOUND');
      if(body.planRevision!==plan.revision)fail(409,'План уже изменился. Обновите страницу.','STALE_PLAN');
      if(body.dayIndex>=plan.days.length)fail(400,'Строка плана не найдена');
      const count=db.prepare(`SELECT COUNT(*) n FROM media_mentor_plan_feedback
        WHERE company_id=? AND plan_revision=?`).get(owner.id,plan.revision).n;
      if(count>=MAX_FEEDBACK_PER_PLAN)fail(409,'К этой версии плана уже добавлено слишком много предложений','FEEDBACK_LIMIT');
      db.prepare(`INSERT INTO media_mentor_plan_feedback
        (company_id,plan_revision,day_index,message,created_at,actor_id,actor_name)
        VALUES(?,?,?,?,?,?,?)`).run(owner.id,plan.revision,body.dayIndex,message,iso(),who.userId,who.userName);
      return snapshot(owner);
    });
  }

  function briefVersion(code,value) {
    revision(value);
    return transaction(()=>{
      const owner=company(db,code);
      const row=db.prepare(`SELECT revision,brief,created_at createdAt,actor_id actorId,actor_name actorName,reason
        FROM media_mentor_brief_versions WHERE company_id=? AND revision=?`).get(owner.id,value);
      if(!row)fail(404,'Версия брифа не найдена','NOT_FOUND');
      return {companyCode:owner.code.toLowerCase(),revision:row.revision,createdAt:row.createdAt,actorId:row.actorId,
        actorName:row.actorName,reason:row.reason,fields:{...structuredClone(EMPTY_BRIEF),...parse(row.brief,{})}};
    });
  }
  function planVersion(code,value) {
    revision(value);
    return transaction(()=>{
      const owner=company(db,code);
      const row=db.prepare(`SELECT revision,brief_revision briefRevision,plan,created_at createdAt,actor_id actorId,
        actor_name actorName,reason FROM media_mentor_plan_versions WHERE company_id=? AND revision=?`).get(owner.id,value);
      if(!row)fail(404,'Версия плана не найдена','NOT_FOUND');
      const stored=parse(row.plan,{days:[],startDate:null,endDate:null,windowDays:0});
      return {companyCode:owner.code.toLowerCase(),revision:row.revision,briefRevision:row.briefRevision,createdAt:row.createdAt,
        actorId:row.actorId,actorName:row.actorName,reason:row.reason,days:stored.days,startDate:stored.startDate,
        endDate:stored.endDate,windowDays:stored.windowDays,decision:decisionOf(owner,row.revision),
        feedback:feedbackOf(owner,row.revision)};
    });
  }
  return {get,saveBrief,savePlan,decide,addFeedback,briefVersion,planVersion};
}

module.exports={createMediaMentor,COMFORT,ASSET_KINDS,BRIEF_FIELDS,DAY_FIELDS,EMPTY_BRIEF,MIN_DAYS,MAX_DAYS,MAX_ITEMS_PER_DAY,NOTICE};
