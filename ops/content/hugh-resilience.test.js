'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createHughFallback}=require('./hugh-fallback');
const {reviewDraft,parseReview}=require('./task-dispatch-worker');
test('wrong structured result uses another provider; paid attempt is counted; reviewer excludes author',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let calls=[];
 const providers=['first','second','third'].map(name=>({name,url:'https://'+name+'.example',secret:'fixture',model:name+'-model',timeoutMs:5000,pricePromptMicroUsdPer1k:1000,priceCompletionMicroUsdPer1k:1000}));
 const f=createHughFallback({db,env:{HUGH_FALLBACK_BUDGET_MAX_REQUESTS:'20'},providerStore:{available:true,runtimeProviders:()=>providers},fetchImpl:async url=>{
  calls.push(url);return {ok:true,status:200,json:async()=>({choices:[{message:{content:url.includes('first')?'invalid':JSON.stringify({verdict:'passed',note:'ok'})}}],usage:{prompt_tokens:20,completion_tokens:10}})};
 }});
 const r=await f.reply({messages:[]},{validate:parseReview});assert.equal(r.provider,'second');assert.equal(calls.length,2);assert.equal(f.budget.state().requests,2);
 calls=[];const checked=await reviewDraft(f,{title:'T',description:'D',answer:''},{result:'Text'},r);assert.equal(checked.provider,'third');assert.equal(checked.verdict,'passed');assert.equal(calls.length,1);assert.ok(!calls[0].includes('second'));
});
test('two failed providers are bounded; output is preserved when independent review unavailable',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let calls=0;
 const f=createHughFallback({db,env:{HUGH_FALLBACK_BUDGET_MAX_REQUESTS:'20'},providerStore:{available:true,runtimeProviders:()=>['a','b','c'].map(name=>({name,url:'https://'+name+'.example',secret:'fixture',model:name,timeoutMs:5000}))},fetchImpl:async()=>{calls++;throw new Error('offline');}});
 await assert.rejects(f.reply({messages:[]}));assert.equal(calls,2);
 const review=await reviewDraft({reply:async()=>{throw new Error('quota');}},{title:'T'},{result:'D'},{provider:'a'});assert.equal(review.verdict,'unavailable');
 const self=await reviewDraft({reply:async()=>({text:JSON.stringify({verdict:'passed',note:'ok'}),provider:'a',model:'a'})},{},{result:'D'},{provider:'a'});assert.equal(self.verdict,'unavailable');
});

test('same actual model through a different provider is not independent review',async()=>{
 const review=await reviewDraft({reply:async()=>({provider:'b',model:'Writer',text:'{"verdict":"passed","note":"ok"}'})},{},{result:'D'},{provider:'a',model:'writer'});
 assert.equal(review.verdict,'unavailable');
});
