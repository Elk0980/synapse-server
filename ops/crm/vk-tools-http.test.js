'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createVkToolsHandler}=require('./vk-tools-http');
function fixture(){
 const calls=[],responses=[];let reads=0,changed=false;
 const direct={getSettings:(code,purpose)=>({companyCode:code,purpose,revision:3}),
 saveSettings:(code,purpose,body)=>{calls.push({method:'save',code,purpose,body});return{companyCode:code,purpose,revision:4};},
 checkConnection:async(code,purpose)=>{calls.push({method:'check',code,purpose});return{companyCode:code,purpose,revision:3};}};
 const design=Object.fromEntries(['getState','preview','apply','history','rollbackPreview'].map(method=>[method,(code,body)=>{calls.push({method,code,body});return{companyCode:code,operation:method};}]));
 const materials=Object.fromEntries(['listAlbums','preview','apply','history'].map(method=>[method,(code,body)=>{calls.push({method:'materials.'+method,code,body});return{companyCode:code,operation:method};}]));
 const avatar=Object.fromEntries(['preview','apply','history'].map(method=>[method,(code,body)=>{calls.push({method:'avatar.'+method,code,body});return{companyCode:code,operation:method};}]));
 const handle=createVkToolsHandler({direct,design,materials,avatar,companyModuleContext(req,code){
   if(!req.identity||req.identity.role!=='owner'||changed)throw Object.assign(Error('Denied'),{status:403});
   if(!code||!['alvi','palitra-love'].includes(code.toLowerCase()))throw Object.assign(Error('Company required'),{status:400});
   return{identity:req.identity,company:{code:code.toLowerCase()}};
 },readJson:async(req,limit)=>{reads++;calls.push({method:'body',limit});if(req.revoke)changed=true;return req.body;},send:(res,status,body,headers)=>responses.push({status,body,headers})});
 const request=(method,path,body,role='owner',extra={})=>handle({method,body,identity:role?{role,userId:1}:null,...extra},{},new URL('https://fixture.test'+path));
 return{direct,design,materials,avatar,calls,responses,request,get reads(){return reads;}};
}
const routes=[['GET','analytics/settings'],['PUT','analytics/settings'],['POST','analytics/check'],['GET','design/settings'],['PUT','design/settings'],['POST','design/check'],['GET','design/state'],['GET','design/history'],['POST','design/preview'],['POST','design/apply'],['POST','design/rollback-preview']];
const materialRoutes=[['GET','design/albums'],['GET','design/material-history'],['POST','design/material-preview'],['POST','design/material-apply']];
const avatarRoutes=[['GET','design/avatar-history'],['POST','design/avatar-preview'],['POST','design/avatar-apply']];
test('avatar routes preserve owner scope, body limits, revision and sanitized errors',async()=>{
 const f=fixture();
 for(const [method,path]of avatarRoutes){await f.request(method,'/vk-tools/'+path+'?companyCode=PALITRA-LOVE&revision=3',{revision:3});assert.equal(f.responses.at(-1).status,200);assert.equal(f.calls.at(-1).code,'palitra-love');assert.equal(f.responses.at(-1).headers['cache-control'],'no-store');}
 await f.request('POST','/vk-tools/design/avatar-preview?companyCode=palitra-love',{revision:3});assert.equal(f.calls.filter(c=>c.method==='body').at(-1).limit,12*1024*1024);
 await f.request('POST','/vk-tools/design/avatar-apply?companyCode=palitra-love',{revision:3});assert.equal(f.calls.filter(c=>c.method==='body').at(-1).limit,64*1024);
 for(const revision of ['', '0','-1','NaN']){await f.request('GET','/vk-tools/design/avatar-history?companyCode=palitra-love&revision='+revision);assert.equal(f.responses.at(-1).status,400);}
 for(const [method,path]of [['POST','design/avatar-history'],['GET','design/avatar-apply'],['POST','analytics/avatar-preview'],['GET','analytics/avatar-history']]){await f.request(method,'/vk-tools/'+path+'?companyCode=palitra-love',{});assert.equal(f.responses.at(-1).status,405);}
 await f.request('POST','/vk-tools/design/avatar-preview?companyCode=palitra-love',{companyCode:'alvi'});assert.equal(f.responses.at(-1).status,400);
 f.avatar.preview=()=>{throw Object.assign(Error('PRIVATE_PROVIDER_PAYLOAD'),{code:'UNTRUSTED',status:502});};
 await f.request('POST','/vk-tools/design/avatar-preview?companyCode=palitra-love',{});assert.equal(f.responses.at(-1).status,502);assert.doesNotMatch(JSON.stringify(f.responses.at(-1)),/PRIVATE|UNTRUSTED/);
 await f.request('POST','/vk-tools/design/avatar-apply?companyCode=palitra-love',{},'owner',{revoke:true});assert.equal(f.responses.at(-1).status,403);
});
test('owner and explicit valid company are required on every route before bodies or service calls',async()=>{
 const f=fixture();for(const [method,path]of [...routes,...materialRoutes,...avatarRoutes])for(const role of ['editor','viewer',null])await assert.rejects(f.request(method,'/vk-tools/'+path+'?companyCode=palitra-love',{},role),e=>e.status===403);
 for(const company of ['', '?companyCode=deleted','?companyCode=../alvi'])await assert.rejects(f.request('GET','/vk-tools/analytics/settings'+company),e=>e.status===400);
 assert.equal(f.reads,0);assert.equal(f.calls.length,0);
});

test('material routes enforce scope, narrow methods, revision and bounded preview bodies',async()=>{
 const f=fixture();
 for(const [method,path]of materialRoutes){await f.request(method,'/vk-tools/'+path+'?companyCode=PALITRA-LOVE&revision=3',{revision:3});assert.equal(f.responses.at(-1).status,200);assert.equal(f.calls.at(-1).code,'palitra-love');}
 assert.equal(f.calls.find(c=>c.method==='materials.listAlbums').body.revision,3);
 await f.request('POST','/vk-tools/design/material-preview?companyCode=palitra-love',{revision:3});assert.equal(f.calls.filter(c=>c.method==='body').at(-1).limit,12*1024*1024);
 await f.request('POST','/vk-tools/design/material-apply?companyCode=palitra-love',{companyCode:'alvi'});assert.equal(f.responses.at(-1).status,400);
 for(const route of ['albums','material-history'])for(const revision of ['', '0','-1','NaN']){await f.request('GET','/vk-tools/design/'+route+'?companyCode=palitra-love&revision='+revision);assert.equal(f.responses.at(-1).status,400);}
 for(const [method,path]of [['POST','design/albums'],['GET','design/material-apply'],['POST','analytics/material-apply'],['GET','analytics/albums']]){await f.request(method,'/vk-tools/'+path+'?companyCode=palitra-love',{});assert.equal(f.responses.at(-1).status,405);}
 await f.request('POST','/vk-tools/design/material-apply?companyCode=palitra-love',{},'owner',{revoke:true});assert.equal(f.responses.at(-1).status,403);
});
test('canonical company is used; cross-company body and revoked identity fail before mutation',async()=>{
 const f=fixture();await f.request('POST','/vk-tools/design/preview?companyCode=PALITRA-LOVE',{revision:3});
 assert.equal(f.calls.at(-1).code,'palitra-love');assert.equal(f.responses.at(-1).headers['cache-control'],'no-store');
 await f.request('POST','/vk-tools/design/apply?companyCode=palitra-love',{companyCode:'alvi'});assert.equal(f.responses.at(-1).status,400);
 await f.request('PUT','/vk-tools/design/settings?companyCode=palitra-love',{},'owner',{revoke:true});assert.equal(f.responses.at(-1).status,403);
 assert.equal(f.calls.filter(c=>['apply','save'].includes(c.method)).length,0);
});
test('route/method allowlist excludes general VK proxy and analytics mutations',async()=>{
 const f=fixture();assert.equal(await f.request('GET','/vk-tools-other/settings'),false);
 for(const [method,path]of [['DELETE','design/settings'],['POST','analytics/apply'],['GET','design/apply'],['POST','design/arbitrary'],['POST','design/history']]){
 await f.request(method,'/vk-tools/'+path+'?companyCode=palitra-love',{});assert.ok([404,405].includes(f.responses.at(-1).status));}
 assert.equal(f.reads,0);assert.equal(f.calls.length,0);
});
test('check requires exact revision; stale async verification is not returned as success',async()=>{
 const f=fixture();for(const revision of [undefined,0,'3',2]){await f.request('POST','/vk-tools/analytics/check?companyCode=palitra-love',{revision});assert.equal(f.responses.at(-1).status,409);}
 assert.equal(f.calls.filter(c=>c.method==='check').length,0);
 await f.request('POST','/vk-tools/analytics/check?companyCode=palitra-love',{revision:3});assert.equal(f.responses.at(-1).status,200);
 f.direct.checkConnection=async()=>({revision:4});await f.request('POST','/vk-tools/design/check?companyCode=palitra-love',{revision:3});assert.equal(f.responses.at(-1).status,409);
});
test('bounded JSON applies only to image preview; malformed bodies are rejected',async()=>{
 const f=fixture();for(const value of [null,[],true,'x']){await f.request('POST','/vk-tools/design/preview?companyCode=palitra-love',value);assert.equal(f.responses.at(-1).status,400);}
 await f.request('POST','/vk-tools/design/preview?companyCode=palitra-love',{});assert.equal(f.calls.filter(c=>c.method==='body').at(-1).limit,12*1024*1024);
 await f.request('PUT','/vk-tools/design/settings?companyCode=palitra-love',{});assert.equal(f.calls.filter(c=>c.method==='body').at(-1).limit,64*1024);
 for(const revision of ['0','-1','NaN','1.2']){await f.request('GET','/vk-tools/design/state?companyCode=palitra-love&revision='+revision);assert.equal(f.responses.at(-1).status,400);}
});
test('all preview/apply/history/rollback methods dispatch; provider errors never escape',async()=>{
 const f=fixture();for(const [method,path]of routes){await f.request(method,'/vk-tools/'+path+'?companyCode=palitra-love',{revision:3});assert.equal(f.responses.at(-1).status,200);}
 f.design.apply=async()=>{throw Object.assign(Error('PRIVATE_TOKEN_OR_UPLOAD_URL'),{status:502,code:'RAW_PROVIDER_CODE',body:'PRIVATE_PAYLOAD'});};
 await f.request('POST','/vk-tools/design/apply?companyCode=palitra-love',{});const result=f.responses.at(-1);
 assert.equal(result.status,502);assert.equal(result.body.code,'OPERATION_FAILED');assert.doesNotMatch(JSON.stringify(result),/PRIVATE|RAW_PROVIDER/);
});
