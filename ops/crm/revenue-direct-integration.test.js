'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createRevenueAnalytics}=require('./revenue-analytics');
const {createRevenueAdapters}=require('./revenue-analytics-adapters');
const {createRevenueHandler}=require('./revenue-analytics-http');

const AT=Date.parse('2026-10-13T06:00:00Z'),P={from:'2026-10-01',to:'2026-10-07'};
const TOKEN='synthetic-direct-private-credential';
const config=(v={})=>({externalLogin:'shared-client',campaignIds:['701'],currency:'RUB',timezone:'Europe/Moscow',includeVAT:false,includeDiscount:true,historyFrom:'2026-09-01',...v});
function report(init,cost='1234567890',campaign) {
  const p=JSON.parse(init.body).params;
  return new Response(['"'+p.ReportName+' ('+p.SelectionCriteria.DateFrom+' - '+p.SelectionCriteria.DateTo+')"',
    'Date\tCampaignId\tImpressions\tClicks\tCost',p.SelectionCriteria.DateFrom+'\t'+(campaign||p.SelectionCriteria.Filter[0].Values[0])+'\t25\t3\t'+cost,'Total rows: 1'].join('\n')+'\n',
    {status:200,headers:{'content-type':'text/tab-separated-values'}});
}
function harness(t,{filename=':memory:',time=AT}={}) {
  const h={time,calls:[],respond:async init=>report(init)};
  h.db=new DatabaseSync(filename);
  h.adapters=createRevenueAdapters({fetchImpl:async(url,init)=>{
    assert.equal(url,'https://api.direct.yandex.com/json/v501/reports');
    assert.equal(init.method,'POST');assert.equal(init.redirect,'error');
    h.calls.push(init);return h.respond(init);
  },now:()=>h.time});
  h.a=createRevenueAnalytics(h.db,{apiKey:'synthetic-at-rest-key',now:()=>h.time,adapters:h.adapters});
  h.save=(company='alvi',extra={})=>h.a.save(company,'direct',{revision:h.a.access.get(company,'direct').revision,enabled:true,config:config(),credential:{token:TOKEN},...extra});
  t.after(async()=>{await h.a.stop();h.db.close();});
  return h;
}

test('доступ Директа шифруется, секрет не выходит в настройки; пересечение запрещено и с выключенной компанией',t=>{
  const h=harness(t);h.save('alvi',{enabled:false});
  assert.doesNotMatch(h.db.prepare("SELECT secret FROM revenue_access WHERE provider='direct'").get().secret,/synthetic-direct-private/);
  assert.doesNotMatch(JSON.stringify(h.a.settings('alvi')),/credential|synthetic-direct-private/);
  assert.throws(()=>h.save('avocado'),{code:'BINDING_OVERLAP'});
  assert.equal(h.a.access.get('avocado','direct').revision,0);
  h.save('avocado',{config:config({campaignIds:['702']})});
  assert.equal(h.a.access.resolve('avocado','direct').credential.token,TOKEN);
  assert.throws(()=>h.save('alvi',{config:config({campaignIds:['703']})}),{code:'BINDING_CHANGED'});
  assert.throws(()=>h.save('alvi',{config:config({externalLogin:'other-client'})}),{code:'BINDING_CHANGED'});
  assert.throws(()=>h.save('alvi',{config:config({currency:'EUR'})}),{code:'BINDING_CHANGED'});
  assert.equal(h.a.access.get('alvi','direct').revision,1);
  assert.throws(()=>h.save('alvi',{revision:0}),{code:'REVISION_CONFLICT'});
});

test('реальный путь адаптер → SQLite → отчёт хранит точный расход в микроединицах, период и настройки',async t=>{
  const h=harness(t);h.save();
  assert.equal(h.a.report('alvi',P.from,P.to).direct,null);
  assert.equal((await h.a.collect('alvi','direct',P)).collected,true);
  const snapshot=h.a.report('alvi',P.from,P.to).direct;
  assert.equal(snapshot.totalCostMicros,1234567890);assert.equal(snapshot.currency,'RUB');
  assert.equal(snapshot.moneyUnit,'micros');assert.equal(snapshot.includeVAT,false);
  assert.equal(snapshot.includeSubscriptionDiscount,true);assert.equal(snapshot.timezone,'Europe/Moscow');
  assert.equal(snapshot.periodClosed,true);assert.equal(snapshot.current,true);assert.deepEqual(snapshot.period,P);
  assert.equal(h.a.report('alvi','2026-10-02',P.to).direct,null);
  assert.equal(h.a.report('avocado',P.from,P.to).direct,null);
  assert.equal(h.a.report('alvi',P.from,P.to).economics.cac,null);
  assert.doesNotMatch(JSON.stringify(snapshot),/synthetic-direct-private/);
});

test('сбой API сохраняет предыдущий снимок и расход; отсутствие отчёта не заменяется нулём',async t=>{
  const h=harness(t);h.save();await h.a.collect('alvi','direct',P);
  h.respond=async()=>new Response('Unavailable',{status:429});
  const result=await h.a.collect('alvi','direct',P);
  assert.equal(result.collected,false);assert.equal(result.errorCode,'RATE_LIMITED');
  const saved=h.a.report('alvi',P.from,P.to);
  assert.equal(saved.direct.totalCostMicros,1234567890);
  assert.equal(saved.quality.checks.find(c=>c.id==='direct_snapshot').status,'attention');
  assert.equal(h.a.report('alvi','2026-10-05','2026-10-06').direct,null);
});

test('смена настроек во время запроса не позволяет старому писателю заменить данные',async t=>{
  const h=harness(t);h.save();await h.a.collect('alvi','direct',P);
  h.respond=async init=>{h.save('alvi',{config:config({includeVAT:true})});return report(init,'990000000');};
  const result=await h.a.collect('alvi','direct',P);
  assert.equal(result.collected,false);assert.equal(result.errorCode,'REVISION_CONFLICT');
  const snapshot=h.a.report('alvi',P.from,P.to).direct;
  assert.equal(snapshot.totalCostMicros,1234567890);assert.equal(snapshot.current,false);
});

test('аренда SQLite не допускает второго сбора одной компании',async t=>{
  const h=harness(t);h.save();let release,entered;
  const gotRequest=new Promise(r=>{entered=r;});
  h.respond=init=>new Promise(r=>{release=()=>r(report(init));entered();});
  const first=h.a.collect('alvi','direct',P);await gotRequest;
  const second=createRevenueAnalytics(h.db,{apiKey:'synthetic-at-rest-key',now:()=>h.time,adapters:h.adapters});
  assert.equal((await second.collect('alvi','direct',P)).busy,true);
  assert.equal(h.calls.length,1);release();assert.equal((await first).collected,true);
});

test('перезапуск сохраняет следующий срок, снимок и вызывает настоящий адаптер во втором плановом цикле',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'synapse-direct-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const filename=join(dir,'analytics.sqlite');
  let time=AT,calls=0;
  const make=db=>createRevenueAnalytics(db,{apiKey:'synthetic-persistence-key',now:()=>time,
    adapters:createRevenueAdapters({now:()=>time,fetchImpl:async(url,init)=>{calls++;return report(init,String(calls*1000000));}})});
  let db=new DatabaseSync(filename),a=make(db);
  a.save('alvi','direct',{revision:0,enabled:true,config:config(),credential:{token:TOKEN}});
  assert.equal((await a.collectDue())[0].collected,true);
  const expected={from:'2026-09-13',to:'2026-10-12'};
  assert.equal(a.report('alvi',expected.from,expected.to).direct.totalCostMicros,1000000);
  const next=a.status('alvi','direct').nextCheckAt;
  await a.stop();db.close();db=new DatabaseSync(filename);a=make(db);
  try {
    assert.equal(a.status('alvi','direct').nextCheckAt,next);assert.equal((await a.collectDue()).length,0);assert.equal(calls,2);
    assert.equal(a.report('alvi','2026-09-01','2026-10-12').direct.totalCostMicros,2000000);
    time+=3600001;assert.equal((await a.collectDue())[0].collected,true);assert.equal(calls,4);
    assert.equal(a.report('alvi',expected.from,expected.to).direct.totalCostMicros,3000000);
    assert.equal(a.report('alvi','2026-09-01','2026-10-12').direct.totalCostMicros,4000000);
  } finally {await a.stop();db.close();}
});

test('плановый период использует завершённые московские сутки; неподключённые источники не вызывают API',async t=>{
  const h=harness(t,{time:Date.parse('2026-10-12T20:00:00Z')});
  assert.deepEqual(await h.a.collectDue(),[]);assert.equal(h.calls.length,0);
  h.save();await h.a.collectDue();
  const dates=JSON.parse(h.calls[0].body).params.SelectionCriteria;
  assert.equal(dates.DateFrom,'2026-09-12');assert.equal(dates.DateTo,'2026-10-11');
  const snap=h.a.report('alvi',dates.DateFrom,dates.DateTo).direct;
  assert.equal(snap.periodClosed,true);assert.equal(snap.timezone,'Europe/Moscow');
});

test('чужая кампания не записывается в SQLite даже при HTTP200',async t=>{
  const h=harness(t);h.save();h.respond=async init=>report(init,'1000000','999');
  const result=await h.a.collect('alvi','direct',P);
  assert.equal(result.collected,false);assert.equal(result.errorCode,'PROFILE_CHANGED');
  assert.equal(h.a.report('alvi',P.from,P.to).direct,null);
});

test('ошибка исторической части не публикует частичный успех нового поколения',async t=>{
  const h=harness(t);h.save();await h.a.collectDue();
  h.time+=3600001;let count=0;
  h.respond=async init=>++count===1?report(init,'999000000'):new Response('Unavailable',{status:503});
  const result=(await h.a.collectDue())[0];assert.equal(result.collected,false);
  assert.equal(h.a.report('alvi','2026-09-13','2026-10-12').direct.totalCostMicros,1234567890);
  assert.equal(h.a.report('alvi','2026-09-01','2026-10-12').direct.totalCostMicros,1234567890);
});

test('штатная остановка прерывает ожидание офлайн-отчёта, успех и ноль не сохраняются',async t=>{
  const h=harness(t);h.save();let started;
  const pending=new Promise(r=>{started=r;});
  h.respond=async()=>{started();return new Response(null,{status:202,headers:{retryIn:'10'}});};
  const work=h.a.collect('alvi','direct',P);await pending;await h.a.stop();
  assert.equal((await work).errorCode,'CANCELLED');
  assert.equal(h.a.report('alvi',P.from,P.to).direct,null);assert.equal(h.calls.length,1);
});

test('владелец подключает Директ через существующий защищённый API; чужая роль не запускает сбор',async t=>{
  const h=harness(t);let role='owner';const replies=[];
  const handler=createRevenueHandler({analytics:h.a,companyModuleContext:()=>({company:{code:'alvi'},identity:{role}}),
    readJson:async req=>req.body,send:(res,status,body,headers)=>replies.push({status,body,headers})});
  await handler({method:'PUT',body:{revision:0,enabled:true,config:config(),credential:{token:TOKEN}}},{},new URL('https://synthetic.invalid/revenue-analytics/access?companyCode=alvi&provider=direct'));
  assert.equal(replies.at(-1).status,200);assert.doesNotMatch(JSON.stringify(replies),/synthetic-direct-private/);
  role='manager';await handler({method:'POST',body:P},{},new URL('https://synthetic.invalid/revenue-analytics/collect?companyCode=alvi&provider=direct'));
  assert.equal(replies.at(-1).status,403);assert.equal(h.calls.length,0);
});
