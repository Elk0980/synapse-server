'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createRevenueAnalytics,kopecks,attribution,dateTime}=require('./revenue-analytics');
const {createRevenueAdapters}=require('./revenue-analytics-adapters');
const {createRevenueHandler}=require('./revenue-analytics-http');
const {localDay}=require('./revenue-analytics-access');
const A='demo-a',B='demo-b',at='2026-10-08T08:00:00Z';
const config=(provider='yclients')=>({externalId:provider==='yclients'?'101':'201',historyFrom:'2026-09-01',timezone:'Asia/Irkutsk',...(provider==='yclients'?{cashRules:[{expenseId:'5',kind:'signed'},{expenseId:'6',kind:'refund'}]}:{goals:[{id:'301',label:'Заявка'}]})});
const credential=provider=>provider==='yclients'?{partnerToken:'synthetic-partner',userToken:'synthetic-user'}:{token:'synthetic-oauth'};
const rec=(v={})=>({id:1,company_id:101,visit_id:11,client:{id:21,name:'PRIVATE NAME',phone:'PRIVATE PHONE',email:'PRIVATE EMAIL'},create_date:'2026-10-02T16:00:00+0800',datetime:'2026-10-03T16:00:00+0800',last_change_date:'2026-10-03T17:00:00+0800',attendance:1,deleted:false,online:true,comment:'PRIVATE COMMENT',from_url:'https://example.test/?utm_source=2gis&utm_medium=paid_maps&utm_campaign=spa&utm_content=story',...v});
const tx=(v={})=>({id:101,record_id:1,visit_id:11,client:{id:21,phone:'PRIVATE PHONE'},expense:{id:5},date:'2026-10-03T17:00:00+0800',amount:'1000.10',...v});
const metrika=(c,r)=>({period:r,timezone:c.config.timezone,overview:{totals:[17,13,120.75,18,1.4],sampled:false},sources:{rows:[]},utm:{rows:[]},goals:[]});
function harness(t) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());let time=Date.parse(at);
  const data={records:[rec()],cash:[tx()],error:null,before:null,calls:[]};
  const adapters={ycPages:async(path,params,c,normalize)=>{
    data.calls.push({path,params});if(data.before)await data.before();if(data.error)throw Object.assign(Error('PRIVATE API RESPONSE '+c.partnerToken),{code:data.error});
    return structuredClone(path.includes('/records/')?data.records:data.cash).map(normalize);
  },metrika:async(c,r)=>{data.calls.push(r);if(data.before)await data.before();if(data.error)throw Object.assign(Error('SECRET'),{code:data.error});return metrika(c,r);},json:async()=>({success:true,data:rec()}),ycHeaders:()=>({})};
  const a=createRevenueAnalytics(db,{apiKey:'test-storage-key',now:()=>time,adapters});
  const save=(code=A,provider='yclients',extra={})=>a.save(code,provider,{revision:a.access.get(code,provider).revision,config:config(provider),credential:credential(provider),enabled:true,...extra});
  const report=(code=A,from='2026-10-01',to='2026-10-08')=>a.report(code,from,to);
  return {db,a,data,save,report,advance:n=>{time+=n;}};
}
test('повтор сбора не удваивает деньги; разные даты этапов и возврат сохраняются',async t=>{
  const h=harness(t);h.save();h.data.cash.push(tx({id:102,expense:{id:6},amount:'200.05',date:'2026-10-05T12:00:00+0800'}));
  for(let i=0;i<2;i++)assert.equal((await h.a.collect(A,'yclients')).collected,true);
  const y=h.report().yclients;assert.equal(y.createdBookings,1);assert.equal(y.attendedVisits,1);assert.equal(y.payingClients,1);assert.equal(y.paymentKopecks,100010);assert.equal(y.refundKopecks,20005);assert.equal(y.netCashKopecks,80005);assert.equal(y.bookingsWithSource,1);
  assert.equal(h.report(A,'2026-10-02','2026-10-02').yclients.attendedVisits,0);
  assert.equal(h.report(A,'2026-10-05','2026-10-05').yclients.netCashKopecks,-20005);
  const raw=JSON.stringify(h.db.prepare('SELECT * FROM revenue_records').all())+JSON.stringify(h.db.prepare('SELECT * FROM revenue_cash').all());
  for(const s of ['PRIVATE NAME','PRIVATE PHONE','PRIVATE EMAIL','PRIVATE COMMENT','example.test'])assert.ok(!raw.includes(s));
});
test('отмена, неявка и подтверждение не считаются посещением',async t=>{
  const h=harness(t);h.save();h.data.records=[rec({deleted:true}),rec({id:2,visit_id:12,attendance:-1}),rec({id:3,visit_id:13,attendance:2})];
  await h.a.collect(A,'yclients');const y=h.report().yclients;assert.equal(y.createdBookings,3);assert.equal(y.cancelledBookings,1);assert.equal(y.attendedVisits,0);assert.equal(y.noShows,1);
});
test('удалённая денежная операция исчезает из следующего полного снимка',async t=>{
  const h=harness(t);h.save();await h.a.collect(A,'yclients');h.data.cash=[];await h.a.collect(A,'yclients');assert.equal(h.report().yclients.paymentKopecks,0);
});
test('неизвестные статьи и неоднозначный visit_id не становятся рекламной выручкой',async t=>{
  const h=harness(t);h.save();h.data.records.push(rec({id:2,from_url:'',client:{id:22}}));
  h.data.cash=[tx({record_id:0}),tx({id:102,expense:{id:999}})];await h.a.collect(A,'yclients');
  const y=h.report().yclients;assert.equal(y.attendedVisits,1);assert.equal(y.unknownExpenseTransactions,1);assert.equal(y.unmatchedTransactions,1);assert.equal(y.paymentKopecks,100010);
  assert.equal(y.sources.find(s=>s.utm===null).paymentKopecks,100010);assert.equal(y.financialClassificationComplete,false);
});
test('противоречащий идентификатор клиента сохраняет оплату с неизвестным источником',async t=>{
  const h=harness(t);h.save();h.data.cash=[tx({client:{id:22}})];await h.a.collect(A,'yclients');assert.equal(h.report().yclients.unmatchedTransactions,1);
});
test('отказ источника сохраняет прошлые числа и последний успех',async t=>{
  const h=harness(t);h.save();await h.a.collect(A,'yclients');const old=h.report().state.providers[1].lastSuccess;
  h.advance(86400000);h.data.error='ACCESS_DENIED';const result=await h.a.collect(A,'yclients');assert.equal(result.collected,false);assert.equal(result.errorCode,'ACCESS_DENIED');assert.equal(h.report().yclients.paymentKopecks,100010);assert.equal(h.report().state.providers[1].lastSuccess,old);
  assert.ok(!JSON.stringify(result).includes('synthetic-partner'));assert.ok(!JSON.stringify(result).includes('PRIVATE API'));
});
test('изменение ревизии во время запроса не принимает устаревшие данные',async t=>{
  const h=harness(t);h.save();let once=false;h.data.before=async()=>{if(!once){once=true;h.save(A,'yclients',{credential:{partnerToken:'new-partner',userToken:'new-user'}});}};
  const r=await h.a.collect(A,'yclients');assert.equal(r.collected,false);assert.equal(r.errorCode,'REVISION_CONFLICT');assert.equal(h.report().yclients,null);
});
test('аренда не допускает второго писателя и восстанавливается после истечения',async t=>{
  const h=harness(t);h.save();h.db.prepare('UPDATE revenue_jobs SET lease=?,lease_until=? WHERE company=? AND provider=?').run('other',Date.parse(at)+1000,A,'yclients');
  assert.equal((await h.a.collect(A,'yclients')).busy,true);assert.equal(h.data.calls.length,0);h.advance(1001);assert.equal((await h.a.collect(A,'yclients')).collected,true);
});
test('утративший аренду писатель не записывает результат',async t=>{
  const h=harness(t);h.save();h.data.before=async()=>{h.db.prepare('UPDATE revenue_jobs SET lease=?').run('other');};
  const r=await h.a.collect(A,'yclients');assert.equal(r.errorCode,'LEASE_LOST');assert.equal(h.report().yclients,null);
});
test('подключения шифруются, компании изолированы, смена внешней привязки запрещена',async t=>{
  const h=harness(t);h.save();await h.a.collect(A,'yclients');h.save(B);assert.equal(h.report(B).yclients,null);
  const raw=JSON.stringify(h.db.prepare('SELECT * FROM revenue_access').all());assert.ok(!raw.includes('synthetic-partner'));assert.ok(!JSON.stringify(h.a.settings(A)).includes('synthetic-user'));
  assert.throws(()=>h.save(A,'yclients',{config:{...config(),externalId:'102'}}),{code:'BINDING_CHANGED'});
  assert.throws(()=>h.save(A,'yclients',{revision:0}),{code:'REVISION_CONFLICT'});
  const clients=h.db.prepare('SELECT payload FROM revenue_records').all().map(r=>JSON.parse(r.payload).client);assert.notEqual(clients[0],'21');
});
test('серверное расписание сохраняется и не повторяет сбор до срока',async t=>{
  const h=harness(t);h.save();await h.a.collectDue();const n=h.data.calls.length;await h.a.collectDue();assert.equal(h.data.calls.length,n);h.advance(86400001);await h.a.collectDue();assert.ok(h.data.calls.length>n);
  assert.ok(h.data.calls.at(-2).params.changed_after.includes('T'));assert.equal(h.data.calls[0].params.with_deleted,1);
});
test('Метрика сохраняет цельные итоги периода, не складывая уникальных посетителей',async t=>{
  const h=harness(t);h.save(A,'metrika');await h.a.collect(A,'metrika');const r=h.report(A,'2026-10-02','2026-10-08');
  assert.equal(r.metrika.overview.totals[1],13);assert.equal(r.metrika.overview.totals[2],120.75);assert.equal(r.economics.cac,null);assert.equal(h.report(B).metrika,null);
  h.data.error='INCOMPLETE';await h.a.collect(A,'metrika');assert.equal(h.report(A,'2026-10-02','2026-10-08').metrika.overview.totals[0],17);
});
test('часовой пояс применяется к локальному времени и финансовой дате',()=>{
  assert.equal(dateTime('2026-10-08 00:05:00','Asia/Irkutsk'),'2026-10-07T16:05:00.000Z');
  assert.equal(localDay(Date.parse('2026-10-07T16:05:00Z'),'Asia/Irkutsk'),'2026-10-08');
  assert.equal(kopecks('12.01'),1201);assert.equal(kopecks('-0.01'),-1);assert.throws(()=>kopecks('0.001'));
  assert.deepEqual(attribution('https://example.test/?utm_source=2gis&utm_term=79000000000&utm_content=me%40example.test'),{source:'2gis'});
});
test('две разные метки одного визита не назначаются одному источнику',async t=>{
  const h=harness(t);h.save();h.data.records.push(rec({id:2,from_url:'https://example.test/?utm_source=yandex'}));
  await h.a.collect(A,'yclients');const y=h.report().yclients;assert.equal(y.attendedVisits,1);assert.equal(y.sources.find(s=>s.utm===null).attendedVisits,1);
});
test('ошибка финансовой страницы не сохраняет половину нового поколения',async t=>{
  const h=harness(t);h.save();await h.a.collect(A,'yclients');h.data.records=[rec({id:2})];
  h.a.access.resolve(A,'yclients');let n=0;h.data.before=async()=>{if(++n===2)h.data.error='INCOMPLETE';};
  assert.equal((await h.a.collect(A,'yclients')).errorCode,'INCOMPLETE');assert.equal(h.report().yclients.createdBookings,1);
  assert.equal(JSON.parse(h.db.prepare('SELECT payload FROM revenue_records').get().payload).id,'1');
});
test('остановка дожидается активной записи и запрещает новые задания',async t=>{
  const h=harness(t);h.save();let release;const pending=new Promise(r=>{release=r;});h.data.before=()=>pending;
  const work=h.a.collect(A,'yclients'),stopped=h.a.stop();await assert.rejects(h.a.collect(A,'yclients'),{code:'SERVER_STOPPING'});
  release();await stopped;await work;assert.deepEqual(await h.a.collectDue(),[]);
});
test('адаптер проверяет принадлежность пустой выгрузки YCLIENTS',async()=>{
  let valid=false;const a=createRevenueAdapters({wait:async()=>{},fetchImpl:async()=>Response.json({success:true,data:[{id:valid?101:999}]})});
  await assert.rejects(a.verifyYclients({config:config(),credential:credential('yclients')}),{code:'PROFILE_CHANGED'});valid=true;
  await a.verifyYclients({config:config(),credential:credential('yclients')});
});
test('контакты, целые URL и слишком длинные метки из Метрики не сохраняются',async()=>{
  const a=createRevenueAdapters({wait:async()=>{},fetchImpl:async url=>{const q=url.searchParams,n=q.get('metrics').split(',').length;
    return Response.json({query:{date1:q.get('date1'),date2:q.get('date2'),metrics:q.get('metrics').split(',')},totals:Array(n).fill(1),data:[{metrics:Array(n).fill(1),dimensions:[{id:'private@example.test',name:'https://example.test/?phone=79000000000'}]}],total_rows:1});}});
  const r=await a.metrika({config:config('metrika'),credential:credential('metrika')},{from:'2026-10-01',to:'2026-10-08'});
  assert.ok(!JSON.stringify(r).includes('private@example.test'));assert.ok(!JSON.stringify(r).includes('79000000000'));
});
test('адаптер требует полную пагинацию; повтор страницы и изменившийся итог — отказ',async()=>{
  const b={success:true,data:[{id:1}],meta:{total_count:2}};let calls=0;
  const a=createRevenueAdapters({wait:async()=>{},fetchImpl:async()=>{calls++;return Response.json(b);}});
  await assert.rejects(a.ycPages('/api/v1/records/101',{},credential('yclients')),{code:'INCOMPLETE'});assert.equal(calls,2);
});
test('адаптер YCLIENTS использует документированные заголовки, пагинацию и только GET',async()=>{
  const calls=[];const a=createRevenueAdapters({wait:async()=>{},fetchImpl:async(url,o)=>{calls.push({url:String(url),o});return Response.json({success:true,data:[{id:1}],meta:{total_count:1}});}});
  await a.ycPages('/api/v1/records/101',{with_deleted:1},credential('yclients'));assert.equal(calls[0].o.method,'GET');assert.equal(calls[0].o.redirect,'error');assert.equal(calls[0].o.headers.Authorization,'Bearer synthetic-partner, User synthetic-user');assert.equal(calls[0].o.headers.Accept,'application/vnd.yclients.v2+json');
});
test('исчезнувший или изменённый total_count не превращает неполную историю в успех',async()=>{
  for(const next of [undefined,3]){let n=0;
    const a=createRevenueAdapters({wait:async()=>{},fetchImpl:async()=>Response.json({success:true,data:[{id:++n}],meta:n===1?{total_count:2}:next===undefined?{}:{total_count:next}})});
    await assert.rejects(a.ycPages('/api/v1/records/101',{},credential('yclients')),{code:'INCOMPLETE'});
  }
});
test('адаптер Метрики проверяет период, цели, метрики и неполную таблицу',async()=>{
  const calls=[];let incomplete=false;
  const a=createRevenueAdapters({wait:async()=>{},fetchImpl:async(url)=>{
    calls.push(String(url));const q=url.searchParams;const n=q.get('metrics').split(',').length;
    return Response.json({query:{date1:q.get('date1'),date2:q.get('date2'),metrics:q.get('metrics').split(',')},totals:Array(n).fill(2),data:[{metrics:Array(n).fill(2),dimensions:[]}],total_rows:incomplete?20:1,sampled:false});
  }});
  const result=await a.metrika({config:config('metrika'),credential:credential('metrika')},{from:'2026-10-01',to:'2026-10-08'});
  assert.equal(result.goals[0].reaches,2);assert.ok(calls.some(s=>new URL(s).searchParams.get('metrics')==='ym:s:goal301visits,ym:s:goal301reaches,ym:s:goal301conversionRate'));
  assert.equal(new URL(calls[0]).searchParams.get('timezone'),'+08:00');incomplete=true;await assert.rejects(a.metrika({config:config('metrika'),credential:credential('metrika')},{from:'2026-10-01',to:'2026-10-08'}),{code:'INCOMPLETE'});
});
test('чужой хост, редирект и секрет в ответе ошибки не допускаются',async()=>{
  let calls=0;const a=createRevenueAdapters({wait:async()=>{},fetchImpl:async()=>{calls++;return new Response('SECRET',{status:401});}});
  await assert.rejects(a.json(new URL('https://evil.test'),{}),{code:'BAD_ENDPOINT'});assert.equal(calls,0);
  await assert.rejects(a.ycPages('/api/v1/records/101',{},credential('yclients')),e=>e.code==='ACCESS_DENIED'&&!e.message.includes('SECRET'));assert.equal(calls,1);
});
test('HTTP: чтение analytics.view, настройки только владельцу, company scope и no-store',async t=>{
  const h=harness(t);let owner=false;const scopes=[];
  const handler=createRevenueHandler({analytics:h.a,readJson:async r=>r.body,send:(r,status,body,headers)=>Object.assign(r,{status,body,headers}),companyModuleContext:(r,c,p)=>{scopes.push({c,p});if(c!==A)throw Object.assign(Error('Denied'),{status:403});return {company:{code:c},identity:{role:owner?'owner':'editor'}};}});
  async function call(method,path,b=null){const out={};await handler({method,body:b},out,new URL('https://test'+path),{});return out;}
  assert.equal((await call('GET','/revenue-analytics?companyCode=demo-a&from=2026-10-01&to=2026-10-08')).headers['cache-control'],'no-store');
  assert.equal(scopes[0].p,'analytics.view');assert.equal((await call('PUT','/revenue-analytics/access?companyCode=demo-a&provider=yclients',{})).status,403);
  assert.equal(scopes[1].p,'crm.edit');owner=true;
  assert.equal((await call('PUT','/revenue-analytics/access?companyCode=demo-a&provider=yclients',{revision:0,config:config(),credential:credential('yclients'),enabled:true})).status,200);
  assert.equal((await call('GET','/revenue-analytics?companyCode=demo-a&from=bad&to=bad')).status,400);
  await assert.rejects(call('GET','/revenue-analytics?companyCode=demo-b&from=2026-10-01&to=2026-10-08'),{status:403});
});
