'use strict';

const {company,fail,object,text,timezone,utcDate,revision,url}=require('./company-information');
const {publicUrl}=require('./autoposting-transport');
const {randomUUID}=require('node:crypto');
const LEASE_MS=120000;
const META_FIELDS=['format','role','audience','hook','idea','hughNote','metrics','methodSource'];
const EDITABLE=['title','text','mediaUrls','platformIds','scheduledAt','timezone','profileRevision','dayKey','captions','origin','mediaSha256',...META_FIELDS];
/* Метаданные контент-плана: формат и роль независимы; ни одно поле не попадает в публичную подпись.
   Роли — из процесса «привлечение → доверие → обращение»; источник методики — текст (название курса/принципа), не ссылка. */
const FORMATS=Object.freeze({post:'Пост',story:'Сторис',reel:'Reels / Shorts / клип',carousel:'Карусель'});
const ROLES=Object.freeze({reach:'Охватный',affection:'На влюбление',sale:'На продажу'});
const REVIEW_STATES=Object.freeze({draft:'Черновик',pending:'На согласовании',approved:'Согласовано',rejected:'Отклонено'});
const META_LIMITS=Object.freeze({audience:500,hook:500,idea:4000,hughNote:2000,metrics:1000,methodSource:300});
function meta(value) {
  if(value===null||value===undefined)return {};
  if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'Метаданные карточки должны быть объектом');
  const out={};
  for(const [key,item]of Object.entries(value)){
    if(!META_FIELDS.includes(key))fail(400,`Неизвестное поле метаданных «${key}»`);
    if(key==='format'){if(item!==''&&item!==null&&!Object.hasOwn(FORMATS,item))fail(400,'Формат: post, story, reel или carousel');out.format=item||'';}
    else if(key==='role'){if(item!==''&&item!==null&&!Object.hasOwn(ROLES,item))fail(400,'Роль: reach, affection или sale');out.role=item||'';}
    else out[key]=text(item??'',META_LIMITS[key]);
  }
  return out;
}
const sha256=value=>{if(value===null||value===undefined||value==='')return '';if(typeof value!=='string'||!/^[a-f0-9]{64}$/i.test(value))fail(400,'Хеш SHA-256 должен быть 64 шестнадцатеричных символа');return value.toLowerCase();};
/* Очередь контента: пять площадок с лимитами подписей, карточки дней (D1…D7), версия и одобрение конкретной версии.
   Одобрение — только фиксация решения владельца; публикацию оно не запускает. */
const CAPTION_PLATFORMS=Object.freeze({instagram:{label:'Instagram / Reels',limit:2200},tiktok:{label:'TikTok',limit:2200},
  youtube_shorts:{label:'YouTube Shorts',limit:5000},vk:{label:'ВКонтакте',limit:15000},telegram:{label:'Telegram',limit:1024}});
/* Подтверждение внешней публикации (receipt): владелец фиксирует, что материал уже вышел на площадке
   через внешний сервис или нативный интерфейс. Это доказательство, а не доставка: провайдер не вызывается,
   одобрение не меняется, отправка не запускается.
   Ссылка принимается только по разобранному формату: https, домен площадки, путь адреса записи и —
   если формат его требует — ровно один параметр с проверенным значением. Непроверяемые короткие ссылки
   (vm.tiktok.com, youtu.be) не поддерживаются: по ним нельзя убедиться, что это адрес записи, а не редирект. */
const RECEIPT_PLATFORMS=Object.freeze({
  instagram:{label:'Instagram / Reels',hosts:new Set(['instagram.com','www.instagram.com']),
    forms:[{path:/^\/(?:[A-Za-z0-9._]{1,30}\/)?(?:p|reel|reels|tv)\/[A-Za-z0-9_-]{5,40}\/?$/,query:{}}]},
  tiktok:{label:'TikTok',hosts:new Set(['tiktok.com','www.tiktok.com']),
    forms:[{path:/^\/@[A-Za-z0-9._]{1,30}\/(?:video|photo)\/\d{5,30}\/?$/,query:{}}]},
  youtube_shorts:{label:'YouTube Shorts',hosts:new Set(['youtube.com','www.youtube.com','m.youtube.com']),
    forms:[{path:/^\/shorts\/[A-Za-z0-9_-]{5,20}\/?$/,query:{}},{path:/^\/watch$/,query:{v:/^[A-Za-z0-9_-]{5,20}$/}}]},
  vk:{label:'ВКонтакте',hosts:new Set(['vk.com','www.vk.com','m.vk.com','vk.ru','www.vk.ru']),
    forms:[{path:/^\/(?:wall|video|clip|photo)-?\d{1,20}_\d{1,20}\/?$/,query:{}},
      {path:/^\/[A-Za-z0-9._]{2,40}\/?$/,query:{w:/^(?:wall|video|clip|photo)-?\d{1,20}_\d{1,20}$/}}]},
  telegram:{label:'Telegram',hosts:new Set(['t.me','telegram.me']),
    forms:[{path:/^\/(?:c\/\d{1,20}\/\d{1,20}|[A-Za-z0-9_]{4,32}\/\d{1,20})\/?$/,query:{}}]},
});
/* Общая для сервера и кабинета проверка. Значения разрешённых параметров сверяются с форматом,
   повтор параметра и любой лишний параметр отклоняются: иначе ?t=…/?w=… унесли бы токен или метку. */
function receiptFormat(platform,value) {
  const spec=RECEIPT_PLATFORMS[platform];
  if(!spec||typeof value!=='string')return null;
  const raw=value.trim();
  if(!raw||raw.length>500||/[\x00-\x20\x7f-\x9f<>"'`\\]/.test(raw))return null;
  let parsed;
  try{parsed=new URL(raw);}catch{return null;}
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||parsed.hash)return null;
  if(!spec.hosts.has(parsed.hostname.toLowerCase()))return null;
  const keys=[...parsed.searchParams.keys()];
  if(new Set(keys).size!==keys.length)return null;
  const form=spec.forms.find(item=>item.path.test(parsed.pathname)
    &&keys.length===Object.keys(item.query).length
    &&Object.entries(item.query).every(([key,pattern])=>pattern.test(parsed.searchParams.get(key)??'')));
  return form?parsed.href:null;
}
function receiptUrl(platform,value) {
  const spec=RECEIPT_PLATFORMS[platform],normalized=receiptFormat(platform,value);
  if(normalized)return normalized;
  fail(400,`Укажите обычный https-адрес записи ${spec.label} — без логина, пароля, порта, части после «#» и лишних параметров`);
}
/* Календарь месяца. Период задаётся календарными датами компании, а не UTC-сутками:
   владелец видит день так, как он наступает в его часовом поясе. Окно ограничено,
   чтобы ответ оставался предсказуемым; карточки без даты отдаются отдельным списком. */
const CALENDAR_MAX_RANGE_DAYS=31,CALENDAR_UNDATED_LIMIT=200,CALENDAR_TARGET_DAYS=14,CALENDAR_MINIMUM_DAYS=7,CALENDAR_CRITICAL_DAYS=3;
const CALENDAR_DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
// Повторяет BASE из company-information: эти поля компании и есть источник эталонного профиля.
const PROFILE_BASE=Object.freeze({name:'name',city:'city',timezone:'timezone',phone:'phone',email:'email',websiteUrl:'website_url',socials:'socials'});
function calendarDay(value,label) {
  if(typeof value!=='string'||!CALENDAR_DATE_RE.test(value))fail(400,`${label}: укажите дату в формате ГГГГ-ММ-ДД`);
  const time=Date.parse(`${value}T00:00:00Z`);
  // Строгая проверка отсекает 2026-02-30 и 2025-02-29: несуществующий день нельзя молча сдвинуть.
  if(!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==value)fail(400,`${label}: такой даты не существует`);
  return {value,time};
}
function zoneFormatter(zone) {
  try{return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});}catch{return null;}
}
function zoneDay(formatter,instant) {
  if(!Number.isFinite(instant))return null;
  const parts=formatter.formatToParts(new Date(instant)),part=type=>parts.find(item=>item.type===type)?.value||'';
  const day=`${part('year')}-${part('month')}-${part('day')}`;
  return CALENDAR_DATE_RE.test(day)?day:null;
}
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
    ['content_revision','INTEGER NOT NULL DEFAULT 1'],['meta',"TEXT NOT NULL DEFAULT '{}'"],['sort_order','INTEGER NOT NULL DEFAULT 0'],
    ['partial_approved_revision','INTEGER'],['review_state',"TEXT NOT NULL DEFAULT 'draft'"],['review_comment',"TEXT NOT NULL DEFAULT ''"],['review_by_name','TEXT'],['review_at','TEXT']]){
    if(!postColumns.has(column))db.exec(`ALTER TABLE autoposting_posts ADD COLUMN ${column} ${type}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS autoposting_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,post_id INTEGER NOT NULL REFERENCES autoposting_posts(id),company_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('submitted','approved','rejected','revoked','edited','reordered','rescheduled')),
    content_revision INTEGER NOT NULL,comment TEXT NOT NULL DEFAULT '',actor_id INTEGER,actor_name TEXT,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS autoposting_reviews_post_idx ON autoposting_reviews(post_id,id);`);
  /* Подтверждения внешней публикации хранятся отдельно от доставок: правка содержимого удаляет доставки,
     но доказательства прежних выходов остаются навсегда. Идемпотентность — компания+карточка+площадка+ссылка. */
  db.exec(`CREATE TABLE IF NOT EXISTS autoposting_publication_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,company_id INTEGER NOT NULL REFERENCES companies(id),
    post_id INTEGER NOT NULL REFERENCES autoposting_posts(id),platform TEXT NOT NULL,url TEXT NOT NULL,
    published_at TEXT NOT NULL,content_revision INTEGER NOT NULL,note TEXT NOT NULL DEFAULT '',
    recorded_by INTEGER,recorded_by_name TEXT,recorded_at TEXT NOT NULL,
    UNIQUE(company_id,post_id,platform,url));
    CREATE INDEX IF NOT EXISTS autoposting_receipts_post_idx ON autoposting_publication_receipts(post_id,platform);`);
  /* Согласование по площадкам. Решение владельца хранится отдельно для каждого канала карточки
     и всегда привязано к версии содержимого: одобрение прежней версии к новой не относится.
     Карточки без записей здесь — прежняя модель «одно решение на карточку»; её решение
     переносится только на каналы, уже выбранные в карточке, и никогда на новые. */
  db.exec(`CREATE TABLE IF NOT EXISTS autoposting_platform_reviews (
    post_id INTEGER NOT NULL REFERENCES autoposting_posts(id),platform_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected')),
    content_revision INTEGER NOT NULL,comment TEXT NOT NULL DEFAULT '',actor_id INTEGER,actor_name TEXT,created_at TEXT NOT NULL,
    PRIMARY KEY(post_id,platform_id));
    CREATE INDEX IF NOT EXISTS autoposting_platform_reviews_post_idx ON autoposting_platform_reviews(post_id);`);
  /* Продолжение работы по оставшимся площадкам. Одна площадка исходной карточки может быть передана
     только одной активной дочерней карточке — это и есть защита от двойного нажатия и двух заданий в плане. */
  db.exec(`CREATE TABLE IF NOT EXISTS autoposting_split_links (
    source_post_id INTEGER NOT NULL REFERENCES autoposting_posts(id),platform_id TEXT NOT NULL,
    child_post_id INTEGER NOT NULL REFERENCES autoposting_posts(id),company_id INTEGER NOT NULL,
    source_content_revision INTEGER NOT NULL,created_at TEXT NOT NULL,created_by INTEGER,
    PRIMARY KEY(source_post_id,platform_id));
    CREATE INDEX IF NOT EXISTS autoposting_split_child_idx ON autoposting_split_links(child_post_id);`);
  const deliveryColumns=new Set(db.prepare('PRAGMA table_info(autoposting_deliveries)').all().map(row=>row.name));
  for(const column of ['provider_post_id','provider_status','provider_checked_at']){
    if(!deliveryColumns.has(column))db.exec(`ALTER TABLE autoposting_deliveries ADD COLUMN ${column} TEXT`);
  }
  const iso=()=>new Date(now()).toISOString();
  function transaction(work){db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
  const history=(row,action,comment,actor={})=>db.prepare('INSERT INTO autoposting_reviews(post_id,company_id,action,content_revision,comment,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(row.id,row.company_id,action,row.content_revision??1,comment||'',actor.userId??null,actor.userName??null,iso());
  const historyDto=id=>db.prepare('SELECT action,content_revision contentRevision,comment,actor_name actorName,created_at createdAt FROM autoposting_reviews WHERE post_id=? ORDER BY id DESC LIMIT 30').all(id);
  const metaOf=row=>{const m=JSON.parse(row.meta||'{}');return Object.fromEntries(META_FIELDS.map(k=>[k,m[k]??'']));};
  /* Подтверждения читаются как есть, без пересчёта статуса карточки: карточка остаётся черновиком,
     а площадка получает отдельную отметку «Опубликовано вне ЛК». stale — публикация другой версии содержимого. */
  const receiptsOf=row=>db.prepare(`SELECT id,platform,url,published_at publishedAt,content_revision contentRevision,note,
    recorded_by_name recordedByName,recorded_at recordedAt FROM autoposting_publication_receipts WHERE post_id=? ORDER BY published_at DESC,id DESC`).all(row.id)
    .map(item=>({...item,platformLabel:RECEIPT_PLATFORMS[item.platform]?.label||item.platform,stale:item.contentRevision!==row.content_revision}));
  const receiptPlatforms=postId=>new Set(db.prepare('SELECT DISTINCT platform FROM autoposting_publication_receipts WHERE post_id=?').all(postId).map(item=>item.platform));
  const channelPlatform=(channel,fallback='')=>channel?.platform||channel?.id||fallback;
  const PLATFORM_REVIEW_STATES={pending:'Ждёт согласования',approved:'Согласовано',rejected:'На доработку'};
  const platformIdsOf=row=>{try{const value=JSON.parse(row.platform_ids||'[]');return Array.isArray(value)?value:[];}catch{return [];}};
  const platformLabel=id=>CAPTION_PLATFORMS[id]?.label||RECEIPT_PLATFORMS[id]?.label||id;
  const platformReviewRows=postId=>db.prepare(`SELECT platform_id platformId,state,content_revision contentRevision,comment,actor_name byName,created_at at
    FROM autoposting_platform_reviews WHERE post_id=? ORDER BY platform_id`).all(postId);
  /* Перенос прежнего решения по карточке в пер-площадочные записи. Делается только для каналов,
     уже выбранных в карточке: новый канал получает отдельную запись «Ждёт согласования». */
  function materializePlatformReviews(row) {
    const existing=new Set(platformReviewRows(row.id).map(item=>item.platformId));
    const state=isApproved(row)?'approved':(row.review_state==='rejected'?'rejected':'pending');
    const contentRevision=(state==='approved'?row.approved_revision:null)??row.content_revision??1;
    for(const id of platformIdsOf(row)){
      if(existing.has(id))continue;
      db.prepare(`INSERT INTO autoposting_platform_reviews(post_id,platform_id,state,content_revision,comment,actor_id,actor_name,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(row.id,id,state,contentRevision,state==='rejected'?(row.review_comment||''):'',
        row.approved_by??null,row.approved_by_name??null,iso());
    }
  }
  /* Видимые статусы и причины по каналам. Одобрение считается действующим только для текущей версии содержимого. */
  function platformApprovals(row) {
    const stored=new Map(platformReviewRows(row.id).map(item=>[item.platformId,item]));
    const legacyApproved=isApproved(row);
    return platformIdsOf(row).map(id=>{
      const item=stored.get(id)||null;
      const state=item?item.state:(legacyApproved?'approved':(row.review_state==='rejected'?'rejected':'pending'));
      const contentRevision=(item?item.contentRevision:(legacyApproved?row.approved_revision:row.content_revision))??null;
      const approved=state==='approved'&&contentRevision===row.content_revision;
      return {platformId:id,platformLabel:platformLabel(id),state,stateLabel:PLATFORM_REVIEW_STATES[state]||state,approved,
        stale:state==='approved'&&!approved,contentRevision,
        comment:item?(item.comment||''):(state==='rejected'?(row.review_comment||''):''),
        byName:item?(item.byName||null):(row.review_by_name||null),at:item?(item.at||null):(row.review_at||null)};
    });
  }
  const setPlatformReview=(row,ids,state,comment,actor={})=>{
    for(const id of ids)db.prepare(`INSERT INTO autoposting_platform_reviews(post_id,platform_id,state,content_revision,comment,actor_id,actor_name,created_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(post_id,platform_id) DO UPDATE SET state=excluded.state,content_revision=excluded.content_revision,
      comment=excluded.comment,actor_id=excluded.actor_id,actor_name=excluded.actor_name,created_at=excluded.created_at`)
      .run(row.id,id,state,row.content_revision??1,comment||'',actor.userId??null,actor.userName??null,iso());
  };
  /* Какие каналы затрагивает решение. Поле не передано или пустое — все каналы карточки (прежнее поведение). */
  function requestedPlatforms(row,body) {
    const all=platformIdsOf(row);
    const value=body.platformIds;
    if(value===undefined||value===null)return all;
    if(!Array.isArray(value)||value.length>20)fail(400,'Допускается не более 20 каналов');
    const ids=value.map(id=>text(id,100,true));
    if(new Set(ids).size!==ids.length)fail(400,'Канал выбран дважды');
    // Явный пустой список — это не «все каналы», а ошибка выбора: наследование «все» действует
    // только когда поле вообще не передано.
    if(!ids.length)fail(400,'Отметьте хотя бы одну площадку');
    const unknown=ids.filter(id=>!all.includes(id));
    if(unknown.length)fail(400,`Эти каналы не выбраны в карточке: ${unknown.map(platformLabel).join(', ')}`);
    return ids;
  }
  /* Одно правило для всех путей отправки: отправляется только та доставка, для канала которой
     утверждена текущая версия содержимого. Карточка без каналов опирается на согласование карточки. */
  const deliveryApproved=(row,channelId)=>{
    if(!isQueueCard(row))return true;
    // Согласование версии обязательно, но оно бывает двух видов: карточка целиком (approved_revision)
    // или частичное — по отдельным каналам (partial_approved_revision). Общий отзыв снимает оба,
    // поэтому снятие approved_revision без частичного согласования останавливает все каналы.
    const versionApproved=isApproved(row)||(row.partial_approved_revision!==null&&row.partial_approved_revision!==undefined&&row.partial_approved_revision===row.content_revision);
    if(!versionApproved)return false;
    const platforms=platformApprovals(row);
    if(!platforms.length)return isApproved(row);
    return platforms.find(item=>item.platformId===channelId)?.approved===true;
  };
  const cancelDeliveries=(row,ids)=>{
    if(!ids.length)return;
    db.prepare(`UPDATE autoposting_deliveries SET status='cancelled' WHERE post_id=? AND status='pending' AND channel_id IN (${ids.map(()=>'?').join(',')})`).run(row.id,...ids);
  };
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
  /* Карточка считается согласованной целиком только если согласованы все её каналы этой же версии:
     иначе добавленный канал делал бы вид, что одобрение распространилось и на него. */
  function cardApprovalDto(row) {
    const base=approvalDto(row),platforms=platformApprovals(row);
    const approved=base.approved&&(platforms.length===0||platforms.every(item=>item.approved));
    return {...base,approved,platforms};
  }
  function dto(row,owner) {
    return {id:row.id,companyCode:owner.code.toLowerCase(),revision:row.revision,contentRevision:row.content_revision,status:row.status,title:row.title,text:row.text,
      mediaUrls:JSON.parse(row.media_urls),platformIds:JSON.parse(row.platform_ids),scheduledAt:row.scheduled_at,timezone:row.timezone,
      dayKey:row.day_key||'',captions:JSON.parse(row.captions||'{}'),origin:row.origin||'',readiness:readiness(row),approval:cardApprovalDto(row),platformApprovals:platformApprovals(row),
      mediaSha256:row.media_sha256||'',expectedMediaSha256:row.expected_media_sha256||'',expectedMediaFile:row.expected_media_file||'',externalId:row.external_id||'',
      externalReceipts:receiptsOf(row),
      continuedPlatforms:db.prepare('SELECT platform_id platformId,child_post_id childPostId,created_at createdAt FROM autoposting_split_links WHERE source_post_id=? ORDER BY platform_id').all(row.id)
        .map(item=>({...item,platformLabel:platformLabel(item.platformId)})),
      continuedFrom:db.prepare('SELECT source_post_id postId,source_content_revision contentRevision FROM autoposting_split_links WHERE child_post_id=? LIMIT 1').get(row.id)||null,
      meta:metaOf(row),sortOrder:row.sort_order||0,review:{state:row.review_state||'draft',stateLabel:REVIEW_STATES[row.review_state||'draft'],comment:row.review_comment||'',byName:row.review_by_name||null,at:row.review_at||null},
      history:historyDto(row.id),labels:{formats:FORMATS,roles:ROLES,reviewStates:REVIEW_STATES,platformReviewStates:PLATFORM_REVIEW_STATES},
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
    return {companyCode:owner.code.toLowerCase(),posts:db.prepare('SELECT * FROM autoposting_posts WHERE company_id=? ORDER BY sort_order ASC,created_at DESC,id DESC LIMIT 200').all(owner.id).map(row=>dto(row,owner))};
  }
  /* Календарь месяца — строго чтение. invalidate/get/list здесь недопустимы: они переводят карточки
     в needs_review и архивируют новую версию данных компании, то есть меняют состояние при просмотре.
     Из транспорта разрешено единственное действие — чтение настроек каналов: ни публикации,
     ни сверки с провайдером, ни очереди календарь не запускает. */
  const hasTable=name=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  function calendarRange(params) {
    const range=params===undefined||params===null?{}:params;
    object(range,['from','to']);
    const from=calendarDay(range.from,'Начало периода'),to=calendarDay(range.to,'Конец периода');
    if(to.time<from.time)fail(400,'Конец периода раньше начала');
    const length=Math.round((to.time-from.time)/86400000)+1;
    if(length>CALENDAR_MAX_RANGE_DAYS)fail(400,`Период календаря — не больше ${CALENDAR_MAX_RANGE_DAYS} дней`);
    const dates=[];
    for(let index=0;index<length;index++)dates.push(new Date(from.time+index*86400000).toISOString().slice(0,10));
    return {from:from.value,to:to.value,dates};
  }
  /* Версия профиля читается из company_information без вызова information.get: тот перед ответом
     архивирует изменения карточки компании. Если правка полей companies ещё не заархивирована,
     текущая версия профиля устарела — на неё нельзя опереться как на подтверждённую. */
  function calendarProfile(owner) {
    const info=db.prepare('SELECT revision FROM company_information WHERE company_id=?').get(owner.id);
    if(!info)return {revision:null,state:'missing'};
    const archived=db.prepare('SELECT profile FROM company_information_versions WHERE company_id=? AND revision=?').get(owner.id,info.revision);
    let saved=null;
    if(archived)try{saved=JSON.parse(archived.profile);}catch{saved=null;}
    if(!saved||typeof saved!=='object'||Array.isArray(saved))return {revision:info.revision,state:'missing'};
    const socials=(()=>{try{const value=JSON.parse(owner.socials);return Array.isArray(value)?value:[];}catch{return [];}})();
    const stale=Object.entries(PROFILE_BASE).some(([key,column])=>key==='socials'
      ?JSON.stringify(saved.socials??[])!==JSON.stringify(socials)
      :String(saved[key]??'')!==String(owner[column]??''));
    return {revision:info.revision,state:stale?'stale':'current'};
  }
  /* Текущий контент-план и расписки текущего переноса. Таблиц Медиа-наставника может не быть вовсе:
     тогда календарь честно работает без плановой основы, а не выдумывает её. */
  function calendarPlan(owner) {
    const blank={planRevision:null,planApproval:null,days:[],items:new Map()};
    if(!hasTable('media_mentor_plans'))return blank;
    const plan=db.prepare('SELECT revision,brief_revision briefRevision,plan FROM media_mentor_plans WHERE company_id=?').get(owner.id);
    if(!plan)return blank;
    let days=[];
    try{const parsed=JSON.parse(plan.plan);if(Array.isArray(parsed?.days))days=parsed.days.filter(day=>day&&CALENDAR_DATE_RE.test(day.date)&&typeof day.platform==='string'&&day.platform);}catch{days=[];}
    const brief=hasTable('media_mentor_briefs')?db.prepare('SELECT revision FROM media_mentor_briefs WHERE company_id=?').get(owner.id):null;
    const decision=hasTable('media_mentor_plan_approvals')?db.prepare(`SELECT decision,brief_revision briefRevision FROM media_mentor_plan_approvals
      WHERE company_id=? AND plan_revision=? ORDER BY id DESC LIMIT 1`).get(owner.id,plan.revision):null;
    // Согласование действительно только вместе с той версией брифа, которая сейчас текущая.
    const planApproval=!brief||plan.briefRevision!==brief.revision?'needs_reapproval'
      :!decision?'pending':decision.decision!=='approved'?'rejected'
        :decision.briefRevision!==brief.revision?'needs_reapproval':'approved';
    const items=new Map(),byIndex=new Map();
    // Только перенос ТЕКУЩЕЙ версии плана и только карточки той же компании: расписка прошлой версии
    // плановой даты карточке не даёт — её разбирают вручную.
    if(hasTable('media_mentor_plan_transfers')&&hasTable('media_mentor_plan_transfer_items')) {
      for(const row of db.prepare(`SELECT i.post_id postId,i.day_index dayIndex,i.plan_date planDate,i.plan_platform planPlatform
        FROM media_mentor_plan_transfer_items i
        JOIN media_mentor_plan_transfers t ON t.id=i.transfer_id
        JOIN media_mentor_plans p ON p.company_id=t.company_id AND p.revision=t.plan_revision
        JOIN autoposting_posts a ON a.id=i.post_id AND a.company_id=t.company_id
        WHERE t.company_id=?`).all(owner.id)){
        items.set(row.postId,{dayIndex:row.dayIndex,planDate:CALENDAR_DATE_RE.test(row.planDate)?row.planDate:null,planPlatform:row.planPlatform||null});
        // День плана закрывает именно та карточка, которую для него создал перенос.
        byIndex.set(row.dayIndex,row.postId);
      }
    }
    return {planRevision:plan.revision,planApproval,days,items,byIndex};
  }
  // Известные ограничения подключённой площадки. Файлы и сеть не проверяются: заявлять больше сохранённого нельзя.
  function capsIssues(channel,caption,mediaCount) {
    const caps=channel&&typeof channel.caps==='object'&&channel.caps?channel.caps:null,issues=[];
    if(!caps)return issues;
    if(Number.isFinite(caps.maxText)&&caption.length>caps.maxText)issues.push(`Текст длиннее лимита площадки (${caps.maxText})`);
    if(Number.isFinite(caps.maxMedia)&&mediaCount>caps.maxMedia)issues.push(`Материалов больше, чем принимает площадка (${caps.maxMedia})`);
    if(Number.isFinite(caps.maxCaption)&&mediaCount&&caption.length>caps.maxCaption)issues.push(`Подпись к материалу длиннее лимита площадки (${caps.maxCaption})`);
    return issues;
  }
  /* Готовность для календаря считается консервативно и по площадкам: готово только то, что
     действительно можно отправить сейчас — есть материал, подпись именно для этой площадки,
     подключённый выбранный канал, одобрение текущей версии содержимого и текущая версия данных компании.
     Уже опубликованное и отмеченное расписками не считается запасом на будущее. */
  function calendarReadiness(row,link,context,effectiveDate) {
    const base=readiness(row),caps=JSON.parse(row.captions||'{}'),media=JSON.parse(row.media_urls||'[]');
    const selected=JSON.parse(row.platform_ids||'[]'),approved=isApproved(row);
    // Готовность считается по каждой площадке отдельно: одобрение прежних каналов не распространяется
    // на добавленный, а общий отзыв версии снимает готовность со всех.
    const approvalByPlatform=new Map(platformApprovals(row).map(item=>[item.platformId,item.approved]));
    // Площадка, работа по которой передана в продолжение, закрыта на исходнике: иначе один и тот же
    // канал считался бы готовым дважды — и здесь, и в дочерней карточке.
    const handedOver=new Map(db.prepare('SELECT platform_id platformId,child_post_id childPostId FROM autoposting_split_links WHERE source_post_id=?')
      .all(row.id).map(item=>[item.platformId,item.childPostId]));
    const receipts=context.receipts.get(row.id)||new Map(),deliveries=context.deliveries.get(row.id)||new Map();
    const common=[...base.issues];
    if(!effectiveDate)common.push('Дата публикации не определена');
    if(media.some(value=>!publicUrl(value)))common.push('Для публикации нужны доступные площадке HTTPS-ссылки на материалы');
    if(context.profile.state==='missing')common.push('Данные компании ещё не зафиксированы: откройте карточку компании');
    else if(context.profile.state==='stale')common.push('Карточка компании изменилась и ещё не зафиксирована новой версией: откройте данные компании');
    else if(row.profile_revision!==context.profile.revision)common.push('Текст написан по прежней версии данных компании');
    if(!context.channelsKnown)common.push('Настройки каналов сейчас недоступны: готовность не подтверждена');
    // Карточка из переноса непересогласованного плана готовой считаться не может.
    if(link&&context.planApproval&&context.planApproval!=='approved'&&context.planApproval!=='pending')
      common.push('Контент-план изменился и требует повторного согласования');
    const soft=[];
    if(!approved&&!approvalByPlatform.size)soft.push('Эта версия содержимого ещё не одобрена владельцем');
    if(link&&context.planApproval==='pending')soft.push('Версия контент-плана ещё не согласована');
    const platforms=new Map();
    for(const id of selected){
      const channel=context.channelById.get(id),platform=channelPlatform(channel,id),hard=[...common];
      // Несогласованность — это ожидание решения владельца, а не нехватка материала: мягкое замечание,
      // и оно относится к конкретной площадке. Прежняя модель (записей по площадкам нет) — общее замечание выше.
      const softLocal=[...soft];
      if(approvalByPlatform.size&&!approvalByPlatform.get(id))softLocal.push('Эта версия ещё не одобрена владельцем для этой площадки');
      if(!channel)hard.push(`Канал «${id}» не настроен в подключениях`);
      else{
        if(!channel.enabled)hard.push(`Канал «${channel.name||id}» выключен`);
        if(!channel.connected)hard.push(`Канал «${channel.name||id}» не подключён`);
        if(channel.caps?.mediaMode==='photos'&&channel.provider!=='onlypult'&&media.some(value=>VIDEO_RE.test(value)))
          hard.push('Подключение отправляет фотографии: для видео нужен подходящий способ публикации');
      }
      const caption=caps[platform]||row.text||'';
      if(!caption)hard.push(`Для площадки ${platform} нет ни подписи, ни общего текста`);
      hard.push(...capsIssues(channel,caption,media.length));
      const delivery=deliveries.get(id),extra=[];
      if(delivery&&channel&&delivery.channelRevision!==channel.revision)
        hard.push('Подключение площадки изменилось после постановки в очередь');
      if(delivery?.status==='cancelled')hard.push('Отправка на площадку отменена');
      let state;
      if(row.status==='cancelled'){state='inactive';extra.push('Карточка отменена');}
      else if(handedOver.has(id)){state='inactive';extra.push(`Работа по этой площадке продолжена в материале №${handedOver.get(id)}: здесь она в запас не идёт`);}
      else if(receipts.get(platform)){state='published';extra.push('Площадка отмечена как опубликованная вне ЛК: повторная отправка создаст дубликат');}
      else if(receipts.has(platform)){state='missing';extra.push('Опубликована другая версия содержимого: проверьте её перед повторной отправкой');}
      // Опубликованность — свойство площадки, а не карточки: чужая успешная отправка не делает этот канал опубликованным.
      else if(delivery?.status==='published'||(!deliveries.size&&row.status==='published')){state='published';extra.push('Уже опубликовано на этой площадке');}
      else if(delivery?.status==='publishing'||row.status==='publishing'){state='pending';extra.push('Отправка выполняется');}
      else if(['failed','needs_review'].includes(delivery?.status)||['failed','needs_review'].includes(row.status)){
        state='missing';extra.push(`Нужна проверка результата на площадке${row.last_error_code?` (${row.last_error_code})`:''}`);
      }
      else state=hard.length?'missing':softLocal.length?'pending':'ready';
      const issues=[...new Set(state==='published'||state==='inactive'?extra:[...extra,...hard,...softLocal])];
      const previous=platforms.get(platform);
      if(previous){previous.issues=[...new Set([...previous.issues,...issues])];if(previous.state==='ready'&&state!=='ready'){previous.state=state;previous.ready=false;}continue;}
      platforms.set(platform,{platform,state,ready:state==='ready',issues});
    }
    // Площадка плана есть, а канал под неё не выбран: слот не закрыт, и выдавать его готовым нельзя.
    for(const platform of new Set([...receipts.keys(),link?.planPlatform].filter(Boolean))){
      if(platforms.has(platform))continue;
      const state=row.status==='cancelled'?'inactive':receipts.get(platform)?'published':'missing';
      const issues=state==='inactive'?['Карточка отменена']:state==='published'
        ?['Текущая версия отмечена как опубликованная вне ЛК: повторная отправка создаст дубликат']
        :[...new Set([...common,...soft,receipts.has(platform)
          ?'Опубликована другая версия содержимого: проверьте её перед повторной отправкой'
          :`Площадка плана «${platform}» не выбрана в карточке`])];
      platforms.set(platform,{platform,state,ready:false,issues});
    }
    const list=[...platforms.values()];
    // Закрытые площадки (отменённые или переданные в продолжение) в итог карточки не входят:
    // иначе карточка без единой работающей площадки выглядела бы готовой и попадала в запас.
    const active=list.filter(item=>item.state!=='inactive');
    let state;
    if(row.status==='cancelled')state='inactive';
    else if(!list.length)state='missing';
    else if(!active.length)state='inactive';
    else if(active.every(item=>item.state==='published'))state='published';
    else if(active.some(item=>item.state==='missing'))state='missing';
    else if(active.some(item=>item.state==='pending'))state='pending';
    else if(active.some(item=>item.state==='ready'))state='ready';
    else state='missing';
    const issues=list.length?list.flatMap(item=>item.issues)
      :state==='inactive'?['Карточка отменена']:[...common,...soft,'Каналы публикации не выбраны'];
    return {state,ready:state==='ready',issues:[...new Set(issues)],platforms:list};
  }
  async function calendar(code,params) {
    const range=calendarRange(params);
    company(db,code);
    // Настройки каналов — единственное обращение к транспорту и единственное ожидание.
    let settings=null,channelsKnown=true;
    try{settings=await transport.getSettings(code);}catch{settings=null;channelsKnown=false;}
    if(settings&&!Array.isArray(settings.channels))channelsKnown=false;
    // После ожидания состояние читается заново: компания, карточки и план могли измениться.
    const owner=company(db,code);
    let formatter=owner.timezone?zoneFormatter(owner.timezone):null;
    const zone=formatter?owner.timezone:'UTC';
    if(!formatter)formatter=zoneFormatter('UTC');
    const today=zoneDay(formatter,now());
    const profile=calendarProfile(owner),plan=calendarPlan(owner);
    const channels=Array.isArray(settings?.channels)?settings.channels:[];
    const channelById=new Map(channels.filter(channel=>channel&&typeof channel.id==='string').map(channel=>[channel.id,channel]));
    const deliveries=new Map();
    for(const item of db.prepare(`SELECT d.post_id postId,d.channel_id channelId,d.status,d.channel_revision channelRevision FROM autoposting_deliveries d
      JOIN autoposting_posts p ON p.id=d.post_id WHERE p.company_id=?`).all(owner.id)){
      if(!deliveries.has(item.postId))deliveries.set(item.postId,new Map());
      deliveries.get(item.postId).set(item.channelId,{status:item.status,channelRevision:item.channelRevision});
    }
    const receipts=new Map();
    for(const item of db.prepare(`SELECT r.post_id postId,r.platform,r.content_revision receiptRevision,p.content_revision contentRevision
      FROM autoposting_publication_receipts r JOIN autoposting_posts p ON p.id=r.post_id AND p.company_id=r.company_id
      WHERE r.company_id=?`).all(owner.id)){
      if(!receipts.has(item.postId))receipts.set(item.postId,new Map());
      const platforms=receipts.get(item.postId);
      platforms.set(item.platform,Boolean(platforms.get(item.platform)||item.receiptRevision===item.contentRevision));
    }
    const context={profile,channelById,channelsKnown,planApproval:plan.planApproval,deliveries,receipts};
    /* Сначала по минимальным полям считаются даты всех карточек компании, и только отобранные
       читаются целиком: иначе ответ рос бы вместе с архивом компании. Дата дня плана берётся
       из расписки переноса, а не выводится из D1…D7 — это разные вещи. */
    const index=db.prepare('SELECT id,scheduled_at scheduledAt,sort_order sortOrder,created_at createdAt FROM autoposting_posts WHERE company_id=?').all(owner.id);
    const within=new Set(range.dates),dated=[],undated=[];
    for(const row of index){
      const link=plan.items.get(row.id)||null;
      const publishDate=row.scheduledAt?zoneDay(formatter,Date.parse(row.scheduledAt)):null;
      const plannedDate=link?link.planDate:null;
      // Назначенное время отправки важнее плановой даты: карточку уже поставили на конкретный день.
      const effectiveDate=publishDate||plannedDate||null;
      const entry={...row,link,plannedDate,planPlatform:link?link.planPlatform:null,publishDate,effectiveDate,
        dateKind:publishDate?'schedule':plannedDate?'plan':null};
      if(effectiveDate===null)undated.push(entry);
      else if(within.has(effectiveDate))dated.push(entry);
    }
    const order=(a,b)=>(a.sortOrder-b.sortOrder)||(a.createdAt<b.createdAt?1:a.createdAt>b.createdAt?-1:0)||(b.id-a.id);
    dated.sort((a,b)=>(a.effectiveDate<b.effectiveDate?-1:a.effectiveDate>b.effectiveDate?1:0)||order(a,b));
    undated.sort(order);
    const full=db.prepare('SELECT * FROM autoposting_posts WHERE id=?');
    const view=entry=>{
      const row=full.get(entry.id);
      return {...dto(row,owner),plannedDate:entry.plannedDate,planPlatform:entry.planPlatform,publishDate:entry.publishDate,
        effectiveDate:entry.effectiveDate,dateKind:entry.dateKind,calendarReadiness:calendarReadiness(row,entry.link,context,entry.effectiveDate)};
    };
    // Карточки с датой отдаются все: период ограничен сам по себе. Запас без даты ограничен и честно помечен.
    const posts=dated.map(view),undatedPosts=undated.slice(0,CALENDAR_UNDATED_LIMIT).map(view);
    const planned=new Map();
    for(const day of plan.days){
      if(!within.has(day.date))continue;
      if(!planned.has(day.date))planned.set(day.date,new Map());
      const byPlatform=planned.get(day.date);
      // Два одинаковых слота одного дня — это два материала, а не один.
      byPlatform.set(day.platform,(byPlatform.get(day.platform)||0)+1);
    }
    const groups=new Map();
    for(const post of posts)for(const item of post.calendarReadiness.platforms){
      const key=`${post.effectiveDate}|${item.platform}`;
      if(!groups.has(key))groups.set(key,[]);
      // Слот плана закрывает только карточка того же переноса с той же датой и площадкой.
      groups.get(key).push({id:post.id,state:item.state,planMatch:Boolean(post.plannedDate===post.effectiveDate&&post.planPlatform===item.platform)});
    }
    const uncoveredDates=[],unknownDates=[];
    let knownPlanDays=0,coveredPlanDays=0;
    const days=range.dates.map(date=>{
      const byPlatform=planned.get(date)||new Map();
      const names=new Set([...byPlatform.keys()]);
      for(const key of groups.keys())if(key.startsWith(`${date}|`))names.add(key.slice(date.length+1));
      let covered=true,planTotal=0;
      const platforms=[...names].sort().map(platform=>{
        const count=byPlatform.get(platform)||0,members=groups.get(`${date}|${platform}`)||[];
        // Отменённая карточка слот не занимает: он снова пустой, а не «уже чем-то закрыт».
        const matches=members.filter(member=>member.planMatch&&member.state!=='inactive');
        const closed=matches.filter(member=>member.state==='ready'||member.state==='published').length;
        const tally=state=>members.filter(member=>member.state===state).length;
        planTotal+=count;
        if(count&&closed<count)covered=false;
        return {platform,planned:count,ready:tally('ready'),
          // Незакрытый слот плана — это нехватка материала, даже если в этот день лежит чужая карточка.
          missing:tally('missing')+Math.max(0,count-matches.length),pending:tally('pending'),published:tally('published'),
          postIds:members.map(member=>member.id)};
      });
      // День без слотов плана остаётся неизвестным: запас карточек планом не является.
      if(!planTotal)unknownDates.push(date);
      else{knownPlanDays++;if(covered)coveredPlanDays++;else uncoveredDates.push(date);}
      return {date,platforms};
    });
    const counted=state=>posts.filter(post=>post.calendarReadiness.state===state).length;
    return {companyCode:owner.code.toLowerCase(),from:range.from,to:range.to,timezone:zone,today,posts,undated:undatedPosts,
      truncated:false,undatedTruncated:undated.length>CALENDAR_UNDATED_LIMIT,undatedTotal:undated.length,
      coverage:{basis:plan.planRevision?'current_plan':'none',planRevision:plan.planRevision,planApproval:plan.planApproval,
        // Гарантий по числу дней календарь не даёт: он показывает только то, что действительно есть.
        guaranteedDays:null,days,uncoveredDates,unknownDates},
      // Счётчики карточек относятся к датам запрошенного периода; запас без даты отдельно — undatedTotal.
      summary:{targetDays:CALENDAR_TARGET_DAYS,minimumDays:CALENDAR_MINIMUM_DAYS,criticalBelowDays:CALENDAR_CRITICAL_DAYS,
        readyPosts:counted('ready'),pendingPosts:counted('pending'),missingPosts:counted('missing'),
        knownPlanDays,coveredPlanDays,stockDays:null}};
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
      else if(META_FIELDS.includes(key))result.meta={...(result.meta||{}),...meta({[key]:value})};
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
    const data=normalized(body,{title:'',text:'',mediaUrls:[],platformIds:[],scheduledAt:null,timezone:current.profile.timezone||'UTC',profileRevision:current.revision,dayKey:'',captions:{},origin:'',mediaSha256:'',meta:{}});
    if(data.profileRevision!==current.revision)fail(409,'Данные компании изменились','PROFILE_CHANGED');
    const time=iso(),order=(db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM autoposting_posts WHERE company_id=?').get(owner.id).m||0)+1;
    const id=db.prepare(`INSERT INTO autoposting_posts(company_id,title,text,media_urls,platform_ids,scheduled_at,timezone,profile_revision,created_at,updated_at,created_by,day_key,captions,origin,media_sha256,meta,sort_order)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(owner.id,data.title,data.text,JSON.stringify(data.mediaUrls),JSON.stringify(data.platformIds),data.scheduledAt,data.timezone,data.profileRevision,time,time,actorId,data.dayKey,JSON.stringify(data.captions),data.origin,data.mediaSha256,JSON.stringify(data.meta||{}),order).lastInsertRowid;
    return get(Number(id),code);
  }
  function update(id,code,body,actor={}) {
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
      const nextMeta=JSON.stringify({...metaOf(row),...(data.meta||{})});
      // Содержимое = текст, подписи, материал, день, происхождение, метаданные. Плановая дата и часовой пояс — не содержимое:
      // их смена не сбрасывает согласование и не активирует отправку (запланированная карточка при этом возвращается в черновик).
      const contentChanged=data.title!==row.title||data.text!==row.text||JSON.stringify(data.mediaUrls)!==row.media_urls||data.dayKey!==(row.day_key||'')
        ||JSON.stringify(data.captions)!==(row.captions||'{}')||data.origin!==(row.origin||'')||mediaSha!==(row.media_sha256||'')||nextMeta!==JSON.stringify(metaOf(row));
      const queue=isQueueCard(row)||isQueueCard({day_key:data.dayKey,captions:JSON.stringify(data.captions)});
      const nextReview=contentChanged?(queue?'pending':'draft'):row.review_state||'draft';
      db.prepare(`UPDATE autoposting_posts SET title=?,text=?,media_urls=?,platform_ids=?,scheduled_at=?,timezone=?,profile_revision=?,day_key=?,captions=?,origin=?,media_sha256=?,meta=?,
        status='draft',revision=revision+1,content_revision=content_revision+?,review_state=?,review_comment=CASE WHEN ? THEN '' ELSE review_comment END,updated_at=?,last_error_code=NULL WHERE id=?`)
        .run(data.title,data.text,JSON.stringify(data.mediaUrls),JSON.stringify(data.platformIds),data.scheduledAt,data.timezone,data.profileRevision,data.dayKey,JSON.stringify(data.captions),data.origin,mediaSha,nextMeta,
          contentChanged?1:0,nextReview,contentChanged?1:0,iso(),row.id);
      db.prepare('DELETE FROM autoposting_deliveries WHERE post_id=?').run(row.id);
      // Согласование по каналам: снятые каналы забываются, новые заводятся как «Ждёт согласования»
      // и прежнее одобрение на них не переносится; общая правка содержимого возвращает на согласование все каналы.
      materializePlatformReviews(row);
      const prevIds=platformIdsOf(row),nextIds=data.platformIds,nextContentRevision=(row.content_revision??1)+(contentChanged?1:0);
      const removed=prevIds.filter(id=>!nextIds.includes(id));
      if(removed.length)db.prepare(`DELETE FROM autoposting_platform_reviews WHERE post_id=? AND platform_id IN (${removed.map(()=>'?').join(',')})`).run(row.id,...removed);
      if(contentChanged)db.prepare("UPDATE autoposting_platform_reviews SET state='pending',content_revision=?,comment='',actor_id=?,actor_name=?,created_at=? WHERE post_id=?")
        .run(nextContentRevision,actor.userId??null,actor.userName??null,iso(),row.id);
      for(const id of nextIds.filter(id=>!prevIds.includes(id)))
        db.prepare(`INSERT INTO autoposting_platform_reviews(post_id,platform_id,state,content_revision,comment,actor_id,actor_name,created_at)
          VALUES(?,?,'pending',?,'',?,?,?)`).run(row.id,id,nextContentRevision,actor.userId??null,actor.userName??null,iso());
      // Добавление канала не меняет содержимое, но снимает согласование карточки целиком: новый канал не согласован.
      // Согласование карточки держится в согласии с каналами. Все каналы согласованы для этой версии —
      // карточка согласована целиком (например, снят единственный несогласованный канал). Иначе снимается
      // только видимый статус: approved_revision сохраняется как свидетельство прежнего решения (stale).
      const afterEdit=platformApprovals(db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(row.id));
      if(afterEdit.length&&afterEdit.every(item=>item.approved))
        db.prepare(`UPDATE autoposting_posts SET approved_revision=(SELECT content_revision FROM autoposting_posts WHERE id=?),
          partial_approved_revision=NULL,approved_at=COALESCE(approved_at,?),review_state='approved' WHERE id=?`).run(row.id,iso(),row.id);
      else if(afterEdit.some(item=>!item.approved))
        db.prepare(`UPDATE autoposting_posts SET partial_approved_revision=CASE WHEN ?=1 THEN (SELECT content_revision FROM autoposting_posts WHERE id=?) ELSE NULL END,
          review_state=CASE WHEN review_state='approved' THEN 'pending' ELSE review_state END WHERE id=?`)
          .run(afterEdit.some(item=>item.approved)?1:0,row.id,row.id);
      const fresh=db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(row.id);
      if(contentChanged)history(fresh,'edited',queue?'Возвращено на согласование после правки':'',actor);
      else if(data.scheduledAt!==row.scheduled_at||data.timezone!==row.timezone)history(fresh,'rescheduled',`План: ${data.scheduledAt||'—'} ${data.timezone}`,actor);
    });return get(id,code);
  }
  async function schedule(id,code,body) {
    // platformIds не обязателен: без него в план идут все каналы карточки, как раньше. С ним — только указанные,
    // а остальные остаются в карточке со своими статусами и просто не отправляются.
    object(body,['revision','scheduledAt','timezone','profileRevision','platformIds']);revision(body.revision);
    const settings=await transport.getSettings(code),current=invalidate(code);
    transaction(()=>{
      const {row,owner}=rowFor(id,code);
      if(row.revision!==body.revision)fail(409,'Публикация уже изменена','REVISION_CONFLICT');
      if(!['draft','failed','cancelled','needs_review'].includes(row.status))fail(409,'Публикация уже запланирована или отправляется','POST_STATE');
      if(db.prepare("SELECT 1 FROM autoposting_deliveries WHERE post_id=? AND status IN ('publishing','published','needs_review')").get(row.id))fail(409,'Проверьте результат на площадке перед повторной отправкой','PUBLICATION_REVIEW_REQUIRED');
      const data=normalized(body,dto(row,owner));
      if(Object.hasOwn(body,'platformIds'))data.platformIds=requestedPlatforms(row,body);
      if(data.profileRevision!==current.revision||row.profile_revision!==current.revision)fail(409,'Пересмотрите текст по новой версии компании','PROFILE_CHANGED');
      const captionsByPlatform=JSON.parse(row.captions||'{}');
      if((!data.text&&!Object.keys(captionsByPlatform).length)||!data.platformIds.length)fail(400,'Добавьте текст и выберите каналы');
      // Карточки очереди контента (день или подписи площадок) ставятся в план только с одобрением именно этой версии.
      // Отправляется только утверждённая текущая версия, и только на те каналы, для которых она утверждена.
      if(isQueueCard(row)){
        materializePlatformReviews(row);
        const states=new Map(platformApprovals(row).map(item=>[item.platformId,item]));
        const waiting=data.platformIds.filter(id=>!states.get(id)?.approved);
        if(waiting.length)fail(409,`Сначала одобрите эту версию для каналов: ${waiting.map(platformLabel).join(', ')}`,'APPROVAL_REQUIRED');
      }
      if(!data.scheduledAt||Date.parse(data.scheduledAt)<=now())fail(400,'Выберите время публикации в будущем');
      const channels=data.platformIds.map(id=>settings.channels.find(channel=>channel.id===id));
      // Площадка, отмеченная как опубликованная вне ЛК, повторно не отправляется: это создало бы дубликат записи.
      const marked=receiptPlatforms(row.id);
      const blocked=data.platformIds.filter((id,index)=>marked.has(channelPlatform(channels[index],id)));
      if(blocked.length)fail(409,`Уже отмечено как опубликованное вне ЛК: ${blocked.join(', ')}. Повторная отправка создаст дубликат.`,'EXTERNAL_PUBLICATION_RECORDED');
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
    object(body,['revision','approved','comment','platformIds']);revision(body.revision);
    if(typeof body.approved!=='boolean')fail(400,'Укажите approved: true или false');
    return transaction(()=>{
      const {row,owner}=rowFor(id,code);
      if(row.revision!==body.revision)fail(409,'Публикация уже изменена','REVISION_CONFLICT');
      if(body.approved){
        const state=readiness(row);
        if(!state.ready)fail(409,`Материал не готов: ${state.issues.join('; ')}`,'NOT_READY');
        if(['publishing','published'].includes(row.status))fail(409,'Публикацию уже отправляют или опубликовали','POST_STATE');
        materializePlatformReviews(row);
        const ids=requestedPlatforms(row,body);
        setPlatformReview(row,ids,'approved','',actor);
        // Карточка целиком считается согласованной только когда согласованы все её каналы этой же версии.
        // Карточка без выбранных каналов согласуется как содержимое; добавленный позже канал всё равно ждёт согласования.
        const everyApproved=platformApprovals(row).every(item=>item.approved);
        if(everyApproved)db.prepare(`UPDATE autoposting_posts SET approved_revision=?,partial_approved_revision=NULL,approved_at=?,approved_by=?,approved_by_name=?,review_state='approved',review_comment='',review_by_name=?,review_at=?,revision=revision+1,updated_at=? WHERE id=?`)
          .run(row.content_revision,iso(),actor.userId??null,actor.userName??null,actor.userName??null,iso(),iso(),row.id);
        else db.prepare(`UPDATE autoposting_posts SET approved_revision=NULL,partial_approved_revision=?,approved_at=NULL,approved_by=NULL,approved_by_name=NULL,review_state='pending',review_comment='',review_by_name=?,review_at=?,revision=revision+1,updated_at=? WHERE id=?`)
          .run(row.content_revision,actor.userName??null,iso(),iso(),row.id);
        history(row,'approved',text(body.comment??'',2000),actor);
      }else{
        // Отзыв одобрения останавливает ещё не начатую отправку: запланированная карточка возвращается в черновик.
        if(row.status==='publishing')fail(409,'Отправка уже началась: дождитесь результата, затем снимите с публикации','POST_STATE');
        materializePlatformReviews(row);
        const ids=requestedPlatforms(row,body);
        setPlatformReview(row,ids,'pending','',actor);
        cancelDeliveries(row,ids);
        // Остались ли согласованные каналы: если нет — это общий отзыв версии, частичное согласование тоже снимается.
        const stillApproved=platformApprovals(row).some(item=>item.approved)?row.content_revision:null;
        db.prepare(`UPDATE autoposting_posts SET approved_revision=NULL,partial_approved_revision=?,approved_at=NULL,approved_by=NULL,approved_by_name=NULL,review_state='pending',review_by_name=?,review_at=?,revision=revision+1,updated_at=?,
          status=CASE WHEN status='scheduled' THEN 'draft' ELSE status END,last_error_code=CASE WHEN status='scheduled' THEN 'APPROVAL_REVOKED' ELSE last_error_code END WHERE id=?`).run(stillApproved,actor.userName??null,iso(),iso(),row.id);
        history(row,'revoked',text(body.comment??'',2000),actor);
      }
      return dto(db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(row.id),owner);
    });
  }
  /* Подтверждение внешней публикации. Владелец сообщает: эта версия содержимого уже вышла на площадке
     через внешний сервис или нативный интерфейс. Провайдер не вызывается, ничего не отправляется,
     статус карточки и одобрение не меняются — фиксируется только доказательство со ссылкой и временем. */
  /* Расписка по площадке, работа по которой передана в продолжение, ставится на самом продолжении:
     иначе исходник «закрывает» канал, а дочерняя карточка об этом не знает и отправляет повторно. */
  function receiptHandedOver(row,platform) {
    const link=db.prepare('SELECT child_post_id childPostId FROM autoposting_split_links WHERE source_post_id=? AND platform_id=?').get(row.id,platform);
    if(link)fail(409,`Работа по площадке ${platformLabel(platform)} продолжена в материале №${link.childPostId}. Отметьте публикацию там, иначе продолжение отправит её ещё раз.`,'SPLIT_HANDED_OVER');
  }
  function recordReceipt(id,code,body,actor={}) {
    object(body,['platform','url','publishedAt','contentRevision','note']);
    if(typeof body.platform!=='string'||!Object.hasOwn(RECEIPT_PLATFORMS,body.platform))
      fail(400,'Площадка подтверждения: instagram, tiktok, youtube_shorts, vk или telegram');
    const platform=body.platform,link=receiptUrl(platform,body.url),publishedAt=utcDate(body.publishedAt);
    // Запланированное не считается опубликованным: дата выхода в будущем — это план, а не доказательство.
    if(Date.parse(publishedAt)>now())fail(400,'Дата публикации в будущем: запланированная запись ещё не опубликована','NOT_PUBLISHED_YET');
    const note=text(body.note??'',500);
    return transaction(()=>{
      const {row,owner}=rowFor(id,code);
      if(!Number.isSafeInteger(body.contentRevision)||body.contentRevision<1)fail(400,'Укажите версию содержимого, которая опубликована');
      if(body.contentRevision!==row.content_revision)
        fail(409,'Содержимое карточки изменилось: подтверждайте ту версию, которая действительно опубликована','CONTENT_REVISION_CONFLICT');
      receiptHandedOver(row,platform);
      // Повтор того же подтверждения (компания+карточка+площадка+ссылка) возвращает прежнюю запись и не плодит историю.
      const existing=db.prepare('SELECT id FROM autoposting_publication_receipts WHERE company_id=? AND post_id=? AND platform=? AND url=?')
        .get(owner.id,row.id,platform,link);
      if(!existing)db.prepare(`INSERT INTO autoposting_publication_receipts(company_id,post_id,platform,url,published_at,content_revision,note,recorded_by,recorded_by_name,recorded_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(owner.id,row.id,platform,link,publishedAt,row.content_revision,note,actor.userId??null,actor.userName??null,iso());
      return {created:!existing,post:dto(db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(row.id),owner)};
    });
  }
  /* Безопасный импорт пакета карточек: только черновики, без одобрения и без публикации; ссылки на медиа — как переданы,
     отсутствующее видео не выдумывается. Повтор пакета с теми же день+название не создаёт дублей. */
  /* Пакет материалов (schemaVersion 1, как готовит владелец): день числом, подписи объектами {text,account}, YouTube {title,text},
     media {file, poster, sha256, publicUrl, origin}. Приводится к карточке; одобрение пакета игнорируется — одобряет только владелец в ЛК. */
  function packageItem(item) {
    object(item,['id','day','title','revision','status','approval','scheduledAt','timezone','durationSeconds','width','height','media','captions','cta','dayKey','text','mediaUrls','origin','platformIds','meta']);
    const out={};
    if(item.meta!==undefined&&item.meta!==null)Object.assign(out,meta(item.meta));
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
        const data=normalized(item,{title:'',text:'',mediaUrls:[],platformIds:[],scheduledAt:null,timezone:current.profile.timezone||'UTC',profileRevision:current.revision,dayKey:'',captions:{},origin:'import',mediaSha256:'',meta:{}});
        if(!data.title)fail(400,'У карточки пакета нет названия');
        const expectedSha=item.expectedMediaSha256||'',expectedFile=item.expectedMediaFile||'',externalId=item.externalId||'';
        const duplicate=(externalId&&db.prepare("SELECT id FROM autoposting_posts WHERE company_id=? AND external_id=? AND status<>'cancelled' ORDER BY id LIMIT 1").get(owner.id,externalId))
          ||db.prepare("SELECT id FROM autoposting_posts WHERE company_id=? AND day_key=? AND title=? AND status<>'cancelled' ORDER BY id LIMIT 1").get(owner.id,data.dayKey,data.title);
        if(duplicate){skipped.push({id:duplicate.id,dayKey:data.dayKey,title:data.title,externalId});continue;}
        const time=iso(),order=(db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM autoposting_posts WHERE company_id=?').get(owner.id).m||0)+1;
        const id=db.prepare(`INSERT INTO autoposting_posts(company_id,title,text,media_urls,platform_ids,scheduled_at,timezone,profile_revision,created_at,updated_at,created_by,day_key,captions,origin,expected_media_sha256,expected_media_file,external_id,meta,sort_order,review_state)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft')`).run(owner.id,data.title,data.text,JSON.stringify(data.mediaUrls),JSON.stringify(data.platformIds),data.scheduledAt,data.timezone,data.profileRevision,time,time,actorId,data.dayKey,JSON.stringify(data.captions),data.origin||'import',expectedSha,expectedFile,externalId,JSON.stringify(data.meta||{}),order).lastInsertRowid;
        const view=dto(db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(id),owner);
        created.push(view);
        if(!data.mediaUrls.length)mediaPending.push({id:view.id,dayKey:view.dayKey,title:view.title,file:expectedFile,sha256:expectedSha});
      }
      return {created,skipped,mediaPending,companyCode:owner.code.toLowerCase(),approved:0,published:0};
    });
  }
  /* Отклонение — только владелец, комментарий обязателен; автор, время и текст сохраняются в истории и на карточке.
     Запланированная карточка при отклонении снимается с плана. */
  function reject(id,code,body,actor={}) {
    object(body,['revision','comment','platformIds']);revision(body.revision);
    const comment=text(body.comment,2000,true);
    return transaction(()=>{
      const {row,owner}=rowFor(id,code);
      if(row.revision!==body.revision)fail(409,'Публикация уже изменена','REVISION_CONFLICT');
      if(['publishing','published'].includes(row.status))fail(409,'Публикацию уже отправляют или опубликовали','POST_STATE');
      materializePlatformReviews(row);
      const rejected=requestedPlatforms(row,body);
      setPlatformReview(row,rejected,'rejected',comment,actor);
      cancelDeliveries(row,rejected);
      const stillApprovedAfterReject=platformApprovals(row).some(item=>item.approved)?row.content_revision:null;
      db.prepare(`UPDATE autoposting_posts SET approved_revision=NULL,partial_approved_revision=?,approved_at=NULL,approved_by=NULL,approved_by_name=NULL,review_state='rejected',review_comment=?,review_by_name=?,review_at=?,
        revision=revision+1,updated_at=?,status=CASE WHEN status='scheduled' THEN 'draft' ELSE status END,last_error_code=CASE WHEN status='scheduled' THEN 'APPROVAL_REVOKED' ELSE last_error_code END WHERE id=?`)
        .run(stillApprovedAfterReject,comment,actor.userName??null,iso(),iso(),row.id);
      // Комментарий владельца сохраняется дословно; какие каналы затронуты — в autoposting_platform_reviews.
      history(row,'rejected',comment,actor);
      return dto(db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(row.id),owner);
    });
  }
  /* Продолжение по оставшимся площадкам. Исходная карточка не меняется: её доставки, расписки и статусы
     остаются как есть, guards не ослабляются. Создаётся связанная карточка только для тех площадок,
     по которым отправки не было и её результат известен. Повторный вызов возвращает уже созданную карточку. */
  function split(id,code,body,actor={}) {
    object(body,['revision','platformIds','reason']);revision(body.revision);
    if(!Array.isArray(body.platformIds)||!body.platformIds.length)fail(400,'Отметьте хотя бы одну площадку');
    if(body.platformIds.length>20)fail(400,'Допускается не более 20 каналов');
    const reason=text(body.reason??'',2000);
    // Сборка представления обращается к данным компании и открывает свою транзакцию,
    // поэтому внутри этой транзакции возвращаются только идентификаторы.
    const outcome=transaction(()=>{
      const {row,owner}=rowFor(id,code);
      if(row.revision!==body.revision)fail(409,'Публикация уже изменена','REVISION_CONFLICT');
      // Продолжать можно только после завершённой отправки: пока карточка черновик или стоит в плане,
      // она сама может отправить те же площадки, и продолжение создало бы второе задание.
      const receiptsHere=receiptPlatforms(row.id);
      const published=db.prepare("SELECT 1 FROM autoposting_deliveries WHERE post_id=? AND status='published'").get(row.id);
      if(row.status!=='published'||(!published&&!receiptsHere.size))
        fail(409,'Продолжать по оставшимся площадкам можно только после того, как отправка исходного материала завершилась и её результат известен','POST_STATE');
      const all=platformIdsOf(row);
      const ids=body.platformIds.map(value=>text(value,100,true));
      if(new Set(ids).size!==ids.length)fail(400,'Канал выбран дважды');
      const unknown=ids.filter(value=>!all.includes(value));
      if(unknown.length)fail(400,`Эти каналы не выбраны в карточке: ${unknown.join(', ')}`);
      // Действительно неотправленные площадки считает сервер, а не клиент.
      const deliveries=new Map(db.prepare('SELECT channel_id,status FROM autoposting_deliveries WHERE post_id=?').all(row.id).map(item=>[item.channel_id,item.status]));
      const marked=receiptsHere;
      const blocked=ids.filter(value=>marked.has(value)||['published','publishing','needs_review'].includes(deliveries.get(value)));
      if(blocked.length)fail(409,`Результат отправки по этим каналам уже есть или ещё неизвестен: ${blocked.map(platformLabel).join(', ')}. Продолжать по ним нельзя — это создало бы дубликат.`,'PUBLICATION_REVIEW_REQUIRED');
      // Идемпотентность: площадка исходной карточки передаётся только одной активной дочерней карточке.
      const links=new Map(db.prepare('SELECT platform_id platformId,child_post_id childPostId FROM autoposting_split_links WHERE source_post_id=?').all(row.id).map(item=>[item.platformId,item.childPostId]));
      // Связь вечная: отменённый ребёнок мог успеть отправить или оставить неизвестный результат,
      // поэтому вторую копию по той же площадке не создаём никогда.
      const mapped=ids.filter(value=>links.has(value));
      if(mapped.length&&mapped.length!==ids.length)
        fail(409,`Часть каналов уже передана в продолжение: ${mapped.map(value=>`${platformLabel(value)} → материал №${links.get(value)}`).join('; ')}. Запросите отдельно только новые каналы.`,'SPLIT_ALREADY_EXISTS');
      if(mapped.length===ids.length){
        const children=[...new Set(ids.map(value=>links.get(value)))];
        if(children.length>1)
          fail(409,`Эти каналы переданы в разные продолжения: ${ids.map(value=>`${platformLabel(value)} → материал №${links.get(value)}`).join('; ')}. Запросите каждый из них отдельно.`,'SPLIT_ALREADY_EXISTS');
        return {created:false,sourceId:row.id,childId:children[0]};
      }
      const captionsAll=JSON.parse(row.captions||'{}');
      const captions=Object.fromEntries(Object.entries(captionsAll).filter(([platform])=>ids.includes(platform)));
      const time=iso(),order=(db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM autoposting_posts WHERE company_id=?').get(owner.id).m||0)+1;
      // У ребёнка нет расписания, доставок и одобрений: нужна новая проверка и новое согласование.
      const childId=Number(db.prepare(`INSERT INTO autoposting_posts(company_id,title,text,media_urls,platform_ids,scheduled_at,timezone,profile_revision,created_at,updated_at,created_by,
        day_key,captions,origin,media_sha256,expected_media_sha256,expected_media_file,meta,sort_order,review_state,content_revision,status)
        VALUES(?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',1,'draft')`)
        .run(owner.id,row.title,row.text,row.media_urls,JSON.stringify(ids),row.timezone,row.profile_revision,time,time,actor.userId??null,
          row.day_key||'',JSON.stringify(captions),row.origin||'',row.media_sha256||'',row.expected_media_sha256||'',row.expected_media_file||'',row.meta||'{}',order).lastInsertRowid);
      const child=db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(childId);
      for(const value of ids){
        db.prepare(`INSERT INTO autoposting_platform_reviews(post_id,platform_id,state,content_revision,comment,actor_id,actor_name,created_at)
          VALUES(?,?,'pending',1,'',?,?,?)`).run(childId,value,actor.userId??null,actor.userName??null,time);
        db.prepare(`INSERT INTO autoposting_split_links(source_post_id,platform_id,child_post_id,company_id,source_content_revision,created_at,created_by)
          VALUES(?,?,?,?,?,?,?)`).run(row.id,value,childId,owner.id,row.content_revision??1,time,actor.userId??null);
      }
      const label=ids.map(platformLabel).join(', ');
      history(row,'edited',`Работа по площадкам ${label} продолжена в карточке №${childId}${reason?`: ${reason}`:''}`,actor);
      history(child,'submitted',`Продолжение карточки №${row.id} (версия содержимого ${row.content_revision??1}) по площадкам ${label}`,actor);
      return {created:true,sourceId:row.id,childId};
    });
    return {created:outcome.created,post:get(outcome.sourceId,code),child:get(outcome.childId,code)};
  }
  /* Отправить на согласование вручную (например, импортированную карточку без правок). */
  function submitReview(id,code,body,actor={}) {
    object(body,['revision']);revision(body.revision);
    return transaction(()=>{
      const {row,owner}=rowFor(id,code);
      if(row.revision!==body.revision)fail(409,'Публикация уже изменена','REVISION_CONFLICT');
      if(isApproved(row))fail(409,'Эта версия уже согласована','POST_STATE');
      db.prepare("UPDATE autoposting_posts SET review_state='pending',revision=revision+1,updated_at=? WHERE id=?").run(iso(),row.id);
      history(row,'submitted','',actor);
      return dto(db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(row.id),owner);
    });
  }
  /* Порядок в плане: полный список идентификаторов компании; чужие и неизвестные отклоняются, пропущенные уходят в конец. */
  function reorder(code,body,actor={}) {
    object(body,['ids']);
    if(!Array.isArray(body.ids)||body.ids.length>200||body.ids.some(v=>!Number.isSafeInteger(v)||v<1))fail(400,'Передайте список идентификаторов карточек');
    if(new Set(body.ids).size!==body.ids.length)fail(400,'Карточка указана дважды');
    const owner=company(db,code);invalidate(code);
    transaction(()=>{
      const rows=db.prepare('SELECT id,sort_order FROM autoposting_posts WHERE company_id=? ORDER BY sort_order ASC,created_at DESC,id DESC').all(owner.id),known=new Set(rows.map(r=>r.id));
      for(const id of body.ids)if(!known.has(id))fail(404,'Карточка не найдена в выбранной компании','NOT_FOUND');
      const ordered=[...body.ids,...rows.map(r=>r.id).filter(id=>!body.ids.includes(id))];
      const stmt=db.prepare('UPDATE autoposting_posts SET sort_order=?,updated_at=? WHERE id=? AND company_id=?');
      ordered.forEach((id,index)=>stmt.run(index+1,iso(),id,owner.id));
      const first=db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(body.ids[0]);if(first)history(first,'reordered',`Порядок: ${ordered.join(',')}`.slice(0,500),actor);
    });
    return list(code);
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
    // За время ожидания владелец мог переписать карточку и заново поставить её в план. Снимок due устарел,
    // и решения по нему относились бы к чужой версии: этот проход просто уходит, не отменяя новый план.
    const reread=db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(due.id);
    if(!reread||reread.revision!==due.revision||reread.content_revision!==due.content_revision||reread.status!=='scheduled'||reread.scheduled_at!==due.scheduled_at)return;
    const deliveries=db.prepare('SELECT * FROM autoposting_deliveries WHERE post_id=? ORDER BY channel_id').all(due.id);
    if(deliveries.some(delivery=>{
      const channel=settings.channels.find(c=>c.id===delivery.channel_id);
      return !channel||!channel.connected||!channel.enabled||channel.revision!==delivery.channel_revision;
    })){review(due.id,'CHANNEL_CHANGED');return;}
    if(information.get(due.code).revision!==due.profile_revision){review(due.id,'PROFILE_CHANGED');return;}
    // Неодобренный канал снимается с очереди; если одобренных не осталось — карточка уходит на пересмотр.
    if(isQueueCard(due)){
      const waiting=deliveries.filter(delivery=>delivery.status==='pending'&&!deliveryApproved(due,delivery.channel_id));
      if(waiting.length){
        const cancel=db.prepare("UPDATE autoposting_deliveries SET status='cancelled',error_code='APPROVAL_REVOKED' WHERE post_id=? AND channel_id=? AND status='pending'");
        for(const delivery of waiting)cancel.run(due.id,delivery.channel_id);
      }
      if(!deliveries.some(delivery=>delivery.status==='pending'&&deliveryApproved(due,delivery.channel_id))){review(due.id,'APPROVAL_REVOKED');return;}
    }
    // Отмеченная как опубликованная вне ЛК площадка снимается с очереди до захвата lease: дубликат не отправляется.
    const marked=receiptPlatforms(due.id);
    const conflicting=marked.size?deliveries.filter(delivery=>delivery.status==='pending'
      &&marked.has(channelPlatform(settings.channels.find(channel=>channel.id===delivery.channel_id),delivery.channel_id))):[];
    if(conflicting.length){
      const cancel=db.prepare("UPDATE autoposting_deliveries SET status='cancelled',error_code='EXTERNAL_PUBLICATION_RECORDED' WHERE post_id=? AND channel_id=? AND status='pending'");
      for(const delivery of conflicting)cancel.run(due.id,delivery.channel_id);
      review(due.id,'EXTERNAL_PUBLICATION_RECORDED');return;
    }
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
      // Подтверждение могло появиться между каналами: отмеченная площадка отменяется, отправка не выполняется.
      if(receiptPlatforms(due.id).has(channelPlatform(channel,delivery.channel_id))){
        db.prepare("UPDATE autoposting_deliveries SET status='cancelled',error_code='EXTERNAL_PUBLICATION_RECORDED' WHERE post_id=? AND channel_id=? AND status='pending'").run(due.id,delivery.channel_id);
        review(due.id,'EXTERNAL_PUBLICATION_RECORDED');return;
      }
      // Отзыв одобрения между каналами: оставшиеся отправки не выполняются.
      if(!deliveryApproved(freshPost,delivery.channel_id)){
        db.prepare("UPDATE autoposting_deliveries SET status='cancelled',error_code='APPROVAL_REVOKED' WHERE post_id=? AND channel_id=? AND status='pending'").run(due.id,delivery.channel_id);
        if(!db.prepare("SELECT 1 FROM autoposting_deliveries WHERE post_id=? AND status='pending'").get(due.id)){review(due.id,'APPROVAL_REVOKED');return;}
        continue;
      }
      if(information.get(due.code).revision!==due.profile_revision){review(due.id,'PROFILE_CHANGED');return;}
      if(!db.prepare("UPDATE autoposting_deliveries SET status='publishing',started_at=? WHERE post_id=? AND channel_id=? AND status='pending'").run(now(),due.id,delivery.channel_id).changes)continue;
      try{
        const result=await transport.publish({companyCode:due.code.toLowerCase(),channelId:delivery.channel_id,channelRevision:delivery.channel_revision,
          // Подпись площадки, если задана, заменяет общий текст именно для этого канала.
          post:(()=>{const view=dto(due,company(db,due.code));return {...view,text:view.captions?.[channel.platform||channel.id]||view.text,idempotencyKey:`synapse-post-${due.id}-${delivery.channel_id}`};})(),
          beforePublish:()=>{
            // Подтверждение могло появиться, пока транспорт ждал предварительные запросы: адаптер вызывает
            // этот барьер перед самой передачей, и до неё отправка ещё отменима.
            if(receiptPlatforms(due.id).has(channelPlatform(channel,delivery.channel_id)))
              throw Object.assign(Error('External publication recorded before provider submission'),{ambiguous:false,receiptBlocked:true});
            const active=db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(due.id);
            if(stopped||active?.status!=='publishing'||active.lease!==lease||information.get(due.code).revision!==due.profile_revision||!deliveryApproved(active,delivery.channel_id))
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
        // Барьер сработал до передачи площадке: отправки не было, доставка снимается с тем же понятным кодом.
        if(error?.receiptBlocked){
          db.prepare("UPDATE autoposting_deliveries SET status='cancelled',error_code='EXTERNAL_PUBLICATION_RECORDED',finished_at=? WHERE post_id=? AND channel_id=? AND status='publishing'")
            .run(iso(),due.id,delivery.channel_id);
          review(due.id,'EXTERNAL_PUBLICATION_RECORDED');return;
        }
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
  return {get,list,calendar,create,update,schedule,cancel,reconcile,drain,stop,invalidate,approve,reject,split,submitReview,reorder,importPackage,recordReceipt};
}
module.exports={createAutoposting,LEASE_MS,CAPTION_PLATFORMS,FORMATS,ROLES,REVIEW_STATES,META_FIELDS,RECEIPT_PLATFORMS,receiptFormat,
  CALENDAR_MAX_RANGE_DAYS,CALENDAR_UNDATED_LIMIT,CALENDAR_TARGET_DAYS,CALENDAR_MINIMUM_DAYS,CALENDAR_CRITICAL_DAYS};
