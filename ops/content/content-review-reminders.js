'use strict';

// Только напоминание: ни записи в CRM, ни AI jobs, ни вызова публикации.
const COMPANY='palitra-love',TIMEZONE='Europe/Moscow',WINDOW_MINUTES=60;
const TIME=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:TIMEZONE,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
const minute=value=>Number(value.slice(0,2))*60+Number(value.slice(3));
const addDay=date=>new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10);
function localClock(now){
  const parts=formatter.formatToParts(new Date(now)),get=type=>parts.find(item=>item.type===type).value;
  return {date:`${get('year')}-${get('month')}-${get('day')}`,minute:Number(get('hour'))*60+Number(get('minute'))};
}
function configFromEnv(env=process.env){
  return {enabled:env.PALITRA_REVIEW_REMINDERS_ENABLED==='true',evening:env.PALITRA_REVIEW_REMINDER_EVENING||'',morning:env.PALITRA_REVIEW_REMINDER_MORNING||''};
}
function validatedConfig(input={}){
  if(!input||input.enabled!==true)return {enabled:false,reason:'disabled'};
  if(!TIME.test(input.evening||'')||input.morning&&!TIME.test(input.morning))return {enabled:false,reason:'invalid_times'};
  const evening=minute(input.evening),morning=input.morning?minute(input.morning):null;
  // Окна не пересекаются и не переходят через полночь. Позднее включение не догоняет старые дни.
  if(evening>1440-WINDOW_MINUTES||morning!==null&&(morning+WINDOW_MINUTES>evening))return {enabled:false,reason:'invalid_times'};
  return {enabled:true,evening,morning};
}
function slotsAt(now,config){
  if(!config.enabled)return [];
  const clock=localClock(now),slots=[];
  if(clock.minute>=config.evening&&clock.minute<config.evening+WINDOW_MINUTES)
    slots.push({phase:'evening',date:clock.date,targetDate:addDay(clock.date)});
  if(config.morning!==null&&clock.minute>=config.morning&&clock.minute<config.morning+WINDOW_MINUTES)
    slots.push({phase:'morning',date:clock.date,targetDate:clock.date});
  return slots;
}
function cabinetBase(value){
  try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)return null;
    url.pathname=url.pathname.replace(/\/$/,'').replace(/\/cabinet\.html$/,'')+'/cabinet.html';return url.href;
  }catch{return null;}
}
function materialUrl(base,item){
  // Оболочка переносит этот alias в content-factory/materials, сохраняя параметры карточки.
  return base+'#autoposting?'+new URLSearchParams({company:COMPANY,post:String(item.id),revision:String(item.contentRevision)});
}
const plain=value=>String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').slice(0,140);
function batches(base,slot,items){
  const heading=`Материалы на ${slot.targetDate.split('-').reverse().join('.')} · время Москвы\nПосмотрите и согласуйте каждую публикацию в кабинете. Это уведомление не является согласованием и не ставит материалы в очередь.\n`;
  const result=[];let group=[],text=heading;
  for(const item of items){
    const line=`\n№${item.id} · версия ${item.contentRevision} · ${plain(item.title)}\n${item.dateKind==='plan'?'Дата плана; время публикации ещё не задано.':'Время задано; материал ещё требует согласования.'}\n${materialUrl(base,item)}\n`;
    if(text.length+line.length>10000&&group.length){result.push({text,items:group});group=[];text=heading;}
    text+=line;group.push(item);
  }
  if(group.length)result.push({text,items:group});return result;
}
function checkedItems(data,slot,now){
  if(!data||data.companyCode!==COMPANY||data.timezone!==TIMEZONE||data.date!==slot.targetDate||!Array.isArray(data.items))throw Error('INVALID_SUMMARY');
  const ids=new Set();
  return data.items.filter(item=>{
    if(!item||!Number.isSafeInteger(item.id)||item.id<1||ids.has(item.id)||!Number.isSafeInteger(item.contentRevision)||item.contentRevision<1||
      !Number.isSafeInteger(item.revision)||item.revision<1||typeof item.title!=='string'||item.effectiveDate!==slot.targetDate||
      !['plan','schedule'].includes(item.dateKind)||typeof item.approved!=='boolean'||!['draft','needs_review','failed','scheduled','published','cancelled','publishing'].includes(item.status))throw Error('INVALID_SUMMARY');
    ids.add(item.id);
    if(item.scheduledAt!==null&&(!Number.isFinite(Date.parse(item.scheduledAt))||localClock(Date.parse(item.scheduledAt)).date!==slot.targetDate))throw Error('INVALID_SUMMARY');
    if((item.dateKind==='schedule')!==(item.scheduledAt!==null))throw Error('INVALID_SUMMARY');
    return !item.approved&&!['published','cancelled','publishing'].includes(item.status)&&(item.scheduledAt===null||Date.parse(item.scheduledAt)>now);
  });
}

function createContentReviewReminders({db,transaction,insertMessage,crmUrl='',crmApiKey='',cabinetUrl='',
  config=configFromEnv(),fetchImpl=(...args)=>globalThis.fetch(...args),now=()=>Date.now()}){
  const settings=validatedConfig(config),base=cabinetBase(cabinetUrl);
  db.exec(`CREATE TABLE IF NOT EXISTS content_review_reminder_runs (
    company_code TEXT NOT NULL REFERENCES project_chat_rooms(company_code), run_date TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('evening','morning')), target_date TEXT NOT NULL, chat_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','queued','empty','blocked')),
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, completed_at TEXT,
    PRIMARY KEY(company_code,run_date,phase));
    CREATE TABLE IF NOT EXISTS content_review_reminder_items (
    company_code TEXT NOT NULL REFERENCES project_chat_rooms(company_code),post_id INTEGER NOT NULL,
    content_revision INTEGER NOT NULL,publish_date TEXT NOT NULL,message_id INTEGER NOT NULL REFERENCES project_chat_messages(id),
    created_at TEXT NOT NULL,PRIMARY KEY(company_code,post_id,content_revision,publish_date));`);
  const room=()=>db.prepare('SELECT telegram_chat_id FROM project_chat_rooms WHERE company_code=?').get(COMPANY)?.telegram_chat_id||null;
  const key=slot=>[COMPANY,slot.date,slot.phase];
  const getRun=slot=>db.prepare('SELECT * FROM content_review_reminder_runs WHERE company_code=? AND run_date=? AND phase=?').get(...key(slot));
  let busy=false,nextCheck=0,stopped=false,generation=0;
  async function process(){
    if(stopped)return {status:'stopped'};
    if(!settings.enabled)return {status:settings.reason};
    if(!base||!crmUrl||!crmApiKey)return {status:'not_configured'};
    if(busy||now()<nextCheck)return {status:'waiting'};
    busy=true;nextCheck=now()+60000;const startedGeneration=generation;
    try{
      for(const slot of slotsAt(now(),settings)){
        const binding=room();if(!binding)return {status:'no_group'};
        transaction(()=>db.prepare(`INSERT OR IGNORE INTO content_review_reminder_runs
          (company_code,run_date,phase,target_date,chat_id,created_at) VALUES(?,?,?,?,?,?)`)
          .run(...key(slot),slot.targetDate,String(binding),new Date(now()).toISOString()));
        const run=getRun(slot);if(run.status!=='pending')continue;
        if(run.chat_id!==String(binding)){
          db.prepare("UPDATE content_review_reminder_runs SET status='blocked',last_error='GROUP_CHANGED' WHERE company_code=? AND run_date=? AND phase=? AND status='pending'").run(...key(slot));continue;
        }
        db.prepare("UPDATE content_review_reminder_runs SET attempts=attempts+1 WHERE company_code=? AND run_date=? AND phase=? AND status='pending'").run(...key(slot));
        let items;
        try{
          const query=new URLSearchParams({companyCode:COMPANY,date:slot.targetDate});
          const response=await fetchImpl(crmUrl.replace(/\/$/,'')+'/autoposting/review-reminders?'+query,
            {headers:{'x-api-key':crmApiKey,accept:'application/json'},signal:AbortSignal.timeout(5000)});
          if(!response.ok)throw Error('CRM_UNAVAILABLE');
          items=checkedItems(await response.json(),slot,now());
        }catch{
          if(stopped||startedGeneration!==generation)return {status:'stopped'};
          db.prepare("UPDATE content_review_reminder_runs SET last_error='CRM_UNAVAILABLE' WHERE company_code=? AND run_date=? AND phase=? AND status='pending'").run(...key(slot));
          return {status:'unavailable'};
        }
        if(stopped||startedGeneration!==generation)return {status:'stopped'};
        transaction(()=>{
          if(getRun(slot).status!=='pending')return;
          if(String(room()||'')!==run.chat_id){
            db.prepare("UPDATE content_review_reminder_runs SET status='blocked',last_error='GROUP_CHANGED' WHERE company_code=? AND run_date=? AND phase=?").run(...key(slot));return;
          }
          if(!slotsAt(now(),settings).some(active=>active.date===slot.date&&active.phase===slot.phase))return;
          const unseen=items.filter(item=>!db.prepare(`SELECT 1 FROM content_review_reminder_items
            WHERE company_code=? AND post_id=? AND content_revision=? AND publish_date=?`).get(COMPANY,item.id,item.contentRevision,slot.targetDate));
          const stamp=new Date(now()).toISOString();
          for(const [index,batch] of batches(base,slot,unseen).entries()){
            const message=insertMessage({code:COMPANY,authorId:'hugh',authorName:'Хью',authorType:'assistant',skipAi:true,
              text:batch.text,clientId:`content-review:${slot.date}:${slot.phase}:${index}`});
            for(const item of batch.items)db.prepare(`INSERT INTO content_review_reminder_items
              (company_code,post_id,content_revision,publish_date,message_id,created_at) VALUES(?,?,?,?,?,?)`)
              .run(COMPANY,item.id,item.contentRevision,slot.targetDate,message.id,stamp);
          }
          db.prepare('UPDATE content_review_reminder_runs SET status=?,completed_at=?,last_error=NULL WHERE company_code=? AND run_date=? AND phase=?')
            .run(unseen.length?'queued':'empty',stamp,...key(slot));
        });
      }
      return {status:'checked'};
    }finally{busy=false;}
  }
  return {process,start(){stopped=false;},stop(){stopped=true;generation++;},configuration:{...settings,timezone:TIMEZONE,windowMinutes:WINDOW_MINUTES}};
}
module.exports={createContentReviewReminders,configFromEnv,validatedConfig,slotsAt,materialUrl};
