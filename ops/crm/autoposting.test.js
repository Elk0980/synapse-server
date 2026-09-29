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

test('очередь контента: карточка дня с подписями пяти площадок, версия и одобрение именно этой версии; правка снимает одобрение; неготовое не одобряется и не планируется',async t=>{
  const f=fixture(t);
  const base={title:'Д1 — Атмосфера утра',text:'Утро',mediaUrls:[],platformIds:['telegram'],dayKey:'D1',origin:'gemini-video',
    captions:{instagram:'Утро в Таиланде',tiktok:'Утро',youtube_shorts:'Утро на побережье',vk:'Утро в Таиланде.',telegram:'Утро'},
    scheduledAt:new Date(Date.parse('2026-09-15T00:00:00Z')+3600000).toISOString(),timezone:'Asia/Irkutsk',profileRevision:f.information.get('alvi').revision};
  const card=f.api.create('alvi',base,7);
  assert.equal(card.dayKey,'D1');assert.equal(card.approval.approved,false);assert.equal(card.readiness.ready,false);assert.match(card.readiness.issues[0],/Нет материала/);
  await assert.rejects(f.api.schedule(card.id,'alvi',{revision:card.revision}),e=>e.details.code==='APPROVAL_REQUIRED','неготовое и неодобренное не планируется');
  assert.throws(()=>f.api.approve(card.id,'alvi',{revision:card.revision,approved:true},{userId:1,userName:'Влад'}),e=>e.details.code==='NOT_READY');
  const withVideo=f.api.update(card.id,'alvi',{revision:card.revision,mediaUrls:['https://cdn.example.test/d1.mp4']});
  assert.equal(withVideo.readiness.ready,true);assert.equal(withVideo.readiness.mediaKind,'video');
  await assert.rejects(f.api.schedule(withVideo.id,'alvi',{revision:withVideo.revision}),e=>e.details.code==='APPROVAL_REQUIRED');
  assert.throws(()=>f.api.approve(withVideo.id,'avokado',{revision:withVideo.revision,approved:true}),e=>e.status===404,'чужая компания не одобряет');
  assert.throws(()=>f.api.approve(withVideo.id,'alvi',{revision:withVideo.revision-1,approved:true}),e=>e.details.code==='REVISION_CONFLICT');
  const approved=f.api.approve(withVideo.id,'alvi',{revision:withVideo.revision,approved:true},{userId:1,userName:'Влад'});
  assert.equal(approved.approval.approved,true);assert.equal(approved.approval.approvedRevision,withVideo.contentRevision);assert.equal(approved.approval.approvedByName,'Влад');
  assert.equal(approved.status,'draft','одобрение не планирует и не публикует');await f.api.drain();assert.equal(f.calls.length,0);
  const edited=f.api.update(approved.id,'alvi',{revision:approved.revision,captions:{...base.captions,telegram:'Утро (правка)'}});
  assert.equal(edited.approval.approved,false);assert.equal(edited.approval.stale,true,'изменение текста снимает одобрение');
  assert.throws(()=>f.api.update(edited.id,'alvi',{revision:edited.revision,captions:{telegram:'x'.repeat(1025)}}),e=>e.status===400);
  assert.throws(()=>f.api.update(edited.id,'alvi',{revision:edited.revision,captions:{facebook:'нет'}}),e=>e.status===400);
  assert.throws(()=>f.api.update(edited.id,'alvi',{revision:edited.revision,dayKey:'D9'}),e=>e.status===400);
  const unapproved=f.api.approve(edited.id,'alvi',{revision:edited.revision,approved:false});assert.equal(unapproved.approval.approvedRevision,null);
  const again=f.api.approve(unapproved.id,'alvi',{revision:unapproved.revision,approved:true},{userId:1,userName:'Влад'});
  const planned=await f.api.schedule(again.id,'alvi',{revision:again.revision});
  assert.equal(planned.status,'scheduled','одобренная версия ставится в план; отправка — только по расписанию и только в подключённые каналы');
  await f.api.drain();assert.equal(f.calls.length,0,'до времени публикации ничего не отправлено');
});
test('импорт пакета создаёт только черновики без одобрения, не выдумывает медиа и не дублирует карточки при повторе',async t=>{
  const f=fixture(t);
  const items=[{dayKey:'D1',title:'Д1',captions:{telegram:'Один'},mediaUrls:['https://cdn.example.test/d1.mp4']},{dayKey:'D2',title:'Д2',captions:{vk:'Два'}},{dayKey:'D3',title:'Д3',text:'Три'}];
  const first=f.api.importPackage('alvi',{items},7);
  assert.equal(first.created.length,3);assert.ok(first.created.every(c=>c.status==='draft'&&c.approval.approved===false&&c.origin==='import'));
  assert.equal(first.created[0].readiness.ready,true);assert.equal(first.created[1].readiness.ready,false);
  const repeat=f.api.importPackage('alvi',{items},7);assert.equal(repeat.created.length,0);assert.equal(repeat.skipped.length,3);
  assert.equal(f.api.list('alvi').posts.length,3);assert.equal(f.api.list('avokado').posts.length,0);
  assert.throws(()=>f.api.importPackage('alvi',{items:[{dayKey:'D1',captions:{}}]}),e=>e.status===400,'без названия');
  assert.throws(()=>f.api.importPackage('alvi',{items:[{title:'x',mediaUrls:['ftp://bad']}]}),e=>e.status===400,'ссылка не HTTP(S)');
  await f.api.drain();assert.equal(f.calls.length,0,'импорт ничего не публикует');
});
test('импорт пакета schemaVersion 1 (синтетический пакет той же схемы, что у владельца): день числом, подписи-объекты, YouTube title+text, хеш ролика из пакета; companyCode пакета не выбирает компанию; хеш загруженного файла сверяется',async t=>{
  const f=fixture(t);
  const pkg=JSON.parse(require('node:fs').readFileSync(__dirname+'/fixtures-content-package.json','utf8'));
  assert.equal(pkg.companyCode,null);assert.equal(pkg.items[0].approval.approved,false);
  const result=f.api.importPackage('alvi',pkg,7);
  assert.equal(result.created.length,2);assert.equal(result.mediaPending.length,2,'публичных URL нет — карточки ждут загрузки видео');
  assert.equal(result.mediaPending[0].file,'media/day1-final.mp4');assert.equal(result.mediaPending[0].sha256,pkg.items[0].media.sha256);
  const d1=result.created[0];
  assert.equal(d1.dayKey,'D1');assert.equal(d1.title,'День первый');assert.equal(d1.externalId,'fixture-day1-v1');assert.match(d1.origin,/Synthetic fixture/);
  assert.equal(d1.captions.instagram,pkg.items[0].captions.instagram.text);assert.equal(d1.captions.youtube_shorts,'Заголовок YouTube, день первый\n\nОписание YouTube, день первый.');
  assert.deepEqual(Object.keys(d1.captions).sort(),['instagram','telegram','tiktok','vk','youtube_shorts']);
  assert.equal(d1.approval.approved,false,'одобрение из пакета не переносится');assert.equal(d1.status,'draft');assert.equal(d1.readiness.ready,false);
  assert.equal(f.api.importPackage('alvi',pkg,7).created.length,0,'повтор по externalId не создаёт дублей');
  assert.throws(()=>f.api.importPackage('alvi',{...pkg,companyCode:'avokado'}),e=>e.details.code==='COMPANY_MISMATCH');
  assert.throws(()=>f.api.approve(d1.id,'alvi',{revision:d1.revision,approved:true},{userId:1}),e=>e.details.code==='NOT_READY');
  // загрузили не тот файл: хеш отличается
  const wrong=f.api.update(d1.id,'alvi',{revision:d1.revision,mediaUrls:['https://synapse.synapsebusiness.ru/content/publishing-assets/alvi/'+'a'.repeat(32)+'.mp4'],mediaSha256:'b'.repeat(64)});
  assert.equal(wrong.readiness.ready,false);assert.match(wrong.readiness.issues[0],/не совпадает/);
  // ссылка без хеша — не сверено, не готово
  const unchecked=f.api.update(wrong.id,'alvi',{revision:wrong.revision,mediaUrls:['https://cdn.example.test/other.mp4']});
  assert.equal(unchecked.mediaSha256,'');assert.match(unchecked.readiness.issues[0],/не сверен/);
  // тот самый ролик: хеш совпал — готов к одобрению, но не опубликован
  const right=f.api.update(unchecked.id,'alvi',{revision:unchecked.revision,mediaUrls:['https://synapse.synapsebusiness.ru/content/publishing-assets/alvi/'+'c'.repeat(32)+'.mp4'],mediaSha256:pkg.items[0].media.sha256});
  assert.equal(right.readiness.ready,true);assert.equal(right.readiness.mediaKind,'video');
  const ok=f.api.approve(right.id,'alvi',{revision:right.revision,approved:true},{userId:1,userName:'Влад'});assert.equal(ok.approval.approved,true);
  await f.api.drain();assert.equal(f.calls.length,0);
  // правка подписи снимает одобрение, хеш при неизменных ссылках сохраняется
  const edited=f.api.update(ok.id,'alvi',{revision:ok.revision,captions:{...ok.captions,tiktok:'Правка'}});
  assert.equal(edited.approval.approved,false);assert.equal(edited.mediaSha256,pkg.items[0].media.sha256);
});

test('одобрение переживает технические переходы (план), а отзыв останавливает ещё не начатую отправку: approve→schedule→revoke→drain = 0 отправок; отзыв между каналами прерывает остальные',async t=>{
  const f=fixture(t);let clock=Date.parse('2026-09-15T00:00:00Z');const advance=ms=>{clock+=ms;f.advance(ms);};
  const make=()=>f.api.create('alvi',{title:'Д1',text:'Утро',mediaUrls:['https://cdn.example.test/d1.mp4'],platformIds:['telegram','vk'],dayKey:'D1',captions:{telegram:'ТГ',vk:'ВК'},
    scheduledAt:new Date(clock+60000).toISOString(),timezone:'Asia/Irkutsk',profileRevision:f.information.get('alvi').revision},7);
  let card=make();
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true},{userId:1,userName:'Влад'});
  const planned=await f.api.schedule(card.id,'alvi',{revision:card.revision});
  assert.equal(planned.status,'scheduled');assert.equal(planned.approval.approved,true,'постановка в план не снимает одобрение');assert.equal(planned.contentRevision,card.contentRevision);
  const revoked=f.api.approve(planned.id,'alvi',{revision:planned.revision,approved:false},{userId:1});
  assert.equal(revoked.approval.approved,false);assert.equal(revoked.status,'draft');assert.equal(revoked.lastErrorCode,'APPROVAL_REVOKED');assert.ok(revoked.deliveries.every(d=>d.status==='cancelled'));
  advance(60000);await f.api.drain();await f.api.drain();assert.equal(f.calls.length,0,'отозванное не уходит');
  // прямая порча: одобрение снято в базе после планирования (например, из другого процесса) — обработчик проверяет перед захватом
  let again=make();again=f.api.approve(again.id,'alvi',{revision:again.revision,approved:true},{userId:1});again=await f.api.schedule(again.id,'alvi',{revision:again.revision});
  f.db.prepare('UPDATE autoposting_posts SET approved_revision=NULL WHERE id=?').run(again.id);
  advance(60000);await f.api.drain();assert.equal(f.calls.length,0);assert.equal(f.api.get(again.id,'alvi').status,'needs_review');assert.equal(f.api.get(again.id,'alvi').lastErrorCode,'APPROVAL_REVOKED');
  // отзыв между каналами: первый канал отправлен, второй — нет
  let third=make();third=f.api.approve(third.id,'alvi',{revision:third.revision,approved:true},{userId:1});third=await f.api.schedule(third.id,'alvi',{revision:third.revision});
  f.setSend(async input=>{f.db.prepare('UPDATE autoposting_posts SET approved_revision=NULL WHERE id=?').run(third.id);return {externalId:'first-'+input.channelId,url:'https://example.test/p'};});
  advance(60000);await f.api.drain();await f.api.drain();
  assert.equal(f.calls.length,1,'после отзыва второй канал не отправлен');assert.equal(f.calls[0].post.text,'ТГ','подпись площадки заменяет общий текст');
  const result=f.api.get(third.id,'alvi');assert.equal(result.status,'needs_review');assert.deepEqual(result.deliveries.map(d=>d.status).sort(),['cancelled','published']);
});

test('контент-план: метаданные не попадают в подпись; правка возвращает на согласование; отклонение требует комментарий и пишет автора/время/историю; смена плановой даты не активирует отправку и не снимает согласование',async t=>{
  const f=fixture(t);const owner={userId:1,userName:'Влад'},editor={userId:2,userName:'Редактор'};
  const start=Date.parse('2026-09-15T00:00:00Z');
  let card=f.api.create('alvi',{title:'Д1',text:'Утро',mediaUrls:['https://cdn.example.test/d1.mp4'],platformIds:['telegram'],dayKey:'D1',captions:{telegram:'ТГ'},
    format:'reel',role:'reach',audience:'Люди, мечтающие о Таиланде',hook:'Море в первые 3 секунды',idea:'Атмосфера утра',hughNote:'Тихий хук без обещаний может удержать',metrics:'Удержание, репосты',methodSource:'Курс «Аудитория через короткий контент» (гипотеза автора)',
    scheduledAt:new Date(start+3600000).toISOString(),timezone:'Asia/Irkutsk',profileRevision:f.information.get('alvi').revision},7);
  assert.equal(card.meta.format,'reel');assert.equal(card.meta.role,'reach');assert.equal(card.review.state,'draft');
  assert.throws(()=>f.api.create('alvi',{title:'x',format:'poem',profileRevision:f.information.get('alvi').revision}),e=>e.status===400);
  assert.throws(()=>f.api.create('alvi',{title:'x',role:'viral',profileRevision:f.information.get('alvi').revision}),e=>e.status===400);
  // отправить на согласование → согласовать
  card=f.api.submitReview(card.id,'alvi',{revision:card.revision},editor);assert.equal(card.review.state,'pending');
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true},owner);assert.equal(card.review.state,'approved');assert.equal(card.approval.approved,true);
  // смена плановой даты/пояса: согласование сохраняется, отправка не активируется
  card=f.api.update(card.id,'alvi',{revision:card.revision,scheduledAt:new Date(start+7200000).toISOString(),timezone:'Asia/Bangkok'},editor);
  assert.equal(card.approval.approved,true);assert.equal(card.review.state,'approved');assert.equal(card.status,'draft');assert.equal(card.timezone,'Asia/Bangkok');
  assert.equal(card.history[0].action,'rescheduled');assert.equal(card.history[0].actorName,'Редактор');
  f.advance(7200000);await f.api.drain();assert.equal(f.calls.length,0,'плановая дата без явной постановки в план ничего не отправляет');
  // правка подписи → снова на согласовании, одобрение снято
  card=f.api.update(card.id,'alvi',{revision:card.revision,captions:{telegram:'ТГ v2'}},editor);
  assert.equal(card.review.state,'pending');assert.equal(card.approval.approved,false);assert.equal(card.history[0].action,'edited');
  // правка метаданных — тоже содержимое (новая версия), но в подпись не попадает
  card=f.api.update(card.id,'alvi',{revision:card.revision,hook:'<script>alert(1)</script> новый хук'},editor);
  assert.equal(card.meta.hook,'<script>alert(1)</script> новый хук','хранится как текст, экранирует интерфейс');
  assert.ok(!JSON.stringify(card.captions).includes('хук')&&!card.text.includes('хук'),'метаданные не в подписи');
  // отклонение: без комментария нельзя; с комментарием — автор, время, история; чужая компания — 404
  assert.throws(()=>f.api.reject(card.id,'alvi',{revision:card.revision,comment:'   '},owner),e=>e.status===400);
  assert.throws(()=>f.api.reject(card.id,'avokado',{revision:card.revision,comment:'нет'},owner),e=>e.status===404);
  card=f.api.reject(card.id,'alvi',{revision:card.revision,comment:'Хук слишком прямой <b>'},owner);
  assert.equal(card.review.state,'rejected');assert.equal(card.review.comment,'Хук слишком прямой <b>');assert.equal(card.review.byName,'Влад');assert.ok(card.review.at);
  assert.deepEqual(card.history.slice(0,1).map(h=>[h.action,h.actorName,h.comment]),[['rejected','Влад','Хук слишком прямой <b>']]);
  assert.throws(()=>f.api.reject(card.id,'alvi',{revision:card.revision-1,comment:'старая'},owner),e=>e.details.code==='REVISION_CONFLICT');
  // после правки — снова на согласовании, комментарий отклонения очищен, но остался в истории
  card=f.api.update(card.id,'alvi',{revision:card.revision,captions:{telegram:'ТГ v3'}},editor);
  assert.equal(card.review.state,'pending');assert.equal(card.review.comment,'');assert.ok(card.history.some(h=>h.action==='rejected'));
  // отклонение запланированной снимает с плана
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true},owner);
  card=await f.api.schedule(card.id,'alvi',{revision:card.revision,scheduledAt:new Date(start+7200000+60000).toISOString()});assert.equal(card.status,'scheduled');
  card=f.api.reject(card.id,'alvi',{revision:card.revision,comment:'Отложим'},owner);assert.equal(card.status,'draft');assert.equal(card.lastErrorCode,'APPROVAL_REVOKED');
  f.advance(120000);await f.api.drain();assert.equal(f.calls.length,0);
});
test('подтверждение внешней публикации: отдельная запись владельца, ссылки проверяются, повтор идемпотентен, правка не теряет историю, отмеченная площадка не отправляется',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'},p=f.draft(['telegram','vk']);
  const receipt=(patch,code='alvi')=>f.api.recordReceipt(p.id,code,{platform:'telegram',url:'https://t.me/taisabai/512',
    publishedAt:'2026-09-14T10:00:00Z',contentRevision:p.contentRevision,...patch},owner);
  assert.throws(()=>receipt({},'avokado'),e=>e.status===404,'карточка чужой компании не подтверждается');
  // Ссылка: только https, только домен площадки, только адрес записи — без учётных данных, разметки, якорей и параметров с токеном.
  for(const url of ['http://t.me/taisabai/512','https://t.me.attacker.example/taisabai/512','https://user:pass@t.me/taisabai/512',
    'javascript:alert(1)','https://t.me/taisabai/512?token=secret','https://t.me/taisabai/512#session','https://t.me/<img src=x>/1',
    'https://t.me/taisabai','https://t.me:8443/taisabai/512','https://www.instagram.com/p/AbCdEfGhIjK',''])
    assert.throws(()=>receipt({url}),e=>e.status===400,url);
  // Значения разрешённых параметров сверяются с форматом, повтор и лишние параметры отклоняются:
  // иначе ?t=…/?z=… пронесли бы токен под видом адреса записи.
  for(const [platform,url] of [['youtube_shorts','https://www.youtube.com/shorts/abcdefghi12?t=TOKEN'],
    ['youtube_shorts','https://www.youtube.com/watch?v=abcdefghi12&t=TOKEN'],
    ['youtube_shorts','https://www.youtube.com/watch?v=abcdefghi12&v=other'],
    ['youtube_shorts','https://www.youtube.com/watch?v=<script>'],
    ['youtube_shorts','https://youtu.be/abcdefghi12'],
    ['vk','https://vk.com/wall-1_2?z=SECRET'],['vk','https://vk.com/club1?w=SECRET'],['vk','https://vk.com/club1?w=wall-1_2&z=SECRET'],
    ['vk','https://vk.com/club1'],['tiktok','https://vm.tiktok.com/ZMabcdef/'],
    ['instagram','https://www.instagram.com/p/AbCdEfGhIjK/?igsh=SESSION'],['telegram','https://t.me/taisabai/512?single=1']])
    assert.throws(()=>f.api.recordReceipt(p.id,'alvi',{platform,url,publishedAt:'2026-09-14T10:00:00Z',contentRevision:p.contentRevision},owner),
      e=>e.status===400,`${platform} ${url}`);
  assert.throws(()=>receipt({platform:'facebook'}),e=>e.status===400);
  assert.throws(()=>receipt({publishedAt:'2026-09-16T10:00:00Z'}),e=>e.details.code==='NOT_PUBLISHED_YET','запланированное не считается опубликованным');
  assert.throws(()=>receipt({contentRevision:p.contentRevision+1}),e=>e.details.code==='CONTENT_REVISION_CONFLICT');
  for(const [platform,url] of [['instagram','https://www.instagram.com/reel/AbCdEfGhIjK/'],['tiktok','https://www.tiktok.com/@taisabai/video/7412345678901234567'],
    ['youtube_shorts','https://www.youtube.com/watch?v=AbCdEfGhIjK']])
    assert.equal(f.api.recordReceipt(p.id,'alvi',{platform,url,publishedAt:'2026-09-14T10:00:00Z',contentRevision:p.contentRevision},owner).created,true,platform);
  const first=receipt({});assert.equal(first.created,true);
  const card=first.post,telegram=card.externalReceipts.find(item=>item.platform==='telegram');
  assert.equal(card.status,'draft','подтверждение не меняет статус карточки');
  assert.equal(card.approval.approved,false,'подтверждение не одобряет версию');
  assert.deepEqual(card.deliveries,[],'подтверждение не создаёт доставку');
  assert.equal(telegram.url,'https://t.me/taisabai/512');assert.equal(telegram.recordedByName,'Влад');
  assert.equal(telegram.publishedAt,'2026-09-14T10:00:00.000Z');assert.equal(telegram.stale,false);assert.ok(telegram.recordedAt);
  assert.equal(card.revision,p.revision,'подтверждение не трогает версию карточки');
  await f.api.drain();assert.equal(f.calls.length,0,'сохранение подтверждения ничего не отправляет');
  assert.equal(receipt({}).created,false,'повтор по компании+карточке+площадке+ссылке не создаёт дубль');
  assert.equal(f.api.get(p.id,'alvi').externalReceipts.length,4);
  assert.equal(receipt({url:'https://t.me/taisabai/513'}).created,true,'другая ссылка той же площадки — отдельное доказательство');
  assert.equal(f.api.list('avokado').posts.length,0);
  const before=f.api.get(p.id,'alvi');assert.equal(before.externalReceipts.length,5);
  await assert.rejects(f.api.schedule(p.id,'alvi',{revision:before.revision}),e=>e.details.code==='EXTERNAL_PUBLICATION_RECORDED');
  // Правка содержимого сохраняет доказательства, но новая версия опубликованной не считается.
  const edited=f.api.update(p.id,'alvi',{revision:before.revision,text:'Новый текст'});
  assert.equal(edited.contentRevision,before.contentRevision+1);assert.equal(edited.externalReceipts.length,5);
  assert.ok(edited.externalReceipts.every(item=>item.stale===true),'ссылки относятся к прежней версии содержимого');
  // Та же ссылка после правки — та же публикация: новой записи нет, и новая версия не выдаётся за опубликованную.
  const again=f.api.recordReceipt(p.id,'alvi',{platform:'telegram',url:'https://t.me/taisabai/512',publishedAt:'2026-09-14T10:00:00Z',contentRevision:edited.contentRevision},owner);
  assert.equal(again.created,false);assert.equal(again.post.externalReceipts.length,5);
  assert.ok(again.post.externalReceipts.every(item=>item.stale===true));
  await assert.rejects(f.api.schedule(edited.id,'alvi',{revision:edited.revision}),e=>e.details.code==='EXTERNAL_PUBLICATION_RECORDED');
  // Неотмеченная площадка планируется и отправляется как прежде.
  const onlyVk=f.api.update(edited.id,'alvi',{revision:edited.revision,platformIds:['vk']});
  const planned=await f.api.schedule(onlyVk.id,'alvi',{revision:onlyVk.revision});assert.equal(planned.status,'scheduled');
  f.advance(120000);await f.api.drain();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].channelId,'vk');
  assert.equal(f.api.get(p.id,'alvi').externalReceipts.length,5,'доставка не превращается в подтверждение и не стирает его');
});
test('подтверждение внешней публикации после постановки в план снимает уже стоящую в очереди отправку и не создаёт дубликат',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'},p=f.draft(['telegram','vk']);
  const planned=await f.schedule(p);assert.equal(planned.status,'scheduled');
  assert.deepEqual(planned.deliveries.map(d=>d.status),['pending','pending']);
  f.api.recordReceipt(p.id,'alvi',{platform:'telegram',url:'https://t.me/taisabai/900',publishedAt:'2026-09-14T10:00:00Z',contentRevision:planned.contentRevision},owner);
  f.advance(60000);await f.api.drain();await f.api.drain();
  assert.equal(f.calls.length,0,'уже отмеченная площадка не отправляется даже из очереди');
  const result=f.api.get(p.id,'alvi');
  assert.equal(result.status,'needs_review');assert.equal(result.lastErrorCode,'EXTERNAL_PUBLICATION_RECORDED');
  const telegram=result.deliveries.find(item=>item.channelId==='telegram');
  assert.equal(telegram.status,'cancelled');assert.equal(telegram.errorCode,'EXTERNAL_PUBLICATION_RECORDED');
  assert.equal(result.externalReceipts.length,1);assert.equal(result.externalReceipts[0].stale,false);
  f.advance(LEASE_MS*2);await createAutoposting(f.db,f.options).drain();assert.equal(f.calls.length,0,'перезапуск воркера не отправляет отмеченное');
});
test('подтверждение во время подготовки отправки останавливает передачу провайдеру на барьере beforePublish',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'},p=f.draft(['telegram']);
  const planned=await f.schedule(p);f.advance(60000);
  let submitted=0,release,entered;const waiting=new Promise(resolve=>entered=resolve);
  // Адаптер ждёт предварительные запросы и только потом вызывает барьер — как настоящий транспорт Onlypult.
  f.setSend(async input=>{entered();await new Promise(resolve=>{release=resolve;});
    input.beforePublish();submitted++;return {externalId:'must-not-happen'};});
  const job=f.api.drain();await waiting;
  f.api.recordReceipt(p.id,'alvi',{platform:'telegram',url:'https://t.me/taisabai/777',publishedAt:'2026-09-14T10:00:00Z',contentRevision:planned.contentRevision},owner);
  release();await job;
  assert.equal(submitted,0,'после подтверждения запрос площадке не передаётся');
  const result=f.api.get(p.id,'alvi');
  assert.equal(result.status,'needs_review');assert.equal(result.lastErrorCode,'EXTERNAL_PUBLICATION_RECORDED');
  assert.equal(result.deliveries[0].status,'cancelled');assert.equal(result.deliveries[0].errorCode,'EXTERNAL_PUBLICATION_RECORDED');
  assert.equal(result.deliveries[0].externalId,null);assert.equal(result.externalReceipts.length,1);
  f.advance(LEASE_MS*2);await createAutoposting(f.db,f.options).drain();assert.equal(submitted,0);
});
test('подтверждение не отменяет уже переданную площадке отправку и не скрывает её результат',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'},p=f.draft(['telegram']);
  const planned=await f.schedule(p);f.advance(60000);
  let release,entered;const waiting=new Promise(resolve=>entered=resolve);
  // Барьер уже пройден: запрос ушёл на площадку. Подтверждение, добавленное позже, дубликат не предотвращает.
  f.setSend(async input=>{input.beforePublish();entered();await new Promise(resolve=>{release=resolve;});
    return {externalId:'already-sent',url:'https://t.me/taisabai/778'};});
  const job=f.api.drain();await waiting;
  f.api.recordReceipt(p.id,'alvi',{platform:'telegram',url:'https://t.me/taisabai/778',publishedAt:'2026-09-14T10:00:00Z',contentRevision:planned.contentRevision},owner);
  release();await job;
  const result=f.api.get(p.id,'alvi');
  assert.equal(result.deliveries[0].status,'published','результат начатой доставки не скрывается и не подменяется');
  assert.equal(result.deliveries[0].externalId,'already-sent');
  assert.equal(result.externalReceipts.length,1,'подтверждение сохраняется рядом с доставкой, а не вместо неё');
});
test('порядок плана хранится на сервере: полный список, чужие/неизвестные id отклоняются, пропущенные уходят в конец; список выдаётся по порядку',async t=>{
  const f=fixture(t);const rev=()=>f.information.get('alvi').revision;
  const a=f.api.create('alvi',{title:'A',profileRevision:rev()},7),b=f.api.create('alvi',{title:'B',profileRevision:rev()},7),c=f.api.create('alvi',{title:'C',profileRevision:rev()},7);
  const other=f.api.create('avokado',{title:'X',profileRevision:f.information.get('avokado').revision},7);
  assert.deepEqual(f.api.list('alvi').posts.map(p=>p.title),['A','B','C']);
  assert.throws(()=>f.api.reorder('alvi',{ids:[c.id,other.id]}),e=>e.status===404);
  assert.throws(()=>f.api.reorder('alvi',{ids:[c.id,c.id]}),e=>e.status===400);
  const result=f.api.reorder('alvi',{ids:[c.id,a.id]},{userId:1,userName:'Влад'});
  assert.deepEqual(result.posts.map(p=>p.title),['C','A','B']);assert.deepEqual(f.api.list('alvi').posts.map(p=>p.sortOrder),[1,2,3]);
  assert.deepEqual(f.api.list('avokado').posts.map(p=>p.title),['X'],'порядок другой компании не тронут');
  assert.equal(f.api.get(c.id,'alvi').history[0].action,'reordered');
  // импорт пакета с метаданными
  const imported=f.api.importPackage('alvi',{items:[{dayKey:'D2',title:'Д2',captions:{vk:'Два'},meta:{format:'reel',role:'affection',hook:'Хук',methodSource:'Курс'}}]},7);
  assert.equal(imported.created[0].meta.role,'affection');assert.equal(imported.created[0].review.state,'draft');assert.equal(imported.created[0].sortOrder,4,'после переупорядочивания трёх карточек новая встаёт в конец');
  assert.throws(()=>f.api.importPackage('alvi',{items:[{title:'Плохо',meta:{role:'viral'}}]}),e=>e.status===400);
});

/* Согласование по площадкам. Проверяется ровно то, что раньше ломалось:
   добавленный канал не наследовал прежнее одобрение, а возврат на доработку был только на карточку целиком. */
function platformCard(f,platformIds=['telegram','vk'],code='alvi'){
  return f.api.create(code,{title:'Д2 — Процедура',text:'Общий текст',mediaUrls:['https://cdn.example.test/d2.mp4'],platformIds,
    dayKey:'D2',origin:'gemini-video',captions:{telegram:'Телеграм',vk:'ВК'},
    scheduledAt:new Date(Date.parse('2026-09-15T00:00:00Z')+3600000).toISOString(),timezone:'Asia/Irkutsk',
    profileRevision:f.information.get(code).revision},7);
}
const stateOf=(card,id)=>card.platformApprovals.find(item=>item.platformId===id);

test('согласование по площадкам: частичное одобрение не делает карточку согласованной и не пускает неодобренный канал в план',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'};let card=platformCard(f);
  assert.equal(card.platformApprovals.length,2);
  assert.ok(card.platformApprovals.every(item=>item.state==='pending'&&item.approved===false));
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true,platformIds:['telegram']},owner);
  assert.equal(stateOf(card,'telegram').approved,true);assert.equal(stateOf(card,'vk').approved,false);
  assert.equal(card.approval.approved,false,'карточка целиком не согласована, пока согласован только один канал');
  assert.equal(card.review.state,'pending');
  await assert.rejects(f.api.schedule(card.id,'alvi',{revision:card.revision}),e=>e.details.code==='APPROVAL_REQUIRED');
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true,platformIds:['vk']},owner);
  assert.equal(card.approval.approved,true,'после одобрения всех каналов карточка согласована целиком');
  assert.equal(card.review.state,'approved');
  const planned=await f.api.schedule(card.id,'alvi',{revision:card.revision});
  assert.equal(planned.status,'scheduled');await f.api.drain();assert.equal(f.calls.length,0);
});

test('добавленная после согласования площадка не наследует одобрение и не уходит в план',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'};let card=platformCard(f,['telegram']);
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true},owner);
  assert.equal(card.approval.approved,true);
  const withVk=f.api.update(card.id,'alvi',{revision:card.revision,platformIds:['telegram','vk']});
  assert.equal(stateOf(withVk,'telegram').approved,true,'у прежнего канала одобрение сохраняется');
  assert.equal(stateOf(withVk,'vk').state,'pending','новый канал не наследует прежнее решение');
  assert.equal(stateOf(withVk,'vk').approved,false);
  assert.equal(withVk.approval.approved,false,'карточка целиком больше не согласована');
  await assert.rejects(f.api.schedule(withVk.id,'alvi',{revision:withVk.revision}),e=>e.details.code==='APPROVAL_REQUIRED');
  await f.api.drain();assert.equal(f.calls.length,0,'несогласованный канал не получает отправку');
});

test('возврат одной площадки на доработку: причина обязательна, видна по каналу, остальные каналы не сбрасываются',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'};let card=platformCard(f);
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true},owner);
  assert.equal(card.approval.approved,true);
  assert.throws(()=>f.api.reject(card.id,'alvi',{revision:card.revision,comment:'   ',platformIds:['vk']},owner),e=>e.status===400,'причина обязательна');
  assert.throws(()=>f.api.reject(card.id,'alvi',{revision:card.revision,comment:'нет',platformIds:['facebook']},owner),e=>e.status===400,'канал не из карточки отклоняется');
  card=f.api.reject(card.id,'alvi',{revision:card.revision,comment:'Для ВК нужен другой хук',platformIds:['vk']},owner);
  assert.equal(stateOf(card,'vk').state,'rejected');assert.equal(stateOf(card,'vk').comment,'Для ВК нужен другой хук');
  assert.equal(stateOf(card,'vk').byName,'Влад');
  assert.equal(stateOf(card,'telegram').approved,true,'одобрение другого канала возвратом не снимается');
  assert.equal(card.approval.approved,false,'карточка целиком не согласована, пока один канал на доработке');
  await assert.rejects(f.api.schedule(card.id,'alvi',{revision:card.revision}),e=>e.details.code==='APPROVAL_REQUIRED');
  await f.api.drain();assert.equal(f.calls.length,0);
});

test('общая правка текста возвращает на согласование все площадки, а не только одну',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'};let card=platformCard(f);
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true},owner);
  assert.ok(card.platformApprovals.every(item=>item.approved));
  const edited=f.api.update(card.id,'alvi',{revision:card.revision,text:'Общий текст переписан'});
  assert.ok(edited.platformApprovals.every(item=>item.state==='pending'&&item.approved===false),'все затронутые каналы ждут нового согласования');
  assert.equal(edited.approval.approved,false);
  await assert.rejects(f.api.schedule(edited.id,'alvi',{revision:edited.revision}),e=>e.details.code==='APPROVAL_REQUIRED');
});

test('массовый возврат идёт по карточкам через существующий reject и даёт результат по каждой отдельно; несогласованное не отправляется',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'};
  let first=platformCard(f,['telegram']),second=platformCard(f,['telegram']);
  first=f.api.approve(first.id,'alvi',{revision:first.revision,approved:true},owner);
  second=f.api.approve(second.id,'alvi',{revision:second.revision,approved:true},owner);
  const results=[first,{...second,revision:second.revision-1}].map(card=>{
    try{return {id:card.id,ok:true,card:f.api.reject(card.id,'alvi',{revision:card.revision,comment:'Переносим на следующую неделю'},owner)};}
    catch(error){return {id:card.id,ok:false,code:error.details?.code||null};}
  });
  assert.equal(results[0].ok,true);assert.equal(results[0].card.review.state,'rejected');
  assert.equal(stateOf(results[0].card,'telegram').state,'rejected');
  assert.equal(results[1].ok,false);assert.equal(results[1].code,'REVISION_CONFLICT','каждая карточка даёт свой результат, одна ошибка не отменяет остальные');
  assert.equal(f.api.get(second.id,'alvi').approval.approved,true,'вторая карточка осталась как была');
  f.advance(3600000);await f.api.drain();assert.equal(f.calls.length,0,'возврат на доработку ничего не публикует');
});

test('утверждённый канал доходит до отправки, неутверждённый нет: approve только Telegram, план, drain после срока = одна отправка Telegram и ни одной ВК',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'};let card=platformCard(f,['telegram','vk']);
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true,platformIds:['telegram']},owner);
  assert.equal(stateOf(card,'telegram').approved,true);assert.equal(stateOf(card,'vk').approved,false);
  card=f.api.update(card.id,'alvi',{revision:card.revision,platformIds:['telegram']});
  assert.equal(stateOf(card,'telegram').approved,true,'снятие другого канала не трогает одобрение Telegram');
  const planned=await f.api.schedule(card.id,'alvi',{revision:card.revision});
  assert.equal(planned.status,'scheduled');await f.api.drain();assert.equal(f.calls.length,0,'до срока публикации ничего не отправлено');
  f.advance(3600000);await f.api.drain();
  assert.equal(f.calls.length,1,'ровно одна отправка');
  assert.equal(f.calls[0].channelId,'telegram');
  assert.equal(f.calls.filter(call=>call.channelId==='vk').length,0,'в ВК не отправлено ничего');
  assert.equal(f.api.get(card.id,'alvi').status,'published');
});

test('снятие одобрения одного канала после постановки в план не даёт отправить ничего и не уничтожает решение по другому каналу',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'};let card=platformCard(f,['telegram','vk']);
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true},owner);
  card=await f.api.schedule(card.id,'alvi',{revision:card.revision});assert.equal(card.status,'scheduled');
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:false,platformIds:['vk']},owner);
  assert.equal(stateOf(card,'vk').approved,false);
  assert.equal(stateOf(card,'telegram').approved,true,'одобрение Telegram сохранено');
  f.advance(3600000);await f.api.drain();
  assert.equal(f.calls.length,0,'несогласованная карточка не отправляется ни по одному пути');
});

test('явный пустой список площадок отклоняется и в одобрении, и в возврате; отсутствие поля по-прежнему означает все каналы',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'};let card=platformCard(f,['telegram','vk']);
  assert.throws(()=>f.api.approve(card.id,'alvi',{revision:card.revision,approved:true,platformIds:[]},owner),e=>e.status===400,'пустой выбор не одобряет всё');
  assert.ok(card.platformApprovals.every(item=>!item.approved),'после отказа ничего не согласовано');
  assert.throws(()=>f.api.reject(card.id,'alvi',{revision:card.revision,comment:'Переделать',platformIds:[]},owner),e=>e.status===400,'пустой выбор не возвращает всё');
  assert.equal(f.api.get(card.id,'alvi').review.state,'draft','отклонённый запрос ничего не изменил');
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true},owner);
  assert.ok(card.platformApprovals.every(item=>item.approved),'без поля platformIds решение относится ко всем каналам');
});

test('частичное согласование без удаления площадок: в план идёт только согласованный Telegram, ВК остаётся в карточке и не отправляется',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'};let card=platformCard(f,['telegram','vk']);
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true,platformIds:['telegram']},owner);
  assert.equal(stateOf(card,'telegram').approved,true);assert.equal(stateOf(card,'vk').approved,false);
  card=f.api.reject(card.id,'alvi',{revision:card.revision,comment:'Для ВК нужен другой хук',platformIds:['vk']},owner);
  assert.equal(stateOf(card,'vk').state,'rejected');assert.equal(stateOf(card,'telegram').approved,true);
  await assert.rejects(f.api.schedule(card.id,'alvi',{revision:card.revision}),e=>e.details.code==='APPROVAL_REQUIRED','без выбора каналов план по-прежнему требует все');
  await assert.rejects(f.api.schedule(card.id,'alvi',{revision:card.revision,platformIds:['vk']}),e=>e.details.code==='APPROVAL_REQUIRED','несогласованный канал в план не берётся');
  await assert.rejects(f.api.schedule(card.id,'alvi',{revision:card.revision,platformIds:[]}),e=>e.status===400,'пустой выбор каналов отклоняется');
  const planned=await f.api.schedule(card.id,'alvi',{revision:card.revision,platformIds:['telegram']});
  assert.equal(planned.status,'scheduled');
  assert.deepEqual(planned.platformIds,['telegram','vk'],'ВК остался в карточке');
  assert.equal(stateOf(planned,'vk').state,'rejected','статус ВК и его причина сохранены');
  assert.equal(planned.deliveries.length,1,'отправка запланирована только для Telegram');
  await f.api.drain();assert.equal(f.calls.length,0,'до срока ничего не отправлено');
  f.advance(3600000);await f.api.drain();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].channelId,'telegram');
  assert.equal(f.calls.filter(call=>call.channelId==='vk').length,0,'в ВК не отправлено ничего');
});

test('общий отзыв версии останавливает и частично согласованные каналы',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'};let card=platformCard(f,['telegram','vk']);
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true,platformIds:['telegram']},owner);
  card=await f.api.schedule(card.id,'alvi',{revision:card.revision,platformIds:['telegram']});
  assert.equal(card.status,'scheduled');
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:false},owner);
  assert.equal(card.status,'draft');assert.equal(card.lastErrorCode,'APPROVAL_REVOKED');
  assert.ok(card.platformApprovals.every(item=>!item.approved),'общий отзыв снимает согласование всех каналов');
  f.advance(3600000);await f.api.drain();assert.equal(f.calls.length,0);
});

test('гонка обработчика: правка и новый план во время ожидания настроек не отменяются устаревшим проходом',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'};let card=platformCard(f,['telegram']);
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true},owner);
  card=await f.api.schedule(card.id,'alvi',{revision:card.revision});
  assert.equal(card.status,'scheduled');
  f.advance(3600000);
  const original=f.transport.getSettings;let barrier=0;
  f.transport.getSettings=async code=>{
    if(++barrier===1){
      // Владелец успел переписать материал и заново поставить его в план, пока обработчик ждал настройки.
      let fresh=f.api.get(card.id,'alvi');
      fresh=f.api.update(fresh.id,'alvi',{revision:fresh.revision,text:'Переписанный текст'});
      fresh=f.api.approve(fresh.id,'alvi',{revision:fresh.revision,approved:true},owner);
      fresh=await f.api.schedule(fresh.id,'alvi',{revision:fresh.revision,scheduledAt:new Date(Date.parse('2026-09-15T00:00:00Z')+2*3600000+600000).toISOString()});
      assert.equal(fresh.status,'scheduled');
    }
    return original(code);
  };
  await f.api.drain();
  f.transport.getSettings=original;
  const after=f.api.get(card.id,'alvi');
  assert.equal(f.calls.length,0,'устаревший снимок ничего не отправил');
  assert.equal(after.status,'scheduled','новый план не снят');
  assert.equal(after.lastErrorCode,null,'устаревший проход не пометил карточку отзывом');
  assert.equal(after.text,'Переписанный текст');
  assert.ok(after.deliveries.every(delivery=>delivery.status==='pending'),'новые доставки не отменены');
});

test('календарь: добавленная подключённая площадка не наследует одобрение и ждёт решения, а не считается готовой',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'},range={from:'2026-09-01',to:'2026-09-30'};
  let card=platformCard(f,['telegram']);
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true},owner);
  const entryOf=async(id,platform)=>{
    const data=await f.api.calendar('alvi',range);
    const item=[...(data.posts||[]),...(data.undated||[])].find(value=>value.id===id);
    assert.ok(item,'карточка есть в календаре');
    return ((item.calendarReadiness||{}).platforms||[]).find(entry=>entry.platform===platform);
  };
  assert.equal((await entryOf(card.id,'telegram')).state,'ready','одобренный Telegram готов');
  const withVk=f.api.update(card.id,'alvi',{revision:card.revision,platformIds:['telegram','vk']});
  assert.equal(stateOf(withVk,'vk').approved,false);
  const vk=await entryOf(card.id,'vk');
  assert.equal(vk.state,'pending','добавленный ВК ждёт решения владельца, а не помечается нехваткой материала');
  assert.ok(vk.issues.some(issue=>/не одобрена владельцем для этой площадки/.test(issue)),'причина названа прямо');
  assert.equal((await entryOf(card.id,'telegram')).state,'ready','одобрение Telegram сохранено и не сбивается добавлением ВК');
  const revoked=f.api.approve(withVk.id,'alvi',{revision:withVk.revision,approved:false},owner);
  assert.ok(revoked.platformApprovals.every(item=>!item.approved));
  assert.equal((await entryOf(card.id,'telegram')).state,'pending','общий отзыв снимает готовность и с Telegram');
});

test('полный цикл частичной отправки: Telegram отправлен, ВК продолжен связанной карточкой, доработан, согласован и отправлен; по одной отправке на канал',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'};let card=platformCard(f,['telegram','vk']);
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true,platformIds:['telegram']},owner);
  card=await f.api.schedule(card.id,'alvi',{revision:card.revision,platformIds:['telegram']});
  f.advance(3600000);await f.api.drain();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].channelId,'telegram');
  const parent=f.api.get(card.id,'alvi');
  assert.deepEqual(parent.platformIds,['telegram','vk'],'ВК остался в исходной карточке');
  // Исходную карточку править нельзя — guard сохранён.
  assert.throws(()=>f.api.update(parent.id,'alvi',{revision:parent.revision,text:'Правка'}),e=>e.details.code==='POST_STATE','прежний guard исходника сохранён');
  // Продолжение только по ВК: Telegram сервер не отдаёт.
  assert.throws(()=>f.api.split(parent.id,'alvi',{revision:parent.revision,platformIds:['telegram']},owner),e=>e.details.code==='PUBLICATION_REVIEW_REQUIRED');
  assert.throws(()=>f.api.split(parent.id,'alvi',{revision:parent.revision,platformIds:[]},owner),e=>e.status===400);
  assert.throws(()=>f.api.split(parent.id,'avokado',{revision:parent.revision,platformIds:['vk']},owner),e=>e.status===404,'чужая компания не продолжает');
  const first=f.api.split(parent.id,'alvi',{revision:parent.revision,platformIds:['vk'],reason:'Нужен другой хук'},owner);
  assert.equal(first.created,true);
  let child=first.child;
  assert.deepEqual(child.platformIds,['vk']);assert.equal(child.status,'draft');assert.equal(child.scheduledAt,null);
  assert.deepEqual(Object.keys(child.captions),['vk'],'у ребёнка только подписи оставшихся площадок');
  assert.equal(child.deliveries.length,0);assert.equal(child.approval.approved,false);assert.equal(child.review.state,'pending');
  assert.equal(child.continuedFrom.postId,parent.id);assert.equal(child.continuedFrom.contentRevision,parent.contentRevision);
  const linked=f.api.get(parent.id,'alvi');
  assert.deepEqual(linked.continuedPlatforms.map(item=>item.platformId),['vk']);
  assert.equal(linked.continuedPlatforms[0].childPostId,child.id,'в исходной карточке видно, куда ушла работа');
  // Повторное и одновременное нажатие не создаёт второго активного ребёнка.
  const again=f.api.split(linked.id,'alvi',{revision:linked.revision,platformIds:['vk']},owner);
  assert.equal(again.created,false);assert.equal(again.child.id,child.id);
  const third=f.api.split(f.api.get(parent.id,'alvi').id,'alvi',{revision:f.api.get(parent.id,'alvi').revision,platformIds:['vk']},owner);
  assert.equal(third.child.id,child.id);
  assert.equal(f.api.list('alvi').posts.filter(item=>item.continuedFrom&&item.continuedFrom.postId===parent.id).length,1,'ровно одно продолжение по ВК');
  // Доработка и согласование ребёнка, затем отправка только в ВК.
  child=f.api.update(child.id,'alvi',{revision:child.revision,captions:{vk:'ВК, переписанная подпись'},
    scheduledAt:new Date(Date.parse('2026-09-15T00:00:00Z')+2*3600000).toISOString()});
  await assert.rejects(f.api.schedule(child.id,'alvi',{revision:child.revision}),e=>e.details.code==='APPROVAL_REQUIRED','несогласованное продолжение в план не идёт');
  child=f.api.approve(child.id,'alvi',{revision:child.revision,approved:true},owner);
  child=await f.api.schedule(child.id,'alvi',{revision:child.revision});
  assert.equal(child.status,'scheduled');
  f.advance(3600000);await f.api.drain();await f.api.drain();
  assert.equal(f.calls.filter(call=>call.channelId==='telegram').length,1,'Telegram отправлен ровно один раз');
  assert.equal(f.calls.filter(call=>call.channelId==='vk').length,1,'ВК отправлен ровно один раз');
  assert.equal(f.api.get(child.id,'alvi').status,'published');
});

test('продолжение запрещено при неизвестном результате отправки',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'};let card=platformCard(f,['telegram','vk']);
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true},owner);
  card=await f.api.schedule(card.id,'alvi',{revision:card.revision});
  f.advance(3600000);f.setSend(async()=>{throw Error('сеть оборвалась');});await f.api.drain();
  const stuck=f.api.get(card.id,'alvi');assert.equal(stuck.lastErrorCode,'PUBLICATION_UNCERTAIN');
  assert.throws(()=>f.api.split(stuck.id,'alvi',{revision:stuck.revision,platformIds:['telegram']},owner),e=>e.details.code==='POST_STATE','незавершённая карточка не продолжается: ранний guard срабатывает первым');
});

test('продолжение недоступно для черновика и запланированной карточки: они сами могут отправить те же площадки',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'};let card=platformCard(f,['telegram','vk']);
  assert.throws(()=>f.api.split(card.id,'alvi',{revision:card.revision,platformIds:['vk']},owner),e=>e.details.code==='POST_STATE','черновик не продолжают');
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true,platformIds:['telegram']},owner);
  card=await f.api.schedule(card.id,'alvi',{revision:card.revision,platformIds:['telegram']});
  assert.equal(card.status,'scheduled');
  assert.throws(()=>f.api.split(card.id,'alvi',{revision:card.revision,platformIds:['vk']},owner),e=>e.details.code==='POST_STATE','запланированную не продолжают');
  f.advance(3600000);await f.api.drain();
  const settled=f.api.get(card.id,'alvi');assert.equal(settled.status,'published');
  assert.equal(f.api.split(settled.id,'alvi',{revision:settled.revision,platformIds:['vk']},owner).created,true,'после завершённой отправки продолжение доступно');
});

test('связь по площадке вечная: отменённый ребёнок не создаётся заново, смешанный запрос даёт конфликт со ссылкой',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'};
  f.channels.push({id:'youtube_shorts',enabled:true,connected:true,revision:1});
  let card=platformCard(f,['telegram','vk']);
  card=f.api.update(card.id,'alvi',{revision:card.revision,platformIds:['telegram','vk','youtube_shorts'],captions:{telegram:'ТГ',vk:'ВК',youtube_shorts:'Шортс'}});
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true,platformIds:['telegram']},owner);
  card=await f.api.schedule(card.id,'alvi',{revision:card.revision,platformIds:['telegram']});
  f.advance(3600000);await f.api.drain();
  let parent=f.api.get(card.id,'alvi');assert.equal(parent.status,'published');
  const first=f.api.split(parent.id,'alvi',{revision:parent.revision,platformIds:['vk']},owner);
  assert.equal(first.created,true);const childId=first.child.id;
  // Отмена ребёнка не освобождает площадку: у него могла остаться неизвестная или уже выполненная отправка.
  const child=f.api.get(childId,'alvi');f.api.cancel(childId,'alvi',{revision:child.revision});
  parent=f.api.get(parent.id,'alvi');
  const retry=f.api.split(parent.id,'alvi',{revision:parent.revision,platformIds:['vk']},owner);
  assert.equal(retry.created,false);assert.equal(retry.child.id,childId,'вторая копия по ВК не создаётся даже после отмены');
  assert.equal(f.api.list('alvi').posts.filter(item=>item.continuedFrom?.postId===parent.id).length,1);
  // Смешанный запрос: часть уже передана, часть новая.
  parent=f.api.get(parent.id,'alvi');
  assert.throws(()=>f.api.split(parent.id,'alvi',{revision:parent.revision,platformIds:['vk','youtube_shorts']},owner),
    e=>e.details.code==='SPLIT_ALREADY_EXISTS'&&/материал №/.test(e.message),'конфликт со ссылкой на существующее продолжение');
  parent=f.api.get(parent.id,'alvi');
  const second=f.api.split(parent.id,'alvi',{revision:parent.revision,platformIds:['youtube_shorts']},owner);
  assert.equal(second.created,true);assert.notEqual(second.child.id,childId,'новые каналы запрашиваются отдельно');
});

test('в календаре опубликована только своя площадка: расписка и доставка считаются по каналу, не по карточке',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'},range={from:'2026-09-01',to:'2026-09-30'};
  let card=platformCard(f,['telegram','vk']);
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true,platformIds:['telegram']},owner);
  card=await f.api.schedule(card.id,'alvi',{revision:card.revision,platformIds:['telegram']});
  f.advance(3600000);await f.api.drain();
  const data=await f.api.calendar('alvi',range);
  const item=[...(data.posts||[]),...(data.undated||[])].find(value=>value.id===card.id);
  assert.ok(item);
  const byPlatform=new Map(((item.calendarReadiness||{}).platforms||[]).map(entry=>[entry.platform,entry]));
  assert.equal(byPlatform.get('telegram').state,'published','Telegram опубликован по своей доставке');
  assert.notEqual(byPlatform.get('vk').state,'published','ВК не становится опубликованным из-за чужой отправки');
});

test('после передачи площадки в продолжение расписка ставится только на продолжении: повторной отправки ВК не происходит',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'};let card=platformCard(f,['telegram','vk']);
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true,platformIds:['telegram']},owner);
  card=await f.api.schedule(card.id,'alvi',{revision:card.revision,platformIds:['telegram']});
  f.advance(3600000);await f.api.drain();
  assert.equal(f.calls.filter(call=>call.channelId==='telegram').length,1);
  let parent=f.api.get(card.id,'alvi');assert.equal(parent.status,'published');
  const outcome=f.api.split(parent.id,'alvi',{revision:parent.revision,platformIds:['vk']},owner);
  assert.equal(outcome.created,true);let child=outcome.child;
  // Расписку по переданной площадке исходник больше не принимает — иначе продолжение отправит её ещё раз.
  assert.throws(()=>f.api.recordReceipt(parent.id,'alvi',{platform:'vk',url:'https://vk.com/wall-1_2',
    publishedAt:'2026-09-15T00:30:00Z',contentRevision:f.api.get(parent.id,'alvi').contentRevision},owner),
    e=>e.details.code==='SPLIT_HANDED_OVER'&&/материале №/.test(e.message));
  // Штатно расписка ставится на продолжении, и оно после этого не отправляет ВК повторно.
  const receipt=f.api.recordReceipt(child.id,'alvi',{platform:'vk',url:'https://vk.com/wall-1_2',
    publishedAt:'2026-09-15T00:30:00Z',contentRevision:child.contentRevision},owner);
  assert.equal(receipt.created,true);
  child=f.api.get(child.id,'alvi');
  child=f.api.approve(child.id,'alvi',{revision:child.revision,approved:true},owner);
  await assert.rejects(f.api.schedule(child.id,'alvi',{revision:child.revision,
    scheduledAt:new Date(Date.parse('2026-09-15T00:00:00Z')+2*3600000).toISOString()}),
    e=>e.details.code==='EXTERNAL_PUBLICATION_RECORDED','отмеченная вне ЛК площадка повторно не отправляется');
  f.advance(3600000);await f.api.drain();
  assert.equal(f.calls.filter(call=>call.channelId==='vk').length,0,'ВК из кабинета не отправлялся ни разу');
  assert.equal(f.calls.filter(call=>call.channelId==='telegram').length,1,'Telegram остался с одной отправкой');
});

test('переданная в продолжение площадка не считается запасом на исходнике и не задваивает агрегаты',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'},range={from:'2026-09-01',to:'2026-09-30'};
  let card=platformCard(f,['telegram','vk']);
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true,platformIds:['telegram']},owner);
  card=await f.api.schedule(card.id,'alvi',{revision:card.revision,platformIds:['telegram']});
  f.advance(3600000);await f.api.drain();
  let parent=f.api.get(card.id,'alvi');assert.equal(parent.status,'published');
  const before=await f.api.calendar('alvi',range);
  const child=f.api.split(parent.id,'alvi',{revision:parent.revision,platformIds:['vk']},owner).child;
  const after=await f.api.calendar('alvi',range);
  const platformOf=(data,id,platform)=>{
    const item=[...(data.posts||[]),...(data.undated||[])].find(value=>value.id===id);
    assert.ok(item,'карточка есть в календаре');
    return ((item.calendarReadiness||{}).platforms||[]).find(entry=>entry.platform===platform);
  };
  const vk=platformOf(after,parent.id,'vk');
  assert.equal(vk.state,'inactive','ВК исходника закрыт: работа передана');
  assert.equal(vk.ready,false);
  assert.ok(vk.issues.some(issue=>new RegExp(`материале №${child.id}`).test(issue)),'видно, куда ушла работа');
  assert.equal(platformOf(after,parent.id,'telegram').state,'published','Telegram исходника не затронут');
  assert.ok(after.summary.readyPosts<=before.summary.readyPosts,'передача работы не увеличивает запас готового');
  // Итог карточки считается без закрытых площадок: Telegram опубликован, ВК передан — готовой она не становится.
  const parentItem=[...(after.posts||[]),...(after.undated||[])].find(value=>value.id===parent.id);
  assert.equal(parentItem.calendarReadiness.state,'published','исходник закрыт публикацией своей площадки, а не «готов»');
  assert.equal(parentItem.calendarReadiness.ready,false);
});

test('каналы, переданные в разные продолжения, не возвращают молча первое из них',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'};
  f.channels.push({id:'youtube_shorts',enabled:true,connected:true,revision:1});
  let card=platformCard(f,['telegram','vk']);
  card=f.api.update(card.id,'alvi',{revision:card.revision,platformIds:['telegram','vk','youtube_shorts'],
    captions:{telegram:'ТГ',vk:'ВК',youtube_shorts:'Шортс'}});
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true,platformIds:['telegram']},owner);
  card=await f.api.schedule(card.id,'alvi',{revision:card.revision,platformIds:['telegram']});
  f.advance(3600000);await f.api.drain();
  let parent=f.api.get(card.id,'alvi');
  const first=f.api.split(parent.id,'alvi',{revision:parent.revision,platformIds:['vk']},owner).child;
  parent=f.api.get(parent.id,'alvi');
  const second=f.api.split(parent.id,'alvi',{revision:parent.revision,platformIds:['youtube_shorts']},owner).child;
  assert.notEqual(first.id,second.id);
  parent=f.api.get(parent.id,'alvi');
  assert.throws(()=>f.api.split(parent.id,'alvi',{revision:parent.revision,platformIds:['vk','youtube_shorts']},owner),
    error=>error.details.code==='SPLIT_ALREADY_EXISTS'
      &&new RegExp(`материал №${first.id}`).test(error.message)
      &&new RegExp(`материал №${second.id}`).test(error.message),
    'конфликт называет оба продолжения, а не подменяет их одним');
});

test('сервер не ставит в план заведомо невалидный YouTube Shorts: картинка, http, отсутствие видео и длинное название',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'};
  f.channels.push({id:'youtube_shorts',enabled:true,connected:true,revision:1});
  const future=new Date(Date.parse('2026-09-15T00:00:00Z')+3600000).toISOString();
  const card=(changes={})=>{
    const created=f.api.create('alvi',{title:'Утро в студии',text:'Описание',mediaUrls:['https://cdn.example.test/d1.mp4'],
      platformIds:['telegram','youtube_shorts'],dayKey:'D2',captions:{telegram:'ТГ',youtube_shorts:'Шортс'},
      scheduledAt:future,timezone:'Asia/Irkutsk',profileRevision:f.information.get('alvi').revision,...changes},7);
    return f.api.approve(created.id,'alvi',{revision:created.revision,approved:true},owner);
  };
  for (const [name,changes] of [
    ['картинка вместо видео',{mediaUrls:['https://cdn.example.test/frame.jpg']}],
    ['видео по http',{mediaUrls:['http://cdn.example.test/d1.mp4']}],
    ['два файла',{mediaUrls:['https://cdn.example.test/a.mp4','https://cdn.example.test/b.mp4']}],
    ['картинка с расширением в параметре',{mediaUrls:['https://cdn.example.test/frame.jpg?file=.mp4']}],
    ['видео с фрагментом',{mediaUrls:['https://cdn.example.test/d1.mp4#t=1']}],
    ['видео с параметром и фрагментом',{mediaUrls:['https://cdn.example.test/d1.mp4?x=1#t=1']}],
    ['длинное название',{title:'З'.repeat(101)}],
  ]) {
    const item=card(changes);
    await assert.rejects(f.api.schedule(item.id,'alvi',{revision:item.revision}),
      error=>error.status===400&&error.details.code==='CONTENT_LIMIT',name);
    assert.equal(f.api.get(item.id,'alvi').deliveries.length,0,`${name}: очередь не создана`);
  }
  // Частичное согласование не ломается: Telegram в план идёт, YouTube остаётся в карточке.
  const partial=card({mediaUrls:['https://cdn.example.test/frame.jpg']});
  const planned=await f.api.schedule(partial.id,'alvi',{revision:partial.revision,platformIds:['telegram']});
  assert.equal(planned.status,'scheduled');
  assert.equal(planned.deliveries.length,1);
  assert.deepEqual(planned.platformIds,['telegram','youtube_shorts']);
  // Настоящий параметр запроса видео не ломает: отклоняется именно фрагмент.
  const withQuery=card({mediaUrls:['https://cdn.example.test/d1.mp4?x=1']});
  const queryPlanned=await f.api.schedule(withQuery.id,'alvi',{revision:withQuery.revision});
  assert.equal(queryPlanned.status,'scheduled');assert.equal(queryPlanned.deliveries.length,2);
  // И правильный материал планируется целиком.
  const good=card();
  const ok=await f.api.schedule(good.id,'alvi',{revision:good.revision});
  assert.equal(ok.status,'scheduled');assert.equal(ok.deliveries.length,2);
});

test('календарь не считает YouTube Shorts готовым, если вместо видео картинка или название слишком длинное',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'},range={from:'2026-09-01',to:'2026-09-30'};
  f.channels.push({id:'youtube_shorts',enabled:true,connected:true,revision:1});
  const entry=async(changes,platform='youtube_shorts')=>{
    const created=f.api.create('alvi',{title:'Утро в студии',text:'Описание',mediaUrls:['https://cdn.example.test/d1.mp4'],
      platformIds:['youtube_shorts'],dayKey:'D3',captions:{youtube_shorts:'Шортс'},
      scheduledAt:new Date(Date.parse('2026-09-15T00:00:00Z')+3600000).toISOString(),
      timezone:'Asia/Irkutsk',profileRevision:f.information.get('alvi').revision,...changes},7);
    f.api.approve(created.id,'alvi',{revision:created.revision,approved:true},owner);
    const data=await f.api.calendar('alvi',range);
    const item=[...(data.posts||[]),...(data.undated||[])].find(value=>value.id===created.id);
    assert.ok(item);
    return ((item.calendarReadiness||{}).platforms||[]).find(value=>value.platform===platform);
  };
  const picture=await entry({mediaUrls:['https://cdn.example.test/frame.jpg']});
  assert.notEqual(picture.state,'ready','картинка не делает Shorts готовым');
  assert.ok(picture.issues.some(issue=>/ровно один видеофайл по HTTPS/.test(issue)));
  const longTitle=await entry({title:'З'.repeat(101)});
  assert.notEqual(longTitle.state,'ready');
  assert.ok(longTitle.issues.some(issue=>/длиннее 100 символов/.test(issue)));
  const good=await entry({});
  assert.equal(good.state,'ready','правильный материал остаётся готовым');
});

/* Семь площадок Алви: план и согласование. Компании, числа и опции синтетические. */
const SEVEN=['vk','telegram','youtube_shorts','instagram','tiktok','two_gis','max'];

test('все семь площадок сохраняются при создании, правке и перечитывании; неизвестный сохранённый канал не пропадает',t=>{
  const f=fixture(t);
  const post=f.api.create('alvi',{title:'Семь площадок',text:'Подтверждённый текст',mediaUrls:['https://cdn.example.test/d1.mp4'],
    platformIds:SEVEN,scheduledAt:null,timezone:'Asia/Irkutsk',profileRevision:f.information.get('alvi').revision},7);
  assert.deepEqual(post.platformIds,SEVEN);
  assert.deepEqual(f.api.get(post.id,'alvi').platformIds,SEVEN,'выбор переживает перечитывание');
  // Правка текста выбор не теряет: Instagram, TikTok, MAX и 2ГИС остаются в карточке.
  const edited=f.api.update(post.id,'alvi',{revision:post.revision,text:'Другой подтверждённый текст',
    platformIds:post.platformIds,profileRevision:f.information.get('alvi').revision});
  assert.deepEqual(edited.platformIds,SEVEN);
  // Сохранённый идентификатор вне словаря не выбрасывается молча.
  const legacy=f.api.update(edited.id,'alvi',{revision:edited.revision,platformIds:[...SEVEN,'yandex_maps'],
    profileRevision:f.information.get('alvi').revision});
  assert.deepEqual(f.api.get(legacy.id,'alvi').platformIds,[...SEVEN,'yandex_maps']);
});

test('подписи и согласование охватывают семь площадок; 2ГИС планируется, но подтверждение публикации по нему не принимается',t=>{
  const f=fixture(t);
  const captions=Object.fromEntries(SEVEN.map(id=>[id,'Подпись '+id]));
  const post=f.api.create('alvi',{title:'Подписи',text:'Общий текст',mediaUrls:['https://cdn.example.test/d1.mp4'],
    platformIds:SEVEN,captions,dayKey:'D1',scheduledAt:null,timezone:'Asia/Irkutsk',profileRevision:f.information.get('alvi').revision},7);
  assert.deepEqual(Object.keys(post.captions).sort(),SEVEN.slice().sort());
  assert.deepEqual(post.platformApprovals.map(item=>item.platformId).sort(),SEVEN.slice().sort());
  assert.ok(post.platformApprovals.every(item=>item.state==='pending'));
  assert.equal(post.readiness.ready,true);
  // 2ГИС согласуется наравне с остальными.
  const approved=f.api.approve(post.id,'alvi',{revision:post.revision,approved:true,platformIds:['two_gis','max']},{userId:1,userName:'Влад'});
  const byId=new Map(approved.platformApprovals.map(item=>[item.platformId,item]));
  assert.equal(byId.get('two_gis').approved,true);
  assert.equal(byId.get('max').approved,true);
  assert.equal(byId.get('instagram').approved,false,'остальные площадки решение не затронуло');
  assert.equal(approved.approval?.approved,false,'карточка целиком согласованной не стала');
  // Подтверждение публикации: формат ссылки для MAX и 2ГИС не подтверждён, поэтому расписка не принимается.
  assert.throws(()=>f.api.recordReceipt(approved.id,'alvi',{platform:'two_gis',url:'https://2gis.ru/irkutsk/firm/1',publishedAt:'2026-09-15T10:00:00Z',contentRevision:approved.contentRevision}),
    error=>error.status===400&&/не подтверждён/.test(error.message));
  assert.throws(()=>f.api.recordReceipt(approved.id,'alvi',{platform:'max',url:'https://max.ru/post/1',publishedAt:'2026-09-15T10:00:00Z',contentRevision:approved.contentRevision}),
    error=>error.status===400);
});

test('частичное решение по площадкам: пустое пересечение отклоняется, согласованные ранее каналы не сбрасываются',t=>{
  const f=fixture(t);
  const post=f.api.create('alvi',{title:'Частично',text:'Подтверждённый текст',mediaUrls:['https://cdn.example.test/d1.mp4'],
    platformIds:['telegram','youtube_shorts','instagram'],dayKey:'D2',captions:{telegram:'ТГ'},scheduledAt:null,
    timezone:'Asia/Irkutsk',profileRevision:f.information.get('alvi').revision},7);
  const first=f.api.approve(post.id,'alvi',{revision:post.revision,approved:true,platformIds:['telegram','youtube_shorts']},{userId:1,userName:'Влад'});
  assert.deepEqual(first.platformApprovals.filter(item=>item.approved).map(item=>item.platformId).sort(),['telegram','youtube_shorts']);
  // Возврат Instagram на доработку прежние решения по TG и YouTube не трогает.
  const rejected=f.api.reject(first.id,'alvi',{revision:first.revision,comment:'Переснять вертикаль',platformIds:['instagram']},{userId:1,userName:'Влад'});
  const map=new Map(rejected.platformApprovals.map(item=>[item.platformId,item]));
  assert.equal(map.get('instagram').state,'rejected');
  assert.equal(map.get('telegram').approved,true);
  assert.equal(map.get('youtube_shorts').approved,true);
  // Площадка, не выбранная в карточке, решением не затрагивается.
  assert.throws(()=>f.api.approve(rejected.id,'alvi',{revision:rejected.revision,approved:true,platformIds:['tiktok']}),
    error=>error.status===400&&/не выбраны в карточке/.test(error.message));
  assert.throws(()=>f.api.approve(rejected.id,'alvi',{revision:rejected.revision,approved:true,platformIds:[]}),
    error=>error.status===400);
  // Устаревшая версия решения не принимается.
  assert.throws(()=>f.api.approve(rejected.id,'alvi',{revision:post.revision,approved:true,platformIds:['instagram']}),
    error=>error.status===409);
  assert.throws(()=>f.api.approve(rejected.id,'avokado',{revision:rejected.revision,approved:true,platformIds:['instagram']}),
    error=>error.status===404,'решение не переходит на другую компанию');
});

test('публикуемые опции входят в версию содержимого: их правка снимает согласование, чужие поля не принимаются',t=>{
  const f=fixture(t);
  const post=f.api.create('alvi',{title:'Опции',text:'Подтверждённый текст',mediaUrls:['https://cdn.example.test/d1.mp4'],
    platformIds:['instagram','tiktok','max'],dayKey:'D3',captions:{instagram:'ИГ'},scheduledAt:null,timezone:'Asia/Irkutsk',
    platformOptions:{instagram:{is_reels:true},tiktok:{privacy:'SELF_ONLY'},max:{pin_message:true}},
    profileRevision:f.information.get('alvi').revision},7);
  assert.deepEqual(post.platformOptions,{instagram:{is_reels:true},max:{pin_message:true},tiktok:{privacy:'SELF_ONLY'}});
  const approved=f.api.approve(post.id,'alvi',{revision:post.revision,approved:true},{userId:1,userName:'Влад'});
  assert.equal(approved.approval.approved,true);
  const changed=f.api.update(approved.id,'alvi',{revision:approved.revision,
    platformOptions:{instagram:{is_story:true},tiktok:{privacy:'SELF_ONLY'},max:{pin_message:true}},
    profileRevision:f.information.get('alvi').revision});
  assert.equal(changed.contentRevision,approved.contentRevision+1,'смена опции — новая версия содержимого');
  assert.equal(changed.approval.approved,false,'прежнее согласование снято');
  assert.ok(changed.platformApprovals.every(item=>item.state==='pending'));
  // Закрытая схема: чужие поля, чужие площадки и неподтверждённые значения не принимаются.
  const revision=changed.revision,profileRevision=f.information.get('alvi').revision;
  for(const options of [{instagram:{is_video:true}},{telegram:{pin_message:true}},{tiktok:{privacy:'FRIENDS'}},
    {instagram:{is_story:true,is_reels:true}},{max:{pin_message:'да'}}]){
    assert.throws(()=>f.api.update(changed.id,'alvi',{revision,platformOptions:options,profileRevision}),error=>error.status===400);
  }
  assert.deepEqual(f.api.get(changed.id,'alvi').platformOptions,{instagram:{is_story:true},max:{pin_message:true},tiktok:{privacy:'SELF_ONLY'}},
    'отклонённые правки ничего не записали');
});

test('согласование не запускает доставку, а выбранная неподключённая площадка остаётся в плане',async t=>{
  const f=fixture(t);
  const post=f.api.create('alvi',{title:'План',text:'Подтверждённый текст',mediaUrls:['https://cdn.example.test/d1.mp4'],
    platformIds:['telegram','two_gis','instagram'],scheduledAt:new Date(Date.parse('2026-09-15T00:00:00Z')+60000).toISOString(),
    timezone:'Asia/Irkutsk',profileRevision:f.information.get('alvi').revision},7);
  const approved=f.api.approve(post.id,'alvi',{revision:post.revision,approved:true},{userId:1,userName:'Влад'});
  await f.api.drain();
  assert.equal(f.calls.length,0,'согласование доставку не запускает');
  assert.deepEqual(f.api.get(approved.id,'alvi').platformIds,['telegram','two_gis','instagram'],'неподключённые площадки остались в плане');
  assert.notEqual(f.api.get(approved.id,'alvi').status,'published','подключения нет — публикацией это не становится');
});

/* Регрессии приёмки 29.09: дефекты 1 и 2. Компании, числа и опции синтетические. */

test('продолжение карточки переносит публикуемые опции оставшихся площадок',async t=>{
  const f=fixture(t),owner={userId:1,userName:'Влад'};
  const options={instagram:{is_story:true,disable_comment:false},tiktok:{privacy:'SELF_ONLY'},max:{pin_message:true}};
  let card=f.api.create('alvi',{title:'Родитель',text:'Подтверждённый текст',mediaUrls:['https://cdn.example.test/d1.mp4'],
    platformIds:['telegram','instagram','tiktok','max'],dayKey:'D1',captions:{telegram:'ТГ',instagram:'ИГ',tiktok:'ТТ'},
    scheduledAt:new Date(Date.parse('2026-09-15T00:00:00Z')+3600000).toISOString(),timezone:'Asia/Irkutsk',
    platformOptions:options,profileRevision:f.information.get('alvi').revision},7);
  // Telegram отправлен, остальные площадки продолжаются отдельной карточкой — как в жизни.
  card=f.api.approve(card.id,'alvi',{revision:card.revision,approved:true,platformIds:['telegram']},owner);
  card=await f.api.schedule(card.id,'alvi',{revision:card.revision,platformIds:['telegram']});
  f.advance(3600000);await f.api.drain();
  const parent=f.api.get(card.id,'alvi');
  const result=f.api.split(parent.id,'alvi',{revision:parent.revision,platformIds:['instagram','tiktok']},owner);
  assert.equal(result.created,true);
  const child=result.child;
  assert.deepEqual(child.platformIds,['instagram','tiktok']);
  // Переносятся значения ровно переданных площадок, включая явное false; чужая опция не тянется.
  assert.deepEqual(child.platformOptions,{instagram:{disable_comment:false,is_story:true},tiktok:{privacy:'SELF_ONLY'}});
  assert.equal(Object.hasOwn(child.platformOptions,'max'),false,'опция площадки, оставшейся у родителя, в продолжение не попала');
  assert.equal(child.platformOptions.instagram.disable_comment,false,'явное false пережило продолжение');
  // Продолжение согласуется заново и дальше везёт те же настройки.
  assert.ok(child.platformApprovals.every(item=>item.state==='pending'));
  const approved=f.api.approve(child.id,'alvi',{revision:child.revision,approved:true},owner);
  assert.equal(approved.approval.approved,true);
  assert.deepEqual(f.api.get(approved.id,'alvi').platformOptions,{instagram:{disable_comment:false,is_story:true},tiktok:{privacy:'SELF_ONLY'}});
  assert.deepEqual(f.api.get(parent.id,'alvi').platformOptions,options,'у родителя настройки не изменились');
});

test('импорт пакета принимает публикуемые опции, а пакет с другими опциями не выдаётся за повтор',t=>{
  const f=fixture(t);
  const item=(over={})=>({dayKey:'D1',title:'Импорт с опциями',text:'Подтверждённый текст',
    mediaUrls:['https://cdn.example.test/d1.mp4'],captions:{instagram:'ИГ'},
    platformIds:['instagram','tiktok'],platformOptions:{instagram:{is_reels:true},tiktok:{privacy:'SELF_ONLY'}},...over});
  const first=f.api.importPackage('alvi',{items:[item()]},7);
  assert.equal(first.created.length,1);
  assert.deepEqual(first.created[0].platformOptions,{instagram:{is_reels:true},tiktok:{privacy:'SELF_ONLY'}});
  assert.deepEqual(f.api.get(first.created[0].id,'alvi').platformOptions,{instagram:{is_reels:true},tiktok:{privacy:'SELF_ONLY'}});
  // Тот же пакет дублей не создаёт.
  const again=f.api.importPackage('alvi',{items:[item()]},7);
  assert.equal(again.created.length,0);
  assert.equal(again.skipped[0].reason,'duplicate');
  // Другой набор публикуемых опций — это не «то же содержимое»: пропуск помечен отдельной причиной.
  const other=f.api.importPackage('alvi',{items:[item({platformOptions:{instagram:{is_story:true}}})]},7);
  assert.equal(other.created.length,0,'дубль не создаётся');
  assert.equal(other.skipped[0].reason,'options_differ');
  assert.match(other.skipped[0].note,/другие публикуемые опции/);
  assert.deepEqual(f.api.get(first.created[0].id,'alvi').platformOptions,{instagram:{is_reels:true},tiktok:{privacy:'SELF_ONLY'}},
    'сохранённая карточка не переписана');
  // Закрытая схема действует и в импорте.
  assert.throws(()=>f.api.importPackage('alvi',{items:[item({dayKey:'D2',title:'Чужое поле',platformOptions:{instagram:{is_video:true}}})]},7),
    error=>error.status===400);
  assert.throws(()=>f.api.importPackage('alvi',{items:[item({dayKey:'D3',title:'Чужая площадка',platformOptions:{telegram:{pin_message:true}}})]},7),
    error=>error.status===400);
});
