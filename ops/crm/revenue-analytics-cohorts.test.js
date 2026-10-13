'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {buildRevenueCohorts,closedAnalysisDay}=require('./revenue-analytics-cohorts');
const A='demo-a',B='demo-b';
// Синтетические статьи только для тестов. Настоящие cashRules задаёт владелец по подтверждённым статьям YCLIENTS.
const PAY='900001',REFUND='900002';
const config=()=>({externalId:'101',historyFrom:'2026-01-01',timezone:'Asia/Irkutsk',cashRules:[{expenseId:PAY,kind:'payment'},{expenseId:REFUND,kind:'refund'}]});
const client=n=>crypto.createHmac('sha256','test-storage-key').update('revenue-client/v1/'+A+'/'+n).digest('hex');
const iso=s=>new Date(s).toISOString();
// Касание по умолчанию: 2 октября 09:00 по Иркутску, за час до создания записи.
const T=iso('2026-10-02T09:00:00+08:00');
const rec=(n,v={})=>({id:String(n),visitId:String(n+1000),client:client(1),createdAt:iso('2026-10-02T10:00:00+08:00'),visitAt:iso('2026-10-03T10:00:00+08:00'),
  changedAt:iso('2026-10-03T12:00:00+08:00'),attendance:1,deleted:false,utm:{source:'yandex',medium:'cpc',campaign:'spa'},online:true,...v});
const pay=(n,v={})=>({id:String(n),recordId:'1',visitId:'1001',client:client(1),at:iso('2026-10-03T12:00:00+08:00'),amount:100000,expenseId:PAY,deleted:false,...v});
const ev=kind=>({kind,reference:'synthetic-'+kind,confirmedAt:'2026-10-12T00:00:00Z'});
const snapshot=(records,cash,v={})=>({companyCode:A,current:true,collectedAt:'2026-11-20T00:00:00.000Z',historyFrom:'2026-01-01',config:config(),records,cash,...v});
const input=(y,v={})=>({companyCode:A,cohort:{from:'2026-10-01',to:'2026-10-31'},observationTo:'2026-11-15',timezone:'Asia/Irkutsk',currency:'RUB',vatMode:'no_vat',yclients:y,
  paymentHistory:{companyCode:A,noPaymentsBefore:'2026-01-01',evidence:ev('owner_confirmed_opening_date')},...v});
const has=(m,code)=>m.reasons.some(r=>r.code===code);
const touchRow=(out,source)=>out.rows.find(r=>r.basis==='first_touch'&&r.attribution?.source===source);
const fact=(id,provider,campaignId,amountKopecks,v={})=>({companyCode:A,id,provider,campaignId,accountScope:'company',kind:'spend',serviceFrom:'2026-10-01',serviceTo:'2026-10-31',
  amountKopecks,currency:'RUB',vatMode:'no_vat',timezone:'Asia/Irkutsk',allocations:null,evidence:ev('ad_cabinet_export'),...v});
const campaign=(provider,campaignId,source,name)=>({companyCode:A,provider,campaignId,utm:{source,campaign:name},evidence:ev('ad_cabinet_export')});
// Синтетическая серверная связь. Это фикстура формата, а не доказательство работающей интеграции журнала заявок.
const bind=(recordId,source,name,at,kind='server_lead_record_link',lead)=>({companyCode:A,recordId,
  leadId:kind==='server_lead_record_link'?lead||'lead_synthetic_'+recordId:null,firstTouch:{source,campaign:name,at},evidence:ev(kind)});
const cost=(recordId,costKopecks)=>({companyCode:A,recordId,costKopecks,currency:'RUB',vatMode:'no_vat',evidence:ev('accounting_ledger')});
const spendFor=(from,to,amount)=>({companyCode:A,from,to,providers:['yandex_direct'],evidence:ev('owner_confirmed'),
  facts:[fact('synthetic-direct-'+from,'yandex_direct','701',amount,{serviceFrom:from,serviceTo:to})],campaigns:[campaign('yandex_direct','701','yandex','spa')]});
const NOV={cohort:{from:'2026-11-01',to:'2026-11-14'},observationTo:'2026-11-15'};
// Выгрузка в другом native поясе и дневной расход Директа в московских сутках (синтетика формата, не живая выгрузка).
const cfg=v=>({...config(),...v});
const MSK='Europe/Moscow',IRK='Asia/Irkutsk';
const mskSpend=(from,to,amount)=>{const s=spendFor(from,to,amount);s.facts[0].timezone=MSK;return s;};

// Полная синтетическая цепочка: заявка → запись → посещение → оплата → возврат, расходы и себестоимость.
function fullFlow() {
  const records=[
    rec(1),
    rec(2,{client:client(2),utm:{source:'2gis',medium:'maps',campaign:'maps'},createdAt:iso('2026-10-09T10:00:00+08:00'),visitAt:iso('2026-10-10T10:00:00+08:00')}),
    rec(3,{client:client(3),utm:{},online:false,createdAt:iso('2026-10-19T10:00:00+08:00'),visitAt:iso('2026-10-20T10:00:00+08:00')})
  ];
  const cash=[
    pay(10,{amount:300000}),
    pay(11,{recordId:'2',visitId:'1002',client:client(2),amount:200000,at:iso('2026-10-10T12:00:00+08:00')}),
    pay(12,{recordId:'3',visitId:'1003',client:client(3),amount:100000,at:iso('2026-10-20T12:00:00+08:00')}),
    pay(13,{expenseId:REFUND,amount:50000,at:iso('2026-11-02T12:00:00+08:00')})
  ];
  return input(snapshot(records,cash),{
    leadBindings:[bind('1','yandex','spa','2026-10-01T09:00:00.000Z'),bind('2','2gis','maps','2026-10-08T09:00:00.000Z'),
      bind('3','offline',null,iso('2026-10-19T10:00:00+08:00'),'server_record_origin')],
    spend:{companyCode:A,from:'2026-10-01',to:'2026-10-31',providers:['yandex_direct','2gis'],evidence:ev('owner_confirmed'),
      facts:[fact('synthetic-direct-oct','yandex_direct','701',100000),fact('synthetic-2gis-oct','2gis','pkg-oct',150000,{kind:'package',evidence:ev('closing_act')})],
      campaigns:[campaign('yandex_direct','701','yandex','spa'),campaign('2gis','pkg-oct','2gis','maps')]},
    recordCosts:[cost('1',100000),cost('2',80000),cost('3',30000)]
  });
}

test('полная синтетическая цепочка с подтверждённой связью даёт точные CAC и ROMI в целых копейках',()=>{
  const out=buildRevenueCohorts(fullFlow());
  assert.equal(out.cohort.basis,'server_bound_first_touch_local_day');
  assert.deepEqual(out.cohortTotals.newPayingClients,{status:'verified',value:3,knownValue:3,reasons:[]});
  const a=out.cohortTotals.activity;
  assert.equal(a.status,'verified');assert.equal(a.paymentKopecks,600000);assert.equal(a.refundKopecks,50000);assert.equal(a.netKopecks,550000);
  assert.equal(a.createdBookings,3);assert.equal(a.attendedUniqueVisits,3);
  const f=out.cohortTotals.funnel;
  assert.equal(f.status,'verified');assert.equal(f.acquiredClients,3);assert.equal(f.bookedClients,3);assert.equal(f.attendedClients,3);
  assert.equal(f.payingClients,3);assert.equal(f.notYetPayingClients,0);assert.equal(f.reactivatedPriorPayers,0);
  // Заявки без записи не придуманы: серверного журнала заявок ещё нет.
  assert.equal(f.leadsWithoutBooking.status,'unavailable');assert.equal(f.leadsWithoutBooking.value,null);assert.ok(has(f.leadsWithoutBooking,'LEAD_JOURNAL_NOT_INTEGRATED'));
  assert.equal(out.source.leadJournal,'not_integrated');
  assert.deepEqual(out.cohortTotals.margin,{status:'verified',valueKopecks:340000,costKopecks:210000,reasons:[]});
  assert.deepEqual(out.economics.cac,{status:'verified',valueKopecks:83333,exact:{spendKopecks:250000,clients:3},reasons:[]});
  assert.deepEqual(out.economics.romi,{status:'verified',basisPoints:3600,exact:{netMarginKopecks:340000,spendKopecks:250000},reasons:[]});
  const yandex=touchRow(out,'yandex'),gis=touchRow(out,'2gis'),offline=touchRow(out,'offline');
  assert.equal(yandex.spendKopecks,100000);assert.equal(yandex.cac.valueKopecks,100000);assert.equal(yandex.romi.basisPoints,5000);assert.equal(yandex.netKopecks,250000);
  assert.equal(gis.spendKopecks,150000);assert.equal(gis.romi.basisPoints,-2000);
  assert.equal(offline.spendKopecks,0);assert.equal(offline.cac.valueKopecks,0);assert.equal(offline.romi.status,'not_applicable');assert.ok(has(offline.romi,'ZERO_SPEND'));
  assert.equal(out.attribution.firstTouch.status,'verified');assert.equal(out.attribution.firstTouch.boundClients,3);
  assert.equal(out.coverage.status,'partial');assert.ok(out.coverage.reasons.some(r=>r.code==='LEAD_JOURNAL_NOT_INTEGRATED'));
  // Календарный кассовый итог окна не содержит возврата ноября: это другое отношение, чем выручка когорты.
  assert.equal(out.calendar.netCashKopecks,600000);assert.equal(out.calendar.firstObservedPayers,3);
  assert.equal(out.cohortTotals.firstObservedPayers,undefined);
  for(const v of [a.paymentKopecks,a.netKopecks,out.economics.cac.valueKopecks,out.economics.romi.basisPoints])assert.ok(Number.isSafeInteger(v));
});

// (1) Привлечён в одном окне, оплачен в другом: точная проверка CAC/ROMI обеих когорт.
test('привлечён 2 окт., первая оплата 3 нояб.: клиент октябрьской когорты; ноябрьская его не получает',()=>{
  const records=[rec(1,{visitAt:iso('2026-11-03T10:00:00+08:00')})];
  const cash=[pay(10,{at:iso('2026-11-03T12:00:00+08:00')}),pay(11,{amount:50000,at:iso('2026-11-10T12:00:00+08:00')}),
    pay(12,{expenseId:REFUND,amount:20000,at:iso('2026-11-12T12:00:00+08:00')}),pay(13,{expenseId:REFUND,amount:10000,at:iso('2026-11-16T12:00:00+08:00')})];
  const extra={leadBindings:[bind('1','yandex','spa',T)],recordCosts:[cost('1',30000)]};
  const oct=buildRevenueCohorts(input(snapshot(records,cash),{...extra,spend:spendFor('2026-10-01','2026-10-31',40000)}));
  assert.deepEqual(oct.cohortTotals.newPayingClients,{status:'verified',value:1,knownValue:1,reasons:[]});
  const a=oct.cohortTotals.activity;
  // Оплаты 3 и 10 нояб. и возврат 12 нояб. входят; возврат 16 нояб. — после observationTo.
  assert.equal(a.status,'verified');assert.equal(a.paymentKopecks,150000);assert.equal(a.refundKopecks,20000);assert.equal(a.netKopecks,130000);
  assert.deepEqual(oct.cohortTotals.margin,{status:'verified',valueKopecks:100000,costKopecks:30000,reasons:[]});
  // CAC = расход октября 40 000 коп. / 1 новый платящий октября; ROMI = (130 000 − 30 000 − 40 000) / 40 000 = 150%.
  assert.deepEqual(oct.economics.cac,{status:'verified',valueKopecks:40000,exact:{spendKopecks:40000,clients:1},reasons:[]});
  assert.deepEqual(oct.economics.romi,{status:'verified',basisPoints:15000,exact:{netMarginKopecks:100000,spendKopecks:40000},reasons:[]});
  const y=touchRow(oct,'yandex');assert.equal(y.acquiredClients,1);assert.equal(y.clients,1);assert.equal(y.cac.valueKopecks,40000);assert.equal(y.romi.basisPoints,15000);
  assert.equal(oct.calendar.paymentKopecks,0);assert.equal(oct.calendar.firstObservedPayers,0);assert.equal(oct.calendar.createdBookings,1);

  // Ноябрьское окно привлечения: первая оплата в ноябре не делает клиента новым ноябрьским.
  const nov=buildRevenueCohorts(input(snapshot(records,cash),{...extra,...NOV,spend:spendFor('2026-11-01','2026-11-14',70000)}));
  assert.deepEqual(nov.cohortTotals.newPayingClients,{status:'verified',value:0,knownValue:0,reasons:[]});
  assert.equal(nov.economics.cac.status,'not_applicable');assert.deepEqual(nov.economics.cac.exact,{spendKopecks:70000,clients:0});assert.ok(has(nov.economics.cac,'NO_NEW_CLIENTS'));
  assert.deepEqual(nov.economics.romi,{status:'verified',basisPoints:-10000,exact:{netMarginKopecks:0,spendKopecks:70000},reasons:[]});
  // Календарь ноября честно показывает деньги и первую наблюдаемую оплату, но отдельно от когорты.
  assert.equal(nov.calendar.paymentKopecks,150000);assert.equal(nov.calendar.refundKopecks,20000);assert.equal(nov.calendar.firstObservedPayers,1);
  const ny=touchRow(nov,'yandex');assert.equal(ny.clients,0);assert.equal(ny.spendKopecks,70000);assert.equal(ny.cac.status,'not_applicable');
});

// (2) Привлечён 30 сент., первая оплата 3 окт.
test('привлечён 30 сент., впервые оплатил 3 окт.: не новый клиент октября, но новый сентября',()=>{
  const records=[rec(1,{createdAt:iso('2026-09-30T12:00:00+08:00')})],cash=[pay(10)];
  const extra={leadBindings:[bind('1','yandex','spa',iso('2026-09-30T11:00:00+08:00'))],recordCosts:[cost('1',10000)]};
  const oct=buildRevenueCohorts(input(snapshot(records,cash),{...extra,spend:spendFor('2026-10-01','2026-10-31',50000)}));
  assert.deepEqual(oct.cohortTotals.newPayingClients,{status:'verified',value:0,knownValue:0,reasons:[]});
  assert.equal(oct.cohortTotals.funnel.acquiredClients,0);
  assert.equal(oct.calendar.firstObservedPayers,1);assert.equal(oct.calendar.paymentKopecks,100000);
  assert.equal(oct.economics.cac.status,'not_applicable');assert.deepEqual(oct.economics.cac.exact,{spendKopecks:50000,clients:0});
  assert.equal(oct.economics.romi.basisPoints,-10000);
  const sep=buildRevenueCohorts(input(snapshot(records,cash),{...extra,cohort:{from:'2026-09-01',to:'2026-09-30'},observationTo:'2026-10-15',
    spend:spendFor('2026-09-01','2026-09-30',30000)}));
  assert.deepEqual(sep.cohortTotals.newPayingClients,{status:'verified',value:1,knownValue:1,reasons:[]});
  assert.equal(sep.cohortTotals.activity.paymentKopecks,100000);assert.equal(sep.calendar.paymentKopecks,0);assert.equal(sep.calendar.firstObservedPayers,0);
  assert.deepEqual(sep.economics.cac,{status:'verified',valueKopecks:30000,exact:{spendKopecks:30000,clients:1},reasons:[]});
  // ROMI = (100 000 − 10 000 − 30 000) / 30 000 = 200%.
  assert.deepEqual(sep.economics.romi,{status:'verified',basisPoints:20000,exact:{netMarginKopecks:90000,spendKopecks:30000},reasons:[]});
});

// (3) Оплата после observationTo.
test('привлечён 2 окт., оплата 20 нояб. после observationTo: ещё не платящий, запись и визит остаются в воронке',()=>{
  const records=[rec(1,{visitAt:iso('2026-10-05T10:00:00+08:00')})],cash=[pay(10,{at:iso('2026-11-20T12:00:00+08:00')})];
  const y=snapshot(records,cash,{collectedAt:'2026-11-25T00:00:00.000Z'});
  const extra={leadBindings:[bind('1','yandex','spa',T)],recordCosts:[cost('1',10000)],spend:spendFor('2026-10-01','2026-10-31',40000)};
  const out=buildRevenueCohorts(input(y,extra));
  assert.deepEqual(out.cohortTotals.newPayingClients,{status:'verified',value:0,knownValue:0,reasons:[]});
  const f=out.cohortTotals.funnel;
  assert.equal(f.status,'verified');assert.equal(f.acquiredClients,1);assert.equal(f.bookedClients,1);assert.equal(f.attendedClients,1);
  assert.equal(f.payingClients,0);assert.equal(f.notYetPayingClients,1);
  const a=out.cohortTotals.activity;
  assert.equal(a.status,'verified');assert.equal(a.createdBookings,1);assert.equal(a.attendedUniqueVisits,1);assert.equal(a.paymentKopecks,0);
  // Знаменатель CAC — только новые платящие: привлечённый без оплаты его не увеличивает.
  assert.equal(out.economics.cac.status,'not_applicable');assert.deepEqual(out.economics.cac.exact,{spendKopecks:40000,clients:0});
  const row=touchRow(out,'yandex');assert.equal(row.acquiredClients,1);assert.equal(row.clients,0);assert.equal(row.cac.status,'not_applicable');
  const later=buildRevenueCohorts(input(y,{...extra,observationTo:'2026-11-24'}));
  assert.equal(later.cohortTotals.newPayingClients.value,1);assert.equal(later.cohortTotals.activity.paymentKopecks,100000);
  assert.deepEqual(later.economics.cac,{status:'verified',valueKopecks:40000,exact:{spendKopecks:40000,clients:1},reasons:[]});
});

// (4) Старый платёж до привлечения.
test('клиент с оплатой раньше подтверждённого касания не новый, даже если касание в окне',()=>{
  const records=[rec(1),rec(2,{client:client(2)})];
  const cash=[pay(9,{recordId:null,visitId:null,amount:70000,at:iso('2026-06-10T12:00:00+08:00')}),pay(10),
    pay(11,{recordId:'2',visitId:'1002',client:client(2),amount:40000})];
  const out=buildRevenueCohorts(input(snapshot(records,cash),{leadBindings:[bind('1','yandex','spa',T),bind('2','yandex','spa',T)]}));
  assert.deepEqual(out.cohortTotals.newPayingClients,{status:'verified',value:1,knownValue:1,reasons:[]});
  assert.equal(out.cohortTotals.funnel.reactivatedPriorPayers,1);assert.equal(out.cohortTotals.funnel.acquiredClients,1);
  assert.equal(out.cohortTotals.activity.paymentKopecks,40000);
  assert.equal(out.calendar.paymentKopecks,140000);assert.equal(out.calendar.firstObservedPayers,1);
});

// (5) Граница суток по Иркутску для даты привлечения; дата оплаты другая.
test('граница суток по Иркутску определяет окно привлечения, а не дату оплаты',()=>{
  const records=[rec(1,{createdAt:'2026-09-30T17:00:00.000Z',visitAt:'2026-11-01T02:00:00.000Z'}),
    rec(2,{client:client(2),createdAt:'2026-10-31T16:20:00.000Z',visitAt:'2026-10-31T16:30:00.000Z'})];
  const cash=[pay(10,{at:'2026-11-02T03:00:00.000Z'}),pay(11,{recordId:'2',visitId:'1002',client:client(2),at:'2026-10-31T16:40:00.000Z'})];
  // 30.09 16:30Z = 01.10 00:30 Иркутск; 31.10 16:10Z = 01.11 00:10 Иркутск.
  const leadBindings=[bind('1','yandex','spa','2026-09-30T16:30:00.000Z'),bind('2','vk','stories','2026-10-31T16:10:00.000Z')];
  const oct=buildRevenueCohorts(input(snapshot(records,cash),{leadBindings}));
  assert.equal(oct.cohortTotals.newPayingClients.value,1);assert.equal(touchRow(oct,'yandex').clients,1);assert.equal(touchRow(oct,'vk'),undefined);
  assert.equal(oct.cohortTotals.activity.paymentKopecks,100000);
  assert.equal(oct.calendar.paymentKopecks,0);assert.equal(oct.calendar.createdBookings,1);assert.equal(oct.calendar.firstObservedPayers,0);
  const nov=buildRevenueCohorts(input(snapshot(records,cash),{leadBindings,...NOV}));
  assert.equal(nov.cohortTotals.newPayingClients.value,1);assert.equal(touchRow(nov,'vk').clients,1);assert.equal(touchRow(nov,'yandex'),undefined);
  assert.equal(nov.calendar.firstObservedPayers,2);assert.equal(nov.calendar.paymentKopecks,200000);
});

// (6) Противоречивые связи с одинаковым источником и кампанией.
test('одинаковые source/campaign с разными leadId или временем не дают проверенного привлечения',()=>{
  const one=leadBindings=>buildRevenueCohorts(input(snapshot([rec(1)],[pay(10)]),{leadBindings}));
  const ids=one([bind('1','yandex','spa',T,undefined,'lead_alpha1'),bind('1','yandex','spa',T,undefined,'lead_beta22')]);
  assert.ok(ids.attribution.bindingReasons.some(r=>r.code==='BINDING_CONFLICT'));
  assert.equal(ids.cohortTotals.newPayingClients.status,'unavailable');assert.equal(ids.cohortTotals.newPayingClients.value,null);
  assert.ok(has(ids.cohortTotals.newPayingClients,'BINDING_CONFLICT'));assert.equal(ids.economics.cac.status,'unavailable');
  assert.equal(ids.attribution.firstTouch.boundClients,0);assert.equal(ids.attribution.firstTouch.unknownClients,1);
  assert.equal(ids.calendar.status,'verified');assert.equal(ids.calendar.paymentKopecks,100000);
  const times=one([bind('1','yandex','spa',T),bind('1','yandex','spa',iso('2026-10-01T09:00:00+08:00'))]);
  assert.ok(has(times.cohortTotals.newPayingClients,'BINDING_CONFLICT'));
  // Одна заявка на двух записях одного клиента с разным временем касания.
  const twoRecords=[rec(1),rec(2,{createdAt:iso('2026-10-12T10:00:00+08:00')})];
  const lead=buildRevenueCohorts(input(snapshot(twoRecords,[pay(10)]),{leadBindings:[bind('1','yandex','spa',T,undefined,'lead_shared'),
    bind('2','yandex','spa',iso('2026-10-01T09:00:00+08:00'),undefined,'lead_shared')]}));
  assert.ok(has(lead.cohortTotals.newPayingClients,'BINDING_LEAD_CONFLICT'));assert.equal(lead.economics.cac.status,'unavailable');
  // Одна заявка у двух разных клиентов.
  const multi=buildRevenueCohorts(input(snapshot([rec(1),rec(2,{client:client(2)})],[pay(10),pay(11,{recordId:'2',visitId:'1002',client:client(2)})]),
    {leadBindings:[bind('1','yandex','spa',T,undefined,'lead_shared'),bind('2','yandex','spa',T,undefined,'lead_shared')]}));
  assert.ok(has(multi.cohortTotals.newPayingClients,'BINDING_LEAD_MULTIPLE_CLIENTS'));assert.equal(multi.attribution.firstTouch.unknownClients,2);
  // Согласованная заявка на нескольких записях одного клиента и точный дубль связи принимаются.
  const ok=buildRevenueCohorts(input(snapshot(twoRecords,[pay(10)]),{leadBindings:[bind('1','yandex','spa',T,undefined,'lead_shared'),
    bind('2','yandex','spa',T,undefined,'lead_shared'),bind('1','yandex','spa',T,undefined,'lead_shared')]}));
  assert.deepEqual(ok.cohortTotals.newPayingClients,{status:'verified',value:1,knownValue:1,reasons:[]});
  assert.equal(ok.attribution.firstTouch.multiTouchClients,0);assert.deepEqual(ok.attribution.bindingReasons,[]);
});

test('несколько доказанных касаний: самое раннее по времени, не по порядку ввода; одновременные разные — неоднозначность',()=>{
  const records=[rec(1),rec(2,{createdAt:iso('2026-10-12T10:00:00+08:00'),visitAt:iso('2026-10-13T10:00:00+08:00')})];
  const run=leadBindings=>buildRevenueCohorts(input(snapshot(records,[pay(10)]),{leadBindings}));
  const later=bind('2','yandex','spa',iso('2026-10-11T09:00:00+08:00'),undefined,'lead_later');
  const early=run([later,bind('1','vk','stories',T,undefined,'lead_early')]);
  assert.equal(early.cohortTotals.newPayingClients.value,1);assert.equal(touchRow(early,'vk').clients,1);assert.equal(touchRow(early,'yandex'),undefined);
  assert.equal(early.attribution.firstTouch.multiTouchClients,1);
  // Самое раннее касание до окна: октябрьская заявка не делает клиента новым в октябре.
  const before=run([later,bind('1','vk','stories',iso('2026-09-28T09:00:00+08:00'),undefined,'lead_early')]);
  assert.deepEqual(before.cohortTotals.newPayingClients,{status:'verified',value:0,knownValue:0,reasons:[]});
  assert.equal(before.cohortTotals.funnel.acquiredClients,0);
  const same=run([bind('2','yandex','spa',T,undefined,'lead_b_same'),bind('1','vk','stories',T,undefined,'lead_a_same')]);
  assert.equal(same.cohortTotals.newPayingClients.status,'unavailable');assert.ok(has(same.cohortTotals.newPayingClients,'ACQUISITION_TOUCH_AMBIGUOUS'));
});

// (7) Отсутствие связи и неполная история не превращаются в ноль новых.
test('без связи заявка→запись новые платящие и экономика неизвестны, календарь сохраняется',()=>{
  const i=fullFlow();delete i.leadBindings;const out=buildRevenueCohorts(i);
  const n=out.cohortTotals.newPayingClients;
  assert.equal(n.status,'unavailable');assert.equal(n.value,null);assert.notEqual(n.value,0);assert.equal(n.knownValue,0);
  assert.deepEqual(n.reasons.find(r=>r.code==='ATTRIBUTION_UNBOUND').count,3);
  assert.equal(out.calendar.status,'verified');assert.equal(out.calendar.paymentKopecks,600000);assert.equal(out.calendar.firstObservedPayers,3);
  assert.equal(out.economics.cac.status,'unavailable');assert.equal(out.economics.cac.valueKopecks,null);assert.ok(has(out.economics.cac,'ATTRIBUTION_UNBOUND'));
  assert.equal(out.economics.romi.status,'unavailable');
  assert.equal(out.attribution.firstTouch.status,'partial');assert.equal(out.attribution.firstTouch.unknownClients,3);
  assert.equal(out.cohortTotals.funnel.status,'partial');
  // Метка from_url записи не становится первым касанием и не создаёт когорту.
  assert.equal(touchRow(out,'yandex').clients,0);assert.equal(touchRow(out,'yandex').cac.status,'unavailable');
  assert.equal(out.rows.some(r=>r.basis==='record_label'),false);assert.equal(out.rows.some(r=>r.basis==='first_touch'&&r.attribution===null),false);
  assert.equal(out.coverage.status,'partial');
});

test('неполная история оплат: новизна неизвестна, известная часть видна отдельно',()=>{
  const none=fullFlow();none.paymentHistory=null;const a=buildRevenueCohorts(none);
  assert.equal(a.cohortTotals.newPayingClients.value,null);assert.equal(a.cohortTotals.newPayingClients.knownValue,3);
  assert.ok(has(a.cohortTotals.newPayingClients,'PAYMENT_HISTORY_UNPROVEN'));assert.equal(a.cohortTotals.funnel.status,'partial');
  assert.equal(a.economics.cac.status,'unavailable');assert.equal(a.calendar.firstObservedPayers,3);
  const gap=fullFlow();gap.yclients.historyFrom='2026-06-01';const b=buildRevenueCohorts(gap);
  assert.ok(has(b.cohortTotals.newPayingClients,'PAYMENT_HISTORY_UNPROVEN'));assert.equal(b.economics.romi.status,'unavailable');
});

test('несвязанный клиент с записью до окна точно вне когорты; несвязанный без оплаты не блокирует CAC',()=>{
  const before=buildRevenueCohorts(input(snapshot(
    [rec(1),rec(2,{client:client(2),createdAt:iso('2026-09-20T10:00:00+08:00'),visitAt:iso('2026-10-05T10:00:00+08:00')})],
    [pay(10),pay(11,{recordId:'2',visitId:'1002',client:client(2),at:iso('2026-10-05T12:00:00+08:00')})]),{leadBindings:[bind('1','yandex','spa',T)]}));
  assert.deepEqual(before.cohortTotals.newPayingClients,{status:'verified',value:1,knownValue:1,reasons:[]});
  assert.equal(before.attribution.firstTouch.unknownClients,0);assert.equal(before.calendar.firstObservedPayers,2);
  const unpaid=buildRevenueCohorts(input(snapshot([rec(1),rec(2,{client:client(2),createdAt:iso('2026-10-05T10:00:00+08:00')})],[pay(10)]),
    {leadBindings:[bind('1','yandex','spa',T)],spend:spendFor('2026-10-01','2026-10-31',50000)}));
  assert.deepEqual(unpaid.cohortTotals.newPayingClients,{status:'verified',value:1,knownValue:1,reasons:[]});
  assert.deepEqual(unpaid.economics.cac,{status:'verified',valueKopecks:50000,exact:{spendKopecks:50000,clients:1},reasons:[]});
  assert.equal(unpaid.cohortTotals.funnel.status,'partial');assert.ok(has(unpaid.cohortTotals.funnel,'ATTRIBUTION_UNBOUND'));
  assert.equal(unpaid.attribution.firstTouch.unknownClients,1);
});

test('запись раньше касания внутри окна и связь на отсутствующую запись делают привлечение неизвестным',()=>{
  const earlier=buildRevenueCohorts(input(snapshot(
    [rec(1,{createdAt:iso('2026-10-01T10:00:00+08:00')}),rec(2,{createdAt:iso('2026-10-05T10:00:00+08:00'),visitAt:iso('2026-10-06T10:00:00+08:00')})],
    [pay(10,{recordId:'2',visitId:'1002',at:iso('2026-10-06T12:00:00+08:00')})]),{leadBindings:[bind('2','yandex','spa',iso('2026-10-04T10:00:00+08:00'))]}));
  assert.equal(earlier.cohortTotals.newPayingClients.status,'unavailable');assert.ok(has(earlier.cohortTotals.newPayingClients,'ACQUISITION_EARLIER_CONTACT'));
  const orphan=buildRevenueCohorts(input(snapshot([rec(1)],[pay(10)]),{leadBindings:[bind('1','yandex','spa',T),bind('99','yandex','spa',T)]}));
  assert.ok(has(orphan.cohortTotals.newPayingClients,'BINDING_RECORD_MISSING'));assert.equal(orphan.economics.cac.status,'unavailable');
  // Связь на отсутствующую запись с касанием после окна не может изменить состав октябрьской когорты.
  const afterWindow=buildRevenueCohorts(input(snapshot([rec(1)],[pay(10)]),{leadBindings:[bind('1','yandex','spa',T),bind('99','yandex','spa',iso('2026-11-05T10:00:00+08:00'))]}));
  assert.equal(afterWindow.cohortTotals.newPayingClients.status,'verified');
  assert.ok(afterWindow.attribution.bindingReasons.some(r=>r.code==='BINDING_RECORD_MISSING'));assert.equal(afterWindow.coverage.status,'partial');
});

// (8) Исходные смысловые проверки денег, изоляции, маржи, возвратов и нуля.
test('поздняя оплата и возврат до observationTo входят, позже — нет; незакрытое наблюдение не даёт проверенного числа',()=>{
  const cash=[pay(10),pay(11,{at:iso('2026-11-05T12:00:00+08:00'),amount:50000}),pay(12,{expenseId:REFUND,amount:20000,at:iso('2026-11-10T12:00:00+08:00')}),
    pay(13,{expenseId:REFUND,amount:10000,at:iso('2026-11-16T12:00:00+08:00')})];
  const leadBindings=[bind('1','yandex','spa',T)];
  const out=buildRevenueCohorts(input(snapshot([rec(1)],cash),{leadBindings}));
  const a=out.cohortTotals.activity;
  assert.equal(a.status,'verified');assert.equal(a.paymentKopecks,150000);assert.equal(a.refundKopecks,20000);assert.equal(a.netKopecks,130000);
  assert.equal(out.calendar.paymentKopecks,100000);assert.equal(out.calendar.refundKopecks,0);
  const open=buildRevenueCohorts(input(snapshot([rec(1)],cash),{leadBindings,observationTo:'2026-11-25'}));
  assert.equal(open.cohortTotals.activity.refundKopecks,30000);assert.equal(open.cohortTotals.activity.status,'partial');
  assert.ok(has(open.cohortTotals.activity,'PERIOD_NOT_CLOSED'));
  assert.equal(open.cohortTotals.newPayingClients.status,'unavailable');assert.equal(open.cohortTotals.newPayingClients.knownValue,1);
  assert.equal(open.economics.romi.status,'unavailable');
});

// Прежде любой календарь отчёта, отличный от native, отклонялся TIMEZONE_MISMATCH 409. Теперь календарь выбран явно,
// а строки YCLIENTS — UTC-моменты; несопоставимым остаётся только дневной расход в другом поясе.
test('календарь отчёта может отличаться от native; московские сутки Директа под Иркутском не пересчитываются',()=>{
  const utcOut=buildRevenueCohorts(input(snapshot([rec(1)],[pay(10)]),{timezone:'UTC'}));
  assert.equal(utcOut.timeBasis.analysisTimezone,'UTC');assert.equal(utcOut.timeBasis.nativeTimezone,IRK);assert.equal(utcOut.scope.timezone,'UTC');
  assert.equal(utcOut.calendar.status,'verified');assert.equal(utcOut.calendar.paymentKopecks,100000);
  const i=fullFlow();i.spend.facts[0].timezone=MSK;const out=buildRevenueCohorts(i);
  assert.ok(has(out.spend,'TIMEZONE_MISMATCH'));assert.equal(out.spend.knownKopecks,250000);
  assert.equal(out.economics.cac.status,'unavailable');assert.ok(has(out.economics.cac,'TIMEZONE_MISMATCH'));
  assert.equal(out.cohortTotals.newPayingClients.status,'verified');
});

test('дубль визита и несколько оплат: одно посещение, один клиент, все деньги',()=>{
  const out=buildRevenueCohorts(input(snapshot(
    [rec(1,{visitId:'5000'}),rec(2,{visitId:'5000'}),rec(3,{deleted:true}),rec(4,{attendance:-1})],
    [pay(10,{visitId:'5000',amount:60000}),pay(11,{recordId:'2',visitId:'5000',amount:40000}),pay(12,{visitId:'5000',amount:10000,at:iso('2026-10-20T12:00:00+08:00')})]),
    {leadBindings:[bind('1','yandex','spa',T)]}));
  const a=out.cohortTotals.activity;
  assert.equal(out.cohortTotals.newPayingClients.value,1);assert.equal(a.paymentKopecks,110000);
  assert.equal(a.createdBookings,4);assert.equal(a.cancelledBookings,1);assert.equal(a.noShows,1);assert.equal(a.attendedUniqueVisits,1);
  assert.equal(out.cohortTotals.funnel.attendedClients,1);
  assert.equal(out.calendar.attendedUniqueVisits,1);assert.equal(out.calendar.noShows,1);
});

test('противоречащий клиент оплаты и неоднозначный visitId остаются неизвестными без выключения полезного',()=>{
  const conflict=buildRevenueCohorts(input(snapshot([rec(1)],[pay(10,{client:client(2)})]),{leadBindings:[bind('1','yandex','spa',T)]}));
  assert.equal(conflict.cohortTotals.newPayingClients.status,'unavailable');assert.ok(has(conflict.cohortTotals.newPayingClients,'CLIENT_IDENTITY_CONFLICT'));
  assert.equal(conflict.cohortTotals.funnel.acquiredClients,1);
  assert.equal(conflict.calendar.firstObservedPayers,0);assert.equal(conflict.calendar.paymentKopecks,100000);assert.equal(conflict.calendar.status,'verified');
  const ambiguous=buildRevenueCohorts(input(snapshot([rec(1,{visitId:'7000'}),rec(2,{visitId:'7000',client:client(2)})],
    [pay(10,{recordId:null,visitId:'7000'})]),{leadBindings:[bind('1','yandex','spa',T)]}));
  // Несвязанный клиент без оплаты не мешает числу новых платящих, но воронка помечена неполной.
  assert.deepEqual(ambiguous.cohortTotals.newPayingClients,{status:'verified',value:1,knownValue:1,reasons:[]});
  assert.ok(has(ambiguous.attribution.recordLabel,'PAYMENT_UNMATCHED'));
  assert.equal(ambiguous.rows.find(r=>r.basis==='record_label').attribution,null);
  assert.ok(has(ambiguous.cohortTotals.margin,'PAYMENT_UNMATCHED'));assert.ok(has(ambiguous.cohortTotals.funnel,'ATTRIBUTION_UNBOUND'));
});

test('неизвестная статья не становится деньгами и не выключает отчёт целиком',()=>{
  const leadBindings=[bind('1','yandex','spa',T)];
  const cash=[pay(10),pay(11,{expenseId:'900099',amount:999900}),pay(12,{expenseId:null,amount:5000})];
  const out=buildRevenueCohorts(input(snapshot([rec(1)],cash),{leadBindings}));
  assert.equal(out.calendar.paymentKopecks,100000);assert.equal(out.calendar.status,'partial');
  assert.deepEqual(out.calendar.reasons.map(r=>[r.code,r.count]),[['UNKNOWN_CASH_ARTICLE',2]]);
  // Неизвестные операции уже платящего клиента не меняют число новых платящих, но деньги когорты неполные.
  assert.equal(out.cohortTotals.newPayingClients.status,'verified');
  assert.equal(out.cohortTotals.activity.status,'partial');assert.ok(has(out.cohortTotals.activity,'UNKNOWN_CASH_ARTICLE'));
  assert.equal(out.economics.romi.status,'unavailable');assert.ok(!has(out.economics.cac,'UNKNOWN_CASH_ARTICLE'));
  const anonymous=buildRevenueCohorts(input(snapshot([rec(1)],[...cash,pay(13,{recordId:null,visitId:null,client:null,expenseId:'900099',amount:1000})]),{leadBindings}));
  assert.equal(anonymous.cohortTotals.newPayingClients.value,null);assert.equal(anonymous.cohortTotals.newPayingClients.knownValue,1);
  assert.ok(has(anonymous.economics.cac,'UNKNOWN_CASH_ARTICLE'));
});

test('без себестоимости CAC возможен, а маржа и ROMI неизвестны',()=>{
  const i=fullFlow();i.recordCosts=null;const out=buildRevenueCohorts(i);
  assert.equal(out.economics.cac.valueKopecks,83333);assert.equal(out.economics.romi.status,'unavailable');assert.ok(has(out.economics.romi,'COSTS_MISSING'));
  assert.equal(out.cohortTotals.margin.valueKopecks,null);
  const j=fullFlow();j.recordCosts.pop();const partial=buildRevenueCohorts(j);
  assert.ok(has(partial.economics.romi,'COST_RECORD_MISSING'));assert.equal(partial.economics.romi.basisPoints,null);
});

test('несовпадение валюты или режима НДС делает экономику несопоставимой',()=>{
  const usd=fullFlow();usd.spend.facts[0].currency='USD';const a=buildRevenueCohorts(usd);
  assert.ok(has(a.spend,'CURRENCY_MISMATCH'));assert.equal(a.economics.cac.status,'unavailable');
  const vat=fullFlow();vat.spend.facts[1].vatMode='vat_included';const b=buildRevenueCohorts(vat);
  assert.ok(has(b.economics.cac,'VAT_MODE_MISMATCH'));
  const costVat=fullFlow();costVat.recordCosts[0].vatMode='vat_included';const c=buildRevenueCohorts(costVat);
  assert.equal(c.economics.cac.status,'verified');assert.ok(has(c.economics.romi,'VAT_MODE_MISMATCH'));
});

test('пакет 2ГИС распределяется только подтверждённо; общий кабинет не размазывается',()=>{
  const cross=fullFlow();cross.spend.facts[1]=fact('synthetic-2gis-pkg','2gis','pkg-oct',300000,{kind:'package',serviceFrom:'2026-10-15',serviceTo:'2026-11-14'});
  const a=buildRevenueCohorts(cross);
  assert.ok(has(a.spend,'EXPENSE_PERIOD_UNALLOCATED'));assert.equal(a.spend.knownKopecks,100000);assert.equal(a.economics.cac.status,'unavailable');
  cross.spend.facts[1].allocations=[{from:'2026-10-15',to:'2026-10-31',amountKopecks:170000},{from:'2026-11-01',to:'2026-11-14',amountKopecks:130000}];
  assert.equal(buildRevenueCohorts(cross).economics.cac.valueKopecks,90000);
  cross.spend.facts[1].allocations[1].amountKopecks=120000;
  assert.throws(()=>buildRevenueCohorts(cross),{code:'ALLOCATION_MISMATCH'});
  const shared=fullFlow();shared.spend.facts.push(fact('synthetic-shared','yandex_direct','999',500000,{accountScope:'shared'}));
  const b=buildRevenueCohorts(shared);
  assert.ok(has(b.spend,'SHARED_ACCOUNT_UNALLOCATED'));assert.equal(b.spend.knownKopecks,250000);assert.equal(b.economics.cac.status,'unavailable');
  shared.spend.campaigns.push(campaign('yandex_direct','999','yandex','spa'));
  const c=buildRevenueCohorts(shared);
  assert.equal(c.economics.cac.valueKopecks,250000);assert.equal(touchRow(c,'yandex').spendKopecks,600000);
});

test('строки чужой компании, контакты и автоматические доказательства отклоняются',()=>{
  assert.throws(()=>buildRevenueCohorts(input(snapshot([rec(1)],[pay(10)],{companyCode:B}))),{code:'FOREIGN_COMPANY'});
  for(const mutate of [i=>{i.leadBindings[0].companyCode=B;},i=>{i.spend.facts[0].companyCode=B;},i=>{i.spend.campaigns[0].companyCode=B;},
    i=>{i.recordCosts[0].companyCode=B;},i=>{i.paymentHistory.companyCode=B;}]) {
    const i=fullFlow();mutate(i);assert.throws(()=>buildRevenueCohorts(i),{code:'FOREIGN_COMPANY'});
  }
  assert.throws(()=>buildRevenueCohorts(input(snapshot([rec(1,{phone:'+79000000000'})],[pay(10)]))),
    e=>e.code==='VALIDATION_ERROR'&&!e.message.includes('79000000000'));
  for(const leadId of ['79001234567','me@example.test']) {
    const i=fullFlow();i.leadBindings[0].leadId=leadId;assert.throws(()=>buildRevenueCohorts(i),{code:'VALIDATION_ERROR'});
  }
  for(const kind of ['phone_hash_match','from_url','record_created_at']) {
    const i=fullFlow();i.leadBindings[0].evidence=ev(kind);assert.throws(()=>buildRevenueCohorts(i),{code:'EVIDENCE_REJECTED'});
  }
});

test('связь позже записи или противоречивая связь не принимаются',()=>{
  const late=fullFlow();late.leadBindings[0].firstTouch.at='2026-10-05T00:00:00.000Z';
  const a=buildRevenueCohorts(late);assert.ok(a.attribution.bindingReasons.some(r=>r.code==='BINDING_TIME_INCONSISTENT'));
  assert.ok(has(a.attribution.firstTouch,'BINDING_TIME_INCONSISTENT'));assert.equal(a.economics.cac.status,'unavailable');
  const twice=fullFlow();twice.leadBindings.push(bind('1','vk','other','2026-10-01T08:00:00.000Z'));
  const b=buildRevenueCohorts(twice);assert.ok(b.attribution.bindingReasons.some(r=>r.code==='BINDING_CONFLICT'));
  assert.ok(has(b.attribution.firstTouch,'BINDING_CONFLICT'));assert.equal(b.economics.cac.status,'unavailable');
});

test('проверенный ноль отличается от недоступных данных',()=>{
  const missing=buildRevenueCohorts(input(null));
  assert.equal(missing.cohortTotals.newPayingClients.status,'unavailable');assert.equal(missing.cohortTotals.newPayingClients.value,null);
  assert.equal(missing.cohortTotals.funnel.acquiredClients,null);assert.equal(missing.calendar.firstObservedPayers,null);
  assert.equal(missing.calendar.paymentKopecks,null);assert.ok(has(missing.calendar,'YCLIENTS_SNAPSHOT_MISSING'));assert.equal(missing.coverage.status,'unavailable');
  const stale=buildRevenueCohorts(input(snapshot([rec(1)],[pay(10)],{current:false})));
  assert.equal(stale.calendar.paymentKopecks,null);assert.ok(has(stale.cohortTotals.newPayingClients,'YCLIENTS_SNAPSHOT_STALE'));
  const empty=buildRevenueCohorts(input(snapshot([],[]),{recordCosts:[],
    spend:{companyCode:A,from:'2026-10-01',to:'2026-10-31',providers:[],evidence:ev('owner_confirmed'),facts:[],campaigns:[]}}));
  assert.deepEqual(empty.cohortTotals.newPayingClients,{status:'verified',value:0,knownValue:0,reasons:[]});
  assert.equal(empty.cohortTotals.funnel.status,'verified');assert.equal(empty.cohortTotals.funnel.acquiredClients,0);
  assert.equal(empty.calendar.status,'verified');assert.equal(empty.calendar.paymentKopecks,0);
  assert.equal(empty.economics.cac.status,'not_applicable');assert.ok(has(empty.economics.cac,'NO_NEW_CLIENTS'));assert.equal(empty.economics.cac.valueKopecks,null);
  assert.equal(empty.economics.romi.status,'not_applicable');assert.ok(has(empty.economics.romi,'ZERO_SPEND'));
  assert.equal(empty.coverage.status,'partial');assert.ok(empty.coverage.reasons.some(r=>r.code==='LEAD_JOURNAL_NOT_INTEGRATED'));
});

test('совместимость со строками существующего нормализатора revenue_records/revenue_cash',async t=>{
  const {DatabaseSync}=require('node:sqlite');const {createRevenueAnalytics}=require('./revenue-analytics');
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const raw={records:[{id:1,company_id:101,visit_id:11,client:{id:21,name:'PRIVATE NAME',phone:'PRIVATE PHONE'},create_date:'2026-10-02T16:00:00+0800',datetime:'2026-10-03T16:00:00+0800',
    last_change_date:'2026-10-03T17:00:00+0800',attendance:1,deleted:false,online:true,comment:'PRIVATE COMMENT',from_url:'https://example.test/?utm_source=2gis&utm_medium=paid_maps&utm_campaign=spa'}],
    cash:[{id:101,record_id:1,visit_id:11,client:{id:21,phone:'PRIVATE PHONE'},expense:{id:Number(PAY)},date:'2026-10-03T17:00:00+0800',amount:'1000.10'}]};
  const adapters={ycPages:async(path,params,c,normalize)=>structuredClone(path.includes('/records/')?raw.records:raw.cash).map(normalize),
    json:async()=>{throw Object.assign(new Error('NOT_FOUND'),{code:'NOT_FOUND'});},ycHeaders:()=>({})};
  const a=createRevenueAnalytics(db,{apiKey:'test-storage-key',now:()=>Date.parse('2026-11-20T08:00:00Z'),adapters});
  a.save(A,'yclients',{revision:0,config:config(),credential:{partnerToken:'synthetic-partner',userToken:'synthetic-user'},enabled:true});
  assert.equal((await a.collect(A,'yclients')).collected,true);
  const st=a.status(A,'yclients'),rows=table=>db.prepare('SELECT payload FROM '+table+' WHERE company=?').all(A).map(r=>JSON.parse(r.payload));
  const job=db.prepare('SELECT history_from FROM revenue_jobs WHERE company=? AND provider=?').get(A,'yclients');
  const y={companyCode:A,current:st.current,collectedAt:st.lastSuccess,historyFrom:job.history_from,config:st.config,records:rows('revenue_records'),cash:rows('revenue_cash')};
  // Без серверной связи from_url нормализованной записи не создаёт когорту привлечения.
  const unbound=buildRevenueCohorts(input(y));
  assert.equal(unbound.cohortTotals.newPayingClients.value,null);assert.ok(has(unbound.cohortTotals.newPayingClients,'ATTRIBUTION_UNBOUND'));
  assert.equal(unbound.calendar.paymentKopecks,100010);
  const out=buildRevenueCohorts(input(y,{leadBindings:[bind('1','2gis','spa',iso('2026-10-02T15:00:00+08:00'))]}));
  assert.equal(out.cohortTotals.newPayingClients.value,1);assert.equal(out.cohortTotals.activity.paymentKopecks,100010);
  assert.deepEqual(out.rows.find(r=>r.basis==='record_label').attribution,{source:'2gis',medium:'paid_maps',campaign:'spa'});
  assert.equal(out.economics.cac.status,'unavailable');
  assert.doesNotMatch(JSON.stringify(out),/PRIVATE|synthetic-partner|synthetic-user|example\.test/);
  // Те же нормализованные UTC-строки в московском календаре отчёта: native пояс сохранён, деньги не потеряны и не удвоены.
  const msk=buildRevenueCohorts(input(y,{timezone:MSK}));
  assert.equal(msk.timeBasis.nativeTimezone,IRK);assert.equal(msk.calendar.paymentKopecks,100010);assert.equal(msk.calendar.status,'verified');
  assert.doesNotMatch(JSON.stringify(msk),/PRIVATE|synthetic-partner|synthetic-user|example\.test/);
});

test('неподтверждённый НДС сохраняет календарь и клиентов, но не разрешает экономику',()=>{
  const i=fullFlow();i.vatMode='unknown';const out=buildRevenueCohorts(i);
  assert.equal(out.calendar.paymentKopecks,600000);
  assert.equal(out.cohortTotals.newPayingClients.value,3);
  assert.equal(out.economics.cac.status,'unavailable');assert.equal(out.economics.romi.status,'unavailable');
  assert.ok(out.economics.cac.reasons.some(r=>r.code==='VAT_MODE_UNCONFIRMED'));
});

test('невозможная календарная дата касания отклоняется вместо нормализации в следующий месяц',()=>{
  const i=fullFlow();i.leadBindings[0].firstTouch.at='2026-02-30T09:00:00Z';
  assert.throws(()=>buildRevenueCohorts(i),{code:'BAD_PERIOD'});
});

test('отношение безопасных сумм не возвращает небезопасные целые проценты',()=>{
  const i=fullFlow();i.yclients.records=i.yclients.records.slice(0,1);i.yclients.cash=i.yclients.cash.slice(0,1);
  i.yclients.cash[0].amount=4000000000000000;i.leadBindings=i.leadBindings.slice(0,1);
  i.recordCosts=i.recordCosts.slice(0,1);i.recordCosts[0].costKopecks=0;
  i.spend.facts=i.spend.facts.slice(0,1);i.spend.facts[0].amountKopecks=1;i.spend.campaigns=i.spend.campaigns.slice(0,1);
  assert.throws(()=>buildRevenueCohorts(i),{code:'MONEY_OVERFLOW'});
});

// --- Выбранный календарь отчёта поверх UTC-native YCLIENTS (T008). Все строки и доказательства синтетические. ---

test('одна UTC-оплата и одно касание попадают в разные даты Москвы и Иркутска',()=>{
  // 31.10 17:30Z = 31.10 20:30 Москва = 01.11 01:30 Иркутск; запись 17:45Z, визит 17:50Z, оплата 18:00Z.
  const y=snapshot([rec(1,{createdAt:'2026-10-31T17:45:00.000Z',visitAt:'2026-10-31T17:50:00.000Z'})],[pay(10,{at:'2026-10-31T18:00:00.000Z'})]);
  const leadBindings=[bind('1','yandex','spa','2026-10-31T17:30:00.000Z')];
  const mskOct=buildRevenueCohorts(input(y,{timezone:MSK,leadBindings}));
  assert.deepEqual(mskOct.cohortTotals.newPayingClients,{status:'verified',value:1,knownValue:1,reasons:[]});
  assert.equal(mskOct.calendar.status,'verified');assert.equal(mskOct.calendar.paymentKopecks,100000);
  assert.equal(mskOct.calendar.createdBookings,1);assert.equal(mskOct.calendar.attendedUniqueVisits,1);assert.equal(mskOct.calendar.firstObservedPayers,1);
  assert.deepEqual(mskOct.timeBasis,{analysisTimezone:MSK,nativeTimezone:IRK,
    bounds:{cohortFromUtc:'2026-09-30T21:00:00.000Z',cohortToUtcExclusive:'2026-10-31T21:00:00.000Z',observationToUtcExclusive:'2026-11-15T21:00:00.000Z'},
    nativeCoverage:{fromUtc:'2025-12-31T16:00:00.000Z',toUtcExclusive:'2026-11-19T16:00:00.000Z',startGap:false,cohortEndGap:false,observationEndGap:false}});
  assert.equal(mskOct.source.yclients.historyFrom,'2026-01-01');
  const irkOct=buildRevenueCohorts(input(y,{leadBindings}));
  assert.deepEqual(irkOct.cohortTotals.newPayingClients,{status:'verified',value:0,knownValue:0,reasons:[]});
  assert.equal(irkOct.cohortTotals.funnel.acquiredClients,0);assert.equal(irkOct.calendar.paymentKopecks,0);assert.equal(irkOct.calendar.createdBookings,0);
  const irkNov=buildRevenueCohorts(input(y,{...NOV,leadBindings}));
  assert.equal(irkNov.cohortTotals.newPayingClients.value,1);assert.equal(irkNov.calendar.paymentKopecks,100000);
  const mskNov=buildRevenueCohorts(input(y,{...NOV,timezone:MSK,leadBindings}));
  assert.deepEqual(mskNov.cohortTotals.newPayingClients,{status:'verified',value:0,knownValue:0,reasons:[]});assert.equal(mskNov.calendar.paymentKopecks,0);
});

// Три клиента у границ суток; native Иркутск, отчёт по Москве, Директ даёт московские сутки.
function mskFlow(v={}) {
  const records=[
    rec(1,{createdAt:iso('2026-10-01T00:45:00+03:00'),visitAt:iso('2026-10-02T11:00:00+03:00')}),
    rec(2,{client:client(2),createdAt:iso('2026-10-31T23:45:00+03:00'),visitAt:iso('2026-11-03T11:00:00+03:00')}),
    rec(3,{client:client(3),createdAt:iso('2026-09-30T23:45:00+03:00'),visitAt:iso('2026-10-01T11:00:00+03:00')})
  ];
  const cash=[
    pay(10,{amount:200000,at:iso('2026-10-02T12:00:00+03:00')}),
    pay(11,{recordId:'2',visitId:'1002',client:client(2),amount:100000,at:iso('2026-11-03T12:00:00+03:00')}),
    // 15.11 23:30 Москва = 16.11 04:30 Иркутск: внутри московского observationTo, вне иркутского.
    pay(12,{recordId:'2',visitId:'1002',client:client(2),expenseId:REFUND,amount:10000,at:iso('2026-11-15T23:30:00+03:00')}),
    pay(13,{recordId:'3',visitId:'1003',client:client(3),amount:70000,at:iso('2026-10-01T12:00:00+03:00')})
  ];
  return input(snapshot(records,cash),{timezone:MSK,
    leadBindings:[bind('1','yandex','spa',iso('2026-10-01T00:30:00+03:00')),bind('2','yandex','spa',iso('2026-10-31T23:30:00+03:00')),
      bind('3','yandex','spa',iso('2026-09-30T23:30:00+03:00'))],
    spend:mskSpend('2026-10-01','2026-10-31',90000),recordCosts:[cost('1',50000),cost('2',20000),cost('3',15000)],...v});
}

test('полностью покрытый московский календарь с расходом Директа MSK даёт точные копейки, CAC и ROMI',()=>{
  const out=buildRevenueCohorts(mskFlow());
  assert.equal(out.timeBasis.nativeTimezone,IRK);assert.equal(out.timeBasis.nativeCoverage.observationEndGap,false);
  // Члены октября по Москве: 1 (01.10 00:30) и 2 (31.10 23:30, оплата 3 нояб.). Клиент 3 привлечён 30.09 23:30 по Москве.
  assert.deepEqual(out.cohortTotals.newPayingClients,{status:'verified',value:2,knownValue:2,reasons:[]});
  const a=out.cohortTotals.activity;
  assert.equal(a.status,'verified');assert.equal(a.paymentKopecks,300000);assert.equal(a.refundKopecks,10000);assert.equal(a.netKopecks,290000);
  assert.deepEqual(out.cohortTotals.margin,{status:'verified',valueKopecks:220000,costKopecks:70000,reasons:[]});
  assert.deepEqual(out.spend.reasons,[]);assert.equal(out.spend.knownKopecks,90000);
  // CAC = 90 000 / 2; ROMI = (220 000 − 90 000) / 90 000 = 144,44% → 14444 б.п.
  assert.deepEqual(out.economics.cac,{status:'verified',valueKopecks:45000,exact:{spendKopecks:90000,clients:2},reasons:[]});
  assert.deepEqual(out.economics.romi,{status:'verified',basisPoints:14444,exact:{netMarginKopecks:220000,spendKopecks:90000},reasons:[]});
  const y=touchRow(out,'yandex');assert.equal(y.clients,2);assert.equal(y.spendKopecks,90000);assert.equal(y.cac.valueKopecks,45000);assert.equal(y.romi.basisPoints,14444);
  // Календарь окна по Москве: оплаты 1 и 2 окт.; оплата 3 нояб. — только в активности когорты.
  assert.equal(out.calendar.status,'verified');assert.equal(out.calendar.paymentKopecks,270000);assert.equal(out.calendar.firstObservedPayers,2);
  assert.equal(out.calendar.createdBookings,2);
});

test('отчёт по Иркутску с дневным расходом Директа MSK: экономика неизвестна, сумма не сдвигается',()=>{
  const out=buildRevenueCohorts(mskFlow({timezone:IRK}));
  // Иркутские сутки: члены октября 1 и 3; клиент 2 привлечён 01.11 по Иркутску.
  assert.deepEqual(out.cohortTotals.newPayingClients,{status:'verified',value:2,knownValue:2,reasons:[]});
  assert.equal(out.cohortTotals.activity.paymentKopecks,270000);assert.equal(out.cohortTotals.activity.refundKopecks,0);
  assert.ok(has(out.spend,'TIMEZONE_MISMATCH'));assert.equal(out.spend.knownKopecks,90000);
  assert.equal(out.economics.cac.status,'unavailable');assert.equal(out.economics.cac.valueKopecks,null);assert.ok(has(out.economics.cac,'TIMEZONE_MISMATCH'));
  assert.equal(out.economics.romi.status,'unavailable');assert.equal(touchRow(out,'yandex').cac.status,'unavailable');
  // Расход в иркутских сутках сопоставим: другая когорта, другие точные значения.
  const irk=mskFlow({timezone:IRK});irk.spend.facts[0].timezone=IRK;const ok=buildRevenueCohorts(irk);
  assert.deepEqual(ok.economics.cac,{status:'verified',valueKopecks:45000,exact:{spendKopecks:90000,clients:2},reasons:[]});
  assert.deepEqual(ok.economics.romi,{status:'verified',basisPoints:12778,exact:{netMarginKopecks:205000,spendKopecks:90000},reasons:[]});
});

test('начало native покрытия: разница 5 часов между Москвой и Иркутском не скрывается',()=>{
  const leadBindings=[bind('1','yandex','spa',T)];
  const mskNative=snapshot([rec(1)],[pay(10)],{historyFrom:'2026-10-01',config:cfg({timezone:MSK,historyFrom:'2026-10-01'})});
  const history=(v={})=>({companyCode:A,noPaymentsBefore:'2026-10-01',evidence:ev('owner_confirmed_opening_date'),...v});
  // Native Москва с 01.10 00:00 MSK = 30.09 21:00Z, а октябрь по Иркутску начинается 30.09 16:00Z.
  const irk=buildRevenueCohorts(input(mskNative,{leadBindings,paymentHistory:history()}));
  assert.equal(irk.timeBasis.nativeCoverage.fromUtc,'2026-09-30T21:00:00.000Z');assert.equal(irk.timeBasis.nativeCoverage.startGap,true);
  assert.equal(irk.calendar.status,'partial');assert.ok(has(irk.calendar,'HISTORY_AFTER_PERIOD_START'));assert.equal(irk.calendar.paymentKopecks,100000);
  const n=irk.cohortTotals.newPayingClients;
  assert.equal(n.value,null);assert.equal(n.knownValue,1);assert.ok(has(n,'HISTORY_AFTER_PERIOD_START'));assert.ok(!has(n,'PAYMENT_HISTORY_UNPROVEN'));
  assert.equal(irk.economics.cac.status,'unavailable');
  const msk=buildRevenueCohorts(input(mskNative,{timezone:MSK,leadBindings,paymentHistory:history()}));
  assert.equal(msk.timeBasis.nativeCoverage.startGap,false);
  assert.deepEqual(msk.cohortTotals.newPayingClients,{status:'verified',value:1,knownValue:1,reasons:[]});
  // Обратная пара: native Иркутск с 01.10 (30.09 16:00Z) покрывает московский октябрь полностью.
  const irkNative=snapshot([rec(1)],[pay(10)],{historyFrom:'2026-10-01',config:cfg({historyFrom:'2026-10-01'})});
  const covered=buildRevenueCohorts(input(irkNative,{timezone:MSK,leadBindings,paymentHistory:history()}));
  assert.equal(covered.timeBasis.nativeCoverage.startGap,false);assert.equal(covered.cohortTotals.newPayingClients.status,'verified');
  // История «нет оплат до 01.10 по Иркутску» кончается 30.09 16:00Z: 5 часов до московской выгрузки не подтверждены.
  const hole=buildRevenueCohorts(input(mskNative,{timezone:MSK,leadBindings,paymentHistory:history({timezone:IRK})}));
  assert.ok(has(hole.cohortTotals.newPayingClients,'PAYMENT_HISTORY_UNPROVEN'));assert.equal(hole.economics.cac.status,'unavailable');
  const explicit=buildRevenueCohorts(input(mskNative,{timezone:MSK,leadBindings,paymentHistory:history({timezone:MSK})}));
  assert.equal(explicit.cohortTotals.newPayingClients.status,'verified');
  for(const timezone of [null,'Mars/Base','']) assert.throws(()=>buildRevenueCohorts(input(mskNative,{timezone:MSK,leadBindings,paymentHistory:history({timezone})})),{code:'BAD_TIMEZONE'});
});

test('конец native покрытия: незакрытые иркутские сутки сбора делают московский итог неполным',()=>{
  // Сбор 15.11 22:00Z = 16.11 06:00 Иркутск = 16.11 01:00 Москва. Завершены иркутские сутки по 15.11 включительно → покрытие до 15.11 16:00Z.
  // Сравнение строк дат (16.11 по Москве > observationTo 15.11) ошибочно сочло бы период закрытым.
  const cash=[pay(10),pay(11,{amount:5000,at:'2026-11-15T18:00:00.000Z'})];
  const y=snapshot([rec(1)],cash,{collectedAt:'2026-11-15T22:00:00.000Z'});
  const extra={leadBindings:[bind('1','yandex','spa',T)],spend:mskSpend('2026-10-01','2026-10-31',40000)};
  const open=buildRevenueCohorts(input(y,{...extra,timezone:MSK}));
  assert.equal(open.timeBasis.nativeCoverage.toUtcExclusive,'2026-11-15T16:00:00.000Z');
  assert.equal(open.timeBasis.nativeCoverage.observationEndGap,true);assert.equal(open.timeBasis.nativeCoverage.cohortEndGap,false);
  const n=open.cohortTotals.newPayingClients;
  assert.equal(n.status,'unavailable');assert.equal(n.value,null);assert.equal(n.knownValue,1);assert.ok(has(n,'PERIOD_NOT_CLOSED'));
  assert.equal(open.cohortTotals.activity.status,'partial');assert.equal(open.cohortTotals.activity.paymentKopecks,105000);
  assert.equal(open.economics.cac.status,'unavailable');assert.ok(has(open.economics.cac,'PERIOD_NOT_CLOSED'));
  assert.equal(open.calendar.status,'verified');
  const closed=buildRevenueCohorts(input(y,{...extra,timezone:MSK,observationTo:'2026-11-14'}));
  assert.equal(closed.cohortTotals.activity.status,'verified');assert.equal(closed.cohortTotals.activity.paymentKopecks,100000);
  assert.deepEqual(closed.economics.cac,{status:'verified',valueKopecks:40000,exact:{spendKopecks:40000,clients:1},reasons:[]});
  const irk=buildRevenueCohorts(input(y,{leadBindings:extra.leadBindings}));
  assert.deepEqual(irk.cohortTotals.newPayingClients,{status:'verified',value:1,knownValue:1,reasons:[]});
  assert.equal(irk.cohortTotals.activity.paymentKopecks,100000);
  assert.equal(closedAnalysisDay('2026-11-15T22:00:00.000Z',IRK,MSK),'2026-11-14');
  assert.equal(closedAnalysisDay('2026-11-15T22:00:00.000Z',IRK,IRK),'2026-11-15');
  assert.equal(closedAnalysisDay('2026-11-15T22:00:00.000Z',MSK,IRK),'2026-11-15');
  assert.throws(()=>closedAnalysisDay('2026-11-15T22:00:00.000Z','Mars/Base',MSK),{code:'BAD_TIMEZONE'});
});

test('нет native покрытия: выгрузка без завершённых суток не даёт проверенных нулей',()=>{
  // historyFrom 20.11 по Иркутску, сбор 20.11 13:00 Иркутск: покрытие пустое [19.11 16:00Z; 19.11 16:00Z).
  const y=snapshot([rec(1)],[pay(10)],{historyFrom:'2026-11-20',config:cfg({historyFrom:'2026-11-20'}),collectedAt:'2026-11-20T05:00:00.000Z'});
  const oct=buildRevenueCohorts(input(y,{timezone:MSK,leadBindings:[bind('1','yandex','spa',T)],spend:mskSpend('2026-10-01','2026-10-31',40000)}));
  const c=oct.timeBasis.nativeCoverage;
  assert.equal(c.fromUtc,'2026-11-19T16:00:00.000Z');assert.equal(c.toUtcExclusive,c.fromUtc);assert.equal(c.startGap,true);
  assert.equal(oct.calendar.status,'partial');assert.ok(has(oct.calendar,'HISTORY_AFTER_PERIOD_START'));
  const n=oct.cohortTotals.newPayingClients;
  assert.equal(n.status,'unavailable');assert.equal(n.value,null);assert.ok(has(n,'HISTORY_AFTER_PERIOD_START'));assert.ok(has(n,'PAYMENT_HISTORY_UNPROVEN'));
  assert.equal(oct.economics.cac.status,'unavailable');assert.equal(oct.economics.romi.status,'unavailable');assert.equal(oct.coverage.status,'partial');
  // Окно вокруг дня сбора: начало и конец вне пустого покрытия; ноль календаря не проверен.
  const today=buildRevenueCohorts(input(y,{timezone:MSK,cohort:{from:'2026-11-19',to:'2026-11-20'},observationTo:'2026-11-20'}));
  const g=today.timeBasis.nativeCoverage;
  assert.deepEqual([g.startGap,g.cohortEndGap,g.observationEndGap],[true,true,true]);
  assert.equal(today.calendar.paymentKopecks,0);assert.equal(today.calendar.status,'partial');
  assert.ok(has(today.calendar,'HISTORY_AFTER_PERIOD_START'));assert.ok(has(today.calendar,'PERIOD_NOT_CLOSED'));
  assert.equal(today.cohortTotals.newPayingClients.value,null);assert.ok(has(today.cohortTotals.newPayingClients,'PERIOD_NOT_CLOSED'));
  const missing=buildRevenueCohorts(input(null,{timezone:MSK}));
  assert.equal(missing.timeBasis.nativeTimezone,null);assert.equal(missing.timeBasis.nativeCoverage,null);
  assert.equal(missing.timeBasis.bounds.cohortFromUtc,'2026-09-30T21:00:00.000Z');assert.equal(missing.coverage.status,'unavailable');
  const stale=buildRevenueCohorts(input(snapshot([rec(1)],[pay(10)],{current:false}),{timezone:MSK}));
  assert.equal(stale.timeBasis.nativeTimezone,IRK);assert.equal(stale.timeBasis.nativeCoverage,null);assert.equal(stale.calendar.paymentKopecks,null);
});

test('деньги у полуночи Москвы и Иркутска не теряются и не удваиваются при делении окна',()=>{
  // 15.10: 15:59:59Z = 23:59:59 Иркутск; 16:00Z = 00:00 Иркутск 16.10; 20:59:59.999Z = 23:59:59.999 Москва; 21:00Z = 00:00 Москва 16.10.
  const cash=[pay(10,{amount:100,at:'2026-10-15T15:59:59.000Z'}),pay(11,{amount:1000,at:'2026-10-15T16:00:00.000Z'}),
    pay(12,{amount:10000,at:'2026-10-15T20:59:59.999Z'}),pay(13,{amount:100000,at:'2026-10-15T21:00:00.000Z'}),
    pay(14,{expenseId:REFUND,amount:500,at:'2026-10-15T16:00:00.000Z'})];
  const y=snapshot([rec(1)],cash);
  const run=(timezone,from,to,v={})=>buildRevenueCohorts(input(y,{timezone,cohort:{from,to},observationTo:'2026-10-31',...v}));
  const expected={[MSK]:{first:[11100,500],second:[100000,0]},[IRK]:{first:[100,0],second:[111000,500]}};
  for(const tz of [MSK,IRK]) {
    const first=run(tz,'2026-10-01','2026-10-15').calendar,second=run(tz,'2026-10-16','2026-10-31').calendar,whole=run(tz,'2026-10-01','2026-10-31').calendar;
    for(const c of [first,second,whole])assert.equal(c.status,'verified');
    assert.deepEqual([first.paymentKopecks,first.refundKopecks],expected[tz].first);
    assert.deepEqual([second.paymentKopecks,second.refundKopecks],expected[tz].second);
    assert.equal(first.paymentKopecks+second.paymentKopecks,whole.paymentKopecks);assert.equal(whole.paymentKopecks,111100);
    assert.equal(first.refundKopecks+second.refundKopecks,whole.refundKopecks);assert.equal(whole.netCashKopecks,110600);
    // Деньги одного клиента когорты считаются один раз в любом календаре отчёта.
    const cohort=run(tz,'2026-10-01','2026-10-31',{leadBindings:[bind('1','yandex','spa',T)]}).cohortTotals.activity;
    assert.equal(cohort.status,'verified');assert.equal(cohort.paymentKopecks,111100);assert.equal(cohort.netKopecks,110600);
  }
});
