'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createPlatformDemand}=require('./platform-demand');
function fixture(t) {
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE companies(code TEXT PRIMARY KEY COLLATE NOCASE,name TEXT,is_deleted INTEGER DEFAULT 0);
 INSERT INTO companies VALUES('alvi','ALVI',0),('avokado','Авокадо',0),('deleted','Deleted',1);`);t.after(()=>db.close());
 let now=Date.parse('2026-09-28T12:00:00Z');const options={now:()=>now},api=createPlatformDemand(db,options),actor={userId:2,userName:'Администратор'};
 const settings={revision:0,organizationId:'12345',organizationName:'Студия',city:'Иркутск',cabinetUrl:'https://account.2gis.com/orgs/12345/statistics/demand'};
 const row={periodStart:'2026-08-01',periodEnd:'2026-08-31',category:'Массаж',metric:'searches',value:20,partial:false};
 const report={organizationId:settings.organizationId,organizationName:settings.organizationName,city:settings.city,sourceUrl:settings.cabinetUrl,
   reportKind:'rubric_demand',periodStart:row.periodStart,periodEnd:row.periodEnd,granularity:'month',capturedAt:'2026-09-17T12:00:00Z',originalFilename:'спрос.xls',rows:[row]};
 return {db,api,actor,settings,row,report,options,advance(){now+=86400000;},
   configure:(code='avokado',changes={})=>api.saveSettings(code,{...settings,...changes},actor),
   import:(changes={},code='avokado')=>api.importDataset(code,{...report,...changes},actor)};
}
const err=(code,status=400)=>error=>{assert.equal(error.code,code);assert.equal(error.status,status);return true;};

test('empty state has no fabricated counts or connection; settings scoped, validated and optimistic',t=>{
 const f=fixture(t),empty=f.api.get('avokado');assert.equal(empty.settings.configured,false);assert.equal(empty.settings.canSync,false);
 assert.deepEqual(empty.datasets,[]);assert.equal(empty.summary.available,false);assert.equal(empty.summary.latestCapturedAt,null);
 assert.throws(()=>f.import(),err('CONFIGURATION_REQUIRED',409));
 const saved=f.configure();assert.equal(saved.settings.revision,1);assert.equal(f.api.get('alvi').settings.configured,false);
 assert.throws(()=>f.configure(),err('REVISION_CONFLICT',409));
 for(const cabinetUrl of ['https://account.2gis.com/orgs/999/statistics/demand','https://account.2gis.com.evil.org/orgs/12345/a','http://account.2gis.com/orgs/12345/a','https://u:secret@account.2gis.com/orgs/12345/a'])
   assert.throws(()=>f.configure('avokado',{revision:1,cabinetUrl}),err('ORG_MISMATCH',409));
 for(const cabinetUrl of [f.settings.cabinetUrl+'?token=PRIVATE',f.settings.cabinetUrl+'#access_token=PRIVATE'])assert.throws(()=>f.configure('avokado',{revision:1,cabinetUrl}),err('VALIDATION_ERROR'));
 assert.throws(()=>f.api.get('deleted'),err('NOT_FOUND',404));assert.throws(()=>f.api.get('../avokado'),err('VALIDATION_ERROR'));
});

test('atomic import requires configured exact organisation and city; same payload cannot leak across companies',t=>{
 const f=fixture(t);f.configure();f.configure('alvi');
 for(const change of [{organizationId:'999',sourceUrl:'https://account.2gis.com/orgs/999/statistics/demand'},{organizationName:'Другая студия'},{city:'Омск'},{sourceUrl:'https://account.2gis.com/orgs/999/statistics/demand'}])assert.throws(()=>f.import(change),err('ORG_MISMATCH',409));
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM platform_demand_datasets').get().n,0);
 const saved=f.import().dataset,other=f.import({},'alvi').dataset;assert.notEqual(saved.id,other.id);assert.notEqual(saved.sourceHash,other.sourceHash);
 assert.equal(saved.importedBy.userId,2);assert.equal(saved.originalFilename,'спрос.xls');assert.equal(saved.sourceHashKind,'structured-report-sha256');
 assert.throws(()=>f.api.getDataset('alvi',saved.id),err('NOT_FOUND',404));
 f.configure('avokado',{revision:1,city:'Омск'});assert.equal(f.api.get('avokado').datasets.length,0);assert.equal(f.api.get('avokado').summary.available,false);
 assert.throws(()=>f.api.getDataset('avokado',saved.id),err('NOT_FOUND',404));assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM platform_demand_datasets').get().n,2);
});

test('identical exports deduplicate across dates and filenames while capture observations and immutable source remain',t=>{
 const f=fixture(t);f.configure();
 const first=f.import();assert.equal(first.duplicate,false);assert.match(first.dataset.sourceHash,/^[a-f0-9]{64}$/);
 const repeat=f.import({capturedAt:'2026-09-21T12:00:00Z',originalFilename:'новый-экспорт.xls'});assert.equal(repeat.duplicate,true);assert.equal(repeat.dataset.id,first.dataset.id);
 assert.equal(repeat.dataset.capturedAt,'2026-09-17T12:00:00.000Z');assert.equal(repeat.dataset.lastCheckedAt,'2026-09-21T12:00:00.000Z');assert.equal(repeat.dataset.originalFilename,'спрос.xls');
 const stored=f.db.prepare('SELECT * FROM platform_demand_datasets').all();assert.equal(stored.length,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM platform_demand_checks').get().n,2);
 assert.equal(createPlatformDemand(f.db,f.options).get('avokado').datasets[0].id,first.dataset.id);
});

test('latest observation replaces earlier snapshot without addition, even when content returns to an older fingerprint',t=>{
 const f=fixture(t);f.configure();const first=f.import().dataset;
 const second=f.import({capturedAt:'2026-09-18T12:00:00Z',rows:[{...f.row,value:30}]}).dataset;
 assert.equal(f.api.get('avokado').datasets[0].id,second.id);assert.equal(f.api.get('avokado').summary.periods[0].unclassified,30);
 f.import({capturedAt:'2026-09-19T12:00:00Z'});let current=f.api.get('avokado');
 assert.equal(current.datasets[0].id,first.id);assert.equal(current.summary.periods[0].unclassified,20);assert.equal(current.history.length,2);
 f.import({capturedAt:'2026-09-10T12:00:00Z',rows:[{...f.row,value:50}]});current=f.api.get('avokado');assert.equal(current.datasets[0].id,first.id);
});

test('classification retains unknown rubrics, excludes aggregate, separates percentages and labels partial data',t=>{
 const f=fixture(t);f.configure();
 f.api.saveCategories('avokado',{revision:0,items:[{category:'Массаж',classification:'target',reason:'Есть услуга'},{category:'Детские клубы',classification:'non_target',reason:'Не оказываем'}]},f.actor);
 const rows=[{...f.row,category:'Все рубрики',value:100},{...f.row,value:20},{...f.row,category:'Детские клубы',value:5},{...f.row,category:'Неизвестная рубрика',value:7,partial:true}];
 f.import({rows});let state=f.api.get('avokado'),s=state.summary.periods[0];
 assert.equal(s.total,100);assert.equal(s.target,20);assert.equal(s.nonTarget,5);assert.equal(s.unclassified,7);assert.equal(s.partial,true);
 assert.equal(state.categories.items.length,3);assert.ok(!state.categories.items.some(i=>i.category==='Все рубрики'));
 assert.match(state.summary.note,/не число уникальных людей/);
 f.api.saveCategories('avokado',{revision:1,items:[{category:'Массаж',classification:'unclassified',reason:''}]},f.actor);
 assert.equal(f.api.get('avokado').categories.items.find(i=>i.category==='Детские клубы').classification,'non_target');
 assert.equal(f.api.get('alvi').categories.items.length,0);
 assert.throws(()=>f.api.saveCategories('avokado',{revision:1,items:[]}),err('REVISION_CONFLICT',409));
 assert.throws(()=>f.api.saveCategories('avokado',{revision:2,items:[{category:'Все рубрики',classification:'target',reason:''}]}),err('VALIDATION_ERROR'));
 f.import({reportKind:'search_share',rows:[{...f.row,metric:'share_percent',value:12.5}]});state=f.api.get('avokado');assert.equal(state.datasets.length,2);
 const share=state.summary.periods.find(p=>p.metric==='share_percent');assert.equal(share.total,null);assert.equal(share.target,null);assert.equal(share.unclassified,null);
});

test('invalid rows, impossible dates, unmarked future periods and malformed files reject entire report without partial writes',t=>{
 const f=fixture(t);f.configure();
 for(const change of [{rows:[]},{rows:Array(2001).fill(f.row)},{rows:[f.row,f.row]},{rows:[f.row,{...f.row,category:'МАССАЖ'}]},
  {rows:[{...f.row,value:-1}]},{rows:[{...f.row,value:1.1}]},{rows:[{...f.row,value:Infinity}]},{rows:[{...f.row,partial:'true'}]},
  {rows:[{...f.row,periodStart:'2026-02-30'}]},{rows:[{...f.row,periodStart:'2026-07-31'}]},{rows:[{...f.row,metric:'share_percent'}]},
  {reportKind:'search_share',rows:[{...f.row,metric:'share_percent',value:101}]},{granularity:'day'},{granularity:'week'},
  {periodEnd:'2026-08-01'},{capturedAt:'2027-01-01T00:00:00Z'},{originalFilename:'C:/private/report.xls'},{companyCode:'alvi'},
  {periodStart:'2026-09-01',periodEnd:'2026-09-30',rows:[{...f.row,periodStart:'2026-09-01',periodEnd:'2026-09-30'}]}])assert.throws(()=>f.import(change),err('VALIDATION_ERROR'));
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM platform_demand_datasets').get().n,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM platform_demand_checks').get().n,0);
 const valid=f.import({periodStart:'2026-09-01',periodEnd:'2026-09-30',rows:[{...f.row,periodStart:'2026-09-01',periodEnd:'2026-09-30',partial:true}]}).dataset;
 assert.equal(valid.rows[0].partial,true);
});

test('row order does not change fingerprint and category revisions preserve concurrent classifications',t=>{
 const f=fixture(t);f.configure();const rows=[f.row,{...f.row,category:'SPA',value:5}];const saved=f.import({rows});
 assert.equal(f.import({rows:rows.slice().reverse()}).dataset.id,saved.dataset.id);
 f.api.saveCategories('avokado',{revision:0,items:[{category:'SPA',classification:'target',reason:'Услуга'}]},f.actor);
 assert.throws(()=>f.api.saveCategories('avokado',{revision:0,items:[{category:'SPA',classification:'non_target',reason:'stale'}]},f.actor),err('REVISION_CONFLICT',409));
 assert.equal(f.api.get('avokado').categories.items.find(i=>i.category==='SPA').classification,'target');
 const audit=f.db.prepare('SELECT * FROM platform_demand_audit').all();assert.ok(audit.every(row=>row.company_code==='avokado'));assert.ok(audit.every(row=>row.actor_id===2));
});

test('potential keeps every period from history, lets the latest correction win, never sums overlapping granularities and turns missing rubrics into unknown, not zero',t=>{
 const f=fixture(t),month=(m,end,all,massage,tan,partial=false)=>[
   {periodStart:m+'-01',periodEnd:m+'-'+end,category:'Все рубрики',metric:'searches',value:all,partial},
   {periodStart:m+'-01',periodEnd:m+'-'+end,category:'Массаж',metric:'searches',value:massage,partial},
   {periodStart:m+'-01',periodEnd:m+'-'+end,category:'Загар',metric:'searches',value:tan,partial}];
 const unconfigured=f.api.potential('avokado','2026-08-01','2026-08-31');
 assert.equal(unconfigured.available,false);assert.equal(unconfigured.organization,null);assert.deepEqual(unconfigured.uncovered,[{from:'2026-08-01',to:'2026-08-31'}]);
 f.configure();f.configure('alvi');
 const url='https://account.2gis.com/orgs/12345/statistics/demand?demandPeriod=year&demandGroup=month';
 const first=f.import({sourceUrl:url,periodStart:'2026-07-01',periodEnd:'2026-09-16',rows:[...month('2026-07','31',100,40,10),...month('2026-08','31',200,80,20),...month('2026-09','16',50,20,5,true)]}).dataset;
 assert.equal(first.sourceUrl,url,'observed 2GIS query parameters are accepted');
 assert.throws(()=>f.import({sourceUrl:url+'&token=PRIVATE'}),err('VALIDATION_ERROR'));
 f.import({periodStart:'2026-08-01',periodEnd:'2026-08-31',reportKind:'search_share',rows:[{periodStart:'2026-08-01',periodEnd:'2026-08-31',category:'массаж иркутск',metric:'share_percent',value:12.5,partial:false}]});
 // 18.08–17.09: август не целиком → не учитывается; внутрь попадает неполная сентябрьская строка; непокрытые отрезки названы.
 const inside=f.api.potential('avokado','2026-08-18','2026-09-17');
 assert.equal(inside.complete,false);assert.equal(inside.partial,true);assert.deepEqual(inside.covered,{from:'2026-09-01',to:'2026-09-16'});
 assert.deepEqual(inside.uncovered,[{from:'2026-08-18',to:'2026-08-31'},{from:'2026-09-17',to:'2026-09-17'}]);assert.deepEqual(inside.granularities,['month']);
 assert.deepEqual(inside.totals,{all:50,target:null,nonTarget:null,unclassified:25});
 assert.deepEqual(inside.suggested,{from:'2026-08-01',to:'2026-09-16',granularities:['month'],partial:true});
 const nothing=f.api.potential('avokado','2026-08-18','2026-08-30');assert.equal(nothing.covered,null);assert.deepEqual(nothing.periods,[]);assert.deepEqual(nothing.totals,{all:null,target:null,nonTarget:null,unclassified:null});
 // Целый август без классификации: общий спрос известен, целевой — нет, рубрики названы явно.
 const august=f.api.potential('avokado','2026-08-01','2026-08-31');
 assert.equal(august.complete,true);assert.deepEqual(august.uncovered,[]);assert.deepEqual(august.totals,{all:200,target:null,nonTarget:null,unclassified:100});assert.deepEqual(august.unclassifiedCategories,['Загар','Массаж']);
 f.api.saveCategories('avokado',{revision:0,items:[{category:'Массаж',classification:'target',reason:''},{category:'Загар',classification:'non_target',reason:''}]},f.actor);
 assert.deepEqual(f.api.potential('avokado','2026-07-01','2026-08-31').totals,{all:300,target:120,nonTarget:30,unclassified:null});
 // Новая недельная выгрузка сентября НЕ прячет август и не складывается с месячным сентябрём.
 f.advance();const week=f.import({periodStart:'2026-09-07',periodEnd:'2026-09-13',granularity:'week',capturedAt:'2026-09-18T12:00:00Z',rows:[
   {periodStart:'2026-09-07',periodEnd:'2026-09-13',category:'Все рубрики',metric:'searches',value:14,partial:false},
   {periodStart:'2026-09-07',periodEnd:'2026-09-13',category:'Массаж',metric:'searches',value:6,partial:false},
   {periodStart:'2026-09-07',periodEnd:'2026-09-13',category:'Загар',metric:'searches',value:2,partial:false}]}).dataset;
 assert.equal(f.api.get('avokado').datasets[0].id,week.id,'the latest dataset leads the section');
 const augustAgain=f.api.potential('avokado','2026-08-01','2026-08-31');assert.deepEqual(augustAgain.totals,{all:200,target:80,nonTarget:20,unclassified:null});assert.deepEqual(augustAgain.datasetIds,[first.id]);
 const september=f.api.potential('avokado','2026-09-01','2026-09-16');
 assert.deepEqual(september.totals,{all:50,target:20,nonTarget:5,unclassified:null});assert.equal(september.periods.length,1);assert.equal(september.excluded.length,1);
 assert.equal(september.excluded[0].datasetId,week.id);assert.match(september.excluded[0].reason,/перекрывается/);
 const weekOnly=f.api.potential('avokado','2026-09-07','2026-09-13');assert.deepEqual(weekOnly.totals,{all:14,target:6,nonTarget:2,unclassified:null});assert.deepEqual(weekOnly.granularities,['week']);
 // Исправленная повторная выгрузка августа: побеждает последняя проверка, числа не удваиваются; история сохранена.
 f.advance();const fixed=f.import({periodStart:'2026-08-01',periodEnd:'2026-08-31',capturedAt:'2026-09-19T12:00:00Z',rows:month('2026-08','31',210,85,20)}).dataset;
 assert.notEqual(fixed.id,first.id);assert.equal(f.api.get('avokado').historyTotal,4);
 const corrected=f.api.potential('avokado','2026-07-01','2026-08-31');assert.deepEqual(corrected.totals,{all:310,target:125,nonTarget:30,unclassified:null});assert.deepEqual(corrected.datasetIds.sort(),[first.id,fixed.id].sort());
 f.advance();f.import({periodStart:'2026-08-01',periodEnd:'2026-08-31',capturedAt:'2026-09-20T12:00:00Z',rows:month('2026-08','31',210,85,20)});
 assert.deepEqual(f.api.potential('avokado','2026-08-01','2026-08-31').totals,{all:210,target:85,nonTarget:20,unclassified:null},'identical re-export changes nothing');
 // Пропуск рубрики в одном из периодов: итог по этой классификации неизвестен, не ноль; период помечен.
 f.advance();f.import({periodStart:'2026-06-01',periodEnd:'2026-06-30',capturedAt:'2026-09-21T12:00:00Z',rows:[
   {periodStart:'2026-06-01',periodEnd:'2026-06-30',category:'Все рубрики',metric:'searches',value:90,partial:false},
   {periodStart:'2026-06-01',periodEnd:'2026-06-30',category:'Загар',metric:'searches',value:9,partial:false}]});
 const gap=f.api.potential('avokado','2026-06-01','2026-08-31');
 assert.equal(gap.complete,false);assert.deepEqual(gap.missingCategories,['Массаж']);assert.deepEqual(gap.periods[0].missingCategories,['Массаж']);
 assert.deepEqual(gap.totals,{all:400,target:null,nonTarget:39,unclassified:null});assert.equal(gap.periods[0].target,null);assert.equal(gap.periods[1].target,40);
 // Настроенная целевая рубрика, которой нет ни в одном импорте: целевой итог неизвестен, пропуск назван в каждом периоде.
 f.api.saveCategories('avokado',{revision:1,items:[{category:'SPA',classification:'target',reason:'решение владельца'}]},f.actor);
 const spa=f.api.potential('avokado','2026-08-01','2026-08-31');
 assert.equal(spa.complete,false);assert.equal(spa.totals.target,null);assert.equal(spa.totals.all,210);assert.equal(spa.totals.nonTarget,20);
 assert.deepEqual(spa.missingCategories,['SPA']);assert.deepEqual(spa.periods[0].missingCategories,['SPA']);
 const spaTwo=f.api.potential('avokado','2026-07-01','2026-08-31');assert.equal(spaTwo.totals.target,null);assert.ok(spaTwo.periods.every(period=>period.missingCategories.includes('SPA')));
 // Настроенная нецелевая рубрика без строк не мешает целевому итогу, но нецелевой становится неизвестным.
 f.api.saveCategories('avokado',{revision:2,items:[{category:'SPA',classification:'non_target',reason:''}]},f.actor);
 const spaNon=f.api.potential('avokado','2026-08-01','2026-08-31');assert.equal(spaNon.totals.target,85);assert.equal(spaNon.totals.nonTarget,null);assert.equal(spaNon.complete,false);
 f.api.saveCategories('avokado',{revision:3,items:[{category:'SPA',classification:'unclassified',reason:''}]},f.actor);
 // Изоляция компаний и проверка входа.
 const other=f.api.potential('alvi','2026-08-01','2026-08-31');assert.equal(other.available,false);assert.equal(other.organization.id,'12345');
 assert.throws(()=>f.api.potential('avokado','2026-08-31','2026-08-01'),err('VALIDATION_ERROR'));assert.throws(()=>f.api.potential('avokado','2026-8-1','2026-08-31'),err('VALIDATION_ERROR'));
 assert.throws(()=>f.api.potential('deleted','2026-08-01','2026-08-31'),err('NOT_FOUND',404));
});

test('search-share phrases are never rubrics: not offered, not saveable, old assignments ignored; a phrase that is also a rubric stays a rubric; a saved missing rubric still blocks',t=>{
 const f=fixture(t);f.configure();
 const rubric=[{periodStart:'2026-08-01',periodEnd:'2026-08-31',category:'Все рубрики',metric:'searches',value:90676,partial:false},
   {periodStart:'2026-08-01',periodEnd:'2026-08-31',category:'Массажист',metric:'searches',value:46561,partial:false},
   {periodStart:'2026-08-01',periodEnd:'2026-08-31',category:'Эпиляция',metric:'searches',value:39608,partial:false}];
 const share=[{periodStart:'2026-08-01',periodEnd:'2026-08-31',category:'авокадо',metric:'share_percent',value:29.3,partial:false},
   {periodStart:'2026-08-01',periodEnd:'2026-08-31',category:'массажист',metric:'share_percent',value:2.1,partial:false},
   {periodStart:'2026-08-01',periodEnd:'2026-08-31',category:'прочее',metric:'share_percent',value:24.1,partial:false}];
 f.import({rows:rubric});f.import({reportKind:'search_share',rows:share});
 // Предлагаются только рубрики количественного отчёта; фразы «авокадо» и «прочее» не предлагаются, «Массажист» — рубрика.
 const offered=f.api.get('avokado').categories.items.map(item=>item.category);
 assert.deepEqual(offered,['Массажист','Эпиляция']);
 const shareRows=f.api.get('avokado').datasets.find(item=>item.reportKind==='search_share').rows;assert.ok(shareRows.every(row=>row.classification==='unclassified'));
 // Сохранить фразу нельзя — ни одна строка пакета не записывается.
 assert.throws(()=>f.api.saveCategories('avokado',{revision:0,items:[{category:'Массажист',classification:'target',reason:''},{category:'авокадо',classification:'target',reason:''}]},f.actor),err('VALIDATION_ERROR'));
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM platform_demand_categories').get().n,0);
 f.api.saveCategories('avokado',{revision:0,items:[{category:'Массажист',classification:'target',reason:''},{category:'массажист',classification:'target',reason:''}].slice(0,1)},f.actor);
 assert.equal(f.api.potential('avokado','2026-08-01','2026-08-31').totals.target,46561);
 // Старое назначение фразы (записано до правила) игнорируется: не ожидается, не предлагается, полнота не страдает.
 f.db.prepare('INSERT INTO platform_demand_categories(company_code,category_key,category,classification,reason) VALUES(?,?,?,?,?)').run('avokado','авокадо','авокадо','target','старое');
 const p=f.api.potential('avokado','2026-08-01','2026-08-31');
 assert.equal(p.totals.target,46561);assert.equal(p.complete,true);assert.deepEqual(p.missingCategories,[]);
 assert.deepEqual(f.api.get('avokado').categories.items.map(item=>item.category),['Массажист','Эпиляция']);
 // Фраза, совпадающая с рубрикой другой компании, у этой компании остаётся фразой: изоляция по организации.
 f.configure('alvi');f.import({rows:[{periodStart:'2026-08-01',periodEnd:'2026-08-31',category:'авокадо',metric:'searches',value:5,partial:false}]},'alvi');
 assert.deepEqual(f.api.get('alvi').categories.items.map(item=>item.category),['авокадо']);
 assert.deepEqual(f.api.get('avokado').categories.items.map(item=>item.category),['Массажист','Эпиляция']);
 // Настоящая отсутствующая рубрика по-прежнему блокирует.
 f.api.saveCategories('avokado',{revision:1,items:[{category:'SPA',classification:'target',reason:''}]},f.actor);
 const spa=f.api.potential('avokado','2026-08-01','2026-08-31');assert.equal(spa.totals.target,null);assert.equal(spa.complete,false);assert.deepEqual(spa.missingCategories,['SPA']);
});
