'use strict';
/* Снятие опубликованного материала с площадок (spec 182). Действие выполняет человек с правом
   autoposting.edit по своей компании; фоновых удалений нет. Карточка из БД не стирается:
   доставки и расписки остаются доказательством, а снятие хранится отдельным журналом.
   Автоматически: Onlypult DELETE /posts/{id} — только черновик или запланированный пост
   (контракт onlypult.com/dev/openapi.yaml: «Delete a draft or scheduled post»), и Telegram
   deleteMessage прямым ботом (Bot API: не старше 48 часов, бот с can_post_messages удаляет свои
   сообщения в канале). Всё остальное — «удалить вручную» со ссылкой на публикацию. */
const fail=(status,message,code)=>{throw Object.assign(Error(message),{status,code});};
const TELEGRAM_WINDOW_MS=48*3600*1000;
const LABELS={telegram:'Telegram',vk:'ВКонтакте',youtube_shorts:'YouTube Shorts',instagram:'Instagram',tiktok:'TikTok',max:'MAX',two_gis:'2ГИС',yandex_maps:'Яндекс Карты'};
const label=id=>LABELS[id]||id;
const OUTCOMES=new Set(['removed','manual','failed','uncertain','manual_done']);

function createAutopostingUnpublish(db,{transport,now=Date.now}={}) {
  if(!transport)throw Error('Unpublish requires publication adapters');
  db.exec(`CREATE TABLE IF NOT EXISTS autoposting_unpublish_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,post_id INTEGER NOT NULL REFERENCES autoposting_posts(id),company_id INTEGER NOT NULL,
    target_key TEXT NOT NULL,platform TEXT NOT NULL,outcome TEXT NOT NULL,url TEXT,error_code TEXT,
    actor_id INTEGER,actor_name TEXT,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS autoposting_unpublish_events_post_idx ON autoposting_unpublish_events(post_id,id);
    CREATE TABLE IF NOT EXISTS autoposting_unpublish_locks (post_id INTEGER PRIMARY KEY,started_at TEXT NOT NULL);`);
  const iso=()=>new Date(now()).toISOString();
  function postFor(id,companyId) {
    if(!/^\d{1,12}$/.test(String(id)))fail(404,'Материал не найден','NOT_FOUND');
    const row=db.prepare('SELECT * FROM autoposting_posts WHERE id=? AND company_id=?').get(Number(id),companyId);
    if(!row)fail(404,'Материал не найден','NOT_FOUND');
    return row;
  }
  const mediaCount=row=>{try{const list=JSON.parse(row.media_urls||'[]');return Array.isArray(list)?list.length:0;}catch{return 0;}};
  const lastOutcome=postId=>{
    const map=new Map();
    for(const event of db.prepare('SELECT target_key,outcome FROM autoposting_unpublish_events WHERE post_id=? ORDER BY id').all(postId))map.set(event.target_key,event.outcome);
    return map;
  };
  /* Что и как можно снять. mode: auto — выполнит сервер; manual — человек удаляет сам по ссылке. */
  function targetsOf(row) {
    const targets=[];
    for(const d of db.prepare('SELECT * FROM autoposting_deliveries WHERE post_id=? ORDER BY channel_id').all(row.id)){
      const platform=d.channel_id,link=d.url||null;
      if(d.provider_post_id){
        const base={key:`provider:${platform}:${d.provider_post_id}`,platform,label:label(platform),url:link,channelId:platform,
          channelRevision:d.channel_revision,providerPostId:d.provider_post_id};
        if(d.provider_status==='failed'){continue;}
        if(['draft','scheduled'].includes(d.provider_status))targets.push({...base,mode:'auto',action:'provider_delete',
          note:'Отменим задание в Onlypult: пост ещё не вышел на площадку.'});
        else targets.push({...base,mode:'manual',action:'manual',note:'Onlypult не удаляет уже опубликованное: удалите пост на площадке вручную.'});
        continue;
      }
      if(d.status==='published'&&platform==='telegram'&&d.external_id){
        const base={key:`direct:telegram:${d.external_id}`,platform,label:label(platform),url:link,channelId:platform,
          channelRevision:d.channel_revision,externalId:d.external_id};
        const age=now()-Date.parse(d.finished_at||'');
        if(mediaCount(row)>1)targets.push({...base,mode:'manual',action:'manual',note:'Альбом из нескольких сообщений: удалите его в канале вручную.'});
        else if(!(age>=0&&age<TELEGRAM_WINDOW_MS))targets.push({...base,mode:'manual',action:'manual',note:'Telegram позволяет боту удалять сообщение только в течение 48 часов: удалите вручную.'});
        else targets.push({...base,mode:'auto',action:'telegram_delete',note:'Удалим сообщение ботом канала.'});
        continue;
      }
      if(d.status==='published'||d.status==='needs_review')targets.push({key:`delivery:${platform}`,platform,label:label(platform),url:link,mode:'manual',action:'manual',
        note:d.status==='published'?'Автоматическое удаление для этой площадки не подключено: удалите вручную.':'Результат отправки не подтверждён: проверьте площадку и удалите вручную, если пост вышел.'});
    }
    for(const r of db.prepare('SELECT id,platform,url FROM autoposting_publication_receipts WHERE post_id=? ORDER BY id').all(row.id))
      targets.push({key:`receipt:${r.id}`,platform:r.platform,label:label(r.platform),url:r.url,mode:'manual',action:'manual',
        note:'Публикация отмечена вручную: удалите её на площадке сами.'});
    return targets;
  }
  const publicTarget=(t,outcomes)=>({key:t.key,platform:t.platform,label:t.label,url:t.url,mode:t.mode,note:t.note,outcome:outcomes.get(t.key)||null});
  function stateOf(targets,outcomes) {
    if(!outcomes.size)return 'published';
    const open=targets.filter(t=>!['removed','manual_done'].includes(outcomes.get(t.key)));
    return open.length?'manual_pending':'removed';
  }
  function preview(id,company) {
    const row=postFor(id,company.id),targets=targetsOf(row),outcomes=lastOutcome(row.id);
    return {postId:row.id,revision:row.revision,state:stateOf(targets,outcomes),running:Boolean(db.prepare('SELECT 1 FROM autoposting_unpublish_locks WHERE post_id=?').get(row.id)),
      targets:targets.map(t=>publicTarget(t,outcomes)),
      history:db.prepare(`SELECT target_key targetKey,platform,outcome,url,error_code errorCode,actor_name actorName,created_at createdAt
        FROM autoposting_unpublish_events WHERE post_id=? ORDER BY id DESC LIMIT 50`).all(row.id).map(e=>({...e,label:label(e.platform)}))};
  }
  const record=(row,t,outcome,errorCode,actor)=>{
    if(!OUTCOMES.has(outcome))throw Error('Unknown outcome');
    db.prepare(`INSERT INTO autoposting_unpublish_events(post_id,company_id,target_key,platform,outcome,url,error_code,actor_id,actor_name,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(row.id,row.company_id,t.key,t.platform,outcome,t.url||null,errorCode||null,actor.userId??null,actor.userName??null,iso());
  };
  async function execute(t,companyCode) {
    try{
      if(t.action==='telegram_delete')await transport.removePublished({companyCode,channelId:t.channelId,channelRevision:t.channelRevision,externalId:t.externalId});
      else await transport.removeProviderPost({companyCode,channelId:t.channelId,channelRevision:t.channelRevision,providerPostId:t.providerPostId});
      return {outcome:'removed'};
    }catch(error){
      const code=typeof error?.code==='string'&&/^[A-Z_]{2,40}$/.test(error.code)?error.code:'REMOVE_FAILED';
      return {outcome:error?.ambiguous===false?'failed':'uncertain',errorCode:code};
    }
  }
  /* Выполнение. Список ключей из окна подтверждения обязан совпасть с текущим планом:
     человек подтверждает ровно то, что будет сделано. Уже снятое повторно не трогается. */
  async function unpublish(id,company,body,actor={}) {
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['revision','targets'].includes(k)))fail(400,'Ожидались revision и targets');
    if(!Number.isSafeInteger(body.revision)||!Array.isArray(body.targets)||body.targets.length>50||body.targets.some(k=>typeof k!=='string'))fail(400,'Ожидались revision и targets');
    const row=postFor(id,company.id);
    if(row.revision!==body.revision)fail(409,'Материал уже изменён. Обновите окно','REVISION_CONFLICT');
    if(row.status==='publishing')fail(409,'Материал сейчас отправляется: дождитесь результата','POST_STATE');
    const outcomes=lastOutcome(row.id);
    const pending=targetsOf(row).filter(t=>!['removed','manual_done'].includes(outcomes.get(t.key)));
    if(!pending.length)fail(409,'Снимать нечего: опубликованных мест нет или всё уже снято','NOTHING_TO_UNPUBLISH');
    const expected=pending.map(t=>t.key).sort(),given=[...new Set(body.targets)].sort();
    if(expected.length!==given.length||expected.some((k,i)=>k!==given[i]))fail(409,'Список площадок изменился. Откройте окно заново','PLAN_CHANGED');
    try{db.prepare('INSERT INTO autoposting_unpublish_locks(post_id,started_at) VALUES(?,?)').run(row.id,iso());}
    catch{fail(409,'Снятие уже выполняется','UNPUBLISH_RUNNING');}
    const results=[];
    try{
      for(const t of pending){
        if(t.mode!=='auto'){record(row,t,'manual',null,actor);results.push({key:t.key,label:t.label,outcome:'manual',url:t.url});continue;}
        const r=await execute(t,company.code.toLowerCase());
        record(row,t,r.outcome,r.errorCode,actor);results.push({key:t.key,label:t.label,outcome:r.outcome,errorCode:r.errorCode||null,url:t.url});
      }
    }finally{db.prepare('DELETE FROM autoposting_unpublish_locks WHERE post_id=?').run(row.id);}
    return {...preview(row.id,company),results};
  }
  // Человек удалил пост сам и отмечает это: внешних вызовов нет.
  function confirmManual(id,company,body,actor={}) {
    if(!body||typeof body!=='object'||typeof body.key!=='string'||Object.keys(body).length!==1)fail(400,'Ожидался key');
    const row=postFor(id,company.id),target=targetsOf(row).find(t=>t.key===body.key);
    if(!target)fail(404,'Площадка не найдена','NOT_FOUND');
    const last=lastOutcome(row.id).get(target.key);
    if(!last)fail(409,'Сначала запустите снятие с площадок','UNPUBLISH_NOT_STARTED');
    if(!['removed','manual_done'].includes(last))record(row,target,'manual_done',null,actor);
    return preview(row.id,company);
  }
  function states(company) {
    const rows=db.prepare('SELECT DISTINCT post_id FROM autoposting_unpublish_events WHERE company_id=?').all(company.id);
    const result={};
    for(const {post_id:id}of rows){const row=postFor(id,company.id);result[id]=stateOf(targetsOf(row),lastOutcome(id));}
    return result;
  }
  return {preview,unpublish,confirmManual,states,targetsOf};
}

function createAutopostingUnpublishHandler({unpublish,companyModuleContext,readJson,send}) {
  return async function handle(request,response,url,cors={}) {
    const match=/^\/autoposting\/posts\/(\d{1,12})\/unpublish(\/manual)?$/.exec(url.pathname);
    const statesPath=url.pathname==='/autoposting/unpublish-states';
    if(!match&&!statesPath)return false;
    const code=url.searchParams.get('companyCode'),read=request.method==='GET';
    if(statesPath||(match&&!match[2]&&read)){
      if(!read)fail(405,'Метод не поддерживается');
      const {company}=companyModuleContext(request,code,'autoposting.view');
      const result=statesPath?{companyCode:company.code.toLowerCase(),states:unpublish.states(company)}:unpublish.preview(match[1],company);
      send(response,200,result,{...cors,'cache-control':'no-store'});return true;
    }
    if(request.method!=='POST')fail(405,'Метод не поддерживается');
    // Право правки публикаций своей компании проверяется на сервере, а не только кнопкой.
    const {identity,company}=companyModuleContext(request,code,'autoposting.edit');
    const body=await readJson(request);
    const result=match[2]?unpublish.confirmManual(match[1],company,body,identity):await unpublish.unpublish(match[1],company,body,identity);
    send(response,200,result,{...cors,'cache-control':'no-store'});return true;
  };
}
module.exports={createAutopostingUnpublish,createAutopostingUnpublishHandler,TELEGRAM_WINDOW_MS};
