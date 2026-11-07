'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createReelMaterials,validateEdl}=require('./reel-materials');
const {createReelMaterialsHandler}=require('./reel-materials-http');
const asset=(code,n='a')=>`https://synapse.synapsebusiness.ru/content/publishing-assets/${code}/${n.repeat(32)}.mp4`;
const edl=over=>({v:1,video:[{inMs:0,outMs:4000},{inMs:6000,outMs:9000}],audio:[{inMs:0,outMs:7000,gain:0.5,muted:false}],captions:[{startMs:0,endMs:1500,text:'Новый титр'}],coverMs:1200,speed:1.25,...over});

function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies(id,code) VALUES(1,'avokado'),(2,'alvi');
    CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT,updated_at TEXT,is_deleted INTEGER DEFAULT 0,title TEXT,description TEXT,company_code TEXT,
      assignee_role TEXT,assignee_name TEXT,status TEXT,priority TEXT DEFAULT 'normal',due_date TEXT DEFAULT '',source TEXT,source_ref TEXT,source_author TEXT,created_by TEXT);`);
  const posts={avokado:[{id:11,title:'Рилс из плана',mediaUrls:[asset('avokado','c')],platformIds:['instagram','vk'],scheduledAt:'2026-11-06T03:00:00Z',timezone:'Asia/Irkutsk',mediaSha256:''},
    {id:12,title:'Пост с фото',mediaUrls:['https://x.example/a.jpg'],platformIds:['vk'],scheduledAt:null}],alvi:[]};
  const created=[];
  const autoposting={list:code=>({posts:posts[code]}),get:(id,code)=>{const post=posts[code].find(p=>p.id===id);if(!post)throw Object.assign(Error('nf'),{status:404});return post;},
    create:(code,body,actorId)=>{created.push({code,body,actorId});return {id:500+created.length,title:body.title,status:'draft',platformIds:body.platformIds,mediaUrls:body.mediaUrls};}};
  const materials=createReelMaterials(db,{autoposting,information:{get:()=>({revision:3})}});
  return {db,materials,created};
}
const editor={userId:7,userName:'СММ',role:'editor',permissions:new Set(['autoposting.view','autoposting.edit']),companyCodes:new Set(['avokado'])};

test('EDL: порядок, обрезка, громкость, титры, обложка и скорость проверяются; ошибки отклоняются',()=>{
  const out=validateEdl(edl(),10000);
  assert.deepEqual(out.video,[{inMs:0,outMs:4000},{inMs:6000,outMs:9000}]);
  assert.equal(out.outputMs,Math.round(7000/1.25));assert.equal(out.audio[0].gain,0.5);assert.equal(out.coverMs,1200);
  for(const bad of [edl({v:2}),edl({video:[]}),edl({video:[{inMs:500,outMs:400}]}),edl({video:[{inMs:0,outMs:20000}]}),
    edl({audio:[{inMs:0,outMs:1000,gain:3}]}),edl({speed:2}),edl({captions:[{startMs:0,endMs:1,text:''}]}),edl({coverMs:99999}),edl({extra:1}),
    edl({video:[{inMs:0,outMs:1000,src:'file:///etc/passwd'}]})])
    assert.throws(()=>validateEdl(bad,10000),{status:400});
});

test('Список: рилсы из плана и из «Материалов», фильтры по дате выхода и площадке, без чужой компании',()=>{
  const f=fixture();
  f.materials.create('avokado',{title:'Монтаж v1',releaseDate:'2026-11-10',platforms:['tiktok','max'],mediaUrl:asset('avokado'),durationMs:10000},editor);
  f.materials.create('alvi',{title:'Чужой',releaseDate:'2026-11-10',platforms:['tiktok'],mediaUrl:asset('alvi')},editor);
  const all=f.materials.list('avokado');
  assert.deepEqual(all.reels.map(r=>r.title),['Монтаж v1','Рилс из плана']);
  assert.equal(all.reels[1].releaseDate,'2026-11-06');assert.equal(all.reels[1].source,'plan');
  assert.deepEqual(f.materials.list('avokado',{platform:'vk'}).reels.map(r=>r.title),['Рилс из плана']);
  assert.deepEqual(f.materials.list('avokado',{from:'2026-11-07',to:'2026-11-30'}).reels.map(r=>r.title),['Монтаж v1']);
  assert.deepEqual(f.materials.list('alvi').reels.map(r=>r.title),['Чужой']);
  assert.throws(()=>f.materials.list('avokado',{platform:'myspace'}),{status:400});
  assert.throws(()=>f.materials.list('avokado',{from:'06.11.2026'}),{status:400});
});

test('Изоляция: ролик другой компании не принимается и не читается по id',()=>{
  const f=fixture();
  assert.throws(()=>f.materials.create('avokado',{title:'x',mediaUrl:asset('alvi')},editor),{status:403});
  assert.throws(()=>f.materials.create('avokado',{title:'x',mediaUrl:'http://synapse.synapsebusiness.ru/content/publishing-assets/avokado/'+'a'.repeat(32)+'.mp4'},editor),{status:400});
  const alien=f.materials.create('alvi',{title:'Чужой',mediaUrl:asset('alvi')},editor);
  assert.throws(()=>f.materials.get('avokado',alien.id),{status:404});
  assert.throws(()=>f.materials.requestEdit('avokado',alien.id,{clientRequestId:'r1',baseVersion:1,kind:'request',comment:'x',startMs:0,endMs:1000},editor),{status:404});
  assert.throws(()=>f.materials.addVersion('avokado',alien.id,{mediaUrl:asset('avokado','b')}),{status:404});
});

test('Хост ролика: только разрешённый origin хранилища или относительный путь; чужой хост → 400 (кабинет и агент монтажа)',()=>{
  const f=fixture(),name='a'.repeat(32)+'.mp4',path='/content/publishing-assets/avokado/'+name;
  for(const host of ['https://evil.example','https://synapse.synapsebusiness.ru.evil.example','https://synapse.synapsebusiness.ru:8443','https://127.0.0.1'])
    assert.throws(()=>f.materials.create('avokado',{title:'x',mediaUrl:host+path},editor),error=>error.status===400&&error.details?.code==='MEDIA_HOST',host);
  assert.throws(()=>f.materials.create('avokado',{title:'x',mediaUrl:'//evil.example'+path},editor),{status:400});
  const relative=f.materials.create('avokado',{title:'Относительный',mediaUrl:path},editor);
  assert.equal(relative.versions[0].mediaUrl,'https://synapse.synapsebusiness.ru'+path);
  assert.throws(()=>f.materials.addVersion('avokado',relative.id,{mediaUrl:'https://evil.example/content/publishing-assets/avokado/'+'b'.repeat(32)+'.mp4'}),{status:400});
  const custom=createReelMaterials(f.db,{mediaOrigins:'https://cdn.synapse.test, https://synapse.synapsebusiness.ru'});
  assert.equal(custom.create('avokado',{title:'CDN',mediaUrl:'https://cdn.synapse.test'+path},editor).versions[0].mediaUrl,'https://cdn.synapse.test'+path);
  assert.throws(()=>createReelMaterials(f.db,{mediaOrigins:'http://insecure.test'}),/https/);
  /* Рилс из плана с видео на чужом хосте в «Материалы» не попадает. */
  const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,is_deleted INTEGER DEFAULT 0);INSERT INTO companies VALUES(1,'avokado',0);CREATE TABLE tasks(id INTEGER PRIMARY KEY);");
  const plan=createReelMaterials(db,{autoposting:{list:()=>({posts:[{id:1,title:'Чужой хост',mediaUrls:['https://evil.example'+path],platformIds:[]}]})}});
  assert.deepEqual(plan.list('avokado').reels,[]);
});

test('Правка → задача монтажа → claim → новая версия v2, журнал «исправлено»; повтор запроса без дубля',()=>{
  const f=fixture(),reel=f.materials.create('avokado',{title:'Рилс',mediaUrl:asset('avokado'),durationMs:10000},editor);
  const body={clientRequestId:'req-1',baseVersion:1,kind:'request',comment:'Хью, убери паузу',startMs:2000,endMs:3500};
  const first=f.materials.requestEdit('avokado',reel.id,body,editor),again=f.materials.requestEdit('avokado',reel.id,body,editor);
  assert.equal(again.duplicate,true);assert.equal(again.edit.id,first.edit.id);
  const task=f.db.prepare('SELECT * FROM tasks').all();assert.equal(task.length,1);
  assert.equal(task[0].company_code,'avokado');assert.equal(task[0].assignee_name,'Claude · монтаж');assert.equal(task[0].source_ref,'reel-edit:'+first.edit.id);
  const edlEdit=f.materials.requestEdit('avokado',reel.id,{clientRequestId:'req-2',baseVersion:1,kind:'edl',edl:edl()},editor);
  assert.equal(edlEdit.edit.edl.speed,1.25);
  assert.deepEqual(f.materials.queue('alvi').edits,[]);
  assert.equal(f.materials.queue('avokado').edits.length,2);assert.equal(f.materials.queue('avokado').edits[0].base.mediaUrl,asset('avokado'));
  assert.throws(()=>f.materials.claim('alvi',first.edit.id),{status:404});
  assert.equal(f.materials.claim('avokado',first.edit.id).status,'in_progress');
  assert.throws(()=>f.materials.cancelEdit('avokado',reel.id,first.edit.id),{status:409});
  const done=f.materials.addVersion('avokado',reel.id,{mediaUrl:asset('avokado','b'),sha256:'f'.repeat(64),durationMs:8000,editId:first.edit.id,note:'reels-check ✔'});
  assert.equal(done.version.version,2);assert.equal(done.version.editId,first.edit.id);
  assert.match(done.hughChat.text,/Исправлено.*v2/);
  assert.deepEqual(done.reel.log.map(item=>item.from),['user','hugh','user']);
  assert.throws(()=>f.materials.addVersion('avokado',reel.id,{mediaUrl:asset('avokado','d'),editId:first.edit.id}),{status:409});
  assert.equal(f.materials.cancelEdit('avokado',reel.id,edlEdit.edit.id).edits[1].status,'cancelled');
  assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(edlEdit.edit.taskId).status,'cancelled');
  const log=f.materials.hughLog('avokado',7);
  assert.deepEqual(log.entries.map(e=>[e.key.replace(/\d+/,'N'),e.from]),[['reel-edit:N:request','user'],['reel-edit:N:done','hugh'],['reel-edit:N:request','user'],['reel-edit:N:cancelled','hugh']]);
  assert.match(log.entries[0].text,/^«Рилс» — Хью, измени \(v1, 2\.0–3\.5 с\): Хью, убери паузу$/);assert.match(log.entries[1].text,/Исправлено: «Рилс» — готова v2/);
  assert.deepEqual(f.materials.hughLog('avokado',8).entries,[],'чужой автор не видит правки');
  assert.deepEqual(f.materials.hughLog('alvi',7).entries,[],'другая компания не видит правки');
  assert.throws(()=>f.materials.hughLog('avokado','0'),{status:400});
});

test('Создать публикацию: черновик автопостинга с версией ролика, без отправки; рилс из плана берётся в материалы один раз',()=>{
  const f=fixture(),adopted=f.materials.create('avokado',{postId:11},editor),repeat=f.materials.create('avokado',{postId:11},editor);
  assert.equal(adopted.id,repeat.id);assert.equal(adopted.versions[0].mediaUrl,asset('avokado','c'));
  assert.throws(()=>f.materials.create('avokado',{postId:12},editor),{status:400});
  assert.deepEqual(f.materials.list('avokado').reels.map(r=>r.source),['materials']);
  const reel=f.materials.create('avokado',{title:'Новый',mediaUrl:asset('avokado'),platforms:['tiktok']},editor);
  const out=f.materials.createPublication('avokado',reel.id,{version:1,platformIds:['instagram','max']},editor);
  assert.deepEqual(f.created[0].body.mediaUrls,[asset('avokado')]);assert.deepEqual(f.created[0].body.platformIds,['instagram','max']);
  assert.equal(f.created[0].body.profileRevision,3);assert.equal(f.created[0].body.format,'reel');assert.equal(out.reel.postId,out.post.id);
  assert.equal(f.created[0].body.scheduledAt,undefined);
});

test('HTTP: права по autoposting.view/edit, компания проверяется сервером, служебный API только без личности',async()=>{
  const f=fixture(),contexts=[];
  const companyModuleContext=(req,code,permission)=>{contexts.push(permission);const a=req.identity;
    if(!a||a.role!=='owner'&&!a.permissions.has(permission))throw Object.assign(Error('forbidden'),{status:403});
    if(a.role!=='owner'&&!a.companyCodes.has(String(code).toLowerCase()))throw Object.assign(Error('forbidden'),{status:403});return {identity:a,company:{code}};};
  const handle=createReelMaterialsHandler({materials:f.materials,companyModuleContext,readJson:async req=>req.body,send:(res,status,body)=>Object.assign(res,{status,body}),trustedService:req=>!req.identity});
  const call=async(method,path,{identity=editor,body,code='avokado'}={})=>{const res={},url=new URL('http://crm'+path);if(code)url.searchParams.set('companyCode',code);
    const handled=await handle({method,body,identity,headers:{}},res,url);return {handled,...res};};
  assert.equal((await call('GET','/autoposting/posts')).handled,false);
  const created=await call('POST','/autoposting/reels',{body:{title:'HTTP',mediaUrl:asset('avokado'),durationMs:5000}});
  assert.equal(created.status,201);
  assert.equal((await call('GET','/autoposting/reels')).body.reels.length,2);
  const viewer={...editor,permissions:new Set(['autoposting.view'])};
  await assert.rejects(call('POST','/autoposting/reels/'+created.body.id+'/edits',{identity:viewer,body:{}}),{status:403});
  await assert.rejects(call('GET','/autoposting/reels',{code:'alvi'}),{status:403});
  const edit=await call('POST','/autoposting/reels/'+created.body.id+'/edits',{body:{clientRequestId:'h1',baseVersion:1,kind:'request',comment:'Хью, ярче',startMs:0,endMs:1000}});
  assert.equal(edit.status,201);
  await assert.rejects(call('GET','/internal/reel-materials/queue'),{status:403});
  const queue=await call('GET','/internal/reel-materials/queue',{identity:null,code:''});assert.equal(queue.body.edits.length,1);
  const version=await call('POST','/internal/reel-materials/reels/'+created.body.id+'/versions',{identity:null,body:{mediaUrl:asset('avokado','e'),editId:edit.body.edit.id}});
  assert.equal(version.body.version.version,2);
  await assert.rejects(call('DELETE','/autoposting/reels/'+created.body.id),{status:405});
  assert.ok(contexts.includes('autoposting.view')&&contexts.includes('autoposting.edit'));
});

/* specs/227-plan-caption-to-post: текст публикации из версий площадок идеи действующего плана своей компании. */
function withPlan(f){
  f.db.exec(`CREATE TABLE IF NOT EXISTS media_mentor_plans(company_id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,brief_revision INTEGER NOT NULL,plan TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS media_mentor_idea_archive(company_id INTEGER NOT NULL,idea_id TEXT NOT NULL,idea TEXT NOT NULL,archived_at TEXT NOT NULL,archived_by INTEGER,archived_by_name TEXT NOT NULL DEFAULT '',reason TEXT NOT NULL DEFAULT '',PRIMARY KEY(company_id,idea_id));`);
  const put=(companyId,revision,days)=>f.db.prepare('INSERT OR REPLACE INTO media_mentor_plans(company_id,revision,brief_revision,plan,updated_at) VALUES(?,?,1,?,?)')
    .run(companyId,revision,JSON.stringify({days}),'2026-11-07T00:00:00Z');
  return put;
}
const planIdea=(ideaId,variants,extra={})=>({ideaId,date:'2026-11-12',platform:'vk',format:'reel',role:'reach',topic:'SAMPLE тема плана',variants,...extra});

test('specs/227: «Создать публикацию» берёт текст из версий идеи плана — основной текст, подписи площадок, тема, пометка ревизии',()=>{
  const f=fixture(),put=withPlan(f);
  put(1,7,[planIdea('s-1',{vk:{text:'SAMPLE текст VK',contentRevision:3},telegram:{text:'SAMPLE текст TG',contentRevision:1},
    instagram:{text:'SAMPLE текст VK',contentRevision:2},max:{text:'SAMPLE исключён',excluded:true}})]);
  const reel=f.materials.create('avokado',{title:'Монтаж темы',mediaUrl:asset('avokado'),platforms:['vk'],ideaId:'s-1'},editor);
  const out=f.materials.createPublication('avokado',reel.id,{version:1,platformIds:['vk','telegram','instagram','max']},editor);
  const body=f.created[0].body;
  assert.equal(body.text,'SAMPLE текст VK','основной текст — версия основной площадки идеи');
  assert.deepEqual(body.captions,{telegram:'SAMPLE текст TG'},'подпись — только у отличающейся версии; совпадающая и исключённая не дублируются');
  assert.equal(body.title,'SAMPLE тема плана','заголовок — тема идеи');
  assert.match(body.origin,/^Материалы: ролик №\d+ v1 · текст из контент-плана, ревизия плана 7, тема s-1$/);
  assert.equal(out.planText.source,'plan');assert.equal(out.planText.planRevision,7);assert.equal(out.planText.mainPlatform,'vk');
  assert.deepEqual(out.planText.captionPlatforms,['telegram']);assert.deepEqual(out.planText.warnings,[]);
  assert.equal(out.planText.text,undefined,'сам текст в отчёт не дублируется');
  // Свой заголовок из запроса важнее темы.
  f.materials.createPublication('avokado',reel.id,{version:1,platformIds:['vk'],title:'Свой заголовок'},editor);
  assert.equal(f.created[1].body.title,'Свой заголовок');
});

test('specs/227: основной площадки без текста — берётся первая непустая версия; длинный текст не обрезается и не подставляется',()=>{
  const f=fixture(),put=withPlan(f),long='Д'.repeat(1100);
  put(1,2,[planIdea('s-2',{vk:{text:''},telegram:{text:long},tiktok:{text:'SAMPLE TT'}})]);
  const reel=f.materials.create('avokado',{title:'Ролик',mediaUrl:asset('avokado'),platforms:['tiktok'],ideaId:'s-2'},editor);
  const out=f.materials.createPublication('avokado',reel.id,{version:1,platformIds:['tiktok','telegram']},editor);
  assert.equal(out.planText.mainPlatform,'tiktok','первая непустая версия по выбранным площадкам');
  assert.equal(f.created[0].body.text,undefined,'общий текст пуст: иначе Telegram получил бы его вместо своей версии');
  assert.deepEqual(f.created[0].body.captions,{tiktok:'SAMPLE TT'},'текст длиннее 1024 для Telegram не подставлен');
  assert.deepEqual(out.planText.blockedPlatforms,['telegram']);
  assert.deepEqual(out.planText.warnings.map(w=>[w.platform,w.code]),[['telegram','CAPTION_TOO_LONG']]);
  assert.match(out.planText.warnings[0].message,/Telegram.*1024/);
  // Основной текст длиннее лимита площадки без своей версии — предупреждение, текст площадки не выдумывается.
  put(1,3,[planIdea('s-2',{vk:{text:'В'.repeat(3000)}})]);
  const second=f.materials.createPublication('avokado',reel.id,{version:1,platformIds:['vk','instagram']},editor);
  assert.equal(f.created[1].body.text,undefined,'основной текст не уходит общим — Instagram его не получит');
  assert.equal(f.created[1].body.captions.vk.length,3000);assert.equal(Object.hasOwn(f.created[1].body.captions,'instagram'),false);
  assert.deepEqual(second.planText.warnings.map(w=>[w.platform,w.code]),[['instagram','MAIN_TOO_LONG']]);
});

test('specs/227: нет связи, плана, идеи или текста — черновик как раньше; идея в архиве и чужая компания — никогда',()=>{
  const f=fixture(),put=withPlan(f);
  const plain=f.materials.create('avokado',{title:'Без темы',mediaUrl:asset('avokado'),platforms:['vk']},editor);
  let out=f.materials.createPublication('avokado',plain.id,{version:1,platformIds:['vk']},editor);
  assert.equal(out.planText.source,'none');assert.equal(out.planText.reason,'NO_IDEA_LINK');
  assert.equal(f.created[0].body.text,undefined);assert.equal(f.created[0].body.captions,undefined);
  assert.equal(f.created[0].body.title,'Без темы');assert.equal(f.created[0].body.origin,`Материалы: ролик №${plain.id} v1`);
  // Тема без текста.
  put(1,1,[planIdea('s-3',{vk:{text:''}})]);
  const empty=f.materials.create('avokado',{title:'Ролик без текста',mediaUrl:asset('avokado'),platforms:['vk'],ideaId:'s-3'},editor);
  out=f.materials.createPublication('avokado',empty.id,{version:1,platformIds:['vk']},editor);
  assert.equal(out.planText.reason,'NO_TEXT');assert.equal(f.created[1].body.text,undefined);assert.equal(f.created[1].body.title,'Ролик без текста');
  // Тема пропала из плана после пересохранения.
  put(1,2,[planIdea('s-other',{vk:{text:'другое'}})]);
  out=f.materials.createPublication('avokado',empty.id,{version:1,platformIds:['vk']},editor);
  assert.equal(out.planText.reason,'IDEA_NOT_IN_PLAN');assert.equal(f.created[2].body.text,undefined);
  // Тема в архиве плана.
  put(1,3,[planIdea('s-3',{vk:{text:'SAMPLE архивный'}})]);
  f.db.prepare("INSERT INTO media_mentor_idea_archive(company_id,idea_id,idea,archived_at) VALUES(1,'s-3','{}','2026-11-07T00:00:00Z')").run();
  out=f.materials.createPublication('avokado',empty.id,{version:1,platformIds:['vk']},editor);
  assert.equal(out.planText.reason,'IDEA_ARCHIVED');assert.equal(f.created[3].body.text,undefined);
  // Чужая компания: у alvi в плане идея с тем же ideaId; ролик avokado видит только план avokado.
  put(2,9,[planIdea('s-3',{vk:{text:'ЧУЖОЙ текст'}}),planIdea('s-alvi',{vk:{text:'ЧУЖОЙ текст 2'}})]);
  f.db.prepare("DELETE FROM media_mentor_idea_archive").run();put(1,4,[planIdea('s-3',{vk:{text:'SAMPLE свой'}})]);
  out=f.materials.createPublication('avokado',empty.id,{version:1,platformIds:['vk']},editor);
  assert.equal(f.created[4].body.text,'SAMPLE свой');assert.equal(out.planText.planRevision,4);
  assert.throws(()=>f.materials.create('avokado',{title:'x',mediaUrl:asset('avokado'),platforms:['vk'],ideaId:'s-alvi'},editor),{status:404},'идея чужого плана не привязывается');
  f.db.prepare("UPDATE reel_materials SET idea_id='s-alvi' WHERE id=?").run(plain.id);
  out=f.materials.createPublication('avokado',plain.id,{version:1,platformIds:['vk']},editor);
  assert.equal(out.planText.reason,'IDEA_NOT_IN_PLAN','даже прямая запись чужого ideaId не даёт текста чужой компании');
  assert.ok(f.created.every(c=>!String(c.body.text||'').includes('ЧУЖОЙ')));
  assert.ok(f.created.every(c=>c.code==='avokado'));
});

test('specs/227: версия длиннее лимита своей площадки не становится основным текстом',()=>{
  const f=fixture(),put=withPlan(f);
  put(1,1,[planIdea('s-4',{telegram:{text:'Т'.repeat(1100)},vk:{text:'SAMPLE VK'}},{platform:'telegram'})]);
  const reel=f.materials.create('avokado',{title:'Ролик',mediaUrl:asset('avokado'),platforms:['telegram'],ideaId:'s-4'},editor);
  const out=f.materials.createPublication('avokado',reel.id,{version:1,platformIds:['telegram','vk']},editor);
  assert.equal(out.planText.mainPlatform,'vk');assert.equal(f.created[0].body.text,undefined);assert.deepEqual(f.created[0].body.captions,{vk:'SAMPLE VK'});
  assert.deepEqual(out.planText.warnings.map(w=>[w.platform,w.code]),[['telegram','CAPTION_TOO_LONG']]);
});

test('specs/227, связка с настоящим планом: текст пустой площадки дописан через savePlan — согласование другой площадки цело, черновик получает оба текста',()=>{
  const {createMediaMentor}=require('./media-mentor');
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'avokado','SAMPLE','Asia/Irkutsk','[]'),(2,'alvi','SAMPLE 2','Asia/Irkutsk','[]');`);
  const mentor=createMediaMentor(db),actor={userId:7,userName:'SAMPLE'};
  const brief=mentor.saveBrief('avokado',{revision:0,brief:{platforms:['vk','telegram']}},actor).brief.revision;
  let snap=mentor.savePlan('avokado',{planRevision:0,briefRevision:brief,days:[{ideaId:'s-1',date:'2026-11-12',platform:'vk',format:'reel',role:'reach',topic:'SAMPLE тема',
    variants:{vk:{text:'SAMPLE VK'},telegram:{text:''}}}]},actor);
  snap=mentor.decideVariants('avokado',{planRevision:snap.plan.revision,briefRevision:brief,scope:'idea',ideaId:'s-1',decision:'approved'},actor);
  const status=(s,p)=>s.variants.find(v=>v.platform===p).status;
  assert.equal(status(snap,'vk'),'approved');assert.equal(status(snap,'telegram'),'empty');
  const days=snap.plan.days.map(({stage,stageSource,publications,...d})=>({...d,variants:{...d.variants,telegram:{...d.variants.telegram,text:'SAMPLE TG'}}}));
  const before=snap.plan.days[0].variants.vk.contentRevision;
  snap=mentor.savePlan('avokado',{planRevision:snap.plan.revision,briefRevision:brief,days,reason:'Текст публикации изменён'},actor);
  assert.equal(snap.plan.revision,2,'новая версия плана');assert.equal(snap.plan.days[0].variants.vk.contentRevision,before);
  assert.equal(status(snap,'vk'),'approved','версия без изменений сохраняет согласование');assert.equal(status(snap,'telegram'),'pending');
  assert.equal(snap.approval.status,'pending','решение «план целиком» привязано к версии плана');
  const created=[],autoposting={list:()=>({posts:[]}),create:(code,body)=>{created.push({code,body});return {id:1,title:body.title,status:'draft',platformIds:body.platformIds,mediaUrls:body.mediaUrls};}};
  const materials=createReelMaterials(db,{autoposting,information:{get:()=>({revision:1})}});
  const reel=materials.create('avokado',{title:'Монтаж',mediaUrl:asset('avokado'),platforms:['vk'],ideaId:'s-1'},editor);
  const out=materials.createPublication('avokado',reel.id,{version:1,platformIds:['vk','telegram']},editor);
  assert.equal(created[0].body.text,'SAMPLE VK');assert.deepEqual(created[0].body.captions,{telegram:'SAMPLE TG'});
  assert.equal(created[0].body.title,'SAMPLE тема');assert.equal(out.planText.planRevision,2);
  // Чужая компания с той же идеей ничего не получает.
  assert.throws(()=>materials.create('alvi',{title:'x',mediaUrl:asset('alvi'),platforms:['vk'],ideaId:'s-1'},{...editor,companyCodes:new Set(['alvi'])}),{status:404});
});

test('specs/227 ревью: при MAIN_TOO_LONG основной текст не попадает в площадку с меньшим лимитом — ни общим текстом, ни подписью',()=>{
  const f=fixture(),put=withPlan(f),long='Т'.repeat(3000);
  put(1,1,[planIdea('s-5',{vk:{text:long},youtube_shorts:{text:'SAMPLE YT'}})]);
  const reel=f.materials.create('avokado',{title:'Ролик',mediaUrl:asset('avokado'),platforms:['vk'],ideaId:'s-5'},editor);
  const out=f.materials.createPublication('avokado',reel.id,{version:1,platformIds:['vk','telegram','max','youtube_shorts']},editor);
  const body=f.created[0].body;
  assert.equal(body.text,undefined);
  assert.deepEqual(body.captions,{vk:long,max:long,youtube_shorts:'SAMPLE YT'},'max (4000) — основной текст подписью, telegram (1024) — ничего');
  assert.equal(Object.hasOwn(body.captions,'telegram'),false);
  for(const [platform,caption] of Object.entries(body.captions))assert.ok(caption.length<=({vk:15000,max:4000,youtube_shorts:5000})[platform]);
  assert.deepEqual(out.planText.warnings.map(w=>[w.platform,w.code]),[['telegram','MAIN_TOO_LONG']]);
  // Для vk/max основной текст положен явно: проверка без max.
  f.materials.createPublication('avokado',reel.id,{version:1,platformIds:['vk','telegram','max']},editor);
  assert.deepEqual(Object.keys(f.created[1].body.captions).sort(),['max','vk']);
  // Ни одной площадке текст не подходит — причина TOO_LONG, текста нет совсем, предупреждение есть.
  const only=f.materials.createPublication('avokado',reel.id,{version:1,platformIds:['telegram']},editor);
  assert.equal(only.planText.source,'none');assert.equal(only.planText.reason,'TOO_LONG');
  assert.equal(f.created[2].body.text,undefined);assert.equal(f.created[2].body.captions,undefined);
  assert.deepEqual(only.planText.warnings.map(w=>w.code),['MAIN_TOO_LONG']);
});
