'use strict';
// Искусственные данные: ни ключей, ни клиентов из рабочих компаний.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const RANGE={from:'2026-10-01',to:'2026-10-08'};
const tick=()=>new Promise(r=>setImmediate(r));
const skeleton=`<div id="analytics-periods"></div><form id="analytics-dates"><input name="from"><input name="to"></form>
<div id="platform-filter"><button id="platform-trigger"></button><div id="platform-panel"></div></div>
<div id="analytics-content"></div><div id="analytics-legacy"></div><section id="expenses-section"><h2>Расходы</h2>
<form id="expense-form"><input name="date"></form><div id="expense-result"></div><div id="expenses-content"></div></section>`;
const payload=(code='demo-a')=>({companyCode:code,period:{...RANGE},state:{providers:[
  {provider:'metrika',configured:true,enabled:true,lastSuccess:'2026-10-08T08:00:00Z'},
  {provider:'yclients',configured:true,enabled:true,stale:true,errorCode:'ACCESS_DENIED',lastSuccess:'2026-10-07T08:00:00Z'}]},
  metrika:{current:true,timezone:'Asia/Irkutsk',collectedAt:'2026-10-08T08:00:00Z',overview:{totals:[17,13,120,20,1.4],sampled:true,sampleShare:0.5},
    goals:[{label:'Клик на запись <script>',visits:2,reaches:4,conversionRate:11.76}],
    utm:{rows:[{dimensions:[{name:'2gis'},{name:'paid_maps'}],metrics:[5,4,99]}]},sources:{rows:[{dimensions:[{name:'Ссылки с сайтов'},{name:'link.2gis.ru'}],metrics:[6,5,88]}]}},
  yclients:{createdBookings:3,cancelledBookings:1,attendedVisits:1,payingClients:1,paymentKopecks:100000,refundKopecks:20000,netCashKopecks:80000,
    financialClassificationComplete:false,unknownExpenseTransactions:2,unmatchedTransactions:1,bookingsWithSource:1,bookingsWithoutSource:2,
    partialHistory:true,historyFrom:'2026-10-02',sources:[{utm:null,bookings:2,attendedVisits:1,netCashKopecks:80000}]},
  economics:{cac:null,romi:null,reason:'Расходы и себестоимость ещё не подтверждены.'}});
function fixture({value=payload(),role='owner',custom}={}) {
  const dom=new JSDOM(`<main>${skeleton}</main>`,{url:'https://cabinet.example.test/',runScripts:'outside-only'}),w=dom.window,d=w.document,views={},calls=[];
  w.SbCabinet={registerView:(n,v)=>{views[n]=v;}};w.eval(fs.readFileSync(__dirname+'/analytics.js','utf8'));
  let company='demo-a';
  const ctx={currentView:'analytics-through',identity:{role,permissions:role==='owner'?['analytics.view','crm.edit']:['analytics.view'],companies:[]},
    byId:id=>d.getElementById(id),escapeHTML:s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    scopeParams:()=>({companyCode:company}),csrfOptions:(method,body)=>({method,body:JSON.stringify(body)}),
    formatMoney:v=>String(v)+' ₽',formatROMI:String,periodDates:()=>({...RANGE}),dateValue:()=>'2026-10-08',
    crmQuery:async(path,params,options)=>{calls.push({path,params,options});
      if(path==='/dashboard')return {funnel:[],sources:[],finance:{expenses:null,revenue:null,romi:null}};
      if(path==='/summary')return {total:0,booked:0,visited:0,sales:0,sources:[]};
      if(path==='/expenses')return {expenses:[]};
      if(path==='/platform-demand/potential'||path==='/platform-demand/company-metrics')return {error:true};
      if(custom)return custom(path,params,options);
      if(path==='/revenue-analytics'){if(value instanceof Error)throw value;return value;}
      return {collected:false};}};
  const settle=async()=>{for(let n=0;n<8;n++)await tick();};
  return {dom,d,ctx,views,calls,settle,block:()=>d.querySelector('.analytics-revenue'),
    change:async code=>{company=code;views['analytics-through'].onProjectChange(ctx);await settle();},
    render:async()=>{views['analytics-through'].render(d.querySelector('main'),ctx);await settle();},close:()=>w.close()};
}
test('блок различает цели, посещения, денежный поток, источник и частичную историю',async()=>{
  const f=fixture();try{await f.render();const b=f.block(),s=b.textContent;
    assert.match(s,/Визиты: 17/);assert.match(s,/среднее время: 120 сек/);assert.match(s,/доля 50%/);
    assert.match(s,/Клик на запись <script>/);assert.equal(b.querySelectorAll('script').length,0);
    assert.match(s,/отменено: 1/);assert.match(s,/возвраты: 200/);assert.match(s,/денежный итог: 800/);
    assert.match(s,/Источник неизвестен/);assert.match(s,/История до 2026-10-02 не загружена/);
    assert.match(s,/ошибка загрузки/);assert.match(s,/link.2gis.ru/);assert.match(s,/paid_maps/);
    assert.match(s,/не является конверсией одной группы/);assert.match(s,/фильтр площадок выше относится к прежней/);
  }finally{f.close();}
});
test('ошибка, чужая компания или период не отображаются как свои деньги или нули',async()=>{
  for(const value of [Error('SECRET'),payload('demo-b'),{...payload(),period:{from:'2026-01-01',to:'2026-01-02'}}]){
    const f=fixture({value});try{await f.render();assert.match(f.block().textContent,/ещё не доступен/);assert.doesNotMatch(f.block().textContent,/SECRET|800 ₽/);assert.match(f.d.getElementById('analytics-content').textContent,/Воронка/);}finally{f.close();}
  }
});
test('чтение для сотрудника не предлагает серверную запись',async()=>{
  const f=fixture({role:'employee'});try{await f.render();assert.equal(f.block().querySelector('[data-revenue-collect]'),null);assert.equal(f.calls.filter(c=>c.options?.method==='POST').length,0);}finally{f.close();}
});
test('запоздалая статистика первой компании не заменяет текущую',async()=>{
  let resolve;const first=new Promise(r=>{resolve=r;});let n=0;
  const f=fixture({custom:async()=>++n===1?first:payload('demo-b')});try{
    await f.render();await f.change('demo-b');assert.match(f.block().textContent,/Визиты: 17/);
    const old=payload();old.metrika.overview.totals[0]=9999;resolve(old);await f.settle();assert.doesNotMatch(f.block().textContent,/9999/);
  }finally{f.close();}
});
test('переключение компании во время сбора не запускает следующий источник',async()=>{
  let resolve;const pending=new Promise(r=>{resolve=r;});
  const f=fixture({custom:async(path,params)=>path==='/revenue-analytics'?payload(params.companyCode):pending});try{
    await f.render();f.block().querySelector('[data-revenue-collect]').click();await f.settle();await f.change('demo-b');resolve({collected:true});await f.settle();
    const writes=f.calls.filter(c=>c.path==='/revenue-analytics/collect');assert.equal(writes.length,1);assert.equal(writes[0].params.companyCode,'demo-a');
  }finally{f.close();}
});

test('неопределённое продление доступа видно отдельно от прежних успешных чисел',async()=>{
  const value=payload();value.state.providers[0].errorCode='TOKEN_REFRESH_UNCERTAIN';
  const f=fixture({value});try{await f.render();assert.match(f.block().textContent,/продление доступа не подтверждено/);assert.match(f.block().textContent,/Визиты: 17/);assert.doesNotMatch(f.block().textContent,/TOKEN_REFRESH_UNCERTAIN/);}finally{f.close();}
});
