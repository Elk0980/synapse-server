'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createSocialStats}=require('./social-stats');
function fixture(t,zone='Europe/Moscow'){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,timezone TEXT,is_deleted INTEGER DEFAULT 0);
 INSERT INTO companies VALUES(1,'alpha','A','Europe/Moscow',0),(2,'beta','B','UTC',0);
 CREATE TABLE leads(id INTEGER PRIMARY KEY,company_code TEXT,created_at TEXT,stage TEXT,sale_amount REAL,source TEXT,utm_source TEXT,utm_content TEXT,utm_campaign TEXT,referrer TEXT,landing_page TEXT);
 CREATE TABLE autoposting_posts(id INTEGER PRIMARY KEY,company_id INTEGER,external_id TEXT,meta TEXT,content_revision INTEGER);
 CREATE TABLE autoposting_publication_receipts(id INTEGER PRIMARY KEY,company_id INTEGER,post_id INTEGER,platform TEXT,url TEXT,published_at TEXT,content_revision INTEGER);
 INSERT INTO autoposting_posts VALUES(1,1,'D1','{"format":"post","role":"reach"}',1);
 INSERT INTO autoposting_publication_receipts VALUES(1,1,1,'telegram','https://t.me/demo_channel/10','2026-08-20T12:00:00Z',1);`);
 db.prepare('UPDATE companies SET timezone=? WHERE id=1').run(zone);
 const stats=createSocialStats(db,{now:()=>Date.parse('2026-11-02T00:00:00Z'),adapters:{},logger:{warn(){}}});
 stats.writePosts('alpha','telegram',[{platformPostId:'native-10',url:'https://t.me/demo_channel/10',contentId:'D1',publishedAt:'2026-08-20T12:00:00Z',metrics:[]}],{provider:'manual'});
 const lead=(at,amount=10,code='alpha')=>db.prepare('INSERT INTO leads(company_code,created_at,stage,sale_amount,source,referrer) VALUES(?,?,?,?,?,?)')
  .run(code,at,'продажа',amount,'telegram','https://t.me/demo_channel/10');
 const read=(from='2026-10-01',to='2026-10-31',options={crmPeriod:'project'},code='alpha')=>stats.attribution(code,from,to,options);
 return {db,stats,lead,read};
}
const validation=(fn,field)=>assert.throws(fn,error=>error.status===400&&error.code==='VALIDATION_ERROR'&&error.field===field);

test('CF29 Moscow: сентябрьский UTC timestamp относится октябрю проекта, обе CRM выборки используют [start,end)',t=>{
 const f=fixture(t);
 f.lead('2026-09-30T20:59:59.999Z',1);
 f.lead('2026-09-30T21:00:00.000Z',100);
 f.lead('2026-09-30T21:00:00Z',100);
 f.lead('2026-09-30T21:30:00Z',200);
 f.lead('2026-10-31T20:59:59.999Z',300);
 f.lead('2026-10-31T21:00:00.000Z',400);
 const result=f.read();assert.equal(result.posts.length,1);
 assert.deepEqual([result.posts[0].leads,result.posts[0].sales,result.posts[0].revenue],[4,4,700]);
 assert.deepEqual(result.bySource,[{source:'telegram',leads:4,sales:4,revenue:700}]);
 assert.deepEqual(result.period,{basis:'project',timezone:'Europe/Moscow',from:'2026-10-01',to:'2026-10-31',
  startInclusive:'2026-09-30T21:00:00.000Z',endExclusive:'2026-10-31T21:00:00.000Z'});
 assert.equal(result.posts[0].publishedAt,'2026-08-20T12:00:00Z','реестр не отфильтрован месяцем заявок');
});

test('CF29: default UTC и explicit utc сохраняют прежний DTO без period',t=>{
 const f=fixture(t);f.lead('2026-09-30T21:30:00Z',10);f.lead('2026-10-31T21:30:00Z',20);
 const legacy=f.stats.attribution('alpha','2026-10-01','2026-10-31');
 assert.equal(legacy.posts[0].leads,1);assert.equal(legacy.posts[0].revenue,20);
 assert.equal(Object.hasOwn(legacy,'period'),false);
 assert.deepEqual(f.read(undefined,undefined,{}),legacy);
 assert.deepEqual(f.read(undefined,undefined,{crmPeriod:'utc'}),legacy);
 assert.deepEqual(f.stats.overview('alpha','2026-10-01','2026-10-31',{crmPeriod:'utc'}),f.stats.overview('alpha','2026-10-01','2026-10-31'));
 assert.equal(f.read().posts[0].revenue,10);
});

test('CF29 DST: реальные день и месяц Berlin на весеннем и осеннем переходе',t=>{
 for(const [from,to,start,end,hours] of [
  ['2026-03-29','2026-03-29','2026-03-28T23:00:00.000Z','2026-03-29T22:00:00.000Z',23],
  ['2026-10-25','2026-10-25','2026-10-24T22:00:00.000Z','2026-10-25T23:00:00.000Z',25],
  ['2026-03-01','2026-03-31','2026-02-28T23:00:00.000Z','2026-03-31T22:00:00.000Z',743],
  ['2026-10-01','2026-10-31','2026-09-30T22:00:00.000Z','2026-10-31T23:00:00.000Z',745]
 ]){
  const f=fixture(t,'Europe/Berlin');f.lead(new Date(Date.parse(start)-1).toISOString());f.lead(start);
  f.lead(new Date(Date.parse(end)-1).toISOString());f.lead(end);
  const result=f.read(from,to);assert.equal(result.posts[0].leads,2,`${from}..${to}`);
  assert.equal(result.bySource[0].leads,2);assert.equal(result.period.startInclusive,start);assert.equal(result.period.endExclusive,end);
  assert.equal((Date.parse(end)-Date.parse(start))/3600000,hours);
 }
});

test('CF29: timezone только своей активной компании, не из options или соседней компании',t=>{
 const f=fixture(t);f.lead('2026-09-30T21:30:00Z',10);f.lead('2026-09-30T21:30:00Z',999,'beta');
 assert.equal(f.read().posts[0].revenue,10);
 const beta=f.read('2026-10-01','2026-10-31',{crmPeriod:'project'},'beta');assert.equal(beta.period.timezone,'UTC');assert.deepEqual(beta.bySource,[]);
 assert.equal(f.read('2026-09-30','2026-09-30',{crmPeriod:'project'},'beta').bySource[0].revenue,999);
 validation(()=>f.read(undefined,undefined,{crmPeriod:'project',timezone:'UTC'}),'timezone');
 validation(()=>f.read(undefined,undefined,{crmPeriod:'project',companyCode:'beta'}),'companyCode');
 f.db.exec('UPDATE companies SET is_deleted=1 WHERE id=1');
 assert.throws(()=>f.read(),error=>error.status===404&&error.code==='NOT_FOUND');
});

test('CF29: строгие options без coercion и пустой/невалидный company timezone без fallback',t=>{
 const f=fixture(t);
 for(const options of [null,[],false,'project',{crmPeriod:null},{crmPeriod:undefined},{crmPeriod:1},{crmPeriod:'PROJECT'},{crmPeriod:''},{crmPeriod:'account'}]){
  validation(()=>f.read(undefined,undefined,options),'crmPeriod');
  validation(()=>f.stats.overview('alpha','2026-10-01','2026-10-31',options),'crmPeriod');
 }
 for(const tz of [null,'','   ','Mars/Phobos',17]){
  f.db.prepare('UPDATE companies SET timezone=? WHERE id=1').run(tz);
  validation(()=>f.read(),'timezone');validation(()=>f.stats.overview('alpha','2026-10-01','2026-10-31',{crmPeriod:'project'}),'timezone');
  assert.equal(Object.hasOwn(f.stats.attribution('alpha','2026-10-01','2026-10-31'),'period'),false,'legacy не требует company timezone');
 }
});

test('CF29: project меняет только CRM период; daily/postMetrics/CF27/лимиты и readonly прежние',t=>{
 const f=fixture(t);f.lead('2026-09-30T21:30:00Z');
 f.stats.saveAccounts('alpha',{accounts:[{platform:'telegram',accountRef:'@demo_channel',provider:'manual',timezone:'Asia/Bangkok',revision:0}]});
 f.stats.writeSnapshots('alpha','telegram','@demo_channel',[{date:'2026-10-01',metric:'views',value:9,period:'day',kind:'organic',completeness:'complete'}],{provider:'manual',tz:'Asia/Bangkok'});
 const changes=f.db.prepare('SELECT total_changes() n').get().n;
 const legacy=f.stats.overview('alpha','2026-10-01','2026-10-31'),project=f.stats.overview('alpha','2026-10-01','2026-10-31',{crmPeriod:'project'});
 assert.deepEqual({...project,crm:legacy.crm},legacy,'всё кроме CRM неизменно');assert.equal(project.platforms.telegram.totals.views,9);
 assert.equal(project.platforms.telegram.timezone,'Asia/Bangkok');assert.equal(project.crm.period.timezone,'Europe/Moscow');
 assert.deepEqual([project.crm.posts[0].format,project.crm.posts[0].ovpRole],['post','reach']);
 assert.equal(project.postMetrics.coverage.postsLimit,200);
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
 f.db.exec("UPDATE autoposting_posts SET content_revision=2,meta='{\"format\":\"reel\",\"role\":\"sale\"}' WHERE id=1");
 assert.deepEqual(f.read().posts.map(post=>[post.format,post.ovpRole]),[[null,null]],'CF27 stale опубликованная версия не получает текущие метки');
});
