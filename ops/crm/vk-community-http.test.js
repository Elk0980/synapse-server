'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createVkCommunityHandler}=require('./vk-community-http');
function fixture() {
 const calls=[],responses=[];let reads=0;
 const community=Object.fromEntries(['getSettings','saveSettings','checkConnection','syncConversations','syncHistory','reply'].map(method=>[method,(code,body)=>{calls.push({method,code,body});return{companyCode:code,operation:method};}]));
 const handler=createVkCommunityHandler({community,companyModuleContext(req,code,permission){
  assert.equal(permission,'vk-community.owner');
  if(!req.identity)throw Object.assign(Error('Forbidden'),{status:403});
  if(!code||!/^[a-z0-9_-]+$/i.test(code))throw Object.assign(Error('Choose company'),{status:400});
  if(!['alvi','avokado'].includes(code.toLowerCase()))throw Object.assign(Error('Not found'),{status:404});
  return{identity:req.identity,company:{code:code.toLowerCase()}};
 },readJson:async req=>{reads++;return req.body;},send:(response,status,body,headers)=>responses.push({status,body,headers})});
 const request=(method,path,body,role='owner')=>handler({method,body,...(role?{identity:{role}}:{})},{},new URL('https://fixture.test'+path),{'x-fixture-cors':'yes'});
 return{calls,responses,request,community,get reads(){return reads;}};
}
const routes=[['GET','settings','getSettings'],['PUT','settings','saveSettings'],['POST','check','checkConnection'],['POST','conversations','syncConversations'],['POST','history','syncHistory'],['POST','reply','reply']];

test('HTTP handler rejects every non-owner before reading bodies or contacting a connector',async()=>{
 const f=fixture();for(const role of ['editor','viewer',null])for(const [method,path]of routes)await assert.rejects(f.request(method,`/vk-community/${path}?companyCode=avokado`,{},role),e=>e.status===403);
 assert.equal(f.reads,0);assert.equal(f.calls.length,0);
});
test('HTTP handler requires existing explicit company and uses canonical query scope, never body company',async()=>{
 const f=fixture();for(const company of ['', '?companyCode=','?companyCode=../alvi','?companyCode=deleted'])await assert.rejects(f.request('GET','/vk-community/settings'+company),e=>[400,404].includes(e.status));
 assert.equal(f.calls.length,0);
 for(const [method,path,operation]of routes) {
  const body={companyCode:'alvi',peerId:99};assert.equal(await f.request(method,`/vk-community/${path}?companyCode=AVOKADO`,body),true);
  assert.equal(f.calls.at(-1).method,operation);assert.equal(f.calls.at(-1).code,'avokado');
  assert.equal(f.responses.at(-1).body.companyCode,'avokado');assert.equal(f.responses.at(-1).headers['cache-control'],'no-store');assert.equal(f.responses.at(-1).headers['x-fixture-cors'],'yes');
 }
});
test('unsupported methods and unrelated paths never invoke a connector',async()=>{
 const f=fixture();assert.equal(await f.request('GET','/unrelated'),false);assert.equal(await f.request('POST','/vk-community-other/reply',{}),false);
 for(const [method,path]of [['GET','reply'],['POST','settings'],['DELETE','settings'],['POST','missing']])await assert.rejects(f.request(method,`/vk-community/${path}?companyCode=avokado`,{}),e=>e.status===405);
 assert.equal(f.calls.length,0);assert.equal(f.reads,0);
});
test('malformed JSON body shapes fail as 400 without connector calls',async()=>{
 const f=fixture();for(const [method,path]of routes.filter(item=>['settings','conversations','history','reply'].includes(item[1])&&item[0]!=='GET'))for(const value of [null,[],true,1,'not an object'])await assert.rejects(f.request(method,`/vk-community/${path}?companyCode=avokado`,value),e=>e.status===400);
 assert.equal(f.calls.length,0);
});
test('only known connector errors receive static safe HTTP code and message; unknown failures remain for server handling',async()=>{
 const f=fixture();
 for(const [code,status]of [['SETTINGS_CHANGED',409],['REPLY_DENIED',502],['ACCESS_DENIED',502]]) {
  f.community.reply=async()=>{throw Object.assign(Error('PRIVATE RAW PROVIDER PAYLOAD'),{status,code,details:{private:'PRIVATE RAW PROVIDER PAYLOAD'}});};
  assert.equal(await f.request('POST','/vk-community/reply?companyCode=avokado',{}),true);
  const response=f.responses.at(-1);assert.equal(response.status,status);assert.equal(response.body.code,code);assert.equal(response.headers['cache-control'],'no-store');
  assert.deepEqual(Object.keys(response.body).sort(),['code','error']);assert.doesNotMatch(JSON.stringify(response),/PRIVATE RAW PROVIDER PAYLOAD/);
 }
 const unexpected=Object.assign(Error('Unexpected failure'),{status:400,code:'UNKNOWN_CODE'});
 f.community.reply=()=>{throw unexpected;};
 await assert.rejects(f.request('POST','/vk-community/reply?companyCode=avokado',{}),error=>error===unexpected);
});
