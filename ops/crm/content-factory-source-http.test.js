'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createContentFactorySourceHandler}=require('./content-factory-source-http');
const fail=(status)=>{throw Object.assign(Error('fixture guard'),{status});};
function fixture(){
  const calls=[],contexts=[],companies={'palitra-love':{code:'palitra-love'},alvi:{code:'alvi'}},identity={userId:7,userName:'Редактор',role:'editor',permissions:new Set(['autoposting.view','autoposting.edit']),companyCodes:new Set(['palitra-love'])};
  let reads=0,onRead,lookupReceipt={companyCode:'palitra-love',duplicate:true,post:{id:22},link:{id:1}};
  const companyModuleContext=(req,code,permission)=>{
    contexts.push({code,permission});const actor=req.trustedIdentity;
    if(!actor||actor.role!=='owner'&&!actor.permissions.has(permission))fail(403);
    if(typeof code!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code))fail(400);
    if(actor.role!=='owner'&&!actor.companyCodes.has(code.toLowerCase()))fail(403);
    const company=companies[code.toLowerCase()];if(!company)fail(404);return {identity:actor,company};
  };
  const autoposting={attachSource:async(...args)=>{calls.push({action:'attach',args});return {post:{id:22},duplicate:false};},
    lookupSourceAttachment:async(...args)=>{calls.push({action:'lookup',args});return lookupReceipt;},sourceUsage:async(...args)=>{calls.push({action:'usage',args});return {usages:[{postId:22,current:true}]};}};
  const handle=createContentFactorySourceHandler({autoposting,companyModuleContext,readJson:async req=>{reads++;if(onRead)await onRead(req);return req.body;},send:(res,status,body,headers)=>Object.assign(res,{status,body,headers})});
  async function call({action='source-attach',method='POST',code='palitra-love',body={},actor=identity,pathname}={}){
    const req={method,body,trustedIdentity:actor},res={},url=new URL('http://fixture'+(pathname||'/internal/content-factory/'+action));if(code!==undefined&&code!==null)url.searchParams.set('companyCode',code);
    return {handled:await handle(req,res,url),res};
  }
  return {call,calls,contexts,identity,companyModuleContext,set onRead(value){onRead=value;},set lookupReceipt(value){lookupReceipt=value;},get reads(){return reads;}};
}

test('CF18: lookup возвращает receipt/null в company envelope, edit дважды и no-store, без attach',async()=>{
 const f=fixture(),body={clientRequestId:'request-lookup-1',source:{id:1,revision:2,sha256:'a'.repeat(64),url:'https://example.test/content/publishing-assets/palitra-love/'+ '1'.repeat(32)+'.mp4'},postId:22,revision:3};
 const first=await f.call({action:'source-attach-lookup',code:'PALITRA-LOVE',body});
 assert.deepEqual(first.res.body,{companyCode:'palitra-love',receipt:{companyCode:'palitra-love',duplicate:true,post:{id:22},link:{id:1}}});
 assert.equal(first.res.headers['cache-control'],'no-store');assert.deepEqual(f.calls,[{action:'lookup',args:['palitra-love',body]}]);
 assert.deepEqual(f.contexts,[{code:'PALITRA-LOVE',permission:'autoposting.edit'},{code:'PALITRA-LOVE',permission:'autoposting.edit'}]);
 f.lookupReceipt=null;assert.deepEqual((await f.call({action:'source-attach-lookup',body})).res.body,{companyCode:'palitra-love',receipt:null});
 assert.ok(f.calls.every(item=>item.action==='lookup'));
});

test('CF18: lookup exact POST и identity/company/edit guards до чтения, fresh отказ после read',async()=>{
 const f=fixture(),action='source-attach-lookup';
 for(const pathname of ['/internal/content-factory/source-attach-lookup/','/internal/content-factory/source-attach-lookup/x','/autoposting/source-attach-lookup'])assert.equal((await f.call({pathname})).handled,false);
 for(const method of ['GET','HEAD','PATCH','DELETE'])await assert.rejects(f.call({action,method}),{status:405});
 await assert.rejects(f.call({action,actor:null}),{status:403});await assert.rejects(f.call({action,code:'alvi'}),{status:403});
 for(const code of [null,'','bad/code'])await assert.rejects(f.call({action,code}),{status:400});
 f.identity.permissions.delete('autoposting.edit');await assert.rejects(f.call({action}),{status:403});assert.equal(f.reads,0);assert.deepEqual(f.calls,[]);
 f.identity.permissions.add('autoposting.edit');f.onRead=()=>f.identity.permissions.delete('autoposting.edit');await assert.rejects(f.call({action}),{status:403});
 f.identity.permissions.add('autoposting.edit');f.onRead=req=>{req.trustedIdentity={...f.identity,userId:8};};await assert.rejects(f.call({action}),{status:403});
 f.onRead=req=>{req.trustedIdentity={...f.identity,companyCodes:new Set(['alvi'])};};await assert.rejects(f.call({action}),{status:403});
 assert.deepEqual(f.calls,[]);
});

test('CF18: реальный CRM lookup нормализует полный body и сохраняет conflict/company/body ошибки без записи',async t=>{
 const {DatabaseSync}=require('node:sqlite'),{createCompanyInformation}=require('./company-information'),{createAutoposting}=require('./autoposting');
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
   INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'palitra-love','Fixture','UTC','[]'),(2,'alvi','Fixture2','UTC','[]')`);
 const api=createAutoposting(db,{information:createCompanyInformation(db),transport:{getSettings:()=>({channels:[]}),publish(){throw Error('Сеть запрещена');}}});
 const f=fixture(),body={clientRequestId:'real-lookup-body-1',source:{id:1,revision:1,sha256:'a'.repeat(64),url:'https://example.test/content/publishing-assets/palitra-love/'+ '1'.repeat(32)+'.mp4'},newPost:{title:'Fixture'}};
 const original=api.attachSource('palitra-love',body,f.identity),before=db.prepare('SELECT total_changes() n').get().n;
 const handle=createContentFactorySourceHandler({autoposting:api,companyModuleContext:f.companyModuleContext,readJson:async req=>req.body,send:(res,status,data,headers)=>Object.assign(res,{status,body:data,headers})});
 const request=async(value,code='palitra-love',actor=f.identity)=>{const res={};await handle({method:'POST',trustedIdentity:actor,body:value},res,new URL('http://fixture/internal/content-factory/source-attach-lookup?companyCode='+code));return res;};
 assert.deepEqual((await request(body)).body,{companyCode:'palitra-love',receipt:{...original,duplicate:true}});
 assert.deepEqual((await request({...body,clientRequestId:'real-no-receipt-1'})).body,{companyCode:'palitra-love',receipt:null});
 await assert.rejects(request({...body,source:{...body.source,revision:2}}),e=>e.status===409&&e.details.code==='REQUEST_CONFLICT');
 for(const invalid of [null,[],{}, {...body,userId:999},{...body,source:{...body.source,companyCode:'alvi'}}])await assert.rejects(request(invalid),{status:400});
 await assert.rejects(request(body,'alvi'),{status:403});
 const owner={userId:1,role:'owner',permissions:new Set(),companyCodes:new Set()};
 assert.deepEqual((await request({...body,source:{...body.source,url:body.source.url.replace('/palitra-love/','/alvi/')}},'alvi',owner)).body,{companyCode:'alvi',receipt:null});
 assert.equal(db.prepare('SELECT total_changes() n').get().n,before);assert.equal(db.prepare('SELECT count(*) n FROM autoposting_posts').get().n,1);
});
test('CRM attach передаёт company/body и только trusted identity; ответ no-store',async()=>{
  const f=fixture(),body={clientRequestId:'request-key-123',source:{id:1,revision:2,sha256:'a'.repeat(64),url:'https://fixture.test/file.png'},postId:22,revision:3,userId:999,role:'owner'};
  const result=await f.call({code:'PALITRA-LOVE',body});assert.equal(result.handled,true);assert.equal(result.res.status,200);assert.equal(result.res.headers['cache-control'],'no-store');
  assert.deepEqual(f.calls[0].args,[ 'palitra-love',body,f.identity ]);assert.equal(f.calls[0].args[2].userId,7);
  assert.deepEqual(f.contexts,[{code:'PALITRA-LOVE',permission:'autoposting.edit'},{code:'PALITRA-LOVE',permission:'autoposting.edit'}]);
});
test('CRM usage — строго {sourceId}, view и прочтение без attach',async()=>{
  const f=fixture();f.identity.permissions.delete('autoposting.edit');const result=await f.call({action:'source-usage',body:{sourceId:14}});
  assert.equal(result.handled,true);assert.deepEqual(result.res.body,{usages:[{postId:22,current:true}]});assert.deepEqual(f.calls,[{action:'usage',args:['palitra-love',14]}]);
  assert.ok(f.contexts.every(item=>item.permission==='autoposting.view'));
  for(const body of [{sourceId:0},{sourceId:-1},{sourceId:1.2},{sourceId:'1'},{sourceId:Number.MAX_SAFE_INTEGER+1},{sourceId:1,companyCode:'alvi'},null,[],{}])await assert.rejects(f.call({action:'source-usage',body}),{status:400});
  assert.equal(f.calls.length,1);
});
test('exact routes и POST: посторонний path не перехватывается; method не читает body',async()=>{
  const f=fixture();for(const pathname of ['/autoposting/source-attach','/internal/content-factory/source-attach/','/internal/content-factory/source-usage/x'])assert.equal((await f.call({pathname})).handled,false);
  for(const action of ['source-attach','source-usage'])for(const method of ['GET','PUT','PATCH','DELETE','HEAD'])await assert.rejects(f.call({action,method}),{status:405});
  assert.equal(f.reads,0);assert.deepEqual(f.calls,[]);assert.deepEqual(f.contexts,[]);
});
test('identity/permission/company guards выполняются перед чтением и записью',async()=>{
  const f=fixture();await assert.rejects(f.call({actor:null}),{status:403});await assert.rejects(f.call({code:'alvi'}),{status:403});
  for(const code of [null,'','bad/code'])await assert.rejects(f.call({code}),{status:400});
  f.identity.permissions.delete('autoposting.edit');await assert.rejects(f.call(),{status:403});assert.equal(f.reads,0);assert.deepEqual(f.calls,[]);
  const owner={userId:1,role:'owner',permissions:new Set(),companyCodes:new Set()};assert.equal((await f.call({actor:owner,code:'alvi'})).res.status,200);
  await assert.rejects(f.call({actor:owner,code:'missing'}),{status:404});
});
test('после async чтения повторяются context и trusted actor; отказ не вызывает autoposting',async()=>{
  const f=fixture();f.onRead=()=>{f.identity.permissions.delete('autoposting.edit');};await assert.rejects(f.call(),{status:403});assert.deepEqual(f.calls,[]);
  f.identity.permissions.add('autoposting.edit');f.onRead=req=>{req.trustedIdentity={...f.identity,userId:8};};await assert.rejects(f.call(),{status:403});assert.deepEqual(f.calls,[]);
  f.onRead=undefined;for(const body of [null,[],1])await assert.rejects(f.call({body}),{status:400});
});
