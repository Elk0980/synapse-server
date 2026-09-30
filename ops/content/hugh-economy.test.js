'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createHughEconomy,parseBalance,forecast,BALANCE_URL}=require('./hugh-economy');
const {createHughBudget}=require('./hugh-budget');
const payload={is_available:true,balance_infos:[{currency:'USD',total_balance:'12.50',granted_balance:'2.50',topped_up_balance:'10.00'}]};
test('balance preserves currency and total without adding funding twice; invalid data is unknown',()=>{
 assert.equal(parseBalance(payload).balances[0].total,12.5);
 for(const x of [{}, {...payload,is_available:'true'}, {...payload,balance_infos:[{...payload.balance_infos[0],total_balance:'NaN'}]}, {...payload,balance_infos:[payload.balance_infos[0],payload.balance_infos[0]]}])assert.throws(()=>parseBalance(x));
 assert.equal(forecast(10,{usdPerDay:2}),5);assert.equal(forecast(null,{usdPerDay:2}),null);assert.equal(forecast(10,{usdPerDay:null}),null);assert.equal(forecast(0,{}),0);
});
test('fixed endpoint, cache, failed refresh, rotation and secret isolation',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let time=1790000000000,revision=1,calls=0,broken=false,rotate=false;
 const api=createHughEconomy({db,now:()=>time,account:()=>({revision,secret:'fixture-not-a-real-key'}),fetchImpl:async(url,o)=>{calls++;assert.equal(url,BALANCE_URL);assert.equal(o.redirect,'error');assert.equal(o.method,'GET');if(rotate)revision++;if(broken)throw new Error('fixture-not-a-real-key');return {ok:true,json:async()=>payload};}});
 assert.equal(api.view('zai',1).supported,false);assert.equal(api.view('deepseek',1).status,'unknown');
 await Promise.all([api.refresh(),api.refresh()]);assert.equal(calls,1);await api.refresh();assert.equal(calls,1);
 assert.equal(api.view('deepseek',1).balances[0].total,12.5);time+=600001;broken=true;await api.refresh();assert.equal(api.view('deepseek',1).status,'error');assert.doesNotMatch(JSON.stringify(api.view('deepseek',1)),/fixture/);
 time+=1800001;assert.equal(api.view('deepseek',1).stale,true);broken=false;rotate=true;await api.refresh();assert.equal(api.view('deepseek',revision).status,'unknown');
});
test('redirect and invalid balance never produce a current wallet',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const api=createHughEconomy({db,account:()=>({revision:1,secret:'fixture'}),fetchImpl:async()=>({ok:true,redirected:true,json:async()=>payload})});
 assert.equal((await api.refresh()).status,'error');assert.deepEqual(api.view('deepseek',1).balances,[]);
});
test('cost rate requires observation; settle/release do not double count; unknown price disables forecast',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let time=1790000000000;let priced=true;
 const b=createHughBudget({db,env:{HUGH_FALLBACK_BUDGET_MAX_REQUESTS:'100'},now:()=>time,priceFor:()=>priced?{promptMicroUsdPer1k:1000,completionMicroUsdPer1k:2000}:null});
 for(let i=0;i<3;i++){const r=b.reserve('p',{promptBytes:1000,maxOutputTokens:1000});b.settle(r.id,{promptTokens:1000,completionTokens:1000});}
 assert.equal(b.rate('p').usdPerDay,null);time+=86400000;
 assert.equal(b.rate('p').usdPerDay,.009);const released=b.reserve('p',{promptBytes:1000});b.release(released.id);assert.equal(b.rate('p').requests,3);
 const uncertain=b.reserve('p',{promptBytes:1000});b.keep(uncertain.id);assert.ok(b.rate('p').usdPerDay>.009);
 assert.equal(b.state().remainingRequests,96);priced=false;b.reserve('p');assert.equal(b.rate('p').usdPerDay,null);
});
test('owner alerts deduplicate unchanged failures and reopen only after recovery',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const api=createHughEconomy({db,account:()=>null});
 const state={budget:{remainingUsd:null},providers:[{name:'deepseek',title:'DeepSeek',enabled:true,spend:{limitUsd:5,remainingUsd:.2},wallet:{status:'ok',available:false}}]};
 const runtime={providers:[],budget:{}};api.warnings(state,runtime);api.warnings(state,runtime);assert.equal(db.prepare('SELECT count(*) n FROM hugh_owner_alerts').get().n,3);
 state.providers[0].spend.remainingUsd=4;state.providers[0].wallet.available=true;api.warnings(state,{providers:[{},{}],budget:{}});api.warnings(state,runtime);assert.equal(db.prepare('SELECT count(*) n FROM hugh_owner_alerts').get().n,4);
});
