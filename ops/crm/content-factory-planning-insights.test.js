'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createSocialStats}=require('./social-stats');
const {createPlanningInsights,RECOMMENDATIONS,LIMITATIONS,UNAVAILABLE_LIMITATION,OPEN_PERIOD_LIMITATION}=require('./content-factory-planning-insights');
const AT=Date.parse('2026-10-01T10:00:00.000Z');
const platform=result=>result.platforms.find(item=>item.platform==='telegram');
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE,name TEXT,timezone TEXT,is_deleted INTEGER DEFAULT 0);
    INSERT INTO companies VALUES(1,'alpha','Компания А','Asia/Bangkok',0),(2,'beta','Компания Б','Asia/Irkutsk',0);
    CREATE TABLE leads(id INTEGER PRIMARY KEY,company_code TEXT,created_at TEXT,stage TEXT,sale_amount REAL,source TEXT,utm_source TEXT,utm_content TEXT,utm_campaign TEXT,referrer TEXT,landing_page TEXT)`);
  const stats=createSocialStats(db,{now:()=>AT,adapters:{},logger:{warn(){}}});
  const configure=(code='alpha',revision=0,extra={})=>stats.saveAccounts(code,{accounts:[{platform:'telegram',accountRef:'@private_'+code,provider:'manual',timezone:'Asia/Bangkok',revision,...extra}]});
  const write=(rows,code='alpha',extra={})=>stats.writeSnapshots(code,'telegram','@private_'+code,rows,{provider:'manual',tz:'Asia/Bangkok',collectedAt:'2026-09-30T10:00:00.000Z',...extra});
  return {db,stats,configure,write,api:createPlanningInsights({stats,now:()=>AT})};
}
const row=(date,value=947381,extra={})=>({date,metric:'views',value,completeness:'complete',kind:'organic',...extra});
const monthRows=()=>Array.from({length:30},(_,i)=>row('2026-09-'+String(i+1).padStart(2,'0')));
function assertPrivate(result){
  const serialized=JSON.stringify(result);
  assert.doesNotMatch(serialized,/947381|738299|private_|secret|https?:|@private|permalink|accountRef|providerRef|platformPostId|sourceNote|displayLabel|values|totals|percent|knownDays|sourceField/i);
  function numbers(value,path=''){
    if(typeof value==='number')assert.equal(path,'schemaVersion');
    else if(value&&typeof value==='object')for(const [key,item]of Object.entries(value))numbers(item,path?path+'.'+key:key);
  }numbers(result);
  assert.ok(Buffer.byteLength(serialized)<=8192);
}
test('своя компания и предыдущий календарный месяц; saved-only capture не меняет БД',t=>{
 const f=fixture(t);f.configure();f.write(monthRows());let calls=0;
 const api=createPlanningInsights({stats:{overview(...args){calls++;assert.deepEqual(args,['alpha','2026-09-01','2026-09-30']);return f.stats.overview(...args);},collect(){throw Error('collect запрещён');},importManual(){throw Error('mutation запрещена');}},now:()=>AT});
 const before=f.db.prepare('SELECT * FROM social_snapshots ORDER BY id').all(),changes=f.db.prepare('SELECT total_changes() n').get().n;
 const result=api.capture('ALPHA','2026-10');assert.equal(calls,1);assert.equal(result.source.status,'available');
 assert.equal(platform(result).coverage,'complete');assert.equal(platform(result).confidence,'descriptive');assertPrivate(result);
 assert.deepEqual(f.db.prepare('SELECT * FROM social_snapshots ORDER BY id').all(),before);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
 const other=f.api.capture('beta','2026-10');assert.equal(platform(other).coverage,'missing');assert.deepEqual(platform(other).editorialRecommendations,[]);
});
test('январь и високосный февраль вычисляются календарно, не как равная длина дней',()=>{
 for(const [month,from,to]of [['2027-01','2026-12-01','2026-12-31'],['2028-03','2028-02-01','2028-02-29'],['2027-03','2027-02-01','2027-02-28']]){
  const api=createPlanningInsights({stats:{overview(code,a,b){assert.deepEqual([a,b],[from,to]);return {companyCode:code,from:a,to:b,timezone:'UTC',platforms:{}};}},now:()=>AT});
  assert.deepEqual(api.capture('alpha',month).source.period,{from,to,timezone:'UTC'});
 }
});
test('невалидные company/month отклоняются до чтения статистики',()=>{
 let reads=0;const api=createPlanningInsights({stats:{overview(){reads++;}},now:()=>AT});
 for(const [code,month]of [['../alpha','2026-10'],['alpha','2026-13'],['alpha','2026-9'],['alpha',null]])assert.throws(()=>api.capture(code,month),e=>e.status===400);
 assert.equal(reads,0);
});
test('missing и сохранённые null не превращаются в ноль или рекомендацию успешной темы',t=>{
 const f=fixture(t);f.configure();f.write([row('2026-09-01',null,{completeness:'unknown'})]);
 const result=f.api.capture('alpha','2026-10');assert.equal(platform(result).coverage,'missing');assert.equal(platform(result).confidence,'insufficient');
 assert.deepEqual(platform(result).editorialRecommendations,[]);assert.match(result.limitations.join(' '),/не нулевой результат/);assertPrivate(result);
});
test('известные нули остаются измерениями, без публикации чисел или выводов об успехе',t=>{
 const f=fixture(t);f.configure();f.write(monthRows().map(item=>({...item,value:0})));
 const result=f.api.capture('alpha','2026-10');assert.equal(platform(result).coverage,'complete');assertPrivate(result);
 assert.deepEqual(platform(result).editorialRecommendations.map(item=>item.code),['CHECK_EDITORIAL_HYPOTHESES']);
});
test('partial/unknown полнота и пропуски дают только фиксированную проверку покрытия',t=>{
 const f=fixture(t);f.configure();f.write([row('2026-09-01'),row('2026-09-02',947381,{completeness:'partial'})]);
 const result=f.api.capture('alpha','2026-10');assert.equal(platform(result).coverage,'partial');assert.equal(platform(result).confidence,'limited');
 assert.equal(platform(result).editorialRecommendations[0].code,'CHECK_COVERAGE');assertPrivate(result);
});
test('одиночный lifetime не превращается в итог месяца или динамику',t=>{
 const f=fixture(t);f.configure();f.write([{date:'2026-09-30',metric:'followers',value:947381,period:'lifetime',completeness:'complete',kind:'organic'}]);
 const result=f.api.capture('alpha','2026-10');assert.equal(platform(result).coverage,'state_only');assert.equal(platform(result).confidence,'limited');
 assert.equal(platform(result).editorialRecommendations[0].code,'CHECK_PERIOD_DATA');assertPrivate(result);
});
test('давность источника явна: recent/stale/unknown, порог7дней и будущая дата не считаются свежими',t=>{
 for(const [collectedAt,status]of [['2026-09-24T10:00:00.000Z','recent'],['2026-09-24T09:59:59.000Z','stale'],['private_secret','unknown'],['2026-10-02T00:00:00.000Z','unknown']]){
  const f=fixture(t);f.configure();f.write(monthRows(),undefined,{collectedAt});
  const result=f.api.capture('alpha','2026-10');assert.equal(platform(result).freshness.status,status);
  assert.equal(platform(result).freshness.lastCollectedAt,status==='unknown'?null:collectedAt);
  assert.match(result.limitations.join(' '),/7дней/);assertPrivate(result);
  if(status!=='recent')assert.equal(platform(result).confidence,'limited');
 }
});
test('история другого аккаунта и другой системы суток не склеивается с активным рядом',t=>{
 const f=fixture(t);f.configure();f.write(monthRows());
 f.stats.writeSnapshots('alpha','telegram','@private_old',[row('2026-09-01',738299)],{provider:'manual',tz:'Asia/Bangkok',collectedAt:'2026-09-30T10:00:00.000Z'});
 assert.equal(platform(f.api.capture('alpha','2026-10')).coverage,'incompatible');
 f.write([row('2026-09-02',738299)],undefined,{tz:'Asia/Irkutsk'});
 const result=f.api.capture('alpha','2026-10');assert.equal(platform(result).coverage,'incompatible');
 assert.equal(platform(result).editorialRecommendations[0].code,'CHECK_COMPARABILITY');assertPrivate(result);
});
test('неизвестная область/смена источника/органика и реклама не становятся сопоставимым рядом',t=>{
 for(const extra of [{kind:'unknown'},{kind:'mixed'},{kind:'paid'}]){
  const f=fixture(t);f.configure();f.write(monthRows());f.write([row('2026-09-01',947381,extra)]);
  assert.equal(platform(f.api.capture('alpha','2026-10')).coverage,'incompatible');
 }
 const f=fixture(t);f.configure();f.write(monthRows());f.write([row('2026-09-01')],undefined,{provider:'direct'});
 const result=f.api.capture('alpha','2026-10');assert.equal(platform(result).coverage,'incompatible');assertPrivate(result);
});
test('разные площадки сохраняют свои системы суток, без общего показателя или причинного ранга',t=>{
 const f=fixture(t);f.configure();f.write(monthRows());
 f.stats.saveAccounts('alpha',{accounts:[{platform:'vk',accountRef:'private_vk',provider:'manual',timezone:'Asia/Irkutsk',revision:0}]});
 f.stats.writeSnapshots('alpha','vk','private_vk',monthRows(),{provider:'manual',tz:'Asia/Irkutsk',collectedAt:'2026-09-30T10:00:00.000Z'});
 const result=f.api.capture('alpha','2026-10');assert.equal(platform(result).timezone,'Asia/Bangkok');
 assert.equal(result.platforms.find(item=>item.platform==='vk').timezone,'Asia/Irkutsk');assertPrivate(result);
});
test('исходные labels/reasons/PII/URL и один ролик не попадают в проекцию и не дают ранга',t=>{
 const f=fixture(t);f.configure();f.write(monthRows());const view=f.stats.overview('alpha','2026-09-01','2026-09-30');
 view.platforms.telegram.label='private_secret https://private.test @private_person';
 view.platforms.telegram.lastRun={sourceNote:'private_secret',error:'private_secret'};
 view.postMetrics={companyCode:'alpha',posts:[{platform:'telegram',url:'https://private.test',accountRef:'@private_person',values:{views:738299},reportName:'private_report'}]};
 const before=structuredClone(view),result=createPlanningInsights({stats:{overview:()=>view},now:()=>AT}).capture('alpha','2026-10');
 assertPrivate(result);assert.deepEqual(view,before);assert.doesNotMatch(result.platforms.flatMap(item=>item.editorialRecommendations).map(item=>item.text).join(' '),/лучший|победитель|увеличьте|благодаря|вызвал|из-за/);
});
test('ошибка чтения и чужой scope дают неблокирующий unavailable без исходной ошибки',()=>{
 for(const stats of [{overview(){throw Error('private_secret https://private.test 947381');}},{overview(){return {companyCode:'beta',from:'2026-09-01',to:'2026-09-30',platforms:{}};}}]){
  const result=createPlanningInsights({stats,now:()=>AT}).capture('alpha','2026-10');assert.equal(result.source.status,'unavailable');assert.deepEqual(result.platforms,[]);
  assert.match(result.limitations[0],/можно подготовить/);assertPrivate(result);
 }
});
test('предел8КиБ при всех площадках и ограничениях; повтор не зависит от raw magnitude',t=>{
 const f=fixture(t);f.configure();f.write(monthRows());const view=f.stats.overview('alpha','2026-09-01','2026-09-30');
 const sample=structuredClone(view.platforms.telegram);sample.lastCollectedAt='2026-09-01T00:00:00.000Z';
 for(const key of ['instagram','tiktok','youtube','vk','telegram'])view.platforms[key]=structuredClone(sample);
 const api=createPlanningInsights({stats:{overview:()=>view},now:()=>AT}),first=api.capture('alpha','2026-10');
 assert.equal(first.source.status,'available');assertPrivate(first);
 for(const item of Object.values(view.platforms)){for(const day of Object.values(item.days))for(const metric of Object.values(day))metric.value=738299;item.totals.views=738299;}
 assert.deepEqual(api.capture('alpha','2026-10'),first);
});
test('экспортируемые тексты заморожены; output содержит только общий фиксированный словарь',t=>{
 const f=fixture(t);f.configure();f.write(monthRows());const result=f.api.capture('alpha','2026-10');
 assert.equal(Object.isFrozen(RECOMMENDATIONS),true);assert.equal(Object.isFrozen(LIMITATIONS),true);
 for(const item of result.platforms)for(const recommendation of item.editorialRecommendations)assert.equal(RECOMMENDATIONS[recommendation.code],recommendation.text);
 for(const text of result.limitations)assert.ok(LIMITATIONS.includes(text)||text===OPEN_PERIOD_LIMITATION||text===UNAVAILABLE_LIMITATION);
});
test('неизвестная система суток и открытый месяц не получают descriptive/complete',t=>{
 const f=fixture(t);f.configure();f.write(monthRows());const original=f.stats.overview('alpha','2026-09-01','2026-09-30');
 for(const missing of ['company','platform']){
  const view=structuredClone(original);if(missing==='company')view.timezone='private_secret';else view.platforms.telegram.timezone='private_secret';
  const result=createPlanningInsights({stats:{overview:()=>view},now:()=>AT}).capture('alpha','2026-10');
  assert.equal(platform(result).coverage,'incompatible');assert.equal(platform(result).confidence,'insufficient');assertPrivate(result);
 }
 const open=createPlanningInsights({stats:{overview:()=>original},now:()=>Date.parse('2026-09-30T00:00:00.000Z')}).capture('alpha','2026-10');
 assert.equal(platform(open).coverage,'partial');assert.equal(platform(open).confidence,'limited');assert.ok(open.limitations.includes(OPEN_PERIOD_LIMITATION));
});
