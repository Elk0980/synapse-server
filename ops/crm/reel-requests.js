'use strict';
/* specs/231-lena-materials-requests. Расширение «Материалов»:
   — своя подпись ролика, отметка «берём / не берём / переделать» и история изменений карточки (кто, когда, что);
   — просьбы агенту с ролика: переделать, опубликовать, перенести дату, заменить текст, убрать из плана, сообщение.
     У просьбы статус и ответ агента простым языком. «Переделать» — это существующая правка монтажа (requestEdit),
     «Опубликовать» — существующий черновик автопостинга (createPublication) с его согласованием; остальные виды —
     обычная задача доски. Второй доски, второго чата, новых площадок и прав здесь нет, на площадки ничего не уходит;
   — отрезки версии и «живой монтаж»: отрезок можно выключить или оставить без звука, порядок не меняется.
     Результат — обычная правка EDL v1 (kind=edl), которую забирает агент монтажа.
   Модуль подключается внутри createReelMaterials и работает только со строками проверенной компании. */
const {company,fail,object,text}=require('./company-information');
const {CAPTION_PLATFORMS}=require('./autoposting');

const DECISIONS=Object.freeze({'':'без решения',take:'берём',skip:'не берём',redo:'переделать'});
const KINDS=Object.freeze({redo:'Переделать',publish:'Опубликовать',reschedule:'Перенести дату',replace_text:'Заменить текст',remove_from_plan:'Убрать из плана',message:'Сообщение'});
const STATUSES=Object.freeze({accepted:'принято',in_progress:'в работе',ready:'готово, посмотрите',published:'опубликовано',rejected:'отклонено',waiting_owner:'ждёт владельца'});
const FINAL=Object.freeze(['published','rejected']);
/* Что агент может поставить сам. «Опубликовано» — только по факту из автопостинга. */
const AGENT_STATUSES=Object.freeze(['in_progress','ready','rejected','waiting_owner']);
const REVIEW_FIELDS=Object.freeze(['caption','decision','decisionComment']);
const TEXT_REQUIRED=Object.freeze(['redo','replace_text','message']);
const FIELD_LABELS=Object.freeze({title:'Название',releaseDate:'Дата выхода',platforms:'Площадки',caption:'Подпись',decision:'Решение'});
const iso=()=>new Date().toISOString();
const parse=(value,fallback)=>{try{return JSON.parse(value);}catch{return fallback;}};
const int=(value,min,max,label)=>{if(!Number.isSafeInteger(value)||value<min||value>max)fail(400,`${label}: целое от ${min} до ${max}`);return value;};
const day=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value+'T00:00:00Z')))fail(400,'Дата: ГГГГ-ММ-ДД');return value;};
const seconds=ms=>(ms/1000).toFixed(1);
const NOTE_OPTIONS=Object.freeze({font:['larger','smaller','style','none'],transition:['cut','smooth','zoom'],volume:['louder','quieter'],music:['add','remove','quieter','louder'],insert:['overlay'],other:['text']});
const NOTE_LABELS={font:'Шрифт и титры',transition:'Переход',volume:'Громкость',music:'Музыка на фон',insert:'Врезка (голос остаётся на фоне)',other:'Другое'};
const OPTION_LABELS={larger:'крупнее',smaller:'мельче',style:'другой стиль',none:'убрать титры',cut:'резкая склейка',smooth:'плавно',zoom:'приближение',louder:'громче',quieter:'тише',add:'добавить',remove:'убрать',overlay:'показать',text:''};
const notesText=notes=>notes.map(n=>`${n.from?`Фразы ${n.from}${n.to!==n.from?'–'+n.to:''}: `:''}${NOTE_LABELS[n.type]} — ${OPTION_LABELS[n.option]}${n.text?' '+n.text:''}`).join('; ');

function createReelRequests(db,{core,autoposting,maxMs,maxClips,executor}){
  const problems=require('./reel-problems').createReelProblems(db,{core});
  const addColumns=(table,columns)=>{const have=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column=>column.name));
    for(const [name,type] of columns)if(!have.has(name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);};
  addColumns('reel_materials',[['caption',"TEXT NOT NULL DEFAULT ''"],['decision',"TEXT NOT NULL DEFAULT ''"],['decision_comment',"TEXT NOT NULL DEFAULT ''"]]);
  addColumns('reel_versions',[['segments','TEXT']]);
  db.exec(`CREATE TABLE IF NOT EXISTS reel_material_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL REFERENCES companies(id), reel_id INTEGER NOT NULL REFERENCES reel_materials(id),
      field TEXT NOT NULL, old_value TEXT NOT NULL DEFAULT '', new_value TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '',
      actor_id TEXT NOT NULL DEFAULT '', actor_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS reel_material_events_reel ON reel_material_events(company_id,reel_id,id);
    CREATE TABLE IF NOT EXISTS reel_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL REFERENCES companies(id), reel_id INTEGER NOT NULL REFERENCES reel_materials(id),
      kind TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', version INTEGER, start_ms INTEGER, end_ms INTEGER, target_date TEXT NOT NULL DEFAULT '',
      platform_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'accepted', reply TEXT NOT NULL DEFAULT '', replied_at TEXT, replied_by TEXT NOT NULL DEFAULT '',
      edit_id INTEGER, post_id INTEGER, task_id INTEGER, client_request_id TEXT NOT NULL, author_id TEXT NOT NULL, author_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(company_id,client_request_id));
    CREATE INDEX IF NOT EXISTS reel_requests_reel ON reel_requests(company_id,reel_id,id);
    CREATE TABLE IF NOT EXISTS reel_request_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL REFERENCES reel_requests(id), company_id INTEGER NOT NULL REFERENCES companies(id),
      status TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);`);
  addColumns('reel_requests',[['notes',"TEXT NOT NULL DEFAULT '[]'"]]);
  addColumns('reel_request_events',[['actor_id',"TEXT NOT NULL DEFAULT ''"]]);
  const who=actor=>({id:String(actor?.userId??''),name:String(actor?.userName||'')});
  const hasTasks=()=>db.prepare('PRAGMA table_info(tasks)').all().some(column=>column.name==='company_code');

  /* --- Подпись, отметка, история карточки --- */
  function reviewOf(row,body){
    const next={caption:row.caption||'',decision:row.decision||'',decisionComment:row.decision_comment||''};
    if(Object.hasOwn(body,'caption'))next.caption=text(String(body.caption??'').normalize('NFC'),4000);
    if(Object.hasOwn(body,'decision')){if(typeof body.decision!=='string'||!Object.hasOwn(DECISIONS,body.decision))fail(400,'Решение: take, skip, redo или пусто');next.decision=body.decision;}
    if(Object.hasOwn(body,'decisionComment'))next.decisionComment=text(body.decisionComment??'',1000);
    if(!next.decision&&next.decisionComment)fail(400,'Комментарий относится к решению: сначала выберите «берём», «не берём» или «переделать»');
    return next;
  }
  /* Вызывается внутри транзакции update: пишет новые значения и по записи истории на каждое изменённое поле. */
  function saveReview(owner,row,base,review,actor){
    const at=iso(),{id,name}=who(actor);
    const log=(field,before,after,comment='')=>db.prepare(`INSERT INTO reel_material_events(company_id,reel_id,field,old_value,new_value,comment,actor_id,actor_name,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(owner.id,row.id,field,String(before??''),String(after??''),comment,id,name,at);
    if(base.title!==row.title)log('title',row.title,base.title);
    if(base.releaseDate!==row.release_date)log('releaseDate',row.release_date,base.releaseDate);
    const platformsBefore=(parse(row.platforms,[])||[]).join(', '),platformsAfter=(parse(base.platforms,[])||[]).join(', ');
    if(platformsBefore!==platformsAfter)log('platforms',platformsBefore,platformsAfter);
    if(review.caption!==(row.caption||''))log('caption',row.caption||'',review.caption);
    if(review.decision!==(row.decision||'')||review.decisionComment!==(row.decision_comment||''))log('decision',row.decision||'',review.decision,review.decisionComment);
    db.prepare('UPDATE reel_materials SET caption=?,decision=?,decision_comment=? WHERE id=? AND company_id=?').run(review.caption,review.decision,review.decisionComment,row.id,owner.id);
  }
  const historyOf=(owner,row)=>db.prepare('SELECT * FROM reel_material_events WHERE company_id=? AND reel_id=? ORDER BY id DESC LIMIT 200').all(owner.id,row.id)
    .map(e=>({id:e.id,field:e.field,fieldLabel:FIELD_LABELS[e.field]||e.field,before:e.old_value,after:e.new_value,comment:e.comment,
      ...(e.field==='decision'?{beforeLabel:DECISIONS[e.old_value]??e.old_value,afterLabel:DECISIONS[e.new_value]??e.new_value}:{}),
      authorName:e.actor_name,at:e.created_at}));

  /* FR-3: своя подпись ролика — текст публикации. Длинный текст не обрезается и не подставляется в площадку (как в specs/227). */
  function ownText(row,ids){
    const own=(row.caption||'').trim();if(!own)return null;
    const limit=platform=>CAPTION_PLATFORMS[platform]?.limit||null,label=platform=>CAPTION_PLATFORMS[platform]?.label||platform;
    const blocked=ids.filter(platform=>limit(platform)&&own.length>limit(platform));
    const warnings=blocked.map(platform=>({platform,code:'CAPTION_TOO_LONG',message:`Подпись ролика длиннее ${limit(platform)} символов — для ${label(platform)} не подставлена. Сократите подпись.`}));
    const captions={};let body=own;
    if(blocked.length){body='';for(const platform of ids)if(!blocked.includes(platform))captions[platform]=own;}
    const base={ideaId:row.idea_id||null,planRevision:null,mainPlatform:null,warnings};
    if(!body&&!Object.keys(captions).length)return {...base,source:'none',reason:'TOO_LONG',message:'Подпись ролика длиннее лимита выбранных площадок — не подставлена',captionPlatforms:[]};
    return {...base,source:'material',reason:'',message:'Текст публикации взят из подписи ролика',captionPlatforms:Object.keys(captions),blockedPlatforms:blocked,text:body,captions};
  }

  /* --- Отрезки версии --- */
  function segmentsOf(value,durationMs){
    if(!Array.isArray(value)||!value.length||value.length>maxClips)fail(400,`Отрезки: от 1 до ${maxClips}`);
    const limit=durationMs||maxMs;let cursor=0;
    const result=value.map(item=>{
      object(item,['startMs','endMs','label','enabled','sound']);
      const startMs=int(item.startMs,0,limit,'Начало отрезка'),endMs=int(item.endMs,0,limit,'Конец отрезка');
      if(startMs!==cursor)fail(400,'Отрезки идут подряд от начала ролика, без пропусков и наложений');
      if(endMs-startMs<100)fail(400,'Отрезок короче 0,1 с');
      cursor=endMs;
      const label=item.label===undefined||item.label===null?'':text(String(item.label).normalize('NFC'),200);
      /* specs/232: отрезок может быть размечен как «не в ролике» или «без звука» — тогда его можно добавить/озвучить в «живом монтаже». */
      for(const key of ['enabled','sound'])if(item[key]!==undefined&&typeof item[key]!=='boolean')fail(400,'«Включён» и «звук» у отрезка — true или false');
      return {startMs,endMs,...(label?{label}:{}),...(item.enabled===false?{enabled:false}:{}),...(item.sound===false?{sound:false}:{})};
    });
    if(durationMs&&cursor!==durationMs)fail(400,'Отрезки должны покрывать весь ролик до конца');
    return result;
  }
  const storedSegments=version=>{const list=version?.segments?parse(version.segments,null):null;return Array.isArray(list)&&list.length?list:null;};
  function notesOf(value,version){
    if(value===undefined)return [];
    if(!Array.isArray(value)||value.length>20)fail(400,'Пожелания: не больше 20');
    const count=storedSegments(version)?.length||0;
    const notes=value.map(note=>{
      object(note,['type','option','from','to','text']);
      if(typeof note.type!=='string'||!Object.hasOwn(NOTE_OPTIONS,note.type)||!NOTE_OPTIONS[note.type].includes(note.option))fail(400,'Неизвестный вид или вариант пожелания');
      const clean={type:note.type,option:note.option};
      if(note.from!==undefined||note.to!==undefined){
        clean.from=int(note.from,1,count,'Первая фраза');clean.to=note.to===undefined?clean.from:int(note.to,clean.from,count,'Последняя фраза');
      }
      const description=text(note.text??'',500,['other','insert'].includes(note.type));
      if(description)clean.text=description;
      return clean;
    });
    if(notes.reduce((n,note)=>n+(note.text||'').length,0)>5000)fail(400,'Общий текст пожеланий: не больше 5000 символов');
    return notes;
  }
  const segmentRevision=version=>require('node:crypto').createHash('sha256').update(JSON.stringify([
    version.version,version.media_url,version.sha256,version.duration_ms,storedSegments(version)||[]])).digest('hex');
  function getSegments(code,id,versionNumber){
    const owner=company(db,code),row=core.rowFor(owner,id),version=core.liveVersion(row.id,versionNumber);
    if(!version)fail(404,'Версия ролика не найдена','NOT_FOUND');
    return {companyCode:owner.code,reelId:row.id,version:version.version,durationMs:version.duration_ms,
      mediaSha256:version.sha256||'',revision:segmentRevision(version),segments:storedSegments(version)||[]};
  }
  function setSegments(code,id,versionNumber,body,{summaryOnly=false}={}){
    const owner=company(db,code),row=core.rowFor(owner,id);object(body,['segments','expectedRevision']);
    const version=core.liveVersion(row.id,versionNumber);if(!version)fail(404,'Версия ролика не найдена','NOT_FOUND');
    const list=segmentsOf(body.segments,version.duration_ms);
    if(body.expectedRevision!==undefined&&(typeof body.expectedRevision!=='string'||!/^[a-f0-9]{64}$/.test(body.expectedRevision)))fail(400,'Некорректная ревизия отрезков');
    return core.transaction(()=>{
      core.rowFor(owner,id);
      const current=core.liveVersion(row.id,versionNumber);
      if(!current)fail(404,'Версия ролика не найдена','NOT_FOUND');
      const same=JSON.stringify(storedSegments(current))===JSON.stringify(list);
      if(!same&&body.expectedRevision!==undefined&&body.expectedRevision!==segmentRevision(current))fail(409,'Разметка уже изменилась. Прочитайте версию заново.','SEGMENTS_CONFLICT');
      if(!same)db.prepare('UPDATE reel_versions SET segments=? WHERE reel_id=? AND version=?').run(JSON.stringify(list),row.id,version.version);
      return summaryOnly?getSegments(code,id,versionNumber):core.full(owner,row.id);
    });
  }
  /* «Живой монтаж»: переключатели по отрезкам → EDL v1. Видео и звук строит сервер из включённых отрезков в исходном
     порядке, поэтому перестановка и подрезка невозможны. Рендера нет: правку забирает агент монтажа. */
  function liveEdit(code,id,body,actor){
    const owner=company(db,code),row=core.rowFor(owner,id);
    object(body,['clientRequestId','baseVersion','segments','comment','notes']);
    const clientRequestId=text(body.clientRequestId??'',80,true);
    const repeat=db.prepare('SELECT * FROM reel_requests WHERE company_id=? AND client_request_id=?').get(owner.id,clientRequestId);
    if(repeat){if(repeat.reel_id!==row.id||!repeat.edit_id)fail(409,'Ключ запроса уже использован');
      const reel=core.full(owner,row.id);
      return {reel,request:requestDto(refresh(owner,repeat)),edit:reel.edits.find(e=>e.id===repeat.edit_id),duplicate:true};}
    const version=core.liveVersion(row.id,int(body.baseVersion,1,Number.MAX_SAFE_INTEGER,'Версия ролика'));if(!version)fail(400,'Версия ролика не найдена');
    const notes=notesOf(body.notes,version);
    if(!Array.isArray(body.segments)||!body.segments.length||body.segments.length>maxClips)fail(400,`Отрезки: от 1 до ${maxClips}`);
    const toggles=body.segments.map(item=>{object(item,['startMs','endMs','enabled','sound']);
      if(typeof item.enabled!=='boolean'||typeof item.sound!=='boolean')fail(400,'«Включён» и «звук» — true или false');
      return {startMs:item.startMs,endMs:item.endMs,enabled:item.enabled,sound:item.sound};});
    const stored=storedSegments(version);
    let base;
    if(stored){
      if(stored.length!==toggles.length||stored.some((item,index)=>item.startMs!==toggles[index].startMs||item.endMs!==toggles[index].endMs))
        fail(400,'Отрезки не совпадают с отрезками этой версии. Обновите страницу.','SEGMENTS_MISMATCH');
      base=stored;
    }else{
      base=segmentsOf(toggles.map(({startMs,endMs})=>({startMs,endMs})),version.duration_ms);
      if(version.duration_ms&&base.at(-1).endMs!==version.duration_ms)fail(400,'Отрезки должны покрывать ролик целиком','SEGMENTS_MISMATCH');
    }
    const kept=toggles.filter(item=>item.enabled);
    if(!kept.length)fail(400,'Нельзя выключить все отрезки: оставьте хотя бы один');
    const numbers=test=>toggles.map((item,index)=>test(item)?index+1:0).filter(Boolean);
    const off=numbers(item=>!item.enabled),silent=numbers(item=>item.enabled&&!item.sound);
    /* specs/232: исходное состояние берётся из разметки версии; без разметки все отрезки включены и со звуком. */
    const was=index=>({enabled:base[index].enabled!==false,sound:base[index].sound!==false});
    const added=toggles.map((item,index)=>item.enabled&&!was(index).enabled?index+1:0).filter(Boolean);
    if(!notes.length&&!toggles.some((item,index)=>item.enabled!==was(index).enabled||item.sound!==was(index).sound))fail(400,'Ничего не изменено: выберите фразы или добавьте пожелание');
    const note=text(body.comment??'',1500);
    const summary=['Живой монтаж',added.length?`добавлены отрезки: ${added.join(', ')}`:'',off.length?`выключены отрезки: ${off.join(', ')}`:'',silent.length?`без звука: ${silent.join(', ')}`:''].filter(Boolean).join('; ');
    const edl={v:1,video:kept.map(item=>({inMs:item.startMs,outMs:item.endMs})),audio:kept.map(item=>({inMs:item.startMs,outMs:item.endMs,gain:1,muted:!item.sound})),
      captions:[],coverMs:null,speed:1,
      live:{segments:toggles.map((item,index)=>({inMs:item.startMs,outMs:item.endMs,enabled:item.enabled,sound:item.sound,...(base[index].label?{label:base[index].label}:{})}))}};
    const comment=[summary,note,notesText(notes)].filter(Boolean).join('. ').slice(0,1900);
    const made=core.requestEdit(owner.code,row.id,{clientRequestId,baseVersion:version.version,kind:'edl',edl,comment},actor);
    // requestEdit сам выполняет транзакцию. Повтор по его ключу достраивает просьбу после сбоя между двумя сохранениями.
    const request=core.transaction(()=>{
      const at=iso(),author=who(actor);
      const id=Number(db.prepare(`INSERT INTO reel_requests(company_id,reel_id,kind,text,version,edit_id,task_id,client_request_id,author_id,author_name,created_at,updated_at,notes)
        VALUES(?,?,'redo',?,?,?,?,?,?,?,?,?,?)`).run(owner.id,row.id,comment,version.version,made.edit.id,made.edit.taskId,clientRequestId,author.id,author.name,at,at,JSON.stringify(notes)).lastInsertRowid);
      db.prepare('INSERT INTO reel_request_events(request_id,company_id,status,text,actor,created_at) VALUES(?,?,?,?,?,?)').run(id,owner.id,'accepted','',author.name,at);
      if(notes.length&&made.edit.taskId&&hasTasks())db.prepare('UPDATE tasks SET description=description||? WHERE id=? AND company_code=? COLLATE NOCASE')
        .run(`\nПожелания к монтажу, версия v${version.version}:\n${notesText(notes)}\nПолные notes: GET /internal/reel-materials/requests?companyCode=${owner.code}; связь по editId=${made.edit.id}.`,made.edit.taskId,owner.code);
      return requestDto(db.prepare('SELECT * FROM reel_requests WHERE id=?').get(id));
    });
    return {...made,request,reel:core.full(owner,row.id)};
  }

  /* --- Просьбы агенту --- */
  const eventsOf=id=>db.prepare('SELECT status,text,actor,created_at FROM reel_request_events WHERE request_id=? ORDER BY id').all(id)
    .map(e=>({status:e.status,statusLabel:STATUSES[e.status]||e.status,text:e.text,actor:e.actor,at:e.created_at}));
  const requestDto=r=>({id:r.id,reelId:r.reel_id,clientRequestId:r.client_request_id,kind:r.kind,kindLabel:KINDS[r.kind]||r.kind,status:r.status,statusLabel:STATUSES[r.status]||r.status,text:r.text,
    version:r.version,notes:parse(r.notes,[]),startMs:r.start_ms,endMs:r.end_ms,date:r.target_date||'',platformIds:parse(r.platform_ids,[]),reply:r.reply,repliedAt:r.replied_at||null,repliedBy:r.replied_by||'',
    editId:r.edit_id,postId:r.post_id,taskId:r.task_id,authorName:r.author_name,createdAt:r.created_at,updatedAt:r.updated_at,events:eventsOf(r.id)});
  function setStatus(r,status,reply,actor,at=iso(),actorId=''){
    db.prepare('UPDATE reel_requests SET status=?,reply=?,replied_at=?,replied_by=?,updated_at=? WHERE id=? AND company_id=?').run(status,reply,at,actor,at,r.id,r.company_id);
    db.prepare('INSERT INTO reel_request_events(request_id,company_id,status,text,actor,created_at,actor_id) VALUES(?,?,?,?,?,?,?)').run(r.id,r.company_id,status,reply,actor,at,actorId);
    return db.prepare('SELECT * FROM reel_requests WHERE id=?').get(r.id);
  }
  const requestFor=(owner,id)=>{const r=Number.isSafeInteger(id)&&db.prepare('SELECT * FROM reel_requests WHERE id=? AND company_id=?').get(id,owner.id);if(!r)fail(404,'Просьба не найдена','NOT_FOUND');return r;};
  const waitingText=post=>{
    const pending=(post.platformApprovals||[]).filter(item=>item&&!item.approved).map(item=>CAPTION_PLATFORMS[item.platformId]?.label||item.platformId);
    return `Черновик публикации №${post.id} создан, на площадки ничего не отправлено. Публикацию должен согласовать владелец${pending.length?' (ждут решения: '+pending.join(', ')+')':''}. После согласования она пойдёт в план.`;
  };
  const needsOwner=post=>post.approvalRequired===true&&post.approval?.approved!==true;
  /* Статус «Переделать» следует за правкой монтажа, «Опубликовать» — за публикацией автопостинга. Без таймеров: при чтении. */
  function refresh(owner,r){
    if(FINAL.includes(r.status))return r;
    if(r.edit_id){
      const edit=db.prepare('SELECT status,result_version,status_actor_id FROM reel_edits WHERE id=? AND company_id=?').get(r.edit_id,owner.id);
      if(edit?.status==='in_progress'&&r.status==='accepted')return setStatus(r,'in_progress','Агент монтажа взял ролик в работу.','Материалы');
      // Один раз: если после «готово» агент снова взял просьбу в работу, чтение карточки её не перещёлкивает.
      if(edit?.status==='done'&&r.status!=='ready'&&!db.prepare("SELECT 1 FROM reel_request_events WHERE request_id=? AND status='ready' AND actor='Материалы'").get(r.id))return setStatus(r,'ready',`Готова новая версия v${edit.result_version}. Посмотрите и скажите, подходит ли.`,'Материалы');
      if(edit?.status==='cancelled'&&r.status!=='ready')return setStatus(r,'rejected','Правка монтажа отменена.','Материалы',iso(),edit.status_actor_id);
      return r;
    }
    if(r.post_id&&autoposting?.get){
      /* Публикацию удалили в «Постинге» (404): просьба закрывается, иначе она навсегда осталась бы открытой и не давала
         попросить ещё раз. Любая другая ошибка чтения (временный сбой) просьбу не закрывает: статус остаётся прежним, карточка ролика
         и очередь продолжают открываться, сбой пишется в журнал. */
      let post;try{post=autoposting.get(r.post_id,owner.code);}catch(error){
        if(error?.status===404)return setStatus(r,'rejected','Публикация удалена в «Постинге». Если нужно — попросите опубликовать ещё раз.','Автопостинг');
        console.error('reel-requests: не удалось прочитать публикацию',r.post_id,error?.message||error);
        return r;
      }
      if(!post)return r;
      if(post.status==='published')return setStatus(r,'published','Опубликовано.','Автопостинг');
      if(post.status==='cancelled')return setStatus(r,'rejected','Публикация отменена в «Постинге».','Автопостинг');
      if(post.archive?.archivedAt)return setStatus(r,'rejected','Публикация убрана в архив.','Автопостинг');
      if(post.status==='scheduled'&&r.status!=='in_progress'&&!needsOwner(post))return setStatus(r,'in_progress','Публикация согласована и стоит в плане. Выйдет по расписанию.','Автопостинг');
      if(r.status==='waiting_owner'&&post.status==='draft'&&!needsOwner(post))return setStatus(r,'ready','Владелец согласовал публикацию. Осталось поставить её в план в «Постинге».','Автопостинг');
    }
    return r;
  }
  const requestsOf=(owner,row)=>db.prepare('SELECT * FROM reel_requests WHERE company_id=? AND reel_id=? ORDER BY id').all(owner.id,row.id).map(r=>requestDto(refresh(owner,r)));
  function taskFor(owner,row,r,actor){
    if(!hasTasks())return null;
    const at=iso(),details=[r.text,r.target_date?`новая дата: ${r.target_date}`:''].filter(Boolean).join('; ');
    return Number(db.prepare(`INSERT INTO tasks(created_at,updated_at,title,description,company_code,assignee_role,assignee_name,status,source,source_ref,source_author,created_by)
      VALUES(?,?,?,?,?,'synapse',?,'inbox','manual',?,?,?)`).run(at,at,`Материалы: «${row.title}» — ${KINDS[r.kind].toLowerCase()} (просьба №${r.id})`.slice(0,200),
      `Материалы → ролик №${row.id}${r.version?', версия '+r.version:''}.\n${KINDS[r.kind]}${details?': '+details:''}\nОчередь: GET /internal/reel-materials/requests; ответ простым языком: POST /internal/reel-materials/requests/${r.id}/reply ({status, reply}).\nПубликация — только через «Создать публикацию» и согласование автопостинга.`,
      owner.code,executor,`reel-request:${r.id}`,actor.name,actor.id).lastInsertRowid);
  }
  function createRequest(code,id,body,actor){
    const owner=company(db,code),row=core.rowFor(owner,id);
    object(body,['clientRequestId','kind','text','version','startMs','endMs','date','platformIds','notes']);
    const clientRequestId=text(body.clientRequestId??'',70,true);
    const repeat=db.prepare('SELECT * FROM reel_requests WHERE company_id=? AND client_request_id=?').get(owner.id,clientRequestId);
    if(repeat){if(repeat.reel_id!==row.id)fail(409,'Ключ запроса уже использован');return {reel:core.full(owner,row.id),request:requestDto(refresh(owner,repeat)),duplicate:true};}
    const kind=body.kind;if(typeof kind!=='string'||!Object.hasOwn(KINDS,kind))fail(400,'Вид просьбы: '+Object.keys(KINDS).join(', '));
    const allowed={redo:['version','startMs','endMs'],publish:['version','platformIds'],reschedule:['date']}[kind]||[];
    for(const field of ['version','startMs','endMs','date','platformIds'])if(body[field]!==undefined&&!allowed.includes(field))fail(400,`Поле ${field} не относится к просьбе «${KINDS[kind]}»`);
    if(body.notes!==undefined&&kind!=='redo')fail(400,'Пожелания относятся только к монтажу');
    const noteVersion=kind==='redo'?core.liveVersion(row.id,body.version===undefined?db.prepare('SELECT MAX(version) v FROM reel_versions WHERE reel_id=? AND archived_at IS NULL').get(row.id).v:int(body.version,1,Number.MAX_SAFE_INTEGER,'Версия ролика')):null;
    if(kind==='redo'&&!noteVersion)fail(400,'Версия ролика не найдена');
    const notes=notesOf(body.notes,noteVersion);
    const message=text(body.text??(notes.length?notesText(notes).slice(0,1900):''),1900,TEXT_REQUIRED.includes(kind));
    const author=who(actor),at=iso();
    const insert=fields=>{
      const data={version:null,startMs:null,endMs:null,date:'',platformIds:[],editId:null,postId:null,taskId:null,...fields};
      const requestId=Number(db.prepare(`INSERT INTO reel_requests(company_id,reel_id,kind,text,version,start_ms,end_ms,target_date,platform_ids,edit_id,post_id,task_id,client_request_id,author_id,author_name,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(owner.id,row.id,kind,message,data.version,data.startMs,data.endMs,data.date,JSON.stringify(data.platformIds),data.editId,data.postId,data.taskId,
        clientRequestId,author.id,author.name,at,at).lastInsertRowid);
      db.prepare('INSERT INTO reel_request_events(request_id,company_id,status,text,actor,created_at) VALUES(?,?,?,?,?,?)').run(requestId,owner.id,'accepted','',author.name,at);
      db.prepare('UPDATE reel_requests SET notes=? WHERE id=?').run(JSON.stringify(notes),requestId);
      return db.prepare('SELECT * FROM reel_requests WHERE id=?').get(requestId);
    };
    const result=r=>({reel:core.full(owner,row.id),request:requestDto(r),duplicate:false});
    if(kind==='redo'||kind==='publish'){
      const number=body.version===undefined?db.prepare('SELECT MAX(version) v FROM reel_versions WHERE reel_id=? AND archived_at IS NULL').get(row.id).v
        :int(body.version,1,Number.MAX_SAFE_INTEGER,'Версия ролика');
      const version=core.liveVersion(row.id,number);if(!version)fail(400,'Версия ролика не найдена');
      if(kind==='redo'){
        const whole=body.startMs===undefined&&body.endMs===undefined;
        const startMs=whole?0:body.startMs,endMs=whole?(version.duration_ms||maxMs):body.endMs;
        const made=core.requestEdit(owner.code,row.id,{clientRequestId:'rq:'+clientRequestId,baseVersion:version.version,kind:'request',comment:whole?`Весь ролик. ${message}`:message,startMs,endMs},actor);
        if(notes.length&&made.edit.taskId&&hasTasks())db.prepare('UPDATE tasks SET description=description||? WHERE id=? AND company_code=? COLLATE NOCASE')
          .run(`\nПожелания к монтажу, версия v${version.version}:\n${notesText(notes)}\nПолные notes: GET /internal/reel-materials/requests?companyCode=${owner.code}; связь по editId=${made.edit.id}.`,made.edit.taskId,owner.code);
        return result(insert({version:version.version,startMs:whole?null:startMs,endMs:whole?null:endMs,editId:made.edit.id,taskId:made.edit.taskId}));
      }
      if(db.prepare("SELECT 1 FROM reel_requests WHERE company_id=? AND reel_id=? AND kind='publish' AND version=? AND status NOT IN ('published','rejected') LIMIT 1").get(owner.id,row.id,version.version))
        fail(409,'Просьба опубликовать эту версию уже есть. Посмотрите её статус.','REQUEST_EXISTS');
      const made=core.createPublication(owner.code,row.id,{version:version.version,...(body.platformIds===undefined?{}:{platformIds:body.platformIds})},actor);
      let post=made.post;try{post={...post,...(autoposting.get(made.post.id,owner.code)||{})};}catch{/* состояние согласования неизвестно — считаем по ответу создания */}
      const warnings=(made.planText?.warnings||[]).map(item=>item.message).join(' ');
      const reply=(needsOwner(post)?waitingText(post):`Черновик публикации №${post.id} создан в «Постинге», на площадки ничего не отправлено. Проверьте текст и дату и поставьте публикацию в план.`)+(warnings?' Замечания: '+warnings:'');
      return result(setStatus(insert({version:version.version,platformIds:post.platformIds||[],postId:post.id}),needsOwner(post)?'waiting_owner':'ready',reply,'Материалы'));
    }
    const date=kind==='reschedule'?day(body.date):'';
    return result(core.transaction(()=>{
      const r=insert({date}),taskId=taskFor(owner,row,r,author);
      if(taskId)db.prepare('UPDATE reel_requests SET task_id=? WHERE id=?').run(taskId,r.id);
      return db.prepare('SELECT * FROM reel_requests WHERE id=?').get(r.id);
    }));
  }
  const taskStatus=(owner,r,status)=>{
    if(!r.task_id||!hasTasks())return;
    const next={in_progress:'in_progress',ready:'done',rejected:'cancelled'}[status];if(!next)return;
    db.prepare(`UPDATE tasks SET status=?,updated_at=? WHERE id=? AND company_code=? COLLATE NOCASE AND status IN (${next==='in_progress'?"'inbox','planned'":"'inbox','planned','in_progress'"})`).run(next,iso(),r.task_id,owner.code);
  };
  function cancelRequest(code,id,requestId,actor){
    const owner=company(db,code),row=core.rowFor(owner,id),r=refresh(owner,requestFor(owner,requestId));
    if(r.reel_id!==row.id)fail(404,'Просьба не найдена','NOT_FOUND');
    if(actor?.role!=='owner'&&String(actor?.userId??'')!==r.author_id)fail(403,'Отменить просьбу может её автор','FORBIDDEN');
    if(r.status!=='accepted')fail(409,'Просьбу уже взяли в работу или закрыли','REQUEST_STATE');
    /* Сначала закрывается просьба, затем правка: иначе чтение карточки внутри cancelEdit записало бы второе отклонение. */
    setStatus(r,'rejected','Отменено автором.',who(actor).name,iso(),who(actor).id);
    if(r.edit_id)core.cancelEdit(owner.code,row.id,r.edit_id,actor);else taskStatus(owner,r,'rejected');
    return core.full(owner,row.id);
  }
  /* --- Служебный API агента (ключ сервиса) --- */
  function requestQueue(code){
    const owner=code?company(db,code):null;
    const rows=db.prepare(`SELECT r.*,c.id owner_id,c.code company_code,m.title,m.caption FROM reel_requests r JOIN companies c ON c.id=r.company_id
      JOIN reel_materials m ON m.id=r.reel_id AND m.company_id=r.company_id
      WHERE r.status IN ('accepted','in_progress','waiting_owner') AND m.archived_at IS NULL ${owner?'AND r.company_id=?':''} ORDER BY r.id`).all(...(owner?[owner.id]:[]));
    return {requests:rows.map(item=>{const r=refresh({id:item.owner_id,code:item.company_code},item);
      return ['accepted','in_progress','waiting_owner'].includes(r.status)?{...requestDto(r),companyCode:item.company_code.toLowerCase(),title:item.title,caption:item.caption||''}:null;}).filter(Boolean)};
  }
  function reply(code,requestId,body,agent){
    const owner=company(db,code),r=refresh(owner,requestFor(owner,requestId));
    object(body,['status','reply']);
    if(body.status==='published')fail(400,'«Опубликовано» ставится только по факту публикации в автопостинге');
    if(!AGENT_STATUSES.includes(body.status))fail(400,'Статус: '+AGENT_STATUSES.join(', '));
    const answer=text(body.reply??'',2000,true);
    if(FINAL.includes(r.status))fail(409,'Просьба уже закрыта','REQUEST_STATE');
    return requestDto(core.transaction(()=>{
      if(body.status==='rejected'&&r.edit_id){
        const edit=db.prepare("SELECT * FROM reel_edits WHERE id=? AND company_id=? AND status IN ('pending','in_progress')").get(r.edit_id,owner.id);
        if(edit){db.prepare("UPDATE reel_edits SET status='cancelled',status_actor_id='',updated_at=? WHERE id=?").run(iso(),edit.id);
          if(edit.task_id&&hasTasks())db.prepare("UPDATE tasks SET status='cancelled',updated_at=? WHERE id=? AND company_code=? COLLATE NOCASE").run(iso(),edit.task_id,owner.code);}
      }else if(!r.edit_id)taskStatus(owner,r,body.status);
      return setStatus(r,body.status,answer,text(String(agent||executor),200));
    }));
  }
  /* Записи для личного чата автора с Хью (hughLog). «Переделать» уже попадает туда записью правки, здесь — остальные виды. */
  function hughEntries(owner,author){
    const rows=db.prepare(`SELECT r.*,m.title FROM reel_requests r JOIN reel_materials m ON m.id=r.reel_id AND m.company_id=r.company_id
      WHERE r.company_id=? AND r.author_id=? AND r.edit_id IS NULL ORDER BY r.id DESC LIMIT 100`).all(owner.id,author).reverse();
    return rows.flatMap(r=>[{key:`reel-request:${r.id}:request`,at:r.created_at,from:'user',authorName:r.author_name,requestId:r.id,reelId:r.reel_id,
        text:`«${r.title}» — ${KINDS[r.kind]||r.kind}${r.target_date?' на '+r.target_date:''}${r.text?': '+r.text:''}`},
      ...db.prepare("SELECT id,status,text,created_at FROM reel_request_events WHERE request_id=? AND text<>'' AND actor_id<>? ORDER BY id").all(r.id,r.author_id)
        .map(e=>({key:`reel-request:${r.id}:reply:${e.id}`,at:e.created_at,from:'hugh',requestId:r.id,reelId:r.reel_id,text:`«${r.title}» — ${STATUSES[e.status]||e.status}: ${e.text}`}))]);
  }
  /* Добавка к карточке ролика. В списке — только то, что нужно ленте; в полной карточке — просьбы и история. */
  function decorate(out,row,owner,full){
    const extra={caption:row.caption||'',decision:row.decision||'',decisionLabel:DECISIONS[row.decision||''],decisionComment:row.decision_comment||'',
      openRequests:db.prepare("SELECT COUNT(*) n FROM reel_requests WHERE company_id=? AND reel_id=? AND status NOT IN ('published','rejected')").get(owner.id,row.id).n};
    if(!full)return {...out,...extra};
    const requests=requestsOf(owner,row);
    return {...out,...extra,openRequests:requests.filter(item=>!FINAL.includes(item.status)).length,requests,history:historyOf(owner,row),problemReports:problems.list(owner,row.id)};
  }
  return {REVIEW_FIELDS,reviewOf,saveReview,ownText,segmentsOf,decorate,hughEntries,
    api:{createRequest,cancelRequest,requestQueue,replyRequest:reply,getSegments,setSegments,liveEdit,reportProblem:problems.report}};
}
module.exports={createReelRequests,REQUEST_KINDS:KINDS,REQUEST_STATUSES:STATUSES,DECISIONS};
