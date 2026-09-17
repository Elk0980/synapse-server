'use strict';

const {company, fail, object, text, timezone, utcDate, revision} = require('./company-information');
const TYPES = ['booked', 'confirmed', 'visited', 'no_show', 'rescheduled', 'cancelled', 'membership'];
const LABELS = {new:'Новая заявка',booked:'Записан',confirmed:'Подтвердил визит',visited:'Пришёл',no_show:'Не пришёл',rescheduled:'Перенос',cancelled:'Отменил запись',membership:'Купил абонемент'};
function stateOf(events) {
  const state={status:'new',appointmentAt:null,timezone:null,visited:0,memberships:0};
  for(const e of events.filter(e=>!e.voidedAt)) {
    state.status=e.type;
    if(['booked','rescheduled'].includes(e.type)){state.appointmentAt=e.appointmentAt;state.timezone=e.timezone;}
    if(e.type==='visited')state.visited++;
    if(e.type==='membership')state.memberships++;
  }
  return state;
}
function createStudioJourney(db,{now=Date.now}={}) {
  db.exec(`CREATE TABLE IF NOT EXISTS studio_journey_events (
    id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), lead_id INTEGER NOT NULL REFERENCES leads(id),
    type TEXT NOT NULL, occurred_at TEXT NOT NULL, appointment_at TEXT, timezone TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '', membership_name TEXT NOT NULL DEFAULT '', amount_cents INTEGER,
    evidence TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, actor_id INTEGER,
    voided_at TEXT, voided_by INTEGER, void_reason TEXT, request_id TEXT NOT NULL,
    UNIQUE(company_id,lead_id,request_id));
    CREATE INDEX IF NOT EXISTS studio_journey_lead_idx ON studio_journey_events(company_id,lead_id,id);`);
  const iso=()=>new Date(now()).toISOString();
  function transaction(work){db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
  function leadFor(code,id){
    const owner=company(db,code);
    if(!Number.isSafeInteger(Number(id))||Number(id)<1)fail(404,'Заявка не найдена','NOT_FOUND');
    const lead=db.prepare('SELECT * FROM leads WHERE id=? AND company_code=? COLLATE NOCASE').get(Number(id),owner.code);
    if(!lead)fail(404,'Заявка не найдена','NOT_FOUND');return {owner,lead};
  }
  const eventsFor=(owner,id)=>db.prepare(`SELECT id,type,occurred_at occurredAt,appointment_at appointmentAt,timezone,note,
    membership_name membershipName,amount_cents amountCents,evidence,created_at createdAt,actor_id actorId,
    voided_at voidedAt,voided_by voidedBy,void_reason voidReason,request_id requestId
    FROM studio_journey_events WHERE company_id=? AND lead_id=? ORDER BY id`).all(owner.id,id);
  function get(code,id){
    const {owner,lead}=leadFor(code,id),events=eventsFor(owner,lead.id),state=stateOf(events);
    return {companyCode:owner.code.toLowerCase(),leadId:lead.id,name:lead.name,contact:lead.contact,
      source:lead.utm_source||lead.source||'Не указан',createdAt:lead.created_at,
      revision:events.length+events.filter(e=>e.voidedAt).length,timezone:state.timezone||owner.timezone||'UTC',state,events};
  }
  function record(code,id,body,actorId=null){
    object(body,['revision','requestId','type','occurredAt','appointmentAt','timezone','note','membershipName','amount','evidence']);
    revision(body.revision);const requestId=text(body.requestId,100,true);
    if(!/^[\w-]{8,100}$/.test(requestId))fail(400,'Некорректный номер изменения');
    return transaction(()=>{
      const current=get(code,id),{owner}=leadFor(code,id);
      if(current.events.some(e=>e.requestId===requestId))return current;
      if(current.revision!==body.revision)fail(409,'Карточка уже изменена. Обновите её.','REVISION_CONFLICT');
      const type=body.type;if(!TYPES.includes(type))fail(400,'Выберите событие');
      const occurredAt=body.occurredAt?utcDate(body.occurredAt):iso();
      const previous=current.events.filter(e=>!e.voidedAt).at(-1);
      if(Date.parse(occurredAt)>now()+60000||Date.parse(occurredAt)<Date.parse(current.createdAt)||(previous&&occurredAt<previous.occurredAt))
        fail(400,'Время события должно быть после заявки и предыдущей отметки, не в будущем');
      const zone=timezone(body.timezone||current.timezone),note=body.note===undefined?'':text(body.note,2000);
      let appointmentAt=current.state.appointmentAt,membershipName='',amountCents=null,evidence='';
      const status=current.state.status;
      if(['booked','rescheduled'].includes(type)){
        appointmentAt=utcDate(body.appointmentAt);
        if(appointmentAt<occurredAt)fail(400,'Визит не может быть раньше назначения записи. Для исторической записи укажите время события.');
        if(type==='booked'&&!['new','cancelled','no_show','visited','membership'].includes(status))fail(409,'Для действующей записи выберите перенос');
        if(type==='rescheduled'&&!['booked','confirmed','rescheduled','no_show'].includes(status))fail(409,'Сначала назначьте визит');
        if(type==='rescheduled'&&appointmentAt===current.state.appointmentAt)fail(400,'Укажите другое время визита');
        if(type==='rescheduled'&&!note)fail(400,'Укажите причину переноса');
      }else if(type==='confirmed'){
        if(!['booked','rescheduled'].includes(status))fail(409,'Подтвердить можно назначенный визит');
      }else if(['visited','no_show','cancelled'].includes(type)){
        if(!['booked','confirmed','rescheduled'].includes(status))fail(409,'Сначала назначьте визит');
        if(type!=='cancelled'&&(appointmentAt>occurredAt||Date.parse(appointmentAt)>now()))fail(400,'Время визита ещё не наступило');
        if(['no_show','cancelled'].includes(type)&&!note)fail(400,'Укажите причину или «Неизвестна»');
      }else if(type==='membership'){
        if(status!=='visited')fail(409,'Покупка абонемента в этом пути отмечается после состоявшегося визита');
        membershipName=text(body.membershipName,200,true);evidence=text(body.evidence,1000,true);
        if(typeof body.amount!=='number'||!Number.isFinite(body.amount)||body.amount<=0||body.amount>100000000||Math.abs(body.amount*100-Math.round(body.amount*100))>0.00001)
          fail(400,'Укажите фактически оплаченную сумму с точностью до копеек');
        amountCents=Math.round(body.amount*100);
      }
      db.prepare(`INSERT INTO studio_journey_events(company_id,lead_id,type,occurred_at,appointment_at,timezone,note,membership_name,amount_cents,evidence,created_at,actor_id,request_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(owner.id,Number(id),type,occurredAt,appointmentAt,zone,note,membershipName,amountCents,evidence,iso(),actorId,requestId);
      return get(code,id);
    });
  }
  function remove(code,id,eventId,body,actorId=null){
    object(body,['revision','reason']);revision(body.revision);const reason=text(body.reason,2000,true);
    return transaction(()=>{
      const current=get(code,id),{owner}=leadFor(code,id);
      if(current.revision!==body.revision)fail(409,'Карточка уже изменена','REVISION_CONFLICT');
      const last=current.events.filter(e=>!e.voidedAt).at(-1);
      if(!last||last.id!==Number(eventId))fail(409,'Можно отменить только последнюю действующую отметку');
      db.prepare('UPDATE studio_journey_events SET voided_at=?,voided_by=?,void_reason=? WHERE id=? AND company_id=? AND lead_id=?')
        .run(iso(),actorId,reason,last.id,owner.id,Number(id));return get(code,id);
    });
  }
  function list(code,{from,to,source='',offset=0}={}){
    const owner=company(db,code),clauses=['company_code=? COLLATE NOCASE'],args=[owner.code];
    if(from){clauses.push('created_at>=?');args.push(utcDate(from));}
    if(to){clauses.push('created_at<=?');args.push(utcDate(to));}
    if(from&&to&&Date.parse(from)>Date.parse(to))fail(400,'Проверьте период');
    if(source){clauses.push('source=?');args.push(text(source,200));}
    if(!Number.isSafeInteger(offset)||offset<0||offset>1000000)fail(400,'Некорректная страница');
    const leads=db.prepare(`SELECT id,name,contact,created_at,utm_source,source FROM leads WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC,id DESC`).all(...args);
    const allEvents=db.prepare(`SELECT e.lead_id leadId,e.type,e.voided_at voidedAt FROM studio_journey_events e JOIN leads l ON l.id=e.lead_id
      WHERE e.company_id=? AND l.company_code=? COLLATE NOCASE`).all(owner.id,owner.code);
    const byLead=new Map();for(const e of allEvents){if(!e.voidedAt){if(!byLead.has(e.leadId))byLead.set(e.leadId,[]);byLead.get(e.leadId).push(e.type);}}
    const empty=source=>({source,leads:0,booked:0,confirmed:0,visited:0,memberships:0,noShows:0,reschedules:0,completedVisits:0});
    const groups=new Map(),summary=empty('Все источники');
    for(const lead of leads){const source=lead.utm_source||lead.source||'Не указан';if(!groups.has(source))groups.set(source,empty(source));const events=byLead.get(lead.id)||[];
      for(const target of [summary,groups.get(source)]){target.leads++;for(const [metric,types]of [['booked',['booked','rescheduled']],['confirmed',['confirmed']],['visited',['visited']],['memberships',['membership']]])if(events.some(e=>types.includes(e)))target[metric]++;
        target.noShows+=events.filter(e=>e==='no_show').length;target.reschedules+=events.filter(e=>e==='rescheduled').length;target.completedVisits+=events.filter(e=>e==='visited').length;}}
    for(const target of [summary,...groups.values()]){const completed=target.completedVisits+target.noShows;target.noShowRate=completed?Math.round(target.noShows/completed*1000)/10:null;target.membershipRate=target.visited?Math.round(target.memberships/target.visited*1000)/10:null;}
    return {companyCode:owner.code.toLowerCase(),timezone:owner.timezone||'UTC',summary,sources:[...groups.values()],total:leads.length,offset,
      leads:leads.slice(offset,offset+50).map(l=>{const card=get(code,l.id);return {leadId:card.leadId,name:card.name,contact:card.contact,source:card.source,createdAt:card.createdAt,state:card.state};}),
      basis:'Когорта заявок, созданных в выбранный период. Этапы — по фактическим отметкам; старые статусы и суммы не учитываются.'};
  }
  return {get,record,remove,list};
}

function createStudioJourneyHandler({journey,companyModuleContext,readJson,send}){
  return async function handleStudioJourney(request,response,url,cors={}){
    if(!/^\/studio-journey(?:\/|$)/.test(url.pathname))return false;
    const code=url.searchParams.get('companyCode'),permission=request.method==='GET'?'crm.view':'crm.edit';
    const {identity}=companyModuleContext(request,code,permission);
    const match=/^\/studio-journey(?:\/(\d+)(?:\/(events)(?:\/(\d+))?)?)?$/.exec(url.pathname);
    if(!match)fail(404,'Раздел не найден','NOT_FOUND');
    let result,status=200;
    if(!match[1]&&request.method==='GET')result=journey.list(code,{from:url.searchParams.get('from'),to:url.searchParams.get('to'),source:url.searchParams.get('source')||'',offset:Number(url.searchParams.get('offset')||0)});
    else if(match[1]&&!match[2]&&request.method==='GET')result=journey.get(code,match[1]);
    else if(match[2]&&!match[3]&&request.method==='POST'){result=journey.record(code,match[1],await readJson(request),identity.userId);status=201;}
    else if(match[3]&&request.method==='DELETE')result=journey.remove(code,match[1],match[3],await readJson(request),identity.userId);
    else fail(405,'Метод не поддерживается');
    send(response,status,result,{...cors,'cache-control':'no-store'});return true;
  };
}
module.exports={createStudioJourney,createStudioJourneyHandler,stateOf,TYPES,LABELS};
