'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('./company-context');
const who = (codes = ['palitra-love','avokado','alvi'], id = 1, role = 'owner') => ({ userId: id, role, companies: codes.map(id => ({id})), permissions: ['crm.view','crm.edit'] });
const deferred = () => { let resolve, reject; const promise = new Promise((r,j) => {resolve=r;reject=j;});return {promise,resolve,reject}; };
test('owner sees exactly the three supported companies; staff sees only assigned studios', () => {
 assert.deepEqual(C.available(who()).map(p=>p.name), ['Палитра','Авокадо','Алви']);
 assert.deepEqual(C.available(who(['alvi','avokado'],2,'editor')).map(p=>p.code), ['avokado','alvi']);
 assert.deepEqual(C.available(who([],1)), []);
 for(const role of ['customer','admin','constructor',undefined]) assert.deepEqual(C.available({...who(),role}),[]);
 for(const userId of ['',0,-1,NaN,Infinity,'<script>']) assert.deepEqual(C.available({...who(),userId}),[]);
 assert.deepEqual(C.available({...who(),companies:[{code:'palitra-love'}]}), []);
});
test('known but unassigned company never activates, even if a saved selection requests it', async()=>{
 let calls=0;const context=C.create({verifyIdentity:async()=>who(['alvi','avokado'],2,'editor'),activate:()=>{calls++;}});
 assert.equal(context.initialize(who(['alvi','avokado'],2,'editor'),'palitra-love').code,'avokado');
 await assert.rejects(context.choose('palitra-love'),{code:'COMPANY_FORBIDDEN'});assert.equal(calls,0);assert.equal(context.snapshot().company.code,'avokado');
 await assert.rejects(context.choose('__proto__'),{code:'COMPANY_FORBIDDEN'});assert.equal(calls,0);
});
test('drafts and same numeric entity ids remain isolated across companies and actors',async()=>{
 let identity=who();const c=C.create({verifyIdentity:async()=>identity,activate:()=>{}});c.initialize(identity);
 c.saveDraft({entity:'native-order:18',text:'Палитра'});const ticket=c.ticket();
 await c.choose('avokado');assert.equal(c.current(ticket),false);assert.equal(c.draft(),undefined);
 c.saveDraft({entity:'native-order:18',text:'Авокадо'});await c.choose('palitra-love');assert.equal(c.draft().text,'Палитра');
 identity=who(['palitra-love'],2,'editor');await c.choose('palitra-love');assert.equal(c.draft(),undefined);
});
test('file, unknown outcome, busy operation and unverified form prevent switching without clearing anything',async()=>{
 for(const reason of ['file','pending','busy','protected','unverified']){
  let calls=0;const c=C.create({verifyIdentity:async()=>{calls++;return who();},beforeSwitch:()=>[reason],activate:()=>assert.fail('must not activate')});c.initialize(who());c.saveDraft('сохранить');
  await assert.rejects(c.choose('alvi'),{code:'SWITCH_BLOCKED'});assert.equal(calls,0);assert.equal(c.draft(),'сохранить');assert.equal(c.snapshot().company.code,'palitra-love');
 }
});
test('new edits during identity request cancel switch; concurrent clicks make one request',async()=>{
 const d=deferred();let dirty=false,calls=0,activated=0;
 const c=C.create({verifyIdentity:()=>{calls++;return d.promise;},beforeSwitch:()=>dirty?['file']:[],activate:()=>{activated++;}});c.initialize(who());
 const p=c.choose('alvi');await assert.rejects(c.choose('avokado'),{code:'SWITCH_BUSY'});dirty=true;d.resolve(who());
 await assert.rejects(p,{code:'SWITCH_BLOCKED'});assert.equal(calls,1);assert.equal(activated,0);assert.equal(c.snapshot().company.code,'palitra-love');
});
test('revoked company clears visible context before declining; revoked session clears all drafts',async()=>{
 const activated=[];let identity=who(['alvi']);const c=C.create({verifyIdentity:async()=>identity,activate:(p,_i,m)=>{activated.push([p&&p.code,m.revoked]);}});c.initialize(who());c.saveDraft('secret');
 await assert.rejects(c.choose('palitra-love'),{code:'COMPANY_FORBIDDEN'});assert.equal(c.snapshot().company,null);assert.equal(c.draft(),undefined);assert.deepEqual(activated[0],[null,true]);
 const revoked=C.create({verifyIdentity:async()=>{throw Object.assign(new Error('expired'),{status:401});},activate:p=>assert.equal(p,null)});revoked.initialize(who());revoked.saveDraft('secret');
 await assert.rejects(revoked.choose('alvi'),{status:401});assert.equal(revoked.snapshot().actor,'');assert.equal(revoked.draft(),undefined);
});
test('late identity response after revoke cannot select company, activate, or repaint',async()=>{
 const d=deferred();let calls=0;const c=C.create({verifyIdentity:()=>d.promise,activate:()=>{calls++;}});c.initialize(who());const p=c.choose('alvi');c.revoke();d.resolve(who());assert.equal(await p,false);assert.equal(calls,0);assert.equal(c.snapshot().company,null);
});
test('identity object mutation after initialize cannot create new menu grants',()=>{
 const identity=who(['alvi'],2,'editor');const c=C.create({verifyIdentity:async()=>identity,activate:()=>{}});c.initialize(identity);identity.companies.push({id:'palitra-love'});assert.deepEqual(c.snapshot().companies.map(p=>p.code),['alvi']);
});
test('scoped bridge builds exact company routes, validates membership, and rejects unsupported transports',async()=>{
 const root=require('./product/synapse-bridge');const seen=[];
 for(const code of ['palitra-love','avokado','alvi']){
  const b=root.forCompany(code), identity=b.parseIdentity({...who(),csrfToken:'synthetic-csrf'});
  const bridge=b.createBridge({getAuth:()=>({cabinet:identity}),transport:{send:async request=>{seen.push(request);return {orders:[]};}}});
  await bridge.call('native.orders.list',{query:{limit:10}});assert.equal(seen.at(-1).path,`/content/${C.profile(code).site}/orders`);
  assert.equal(b.crmReportQuery({from:'2026-10-01',to:'2026-10-07'}).companyCode,code);
  assert.equal(b.ORIGINS.shop,C.profile(code).origin);
  if(code!=='palitra-love')await assert.rejects(bridge.call('thread.list'),{code:'NOT_CONNECTED'});
 }
 const av=root.forCompany('avokado'), foreign=av.parseIdentity({...who(['alvi'],2,'editor'),csrfToken:'synthetic'});
 let calls=0;const denied=av.createBridge({getAuth:()=>({cabinet:foreign}),transport:{send:async()=>{calls++;}}});
 await assert.rejects(denied.call('native.orders.list'),{code:'FORBIDDEN'});assert.equal(calls,0);
 assert.throws(()=>root.forCompany('constructor'));
});
