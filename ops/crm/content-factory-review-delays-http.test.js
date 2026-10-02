'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createContentFactoryReviewDelaysHandler}=require('./content-factory-review-delays-http');
test('closed delay read rejects identity/method/extra fields; no browser company query or mutation',async()=>{
 let reads=0;const summary={items:[],hasMore:false,nextAfterTaskId:0,detectedAt:'2026-10-02T12:00:00.000Z'};
 const handle=createContentFactoryReviewDelaysHandler({delays:{pending(body){reads++;assert.deepEqual(body,{afterTaskId:0,limit:100});return summary;}},readJson:async req=>req.body,send:(res,status,body,headers)=>Object.assign(res,{status,body,headers})});
 const call=async({method='POST',headers={},body={afterTaskId:0,limit:100},search=''}={})=>{const response={};assert.equal(await handle({method,headers,body},response,new URL('http://test/internal/content-factory/review-delays'+search)),true);return response;};
 assert.equal(await handle({headers:{}},{},new URL('http://test/unrelated')),false);
 await assert.rejects(call({headers:{'x-synapse-crm-identity':'forged'}}),{status:403});await assert.rejects(call({method:'GET'}),{status:405});
 for(const body of [null,[],{}, {afterTaskId:0,limit:100,companyCode:'other'},{afterTaskId:0,limit:100,actor:{}}])await assert.rejects(call({body}),{status:400});
 await assert.rejects(call({search:'?companyCode=other'}),{status:400});assert.equal(reads,0);
 const result=await call();assert.equal(result.status,200);assert.equal(result.body,summary);assert.equal(result.headers['cache-control'],'no-store');
});
