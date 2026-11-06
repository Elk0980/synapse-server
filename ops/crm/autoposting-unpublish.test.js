'use strict';
// Снятие опубликованного с площадок (spec 182): все внешние API — заглушки fetch, реальных вызовов нет.
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createAutopostingTransport}=require('./autoposting-transport');
const {createAutopostingUnpublish,createAutopostingUnpublishHandler}=require('./autoposting-unpublish');
const TG_TOKEN='123456789:TEST_ONLY_TELEGRAM_TOKEN_1234567890',OP_TOKEN='op_'+'a'.repeat(64);
const NOW=Date.parse('2026-11-06T12:00:00Z');
const wire=(data,status=200)=>new Response(data===null?null:JSON.stringify(data),{status,headers:{'content-type':'application/json'}});

function fixture(t,{reply}={}) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,timezone TEXT,is_deleted INTEGER NOT NULL DEFAULT 0);
    INSERT INTO companies VALUES(1,'alvi','Asia/Irkutsk',0),(2,'avokado','Asia/Irkutsk',0);
    CREATE TABLE autoposting_posts(id INTEGER PRIMARY KEY,company_id INTEGER,revision INTEGER,status TEXT,media_urls TEXT);
    CREATE TABLE autoposting_deliveries(post_id INTEGER,channel_id TEXT,channel_revision INTEGER,status TEXT,external_id TEXT,url TEXT,
      error_code TEXT,finished_at TEXT,provider_post_id TEXT,provider_status TEXT,PRIMARY KEY(post_id,channel_id));
    CREATE TABLE autoposting_publication_receipts(id INTEGER PRIMARY KEY,company_id INTEGER,post_id INTEGER,platform TEXT,url TEXT);`);
  const calls=[];
  const fetchImpl=async(url,options)=>{
    const call={url,method:options.method,body:options.body?JSON.parse(options.body):null};calls.push(call);
    if(reply){const custom=await reply(call);if(custom)return custom;}
    if(url.includes('/getMe'))return wire({ok:true,result:{id:701}});
    if(url.includes('/getChat')&&!url.includes('Member'))return wire({ok:true,result:{id:-1001,type:'channel'}});
    if(url.includes('/getChatMember'))return wire({ok:true,result:{status:'administrator',can_post_messages:true}});
    if(url.includes('/deleteMessage'))return wire({ok:true,result:true});
    if(url.endsWith('/profiles'))return wire({data:[{id:'p1',name:'IG',status:'active',platform:'instagram_business'}]});
    if(options.method==='GET'&&/\/posts\/op-/.test(url))return wire({data:{id:url.split('/').pop(),profile_ids:['p1'],status:'scheduled'}});
    if(options.method==='DELETE')return wire(null,204);
    throw Error('unexpected '+url);
  };
  const transport=createAutopostingTransport(db,{apiKey:'TEST_ONLY_KEY',fetchImpl,now:()=>NOW});
  transport.saveSettings('alvi',{channels:[{id:'telegram',revision:0,enabled:true,target:'@qa_channel',token:TG_TOKEN}]});
  transport.saveSettings('alvi',{channels:[{id:'instagram',provider:'onlypult',revision:0,enabled:true,target:'p1',token:OP_TOKEN}]});
  const unpublish=createAutopostingUnpublish(db,{transport,now:()=>NOW});
  const post=(id,{company=1,status='published',media=[]}={})=>db.prepare('INSERT INTO autoposting_posts VALUES(?,?,?,?,?)').run(id,company,3,status,JSON.stringify(media));
  const delivery=(postId,channel,fields)=>db.prepare(`INSERT INTO autoposting_deliveries(post_id,channel_id,channel_revision,status,external_id,url,finished_at,provider_post_id,provider_status)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(postId,channel,fields.rev??1,fields.status,fields.ext??null,fields.url??null,fields.at??null,fields.pid??null,fields.pstatus??null);
  calls.length=0;
  return {db,unpublish,calls,post,delivery,alvi:{id:1,code:'alvi'},avokado:{id:2,code:'avokado'},actor:{userId:7,userName:'Влад'}};
}
const fresh=new Date(NOW-3600e3).toISOString(),old=new Date(NOW-49*3600e3).toISOString();

test('план снятия: что автоматически, что вручную, со ссылками',t=>{
  const f=fixture(t);
  f.post(1);f.delivery(1,'telegram',{status:'published',ext:'81',url:'https://t.me/qa_channel/81',at:fresh});
  f.delivery(1,'instagram',{status:'needs_review',pid:'op-1',pstatus:'scheduled'});
  f.db.prepare("INSERT INTO autoposting_publication_receipts VALUES(1,1,1,'vk','https://vk.com/wall-1_2')").run();
  f.post(2,{media:['https://e.test/a.jpg','https://e.test/b.jpg']});f.delivery(2,'telegram',{status:'published',ext:'90',at:fresh});
  f.post(3);f.delivery(3,'telegram',{status:'published',ext:'91',at:old});
  f.delivery(3,'instagram',{status:'needs_review',pid:'op-3',pstatus:'published'});
  f.post(4);f.delivery(4,'instagram',{status:'needs_review',pid:'op-4',pstatus:'failed'});
  const p1=f.unpublish.preview(1,f.alvi);
  assert.equal(p1.state,'published');
  assert.deepEqual(p1.targets.map(x=>[x.key,x.mode]),[['provider:instagram:op-1','auto'],['direct:telegram:81','auto'],['receipt:1','manual']]);
  assert.equal(p1.targets[2].url,'https://vk.com/wall-1_2');
  assert.equal(f.unpublish.preview(2,f.alvi).targets[0].mode,'manual','альбом — вручную');
  const p3=f.unpublish.preview(3,f.alvi).targets;
  assert.deepEqual(p3.map(x=>x.mode),['manual','manual']);assert.match(p3[1].note,/48 часов/);assert.match(p3[0].note,/Onlypult не удаляет/);
  assert.equal(f.unpublish.preview(4,f.alvi).targets.length,0,'неудачная отправка не требует снятия');
  assert.equal(f.calls.length,0,'предпросмотр ничего не вызывает');
});

test('снятие: Telegram deleteMessage и Onlypult DELETE, журнал, карточка остаётся',async t=>{
  const f=fixture(t);
  f.post(1);f.delivery(1,'telegram',{status:'published',ext:'81',url:'https://t.me/qa_channel/81',at:fresh});
  f.delivery(1,'instagram',{status:'needs_review',pid:'op-1',pstatus:'scheduled'});
  f.db.prepare("INSERT INTO autoposting_publication_receipts VALUES(1,1,1,'vk','https://vk.com/wall-1_2')").run();
  const keys=f.unpublish.preview(1,f.alvi).targets.map(x=>x.key);
  const result=await f.unpublish.unpublish(1,f.alvi,{revision:3,targets:keys},f.actor);
  assert.deepEqual(result.results.map(r=>[r.key,r.outcome]),[['provider:instagram:op-1','removed'],['direct:telegram:81','removed'],['receipt:1','manual']]);
  const tg=f.calls.find(c=>c.url.includes('deleteMessage'));assert.deepEqual(tg.body,{chat_id:'@qa_channel',message_id:81});
  const op=f.calls.filter(c=>c.url.includes('/posts/op-1')).map(c=>c.method);assert.deepEqual(op,['GET','DELETE'],'статус перечитан перед удалением');
  assert.equal(result.state,'manual_pending');
  const events=f.db.prepare('SELECT target_key,outcome,actor_name FROM autoposting_unpublish_events ORDER BY id').all();
  assert.equal(events.length,3);assert.ok(events.every(e=>e.actor_name==='Влад'));
  assert.ok(f.db.prepare('SELECT 1 FROM autoposting_posts WHERE id=1').get(),'карточка не стёрта');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM autoposting_deliveries WHERE post_id=1').get().n,2,'доставки сохранены');
  const before=f.calls.length;
  await assert.rejects(f.unpublish.unpublish(1,f.alvi,{revision:3,targets:keys},f.actor),{code:'PLAN_CHANGED'});
  const done=f.unpublish.confirmManual(1,f.alvi,{key:'receipt:1'},f.actor);
  assert.equal(done.state,'removed');assert.equal(f.calls.length,before,'повтор и ручная отметка не вызывают площадки');
  assert.deepEqual(f.unpublish.states(f.alvi),{1:'removed'});
});

test('отказ, неопределённость и сменённый канал не выдаются за удаление',async t=>{
  const f=fixture(t,{reply:call=>{
    if(call.url.includes('deleteMessage'))return call.body.message_id===81?wire({ok:false,error_code:400,description:'x'},400):Promise.reject(Error('net'));
    if(call.method==='GET'&&call.url.endsWith('/posts/op-5'))return wire({data:{id:'op-5',profile_ids:['p1'],status:'published'}});
  }});
  f.post(1);f.delivery(1,'telegram',{status:'published',ext:'81',at:fresh});
  f.post(2);f.delivery(2,'telegram',{status:'published',ext:'82',at:fresh});
  f.post(3);f.delivery(3,'telegram',{status:'published',ext:'83',at:fresh,rev:7});
  f.post(5);f.delivery(5,'instagram',{status:'needs_review',pid:'op-5',pstatus:'scheduled'});
  const run=async id=>(await f.unpublish.unpublish(id,f.alvi,{revision:3,targets:f.unpublish.preview(id,f.alvi).targets.map(x=>x.key)},f.actor)).results[0];
  assert.equal((await run(1)).outcome,'failed');
  assert.equal((await run(2)).outcome,'uncertain');
  const n=f.calls.length,changed=await run(3);
  assert.deepEqual([changed.outcome,changed.errorCode],['failed','CHANNEL_CHANGED']);assert.equal(f.calls.length,n,'чужая ревизия канала — без вызова');
  const late=await run(5);assert.equal(late.errorCode,'PROVIDER_ALREADY_PUBLISHED');
  assert.ok(!f.calls.some(c=>c.method==='DELETE'),'вышедшему посту DELETE не отправляется');
  assert.equal(f.unpublish.preview(1,f.alvi).state,'manual_pending');
});

test('границы: чужая компания, версия, состав запроса',async t=>{
  const f=fixture(t);
  f.post(1);f.delivery(1,'telegram',{status:'published',ext:'81',at:fresh});
  assert.throws(()=>f.unpublish.preview(1,f.avokado),{status:404});
  await assert.rejects(f.unpublish.unpublish(1,f.alvi,{revision:2,targets:['direct:telegram:81']},f.actor),{code:'REVISION_CONFLICT'});
  await assert.rejects(f.unpublish.unpublish(1,f.alvi,{revision:3,targets:[]},f.actor),{code:'PLAN_CHANGED'});
  await assert.rejects(f.unpublish.unpublish(1,f.alvi,{revision:3,targets:['direct:telegram:81'],force:true},f.actor),{status:400});
  assert.throws(()=>f.unpublish.confirmManual(1,f.alvi,{key:'direct:telegram:81'},f.actor),{code:'UNPUBLISH_NOT_STARTED'});
  assert.equal(f.calls.length,0);
});

test('маршрут: чтение — право просмотра, снятие — право правки на сервере',async()=>{
  const asked=[],sent=[];
  const unpublish={preview:()=>({ok:'preview'}),states:()=>({}),unpublish:async()=>({ok:'run'}),confirmManual:()=>({ok:'manual'})};
  const handle=createAutopostingUnpublishHandler({unpublish,readJson:async()=>({}),send:(res,status,body)=>sent.push([status,body]),
    companyModuleContext:(req,code,permission)=>{asked.push(permission);if(permission==='autoposting.edit'&&req.viewer)throw Object.assign(Error('no'),{status:403});return {identity:{userId:1},company:{id:1,code}};}});
  const url=path=>new URL('http://x'+path+'?companyCode=alvi');
  assert.equal(await handle({method:'GET'},{},url('/autoposting/posts/1')),false);
  assert.equal(await handle({method:'GET'},{},url('/autoposting/posts/1/unpublish')),true);
  assert.equal(await handle({method:'POST'},{},url('/autoposting/posts/1/unpublish')),true);
  assert.equal(await handle({method:'POST'},{},url('/autoposting/posts/1/unpublish/manual')),true);
  assert.equal(await handle({method:'GET'},{},url('/autoposting/unpublish-states')),true);
  assert.deepEqual(asked,['autoposting.view','autoposting.edit','autoposting.edit','autoposting.view']);
  await assert.rejects(handle({method:'POST',viewer:true},{},url('/autoposting/posts/1/unpublish')),{status:403});
  assert.deepEqual(sent.map(s=>s[1].ok),['preview','run','manual',undefined]);
});
