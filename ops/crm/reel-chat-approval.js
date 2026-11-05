'use strict';
/* Согласование рилса в общем чате компании (№166). Новой системы согласования, задач и публикации нет:
   - отправка привязывает ролик к публикации автопостинга (черновик ролика с тем же файлом или существующий
     createPublication), подпись/площадки меняет autoposting.update, «на согласование» — submitReview;
   - «Согласовано» = autoposting.approve (версия содержимого и площадки), «кто и когда» берутся из согласования публикации;
   - «Нужны правки» = materials.requestEdit (задача монтажа на общей доске);
   - публикует только существующий автопостинг; итоги по площадкам читаются из его доставок и расписок.
   Сообщения в чат пишет content: он забирает updates() служебным ключом (CRM content не вызывает). */
const {company,fail,object,text}=require('./company-information');
const {PLATFORMS}=require('./reel-materials');

const LABELS=Object.freeze({instagram:'Instagram',tiktok:'TikTok',youtube_shorts:'YouTube Shorts',vk:'ВКонтакте',telegram:'Telegram',max:'MAX'});
/* Тексты кодов доставки — те же смыслы, что в «Постинге» (sites/synapse/cabinet/autoposting.js, ERRORS). */
const ERRORS=Object.freeze({PUBLISH_FAILED:'площадка не подтвердила публикацию',PUBLICATION_UNCERTAIN:'площадка могла принять материал — проверьте вручную, повтор может создать дубль',
  PROVIDER_FAILED:'сервис публикации не смог опубликовать материал',PROVIDER_CHECK_FAILED:'не удалось проверить результат у сервиса публикации',
  APPROVAL_REVOKED:'согласование снято — отправка отменена',EXTERNAL_PUBLICATION_RECORDED:'отмечено как опубликованное вне кабинета — отправка не выполнялась',
  CHANNEL_CHANGED:'изменилось подключение канала — отправка остановлена',PROFILE_CHANGED:'изменились данные компании — отправка остановлена',
  TIKTOK_PRIVACY_UNCONFIRMED:'отправка в TikTok остановлена: режим доступа профиля не подтверждается контрактом Onlypult',
  TIKTOK_PRIVACY_REQUIRED:'для TikTok не выбран режим доступа',CONTENT_LIMIT:'материал не прошёл ограничения площадки',
  ACCESS_DENIED:'площадка не приняла ключ доступа',PLATFORM_REJECTED:'площадка отклонила публикацию',CHANNEL_MISCONFIGURED:'канал настроен неверно'});
const IMAGE_PATH=/^\/content\/publishing-assets\/([a-z0-9_-]{1,64})\/[a-f0-9]{32}\.(?:jpg|png|webp)$/;
const DEFAULT_ORIGINS=Object.freeze(['https://synapse.synapsebusiness.ru']);
const iso=()=>new Date().toISOString();
const parse=(value,fallback)=>{try{return JSON.parse(value);}catch{return fallback;}};
const int=(value,min,max,label)=>{if(!Number.isSafeInteger(value)||value<min||value>max)fail(400,`${label}: целое от ${min} до ${max}`);return value;};

function createReelChatApproval(db,{materials,autoposting,mediaOrigins=process.env.PUBLISHING_ASSET_ORIGINS||DEFAULT_ORIGINS,now=()=>Date.now()}={}){
  const origins=(Array.isArray(mediaOrigins)?mediaOrigins:String(mediaOrigins).split(',')).map(v=>String(v).trim()).filter(Boolean).map(v=>new URL(v).origin);
  db.exec(`CREATE TABLE IF NOT EXISTS reel_chat_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL REFERENCES companies(id),
      reel_id INTEGER NOT NULL REFERENCES reel_materials(id), version INTEGER NOT NULL, post_id INTEGER NOT NULL,
      content_revision INTEGER NOT NULL, platform_ids TEXT NOT NULL, title TEXT NOT NULL, caption TEXT NOT NULL DEFAULT '',
      media_url TEXT NOT NULL, duration_ms INTEGER, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','changes_requested','superseded')),
      requested_by_id INTEGER NOT NULL, requested_by_name TEXT NOT NULL DEFAULT '', requested_at TEXT NOT NULL,
      edit_id INTEGER, edit_task_id INTEGER, edit_comment TEXT NOT NULL DEFAULT '', edit_by_name TEXT, edit_at TEXT, screenshot_url TEXT,
      client_request_id TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT, UNIQUE(company_id,client_request_id));
    CREATE INDEX IF NOT EXISTS reel_chat_approvals_open ON reel_chat_approvals(closed_at,company_id,id);`);
  const rowFor=(owner,reelId,id)=>{const row=Number.isSafeInteger(id)&&db.prepare('SELECT * FROM reel_chat_approvals WHERE id=? AND company_id=? AND reel_id=?').get(id,owner.id,reelId);
    if(!row)fail(404,'Запрос согласования не найден','NOT_FOUND');return row;};
  const platformList=value=>{
    if(!Array.isArray(value)||!value.length||value.length>PLATFORMS.length||value.some(id=>!PLATFORMS.includes(id))||new Set(value).size!==value.length)
      fail(400,'Отметьте площадки: '+PLATFORMS.join(', '));
    return PLATFORMS.filter(id=>value.includes(id));
  };
  const postOf=(code,id)=>{try{return autoposting.get(id,code);}catch(error){if([404,409].includes(error.status))return null;throw error;}};
  const caption=post=>String(post?.text||'').trim()||Object.values(post?.captions||{}).find(v=>String(v).trim())||'';
  const same=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
  /* Решение относится к тексту, файлу и площадкам на момент отправки. Площадки не входят в content_revision
     автопостинга, поэтому убранная из публикации площадка запроса проверяется отдельно. */
  const changed=(post,row)=>post.contentRevision!==row.content_revision||post.mediaUrls[0]!==row.media_url
    ||!parse(row.platform_ids,[]).every(p=>post.platformIds.includes(p));

  /* Отправка в чат. Порядок: проверить вход до создания черновика → найти/создать публикацию версии →
     подпись и площадки → «на согласование» → запрос. Функции автопостинга транзакционны сами по себе. */
  function send(code,reelId,body,actor){
    const owner=company(db,code);object(body,['clientRequestId','version','platformIds','text']);
    const clientRequestId=text(body.clientRequestId??'',80,true);
    const repeat=db.prepare('SELECT * FROM reel_chat_approvals WHERE company_id=? AND client_request_id=?').get(owner.id,clientRequestId);
    if(repeat){if(repeat.reel_id!==reelId)fail(409,'Ключ запроса уже использован');return {approval:view(owner,repeat),duplicate:true};}
    const reel=materials.get(owner.code,reelId);
    const version=(reel.versions||[]).find(v=>v.version===body.version);if(!version)fail(400,'Версия ролика не найдена');
    const platformIds=platformList(body.platformIds);
    const wanted=body.text===undefined?'':text(body.text,20000);
    /* Черновик этого ролика с тем же единственным файлом — переиспользуется: прежний запрос этой версии или связанная публикация. */
    const candidates=[...new Set([...db.prepare("SELECT post_id FROM reel_chat_approvals WHERE company_id=? AND reel_id=? AND version=? ORDER BY id DESC LIMIT 5").all(owner.id,reelId,version.version).map(r=>r.post_id),reel.postId].filter(Boolean))];
    let post=candidates.map(id=>postOf(owner.code,id)).find(p=>p&&p.status==='draft'&&p.mediaUrls.length===1&&p.mediaUrls[0]===version.mediaUrl)||null;
    if(!wanted&&!caption(post))fail(400,'Добавьте подпись к публикации: без неё площадки не примут рилс','CAPTION_REQUIRED');
    if(!post)post=autoposting.get(materials.createPublication(owner.code,reelId,{version:version.version,platformIds},actor).post.id,owner.code);
    const patch={};
    if(wanted&&wanted!==String(post.text||'').trim())patch.text=wanted;
    if(!same([...post.platformIds].sort(),[...platformIds].sort()))patch.platformIds=platformIds;
    if(Object.keys(patch).length)post=autoposting.update(post.id,owner.code,{revision:post.revision,...patch},actor);
    if(!post.approval?.approved&&post.review?.state!=='pending'){
      try{post=autoposting.submitReview(post.id,owner.code,{revision:post.revision},actor);}
      catch(error){if(error.details?.code!=='POST_STATE')throw error;}
    }
    const at=iso();
    /* Заменяются только неотвеченные карточки ролика; согласованная остаётся свидетельством своего решения. */
    const replaced=db.prepare("SELECT * FROM reel_chat_approvals WHERE company_id=? AND reel_id=? AND state='pending' AND closed_at IS NULL").all(owner.id,reelId)
      .filter(item=>view(owner,item).open).map(item=>item.id);
    db.exec('BEGIN IMMEDIATE');
    try{
      for(const id of replaced)db.prepare("UPDATE reel_chat_approvals SET state='superseded',updated_at=?,closed_at=COALESCE(closed_at,?) WHERE id=? AND state='pending'").run(at,at,id);
      const id=Number(db.prepare(`INSERT INTO reel_chat_approvals(company_id,reel_id,version,post_id,content_revision,platform_ids,title,caption,media_url,duration_ms,
        requested_by_id,requested_by_name,requested_at,client_request_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(owner.id,reelId,version.version,post.id,post.contentRevision,JSON.stringify(platformIds),reel.title,caption(post),version.mediaUrl,version.durationMs??null,
          Number(actor.userId),String(actor.userName||''),at,clientRequestId,at).lastInsertRowid);
      db.exec('COMMIT');
      return {approval:view(owner,db.prepare('SELECT * FROM reel_chat_approvals WHERE id=?').get(id)),duplicate:false};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  /* Открытый запрос и текущая публикация той же версии содержимого — иначе решение относилось бы к другому тексту/файлу. */
  function openFor(owner,reelId,id){
    const row=rowFor(owner,reelId,id);
    if(row.state==='superseded')fail(409,'Рилс уже отправлен на согласование заново — решайте по новой карточке','APPROVAL_SUPERSEDED');
    const post=postOf(owner.code,row.post_id);
    if(!post||changed(post,row))
      fail(409,'Публикация изменилась после отправки в чат — отправьте рилс на согласование заново','APPROVAL_STALE');
    return {row,post};
  }
  function approve(code,reelId,id,actor){
    const owner=company(db,code),{row,post}=openFor(owner,reelId,id);
    if(row.state==='changes_requested')fail(409,'По этой карточке уже попросили правки','APPROVAL_CLOSED');
    const ids=parse(row.platform_ids,[]);
    const already=ids.length&&ids.every(p=>post.platformApprovals.find(item=>item.platformId===p)?.approved);
    if(!already&&!post.approval?.approved)autoposting.approve(post.id,owner.code,{revision:post.revision,approved:true,platformIds:ids},actor);
    db.prepare('UPDATE reel_chat_approvals SET updated_at=? WHERE id=?').run(iso(),row.id);
    return {approval:view(owner,rowFor(owner,reelId,id))};
  }
  /* Скриншот — изображение из хранилища публикаций этой же компании и разрешённого origin. */
  function screenshot(value,owner){
    if(value===undefined||value===null||value==='')return null;
    let url;try{url=new URL(String(value));}catch{fail(400,'Скриншот: нужна ссылка на изображение из хранилища');}
    const match=IMAGE_PATH.exec(url.pathname);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!match||!origins.includes(url.origin))fail(400,'Скриншот должен быть загружен в хранилище публикаций Synapse','MEDIA_HOST');
    if(match[1]!==owner.code.toLowerCase())fail(403,'Скриншот принадлежит другой компании','FORBIDDEN');
    return url.href;
  }
  function changes(code,reelId,id,body,actor){
    const owner=company(db,code);object(body,['comment','startMs','endMs','durationMs','screenshotUrl']);
    const comment=text(body.comment??'',1800,true),shot=screenshot(body.screenshotUrl,owner);
    const row=rowFor(owner,reelId,id);
    if(row.state==='changes_requested'&&row.edit_id)return {approval:view(owner,row),duplicate:true};
    const {post}=openFor(owner,reelId,id);
    if(post.approval?.approved)fail(409,'Эта версия уже согласована: чтобы вернуть на правки, снимите согласование в «Постинге»','APPROVAL_CLOSED');
    const duration=row.duration_ms??(body.durationMs===undefined?null:int(body.durationMs,100,10*60*1000,'Длительность'));
    const startMs=body.startMs===undefined?0:int(body.startMs,0,duration??10*60*1000,'Начало отрезка');
    const endMs=body.endMs===undefined?duration:int(body.endMs,1,duration??10*60*1000,'Конец отрезка');
    if(endMs===null)fail(400,'Не удалось определить длительность ролика: отметьте момент в плеере');
    const result=materials.requestEdit(owner.code,reelId,{clientRequestId:`chat-approval:${row.id}`,baseVersion:row.version,kind:'request',
      comment:shot?`${comment}\nСкрин: ${shot}`:comment,startMs,endMs},actor);
    const at=iso();
    db.prepare(`UPDATE reel_chat_approvals SET state='changes_requested',edit_id=?,edit_task_id=?,edit_comment=?,edit_by_name=?,edit_at=?,screenshot_url=?,updated_at=?,closed_at=? WHERE id=?`)
      .run(result.edit.id,result.edit.taskId??null,comment,String(actor.userName||''),at,shot,at,at,row.id);
    return {approval:view(owner,rowFor(owner,reelId,id)),duplicate:result.duplicate};
  }

  /* Итог по площадке — только из записей автопостинга. Ссылка — url доставки (прямые Telegram/ВК) или
     подтверждённая владельцем расписка; Onlypult ссылку не отдаёт (контракт Post без url) → ID задания. */
  function outcome(post,platformId){
    const delivery=(post.deliveries||[]).find(d=>d.channelId===platformId);
    const receipt=(post.externalReceipts||[]).find(r=>r.platform===platformId&&!r.stale);
    const base={platformId,label:LABELS[platformId]||platformId};
    if(receipt)return {...base,state:'published',url:receipt.url,source:'receipt',externalId:null,providerPostId:null,error:null,at:receipt.publishedAt};
    if(!delivery)return {...base,state:'none',url:null,source:null,externalId:null,providerPostId:null,error:null,at:null};
    const common={url:null,externalId:delivery.externalId||null,providerPostId:delivery.providerPostId||null,at:delivery.finishedAt||delivery.providerCheckedAt||null};
    if(delivery.status==='published')return {...base,...common,state:'published',url:delivery.url||null,source:'direct',error:null};
    if(delivery.providerPostId){
      if(delivery.providerStatus==='published')return {...base,...common,state:'published',source:'onlypult',error:null};
      if(delivery.providerStatus==='failed')return {...base,...common,state:'failed',source:'onlypult',error:ERRORS.PROVIDER_FAILED};
      return {...base,...common,state:'pending',source:'onlypult',error:null};
    }
    if(delivery.status==='failed')return {...base,...common,state:'failed',source:'direct',error:ERRORS[delivery.errorCode]||`ошибка ${delivery.errorCode||'без кода'}`};
    if(delivery.status==='needs_review')return {...base,...common,state:'uncertain',source:'direct',error:ERRORS[delivery.errorCode]||ERRORS.PUBLICATION_UNCERTAIN};
    if(delivery.status==='cancelled')return {...base,...common,state:'cancelled',source:'direct',error:ERRORS[delivery.errorCode]||'отправка отменена'};
    return {...base,...common,state:'pending',source:'direct',error:null};
  }
  const TERMINAL=new Set(['published','failed','uncertain','cancelled']);
  const LABEL={pending:'Ждёт согласования',approved:'Согласовано — ждёт публикации',scheduled:'Согласовано — публикация в плане',publishing:'Публикуется',
    published:'Опубликовано',partial:'Публикация завершена частично',changes_requested:'Нужны правки',returned:'Возвращено на доработку',
    superseded:'Заменено новой отправкой',stale:'Публикация изменилась — отправьте заново',unavailable:'Публикация недоступна'};
  /* Статус карточки вычисляется из публикации: согласование, сделанное в «Постинге», видно так же. */
  function view(owner,row){
    const post=postOf(owner.code,row.post_id),platformIds=parse(row.platform_ids,[]);
    let status,approvedBy=null,approvedAt=null,items=[];
    const reviews=post?platformIds.map(p=>post.platformApprovals.find(item=>item.platformId===p)).filter(Boolean):[];
    const approved=Boolean(post)&&post.contentRevision===row.content_revision&&(post.approval?.approved||(reviews.length===platformIds.length&&reviews.every(r=>r.approved)));
    if(approved){const by=reviews.find(r=>r.approved&&r.byName);approvedBy=post.approval?.approvedByName||by?.byName||null;approvedAt=post.approval?.approvedAt||by?.at||null;}
    if(post)items=platformIds.filter(p=>post.platformIds.includes(p)).map(p=>outcome(post,p));
    const started=items.some(i=>i.state!=='none');
    if(row.state==='superseded')status='superseded';
    else if(row.state==='changes_requested')status='changes_requested';
    else if(!post)status='unavailable';
    else if(started&&items.every(i=>TERMINAL.has(i.state)||i.state==='none'))status=items.every(i=>i.state==='published')?'published':'partial';
    else if(started||post.status==='publishing')status='publishing';
    else if(changed(post,row))status='stale';
    else if(approved)status=post.status==='scheduled'?'scheduled':'approved';
    else if(post.review?.state==='rejected')status='returned';
    else status='pending';
    const final=['superseded','changes_requested','stale','unavailable','published','partial'].includes(status);
    if(final&&!row.closed_at)db.prepare('UPDATE reel_chat_approvals SET closed_at=? WHERE id=? AND closed_at IS NULL').run(iso(),row.id);
    return {id:row.id,companyCode:owner.code.toLowerCase(),reelId:row.reel_id,version:row.version,postId:row.post_id,contentRevision:row.content_revision,
      title:row.title,caption:row.caption,mediaUrl:row.media_url,durationMs:row.duration_ms,platforms:platformIds.map(p=>({id:p,label:LABELS[p]||p})),
      requestedBy:{id:row.requested_by_id,name:row.requested_by_name},requestedAt:row.requested_at,
      status,statusLabel:LABEL[status],
      open:status==='pending'||status==='returned',scheduledAt:post?.scheduledAt||null,
      approvedBy,approvedAt,returned:status==='returned'?{byName:post.review.byName,at:post.review.at,comment:post.review.comment}:null,
      edit:row.edit_id?{id:row.edit_id,taskId:row.edit_task_id,comment:row.edit_comment,byName:row.edit_by_name,at:row.edit_at,screenshotUrl:row.screenshot_url}:null,
      publication:{items,done:final&&started}};
  }
  function get(code,reelId,id){const owner=company(db,code);return {approval:view(owner,rowFor(owner,reelId,id))};}
  /* Служебно для content: открытые запросы и закрытые за последние сутки — с текущим статусом. */
  function updates(code){
    const owner=code?company(db,code):null,since=new Date(now()-864e5).toISOString();
    const rows=db.prepare(`SELECT a.*,c.code company_code FROM reel_chat_approvals a JOIN companies c ON c.id=a.company_id
      WHERE c.is_deleted=0 AND (a.closed_at IS NULL OR a.closed_at>=?) ${owner?'AND a.company_id=?':''} ORDER BY a.id DESC LIMIT 200`).all(since,...(owner?[owner.id]:[]));
    return {approvals:rows.map(row=>view({id:row.company_id,code:row.company_code},row)).reverse()};
  }
  return {send,approve,changes,get,updates};
}
module.exports={createReelChatApproval,PLATFORM_LABELS:LABELS};
