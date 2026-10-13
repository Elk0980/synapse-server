'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join,resolve,relative}=require('node:path');
const {createRevenueAnalytics}=require('./revenue-analytics');
const {createRevenueHandler}=require('./revenue-analytics-http');
const AT=Date.parse('2026-11-20T02:00:00Z'),P={from:'2026-10-01',to:'2026-10-31'};
const config={externalId:'101',historyFrom:'2026-01-01',timezone:'Asia/Irkutsk',cashRules:[{expenseId:'5',kind:'payment'},{expenseId:'6',kind:'refund'}]};
const ev=kind=>({kind,reference:'synthetic-proof-'+kind,confirmedAt:'2026-11-19T00:00:00.000Z'});
function facts(code='demo-a') {
  return {companyCode:code,vatMode:'no_vat',paymentHistory:{companyCode:code,noPaymentsBefore:'2026-01-01',evidence:ev('owner_confirmed_opening_date')},
    leadBindings:[{companyCode:code,recordId:'1',leadId:'lead_synthetic_1',firstTouch:{source:'yandex',campaign:'spa',at:'2026-10-02T01:00:00Z'},evidence:ev('server_lead_record_link')}],
    spend:{companyCode:code,from:P.from,to:P.to,providers:['yandex_direct'],evidence:ev('owner_confirmed'),
      facts:[{companyCode:code,id:'synthetic-oct-spend',provider:'yandex_direct',campaignId:'701',accountScope:'company',kind:'spend',serviceFrom:P.from,serviceTo:P.to,
        amountKopecks:40000,currency:'RUB',vatMode:'no_vat',timezone:'Asia/Irkutsk',allocations:null,evidence:ev('ad_cabinet_export')}],
      campaigns:[{companyCode:code,provider:'yandex_direct',campaignId:'701',utm:{source:'yandex',campaign:'spa'},evidence:ev('ad_cabinet_export')}]},
    recordCosts:[{companyCode:code,recordId:'1',costKopecks:30000,currency:'RUB',vatMode:'no_vat',evidence:ev('accounting_ledger')}]};
}
function harness(t,cohortFacts=null) {
  const h={time:AT,record:{id:1,visit_id:501,client:{id:1},company_id:101,create_date:'2026-10-02T10:00:00+08:00',
    datetime:'2026-11-03T10:00:00+08:00',last_change_date:'2026-11-03T12:00:00+08:00',attendance:1,deleted:false,
    from_url:'https://synthetic.invalid/?utm_source=yandex&utm_campaign=spa',online:true},
    cash:[{id:10,record_id:1,visit_id:501,client:{id:1},company_id:101,date:'2026-11-03T12:00:00+08:00',amount:'1000.00',expense:{id:5},deleted:false},
      {id:11,record_id:1,visit_id:501,client:{id:1},company_id:101,date:'2026-11-12T12:00:00+08:00',amount:'200.00',expense:{id:6},deleted:false}]};
  h.db=new DatabaseSync(':memory:');t.after(()=>h.db.close());
  h.a=createRevenueAnalytics(h.db,{apiKey:'synthetic-cohort-storage-key',now:()=>h.time,cohortFacts,
    adapters:{verifyYclients:async()=>{},ycPages:async(path,query,key,normalize)=>(path.includes('/records/')?[h.record]:h.cash).map(normalize)}});
  h.save=extra=>h.a.save('demo-a','yclients',{revision:h.a.access.get('demo-a','yclients').revision,config,enabled:true,
    credential:{partnerToken:'synthetic-partner',userToken:'synthetic-user'},...extra});
  h.report=()=>h.a.report('demo-a',P.from,P.to,{observationTo:'2026-11-15'});
  h.save();return h;
}

test('внутренний журнал остаётся отдельным scoped фактом, не повышает firstTouch/economics и не возвращаетPII',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let mode='valid';
 const a=createRevenueAnalytics(db,{apiKey:'synthetic-journal-key',now:()=>AT,adapters:{},leadJournal:ctx=>{
  if(mode==='promise')return Promise.resolve({});
  if(mode==='false')return false;
  if(mode==='undefined')return undefined;
  return {companyCode:mode==='foreign'?'demo-b':ctx.companyCode,period:{from:ctx.from,to:ctx.to,timezone:mode==='period'?'UTC':ctx.timezone},
   writer:{status:'active',since:'2026-10-01T00:00:00Z',fullPeriodCovered:false,secret:'synthetic-do-not-return'},completeness:'partial',reasons:['writer_coverage_gap'],
   knownReceiptCounts:{total:2,created:1,deduplicated:1},countsAreLowerBound:true,legacyLeadRowsCount:1,
   firstTouch:'verified',nativeLinks:'verified',economics:'verified',names:['synthetic-person-private'],contacts:['private@synthetic.invalid']};
 }});
 const report=a.report('demo-a',P.from,P.to);assert.equal(report.leadJournal.knownReceiptCounts.total,2);assert.equal(report.leadJournal.firstTouch,'unknown');assert.equal(report.economics.cac,null);
 assert.equal(report.leadJournal.nativeLinks,'missing');assert.equal(report.leadJournal.countsAreLowerBound,true);assert.equal(JSON.stringify(report).includes('synthetic-person-private'),false);assert.equal(JSON.stringify(report).includes('synthetic-do-not-return'),false);
 for(const [value,code] of [['foreign','FOREIGN_COMPANY'],['period','COHORT_CONTEXT_INVALID'],['promise','COHORT_CONTEXT_INVALID'],['false','COHORT_CONTEXT_INVALID'],['undefined','COHORT_CONTEXT_INVALID']]){mode=value;assert.throws(()=>a.report('demo-a',P.from,P.to),{code})}
 mode='valid';assert.equal(a.report('demo-a',P.from,P.to).leadJournal.legacyLeadRowsCount,1);
});

test('выбранная Москва объединяет UTC-native YCLIENTS с московским расходом, исходный календарь не переименован',async t=>{
 let context;const h=harness(t,ctx=>{
  context=ctx;const value=facts(ctx.companyCode);value.leadBindings[0].firstTouch.at='2026-10-31T17:00:00Z';value.spend.facts[0].timezone='Europe/Moscow';return value;
 });
 h.record.create_date='2026-10-31T17:30:00Z';await h.a.collect('demo-a','yclients');
 const report=h.a.report('demo-a',P.from,P.to,{observationTo:'2026-11-15',analysisTimezone:'Europe/Moscow'});
 assert.equal(context.timezone,'Europe/Moscow');assert.equal(report.calendarBasis.analysisTimezone,'Europe/Moscow');assert.equal(report.calendarBasis.nativeYclientsTimezone,'Asia/Irkutsk');
 assert.equal(report.yclients.timezone,'Asia/Irkutsk');assert.equal(report.yclients.createdBookings,0);
 assert.equal(report.cohorts.calendar.createdBookings,1);assert.equal(report.cohorts.cohortTotals.newPayingClients.value,1);assert.equal(report.economics.cac,400);assert.equal(report.economics.romi,25);
 assert.equal(report.cohorts.timeBasis.nativeTimezone,'Asia/Irkutsk');assert.equal(report.cohorts.timeBasis.bounds.cohortFromUtc,'2026-09-30T21:00:00.000Z');
 assert.equal(h.a.access.get('demo-a','yclients').config.timezone,'Asia/Irkutsk');
});

test('наблюдение по умолчанию не расширяет native покрытие на пять московских часов',async t=>{
 const h=harness(t,ctx=>{const value=facts(ctx.companyCode);value.spend.facts[0].timezone='Europe/Moscow';return value});h.time=Date.parse('2026-11-15T22:00:00Z');await h.a.collect('demo-a','yclients');
 const report=h.a.report('demo-a',P.from,P.to,{analysisTimezone:'Europe/Moscow'});assert.equal(report.cohorts.cohort.observationTo,'2026-11-14');assert.equal(report.economics.cac,400);
 const beyond=h.a.report('demo-a',P.from,P.to,{analysisTimezone:'Europe/Moscow',observationTo:'2026-11-15'});assert.equal(beyond.economics.cac,null);assert.equal(beyond.cohorts.timeBasis.nativeCoverage.observationEndGap,true);
 assert.ok(beyond.cohorts.economics.cac.reasons.some(r=>r.code==='PERIOD_NOT_CLOSED'));assert.equal(beyond.cohorts.cohortTotals.activity.status,'partial');assert.equal(beyond.cohorts.cohortTotals.activity.netKopecks,80000);
});

test('HTTP календарь контекстен: Москва допускается, пустой/неизвестный пояс отклоняется и не подтверждает VAT/history',async t=>{
 const h=harness(t);await h.a.collect('demo-a','yclients');let answer;
 const handler=createRevenueHandler({analytics:h.a,companyModuleContext:()=>({company:{code:'demo-a'},identity:{role:'employee'}}),readJson:async()=>assert.fail('GET не читает тело'),send:(_r,status,body)=>{answer={status,body}}});
 const base='https://synthetic.invalid/revenue-analytics?companyCode=demo-a&from=2026-10-01&to=2026-10-31';
 await handler({method:'GET'},{},new URL(base+'&analysisTimezone=Europe%2FMoscow&vatMode=no_vat&paymentHistory=verified'));assert.equal(answer.status,200);assert.equal(answer.body.cohorts.scope.timezone,'Europe/Moscow');assert.equal(answer.body.cohorts.scope.vatMode,'unknown');assert.equal(answer.body.economics.cac,null);
 for(const tz of ['','Europe%2FBerlin','%3Cscript%3E']){await handler({method:'GET'},{},new URL(base+'&analysisTimezone='+tz));assert.equal(answer.status,400);assert.equal(answer.body.code,'BAD_TIMEZONE')}
 await handler({method:'GET'},{},new URL(base));assert.equal(answer.status,200);assert.equal(answer.body.cohorts.scope.timezone,'Asia/Irkutsk');
});

test('SQL report использует нормализатор и поздние реальные поля API, отделяя календарь от когорты',async t=>{
  const h=harness(t,({companyCode})=>facts(companyCode));await h.a.collect('demo-a','yclients');
  const report=h.report();assert.equal(report.yclients.paymentKopecks,0);
  assert.equal(report.cohorts.cohort.basis,'server_bound_first_touch_local_day');
  assert.equal(report.cohorts.cohort.observationTo,'2026-11-15');
  assert.equal(report.cohorts.cohortTotals.newPayingClients.value,1);
  assert.equal(report.cohorts.cohortTotals.activity.paymentKopecks,100000);
  assert.equal(report.cohorts.cohortTotals.activity.refundKopecks,20000);
  assert.equal(report.cohorts.economics.cac.valueKopecks,40000);assert.equal(report.cohorts.economics.romi.basisPoints,2500);
  assert.equal(report.economics.cac,400);assert.equal(report.economics.romi,25);
  assert.equal(report.quality.checks.find(c=>c.id==='economics').status,'ok');
  assert.doesNotMatch(JSON.stringify(report.cohorts),/synthetic-partner|synthetic-user|client.*[a-f0-9]{64}/);
});

test('без внутреннего источника доказательств деньги известны по календарю, новые клиенты/НДС/экономика неизвестны',async t=>{
  const h=harness(t);await h.a.collect('demo-a','yclients');const report=h.report();
  assert.equal(report.cohorts.scope.vatMode,'unknown');assert.equal(report.cohorts.cohortTotals.newPayingClients.value,null);
  assert.equal(report.cohorts.calendar.firstObservedPayers,0);assert.equal(report.economics.cac,null);assert.equal(report.economics.romi,null);
  assert.match(report.economics.reason,/НДС.*не подтверждён/);
});

test('устаревшая или ошибочная выгрузка не разрешает экономику даже с подтверждёнными injected facts',async t=>{
  const h=harness(t,()=>facts());await h.a.collect('demo-a','yclients');
  h.db.prepare("UPDATE revenue_jobs SET error_code='UPSTREAM_ERROR' WHERE company='demo-a' AND provider='yclients'").run();
  assert.equal(h.report().economics.cac,null);assert.equal(h.report().cohorts.coverage.status,'unavailable');
  h.db.prepare("UPDATE revenue_jobs SET error_code='' WHERE company='demo-a' AND provider='yclients'").run();
  h.time+=31*3600000;assert.equal(h.report().economics.cac,null);
  assert.equal(h.report().cohorts.source.yclients.current,false);
});

test('смена правил сохраняет старые строки, но они не пересчитываются как проверенная когорта',async t=>{
  const h=harness(t,()=>facts());await h.a.collect('demo-a','yclients');h.save({config:{...config,cashRules:[{expenseId:'5',kind:'exclude'}]}});
  assert.equal(h.report().cohorts.cohortTotals.activity.paymentKopecks,null);assert.equal(h.report().economics.cac,null);
  assert.equal(h.db.prepare('SELECT count(*) n FROM revenue_cash').get().n,2);
});

test('факты другой компании отклоняются; rollback чтения оставляет возможность следующего запроса',async t=>{
  let foreign=true;const h=harness(t,({companyCode})=>facts(foreign&&companyCode==='demo-a'?'demo-b':companyCode));await h.a.collect('demo-a','yclients');
  assert.throws(h.report,{code:'FOREIGN_COMPANY'});foreign=false;assert.equal(h.report().economics.cac,400);
  assert.equal(h.a.report('demo-b',P.from,P.to).cohorts.coverage.status,'unavailable');
});

test('HTTP выбирает observationTo, но публичные параметры не создают proof или полную историю',async t=>{
  const h=harness(t);await h.a.collect('demo-a','yclients');let answer;
  const handler=createRevenueHandler({analytics:h.a,companyModuleContext:()=>({company:{code:'demo-a'},identity:{role:'employee'}}),
    readJson:async()=>{throw new Error('GET не читает тело');},send:(response,status,body,headers)=>{answer={status,body,headers};}});
  await handler({method:'GET'},{},new URL('https://synthetic.invalid/revenue-analytics?companyCode=demo-a&from=2026-10-01&to=2026-10-31&observationTo=2026-11-15&paymentHistory=verified&vatMode=no_vat'));
  assert.equal(answer.status,200);assert.equal(answer.body.cohorts.cohort.observationTo,'2026-11-15');
  assert.equal(answer.body.cohorts.scope.vatMode,'unknown');assert.equal(answer.body.economics.cac,null);
  assert.equal(answer.headers['cache-control'],'no-store');
  await handler({method:'GET'},{},new URL('https://synthetic.invalid/revenue-analytics?companyCode=demo-a&from=2026-10-01&to=2026-10-31&observationTo=2026-10-07'));
  assert.equal(answer.status,400);assert.equal(answer.body.code,'BAD_PERIOD');
});

test('сбор не нормализует несуществующий день в деньги следующего месяца',async t=>{
  const h=harness(t);h.record.create_date='2026-02-30T10:00:00+08:00';
  const result=await h.a.collect('demo-a','yclients');assert.equal(result.collected,false);assert.equal(result.errorCode,'RESPONSE_UNCERTAIN');
  assert.equal(h.db.prepare('SELECT count(*) n FROM revenue_records').get().n,0);
});

test('суммирование безопасных отдельных платежей не выдаёт переполненный денежный итог',async t=>{
  const h=harness(t);await h.a.collect('demo-a','yclients');
  const transaction=JSON.parse(h.db.prepare('SELECT payload FROM revenue_cash WHERE id=?').get('10').payload);
  transaction.at='2026-10-03T01:00:00Z';transaction.amount=Number.MAX_SAFE_INTEGER;
  h.db.prepare('UPDATE revenue_cash SET payload=? WHERE id=?').run(JSON.stringify(transaction),'10');
  transaction.id='12';h.db.prepare('INSERT INTO revenue_cash VALUES(?,?,?)').run('demo-a','12',JSON.stringify(transaction));
  assert.throws(h.report,{code:'MONEY_OVERFLOW'});
});

test('второй SQLite писатель во время чтения не смешивает поколения денег и внутренних фактов',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'synapse-cohort-read-')),file=join(dir,'facts.sqlite');
  const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL');const writer=new DatabaseSync(file);
  t.after(()=>{writer.close();db.close();const rel=relative(resolve(tmpdir()),resolve(dir));assert.ok(rel&&!rel.startsWith('..')&&!rel.includes(':')&&rel.startsWith('synapse-cohort-read-'));rmSync(dir,{recursive:true,force:true});});
  let changed=false;
  const a=createRevenueAnalytics(db,{apiKey:'synthetic-snapshot-key',now:()=>AT,adapters:{},cohortFacts:()=>{
    if(!changed){changed=true;const value=JSON.parse(writer.prepare('SELECT payload FROM revenue_cash').get().payload);value.amount=200000;
      writer.prepare('UPDATE revenue_cash SET payload=?').run(JSON.stringify(value));}
    return null;
  }});
  a.save('demo-a','yclients',{revision:0,config,enabled:true,credential:{partnerToken:'synthetic-partner',userToken:'synthetic-user'}});
  db.prepare('UPDATE revenue_jobs SET last_success=?,success_revision=?,history_from=? WHERE company=? AND provider=?').run(new Date(AT).toISOString(),1,config.historyFrom,'demo-a','yclients');
  const record={id:'1',visitId:'501',client:'a'.repeat(64),createdAt:'2026-10-02T01:00:00Z',visitAt:'2026-10-03T01:00:00Z',changedAt:'2026-10-03T01:00:00Z',attendance:1,deleted:false,utm:{},online:true};
  db.prepare('INSERT INTO revenue_records VALUES(?,?,?)').run('demo-a','1',JSON.stringify(record));
  db.prepare('INSERT INTO revenue_cash VALUES(?,?,?)').run('demo-a','10',JSON.stringify({id:'10',recordId:'1',visitId:'501',client:'a'.repeat(64),at:'2026-10-03T01:00:00Z',amount:100000,expenseId:'5',deleted:false}));
  const first=a.report('demo-a',P.from,P.to);assert.equal(first.yclients.paymentKopecks,100000);assert.equal(first.cohorts.calendar.paymentKopecks,100000);
  const next=a.report('demo-a',P.from,P.to);assert.equal(next.yclients.paymentKopecks,200000);assert.equal(next.cohorts.calendar.paymentKopecks,200000);
});
