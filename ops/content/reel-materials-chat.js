'use strict';
/* Лог правок «Материалов» → личный чат пользователя с Хью (комната hugh:<id> рабочего чата, PR 504),
   который открывает плавающая панель hugh-chat. CRM сам не вызывает content, поэтому content забирает
   записи автора из CRM (GET /internal/reel-materials/hugh-log, ключ сервиса) после запроса браузера
   к «Материалам» и перед чтением комнаты hugh:<id>. Записи идемпотентны (client_id = ключ записи).
   Без комнат чата (PR 504 ещё не выпущен) ничего не пишется и ничего не падает: лог остаётся в карточке ролика. */
const CODE=/^[a-z0-9][a-z0-9_-]{0,63}$/i;
const KEY=/^reel-edit:[1-9]\d{0,15}:(?:request|done|cancelled)$/;
function createReelHughLog({db,crmUrl,crmKey,fetchImpl=globalThis.fetch,timeoutMs=1500,minIntervalMs=15000,now=()=>Date.now(),warn=console.warn}) {
  const last=new Map(),running=new Map();
  function rooms() {
    try {
      const columns=new Set(db.prepare('PRAGMA table_info(team_chat_messages)').all().map(column=>column.name));
      return ['room','kind','audience_id'].every(name=>columns.has(name));
    } catch { return false; }
  }
  function sync(code,user,{force=false}={}) {
    if(typeof code!=='string'||!CODE.test(code)||!Number.isSafeInteger(user?.id)||user.id<1)return Promise.resolve({written:0,skipped:'BAD_INPUT'});
    if(!rooms())return Promise.resolve({written:0,skipped:'NO_ROOMS'});
    if(!crmUrl||!crmKey)return Promise.resolve({written:0,skipped:'NO_CRM'});
    const key=`${code}:${user.id}`;
    if(running.has(key))return running.get(key);
    if(!force&&last.has(key)&&now()-last.get(key)<minIntervalMs)return Promise.resolve({written:0,skipped:'RECENT'});
    last.set(key,now());
    const job=(async()=>{
      const response=await fetchImpl(`${crmUrl}/internal/reel-materials/hugh-log?companyCode=${encodeURIComponent(code)}&authorId=${user.id}`,
        {headers:{'x-api-key':crmKey},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
      if(!response.ok)throw Object.assign(Error('CRM: лог правок недоступен'),{status:response.status});
      const body=await response.json();
      if(body?.authorId!==user.id||String(body.companyCode).toLowerCase()!==code.toLowerCase()||!Array.isArray(body.entries))throw Error('CRM: неверный ответ лога правок');
      const insert=db.prepare(`INSERT OR IGNORE INTO team_chat_messages(company_code,user_id,author_name,text,client_id,created_at,room,kind,audience_id)
        VALUES(?,?,?,?,?,?,?,?,?)`);
      let written=0;
      for(const entry of body.entries) {
        if(!entry||typeof entry.key!=='string'||!KEY.test(entry.key)||typeof entry.text!=='string'||!entry.text.trim())continue;
        const mine=entry.from==='user',at=typeof entry.at==='string'&&!Number.isNaN(Date.parse(entry.at))?entry.at:new Date(now()).toISOString();
        written+=Number(insert.run(code,mine?user.id:0,mine?String(user.displayName||user.login||'Я').slice(0,120):'Хью · ИИ',entry.text.slice(0,4000),
          entry.key,at,`hugh:${user.id}`,mine?'reel-edit':'reel-edit-result',user.id).changes);
      }
      return {written};
    })();
    running.set(key,job);
    job.finally(()=>running.delete(key)).catch(()=>{});
    return job;
  }
  const quiet=promise=>promise.catch(error=>{warn('content: лог правок «Материалов» не перенесён в чат с Хью; повтор при следующем обращении',error?.status||'');return {written:0,skipped:'ERROR'};});
  /* После ответа CRM на /autoposting/reels…: запрос правки переносится сразу, чтения — не чаще minIntervalMs. */
  function afterProxy(crmPath,method,status,code,identity) {
    if(!/^\/autoposting\/reels(?:\/|$)/.test(crmPath)||status<200||status>=300)return Promise.resolve(null);
    return quiet(sync(code,identity,{force:method!=='GET'}));
  }
  /* Перед чтением своей комнаты hugh:<id>: подтягивает «Исправлено: готова vN» от агента монтажа. Никогда не бросает. */
  async function beforePeople(request,url,requireSession) {
    if(request.method!=='GET'||url.pathname!=='/content/people/team-chat')return null;
    const room=/^hugh:([1-9]\d{0,15})$/.exec(url.searchParams.get('room')||''),code=url.searchParams.get('companyCode');
    if(!room)return null;
    let session;try{session=requireSession(request);}catch{return null;}
    if(session.user.id!==Number(room[1])||!session.user.companyCodes?.includes(code))return null;
    return quiet(sync(code,session.user));
  }
  return {sync,afterProxy,beforePeople,rooms};
}
module.exports={createReelHughLog};
