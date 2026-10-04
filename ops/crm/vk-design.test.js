'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createVkDesign,validateImage,validateUploadUrl}=require('./vk-design');
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII=';
const oldImage={url:'https://sun1.userapi.com/old.jpg',width:1590,height:400};
const newImage={url:'https://sun1.userapi.com/new.jpg',width:1590,height:400};
function fixture(t) {
 const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE companies(code TEXT PRIMARY KEY COLLATE NOCASE,is_deleted INTEGER NOT NULL DEFAULT 0);INSERT INTO companies VALUES('palitra-love',0),('alvi',0),('deleted',1)");t.after(()=>db.close());
 const settings={companyCode:'palitra-love',groupId:'12345',revision:1,connected:true};
 let description='Before',cover={enabled:1,images:[oldImage]},handler,uploadHandler;const calls=[],uploads=[];
 const direct={getSettings(code){return {...settings,companyCode:code,groupId:code==='alvi'?'222':settings.groupId};},async request(code,purpose,revision,method,params){
  assert.equal(purpose,'design');assert.equal(revision,settings.revision);const call={code,method,params};calls.push(call);if(handler)return handler(call);
  if(method==='groups.getById')return {groups:[{id:Number(code==='alvi'?'222':settings.groupId),description,cover}]};
  if(method==='groups.edit'){description=params.description;return 1;}
  if(method==='photos.getOwnerCoverPhotoUploadServer')return {upload_url:'https://pu.vk.com/upload?act=cover'};
  if(method==='photos.saveOwnerCoverPhoto'){cover={enabled:1,images:[newImage]};return {images:[newImage]};}
  throw new Error('Unexpected method');
 }};
 const options={direct,now:()=>Date.parse('2026-10-04T12:00:00Z'),fetchImpl:async(url,opts)=>{uploads.push({url,opts});if(uploadHandler)return uploadHandler(url,opts);return new Response(JSON.stringify({hash:'FIXTURE_UPLOAD_HASH',photo:'FIXTURE_UPLOAD_PHOTO'}));}};
 const api=createVkDesign(db,options),preview=(extra={},code='palitra-love')=>api.preview(code,{revision:1,operation:'description',description:'After',...extra});
 const apply=(p,extra={},code='palitra-love')=>api.apply(code,{revision:1,previewId:p.previewId,requestId:'fixture_request_0001',...extra});
 return {db,api,options,settings,calls,uploads,preview,apply,setHandler:v=>handler=v,setUploadHandler:v=>uploadHandler=v,setDescription:v=>description=v};
}
const errorCode=code=>error=>{assert.equal(error.code,code);return true;};

test('description preview is private, immutable, company scoped and has no external mutation',async t=>{
 const f=fixture(t),p=await f.preview();assert.equal(p.before,'Before');assert.equal(p.after,'After');assert.equal(p.revision,1);assert.equal(p.sourceHash.length,64);
 assert.deepEqual(f.calls.map(c=>c.method),['groups.getById']);assert.equal(f.api.history('alvi').items.length,0);
 await assert.rejects(f.apply(p,{},'alvi'),errorCode('PREVIEW_NOT_FOUND'));assert.equal(f.calls.length,1);
 await assert.rejects(f.preview({revision:2}),errorCode('SETTINGS_CHANGED'));
 await assert.rejects(f.preview({groupId:'222'}),errorCode('INVALID_INPUT'));
});

test('description applies once, verifies readback and preserves audit across restart and retry IDs',async t=>{
 const f=fixture(t),p=await f.preview(),result=await f.apply(p);assert.equal(result.status,'verified');assert.equal(result.before,'Before');assert.equal(result.after,'After');
 assert.equal(f.calls.filter(c=>c.method==='groups.edit').length,1);
 assert.deepEqual(await f.apply(p),result);assert.deepEqual(await f.apply(p,{requestId:'fixture_request_0002'}),result);
 const restarted=createVkDesign(f.db,f.options);assert.deepEqual(await restarted.apply('palitra-love',{revision:1,previewId:p.previewId,requestId:'fixture_request_0001'}),result);
 assert.equal(f.calls.filter(c=>c.method==='groups.edit').length,1);assert.equal(f.api.history('palitra-love').items.length,1);
 const other=await f.preview({description:'Next'});await assert.rejects(f.apply(other),errorCode('REQUEST_CONFLICT'));
});

test('stale provider state or changed binding fails before mutation',async t=>{
 const f=fixture(t),p=await f.preview();f.setDescription('External owner edit');const result=await f.apply(p);assert.equal(result.status,'failed');assert.equal(result.code,'STATE_CHANGED');
 assert.ok(!f.calls.some(c=>c.method==='groups.edit'));f.settings.revision=2;await assert.rejects(f.apply(p),errorCode('SETTINGS_CHANGED'));
});

test('concurrent apply blocks a second mutation and claims the first before provider call',async t=>{
 const f=fixture(t),p=await f.preview();let release;
 f.setHandler(({method})=>{
  if(method==='groups.getById')return {groups:[{id:12345,description:'Before',cover:{enabled:1,images:[oldImage]}}]};
  assert.equal(f.db.prepare('SELECT status FROM vk_design_actions').get().status,'applying');return new Promise(resolve=>release=()=>resolve(1));
 });
 const pending=f.apply(p);while(!release)await new Promise(resolve=>setImmediate(resolve));
 const duplicate=await f.apply(p);assert.equal(duplicate.status,'applying');release();await pending;assert.equal(f.calls.filter(c=>c.method==='groups.edit').length,1);
});

test('uncertain mutation never retries, errors redact provider text and malformed acceptance is uncertain',async t=>{
 for(const mode of ['timeout','malformed','reject']){
  const f=fixture(t),p=await f.preview();f.setHandler(({method})=>{
   if(method==='groups.getById')return {groups:[{id:12345,description:'Before',cover:{enabled:1,images:[oldImage]}}]};
   if(mode==='malformed')return {secret:'TOKEN_DO_NOT_LEAK'};
   throw Object.assign(new Error('TOKEN_DO_NOT_LEAK'),{code:mode==='reject'?'ACCESS_DENIED':'CONNECTION_UNCERTAIN',ambiguous:mode!=='reject'});
  });
  const result=await f.apply(p);assert.equal(result.status,mode==='reject'?'failed':'uncertain');assert.ok(!JSON.stringify(result).includes('TOKEN_DO_NOT_LEAK'));
  await f.apply(p);assert.equal(f.calls.filter(c=>c.method==='groups.edit').length,1);
 }
});

test('accepted mutation is not represented as verified when readback differs or fails',async t=>{
 const f=fixture(t),p=await f.preview();f.setHandler(({method})=>method==='groups.edit'?1:{groups:[{id:12345,description:'Before',cover:{enabled:1,images:[oldImage]}}]});
 assert.equal((await f.apply(p)).status,'applied_unverified');
});

test('description rollback is a new guarded preview and never silently overwrites newer changes',async t=>{
 const f=fixture(t),p=await f.preview(),result=await f.apply(p);
 const rollback=await f.api.rollbackPreview('palitra-love',{revision:1,requestId:result.requestId});assert.equal(rollback.before,'After');assert.equal(rollback.after,'Before');assert.notEqual(rollback.previewId,p.previewId);
 assert.equal(f.calls.filter(c=>c.method==='groups.edit').length,1);f.setDescription('New owner edit');
 await assert.rejects(f.api.rollbackPreview('palitra-love',{revision:1,requestId:result.requestId}),errorCode('STATE_CHANGED'));
});

test('cover preview validates bytes, private storage and upload has no authorization or redirects',async t=>{
 const f=fixture(t),p=await f.preview({operation:'cover',description:undefined,image:{mime:'image/png',base64:PNG}});assert.equal(p.after.width,1);assert.ok(p.warnings.includes('COVER_RESTORE_REQUIRES_ORIGINAL'));assert.equal(f.uploads.length,0);
 assert.ok(!JSON.stringify(p).includes(PNG));const result=await f.apply(p);assert.equal(result.status,'verified');assert.equal(f.uploads.length,1);
 const {opts}=f.uploads[0];assert.equal(opts.redirect,'error');assert.equal(opts.headers,undefined);assert.ok(opts.body instanceof FormData);assert.equal(opts.body.get('photo').type,'image/png');
 assert.equal(opts.body.get('photo').size,Buffer.from(PNG,'base64').length);assert.ok(opts.signal instanceof AbortSignal);
 assert.ok(!JSON.stringify(f.api.history('palitra-love')).includes('FIXTURE_UPLOAD_HASH'));
 assert.equal(f.calls.find(c=>c.method==='photos.saveOwnerCoverPhoto').params.is_video_cover,0);
});

test('cover acceptance needs saved-image match in readback; scalar response is never success',async t=>{
 for(const mode of ['mismatch','scalar']){
  const f=fixture(t),p=await f.preview({operation:'cover',description:undefined,image:{mime:'image/png',base64:PNG}});
  f.setHandler(({method})=>({
   'groups.getById':{groups:[{id:12345,description:'Before',cover:{enabled:1,images:[oldImage]}}]},
   'photos.getOwnerCoverPhotoUploadServer':{upload_url:'https://pu.vk.com/upload'},
   'photos.saveOwnerCoverPhoto':mode==='scalar'?1:{images:[newImage]},
  })[method]);assert.equal((await f.apply(p)).status,mode==='scalar'?'uncertain':'applied_unverified');
 }
});

test('image and URL validation rejects malformed, oversized, arbitrary and private inputs',()=>{
 assert.equal(validateImage({mime:'image/png',base64:PNG}).width,1);
 for(const image of [{mime:'image/svg+xml',base64:PNG},{mime:'image/jpeg',base64:PNG},{mime:'image/png',base64:PNG+' '},{mime:'image/png',base64:'AA=='},{mime:'image/png',base64:'A'.repeat(12*1024*1024)}])assert.throws(()=>validateImage(image),errorCode('INVALID_IMAGE'));
 const bomb=Buffer.from(PNG,'base64');bomb.writeUInt32BE(100000,16);assert.throws(()=>validateImage({mime:'image/png',base64:bomb.toString('base64')}),errorCode('INVALID_IMAGE'));
 for(const url of ['http://pu.vk.com/upload','https://vk.com.evil.test/u','https://127.0.0.1/u','https://[::1]/u','https://localhost/u','https://u:p@pu.vk.com/u','https://pu.vk.com:8443/u','https://pu.vk.com/u#x','https://example.org/u'])assert.throws(()=>validateUploadUrl(url),errorCode('UNSAFE_UPLOAD_URL'));
 assert.equal(validateUploadUrl('https://pu.vk.com/u'),'https://pu.vk.com/u');
});

test('unsafe upload server and bounded/invalid upload reply cannot reach cover save',async t=>{
 for(const mode of ['host','large','invalid','redirect']){
  const f=fixture(t),p=await f.preview({operation:'cover',description:undefined,image:{mime:'image/png',base64:PNG}});
  f.setHandler(({method})=>method==='groups.getById'?{groups:[{id:12345,description:'Before',cover:{enabled:1,images:[oldImage]}}]}:{upload_url:mode==='host'?'https://127.0.0.1/u':'https://pu.vk.com/u'});
  f.setUploadHandler(()=>new Response(mode==='large'?'X'.repeat(2*1024*1024+1):mode==='invalid'?'{}':'redirect',{status:mode==='redirect'?302:200}));
  const result=await f.apply(p);assert.equal(result.status,'failed');assert.ok(!f.calls.some(c=>c.method==='photos.saveOwnerCoverPhoto'));assert.equal(f.uploads.length,mode==='host'?0:1);
 }
});

test('revision changes during read and between cover upload and save cannot mutate new binding',async t=>{
 const f=fixture(t);f.setHandler(()=>{f.settings.revision=2;return {groups:[{id:12345,description:'Before',cover:{enabled:1,images:[oldImage]}}]};});
 await assert.rejects(f.preview(),errorCode('SETTINGS_CHANGED'));assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vk_design_previews').get().n,0);
 const g=fixture(t),p=await g.preview({operation:'cover',description:undefined,image:{mime:'image/png',base64:PNG}});
 g.setUploadHandler(()=>{g.settings.revision=2;return new Response(JSON.stringify({hash:'h',photo:'p'}));});
 const result=await g.apply(p);assert.equal(result.status,'failed');assert.equal(result.code,'SETTINGS_CHANGED');assert.ok(!g.calls.some(c=>c.method==='photos.saveOwnerCoverPhoto'));
});

test('accepted write preserves unverified audit after connection changes mid mutation',async t=>{
 const f=fixture(t),p=await f.preview();f.setHandler(({method})=>{
  if(method==='groups.getById')return {groups:[{id:12345,description:'Before',cover:{enabled:1,images:[oldImage]}}]};
  f.settings.revision=2;return 1;
 });
 const result=await f.apply(p);assert.equal(result.status,'applied_unverified');assert.equal(result.code,'SETTINGS_CHANGED');assert.equal(f.api.history('palitra-love').items[0].revision,1);
});

test('another pending action for the same group is blocked and failed claim leaves no new journal row',async t=>{
 const f=fixture(t),p=await f.preview(),other=await f.preview({description:'Second'});let release;
 f.setHandler(({method})=>method==='groups.getById'?{groups:[{id:12345,description:'Before',cover:{enabled:1,images:[oldImage]}}]}:new Promise(resolve=>release=()=>resolve(1)));
 const pending=f.apply(p);while(!release)await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(f.apply(other,{requestId:'fixture_request_0002'}),errorCode('OPERATION_BUSY'));assert.equal(f.api.history('palitra-love').items.length,1);release();await pending;
});

test('upload deadline bounds a stuck fetch and never calls save',async t=>{
 const f=fixture(t),p=await f.preview({operation:'cover',description:undefined,image:{mime:'image/png',base64:PNG}});
 f.setUploadHandler(()=>new Promise(()=>{}));const api=createVkDesign(f.db,{...f.options,timeoutMs:20});
 const result=await api.apply('palitra-love',{revision:1,previewId:p.previewId,requestId:'fixture_request_0001'});
 assert.equal(result.status,'failed');assert.equal(result.code,'UPLOAD_FAILED');assert.ok(f.uploads[0].opts.signal.aborted);assert.ok(!f.calls.some(c=>c.method==='photos.saveOwnerCoverPhoto'));
});

test('no hidden assumptions for malformed state, empty description is explicit and expiration needs new preview',async t=>{
 const f=fixture(t);f.setHandler(()=>({groups:[{id:12345,cover:{enabled:0,images:[]}}]}));await assert.rejects(f.preview(),errorCode('RESPONSE_INVALID'));
 f.setHandler(()=>({groups:[{id:12345,description:'',cover:{enabled:0}}]}));const p=await f.preview({description:''});assert.equal(p.before,'');assert.equal(p.after,'');
 const expired=createVkDesign(f.db,{...f.options,now:()=>Date.parse('2026-10-04T13:00:00Z')});await assert.rejects(expired.apply('palitra-love',{revision:1,previewId:p.previewId,requestId:'fixture_request_0001'}),errorCode('PREVIEW_EXPIRED'));
});

test('JPEG header dimensions are bounded, scan data is required and PNG input does not recurse on large data',()=>{
 // Synthetic header fixture: SOI + baseline SOF + SOS + entropy + EOI; no media decoder is run by the module.
 const jpeg=Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0,1,0,2,1,1,0x11,0,0xff,0xda,0,8,1,1,0,0,63,0,0,0xff,0xd9]);
 const result=validateImage({mime:'image/jpeg',base64:jpeg.toString('base64')});assert.equal(result.width,2);assert.equal(result.height,1);
 const noScan=Buffer.concat([jpeg.subarray(0,15),Buffer.from([0xff,0xd9])]);assert.throws(()=>validateImage({mime:'image/jpeg',base64:noScan.toString('base64')}),errorCode('INVALID_IMAGE'));
 assert.throws(()=>validateImage({mime:'image/png',base64:Buffer.alloc(8*1024*1024).toString('base64')}),errorCode('INVALID_IMAGE'));
});

test('optional cover is unknown without blocking description and wrapped SDK upload response is accepted',async t=>{
 const f=fixture(t);f.setHandler(()=>({groups:[{id:12345,description:'Before'}]}));assert.equal((await f.api.getState('palitra-love')).cover,null);
 assert.equal((await f.preview()).before,'Before');await assert.rejects(f.preview({operation:'cover',description:undefined,image:{mime:'image/png',base64:PNG}}),errorCode('RESPONSE_INVALID'));
 const g=fixture(t),p=await g.preview({operation:'cover',description:undefined,image:{mime:'image/png',base64:PNG}});g.setUploadHandler(()=>new Response(JSON.stringify({response:{hash:'h',photo:'p'}})));
 assert.equal((await g.apply(p)).status,'verified');assert.equal(g.db.prepare('SELECT image_bytes FROM vk_design_previews').get().image_bytes,null);
});

test('active preview limit and expiry clean unused bytes without deleting action audit',async t=>{
 const f=fixture(t),applied=await f.preview();await f.apply(applied);
 for(let n=0;n<20;n++)await f.preview({description:String(n)});
 await assert.rejects(f.preview(),errorCode('PREVIEW_LIMIT'));assert.equal(f.api.history('palitra-love').items.length,1);
 const later=createVkDesign(f.db,{...f.options,now:()=>Date.parse('2026-10-04T13:00:00Z')});await later.preview('palitra-love',{revision:1,operation:'description',description:'New'});
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vk_design_previews').get().n,2);assert.equal(later.history('palitra-love').items[0].previewId,applied.previewId);
});

test('design composes with real direct connector and preserves forced group and token-free upload boundaries',async t=>{
 const {createVkDirect}=require('./vk-direct');const f=fixture(t);let description='Before',cover={enabled:1,images:[oldImage]};const calls=[];
 const fetchImpl=async(url,options)=>{
  const method=url.split('/').at(-1),params=Object.fromEntries(new URLSearchParams(options.body));calls.push({method,params});assert.equal(options.headers.Authorization,'Bearer SYNTHETIC_GROUP_TOKEN');
  if(!['groups.getTokenPermissions','photos.saveOwnerCoverPhoto'].includes(method))assert.equal(params.group_id,'12345');
  let response;
  if(method==='groups.getTokenPermissions')response={mask:1,permissions:[]};
  else if(method==='groups.getById')response={groups:[{id:12345,description,cover}]};
  else if(method==='groups.edit'){description=params.description;response=1;}
  else if(method==='photos.getOwnerCoverPhotoUploadServer'){assert.equal(params.is_video_cover,'0');response={upload_url:'https://pu.vk.com/u'};}
  else if(method==='photos.saveOwnerCoverPhoto'){assert.equal(params.group_id,undefined);assert.equal(params.photo,'photo');cover={enabled:1,images:[newImage]};response={images:[newImage]};}
  else throw new Error('Unexpected method');
  return new Response(JSON.stringify({response}));
 };
 const direct=createVkDirect(f.db,{apiKey:'SYNTHETIC_STORAGE_KEY',fetchImpl});direct.saveSettings('palitra-love','design',{revision:0,groupId:'12345',tokenType:'group',accessToken:'SYNTHETIC_GROUP_TOKEN'});
 assert.equal((await direct.checkConnection('palitra-love','design')).ok,true);
 const api=createVkDesign(f.db,{direct,fetchImpl:async(url,options)=>{assert.equal(options.headers,undefined);assert.equal(url,'https://pu.vk.com/u');return new Response(JSON.stringify({response:{hash:'hash',photo:'photo'}}));}});
 const text=await api.preview('PALITRA-LOVE',{revision:1,operation:'description',description:'New description'});
 assert.equal((await api.apply('palitra-love',{revision:1,previewId:text.previewId,requestId:'integration_description'})).status,'verified');
 const image=await api.preview('palitra-love',{revision:1,operation:'cover',image:{mime:'image/png',base64:PNG}});
 assert.equal((await api.apply('palitra-love',{revision:1,previewId:image.previewId,requestId:'integration_cover'})).status,'verified');
 assert.equal(calls.filter(c=>c.method==='groups.edit').length,1);assert.equal(calls.filter(c=>c.method==='photos.saveOwnerCoverPhoto').length,1);
});

test('ambiguous provider internal failure after mutation is uncertain and cannot dispatch a second time',async t=>{
 const f=fixture(t),p=await f.preview();f.setHandler(({method})=>{
  if(method==='groups.getById')return {groups:[{id:12345,description:'Before',cover:{enabled:1,images:[oldImage]}}]};
  f.setDescription('After');throw Object.assign(new Error('PRIVATE_PROVIDER_INTERNAL_FAILURE'),{code:'CONNECTION_UNCERTAIN',uncertain:true,ambiguous:true});
 });
 const result=await f.apply(p);assert.equal(result.status,'uncertain');assert.equal(result.code,'CONNECTION_UNCERTAIN');
 f.setHandler(null);assert.equal((await f.api.getState('palitra-love')).description,'After');
 assert.deepEqual(await f.apply(p),result);assert.deepEqual(await f.apply(p,{requestId:'different_request_0001'}),result);
 assert.equal(f.calls.filter(c=>c.method==='groups.edit').length,1);assert.ok(!JSON.stringify(f.api.history('palitra-love')).includes('PRIVATE_PROVIDER_INTERNAL_FAILURE'));
});
