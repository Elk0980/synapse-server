'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createContentFactoryContextHandler}=require('./content-factory-context-http');
function fixture({planningInsights=null}={}){
 const calls=[],actor={userId:5,allowed:true,role:'editor',permissions:new Set()};let onRead,previous=null;
 const handler=createContentFactoryContextHandler({generation:{create(...args){calls.push(['start',...args]);return {job:{id:'new'}};}},
  jobs:{lookupRequest(...args){calls.push(['lookup',...args]);return previous;}},planningInsights,
  companyModuleContext(req,code,permission){if(!actor.allowed||code!=='alpha'||permission!=='autoposting.edit')throw Object.assign(Error('Forbidden'),{status:403});return {company:{code},identity:actor};},
  readJson:async req=>{if(onRead)await onRead();return req.body;},send:(res,status,body,headers)=>Object.assign(res,{status,body,headers})});
 const call=async(path,body,method='POST')=>{const res={};return {handled:await handler({method,body},res,new URL('http://test'+path+'?companyCode=alpha')),res};};
 return {calls,actor,call,set onRead(value){onRead=value;},set previous(value){previous=value;}};
}
test('private context routes сохраняют body boundary и no-store; lookup не запускает генерацию',async()=>{
 const f=fixture(),request={month:'2026-10',clientRequestId:'context-request-1'};
 const lookup=await f.call('/internal/content-factory/plan-lookup',request);assert.deepEqual(lookup.res.body,{companyCode:'alpha',job:null});
 assert.deepEqual(f.calls,[['lookup','alpha',request.clientRequestId,request.month]]);
 const library={schemaVersion:1},start=await f.call('/internal/content-factory/plan-start',{request,sourceLibrary:library});
 assert.deepEqual(f.calls[1],['lookup','alpha',request.clientRequestId,request.month]);
 assert.deepEqual(f.calls[2],['start','alpha',request,library,null]);assert.equal(start.res.headers['cache-control'],'no-store');
});
test('private context не перехватывает другие маршруты, отвергает метод/лишние поля до вызова сервиса',async()=>{
 const f=fixture();assert.equal((await f.call('/media-mentor/generation',{})).handled,false);
 await assert.rejects(f.call('/internal/content-factory/plan-lookup',{},'GET'),{status:405});
 for(const body of [null,[],{}, {month:'2026-10',clientRequestId:'abcdefgh',snapshot:{}}])await assert.rejects(f.call('/internal/content-factory/plan-lookup',body),{status:400});
 for(const body of [{request:{},sourceLibrary:{}},{request:{month:'2026-10',clientRequestId:'abcdefgh',extra:1},sourceLibrary:{}}])await assert.rejects(f.call('/internal/content-factory/plan-start',body),{status:400});
 assert.deepEqual(f.calls,[]);
});
test('право private context повторно проверяется после async чтения',async()=>{
 const f=fixture();f.onRead=()=>{f.actor.allowed=false;};
 await assert.rejects(f.call('/internal/content-factory/plan-lookup',{month:'2026-10',clientRequestId:'abcdefgh'}),{status:403});assert.deepEqual(f.calls,[]);
});
test('статистика читается только owner/analytics.view и после раннего replay; browser не задаёт её',async()=>{
 const captured=[],context={schemaVersion:1},f=fixture({planningInsights:{capture:(...args)=>{captured.push(args);return context;}}});
 const body={request:{month:'2026-10',clientRequestId:'stats-context-1'},sourceLibrary:{schemaVersion:1}};
 await f.call('/internal/content-factory/plan-start',body);assert.deepEqual(captured,[]);assert.equal(f.calls.at(-1)[4],null);
 f.actor.permissions.add('analytics.view');await f.call('/internal/content-factory/plan-start',body);
 assert.deepEqual(captured,[['alpha','2026-10']]);assert.equal(f.calls.at(-1)[4],context);
 const original={companyCode:'alpha',job:{id:'original'}};f.previous=original;
 const replay=await f.call('/internal/content-factory/plan-start',body);assert.deepEqual(replay.res.body,original);
 assert.equal(captured.length,1);assert.equal(f.calls.at(-1)[0],'lookup');
 f.previous=null;f.actor.permissions.clear();f.actor.role='owner';await f.call('/internal/content-factory/plan-start',body);assert.equal(captured.length,2);
 await assert.rejects(f.call('/internal/content-factory/plan-start',{...body,planningInsights:context}),{status:400});
});
