'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{randomBytes,createHash}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
test('CRM campaign routes require API key, enforce company scope, persist drafts and expose only opaque unsubscribe HTML',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'synapse-campaign-api-')),database=path.join(dir,'crm.sqlite');
 const probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const key=randomBytes(24).toString('hex');let output='';
 const child=spawn(process.execPath,[path.join(__dirname,'server.js')],{env:{...process.env,PORT:String(port),DATABASE_PATH:database,API_KEY:key,
  CRM_MAIL_DAILY_CAP:'100',CRM_EMAIL_PUBLIC_BASE_URL:'https://synapse.synapsebusiness.ru',LEADS_SMTP_HOST:'',LEADS_SMTP_PORT:'465',LEADS_SMTP_USER:'',LEADS_SMTP_PASSWORD:'',LEADS_MAIL_FROM:'',LEADS_NOTIFY_EMAIL:'',LEADS_NOTIFY_EMAIL_ALVI:'',LEADS_NOTIFY_EMAIL_AVOKADO:''},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',()=>{});
 t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(dir,{recursive:true,force:true});});
 for(let attempt=0;attempt<100&&!output.includes('слушает');attempt++){if(child.exitCode!==null)throw Error('Test CRM failed to start');await new Promise(resolve=>setTimeout(resolve,25));}
 assert.match(output,/слушает/);
 async function request(method,url,body,authenticated=true){const response=await fetch(`http://127.0.0.1:${port}${url}`,{method,headers:{...(authenticated?{'x-api-key':key}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const text=await response.text();return{status:response.status,text,body:response.headers.get('content-type')?.includes('json')?JSON.parse(text):null};}
 for(const [method,url,body] of [['GET','/email-campaigns?companyCode=qa'],['POST','/email-campaigns?companyCode=qa',{}],['PUT','/email-subscriptions?companyCode=qa',{}],['POST','/email-campaigns/1/launch?companyCode=qa',{confirm:true}],['GET','/email-unsubscribe/'+ 'A'.repeat(43)]])assert.equal((await request(method,url,body,false)).status,401);
 assert.equal((await request('POST','/companies',{code:'qa',name:'QA company'})).status,201);
 assert.equal((await request('POST','/companies',{code:'other',name:'Other QA company'})).status,201);
 const created=await request('POST','/email-campaigns?companyCode=qa',{name:'QA campaign',subject:'QA subject',text:'QA text'});assert.equal(created.status,201);const id=created.body.id;
 assert.equal((await request('GET',`/email-campaigns/${id}?companyCode=other`)).status,404);
 assert.equal((await request('GET','/email-campaigns')).status,400);
 const subscribed=await request('PUT','/email-subscriptions?companyCode=qa',{email:'qa@example.test',status:'subscribed',source:'QA explicit consent',consentedAt:'2026-01-01T00:00:00Z'});assert.equal(subscribed.status,200);
 const preview=await request('GET',`/email-campaigns/${id}/preview?companyCode=qa`);assert.equal(preview.body.counts.eligible,1);assert.equal(preview.body.canLaunch,false);assert.equal(preview.body.sender.configured,false);
 assert.equal((await request('POST',`/email-campaigns/${id}/launch?companyCode=qa`,{confirm:true,previewToken:preview.body.previewToken})).body.details.code,'SMTP_NOT_CONFIGURED');
 const token=randomBytes(32).toString('base64url'),db=new DatabaseSync(database);
 db.prepare('INSERT INTO email_unsubscribe_tokens(token_hash,subscription_id,created_at) VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'),subscribed.body.id,new Date().toISOString());
 assert.equal(db.prepare('SELECT count(*) n FROM email_campaign_deliveries').get().n,0);db.close();
 const page=await request('GET','/email-unsubscribe/'+token);assert.equal(page.status,200);assert.match(page.text,/<form method="post">/);assert.ok(!page.text.includes('qa@example.test'));
 assert.equal((await request('GET','/email-subscriptions?companyCode=qa')).body.subscriptions[0].status,'subscribed');
 const unsub=await request('POST','/email-unsubscribe/'+token);assert.equal(unsub.status,200);assert.match(unsub.text,/Вы отписались/);
 assert.equal((await request('POST','/email-unsubscribe/'+token)).status,200);assert.equal((await request('GET','/email-subscriptions?companyCode=qa')).body.subscriptions[0].status,'unsubscribed');
 assert.equal((await request('GET','/email-unsubscribe/'+'B'.repeat(43))).status,404);
});
