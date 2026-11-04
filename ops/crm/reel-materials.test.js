'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createReelMaterials,validateEdl}=require('./reel-materials');
const {createReelMaterialsHandler}=require('./reel-materials-http');
const asset=(code,n='a')=>`https://synapse.example/content/publishing-assets/${code}/${n.repeat(32)}.mp4`;
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
  assert.throws(()=>f.materials.create('avokado',{title:'x',mediaUrl:'http://synapse.example/content/publishing-assets/avokado/'+'a'.repeat(32)+'.mp4'},editor),{status:400});
  const alien=f.materials.create('alvi',{title:'Чужой',mediaUrl:asset('alvi')},editor);
  assert.throws(()=>f.materials.get('avokado',alien.id),{status:404});
  assert.throws(()=>f.materials.requestEdit('avokado',alien.id,{clientRequestId:'r1',baseVersion:1,kind:'request',comment:'x',startMs:0,endMs:1000},editor),{status:404});
  assert.throws(()=>f.materials.addVersion('avokado',alien.id,{mediaUrl:asset('avokado','b')}),{status:404});
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
