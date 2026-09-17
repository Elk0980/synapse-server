'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createVkCommunity}=require('./vk-community');
const KEY='FIXTURE_ENCRYPTION_KEY',TOKEN='FIXTURE_COMMUNITY_TOKEN',PRIVATE='PRIVATE_PROVIDER_ERROR';
const wire=(response,status=200)=>new Response(JSON.stringify({response}),{status});
const msg=(peerId=101,changes={})=>({id:77,peer_id:peerId,from_id:peerId,text:'Здравствуйте',date:1789640000,out:0,...changes});
const conversation=(peerId=101,changes={})=>({peer:{id:peerId,type:'user'},can_write:{allowed:true},...changes});
function fixture(t,extra={}) {
 const db=new DatabaseSync(':memory:');db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE companies(code TEXT PRIMARY KEY COLLATE NOCASE,is_deleted INTEGER NOT NULL DEFAULT 0);
 INSERT INTO companies VALUES('avokado',0),('alvi',0),('deleted',1);`);t.after(()=>db.close());
 let handler=null;const calls=[];
 const fetchImpl=async(url,options)=>{
  assert.ok(url.startsWith('https://api.vk.com/method/'));assert.equal(options.method,'POST');assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.headers.Authorization,`Bearer ${TOKEN}`);assert.ok(!url.includes(TOKEN));assert.ok(!options.body.includes(TOKEN));
  const method=url.split('/').at(-1),params=Object.fromEntries(new URLSearchParams(options.body));assert.equal(params.v,'5.199');
  const call={method,params,options};calls.push(call);if(handler)return handler(call);
  return wire({'groups.getTokenPermissions':{mask:4096,permissions:[{name:'messages',setting:1}]},
   'groups.getById':{groups:[{id:Number(params.group_id),name:'Студия',screen_name:'fixture_studio'}]},
   'messages.getConversations':{count:1,items:[{conversation:conversation(),last_message:msg()}],profiles:[{id:101,first_name:'Анна',last_name:'Иванова',private:PRIVATE}]},
   'messages.getConversationsById':{count:1,items:[conversation(Number(params.peer_ids))]},
   'messages.getHistory':{count:1,items:[msg(Number(params.peer_id))]},'messages.send':88}[method]);
 };
 const options={apiKey:KEY,fetchImpl,now:()=>Date.parse('2026-09-17T12:00:00Z'),...extra};const api=createVkCommunity(db,options);
 const save=(code='avokado',changes={})=>api.saveSettings(code,{revision:0,groupId:code==='avokado'?'12345':'67890',communityToken:TOKEN,...changes});
 const connect=async(code='avokado')=>{save(code);assert.equal((await api.checkConnection(code)).ok,true);};
 const sync=async(code='avokado')=>{await connect(code);return api.syncConversations(code);};
 const reply=(changes={},code='avokado')=>api.reply(code,{revision:1,peerId:101,text:'Добрый день!',requestId:'fixture_request_0001',...changes});
 return {db,api,options,calls,save,connect,sync,reply,setHandler:value=>handler=value};
}
function safe(value) {const text=JSON.stringify(value);for(const part of [KEY,TOKEN,PRIVATE,'encrypted_token'])assert.ok(!text.includes(part),part);}
const code=expected=>error=>{assert.equal(error.code,expected);safe({message:error.message,...error});return true;};

test('separate company credentials are encrypted and saved settings never imply verified access',async t=>{
 const f=fixture(t);assert.equal(f.api.getSettings('avokado').status,'not_configured');f.save();f.save('alvi');
 assert.equal(f.calls.length,0);const saved=f.api.getSettings('AVOKADO');safe(saved);assert.equal(saved.companyCode,'avokado');
 assert.equal(saved.tokenConfigured,true);assert.equal(saved.connected,false);assert.equal(saved.status,'needs_check');
 assert.deepEqual(saved.capabilities,{messages:false,communityInfo:false,statistics:false,ads:false,design:false});
 const rows=f.db.prepare('SELECT * FROM vk_community_connections').all();assert.notEqual(rows[0].encrypted_token,rows[1].encrypted_token);
 for(const row of rows)assert.ok(!row.encrypted_token.includes(TOKEN));
 const checked=await f.api.checkConnection('avokado');safe(checked);assert.equal(checked.ok,true);assert.equal(checked.capabilities.messages,true);
 assert.deepEqual(checked.group,{id:'12345',name:'Студия',screenName:'fixture_studio'});assert.equal(f.api.getSettings('alvi').connected,false);
 assert.deepEqual(f.calls.map(c=>c.method),['groups.getTokenPermissions','groups.getById','messages.getConversations']);
 assert.equal(f.calls[1].params.group_id,'12345');assert.equal(f.calls[2].params.group_id,'12345');
});

test('ciphertext cannot be moved between companies or groups and encryption rotation fails closed',async t=>{
 const f=fixture(t);f.save();f.save('alvi');const before=f.db.prepare("SELECT encrypted_token FROM vk_community_connections WHERE company_code='avokado'").get().encrypted_token;
 f.db.prepare("UPDATE vk_community_connections SET encrypted_token=? WHERE company_code='alvi'").run(before);
 assert.equal((await f.api.checkConnection('alvi')).code,'TOKEN_UNREADABLE');assert.equal(f.calls.length,0);
 f.db.prepare("UPDATE vk_community_connections SET group_id='444' WHERE company_code='avokado'").run();
 assert.equal(f.api.getSettings('avokado').tokenConfigured,false);
 const rotated=createVkCommunity(f.db,{...f.options,apiKey:'OTHER_FIXTURE_KEY'});assert.equal(rotated.getSettings('alvi').tokenConfigured,false);
 assert.equal(f.db.prepare("SELECT encrypted_token FROM vk_community_connections WHERE company_code='avokado'").get().encrypted_token,before);
});

test('blank token preserves only same group; mandatory revision and company boundary reject stale settings',async t=>{
 const f=fixture(t);await f.sync();
 for(const companyCode of ['missing','deleted'])assert.throws(()=>f.api.getSettings(companyCode),e=>e.status===404);
 assert.throws(()=>f.api.getSettings('../avokado'),e=>e.status===400);
 assert.throws(()=>f.save('avokado',{revision:0}),code('SETTINGS_CHANGED'));
 assert.throws(()=>f.save('avokado',{revision:1,groupId:'999',communityToken:''}),e=>e.status===400);
 const saved=f.save('avokado',{revision:1,communityToken:''});assert.equal(saved.revision,2);assert.equal(saved.tokenConfigured,true);assert.equal(saved.connected,false);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vk_community_dialogs').get().n,0);
 await assert.rejects(f.reply(),code('SETTINGS_CHANGED'));
 for(const body of [{groupId:'https://vk.com/club12345'},{groupId:12345},{communityToken:'secret\ninvalid'}])assert.throws(()=>f.save('avokado',{revision:2,...body}),e=>e.status===400);
});

test('revision comparison occurs inside save transaction and preserves concurrent owner edits',t=>{
 const f=fixture(t);f.save();let inject=true;
 const wrapped={prepare:sql=>f.db.prepare(sql),exec(sql){if(sql==='BEGIN IMMEDIATE'&&inject){inject=false;f.db.exec("UPDATE vk_community_connections SET revision=2 WHERE company_code='avokado'");}return f.db.exec(sql);}};
 const api=createVkCommunity(wrapped,f.options);
 assert.throws(()=>api.saveSettings('avokado',{revision:1,groupId:'12345',communityToken:''}),code('SETTINGS_CHANGED'));
 assert.equal(f.api.getSettings('avokado').revision,2);
});

test('public group lookup alone never validates messaging access, denied or wrong group stays disconnected',async t=>{
 for(const mode of ['wrong-group','denied-messaging','wrong-token','malformed']) {
  const f=fixture(t);f.save();
  f.setHandler(({method})=>{
   if(method==='groups.getTokenPermissions')return mode==='wrong-token'?new Response(JSON.stringify({error:{error_code:27,error_msg:TOKEN+PRIVATE}})):wire(mode==='malformed'?{}:{mask:4096,permissions:[]});
   if(method==='groups.getById')return wire({groups:[{id:mode==='wrong-group'?999:12345,name:'Студия'}]});
   return new Response(JSON.stringify({error:{error_code:15,error_msg:TOKEN+PRIVATE}}));
  });
  const checked=await f.api.checkConnection('avokado');safe(checked);assert.equal(checked.ok,false);assert.equal(checked.connected,false);assert.equal(checked.group,null);
  assert.equal(checked.code,mode==='wrong-group'?'GROUP_MISMATCH':mode==='malformed'?'RESPONSE_INVALID':'ACCESS_DENIED');
  await assert.rejects(f.api.syncConversations('avokado'),code('CONNECTION_MISSING'));
 }
});

test('stale in-flight check cannot overwrite newly saved settings or continue to messaging requests',async t=>{
 const f=fixture(t);f.save();let release;
 f.setHandler(()=>new Promise(resolve=>release=()=>resolve(wire({mask:4096,permissions:[]}))));
 const pending=f.api.checkConnection('avokado');f.save('avokado',{revision:1,communityToken:''});release();
 const result=await pending;assert.equal(result.code,'SETTINGS_CHANGED');assert.equal(result.revision,2);assert.equal(result.status,'needs_check');assert.equal(f.calls.length,1);
});

test('manual sync returns minimal conversations and history without marking read or sending, exact tenant group in every call',async t=>{
 const f=fixture(t);const list=await f.sync();safe(list);assert.equal(list.companyCode,'avokado');
 assert.deepEqual(list.items,[{peerId:101,title:'Анна Иванова',unreadCount:0,canReply:true,lastMessage:{id:77,peerId:101,fromId:101,text:'Здравствуйте',date:1789640000,out:false}}]);
 const history=await f.api.syncHistory('avokado',{peerId:101,offset:0,count:50});assert.equal(history.items[0].peerId,101);safe(history);
 assert.ok(f.calls.every(c=>c.method.startsWith('groups.get')||c.method.startsWith('messages.get')));
 assert.ok(f.calls.filter(c=>c.method.startsWith('messages.')).every(c=>c.params.group_id==='12345'));
 await f.connect('alvi');const count=f.calls.length;
 await assert.rejects(f.api.syncHistory('alvi',{peerId:101}),code('DIALOG_REQUIRED'));
 await assert.rejects(f.reply({},'alvi'),code('DIALOG_REQUIRED'));assert.equal(f.calls.length,count);
});

test('messages from another peer and stale sync responses are never returned or cached',async t=>{
 const f=fixture(t);await f.sync();f.setHandler(()=>wire({count:1,items:[msg(999)]}));
 await assert.rejects(f.api.syncHistory('avokado',{peerId:101}),code('RESPONSE_INVALID'));
 let release;f.setHandler(()=>new Promise(resolve=>release=()=>resolve(wire({count:1,items:[{conversation:conversation(102),last_message:msg(102)}]}))));
 const pending=f.api.syncConversations('avokado');f.save('avokado',{revision:1,communityToken:''});release();
 await assert.rejects(pending,code('SETTINGS_CHANGED'));assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vk_community_dialogs').get().n,0);
});

test('group chats are excluded and arbitrary recipients cannot be contacted',async t=>{
 const f=fixture(t);await f.connect();f.setHandler(()=>wire({count:1,items:[{conversation:{peer:{id:2000000001,type:'chat'}}}]}));
 const list=await f.api.syncConversations('avokado');assert.deepEqual(list.items,[]);const count=f.calls.length;
 await assert.rejects(f.reply({peerId:2000000001}),code('DIALOG_REQUIRED'));
 await assert.rejects(f.reply({peerId:909}),code('DIALOG_REQUIRED'));assert.equal(f.calls.length,count);
});

test('explicit reply rechecks exact dialog permission and records stable logical send, duplicate never resends',async t=>{
 const f=fixture(t);await f.sync();const sent=await f.reply();safe(sent);
 assert.deepEqual(sent,{companyCode:'avokado',revision:1,peerId:101,requestId:'fixture_request_0001',status:'sent',messageId:88,code:null});
 const send=f.calls.at(-1);assert.equal(send.method,'messages.send');assert.equal(send.params.group_id,'12345');assert.equal(send.params.peer_id,'101');assert.equal(send.params.message,'Добрый день!');assert.ok(Number(send.params.random_id)>0);
 const count=f.calls.length;assert.deepEqual(await f.reply(),sent);assert.equal(f.calls.length,count);
 await assert.rejects(f.reply({text:'Другой текст'}),code('REQUEST_CONFLICT'));assert.equal(f.calls.length,count);
 const stored=f.db.prepare('SELECT * FROM vk_community_replies').get();assert.ok(!JSON.stringify(stored).includes('Добрый день!'));
});

test('reply access denied or wrong peer fails before any send and raw provider error stays private',async t=>{
 for(const response of [{count:1,items:[conversation(101,{can_write:{allowed:false}})]},{count:1,items:[conversation(999)]}]) {
  const f=fixture(t);await f.sync();f.setHandler(()=>wire(response));
  await assert.rejects(f.reply(),code(response.items[0].peer.id===999?'DIALOG_REQUIRED':'REPLY_DENIED'));
  assert.equal(f.calls.some(c=>c.method==='messages.send'),false);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vk_community_replies').get().n,0);
 }
});

test('timeout, malformed success and explicit rejection have distinct safe states and never auto-resend',async t=>{
 for(const mode of ['timeout','malformed','denied']) {
  const f=fixture(t);await f.sync();f.setHandler(({method})=>{
   if(method==='messages.getConversationsById')return wire({count:1,items:[conversation()]});
   if(mode==='timeout')throw new Error(TOKEN+PRIVATE);
   if(mode==='denied')return new Response(JSON.stringify({error:{error_code:15,error_msg:TOKEN+PRIVATE,request_params:[{value:TOKEN}]}}));
   return wire({message_id:88,private:PRIVATE});
  });
  const result=await f.reply();safe(result);assert.equal(result.status,mode==='denied'?'failed':'uncertain');assert.equal(result.messageId,null);
  const count=f.calls.length;assert.deepEqual(await f.reply(),result);assert.equal(f.calls.length,count);
 }
});

test('concurrent duplicate replies produce one external send',async t=>{
 const f=fixture(t);await f.sync();const releases=[];
 f.setHandler(({method})=>method==='messages.getConversationsById'?new Promise(resolve=>releases.push(()=>resolve(wire({count:1,items:[conversation()]})))):wire(88));
 const first=f.reply(),second=f.reply();releases.forEach(release=>release());
 const values=await Promise.all([first,second]);assert.ok(values.every(item=>['sending','sent'].includes(item.status)));assert.equal(f.calls.filter(c=>c.method==='messages.send').length,1);
 assert.equal((await f.reply()).status,'sent');
});

test('settings change before send blocks mutation; change during send preserves audit outcome but rejects stale response',async t=>{
 const f=fixture(t);await f.sync();let release;
 f.setHandler(()=>new Promise(resolve=>release=()=>resolve(wire({count:1,items:[conversation()]}))));
 const blocked=f.reply();f.save('avokado',{revision:1,communityToken:''});release();await assert.rejects(blocked,code('SETTINGS_CHANGED'));
 assert.equal(f.calls.some(c=>c.method==='messages.send'),false);
 f.setHandler(null);await f.api.checkConnection('avokado');await f.api.syncConversations('avokado');
 f.setHandler(({method})=>method==='messages.getConversationsById'?wire({count:1,items:[conversation()]}):new Promise(resolve=>release=()=>resolve(wire(88))));
 const inFlight=f.reply({revision:2});
 while(!f.calls.some(c=>c.method==='messages.send'))await new Promise(resolve=>setImmediate(resolve));
 f.save('avokado',{revision:2,communityToken:''});release();await assert.rejects(inFlight,code('SETTINGS_CHANGED'));
 assert.equal(f.db.prepare('SELECT status FROM vk_community_replies').get().status,'sent');assert.equal(f.api.getSettings('avokado').connected,false);
});

test('oversized bodies are cancelled, and stalled streamed body times out without raw error exposure',async t=>{
 for(const mode of ['oversized','stall']) {
  const f=fixture(t,{timeoutMs:10});f.save();let cancelled=false;
  f.setHandler(()=>({ok:true,body:new ReadableStream({pull(controller){if(mode==='oversized')controller.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}})}));
  const keepAlive=setTimeout(()=>{},500);try {const checked=await f.api.checkConnection('avokado');safe(checked);assert.equal(checked.code,'CONNECTION_UNCERTAIN');assert.equal(cancelled,true);} finally {clearTimeout(keepAlive);}
 }
});
