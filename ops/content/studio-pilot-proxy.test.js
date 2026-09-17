'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomBytes}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {createAuthStore}=require('./auth-store'),{hashPassword}=require('./passwords');
async function freePort(){const s=net.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const port=s.address().port;await new Promise(resolve=>s.close(resolve));return port;}
test('real content→CRM pilot routes enforce session, CSRF, edit rights and company boundaries', {timeout:30000},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'studio-pilot-http-')),contentDb=path.join(directory,'content.sqlite'),crmDb=path.join(directory,'crm.sqlite');
  const password='test-only-local-passphrase',key=randomBytes(32).toString('hex'),children=[];
  t.after(async()=>{for(const child of children.reverse())if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(directory,{recursive:true,force:true});});
  const authDb=new DatabaseSync(contentDb);const auth=createAuthStore(authDb,`owner:owner:${hashPassword(password)}`),owner=auth.getByLogin('owner');
  for(const [login,permissions]of [['reader',['crm.view','autoposting.view']],['writer',['crm.edit','autoposting.edit']],['marketing',['autoposting.edit']]])
    auth.create(owner.id,{login,displayName:login,password,companies:['avokado'],permissions},hashPassword(password));
  authDb.close();
  const crmPort=await freePort(),contentPort=await freePort(),crmBase=`http://127.0.0.1:${crmPort}`,contentBase=`http://127.0.0.1:${contentPort}`;
  async function start(file,env,base){let errors='';const child=spawn(process.execPath,[file],{env:{...process.env,...env},stdio:['ignore','ignore','pipe'],windowsHide:true});children.push(child);child.stderr.on('data',chunk=>errors+=chunk);
    for(let attempt=0;attempt<100;attempt++){if(child.exitCode!==null)throw Error('Service failed: '+errors);try{const result=await fetch(base+'/health',{signal:AbortSignal.timeout(500)});await result.text();return;}catch{await new Promise(resolve=>setTimeout(resolve,25));}}throw Error('Service not ready: '+errors);}
  await start(path.join(__dirname,'../crm/server.js'),{PORT:String(crmPort),DATABASE_PATH:crmDb,API_KEY:key,STRICT_ORIGIN:'',LEADS_SMTP_HOST:'',LEADS_SMTP_PORT:'465',LEADS_SMTP_USER:'',LEADS_SMTP_PASSWORD:'',LEADS_MAIL_FROM:'',LEADS_NOTIFY_EMAIL:'',LEADS_NOTIFY_EMAIL_ALVI:'',LEADS_NOTIFY_EMAIL_AVOKADO:''},crmBase);
  await start(path.join(__dirname,'server.js'),{PORT:String(contentPort),DATABASE_PATH:contentDb,AUTH_USERS:'',API_KEY:'',CRM_URL:crmBase,CRM_API_KEY:key,SEED_DIR:directory,ASSETS_DIR:path.join(directory,'assets'),SESSION_SECRET:randomBytes(32).toString('hex')},contentBase);
  const identity=Buffer.from(JSON.stringify({v:1,userId:1,role:'owner',permissions:[],companyCodes:[]})).toString('base64url');
  async function request(base,route,{method='GET',body,headers={}}={}){const response=await fetch(base+route,{method,headers:{...headers,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const text=await response.text();return{status:response.status,body:text?JSON.parse(text):null,headers:response.headers};}
  const direct=(route,options={})=>request(crmBase,route,{...options,headers:{'x-api-key':key,'x-synapse-crm-identity':identity,...options.headers}});
  for(const code of ['alvi','avokado']){const result=await direct('/companies',{method:'POST',body:{code,name:'Local test '+code,timezone:'Asia/Irkutsk'}});assert.equal(result.status,201,JSON.stringify(result.body));}
  const ownLead=await direct('/leads',{method:'POST',body:{companyCode:'avokado',name:'Local Avokado fixture',contact:'+70000000001',source:'vk'}});
  const otherLead=await direct('/leads',{method:'POST',body:{companyCode:'alvi',name:'LOCAL PRIVATE ALVI',contact:'+70000000002',source:'vk'}});
  assert.equal(ownLead.status,201);assert.equal(otherLead.status,201);const id=ownLead.body.id,foreignId=otherLead.body.id;
  const sessions={};for(const name of ['owner','reader','writer','marketing']){const login=await request(contentBase,'/content/login',{method:'POST',body:{login:name,password}});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];const profile=await request(contentBase,'/content/whoami',{headers:{cookie}});sessions[name]={cookie,'x-csrf-token':profile.body.csrfToken};}
  const through=(name,route,options={})=>request(contentBase,'/content/crm'+route,{...options,headers:{...sessions[name],...options.headers}});
  for(const route of ['/studio-journey?companyCode=avokado','/autoposting/starter-plan?companyCode=avokado','/autoposting/settings/vk/profiles?companyCode=avokado']){
    assert.equal((await request(contentBase,'/content/crm'+route)).status,401);
    assert.equal((await request(crmBase,route,{headers:{'x-synapse-crm-identity':identity}})).status,401);
    assert.equal((await request(crmBase,route,{headers:{'x-api-key':key}})).status,403);
    assert.equal((await through('writer',route.replace('avokado','alvi'),{headers:{'x-synapse-crm-identity':identity}})).status,403);
  }
  assert.equal((await through('writer','/studio-journey')).status,400);
  assert.equal((await through('reader',`/studio-journey/${foreignId}?companyCode=avokado`)).status,404);
  const own=await through('reader',`/studio-journey/${id}?companyCode=avokado`);assert.equal(own.status,200);assert.equal(own.body.companyCode,'avokado');assert.doesNotMatch(JSON.stringify(own.body),/LOCAL PRIVATE ALVI/);
  const body={revision:0,requestId:'integration-booking',type:'booked',appointmentAt:new Date(Date.now()+86400000).toISOString()};
  assert.equal((await through('reader',`/studio-journey/${id}/events?companyCode=avokado`,{method:'POST',body})).status,403);
  assert.equal((await through('writer',`/studio-journey/${id}/events?companyCode=avokado`,{method:'POST',body,headers:{'x-csrf-token':''}})).status,403);
  assert.equal((await through('owner',`/studio-journey/${foreignId}/events?companyCode=avokado`,{method:'POST',body})).status,404);
  const created=await through('writer',`/studio-journey/${id}/events?companyCode=avokado`,{method:'POST',body});assert.equal(created.status,201);assert.equal(created.body.state.status,'booked');
  const dashboard=await through('reader','/dashboard?companyCode=avokado&period=today');assert.equal(dashboard.status,200);assert.ok(Number.isFinite(Date.parse(dashboard.body.range.from)));
  const cohort=await through('reader','/studio-journey?companyCode=avokado&from='+encodeURIComponent(dashboard.body.range.from));assert.equal(cohort.status,200);assert.equal(cohort.body.summary.leads,dashboard.body.summary.total);assert.equal(cohort.body.summary.booked,1);assert.equal(cohort.body.summary.visited,0);
  assert.equal((await through('reader',`/studio-journey/${id}/events/${created.body.events[0].id}?companyCode=avokado`,{method:'DELETE',body:{revision:1,reason:'test'}})).status,403);
  assert.equal((await through('marketing','/studio-journey?companyCode=avokado')).status,403);
  assert.equal((await through('reader','/autoposting/settings/vk/profiles?companyCode=avokado')).status,403);
  assert.equal((await through('marketing','/autoposting/settings/vk/profiles?companyCode=avokado')).status,403,'shared provider account profiles are owner-only');
  assert.equal((await through('owner','/autoposting/settings/vk/profiles?companyCode=avokado')).status,400,'owner reaches setup validation without a configured provider; no network');
  const onlypultBody={channels:[{id:'vk',provider:'onlypult',revision:0,target:'',enabled:false,token:'op_'+'a'.repeat(64)}]};
  assert.equal((await through('marketing','/autoposting/settings?companyCode=avokado',{method:'PUT',body:onlypultBody})).status,403);
  const savedProvider=await through('owner','/autoposting/settings?companyCode=avokado',{method:'PUT',body:onlypultBody});assert.equal(savedProvider.status,200);assert.doesNotMatch(JSON.stringify(savedProvider.body),new RegExp(onlypultBody.channels[0].token));
  for(const patch of [{id:'vk',revision:1,target:'another-company',enabled:false},{id:'vk',provider:'direct',revision:1,target:'123',token:'new-test-token',enabled:false}])
    assert.equal((await through('marketing','/autoposting/settings?companyCode=avokado',{method:'PUT',body:{channels:[patch]}})).status,403,'cannot switch target or provider of an existing owner connection');
  const editorIdentity=Buffer.from(JSON.stringify({v:1,userId:2,role:'editor',permissions:['autoposting.view','autoposting.edit'],companyCodes:['avokado']})).toString('base64url');
  assert.equal((await direct('/autoposting/settings/vk/profiles?companyCode=avokado',{headers:{'x-synapse-crm-identity':editorIdentity}})).status,403);
  assert.equal((await direct('/autoposting/settings?companyCode=avokado',{method:'PUT',body:{channels:[{id:'vk',revision:1,target:'another-company',enabled:false}]},headers:{'x-synapse-crm-identity':editorIdentity}})).status,403);
  const directSaved=await through('marketing','/autoposting/settings?companyCode=avokado',{method:'PUT',body:{channels:[{id:'telegram',provider:'direct',revision:0,target:'@test_channel',enabled:false,token:'12345:'+'a'.repeat(24)}]}});assert.equal(directSaved.status,200,'direct provider editing retains its previous permission');
  const plan=await through('reader','/autoposting/starter-plan?companyCode=avokado');assert.equal(plan.status,200);assert.equal(plan.body.available,true);
  const planBody={platform:'vk',profileRevision:plan.body.profileRevision};
  assert.equal((await through('reader','/autoposting/starter-plan?companyCode=avokado',{method:'POST',body:planBody})).status,403);
  assert.equal((await through('marketing','/autoposting/starter-plan?companyCode=avokado',{method:'POST',body:planBody,headers:{'x-csrf-token':''}})).status,403);
  const imported=await through('marketing','/autoposting/starter-plan?companyCode=avokado',{method:'POST',body:planBody});assert.equal(imported.status,201);assert.equal(imported.body.posts.length,7);assert.ok(imported.body.posts.every(p=>p.companyCode==='avokado'&&p.status==='draft'&&!p.scheduledAt&&!p.platformIds.length));
  const postId=imported.body.posts[0].id;
  assert.equal((await through('owner',`/autoposting/posts/${postId}?companyCode=alvi`)).status,404);
  assert.equal((await through('owner',`/autoposting/posts/${postId}/reconcile?companyCode=alvi`,{method:'POST',body:{revision:1}})).status,404);
  assert.equal((await through('reader',`/autoposting/posts/${postId}/reconcile?companyCode=avokado`,{method:'POST',body:{revision:1}})).status,403);
  const repeated=await through('marketing','/autoposting/starter-plan?companyCode=avokado',{method:'POST',body:planBody});assert.equal(repeated.status,200);assert.deepEqual(repeated.body.postIds,imported.body.postIds);
  const db=new DatabaseSync(crmDb);try{assert.equal(db.prepare('SELECT COUNT(*) n FROM autoposting_deliveries').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM studio_journey_events').get().n,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM autoposting_posts').get().n,7);}finally{db.close();}
});
