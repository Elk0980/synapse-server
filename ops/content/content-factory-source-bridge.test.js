'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Readable}=require('node:stream'),{DatabaseSync}=require('node:sqlite');
const {createTelegramSources}=require('./telegram-sources'),{createContentFactorySourceBridge}=require('./content-factory-source-bridge');
const {createCompanyInformation}=require('../crm/company-information'),{createAutoposting}=require('../crm/autoposting');
const {createContentFactorySourceHandler}=require('../crm/content-factory-source-http');
const fail=status=>{throw Object.assign(Error('fixture guard'),{status});},ORIGIN='https://publishing.fixture.test',BOUNDARY='bridge-source-fixture';
const HEADS={'image/png':Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(24)]),'image/jpeg':Buffer.from([255,216,255,224]),
  'video/mp4':Buffer.concat([Buffer.from([0,0,0,20]),Buffer.from('ftypisom'),Buffer.alloc(20)]),'video/quicktime':Buffer.concat([Buffer.from([0,0,0,20]),Buffer.from('ftypqt  '),Buffer.alloc(20)]),'application/pdf':Buffer.from('%PDF-1.7')};
function fixture(t,bridgeOptions={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'source-bridge-')),assetsDir=path.join(dir,'assets'),db=new DatabaseSync(path.join(dir,'content.sqlite')),crmDb=new DatabaseSync(path.join(dir,'crm.sqlite'));
  t.after(()=>{db.close();crmDb.close();fs.rmSync(dir,{recursive:true,force:true});});
  const users={1:{id:1,displayName:'Владелец',role:'owner',sessionVersion:1},2:{id:2,displayName:'Редактор',role:'member',sessionVersion:1,companyCodes:['palitra-love'],permissions:['autoposting.view','autoposting.edit']},
    3:{id:3,role:'member',sessionVersion:1,companyCodes:['palitra-love'],permissions:['autoposting.view']},4:{id:4,role:'member',sessionVersion:1,companyCodes:['alvi'],permissions:['autoposting.view','autoposting.edit']},
    5:{id:5,role:'member',sessionVersion:1,companyCodes:['palitra-love'],permissions:['autoposting.edit']}};
  const requireSession=req=>{if(!req.actor)fail(401);return {user:{id:req.actor,sessionVersion:1}};},requireCsrf=req=>{if(req.headers?.['x-csrf-token']!=='csrf')fail(403);};
  const sendJson=(res,status,body,headers)=>Object.assign(res,{status,body,headers}),authStore={getById:id=>users[id]};
  const library=createTelegramSources({db,assetsDir,authStore,requireSession,requireCsrf,sendJson});
  crmDb.exec(`PRAGMA foreign_keys=ON;CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'palitra-love','Palitra','UTC','[]'),(2,'alvi','Alvi','UTC','[]');`);
  const information=createCompanyInformation(crmDb),transport={getSettings:()=>({channels:[]}),publish:()=>{throw Error('Внешний вызов запрещён');}};
  let autoposting=createAutoposting(crmDb,{information,transport}),bridge,crmCalls=[],readHook,crmHook,loseResponse=false,crmReady=true;
  const handler=createContentFactorySourceHandler({autoposting:{attachSource:(...args)=>autoposting.attachSource(...args),lookupSourceAttachment:(...args)=>autoposting.lookupSourceAttachment(...args),sourceUsage:(...args)=>autoposting.sourceUsage(...args)},
    companyModuleContext:(req,code,permission)=>{const identity=req.trustedIdentity;if(!identity||identity.role!=='owner'&&!identity.permissions.has(permission))fail(403);
      if(identity.role!=='owner'&&!identity.companyCodes.has(code))fail(403);const company=crmDb.prepare('SELECT code FROM companies WHERE code=?').get(code);if(!company)fail(404);return {identity,company};},
    readJson:async req=>req.body,send:sendJson});
  const crmCall=async(action,code,body,user)=>{
    crmCalls.push({action,code,body:structuredClone(body),userId:user.id});if(crmHook)await crmHook();
    const identity={userId:user.id,userName:user.displayName||'#'+user.id,role:user.role==='owner'?'owner':'editor',permissions:new Set(user.permissions||[]),companyCodes:new Set(user.companyCodes||[])};
    const response={};await handler({method:'POST',body,trustedIdentity:identity},response,new URL('http://synthetic/internal/content-factory/'+action+'?companyCode='+code));
    if(loseResponse){loseResponse=false;fail(503);}return response.body;
  };
  function restartBridge(){bridge=createContentFactorySourceBridge({db,assetsDir,authStore,requireSession,requireCsrf,readJson:async req=>{if(readHook)await readHook();return req.body;},sendJson,crmCall,ready:()=>crmReady,publishingOrigin:ORIGIN,...bridgeOptions});}
  restartBridge();
  async function call(item,body,{actor=2,csrf='csrf',code=item.companyCode,action='attach',method=action==='attach'?'POST':'GET',id=item.id}={}){
    const req={method,actor,body,headers:{'x-csrf-token':csrf}},res={};const handled=await bridge.handle(req,res,new URL(`http://fixture/content/telegram-sources/${code}/${id}/${action}`));return {handled,...res};
  }
  async function upload({mime='image/png',state='source',code='palitra-love',marker=0,size=128}={}){
    const head=HEADS[mime],bytes=Buffer.concat([head,Buffer.alloc(Math.max(0,size-head.length),marker)]),name='source.'+({'image/png':'png','image/jpeg':'jpg','video/mp4':'mp4','video/quicktime':'mov','application/pdf':'pdf'}[mime]);
    const metadata=JSON.stringify({materialState:state}),req=Readable.from([Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${metadata}\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`),bytes,Buffer.from(`\r\n--${BOUNDARY}--\r\n`)]);
    req.method='POST';req.actor=1;req.headers={'content-type':`multipart/form-data; boundary=${BOUNDARY}`,'x-csrf-token':'csrf'};const res={};await library.handle(req,res,new URL(`http://fixture/content/telegram-sources/${code}/upload`));return res.body.item;
  }
  async function markReady(item){const req=Readable.from([Buffer.from(JSON.stringify({revision:item.revision,metadata:{materialState:'ready'}}))]);req.method='PATCH';req.actor=2;req.headers={'content-type':'application/json','x-csrf-token':'csrf'};const res={};await library.handle(req,res,new URL(`http://fixture/content/telegram-sources/${item.companyCode}/${item.id}/metadata`));return res.body.item;}
  return {dir,db,crmDb,assetsDir,users,upload,markReady,call,get api(){return autoposting;},get crmCalls(){return crmCalls;},
    get readHook(){return readHook;},set readHook(value){readHook=value;},set crmHook(value){crmHook=value;},set loseResponse(value){loseResponse=value;},set crmReady(value){crmReady=value;},
    copies(code='palitra-love'){const target=path.join(assetsDir,'publishing',code);return fs.existsSync(target)?fs.readdirSync(target):[];},
    restart(){autoposting=createAutoposting(crmDb,{information,transport});restartBridge();},
    draft(code='palitra-love'){return autoposting.create(code,{title:'Прежняя карточка',text:'Текст',mediaUrls:[],platformIds:[],scheduledAt:null},2);}};
}
const newTarget=(item,key='bridge-new-request-1')=>({clientRequestId:key,sourceRevision:item.revision,newPost:{title:'Материал',text:'Подпись',format:'post',ovpRole:'reach'}});
test('private source → ready → проверенная детерминированная publishing копия → CRM draft и usage',async t=>{
  const f=fixture(t),raw=await f.upload();await assert.rejects(f.call(raw,newTarget(raw)),{status:409});assert.deepEqual(f.copies(),[]);assert.equal(f.crmCalls.length,0);
  const item=await f.markReady(raw),result=await f.call(item,newTarget(item));assert.equal(result.handled,true);assert.equal(result.status,200);assert.equal(result.headers['cache-control'],'no-store');
  const name=item.sha256.slice(0,32)+'.png',url=ORIGIN+'/content/publishing-assets/palitra-love/'+name;
  assert.deepEqual(f.copies(),[name]);const privateBytes=fs.readFileSync(path.join(f.assetsDir,'telegram-sources','palitra-love',item.sha256)),copy=fs.readFileSync(path.join(f.assetsDir,'publishing','palitra-love',name));assert.deepEqual(copy,privateBytes);
  assert.equal(crypto.createHash('sha256').update(copy).digest('hex'),item.sha256);assert.equal(result.body.post.status,'draft');assert.equal(result.body.post.scheduledAt,null);assert.equal(result.body.post.approval.approved,false);assert.deepEqual(result.body.post.mediaUrls,[url]);
  assert.deepEqual(f.crmCalls[0],{action:'source-attach',code:'palitra-love',userId:2,body:{clientRequestId:'bridge-new-request-1',newPost:newTarget(item).newPost,source:{id:item.id,revision:2,sha256:item.sha256,url}}});
  assert.ok(!Object.hasOwn(f.crmCalls[0].body,'sourceRevision'));assert.equal(result.body.link.sourceRevision,2);assert.equal(result.body.link.sourceId,item.id);
  const usage=await f.call(item,undefined,{actor:3,action:'usage'});assert.equal(usage.status,200);assert.equal(usage.body.usages[0].current,true);assert.equal(usage.body.usages[0].post.id,result.body.post.id);
  assert.deepEqual(f.crmCalls[1].body,{sourceId:item.id});assert.equal(f.crmCalls[1].userId,3);
});
test('существующая карточка получает exact target; usage показывает историческую связь и архив',async t=>{
  const f=fixture(t),item=await f.upload({state:'ready'}),post=f.draft(),body={clientRequestId:'bridge-existing-1',sourceRevision:1,postId:post.id,revision:post.revision};
  const attached=(await f.call(item,body)).body;assert.equal(attached.post.id,post.id);assert.equal(attached.post.title,'Прежняя карточка');assert.equal(f.crmCalls[0].body.postId,post.id);assert.equal(f.crmCalls[0].body.revision,post.revision);assert.ok(!Object.hasOwn(f.crmCalls[0].body,'newPost'));
  const changed=f.api.update(post.id,'palitra-love',{revision:attached.post.revision,title:'Ручная правка',mediaUrls:['https://fixture.test/new.png']},{userId:2});
  const archived=f.api.archive(post.id,'palitra-love',{revision:changed.revision},{userId:2});
  const usage=(await f.call(item,undefined,{action:'usage',actor:3})).body.usages[0];assert.equal(usage.current,false);assert.equal(usage.post.title,'Ручная правка');assert.equal(usage.post.archivedAt,archived.archive.archivedAt);
});
test('stored/ready/MOV/PDF/size/magic/SHA/revision проверяются до CRM и public копии',async t=>{
  const f=fixture(t,{maxImageBytes:160,maxVideoBytes:160});
  for(const mime of ['video/quicktime','application/pdf']){const item=await f.upload({mime,state:'ready'});await assert.rejects(f.call(item,newTarget(item)),{status:415});}
  const large=await f.upload({size:180,state:'ready'});await assert.rejects(f.call(large,newTarget(large)),{status:413});
  const item=await f.upload({state:'ready',marker:2});await assert.rejects(f.call(item,{...newTarget(item),sourceRevision:2}),{status:409});
  f.db.prepare("UPDATE telegram_source_items SET status='manual_import' WHERE id=?").run(item.id);await assert.rejects(f.call(item,newTarget(item)),{status:409});f.db.prepare("UPDATE telegram_source_items SET status='stored' WHERE id=?").run(item.id);
  const file=path.join(f.assetsDir,'telegram-sources','palitra-love',item.sha256),bytes=fs.readFileSync(file);fs.writeFileSync(file,Buffer.alloc(bytes.length));await assert.rejects(f.call(item,newTarget(item)),{status:415});
  const changed=Buffer.from(bytes);changed[changed.length-1]^=1;fs.writeFileSync(file,changed);await assert.rejects(f.call(item,newTarget(item)),{status:409});fs.rmSync(file);await assert.rejects(f.call(item,newTarget(item)),{status:404});
  assert.ok(f.crmCalls.every(call=>call.action==='source-attach-lookup'));assert.deepEqual(f.copies(),[]);
});
test('company/view/edit/session/CSRF и свежая auth после async защищают attach/usage',async t=>{
  const f=fixture(t),item=await f.upload({state:'ready'});
  for(const [options,status]of [[{actor:null},401],[{actor:3},403],[{actor:4},403],[{actor:5},403],[{csrf:''},403],[{code:'alvi',actor:1},404],[{method:'GET'},405]])await assert.rejects(f.call(item,newTarget(item),options),{status});
  const other=await f.upload({state:'ready',code:'alvi'});await assert.rejects(f.call(other,undefined,{action:'usage',actor:2}),{status:403});
  assert.equal((await f.call(item,undefined,{action:'usage',actor:3,csrf:''})).status,200);
  f.readHook=()=>{f.users[2].permissions=['autoposting.view'];};await assert.rejects(f.call(item,newTarget(item)),{status:403});f.users[2].permissions.push('autoposting.edit');
  f.readHook=()=>{f.users[2].sessionVersion=2;};await assert.rejects(f.call(item,newTarget(item)),{status:401});f.users[2].sessionVersion=1;f.readHook=undefined;
  assert.ok(f.crmCalls.every(call=>call.action==='source-usage'));assert.deepEqual(f.copies(),[]);
});
test('недоступная CRM, raw/not-ready и неверный клиентский target не создают publishing файл',async t=>{
  const f=fixture(t),item=await f.upload({state:'ready'});f.crmReady=false;await assert.rejects(f.call(item,newTarget(item)),{status:503});assert.equal(f.crmCalls.length,0);assert.deepEqual(f.copies(),[]);f.crmReady=true;
  for(const body of [null,[],{}, {sourceRevision:1,clientRequestId:'x',newPost:{}}, {sourceRevision:1,clientRequestId:'valid-request-1'},
    {sourceRevision:1,clientRequestId:'valid-request-1',postId:1}, {sourceRevision:1,clientRequestId:'valid-request-1',postId:1,revision:1,newPost:{}},
    {sourceRevision:1,clientRequestId:'valid-request-1',newPost:{},source:{url:'https://evil.test/private'}},
    {sourceRevision:1,clientRequestId:'valid-request-1',newPost:{format:'unknown'}}]){
    await assert.rejects(f.call(item,body),{status:400});assert.deepEqual(f.copies(),[]);assert.equal(f.crmCalls.length,0);
  }
});
test('потеря CRM ответа и restart: один commit, одна publishing копия; повреждённая копия отвергается',async t=>{
  const f=fixture(t),item=await f.upload({state:'ready',mime:'video/mp4'}),body=newTarget(item,'retry-request-1');f.loseResponse=true;await assert.rejects(f.call(item,body),{status:503});
  assert.equal(f.crmDb.prepare('SELECT count(*) n FROM autoposting_posts').get().n,1);const files=f.copies();assert.equal(files.length,1);f.restart();
  const retry=await f.call(item,body);assert.equal(retry.body.duplicate,true);assert.equal(f.crmDb.prepare('SELECT count(*) n FROM autoposting_posts').get().n,1);assert.equal(f.crmDb.prepare('SELECT count(*) n FROM autoposting_source_links').get().n,1);assert.deepEqual(f.copies(),files);
  fs.writeFileSync(path.join(f.assetsDir,'publishing','palitra-love',files[0]),'tampered');await assert.rejects(f.call(item,body),{status:409});assert.equal(f.crmCalls.length,2);
});
test('lost response после commit и правка только metadata: чистый replay возвращает original без нового файла/карточки',async t=>{
 const f=fixture(t),item=await f.upload({state:'ready'}),body=newTarget(item,'metadata-recovery-request');f.loseResponse=true;
 await assert.rejects(f.call(item,body),{status:503});const original=JSON.parse(f.crmDb.prepare('SELECT result FROM autoposting_source_links').get().result);
 const changed=f.api.update(original.post.id,'palitra-love',{revision:original.post.revision,title:'Новая ручная правка'},{userId:2});
 f.db.prepare("UPDATE telegram_source_items SET revision=revision+1,metadata='{}' WHERE id=?").run(item.id);f.restart();
 const before=f.crmDb.prepare('SELECT total_changes() n').get().n,files=f.copies();
 const replay=await f.call(item,body);assert.deepEqual(replay.body,{...original,duplicate:true});assert.equal(f.crmCalls.at(-1).action,'source-attach-lookup');
 assert.equal(f.crmDb.prepare('SELECT total_changes() n').get().n,before);assert.deepEqual(f.copies(),files);assert.equal(f.api.get(changed.id,'palitra-love').title,'Новая ручная правка');
 await assert.rejects(f.call(item,{...body,clientRequestId:'stale-new-request'}),{status:409});assert.equal(f.crmDb.prepare('SELECT count(*) n FROM autoposting_posts').get().n,1);
 await assert.rejects(f.call(item,{...body,newPost:{...body.newPost,title:'Другие данные'}}),{status:409});
 f.crmHook=()=>{f.users[2].permissions=['autoposting.view'];};await assert.rejects(f.call(item,body),{status:403});
});
