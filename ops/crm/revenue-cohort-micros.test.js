'use strict';
// Точные micros расходов в когортах (T018). Все компании, клиенты, суммы и доказательства синтетические;
// это проверка вычислителя, а не живого Директа, reader или рабочей установки.
const test=require('node:test'),assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {buildRevenueCohorts,EVIDENCE}=require('./revenue-analytics-cohorts');
const A='demo-a',B='demo-b',PAY='900001',REFUND='900002',IRK='Asia/Irkutsk',MSK='Europe/Moscow';
const client=n=>crypto.createHmac('sha256','test-storage-key').update('revenue-client/v1/'+A+'/'+n).digest('hex');
const iso=s=>new Date(s).toISOString();
const ev=kind=>({kind,reference:'synthetic-'+kind,confirmedAt:'2026-10-12T00:00:00Z'});
const rec=n=>({id:String(n),visitId:String(n+1000),client:client(n),createdAt:iso('2026-10-02T10:00:00+08:00'),visitAt:iso('2026-10-03T10:00:00+08:00'),
  changedAt:iso('2026-10-03T12:00:00+08:00'),attendance:1,deleted:false,utm:{source:'yandex',medium:'cpc',campaign:'spa'},online:true});
const pay=(id,n,amount,v={})=>({id:String(id),recordId:String(n),visitId:String(n+1000),client:client(n),at:iso('2026-10-03T12:00:00+08:00'),
  amount,expenseId:PAY,deleted:false,...v});
const bind=n=>({companyCode:A,recordId:String(n),leadId:'lead_synthetic_'+n,firstTouch:{source:'yandex',campaign:'spa',at:iso('2026-10-02T09:00:00+08:00')},
  evidence:ev('server_lead_record_link')});
const cost=(n,costKopecks)=>({companyCode:A,recordId:String(n),costKopecks,currency:'RUB',vatMode:'no_vat',evidence:ev('accounting_ledger')});
const mc=amountMicros=>({amountMicros}),kop=amountKopecks=>({amountKopecks});
const fact=(id,amount,v={})=>({companyCode:A,id,provider:'yandex_direct',campaignId:'701',accountScope:'company',kind:'spend',
  serviceFrom:'2026-10-01',serviceTo:'2026-10-31',...amount,currency:'RUB',vatMode:'no_vat',timezone:IRK,allocations:null,evidence:ev('direct_reports_api'),...v});
const campaign=(campaignId,source='yandex',name='spa')=>({companyCode:A,provider:'yandex_direct',campaignId,utm:{source,campaign:name},evidence:ev('ad_cabinet_export')});
const spend=(facts,v={})=>({companyCode:A,from:'2026-10-01',to:'2026-10-31',providers:['yandex_direct'],evidence:ev('owner_confirmed'),
  facts,campaigns:[campaign('701'),campaign('702')],...v});
// Каждый клиент привлечён в октябре подтверждённой связью и платит один раз; себестоимость по умолчанию 0.
function flow(facts,{payments=[100000],refunds=[],costs,spendV={},...v}={}) {
  const records=payments.map((_,i)=>rec(i+1));
  const cash=[...payments.map((amount,i)=>pay(100+i,i+1,amount)),
    ...refunds.map(([n,amount],i)=>pay(200+i,n,amount,{expenseId:REFUND,at:iso('2026-10-20T12:00:00+08:00')}))];
  return {companyCode:A,cohort:{from:'2026-10-01',to:'2026-10-31'},observationTo:'2026-11-15',timezone:IRK,currency:'RUB',vatMode:'no_vat',
    yclients:{companyCode:A,current:true,collectedAt:'2026-11-20T00:00:00.000Z',historyFrom:'2026-01-01',
      config:{externalId:'101',historyFrom:'2026-01-01',timezone:IRK,cashRules:[{expenseId:PAY,kind:'payment'},{expenseId:REFUND,kind:'refund'}]},records,cash},
    paymentHistory:{companyCode:A,noPaymentsBefore:'2026-01-01',evidence:ev('owner_confirmed_opening_date')},
    leadBindings:records.map(r=>bind(r.id)),spend:spend(facts,spendV),recordCosts:records.map((r,i)=>cost(r.id,costs?.[i]??0)),...v};
}
const run=(facts,v)=>buildRevenueCohorts(flow(facts,v));
const has=(m,code)=>m.reasons.some(r=>r.code===code);
const yandex=out=>out.rows.find(r=>r.basis==='first_touch'&&r.attribution?.source==='yandex');
const strip=v=>Array.isArray(v)?v.map(strip):v&&typeof v==='object'?
  Object.fromEntries(Object.entries(v).filter(([k])=>k!=='knownMicros'&&k!=='spendMicros').map(([k,x])=>[k,strip(x)])):v;

test('пустой полный native range сохраняет точный knownMicros ноль при partial глобальном реестре',()=>{
 const out=run([],{spendV:{complete:false,evidence:ev('native_report_range')}});
 assert.equal(out.spend.knownMicros,0);assert.notEqual(out.spend.status,'verified');
});
test('сумма несовместимых валют/НДС/суток не выдаётся как известный общий расход',()=>{
 for(const field of ['currency','vatMode','timezone']){
  const bad={currency:'USD',vatMode:'vat_included',timezone:MSK}[field];
  const out=run([fact('a',mc(10000)),fact('b',mc(20000),{[field]:bad})]);
  assert.equal(out.spend.knownKopecks,null,field);assert.equal(out.spend.knownMicros,null,field);
  assert.notEqual(out.economics.cac.status,'verified');
 }
});
test('coveredRanges с пробелом не подтверждает весь период даже с complete true, пересечение/foreign bounds отклоняются',()=>{
 const facts=[fact('a',mc(10000))];
 const gap=run(facts,{spendV:{complete:true,coveredRanges:[{from:'2026-10-01',to:'2026-10-05'},{from:'2026-10-07',to:'2026-10-31'}]}});
 assert.ok(has(gap.spend,'SPEND_COVERAGE_MISSING'));assert.notEqual(gap.economics.cac.status,'verified');
 for(const coveredRanges of [[{from:'2026-09-30',to:'2026-10-03'}],[{from:'2026-10-01',to:'2026-10-05'},{from:'2026-10-04',to:'2026-10-09'}]])
  assert.throws(()=>run(facts,{spendV:{coveredRanges}}),{code:'SPEND_COVERAGE_CONTRADICTION'});
});

test('3×3333 micros: итог 9999 micros округляется один раз в 1 копейку, а не построчно в 0',()=>{
  const out=run([fact('d1',mc(3333)),fact('d2',mc(3333)),fact('d3',mc(3333))]);
  assert.equal(out.spend.status,'verified');assert.equal(out.spend.knownMicros,9999);assert.equal(out.spend.knownKopecks,1);
  assert.deepEqual(out.spend.channels,[{utm:{source:'yandex',campaign:'spa'},spendKopecks:1,spendMicros:9999}]);
  assert.deepEqual(out.economics.cac,{status:'verified',valueKopecks:1,exact:{spendKopecks:1,spendMicros:9999,clients:1},reasons:[]});
  // ROMI = (100 000 коп. × 10 000 − 9 999) / 9 999 × 10 000 = 1 000 090 010,001 б.п.; при 1 коп. было бы 999 990 000.
  assert.deepEqual(out.economics.romi,{status:'verified',basisPoints:1000090010,exact:{netMarginKopecks:100000,spendKopecks:1,spendMicros:9999},reasons:[]});
  const row=yandex(out);assert.equal(row.spendMicros,9999);assert.equal(row.spendKopecks,1);assert.equal(row.romi.basisPoints,1000090010);
  for(const v of [out.spend.knownMicros,out.economics.romi.basisPoints,row.spendMicros])assert.ok(Number.isSafeInteger(v));
});

test('CAC нескольких клиентов и канала делит точные micros, без промежуточного округления',()=>{
  // 5000 µ (701) + 5000 µ (702) + 15000 µ (701) = 25000 µ = 2,5 коп. на 2 клиента = 1,25 → 1 коп.
  // Построчное округление дало бы (1+1+2)/2 = 2, округление итога до деления — 3/2 = 1,5 → 2.
  const out=run([fact('d1',mc(5000)),fact('d2',mc(5000),{campaignId:'702'}),fact('d3',mc(15000))],{payments:[100000,100000]});
  assert.equal(out.spend.knownMicros,25000);assert.equal(out.spend.knownKopecks,3);
  assert.deepEqual(out.economics.cac,{status:'verified',valueKopecks:1,exact:{spendKopecks:3,spendMicros:25000,clients:2},reasons:[]});
  // ROMI = (200 000 × 10 000 − 25 000) / 25 000 × 10 000 = 799 990 000 б.п.
  assert.equal(out.economics.romi.basisPoints,799990000);
  const row=yandex(out);
  assert.equal(row.clients,2);assert.equal(row.spendMicros,25000);assert.equal(row.spendKopecks,3);
  assert.deepEqual(row.cac,{status:'verified',valueKopecks:1,reasons:[]});
  assert.deepEqual(row.romi,{status:'verified',basisPoints:799990000,exact:{netMarginKopecks:200000,spendKopecks:3,spendMicros:25000},reasons:[]});
});

test('ROMI с дробной копейкой отличается от преждевременно округлённого; отрицательная маржа и возврат',()=>{
  // 15000 µ = 1,5 коп.; маржа 3 коп.: точно (3 − 1,5) / 1,5 = 100%, а при 2 коп. было бы 50%.
  const half=run([fact('d1',mc(15000))],{payments:[3]});
  assert.equal(half.spend.knownKopecks,2);
  assert.deepEqual(half.economics.romi,{status:'verified',basisPoints:10000,exact:{netMarginKopecks:3,spendKopecks:2,spendMicros:15000},reasons:[]});
  assert.equal(half.economics.cac.valueKopecks,2);
  // Оплата 100, возврат 40, себестоимость 70: маржа −10 коп.; расход 25000 µ = 2,5 коп.
  // ROMI = (−100 000 − 25 000) / 25 000 × 10 000 = −50 000; при 3 коп. было бы −43 333.
  const loss=run([fact('d1',mc(25000))],{payments:[100],refunds:[[1,40]],costs:[70]});
  const a=loss.cohortTotals.activity;
  assert.equal(a.status,'verified');assert.equal(a.paymentKopecks,100);assert.equal(a.refundKopecks,40);assert.equal(a.netKopecks,60);
  assert.deepEqual(loss.cohortTotals.margin,{status:'verified',valueKopecks:-10,costKopecks:70,reasons:[]});
  assert.deepEqual(loss.economics.romi,{status:'verified',basisPoints:-50000,exact:{netMarginKopecks:-10,spendKopecks:3,spendMicros:25000},reasons:[]});
  assert.equal(yandex(loss).romi.basisPoints,-50000);
  // Половина округляется от нуля, как прежде: −330 000 / 320 000 × 10 000 = −10 312,5 → −10 313.
  const tie=run([fact('d1',mc(320000))],{payments:[1],costs:[2]});
  assert.equal(tie.cohortTotals.margin.valueKopecks,-1);assert.equal(tie.economics.romi.basisPoints,-10313);
});

test('положительный 1 micro отображается как 0 копеек, но не является нулевым расходом',()=>{
  const one=run([fact('d1',mc(1))],{payments:[100]});
  assert.equal(one.spend.status,'verified');assert.equal(one.spend.knownKopecks,0);assert.equal(one.spend.knownMicros,1);
  assert.deepEqual(one.economics.cac,{status:'verified',valueKopecks:0,exact:{spendKopecks:0,spendMicros:1,clients:1},reasons:[]});
  assert.equal(one.economics.romi.status,'verified');assert.ok(!has(one.economics.romi,'ZERO_SPEND'));
  // (100 × 10 000 − 1) / 1 × 10 000.
  assert.equal(one.economics.romi.basisPoints,9999990000);assert.equal(one.economics.romi.exact.spendMicros,1);
  assert.equal(yandex(one).romi.status,'verified');assert.equal(yandex(one).spendMicros,1);
  const zero=run([fact('d1',mc(0))],{payments:[100]});
  assert.equal(zero.economics.romi.status,'not_applicable');assert.ok(has(zero.economics.romi,'ZERO_SPEND'));
  assert.deepEqual(zero.economics.romi.exact,{netMarginKopecks:100,spendKopecks:0,spendMicros:0});
  assert.equal(yandex(zero).romi.status,'not_applicable');assert.equal(zero.spend.knownMicros,0);
});

test('смешанные единицы и пакет с распределением в micros складываются точно и проверяются целиком',()=>{
  // Копеечный факт 100 коп. = 1 000 000 µ; пакет 3 000 000 µ c 15.10 по 14.11, октябрю подтверждено 1 700 001 µ.
  const pkg=(allocations,v={})=>fact('p1',mc(3000000),{kind:'package',serviceFrom:'2026-10-15',serviceTo:'2026-11-14',evidence:ev('closing_act'),allocations,...v});
  const alloc=()=>[{from:'2026-10-15',to:'2026-10-31',amountMicros:1700001},{from:'2026-11-01',to:'2026-11-14',amountMicros:1299999}];
  const out=run([fact('k1',kop(100),{evidence:ev('ad_cabinet_export')}),pkg(alloc())]);
  assert.equal(out.spend.status,'verified');assert.equal(out.spend.knownMicros,2700001);assert.equal(out.spend.knownKopecks,270);
  assert.deepEqual(out.economics.cac.exact,{spendKopecks:270,spendMicros:2700001,clients:1});
  // (100 000 × 10 000 − 2 700 001) / 2 700 001 × 10 000 = 3 693 702,33…
  assert.equal(out.economics.romi.basisPoints,3693702);
  // Без распределения пакет не попадает в сумму и делает экономику недоступной.
  const open=run([fact('k1',kop(100)),pkg(null)]);
  assert.ok(has(open.spend,'EXPENSE_PERIOD_UNALLOCATED'));assert.equal(open.spend.knownMicros,1000000);assert.equal(open.economics.cac.status,'unavailable');
  const off=alloc();off[1].amountMicros=1299998;
  assert.throws(()=>run([pkg(off)]),{code:'ALLOCATION_MISMATCH'});
  const mixed=alloc();mixed[1]={from:'2026-11-01',to:'2026-11-14',amountKopecks:130};
  assert.throws(()=>run([pkg(mixed)]),{code:'ALLOCATION_UNIT_MISMATCH'});
  assert.throws(()=>run([fact('k1',kop(300),{kind:'package',serviceFrom:'2026-10-15',serviceTo:'2026-11-14',
    allocations:[{from:'2026-10-15',to:'2026-10-31',amountMicros:1700000},{from:'2026-11-01',to:'2026-11-14',amountKopecks:130}]})]),{code:'ALLOCATION_UNIT_MISMATCH'});
  // Две единицы в одном факте или ни одной — ошибка, не выбор.
  assert.throws(()=>run([fact('d1',{amountKopecks:1,amountMicros:10000})]),{code:'VALIDATION_ERROR'});
  assert.throws(()=>run([fact('d1',{})]),{code:'VALIDATION_ERROR'});
});

test('micros: только безопасные целые ≥ 0; переполнение итога и смешанных единиц отклоняется',()=>{
  for(const bad of [Number.MAX_SAFE_INTEGER+1,'1000',0.5,-1,null,1n])assert.throws(()=>run([fact('d1',mc(bad))]),{code:'BAD_MONEY'});
  assert.throws(()=>run([fact('d1',mc(Number.MAX_SAFE_INTEGER)),fact('d2',mc(Number.MAX_SAFE_INTEGER))]),{code:'MONEY_OVERFLOW'});
  assert.throws(()=>run([fact('k1',kop(1e15)),fact('d1',mc(1))]),{code:'MONEY_OVERFLOW'});
  // Прежний копеечный вход той же величины не переводится в micros наружу и работает как раньше.
  const legacy=run([fact('k1',kop(1e15))]);
  assert.equal(legacy.spend.knownKopecks,1e15);assert.equal('knownMicros' in legacy.spend,false);
  assert.deepEqual(legacy.economics.cac.exact,{spendKopecks:1e15,clients:1});
  const big=run([fact('d1',mc(Number.MAX_SAFE_INTEGER))]);
  assert.equal(big.spend.knownMicros,Number.MAX_SAFE_INTEGER);assert.equal(big.spend.knownKopecks,900719925474);
  assert.doesNotThrow(()=>JSON.stringify(big));
});

test('чужая компания, дубли и противоречия словаря остаются ошибками или неполнотой',()=>{
  assert.throws(()=>run([fact('d1',mc(5000),{companyCode:B})]),{code:'FOREIGN_COMPANY'});
  assert.throws(()=>run([fact('d1',mc(5000)),fact('d1',mc(7000))]),{code:'DUPLICATE_ROW'});
  const i=flow([fact('d1',mc(25000))],{payments:[100000]});i.spend.campaigns.push(campaign('701','vk','other'));
  const out=buildRevenueCohorts(i);
  assert.ok(out.spend.channelReasons.some(r=>r.code==='CAMPAIGN_DICTIONARY_CONFLICT'));assert.equal(out.spend.channelStatus,'partial');
  assert.deepEqual(out.spend.channels,[]);
  assert.equal(out.economics.cac.status,'verified');assert.equal(out.economics.cac.exact.spendMicros,25000);
  assert.equal(yandex(out).cac.status,'unavailable');assert.equal(yandex(out).spendMicros,null);
  const usd=run([fact('d1',mc(25000),{currency:'USD'})]);
  assert.ok(has(usd.spend,'CURRENCY_MISMATCH'));assert.equal(usd.economics.cac.status,'unavailable');assert.equal(usd.economics.cac.exact,null);
});

test('native частичный диапазон всегда partial и не поднимается флагами',()=>{
  assert.ok(EVIDENCE.spendCoverage.includes('native_report_range'));assert.ok(EVIDENCE.spend.includes('direct_reports_api'));
  const partial={evidence:ev('native_report_range'),complete:false};
  // 1 234 567 890 µ = 123 456,789 коп. → 123 457 только в отображении.
  const out=run([fact('d1',mc(1234567890))],{spendV:partial});
  assert.equal(out.spend.status,'partial');assert.ok(has(out.spend,'SPEND_COVERAGE_MISSING'));
  assert.equal(out.spend.knownMicros,1234567890);assert.equal(out.spend.knownKopecks,123457);
  for(const m of [out.economics.cac,out.economics.romi]){assert.equal(m.status,'unavailable');assert.ok(has(m,'SPEND_COVERAGE_MISSING'));assert.equal(m.exact,null);}
  assert.equal(yandex(out).cac.status,'unavailable');
  assert.equal(out.coverage.status,'partial');assert.ok(out.coverage.reasons.some(r=>r.code==='SPEND_COVERAGE_MISSING'));
  // Клиенты, первое касание и журнал заявок расходом не повышаются и не понижаются.
  assert.deepEqual(out.cohortTotals.newPayingClients,{status:'verified',value:1,knownValue:1,reasons:[]});
  assert.equal(out.source.leadJournal,'not_integrated');assert.equal(out.cohortTotals.funnel.leadsWithoutBooking.status,'unavailable');
  const unbound=run([fact('d1',mc(1))],{spendV:partial,leadBindings:[]});
  assert.ok(has(unbound.cohortTotals.newPayingClients,'ATTRIBUTION_UNBOUND'));assert.equal(unbound.attribution.firstTouch.status,'partial');
  // Прежние проверки валюты, суток и НДС сохраняются и для частичного диапазона.
  const msk=run([fact('d1',mc(5000),{timezone:MSK,vatMode:'vat_included',currency:'USD'})],{spendV:partial});
  for(const code of ['SPEND_COVERAGE_MISSING','TIMEZONE_MISMATCH','VAT_MODE_MISMATCH','CURRENCY_MISMATCH'])assert.ok(has(msk.spend,code),code);
  // Ни complete:true, ни отсутствие поля не делают native диапазон полным реестром.
  assert.throws(()=>run([fact('d1',mc(1))],{spendV:{evidence:ev('native_report_range'),complete:true}}),{code:'EVIDENCE_REJECTED'});
  assert.throws(()=>run([fact('d1',mc(1))],{spendV:{evidence:ev('native_report_range')}}),{code:'EVIDENCE_REJECTED'});
  for(const complete of ['false','true',0,1,null])assert.throws(()=>run([fact('d1',mc(1))],{spendV:{...partial,complete}}),{code:'VALIDATION_ERROR'});
  // Виды доказательств не взаимозаменяемы; посторонние флаги отклоняются.
  assert.throws(()=>run([fact('d1',mc(1))],{spendV:{evidence:ev('direct_reports_api'),complete:false}}),{code:'EVIDENCE_REJECTED'});
  assert.throws(()=>run([fact('d1',mc(1),{evidence:ev('native_report_range')})]),{code:'EVIDENCE_REJECTED'});
  assert.throws(()=>run([fact('d1',mc(1))],{spendV:{...partial,fullRegistry:true}}),{code:'VALIDATION_ERROR'});
  assert.throws(()=>run([fact('d1',mc(1),{complete:true})]),{code:'VALIDATION_ERROR'});
  // Прежний доверенный перечень: явный complete:false — неполнота, complete:true — то же, что без поля.
  const owner=run([fact('d1',mc(5000))],{spendV:{complete:false}});
  assert.equal(owner.spend.status,'partial');assert.ok(has(owner.economics.cac,'SPEND_COVERAGE_MISSING'));
  assert.deepEqual(run([fact('d1',mc(5000))],{spendV:{complete:true}}),run([fact('d1',mc(5000))]));
});

test('прежние целокопеечные входы дают прежнюю форму; равные micros — те же числа плюс точные поля',()=>{
  const opts={payments:[300000,200000,100000],costs:[100000,80000,30000],refunds:[[1,50000]]};
  const legacy=run([fact('k1',kop(100000),{evidence:ev('ad_cabinet_export')}),fact('k2',kop(150000),{campaignId:'702',evidence:ev('ad_cabinet_export')})],opts);
  const micro=run([fact('k1',mc(1000000000)),fact('k2',mc(1500000000),{campaignId:'702'})],opts);
  // Те же значения, что в прежней полной синтетической цепочке: CAC 83 333, ROMI 3 600 б.п.
  assert.deepEqual(legacy.economics.cac,{status:'verified',valueKopecks:83333,exact:{spendKopecks:250000,clients:3},reasons:[]});
  assert.deepEqual(legacy.economics.romi,{status:'verified',basisPoints:3600,exact:{netMarginKopecks:340000,spendKopecks:250000},reasons:[]});
  assert.equal('knownMicros' in legacy.spend,false);assert.ok(legacy.rows.every(r=>!('spendMicros' in r)));
  assert.ok(legacy.spend.channels.every(c=>!('spendMicros' in c)));
  assert.deepEqual(micro.economics.cac.exact,{spendKopecks:250000,spendMicros:2500000000,clients:3});
  assert.ok(micro.rows.every(r=>'spendMicros' in r));
  assert.deepEqual(strip(micro),legacy);
  // Без расхода форма также прежняя.
  const none=buildRevenueCohorts({...flow([]),spend:null});
  assert.equal(none.spend.knownKopecks,null);assert.equal('knownMicros' in none.spend,false);assert.equal(none.economics.cac.status,'unavailable');
});
