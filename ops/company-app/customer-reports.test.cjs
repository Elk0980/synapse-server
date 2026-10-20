'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),R=require('./customer-reports.cjs');
const now='2026-10-18T15:00:00Z';
const client=(id,first='2026-10-01T02:00:00Z',created='2023-01-01T00:00:00Z')=>({id,createdAt:created,firstPaidVisitAt:first,lastVisitAt:first});
const cash=(id,clientId,amountKopecks,kind='payment',at='2026-10-01T02:00:00Z')=>({id,clientId,amountKopecks,kind,at,currency:'RUB'});
const snapshot=(clients=[client('1')],events=[cash('1','1',10000)])=>({contract:'salon-client-history/v1',companyCode:'alvi',source:'yclients',capturedAt:now,observedThrough:now,coverage:{clients:true,visits:true,lifetimeHistory:true,payments:true,refunds:true},clients,cash:events});
const report=(s,query={},companyCode='alvi')=>R.report({companyCode,snapshot:s,query,now});
test('default month and day boundaries use Irkutsk calendar across UTC midnight and year change',()=>{
 assert.equal(R.period({},'2026-12-31T16:10:00Z').month,'2027-01');
 assert.equal(R.period({mode:'day',day:'2026-10-18'},now).fromAt,'2026-10-17T16:00:00.000Z');
 assert.equal(R.period({month:'2024-02'},now).to,'2024-02-29');
 for(const q of [{month:'2026-13'},{mode:'day',day:'2026-02-30'},{mode:'year'},{company:'avokado'}])assert.throws(()=>R.period(q,now),{status:400});
});
test('new clients counted once by first paid visit, not registration or subsequent visits',()=>{
 const s=snapshot([client('1'),{...client('2','2026-09-01T02:00:00Z'),lastVisitAt:'2026-10-03T00:00:00Z'},client('3',null,'2026-10-01T00:00:00Z')],[cash('1','1',10000),cash('2','2',20000)]);
 const r=report(s);assert.equal(r.newClients.value,1);assert.equal(r.clients.value,3);assert.equal(r.groups.find(g=>g.key==='noVisit').count,1);assert.equal(r.newSeries.reduce((n,p)=>n+(p.value||0),0),1);assert.equal(r.newSeries.at(-1).value,null);
});
test('first visit at exact Irkutsk midnight belongs to that day and month',()=>{
 const r=report(snapshot([client('1','2026-09-30T16:00:00Z')],[cash('1','1',10000)]));assert.equal(r.newClients.value,1);assert.equal(r.newSeries[0].value,1);
 const d=report(snapshot([client('1','2026-10-17T16:00:00Z')],[cash('1','1',10000)]),{mode:'day',day:'2026-10-18'});assert.equal(d.newClients.value,1);assert.equal(d.newSeries[0].value,1);
});
test('age buckets are exclusive at 3, 6, 12, 24 months and preserve leap-day clamping',()=>{
 const s=snapshot([client('1','2026-10-18T00:00:00Z'),client('2','2026-07-18T00:00:00Z'),client('3','2026-04-18T00:00:00Z'),client('4','2025-10-18T00:00:00Z'),client('5','2024-10-18T00:00:00Z')],[]);
 assert.deepEqual(report(s).groups.map(g=>g.count),[1,1,1,1,1,0]);assert.equal(R.shiftMonth('2024-08-31',-6),'2024-02-29');
});
test('cash LTV subtracts refunds, uses lifetime money, and excludes clients with no paid visit',()=>{
 const s=snapshot([client('1','2024-01-01T00:00:00Z'),client('2'),client('3',null)],[cash('1','1',100000,'payment','2024-01-01T00:00:00Z'),cash('2','1',20000,'refund'),cash('3','2',200000)]);
 const r=report(s);assert.equal(r.ltv.netKopecks,'280000');assert.equal(r.ltv.payingClients,2);assert.equal(r.ltv.value,'140000');assert.equal(r.ltvSeries.length,12);
});
test('past-month cutoff excludes later payments/refunds and later first visits',()=>{
 const s=snapshot([client('1','2026-09-01T00:00:00Z'),client('2')],[cash('1','1',10000,'payment','2026-09-01T00:00:00Z'),cash('2','1',5000,'refund'),cash('3','2',20000)]);
 const r=report(s,{month:'2026-09'});assert.equal(r.newClients.value,1);assert.equal(r.ltv.value,'10000');assert.equal(r.ltv.payingClients,1);
});
test('missing or incomplete history remains unknown, while proven empty data has zero customers and no invented LTV',()=>{
 assert.equal(report(null).newClients.value,null);
 for(const key of ['clients','visits','lifetimeHistory']){const s=snapshot();s.coverage[key]=false;assert.equal(report(s).newClients.value,null);assert.equal(report(s).ltv.value,null);}
 for(const key of ['payments','refunds']){const s=snapshot();s.coverage[key]=false;assert.equal(report(s).newClients.value,1);assert.equal(report(s).ltv.value,null);}
 const r=report(snapshot([],[]));assert.equal(r.clients.value,0);assert.equal(r.newClients.value,0);assert.equal(r.ltv.value,null);assert.equal(r.ltv.reason,'NO_PAYING_CLIENTS');
});
test('same client id across companies never merges; foreign or duplicate source identities fail closed',()=>{
 const s=snapshot();assert.throws(()=>report(s,{},'avokado'),{status:400});
 assert.throws(()=>report(snapshot([client('1'),client('1')],[])),{status:400});
 assert.throws(()=>report(snapshot([client('1')],[cash('1','1',100),cash('1','1',100)])),{status:400});
 const s2={...s,companyCode:'avokado',cash:[cash('2','1',90000)]};assert.equal(report(s).ltv.value,'10000');assert.equal(report(s2,{},'avokado').ltv.value,'90000');
});
test('unknown financial classification/client mapping/currency does not become a valid LTV',()=>{
 const s=snapshot();s.cash[0].clientId='other';assert.equal(report(s).ltv.value,null);
 for(const amountKopecks of [1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>report(snapshot([client('1')],[cash('1','1',amountKopecks)])),{status:400});
 const foreign=snapshot();foreign.cash[0].currency='THB';assert.throws(()=>report(foreign),{status:400});
});
test('last-visit recency for an older month cannot be reconstructed from only current lastVisit',()=>{
 const s=snapshot([{...client('1','2026-01-01T00:00:00Z'),lastVisitAt:'2026-10-01T00:00:00Z'}],[]);const r=report(s,{month:'2026-09',basis:'lastVisit'});assert.equal(r.groupsReason,'HISTORICAL_LAST_VISIT_UNAVAILABLE');assert.ok(r.groups.every(g=>g.count===null));assert.equal(r.newClients.value,0);
});
test('nonexistent ISO dates and out-of-range hours are rejected instead of silently rolled forward',()=>{
 for(const at of ['2026-02-30T00:00:00Z','2026-04-31T00:00:00Z','2026-09-30T24:00:00Z']){
  assert.throws(()=>R.period({},at),{status:400});const s=snapshot();s.clients[0].lastVisitAt=at;assert.throws(()=>report(s),{status:400});
 }
 assert.equal(R.period({},'2026-10-18T15:00:00.1Z').month,'2026-10');
});
