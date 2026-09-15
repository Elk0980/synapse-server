'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createEmailCampaigns,LEASE_MS}=require('./email-campaigns');
const {createEmailSendLimit,DAY}=require('./email-send-limit');
const {createEmailOutbox}=require('./email-outbox');
const {createEmailNotifications,emailNotificationReady}=require('./email-notifications');
function fixture(t,{cap=100}={}) {
 const db=new DatabaseSync(':memory:');db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,name TEXT,is_deleted INTEGER DEFAULT 0);
 INSERT INTO companies(id,code,name) VALUES(1,'alvi','ALVI'),(2,'avokado','AVOKADO');
 CREATE TABLE contacts(id INTEGER PRIMARY KEY,email TEXT,name TEXT,is_deleted INTEGER DEFAULT 0);
 CREATE TABLE contact_companies(contact_id INTEGER,company_id INTEGER,is_deleted INTEGER DEFAULT 0);
 CREATE TABLE leads(id INTEGER PRIMARY KEY,company_code TEXT);
 INSERT INTO leads VALUES(1,'alvi');`);
 t.after(()=>db.close());let time=Date.parse('2026-09-15T12:00:00Z'),configured=true,sender='sender@example.test',priority=false,send=async()=>true;
 const calls=[],logs=[];const limiter=createEmailSendLimit(db,{now:()=>time,dailyCap:cap});
 const transport={configured:()=>configured,sender:()=>sender,send:async message=>{calls.push(message);return send(message)}};
 const options={transport,limiter,now:()=>time,hasPriorityWork:()=>priority,logger:{warn:line=>logs.push(line)}};
 const api=createEmailCampaigns(db,options);
 const add=(email='one@example.test',company='alvi')=>api.subscribe(company,{email,name:'Guest',status:'subscribed',source:'Paper consent QA',consentedAt:new Date(time-1000).toISOString()},9);
 const draft=(company='alvi')=>api.create(company,{name:'QA draft',subject:'Тестовая тема',text:'Только тестовый текст'},9);
 const launch=(campaign)=>api.launch(campaign.id,campaign.companyCode,{confirm:true,previewToken:api.preview(campaign.id,campaign.companyCode).previewToken});
 return {db,api,options,limiter,calls,logs,add,draft,launch,advance:ms=>time+=ms,setSend:value=>send=value,setConfigured:value=>configured=value,setSender:value=>sender=value,setPriority:value=>priority=value,
 delivery:()=>db.prepare('SELECT * FROM email_campaign_deliveries ORDER BY id').all()};
}
test('contacts default to unknown; drafts and preview never enqueue or send; company scopes are enforced',async t=>{
 const f=fixture(t);f.db.exec("INSERT INTO contacts VALUES(1,'known@example.test','Contact',0),(2,'bad address','Invalid',0); INSERT INTO contact_companies VALUES(1,1,0),(2,1,0)");
 const d=f.draft();assert.equal(f.api.subscriptions('alvi').subscriptions[0].status,'unknown');
 const p=f.api.preview(d.id,'alvi');assert.equal(p.counts.unknown,1);assert.equal(p.counts.invalid,1);assert.equal(p.canLaunch,false);
 await f.api.drain();assert.equal(f.calls.length,0);assert.equal(f.delivery().length,0);
 assert.throws(()=>f.api.get(d.id,'avokado'),e=>e.status===404);assert.throws(()=>f.api.list(undefined),e=>e.status===400);
 assert.equal(f.api.subscriptions('avokado').subscriptions.length,0);
});
test('manual subscription requires actual source/date, normalizes one mailbox, and records audit without enrolling other companies',t=>{
 const f=fixture(t),base={email:' ONE@example.test ',status:'subscribed',source:'',consentedAt:'2026-09-15T10:00:00Z'};
 assert.throws(()=>f.api.subscribe('alvi',base));assert.throws(()=>f.api.subscribe('alvi',{...base,source:'paper',consentedAt:'2099-01-01T00:00:00Z'}));
 for(const address of ['a@example.test,b@example.test','<a@example.test>','javascript:bad'])assert.throws(()=>f.add(address));
 const row=f.api.subscribe('alvi',{...base,source:'Paper confirmation'});assert.equal(row.email,'one@example.test');
 assert.equal(f.api.subscriptions('avokado').subscriptions.length,0);assert.equal(f.db.prepare('SELECT count(*) n FROM email_subscription_events').get().n,1);
});
test('preview deduplicates contact emails and launch rejects changed recipients/content without enqueuing',t=>{
 const f=fixture(t);f.db.exec("INSERT INTO contacts VALUES(1,'ONE@example.test','A',0),(2,'one@example.test','B',0); INSERT INTO contact_companies VALUES(1,1,0),(2,1,0)");
 f.add();const d=f.draft(),p=f.api.preview(d.id,'alvi');assert.equal(p.counts.eligible,1);assert.equal(p.counts.duplicate,1);
 f.add('two@example.test');assert.throws(()=>f.api.launch(d.id,'alvi',{confirm:true,previewToken:p.previewToken}),e=>e.details.code==='PREVIEW_CHANGED');
 assert.equal(f.delivery().length,0);assert.throws(()=>f.api.launch(d.id,'alvi',{confirm:false,previewToken:p.previewToken}));
 const p2=f.api.preview(d.id,'alvi');f.api.update(d.id,'alvi',{text:'New saved body'});
 assert.throws(()=>f.api.launch(d.id,'alvi',{confirm:true,previewToken:p2.previewToken}),e=>e.details.code==='PREVIEW_CHANGED');
 f.launch(d);assert.equal(f.delivery().length,2);assert.throws(()=>f.launch(d),e=>e.details.code==='CAMPAIGN_STATE');
});
test('launch fixes audience and content; pause stops delivery, resume excludes new subscribers, completed does not resend',async t=>{
 const f=fixture(t);f.add();const d=f.draft();f.launch(d);f.api.pause(d.id,'alvi');f.add('later@example.test');
 await f.api.drain();assert.equal(f.calls.length,0);assert.equal(f.api.preview(d.id,'alvi').counts.eligible,1);
 assert.throws(()=>f.api.update(d.id,'alvi',{subject:'Different'}),e=>e.details.code==='CAMPAIGN_STATE');
 f.launch(d);await f.api.drain();assert.equal(f.calls.length,1);assert.equal(f.calls[0].to,'one@example.test');
 assert.equal(f.api.get(d.id,'alvi').status,'completed');await f.api.drain();assert.equal(f.calls.length,1);
});
test('opaque unsubscribe GET is readonly; POST is idempotent, skips future mail and prevents stale resubscription',async t=>{
 const f=fixture(t);f.add();const a=f.draft();f.launch(a);await f.api.drain();
 const url=f.calls[0].unsubscribeUrl,token=url.split('/').pop();assert.match(token,/^[A-Za-z0-9_-]{43}$/);assert.ok(!url.includes('@'));
 const table=f.db.prepare('SELECT * FROM email_unsubscribe_tokens').get();assert.notEqual(table.token_hash,token);
 assert.equal(f.api.unsubscribe(token).unsubscribed,false);assert.equal(f.api.subscriptions('alvi').subscriptions[0].status,'subscribed');
 const b=f.draft();f.launch(b);f.advance(2000);assert.equal(f.api.unsubscribe(token,true).unsubscribed,true);
 const eventCount=f.db.prepare('SELECT count(*) n FROM email_subscription_events').get().n;
 assert.equal(f.api.unsubscribe(token,true).unsubscribed,true);assert.equal(f.db.prepare('SELECT count(*) n FROM email_subscription_events').get().n,eventCount);
 await f.api.drain();assert.equal(f.calls.length,1);assert.equal(f.api.get(b.id,'alvi').counts.skipped,1);
 assert.deepEqual(f.api.unsubscribe('invalid',true),{valid:false,unsubscribed:false});
 assert.throws(()=>f.api.subscribe('alvi',{email:'one@example.test',status:'subscribed',source:'old paper',consentedAt:'2026-09-15T10:00:00Z'}));
});
test('unknown status cannot erase an earlier unsubscribe or allow resubscription with old consent',t=>{
 const f=fixture(t);f.add();
 const save=(status,consentedAt)=>f.api.subscribe('alvi',{email:'one@example.test',status,source:'Recorded owner operation',...(consentedAt?{consentedAt}:{})});
 save('unsubscribed');f.advance(2000);save('unknown');
 const before=f.db.prepare('SELECT count(*) n FROM email_subscription_events').get().n;
 assert.throws(()=>save('subscribed','2026-09-15T11:00:00Z'),e=>e.status===400);
 assert.equal(f.api.subscriptions('alvi').subscriptions[0].status,'unknown');
 assert.equal(f.db.prepare('SELECT count(*) n FROM email_subscription_events').get().n,before);
 save('subscribed','2026-09-15T12:00:01Z');assert.equal(f.api.subscriptions('alvi').subscriptions[0].status,'subscribed');
});
test('a temporary failure survives recreation and retries with one stable message ID and sanitized logs',async t=>{
 const f=fixture(t);f.add();const d=f.draft();f.launch(d);f.setSend(async()=>{throw Object.assign(Error('secret-password person@example.test'),{code:'ECONNECTION'})});
 await f.api.drain();assert.equal(f.delivery()[0].status,'pending');assert.equal(f.delivery()[0].last_error_code,'SMTP_CONNECTION');
 const worker=createEmailCampaigns(f.db,f.options);await worker.drain();assert.equal(f.calls.length,1);
 f.advance(30000);f.setSend(async()=>true);await worker.drain();assert.equal(f.calls.length,2);assert.equal(f.calls[0].messageId,f.calls[1].messageId);
 assert.equal(f.api.get(d.id,'alvi').counts.sent,1);assert.ok(f.logs.every(line=>!line.includes('@')&&!line.includes('secret-password')));
});
test('expired sending is reclaimed but an older worker cannot overwrite a newer result',async t=>{
 const f=fixture(t);f.add();const d=f.draft();f.launch(d);let rejectOld;
 f.setSend(()=>new Promise((resolve,reject)=>rejectOld=reject));const old=f.api.drain();assert.equal(f.delivery()[0].status,'sending');
 f.advance(LEASE_MS+1);f.setSend(async()=>true);const worker=createEmailCampaigns(f.db,f.options);await worker.drain();
 assert.equal(f.delivery()[0].status,'sent');assert.equal(f.delivery()[0].attempts,2);
 rejectOld(Object.assign(Error('old worker failed'),{code:'ECONNECTION'}));await old;
 assert.equal(f.delivery()[0].status,'sent');assert.equal(f.api.get(d.id,'alvi').status,'completed');
});
test('multiple workers do not claim an unexpired delivery; pausing during an in-flight send preserves its result',async t=>{
 const f=fixture(t);f.add();const d=f.draft();f.launch(d);let finish;
 f.setSend(()=>new Promise(resolve=>finish=resolve));const job=f.api.drain();f.advance(3000);
 await createEmailCampaigns(f.db,f.options).drain();assert.equal(f.calls.length,1);f.api.pause(d.id,'alvi');finish(true);await job;
 assert.equal(f.delivery()[0].status,'sent');assert.equal(f.api.get(d.id,'alvi').status,'completed');
});
test('transport safe SMTP_AUTH pauses the campaign and a recipient refusal is terminal without false sent status',async t=>{
 const f=fixture(t);f.add();const d=f.draft();f.launch(d);
 f.setSend(async()=>{throw Object.assign(Error('sanitized'),{code:'SMTP_AUTH'})});await f.api.drain();
 assert.equal(f.api.get(d.id,'alvi').status,'paused');assert.equal(f.delivery()[0].last_error_code,'SMTP_AUTH');assert.equal(f.delivery()[0].sent_at,null);
 f.advance(30000);f.launch(d);f.setSend(async()=>{throw Object.assign(Error('sanitized'),{code:'EMAIL_RECIPIENT_REJECTED'})});await f.api.drain();
 assert.equal(f.delivery()[0].status,'failed');assert.equal(f.api.get(d.id,'alvi').counts.sent,0);
});
test('missing or changed sender pauses without SMTP and explicit preview is required before resuming',async t=>{
 const f=fixture(t);f.add();const d=f.draft();f.setConfigured(false);assert.equal(f.api.preview(d.id,'alvi').canLaunch,false);
 assert.throws(()=>f.launch(d),e=>e.details.code==='SMTP_NOT_CONFIGURED');f.setConfigured(true);f.launch(d);f.setSender('new@example.test');
 await f.api.drain();assert.equal(f.calls.length,0);assert.equal(f.api.get(d.id,'alvi').status,'paused');
 f.launch(d);await f.api.drain();assert.equal(f.calls.length,1);
});
test('shared quota counts notification and campaign attempts, enforces 2s and rolling daily cap across workers',async t=>{
 const f=fixture(t,{cap:2});f.add();const d=f.draft();f.launch(d);
 const outbox=createEmailOutbox(f.db,{notifyLead:async()=>true},{now:f.options.now,acquireSlot:()=>f.limiter.acquire().ok,logger:{warn(){}}});
 outbox.enqueue({id:1});await outbox.drain();await f.api.drain();assert.equal(f.calls.length,0);assert.equal(f.delivery()[0].attempts,0);
 f.advance(2000);await f.api.drain();assert.equal(f.calls.length,1);
 const secondLimiter=createEmailSendLimit(f.db,{now:f.options.now,dailyCap:2});assert.equal(secondLimiter.acquire().ok,false);
 f.advance(DAY);assert.equal(secondLimiter.acquire().ok,true);
});
test('notification priority blocks campaign without consuming its attempt or quota',async t=>{
 const f=fixture(t);f.add();const d=f.draft();f.launch(d);f.setPriority(true);await f.api.drain();
 assert.equal(f.calls.length,0);assert.equal(f.delivery()[0].attempts,0);assert.equal(f.db.prepare('SELECT count(*) n FROM email_send_slots').get().n,0);
 f.setPriority(false);await f.api.drain();assert.equal(f.calls.length,1);
});
test('quota refusal leaves notification pending without consuming attempts',async t=>{
 const f=fixture(t);const outbox=createEmailOutbox(f.db,{notifyLead:async()=>{throw Error('must not send')}},{acquireSlot:()=>false,now:f.options.now});
 outbox.enqueue({id:1});await outbox.drain();const row=f.db.prepare('SELECT * FROM lead_email_outbox').get();assert.equal(row.attempts,0);assert.equal(row.status,'pending');
});
test('notification priority mirrors SMTP defaults and isolated recipient routing without a generic studio fallback',async t=>{
 const base={LEADS_SMTP_USER:'sender@example.test',LEADS_SMTP_PASSWORD:'mock-only',LEADS_NOTIFY_EMAIL:'generic@example.test'};
 const lead={company_code:'alvi',created_at:'2026-09-15T12:00:00Z'};
 for(const [changes,company,expected] of [
  [{},'alvi',false],[{},'avokado',false],[{},'other',true],
  [{LEADS_NOTIFY_EMAIL_ALVI:' alvi@example.test '},'ALVI',true],
  [{LEADS_NOTIFY_EMAIL_ALVI:'  '},'alvi',false],
  [{LEADS_NOTIFY_EMAIL_AVOKADO:'avokado@example.test'},'avokado',true],
  [{LEADS_SMTP_HOST:' '},'other',false],[{LEADS_SMTP_USER:' '},'other',false],
  [{LEADS_SMTP_PASSWORD:' '},'other',false],
 ]) {
  const env={...base,...changes},row={...lead,company_code:company};let sent=false;
  const notifier=createEmailNotifications(env,{info(){}},()=>({sendMail:async()=>{sent=true;return {accepted:['mock']}}}));
  let accepted=false;try{accepted=await notifier.notifyLead(row)}catch(error){assert.equal(error.code,'EMAIL_RECIPIENT_MISSING')}
  assert.equal(emailNotificationReady(row,env),expected);assert.equal(accepted,expected);assert.equal(sent,expected);
 }
 const f=fixture(t);f.add();f.launch(f.draft());
 f.setPriority(emailNotificationReady(lead,base));await f.api.drain();assert.equal(f.calls.length,1,'a notification without its studio recipient must not starve campaign mail');
});
