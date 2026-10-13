'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {compareMetrikaSnapshot}=require('./revenue-analytics-reconcile');
function fixture(){
  const period={from:'2026-10-01',to:'2026-10-07'};
  const table=()=>({metrics:['ym:s:visits','ym:s:users','ym:s:avgVisitDurationSeconds'],totals:[7,4,120.55],
    sampled:false,sampleShare:1,dataLagSeconds:0,rows:[
      {dimensions:[{id:'a',name:'Источник А'}],metrics:[4,3,125.5]},
      {dimensions:[{id:'b',name:'Источник Б'}],metrics:[3,2,113.95]}]});
  const report={period,timezone:'Asia/Irkutsk',attribution:'lastsign',overview:table(),sources:table(),utm:table(),
    goals:[{id:'301',visits:1,reaches:2,conversionRate:14.28571429,sampled:false},{id:'302',visits:0,reaches:0,conversionRate:0,sampled:false}]};
  return {expected:{companyCode:'demo-a',counterId:'201',period,report},actual:{companyCode:'demo-a',period,
    state:{providers:[{provider:'metrika',config:{externalId:'201'}}]},metrika:{...structuredClone(report),current:true}}};
}
test('сверка использует целый период и каждую цель, порядок строк не важен',()=>{
  const {expected,actual}=fixture();actual.metrika.sources.rows.reverse();actual.metrika.goals.reverse();
  const result=compareMetrikaSnapshot(expected,actual);assert.equal(result.matches,true);assert.ok(result.comparedValues>30);
  assert.equal(actual.metrika.overview.totals[1],4); // Сумма строк 5 не является числом уникальных посетителей.
});
test('другая компания, счётчик, диапазон, часовой пояс, атрибуция или ревизия не принимаются',()=>{
  for(const change of [a=>a.companyCode='demo-b',a=>a.state.providers[0].config.externalId='202',a=>a.period={from:'2026-10-02',to:'2026-10-07'},
    a=>a.metrika.timezone='UTC',a=>a.metrika.attribution='first',a=>a.metrika.current=false]){
    const {expected,actual}=fixture();change(actual);const result=compareMetrikaSnapshot(expected,actual);
    assert.equal(result.matches,false);assert.equal(result.scopeValid,false);assert.equal(result.comparedValues,0);
  }
});
test('пропавшая нулевая цель и отсутствующее число не превращаются в совпадение',()=>{
  const {expected,actual}=fixture();actual.metrika.goals.pop();actual.metrika.overview.totals[1]=null;
  const result=compareMetrikaSnapshot(expected,actual);assert.equal(result.matches,false);
  assert.ok(result.differences.some(d=>d.kind==='missing_goal'));assert.ok(result.differences.some(d=>d.kind==='missing_or_invalid'));
});
test('показатели каждой UTM и цели, среднее и выборка сравниваются отдельно',()=>{
  const {expected,actual}=fixture();actual.metrika.utm.rows[0].metrics[0]++;
  actual.metrika.goals[0].reaches++;actual.metrika.sources.sampled=true;actual.metrika.overview.totals[2]=121;
  const result=compareMetrikaSnapshot(expected,actual);assert.equal(result.matches,false);
  for(const name of ['utm.rows.0.metrics.0','goals.0.reaches','sources.sampled','overview.totals.2'])assert.ok(result.differences.some(d=>d.path===name));
});
test('дубликат источника или цели не скрывает потерянную строку',()=>{
  for(const name of ['sources','goals']){
    const {expected,actual}=fixture();if(name==='goals')actual.metrika.goals.push(actual.metrika.goals[0]);
    else actual.metrika.sources.rows.push(actual.metrika.sources.rows[0]);
    assert.ok(compareMetrikaSnapshot(expected,actual).differences.some(d=>d.kind==='duplicate'));
  }
});
test('результат сверки не раскрывает значения меток и сырые ответы',()=>{
  const {expected,actual}=fixture();actual.metrika.utm.rows[0].dimensions[0].name='PRIVATE_MARKER';
  const result=compareMetrikaSnapshot(expected,actual);assert.equal(result.matches,false);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_MARKER|Источник А/);
});
test('малый шум дробного среднего допустим, изменение целого визита — расхождение',()=>{
  const {expected,actual}=fixture();actual.metrika.overview.totals[2]+=1e-9;
  assert.equal(compareMetrikaSnapshot(expected,actual).matches,true);
  actual.metrika.overview.totals[0]+=1e-9;assert.equal(compareMetrikaSnapshot(expected,actual).matches,false);
});
test('пустая схема и некалендарная дата не принимаются даже при одинаковых повреждённых ответах',()=>{
  const {expected,actual}=fixture();expected.report.overview.metrics=[];actual.metrika.overview.metrics=[];
  assert.equal(compareMetrikaSnapshot(expected,actual).matches,false);
  const next=fixture();next.expected.period.from='2026-02-30';next.actual.period.from='2026-02-30';
  assert.equal(compareMetrikaSnapshot(next.expected,next.actual).scopeValid,false);
});
