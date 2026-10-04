'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createVkCommunity}=require('./vk-community');
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII=';
const PDF=Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n').toString('base64');
const TOKEN='FIXTURE_COMMUNITY_TOKEN',KEY='FIXTURE_STORAGE_KEY',ACCESS='FIXTURE_ACCESS_KEY',PRIVATE='PRIVATE_PROVIDER_DETAIL';
const wire=(response,status=200)=>new Response(JSON.stringify({response}),{status});
const raw=(value,status=200)=>new Response(JSON.stringify(value),{status});
const dialog=(peerId=101,allowed=true)=>({peer:{id:peerId,type:'user'},can_write:{allowed}});
const message=(attachments=[])=>({id:7,peer_id:101,from_id:101,date:1791000000,text:'Фото и документы',out:0,attachments});
const file=(mime='image/png')=>({name:mime==='application/pdf'?'Прайс.pdf':'Фото.png',mime,base64:mime==='application/pdf'?PDF:PNG});
const errorCode=code=>error=>{assert.equal(error.code,code);safe(error);return true;};
function safe(value) {for(const part of [TOKEN,KEY,ACCESS,PRIVATE,'encrypted_token','access_key','base64'])assert.ok(!JSON.stringify(value).includes(part),part);}
function fixture(t,extra={}) {
 const db=new DatabaseSync(':memory:');db.exec("PRAGMA foreign_keys=ON;CREATE TABLE companies(code TEXT PRIMARY KEY COLLATE NOCASE,is_deleted INTEGER DEFAULT 0);INSERT INTO companies VALUES('palitra',0),('other',0),('deleted',1)");t.after(()=>db.close());
 let currentTime=Date.parse('2026-10-04T12:00:00Z'),handler,uploadHandler;const calls=[],uploads=[];
 const fetchImpl=async(url,options)=>{
  assert.equal(options.method,'POST');assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
  if(!url.startsWith('https://api.vk.com/method/')) {
   const call={url,options};uploads.push(call);assert.ok(!options.headers);assert.ok(options.body instanceof FormData);
   if(uploadHandler)return uploadHandler(call);
   return raw(options.body.has('photo')?{server:1,photo:'FIXTURE_OPAQUE_PHOTO',hash:'FIXTURE_HASH'}:{file:'FIXTURE_OPAQUE_DOC'});
  }
  assert.equal(options.headers.Authorization,`Bearer ${TOKEN}`);const method=url.split('/').at(-1),params=Object.fromEntries(new URLSearchParams(options.body));
  const call={method,params,options};calls.push(call);if(handler){const result=await handler(call);if(result!==undefined)return result;}
  if(method==='groups.getTokenPermissions')return wire({mask:4096,permissions:[]});
  if(method==='groups.getById')return wire({groups:[{id:Number(params.group_id),name:'Fixture group'}]});
  if(method==='messages.getConversations')return wire({count:1,items:[{conversation:dialog(),last_message:message()}]});
  if(method==='messages.getConversationsById')return wire({count:1,items:[dialog(Number(params.peer_ids))]});
  if(method==='messages.getHistory')return wire({count:1,items:[message()]});
  if(method==='photos.getMessagesUploadServer'||method==='docs.getMessagesUploadServer')return wire({upload_url:'https://pu.vk.com/upload?act=fixture'});
  if(method==='photos.saveMessagesPhoto')return wire([{owner_id:-12345,id:7,access_key:ACCESS}]);
  if(method==='docs.save')return wire({type:'doc',doc:{owner_id:-12345,id:8,access_key:ACCESS}});
  if(method==='messages.send')return wire(88);
  throw Error('Unexpected method: '+method);
 };
 const options={apiKey:KEY,fetchImpl,now:()=>currentTime,...extra},api=createVkCommunity(db,options);
 const connect=async(code='palitra')=>{api.saveSettings(code,{revision:0,groupId:code==='palitra'?'12345':'22222',communityToken:TOKEN});assert.equal((await api.checkConnection(code)).ok,true);await api.syncConversations(code);};
 const preview=(changes={},code='palitra')=>api.previewReply(code,{revision:1,peerId:101,text:'Подтверждённый текст',file:file(),...changes});
 const confirm=(p,changes={},code='palitra')=>api.confirmReply(code,{revision:1,previewId:p.previewId,requestId:'fixture_request_0001',...changes});
 const writes=()=>calls.filter(call=>['photos.saveMessagesPhoto','docs.save','messages.send'].includes(call.method));
 return {db,api,options,calls,uploads,connect,preview,confirm,writes,setHandler:value=>handler=value,setUploadHandler:value=>uploadHandler=value,advance:ms=>currentTime+=ms};
}

test('local immutable preview validates scope and retains private bytes with no provider call',async t=>{
 const f=fixture(t);await f.connect();const before=f.calls.length,body={revision:1,peerId:101,text:'Frozen',file:file()},p=f.api.previewReply('PALITRA',body);
 body.text='Changed';body.file.base64='Changed';assert.equal(f.calls.length,before);assert.equal(f.uploads.length,0);safe(p);
 assert.equal(p.text,'Frozen');assert.equal(p.file.mime,'image/png');assert.equal(p.file.width,1);assert.equal(Date.parse(p.expiresAt)-Date.parse(p.createdAt),30*60*1000);
 const stored=f.db.prepare('SELECT * FROM vk_community_reply_previews').get();assert.equal(stored.text,'Frozen');assert.deepEqual(Buffer.from(stored.file_bytes),Buffer.from(PNG,'base64'));
 assert.throws(()=>f.preview({peerId:202}),errorCode('DIALOG_REQUIRED'));assert.throws(()=>f.preview({revision:2}),errorCode('SETTINGS_CHANGED'));
 for(const changes of [{attachment:'photo1_2'},{url:'https://evil.test/x'},{companyCode:'other'},{file:{...file(),url:'https://evil.test/x'}},{text:'' ,file:undefined}])assert.throws(()=>f.preview(changes),errorCode('INVALID_INPUT'));
 assert.equal(f.calls.length,before);
});

test('explicit photo confirmation uploads and sends the frozen preview once; retries and restarts reuse journal',async t=>{
 const f=fixture(t);await f.connect();const p=f.preview(),result=await f.confirm(p);safe(result);assert.equal(result.status,'sent');assert.equal(result.messageId,88);
 assert.deepEqual(f.writes().map(c=>c.method),['photos.saveMessagesPhoto','messages.send']);assert.equal(f.uploads.length,1);
 const uploaded=f.uploads[0].options.body.get('photo');assert.equal(uploaded.type,'image/png');assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()),Buffer.from(PNG,'base64'));
 const server=f.calls.find(c=>c.method==='photos.getMessagesUploadServer');assert.equal(server.params.peer_id,'101');
 const sent=f.calls.find(c=>c.method==='messages.send');assert.equal(sent.params.attachment,`photo-12345_7_${ACCESS}`);assert.equal(sent.params.message,p.text);assert.equal(sent.params.group_id,'12345');assert.equal(sent.params.peer_id,'101');
 const count=f.calls.length;assert.deepEqual(await f.confirm(p),result);assert.deepEqual(await f.confirm(p,{requestId:'fixture_request_0002'}),result);
 const restarted=createVkCommunity(f.db,f.options);assert.deepEqual(await restarted.confirmReply('palitra',{revision:1,previewId:p.previewId,requestId:'fixture_request_0003'}),result);assert.equal(f.calls.length,count);
 const preview=f.db.prepare('SELECT * FROM vk_community_reply_previews').get();assert.equal(preview.file_bytes,null);assert.equal(preview.text,null);
 safe(f.db.prepare('SELECT * FROM vk_community_replies').all());safe(f.db.prepare('SELECT * FROM vk_community_reply_actions').all());
 const second=f.preview({text:'New preview'});await assert.rejects(f.confirm(second),errorCode('REQUEST_CONFLICT'));
});

test('file-only PDF uses doc upload contract and normalized filename; manual text-only confirmation still works',async t=>{
 const f=fixture(t);await f.connect();const p=f.preview({text:'',file:{...file('application/pdf'),name:'Прайс.exe'}}),result=await f.confirm(p);assert.equal(result.status,'sent');
 const doc=f.uploads[0].options.body.get('file');assert.equal(doc.type,'application/pdf');assert.equal(doc.name,'Прайс.pdf');assert.deepEqual(Buffer.from(await doc.arrayBuffer()),Buffer.from(PDF,'base64'));
 const server=f.calls.find(c=>c.method==='docs.getMessagesUploadServer');assert.equal(server.params.type,'doc');assert.equal(server.params.peer_id,'101');
 assert.equal(f.calls.find(c=>c.method==='docs.save').params.title,'Прайс.pdf');assert.equal(f.calls.find(c=>c.method==='messages.send').params.attachment,`doc-12345_8_${ACCESS}`);
 const text=f.preview({file:undefined,text:'Без файла'});assert.equal(text.file,null);assert.equal((await f.confirm(text,{requestId:'fixture_request_text'})).status,'sent');assert.equal(f.uploads.length,1);assert.equal(f.calls.at(-1).params.attachment,undefined);
 const pdf2=f.preview({file:{...file('application/pdf'),base64:Buffer.from(Buffer.from(PDF,'base64').toString().replace('%PDF-1.7','%PDF-2.0')).toString('base64')}});assert.equal(pdf2.file.mime,'application/pdf');
});

test('durable claim precedes awaits; concurrent confirmations cannot duplicate a chain or retain source bytes',async t=>{
 const f=fixture(t);await f.connect();const p=f.preview();let release;
 f.setHandler(({method})=>{if(method==='messages.getConversationsById'&&!release)return new Promise(resolve=>release=()=>resolve(wire({count:1,items:[dialog()]})));});
 const first=f.confirm(p);assert.ok(release);const row=f.db.prepare('SELECT * FROM vk_community_replies').get();assert.equal(row.status,'sending');
 assert.equal(f.db.prepare('SELECT file_bytes FROM vk_community_reply_previews').get().file_bytes,null);
 const second=await f.confirm(p,{requestId:'fixture_request_other'});assert.equal(second.status,'sending');assert.equal(f.uploads.length,0);release();assert.equal((await first).status,'sent');assert.equal(f.uploads.length,1);assert.equal(f.writes().filter(c=>c.method==='messages.send').length,1);
});

test('a durable crash claim remains non-retryable across connector recreation and new request IDs',async t=>{
 const f=fixture(t);await f.connect();const p=f.preview();
 const original=f.db.prepare('SELECT * FROM vk_community_reply_previews').get();
 f.db.prepare("INSERT INTO vk_community_replies(company_code,request_id,revision,group_id,peer_id,text_hash,random_id,status,created_at) VALUES('palitra','fixture_crash_request',1,'12345',101,?,123,'sending',?)").run(original.content_hash,original.created_at);
 f.db.prepare("INSERT INTO vk_community_reply_actions VALUES('palitra',?,'fixture_crash_request')").run(p.previewId);
 f.db.prepare('UPDATE vk_community_reply_previews SET file_bytes=NULL,text=NULL').run();
 const restarted=createVkCommunity(f.db,f.options),before=f.calls.length;
 const result=await restarted.confirmReply('palitra',{revision:1,previewId:p.previewId,requestId:'fixture_new_request'});assert.equal(result.status,'sending');assert.equal(f.calls.length,before);assert.equal(f.uploads.length,0);
});

test('another company, edited confirmation payload, stale revision and expired previews never dispatch',async t=>{
 const f=fixture(t);await f.connect();await f.connect('other');const p=f.preview(),before=f.calls.length;
 await assert.rejects(f.confirm(p,{},'other'),errorCode('PREVIEW_NOT_FOUND'));
 for(const changes of [{peerId:202},{text:'Replacement'},{file:file()},{groupId:'22222'},{attachment:'doc9_8'}])await assert.rejects(f.confirm(p,changes),errorCode('INVALID_INPUT'));
 f.advance(30*60*1000);await assert.rejects(f.confirm(p),errorCode('PREVIEW_EXPIRED'));assert.equal(f.db.prepare('SELECT file_bytes FROM vk_community_reply_previews').get().file_bytes,null);
 const fresh=f.preview();f.api.saveSettings('palitra',{revision:1,groupId:'12345',communityToken:''});await assert.rejects(f.confirm(fresh),errorCode('SETTINGS_CHANGED'));
 assert.equal(f.calls.length,before);assert.equal(f.uploads.length,0);
});

test('permission is checked before upload and immediately before send; denial never sends',async t=>{
 for(const denyCheck of [1,2]) {
  const f=fixture(t);await f.connect();const p=f.preview();let checks=0;
  f.setHandler(({method})=>{if(method==='messages.getConversationsById')return wire({count:1,items:[dialog(101,++checks!==denyCheck)]});});
  const result=await f.confirm(p);assert.equal(result.status,'failed');assert.equal(result.code,'REPLY_DENIED');assert.equal(f.uploads.length,denyCheck-1);assert.equal(f.writes().some(c=>c.method==='messages.send'),false);
  const before=f.calls.length;assert.deepEqual(await f.confirm(p,{requestId:'fixture_retry_denied'}),result);assert.equal(f.calls.length,before);
 }
});

test('binding changes during upload block subsequent saves and sends and preserve a terminal journal',async t=>{
 const f=fixture(t);await f.connect();const p=f.preview();f.setUploadHandler(()=>{f.api.saveSettings('palitra',{revision:1,groupId:'12345',communityToken:''});return raw({server:1,photo:'PHOTO',hash:'HASH'});});
 await assert.rejects(f.confirm(p),errorCode('SETTINGS_CHANGED'));assert.equal(f.writes().length,0);assert.equal(f.db.prepare('SELECT status FROM vk_community_replies').get().status,'failed');
 assert.equal(f.db.prepare('SELECT file_bytes FROM vk_community_reply_previews').get().file_bytes,null);
});

test('unsafe upload URLs are blocked before multipart requests',async t=>{
 const f=fixture(t);await f.connect();let i=0;
 for(const url of ['http://pu.vk.com/upload','https://vk.com.evil.test/upload','https://userapi.com@evil.test/upload','https://127.0.0.1/upload','https://pu.vk.com:444/upload','https://pu.vk.com/upload#fragment']) {
  const p=f.preview();f.setHandler(({method})=>method==='photos.getMessagesUploadServer'?wire({upload_url:url}):undefined);
  const result=await f.confirm(p,{requestId:'fixture_bad_url_'+String(i++).padStart(3,'0')});assert.equal(result.status,'failed');assert.equal(result.code,'UNSAFE_UPLOAD_URL');
 }
 assert.equal(f.uploads.length,0);assert.equal(f.writes().length,0);
});

test('bad and oversized files, dimensions and noncanonical base64 are rejected before any external call',async t=>{
 const f=fixture(t);await f.connect();const before=f.calls.length;
 const dimension=Buffer.from(PNG,'base64');dimension.writeUInt32BE(20000,16);
 for(const bad of [null,{...file(),mime:'text/html'},{...file(),name:'../escape.png'},{...file(),name:'foo\u202Egnp.exe'},{...file(),base64:'AAAA===='},
  {...file(),base64:Buffer.from('not a PNG').toString('base64')},{...file(),base64:dimension.toString('base64')},
  {...file('application/pdf'),base64:Buffer.from('%PDF-1.7\nmissing trailer').toString('base64')},
  {...file('application/pdf'),base64:Buffer.alloc(8*1024*1024+1).toString('base64')}])assert.throws(()=>f.preview({file:bad}),errorCode(bad===null?'INVALID_INPUT':'INVALID_FILE'));
 assert.equal(f.calls.length,before);assert.equal(f.uploads.length,0);
});

test('preview limits are bounded per company and expired source bytes are purged on next access',async t=>{
 const f=fixture(t);await f.connect();for(let i=0;i<20;i++)f.preview();assert.throws(()=>f.preview(),errorCode('PREVIEW_LIMIT'));
 f.advance(30*60*1000);const p=f.preview();assert.ok(p.previewId);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vk_community_reply_previews WHERE file_bytes IS NOT NULL').get().n,1);
});

test('incoming attachments expose minimal safe photo/PDF metadata and placeholders without access keys',async t=>{
 const f=fixture(t);await f.connect();const attachments=[
  {type:'photo',photo:{id:2,owner_id:101,access_key:ACCESS,sizes:[{url:'https://sun1.userapi.com/p.png',width:100,height:50},{url:'https://evil.test/p.png',width:999,height:999}]}},
  {type:'doc',doc:{url:'https://vk.com/doc123?dl=1',title:'Прайс.pdf',size:42,ext:'pdf',access_key:ACCESS}},
  {type:'doc',doc:{url:'https://vk.com/doc123',title:'malware.exe',size:20,ext:'exe'}},
  {type:'photo',photo:{sizes:[{url:'https://sun1.userapi.com/p.png?access_key='+ACCESS,width:100,height:50}]}},
  {type:'photo',photo:{sizes:[{url:'javascript:alert(1)',width:100,height:50}]}},{type:'wall',wall:{text:PRIVATE}},{type:'doc',doc:{url:'https://evil.test/p.pdf',title:'bad.pdf',size:42,ext:'pdf'}},
 ];
 f.setHandler(({method})=>method==='messages.getHistory'?wire({count:1,items:[message(attachments)]}):undefined);
 const result=await f.api.syncHistory('palitra',{revision:1,peerId:101});safe(result);assert.deepEqual(result.items[0].attachments.slice(0,2),[
  {type:'photo',name:'Фото',url:'https://sun1.userapi.com/p.png',width:100,height:50},{type:'doc',name:'Прайс.pdf',url:'https://vk.com/doc123?dl=1',size:42,mime:'application/pdf'},
 ]);assert.ok(result.items[0].attachments.slice(2).every(item=>item.type==='unavailable'&&!item.url));assert.equal(f.writes().length,0);
});

test('upload redirects, oversized payloads and hangs produce safe unknown outcome with no retry',async t=>{
 for(const mode of ['redirect','oversized','hang','malformed']) {
  const f=fixture(t,{timeoutMs:20});await f.connect();const p=f.preview();
  f.setUploadHandler(()=>{
   if(mode==='redirect')return new Response('',{status:302,headers:{location:'https://evil.test'}});
   if(mode==='oversized')return new Response('x'.repeat(2*1024*1024+1));
   if(mode==='hang')return new Promise(()=>{});
   return raw({server:1,photo:42,hash:PRIVATE});
  });
  const result=await f.confirm(p);safe(result);assert.equal(result.status,'uncertain');assert.equal(f.writes().length,0);
  assert.deepEqual(await f.confirm(p,{requestId:'fixture_no_auto_retry'}),result);assert.equal(f.uploads.length,1);
 }
});

test('HTTP 5xx with VK error body is ambiguous for attachment and legacy text sends',async t=>{
 for(const legacy of [false,true]) {
  const f=fixture(t);await f.connect();f.setHandler(({method})=>method==='messages.send'?raw({error:{error_code:15,error_msg:TOKEN+PRIVATE}},503):undefined);
  const result=legacy?await f.api.reply('palitra',{revision:1,peerId:101,text:'Legacy',requestId:'fixture_legacy_request'}):await f.confirm(f.preview());
  safe(result);assert.equal(result.status,'uncertain');assert.equal(result.code,'CONNECTION_UNCERTAIN');assert.equal(f.writes().filter(c=>c.method==='messages.send').length,1);
 }
});

test('HTTP 200 internal, unknown and malformed VK errors leave every dispatched write uncertain and non-retryable',async t=>{
 for(const stage of ['photos.saveMessagesPhoto','docs.save','messages.send','legacy'])for(const error of [
  {error_code:1,error_msg:PRIVATE},{error_code:10,error_msg:PRIVATE},{error_code:36,error_msg:PRIVATE},{error_code:999999,error_msg:PRIVATE},{error_code:'15',error_msg:PRIVATE},null,[],
 ]) {
  const f=fixture(t);await f.connect();const method=stage==='legacy'?'messages.send':stage;
  // An error field takes precedence even if a malformed provider envelope also contains a success value.
  f.setHandler(call=>call.method===method?raw({error,response:88}):undefined);
  const p=stage==='legacy'?null:f.preview({file:file(stage==='docs.save'?'application/pdf':'image/png')});
  const legacyBody={revision:1,peerId:101,text:'Legacy',requestId:'fixture_legacy_request'};
  const result=stage==='legacy'?await f.api.reply('palitra',legacyBody):await f.confirm(p);
  safe(result);assert.equal(result.status,'uncertain',stage);assert.equal(result.code,'CONNECTION_UNCERTAIN');
  assert.equal(f.calls.filter(call=>call.method===method).length,1);
  if(method!=='messages.send')assert.equal(f.calls.some(call=>call.method==='messages.send'),false);
  const calls=f.calls.length,uploads=f.uploads.length,restarted=createVkCommunity(f.db,f.options);
  const replay=stage==='legacy'?await restarted.reply('palitra',legacyBody):await restarted.confirmReply('palitra',{revision:1,previewId:p.previewId,requestId:'fixture_distinct_retry'});
  assert.deepEqual(replay,result);assert.equal(f.calls.length,calls);assert.equal(f.uploads.length,uploads);
  assert.equal(f.db.prepare('SELECT status FROM vk_community_replies').get().status,'uncertain');
 }
});

test('only known VK access, validation and rate errors remain definite write failures',async t=>{
 for(const stage of ['photos.saveMessagesPhoto','docs.save','messages.send','legacy'])for(const providerCode of [15,901,6,100]) {
  const f=fixture(t);await f.connect();const method=stage==='legacy'?'messages.send':stage;
  f.setHandler(call=>call.method===method?raw({error:{error_code:providerCode,error_msg:PRIVATE}}):undefined);
  const p=stage==='legacy'?null:f.preview({file:file(stage==='docs.save'?'application/pdf':'image/png')});
  const legacyBody={revision:1,peerId:101,text:'Legacy',requestId:'fixture_legacy_request'};
  const result=stage==='legacy'?await f.api.reply('palitra',legacyBody):await f.confirm(p);
  safe(result);assert.equal(result.status,'failed');assert.equal(result.code,[6,100].includes(providerCode)?'PLATFORM_REJECTED':'ACCESS_DENIED');
  const count=f.calls.length;
  assert.deepEqual(stage==='legacy'?await f.api.reply('palitra',legacyBody):await f.confirm(p,{requestId:'fixture_definite_retry'}),result);
  assert.equal(f.calls.length,count);assert.equal(f.calls.filter(call=>call.method===method).length,1);
 }
});

test('malformed saved attachment references cannot add additional attachment types or escape DTOs',async t=>{
 const f=fixture(t);await f.connect();f.setHandler(({method})=>method==='photos.saveMessagesPhoto'?wire([{owner_id:-12345,id:7,access_key:'unsafe,doc1_2'}]):undefined);
 const result=await f.confirm(f.preview());safe(result);assert.equal(result.status,'uncertain');assert.equal(result.code,'RESPONSE_INVALID');assert.equal(f.writes().some(c=>c.method==='messages.send'),false);
});
