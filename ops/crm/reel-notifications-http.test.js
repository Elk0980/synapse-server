'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createReelMaterialsHandler}=require('./reel-materials-http');
test('notifications HTTP: сервисный feed закрыт браузеру, read требует текущее право и не доверяет автору из тела',async t=>{
 let calls=[],permitted=true,reads=0;
 const fail=status=>{throw Object.assign(Error('SAMPLE'),{status});};
 const handler=createReelMaterialsHandler({
  trustedService:req=>req.headers['x-api-key']==='SAMPLE'&&!req.headers['x-synapse-crm-identity'],
  companyModuleContext(req,code){if(!permitted)fail(403);if(code!=='avokado')fail(404);return {company:{code},identity:{userId:7}};},
  materials:{notificationFeed:(...args)=>{calls.push(['feed',...args]);return {events:[]};},
   unreadNotifications:(...args)=>{calls.push(['unread',...args]);return {count:1};},
   readNotifications:(...args)=>{calls.push(['read',...args]);return {count:0};}},
  readJson:async()=>{reads++;if(reads===2)permitted=false;return {throughId:1};},
  send:(res,status,body,headers)=>{res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(body));}});
 const server=http.createServer(async(req,res)=>{try{await handler(req,res,new URL(req.url,'http://local'));}catch(e){res.writeHead(e.status||500);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const call=(path,options)=>fetch(`http://127.0.0.1:${server.address().port}${path}`,options);
 assert.equal((await call('/internal/reel-materials/notifications')).status,403);
 assert.equal((await call('/internal/reel-materials/notifications',{headers:{'x-api-key':'SAMPLE','x-synapse-crm-identity':'SAMPLE'}})).status,403);
 assert.equal((await call('/internal/reel-materials/notifications?after=3&limit=50',{headers:{'x-api-key':'SAMPLE'}})).status,200);
 assert.deepEqual(calls.pop(),['feed',3,50]);
 const route='/autoposting/reels/21/notifications/read?companyCode=avokado';
 assert.equal((await call(route,{method:'POST'})).status,200);assert.equal(calls.at(-1)[4].userId,7);
 assert.equal((await call(route,{method:'POST'})).status,403);assert.equal(calls.filter(c=>c[0]==='read').length,1);
 permitted=false;assert.equal((await call('/autoposting/reels/notifications?companyCode=avokado')).status,403);
});
