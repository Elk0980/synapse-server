'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const {createSocialMaxService}=require('./social-max-service');
const {createSocialAdapters}=require('./social-adapters');
const {createSocialStats}=require('./social-stats');
const CHAT='-1000000000000000137',NOW=Date.parse('2026-10-13T12:00:00Z');
const posts=Array.from({length:450},(_,i)=>({recipient:{chat_id:CHAT,chat_type:'channel'},
 timestamp:Date.parse('2026-10-01T00:00:00Z')-i*3600000,body:{mid:'mid.history'+i},stat:{views:10+i}}));
function access(clock,hook){
 const envelope=(messages)=>({companyCode:'history',chatId:CHAT,accessRevision:1,observedAt:new Date(clock.ms).toISOString(),data:{messages}});
 return {ready:()=>({ok:true,chatId:CHAT,accountRef:CHAT,accessRevision:1}),bindingFingerprint:()=>CHAT+':1',
  readChannel:async()=>({...envelope([]),data:{chat_id:CHAT,type:'channel',status:'active',participants_count:140}}),
  readMessages:async(code,query,{signal}={})=>{
   if(hook){const answer=await hook(query,envelope,signal);if(answer!==undefined)return answer;}
   const rows=query.messageIds?posts.filter(p=>query.messageIds.includes(p.body.mid))
    :posts.filter(p=>p.timestamp>=query.after&&p.timestamp<=query.before).slice(0,query.count);
   return envelope(rows);
  }};
}
function open(file,clock,{initialize=false,hook,maxPages=1}={}){
 const db=new DatabaseSync(file||':memory:');
 if(initialize)db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,timezone TEXT,is_deleted INTEGER DEFAULT 0);
 INSERT INTO companies VALUES(1,'history','Fixture','UTC',0);
 CREATE TABLE leads(id INTEGER PRIMARY KEY,company_code TEXT,created_at TEXT,stage TEXT,sale_amount REAL,source TEXT,utm_source TEXT,utm_content TEXT,utm_campaign TEXT,referrer TEXT,landing_page TEXT);`);
 const service=createSocialMaxService(db,{access:access(clock,hook),now:()=>clock.ms,backfillOptions:{maxPages}});
 const stats=createSocialStats(db,{now:()=>clock.ms,maxIndex:service.index,adapters:createSocialAdapters({maxStats:service}),logger:{warn(){}}});
 if(initialize)stats.saveAccounts('history',{accounts:[{platform:'max',accountRef:CHAT,provider:'direct',timezone:'UTC',enabled:true,revision:0}]});
 let closed=false;
 return {db,service,stats,async close(){if(!closed){closed=true;await stats.stop();db.close();}}};
}
test('штатный schedule продолжает исторический индекс после SQLite reopen и охватывает посты старше дней очереди',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'synapse-max-history-')),file=path.join(root,'fixture.sqlite');
 const clock={ms:NOW},opened=[];
 t.after(async()=>{
  for(const f of opened)await f.close();
  const absolute=fs.realpathSync(root);assert.equal(path.dirname(absolute),fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(absolute).startsWith('synapse-max-history-'));assert.equal(fs.lstatSync(root).isSymbolicLink(),false);
  fs.rmSync(root,{recursive:true});
 });
 let f=open(file,clock,{initialize:true});opened.push(f);
 await f.stats.collectDue();
 const initial=f.db.prepare('SELECT count(*) n FROM social_max_post_index').get().n;
 assert.ok(initial>0&&initial<450);
 const revision=f.db.prepare('SELECT revision FROM social_max_backfill_state').get().revision;
 await f.close();f=open(file,clock);opened.push(f);
 assert.equal(f.db.prepare('SELECT revision FROM social_max_backfill_state').get().revision,revision);
 for(let i=0;i<16;i++){clock.ms+=3600001;await f.stats.collectDue();}
 assert.equal(f.db.prepare('SELECT count(*) n FROM social_max_post_index').get().n,450);
 assert.equal(f.db.prepare('SELECT phase FROM social_max_backfill_state').get().phase,'done');
 assert.equal(f.db.prepare("SELECT count(DISTINCT post_id) n FROM social_post_metrics WHERE period='lifetime' AND metric='views'").get().n,450);
 assert.ok(f.db.prepare("SELECT count(*) n FROM social_snapshots WHERE metric='followers' AND period='lifetime'").get().n>0);
 assert.equal(f.db.prepare("SELECT count(*) n FROM social_post_metrics WHERE date<'2026-10-13'").get().n,0,'история публикаций не стала дневной историей просмотров');
 const changes=f.db.prepare('SELECT total_changes() n').get().n;
 const coverage=f.stats.accounts('history').accounts.find(a=>a.platform==='max').historyIndex;
 assert.equal(coverage.indexedPosts,450);assert.equal(coverage.historyComplete,false);
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes,'чтение coverage не запускает сбор');
 f.stats.saveAccounts('history',{accounts:[{platform:'max',accountRef:'-999',provider:'direct',revision:1,timezone:'UTC'}]});
 assert.equal(f.stats.accounts('history').accounts.find(a=>a.platform==='max').historyIndex,null,'другой канал не получает прежний индекс');
});
test('stop охватывает исторический запрос после завершения дневного reader и не принимает позднюю страницу',async t=>{
 let seen,release;const entered=new Promise(resolve=>{seen=resolve;});
 const clock={ms:NOW},f=open(null,clock,{initialize:true,hook:(query,envelope)=>{
  if(query.after===0){seen();return new Promise(resolve=>{release=()=>resolve(envelope(posts.slice(0,100)));});}
 }});
 t.after(()=>f.close());
 const pending=f.service.collectDate({companyCode:'history',date:'2026-10-12',timezone:'UTC'});
 await entered;
 const stopped=f.service.stop();await assert.rejects(pending,{code:'STOPPED'});await stopped;
 release();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.db.prepare('SELECT count(*) n FROM social_max_backfill_state').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM social_max_post_index').get().n,0);
 assert.throws(()=>f.service.collectDate({companyCode:'history',date:'2026-10-12',timezone:'UTC'}),{code:'STOPPED'});
});
test('чужой receiver исторической страницы отвергает весь MAX снимок, включая staged followers',async t=>{
 const clock={ms:NOW},f=open(null,clock,{initialize:true,hook:(query,envelope)=>query.after===0
  ?envelope([{...posts[0],recipient:{chat_id:'-99',chat_type:'channel'}}]):undefined});
 t.after(()=>f.close());
 await f.stats.collect('history','max',{date:'2026-10-12'});
 assert.equal(f.db.prepare('SELECT count(*) n FROM social_snapshots').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM social_max_backfill_state').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM social_max_post_index').get().n,0);
});
test('конкурирующий late шаг откатывает индекс вместе с его cursor и не меняет наблюдение принятого шага',async t=>{
 const clock={ms:NOW},f=open(null,clock,{initialize:true});t.after(()=>f.close());
 const a=await f.service.collectDate({companyCode:'history',date:'2026-10-12',timezone:'UTC'});
 const b=await f.service.collectDate({companyCode:'history',date:'2026-10-11',timezone:'UTC'});
 const commit=(result,at)=>{
  f.db.exec('BEGIN IMMEDIATE');
  try{f.service.index.commit(result.maxIndexPrepared,{runId:1,collectedAt:at});f.db.exec('COMMIT');}
  catch(error){f.db.exec('ROLLBACK');throw error;}
 };
 commit(a,'2026-10-13T12:00:00Z');
 const before=JSON.stringify(f.db.prepare('SELECT * FROM social_max_post_index ORDER BY native_post_id').all());
 assert.throws(()=>commit(b,'2026-10-13T12:05:00Z'),{code:'MAX_BACKFILL_STALE'});
 assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM social_max_post_index ORDER BY native_post_id').all()),before);
 assert.equal(f.db.prepare('SELECT revision FROM social_max_backfill_state').get().revision,1);
});
