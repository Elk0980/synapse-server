'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomBytes}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {createAuthStore}=require('./auth-store'),{hashPassword}=require('./passwords');
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

// Подтверждение внешней публикации через существующий прокси кабинета: владелец компании, CSRF, изоляция компаний,
// проверка ссылки, идемпотентность, устаревшая версия содержимого и запрет повторной отправки отмеченной площадки.
test('проблема монтажа через proxy: view/edit, CSRF, компания, один taskId, без сообщений',{timeout:60000},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'receipts-http-')),children=[];
 const contentDb=path.join(directory,'content.sqlite'),crmDb=path.join(directory,'crm.sqlite'),blockedNetwork=path.join(directory,'blocked-network.log');
 const password='Local-receipts-fixture-password',key=randomBytes(32).toString('hex');
 t.after(async()=>{
  for(const child of children.reverse())if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(directory,{recursive:true,force:true});
 });
 const authDb=new DatabaseSync(contentDb),auth=createAuthStore(authDb,`owner:owner:${hashPassword(password)}`),owner=auth.getByLogin('owner');
 for(const [login,permissions]of [['editor',['autoposting.view','autoposting.edit']],['viewer',['autoposting.view']],['editonly',['autoposting.edit']],['denied',['crm.view']]])
  auth.create(owner.id,{login,displayName:login,password,companies:['avokado'],permissions},hashPassword(password));
 authDb.close();
 const crmPort=await freePort(),contentPort=await freePort(),crmBase=`http://127.0.0.1:${crmPort}`,contentBase=`http://127.0.0.1:${contentPort}`;
 const preload=path.join(directory,'local-network-only.cjs');
 await fs.writeFile(preload,`
 'use strict';
 const fs=require('node:fs'),net=require('node:net');
 const allowed=process.env.DEMAND_TEST_ALLOWED_ORIGIN?new URL(process.env.DEMAND_TEST_ALLOWED_ORIGIN):null;
 function blocked(){fs.appendFileSync(${JSON.stringify(blockedNetwork)},'blocked\\n');throw new Error('External network disabled by receipts fixture');}
 const originalFetch=globalThis.fetch;
 globalThis.fetch=(input,options)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!allowed||url.origin!==allowed.origin)blocked();return originalFetch(input,options);};
 const originalConnect=net.Socket.prototype.connect;
 net.Socket.prototype.connect=function(...args){const values=Array.isArray(args[0])?args[0]:args;const options=typeof values[0]==='object'?values[0]:{port:values[0],host:typeof values[1]==='string'?values[1]:'localhost'};
  if(!allowed||options.host!==allowed.hostname||String(options.port)!==allowed.port)blocked();return originalConnect.apply(this,args);};
 require('node:tls').connect=blocked;
 `);
 async function start(file,env,base){let errors='';const child=spawn(process.execPath,['--require',preload,file],{env:{...process.env,...env},stdio:['ignore','ignore','pipe'],windowsHide:true});children.push(child);child.stderr.on('data',chunk=>errors+=chunk);
  for(let attempt=0;attempt<150;attempt++){if(child.exitCode!==null)throw Error('Service failed: '+errors);try{const response=await fetch(base+'/health',{signal:AbortSignal.timeout(500)});await response.text();return;}catch{await new Promise(resolve=>setTimeout(resolve,25));}}throw Error('Service not ready: '+errors);}
 await start(path.join(__dirname,'../crm/server.js'),{PORT:String(crmPort),DATABASE_PATH:crmDb,API_KEY:key,RATE_LIMIT_MAX:'10000',STRICT_ORIGIN:'',DEMAND_TEST_ALLOWED_ORIGIN:'',LEADS_SMTP_HOST:'',LEADS_SMTP_PORT:'465',LEADS_SMTP_USER:'',LEADS_SMTP_PASSWORD:'',LEADS_MAIL_FROM:'',LEADS_NOTIFY_EMAIL:'',LEADS_NOTIFY_EMAIL_ALVI:'',LEADS_NOTIFY_EMAIL_AVOKADO:''},crmBase);
 await start(path.join(__dirname,'server.js'),{PORT:String(contentPort),DATABASE_PATH:contentDb,AUTH_USERS:'',API_KEY:'',CRM_URL:crmBase,CRM_API_KEY:key,SEED_DIR:directory,ASSETS_DIR:path.join(directory,'assets'),SESSION_SECRET:randomBytes(32).toString('hex'),DEMAND_TEST_ALLOWED_ORIGIN:crmBase,HUGH_RUNNER_URL:'',CHAT_URL:'',CHAT_API_KEY:''},contentBase);
 const identity=(permissions=[],role='owner',companyCodes=[])=>Buffer.from(JSON.stringify({v:1,userId:1,role,permissions,companyCodes})).toString('base64url');
 async function request(base,route,{method='GET',body,headers={}}={}){const response=await fetch(base+route,{method,headers:{...headers,...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});const text=await response.text();return{status:response.status,body:text?JSON.parse(text):null,headers:response.headers};}
 const direct=(route,options={})=>request(crmBase,route,{...options,headers:{'x-api-key':key,'x-synapse-crm-identity':identity(),...options.headers}});
 for(const code of ['avokado','alvi'])assert.equal((await direct('/companies',{method:'POST',body:{code,name:'Local '+code}})).status,201);
 const sessions={};for(const login of ['owner','editor','viewer','editonly','denied']){const result=await request(contentBase,'/content/login',{method:'POST',body:{login,password}});assert.equal(result.status,200);
  const cookie=result.headers.get('set-cookie').split(';')[0];const profile=await request(contentBase,'/content/whoami',{headers:{cookie}});sessions[login]={cookie,'x-csrf-token':profile.body.csrfToken};}
 const through=(who,route,options={})=>request(contentBase,'/content/crm'+route,{...options,headers:{...sessions[who],...options.headers}});

 const made=await through('editor','/autoposting/reels?companyCode=avokado',{method:'POST',body:{title:'SAMPLE ролик',mediaUrl:'https://synapse.synapsebusiness.ru/content/publishing-assets/avokado/'+'a'.repeat(32)+'.mp4'}});
 assert.equal(made.status,201,JSON.stringify(made.body));
 const route='/autoposting/reels/'+made.body.id+'/problems?companyCode=avokado',body={clientRequestId:'proxy-problem',text:'SAMPLE сбой',version:1};
 assert.equal((await through('viewer',route,{method:'POST',body,headers:{'x-csrf-token':''}})).status,403);
 assert.equal((await through('denied',route,{method:'POST',body})).status,403);
 const report=await through('viewer',route,{method:'POST',body});assert.equal(report.status,201,JSON.stringify(report.body));
 const repeat=await through('viewer',route,{method:'POST',body});assert.equal(repeat.status,200);assert.equal(repeat.body.taskId,report.body.taskId);
 assert.equal((await through('editonly',route,{method:'POST',body:{...body,clientRequestId:'editonly'}})).status,201);
 assert.equal((await through('viewer',route.replace('avokado','alvi'),{method:'POST',body})).status,403);
 assert.equal((await through('owner',route.replace('avokado','alvi'),{method:'POST',body})).status,404);
 assert.equal((await through('viewer','/autoposting/reels/'+made.body.id+'?companyCode=avokado',{method:'PATCH',body:{title:'нельзя'}})).status,403);
 const db=new DatabaseSync(crmDb);const tasks=db.prepare("SELECT * FROM tasks WHERE source_ref LIKE 'reel-problem:%'").all();
 assert.equal(tasks.length,2);assert.ok(tasks.every(t=>t.assignee_name==='Claude'));assert.equal(db.prepare('SELECT COUNT(*) n FROM reel_requests').get().n,0);db.close();
 const cdb=new DatabaseSync(contentDb);assert.equal(cdb.prepare('SELECT COUNT(*) n FROM team_chat_messages').get().n,0);cdb.close();
 assert.equal(await fs.stat(blockedNetwork).then(s=>s.size,()=>0),0,'никаких внешних соединений');
});
