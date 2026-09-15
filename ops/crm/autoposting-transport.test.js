'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createAutopostingTransport,publicUrl}=require('./autoposting-transport');
const API_KEY='TEST_ONLY_ENCRYPTION_KEY_DO_NOT_USE';
const TG_TOKEN='123456789:TEST_ONLY_TELEGRAM_TOKEN_1234567890';
const VK_TOKEN='TEST_ONLY_VK_TOKEN_NEVER_LIVE';
const channel=(id,revision=0,changes={})=>({id,revision,enabled:true,target:id==='telegram'?'@qa_channel':'12345',token:id==='telegram'?TG_TOKEN:VK_TOKEN,...changes});
const wire=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
function defaultReply(method) {
 return {getMe:{ok:true,result:{id:701,is_bot:true}},getChat:{ok:true,result:{id:-1001234567,type:'channel',username:'qa_channel'}},
  getChatMember:{ok:true,result:{status:'administrator',can_post_messages:true}},
  'account.getAppPermissions':{response:8192},'groups.getById':{response:[{id:12345,is_admin:1,can_post:1}]},
  sendMessage:{ok:true,result:{message_id:81,chat:{id:-1001234567,username:'qa_channel'}}},
  sendPhoto:{ok:true,result:{message_id:82,chat:{id:-1001234567}}},
  sendMediaGroup:{ok:true,result:[{message_id:83,chat:{id:-1001234567}},{message_id:84,chat:{id:-1001234567}}]},
  'wall.post':{response:{post_id:91}}}[method];
}
function fixture(t) {
 const db=new DatabaseSync(':memory:');db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE companies(code TEXT PRIMARY KEY COLLATE NOCASE,timezone TEXT,is_deleted INTEGER NOT NULL DEFAULT 0);
 INSERT INTO companies VALUES('alvi','Asia/Irkutsk',0),('avokado','Asia/Irkutsk',0),('deleted','Asia/Irkutsk',1);`);
 t.after(()=>db.close());const calls=[];let handler=null;
 const fetchImpl=async(url,options)=>{
  const method=url.split('/').pop(),telegram=url.startsWith('https://api.telegram.org/');
  assert.ok(telegram||url.startsWith('https://api.vk.com/method/'));
  assert.equal(options.method,'POST');assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
  const params=telegram?JSON.parse(options.body):Object.fromEntries(new URLSearchParams(options.body));
  const request={url,options,method,params};calls.push(request);
  return handler?handler(request):wire(defaultReply(method));
 };
 const options={apiKey:API_KEY,fetchImpl,now:()=>Date.parse('2026-09-15T10:00:00Z')};
 const api=createAutopostingTransport(db,options);
 const save=(id='telegram',code='alvi',changes={})=>api.saveSettings(code,{channels:[channel(id,0,changes)]});
 const connect=async(id='telegram',code='alvi')=>{save(id,code);assert.equal((await api.checkChannel(code,id)).ok,true);};
 const publish=(id='telegram',code='alvi',post={})=>api.publish({companyCode:code,channelId:id,post:{id:11,revision:1,text:'Fixture text',mediaUrls:[],...post}});
 return {db,api,options,calls,save,connect,publish,setHandler:value=>handler=value};
}
function noSecrets(value) {
 const text=JSON.stringify(value);
 for(const secret of [API_KEY,TG_TOKEN,VK_TOKEN,'PRIVATE_PROVIDER_RESPONSE'])assert.ok(!text.includes(secret),'public result contains a secret marker');
 assert.ok(!text.includes('encrypted_token'),'public result must not expose ciphertext');
}
function safeFailure(code,ambiguous) {return error=>{
 assert.equal(error.code,code);assert.equal(error.ambiguous,ambiguous);noSecrets({message:error.message,...error});return true;
};}

test('settings encrypt every tenant token and expose no credentials; only explicit successful checks connect a saved revision',async t=>{
 const f=fixture(t);const initial=f.api.getSettings('alvi');assert.equal(initial.channels.every(c=>!c.connected&&!c.tokenConfigured),true);
 f.save('telegram');f.save('vk');f.save('telegram','avokado');
 assert.equal(f.calls.length,0,'settings reads/saves never contact a provider');
 const rows=f.db.prepare('SELECT * FROM autoposting_channels').all();
 for(const row of rows){assert.ok(!JSON.stringify(row).includes(TG_TOKEN));assert.ok(!JSON.stringify(row).includes(VK_TOKEN));assert.equal(JSON.parse(row.encrypted_token).v,1)}
 assert.notEqual(rows[0].encrypted_token,rows[2].encrypted_token);
 const saved=f.api.getSettings('alvi');noSecrets(saved);assert.ok(saved.channels.every(c=>c.tokenConfigured&&!c.connected));
 const checked=await f.api.checkChannel('alvi','telegram');noSecrets(checked);assert.equal(checked.ok,true);
 assert.equal(checked.channels.find(c=>c.id==='telegram').connected,true);assert.equal(checked.channels.find(c=>c.id==='vk').connected,false);
});

test('ciphertext is bound to its company and channel, and rotating the encryption key fails closed without deleting it',async t=>{
 const f=fixture(t);f.save();f.save('telegram','avokado');f.save('vk');
 const original=f.db.prepare("SELECT encrypted_token FROM autoposting_channels WHERE company_code='alvi' AND id='telegram'").get().encrypted_token;
 f.db.prepare("UPDATE autoposting_channels SET encrypted_token=? WHERE company_code='avokado' OR id='vk'").run(original);
 for(const [code,id]of[['avokado','telegram'],['alvi','vk']]){
  const result=await f.api.checkChannel(code,id);assert.equal(result.ok,false);assert.equal(result.code,'TOKEN_UNREADABLE');noSecrets(result);
 }
 assert.equal(f.calls.length,0);
 const rotated=createAutopostingTransport(f.db,{...f.options,apiKey:'DIFFERENT_TEST_KEY'});
 assert.equal(rotated.getSettings('alvi').channels.find(c=>c.id==='telegram').tokenConfigured,false);
 assert.equal((await rotated.checkChannel('alvi','telegram')).code,'TOKEN_UNREADABLE');
 assert.equal(f.db.prepare("SELECT encrypted_token FROM autoposting_channels WHERE company_code='alvi' AND id='telegram'").get().encrypted_token,original);
});

test('revision is mandatory, a stale channel prevents the entire multi-channel save, and blank token preserves the credential',async t=>{
 const f=fixture(t);
 const missingRevision=channel('telegram');delete missingRevision.revision;
 assert.throws(()=>f.api.saveSettings('alvi',{channels:[missingRevision]}),e=>e.status===409);
 f.save();f.save('vk');await f.api.checkChannel('alvi','telegram');
 assert.throws(()=>f.api.saveSettings('alvi',{channels:[channel('telegram',1,{name:'Should roll back'}),channel('vk',0)]}),e=>e.status===409);
 assert.equal(f.api.getSettings('alvi').channels.find(c=>c.id==='telegram').revision,1);
 const next=f.api.saveSettings('alvi',{channels:[channel('telegram',1,{token:'',target:'@next_channel'})]});
 assert.equal(next.channels[0].revision,2);assert.equal(next.channels[0].connected,false);assert.equal(next.channels[0].checkedAt,null);
 await f.api.checkChannel('alvi','telegram');assert.ok(f.calls.at(-1).url.includes(TG_TOKEN));assert.equal(f.calls.at(-1).params.chat_id,'@next_channel');
 for(const input of [channel('telegram',2,{name:{}}),channel('telegram',2,{token:'bad token'}),channel('vk',1,{target:'https://malicious.test/123'})])assert.throws(()=>f.api.saveSettings('alvi',{channels:[input]}),e=>e.status===400);
});

test('revision comparison occurs after acquiring the write transaction, so a concurrent committed update is preserved',t=>{
 const f=fixture(t);f.save();let inject=true;
 const wrapped={prepare:sql=>f.db.prepare(sql),exec(sql){
  if(sql==='BEGIN IMMEDIATE'&&inject){inject=false;f.db.exec("UPDATE autoposting_channels SET revision=2,name='Concurrent owner edit' WHERE company_code='alvi'")}
  return f.db.exec(sql);
 }};
 const api=createAutopostingTransport(wrapped,f.options);
 assert.throws(()=>api.saveSettings('alvi',{channels:[channel('telegram',1,{name:'Stale owner edit'})]}),e=>e.status===409);
 const actual=f.api.getSettings('alvi').channels[0];assert.equal(actual.revision,2);assert.equal(actual.name,'Concurrent owner edit');
});

test('tenant scopes reject missing/deleted companies and never reuse another company connection',async t=>{
 const f=fixture(t);await f.connect();
 for(const code of ['missing','deleted'])assert.throws(()=>f.api.getSettings(code),e=>e.status===404);
 assert.throws(()=>f.api.getSettings('../alvi'),e=>e.status===400);
 const count=f.calls.length;await assert.rejects(f.publish('telegram','avokado'),safeFailure('CONNECTION_MISSING',false));assert.equal(f.calls.length,count);
 f.save('telegram','avokado',{target:'@avokado_qa'});await f.api.checkChannel('avokado','telegram');await f.publish('telegram','avokado');
 assert.equal(f.calls.at(-1).params.chat_id,'@avokado_qa');assert.equal(f.api.getSettings('alvi').channels[0].target,'@qa_channel');
});

test('Telegram check requires a channel plus creator or administrator posting permission and performs no publish methods',async t=>{
 for(const [chat,member,expected]of[
  [{type:'supergroup'},{status:'creator'},'CHANNEL_REQUIRED'],[{type:'channel'},{status:'member'},'ADMIN_REQUIRED'],
  [{type:'channel'},{status:'administrator',can_post_messages:false},'ADMIN_REQUIRED'],
  [{type:'channel'},{status:'administrator',can_post_messages:true},null],[{type:'channel'},{status:'creator'},null]
 ]){
  const f=fixture(t);f.save();f.setHandler(({method})=>wire(method==='getChat'?{ok:true,result:chat}:method==='getChatMember'?{ok:true,result:member}:defaultReply(method)));
  const result=await f.api.checkChannel('alvi','telegram');assert.equal(result.ok,expected===null);assert.equal(result.code,expected);noSecrets(result);
  assert.ok(f.calls.every(c=>['getMe','getChat','getChatMember'].includes(c.method)));
  assert.equal(f.api.getSettings('alvi').channels[0].revision,1,'check cannot change configuration revision');
 }
});

test('VK check requires user wall permission and admin/can_post rights on the exact target group',async t=>{
 for(const [permissions,group,expected]of[
  [0,{id:12345,is_admin:1,can_post:1},'WALL_PERMISSION_REQUIRED'],['8192',{id:12345,is_admin:1,can_post:1},'WALL_PERMISSION_REQUIRED'],
  [8192,{id:999,is_admin:1,can_post:1},'ADMIN_REQUIRED'],[8192,{id:12345,is_admin:0,can_post:1},'ADMIN_REQUIRED'],
  [8192,{id:12345,is_admin:1,can_post:0},'ADMIN_REQUIRED'],[8192,{id:12345,is_admin:1,can_post:1},null]
 ]){
  const f=fixture(t);f.save('vk');f.setHandler(({method})=>wire({response:method==='account.getAppPermissions'?permissions:{groups:[group]}}));
  const result=await f.api.checkChannel('alvi','vk');assert.equal(result.ok,expected===null);assert.equal(result.code,expected);noSecrets(result);
  assert.ok(f.calls.every(c=>['account.getAppPermissions','groups.getById'].includes(c.method)));
 }
});

test('an in-flight check cannot mark newly saved settings as connected',async t=>{
 const f=fixture(t);f.save();let release;
 f.setHandler(({method})=>method==='getMe'?new Promise(resolve=>release=()=>resolve(wire(defaultReply(method)))):wire(defaultReply(method)));
 const checking=f.api.checkChannel('alvi','telegram');
 f.api.saveSettings('alvi',{channels:[channel('telegram',1,{target:'@changed_qa'})]});release();
 const result=await checking;assert.equal(result.ok,false);assert.equal(result.code,'SETTINGS_CHANGED');assert.equal(result.channels[0].connected,false);assert.equal(result.channels[0].revision,2);
});

test('Telegram publishes text, one photo and an album only after check and returns safe post identifiers',async t=>{
 const f=fixture(t);f.save();await assert.rejects(f.publish(),safeFailure('CONNECTION_MISSING',false));assert.equal(f.calls.length,0);
 await f.api.checkChannel('alvi','telegram');
 for(const [mediaUrls,method,id]of[[[],'sendMessage','81'],[['https://example.test/one.jpg'],'sendPhoto','82'],[['https://example.test/one.jpg','https://example.test/two.jpg'],'sendMediaGroup','83,84']]){
  const result=await f.publish('telegram','alvi',{mediaUrls});assert.equal(result.status,'published');assert.equal(result.id,id);assert.equal(f.calls.at(-1).method,method);noSecrets(result);
 }
 assert.equal(f.calls.at(-1).params.media[0].caption,'Fixture text');assert.equal(f.calls.at(-1).params.media[1].caption,undefined);
 const saved=f.api.getSettings('alvi').channels[0];f.api.saveSettings('alvi',{channels:[channel('telegram',saved.revision,{enabled:false,token:''})]});
 await assert.rejects(f.publish(),safeFailure('CONNECTION_MISSING',false));
});

test('VK publishes only to the configured community and uses a stable guid for the same idempotency key',async t=>{
 const f=fixture(t);await f.connect('vk');
 const result=await f.publish('vk','alvi',{mediaUrls:['https://example.test/promo.jpg'],idempotencyKey:'stable-fixture'});noSecrets(result);
 assert.deepEqual(result,{id:'-12345_91',externalId:'-12345_91',url:'https://vk.com/wall-12345_91',status:'published'});
 const first=f.calls.at(-1).params;assert.equal(first.owner_id,'-12345');assert.equal(first.from_group,'1');assert.equal(first.attachments,'https://example.test/promo.jpg');
 await f.publish('vk','alvi',{idempotencyKey:'stable-fixture'});assert.equal(f.calls.at(-1).params.guid,first.guid);
});

test('invalid post content and private/credential URLs are rejected without provider calls',async t=>{
 const f=fixture(t);await f.connect();const count=f.calls.length;
 for(const post of [{text:''},{text:'a'.repeat(4097)},{text:'a'.repeat(1025),mediaUrls:['https://example.test/a.jpg']},{mediaUrls:['https://user:password@example.test/a.jpg']},{mediaUrls:['https://127.0.0.1/a.jpg']},{mediaUrls:['http://example.test/a.jpg']},{mediaUrls:Array(11).fill('https://example.test/a.jpg')}])await assert.rejects(f.publish('telegram','alvi',post),safeFailure('CONTENT_LIMIT',false));
 assert.equal(f.calls.length,count);assert.equal(publicUrl('https://localhost/a'),null);
});

test('explicit provider rejections are safe failures; malformed or uncertain send responses require manual resolution',async t=>{
 for(const id of ['telegram','vk']){
  const f=fixture(t);await f.connect(id);
  f.setHandler(()=>wire(id==='telegram'?{ok:false,error_code:403,description:'PRIVATE_PROVIDER_RESPONSE '+TG_TOKEN}:{error:{error_code:15,error_msg:'PRIVATE_PROVIDER_RESPONSE '+VK_TOKEN}}));
  await assert.rejects(f.publish(id),safeFailure('ACCESS_DENIED',false));
  for(const data of [null,{},[],id==='telegram'?{ok:false}:{error:{}},id==='telegram'?{ok:true,result:{}}:{response:{}}]){
   f.setHandler(()=>wire(data));await assert.rejects(f.publish(id),safeFailure('RESPONSE_UNCERTAIN',true));
  }
  f.setHandler(()=>new Response('PRIVATE_PROVIDER_RESPONSE '+TG_TOKEN,{status:502}));await assert.rejects(f.publish(id),safeFailure('CONNECTION_UNCERTAIN',true));
  f.setHandler(()=>{throw new Error('PRIVATE_PROVIDER_RESPONSE '+VK_TOKEN)});await assert.rejects(f.publish(id),safeFailure('CONNECTION_UNCERTAIN',true));
 }
});

test('oversized streamed provider body is cancelled before it is buffered and publication remains ambiguous',async t=>{
 const f=fixture(t);await f.connect();let sent=0,cancelled=false;
 f.setHandler(()=>({ok:true,body:new ReadableStream({pull(controller){sent++;controller.enqueue(new Uint8Array(256*1024))},cancel(){cancelled=true}})}));
 await assert.rejects(f.publish(),safeFailure('CONNECTION_UNCERTAIN',true));
 assert.equal(cancelled,true);assert.ok(sent<=6,'reader must cancel around the 1MB bound instead of exhausting the stream');
});

test('timeout remains active while reading the response body and cancels the reader without leaking data',async t=>{
 const f=fixture(t);await f.connect();const controller=new AbortController();let cancelled=false;
 t.mock.method(AbortSignal,'timeout',()=>controller.signal);
 f.setHandler(()=>({ok:true,body:new ReadableStream({start(){queueMicrotask(()=>controller.abort())},cancel(){cancelled=true}})}));
 await assert.rejects(f.publish(),safeFailure('CONNECTION_UNCERTAIN',true));assert.equal(cancelled,true);
});
