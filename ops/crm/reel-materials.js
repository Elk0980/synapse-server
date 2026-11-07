'use strict';
/* «Материалы»: смонтированные рилсы компании, их версии v1, v2… и правки к версии.
   Правка — это список правок (EDL JSON) или просьба «Хью, измени…» по отрезку. Рендер в браузере
   и здесь не выполняется: правку забирает Claude-агент монтажа (tools/reels-check), монтирует
   ffmpeg и загружает новую версию через служебный маршрут. Публикации здесь нет: «Создать публикацию»
   создаёт обычный черновик автопостинга, дальше работают его согласование и план. */
const {company,fail,object,text}=require('./company-information');
const {CAPTION_PLATFORMS}=require('./autoposting');

const PLATFORMS=Object.freeze(['instagram','tiktok','youtube_shorts','vk','telegram','max']);
const SPEEDS=Object.freeze([1,1.25,1.5]);
const MAX_MS=10*60*1000,MAX_CLIPS=100,MAX_CAPTIONS=50;
const EDIT_STATES=Object.freeze(['pending','in_progress','done','cancelled']);
const MONTAGE_EXECUTOR='Claude · монтаж';
const iso=()=>new Date().toISOString();
const parse=(value,fallback)=>{try{return JSON.parse(value);}catch{return fallback;}};
const int=(value,min,max,label)=>{if(!Number.isSafeInteger(value)||value<min||value>max)fail(400,`${label}: целое от ${min} до ${max}`);return value;};
const date=value=>{if(value===null||value==='')return '';if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value+'T00:00:00Z')))fail(400,'Дата выхода: ГГГГ-ММ-ДД');return value;};
function platforms(value){
  if(!Array.isArray(value)||value.length>PLATFORMS.length||value.some(id=>!PLATFORMS.includes(id))||new Set(value).size!==value.length)
    fail(400,'Площадки: '+PLATFORMS.join(', '));
  return PLATFORMS.filter(id=>value.includes(id));
}
/* Ролик принимается только из хранилища публикаций той же компании и только с разрешённого хоста
   (по умолчанию — origin хранилища content, PUBLISHING_ASSET_ORIGIN). Относительный путь своего хранилища
   дополняется первым разрешённым origin. Чужой хост → 400: агент монтажа не скачивает с произвольного адреса. */
const DEFAULT_MEDIA_ORIGINS=Object.freeze(['https://synapse.synapsebusiness.ru']);
const ASSET_PATH=/^\/content\/publishing-assets\/([a-z0-9_-]{1,64})\/[a-f0-9]{32}\.(?:mp4|webm)$/;
function mediaOriginsOf(value){
  const list=(Array.isArray(value)?value:String(value||'').split(',')).map(item=>String(item).trim()).filter(Boolean);
  const out=list.map(item=>{let url;try{url=new URL(item);}catch{throw Error('Неверный origin хранилища роликов: '+item);}
    if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Origin хранилища роликов: только https://хост');return url.origin;});
  if(!out.length)throw Error('Не задан origin хранилища роликов');
  return Object.freeze([...new Set(out)]);
}
function checkMedia(value,code,allowed){
  if(typeof value!=='string'||value.length>500)return {status:400,message:'Нужна ссылка на ролик'};
  let parsed;try{parsed=new URL(value,value.startsWith('/')&&!value.startsWith('//')?allowed[0]:undefined);}catch{return {status:400,message:'Нужна ссылка на ролик'};}
  const match=ASSET_PATH.exec(parsed.pathname);
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash||!match)return {status:400,message:'Ролик должен быть загружен в хранилище публикаций (MP4/WebM)'};
  if(!allowed.includes(parsed.origin))return {status:400,message:'Ролик должен быть в хранилище публикаций Synapse: чужой адрес не принимается',code:'MEDIA_HOST'};
  if(match[1]!==code.toLowerCase())return {status:403,message:'Ролик принадлежит другой компании',code:'FORBIDDEN'};
  return {href:parsed.href};
}
const sha=value=>{if(value===undefined||value===null||value==='')return '';if(typeof value!=='string'||!/^[a-f0-9]{64}$/i.test(value))fail(400,'SHA-256: 64 шестнадцатеричных символа');return value.toLowerCase();};

/* EDL v1. Порядок элементов массива — порядок на дорожке: «переставить» меняет порядок,
   «разделить» даёт два клипа, «удалить кусок» убирает клип, «обрезать края» меняет inMs/outMs.
   Звук — отдельная дорожка с громкостью 0…2 и «без звука». Дополнительно: титры, кадр обложки, скорость. */
function edl(value,durationMs){
  object(value,['v','video','audio','captions','coverMs','speed']);
  if(value.v!==1)fail(400,'EDL: поддерживается версия 1');
  const limit=durationMs||MAX_MS;
  const clip=(item,audio)=>{
    object(item,audio?['inMs','outMs','gain','muted']:['inMs','outMs']);
    const inMs=int(item.inMs,0,limit,'Начало клипа'),outMs=int(item.outMs,0,limit,'Конец клипа');
    if(outMs-inMs<100)fail(400,'Клип короче 0,1 с');
    if(!audio)return {inMs,outMs};
    const gain=item.gain??1,muted=item.muted??false;
    if(typeof gain!=='number'||!Number.isFinite(gain)||gain<0||gain>2)fail(400,'Громкость: от 0 до 2');
    if(typeof muted!=='boolean')fail(400,'«Без звука» — true или false');
    return {inMs,outMs,gain:Math.round(gain*100)/100,muted};
  };
  const list=(items,audio)=>{if(!Array.isArray(items)||items.length>MAX_CLIPS)fail(400,`Дорожка: до ${MAX_CLIPS} клипов`);return items.map(item=>clip(item,audio));};
  const video=list(value.video,false),audio=list(value.audio??[],true);
  if(!video.length)fail(400,'На видеодорожке нет ни одного клипа');
  const total=video.reduce((sum,item)=>sum+item.outMs-item.inMs,0);
  const captions=value.captions??[];
  if(!Array.isArray(captions)||captions.length>MAX_CAPTIONS)fail(400,`Титры: не больше ${MAX_CAPTIONS}`);
  const titles=captions.map(item=>{object(item,['startMs','endMs','text']);
    const startMs=int(item.startMs,0,total,'Начало титра'),endMs=int(item.endMs,0,total,'Конец титра');
    if(endMs<=startMs)fail(400,'Титр заканчивается раньше начала');
    return {startMs,endMs,text:text(String(item.text??'').normalize('NFC'),120,true)};});
  const coverMs=value.coverMs===undefined||value.coverMs===null?null:int(value.coverMs,0,total,'Кадр обложки');
  const speed=value.speed??1;if(!SPEEDS.includes(speed))fail(400,'Скорость: 1, 1.25 или 1.5');
  return {v:1,video,audio,captions:titles,coverMs,speed,outputMs:Math.round(total/speed)};
}

function createReelMaterials(db,{autoposting,information,mentor,now=Date.now,mediaOrigins=process.env.PUBLISHING_ASSET_ORIGINS||DEFAULT_MEDIA_ORIGINS}={}){
  const allowedOrigins=mediaOriginsOf(mediaOrigins);
  const mediaUrl=(value,code)=>{const result=checkMedia(value,code,allowedOrigins);if(!result.href)fail(result.status,result.message,result.code);return result.href;};
  db.exec(`CREATE TABLE IF NOT EXISTS reel_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL REFERENCES companies(id),
      title TEXT NOT NULL, release_date TEXT NOT NULL DEFAULT '', platforms TEXT NOT NULL DEFAULT '[]',
      post_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT '');
    CREATE UNIQUE INDEX IF NOT EXISTS reel_materials_post ON reel_materials(company_id,post_id) WHERE post_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS reel_versions (
      reel_id INTEGER NOT NULL REFERENCES reel_materials(id), version INTEGER NOT NULL, media_url TEXT NOT NULL,
      sha256 TEXT NOT NULL DEFAULT '', duration_ms INTEGER, edit_id INTEGER, note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT '', PRIMARY KEY(reel_id,version));
    CREATE TABLE IF NOT EXISTS reel_edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT, reel_id INTEGER NOT NULL REFERENCES reel_materials(id),
      company_id INTEGER NOT NULL REFERENCES companies(id), base_version INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('edl','request')),
      edl TEXT, comment TEXT NOT NULL DEFAULT '', start_ms INTEGER, end_ms INTEGER, status TEXT NOT NULL DEFAULT 'pending',
      task_id INTEGER, result_version INTEGER, client_request_id TEXT NOT NULL, author_id TEXT NOT NULL, author_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(company_id,client_request_id));`);
  /* Связь ролика с идеей контент-плана (specs/209-cf-stages): добавочная колонка, старые строки остаются без связи. */
  if(!db.prepare('PRAGMA table_info(reel_materials)').all().some(column=>column.name==='idea_id')){
    db.exec('ALTER TABLE reel_materials ADD COLUMN idea_id TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS reel_materials_idea ON reel_materials(company_id,idea_id) WHERE idea_id IS NOT NULL');
  /* Архив (specs/224-content-archive): мягкое удаление ролика и отдельной версии. Строки и файлы не стираются. */
  for(const table of ['reel_materials','reel_versions']){
    const have=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column=>column.name));
    for(const [name,type] of [['archived_at','TEXT'],['archived_by','TEXT'],['archive_reason','TEXT']])
      if(!have.has(name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS reel_archive_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL REFERENCES companies(id), reel_id INTEGER NOT NULL REFERENCES reel_materials(id),
      version INTEGER, action TEXT NOT NULL CHECK(action IN ('archived','restored')), reason TEXT NOT NULL DEFAULT '',
      actor_id TEXT NOT NULL DEFAULT '', actor_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`);
  const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}};
  const rowAny=(owner,id)=>{const row=Number.isSafeInteger(id)&&db.prepare('SELECT * FROM reel_materials WHERE id=? AND company_id=?').get(id,owner.id);if(!row)fail(404,'Ролик не найден','NOT_FOUND');return row;};
  // Изменять можно только ролик вне архива; чтение (get) и восстановление идут через rowAny.
  const rowFor=(owner,id)=>{const row=rowAny(owner,id);if(row.archived_at)fail(409,'Ролик в архиве. Сначала верните его.','REEL_ARCHIVED');return row;};
  const archiveDto=row=>({archivedAt:row.archived_at||null,archivedBy:row.archived_by||null,reason:row.archive_reason||''});
  const versionDto=v=>({version:v.version,mediaUrl:v.media_url,sha256:v.sha256,durationMs:v.duration_ms,editId:v.edit_id,note:v.note,createdAt:v.created_at,
    ...(v.archived_at?{archive:archiveDto(v)}:{})});
  const allVersions=id=>db.prepare('SELECT * FROM reel_versions WHERE reel_id=? ORDER BY version').all(id).map(versionDto);
  const versionsOf=id=>allVersions(id).filter(v=>!v.archive);
  const liveVersion=(reelId,version)=>{const row=db.prepare('SELECT * FROM reel_versions WHERE reel_id=? AND version=?').get(reelId,version);
    if(row?.archived_at)fail(409,'Эта версия в архиве. Верните её или выберите другую.','VERSION_ARCHIVED');return row;};
  const editDto=e=>({id:e.id,kind:e.kind,baseVersion:e.base_version,status:e.status,edl:e.edl?parse(e.edl,null):null,comment:e.comment,
    startMs:e.start_ms,endMs:e.end_ms,taskId:e.task_id,resultVersion:e.result_version,authorName:e.author_name,createdAt:e.created_at,updatedAt:e.updated_at});
  const seconds=ms=>(ms/1000).toFixed(1);
  function logEntries(e,title,withTitle){
    const where=withTitle?`«${title}» — `:'';
    const ask=e.kind==='request'?`${where}Хью, измени (v${e.baseVersion}, ${seconds(e.startMs)}–${seconds(e.endMs)} с): ${e.comment}`:`${where}Правки монтажа к v${e.baseVersion}${e.comment?': '+e.comment:''}`;
    return [{key:`reel-edit:${e.id}:request`,at:e.createdAt,from:'user',authorName:e.authorName,editId:e.id,text:ask},
      ...(e.status==='done'?[{key:`reel-edit:${e.id}:done`,at:e.updatedAt,from:'hugh',editId:e.id,text:`Исправлено: ${withTitle?`«${title}» — `:''}готова v${e.resultVersion}`}]:[]),
      ...(e.status==='cancelled'?[{key:`reel-edit:${e.id}:cancelled`,at:e.updatedAt,from:'hugh',editId:e.id,text:`Правка №${e.id}${withTitle?` к «${title}»`:''} отменена`}]:[])];
  }
  function reelDto(row,owner,full){
    const versions=versionsOf(row.id),current=versions.at(-1)||null;
    const base={id:row.id,key:'reel:'+row.id,source:'materials',companyCode:owner.code.toLowerCase(),title:row.title,releaseDate:row.release_date,
      platforms:parse(row.platforms,[]),postId:row.post_id,ideaId:row.idea_id||null,planLink:row.idea_id?{ideaId:row.idea_id,source:'materials'}:null,
      currentVersion:current,versionCount:versions.length,archive:archiveDto(row),
      archivedVersions:db.prepare('SELECT COUNT(*) n FROM reel_versions WHERE reel_id=? AND archived_at IS NOT NULL').get(row.id).n,
      openEdits:db.prepare("SELECT COUNT(*) n FROM reel_edits WHERE reel_id=? AND status IN ('pending','in_progress')").get(row.id).n};
    if(!full)return base;
    const edits=db.prepare('SELECT * FROM reel_edits WHERE reel_id=? ORDER BY id').all(row.id).map(editDto);
    /* Журнал правок ролика; те же записи уходят в личный чат автора с Хью (hughLog → content). */
    const log=edits.flatMap(e=>logEntries(e,row.title,false));
    return {...base,versions,archivedVersionList:allVersions(row.id).filter(v=>v.archive),edits,log};
  }
  /* Рилсы из контент-плана: карточка автопостинга с видео, ещё не взятая в «Материалы». Показываются как v1, без копирования. */
  function planReels(owner,taken){
    if(!autoposting)return [];
    return autoposting.list(owner.code).posts.filter(post=>!taken.has(post.id)).map(post=>{
      const video=(post.mediaUrls||[]).find(item=>checkMedia(item,owner.code,allowedOrigins).href);if(!video)return null;
      let releaseDate='';if(post.scheduledAt){try{releaseDate=new Intl.DateTimeFormat('en-CA',{timeZone:post.timezone||'UTC'}).format(new Date(post.scheduledAt));}catch{releaseDate=post.scheduledAt.slice(0,10);}}
      return {id:null,key:'post:'+post.id,source:'plan',companyCode:owner.code.toLowerCase(),title:post.title||`Публикация №${post.id}`,releaseDate,
        platforms:(post.platformIds||[]).filter(id=>PLATFORMS.includes(id)),postId:post.id,
        currentVersion:{version:1,mediaUrl:video,sha256:post.mediaSha256||'',durationMs:null,editId:null,note:'Из контент-плана',createdAt:null},versionCount:1,openEdits:0};
    }).filter(Boolean);
  }
  function list(code,filters={}){
    const owner=company(db,code),from=date(filters.from??''),to=date(filters.to??'');
    const platform=filters.platform??'';if(platform&&!PLATFORMS.includes(platform))fail(400,'Неизвестная площадка');
    const all=db.prepare('SELECT * FROM reel_materials WHERE company_id=? ORDER BY id DESC').all(owner.id);
    // Архивные ролики в общий список не входят; их публикация тоже не всплывает «рилсом из плана» (taken по всем строкам).
    const archivedOnly=filters.archived===true,rows=all.filter(row=>Boolean(row.archived_at)===archivedOnly);
    const reels=[...rows.map(row=>reelDto(row,owner,false)),...(archivedOnly?[]:planReels(owner,new Set(all.map(row=>row.post_id).filter(Boolean))))]
      .filter(reel=>(!from||reel.releaseDate&&reel.releaseDate>=from)&&(!to||reel.releaseDate&&reel.releaseDate<=to)&&(!platform||reel.platforms.includes(platform)))
      .sort((a,b)=>(b.releaseDate||'').localeCompare(a.releaseDate||'')||String(b.key).localeCompare(String(a.key)));
    return {companyCode:owner.code.toLowerCase(),filters:{from,to,platform,...(archivedOnly?{archived:true}:{})},platforms:PLATFORMS,reels};
  }
  function get(code,id){const owner=company(db,code);return reelDto(rowAny(owner,id),owner,true);}
  /* Архив ролика или версии: только пометка и журнал. Публикации автопостинга и соцсети не затрагиваются.
     Ролик с правкой «в монтаже» не убирается: агент уже работает над ней. */
  function archiveReason(body,restore){
    object(body??{},restore?[]:['reason']);
    return restore||body?.reason===undefined?'':text(body.reason,500);
  }
  function setArchive(code,id,version,body,actor,restore){
    const owner=company(db,code),reason=archiveReason(body,restore);
    return transaction(()=>{
      const row=rowAny(owner,id),at=iso(),who=String(actor?.userId??''),name=String(actor?.userName||'');
      if(version===null){
        if(restore&&!row.archived_at)fail(409,'Ролик не в архиве','REEL_NOT_ARCHIVED');
        if(!restore&&row.archived_at)fail(409,'Ролик уже в архиве','REEL_ARCHIVED');
        if(!restore&&db.prepare("SELECT 1 FROM reel_edits WHERE reel_id=? AND status='in_progress' LIMIT 1").get(row.id))
          fail(409,'Правку этого ролика уже монтируют. Дождитесь новой версии и уберите ролик после.','EDIT_IN_PROGRESS');
        db.prepare('UPDATE reel_materials SET archived_at=?,archived_by=?,archive_reason=?,updated_at=? WHERE id=?')
          .run(restore?null:at,restore?null:who,restore?null:reason,at,row.id);
      }else{
        if(row.archived_at)fail(409,'Ролик в архиве. Сначала верните его.','REEL_ARCHIVED');
        const current=db.prepare('SELECT * FROM reel_versions WHERE reel_id=? AND version=?').get(row.id,version);
        if(!current)fail(404,'Версия ролика не найдена','NOT_FOUND');
        if(restore&&!current.archived_at)fail(409,'Версия не в архиве','VERSION_NOT_ARCHIVED');
        if(!restore&&current.archived_at)fail(409,'Версия уже в архиве','VERSION_ARCHIVED');
        if(!restore&&!db.prepare('SELECT 1 FROM reel_versions WHERE reel_id=? AND version<>? AND archived_at IS NULL LIMIT 1').get(row.id,version))
          fail(409,'Это единственная версия ролика. Уберите ролик целиком.','LAST_VERSION');
        if(!restore&&db.prepare("SELECT 1 FROM reel_edits WHERE reel_id=? AND base_version=? AND status='in_progress' LIMIT 1").get(row.id,version))
          fail(409,'По этой версии уже монтируют правку.','EDIT_IN_PROGRESS');
        db.prepare('UPDATE reel_versions SET archived_at=?,archived_by=?,archive_reason=? WHERE reel_id=? AND version=?')
          .run(restore?null:at,restore?null:who,restore?null:reason,row.id,version);
        db.prepare('UPDATE reel_materials SET updated_at=? WHERE id=?').run(at,row.id);
      }
      db.prepare('INSERT INTO reel_archive_events(company_id,reel_id,version,action,reason,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(owner.id,row.id,version,restore?'restored':'archived',reason,who,name,at);
      return reelDto(rowAny(owner,id),owner,true);
    });
  }
  const archive=(code,id,body,actor)=>setArchive(code,id,null,body,actor,false);
  const restore=(code,id,body,actor)=>setArchive(code,id,null,body,actor,true);
  const archiveVersion=(code,id,version,body,actor)=>setArchive(code,id,version,body,actor,false);
  const restoreVersion=(code,id,version,body,actor)=>setArchive(code,id,version,body,actor,true);
  function create(code,body,actor){
    const owner=company(db,code);
    if(body&&Object.hasOwn(body,'postId')){
      object(body,['postId']);const post=autoposting.get(int(body.postId,1,Number.MAX_SAFE_INTEGER,'Публикация'),owner.code);
      const existing=db.prepare('SELECT * FROM reel_materials WHERE company_id=? AND post_id=?').get(owner.id,post.id);
      if(existing)return reelDto(existing,owner,true);
      const plan=planReels(owner,new Set()).find(item=>item.postId===post.id);if(!plan)fail(400,'В публикации нет видео');
      return insert(owner,{title:plan.title,releaseDate:plan.releaseDate,platforms:plan.platforms,postId:post.id,
        mediaUrl:plan.currentVersion.mediaUrl,sha256:plan.currentVersion.sha256,note:'Из контент-плана'},actor);
    }
    object(body,['title','releaseDate','platforms','mediaUrl','sha256','durationMs','ideaId','offPlan']);
    if(body.ideaId!==undefined&&body.ideaId!==null&&body.ideaId!==''&&body.offPlan===true)fail(400,'Ролик либо к рилсу плана, либо вне плана');
    if(body.offPlan!==undefined&&typeof body.offPlan!=='boolean')fail(400,'«Вне плана» — true или false');
    const data={title:text(body.title??'',200,true),releaseDate:date(body.releaseDate??''),platforms:platforms(body.platforms??[]),postId:null,
      mediaUrl:mediaUrl(body.mediaUrl,owner.code),sha256:sha(body.sha256),durationMs:body.durationMs===undefined?null:int(body.durationMs,100,MAX_MS,'Длительность'),note:'',ideaId:null};
    if(body.ideaId!==undefined&&body.ideaId!==null&&body.ideaId!==''){
      data.ideaId=planIdea(owner,body.ideaId).ideaId;
      /* У идеи уже есть ролик — загрузка становится его новой версией, а не второй карточкой. */
      const existing=reelForIdea(owner,data.ideaId);
      if(existing){
        const added=addVersion(owner.code,existing.id,{mediaUrl:data.mediaUrl,sha256:data.sha256||undefined,durationMs:data.durationMs,note:'Новая загрузка к рилсу плана'},actor?.userName||String(actor?.userId??''));
        return {...added.reel,appended:true,appendedVersion:added.version.version};
      }
    }
    let offPlan=null;
    if(body.offPlan===true){offPlan=draftIdea(owner,data,actor);data.ideaId=offPlan.ideaId;}
    const reel=insert(owner,data,actor);
    return offPlan?{...reel,offPlan}:reel;
  }
  /* Идея плана ищется только в плане своей компании (company_id из проверенной компании). */
  const IDEA=/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
  function planDays(owner){
    const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_mentor_plans'").get();
    const row=exists&&db.prepare('SELECT plan FROM media_mentor_plans WHERE company_id=?').get(owner.id);
    const days=row?parse(row.plan,{}).days:null;return Array.isArray(days)?days:[];
  }
  function planIdea(owner,value){
    if(typeof value!=='string'||!IDEA.test(value))fail(400,'Некорректный рилс плана');
    const idea=planDays(owner).find(day=>day&&day.ideaId===value);
    if(!idea)fail(404,'Рилс плана не найден в этой компании','NOT_FOUND');
    return idea;
  }
  function reelForIdea(owner,ideaId){
    const direct=db.prepare('SELECT * FROM reel_materials WHERE company_id=? AND idea_id=? AND archived_at IS NULL ORDER BY id LIMIT 1').get(owner.id,ideaId);
    if(direct)return direct;
    const transfers=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_mentor_variant_transfers'").get();
    return transfers?db.prepare(`SELECT r.* FROM reel_materials r JOIN media_mentor_variant_transfers t ON t.post_id=r.post_id AND t.company_id=r.company_id
      WHERE r.company_id=? AND t.idea_id=? AND r.archived_at IS NULL ORDER BY r.id LIMIT 1`).get(owner.id,ideaId)||null:null;
  }
  /* «Вне плана»: черновик идеи (productionStatus=draft) в текущем плане через обычное сохранение плана.
     Сохранение создаёт новую версию плана, а согласование плана целиком привязано к версии, поэтому черновик
     добавляется только пока план целиком ждёт решения (pending): согласованный или отклонённый план загрузка
     не трогает. Не получилось — ролик сохраняется без связи, причина возвращается в offPlan.reason. */
  function draftIdea(owner,data,actor){
    const refuse=(reason,message)=>({ideaId:null,created:false,reason,message});
    if(!mentor)return refuse('NOT_CONFIGURED','Черновики плана не подключены');
    const service=typeof mentor==='function'?mentor():mentor;
    let snapshot;try{snapshot=service.get(owner.code);}catch{return refuse('PLAN_UNAVAILABLE','План недоступен');}
    if(!snapshot.plan)return refuse('PLAN_ABSENT','План ещё не составлен');
    if(snapshot.approval?.status!=='pending')return refuse('PLAN_DECIDED','План целиком уже согласован или отклонён: черновик не добавлен, чтобы не сбросить решение');
    const brief=snapshot.brief.fields.platforms||[];
    const platform=data.platforms.find(id=>brief.includes(id))||brief[0];
    if(!platform)return refuse('NO_PLATFORM','В брифе нет площадок');
    let day=data.releaseDate;
    if(!day){try{day=new Intl.DateTimeFormat('en-CA',{timeZone:db.prepare('SELECT timezone FROM companies WHERE id=?').get(owner.id)?.timezone||'UTC'}).format(new Date(now()));}
      catch{day=new Date(now()).toISOString().slice(0,10);}}
    const days=snapshot.plan.days.map(({stage,stageSource,publications,...rest})=>rest);
    const taken=new Set(days.map(item=>item.ideaId));let n=1,ideaId;
    do ideaId=`draft-${day}-${String(n++).padStart(2,'0')}`;while(taken.has(ideaId));
    const draft={ideaId,date:day,platform,format:'reel',role:'reach',topic:data.title||'Рилс вне плана',hook:'',assetId:'',mentorNote:'Загружен вне плана. Роль «Охватный» поставлена по умолчанию — уточните',
      productionStatus:'draft',variants:{[platform]:{text:'',hook:'',format:'reel',assetId:'',mentorNote:''}}};
    const next=[...days,draft].sort((a,b)=>String(a.date).localeCompare(String(b.date)));
    try{
      service.savePlan(owner.code,{planRevision:snapshot.plan.revision,briefRevision:snapshot.brief.revision,days:next,reason:'Черновик: рилс загружен вне плана'},
        {userId:actor?.userId??null,userName:actor?.userName||`#${actor?.userId??''}`});
    }catch(error){return refuse('PLAN_REJECTED',error.message);}
    return {ideaId,created:true,reason:'',message:'Черновик добавлен в план'};
  }
  function insert(owner,data,actor){
    return transaction(()=>{
      const at=iso(),id=Number(db.prepare('INSERT INTO reel_materials(company_id,title,release_date,platforms,post_id,created_at,updated_at,created_by,idea_id) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(owner.id,data.title,data.releaseDate,JSON.stringify(data.platforms),data.postId,at,at,String(actor?.userId??''),data.ideaId||null).lastInsertRowid);
      db.prepare('INSERT INTO reel_versions(reel_id,version,media_url,sha256,duration_ms,note,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)')
        .run(id,1,data.mediaUrl,data.sha256||'',data.durationMs??null,data.note,at,String(actor?.userId??''));
      return reelDto(rowFor(owner,id),owner,true);
    });
  }
  function update(code,id,body){
    const owner=company(db,code),row=rowFor(owner,id);object(body,['title','releaseDate','platforms']);
    const next={title:Object.hasOwn(body,'title')?text(body.title,200,true):row.title,releaseDate:Object.hasOwn(body,'releaseDate')?date(body.releaseDate):row.release_date,
      platforms:JSON.stringify(Object.hasOwn(body,'platforms')?platforms(body.platforms):parse(row.platforms,[]))};
    db.prepare('UPDATE reel_materials SET title=?,release_date=?,platforms=?,updated_at=? WHERE id=?').run(next.title,next.releaseDate,next.platforms,iso(),row.id);
    return reelDto(rowFor(owner,id),owner,true);
  }
  /* Правка уходит обычной задачей доски на исполнителя монтажа. Второй системы задач нет. */
  function requestEdit(code,id,body,actor){
    const owner=company(db,code),row=rowFor(owner,id);
    object(body,['clientRequestId','baseVersion','kind','edl','comment','startMs','endMs']);
    const clientRequestId=text(body.clientRequestId??'',80,true);
    const repeat=db.prepare('SELECT * FROM reel_edits WHERE company_id=? AND client_request_id=?').get(owner.id,clientRequestId);
    if(repeat){if(repeat.reel_id!==row.id)fail(409,'Ключ запроса уже использован');return {reel:reelDto(row,owner,true),edit:editDto(repeat),duplicate:true};}
    const version=liveVersion(row.id,body.baseVersion);
    if(!version)fail(400,'Версия ролика не найдена');
    const kind=body.kind;if(!['edl','request'].includes(kind))fail(400,'Вид правки: edl или request');
    const comment=text(body.comment??'',2000,kind==='request');
    let list=null,startMs=null,endMs=null;
    if(kind==='edl')list=edl(body.edl,version.duration_ms);
    else{startMs=int(body.startMs,0,version.duration_ms||MAX_MS,'Начало отрезка');endMs=int(body.endMs,0,version.duration_ms||MAX_MS,'Конец отрезка');if(endMs<=startMs)fail(400,'Конец отрезка раньше начала');}
    return transaction(()=>{
      const at=iso(),editId=Number(db.prepare(`INSERT INTO reel_edits(reel_id,company_id,base_version,kind,edl,comment,start_ms,end_ms,client_request_id,author_id,author_name,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id,owner.id,version.version,kind,list&&JSON.stringify(list),comment,startMs,endMs,clientRequestId,String(actor.userId),actor.userName||'',at,at).lastInsertRowid);
      const what=kind==='request'?`отрезок ${(startMs/1000).toFixed(1)}–${(endMs/1000).toFixed(1)} с: ${comment}`:`список правок (EDL): видео ${list.video.length}, звук ${list.audio.length}, титры ${list.captions.length}, скорость ${list.speed}×${comment?'. '+comment:''}`;
      const taskId=Number(db.prepare(`INSERT INTO tasks(created_at,updated_at,title,description,company_code,assignee_role,assignee_name,status,source,source_ref,source_author,created_by)
        VALUES(?,?,?,?,?,'synapse',?,'inbox','manual',?,?,?)`).run(at,at,`Монтаж: «${row.title}» v${version.version} — правка №${editId}`.slice(0,200),
        `Материалы → ролик №${row.id}, версия ${version.version}.\n${what}\nЗабрать: GET /internal/reel-materials/queue; новая версия: POST /internal/reel-materials/reels/${row.id}/versions (editId ${editId}). Проверка: tools/reels-check.`,
        owner.code,MONTAGE_EXECUTOR,`reel-edit:${editId}`,actor.userName||'',String(actor.userId)).lastInsertRowid);
      db.prepare('UPDATE reel_edits SET task_id=? WHERE id=?').run(taskId,editId);
      return {reel:reelDto(row,owner,true),edit:editDto(db.prepare('SELECT * FROM reel_edits WHERE id=?').get(editId)),duplicate:false};
    });
  }
  function editFor(owner,editId){const edit=Number.isSafeInteger(editId)&&db.prepare('SELECT * FROM reel_edits WHERE id=? AND company_id=?').get(editId,owner.id);if(!edit)fail(404,'Правка не найдена','NOT_FOUND');return edit;}
  function cancelEdit(code,id,editId){
    const owner=company(db,code),row=rowFor(owner,id),edit=editFor(owner,editId);
    if(edit.reel_id!==row.id)fail(404,'Правка не найдена','NOT_FOUND');
    if(edit.status!=='pending')fail(409,'Правку уже взяли в монтаж или закрыли','EDIT_STATE');
    db.prepare("UPDATE reel_edits SET status='cancelled',updated_at=? WHERE id=?").run(iso(),edit.id);
    if(edit.task_id)db.prepare("UPDATE tasks SET status='cancelled',updated_at=? WHERE id=? AND company_code=? COLLATE NOCASE").run(iso(),edit.task_id,owner.code);
    return reelDto(row,owner,true);
  }
  /* specs/227-plan-caption-to-post: текст публикации из версий площадок идеи действующего плана своей компании.
     План читается по company_id проверенной компании — идея чужой компании не находится никогда. Идея в архиве плана
     (specs/224) текст не отдаёт. Лимиты площадок — CAPTION_PLATFORMS: длинный текст не обрезается, а не подставляется
     в эту площадку, и возвращается предупреждение. Ничего не найдено — черновик как раньше, без текста. */
  function planText(owner,row,ids){
    const none=(reason,message)=>({source:'none',reason,message,ideaId:row.idea_id||null,planRevision:null,mainPlatform:null,captionPlatforms:[],warnings:[]});
    if(!row.idea_id)return none('NO_IDEA_LINK','Ролик не привязан к теме контент-плана');
    const has=name=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    const plan=has('media_mentor_plans')&&db.prepare('SELECT revision,plan FROM media_mentor_plans WHERE company_id=?').get(owner.id);
    if(!plan)return none('PLAN_ABSENT','Контент-плана ещё нет');
    const days=parse(plan.plan,{}).days,idea=Array.isArray(days)?days.find(day=>day&&day.ideaId===row.idea_id):null;
    if(!idea)return {...none('IDEA_NOT_IN_PLAN','Темы ролика нет в действующем контент-плане'),planRevision:plan.revision};
    if(has('media_mentor_idea_archive')&&db.prepare('SELECT 1 FROM media_mentor_idea_archive WHERE company_id=? AND idea_id=?').get(owner.id,row.idea_id))
      return {...none('IDEA_ARCHIVED','Тема ролика убрана в архив контент-плана'),planRevision:plan.revision};
    const variants=idea.variants&&typeof idea.variants==='object'&&!Array.isArray(idea.variants)?idea.variants:{};
    const own=platform=>{const variant=variants[platform];
      return variant&&variant.excluded!==true&&typeof variant.text==='string'?variant.text.trim():'';};
    const order=[idea.platform,...ids,...Object.keys(variants)].filter((platform,index,list)=>platform&&list.indexOf(platform)===index);
    const label=platform=>CAPTION_PLATFORMS[platform]?.label||platform,limit=platform=>CAPTION_PLATFORMS[platform]?.limit||null;
    // Основной текст — версия, которая укладывается в лимит своей площадки (старые данные могли его превысить).
    const fits=platform=>own(platform)&&(!limit(platform)||own(platform).length<=limit(platform));
    const mainPlatform=order.find(fits)||null;
    if(!mainPlatform)return {...none('NO_TEXT','В контент-плане нет текста публикации для этой темы'),planRevision:plan.revision};
    const main=own(mainPlatform),captions={},warnings=[],blocked=[];
    for(const platform of ids){
      const value=own(platform),max=limit(platform);
      if(value&&max&&value.length>max){
        blocked.push(platform);
        warnings.push({platform,code:'CAPTION_TOO_LONG',message:`Текст версии для ${label(platform)} длиннее ${max} символов — не подставлен. Сократите его в контент-плане.`});
        continue;
      }
      if(value&&value!==main){captions[platform]=value;continue;}
      if(!value&&max&&main.length>max){
        blocked.push(platform);
        warnings.push({platform,code:'MAIN_TOO_LONG',message:`Для ${label(platform)} своего текста в плане нет, а основной текст длиннее ${max} символов — не подставлен. Добавьте текст версии для ${label(platform)} в контент-плане.`});
      }
    }
    /* Площадка без своей подписи получает общий текст при отправке. Если хоть одной площадке текст подставлять нельзя
       (длиннее её лимита), общий текст остаётся пустым, а подходящим площадкам основной текст кладётся их подписью:
       заблокированная площадка честно остаётся «без текста», а не уходит на отправку с CONTENT_LIMIT. */
    let body=main;
    if(blocked.length){
      body='';
      for(const platform of ids)if(!blocked.includes(platform)&&!Object.hasOwn(captions,platform))captions[platform]=main;
    }
    if(!body&&!Object.keys(captions).length)
      return {...none('TOO_LONG','Текст из контент-плана длиннее лимита выбранных площадок — не подставлен'),planRevision:plan.revision,mainPlatform,warnings};
    return {source:'plan',reason:'',message:'Текст публикации подставлен из контент-плана',ideaId:row.idea_id,planRevision:plan.revision,
      mainPlatform,captionPlatforms:Object.keys(captions),blockedPlatforms:blocked,warnings,text:body,captions,topic:typeof idea.topic==='string'?idea.topic.trim():''};
  }
  /* Черновик автопостинга с выбранной версией. Ничего не отправляется: дальше согласование и план автопостинга. */
  function createPublication(code,id,body,actor){
    const owner=company(db,code),row=rowFor(owner,id);object(body,['version','platformIds','title']);
    const version=liveVersion(row.id,body.version);if(!version)fail(400,'Версия ролика не найдена');
    const ids=platforms(body.platformIds??parse(row.platforms,[]));
    const fromPlan=planText(owner,row,ids),{text:planBody,captions:planCaptions,topic,...report}=fromPlan,warnings=[...report.warnings];
    let title=body.title??row.title;
    if(body.title===undefined&&topic){
      if(topic.length<=200)title=topic;
      else warnings.push({platform:null,code:'TOPIC_TOO_LONG',message:'Тема плана длиннее 200 символов — заголовок оставлен по названию ролика'});
    }
    let origin=`Материалы: ролик №${row.id} v${version.version}`;
    if(fromPlan.source==='plan'){
      const mark=`${origin} · текст из контент-плана, ревизия плана ${fromPlan.planRevision}`,withIdea=`${mark}, тема ${fromPlan.ideaId}`;
      origin=withIdea.length<=200?withIdea:mark;
    }
    const post=autoposting.create(owner.code,{title:text(title,200,true),mediaUrls:[version.media_url],platformIds:ids,
      profileRevision:information.get(owner.code).revision,origin,format:'reel',
      ...(fromPlan.source==='plan'?{...(planBody?{text:planBody}:{}),...(Object.keys(planCaptions).length?{captions:planCaptions}:{})}:{}),
      ...(version.sha256?{mediaSha256:version.sha256}:{})},actor.userId);
    if(!row.post_id)db.prepare('UPDATE reel_materials SET post_id=?,updated_at=? WHERE id=? AND post_id IS NULL').run(post.id,iso(),row.id);
    return {post:{id:post.id,title:post.title,status:post.status,platformIds:post.platformIds,mediaUrls:post.mediaUrls},
      planText:{...report,warnings},reel:reelDto(rowFor(owner,id),owner,true)};
  }
  /* --- Служебный API агента монтажа (ключ сервиса, без браузерной сессии) --- */
  function queue(code){
    const owner=code?company(db,code):null;
    return {edits:db.prepare(`SELECT e.*,c.code company_code,r.title,v.media_url,v.sha256,v.duration_ms FROM reel_edits e JOIN reel_materials r ON r.id=e.reel_id
      JOIN companies c ON c.id=e.company_id JOIN reel_versions v ON v.reel_id=e.reel_id AND v.version=e.base_version
      WHERE e.status IN ('pending','in_progress') AND r.company_id=e.company_id AND r.archived_at IS NULL AND (v.archived_at IS NULL OR e.status='in_progress') ${owner?'AND e.company_id=?':''} ORDER BY e.id`).all(...(owner?[owner.id]:[]))
      .map(e=>({...editDto(e),companyCode:e.company_code.toLowerCase(),reelId:e.reel_id,title:e.title,base:{version:e.base_version,mediaUrl:e.media_url,sha256:e.sha256,durationMs:e.duration_ms}}))};
  }
  function claim(code,editId){
    const owner=company(db,code),edit=editFor(owner,editId);
    if(!['pending','in_progress'].includes(edit.status))fail(409,'Правка уже закрыта','EDIT_STATE');
    db.prepare("UPDATE reel_edits SET status='in_progress',updated_at=? WHERE id=?").run(iso(),edit.id);
    if(edit.task_id)db.prepare("UPDATE tasks SET status='in_progress',updated_at=? WHERE id=? AND company_code=? COLLATE NOCASE AND status IN ('inbox','planned')").run(iso(),edit.task_id,owner.code);
    return editDto(db.prepare('SELECT * FROM reel_edits WHERE id=?').get(edit.id));
  }
  function addVersion(code,id,body,agent){
    const owner=company(db,code),row=rowFor(owner,id);object(body,['mediaUrl','sha256','durationMs','editId','note']);
    const media=mediaUrl(body.mediaUrl,owner.code),hash=sha(body.sha256),note=text(body.note??'',1000);
    const durationMs=body.durationMs===undefined||body.durationMs===null?null:int(body.durationMs,100,MAX_MS,'Длительность');
    const edit=body.editId===undefined||body.editId===null?null:editFor(owner,body.editId);
    if(edit&&(edit.reel_id!==row.id||!['pending','in_progress'].includes(edit.status)))fail(409,'Правка не относится к ролику или уже закрыта','EDIT_STATE');
    return transaction(()=>{
      const at=iso(),version=(db.prepare('SELECT MAX(version) v FROM reel_versions WHERE reel_id=?').get(row.id).v||0)+1;
      db.prepare('INSERT INTO reel_versions(reel_id,version,media_url,sha256,duration_ms,edit_id,note,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(row.id,version,media,hash,durationMs,edit?.id??null,note,at,text(String(agent||MONTAGE_EXECUTOR),200));
      if(edit)db.prepare("UPDATE reel_edits SET status='done',result_version=?,updated_at=? WHERE id=?").run(version,at,edit.id);
      db.prepare('UPDATE reel_materials SET updated_at=? WHERE id=?').run(at,row.id);
      const reel=reelDto(rowFor(owner,id),owner,true);
      return {reel,version:reel.versions.at(-1),hughChat:edit?{companyCode:reel.companyCode,authorId:edit.author_id,text:`Исправлено: «${row.title}» — готова v${version}.`}:null};
    });
  }
  /* Личный лог автора правок для чата с Хью (room hugh:<id> в content). Только правки этого автора в этой компании. */
  function hughLog(code,authorId){
    const owner=company(db,code),author=String(authorId??'');if(!/^[1-9]\d{0,15}$/.test(author))fail(400,'Нужен автор правок');
    const rows=db.prepare(`SELECT e.*,r.title FROM reel_edits e JOIN reel_materials r ON r.id=e.reel_id AND r.company_id=e.company_id
      WHERE e.company_id=? AND e.author_id=? ORDER BY e.id DESC LIMIT 200`).all(owner.id,author).reverse();
    return {companyCode:owner.code.toLowerCase(),authorId:Number(author),entries:rows.flatMap(row=>logEntries(editDto(row),row.title,true).map(entry=>({...entry,reelId:row.reel_id})))};
  }
  return {list,get,archive,restore,archiveVersion,restoreVersion,create,update,requestEdit,cancelEdit,createPublication,queue,claim,addVersion,hughLog};
}
module.exports={createReelMaterials,validateEdl:edl,PLATFORMS,EDIT_STATES,MONTAGE_EXECUTOR,DEFAULT_MEDIA_ORIGINS};
