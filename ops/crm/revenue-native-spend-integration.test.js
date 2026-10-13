'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createRevenueAnalytics}=require('./revenue-analytics');
const {createRevenueAdapters}=require('./revenue-analytics-adapters');
const NOW=Date.parse('2026-10-13T12:00:00Z'),P={from:'2026-10-01',to:'2026-10-02'};
function fixture(t,{filename=':memory:'}={}){
 const db=new DatabaseSync(filename);const f={db,time:NOW,cost:'9999',calls:0};
 const adapters=createRevenueAdapters({now:()=>f.time,wait:async()=>{},fetchImpl:async(url,init)=>{
  assert.equal(url,'https://api.direct.yandex.com/json/v501/reports');assert.equal(init.method,'POST');
  f.calls++;const body=JSON.parse(init.body).params;
  const row=f.cost===null?[]:[`${body.SelectionCriteria.DateFrom}\t701\t1\t1\t${f.cost}`];
  return new Response([`"${body.ReportName} (${body.SelectionCriteria.DateFrom} - ${body.SelectionCriteria.DateTo})"`,
   'Date\tCampaignId\tImpressions\tClicks\tCost',...row,`Total rows: ${row.length}`].join('\n')+'\n',
   {headers:{'content-type':'text/tab-separated-values','RequestId':'synthetic-native-spend'}});
 }});
 f.analytics=createRevenueAnalytics(db,{apiKey:'synthetic-native-spend-key',now:()=>f.time,adapters});
 f.save=enabled=>f.analytics.save('alvi','direct',{revision:f.analytics.access.get('alvi','direct').revision,enabled,
  config:{externalLogin:'fixture-client',campaignIds:['701'],currency:'RUB',timezone:'Europe/Moscow',includeVAT:false,includeDiscount:true,historyFrom:'2026-09-01'},
  credential:{token:'synthetic-direct-spend-private'}});
 f.report=()=>f.analytics.report('alvi',P.from,P.to,{analysisTimezone:'Europe/Moscow'});
 let closed=false;f.close=async()=>{if(!closed){closed=true;await f.analytics.stop();db.close();}};
 t.after(()=>f.close());
 f.save(true);return f;
}
test('настоящий report читает native µ snapshot без сети/записи и не объявляет полный expense inventory',async t=>{
 const f=fixture(t);assert.equal(f.report().cohorts.spend.knownKopecks,null);
 await f.analytics.collect('alvi','direct',P);
 const calls=f.calls,changes=f.db.prepare('SELECT total_changes() n').get().n;
 const report=f.report();assert.equal(report.cohorts.spend.knownMicros,9999);
 assert.equal(report.cohorts.spend.knownKopecks,1);
 assert.notEqual(report.cohorts.spend.status,'verified');
 assert.equal(report.cohorts.scope.vatMode,'unknown');
 assert.equal(report.economics.cac,null);assert.equal(report.economics.romi,null);
 assert.equal(report.cohorts.source.leadJournal,'not_integrated');
 assert.equal(f.calls,calls);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
 assert.doesNotMatch(JSON.stringify(report.cohorts),/synthetic-direct-spend-private|fixture-client/);
});
test('успешный пустой новый report убирает прежний knownDirect расход; disabled/stale/foreign компания не использует cache',async t=>{
 const f=fixture(t);await f.analytics.collect('alvi','direct',P);assert.equal(f.report().cohorts.spend.knownMicros,9999);
 f.time+=1000;f.cost=null;await f.analytics.collect('alvi','direct',P);
 assert.equal(f.report().cohorts.spend.knownMicros,0);assert.notEqual(f.report().cohorts.spend.status,'verified');
 assert.equal(f.analytics.report('avokado',P.from,P.to).cohorts.spend.knownKopecks,null);
 f.time+=4*3600000;assert.equal(f.report().cohorts.spend.knownKopecks,null);
 f.save(false);assert.equal(f.report().cohorts.spend.knownKopecks,null);
});
test('WAL writer между настройками и расходами не смешивает SQL версии в настоящем отчёте',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-spend-wal-')),filename=path.join(root,'fixture.sqlite');
 const f=fixture(t,{filename});f.db.exec('PRAGMA journal_mode=WAL');const other=new DatabaseSync(filename);
 t.after(async()=>{
  await f.close();other.close();const absolute=fs.realpathSync(root);
  assert.equal(path.dirname(absolute),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(absolute).startsWith('native-spend-wal-'));
  assert.equal(fs.lstatSync(root).isSymbolicLink(),false);fs.rmSync(root,{recursive:true});
 });
 await f.analytics.collect('alvi','direct',P);
 const originalPrepare=f.db.prepare.bind(f.db);let changed=false;
 f.db.prepare=sql=>{
  if(!changed&&sql.startsWith('SELECT company,from_day,to_day,revision,payload,collected_at FROM revenue_direct')){
   changed=true;const saved=other.prepare('SELECT payload FROM revenue_direct WHERE company=?').get('alvi');
   const payload=JSON.parse(saved.payload);payload.rows[0].costMicros=7777;payload.totalCostMicros=7777;
   other.prepare('UPDATE revenue_direct SET payload=? WHERE company=?').run(JSON.stringify(payload),'alvi');
  }
  return originalPrepare(sql);
 };
 assert.equal(f.report().cohorts.spend.knownMicros,9999);
 assert.equal(changed,true);assert.equal(f.report().cohorts.spend.knownMicros,7777);
});
