'use strict';
// Только кабинет: постоянный feed CRM -> уже существующий личный Hugh. Внешних отправок нет.
const KEY=/^(?:reel-edit:[1-9]\d*:(?:in_progress|done|cancelled)|reel-request:[1-9]\d*:reply:[1-9]\d*)$/;
const CODE=/^[a-z0-9][a-z0-9_-]{0,63}$/;
function createMontageNotifications({db,authStore,crmUrl,crmKey,enabled=false,fetchImpl=globalThis.fetch,intervalMs=30000,
  warn=()=>{}}){
  const active=enabled===true;
  let timer=null,running=null,stopped=false;
  if(active)db.exec('CREATE TABLE IF NOT EXISTS montage_notification_cursor(id INTEGER PRIMARY KEY CHECK(id=1),after_id INTEGER NOT NULL)');
  function allowed(userId,code){
    const user=authStore.getById(userId);
    return !!user&&!user.mustChangePassword&&['owner','editor'].includes(user.role)&&user.companyCodes?.includes(code)&&
      (user.role==='owner'||user.permissions?.some(p=>['autoposting.view','autoposting.edit'].includes(p)));
  }
  async function run(){
    if(!active||stopped||!crmUrl||!crmKey)return {written:0};
    const cols=new Set(db.prepare('PRAGMA table_info(team_chat_messages)').all().map(c=>c.name));
    if(!['room','kind','audience_id'].every(c=>cols.has(c)))return {written:0};
    const after=db.prepare('SELECT after_id FROM montage_notification_cursor WHERE id=1').get()?.after_id||0;
    const response=await fetchImpl(`${crmUrl}/internal/reel-materials/notifications?after=${after}&limit=100`,{
      headers:{'x-api-key':crmKey},redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw Error('FEED_UNAVAILABLE');
    const raw=await response.text();if(raw.length>1048576)throw Error('FEED_TOO_LARGE');
    const body=JSON.parse(raw);
    if(body.enabled===false)return {written:0};
    if(body.enabled!==true||!Array.isArray(body.events)||body.events.length>100)throw Error('BAD_FEED');
    let previous=after;
    for(const e of body.events){
      if(!Number.isSafeInteger(e.id)||e.id<=previous||!KEY.test(e.eventKey)||!CODE.test(e.companyCode)||
        !['string','number'].includes(typeof e.authorId)||String(e.authorId).length>200||!Number.isSafeInteger(e.reelId)||e.reelId<1||
        typeof e.title!=='string'||e.title.length>1000||typeof e.text!=='string'||!e.text.trim()||e.text.length>4000||
        !Number.isFinite(Date.parse(e.createdAt)))throw Error('BAD_FEED');
      previous=e.id;
    }
    if(body.nextAfter!==previous)throw Error('BAD_CURSOR');
    let written=0;
    db.exec('BEGIN IMMEDIATE');
    try{
      const insert=db.prepare(`INSERT OR IGNORE INTO team_chat_messages
        (company_code,user_id,author_name,text,client_id,created_at,room,kind,audience_id) VALUES(?,0,'Хью · ИИ',?,?,?,?,?,?)`);
      for(const e of body.events){
        const userId=Number(e.authorId);if(!Number.isSafeInteger(userId)||userId<1||String(userId)!==String(e.authorId)||!allowed(userId,e.companyCode))continue;
        const link=`/cabinet.html#content/materials/reel/${e.reelId}?company=${encodeURIComponent(e.companyCode)}`;
        written+=Number(insert.run(e.companyCode,`«${e.title}» — ${e.text}`.slice(0,3800)+`\n${link}`,e.eventKey,e.createdAt,
          `hugh:${userId}`,'reel-edit-result',userId).changes);
      }
      db.prepare('INSERT INTO montage_notification_cursor VALUES(1,?) ON CONFLICT(id) DO UPDATE SET after_id=excluded.after_id').run(previous);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    return {written};
  }
  function tick(){
    if(running)return running;
    running=run().catch(()=>{warn('MONTAGE_NOTIFICATIONS_UNAVAILABLE');return {written:0,error:true};}).finally(()=>{running=null;});
    return running;
  }
  function start(){if(!active||timer||stopped)return;void tick();timer=setInterval(()=>void tick(),intervalMs);timer.unref();}
  async function stop(){stopped=true;clearInterval(timer);timer=null;if(running)await running;}
  return {tick,start,stop,enabled:active};
}
module.exports={createMontageNotifications};
