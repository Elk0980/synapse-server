'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createCompanyInformation}=require('./company-information');
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,city,timezone,phone,socials) VALUES(1,'alvi','ALVI','Иркутск','Asia/Irkutsk','+7 111','[{"type":"legacy","url":"https://example.test/old","label":"Extra"},{"type":"max","url":"https://max.ru/u/qa"}]'),(2,'avokado','Авокадо','','UTC','','[]');`);
  let time=Date.parse('2026-09-15T00:00:00Z');const options={now:()=>time};
  return {db,api:createCompanyInformation(db,options),options,advance:()=>time+=1000};
}
test('canonical CRM fields are reused; immutable revisions capture extras, actor and intentional removals',t=>{
  const f=fixture(t),first=f.api.get('alvi');assert.equal(first.revision,1);assert.equal(first.fieldStates.address.state,'unknown');
  f.advance();const next=f.api.save('alvi',{revision:first.revision,profile:{phone:'',address:'Красная 1',services:[{id:'s1',title:'Массаж',price:2000,currency:'RUB',durationMinutes:60,bookingIntervalMinutes:90}]}},7);
  assert.equal(next.revision,2);assert.equal(next.profile.phone,'');assert.equal(next.fieldStates.phone.state,'removed');assert.equal(next.fieldStates.phone.actorId,7);
  assert.equal(f.db.prepare('SELECT phone FROM companies WHERE id=1').get().phone,'');
  const extras=JSON.parse(f.db.prepare('SELECT extras FROM company_information WHERE company_id=1').get().extras);assert.ok(!Object.hasOwn(extras,'phone'));assert.ok(!Object.hasOwn(extras,'name'));
  const old=JSON.parse(f.db.prepare('SELECT profile FROM company_information_versions WHERE company_id=1 AND revision=1').get().profile);assert.equal(old.phone,'+7 111');
  assert.throws(()=>f.db.prepare("UPDATE company_information_versions SET reason='overwrite' WHERE company_id=1").run(),/Immutable/);
  assert.throws(()=>f.db.prepare('DELETE FROM company_information_versions WHERE company_id=1').run(),/Immutable/);
  assert.deepEqual(next.profile.socials,first.profile.socials);assert.equal(next.profile.services[0].bookingIntervalMinutes,90);
  const restored=createCompanyInformation(f.db,f.options).get('alvi');assert.equal(restored.revision,2);assert.equal(restored.profile.phone,'');
  assert.equal(restored.fieldStates.phone.state,'removed');assert.equal(restored.checks.length,0);
});
test('stale owner writes fail atomically and legacy CRM edits create a new revision without losing extras',t=>{
  const f=fixture(t),first=f.api.get('alvi');const saved=f.api.save('alvi',{revision:first.revision,profile:{description:'Owner text'}});
  f.db.prepare("UPDATE companies SET phone='+7 222' WHERE id=1").run();
  assert.throws(()=>f.api.save('alvi',{revision:saved.revision,profile:{phone:'+7 stale',description:'stale'}}),e=>e.status===409&&e.details.code==='REVISION_CONFLICT');
  const now=f.api.get('alvi');assert.equal(now.profile.phone,'+7 222');assert.equal(now.profile.description,'Owner text');assert.equal(now.revision,3);
  assert.equal(f.api.get('avokado').profile.phone,'');
  assert.throws(()=>f.api.get('../alvi'),e=>e.status===400);assert.throws(()=>f.api.get('missing'),e=>e.status===404);
  f.db.prepare('UPDATE companies SET is_deleted=1 WHERE id=1').run();assert.throws(()=>f.api.get('alvi'),e=>e.status===404);
});
test('profile validation rejects unsafe URLs, malformed facts and ambiguous versions before mutation',t=>{
  const f=fixture(t),before=f.api.get('alvi');
  for(const profile of [{name:''},{websiteUrl:'javascript:alert(1)'},{timezone:'Not/AZone'},
    {services:[{id:'same',title:'A'},{id:'same',title:'B'}]},
    {services:[{id:'s',title:'A',price:-1}]},
    {promotions:[{id:'p',title:'A',startsAt:'2026-09-15T00:00:00Z',endsAt:'2026-09-14T00:00:00Z'}]},
    {materials:[{id:'m',title:'A',url:'data:text/html,no'}]}, {unexpected:'x'}]){
    assert.throws(()=>f.api.save('alvi',{revision:before.revision,profile}),e=>e.status===400);
  }
  assert.throws(()=>f.api.save('alvi',{revision:'1',profile:{phone:'bad'}}),e=>e.status===400);
  assert.equal(f.api.get('alvi').revision,before.revision);assert.equal(f.api.get('alvi').profile.phone,'+7 111');
});
test('external observations remain separate from canonical facts, persist and become stale after owner changes',async t=>{
  const f=fixture(t);let finish,started;const start=new Promise(resolve=>started=resolve);
  const api=createCompanyInformation(f.db,{...f.options,check:async()=>{started();return new Promise(resolve=>finish=resolve);}});
  const current=api.get('alvi'),job=api.check('alvi');await start;
  api.save('alvi',{revision:current.revision,profile:{phone:'+7 owner changed'}});
  finish({checks:[{platformId:'website',status:'differences',fields:[{field:'phone',observed:'+7 external',expected:current.profile.phone}]}]});
  const result=await job;assert.equal(result.profile.phone,'+7 owner changed');assert.equal(result.checks[0].status,'needs_review');
  assert.equal(createCompanyInformation(f.db,f.options).get('alvi').checks[0].fields[0].observed,'+7 external');
  assert.equal(api.get('avokado').checks.length,0);
});

test('real CRM API requires trusted identity, scopes editors and persists company information and drafts across server restart',async t=>{
  const http=require('node:http'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
  const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomBytes}=require('node:crypto');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'company-information-api-')),database=path.join(directory,'crm.sqlite'),key=randomBytes(24).toString('hex');
  const probe=http.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  let child;
  async function stop(){if(child&&child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill();await exit;}}
  t.after(async()=>{await stop();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});});
  async function start(){
    let output='';
    child=spawn(process.execPath,[path.join(__dirname,'server.js')],{env:{...process.env,PORT:String(port),DATABASE_PATH:database,API_KEY:key,
      LEADS_SMTP_HOST:'',LEADS_SMTP_USER:'',LEADS_SMTP_PASSWORD:'',LEADS_NOTIFY_EMAIL:'',LEADS_NOTIFY_EMAIL_ALVI:'',LEADS_NOTIFY_EMAIL_AVOKADO:''},stdio:['ignore','pipe','ignore'],windowsHide:true});
    child.stdout.on('data',chunk=>output+=chunk);
    for(let attempt=0;attempt<100&&!output.includes('слушает');attempt++){if(child.exitCode!==null)throw Error('Fixture CRM failed to start');await new Promise(resolve=>setTimeout(resolve,25));}
    assert.match(output,/слушает/);
  }
  const encode=identity=>Buffer.from(JSON.stringify({v:1,userId:1,permissions:[],companyCodes:[],...identity})).toString('base64url');
  const owner=encode({role:'owner'}),viewer=encode({role:'editor',permissions:['company-information.view','autoposting.view'],companyCodes:['qa']}),
    editor=encode({role:'editor',permissions:['company-information.view','company-information.edit','autoposting.view','autoposting.edit'],companyCodes:['qa']}),
    legacy=encode({permissions:['company-information.view'],companyCodes:['qa']});
  async function request(method,url,body,identity=owner,authenticated=true){
    const response=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{...(authenticated?{'x-api-key':key}:{}),...(identity?{'x-synapse-crm-identity':identity}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
    return {status:response.status,body:await response.json()};
  }
  await start();
  for(const code of ['qa','other'])assert.equal((await request('POST','/companies',{code,name:code,timezone:'UTC'})).status,201);
  const routes=['/company-information','/autoposting/settings','/autoposting/posts'];
  for(const route of routes){
    assert.equal((await request('GET',route+'?companyCode=qa',null,owner,false)).status,401);
    assert.equal((await request('GET',route+'?companyCode=qa',null,null)).status,403);
    assert.equal((await request('GET',route+'?companyCode=other',null,viewer)).status,403);
    assert.equal((await request('GET',route+'?companyCode=qa',null,viewer)).status,200);
  }
  assert.equal((await request('GET','/company-information?companyCode=qa',null,legacy)).status,200,'v1 identity without role remains compatible');
  assert.equal((await request('GET','/company-information?companyCode=qa',null,encode({role:'admin'}))).status,403);
  assert.equal((await request('GET','/company-information')).status,400);
  const initial=(await request('GET','/company-information?companyCode=qa')).body;
  assert.equal((await request('PUT','/company-information?companyCode=qa',{revision:initial.revision,profile:{description:'denied'}},viewer)).status,403);
  const saved=await request('PUT','/company-information?companyCode=qa',{revision:initial.revision,profile:{description:'Owner facts',phone:''}},editor);
  assert.equal(saved.status,200);assert.equal(saved.body.fieldStates.phone.state,'removed');
  assert.equal((await request('PUT','/company-information?companyCode=qa',{revision:initial.revision,profile:{description:'stale'}},editor)).status,409);
  const post=await request('POST','/autoposting/posts?companyCode=qa',{title:'QA',text:'Draft only',platformIds:[],mediaUrls:[],timezone:'UTC',profileRevision:saved.body.revision},editor);
  assert.equal(post.status,201);assert.equal(post.body.status,'draft');
  assert.equal((await request('GET',`/autoposting/posts/${post.body.id}?companyCode=other`)).status,404);
  assert.equal((await request('PATCH',`/autoposting/posts/${post.body.id}?companyCode=qa`,{revision:post.body.revision,text:'denied'},viewer)).status,403);
  assert.equal((await request('POST',`/autoposting/posts/${post.body.id}/schedule?companyCode=qa`,{revision:post.body.revision},viewer)).status,403);
  assert.equal((await request('POST','/autoposting/settings/telegram/check?companyCode=qa',{},viewer)).status,403);
  const settings=await request('PUT','/autoposting/settings?companyCode=qa',{channels:[{id:'telegram',name:'QA',target:'@fixture_qa',enabled:false,revision:0,token:'123456:ABCDEFGHIJKLMNOPQRSTUVWX'}]},editor);
  assert.equal(settings.status,200);assert.doesNotMatch(JSON.stringify(settings.body),/ABCDEFGHIJKLMNOPQRSTUVWX/);
  assert.equal((await request('POST','/company-information/check?companyCode=qa',{},viewer)).status,403);
  const checked=await request('POST','/company-information/check?companyCode=qa',{},editor);assert.equal(checked.status,200);assert.deepEqual(checked.body.checks,[],'no external links means no external network');
  await stop();await start();
  const restored=(await request('GET','/company-information?companyCode=qa')).body;assert.equal(restored.profile.description,'Owner facts');assert.equal(restored.revision,saved.body.revision);
  assert.equal((await request('GET',`/autoposting/posts/${post.body.id}?companyCode=qa`)).body.status,'draft');
  assert.equal((await request('GET','/autoposting/settings?companyCode=qa')).body.channels.find(c=>c.id==='telegram').tokenConfigured,true);
});
