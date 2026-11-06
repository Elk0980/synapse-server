'use strict';
/* №166: карточка рилса на согласование и итоги публикации в общем чате компании (комната common рабочего чата).
   Источник — CRM (reel-chat-approval.js): content забирает GET /internal/reel-materials/chat-approvals служебным
   ключом (CRM content не вызывает — тот же приём, что reel-materials-chat.js). Решения кнопок карточки идут
   обычным proxy /content/crm/autoposting/reels/:id/chat-approvals/… с сессией, правами и CSRF.
   Карточка — одно сообщение kind='reel-approval' (client_id reel-approval:<id>), статус обновляется в payload.
   Итоги — сообщение kind='reel-published'; reel_chat_notices не даёт сообщить одну площадку с одним итогом дважды.
   Без комнат чата или ключа CRM — пропуск без ошибки. */
const CODE=/^[a-z0-9][a-z0-9_-]{0,63}$/;
const TERMINAL=new Set(['published','failed','uncertain','cancelled']);
const httpsUrl=value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}};
const time=value=>{const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleString('ru-RU',{timeZone:'Asia/Bangkok',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});};

function cardText(a){
  const head=`На согласование: рилс «${a.title}» v${a.version} — ${a.platforms.map(p=>p.label).join(', ')}.`;
  return `${head} Статус: ${a.statusLabel}.${a.approvedBy&&a.status!=='pending'?` Согласовал(а): ${a.approvedBy}${a.approvedAt?' '+time(a.approvedAt):''}.`:''} Посмотреть и согласовать — ЛК → Чаты → Общий чат компании.`;
}
function itemLine(item){
  if(item.state==='published'){
    const url=httpsUrl(item.url);
    if(url)return `${item.label}: ${url}${item.source==='receipt'?' (ссылка подтверждена вручную)':''}`;
    const id=item.source==='onlypult'?`ID задания Onlypult ${item.providerPostId}`:item.externalId?`ID ${item.externalId}`:'ID неизвестен';
    return `${item.label}: опубликовано, ссылка недоступна (${id})`;
  }
  const what=item.state==='uncertain'?'результат не подтверждён':item.state==='cancelled'?'не отправлено':'ошибка публикации';
  return `${item.label}: ${what} — ${item.error||'без подробностей'}`;
}

function createReelChatApprovalSync({db,crmUrl,crmKey,fetchImpl=globalThis.fetch,timeoutMs=3000,minIntervalMs=10000,intervalMs=60000,now=()=>Date.now(),warn=console.warn}){
  const last=new Map(),running=new Map();let timer=null;
  function ready(){
    try{
      const columns=new Set(db.prepare('PRAGMA table_info(team_chat_messages)').all().map(c=>c.name));
      if(!['room','kind','audience_id'].every(name=>columns.has(name)))return false;
      if(!columns.has('payload'))db.exec('ALTER TABLE team_chat_messages ADD COLUMN payload TEXT');
      db.exec(`CREATE TABLE IF NOT EXISTS reel_chat_notices (company_code TEXT NOT NULL, approval_id INTEGER NOT NULL, platform_id TEXT NOT NULL,
        state TEXT NOT NULL, message_id INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(company_code,approval_id,platform_id,state))`);
      return true;
    }catch{return false;}
  }
  /* Одна запись CRM → карточка и, если появились новые итоги, одно сообщение с ними. Всё в одной транзакции. */
  function applyOne(a){
    if(!a||!Number.isSafeInteger(a.id)||a.id<1||typeof a.companyCode!=='string'||!CODE.test(a.companyCode)||!Number.isSafeInteger(a.requestedBy?.id)||a.requestedBy.id<1
      ||!Array.isArray(a.platforms)||!Array.isArray(a.publication?.items))return 0;
    const code=a.companyCode,author=String(a.requestedBy.name||'Synapse').slice(0,120),at=new Date(now()).toISOString();
    const card={v:1,approvalId:a.id,reelId:a.reelId,version:a.version,postId:a.postId,title:a.title,caption:a.caption,mediaUrl:httpsUrl(a.mediaUrl),
      platforms:a.platforms,requestedBy:a.requestedBy,requestedAt:a.requestedAt,status:a.status,statusLabel:a.statusLabel,open:a.open===true,
      scheduledAt:a.scheduledAt||null,approvedBy:a.approvedBy||null,approvedAt:a.approvedAt||null,returned:a.returned||null,edit:a.edit||null,
      publication:{items:a.publication.items,done:a.publication.done===true}};
    const payload=JSON.stringify(card);let written=0;
    db.exec('BEGIN IMMEDIATE');
    try{
      const key=`reel-approval:${a.id}`;
      const existing=db.prepare('SELECT id,kind,payload FROM team_chat_messages WHERE company_code=? AND room=? AND client_id=?').get(code,'common',key);
      if(!existing)written+=Number(db.prepare(`INSERT OR IGNORE INTO team_chat_messages(company_code,user_id,author_name,text,client_id,created_at,room,kind,payload)
        VALUES(?,?,?,?,?,?,'common','reel-approval',?)`).run(code,a.requestedBy.id,author,cardText(a),key,a.requestedAt||at,payload).changes);
      else if(existing.kind!=='reel-approval')warn('content: client_id карточки согласования занят другим сообщением',existing.id);
      else if(existing.payload!==payload)written+=Number(db.prepare("UPDATE team_chat_messages SET payload=?,text=? WHERE id=? AND kind='reel-approval'").run(payload,cardText(a),existing.id).changes);
      const done=new Set(db.prepare('SELECT platform_id||\':\'||state k FROM reel_chat_notices WHERE company_code=? AND approval_id=?').all(code,a.id).map(r=>r.k));
      const fresh=a.publication.items.filter(item=>item&&TERMINAL.has(item.state)&&typeof item.platformId==='string'&&!done.has(`${item.platformId}:${item.state}`));
      if(fresh.length){
        const items=fresh.map(item=>({platformId:item.platformId,label:String(item.label||item.platformId),state:item.state,url:httpsUrl(item.url),source:item.source||null,
          externalId:item.externalId||null,providerPostId:item.providerPostId||null,error:item.error||null}));
        const published=items.filter(i=>i.state==='published').length;
        const head=published===items.length?`Рилс «${a.title}» опубликован:`:published?`Рилс «${a.title}» — итоги публикации:`:`Рилс «${a.title}» — публикация не прошла:`;
        const text=[head,...items.map(itemLine)].join('\n');
        const result=db.prepare(`INSERT OR IGNORE INTO team_chat_messages(company_code,user_id,author_name,text,client_id,created_at,room,kind,payload)
          VALUES(?,?,'Synapse · публикация',?,?,?,'common','reel-published',?)`).run(code,a.requestedBy.id,text,
          `reel-published:${a.id}:${items.map(i=>i.platformId+'='+i.state).join(',')}`,at,JSON.stringify({v:1,approvalId:a.id,title:a.title,items}));
        const message=db.prepare('SELECT id FROM team_chat_messages WHERE company_code=? AND user_id=? AND client_id=?')
          .get(code,a.requestedBy.id,`reel-published:${a.id}:${items.map(i=>i.platformId+'='+i.state).join(',')}`);
        const notice=db.prepare('INSERT OR IGNORE INTO reel_chat_notices(company_code,approval_id,platform_id,state,message_id,created_at) VALUES(?,?,?,?,?,?)');
        for(const item of items)notice.run(code,a.id,item.platformId,item.state,message.id,at);
        written+=Number(result.changes);
      }
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    return written;
  }
  function sync(code,{force=false}={}){
    if(code!==null&&(typeof code!=='string'||!CODE.test(code)))return Promise.resolve({written:0,skipped:'BAD_INPUT'});
    if(!crmUrl||!crmKey)return Promise.resolve({written:0,skipped:'NO_CRM'});
    if(!ready())return Promise.resolve({written:0,skipped:'NO_ROOMS'});
    const key=code||'*';
    if(running.has(key))return running.get(key);
    if(!force&&last.has(key)&&now()-last.get(key)<minIntervalMs)return Promise.resolve({written:0,skipped:'RECENT'});
    last.set(key,now());
    const job=(async()=>{
      const response=await fetchImpl(`${crmUrl}/internal/reel-materials/chat-approvals${code?`?companyCode=${encodeURIComponent(code)}`:''}`,
        {headers:{'x-api-key':crmKey},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
      if(!response.ok)throw Object.assign(Error('CRM: запросы согласования недоступны'),{status:response.status});
      const body=await response.json();
      if(!Array.isArray(body?.approvals))throw Error('CRM: неверный ответ запросов согласования');
      let written=0;
      for(const approval of body.approvals){
        // Ответ по одной компании не пишет в чужой чат.
        if(code&&String(approval?.companyCode).toLowerCase()!==code)continue;
        written+=applyOne(approval);
      }
      return {written};
    })();
    running.set(key,job);job.finally(()=>running.delete(key)).catch(()=>{});
    return job;
  }
  const quiet=promise=>promise.catch(error=>{warn('content: согласование рилсов не перенесено в чат; повтор при следующем обращении',error?.status||error?.message||'');return {written:0,skipped:'ERROR'};});
  /* После записи через proxy: отправка в чат, решение кнопки, действия «Постинга» — сразу. */
  function afterProxy(crmPath,method,status,code){
    if(method==='GET'||status<200||status>=300||typeof code!=='string')return Promise.resolve(null);
    if(!/^\/autoposting\/(?:reels\/\d+\/chat-approvals(?:\/|$)|posts\/\d+(?:\/|$))/.test(crmPath))return Promise.resolve(null);
    return quiet(sync(code.toLowerCase(),{force:true}));
  }
  /* Перед чтением общего чата своей компании (не чаще minIntervalMs). Никогда не бросает. */
  async function beforePeople(request,url,requireSession){
    if(request.method!=='GET'||url.pathname!=='/content/people/team-chat'||(url.searchParams.get('room')||'common')!=='common')return null;
    const code=url.searchParams.get('companyCode');
    let session;try{session=requireSession(request);}catch{return null;}
    if(typeof code!=='string'||!session.user.companyCodes?.includes(code))return null;
    return quiet(sync(code));
  }
  function start(){if(timer||!crmUrl||!crmKey)return;timer=setInterval(()=>{void quiet(sync(null));},intervalMs);timer.unref?.();}
  function stop(){clearInterval(timer);timer=null;}
  return {sync,applyOne,afterProxy,beforePeople,start,stop,ready};
}
module.exports={createReelChatApprovalSync,itemLine};
