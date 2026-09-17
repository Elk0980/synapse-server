'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomBytes}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {createAuthStore}=require('./auth-store'),{hashPassword}=require('./passwords');
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

test('real content→CRM VK routes enforce owner, company, CSRF, safe DTOs and explicit scoped replies',{timeout:30000},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'vk-community-http-')),children=[];
 const contentDb=path.join(directory,'content.sqlite'),crmDb=path.join(directory,'crm.sqlite'),marker=path.join(directory,'fixture-methods.jsonl');
 const token='FIXTURE_VK_TOKEN_NOT_REAL',password='Local-only-fixture-password',key=randomBytes(32).toString('hex');
 t.after(async()=>{
  for(const child of children.reverse())if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(directory,{recursive:true,force:true});
 });
 const authDb=new DatabaseSync(contentDb);const auth=createAuthStore(authDb,`owner:owner:${hashPassword(password)}`),owner=auth.getByLogin('owner');
 for(const [login,permissions]of [['reader',['crm.view']],['editor',['crm.view','crm.edit','autoposting.view','autoposting.edit']]])auth.create(owner.id,{login,displayName:login,password,companies:['avokado'],permissions},hashPassword(password));
 authDb.close();
 const preload=path.join(directory,'fixture-vk.cjs');
 // No live VK calls: the CRM process has a fixture fetch, and lower-level outgoing sockets are disabled.
 await fs.writeFile(preload,`
 'use strict';
 const fs=require('node:fs');
 function blocked(){throw new Error('External network disabled by VK HTTP fixture');}
 require('node:net').Socket.prototype.connect=blocked;require('node:tls').connect=blocked;
 globalThis.fetch=async function(url,options){
  if(typeof url!=='string'||!url.startsWith('https://api.vk.com/method/'))blocked();
  const method=url.split('/').pop(),params=Object.fromEntries(new URLSearchParams(options.body));
  const group=params.group_id,peer=group==='12345'?101:202;
  fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({method,groupId:group||null,peerId:params.peer_id||params.peer_ids||null})+'\\n');
  const conversation={peer:{id:peer,type:'user'},can_write:{allowed:true}};
  const message={id:77,peer_id:peer,from_id:peer,text:group==='12345'?'AVOKADO MESSAGE':'ALVI PRIVATE MESSAGE',date:1789640000,out:0};
  const payload={
   'groups.getTokenPermissions':{mask:4096,permissions:[{name:'messages',setting:1}]},
   'groups.getById':{groups:[{id:Number(group),name:group==='12345'?'Avokado fixture':'Alvi fixture'}]},
   'messages.getConversations':{count:1,items:[{conversation,last_message:message}]},
   'messages.getHistory':{count:1,items:[message]},
   'messages.getConversationsById':{count:1,items:[conversation]},
   'messages.send':88
  }[method];
  if(payload===undefined)blocked();return new Response(JSON.stringify({response:payload}));
 };
 `);
 const crmPort=await freePort(),contentPort=await freePort(),crmBase=`http://127.0.0.1:${crmPort}`,contentBase=`http://127.0.0.1:${contentPort}`;
 async function start(file,env,base,requireFile){let errors='';const child=spawn(process.execPath,[...(requireFile?['--require',requireFile]:[]),file],{env:{...process.env,...env},stdio:['ignore','ignore','pipe'],windowsHide:true});children.push(child);child.stderr.on('data',chunk=>errors+=chunk);
  for(let attempt=0;attempt<100;attempt++){if(child.exitCode!==null)throw Error('Service failed: '+errors);try{const response=await fetch(base+'/health',{signal:AbortSignal.timeout(500)});await response.text();return;}catch{await new Promise(resolve=>setTimeout(resolve,25));}}throw Error('Service not ready: '+errors);}
 await start(path.join(__dirname,'../crm/server.js'),{PORT:String(crmPort),DATABASE_PATH:crmDb,API_KEY:key,RATE_LIMIT_MAX:'10000',STRICT_ORIGIN:'',LEADS_SMTP_HOST:'',LEADS_SMTP_PORT:'465',LEADS_SMTP_USER:'',LEADS_SMTP_PASSWORD:'',LEADS_MAIL_FROM:'',LEADS_NOTIFY_EMAIL:'',LEADS_NOTIFY_EMAIL_ALVI:'',LEADS_NOTIFY_EMAIL_AVOKADO:''},crmBase,preload);
 await start(path.join(__dirname,'server.js'),{PORT:String(contentPort),DATABASE_PATH:contentDb,AUTH_USERS:'',API_KEY:'',CRM_URL:crmBase,CRM_API_KEY:key,SEED_DIR:directory,ASSETS_DIR:path.join(directory,'assets'),SESSION_SECRET:randomBytes(32).toString('hex')},contentBase);
 const identity=(role='owner')=>Buffer.from(JSON.stringify({v:1,userId:1,role,permissions:role==='owner'?[]:['vk-community.owner','crm.edit'],companyCodes:['avokado']})).toString('base64url');
 async function request(base,route,{method='GET',body,headers={}}={}){const response=await fetch(base+route,{method,headers:{...headers,...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});const text=await response.text();return{status:response.status,body:text?JSON.parse(text):null,headers:response.headers};}
 const direct=(route,options={})=>request(crmBase,route,{...options,headers:{'x-api-key':key,'x-synapse-crm-identity':identity(),...options.headers}});
 for(const companyCode of ['avokado','alvi'])assert.equal((await direct('/companies',{method:'POST',body:{code:companyCode,name:'Local '+companyCode}})).status,201);
 const sessions={};for(const login of ['owner','reader','editor']){const result=await request(contentBase,'/content/login',{method:'POST',body:{login,password}});assert.equal(result.status,200);const cookie=result.headers.get('set-cookie').split(';')[0];const profile=await request(contentBase,'/content/whoami',{headers:{cookie}});sessions[login]={cookie,'x-csrf-token':profile.body.csrfToken};}
 const through=(who,route,options={})=>request(contentBase,'/content/crm'+route,{...options,headers:{...sessions[who],...options.headers}});
 const routes=[['GET','settings'],['PUT','settings'],['POST','check'],['POST','conversations'],['POST','history'],['POST','reply']];
 async function calls(){try{return(await fs.readFile(marker,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if(error.code==='ENOENT')return[];throw error;}}
 for(const [method,pathName]of routes){const route=`/vk-community/${pathName}?companyCode=avokado`,body=method==='GET'?undefined:{};
  assert.equal((await request(contentBase,'/content/crm'+route,{method,body,headers:{'x-api-key':key,'x-synapse-crm-identity':identity()}})).status,401);
  assert.equal((await request(crmBase,route,{method,body,headers:{'x-synapse-crm-identity':identity()}})).status,401);
  assert.equal((await request(crmBase,route,{method,body,headers:{'x-api-key':key}})).status,403);
  for(const role of ['reader','editor'])assert.equal((await through(role,route,{method,body,headers:{'x-synapse-crm-identity':identity()}})).status,403);
  assert.equal((await direct(route,{method,body,headers:{'x-synapse-crm-identity':identity('editor')}})).status,403,'API key and forged permission name cannot grant owner access');
  assert.equal((await through('owner',`/vk-community/${pathName}`,{method,body})).status,400);
  assert.equal((await direct(`/vk-community/${pathName}`,{method,body})).status,400);
  if(method!=='GET')for(const csrf of ['','wrong-fixture-token'])assert.equal((await through('owner',route,{method,body,headers:{'x-csrf-token':csrf}})).status,403);
 }
 assert.deepEqual(await calls(),[],'denied requests must never contact the provider');
 assert.equal((await through('owner','/vk-community/settings?companyCode=missing')).status,404);
 for(const companyCode of ['avokado','alvi']) {
  const initial=await through('owner',`/vk-community/settings?companyCode=${companyCode}`);assert.equal(initial.status,200);assert.equal(initial.body.configured,false);assert.equal(initial.body.companyCode,companyCode);
  const saved=await through('owner',`/vk-community/settings?companyCode=${companyCode}`,{method:'PUT',body:{revision:0,groupId:companyCode==='avokado'?'12345':'67890',communityToken:token,companyCode:companyCode==='alvi'?'avokado':'alvi'}});
  assert.equal(saved.status,200);assert.equal(saved.body.companyCode,companyCode);assert.equal(saved.body.connected,false);assert.equal(saved.body.tokenConfigured,true);assert.match(saved.headers.get('cache-control'),/no-store/);
  assert.ok(!JSON.stringify(saved.body).includes(token));assert.ok(!JSON.stringify(saved.body).includes('encrypted_token'));
 }
 assert.deepEqual(await calls(),[],'saving credentials never checks or sends');
 for(const companyCode of ['avokado','alvi']) {
  const checked=await through('owner',`/vk-community/check?companyCode=${companyCode}`,{method:'POST',body:{}});assert.equal(checked.status,200);assert.equal(checked.body.ok,true);
  const list=await through('owner',`/vk-community/conversations?companyCode=${companyCode}`,{method:'POST',body:{revision:1,count:30}});assert.equal(list.status,200);assert.equal(list.body.companyCode,companyCode);assert.equal(list.body.items[0].peerId,companyCode==='avokado'?101:202);
  assert.ok(!JSON.stringify(list.body).includes(companyCode==='avokado'?'ALVI PRIVATE MESSAGE':'AVOKADO MESSAGE'));
 }
 const before=(await calls()).length;
 assert.equal((await through('owner','/vk-community/history?companyCode=avokado',{method:'POST',body:{peerId:202}})).status,502,'foreign peer never falls back to another company');
 assert.equal((await through('owner','/vk-community/reply?companyCode=avokado',{method:'POST',body:{revision:1,peerId:202,text:'Fixture',requestId:'fixture_other_0001'}})).status,502);
 assert.equal((await calls()).length,before);
 for(const value of [null,[],'invalid'])assert.equal((await through('owner','/vk-community/history?companyCode=avokado',{method:'POST',body:value})).status,400);
 const history=await through('owner','/vk-community/history?companyCode=avokado',{method:'POST',body:{revision:1,peerId:101}});assert.equal(history.status,200);assert.equal(history.body.items[0].text,'AVOKADO MESSAGE');
 const body={revision:1,peerId:101,text:'Explicit fixture reply',requestId:'fixture_reply_0001'};
 const blocked=await through('owner','/vk-community/reply?companyCode=avokado',{method:'POST',body,headers:{'x-csrf-token':''}});assert.equal(blocked.status,403);assert.equal((await calls()).filter(c=>c.method==='messages.send').length,0);
 const sent=await through('owner','/vk-community/reply?companyCode=avokado',{method:'POST',body});assert.equal(sent.status,200);assert.equal(sent.body.status,'sent');assert.equal(sent.body.companyCode,'avokado');
 const repeated=await through('owner','/vk-community/reply?companyCode=avokado',{method:'POST',body});assert.deepEqual(repeated.body,sent.body);
 const sends=(await calls()).filter(c=>c.method==='messages.send');assert.deepEqual(sends,[{method:'messages.send',groupId:'12345',peerId:'101'}]);
 const stored=new DatabaseSync(crmDb);try{assert.equal(stored.prepare('SELECT COUNT(*) AS n FROM vk_community_replies').get().n,1);assert.equal(stored.prepare('SELECT COUNT(*) AS n FROM lead_email_outbox').get().n,0);}finally{stored.close();}
});
