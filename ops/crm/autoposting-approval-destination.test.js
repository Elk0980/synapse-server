'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createCompanyInformation}=require('./company-information');
const {createAutoposting}=require('./autoposting');
const {createAutopostingTransport}=require('./autoposting-transport');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const SYNTHETIC_TG='123456:SYNTHETIC_NEVER_LIVE_TOKEN_1234567890',SYNTHETIC_VK='SYNTHETIC_VK_NEVER_LIVE';
function fixture(t,filename=':memory:'){
 const db=new DatabaseSync(filename);t.after(()=>{if(db.isOpen)db.close();});
 db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT UNIQUE COLLATE NOCASE,name TEXT,city TEXT,timezone TEXT,phone TEXT,email TEXT,website_url TEXT,socials TEXT,is_deleted INTEGER DEFAULT 0,updated_at TEXT);
 INSERT INTO companies(id,code,name,timezone,socials) VALUES(1,'palitra-love','Synthetic','UTC','[]'),(2,'other','Other','UTC','[]');`);
 let time=Date.parse('2026-10-01T00:00:00Z');const now=()=>time,information=createCompanyInformation(db,{now});
 const transport=createAutopostingTransport(db,{apiKey:'SYNTHETIC_STORAGE_NEVER_LIVE',now,fetchImpl:async()=>assert.fail('Сеть запрещена')});
 const calls=[];transport.publish=async input=>{input.beforePublish?.();calls.push(input);return {externalId:'synthetic-delivery',url:'https://example.test/published'};};
 const options={information,transport,now,logger:{warn(){}}};let api=createAutoposting(db,options);
 const save=(id,changes={},code='palitra-love')=>{const revision=transport.getSettings(code).channels.find(c=>c.id===id).revision;
  transport.saveSettings(code,{channels:[{id,revision,enabled:true,target:id==='telegram'?'@synthetic_a':'12345',token:id==='telegram'?SYNTHETIC_TG:SYNTHETIC_VK,...changes}]});
  db.prepare("UPDATE autoposting_channels SET status='connected',checked_revision=revision WHERE company_code=? AND id=?").run(code,id);};
 save('telegram');save('vk');
 const draft=(ids=['telegram'],code='palitra-love')=>api.create(code,{title:'Synthetic',text:'Проверенный материал',mediaUrls:['https://example.test/material.jpg'],platformIds:ids,dayKey:'D1',scheduledAt:new Date(time+60000).toISOString(),profileRevision:information.get(code).revision},7);
 const approve=p=>api.approve(p.id,p.companyCode,{revision:p.revision,approved:true},{userId:7,userName:'Synthetic owner'});
 const schedule=p=>api.schedule(p.id,p.companyCode,{revision:p.revision});
 return {db,information,transport,options,calls,save,draft,approve,schedule,get api(){return api;},restart:()=>api=createAutoposting(db,options),advance:ms=>time+=ms};
}
test('CF28 regression: approve Telegram A, save/check B, NEW schedule requires a new decision',async t=>{
 const f=fixture(t),p=f.approve(f.draft());f.save('telegram',{target:'@synthetic_b'});
 await assert.rejects(f.schedule(p),e=>e.status===409&&e.details.code==='APPROVAL_DESTINATION_CHANGED');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM autoposting_deliveries').get().n,0);
 assert.equal(f.api.get(p.id,p.companyCode).status,'draft');
});
for(const change of ['token','provider','ABA'])test('CF28 destination change '+change+' requires new approval, then succeeds',async t=>{
 const f=fixture(t),p=f.approve(f.draft()),before=f.transport.approvalDestination(p.companyCode,'telegram').destinationRevision;
 if(change==='token')f.save('telegram',{token:'987654:SYNTHETIC_CHANGED_NEVER_LIVE_TOKEN_1234567890'});
 if(change==='provider')f.save('telegram',{provider:'onlypult',target:'synthetic-profile',token:'op_'+'a'.repeat(64)});
 if(change==='ABA'){f.save('telegram',{target:'@synthetic_b'});f.save('telegram');}
 assert.ok(f.transport.approvalDestination(p.companyCode,'telegram').destinationRevision>before);
 assert.equal(f.api.get(p.id,p.companyCode).approval.approved,false);
 await assert.rejects(f.schedule(p),e=>e.details.code==='APPROVAL_DESTINATION_CHANGED');
 const fresh=f.approve(f.api.get(p.id,p.companyCode));assert.equal((await f.schedule(fresh)).status,'scheduled');
});
test('CF28 rename, same token, enabled toggle and check metadata preserve destination approval',async t=>{
 const f=fixture(t),p=f.approve(f.draft()),destination=f.transport.approvalDestination(p.companyCode,'telegram').destinationRevision;
 f.save('telegram',{name:'Переименовано',token:''});f.save('telegram',{name:'Другой label',enabled:false});f.save('telegram',{name:'Другое UI имя'});
 f.db.prepare("UPDATE autoposting_channels SET profile_display_name='Check label',checked_at='2026-10-01' WHERE company_code=? AND id='telegram'").run(p.companyCode);
 assert.equal(f.transport.approvalDestination(p.companyCode,'telegram').destinationRevision,destination);
 assert.equal(f.api.get(p.id,p.companyCode).approval.approved,true);
 assert.equal((await f.schedule(p)).status,'scheduled');
 const encoded=JSON.stringify(f.api.get(p.id,p.companyCode));assert.ok(!encoded.includes('synthetic_a'));assert.ok(!encoded.includes(SYNTHETIC_TG));
 assert.equal(Object.hasOwn(f.transport.getSettings(p.companyCode).channels[0],'destinationRevision'),false);
});
test('CF28 profileRevision-only update cannot reuse approval, current profile requires new decision',async t=>{
 const f=fixture(t),p=f.approve(f.draft()),oldContent=p.contentRevision;
 const profile=f.information.get(p.companyCode);f.information.save(p.companyCode,{revision:profile.revision,profile:{description:'New saved owner facts'}});
 assert.equal(f.api.get(p.id,p.companyCode).approval.approved,false,'DTO показывает устаревшее согласование ещё до profile-only правки карточки');
 const updated=f.api.update(p.id,p.companyCode,{revision:p.revision,profileRevision:f.information.get(p.companyCode).revision});
 assert.equal(updated.contentRevision,oldContent);assert.equal(updated.approval.approved,false);
 await assert.rejects(f.schedule(updated),e=>e.details.code==='APPROVAL_PROFILE_CHANGED');
 assert.equal((await f.schedule(f.approve(updated))).status,'scheduled');
});
test('CF28 partial approval: changed VK does not invalidate selected Telegram',async t=>{
 const f=fixture(t);let p=f.draft(['telegram','vk']);p=f.api.approve(p.id,p.companyCode,{revision:p.revision,approved:true,platformIds:['telegram']});
 p=f.api.approve(p.id,p.companyCode,{revision:p.revision,approved:true,platformIds:['vk']});f.save('vk',{target:'54321'});
 const current=f.api.get(p.id,p.companyCode);assert.equal(current.platformApprovals.find(x=>x.platformId==='telegram').approved,true);assert.equal(current.platformApprovals.find(x=>x.platformId==='vk').approved,false);
 await assert.rejects(f.api.schedule(p.id,p.companyCode,{revision:p.revision,platformIds:['vk']}),e=>e.details.code==='APPROVAL_DESTINATION_CHANGED');
 assert.equal((await f.api.schedule(p.id,p.companyCode,{revision:p.revision,platformIds:['telegram']})).status,'scheduled');
});
for(const kind of ['destination','name','profile'])test('CF28 awaited settings race '+kind+' rolls back approveAndSchedule',async t=>{
 const f=fixture(t),p=f.draft(),before=f.db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(p.id),getSettings=f.transport.getSettings;
 f.transport.getSettings=async code=>{const snapshot=getSettings(code);f.transport.getSettings=getSettings;
  if(kind==='destination')f.save('telegram',{target:'@synthetic_b'});
  if(kind==='name')f.save('telegram',{name:'Concurrent name'});
  if(kind==='profile'){const profile=f.information.get(code);f.information.save(code,{revision:profile.revision,profile:{description:'Concurrent profile'}});}
  await new Promise(resolve=>setImmediate(resolve));return snapshot;};
 await assert.rejects(f.api.approveAndSchedule(p.id,p.companyCode,{revision:p.revision,approved:true,schedule:true}),e=>e.status===409&&['CHANNEL_CHANGED','PROFILE_CHANGED'].includes(e.details.code));
 assert.deepEqual(f.db.prepare('SELECT * FROM autoposting_posts WHERE id=?').get(p.id),before);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM autoposting_platform_reviews').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM autoposting_reviews').get().n,0);assert.equal(f.db.isTransaction,false);
});
test('CF28 schedule detects destination race after snapshot; no delivery or implicit approval',async t=>{
 const f=fixture(t),p=f.approve(f.draft()),getSettings=f.transport.getSettings;
 f.transport.getSettings=async code=>{const snapshot=getSettings(code);f.transport.getSettings=getSettings;f.save('telegram',{target:'@synthetic_b'});await new Promise(resolve=>setImmediate(resolve));return snapshot;};
 await assert.rejects(f.schedule(p),e=>e.details.code==='APPROVAL_DESTINATION_CHANGED');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM autoposting_deliveries').get().n,0);
});
test('CF28 failed delivery INSERT rolls back content approval and destination binding together',async t=>{
 const f=fixture(t),p=f.draft();f.db.exec("CREATE TRIGGER refuse_delivery BEFORE INSERT ON autoposting_deliveries BEGIN SELECT RAISE(ABORT,'synthetic refusal'); END");
 assert.equal(f.api.get(p.id,p.companyCode).approval.approved,false);
 await assert.rejects(f.api.approveAndSchedule(p.id,p.companyCode,{revision:p.revision,approved:true,schedule:true}),/synthetic refusal/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM autoposting_platform_reviews').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM autoposting_reviews').get().n,0);assert.equal(f.api.get(p.id,p.companyCode).approval.approved,false);
});
test('CF28 restart preserves destination/bindings, and legacy migration requires NEW schedule approval',async t=>{
 const f=fixture(t),p=f.approve(f.draft()),binding=f.db.prepare('SELECT * FROM autoposting_platform_reviews WHERE post_id=?').get(p.id);
 f.restart();assert.deepEqual(f.db.prepare('SELECT * FROM autoposting_platform_reviews WHERE post_id=?').get(p.id),binding);assert.equal(f.api.get(p.id,p.companyCode).approval.approved,true);
 f.db.exec('ALTER TABLE autoposting_platform_reviews DROP COLUMN approved_profile_revision;ALTER TABLE autoposting_platform_reviews DROP COLUMN approved_destination_revision;ALTER TABLE autoposting_channels DROP COLUMN destination_revision');
 createAutopostingTransport(f.db,{apiKey:'SYNTHETIC_STORAGE_NEVER_LIVE',fetchImpl:async()=>assert.fail('Сеть запрещена')});f.restart();
 assert.equal(f.transport.approvalDestination(p.companyCode,'telegram').destinationRevision,1);
 await assert.rejects(f.schedule(p),e=>e.details.code==='APPROVAL_DESTINATION_CHANGED');assert.equal((await f.schedule(f.approve(p))).status,'scheduled');
});
test('CF28 old queued null bindings still drain, channel revision change keeps old delivery guard',async t=>{
 const f=fixture(t);let p=await f.schedule(f.approve(f.draft()));f.db.prepare('UPDATE autoposting_platform_reviews SET approved_profile_revision=NULL,approved_destination_revision=NULL WHERE post_id=?').run(p.id);
 f.restart();assert.equal(f.api.get(p.id,p.companyCode).status,'scheduled');f.advance(60001);await f.api.drain();assert.equal(f.calls.length,1);
 let second=f.approve(f.draft());second=await f.schedule(second);f.save('telegram',{target:'@synthetic_b'});assert.equal(f.api.get(second.id,second.companyCode).status,'scheduled');
 f.advance(60001);await f.api.drain();assert.equal(f.calls.length,1);assert.equal(f.api.get(second.id,second.companyCode).lastErrorCode,'CHANNEL_CHANGED');
});
test('CF28 company scope and missing or async adapter cannot authorize a NEW schedule',async t=>{
 const f=fixture(t),p=f.approve(f.draft());f.save('telegram',{target:'@synthetic_b'},'other');assert.equal(f.api.get(p.id,p.companyCode).approval.approved,true);
 assert.throws(()=>f.transport.approvalDestination('missing','telegram'),e=>e.status===404);assert.throws(()=>f.api.approve(p.id,'other',{revision:p.revision,approved:true}),e=>e.status===404);
 const real=f.transport.approvalDestination;delete f.transport.approvalDestination;const manual=f.approve(f.draft());await assert.rejects(f.schedule(manual),e=>e.details.code==='APPROVAL_DESTINATION_CHANGED');
 f.transport.approvalDestination=async()=>({destinationRevision:1,channelRevision:1});assert.throws(()=>f.approve(f.draft()),e=>e.details.code==='APPROVAL_CONTEXT_UNAVAILABLE');f.transport.approvalDestination=real;
});
test('CF28 file SQLite reopen preserves the approved destination after ABA',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'synapse-cf28-')),filename=path.join(directory,'synthetic.sqlite');
 const f=fixture(t,filename);let p=f.approve(f.draft());f.save('telegram',{target:'@synthetic_b'});f.save('telegram');p=f.approve(f.api.get(p.id,p.companyCode));
 const binding=f.db.prepare('SELECT approved_profile_revision p,approved_destination_revision d FROM autoposting_platform_reviews WHERE post_id=?').get(p.id);
 assert.equal(binding.d,3);f.db.close();const reopened=new DatabaseSync(filename);
 t.after(()=>{reopened.close();fs.unlinkSync(filename);fs.rmdirSync(directory);});
 const transport=createAutopostingTransport(reopened,{apiKey:'SYNTHETIC_STORAGE_NEVER_LIVE',fetchImpl:async()=>assert.fail('Сеть запрещена')}),information=createCompanyInformation(reopened),api=createAutoposting(reopened,{transport,information,now:()=>Date.parse('2026-10-01T00:00:00Z')});
 assert.deepEqual(reopened.prepare('SELECT approved_profile_revision p,approved_destination_revision d FROM autoposting_platform_reviews WHERE post_id=?').get(p.id),binding);
 assert.equal(api.get(p.id,p.companyCode).approval.approved,true);assert.equal((await api.schedule(p.id,p.companyCode,{revision:p.revision})).status,'scheduled');
});
