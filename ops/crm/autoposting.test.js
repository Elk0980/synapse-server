'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createCompanyInformation}=require('./company-information');
const {createAutoposting,LEASE_MS}=require('./autoposting');
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
    INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'alvi','ALVI','Asia/Irkutsk','[]'),(2,'avokado','Авокадо','UTC','[]');`);
  let time=Date.parse('2026-09-15T00:00:00Z'),send=async()=>({externalId:'qa-1',url:'https://example.test/post'});
  const calls=[],channels=[{id:'telegram',enabled:true,connected:true,revision:1},{id:'vk',enabled:true,connected:true,revision:1}];
  const information=createCompanyInformation(db,{now:()=>time});
  const transport={getSettings:()=>({channels:structuredClone(channels)}),publish:async input=>{calls.push(input);return send(input);}};
  const options={information,transport,now:()=>time,logger:{warn(){}}},api=createAutoposting(db,options);
  const draft=(platformIds=['telegram'],code='alvi')=>api.create(code,{title:'Тест',text:'Подтверждённый текст',mediaUrls:[],platformIds,scheduledAt:new Date(time+60000).toISOString(),timezone:'Asia/Irkutsk',profileRevision:information.get(code).revision},7);
  const schedule=p=>api.schedule(p.id,p.companyCode,{revision:p.revision});
  return {db,information,api,options,transport,channels,calls,draft,schedule,setSend:value=>send=value,advance:ms=>time+=ms};
}
test('drafts never publish; scheduled posts survive recreation, respect UTC and publish once per selected channel',async t=>{
  const f=fixture(t),p=f.draft(['telegram','vk']);await f.api.drain();assert.equal(f.calls.length,0);
  const scheduled=await f.schedule(p);assert.equal(scheduled.status,'scheduled');await f.api.drain();assert.equal(f.calls.length,0);
  f.advance(60000);const worker=createAutoposting(f.db,f.options);await worker.drain();await worker.drain();
  assert.equal(f.calls.length,2);assert.equal(new Set(f.calls.map(c=>c.post.idempotencyKey)).size,2);
  assert.ok(f.calls.every(c=>c.companyCode==='alvi'&&c.post.text===p.text));
  const result=f.api.get(p.id,'alvi');assert.equal(result.status,'published');assert.ok(result.deliveries.every(d=>d.status==='published'));
  assert.equal(f.api.list('avokado').posts.length,0);assert.throws(()=>f.api.get(p.id,'avokado'),e=>e.status===404);
});
test('editing canonical CRM data suspends scheduled posts and stale revisions never overwrite a newer draft',async t=>{
  const f=fixture(t),p=f.draft();await f.schedule(p);f.db.prepare("UPDATE companies SET phone='+7 changed' WHERE id=1").run();f.advance(60000);
  await f.api.drain();assert.equal(f.calls.length,0);const stopped=f.api.get(p.id,'alvi');assert.equal(stopped.status,'needs_review');assert.equal(stopped.lastErrorCode,'PROFILE_CHANGED');
  assert.throws(()=>f.api.update(p.id,'alvi',{revision:p.revision,text:'stale'}),e=>e.status===409);
  assert.throws(()=>f.api.update(p.id,'alvi',{revision:stopped.revision,text:'old facts'}),e=>e.details.code==='PROFILE_CHANGED');
  const revised=f.api.update(p.id,'alvi',{revision:stopped.revision,text:'Reviewed text',profileRevision:f.information.get('alvi').revision,scheduledAt:'2026-09-15T00:03:00Z'});
  assert.equal(revised.status,'draft');await f.schedule(revised);f.advance(120000);await f.api.drain();assert.equal(f.calls[0].post.text,'Reviewed text');
});
test('changed channel settings suspend the frozen plan before publication',async t=>{
  const f=fixture(t),p=f.draft();await f.schedule(p);f.channels[0].revision++;f.advance(60000);await f.api.drain();
  assert.equal(f.calls.length,0);assert.equal(f.api.get(p.id,'alvi').lastErrorCode,'CHANNEL_CHANGED');
});
test('multiple workers cannot publish the same lease and cancellation during publishing preserves the actual first result',async t=>{
  const f=fixture(t),p=f.draft(['telegram','vk']);await f.schedule(p);f.advance(60000);
  let finish,started;const start=new Promise(resolve=>started=resolve);f.setSend(()=>{started();return new Promise(resolve=>finish=resolve);});
  const job=f.api.drain();await start;await createAutoposting(f.db,f.options).drain();assert.equal(f.calls.length,1);
  const current=f.api.get(p.id,'alvi');f.api.cancel(p.id,'alvi',{revision:current.revision});finish({externalId:'already-published'});await job;
  const result=f.api.get(p.id,'alvi');assert.equal(result.status,'cancelled');assert.equal(result.deliveries[0].status,'published');assert.equal(result.deliveries[1].status,'cancelled');assert.equal(f.calls.length,1);
});
test('ambiguous network failures never retry automatically or on reschedule and never claim success',async t=>{
  const f=fixture(t),p=f.draft();await f.schedule(p);f.advance(60000);f.setSend(async()=>{throw Error('PRIVATE token network reset');});await f.api.drain();
  let result=f.api.get(p.id,'alvi');assert.equal(result.status,'needs_review');assert.equal(result.lastErrorCode,'PUBLICATION_UNCERTAIN');assert.doesNotMatch(JSON.stringify(result),/PRIVATE|token network/);
  f.advance(LEASE_MS*2);await createAutoposting(f.db,f.options).drain();assert.equal(f.calls.length,1);
  await assert.rejects(f.api.schedule(p.id,'alvi',{revision:result.revision,scheduledAt:'2026-09-16T00:00:00Z'}),e=>e.details.code==='PUBLICATION_REVIEW_REQUIRED');
  assert.throws(()=>f.api.update(p.id,'alvi',{revision:result.revision,text:'try again'}),e=>e.details.code==='PUBLICATION_REVIEW_REQUIRED');
});
test('expired in-flight records become review-needed after restart and are not resent',async t=>{
  const f=fixture(t),p=f.draft();await f.schedule(p);
  f.db.prepare("UPDATE autoposting_posts SET status='publishing',publishing_at=0 WHERE id=?").run(p.id);
  f.db.prepare("UPDATE autoposting_deliveries SET status='publishing',started_at=0 WHERE post_id=?").run(p.id);
  await createAutoposting(f.db,f.options).drain();assert.equal(f.calls.length,0);assert.equal(f.api.get(p.id,'alvi').status,'needs_review');
});
test('profile change during a prior channel publish prevents sending stale content to remaining channels',async t=>{
  const f=fixture(t),p=f.draft(['telegram','vk']);await f.schedule(p);f.advance(60000);
  f.setSend(async()=>{const current=f.information.get('alvi');f.information.save('alvi',{revision:current.revision,profile:{description:'New owner facts'}});return {externalId:'first-published'};});
  await f.api.drain();assert.equal(f.calls.length,1);assert.equal(f.api.get(p.id,'alvi').status,'needs_review');assert.equal(f.api.get(p.id,'alvi').deliveries[0].status,'published');
});
test('definite provider refusal is failed without automatic retry; invalid plans fail before queueing',async t=>{
  const f=fixture(t),p=f.draft();
  await assert.rejects(f.api.schedule(p.id,'alvi',{revision:p.revision,scheduledAt:'2020-01-01T00:00:00Z'}),e=>e.status===400);
  f.channels[0].connected=false;await assert.rejects(f.schedule(p),e=>e.details.code==='CHANNEL_NOT_CONNECTED');f.channels[0].connected=true;
  await f.schedule(p);f.advance(60000);f.setSend(async()=>{throw Object.assign(Error('refused'),{ambiguous:false});});await f.api.drain();
  assert.equal(f.api.get(p.id,'alvi').status,'failed');await f.api.drain();assert.equal(f.calls.length,1);
  assert.throws(()=>f.api.create('alvi',{mediaUrls:['javascript:bad']}),e=>e.status===400);
});
test('partial publication followed by a definite failure cannot be edited or rescheduled into a duplicate',async t=>{
  const f=fixture(t),p=f.draft(['telegram','vk']);await f.schedule(p);f.advance(60000);let attempt=0;
  f.setSend(async()=>{if(++attempt===1)return {externalId:'first-accepted'};throw Object.assign(Error('definite refusal'),{ambiguous:false});});
  await f.api.drain();const result=f.api.get(p.id,'alvi');
  assert.equal(result.status,'failed');assert.deepEqual(result.deliveries.map(d=>d.status),['published','failed']);
  await assert.rejects(f.api.schedule(p.id,'alvi',{revision:result.revision,scheduledAt:'2026-09-16T00:00:00Z'}),e=>e.details.code==='PUBLICATION_REVIEW_REQUIRED');
  assert.throws(()=>f.api.update(p.id,'alvi',{revision:result.revision,text:'Attempt to resend'}),e=>e.details.code==='PUBLICATION_REVIEW_REQUIRED');
  f.advance(LEASE_MS*2);await createAutoposting(f.db,f.options).drain();assert.equal(f.calls.length,2);
});
test('changing the second channel while the first publication is in flight preserves the first result and stops the remainder',async t=>{
  const f=fixture(t),p=f.draft(['telegram','vk']);await f.schedule(p);f.advance(60000);
  let finish,entered;const started=new Promise(resolve=>entered=resolve);
  f.setSend(()=>{entered();return new Promise(resolve=>finish=resolve);});
  const job=f.api.drain();await started;f.channels[1].revision++;finish({externalId:'already-accepted'});await job;
  const result=f.api.get(p.id,'alvi');assert.equal(f.calls.length,1);assert.equal(result.status,'needs_review');assert.equal(result.lastErrorCode,'CHANNEL_CHANGED');
  assert.deepEqual(result.deliveries.map(d=>d.status),['published','pending']);
  await createAutoposting(f.db,f.options).drain();assert.equal(f.calls.length,1);
});
for(const action of ['cancel','profile','stop'])test(`${action} during awaited channel settings prevents publication after the await`,async t=>{
  const f=fixture(t),p=f.draft();await f.schedule(p);f.advance(60000);
  let settingsCalls=0,release,entered;const waiting=new Promise(resolve=>entered=resolve);
  f.transport.getSettings=()=>{
    const snapshot={channels:structuredClone(f.channels)};
    if(++settingsCalls===2){entered();return new Promise(resolve=>release=()=>resolve(snapshot));}
    return snapshot;
  };
  const job=f.api.drain();await waiting;let stopping;
  if(action==='cancel'){const row=f.api.get(p.id,'alvi');f.api.cancel(p.id,'alvi',{revision:row.revision});}
  if(action==='profile'){const current=f.information.get('alvi');f.information.save('alvi',{revision:current.revision,profile:{description:'Changed while waiting'}});}
  if(action==='stop')stopping=f.api.stop();
  release();await job;if(stopping)await stopping;
  assert.equal(f.calls.length,0);const result=f.api.get(p.id,'alvi');
  if(action==='cancel'){assert.equal(result.status,'cancelled');assert.equal(result.deliveries[0].status,'cancelled');}
  if(action==='profile'){assert.equal(result.status,'needs_review');assert.equal(result.lastErrorCode,'PROFILE_CHANGED');}
  if(action==='stop'){
    f.advance(LEASE_MS+1);await createAutoposting(f.db,f.options).drain();assert.equal(f.calls.length,0);
    assert.equal(f.api.get(p.id,'alvi').status,'needs_review');
  }
});

test('Onlypult accepted job survives restart, reconciles by GET only and never appears published without a social link',async t=>{
 const f=fixture(t),p=f.draft(['telegram','vk']);let checks=0;
 f.setSend(async({channelId})=>channelId==='telegram'?{externalId:'tg-1',status:'published',url:'https://t.me/example/1'}:
  {provider:'onlypult',providerPostId:'op-job-1',providerStatus:'scheduled',status:'needs_review',errorCode:'PROVIDER_PENDING'});
 f.transport.reconcile=async input=>{checks++;assert.equal(input.providerPostId,'op-job-1');assert.equal(input.channelId,'vk');assert.equal(input.channelRevision,1);
  return {provider:'onlypult',providerPostId:'op-job-1',providerStatus:'published',status:'needs_review',errorCode:'PROVIDER_LINK_UNAVAILABLE'};};
 await f.schedule(p);f.advance(60000);await f.api.drain();let result=f.api.get(p.id,'alvi');
 assert.equal(f.calls.length,2);assert.equal(result.status,'needs_review');assert.deepEqual(result.deliveries.map(d=>d.status),['published','needs_review']);
 assert.equal(result.deliveries[1].providerPostId,'op-job-1');assert.equal(result.deliveries[1].externalId,null);assert.equal(result.deliveries[1].url,null);
 await f.api.drain();assert.equal(checks,0);f.advance(60000);await createAutoposting(f.db,f.options).drain();
 result=f.api.get(p.id,'alvi');assert.equal(checks,1);assert.equal(f.calls.length,2);assert.equal(result.status,'needs_review');
 assert.equal(result.deliveries[1].providerStatus,'published');assert.equal(result.lastErrorCode,'PROVIDER_LINK_UNAVAILABLE');
 await assert.rejects(f.api.schedule(p.id,'alvi',{revision:result.revision,scheduledAt:'2026-09-16T00:00:00Z'}),e=>e.details.code==='PUBLICATION_REVIEW_REQUIRED');
 assert.throws(()=>f.api.update(p.id,'alvi',{revision:result.revision,text:'Resend'}),e=>e.details.code==='PUBLICATION_REVIEW_REQUIRED');
 f.advance(60000);await f.api.drain();assert.equal(checks,1,'terminal provider status does not need repeated automatic polling');
});

test('manual reconciliation is company scoped, preserves receipt on read failure, and cannot cause duplicate posts',async t=>{
 const f=fixture(t),p=f.draft();f.setSend(async()=>({provider:'onlypult',providerPostId:'job-9',providerStatus:'scheduled',status:'needs_review',errorCode:'PROVIDER_PENDING'}));
 await f.schedule(p);f.advance(60000);await f.api.drain();const result=f.api.get(p.id,'alvi');
 let checks=0;f.transport.reconcile=async()=>{checks++;throw Error('PRIVATE_PROVIDER_RESPONSE');};
 await assert.rejects(f.api.reconcile(p.id,'avokado',{revision:result.revision}),e=>e.status===404);
 await assert.rejects(f.api.reconcile(p.id,'alvi',{revision:0}),e=>e.status===409||e.status===400);
 const checked=await f.api.reconcile(p.id,'alvi',{revision:result.revision});assert.equal(checks,1);assert.equal(f.calls.length,1);
 assert.equal(checked.deliveries[0].providerPostId,'job-9');assert.equal(checked.deliveries[0].errorCode,'PROVIDER_CHECK_FAILED');
 assert.doesNotMatch(JSON.stringify(checked),/PRIVATE/);assert.equal(checked.status,'needs_review');
});

test('unspecified provider queued status must not be converted to published merely because it has an ID',async t=>{
 const f=fixture(t),p=f.draft();f.setSend(async()=>({status:'scheduled',externalId:'provider-job-not-social-post'}));
 await f.schedule(p);f.advance(60000);await f.api.drain();const result=f.api.get(p.id,'alvi');
 assert.equal(result.status,'needs_review');assert.equal(result.deliveries[0].externalId,null);
});

test('provider preflight callback rejects cancellation or canonical edits before the submission',async t=>{
 for(const action of ['cancel','profile']){
  const f=fixture(t),p=f.draft();f.setSend(async input=>{
   if(action==='cancel'){const current=f.api.get(p.id,'alvi');f.api.cancel(p.id,'alvi',{revision:current.revision});}
   else {const current=f.information.get('alvi');f.information.save('alvi',{revision:current.revision,profile:{description:'New facts'}});}
   assert.throws(input.beforePublish,e=>e.ambiguous===false);throw Object.assign(Error('Cancelled before provider POST'),{ambiguous:false});
  });await f.schedule(p);f.advance(60000);await f.api.drain();assert.notEqual(f.api.get(p.id,'alvi').status,'published');
 }
});
