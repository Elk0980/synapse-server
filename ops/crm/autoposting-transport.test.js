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

const OP_TOKEN='op_'+'a'.repeat(64);
function onlypultFixture(t){
 const f=fixture(t),calls=[];let custom;
 const profiles=[{id:'alvi-vk',name:'ALVI',platform:'vkontakte',status:'active',username:'@alvi',private:'PRIVATE_PROVIDER_RESPONSE'},
   {id:'avokado-vk',name:'Авокадо',platform:'vkontakte',status:'active'},
   {id:'alvi-tg',name:'ALVI Telegram',platform:'telegram',status:'active'}];
 const replies={'/profiles':profiles,'/account':{timezone:'Asia/Irkutsk',plan_active:true},'/posts/limits':{platform:{limits:{text:{charLimit:15000},media:{maxCount:10}}}},
   '/posts':{id:'job-123',status:'scheduled',profile_ids:['alvi-vk']},'/posts/job-123':{id:'job-123',status:'published',profile_ids:['alvi-vk']}};
 const api=createAutopostingTransport(f.db,{...f.options,fetchImpl:async(url,options)=>{
   const parsed=new URL(url);assert.equal(parsed.origin,'https://api.onlypult.com');assert.ok(parsed.pathname.startsWith('/v1/'));
   assert.equal(options.headers.authorization,`Bearer ${OP_TOKEN}`);assert.equal(options.redirect,'error');
   assert.ok(options.signal instanceof AbortSignal);const path=parsed.pathname.slice(3),body=options.body?JSON.parse(options.body):null;
   const request={path,body,options};calls.push(request);return custom?custom(request):wire({data:replies[path]});
 }});
 const save=(changes={},code='alvi')=>api.saveSettings(code,{channels:[channel('vk',0,{provider:'onlypult',target:'alvi-vk',token:OP_TOKEN,...changes})]});
 const publish=()=>api.publish({companyCode:'alvi',channelId:'vk',post:{id:9,text:'Owner approved text',mediaUrls:[]}});
 return {...f,api,calls,profiles,replies,save,publish,setHandler:value=>custom=value};
}

test('Onlypult key can be saved before profile selection and stays scoped, encrypted and unreadable in public DTOs',async t=>{
 const f=onlypultFixture(t);f.save({target:'',enabled:false});
 assert.equal(f.calls.length,0);const saved=f.api.getSettings('alvi').channels.find(c=>c.id==='vk');
 assert.equal(saved.provider,'onlypult');assert.equal(saved.connected,false);assert.equal(saved.tokenConfigured,true);
 assert.ok(!JSON.stringify(saved).includes(OP_TOKEN));assert.ok(!f.db.prepare('SELECT encrypted_token FROM autoposting_channels').get().encrypted_token.includes(OP_TOKEN));
 assert.equal((await f.api.checkChannel('alvi','vk')).code,'PROFILE_REQUIRED');assert.equal(f.calls.length,0);
 const listing=await f.api.listProfiles('alvi','vk');assert.deepEqual(listing.profiles.map(p=>p.id),['alvi-vk','avokado-vk']);
 assert.deepEqual(listing.diagnostics,{totalProfiles:3,platformCounts:[{platform:'telegram',count:1},{platform:'vkontakte',count:2}],
   profileShapes:[{idType:'string',nameType:'string',statusType:'string',platformType:'string',count:3}],otherShapesCount:0});
 assert.ok(!JSON.stringify(listing).includes('PRIVATE_PROVIDER_RESPONSE'));assert.equal(listing.revision,1);
 assert.equal(f.calls[0].options.method,'GET');assert.equal(f.calls[0].body,null);
 await assert.rejects(f.api.listProfiles('avokado','vk'),e=>e.status===400);
 assert.throws(()=>f.save({revision:1,target:'',enabled:true}),e=>e.status===400);
 assert.throws(()=>f.save({revision:1,provider:'direct',target:'1234',token:''}),e=>e.status===400);
});

test('Onlypult profile diagnostics distinguish an empty account from unknown platform values without accepting them',async t=>{
 const f=onlypultFixture(t);f.save({target:'',enabled:false});f.replies['/profiles']=[];
 const empty=await f.api.listProfiles('alvi','vk');assert.deepEqual(empty.profiles,[]);
 assert.deepEqual(empty.diagnostics,{totalProfiles:0,platformCounts:[],profileShapes:[],otherShapesCount:0});
 f.replies['/profiles']=[{id:1863190,name:'PRIVATE_NAME',platform:'vk_future',status:'active',email:'private@example.test'}];
 const unsupported=await f.api.listProfiles('alvi','vk');assert.deepEqual(unsupported.profiles,[]);
 assert.equal(unsupported.companyCode,'alvi');assert.equal(unsupported.channelId,'vk');assert.equal(unsupported.revision,1);
 assert.deepEqual(unsupported.diagnostics,{totalProfiles:1,platformCounts:[{platform:'vk_future',count:1}],
   profileShapes:[{idType:'number',nameType:'string',statusType:'string',platformType:'string',count:1}],otherShapesCount:0});
 assert.doesNotMatch(JSON.stringify(unsupported),/PRIVATE_NAME|private@example|1863190/);
 assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>c.options.method==='GET'&&c.path==='/profiles'&&c.body===null));
});

test('Onlypult diagnostics expose only bounded platform labels and field types, never private provider payloads',async t=>{
 const f=onlypultFixture(t);f.save({target:'',enabled:false});
 const privateProfile={id:1863190,name:'PRIVATE_NAME',status:{token:OP_TOKEN},username:'PRIVATE_USERNAME',email:'private@example.test',access_token:OP_TOKEN,'<private-field>':'PRIVATE_VALUE'};
 f.replies['/profiles']=[privateProfile,{...privateProfile,platform:'<img src=x onerror=alert(1)>'},{...privateProfile,platform:OP_TOKEN},
   {...privateProfile,platform:{private:OP_TOKEN}},{...privateProfile,platform:'vk_future'},null];
 const result=await f.api.listProfiles('alvi','vk');assert.deepEqual(result.profiles,[]);
 assert.deepEqual(result.diagnostics.platformCounts,[{platform:'unknown',count:5},{platform:'vk_future',count:1}]);
 const missing=result.diagnostics.profileShapes.find(s=>s.idType==='number'&&s.platformType==='undefined');
 assert.deepEqual(missing,{idType:'number',nameType:'string',statusType:'object',platformType:'undefined',fieldNames:['access_token','email','id','name','status','username'],count:1});
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|private@example|1863190|onerror|<private-field>|op_a{64}/);
 assert.equal(f.calls.length,1);
});

test('Onlypult field-shape diagnostics cap distinct groups and field-name samples',async t=>{
 const f=onlypultFixture(t);f.save({target:'',enabled:false});
 f.replies['/profiles']=Array.from({length:24},(_,i)=>({[String.fromCharCode(97+i)]:'PRIVATE_VALUE'}));
 const result=await f.api.listProfiles('alvi','vk');assert.equal(result.diagnostics.totalProfiles,24);
 assert.equal(result.diagnostics.profileShapes.length,20);assert.equal(result.diagnostics.otherShapesCount,4);
 f.replies['/profiles']=[Object.fromEntries(Array.from({length:26},(_,i)=>[String.fromCharCode(97+i),'PRIVATE_VALUE']))];
 const bounded=await f.api.listProfiles('alvi','vk');assert.equal(bounded.diagnostics.profileShapes[0].fieldNames.length,20);
 assert.doesNotMatch(JSON.stringify(bounded),/PRIVATE_VALUE/);
});

test('Onlypult check requires an exact active profile on the selected platform and remembers its display name',async t=>{
 for(const [target,status,expected]of[['alvi-vk','active',null],['alvi-vk','expired','PROFILE_INACTIVE'],['alvi-tg','active','PROFILE_NOT_FOUND'],['unknown','active','PROFILE_NOT_FOUND']]){
  const f=onlypultFixture(t);f.profiles[0].status=status;f.save({target});const result=await f.api.checkChannel('alvi','vk');
  assert.equal(result.ok,expected===null);assert.equal(result.code,expected);
  assert.equal(result.channels.find(c=>c.id==='vk').profileDisplayName,expected?null:'ALVI');
  assert.ok(f.calls.every(c=>c.path==='/profiles'&&c.options.method==='GET'));
 }
});

test('Onlypult accepts the observed vk alias with the same exact-profile, active-status and public-field rules',async t=>{
 const f=onlypultFixture(t);f.save();f.profiles[0].platform='vk';
 const listing=await f.api.listProfiles('alvi','vk');
 assert.deepEqual(listing.profiles[0],{id:'alvi-vk',name:'ALVI',platform:'vk',status:'active',username:'@alvi'});
 assert.deepEqual(listing.profiles.map(p=>p.id),['alvi-vk','avokado-vk']);assert.doesNotMatch(JSON.stringify(listing),/PRIVATE_PROVIDER_RESPONSE/);
 assert.equal((await f.api.checkChannel('alvi','vk')).ok,true);
 f.profiles[0].status='expired';assert.equal((await f.api.checkChannel('alvi','vk')).code,'PROFILE_INACTIVE');
 f.profiles[0].status='active';f.profiles[0].id='another-vk';assert.equal((await f.api.checkChannel('alvi','vk')).code,'PROFILE_NOT_FOUND');
 assert.ok(f.calls.every(c=>c.options.method==='GET'&&c.path==='/profiles'));
});

test('Onlypult VK alias does not accept case variants, unknown platforms or Telegram profiles',async t=>{
 const f=onlypultFixture(t);f.save();
 for(const platform of ['VK','Vkontakte','vk_future','unknown','telegram']){
  f.replies['/profiles']=[{id:'alvi-vk',name:'ALVI',platform,status:'active'}];
  assert.deepEqual((await f.api.listProfiles('alvi','vk')).profiles,[]);
  assert.equal((await f.api.checkChannel('alvi','vk')).code,'PROFILE_NOT_FOUND');
 }
 f.api.saveSettings('alvi',{channels:[channel('telegram',0,{provider:'onlypult',target:'alvi-tg',token:OP_TOKEN})]});
 f.replies['/profiles']=[{id:'alvi-tg',name:'Telegram',platform:'telegram',status:'active'},
   {id:'other-vk',name:'VK',platform:'vk',status:'active'},{id:'wrong-case',name:'Wrong case',platform:'Telegram',status:'active'}];
 assert.deepEqual((await f.api.listProfiles('alvi','telegram')).profiles.map(p=>p.id),['alvi-tg']);
 assert.equal((await f.api.checkChannel('alvi','telegram')).ok,true);
});

test('Onlypult vk alias preserves strict ID, name and status validation',async t=>{
 const f=onlypultFixture(t);f.save();
 for(const patch of [{id:1863190},{name:null},{status:null}]){
  f.replies['/profiles']=[{id:'alvi-vk',name:'ALVI',platform:'vk',status:'active',...patch}];
  await assert.rejects(f.api.listProfiles('alvi','vk'),safeFailure('RESPONSE_UNCERTAIN',false));
 }
});

test('Onlypult profile list and connection checks reject results from settings changed during an await',async t=>{
 const f=onlypultFixture(t);f.save();let release;
 f.setHandler(()=>new Promise(resolve=>release=()=>resolve(wire({data:f.profiles}))));
 const checking=f.api.checkChannel('alvi','vk');f.save({revision:1,token:'',target:'avokado-vk'});release();
 const result=await checking;assert.equal(result.code,'SETTINGS_CHANGED');assert.equal(result.ok,false);
 const listing=f.api.listProfiles('alvi','vk');f.save({revision:2,token:'',target:'alvi-vk'});release();
 await assert.rejects(listing,safeFailure('SETTINGS_CHANGED',false));
});

test('Onlypult creates only for the frozen profile; provider IDs or published flags are never reported as a live social post',async t=>{
 const f=onlypultFixture(t);f.save();assert.equal((await f.api.checkChannel('alvi','vk')).ok,true);
 for(const status of ['scheduled','published','failed']){
  f.replies['/posts']={id:'job-123',status,profile_ids:['alvi-vk'],url:'https://vk.com/wall-999_9',private:OP_TOKEN};
  const result=await f.publish();assert.equal(result.status,'needs_review');assert.equal(result.providerPostId,'job-123');
  assert.equal(result.providerStatus,status);assert.equal(result.externalId,undefined);assert.equal(result.url,undefined);
  assert.ok(!JSON.stringify(result).includes(OP_TOKEN));
  assert.deepEqual(f.calls.at(-1).body,{profile_ids:['alvi-vk'],content:'Owner approved text',publish_now:true});
 }
 const before=f.calls.length,result=await f.api.reconcile({companyCode:'alvi',channelId:'vk',channelRevision:1,providerPostId:'job-123'});
 assert.equal(result.errorCode,'PROVIDER_LINK_UNAVAILABLE');assert.equal(f.calls.length,before+1);assert.equal(f.calls.at(-1).options.method,'GET');
 await assert.rejects(f.api.reconcile({companyCode:'alvi',channelId:'vk',channelRevision:2,providerPostId:'job-123'}),safeFailure('CHANNEL_CHANGED',false));
});

test('Onlypult refuses malformed, mismatched or uncertain create receipts and never includes provider secrets in errors',async t=>{
 const f=onlypultFixture(t);f.save();await f.api.checkChannel('alvi','vk');
 for(const data of [{id:'job-123',status:'scheduled',profile_ids:['avokado-vk']},{id:'job-123',status:'scheduled',profile_ids:['alvi-vk','avokado-vk']},{status:'published'},{}]){
  f.replies['/posts']=data;await assert.rejects(f.publish(),safeFailure('RESPONSE_UNCERTAIN',true));
 }
 f.setHandler(({path})=>{if(path==='/posts')throw Error('PRIVATE_PROVIDER_RESPONSE '+OP_TOKEN);return wire({data:f.replies[path]});});
 await assert.rejects(f.publish(),safeFailure('CONNECTION_UNCERTAIN',true));
 f.setHandler(({path})=>path==='/posts'?wire({error:{code:'validation_error',message:OP_TOKEN,retryable:false}},422):wire({data:f.replies[path]}));
 await assert.rejects(f.publish(),safeFailure('PLATFORM_REJECTED',false));
});

test('Onlypult preflight guards owner edits and plan/content limits before any mutation',async t=>{
 for(const change of ['settings','plan','limit','owner']){
  const f=onlypultFixture(t);f.save();await f.api.checkChannel('alvi','vk');
  if(change==='plan')f.replies['/account'].plan_active=false;
  if(change==='limit')f.replies['/posts/limits'].platform.limits.text.charLimit=1;
  if(change==='settings')f.setHandler(({path})=>{if(path==='/posts/limits')f.save({revision:1,token:'',target:'avokado-vk'});return wire({data:f.replies[path]});});
  const promise=change==='owner'?f.api.publish({companyCode:'alvi',channelId:'vk',post:{text:'Owner text',mediaUrls:[]},beforePublish:()=>{throw Object.assign(Error('Changed'),{ambiguous:false});}}):f.publish();
  await assert.rejects(promise);assert.equal(f.calls.some(c=>c.options.method==='POST'),false);
 }
});
