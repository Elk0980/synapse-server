'use strict';
// Реальные модули и SQLite; Google отвечает синтетическими Response, внешней сети нет.
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {createSocialAnalyticsCredentials}=require('./social-analytics-credentials');
const {createSocialYoutubeAccess,YOUTUBE_READONLY_SCOPES}=require('./social-youtube-access');
const {createSocialYoutubeStats}=require('./social-youtube-stats');
const {createSocialAdapters}=require('./social-adapters');
const {createSocialStats}=require('./social-stats');
const {createSocialStatsHandler}=require('./social-stats-http');
const CHANNEL='UCabcdefghijklmnopqrstuv',AT=Date.parse('2026-10-13T18:00:00Z');
const SECRET=JSON.stringify({clientId:'synthetic.apps.googleusercontent.com',clientSecret:'GOCSPX-synthetic',refreshToken:'1//synthetic-refresh'});
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
function setup(t,{provider='onlypult',timezone='America/Los_Angeles'}={}) {
 const h={time:AT,calls:[],pending:false,stall:false,role:'owner',body:{},onlypultCalls:0};
 h.db=new DatabaseSync(':memory:');h.db.exec("CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,timezone TEXT,is_deleted INTEGER DEFAULT 0);INSERT INTO companies VALUES(1,'demo-a','A','Europe/Moscow',0),(2,'demo-b','B','Asia/Irkutsk',0)");
 h.credentials=createSocialAnalyticsCredentials(h.db,{apiKey:'synthetic-test-key',now:()=>h.time});
 const fetchImpl=async(url,init)=>{
  h.calls.push({url,method:init.method});assert.equal(init.redirect,'error');const u=new URL(url);
  if(u.origin==='https://oauth2.googleapis.com')return json({access_token:'ya29.synthetic',expires_in:3600,token_type:'Bearer',scope:YOUTUBE_READONLY_SCOPES.join(' ')});
  if(u.origin==='https://www.googleapis.com')return json({items:[{id:CHANNEL,snippet:{title:'Synthetic channel'},statistics:{subscriberCount:'1230'}}]});
  assert.equal(u.origin,'https://youtubeanalytics.googleapis.com');
  if(h.stall)return new Promise(()=>{});
  const metrics=u.searchParams.get('metrics').split(','),date=u.searchParams.get('startDate');
  const values={views:120,engagedViews:90,estimatedMinutesWatched:10,likes:4,comments:2,shares:1,subscribersGained:5,subscribersLost:2};
  return json({columnHeaders:[{name:'day',columnType:'DIMENSION',dataType:'STRING'},...metrics.map(name=>({name,columnType:'METRIC',dataType:name==='estimatedMinutesWatched'?'FLOAT':'INTEGER'}))],rows:h.pending?[]:[[date,...metrics.map(name=>values[name])]]});
 };
 h.access=createSocialYoutubeAccess(h.db,{credentials:h.credentials,fetchImpl,now:()=>h.time,timeoutMs:1000});
 h.youtube=createSocialYoutubeStats({access:h.access,now:()=>h.time,collectTimeoutMs:1000});
 h.adapters=createSocialAdapters({youtubeStats:h.youtube,analytics:{credentials:h.credentials,collector:{collectDay(){h.onlypultCalls++;throw new Error('Onlypult must not read YouTube')}}}});
 h.stats=createSocialStats(h.db,{adapters:h.adapters,now:()=>h.time,logger:{warn(){}}});
 h.stats.saveAccounts('demo-a',{accounts:[{platform:'youtube',provider,accountRef:CHANNEL,timezone,collectHour:6,revision:0}]});
 h.handler=createSocialStatsHandler({stats:h.stats,baselines:{},youtube:{access:h.access},readJson:async()=>h.body,
  companyModuleContext:(_req,code,permission)=>{assert.equal(code,'demo-a');assert.ok(['crm.edit','analytics.view'].includes(permission));return {company:{code},identity:{role:h.role,userId:7}}},
  send:(_response,status,body,headers)=>{h.response={status,body,headers}}});
 h.request=async(method,path,body={})=>{h.body=body;h.response=null;await h.handler({method},{},new URL(path+'?companyCode=demo-a','http://loopback.invalid'));return h.response};
 h.connect=async()=>{assert.equal((await h.request('PUT','/social-stats/youtube/access',{revision:0,credential:SECRET})).status,200);const answer=await h.request('POST','/social-stats/youtube/verify');assert.equal(answer.status,200);assert.equal(answer.body.channelConfirmed,true)};
 t.after(async()=>{h.youtube.stop();h.access.stop();await h.stats.stop();h.db.close()});return h;
}
test('HTTP→точный канал→Google reports→SQLite: Onlypult выбран, происхождение direct, Pacific и две метрики сохранены',async t=>{
 const h=setup(t);await h.connect();const answer=await h.request('POST','/social-stats/collect',{platform:'youtube',date:'2026-10-12'});
 assert.equal(answer.status,200);assert.equal(answer.body.status,'ok');assert.equal(answer.body.provider,'direct');assert.equal(h.onlypultCalls,0);
 const rows=h.db.prepare('SELECT * FROM social_snapshots ORDER BY metric').all();assert.equal(rows.length,8);
 assert.ok(rows.every(r=>r.provider==='direct'&&r.timezone==='America/Los_Angeles'&&r.company_code==='demo-a'));
 assert.equal(rows.find(r=>r.metric==='views').value,120);assert.equal(rows.find(r=>r.metric==='engaged_views').value,90);assert.equal(rows.find(r=>r.metric==='watch_time_seconds').value,600);
 assert.equal(rows.find(r=>r.metric==='followers').date,'2026-10-13');assert.equal(rows.find(r=>r.metric==='views').date,'2026-10-12');
 assert.equal(h.stats.accounts('demo-a').accounts.find(a=>a.platform==='youtube').provider,'onlypult');
 assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM social_snapshots WHERE company_code='demo-b'").get().n,0);
 const state=await h.request('GET','/social-stats/youtube/access');assert.equal(state.headers['cache-control'],'no-store');assert.equal(JSON.stringify(state.body).includes('synthetic-refresh'),false);
});
test('чужая роль не читает/не меняет доступ; тело verify не подменяет сохранённый канал',async t=>{
 const h=setup(t);h.role='editor';for(const method of ['GET','PUT','DELETE'])assert.equal((await h.request(method,'/social-stats/youtube/access',{revision:0,credential:SECRET})).status,403);
 assert.equal((await h.request('POST','/social-stats/youtube/verify')).status,403);assert.equal(h.calls.length,0);
 h.role='owner';assert.equal((await h.request('POST','/social-stats/youtube/verify',{accountRef:CHANNEL})).status,400);assert.equal(h.calls.length,0);
});
test('настройка Иркутска не переименовывает суточные данные Pacific и не запускает Google collect',async t=>{
 const h=setup(t,{timezone:'Asia/Irkutsk'});await h.connect();const before=h.calls.length;
 const result=await h.stats.collect('demo-a','youtube',{date:'2026-10-12'});assert.equal(result.status,'missing_access');assert.equal(h.calls.length,before);assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM social_snapshots').get().n,0);
});
test('задержанный дневной отчёт сохраняет текущих подписчиков, повтор ждёт и неизвестные views не превращаются в0',async t=>{
 const h=setup(t,{provider:'direct'});await h.connect();h.pending=true;await h.stats.collectDue();
 const reports=()=>h.calls.filter(c=>c.url.includes('youtubeanalytics')&&new URL(c.url).searchParams.get('startDate')==='2026-10-12').length;
 const before=reports();assert.equal(before,2);assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM social_snapshots WHERE metric='views'").get().n,0);
 assert.equal(h.db.prepare("SELECT value FROM social_snapshots WHERE metric='followers'").get().value,1230);
 await h.stats.collectDue();assert.equal(reports(),before);h.time+=16*60000;await h.stats.collectDue();assert.equal(reports(),before+2);
});
test('остановка прерывает зависший YouTube и ждёт весь плановый проход до закрытияSQLite; поздних чисел нет',async t=>{
 const h=setup(t,{provider:'direct'});await h.connect();h.stall=true;
 const run=h.stats.collectDue();await new Promise(r=>setImmediate(r));h.access.stop();await h.stats.stop();await run;
 assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM social_snapshots').get().n,0);
 assert.deepEqual(await h.stats.collectDue(),[]);await assert.rejects(h.stats.collect('demo-a','youtube'),{code:'SERVER_STOPPING'});
 assert.ok(h.db.prepare('SELECT * FROM social_collect_runs').all().every(r=>r.finished_at));
});
