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
/* Поля идеи. Прежние имена сохранены целиком: старые планы читаются и сохраняются без
   переименования, миграция клиентской базы руками не нужна. Новое — стабильный ideaId и
   variants: отдельная версия идеи для каждой площадки. */
const DAY_FIELDS=['ideaId','date','platform','format','role','topic','hook','assetId','mentorNote','variants'];
/* Поля версии для площадки. plannedDate/plannedTime/timezone — это ПЛАН выхода, а не очередь
   публикации: постановка в очередь и отправка живут в автопостинге и здесь не выполняются. */
/* contentRevision принимается только для того, чтобы кабинет мог вернуть план в том виде,
   в каком его отдал сервер: значение клиента игнорируется и всегда считается заново. */
const VARIANT_FIELDS=['text','hook','format','assetId','mentorNote','plannedDate','plannedTime','timezone','excluded','contentRevision'];
const VARIANT_SCOPES=Object.freeze(['plan','idea','variants']);
const MAX_VARIANT_TEXT=20000;
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
    object(row,['id','statement','source','approvedForContent']);
    if(row.approvedForContent!==undefined&&typeof row.approvedForContent!=='boolean')
      fail(400,'Разрешение использовать факт в контенте должно быть да или нет');
    const out={id:text(row.id,100,true),statement:text(row.statement,1000,true),source:text(row.source,500,true)};
    if(row.approvedForContent===true)out.approvedForContent=true;
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
function clockTime(value) {
  if(value===undefined||value===null||value==='')return '';
  if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))fail(400,'Время версии — ЧЧ:ММ');
  return value;
}
function zone(value) {
  if(value===undefined||value===null||value==='')return '';
  const raw=text(value,64,true);
  try{new Intl.DateTimeFormat('en-US',{timeZone:raw});}catch{fail(400,'Неизвестный часовой пояс версии');}
  return raw;
}
/* Одна версия идеи для одной площадки. Пустая или исключённая версия согласованной не
   считается и в перенос не идёт: «ничего не написано» — это не одобренный материал. */
function normalizeVariant(platform,row,{assetIds}) {
  if(!row||typeof row!=='object'||Array.isArray(row))fail(400,'Опишите версию для площадки');
  object(row,VARIANT_FIELDS);
  const limit=CAPTION_PLATFORMS[platform]?.limit;
  const body=text(row.text??'',MAX_VARIANT_TEXT);
  if(limit&&body.length>limit)fail(400,`Текст версии для площадки ${CAPTION_PLATFORMS[platform].label} длиннее ${limit} символов`);
  if(row.format!==undefined&&row.format!==null&&row.format!==''&&!Object.hasOwn(FORMATS,row.format))
    fail(400,'Формат версии: post, story, reel или carousel');
  const assetId=row.assetId===undefined||row.assetId===null||row.assetId===''?'':text(row.assetId,100,true);
  if(assetId&&!assetIds.has(assetId))fail(400,'Исходник версии отсутствует в брифе компании');
  if(row.excluded!==undefined&&typeof row.excluded!=='boolean')fail(400,'Признак исключения версии — да или нет');
  const plannedDate=row.plannedDate===undefined||row.plannedDate===null||row.plannedDate===''?'':calendarDate(row.plannedDate).value;
  return {text:body,hook:text(row.hook??'',500),format:row.format||'',assetId,
    mentorNote:text(row.mentorNote??'',2000),plannedDate,plannedTime:clockTime(row.plannedTime),
    timezone:zone(row.timezone),excluded:row.excluded===true};
}
/* ДЕЙСТВУЮЩЕЕ содержимое версии: то, что реально уйдёт в материал. Часть полей версия может
   не задавать — тогда действует значение идеи, и перенос берёт именно его. Поэтому ревизия
   считается по действующим значениям, а не по сырым полям версии: правка формата, зацепки,
   исходника, заметки или даты идеи меняет материал наследующей версии — и требует нового
   решения. Версия со своим значением того же поля от такой правки не меняется и согласование
   не теряет: у неё действующее содержимое осталось прежним. */
function variantEffective(variant,idea) {
  return {role:idea.role,topic:idea.topic,text:variant.text,
    hook:variant.hook||idea.hook||'',format:variant.format||idea.format||'',
    assetId:variant.assetId||idea.assetId||'',mentorNote:variant.mentorNote||idea.mentorNote||'',
    plannedDate:variant.plannedDate||idea.date||'',plannedTime:variant.plannedTime||'',
    timezone:variant.timezone||'',excluded:variant.excluded===true};
}
const variantContent=(variant,idea)=>JSON.stringify(Object.values(variantEffective(variant,idea)));
/* Календарные даты без времени: этап основы ничего не планирует к отправке,
   поэтому часовой пояс и минуты выхода остаются задачей этапа публикации. */
/* reserve(ideaId,platform) выдаёт СЛЕДУЮЩУЮ свободную ревизию содержимого по сохранённой
   истории, а не по текущему плану. Удаление версии или всей идеи историю не сбрасывает:
   вернуть прежний текст под тем же ideaId и получить прежнюю ревизию (а вместе с ней
   оживить старое согласование и старый перенос) невозможно. A→B→A даёт три разные ревизии. */
function normalizeDays(value,brief,priorPlan=null,reserve=null) {
  if(!brief.platforms.length)fail(400,'Сначала укажите площадки компании в брифе','BRIEF_INCOMPLETE');
  if(!Array.isArray(value)||!value.length||value.length>MAX_DAYS*MAX_ITEMS_PER_DAY)fail(400,'Проверьте состав плана');
  const assetIds=new Set(brief.assets.map(asset=>asset.id)),perDate=new Map(),seenIdeas=new Set();
  /* Прежние версии по стабильному ideaId: по ним переносится серверная contentRevision.
     Перестановка идей в списке привязок не рвёт — ключ не позиция, а ideaId. */
  const before=new Map();
  for(const old of (priorPlan?.days||[]))if(old&&old.ideaId)before.set(old.ideaId,old);
  let previous=-Infinity,generated=0;
  const days=value.map((row,index)=>{
    object(row,DAY_FIELDS);
    const date=calendarDate(row.date);
    if(date.time<previous)fail(400,'Дни плана должны идти по возрастанию даты');
    previous=date.time;
    /* Три материала в день считаются ПО ИДЕЯМ: у одной идеи может быть до семи версий,
       и они не превращают один материал в семь. */
    const count=(perDate.get(date.value)||0)+1;
    if(count>MAX_ITEMS_PER_DAY)fail(400,`На один день не больше ${MAX_ITEMS_PER_DAY} материалов`);
    perDate.set(date.value,count);
    if(!brief.platforms.includes(row.platform))fail(400,'Площадка дня не выбрана в брифе компании');
    if(!Object.hasOwn(FORMATS,row.format))fail(400,'Формат: post, story, reel или carousel');
    if(!Object.hasOwn(ROLES,row.role))fail(400,'Роль: reach, affection или sale');
    const assetId=row.assetId===undefined||row.assetId===null||row.assetId===''?'':text(row.assetId,100,true);
    if(assetId&&!assetIds.has(assetId))fail(400,'Исходник дня отсутствует в брифе компании');
    /* Стабильный идентификатор идеи. У старого плана его нет — он выдаётся один раз при
       первом сохранении и дальше не меняется ни при правке, ни при перестановке. */
    const ideaId=row.ideaId===undefined||row.ideaId===null||row.ideaId===''
      ? `idea-${date.value}-${String(index+1).padStart(2,'0')}-${++generated}` : text(row.ideaId,100,true);
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(ideaId))fail(400,'Идентификатор идеи: латиница, цифры, дефис и подчёркивание');
    if(seenIdeas.has(ideaId))fail(400,'Идентификаторы идей должны отличаться');
    seenIdeas.add(ideaId);
    const idea={ideaId,date:date.value,platform:row.platform,format:row.format,role:row.role,
      topic:text(row.topic,300,true),hook:text(row.hook??'',500),assetId,mentorNote:text(row.mentorNote??'',2000)};
    /* Версии площадок. Старый план их не содержит: тогда идея читается как ОДНА версия для
       своей площадки — ровно то, что было раньше. Остальные площадки появляются только
       явным добавлением, автоматического согласия за них никто не даёт. */
    const source=row.variants===undefined||row.variants===null
      ? {[row.platform]:{text:'',hook:idea.hook,format:idea.format,assetId:idea.assetId,mentorNote:idea.mentorNote}}
      : row.variants;
    if(typeof source!=='object'||Array.isArray(source))fail(400,'Версии площадок передаются объектом');
    const names=Object.keys(source);
    if(names.length>brief.platforms.length)fail(400,'Слишком много версий у одной идеи');
    const variants={},old=before.get(ideaId);
    for(const platform of names) {
      if(!brief.platforms.includes(platform))fail(400,'Версия сделана для площадки, которой нет в брифе компании');
      const variant=normalizeVariant(platform,source[platform],{assetIds});
      const wasRow=old?.variants?.[platform]||null;
      const same=wasRow&&variantContent(wasRow,old)===variantContent(variant,idea);
      /* Серверная ревизия содержимого: клиент её не задаёт и подменить не может.
         Прежняя ревизия сохраняется ТОЛЬКО когда версия была в прошлом плане и её действующее
         содержимое не изменилось. Во всех остальных случаях выдаётся новая, никогда не
         использованная ревизия — в том числе после удаления и повторного добавления. */
      variant.contentRevision=same?wasRow.contentRevision
        :(reserve?reserve(ideaId,platform):((wasRow?.contentRevision||0)+1));
      variants[platform]=variant;
    }
    if(!Object.hasOwn(variants,idea.platform))fail(400,'У идеи нет версии для её основной площадки');
    return {...idea,variants};
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
    /* Именные решения по версиям площадок. Ключ решения — компания, идея, площадка и
       СЕРВЕРНАЯ ревизия содержимого этой версии плюс ревизия брифа: правка версии, смена
       брифа или подмена площадки делают прежнее решение неприменимым сами собой.
       Перестановка идей истории не трогает: ключ не позиция, а ideaId.
       Записи неизменяемы; отзыв — это новая запись decision='withdrawn'. */
    CREATE TABLE IF NOT EXISTS media_mentor_variant_approvals (
    id INTEGER PRIMARY KEY,company_id INTEGER NOT NULL REFERENCES companies(id),
    idea_id TEXT NOT NULL,platform TEXT NOT NULL,content_revision INTEGER NOT NULL,
    plan_revision INTEGER NOT NULL,brief_revision INTEGER NOT NULL,scope TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('approved','rejected','withdrawn')),
    comment TEXT NOT NULL DEFAULT '',decided_at TEXT NOT NULL,actor_id INTEGER,actor_name TEXT NOT NULL,
    FOREIGN KEY(company_id,plan_revision) REFERENCES media_mentor_plan_versions(company_id,revision),
    FOREIGN KEY(company_id,brief_revision) REFERENCES media_mentor_brief_versions(company_id,revision));
    CREATE INDEX IF NOT EXISTS media_mentor_variant_approvals_idx
    ON media_mentor_variant_approvals(company_id,idea_id,platform,content_revision,id);
    CREATE TRIGGER IF NOT EXISTS media_mentor_variant_approvals_immutable_update BEFORE UPDATE ON media_mentor_variant_approvals
    BEGIN SELECT RAISE(ABORT,'Immutable media mentor variant approval'); END;
    CREATE TRIGGER IF NOT EXISTS media_mentor_variant_approvals_immutable_delete BEFORE DELETE ON media_mentor_variant_approvals
    BEGIN SELECT RAISE(ABORT,'Immutable media mentor variant approval'); END;
    /* Высшая выданная ревизия содержимого по каждой версии. Живёт отдельно от плана и
       НИКОГДА не уменьшается: удалить версию (или всю идею) и вернуть её прежним текстом,
       чтобы воскресить старое согласование и старый перенос, нельзя. */
    CREATE TABLE IF NOT EXISTS media_mentor_variant_revisions (
    company_id INTEGER NOT NULL REFERENCES companies(id),
    idea_id TEXT NOT NULL,platform TEXT NOT NULL,last_revision INTEGER NOT NULL,
    PRIMARY KEY(company_id,idea_id,platform));
    CREATE TRIGGER IF NOT EXISTS media_mentor_variant_revisions_monotonic
    BEFORE UPDATE ON media_mentor_variant_revisions
    WHEN NEW.last_revision<OLD.last_revision
    BEGIN SELECT RAISE(ABORT,'Media mentor variant revision must not go back'); END;
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

  /* ---------- решения по версиям площадок ----------
     Версия согласована, только если ПОСЛЕДНЕЕ решение по её текущей серверной ревизии
     содержимого и текущей ревизии брифа — approved. Любая правка версии, смена брифа или
     отзыв делают её несогласованной без переписывания истории. */
  const approvable=variant=>Boolean(variant)&&variant.excluded!==true&&Boolean(variant.text);
  function variantDecisions(owner,briefRevision) {
    const map=new Map();
    for(const row of db.prepare(`SELECT idea_id ideaId,platform,content_revision contentRevision,decision,comment,
      scope,decided_at decidedAt,actor_id actorId,actor_name actorName,plan_revision planRevision,brief_revision briefRevision
      FROM media_mentor_variant_approvals WHERE company_id=? AND brief_revision=? ORDER BY id`).all(owner.id,briefRevision)) {
      map.set(`${row.ideaId}|${row.platform}|${row.contentRevision}`,{...row});
    }
    return map;
  }
  /* Состояние версии для кабинета и для переноса. Пустая или исключённая версия материалом
     не считается: у неё нет ни согласования, ни права на перенос. */
  function variantState(idea,platform,variant,decisions) {
    const base={ideaId:idea.ideaId,platform,contentRevision:variant.contentRevision,
      approvable:approvable(variant),decision:null,comment:'',decidedAt:null,actorId:null,actorName:'',scope:null};
    if(!base.approvable)return {...base,status:variant.excluded===true?'excluded':'empty',
      reason:variant.excluded===true?'Версия исключена из плана':'В версии нет текста'};
    const last=decisions.get(`${idea.ideaId}|${platform}|${variant.contentRevision}`)||null;
    if(!last)return {...base,status:'pending',reason:'Версия ещё не согласована'};
    if(last.decision==='withdrawn')return {...base,decision:'withdrawn',comment:last.comment,decidedAt:last.decidedAt,
      actorId:last.actorId,actorName:last.actorName,scope:last.scope,status:'pending',reason:'Согласование отозвано'};
    if(last.decision==='rejected')return {...base,decision:'rejected',comment:last.comment,decidedAt:last.decidedAt,
      actorId:last.actorId,actorName:last.actorName,scope:last.scope,status:'rejected',reason:last.comment};
    return {...base,decision:'approved',comment:last.comment,decidedAt:last.decidedAt,actorId:last.actorId,
      actorName:last.actorName,scope:last.scope,status:'approved',reason:''};
  }
  function planVariantStates(owner,plan,briefRevision) {
    const decisions=variantDecisions(owner,briefRevision),out=[];
    for(const idea of plan?.days||[])
      for(const [platform,variant] of Object.entries(idea.variants||{}))
        out.push(variantState(idea,platform,variant,decisions));
    return out;
  }
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
      /* Состояние каждой версии площадки отдельно: кабинет и перенос читают его, а не
         догадываются по решению о плане целиком. */
      variants:plan?planVariantStates(owner,plan,brief.revision):[],
      vocabulary:{platforms:labels(CAPTION_PLATFORMS),formats:labels(FORMATS),roles:labels(ROLES),
        shootingComfort:labels(COMFORT),assetKinds:labels(ASSET_KINDS),minDays:MIN_DAYS,maxDays:MAX_DAYS,
        variantScopes:VARIANT_SCOPES,captionLimits:Object.fromEntries(Object.entries(CAPTION_PLATFORMS)
          .map(([id,item])=>[id,item.limit??null]))},
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
      /* Выдача ревизий: высшая отметка читается из истории, новые значения копятся в памяти
         и записываются только вместе с самим планом. Сохранение без изменений ревизий не
         тратит — выдача происходит лишь там, где действующее содержимое версии изменилось. */
      const high=new Map(),issued=new Map();
      const reserve=(ideaId,platform)=>{
        const key=`${ideaId}|${platform}`;
        if(!high.has(key)) {
          const row=db.prepare(`SELECT last_revision last FROM media_mentor_variant_revisions
            WHERE company_id=? AND idea_id=? AND platform=?`).get(owner.id,ideaId,platform);
          high.set(key,row?row.last:0);
        }
        const next=high.get(key)+1;
        high.set(key,next);issued.set(key,next);
        return next;
      };
      const normalized=normalizeDays(body.days,brief.fields,current,reserve),payload=JSON.stringify(normalized);
      if(Buffer.byteLength(payload)>200000)fail(400,'План слишком большой');
      // Повторное сохранение того же плана по тому же брифу — не новая версия.
      if(current&&current.briefRevision===brief.revision&&JSON.stringify(normalized.days)===JSON.stringify(current.days))return snapshot(owner);
      const next=(current?current.revision:0)+1,time=iso();
      // Отметки записываются вместе с планом: план сохранён — значит ревизии выданы навсегда.
      for(const [key,value] of issued) {
        const [ideaId,platform]=key.split('|');
        db.prepare(`INSERT INTO media_mentor_variant_revisions(company_id,idea_id,platform,last_revision)
          VALUES(?,?,?,?) ON CONFLICT(company_id,idea_id,platform) DO UPDATE SET
          last_revision=MAX(excluded.last_revision,media_mentor_variant_revisions.last_revision)`)
          .run(owner.id,ideaId,platform,value);
      }
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
  /* Адресное решение: весь план, одна идея или выбранные версии площадок.
     Область указывается явно — «согласовал всё» и «согласовал одну версию» это разные
     утверждения, и подменять одно другим нельзя. Возврат требует комментария; отзыв снимает
     согласование. Ревизии плана, брифа и содержимого версии проверяются до записи, изменение
     всех выбранных версий идёт одной транзакцией: половина решений не сохраняется. */
  function decideVariants(code,body,actor={}) {
    object(body,['planRevision','briefRevision','scope','ideaId','platforms','decision','comment']);
    revision(body.planRevision);revision(body.briefRevision);
    if(!VARIANT_SCOPES.includes(body.scope))fail(400,'Область решения: plan, idea или variants');
    if(!['approved','rejected','withdrawn'].includes(body.decision))fail(400,'Решение: approved, rejected или withdrawn');
    const comment=text(body.comment??'',2000);
    // Возврат на доработку без причины исполнителю ничего не говорит.
    if(body.decision==='rejected'&&!comment)fail(400,'Укажите, что исправить в версии');
    const who=person(actor,true);
    return transaction(()=>{
      const owner=company(db,code),brief=briefOf(owner),plan=planOf(owner);
      if(!plan)fail(409,'План ещё не составлен','PLAN_REQUIRED');
      if(body.planRevision!==plan.revision)fail(409,'План уже изменили. Обновите страницу.','REVISION_CONFLICT');
      if(body.briefRevision!==brief.revision||plan.briefRevision!==brief.revision)
        fail(409,'Бриф изменился. Обновите план и согласуйте заново.','BRIEF_CHANGED');
      const ideas=plan.days;
      let targets=[];
      if(body.scope==='plan') {
        if(body.ideaId!==undefined&&body.ideaId!==null)fail(400,'Для решения по всему плану идея не указывается');
        if(body.platforms!==undefined&&body.platforms!==null)fail(400,'Для решения по всему плану площадки не указываются');
        for(const idea of ideas)for(const platform of Object.keys(idea.variants||{}))targets.push({idea,platform});
      } else {
        const ideaId=text(body.ideaId,100,true);
        const idea=ideas.find(item=>item.ideaId===ideaId);
        if(!idea)fail(404,'Идея плана не найдена','IDEA_NOT_FOUND');
        if(body.scope==='idea') {
          if(body.platforms!==undefined&&body.platforms!==null)fail(400,'Для решения по идее площадки не указываются');
          for(const platform of Object.keys(idea.variants||{}))targets.push({idea,platform});
        } else {
          if(!Array.isArray(body.platforms)||!body.platforms.length)fail(400,'Выберите площадки версий');
          const seen=new Set();
          for(const platform of body.platforms) {
            if(typeof platform!=='string'||!Object.hasOwn(idea.variants||{},platform))fail(404,'Версия для площадки не найдена','VARIANT_NOT_FOUND');
            if(seen.has(platform))fail(400,'Площадки не должны повторяться');
            seen.add(platform);targets.push({idea,platform});
          }
        }
      }
      /* Пустые и исключённые версии решением не затрагиваются: одобрять нечего.
         При явном выборе таких версий это ошибка запроса, при «согласовать всё» — пропуск. */
      const explicit=body.scope==='variants';
      targets=targets.filter(({idea,platform})=>{
        const ok=approvable(idea.variants[platform]);
        if(!ok&&explicit)fail(409,'Пустая или исключённая версия не согласуется','VARIANT_NOT_APPROVABLE');
        return ok;
      });
      if(!targets.length)fail(409,'Согласовывать нечего: у выбранных идей нет заполненных версий','NOTHING_TO_DECIDE');
      const decisions=variantDecisions(owner,brief.revision),time=iso(),written=[];
      const insert=db.prepare(`INSERT INTO media_mentor_variant_approvals
        (company_id,idea_id,platform,content_revision,plan_revision,brief_revision,scope,decision,comment,decided_at,actor_id,actor_name)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
      for(const {idea,platform} of targets) {
        const variant=idea.variants[platform];
        const key=`${idea.ideaId}|${platform}|${variant.contentRevision}`;
        const last=decisions.get(key)||null;
        // Повтор того же решения с тем же комментарием новой записи не создаёт.
        if(last&&last.decision===body.decision&&last.comment===comment)continue;
        /* Отзывать можно только действующее согласование. При явном выборе версий молчаливый
           пропуск скрыл бы от владельца, что отзывать было нечего, поэтому это отказ. */
        if(body.decision==='withdrawn'&&(!last||last.decision!=='approved')) {
          if(explicit)fail(409,'Отзывать нечего: эта версия сейчас не согласована','NOTHING_TO_WITHDRAW');
          continue;
        }
        insert.run(owner.id,idea.ideaId,platform,variant.contentRevision,plan.revision,brief.revision,
          body.scope,body.decision,comment,time,who.userId,who.userName);
        written.push({ideaId:idea.ideaId,platform,contentRevision:variant.contentRevision});
      }
      return {...snapshot(owner),applied:written};
    });
  }

  return {get,saveBrief,savePlan,decide,decideVariants,addFeedback,briefVersion,planVersion,
    planVariantStates,variantDecisions};
}

module.exports={createMediaMentor,variantEffective,COMFORT,ASSET_KINDS,BRIEF_FIELDS,DAY_FIELDS,EMPTY_BRIEF,MIN_DAYS,MAX_DAYS,MAX_ITEMS_PER_DAY,NOTICE};
