'use strict';
/* specs/224-content-archive: мягкое удаление на этапах контент-завода — идея плана, ролик и версия ролика,
   опубликованная публикация. Ничего физически не стирается, восстановление возвращает как было. */
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createMediaMentor}=require('./media-mentor');
const {createReelMaterials}=require('./reel-materials');
const {createReelMaterialsHandler}=require('./reel-materials-http');
const {createCompanyInformation}=require('./company-information');
const {createAutoposting}=require('./autoposting');

const ACTOR={userId:7,userName:'Влад'};
const BRIEF={goal:'Записи',product:'Курс',audience:'Женщины 30–45',pains:['Спина'],confirmedFacts:[],assets:[],
  shootingComfort:{level:'hands_only',notes:''},platforms:['vk','telegram']};
const days=(n=7)=>Array.from({length:n},(_,i)=>({ideaId:`idea-${i+1}`,date:new Date(Date.parse('2026-11-01T00:00:00Z')+i*86400000).toISOString().slice(0,10),
  platform:'vk',format:'reel',role:'reach',topic:`Тема ${i+1}`,hook:'',assetId:'',mentorNote:'',variants:{vk:{text:`Подпись ${i+1}`,hook:'',format:'reel',assetId:'',mentorNote:''}}}));
function mentorFixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'avokado','Авокадо','Asia/Irkutsk','[]'),(2,'alvi','ALVI','Asia/Irkutsk','[]');`);
  const api=createMediaMentor(db);
  const brief=api.saveBrief('avokado',{revision:0,brief:BRIEF},ACTOR);
  api.savePlan('avokado',{planRevision:0,briefRevision:brief.brief.revision,days:days()},ACTOR);
  return {db,api};
}

test('идея плана: «Убрать» скрывает её из плана без новой версии плана и без сброса решений, «Вернуть» возвращает',t=>{
  const {db,api}=mentorFixture(t);
  const before=api.decideVariants('avokado',{planRevision:1,briefRevision:1,scope:'idea',ideaId:'idea-1',decision:'approved',comment:''},ACTOR);
  assert.equal(before.variants.find(v=>v.ideaId==='idea-1').status,'approved');
  assert.throws(()=>api.archiveIdea('alvi','idea-2',{reason:'дубль'},ACTOR),e=>e.status===404,'чужая компания не видит идею');
  assert.throws(()=>api.archiveIdea('avokado','../x',{},ACTOR),e=>e.status===404);
  assert.throws(()=>api.archiveIdea('avokado','idea-2',{reason:'дубль',extra:1},ACTOR),e=>e.status===400);
  const archived=api.archiveIdea('avokado','idea-2',{reason:'дубль'},ACTOR);
  assert.equal(archived.plan.revision,1,'версия плана не меняется');
  assert.deepEqual(archived.plan.days.map(d=>d.ideaId),['idea-1','idea-3','idea-4','idea-5','idea-6','idea-7']);
  assert.ok(!archived.variants.some(v=>v.ideaId==='idea-2'),'убранная идея не участвует в согласовании');
  assert.equal(archived.variants.find(v=>v.ideaId==='idea-1').status,'approved','решение по соседней идее сохранено');
  assert.equal(archived.archivedIdeas.length,1);
  assert.deepEqual({...archived.archivedIdeas[0],archive:{...archived.archivedIdeas[0].archive,archivedAt:'*'}},
    {ideaId:'idea-2',date:'2026-11-02',platform:'vk',format:'reel',topic:'Тема 2',inPlan:true,archive:{archivedAt:'*',archivedBy:7,archivedByName:'Влад',reason:'дубль'}});
  assert.throws(()=>api.archiveIdea('avokado','idea-2',{},ACTOR),e=>e.details.code==='IDEA_ARCHIVED');
  assert.equal(api.get('alvi').archivedIdeas.length,0,'архив не виден другой компании');
  // Сырой план не изменился: данные идеи на месте.
  assert.ok(JSON.parse(db.prepare('SELECT plan FROM media_mentor_plans WHERE company_id=1').get().plan).days.some(d=>d.ideaId==='idea-2'));
  const restored=api.restoreIdea('avokado','idea-2',{},ACTOR);
  assert.equal(restored.plan.revision,1);assert.equal(restored.plan.days.length,7);assert.equal(restored.archivedIdeas.length,0);
  assert.throws(()=>api.restoreIdea('avokado','idea-2',{},ACTOR),e=>e.details.code==='IDEA_NOT_ARCHIVED');
  assert.deepEqual(db.prepare('SELECT action FROM media_mentor_idea_archive_events ORDER BY id').all().map(r=>r.action),['archived','restored']);
});

test('идея плана: после пересохранения плана без неё возвращается из архивной копии новой версией плана',t=>{
  const {db,api}=mentorFixture(t);
  const archived=api.archiveIdea('avokado','idea-7',{},ACTOR);
  // Кабинет сохраняет видимые строки — убранной идеи в теле нет.
  const saved=api.savePlan('avokado',{planRevision:1,briefRevision:1,days:archived.plan.days.map(d=>({...d,topic:d.ideaId==='idea-1'?'Новая тема':d.topic}))},ACTOR);
  assert.equal(saved.plan.revision,2);assert.equal(saved.archivedIdeas[0].inPlan,false);
  assert.ok(!JSON.parse(db.prepare('SELECT plan FROM media_mentor_plans WHERE company_id=1').get().plan).days.some(d=>d.ideaId==='idea-7'));
  const restored=api.restoreIdea('avokado','idea-7',{},ACTOR);
  assert.equal(restored.plan.revision,3);assert.equal(restored.plan.days.at(-1).ideaId,'idea-7');assert.equal(restored.plan.days.at(-1).topic,'Тема 7');
  assert.equal(restored.plan.days[0].topic,'Новая тема','правки после архивации не потеряны');
  assert.equal(restored.archivedIdeas.length,0);
});

const asset=(code,n='a')=>`https://synapse.synapsebusiness.ru/content/publishing-assets/${code}/${n.repeat(32)}.mp4`;
function reelFixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,is_deleted INTEGER DEFAULT 0);INSERT INTO companies(id,code) VALUES(1,'avokado'),(2,'alvi');
    CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT,updated_at TEXT,is_deleted INTEGER DEFAULT 0,title TEXT,description TEXT,company_code TEXT,
      assignee_role TEXT,assignee_name TEXT,status TEXT,priority TEXT DEFAULT 'normal',due_date TEXT DEFAULT '',source TEXT,source_ref TEXT,source_author TEXT,created_by TEXT);`);
  const posts={avokado:[{id:11,title:'Рилс из плана',mediaUrls:[asset('avokado','c')],platformIds:['vk'],scheduledAt:null}],alvi:[]},created=[];
  const autoposting={list:code=>({posts:posts[code]}),get:(id,code)=>{const p=posts[code].find(x=>x.id===id);if(!p)throw Object.assign(Error('nf'),{status:404});return p;},
    create:(code,body)=>{created.push(body);return {id:500+created.length,title:body.title,status:'draft',platformIds:body.platformIds,mediaUrls:body.mediaUrls};}};
  return {db,created,materials:createReelMaterials(db,{autoposting,information:{get:()=>({revision:1})}})};
}
const editor={userId:7,userName:'СММ'};

test('ролик: «Убрать» уводит карточку в архив, список «Архив» её показывает, «Вернуть» возвращает; данные целы',()=>{
  const {db,materials}=reelFixture();
  const reel=materials.create('avokado',{title:'SAMPLE ролик v2',releaseDate:'2026-11-10',platforms:['vk'],mediaUrl:asset('avokado')},editor);
  assert.throws(()=>materials.archive('alvi',reel.id,{},editor),e=>e.status===404,'чужая компания');
  assert.throws(()=>materials.archive('avokado',reel.id,{reason:'x'.repeat(501)},editor),e=>e.status===400);
  const archived=materials.archive('avokado',reel.id,{reason:'лишняя версия'},editor);
  assert.equal(archived.archive.reason,'лишняя версия');assert.ok(archived.archive.archivedAt);assert.equal(archived.archive.archivedBy,'7');
  assert.ok(!materials.list('avokado').reels.some(r=>r.id===reel.id),'нет в общей ленте');
  assert.deepEqual(materials.list('avokado',{archived:true}).reels.map(r=>r.id),[reel.id]);
  assert.equal(materials.list('alvi',{archived:true}).reels.length,0);
  assert.equal(materials.get('avokado',reel.id).archive.reason,'лишняя версия','карточку можно открыть');
  for(const mutate of [()=>materials.update('avokado',reel.id,{title:'Нельзя'}),()=>materials.createPublication('avokado',reel.id,{version:1},editor),
    ()=>materials.archive('avokado',reel.id,{},editor)])assert.throws(mutate,e=>e.status===409);
  const restored=materials.restore('avokado',reel.id,{},editor);
  assert.equal(restored.archive.archivedAt,null);assert.equal(restored.currentVersion.mediaUrl,asset('avokado'));
  assert.ok(materials.list('avokado').reels.some(r=>r.id===reel.id));
  assert.throws(()=>materials.restore('avokado',reel.id,{},editor),e=>e.details.code==='REEL_NOT_ARCHIVED');
  assert.deepEqual(db.prepare('SELECT action FROM reel_archive_events ORDER BY id').all().map(r=>r.action),['archived','restored']);
});

test('ролик из плана (без своей карточки) после «Убрать» не всплывает снова; правка «в монтаже» не даёт убрать',()=>{
  const {materials}=reelFixture();
  const adopted=materials.create('avokado',{postId:11},editor);
  materials.archive('avokado',adopted.id,{},editor);
  assert.ok(!materials.list('avokado').reels.some(r=>r.postId===11),'публикация из плана не превращается обратно в ролик');
  materials.restore('avokado',adopted.id,{},editor);
  const edit=materials.requestEdit('avokado',adopted.id,{clientRequestId:'k1',baseVersion:1,kind:'request',comment:'Звук тише',startMs:0,endMs:1000},editor);
  materials.claim('avokado',edit.edit.id);
  assert.throws(()=>materials.archive('avokado',adopted.id,{},editor),e=>e.details.code==='EDIT_IN_PROGRESS');
});

test('версия ролика: убирается отдельно, последнюю убрать нельзя, архивная версия не публикуется и не правится',()=>{
  const {materials,created}=reelFixture();
  const reel=materials.create('avokado',{title:'SAMPLE ролик',platforms:['vk'],mediaUrl:asset('avokado','a'),durationMs:10000},editor);
  materials.addVersion('avokado',reel.id,{mediaUrl:asset('avokado','b'),note:'звук выровнен'},'agent');
  assert.throws(()=>materials.archiveVersion('avokado',reel.id,9,{},editor),e=>e.status===404);
  const out=materials.archiveVersion('avokado',reel.id,2,{reason:'не та'},editor);
  assert.equal(out.currentVersion.version,1,'текущей становится последняя живая версия');
  assert.deepEqual(out.versions.map(v=>v.version),[1]);assert.equal(out.archivedVersionList[0].archive.reason,'не та');assert.equal(out.archivedVersions,1);
  assert.throws(()=>materials.archiveVersion('avokado',reel.id,1,{},editor),e=>e.details.code==='LAST_VERSION');
  assert.throws(()=>materials.createPublication('avokado',reel.id,{version:2},editor),e=>e.details.code==='VERSION_ARCHIVED');
  assert.throws(()=>materials.requestEdit('avokado',reel.id,{clientRequestId:'k2',baseVersion:2,kind:'request',comment:'x',startMs:0,endMs:500},editor),e=>e.details.code==='VERSION_ARCHIVED');
  assert.equal(created.length,0);
  const next=materials.addVersion('avokado',reel.id,{mediaUrl:asset('avokado','c')},'agent');
  assert.equal(next.version.version,3,'номер новой версии не переиспользует архивную');
  const back=materials.restoreVersion('avokado',reel.id,2,{},editor);
  assert.deepEqual(back.versions.map(v=>v.version),[1,2,3]);assert.equal(back.archivedVersions,0);
});

test('HTTP ролика: убрать/вернуть только с правом правки контента своей компании',async()=>{
  const {materials}=reelFixture();
  const reel=materials.create('avokado',{title:'Черновик',platforms:['vk'],mediaUrl:asset('avokado')},editor);
  const contexts={edit:{identity:{userId:7,userName:'СММ'},company:{code:'avokado'}}};
  const handler=createReelMaterialsHandler({materials,trustedService:()=>false,readJson:async request=>request.body,
    send:(response,status,body)=>{response.status=status;response.body=body;},
    companyModuleContext:(request,code,permission)=>{
      if(request.perms.includes(permission)&&code==='avokado')return contexts.edit;
      throw Object.assign(Error('forbidden'),{status:403});
    }});
  const call=async(method,path,perms=['autoposting.view','autoposting.edit'],body=/\/archive\?/.test(path)?{reason:'дубль'}:{})=>{
    const response={},url=new URL('http://crm'+path);
    try{await handler({method,perms,body,headers:{}},response,url);}catch(error){response.status=error.status;}
    return response;
  };
  assert.equal((await call('POST',`/autoposting/reels/${reel.id}/archive?companyCode=avokado`,['autoposting.view'])).status,403,'только просмотр — нельзя');
  assert.equal((await call('POST',`/autoposting/reels/${reel.id}/archive?companyCode=alvi`)).status,403,'чужая компания');
  assert.equal((await call('GET',`/autoposting/reels/${reel.id}/archive?companyCode=avokado`)).status,405);
  const ok=await call('POST',`/autoposting/reels/${reel.id}/archive?companyCode=avokado`);
  assert.equal(ok.status,200);assert.equal(ok.body.archive.reason,'дубль');
  const list=await call('GET','/autoposting/reels?companyCode=avokado&archived=1',['autoposting.view']);
  assert.deepEqual(list.body.reels.map(r=>r.id),[reel.id]);
  assert.equal((await call('POST',`/autoposting/reels/${reel.id}/restore?companyCode=avokado`)).body.archive.archivedAt,null);
  materials.addVersion('avokado',reel.id,{mediaUrl:asset('avokado','b')},'agent');
  assert.equal((await call('POST',`/autoposting/reels/${reel.id}/versions/2/archive?companyCode=avokado`,['autoposting.view'])).status,403);
  assert.equal((await call('POST',`/autoposting/reels/${reel.id}/versions/2/archive?companyCode=avokado`)).body.currentVersion.version,1);
  assert.equal((await call('POST',`/autoposting/reels/${reel.id}/versions/2/restore?companyCode=avokado`)).body.currentVersion.version,2);
});

function postFixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'qa','QA','UTC','[]'),(2,'other','Other','UTC','[]');`);
  const transport={getSettings:()=>({channels:[]}),publish:()=>{throw Error('Недопустимый внешний вызов');}};
  const api=createAutoposting(db,{information:createCompanyInformation(db),transport});
  return {db,api,post:api.create('qa',{title:'Пост',text:'Текст',mediaUrls:[],platformIds:['telegram'],scheduledAt:null},1)};
}
test('опубликованный пост: архив только с явным подтверждением, статус и доставка сохраняются, площадки не трогаются',t=>{
  const {db,api,post}=postFixture(t);
  db.prepare("UPDATE autoposting_posts SET status='published' WHERE id=?").run(post.id);
  db.prepare("INSERT INTO autoposting_deliveries(post_id,channel_id,channel_revision,status) VALUES(?,'telegram',1,'published')").run(post.id);
  const fresh=api.get(post.id,'qa');
  assert.throws(()=>api.archive(post.id,'qa',{revision:fresh.revision},{userId:1}),e=>e.status===409&&e.details.code==='ARCHIVE_PUBLISHED');
  assert.throws(()=>api.archive(post.id,'qa',{revision:fresh.revision,confirmPublished:'yes'},{userId:1}),e=>e.status===400);
  const archived=api.archive(post.id,'qa',{revision:fresh.revision,confirmPublished:true,reason:'старый пост'},{userId:1});
  assert.equal(archived.status,'published');assert.equal(archived.archive.reason,'старый пост');assert.ok(archived.archive.archivedAt);
  assert.equal(db.prepare('SELECT status FROM autoposting_deliveries WHERE post_id=?').get(post.id).status,'published');
  assert.equal(api.list('qa').posts.length,0);assert.equal(api.archived('qa').posts.length,1);
  const restored=api.restore(post.id,'qa',{revision:archived.revision},{userId:1});
  assert.equal(restored.status,'published');assert.equal(restored.archive.archivedAt,null);assert.equal(api.list('qa').posts.length,1);
});
test('черновик поста: причина сохраняется; незавершённая отправка и расписание по-прежнему не убираются',t=>{
  const {db,api,post}=postFixture(t);
  const archived=api.archive(post.id,'qa',{revision:post.revision,reason:'лишний'},{userId:1});
  assert.equal(archived.archive.reason,'лишний');
  const restored=api.restore(post.id,'qa',{revision:archived.revision},{userId:1});
  assert.equal(restored.archive.reason,'');
  db.prepare("UPDATE autoposting_posts SET status='scheduled' WHERE id=?").run(post.id);
  assert.throws(()=>api.archive(post.id,'qa',{revision:api.get(post.id,'qa').revision,confirmPublished:true},{userId:1}),e=>e.details.code==='ARCHIVE_SCHEDULED');
});
