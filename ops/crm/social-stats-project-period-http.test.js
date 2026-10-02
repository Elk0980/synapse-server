'use strict';
// Настоящий handler и сервис; только временная SQLite и HTTP на loopback. Контекст доступа синтетический.
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {DatabaseSync}=require('node:sqlite');
const {createSocialStats}=require('./social-stats');
const {createSocialStatsHandler}=require('./social-stats-http');

async function fixture(t){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,timezone TEXT,is_deleted INTEGER DEFAULT 0);
 INSERT INTO companies VALUES(1,'demo-a','Synthetic','Europe/Moscow',0),(2,'other','Other','Europe/Berlin',0);
 CREATE TABLE leads(id INTEGER PRIMARY KEY,company_code TEXT,created_at TEXT,stage TEXT,sale_amount REAL,source TEXT,utm_source TEXT,utm_content TEXT,utm_campaign TEXT,referrer TEXT,landing_page TEXT);
 INSERT INTO leads(id,company_code,created_at,stage,source) VALUES(1,'demo-a','2026-09-30T21:30:00.000Z','новая','telegram'),(2,'other','2026-10-01T01:00:00.000Z','новая','vk');`);
 const stats=createSocialStats(db,{adapters:{},logger:{warn(){}}}),calls=[],contexts=[];
 const original=stats.overview;stats.overview=(...args)=>{calls.push(args);return original(...args);};
 const send=(response,status,body,headers={})=>{response.writeHead(status,{'content-type':'application/json',...headers});response.end(JSON.stringify(body));};
 const handle=createSocialStatsHandler({stats,baselines:{},readJson:()=>assert.fail('GET не читает mutation body'),send,
  companyModuleContext:(request,code,permission)=>{
   contexts.push({code,permission});
   if(request.headers['x-test-denied']==='1'||code!=='demo-a')throw Object.assign(new Error('Синтетический отказ доступа'),{status:403});
   assert.equal(permission,'analytics.view');return {company:{code:'demo-a'},identity:{role:'editor',userId:7}};
  }});
 const server=http.createServer(async(request,response)=>{try{if(!await handle(request,response,new URL(request.url,'http://127.0.0.1')))send(response,404,{});}catch(error){send(response,error.status||500,{error:error.message});}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
 const request=(suffix='',headers={},companyCode='demo-a')=>new Promise((resolve,reject)=>{
  http.get({hostname:'127.0.0.1',port:server.address().port,path:'/social-stats?companyCode='+encodeURIComponent(companyCode)+'&from=2026-10-01&to=2026-10-31'+suffix,headers},response=>{
   let raw='';response.on('data',chunk=>raw+=chunk);response.on('end',()=>{try{resolve({status:response.statusCode,headers:response.headers,body:JSON.parse(raw)});}catch(error){reject(error);}});
  }).on('error',reject);
 });
 return {db,calls,contexts,request};
}

test('CF29 HTTP: explicit project month reaches real stats; UTC remains compatible and reads do not write',async t=>{
 const f=await fixture(t),before=f.db.prepare('SELECT total_changes() n').get().n;
 const utc=await f.request();assert.equal(utc.status,200);assert.equal(utc.headers['cache-control'],'no-store');assert.equal(f.calls[0].length,3);
 assert.equal(Object.hasOwn(utc.body.crm,'period'),false);assert.deepEqual(utc.body.crm.bySource,[]);
 const project=await f.request('&crmPeriod=project&timezone=Europe%2FBerlin');assert.equal(project.status,200);
 assert.deepEqual(f.calls[1],['demo-a','2026-10-01','2026-10-31',{crmPeriod:'project'}]);
 assert.deepEqual(project.body.crm.period,{basis:'project',timezone:'Europe/Moscow',from:'2026-10-01',to:'2026-10-31',startInclusive:'2026-09-30T21:00:00.000Z',endExclusive:'2026-10-31T21:00:00.000Z'});
 assert.deepEqual(project.body.crm.bySource,[{source:'telegram',leads:1,sales:0,revenue:0}]);
 assert.deepEqual(project.body.platforms,utc.body.platforms);assert.deepEqual(project.body.postMetrics,utc.body.postMetrics);
 const explicitUtc=await f.request('&crmPeriod=utc');assert.equal(explicitUtc.status,200);assert.deepEqual(explicitUtc.body,utc.body);
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
});

test('CF29 HTTP: invalid, empty and repeated mode fail before overview with no-store',async t=>{
 const f=await fixture(t);
 for(const suffix of ['&crmPeriod=','&crmPeriod=unknown','&crmPeriod=PROJECT','&crmPeriod=project&crmPeriod=project','&crmPeriod=utc&crmPeriod=project']){
  const result=await f.request(suffix);assert.equal(result.status,400,suffix);assert.equal(result.headers['cache-control'],'no-store');
  assert.equal(result.body.code,'VALIDATION_ERROR');assert.equal(result.body.field,'crmPeriod');
 }
 assert.equal(f.calls.length,0);
});

test('CF29 HTTP: existing analytics.view/company boundary is retained before period validation',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request('&crmPeriod=invalid',{'x-test-denied':'1'})).status,403);
 assert.equal((await f.request('&crmPeriod=project',{},'other')).status,403);
 assert.equal(f.calls.length,0);assert.deepEqual(f.contexts,[{code:'demo-a',permission:'analytics.view'},{code:'other',permission:'analytics.view'}]);
});

test('CF29 HTTP: invalid stored project timezone returns a field error, UTC unaffected',async t=>{
 const f=await fixture(t);f.db.exec("UPDATE companies SET timezone='Invalid/Synthetic' WHERE code='demo-a'");
 const before=f.db.prepare('SELECT total_changes() n').get().n;
 const result=await f.request('&crmPeriod=project');assert.equal(result.status,400);assert.equal(result.body.code,'VALIDATION_ERROR');assert.equal(result.body.field,'timezone');assert.equal(result.headers['cache-control'],'no-store');
 assert.equal((await f.request()).status,200);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
});
