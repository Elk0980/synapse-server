'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createSocialStats}=require('./social-stats');
const {createSocialAnalyticsCredentials}=require('./social-analytics-credentials');
const {createSocialMaxAccess}=require('./social-max-access');
const {createSocialMaxService}=require('./social-max-service');
const {createSocialAdapters}=require('./social-adapters');
const {createSocialStatsHandler}=require('./social-stats-http');
const NOW=Date.parse('2026-10-12T10:00:00Z');
function fixture(t,{legacy=false,adapter=null}={}){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,timezone TEXT,is_deleted INTEGER DEFAULT 0);
 INSERT INTO companies VALUES(1,'max-a','Синтетика А','UTC',0),(2,'max-b','Синтетика Б','UTC',0);
 CREATE TABLE leads(id INTEGER PRIMARY KEY,company_code TEXT,created_at TEXT,stage TEXT,sale_amount REAL,source TEXT,utm_source TEXT,utm_content TEXT,utm_campaign TEXT,referrer TEXT,landing_page TEXT);`);
 if(legacy)db.exec(`CREATE TABLE social_posts(id INTEGER PRIMARY KEY AUTOINCREMENT,company_code TEXT NOT NULL COLLATE NOCASE,platform TEXT NOT NULL,platform_post_id TEXT NOT NULL,url TEXT NOT NULL DEFAULT '',content_id TEXT NOT NULL DEFAULT '',published_at TEXT,provider TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'organic',created_at TEXT NOT NULL,UNIQUE(company_code,platform,platform_post_id));
 CREATE TABLE social_post_metrics(post_id INTEGER NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,date TEXT NOT NULL,metric TEXT NOT NULL,value REAL,unit TEXT NOT NULL,source_field TEXT NOT NULL DEFAULT '',completeness TEXT NOT NULL DEFAULT 'unknown',provider TEXT NOT NULL,collected_at TEXT NOT NULL,run_id INTEGER,PRIMARY KEY(post_id,date,metric));
 INSERT INTO social_posts(id,company_code,platform,platform_post_id,provider,created_at)VALUES(1,'max-a','telegram','legacy-native','direct','2026-10-01T10:00:00Z');
 INSERT INTO social_post_metrics VALUES(1,'2026-10-01','views',20,'views','legacy-field','complete','direct','2026-10-01T10:00:00Z',7);`);
 const clock={ms:NOW};const stats=createSocialStats(db,{now:()=>clock.ms,adapters:adapter?{direct:adapter}:{},logger:{warn(){}}});
 return {db,stats,clock};
}
const post=(value,date='2026-10-12',period='lifetime')=>({platformPostId:'mid.native-test',publishedAt:'2026-10-01T10:00:00Z',metrics:[{metric:'views',value,date,period,sourceField:'MAX.Message.stat.views',completeness:'complete'}]});
const measurement=(f,code='max-a')=>f.stats.postMetrics(code,'2026-10-01','2026-10-12').posts.flatMap(p=>p.sources.flatMap(s=>s.measurements));

test('миграция постовых измерений сохраняет значения/происхождение/FK, не выдумывает дневной период',t=>{
 const f=fixture(t,{legacy:true});const old=f.db.prepare('SELECT * FROM social_post_metrics').get();
 assert.equal(old.value,20);assert.equal(old.period,'unknown');assert.equal(old.collected_at,'2026-10-01T10:00:00Z');assert.equal(old.run_id,7);assert.equal(old.source_field,'legacy-field');
 assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
 createSocialStats(f.db,{now:()=>NOW});assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_post_metrics').get().n,1);
 assert.equal(measurement(f)[0].value,20);assert.equal(measurement(f)[0].period,undefined);
});
test('lifetime просмотры показывают последний замер, не сумму, и не смешиваются между компаниями',t=>{
 const f=fixture(t);
 f.stats.writePosts('max-a','max',[post(10,'2026-10-11')],{provider:'direct',collectedAt:'2026-10-11T10:00:00Z'});
 f.stats.writePosts('max-a','max',[post(15)],{provider:'direct',collectedAt:'2026-10-12T10:00:00Z'});
 f.stats.writePosts('max-b','max',[post(999)],{provider:'direct',collectedAt:'2026-10-12T10:00:00Z'});
 const a=measurement(f);assert.equal(a.length,1);assert.equal(a[0].value,15);assert.equal(a[0].period,'lifetime');assert.equal(a[0].date,'2026-10-12');
 assert.equal(measurement(f,'max-b')[0].value,999);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_post_metrics').get().n,3);
});
test('несовместимые day/lifetime на одном посте сохраняются отдельно и не дают произвольный единый итог',t=>{
 const f=fixture(t);f.stats.writePosts('max-a','max',[post(15)],{provider:'direct',collectedAt:'2026-10-12T10:00:00Z'});
 f.stats.writePosts('max-a','max',[post(3,'2026-10-12','day')],{provider:'manual',collectedAt:'2026-10-12T11:00:00Z'});
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_post_metrics').get().n,2);
 const a=measurement(f)[0];assert.equal(a.value,null);assert.equal(a.period,'mixed');assert.equal(a.scopeConflict,true);assert.equal(a.completeness,'unknown');
});
test('задержавшийся запуск другой целевой даты не перезаписывает свежий lifetime и metadata',async t=>{
 const pending=[];const adapter={info:()=>({name:'direct'}),connectionRevision:()=>({provider:'max_analytics',revision:1}),collect:()=>new Promise(resolve=>pending.push(resolve))};
 const f=fixture(t,{adapter});f.stats.saveAccounts('max-a',{accounts:[{platform:'max',accountRef:'-123456',provider:'direct',timezone:'UTC',revision:0}]});
 const old=f.stats.collect('max-a','max',{date:'2026-10-11'});f.clock.ms+=60000;
 const newer=f.stats.collect('max-a','max',{date:'2026-10-12'});
 pending[1]({status:'partial',snapshots:[],posts:[post(100)],missing:[],retryable:false});await newer;
 pending[0]({status:'partial',snapshots:[],posts:[post(50)],missing:[],retryable:false});await old;
 const row=f.db.prepare('SELECT * FROM social_post_metrics').get();assert.equal(row.value,100);assert.equal(row.period,'lifetime');assert.equal(row.collected_at,new Date(NOW+60000).toISOString());
 assert.equal(f.db.prepare('SELECT source_collected_at FROM social_posts').get().source_collected_at,row.collected_at);
});
test('MAX имеет отдельный encrypted namespace, read DTO не раскрывает ключ, чужой конверт не читается',t=>{
 const f=fixture(t);const store=createSocialAnalyticsCredentials(f.db,{apiKey:'synthetic-storage-key',now:()=>NOW});
 const saved=store.save('max-a','max_analytics',{revision:0,credential:'synthetic-max-private'});
 assert.equal(saved.configured,true);assert.equal(JSON.stringify(saved).includes('synthetic-max-private'),false);
 assert.equal(store.resolve('max-a','max_analytics').credential,'synthetic-max-private');assert.equal(store.resolve('max-b','max_analytics'),null);
 f.db.prepare('INSERT INTO social_analytics_credentials SELECT ?,provider,encrypted_credential,revision,checked_revision,status,status_code,checked_at,updated_at,actor_id,actor_name FROM social_analytics_credentials WHERE company_code=?').run('max-b','max-a');
 assert.equal(store.resolve('max-b','max_analytics').unreadable,true);
 assert.equal(store.get('max-a','onlypult_analytics').configured,false);
});

function nativePipeline(t){
 const f=fixture(t),chat='-72000000000000001',calls=[];
 const credentials=createSocialAnalyticsCredentials(f.db,{apiKey:'synthetic-native-store',now:()=>f.clock.ms});
 const access=createSocialMaxAccess(f.db,{credentials,now:()=>f.clock.ms,fetchImpl:async(url,init)=>{
  const u=new URL(url);calls.push({url,headers:init.headers});assert.equal(u.origin,'https://platform-api2.max.ru');assert.equal(init.method,'GET');assert.equal(init.redirect,'error');
  let body;if(u.pathname==='/me')body='{"user_id":123,"is_bot":true}';
  else if(u.pathname.endsWith('/members/me'))body='{"user_id":123,"is_bot":true,"is_admin":true,"is_owner":false,"permissions":["read_all_messages"]}';
  else if(u.pathname.startsWith('/chats/'))body=`{"chat_id":${u.pathname.split('/')[2]},"type":"channel","status":"active","participants_count":42}`;
  else if(u.pathname==='/messages'){const nativeChat=u.searchParams.get('chat_id')||chat;body=`{"messages":[{"recipient":{"chat_id":${nativeChat},"chat_type":"channel"},"timestamp":${NOW-86400000},"body":{"mid":"mid.same"},"stat":{"views":25}}]}`;}
  else throw Error('Unexpected native GET');
  return new Response(body,{status:200,headers:{'content-type':'application/json'}});
 }});
 const max=createSocialMaxService(f.db,{access,now:()=>f.clock.ms});const stats=createSocialStats(f.db,{maxIndex:max.index,adapters:createSocialAdapters({maxStats:max}),now:()=>f.clock.ms,logger:{warn(){}}});
 stats.saveAccounts('max-a',{accounts:[{platform:'max',accountRef:chat,provider:'onlypult',timezone:'UTC',revision:0}]});
 credentials.save('max-a','max_analytics',{revision:0,credential:'synthetic-max-native'});
 t.after(async()=>{await access.stop();await stats.stop()});
 return {...f,stats,access,max,credentials,chat,calls};
}
test('actual credential→verify→adapter→SQL путь сохраняет native provider, today lifetime и индекс без ложной дневной истории',async t=>{
 const h=nativePipeline(t);await h.access.verify('max-a',{accountRef:h.chat});
 const r=await h.stats.collect('max-a','max',{date:'2026-10-11'});assert.equal(r.status,'partial');assert.equal(r.provider,'direct');
 const profile=h.db.prepare("SELECT * FROM social_snapshots WHERE platform='max'").get();assert.equal(profile.date,'2026-10-12');assert.equal(profile.period,'lifetime');assert.equal(profile.value,42);
 const observation=h.db.prepare('SELECT * FROM social_post_metrics').get();assert.equal(observation.date,'2026-10-12');assert.equal(observation.period,'lifetime');assert.equal(observation.value,25);
 assert.equal(h.db.prepare('SELECT COUNT(*) n FROM social_max_post_index').get().n,1);assert.equal(h.stats.accounts('max-a').accounts.find(a=>a.platform==='max').provider,'onlypult');
 const oldRequests=h.calls.length;h.clock.ms+=60000;await h.stats.collect('max-a','max',{date:'2026-10-10'});assert.ok(h.calls.slice(oldRequests).some(c=>c.url.includes('message_ids=mid.same')));
 assert.equal(h.db.prepare('SELECT COUNT(*) n FROM social_posts').get().n,1);assert.equal(h.db.prepare('SELECT COUNT(*) n FROM social_post_metrics').get().n,1);
});
test('MAX owner routes derive saved reference and reject editor/public supplied channel without native reads',async t=>{
 const h=nativePipeline(t);let role='editor',body={},result;
 const handler=createSocialStatsHandler({stats:h.stats,baselines:{},max:{access:h.access,credentials:h.credentials},readJson:async()=>body,send:(_r,status,payload)=>{result={status,payload}},companyModuleContext:()=>({company:{code:'max-a'},identity:{role,userId:1}})});
 const invoke=async(method,path)=>{await handler({method},{},new URL('http://fixture.test'+path+'?companyCode=max-a'),{});return result;};
 assert.equal((await invoke('GET','/social-stats/max/access')).status,403);assert.equal(h.calls.length,0);
 role='owner';body={chatId:'-99',proof:true};assert.equal((await invoke('POST','/social-stats/max/verify')).status,400);assert.equal(h.calls.length,0);
 body={};const verified=await invoke('POST','/social-stats/max/verify');assert.equal(verified.status,200);assert.equal(verified.payload.channelId,h.chat);assert.equal(JSON.stringify(verified.payload).includes('synthetic-max-native'),false);
});
