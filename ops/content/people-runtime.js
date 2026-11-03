'use strict';

const {fridaySummary,fridayEvent,nextWeekStart}=require('./people-friday');
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const defaultRule=()=>({enabled:false,userId:null,timezone:'',metric:'approvedIdeas',weekMode:'nextWeek',weekStart:'',minimum:7,weekday:5,morningHour:9,eveningHour:18});
function rollingWeekStart(rule,anchor,at) {
  const date=value=>{
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:rule.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
    const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));return Date.parse(`${p.year}-${p.month}-${p.day}T00:00:00Z`);
  };
  const monday=value=>{const d=date(value),weekday=new Date(d).getUTCDay();return d-((weekday+6)%7)*86400000;};
  const weeks=Math.floor((monday(at)-monday(anchor))/(7*86400000));
  return new Date(Date.parse(`${rule.weekStart}T00:00:00Z`)+weeks*7*86400000).toISOString().slice(0,10);
}
function createPeopleRuntime({db,authStore,tasks,call,notifications,now=Date.now,enabled=false,intervalMs=60000}) {
  db.exec(`CREATE TABLE IF NOT EXISTS people_friday_rules (
    company_code TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    settings TEXT NOT NULL,anchor_at TEXT NOT NULL,updated_at TEXT NOT NULL);`);
  let timer=null,active=null,stopping=false;
  const stamp=()=>new Date(now()).toISOString();
  const owner=(id,code)=>{const u=authStore.getById(id);if(!u||u.role!=='owner'||!u.companyCodes.includes(code))fail(403,'Настройку выполняет владелец');return u;};
  function getRule(actorId,code) {
    owner(actorId,code);const row=db.prepare('SELECT settings FROM people_friday_rules WHERE company_code=?').get(code);
    if(!row)return defaultRule();
    const {_ownerUserId,...rule}=JSON.parse(row.settings);return rule;
  }
  function saveRule(actorId,code,input) {
    owner(actorId,code);
    if(!input||Object.keys(input).some(k=>!Object.hasOwn(defaultRule(),k)))fail(400,'Переданы лишние настройки');
    const rule={...defaultRule(),...input};
    if(
      typeof rule.enabled!=='boolean'||!Number.isSafeInteger(rule.userId)||!Number.isInteger(rule.morningHour)||
      !Number.isInteger(rule.eveningHour)||rule.morningHour<0||rule.eveningHour>23||rule.morningHour>=rule.eveningHour||
      !Number.isInteger(rule.minimum)||rule.minimum<1||rule.minimum>1000||!Number.isInteger(rule.weekday)||rule.weekday<0||rule.weekday>6||
      !['nextWeek','anchored'].includes(rule.weekMode))fail(400,'Проверьте получателя и настройки правила');
    tasks.access(rule.userId,code);
    const start=rule.weekMode==='nextWeek'?nextWeekStart({now:now(),timezone:rule.timezone}):rule.weekStart;
    fridaySummary({companyCode:code,brief:{revision:0},plan:null,variants:[]},{...rule,weekStart:start,now:now()});
    const previous=db.prepare('SELECT settings,anchor_at FROM people_friday_rules WHERE company_code=?').get(code);
    const old=previous?JSON.parse(previous.settings):null;
    const anchor=old&&old.timezone===rule.timezone&&old.weekStart===rule.weekStart&&old.weekMode===rule.weekMode?previous.anchor_at:stamp();
    db.prepare(`INSERT INTO people_friday_rules VALUES(?,?,?,?,?) ON CONFLICT(company_code)
      DO UPDATE SET user_id=excluded.user_id,settings=excluded.settings,anchor_at=excluded.anchor_at,updated_at=excluded.updated_at`).run(code,rule.userId,JSON.stringify({...rule,_ownerUserId:actorId}),anchor,stamp());
    authStore.audit(actorId,rule.userId,'PEOPLE_FRIDAY_RULE_SAVED',{companyCode:code,...rule});
    return rule;
  }
  async function summary(actor,code,rule,anchor) {
    const snapshot=await call('mediaMentor',{},actor,code);
    if(snapshot.companyCode!==code)fail(502,'Источник вернул другой проект');
    const weekStart=rule.weekMode==='nextWeek'?nextWeekStart({now:now(),timezone:rule.timezone}):rollingWeekStart(rule,anchor,now());
    return fridaySummary(snapshot,{...rule,weekStart,now:now()});
  }
  async function preview(actorId,code) {
    const actor=owner(actorId,code),rule=getRule(actorId,code);
    if(!rule.userId)fail(409,'Сначала сохраните получателя и интервал правила');
    const stored=db.prepare('SELECT anchor_at,updated_at FROM people_friday_rules WHERE company_code=?').get(code);
    const result=await summary(actor,code,rule,stored.anchor_at);owner(actorId,code);
    const current=getRule(actorId,code);
    const fresh=db.prepare('SELECT anchor_at,updated_at FROM people_friday_rules WHERE company_code=?').get(code);
    if(JSON.stringify(current)!==JSON.stringify(rule)||fresh.anchor_at!==stored.anchor_at||fresh.updated_at!==stored.updated_at)fail(409,'Правило изменилось. Повторите предпросмотр');
    return {summary:result,event:fridayEvent(result,{slot:'morning',minimum:rule.minimum,weekday:rule.weekday}),deliveryEnabled:enabled===true};
  }
  async function validateEvent({userId,companyCode,eventKey,payload}) {
    const stored=db.prepare('SELECT * FROM people_friday_rules WHERE company_code=?').get(companyCode);
    if(!stored)return false;
    const rule=JSON.parse(stored.settings);
    if(!rule.enabled||rule.userId!==userId)return false;
    let user;try{user=tasks.access(userId,companyCode);}catch{return false;}
    const sourceOwner=owner(rule._ownerUserId,companyCode);
    const result=await summary(sourceOwner,companyCode,rule,stored.anchor_at);
    const fresh=db.prepare('SELECT * FROM people_friday_rules WHERE company_code=?').get(companyCode);
    if(!fresh||fresh.settings!==stored.settings||fresh.updated_at!==stored.updated_at||fresh.anchor_at!==stored.anchor_at)return false;
    for(const slot of ['morning','evening']) {
      const event=fridayEvent(result,{slot,minimum:rule.minimum,weekday:rule.weekday});
      if(event?.eventKey===eventKey&&event.body===payload.body)return true;
    }
    return false;
  }
  function runOnce() {
    if(stopping||enabled!==true)return Promise.resolve({enabled:false});
    if(active)return active;
    active=(async()=>{
      const people=db.prepare(`SELECT m.user_id,m.company_code FROM company_team_members m
        JOIN people_notification_preferences p ON p.user_id=m.user_id AND p.company_code=m.company_code
        WHERE m.staff_role='human_executor' AND p.enabled=1`).all();
      for(const person of people) {
        if(stopping)break;
        try {
          const actor=tasks.access(person.user_id,person.company_code);
          const data=await tasks.list(actor.id,person.company_code);
          tasks.access(actor.id,person.company_code);
          for(const task of data.tasks.filter(t=>t.assignee_name===`person:${actor.id}`)) {
            notifications.enqueue({userId:actor.id,companyCode:person.company_code,
              eventKey:`people-task:${task.id}:${task.coordination.revision}:${task.status}`,
              title:'Задача Synapse',body:`${task.title} · ${{inbox:'Входящие',planned:'Запланировано',in_progress:'В работе',done:'Готово',cancelled:'Отменено'}[task.status]}`,url:'/cabinet/people.html'});
          }
        }catch{} // Не выдавать ошибку чтения за смену статуса или разрешение отправить.
      }
      for(const stored of db.prepare('SELECT * FROM people_friday_rules').all()) {
        if(stopping)break;
        try {
          const rule=JSON.parse(stored.settings);if(!rule.enabled)continue;
          const weekday=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(new Intl.DateTimeFormat('en-US',{timeZone:rule.timezone,weekday:'short'}).format(now()));
          if(weekday!==rule.weekday)continue;
          tasks.access(rule.userId,stored.company_code);
          const sourceOwner=owner(rule._ownerUserId,stored.company_code);
          const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:rule.timezone,hour:'2-digit',hourCycle:'h23'}).format(now()));
          const slot=hour>=rule.eveningHour?'evening':hour>=rule.morningHour?'morning':null;
          if(!slot)continue;
          const result=await summary(sourceOwner,stored.company_code,rule,stored.anchor_at);
          const fresh=db.prepare('SELECT settings FROM people_friday_rules WHERE company_code=?').get(stored.company_code);
          if(fresh?.settings!==stored.settings)continue;
          tasks.access(rule.userId,stored.company_code);
          const event=fridayEvent(result,{slot,minimum:rule.minimum,weekday:rule.weekday});
          if(event)notifications.enqueue({userId:rule.userId,companyCode:stored.company_code,
            eventKey:event.eventKey,title:event.title,body:event.body,url:'/cabinet/people.html'});
        }catch{}
      }
      if(!stopping)await notifications.runOnce();
      return {enabled:true};
    })().finally(()=>{active=null;});
    return active;
  }
  return {getRule,saveRule,preview,validateEvent,runOnce,
    start(){if(enabled!==true||timer||stopping)return;timer=setInterval(()=>void runOnce().catch(()=>{}),intervalMs);timer.unref?.();void runOnce().catch(()=>{});},
    async stop(){stopping=true;clearInterval(timer);timer=null;await active;}};
}
function createPeopleTelegramResolver({db,authStore,env=process.env}) {
  return ({userId,companyCode})=>{
    // Тот же бот, чей ID уже задан для Mini App; никаких новых ботов или owner fallback.
    if(!(env.PEOPLE_TELEGRAM_COMPANIES||'').split(',').map(x=>x.trim()).includes(companyCode))return null;
    const botToken=env.TELEGRAM_BOT_TOKEN||'',botId=env.TELEGRAM_BOT_ID||'';
    if(!botId||botToken.split(':')[0]!==botId)return null;
    const user=authStore.getById(userId);
    if(!user||!user.companyCodes.includes(companyCode))return null;
    const member=db.prepare('SELECT 1 FROM project_chat_members WHERE user_id=? AND company_code=?').get(userId,companyCode);
    const links=db.prepare('SELECT telegram_user_id FROM project_chat_telegram_links WHERE user_id=?').all(userId);
    if(!member||links.length!==1)return null;
    return {userId,companyCode,chatId:links[0].telegram_user_id,botToken};
  };
}
module.exports={createPeopleRuntime,createPeopleTelegramResolver,rollingWeekStart};
