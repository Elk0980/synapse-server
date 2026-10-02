'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createContentFactoryCompletionHandler}=require('./content-factory-completion-http');
function fixture({revoke=false,changeUser=false}={}){
 let contexts=0,mutations=0,sent=null;const calls=[];
 const handle=createContentFactoryCompletionHandler({autoposting:{history:(...args)=>{calls.push(args);return {items:[]};},createVariant:(...args)=>{mutations++;calls.push(args);return {created:true,post:{id:2}};}},
 companyModuleContext:(request,code,permission)=>{contexts++;if(revoke&&contexts>1)throw Object.assign(Error('Forbidden'),{status:403});assert.equal(code,'alpha');
 calls.push(permission);return {company:{code:'alpha'},identity:{userId:changeUser&&contexts>1?2:1,userName:'Owner'}};},
 readJson:async()=>({revision:1,clientRequestId:'key',platformId:'telegram'}),send:(res,status,body,headers)=>{sent={status,body,headers};}});
 return {run:(method,path)=>handle({method},{},new URL('http://localhost'+path)),get contexts(){return contexts;},get mutations(){return mutations;},get sent(){return sent;},calls};
}
test('history чистое view/cursor, no-store; unrelated route не захватывается',async()=>{
 const f=fixture();assert.equal(await f.run('GET','/else'),false);assert.equal(f.contexts,0);
 await f.run('GET','/autoposting/posts/1/history?companyCode=alpha&before=32&limit=10');
 assert.deepEqual(f.calls,['autoposting.view',[1,'alpha',{before:32,limit:10}]]);assert.equal(f.mutations,0);assert.equal(f.sent.headers['cache-control'],'no-store');
});
test('variants доверенный scope/actor и свежая проверка после body',async()=>{
 const f=fixture();await f.run('POST','/autoposting/posts/1/variants?companyCode=alpha');
 assert.equal(f.contexts,2);assert.equal(f.mutations,1);assert.equal(f.sent.status,201);
 assert.deepEqual(f.calls.at(-1),[1,'alpha',{revision:1,clientRequestId:'key',platformId:'telegram'},{userId:1,userName:'Owner'}]);
 for(const opts of [{revoke:true},{changeUser:true}]){const denied=fixture(opts);await assert.rejects(denied.run('POST','/autoposting/posts/1/variants?companyCode=alpha'),e=>e.status===403);assert.equal(denied.mutations,0);}
});
test('неверные методы/курсор/размер/id не доходят до операции',async()=>{
 for(const [method,path,status] of [['POST','history',405],['GET','variants',405],['GET','history?before=0',400],['GET','history?limit=2.5',400],['GET','history?before=9007199254740992',400]]){
 const f=fixture(),q=path.includes('?')?'&':'?';await assert.rejects(f.run(method,`/autoposting/posts/1/${path}${q}companyCode=alpha`),e=>e.status===status);assert.equal(f.mutations,0);assert.ok(!f.calls.some(Array.isArray));}
 const f=fixture();await assert.rejects(f.run('GET','/autoposting/posts/9007199254740992/history?companyCode=alpha'),e=>e.status===404);assert.equal(f.contexts,0);
});
