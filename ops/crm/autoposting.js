'use strict';

const {company,fail,object,text,timezone,utcDate,revision,url}=require('./company-information');
const {randomUUID}=require('node:crypto');
const LEASE_MS=120000;
const EDITABLE=['title','text','mediaUrls','platformIds','scheduledAt','timezone','profileRevision'];
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
  function dto(row,owner) {
    return {id:row.id,companyCode:owner.code.toLowerCase(),revision:row.revision,status:row.status,title:row.title,text:row.text,
      mediaUrls:JSON.parse(row.media_urls),platformIds:JSON.parse(row.platform_ids),scheduledAt:row.scheduled_at,timezone:row.timezone,
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
    const data=normalized(body,{title:'',text:'',mediaUrls:[],platformIds:[],scheduledAt:null,timezone:current.profile.timezone||'UTC',profileRevision:current.revision});
    if(data.profileRevision!==current.revision)fail(409,'Данные компании изменились','PROFILE_CHANGED');
    const time=iso(),id=db.prepare(`INSERT INTO autoposting_posts(company_id,title,text,media_urls,platform_ids,scheduled_at,timezone,profile_revision,created_at,updated_at,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(owner.id,data.title,data.text,JSON.stringify(data.mediaUrls),JSON.stringify(data.platformIds),data.scheduledAt,data.timezone,data.profileRevision,time,time,actorId).lastInsertRowid;
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
      db.prepare(`UPDATE autoposting_posts SET title=?,text=?,media_urls=?,platform_ids=?,scheduled_at=?,timezone=?,profile_revision=?,
        status='draft',revision=revision+1,updated_at=?,last_error_code=NULL WHERE id=?`)
        .run(data.title,data.text,JSON.stringify(data.mediaUrls),JSON.stringify(data.platformIds),data.scheduledAt,data.timezone,data.profileRevision,iso(),row.id);
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
      if(!data.text||!data.platformIds.length)fail(400,'Добавьте текст и выберите каналы');
      if(!data.scheduledAt||Date.parse(data.scheduledAt)<=now())fail(400,'Выберите время публикации в будущем');
      const channels=data.platformIds.map(id=>settings.channels.find(channel=>channel.id===id));
      if(channels.some(channel=>!channel||!channel.enabled||!channel.connected))fail(409,'Выбранный канал не подключён','CHANNEL_NOT_CONNECTED');
      for(const channel of channels)revision(channel.revision);
      db.prepare('DELETE FROM autoposting_deliveries WHERE post_id=?').run(row.id);
      for(const channel of channels)db.prepare('INSERT INTO autoposting_deliveries(post_id,channel_id,channel_revision) VALUES(?,?,?)').run(row.id,channel.id,channel.revision);
      db.prepare(`UPDATE autoposting_posts SET status='scheduled',scheduled_at=?,timezone=?,revision=revision+1,updated_at=?,last_error_code=NULL WHERE id=?`)
        .run(data.scheduledAt,data.timezone,iso(),row.id);
    });return get(id,code);
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
      if(information.get(due.code).revision!==due.profile_revision){review(due.id,'PROFILE_CHANGED');return;}
      if(!db.prepare("UPDATE autoposting_deliveries SET status='publishing',started_at=? WHERE post_id=? AND channel_id=? AND status='pending'").run(now(),due.id,delivery.channel_id).changes)continue;
      try{
        const result=await transport.publish({companyCode:due.code.toLowerCase(),channelId:delivery.channel_id,channelRevision:delivery.channel_revision,
          post:{...dto(due,company(db,due.code)),idempotencyKey:`synapse-post-${due.id}-${delivery.channel_id}`},
          beforePublish:()=>{
            const active=db.prepare('SELECT status,lease FROM autoposting_posts WHERE id=?').get(due.id);
            if(stopped||active?.status!=='publishing'||active.lease!==lease||information.get(due.code).revision!==due.profile_revision)
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
  return {get,list,create,update,schedule,cancel,reconcile,drain,stop,invalidate};
}
module.exports={createAutoposting,LEASE_MS};
