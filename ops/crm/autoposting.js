'use strict';

const {company,fail,object,text,timezone,utcDate,revision,url}=require('./company-information');
const {randomUUID}=require('node:crypto');
const LEASE_MS=120000;
const EDITABLE=['title','text','mediaUrls','platformIds','scheduledAt','timezone','profileRevision','dayKey','captions','origin','mediaSha256'];
const sha256=value=>{if(value===null||value===undefined||value==='')return '';if(typeof value!=='string'||!/^[a-f0-9]{64}$/i.test(value))fail(400,'Хеш SHA-256 должен быть 64 шестнадцатеричных символа');return value.toLowerCase();};
/* Очередь контента: пять площадок с лимитами подписей, карточки дней (D1…D7), версия и одобрение конкретной версии.
   Одобрение — только фиксация решения владельца; публикацию оно не запускает. */
const CAPTION_PLATFORMS=Object.freeze({instagram:{label:'Instagram / Reels',limit:2200},tiktok:{label:'TikTok',limit:2200},
  youtube_shorts:{label:'YouTube Shorts',limit:5000},vk:{label:'ВКонтакте',limit:15000},telegram:{label:'Telegram',limit:1024}});
const VIDEO_RE=/\.(mp4|webm|mov|m4v)(?:[?#].*)?$/i,IMAGE_RE=/\.(jpe?g|png|webp|gif)(?:[?#].*)?$/i;
const dayKey=value=>{if(value===null||value===undefined||value==='')return '';if(typeof value!=='string'||!/^D[1-7]$/.test(value))fail(400,'День карточки задаётся как D1…D7');return value;};
function captions(value) {
  if(value===null||value===undefined)return {};
  if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'Подписи площадок должны быть объектом');
  const result={};
  for(const [platform,caption]of Object.entries(value)){
    if(!Object.hasOwn(CAPTION_PLATFORMS,platform))fail(400,`Неизвестная площадка подписи «${platform}»`);
    const clean=text(caption??'',CAPTION_PLATFORMS[platform].limit);
    if(clean)result[platform]=clean;
  }
  return result;
}
const mediaKind=urls=>urls.some(u=>VIDEO_RE.test(u))?'video':urls.some(u=>IMAGE_RE.test(u))?'image':urls.length?'file':'none';
function createAutoposting(db,{information,transport,now=Date.now,logger=console}={}) {
  if(!information||!transport)throw Error('Autoposting requires company information and publication adapters');
  db.exec(`CREATE TABLE IF NOT EXISTS autoposting_posts (
    id INTEGER PRIMARY KEY,company_id INTEGER NOT NULL REFERENCES companies(id),revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','scheduled','publishing','published','failed','needs_review','cancelled')),
    title TEXT NOT NULL,text TEXT NOT NULL,media_urls TEXT NOT NULL,platform_ids TEXT NOT NULL,
    scheduled_at TEXT,timezone TEXT NOT NULL,profile_revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,created_by INTEGER,last_error_code TEXT,
    publishing_at INTEGER,lease TEXT);
    CREATE INDEX IF NOT EXISTS autoposting_due_idx ON autoposting_posts(status,scheduled_at);
    CREATE TABLE IF NOT EXISTS autoposting_deliveries (
    post_id INTEGER NOT NULL REFERENCES autoposting_posts(id),channel_id TEXT NOT NULL,channel_revision INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','publishing','published','failed','needs_review','cancelled')),
    external_id TEXT,url TEXT,error_code TEXT,started_at INTEGER,finished_at TEXT,
    PRIMARY KEY(post_id,channel_id));`);
  const postColumns=new Set(db.prepare('PRAGMA table_info(autoposting_posts)').all().map(row=>row.name));
  for(const [column,type]of [['day_key',"TEXT NOT NULL DEFAULT ''"],['captions',"TEXT NOT NULL DEFAULT '{}'"],['origin',"TEXT NOT NULL DEFAULT ''"],
    ['approved_revision','INTEGER'],['approved_at','TEXT'],['approved_by','INTEGER'],['approved_by_name','TEXT'],
    ['media_sha256',"TEXT NOT NULL DEFAULT ''"],['expected_media_sha256',"TEXT NOT NULL DEFAULT ''"],['expected_media_file',"TEXT NOT NULL DEFAULT ''"],['external_id',"TEXT NOT NULL DEFAULT ''"],
    ['content_revision','INTEGER NOT NULL DEFAULT 1']]){
    if(!postColumns.has(column))db.exec(`ALTER TABLE autoposting_posts ADD COLUMN ${column} ${type}`);
  }
  const deliveryColumns=new Set(db.prepare('PRAGMA table_info(autoposting_deliveries)').all().map(row=>row.name));
  for(const column of ['provider_post_id','provider_status','provider_checked_at']){
    if(!deliveryColumns.has(column))db.exec(`ALTER TABLE autoposting_deliveries ADD COLUMN ${column} TEXT`);
  }
  const iso=()=>new Date(now()).toISOString();
  function transaction(work){db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
  function rowFor(id,code) {
    const owner=company(db,code);
    if(!Number.isSafeInteger(Number(id))||Number(id)<1)fail(404,'Публикация не найдена','NOT_FOUND');
    const row=db.prepare('SELECT * FROM autoposting_posts WHERE id=? AND company_id=?').get(Number(id),owner.id);
    if(!row)fail(404,'Публикация не найдена','NOT_FOUND');return {row,owner};
  }
  /* Готовность к одобрению: есть материал, есть текст или подпись хотя бы одной площадки, подписи в лимитах. Ничего не публикует. */
  function readiness(row) {
    const media=JSON.parse(row.media_urls),caps=JSON.parse(row.captions||'{}'),issues=[];
    if(!media.length)issues.push('Нет материала: добавьте ссылку на видео или изображение'+(row.expected_media_file?` (ожидается файл ${row.expected_media_file} из пакета)`:''));
    // Пакет назвал хеш ролика: без сверки загруженный файл не считается тем самым видео.
    else if(row.expected_media_sha256&&!row.media_sha256)issues.push('Хеш видео не сверен с пакетом: загрузите ролик из пакета через кабинет');
    else if(row.expected_media_sha256&&row.media_sha256!==row.expected_media_sha256)issues.push('Загруженный файл не совпадает с роликом из пакета (SHA-256 отличается)');
    if(!row.text&&!Object.keys(caps).length)issues.push('Нет текста и подписей площадок');
    for(const [platform,caption]of Object.entries(caps))if(caption.length>CAPTION_PLATFORMS[platform].limit)issues.push(`Подпись ${CAPTION_PLATFORMS[platform].label} длиннее лимита`);
    return {ready:!issues.length,issues,mediaKind:mediaKind(media)};
  }
  /* Одобрение привязано к content_revision — версии содержимого (текст, подписи, материал, день, происхождение).
     Технические переходы (план, отправка, отмена) меняют revision, но не content_revision, и одобрение сохраняют. */
  const isApproved=row=>row.approved_revision!==null&&row.approved_revision!==undefined&&row.approved_revision===row.content_revision;
  const isQueueCard=row=>Boolean(row.day_key||Object.keys(JSON.parse(row.captions||'{}')).length);
  function approvalDto(row) {
    const approved=isApproved(row);
    return {approved,approvedRevision:row.approved_revision??null,contentRevision:row.content_revision,approvedAt:row.approved_at||null,approvedByName:row.approved_by_name||null,
      stale:row.approved_revision!==null&&row.approved_revision!==undefined&&!approved};
  }
  function dto(row,owner) {
    return {id:row.id,companyCode:owner.code.toLowerCase(),revision:row.revision,contentRevision:row.content_revision,status:row.status,title:row.title,text:row.text,
      mediaUrls:JSON.parse(row.media_urls),platformIds:JSON.parse(row.platform_ids),scheduledAt:row.scheduled_at,timezone:row.timezone,
      dayKey:row.day_key||'',captions:JSON.parse(row.captions||'{}'),origin:row.origin||'',readiness:readiness(row),approval:approvalDto(row),
      mediaSha256:row.media_sha256||'',expectedMediaSha256:row.expected_media_sha256||'',expectedMediaFile:row.expected_media_file||'',externalId:row.external_id||'',
      captionLimits:Object.fromEntries(Object.entries(CAPTION_PLATFORMS).map(([k,v])=>[k,v.limit])),
      profileRevision:row.profile_revision,createdAt:row.created_at,updatedAt:row.updated_at,lastErrorCode:row.last_error_code,
      deliveries:db.prepare(`SELECT channel_id channelId,status,external_id externalId,url,error_code errorCode,finished_at finishedAt,
        provider_post_id providerPostId,provider_status providerStatus,provider_checked_at providerCheckedAt
        FROM autoposting_deliveries WHERE post_id=? ORDER BY channel_id`).all(row.id)};
  }
  function invalidate(code) {
    const current=information.get(code),owner=company(db,code);
    db.prepare(`UPDATE autoposting_posts SET status='needs_review',revision=revision+1,last_error_code='PROFILE_CHANGED',updated_at=?
      WHERE company_id=? AND status='scheduled' AND profile_revision<>?`).run(iso(),owner.id,current.revision);
    return current;
  }
  function get(id,code) {invalidate(code);const {row,owner}=rowFor(id,code);return dto(row,owner);}
  function list(code) {
    invalidate(code);const owner=company(db,code);
    return {companyCode:owner.code.toLowerCase(),posts:db.prepare('SELECT * FROM autoposting_posts WHERE company_id=? ORDER BY created_at DESC,id DESC LIMIT 200').all(owner.id).map(row=>dto(row,owner))};
  }
  function normalized(patch,defaults) {
    const result={...defaults};
    for(const [key,value]of Object.entries(patch)){
      if(key==='title'||key==='text')result[key]=text(value,key==='title'?200:20000);
      else if(key==='timezone')result[key]=timezone(value);
      else if(key==='scheduledAt')result[key]=value===null||value===''?null:utcDate(value);
      else if(key==='profileRevision')result[key]=revision(value);
      else if(key==='dayKey')result[key]=dayKey(value);
      else if(key==='captions')result[key]=captions(value);
      else if(key==='origin')result[key]=text(value??'',200);
      else if(key==='mediaSha256')result[key]=sha256(value);
      else if(key==='mediaUrls'){
        if(!Array.isArray(value)||value.length>10)fail(400,'Допускается не более 10 материалов');result[key]=value.map(url);
      }else if(key==='platformIds'){
        if(!Array.isArray(value)||value.length>20)fail(400,'Допускается не более 20 каналов');
        result[key]=value.map(id=>text(id,100,true));if(new Set(result[key]).size!==result[key].length)fail(400,'Канал выбран дважды');
      }
    }
    return result;
  }
  function create(code,body,actorId=null) {
    object(body,EDITABLE);const owner=company(db,code),current=information.get(code);
    const data=normalized(body,{title:'',text:'',mediaUrls:[],platformIds:[],scheduledAt:null,timezone:current.profile.timezone||'UTC',profileRevision:current.revision,dayKey:'',captions:{},origin:'',mediaSha256:''});
    if(data.profileRevision!==current.revision)fail(409,'Данные компании изменились','PROFILE_CHANGED');
    const time=iso(),id=db.prepare(`INSERT INTO autoposting_posts(company_id,title,text,media_urls,platform_ids,scheduled_at,timezone,profile_revision,created_at,updated_at,created_by,day_key,captions,origin,media_sha256)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(owner.id,data.title,data.text,JSON.stringify(data.mediaUrls),JSON.stringify(data.platformIds),data.scheduledAt,data.timezone,data.profileRevision,time,time,actorId,data.dayKey,JSON.stringify(data.captions),data.origin,data.mediaSha256).lastInsertRowid;
    return get(Number(id),code);
  }
  function update(id,code,body) {
    object(body,['revision',...EDITABLE]);revision(body.revision);const current=invalidate(code);
    transaction(()=>{
      const {row,owner}=rowFor(id,code);
      if(row.revision!==body.revision)fail(409,'Публикация уже изменена','REVISION_CONFLICT');
      if(['publishing','published'].includes(row.status))fail(409,'Публикацию уже отправляют или опубликовали','POST_STATE');
      if(db.prepare("SELECT 1 FROM autoposting_deliveries WHERE post_id=? AND status IN ('publishing','needs_review','published')").get(row.id))fail(409,'Сначала проверьте результат на площадке. Повторная отправка может создать дубликат.','PUBLICATION_REVIEW_REQUIRED');
      const data=normalized(body,dto(row,owner));
      if(data.profileRevision!==current.revision)fail(409,'Пересмотрите текст по новой версии компании','PROFILE_CHANGED');
      // Любое изменение текста, подписей или материала создаёт новую версию: прежнее одобрение к ней не относится.
      // Смена ссылок на материал обнуляет хеш, если клиент не передал новый: старая сверка к новому файлу не относится.
      const mediaSha=Object.hasOwn(body,'mediaSha256')?data.mediaSha256:(JSON.stringify(data.mediaUrls)===row.media_urls?row.media_sha256:'');
      db.prepare(`UPDATE autoposting_posts SET title=?,text=?,media_urls=?,platform_ids=?,scheduled_at=?,timezone=?,profile_revision=?,day_key=?,captions=?,origin=?,media_sha256=?,
        status='draft',revision=revision+1,content_revision=content_revision+1,updated_at=?,last_error_code=NULL WHERE id=?`)
        .run(data.title,data.text,JSON.stringify(data.mediaUrls),JSON.stringify(data.platformIds),data.scheduledAt,data.timezone,data.profileRevision,data.dayKey,JSON.stringify(data.captions),data.origin,mediaSha,iso(),row.id);
      db.prepare('DELETE FROM autoposting_deliveries WHERE post_id=?').run(row.id);
    });return get(id,code);
  }
  async function schedule(id,code,body) {
    object(body,['revision','scheduledAt','timezone','profileRevision']);revision(body.revision);
    const settings=await transport.getSettings(code),current=invalidate(code);
    transaction(()=>{
      const {row,owner}=rowFor(id,code);
      if(row.revision!==body.revision)fail(409,'Публикация уже изменена','REVISION_CONFLICT');
      if(!['draft','failed','cancelled','needs_review'].includes(row.status))fail(409,'Публикация уже запланирована или отправляется','POST_STATE');
      if(db.prepare("SELECT 1 FROM autoposting_deliveries WHERE post_id=? AND status IN ('publishing','published','needs_review')").get(row.id))fail(409,'Проверьте результат на площадке перед повторной отправкой','PUBLICATION_REVIEW_REQUIRED');
      const data=normalized(body,dto(row,owner));
      if(data.profileRevision!==current.revision||row.profile_revision!==current.revision)fail(409,'Пересмотрите текст по новой версии компании','PROFILE_CHANGED');
      const captionsByPlatform=JSON.parse(row.captions||'{}');
      if((!data.text&&!Object.keys(captionsByPlatform).length)||!data.platformIds.length)fail(400,'Добавьте текст и выберите каналы');
      // Карточки очереди контента (день или подписи площадок) ставятся в план только с одобрением именно этой версии.
      if(isQueueCard(row)&&!isApproved(row))fail(409,'Сначала одобрите публикацию этой версии','APPROVAL_REQUIRED');
      if(!data.scheduledAt||Date.parse(data.scheduledAt)<=now())fail(400,'Выберите время публикации в будущем');
      const channels=data.platformIds.map(id=>settings.channels.find(channel=>channel.id===id));
      if(channels.some(channel=>!channel||!channel.enabled||!channel.connected))fail(409,'Выбранный канал не подключён','CHANNEL_NOT_CONNECTED');
      if(channels.some(channel=>!data.text&&!captionsByPlatform[channel.platform||channel.id]))fail(400,'Для выбранного канала нет ни общего текста, ни подписи площадки');
      for(const channel of channels)revision(channel.revision);
      db.prepare('DELETE FROM autoposting_deliveries WHERE post_id=?').run(row.id);
      for(const channel of channels)db.prepare('INSERT INTO autoposting_deliveries(post_id,channel_id,channel_revision) VALUES(?,?,?)').run(row.id,channel.id,channel.revision);
      db.prepare(`UPDATE autoposting_posts SET status='scheduled',scheduled_at=?,timezone=?,revision=revision+1,updated_at=?,last_error_code=NULL WHERE id=?`)
        .run(data.scheduledAt,data.timezone,iso(),row.id);
    });return get(id,code);
  }
  /* Одобрение конкретной версии владельцем. Не публикует, не планирует; снятие галочки убирает одобрение. */
  function approve(id,code,body,actor={}) {
    object(body,['revision','approved']);revision(body.revision);
    if(typeof body.approved!=='boolean')fail(400,'Укажите approved: true или false');
    return transaction(()=>{
      const {row,owner}=rowFor(id,code);
      if(row.revision!==body.revision)fail(409,'Публикация уже изменена','REVISION_CONFLICT');
      if(body.approved){
        const state=readiness(row);
        if(!state.ready)fail(409,`Материал не готов: ${state.issues.join('; ')}`,'NOT_READY');
        if(['publishing','published'].includes(row.status))fail(409,'Публикацию уже отправляют или опубликовали','POST_STATE');
        db.prepare('UPDATE autoposting_posts SET approved_revision=?,approved_at=?,approved_by=?,approved_by_name=?,revision=revision+1,updated_at=? WHERE id=?')
          .run(row.content_revision,iso(),actor.userId??null,actor.userName??null,iso(),row.id);
      }else{
        // Отзыв одобрения останавливает ещё не начатую отправку: запланированная карточка возвращается в черновик.
        if(row.status==='publishing')fail(409,'Отправка уже началась: дождитесь результата, затем снимите с публикации','POST_STATE');
        db.prepare("UPDATE autoposting_deliveries SET status='cancelled' WHERE post_id=? AND status='pending'").run(row.id);
        db.prepare(`UPDATE autoposting_posts SET approved_revision=NULL,approved_at=NULL,approved_by=NULL,approved_by_name=NULL,revision=revision+1,updated_at=?,
          status=CASE WHEN status='scheduled' THEN 'draft' ELSE status END,last_error_code=CASE WHEN status='scheduled' THEN 'APPROVAL_REVOKED' ELSE last_error_code END WHERE id=?`).run(iso(),row.id);
      }
      return dto(db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(row.id),owner);
    });
  }
  /* Безопасный импорт пакета карточек: только черновики, без одобрения и без публикации; ссылки на медиа — как переданы,
     отсутствующее видео не выдумывается. Повтор пакета с теми же день+название не создаёт дублей. */
  /* Пакет материалов (schemaVersion 1, как готовит владелец): день числом, подписи объектами {text,account}, YouTube {title,text},
     media {file, poster, sha256, publicUrl, origin}. Приводится к карточке; одобрение пакета игнорируется — одобряет только владелец в ЛК. */
  function packageItem(item) {
    object(item,['id','day','title','revision','status','approval','scheduledAt','timezone','durationSeconds','width','height','media','captions','cta','dayKey','text','mediaUrls','origin','platformIds']);
    const out={};
    if(item.dayKey!==undefined)out.dayKey=item.dayKey;
    else if(item.day!==undefined){if(!Number.isInteger(item.day)||item.day<1||item.day>7)fail(400,'День пакета должен быть числом от 1 до 7');out.dayKey='D'+item.day;}
    out.title=item.title;
    if(item.text!==undefined)out.text=item.text;
    if(item.scheduledAt!==undefined)out.scheduledAt=item.scheduledAt;
    if(item.timezone!==undefined)out.timezone=item.timezone;
    if(item.platformIds!==undefined)out.platformIds=item.platformIds;
    const media=item.media&&typeof item.media==='object'&&!Array.isArray(item.media)?item.media:null;
    if(media)object(media,['file','poster','sha256','publicUrl','posterUrl','origin','sourceUrl']);
    out.mediaUrls=Array.isArray(item.mediaUrls)?item.mediaUrls:[media?.publicUrl,media?.posterUrl].filter(v=>typeof v==='string'&&v);
    out.origin=item.origin!==undefined?item.origin:media?.origin;
    if(media?.sha256!==undefined&&media.sha256!==null)out.expectedMediaSha256=sha256(media.sha256);
    if(media?.file!==undefined&&media.file!==null)out.expectedMediaFile=text(media.file,300);
    if(item.id!==undefined)out.externalId=text(item.id,200);
    if(item.captions!==undefined&&item.captions!==null){
      if(!item.captions||typeof item.captions!=='object'||Array.isArray(item.captions))fail(400,'Подписи площадок должны быть объектом');
      const caps={};
      for(const [platform,value]of Object.entries(item.captions)){
        const key=platform==='youtube'?'youtube_shorts':platform;
        if(!Object.hasOwn(CAPTION_PLATFORMS,key))fail(400,`Неизвестная площадка подписи «${platform}»`);
        if(typeof value==='string'){caps[key]=value;continue;}
        if(!value||typeof value!=='object'||Array.isArray(value))fail(400,`Подпись «${platform}» должна быть строкой или объектом`);
        object(value,['text','title','account','hashtags']);
        const body=[value.title,value.text].filter(v=>typeof v==='string'&&v.trim()).map(v=>v.trim());
        caps[key]=key==='youtube_shorts'?body.join('\n\n'):body.join('\n');
      }
      out.captions=caps;
    }
    return out;
  }
  function importPackage(code,body,actorId=null) {
    object(body,['items','schemaVersion','project','companyCode','companyCodeNote','packageId','publicationEnabled','music','editorialAssistance','importState','platformDeliveryState']);
    if(!Array.isArray(body.items)||!body.items.length||body.items.length>50)fail(400,'Пакет должен содержать от 1 до 50 карточек');
    const owner=company(db,code),current=information.get(code);
    // companyCode пакета не решает, куда импортировать: компания берётся из авторизованного выбора в кабинете.
    if(typeof body.companyCode==='string'&&body.companyCode&&body.companyCode.toLowerCase()!==owner.code.toLowerCase())fail(409,'Пакет помечен другой компанией. Выберите её в кабинете или уберите companyCode из пакета','COMPANY_MISMATCH');
    return transaction(()=>{
      const created=[],skipped=[],mediaPending=[];
      for(const raw of body.items){
        const item=packageItem(raw);
        const data=normalized(item,{title:'',text:'',mediaUrls:[],platformIds:[],scheduledAt:null,timezone:current.profile.timezone||'UTC',profileRevision:current.revision,dayKey:'',captions:{},origin:'import',mediaSha256:''});
        if(!data.title)fail(400,'У карточки пакета нет названия');
        const expectedSha=item.expectedMediaSha256||'',expectedFile=item.expectedMediaFile||'',externalId=item.externalId||'';
        const duplicate=(externalId&&db.prepare("SELECT id FROM autoposting_posts WHERE company_id=? AND external_id=? AND status<>'cancelled' ORDER BY id LIMIT 1").get(owner.id,externalId))
          ||db.prepare("SELECT id FROM autoposting_posts WHERE company_id=? AND day_key=? AND title=? AND status<>'cancelled' ORDER BY id LIMIT 1").get(owner.id,data.dayKey,data.title);
        if(duplicate){skipped.push({id:duplicate.id,dayKey:data.dayKey,title:data.title,externalId});continue;}
        const time=iso(),id=db.prepare(`INSERT INTO autoposting_posts(company_id,title,text,media_urls,platform_ids,scheduled_at,timezone,profile_revision,created_at,updated_at,created_by,day_key,captions,origin,expected_media_sha256,expected_media_file,external_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(owner.id,data.title,data.text,JSON.stringify(data.mediaUrls),JSON.stringify(data.platformIds),data.scheduledAt,data.timezone,data.profileRevision,time,time,actorId,data.dayKey,JSON.stringify(data.captions),data.origin||'import',expectedSha,expectedFile,externalId).lastInsertRowid;
        const view=dto(db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(id),owner);
        created.push(view);
        if(!data.mediaUrls.length)mediaPending.push({id:view.id,dayKey:view.dayKey,title:view.title,file:expectedFile,sha256:expectedSha});
      }
      return {created,skipped,mediaPending,companyCode:owner.code.toLowerCase(),approved:0,published:0};
    });
  }
  function cancel(id,code,body) {
    object(body,['revision']);revision(body.revision);
    transaction(()=>{
      const {row}=rowFor(id,code);
      if(row.revision!==body.revision)fail(409,'Публикация уже изменена','REVISION_CONFLICT');
      if(row.status==='published')fail(409,'Опубликованное сообщение нельзя отменить в очереди','POST_STATE');
      if(row.status!=='cancelled'){
        db.prepare("UPDATE autoposting_posts SET status='cancelled',revision=revision+1,updated_at=? WHERE id=?").run(iso(),row.id);
        db.prepare("UPDATE autoposting_deliveries SET status='cancelled' WHERE post_id=? AND status='pending'").run(row.id);
      }
    });return get(id,code);
  }
  function review(id,code) {
    db.prepare("UPDATE autoposting_posts SET status='needs_review',last_error_code=?,revision=revision+1,updated_at=? WHERE id=? AND status IN ('publishing','scheduled')")
      .run(code,iso(),id);
  }
  async function reconcile(id,code,body) {
    object(body,['revision']);revision(body.revision);
    const {row}=rowFor(id,code);
    if(row.revision!==body.revision)fail(409,'Публикация уже изменена','REVISION_CONFLICT');
    const deliveries=db.prepare("SELECT * FROM autoposting_deliveries WHERE post_id=? AND provider_post_id IS NOT NULL AND status='needs_review'").all(row.id);
    if(!transport.reconcile||!deliveries.length)fail(409,'Нет принятого задания, которое можно проверить без повторной отправки','PROVIDER_POST_REQUIRED');
    for(const delivery of deliveries)await reconcileDelivery(row.id,code,delivery);
    return get(id,code);
  }
  async function reconcileDelivery(postId,code,delivery) {
    let result;
    try {
      result=await transport.reconcile({companyCode:code,channelId:delivery.channel_id,
        channelRevision:delivery.channel_revision,providerPostId:delivery.provider_post_id});
      if(!result||result.providerPostId!==delivery.provider_post_id||!['draft','scheduled','published','failed'].includes(result.providerStatus))throw Error('Invalid provider receipt');
    } catch {
      // A failed GET never permits a second POST and cannot erase the known job ID.
      db.prepare("UPDATE autoposting_deliveries SET provider_checked_at=?,error_code='PROVIDER_CHECK_FAILED' WHERE post_id=? AND channel_id=? AND provider_post_id=? AND status='needs_review'")
        .run(iso(),postId,delivery.channel_id,delivery.provider_post_id);return;
    }
    db.prepare("UPDATE autoposting_deliveries SET provider_status=?,provider_checked_at=?,error_code=? WHERE post_id=? AND channel_id=? AND provider_post_id=? AND status='needs_review'")
      .run(result.providerStatus,iso(),result.errorCode||'PROVIDER_PENDING',postId,delivery.channel_id,delivery.provider_post_id);
    db.prepare("UPDATE autoposting_posts SET last_error_code=?,revision=revision+1,updated_at=? WHERE id=? AND status='needs_review'")
      .run(result.errorCode||'PROVIDER_PENDING',iso(),postId);
  }
  let stopped=false,running=null;
  async function processDue() {
    // Poll only known pending jobs. Unknown/timeout attempts cannot be reconciled by guessing text.
    if(transport.reconcile&&!stopped){
      const pending=db.prepare(`SELECT d.*,c.code FROM autoposting_deliveries d JOIN autoposting_posts p ON p.id=d.post_id
        JOIN companies c ON c.id=p.company_id WHERE c.is_deleted=0 AND d.status='needs_review'
        AND d.provider_post_id IS NOT NULL AND d.provider_status IN ('draft','scheduled')
        AND (d.provider_checked_at IS NULL OR d.provider_checked_at<=?) LIMIT 5`).all(new Date(now()-60000).toISOString());
      for(const delivery of pending){if(stopped)return;await reconcileDelivery(delivery.post_id,delivery.code,delivery);}
    }
    // An expired attempt may already exist externally. Never resend it automatically.
    db.prepare("UPDATE autoposting_deliveries SET status='needs_review',error_code='PUBLICATION_UNCERTAIN' WHERE status='publishing' AND started_at<=?").run(now()-LEASE_MS);
    db.prepare("UPDATE autoposting_posts SET status='needs_review',last_error_code='PUBLICATION_UNCERTAIN',revision=revision+1,updated_at=? WHERE status='publishing' AND publishing_at<=?").run(iso(),now()-LEASE_MS);
    const due=db.prepare(`SELECT p.*,c.code FROM autoposting_posts p JOIN companies c ON c.id=p.company_id
      WHERE p.status='scheduled' AND p.scheduled_at<=? AND c.is_deleted=0 ORDER BY p.scheduled_at,p.id LIMIT 1`).get(iso());
    if(!due||stopped)return;
    const current=invalidate(due.code);if(due.profile_revision!==current.revision)return;
    const settings=await transport.getSettings(due.code);
    if(stopped)return;
    const deliveries=db.prepare('SELECT * FROM autoposting_deliveries WHERE post_id=? ORDER BY channel_id').all(due.id);
    if(deliveries.some(delivery=>{
      const channel=settings.channels.find(c=>c.id===delivery.channel_id);
      return !channel||!channel.connected||!channel.enabled||channel.revision!==delivery.channel_revision;
    })){review(due.id,'CHANNEL_CHANGED');return;}
    if(information.get(due.code).revision!==due.profile_revision){review(due.id,'PROFILE_CHANGED');return;}
    if(isQueueCard(due)&&!isApproved(due)){review(due.id,'APPROVAL_REVOKED');return;}
    const lease=randomUUID();
    const claimed=db.prepare("UPDATE autoposting_posts SET status='publishing',publishing_at=?,lease=?,revision=revision+1,updated_at=? WHERE id=? AND status='scheduled' AND revision=?")
      .run(now(),lease,iso(),due.id,due.revision);
    if(!claimed.changes)return;
    for(const delivery of deliveries){
      const row=db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(due.id);
      if(stopped||row.status!=='publishing'||row.lease!==lease)return;
      if(information.get(due.code).revision!==due.profile_revision){review(due.id,'PROFILE_CHANGED');return;}
      // Refresh the channel immediately before every publication; earlier awaits can span an owner edit.
      const freshSettings=await transport.getSettings(due.code),channel=freshSettings.channels.find(c=>c.id===delivery.channel_id);
      if(!channel||!channel.connected||!channel.enabled||channel.revision!==delivery.channel_revision){review(due.id,'CHANNEL_CHANGED');return;}
      const freshPost=db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(due.id);
      if(stopped||freshPost.status!=='publishing'||freshPost.lease!==lease)return;
      // Отзыв одобрения между каналами: оставшиеся отправки не выполняются.
      if(isQueueCard(freshPost)&&!isApproved(freshPost)){db.prepare("UPDATE autoposting_deliveries SET status='cancelled' WHERE post_id=? AND status='pending'").run(due.id);review(due.id,'APPROVAL_REVOKED');return;}
      if(information.get(due.code).revision!==due.profile_revision){review(due.id,'PROFILE_CHANGED');return;}
      if(!db.prepare("UPDATE autoposting_deliveries SET status='publishing',started_at=? WHERE post_id=? AND channel_id=? AND status='pending'").run(now(),due.id,delivery.channel_id).changes)continue;
      try{
        const result=await transport.publish({companyCode:due.code.toLowerCase(),channelId:delivery.channel_id,channelRevision:delivery.channel_revision,
          // Подпись площадки, если задана, заменяет общий текст именно для этого канала.
          post:(()=>{const view=dto(due,company(db,due.code));return {...view,text:view.captions?.[channel.platform||channel.id]||view.text,idempotencyKey:`synapse-post-${due.id}-${delivery.channel_id}`};})(),
          beforePublish:()=>{
            const active=db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(due.id);
            if(stopped||active?.status!=='publishing'||active.lease!==lease||information.get(due.code).revision!==due.profile_revision||(isQueueCard(active)&&!isApproved(active)))
              throw Object.assign(Error('Publication changed before provider submission'),{ambiguous:false});
          }});
        if(result?.provider==='onlypult'){
          if(typeof result.providerPostId!=='string'||!result.providerPostId||!['draft','scheduled','published','failed'].includes(result.providerStatus))throw Error('Invalid provider receipt');
          db.prepare(`UPDATE autoposting_deliveries SET status='needs_review',provider_post_id=?,provider_status=?,provider_checked_at=?,error_code=?
            WHERE post_id=? AND channel_id=? AND status='publishing'`).run(result.providerPostId,result.providerStatus,iso(),result.errorCode||'PROVIDER_PENDING',due.id,delivery.channel_id);
          continue;
        }
        if(result?.status&&result.status!=='published')throw Error('Publication still pending');
        if(!result||typeof result.externalId!=='string'||!result.externalId)throw Error('Unconfirmed publication');
        db.prepare("UPDATE autoposting_deliveries SET status='published',external_id=?,url=?,finished_at=?,error_code=NULL WHERE post_id=? AND channel_id=? AND status='publishing'")
          .run(result.externalId.slice(0,500),result.url?url(result.url):null,iso(),due.id,delivery.channel_id);
      }catch(error){
        const ambiguous=error?.ambiguous!==false,status=ambiguous?'needs_review':'failed';
        const code=ambiguous?'PUBLICATION_UNCERTAIN':'PUBLISH_FAILED';
        db.prepare("UPDATE autoposting_deliveries SET status=?,error_code=?,finished_at=? WHERE post_id=? AND channel_id=? AND status='publishing'")
          .run(status,code,iso(),due.id,delivery.channel_id);
        db.prepare("UPDATE autoposting_posts SET status=?,last_error_code=?,revision=revision+1,updated_at=? WHERE id=? AND status='publishing' AND lease=?")
          .run(status,code,iso(),due.id,lease);
        logger.warn(`[crm] autoposting code=${code}`);return;
      }
    }
    db.prepare(`UPDATE autoposting_posts SET status='needs_review',last_error_code=COALESCE((SELECT error_code FROM autoposting_deliveries
      WHERE post_id=? AND status='needs_review' LIMIT 1),'PROVIDER_PENDING'),revision=revision+1,updated_at=?
      WHERE id=? AND status='publishing' AND lease=? AND EXISTS(SELECT 1 FROM autoposting_deliveries WHERE post_id=? AND status='needs_review')`)
      .run(due.id,iso(),due.id,lease,due.id);
    db.prepare("UPDATE autoposting_posts SET status='published',last_error_code=NULL,revision=revision+1,updated_at=? WHERE id=? AND status='publishing' AND lease=? AND NOT EXISTS(SELECT 1 FROM autoposting_deliveries WHERE post_id=? AND status<>'published')")
      .run(iso(),due.id,lease,due.id);
  }
  function drain(){if(stopped)return Promise.resolve();if(!running)running=processDue().finally(()=>running=null);return running;}
  function stop(){stopped=true;return running||Promise.resolve();}
  return {get,list,create,update,schedule,cancel,reconcile,drain,stop,invalidate,approve,importPackage};
}
module.exports={createAutoposting,LEASE_MS,CAPTION_PLATFORMS};
