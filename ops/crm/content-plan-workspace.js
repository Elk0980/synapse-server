'use strict';

/* №98 Б «Контент → Контент-план»: анкета нового проекта и согласование плана отметками.
   Анкета хранится отдельно от брифа: частичное сохранение не создаёт версию брифа и не снимает
   согласований. Отметки согласующих привязаны к ревизии плана и брифа; когда отмечены все,
   модуль принимает обычное решение approved по всему плану через media-mentor.decideVariants —
   поэтому план сразу виден счётчику «пятница ≥7» и «Съёмке». Ничего не публикуется. */

const {company,fail,object,text}=require('./company-information');
const {CAPTION_PLATFORMS}=require('./autoposting');

const TEXT_FIELDS=Object.freeze({goals:2000,audience:2000,tone:1000,rubrics:2000,frequency:500,onCamera:1000,constraints:2000});
const FIELDS=Object.freeze([...Object.keys(TEXT_FIELDS),'platforms']);
// Заглушка до «Настроек → Контент» (агент А): согласует владелец кабинета.
const OWNER_SLOT=Object.freeze({slot:'owner',label:'Владелец',role:'owner',userId:null});

const parse=(value,fallback)=>{try{return JSON.parse(value);}catch{return fallback;}};
const iso=now=>new Date(now()).toISOString();

function normalize(patch) {
  object(patch,FIELDS);
  if(!Object.keys(patch).length)fail(400,'Укажите, что сохранить в анкете');
  const clean={},allowed=Object.keys(CAPTION_PLATFORMS);
  for(const [key,value] of Object.entries(patch)) {
    if(key!=='platforms'){clean[key]=text(value,TEXT_FIELDS[key]);continue;}
    if(!Array.isArray(value)||value.some(id=>typeof id!=='string'||!allowed.includes(id))||new Set(value).size!==value.length)
      fail(400,`Площадки: ${allowed.join(', ')}`);
    clean.platforms=allowed.filter(id=>value.includes(id));
  }
  return clean;
}

function slotsOf(list) {
  if(!Array.isArray(list)||!list.length||list.length>20)return [OWNER_SLOT];
  const seen=new Set(),out=[];
  for(const item of list) {
    const userId=Number.isSafeInteger(item?.userId)&&item.userId>0?item.userId:null;
    const slot=userId?`user:${userId}`:item?.role==='owner'?'owner':null;
    if(!slot||seen.has(slot))continue;
    seen.add(slot);out.push({slot,label:String(item.label||item.userName||(userId?`#${userId}`:'Владелец')).slice(0,200),role:userId?null:'owner',userId});
  }
  return out.length?out:[OWNER_SLOT];
}

function createContentPlanWorkspace(db,{mentor,approvers=()=>null,now=Date.now}={}) {
  if(!mentor||typeof mentor.get!=='function'||typeof mentor.decideVariants!=='function')throw Error('Нужен media-mentor');
  db.exec(`CREATE TABLE IF NOT EXISTS content_plan_questionnaires(
    company_id INTEGER PRIMARY KEY REFERENCES companies(id),revision INTEGER NOT NULL,data TEXT NOT NULL,
    updated_at TEXT NOT NULL,actor_id INTEGER,actor_name TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS content_plan_signoffs(
    company_id INTEGER NOT NULL REFERENCES companies(id),plan_revision INTEGER NOT NULL,brief_revision INTEGER NOT NULL,
    slot TEXT NOT NULL,actor_id INTEGER,actor_name TEXT NOT NULL,checked_at TEXT NOT NULL,
    PRIMARY KEY(company_id,plan_revision,brief_revision,slot));`);

  function questionnaire(code) {
    const owner=company(db,code);
    const row=db.prepare('SELECT revision,data,updated_at updatedAt,actor_name actorName FROM content_plan_questionnaires WHERE company_id=?').get(owner.id);
    const empty=Object.fromEntries(FIELDS.map(key=>[key,key==='platforms'?[]:'']));
    const fields={...empty,...(row?parse(row.data,{}):{})};
    const filled=FIELDS.filter(key=>key==='platforms'?fields[key].length:fields[key]).length;
    return {companyCode:owner.code.toLowerCase(),revision:row?.revision||0,updatedAt:row?.updatedAt||null,
      updatedBy:row?.actorName||'',fields,filled,total:FIELDS.length,
      rules:['Цены, скидки и акции — только из подтверждённых данных компании.']};
  }

  /* Автосохранение: клиент присылает только изменённые поля и последнюю известную ревизию.
     Чужая более новая правка не перезаписывается молча — 409 и свежая версия. */
  function saveQuestionnaire(code,body,actor={}) {
    object(body,['revision','fields']);
    if(!Number.isSafeInteger(body.revision)||body.revision<0)fail(400,'Укажите версию анкеты');
    const patch=normalize(body.fields);
    db.exec('BEGIN IMMEDIATE');
    try {
      const owner=company(db,code),current=questionnaire(code);
      if(current.revision!==body.revision)fail(409,'Анкету уже изменили. Обновите страницу.','REVISION_CONFLICT');
      const fields={...current.fields,...patch};
      if(JSON.stringify(fields)!==JSON.stringify(current.fields)) {
        db.prepare(`INSERT INTO content_plan_questionnaires(company_id,revision,data,updated_at,actor_id,actor_name) VALUES(?,?,?,?,?,?)
          ON CONFLICT(company_id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at,
          actor_id=excluded.actor_id,actor_name=excluded.actor_name`)
          .run(owner.id,current.revision+1,JSON.stringify(fields),iso(now),actor.userId??null,String(actor.userName||'').slice(0,200));
      }
      db.exec('COMMIT');
    } catch(error){db.exec('ROLLBACK');throw error;}
    return questionnaire(code);
  }

  function canCheck(slot,identity) {
    if(!identity)return false;
    const approver=identity.role==='owner'||identity.permissions?.has?.('content-plan.approve')||
      Array.isArray(identity.permissions)&&identity.permissions.includes('content-plan.approve');
    if(!approver)return false;
    return slot.userId?slot.userId===identity.userId:identity.role==='owner';
  }

  function signoffs(code,identity=null) {
    const owner=company(db,code),snap=mentor.get(code),plan=snap.plan;
    const configured=approvers(owner.code.toLowerCase()),slots=slotsOf(configured);
    const base={companyCode:owner.code.toLowerCase(),approversSource:Array.isArray(configured)&&configured.length?'settings':'stub',
      planRevision:plan?.revision||0,briefRevision:snap.brief.revision};
    const states=snap.variants||[],approvable=states.filter(s=>s.approvable);
    const approvedIdeas=new Set(approvable.filter(s=>s.status==='approved').map(s=>s.ideaId));
    const ideas=new Set(approvable.map(s=>s.ideaId));
    const marks=plan?db.prepare(`SELECT slot,actor_name actorName,checked_at checkedAt FROM content_plan_signoffs
      WHERE company_id=? AND plan_revision=? AND brief_revision=?`).all(owner.id,plan.revision,snap.brief.revision):[];
    const bySlot=new Map(marks.map(m=>[m.slot,m]));
    const list=slots.map(slot=>({...slot,checked:bySlot.has(slot.slot),actorName:bySlot.get(slot.slot)?.actorName||'',
      checkedAt:bySlot.get(slot.slot)?.checkedAt||null,canCheck:Boolean(plan)&&canCheck(slot,identity)}));
    const all=list.length>0&&list.every(item=>item.checked);
    const fresh=plan&&plan.briefRevision===snap.brief.revision;
    /* «К СММ» — только когда все отметили И все заполненные версии действующей ревизии согласованы:
       правка плана после отметок возвращает его на согласование без ручного сброса. */
    const stage=!plan?'none':fresh&&all&&ideas.size>0&&approvedIdeas.size===ideas.size?'smm':'approval';
    return {...base,approvers:list,allChecked:all,stage,ideas:ideas.size,approvedIdeas:approvedIdeas.size,
      emptyIdeas:(plan?.days||[]).filter(day=>!ideas.has(day.ideaId)).map(day=>day.ideaId)};
  }

  function signoff(code,body,identity) {
    object(body,['planRevision','briefRevision','slot','checked']);
    if(typeof body.checked!=='boolean'||typeof body.slot!=='string')fail(400,'Укажите отметку согласующего');
    const owner=company(db,code),state=signoffs(code,identity);
    if(!state.planRevision)fail(409,'План ещё не составлен','PLAN_REQUIRED');
    if(body.planRevision!==state.planRevision||body.briefRevision!==state.briefRevision)
      fail(409,'План уже изменили. Обновите страницу.','REVISION_CONFLICT');
    const slot=state.approvers.find(item=>item.slot===body.slot);
    if(!slot)fail(404,'Согласующий не найден','NOT_FOUND');
    if(!slot.canCheck)fail(403,'Эту отметку ставит другой согласующий','FORBIDDEN');
    const actor={userId:identity.userId,userName:String(identity.userName||`#${identity.userId}`).slice(0,200)};
    const revs={planRevision:state.planRevision,briefRevision:state.briefRevision};
    const othersChecked=state.approvers.filter(item=>item.slot!==slot.slot).every(item=>item.checked);
    if(body.checked&&!slot.checked&&othersChecked) {
      if(!state.ideas)fail(409,'Согласовывать нечего: заполните подпись хотя бы у одного материала','NOTHING_TO_DECIDE');
      const names=[...state.approvers.filter(i=>i.checked).map(i=>i.actorName),actor.userName].join(', ');
      mentor.decideVariants(code,{...revs,scope:'plan',decision:'approved',comment:`Отметки согласующих: ${names}`.slice(0,2000)},actor);
    }
    if(!body.checked&&slot.checked&&state.stage==='smm')
      mentor.decideVariants(code,{...revs,scope:'plan',decision:'withdrawn',comment:`Снята отметка: ${actor.userName}`},actor);
    if(body.checked)db.prepare(`INSERT OR IGNORE INTO content_plan_signoffs(company_id,plan_revision,brief_revision,slot,actor_id,actor_name,checked_at)
      VALUES(?,?,?,?,?,?,?)`).run(owner.id,revs.planRevision,revs.briefRevision,slot.slot,actor.userId,actor.userName,iso(now));
    else db.prepare('DELETE FROM content_plan_signoffs WHERE company_id=? AND plan_revision=? AND brief_revision=? AND slot=?')
      .run(owner.id,revs.planRevision,revs.briefRevision,slot.slot);
    return signoffs(code,identity);
  }

  return {questionnaire,saveQuestionnaire,signoffs,signoff};
}

module.exports={createContentPlanWorkspace,QUESTIONNAIRE_FIELDS:FIELDS};
