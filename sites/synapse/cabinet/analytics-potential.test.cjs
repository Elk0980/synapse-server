'use strict';
// Ступень «Потенциал» сквозной аналитики: снимок 2ГИС берётся только для выбранной компании и периода,
// показывается с точным покрытием, никогда не выдаёт общий спрос за целевой и не превращается в процент
// конверсии; устаревшие ответы не перезаписывают новые.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const SOURCE=fs.readFileSync(require.resolve('./analytics.js'),'utf8');
const SHELL=fs.readFileSync(require.resolve('../cabinet.html'),'utf8');
const section=SHELL.slice(SHELL.indexOf('<section class="view-panel" id="analytics-through-view"'),SHELL.indexOf('<section class="view-panel" id="ad-platforms-view"'));
const tick=async(n=3)=>{for(let i=0;i<n;i++)await new Promise(resolve=>setImmediate(resolve));};
const empty={sourceStats:[],summary:{total:0,booked:0,visited:0,sales:0},expenses:null},summary={sources:[]},expenses={expenses:[]};
const AUG={from:'2026-08-01',to:'2026-08-31'};
const potentialFor=(code,over={})=>({company:{code,name:code},organization:{id:code==='avokado'?'777':'70000001061502047',name:code,city:'Иркутск'},
  requested:{...AUG},metric:'searches',kind:'snapshot',available:true,datasetIds:[5],capturedAt:'2026-09-17T09:00:00.000Z',granularities:['month'],
  availablePeriod:{from:'2025-09-01',to:'2026-09-16'},covered:{...AUG},uncovered:[],complete:true,partial:false,suggested:null,
  totals:{all:206783,target:90388,nonTarget:32275,unclassified:84120},unclassifiedCategories:['Косметолог','Медитация'],missingCategories:[],excluded:[],
  periods:[{periodStart:'2026-08-01',periodEnd:'2026-08-31',granularity:'month',partial:false}],note:'',...over});

async function fixture({code='alvi',permissions=['analytics.view'],potential,dashboard=empty,range=AUG,respond}={}){
 const dom=new JSDOM(`<div>${section}</div>`,{url:'https://cabinet.test/cabinet.html#analytics-through',runScripts:'outside-only'}),w=dom.window,d=w.document,views={},calls=[];
 w.SbCabinet={registerView:(name,view)=>{views[name]=view;}};w.eval(SOURCE);
 let selected=code,currentRange={...range};
 const ctx={currentView:'analytics-through',get selectedProjectId(){return selected;},identity:{role:'marketer',permissions},byId:id=>d.getElementById(id),
  escapeHTML:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  csrfOptions:(method,body)=>({method,body:JSON.stringify(body)}),scopeParams:()=>({companyCode:selected}),
  formatMoney:v=>String(v)+' ₽',formatROMI:v=>v===null?'—':String(v)+'%',dateValue:()=>'2026-09-17',
  periodDates:()=>({...currentRange}),
  crmQuery:async(path,params)=>{const call={path,params:{...params}};calls.push(call);
   if(respond){const value=await respond(call);if(value!==undefined)return value;}
   if(path==='/dashboard')return dashboard;if(path==='/summary')return summary;if(path==='/expenses')return expenses;
   if(path==='/platform-demand/potential'){const value=typeof potential==='function'?await potential(params):potential;if(value instanceof Error)throw value;return value;}
   throw Error('unexpected '+path);}};
 const container=d.getElementById('analytics-through-view');
 views['analytics-through'].render(container,ctx);await tick();
 const card=()=>d.querySelector('.funnel-step .funnel-card'),conversion=()=>d.querySelectorAll('.funnel-conversion')[1]?.textContent||'',
  detail=()=>d.querySelector('[data-funnel-detail="potential"]').textContent,content=()=>d.getElementById('analytics-content').textContent;
 return {dom,w,d,ctx,calls,views,container,card,conversion,detail,content,setCompany(next){selected=next;views['analytics-through'].onProjectChange(ctx);},
  setRange(next){currentRange={...next};d.getElementById('analytics-dates').elements.from.value=next.from;d.getElementById('analytics-dates').elements.to.value=next.to;
   d.getElementById('analytics-dates').dispatchEvent(new w.Event('submit',{cancelable:true}));},
  toggle2gis(){const box=d.querySelector('#platform-panel input[value="2gis"]');box.checked=!box.checked;box.dispatchEvent(new w.Event('change',{bubbles:true}));}};
}

test('potential is requested for the selected company and period and rendered as a snapshot of target rubric searches with overlap caveat',async()=>{
 const f=await fixture({potential:potentialFor('alvi')});try{
  const request=f.calls.find(call=>call.path==='/platform-demand/potential');assert.deepEqual(request.params,{from:'2026-08-01',to:'2026-08-31',companyCode:'alvi'});
  assert.match(f.card().querySelector('.funnel-number').textContent,/90\s?388/);
  assert.match(f.card().textContent,/только целевые рубрики/);assert.match(f.card().textContent,/всего по рубрикам: 206\s?783/);
  assert.match(f.card().textContent,/не назначено 2: Косметолог, Медитация/);assert.match(f.card().textContent,/покрыт целиком, целые месяцы/);
  assert.match(f.card().textContent,/рубрики могут пересекаться, это не уникальные люди/);
  assert.equal(f.card().querySelector('.data-mark').dataset.kind,'snapshot');assert.match(f.card().querySelector('.data-mark').textContent,/СНИМОК от 17\.09\.2026/);
  assert.match(f.detail(),/целевые рубрики\s*90\s?388/);assert.match(f.detail(),/все рубрики\s*206\s?783/);assert.match(f.detail(),/не назначено\s*84\s?120/);
 }finally{f.dom.window.close();}
});

test('potential → views is never expressed as a percentage, even for a complete period; later steps still convert',async()=>{
 const views={...empty,sourceStats:[{source:'2gis',external:{pageViews:1000,siteClicks:40},externalCapturedAt:'2026-09-17T09:00:00.000Z',clicks:5,leads:1}]};
 const f=await fixture({dashboard:views,potential:potentialFor('alvi')});
 try{assert.equal(f.conversion(),'Конверсия из предыдущей ступени: — (показатели напрямую не сопоставимы)');
  assert.match(f.d.querySelectorAll('.funnel-conversion')[2].textContent,/%/,'views → clicks keeps its percentage');}
 finally{f.dom.window.close();}
});

test('total demand is never shown as target when rubrics are unclassified or missing in some periods',async()=>{
 const unclassified=await fixture({potential:potentialFor('alvi',{totals:{all:206783,target:null,nonTarget:null,unclassified:206783},unclassifiedCategories:['Массажист','SPA-процедуры']})});
 try{assert.equal(unclassified.card().querySelector('.funnel-number'),null);assert.match(unclassified.card().textContent,/целевой спрос не считается \(не назначено 2: Массажист, SPA-процедуры\)/);
  assert.match(unclassified.card().textContent,/Всего по рубрикам: 206\s?783/);assert.match(unclassified.card().textContent,/Назначьте рубрики/);}
 finally{unclassified.dom.window.close();}
 const missing=await fixture({potential:potentialFor('alvi',{complete:false,totals:{all:400,target:null,nonTarget:39,unclassified:null},unclassifiedCategories:[],missingCategories:['Массаж']})});
 try{assert.equal(missing.card().querySelector('.funnel-number'),null);assert.match(missing.card().textContent,/в части периодов нет рубрик: Массаж — итог по ним неизвестен/);}
 finally{missing.dom.window.close();}
});

test('partial coverage names the covered and uncovered stretches with the snapshot granularity instead of prorating',async()=>{
 const f=await fixture({range:{from:'2026-08-18',to:'2026-09-17'},potential:potentialFor('alvi',{requested:{from:'2026-08-18',to:'2026-09-17'},covered:{from:'2026-09-01',to:'2026-09-16'},
  uncovered:[{from:'2026-08-18',to:'2026-08-31'},{from:'2026-09-17',to:'2026-09-17'}],complete:false,partial:true,
  periods:[{periodStart:'2026-09-01',periodEnd:'2026-09-16',granularity:'month',partial:true}],totals:{all:91485,target:40138,nonTarget:12970,unclassified:38377},
  suggested:{from:'2026-08-01',to:'2026-09-16',granularities:['month'],partial:true}})});
 try{const text=f.card().textContent;
  assert.match(text,/покрыто 01\.09\.2026–16\.09\.2026, не покрыто: 18\.08\.2026–31\.08\.2026, 17\.09\.2026–17\.09\.2026/);
  assert.match(text,/неполный период снимка: 01\.09\.2026–16\.09\.2026/);
  assert.match(text,/Ближайший доступный диапазон снимка \(по месяцам снимка, есть неполный период\): 01\.08\.2026–16\.09\.2026/);assert.doesNotMatch(text,/целые месяцы/);
  assert.doesNotMatch(text,/нет ни одного целого/);}
 finally{f.dom.window.close();}
 const week=await fixture({potential:potentialFor('alvi',{granularities:['week'],periods:[{periodStart:'2026-08-03',periodEnd:'2026-08-09',granularity:'week',partial:false}]})});
 try{assert.match(week.card().textContent,/покрыт целиком, целые недели/);}finally{week.dom.window.close();}
 const partialMonth=await fixture({range:{from:'2026-08-01',to:'2026-09-16'},potential:potentialFor('alvi',{partial:true,periods:[{periodStart:'2026-08-01',periodEnd:'2026-08-31',granularity:'month',partial:false},{periodStart:'2026-09-01',periodEnd:'2026-09-16',granularity:'month',partial:true}],requested:{from:'2026-08-01',to:'2026-09-16'},covered:{from:'2026-08-01',to:'2026-09-16'}})});
 try{const text=partialMonth.card().textContent;assert.match(text,/покрыт целиком, по месяцам снимка, есть неполный период/);assert.match(text,/неполный период снимка: 01\.09\.2026–16\.09\.2026/);assert.doesNotMatch(text,/целые месяцы/);}finally{partialMonth.dom.window.close();}
 const none=await fixture({potential:potentialFor('alvi',{covered:null,complete:false,totals:{all:null,target:null,nonTarget:null,unclassified:null},unclassifiedCategories:[],periods:[],suggested:{from:'2026-08-01',to:'2026-08-31',granularities:['month'],partial:false}})});
 try{assert.equal(none.card().querySelector('.data-mark').dataset.kind,'none');assert.match(none.card().textContent,/нет ни одного целого периода снимка \(в снимке: 01\.09\.2025–16\.09\.2026\)/);
  assert.match(none.card().textContent,/Ближайший доступный диапазон снимка \(целые месяцы\): 01\.08\.2026–31\.08\.2026\./);}
 finally{none.dom.window.close();}
});

test('missing snapshot, request failure, foreign-company or foreign-period response and deselected 2GIS are distinct honest states',async()=>{
 const missing=await fixture({potential:potentialFor('alvi',{available:false,organization:null,covered:null,totals:{all:null,target:null,nonTarget:null,unclassified:null},availablePeriod:null})});
 try{assert.match(missing.card().textContent,/снимок не загружен — добавьте его в разделе «Потенциал 2ГИС»/);assert.equal(missing.card().querySelector('.data-mark').dataset.kind,'none');}finally{missing.dom.window.close();}
 const failed=await fixture({potential:Object.assign(Error('boom'),{status:500})});
 try{assert.match(failed.card().textContent,/снимок сейчас недоступен/);assert.ok(failed.d.querySelector('.analytics-source-table'),'the rest of analytics still renders');}finally{failed.dom.window.close();}
 for(const value of [potentialFor('avokado'),potentialFor('alvi',{requested:{from:'2026-07-01',to:'2026-07-31'}})]){
  const foreign=await fixture({potential:value});
  try{assert.match(foreign.card().textContent,/снимок сейчас недоступен/);assert.doesNotMatch(foreign.card().textContent,/90\s?388/);}finally{foreign.dom.window.close();}}
 const deselected=await fixture({potential:potentialFor('alvi')});
 try{deselected.toggle2gis();assert.match(deselected.card().textContent,/площадка 2ГИС не выбрана в фильтре/);assert.equal(deselected.card().querySelector('.funnel-number'),null);
  assert.equal(deselected.calls.filter(call=>call.path==='/platform-demand/potential').length,1,'filter changes re-render from the cached payload');}
 finally{deselected.dom.window.close();}
});

test('stale responses never overwrite newer ones: period change, A→B→A company switch, failure and filter during loading',async()=>{
 const pending=new Map();const respond=call=>{if(call.path!=='/dashboard')return undefined;
  return new Promise((resolve,reject)=>{pending.set(call.params.companyCode+'|'+call.params.from,{resolve,reject});});};
 const dashboardFor=label=>({...empty,sourceStats:[{source:'2gis',external:{pageViews:label},externalCapturedAt:'2026-09-17T09:00:00.000Z'}]});
 const f=await fixture({respond,potential:params=>potentialFor(params.companyCode,{requested:{from:params.from,to:params.to},covered:{from:params.from,to:params.to}})});
 try{
  // Смена периода: старый ответ приходит позже нового.
  f.setRange({from:'2026-07-01',to:'2026-07-31'});await tick();
  pending.get('alvi|2026-07-01').resolve(dashboardFor(700));await tick();assert.match(f.content(),/700/);
  pending.get('alvi|2026-08-01').resolve(dashboardFor(800));await tick();assert.match(f.content(),/700/);assert.doesNotMatch(f.content(),/800/);
  assert.equal(f.d.querySelectorAll('.funnel-conversion').length,5);
  // A→B→A: ответ первого запроса A и запрос B приходят после последнего запроса A.
  f.setCompany('avokado');await tick();f.setCompany('alvi');await tick();
  const july=[...pending.keys()].filter(key=>key==='alvi|2026-07-01');assert.equal(july.length,1,'map keeps the latest resolver');
  pending.get('avokado|2026-07-01').resolve(dashboardFor(1));await tick();assert.doesNotMatch(f.content(),/Показы\s*1\b/);assert.match(f.content(),/Загрузка/);
  pending.get('alvi|2026-07-01').resolve(dashboardFor(701));await tick();assert.match(f.content(),/701/);
  // Ошибка устаревшего запроса не затирает свежий экран.
  f.setRange({from:'2026-06-01',to:'2026-06-30'});await tick();
  const stale=pending.get('alvi|2026-06-01');f.setRange({from:'2026-05-01',to:'2026-05-31'});await tick();
  stale.reject(Error('late failure'));await tick();assert.doesNotMatch(f.content(),/late failure/);assert.match(f.content(),/Загрузка/);
  // Фильтр площадок во время загрузки не возвращает старые данные.
  f.toggle2gis();await tick();assert.match(f.content(),/Загрузка/);assert.doesNotMatch(f.content(),/701/);
  pending.get('alvi|2026-05-01').resolve(dashboardFor(500));await tick();assert.doesNotMatch(f.content(),/701/);assert.match(f.card().textContent,/не выбрана в фильтре/);assert.doesNotMatch(f.content(),/500/,'2GIS views stay hidden while the platform is deselected');
  f.toggle2gis();await tick();assert.match(f.card().textContent,/только целевые рубрики/);assert.match(f.content(),/500/);
 }finally{f.dom.window.close();}
});


test('Метрика показывает отдельный отчёт периода, ошибку вместо нулей и отбрасывает чужую компанию', async()=>{
 for(const scenario of ['ok','access_denied','foreign']){
  const f=await fixture({potential:potentialFor('alvi'),respond:({path})=>path==='/metrika/report'?{
   companyCode:scenario==='foreign'?'avokado':'alvi',...AUG,status:scenario==='access_denied'?'access_denied':'ok',
   counterId:'101',fetchedAt:'2026-09-24T06:00:00Z',metrics:scenario==='access_denied'?null:{visits:123,users:81,pageViews:231}
  }:undefined});
  try{const text=f.d.querySelector('[aria-label="Яндекс Метрика"]').textContent;
   if(scenario==='ok'){assert.match(text,/Визиты: 123/);assert.match(text,/Посетители: 81/);assert.match(text,/не прибавляются/);}
   else{assert.doesNotMatch(text,/Визиты: 123/);assert.match(text,scenario==='access_denied'?/не разрешил доступ/:/Не удалось получить/);}
  }finally{f.dom.window.close();}
 }
});
