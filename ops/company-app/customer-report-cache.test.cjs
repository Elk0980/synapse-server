'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {Readable}=require('node:stream');
const {createCache}=require('./customer-report-cache.cjs'),H=require('./customer-reports-http.cjs'),I=require('./customer-report-import-http.cjs');
const now='2026-10-18T17:00:00.000Z';
const snapshot=(company='alvi',n=2)=>({contract:'salon-client-aggregates/v1',companyCode:company,branchId:company==='alvi'?989844:375899,source:'yclients-ui',capturedAt:now,observedThrough:now,periods:[{from:'2026-10-01',to:'2026-10-19',newClients:n}],clients:{asOfDay:'2026-10-19',total:10,groups:['under3','3to6','6to12','1to2','over2','noVisit'].map((key,i)=>({key,count:i===0?10:0}))}});
const entry=(company='alvi',n=2,expectedRevision=0)=>({companyCode:company,expectedRevision,snapshot:snapshot(company,n)});
const options=(requestId='daily-2026-10-19')=>({actorId:1,requestId});
function fixture(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());return {db,cache:createCache(db,{clock:()=>now})};}
test('publishes both companies atomically and reads verified real-shape aggregates through protected report handler',async t=>{const {cache}=fixture(t);const receipt=cache.publish([entry('alvi',2),entry('avokado',3)],options());assert.equal(receipt.companies.length,2);assert.equal(receipt.notificationSent,false);let response;
 await H.handle({request:{method:'GET'},url:new URL('https://example.test/content/avokado/customer-reports'),requireSession:()=>({user:{id:2,sessionVersion:1,role:'editor',companyCodes:['avokado'],permissions:['analytics.view']}}),readSnapshot:async c=>cache.read(c),now:()=>now,reply:(status,body)=>response=body});assert.equal(response.companyCode,'avokado');assert.equal(response.newClients.value,3);assert.equal(response.ltv.value,null);
 const copy=cache.read('alvi');copy.clients.total=900;assert.equal(cache.read('alvi').clients.total,10);
});
test('identical request is replayed once, changed body under same request id is rejected',t=>{const {cache,db}=fixture(t),entries=[entry()];const first=cache.publish(entries,options()),again=cache.publish(entries,options());assert.deepEqual(again,{...first,replayed:true});assert.equal(db.prepare('SELECT count(*) AS n FROM salon_report_history_v1').get().n,1);assert.throws(()=>cache.publish([entry('alvi',4)],options()),{status:409});assert.equal(cache.read('alvi').periods[0].newClients,2);});
test('one stale revision or invalid second source leaves both previous snapshots unchanged',t=>{const {cache}=fixture(t);cache.publish([entry('alvi',2),entry('avokado',3)],options());for(const entries of [[entry('alvi',8,1),entry('avokado',9,0)],[entry('alvi',8,1),{...entry('avokado',9,1),snapshot:snapshot('alvi',9)}]]){assert.throws(()=>cache.publish(entries,options('next')));assert.equal(cache.read('alvi').periods[0].newClients,2);assert.equal(cache.read('avokado').periods[0].newClients,3);}});
test('source time cannot move backwards, while same source does not produce another history revision',t=>{const {cache,db}=fixture(t);cache.publish([entry()],options());const same=cache.publish([entry('alvi',2,1)],options('retry-different-key'));assert.equal(same.companies[0].changed,false);assert.equal(same.companies[0].revision,1);const old=entry('alvi',3,1);old.snapshot.capturedAt='2026-10-18T16:59:00.000Z';old.snapshot.observedThrough=old.snapshot.capturedAt;assert.throws(()=>cache.publish([old],options('old')),{status:409});assert.equal(db.prepare('SELECT count(*) AS n FROM salon_report_history_v1').get().n,1);});
test('revoked access at commit leaves no snapshots, history or import receipt',t=>{const {cache,db}=fixture(t);assert.throws(()=>cache.publish([entry('alvi'),entry('avokado')],{...options(),beforeCommit:()=>{throw Object.assign(new Error('revoked'),{status:403});}}),{status:403});for(const table of ['salon_report_cache_v1','salon_report_history_v1','salon_report_import_v1'])assert.equal(db.prepare('SELECT count(*) AS n FROM '+table).get().n,0);});
test('old observed period is validated instead of escaping validation through current-month unknown',t=>{const {cache}=fixture(t);const e=entry();e.snapshot.capturedAt=e.snapshot.observedThrough='2026-09-19T17:00:00.000Z';e.snapshot.periods=[{from:'2026-09-01',to:'2026-09-20',newClients:-1}];delete e.snapshot.clients;assert.throws(()=>cache.publish([e],options()),{status:400});assert.equal(cache.read('alvi'),null);});
test('unknown source fields, cross-branch data, names and phone numbers cannot enter the cache contract',t=>{const {cache}=fixture(t);for(const mutate of [e=>e.snapshot.branchId=375899,e=>e.snapshot.phone='123',e=>e.snapshot.clients.name='not allowed',e=>e.snapshot.periods[0].email='not allowed',e=>e.snapshot.metric_source_verified_at={recency:'2027-01-01T00:00:00.000Z'}]){const e=entry();mutate(e);assert.throws(()=>cache.publish([e],options()),{status:400});}assert.equal(cache.read('alvi'),null);});
test('source timestamps preserve nonzero milliseconds and reject calendar rollover',t=>{const {cache}=fixture(t),e=entry();e.snapshot.metric_source_verified_at={overview:'2026-10-18T16:59:59.221Z'};cache.publish([e],options());assert.equal(cache.read('alvi').metric_source_verified_at.overview,e.snapshot.metric_source_verified_at.overview);const invalid=entry('alvi',3,1);invalid.snapshot.metric_source_verified_at={overview:'2026-02-30T00:00:00.000Z'};assert.throws(()=>cache.publish([invalid],options('invalid-date')),{status:400});assert.equal(cache.read('alvi').periods[0].newClients,2);});
test('reopening cache on same database preserves revisions, idempotency receipts and source hash',t=>{const {cache,db}=fixture(t);const first=cache.publish([entry()],options());const reopened=createCache(db,{clock:()=>now});assert.equal(reopened.metadata('alvi').sha256,first.companies[0].sha256);assert.equal(reopened.publish([entry()],options()).replayed,true);assert.equal(reopened.read('alvi').periods[0].newClients,2);});
test('an interrupted publish can be checked by its own persisted receipt without republishing or reading source data',t=>{const {cache,db}=fixture(t);assert.equal(cache.receipt(1,'daily'),null);const receipt=cache.publish([entry('alvi'),entry('avokado')],options('daily'));assert.deepEqual(createCache(db,{clock:()=>now}).receipt(1,'daily'),receipt);assert.equal(cache.receipt(2,'daily'),null);assert.equal(db.prepare('SELECT count(*) n FROM salon_report_history_v1').get().n,2);const copy=cache.receipt(1,'daily');copy.companies.length=0;assert.equal(cache.receipt(1,'daily').companies.length,2);assert.throws(()=>cache.receipt(1,'bad/request'),{status:400});});
test('even a partial history cannot store repeated identities, financial events or personal columns',t=>{const {cache}=fixture(t);const client={id:'1',createdAt:'2026-01-01T00:00:00Z',firstPaidVisitAt:null,lastVisitAt:null};const s={contract:'salon-client-history/v1',companyCode:'alvi',branchId:989844,source:'yclients',capturedAt:now,observedThrough:now,coverage:{clients:false,visits:false,lifetimeHistory:false,payments:false,refunds:false},clients:[client,{...client}]};assert.throws(()=>cache.publish([{companyCode:'alvi',expectedRevision:0,snapshot:s}],options()),{status:400});s.clients=[client];s.cash=[{id:'1',clientId:'1',at:now,kind:'payment',amountKopecks:100,currency:'RUB'}];s.cash.push({...s.cash[0]});assert.throws(()=>cache.publish([{companyCode:'alvi',expectedRevision:0,snapshot:s}],options()),{status:400});assert.equal(cache.read('alvi'),null);});
function httpSetup({role='owner',codes=['alvi','avokado'],origin='https://synapse.synapsebusiness.ru',method='POST',afterRead}={}){let user={id:1,role,companyCodes:codes,sessionVersion:7};const writes=[],replies=[],calls=[];return{writes,replies,calls,args:{request:{method,headers:{origin}},url:new URL('https://synapse.synapsebusiness.ru/content/customer-reports/source'),origin:'https://synapse.synapsebusiness.ru',requireSession:()=>({user}),requireCsrf:()=>calls.push('csrf'),readJson:async()=>{calls.push('body');if(afterRead)user=afterRead(user);return{requestId:'daily',entries:[entry()]};},cache:{publish:(entries,opt)=>{opt.beforeCommit();writes.push(entries);return{notificationSent:false};}},reply:(...r)=>replies.push(r)}};}
test('native import checks owner, origin, CSRF, current company assignment and actor after body read',async()=>{const s=httpSetup();assert.equal(await I.handle(s.args),true);assert.equal(s.writes.length,1);assert.equal(s.calls.filter(c=>c==='csrf').length,3);assert.equal(s.replies[0][1].notificationSent,false);for(const o of [{role:'editor'},{codes:['avokado']},{origin:'https://evil.test'},{afterRead:u=>({...u,id:2})},{afterRead:u=>({...u,sessionVersion:8})},{afterRead:u=>({...u,role:'editor'})},{afterRead:u=>({...u,companyCodes:[]})}]){const s=httpSetup(o);await assert.rejects(I.handle(s.args),{status:403});assert.equal(s.writes.length,0);}});
test('import source has no raw-data GET, cannot accept query overrides, and leaves unrelated routes alone',async()=>{for(const method of ['GET','PUT','DELETE']){const s=httpSetup({method});await assert.rejects(I.handle(s.args),{status:405});assert.equal(s.calls.length,0);}const q=httpSetup();q.args.url.search='?company=avokado';await assert.rejects(I.handle(q.args),{status:400});const other=httpSetup();other.args.url.pathname='/content/palitra/orders';assert.equal(await I.handle(other.args),false);});
test('source status and own receipt expose only metadata, preserve scope and never send notifications',async t=>{const {cache}=fixture(t);cache.publish([entry('alvi'),entry('avokado')],options('daily'));for(const suffix of ['/status','/receipt?requestId=daily']){const s=httpSetup({method:'GET'});s.args.url=new URL('https://synapse.synapsebusiness.ru/content/customer-reports/source'+suffix);s.args.cache=cache;await I.handle(s.args);assert.equal(s.calls.length,0);assert.equal(s.replies[0][0],200);assert.equal(s.replies[0][2]['cache-control'],'private, no-store');assert.equal(JSON.stringify(s.replies[0][1]).includes('newClients'),false);assert.equal(JSON.stringify(s.replies[0][1]).includes('clients'),false);}assert.equal(cache.receipt(1,'daily').notificationSent,false);});
test('receipt lookup cannot read another actor, a revoked company or malformed keys',async t=>{const {cache}=fixture(t);cache.publish([entry('alvi'),entry('avokado')],options('daily'));for(const [suffix,code,codes] of [['/receipt?requestId=missing',404,['alvi','avokado']],['/receipt?requestId=daily',403,['alvi']],['/receipt?requestId=daily&requestId=other',400,['alvi','avokado']],['/receipt?requestId=bad%2Fkey',400,['alvi','avokado']],['/status?company=alvi',400,['alvi','avokado']]]){const s=httpSetup({method:'GET',codes});s.args.url=new URL('https://synapse.synapsebusiness.ru/content/customer-reports/source'+suffix);s.args.cache=cache;await assert.rejects(I.handle(s.args),{status:code});assert.equal(s.replies.length,0);}for(const suffix of ['/status','/receipt?requestId=daily']){const s=httpSetup({method:'GET',role:'editor'});s.args.url=new URL('https://synapse.synapsebusiness.ru/content/customer-reports/source'+suffix);s.args.cache=cache;await assert.rejects(I.handle(s.args),{status:403});}});
test('metadata read rechecks the same actor, version, role and companies before returning',async()=>{for(const mutate of [u=>({...u,id:2}),u=>({...u,sessionVersion:8}),u=>({...u,role:'editor'}),u=>({...u,companyCodes:['avokado']})]){let reads=0;const user={id:1,sessionVersion:7,role:'owner',companyCodes:['alvi','avokado']},s=httpSetup({method:'GET'});s.args.url.pathname+='/status';s.args.requireSession=()=>({user:reads++?mutate(user):user});s.args.cache={metadata:()=>null};await assert.rejects(I.handle(s.args),{status:403});assert.equal(s.replies.length,0);}});
test('dedicated source reader enforces JSON, actual byte limit and UTF-8 before parsing',async()=>{const request=(bytes,type='application/json')=>Object.assign(Readable.from([bytes]),{headers:{'content-type':type}});assert.deepEqual(await I.readSourceJson(request(Buffer.from('{"ok":true}'))),{ok:true});await assert.rejects(I.readSourceJson(request(Buffer.from('{"т":"я"}')),5),{status:413});await assert.rejects(I.readSourceJson(request(Buffer.from('[]'),'text/plain')),{status:415});await assert.rejects(I.readSourceJson(request(Buffer.from('{"x":"\xff"}','latin1'))),{status:400});await assert.rejects(I.readSourceJson(request(Buffer.from('{broken'))),{status:400});});

function periodSnapshot(at,n,company='alvi'){
 const s=snapshot(company,n),day=require('./customer-reports.cjs').isoDay(at);
 s.capturedAt=s.observedThrough=at;s.periods=[{from:day.slice(0,7)+'-01',to:day,newClients:n}];s.clients.asOfDay=day;return s;
}
test('a later month and reopening do not hide the saved old month or replace its recency with today',async t=>{
 const {db,cache}=fixture(t),old=periodSnapshot('2026-09-30T12:00:00.000Z',7);
 cache.publish([{companyCode:'alvi',expectedRevision:0,snapshot:old}],options('september'));
 cache.publish([entry('alvi',2,1),entry('avokado',3)],options('october'));
 const reopened=createCache(db,{clock:()=>now});
 let response,observedQuery;
 await H.handle({request:{method:'GET'},url:new URL('https://example.test/content/alvi/customer-reports?month=2026-09'),requireSession:()=>({user:{id:2,sessionVersion:1,role:'editor',companyCodes:['alvi'],permissions:['analytics.view']}}),readSnapshot:async(c,q,at)=>{observedQuery={c,q,at};return reopened.readForPeriod(c,q,at);},now:()=>now,reply:(status,body)=>response=body});
 assert.deepEqual(observedQuery,{c:'alvi',q:{month:'2026-09'},at:now});
 assert.equal(response.newClients.value,7);assert.equal(response.clients.value,10);assert.equal(response.groups[0].count,10);assert.equal(response.source.updatedAt,old.capturedAt);
 assert.equal(reopened.readForPeriod('alvi',{month:'2026-10'}).periods[0].newClients,2);
 assert.equal(reopened.metadata('alvi').revision,2);assert.equal(reopened.receipt(1,'october').notificationSent,false);
 assert.equal(reopened.readForPeriod('avokado',{month:'2026-09'}).companyCode,'avokado');
 assert.throws(()=>reopened.readForPeriod('palitra-love',{month:'2026-09'}),{status:403});
});
test('old daily counts remain available from their actual later snapshot, without inventing old client groups',t=>{
 const {cache}=fixture(t),old=periodSnapshot('2026-09-30T12:00:00.000Z',7);
 old.periods.push({from:'2026-09-10',to:'2026-09-10',newClients:3});
 cache.publish([{companyCode:'alvi',expectedRevision:0,snapshot:old}],options('september'));
 cache.publish([entry('alvi',2,1)],options('october'));
 const query={mode:'day',day:'2026-09-10'},source=cache.readForPeriod('alvi',query);
 const result=require('./customer-report-aggregates.cjs').report({companyCode:'alvi',query,snapshot:source,now});
 assert.equal(result.newClients.value,3);assert.equal(result.clients.value,null);assert.ok(result.groups.every(g=>g.count===null));assert.equal(result.ltv.value,null);
 assert.equal(result.source.updatedAt,old.capturedAt);
 const unknown=require('./customer-report-aggregates.cjs').report({companyCode:'alvi',query:{month:'2026-08'},snapshot:cache.readForPeriod('alvi',{month:'2026-08'}),now});
 assert.equal(unknown.newClients.value,null);assert.equal(unknown.clients.value,null);
});
test('correcting an old observed month does not hide a newer observed month',t=>{
 const {db,cache}=fixture(t),old=periodSnapshot('2026-09-30T12:00:00.000Z',7);
 cache.publish([{companyCode:'alvi',expectedRevision:0,snapshot:old}],options('september'));
 cache.publish([entry('alvi',2,1)],options('october'));
 const later='2026-10-19T17:00:00.000Z',writer=createCache(db,{clock:()=>later});
 const corrected=structuredClone(old);corrected.capturedAt=later;corrected.periods[0].newClients=9;
 writer.publish([{companyCode:'alvi',expectedRevision:2,snapshot:corrected}],options('correct-september'));
 assert.equal(writer.readForPeriod('alvi',{month:'2026-09'}).periods[0].newClients,9);
 assert.equal(writer.readForPeriod('alvi',{month:'2026-10'}).periods[0].newClients,2);
 assert.equal(writer.metadata('alvi').revision,3);
 assert.equal(db.prepare('SELECT count(*) n FROM salon_report_history_v1').get().n,3);
});
test('verified complete visit and cash history takes precedence and computes the selected past cut',t=>{
 const {cache}=fixture(t),old=periodSnapshot('2026-09-30T12:00:00.000Z',7);
 cache.publish([{companyCode:'alvi',expectedRevision:0,snapshot:old}],options('september'));
 const first='2026-01-02T12:00:00.000Z',last='2026-10-18T16:00:00.000Z';
 const history={contract:'salon-client-history/v1',companyCode:'alvi',branchId:989844,source:'yclients',capturedAt:now,observedThrough:now,coverage:{clients:true,visits:true,lifetimeHistory:true,payments:true,refunds:true},clients:[{id:'c1',createdAt:'2026-01-01T00:00:00.000Z',firstPaidVisitAt:first,lastVisitAt:last}],attendedVisits:[{id:'v1',clientId:'c1',at:first},{id:'v2',clientId:'c1',at:last}],cash:[{id:'p1',clientId:'c1',at:first,kind:'payment',amountKopecks:3000,currency:'RUB'},{id:'r1',clientId:'c1',at:'2026-02-01T12:00:00.000Z',kind:'refund',amountKopecks:500,currency:'RUB'}]};
 cache.publish([{companyCode:'alvi',expectedRevision:1,snapshot:history}],options('complete-history'));
 const query={month:'2026-09'},selected=cache.readForPeriod('alvi',query);
 assert.equal(selected.contract,'salon-client-history/v1');
 const report=require('./customer-reports.cjs').report({companyCode:'alvi',query,snapshot:selected,now});
 assert.equal(report.newClients.value,0);assert.equal(report.clients.value,1);assert.equal(report.ltv.value,'2500');assert.equal(report.source.status,'complete');
 assert.equal(report.groups.find(g=>g.key==='6to12').count,1);
});
test('historical cache selects the Irkutsk side of midnight at an exact month boundary',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const at='2026-11-01T08:00:00.000Z',cache=createCache(db,{clock:()=>at});
 const october=periodSnapshot('2026-10-31T15:59:59.999Z',12),november=periodSnapshot('2026-10-31T16:00:00.000Z',1);
 cache.publish([{companyCode:'alvi',expectedRevision:0,snapshot:october}],options('last-october-ms'));
 cache.publish([{companyCode:'alvi',expectedRevision:1,snapshot:november}],options('first-november-ms'));
 assert.equal(cache.readForPeriod('alvi',{month:'2026-10'}).periods[0].newClients,12);
 assert.equal(cache.readForPeriod('alvi',{month:'2026-11'}).periods[0].newClients,1);
 assert.equal(cache.readForPeriod('alvi',{mode:'day',day:'2026-10-31'}).observedThrough,october.observedThrough);
 assert.equal(cache.readForPeriod('alvi',{mode:'day',day:'2026-11-01'}).observedThrough,november.observedThrough);
});
