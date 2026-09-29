'use strict';
/* Блок фактической статистики 2ГИС в сквозной аналитике.
   Компании, числа и периоды синтетические: реальная выгрузка в тесты не попадает. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const RANGE={from:'2026-09-01',to:'2026-09-03'};
const SKELETON=`<div id="analytics-periods"></div>
  <form id="analytics-dates"><input name="from"><input name="to"></form>
  <div id="platform-filter"><button id="platform-trigger" type="button"></button><div id="platform-panel"></div></div>
  <div id="analytics-content"></div><div id="analytics-legacy"></div>
  <section id="expenses-section"><h2>Расходы</h2><form id="expense-form"><input name="date"></form>
  <div id="expense-result"></div><div id="expenses-content"></div></section>`;

const dashboard=()=>({funnel:[],finance:{expenses:null,revenue:null,romi:null},sources:[]});
const summaryPayload=()=>({total:0,booked:0,visited:0,sales:0,sources:[]});
const metric=(key,label,over={})=>({metric:key,label,reportKind:'appearance',reportKindLabel:'Видимость',
  aggregation:'sum',total:0,totalAvailable:true,totalNote:'',min:null,max:null,daysWithValue:0,daysWithoutValue:0,days:[],...over});
const metricsPayload=(over={})=>({companyCode:'alvi',organizationId:'70000000000000101',branchId:'70000000000000102',
  period:{...RANGE},metrics:[
    metric('appearance_views','Показы',{total:10,daysWithValue:2}),
    metric('search_position','Позиция в выдаче',{aggregation:'daily_only',totalAvailable:false,min:4,max:7,daysWithValue:2}),
    metric('calls_and_phone_views','Звонки и просмотры телефона',{total:3,daysWithValue:1}),
    metric('address_clicks','Клики в адрес')],
  coverage:{expectedDays:3,dates:['2026-09-01','2026-09-02'],datesWithValue:['2026-09-01','2026-09-02']},...over});

function fixture({metricsResult=metricsPayload(),permissions=['analytics.view']}={}) {
  const dom=new JSDOM(`<main>${SKELETON}</main>`,{url:'https://cabinet.example.test/',runScripts:'outside-only'});
  const w=dom.window,d=w.document,views={},queries=[];
  w.SbCabinet={registerView:(name,view)=>{views[name]=view;}};
  w.eval(fs.readFileSync(__dirname+'/analytics.js','utf8'));
  const ctx={currentView:'analytics-through',selectedProjectId:'alvi',
    identity:{role:'owner',permissions,companies:[{id:'alvi',name:'АЛВИ'}]},
    byId:id=>d.getElementById(id),
    escapeHTML:value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),
    csrfOptions:(method,body)=>({method,body:JSON.stringify(body)}),
    scopeParams:()=>({companyCode:'alvi'}),
    formatMoney:value=>String(value),formatROMI:value=>String(value),
    periodDates:()=>({...RANGE}),dateValue:()=>'2026-09-03',
    crmQuery:async(path,params)=>{queries.push({path,params});
      if(path==='/dashboard')return dashboard();
      if(path==='/summary')return summaryPayload();
      if(path==='/expenses')return {expenses:[]};
      if(path==='/platform-demand/potential')return {error:true};
      if(path==='/platform-demand/company-metrics'){if(metricsResult instanceof Error)throw metricsResult;return metricsResult;}
      throw Error('unexpected '+path);}};
  return {w,d,ctx,views,queries,
    settle:async()=>{for(let i=0;i<8;i++)await tick();},
    section:()=>d.querySelector('.analytics-2gis'),
    async render(){views['analytics-through'].render(d.querySelector('main'),ctx);await this.settle();},
    close:()=>w.close()};
}

test('блок 2ГИС берёт тот же период, показывает итоги и не выдаёт позицию выдачи за сумму',async()=>{
  const f=fixture();try{
    await f.render();
    const call=f.queries.find(item=>item.path==='/platform-demand/company-metrics');
    assert.deepEqual({from:call.params.from,to:call.params.to},RANGE,'период тот же, что у остальной аналитики');
    assert.equal(call.params.companyCode,'alvi');
    const block=f.section();assert.ok(block);
    assert.match(block.textContent,/Показы/);assert.match(block.textContent,/4–7 по дням/);
    assert.doesNotMatch(block.textContent,/Клики в адрес/,'показатели без данных в сводку не попадают');
    assert.match(block.textContent,/Дней с измерениями: 2 из 3/);
    assert.match(block.textContent,/не состоявшиеся звонки/);
    assert.match(block.textContent,/не складываются/);
    assert.ok(block.querySelector('a[href="#platform-demand"]'),'есть ссылка на детали');
  }finally{f.close();}
});

test('ошибка показателей 2ГИС не ломает остальную аналитику и не выдаётся за ноль',async()=>{
  for(const result of [Error('backend detail'),{companyCode:'avokado',period:{...RANGE}}]) {
    const f=fixture({metricsResult:result});try{
      await f.render();
      assert.ok(f.d.getElementById('analytics-content').textContent.includes('Воронка'),'воронка осталась на месте');
      assert.match(f.section().textContent,/недоступны: состояние за период неизвестно/);
      assert.doesNotMatch(f.section().textContent,/backend detail/);
    }finally{f.close();}
  }
});

test('пустой период 2ГИС назван отсутствием отчётов, а не нулём показов',async()=>{
  const f=fixture({metricsResult:metricsPayload({metrics:[metric('appearance_views','Показы')]})});try{
    await f.render();
    assert.match(f.section().textContent,/не ноль показов, а отсутствие отчётов/);
  }finally{f.close();}
});

test('счётчик без сопоставимого итога не показывает «null–null», а называет причину',async()=>{
  const f=fixture({metricsResult:metricsPayload({metrics:[
    metric('page_visits','Переходы на страницу',{reportKind:'pagevisits',total:null,totalAvailable:false,
      totalNote:'Итог не считается: значения собраны при разных условиях и в один ряд не сводятся.',daysWithValue:2})]})});
  try{
    await f.render();
    assert.doesNotMatch(f.section().textContent,/null/);
    assert.match(f.section().textContent,/итог не сводится/);
    assert.match(f.section().textContent,/разных условиях/);
  }finally{f.close();}
});
