'use strict';
/* «Материалы»: смонтированные рилсы компании, их версии v1, v2… и правки к версии.
   Правка — это список правок (EDL JSON) или просьба «Хью, измени…» по отрезку. Рендер в браузере
   и здесь не выполняется: правку забирает Claude-агент монтажа (tools/reels-check), монтирует
   ffmpeg и загружает новую версию через служебный маршрут. Публикации здесь нет: «Создать публикацию»
   создаёт обычный черновик автопостинга, дальше работают его согласование и план. */
const {company,fail,object,text}=require('./company-information');

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

function createReelMaterials(db,{autoposting,information,mediaOrigins=process.env.PUBLISHING_ASSET_ORIGINS||DEFAULT_MEDIA_ORIGINS}={}){
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
  const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}};
  const rowFor=(owner,id)=>{const row=Number.isSafeInteger(id)&&db.prepare('SELECT * FROM reel_materials WHERE id=? AND company_id=?').get(id,owner.id);if(!row)fail(404,'Ролик не найден','NOT_FOUND');return row;};
  const versionsOf=id=>db.prepare('SELECT * FROM reel_versions WHERE reel_id=? ORDER BY version').all(id).map(v=>({version:v.version,mediaUrl:v.media_url,
    sha256:v.sha256,durationMs:v.duration_ms,editId:v.edit_id,note:v.note,createdAt:v.created_at}));
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
      platforms:parse(row.platforms,[]),postId:row.post_id,currentVersion:current,versionCount:versions.length,
      openEdits:db.prepare("SELECT COUNT(*) n FROM reel_edits WHERE reel_id=? AND status IN ('pending','in_progress')").get(row.id).n};
    if(!full)return base;
    const edits=db.prepare('SELECT * FROM reel_edits WHERE reel_id=? ORDER BY id').all(row.id).map(editDto);
    /* Журнал правок ролика; те же записи уходят в личный чат автора с Хью (hughLog → content). */
    const log=edits.flatMap(e=>logEntries(e,row.title,false));
    return {...base,versions,edits,log};
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
    const rows=db.prepare('SELECT * FROM reel_materials WHERE company_id=? ORDER BY id DESC').all(owner.id);
    const reels=[...rows.map(row=>reelDto(row,owner,false)),...planReels(owner,new Set(rows.map(row=>row.post_id).filter(Boolean)))]
      .filter(reel=>(!from||reel.releaseDate&&reel.releaseDate>=from)&&(!to||reel.releaseDate&&reel.releaseDate<=to)&&(!platform||reel.platforms.includes(platform)))
      .sort((a,b)=>(b.releaseDate||'').localeCompare(a.releaseDate||'')||String(b.key).localeCompare(String(a.key)));
    return {companyCode:owner.code.toLowerCase(),filters:{from,to,platform},platforms:PLATFORMS,reels};
  }
  function get(code,id){const owner=company(db,code);return reelDto(rowFor(owner,id),owner,true);}
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
    object(body,['title','releaseDate','platforms','mediaUrl','sha256','durationMs']);
    return insert(owner,{title:text(body.title??'',200,true),releaseDate:date(body.releaseDate??''),platforms:platforms(body.platforms??[]),postId:null,
      mediaUrl:mediaUrl(body.mediaUrl,owner.code),sha256:sha(body.sha256),durationMs:body.durationMs===undefined?null:int(body.durationMs,100,MAX_MS,'Длительность'),note:''},actor);
  }
  function insert(owner,data,actor){
    return transaction(()=>{
      const at=iso(),id=Number(db.prepare('INSERT INTO reel_materials(company_id,title,release_date,platforms,post_id,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?,?)')
        .run(owner.id,data.title,data.releaseDate,JSON.stringify(data.platforms),data.postId,at,at,String(actor?.userId??'')).lastInsertRowid);
      db.prepare('INSERT INTO reel_versions(reel_id,version,media_url,sha256,duration_ms,note,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)')
        .run(id,1,data.mediaUrl,data.sha256||'',data.durationMs??null,data.note,at,String(actor?.userId??''));
      return reelDto(rowFor(owner,id),owner,true);
    });
  }
  function update(code,id,body){
    const owner=company(db,code),row=rowFor(owner,id);object(body,['title','releaseDate','platforms','ideaId']);
    if(Object.hasOwn(body,'ideaId'))require('./reel-plan-status').link(db,owner.id,text(body.ideaId,100,true),row.id);
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
    const version=db.prepare('SELECT * FROM reel_versions WHERE reel_id=? AND version=?').get(row.id,body.baseVersion);
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
  /* Черновик автопостинга с выбранной версией. Ничего не отправляется: дальше согласование и план автопостинга. */
  function createPublication(code,id,body,actor){
    const owner=company(db,code),row=rowFor(owner,id);object(body,['version','platformIds','title']);
    const version=db.prepare('SELECT * FROM reel_versions WHERE reel_id=? AND version=?').get(row.id,body.version);if(!version)fail(400,'Версия ролика не найдена');
    const ids=platforms(body.platformIds??parse(row.platforms,[]));
    const post=autoposting.create(owner.code,{title:text(body.title??row.title,200,true),mediaUrls:[version.media_url],platformIds:ids,
      profileRevision:information.get(owner.code).revision,origin:`Материалы: ролик №${row.id} v${version.version}`,format:'reel',
      ...(version.sha256?{mediaSha256:version.sha256}:{})},actor.userId);
    if(!row.post_id)db.prepare('UPDATE reel_materials SET post_id=?,updated_at=? WHERE id=? AND post_id IS NULL').run(post.id,iso(),row.id);
    return {post:{id:post.id,title:post.title,status:post.status,platformIds:post.platformIds,mediaUrls:post.mediaUrls},reel:reelDto(rowFor(owner,id),owner,true)};
  }
  /* --- Служебный API агента монтажа (ключ сервиса, без браузерной сессии) --- */
  function queue(code){
    const owner=code?company(db,code):null;
    return {edits:db.prepare(`SELECT e.*,c.code company_code,r.title,v.media_url,v.sha256,v.duration_ms FROM reel_edits e JOIN reel_materials r ON r.id=e.reel_id
      JOIN companies c ON c.id=e.company_id JOIN reel_versions v ON v.reel_id=e.reel_id AND v.version=e.base_version
      WHERE e.status IN ('pending','in_progress') AND r.company_id=e.company_id ${owner?'AND e.company_id=?':''} ORDER BY e.id`).all(...(owner?[owner.id]:[]))
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
  return {list,get,create,update,requestEdit,cancelEdit,createPublication,queue,claim,addVersion,hughLog};
}
module.exports={createReelMaterials,validateEdl:edl,PLATFORMS,EDIT_STATES,MONTAGE_EXECUTOR,DEFAULT_MEDIA_ORIGINS};
