'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomBytes}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {createAuthStore}=require('./auth-store'),{hashPassword}=require('./passwords');

async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

test('real content to CRM reviews enforce permissions, company boundaries, CSRF, deduplication and revisions without external requests',{timeout:45000},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'reviews-http-')),children=[];
 const contentDb=path.join(directory,'content.sqlite'),crmDb=path.join(directory,'crm.sqlite'),blockedNetwork=path.join(directory,'blocked-network.log');
 const password='Local-reviews-fixture-password',key=randomBytes(32).toString('hex');
 t.after(async()=>{
  for(const child of children.reverse())if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(directory,{recursive:true,force:true});
 });
 const authDb=new DatabaseSync(contentDb),auth=createAuthStore(authDb,`owner:owner:${hashPassword(password)}`),owner=auth.getByLogin('owner');
 for(const [login,permissions]of [['reader',['crm.view']],['writer',['crm.edit']],['unrelated',['autoposting.view','autoposting.edit']]])
  auth.create(owner.id,{login,displayName:login,password,companies:['avokado'],permissions},hashPassword(password));
 authDb.close();
 const crmPort=await freePort(),contentPort=await freePort(),crmBase=`http://127.0.0.1:${crmPort}`,contentBase=`http://127.0.0.1:${contentPort}`;
 const preload=path.join(directory,'local-network-only.cjs');
 // The CRM cannot open outgoing connections. Content may reach only this fixture CRM.
 await fs.writeFile(preload,`
 'use strict';
 const fs=require('node:fs'),net=require('node:net');
 const allowed=process.env.REVIEWS_TEST_ALLOWED_ORIGIN?new URL(process.env.REVIEWS_TEST_ALLOWED_ORIGIN):null;
 function blocked(){fs.appendFileSync(${JSON.stringify(blockedNetwork)},'blocked\\n');throw new Error('External network disabled by reviews fixture');}
 const originalFetch=globalThis.fetch;
 globalThis.fetch=(input,options)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!allowed||url.origin!==allowed.origin)blocked();return originalFetch(input,options);};
 const originalConnect=net.Socket.prototype.connect;
 net.Socket.prototype.connect=function(...args){const values=Array.isArray(args[0])?args[0]:args;const options=typeof values[0]==='object'?values[0]:{port:values[0],host:typeof values[1]==='string'?values[1]:'localhost'};
  if(!allowed||options.host!==allowed.hostname||String(options.port)!==allowed.port)blocked();return originalConnect.apply(this,args);};
 require('node:tls').connect=blocked;
 `);
 async function start(file,env,base){let errors='';const child=spawn(process.execPath,['--require',preload,file],{env:{...process.env,...env},stdio:['ignore','ignore','pipe'],windowsHide:true});children.push(child);child.stderr.on('data',chunk=>errors+=chunk);
  for(let attempt=0;attempt<150;attempt++){if(child.exitCode!==null)throw Error('Service failed: '+errors);try{const response=await fetch(base+'/health',{signal:AbortSignal.timeout(500)});await response.text();return;}catch{await new Promise(resolve=>setTimeout(resolve,25));}}throw Error('Service not ready: '+errors);}
 await start(path.join(__dirname,'../crm/server.js'),{PORT:String(crmPort),DATABASE_PATH:crmDb,API_KEY:key,RATE_LIMIT_MAX:'10000',STRICT_ORIGIN:'',REVIEWS_TEST_ALLOWED_ORIGIN:'',LEADS_SMTP_HOST:'',LEADS_SMTP_PORT:'465',LEADS_SMTP_USER:'',LEADS_SMTP_PASSWORD:'',LEADS_MAIL_FROM:'',LEADS_NOTIFY_EMAIL:'',LEADS_NOTIFY_EMAIL_ALVI:'',LEADS_NOTIFY_EMAIL_AVOKADO:''},crmBase);
 await start(path.join(__dirname,'server.js'),{PORT:String(contentPort),DATABASE_PATH:contentDb,AUTH_USERS:'',API_KEY:'',CRM_URL:crmBase,CRM_API_KEY:key,SEED_DIR:directory,ASSETS_DIR:path.join(directory,'assets'),SESSION_SECRET:randomBytes(32).toString('hex'),REVIEWS_TEST_ALLOWED_ORIGIN:crmBase,HUGH_RUNNER_URL:'',CHAT_URL:'',CHAT_API_KEY:''},contentBase);
 const identity=(permissions=[],role='owner',companyCodes=[])=>Buffer.from(JSON.stringify({v:1,userId:1,role,permissions,companyCodes})).toString('base64url');
 async function request(base,route,{method='GET',body,headers={}}={}){const response=await fetch(base+route,{method,headers:{...headers,...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});const text=await response.text();return{status:response.status,body:text?JSON.parse(text):null,headers:response.headers};}
 const direct=(route,options={})=>request(crmBase,route,{...options,headers:{'x-api-key':key,'x-synapse-crm-identity':identity(),...options.headers}});
 for(const code of ['avokado','alvi'])assert.equal((await direct('/companies',{method:'POST',body:{code,name:'Local '+code}})).status,201);
 const sessions={};for(const login of ['owner','reader','writer','unrelated']){const result=await request(contentBase,'/content/login',{method:'POST',body:{login,password}});assert.equal(result.status,200);const cookie=result.headers.get('set-cookie').split(';')[0];const profile=await request(contentBase,'/content/whoami',{headers:{cookie}});sessions[login]={cookie,'x-csrf-token':profile.body.csrfToken};}
 const through=(who,route,options={})=>request(contentBase,'/content/crm'+route,{...options,headers:{...sessions[who],...options.headers}});
 const sourceUrl='https://2gis.ru/irkutsk/firm/123/tab/reviews';
 const review={platform:'two_gis',author:'Local reviewer',text:'AVOKADO REVIEW FIXTURE',sourceUrl,externalId:'fixture-review-001'};
 const platform={revision:0,cabinetUrl:sourceUrl,rules:'Обращаться на Вы. Проверить факты перед ответом.'};
 const routes=[['GET','/reviews',undefined],['POST','/reviews',review],['PATCH','/reviews/1',{revision:1,note:'Fixture'}],['PUT','/reviews/platforms/two_gis',platform]];
 for(const [method,route,body]of routes){
  const scoped=route+'?companyCode=avokado';
  assert.equal((await request(contentBase,'/content/crm'+scoped,{method,body,headers:{'x-api-key':key,'x-synapse-crm-identity':identity()}})).status,401);
  assert.equal((await request(crmBase,scoped,{method,body,headers:{'x-synapse-crm-identity':identity()}})).status,401);
  assert.equal((await request(crmBase,scoped,{method,body,headers:{'x-api-key':key}})).status,403);
  assert.equal((await through('unrelated',scoped,{method,body,headers:{'x-synapse-crm-identity':identity()}})).status,403,'client-supplied owner identity cannot override session permissions');
  assert.equal((await through('owner',route,{method,body})).status,400,'company must be explicitly selected');
  assert.equal((await direct(route,{method,body})).status,400);
  const who=method==='GET'?'reader':'writer';
  assert.equal((await through(who,route+'?companyCode=alvi',{method,body,headers:{'x-synapse-crm-identity':identity()}})).status,403);
  assert.equal((await direct(scoped,{method,body,headers:{'x-synapse-crm-identity':identity(['crm.view','crm.edit'],'editor',['alvi'])}})).status,403,'CRM also checks company membership');
  if(method!=='GET'){
   assert.equal((await through('reader',scoped,{method,body})).status,403);
   for(const csrf of ['', 'invalid-fixture-token'])assert.equal((await through('writer',scoped,{method,body,headers:{'x-csrf-token':csrf}})).status,403);
  }
 }
 const initial=await through('reader','/reviews?companyCode=avokado');assert.equal(initial.status,200);assert.equal(initial.body.company.code,'avokado');assert.equal(initial.body.company.name,'Local avokado');assert.deepEqual(initial.body.items,[]);assert.ok(initial.body.platforms);assert.ok(initial.body.counts);assert.match(initial.headers.get('cache-control'),/no-store/);
 assert.equal((await through('owner','/reviews?companyCode=missing')).status,404);
 const created=await through('writer','/reviews?companyCode=avokado',{method:'POST',body:review});assert.equal(created.status,201,JSON.stringify(created.body));assert.equal(created.body.duplicate,false);assert.equal(created.body.item.revision,1);assert.equal(created.body.item.status,'new');const ownId=created.body.item.id;
 const duplicate=await through('writer','/reviews?companyCode=avokado',{method:'POST',body:review});assert.equal(duplicate.status,200);assert.equal(duplicate.body.duplicate,true);assert.equal(duplicate.body.item.id,ownId);assert.equal(duplicate.body.item.revision,1);
 const foreign=await through('owner','/reviews?companyCode=alvi',{method:'POST',body:{...review,text:'PRIVATE ALVI REVIEW FIXTURE'}});assert.equal(foreign.status,201);assert.equal(foreign.body.duplicate,false);assert.notEqual(foreign.body.item.id,ownId);
 const ownList=await through('reader','/reviews?companyCode=avokado');assert.equal(ownList.status,200);assert.equal(ownList.body.items.length,1);assert.equal(ownList.body.items[0].id,ownId);assert.doesNotMatch(JSON.stringify(ownList.body),/PRIVATE ALVI/);
 const ownRoute=`/reviews/${ownId}?companyCode=avokado`,foreignRoute=`/reviews/${foreign.body.item.id}?companyCode=avokado`;
 for(const role of ['owner','writer']){const denied=await through(role,foreignRoute,{method:'PATCH',body:{revision:1,note:'Wrong scope'}});assert.equal(denied.status,404);assert.equal(denied.body.code,'NOT_FOUND');assert.doesNotMatch(JSON.stringify(denied.body),/PRIVATE ALVI/);}
 const edited=await through('writer',ownRoute,{method:'PATCH',body:{revision:1,status:'in_progress',draftReply:'Спасибо за отзыв! Проверим обстоятельства.',note:'Требуется проверка фактов.'}});assert.equal(edited.status,200);assert.equal(edited.body.item.revision,2);assert.equal(edited.body.item.status,'in_progress');assert.equal(edited.body.item.draftReply,'Спасибо за отзыв! Проверим обстоятельства.');
 const stale=await through('writer',ownRoute,{method:'PATCH',body:{revision:1,note:'Stale overwrite'}});assert.equal(stale.status,409);assert.equal(stale.body.code,'REVISION_CONFLICT');assert.match(stale.headers.get('cache-control'),/no-store/);assert.deepEqual(Object.keys(stale.body).sort(),['code','error']);
 const withoutEvidence=await through('writer',ownRoute,{method:'PATCH',body:{revision:2,status:'answered'}});assert.equal(withoutEvidence.status,400);assert.equal(withoutEvidence.body.code,'CONFIRMATION_REQUIRED');
 const invalidUrl=await through('writer',ownRoute,{method:'PATCH',body:{revision:2,status:'answered',publishedReply:'Спасибо за отзыв!',replyUrl:'https://example.test/review/123'}});assert.equal(invalidUrl.status,400);assert.equal(invalidUrl.body.code,'VALIDATION_ERROR');
 const answered=await through('writer',ownRoute,{method:'PATCH',body:{revision:2,status:'answered',publishedReply:'Спасибо за отзыв!',replyUrl:sourceUrl+'?review_id=fixture-review-001'}});assert.equal(answered.status,200);assert.equal(answered.body.item.status,'answered');assert.equal(answered.body.item.revision,3);assert.equal(answered.body.item.publishedReply,'Спасибо за отзыв!');
 const configured=await through('writer','/reviews/platforms/two_gis?companyCode=avokado',{method:'PUT',body:platform});assert.equal(configured.status,200,JSON.stringify(configured.body));assert.equal(configured.body.platform.revision,1);assert.equal(configured.body.platform.rules,platform.rules);
 const stalePlatform=await through('writer','/reviews/platforms/two_gis?companyCode=avokado',{method:'PUT',body:{...platform,rules:'Stale rules'}});assert.equal(stalePlatform.status,409);assert.equal(stalePlatform.body.code,'REVISION_CONFLICT');assert.match(stalePlatform.headers.get('cache-control'),/no-store/);
 const final=await through('reader','/reviews?companyCode=avokado');assert.equal(final.body.items.length,1);assert.equal(final.body.items[0].revision,3);assert.equal(final.body.items[0].note,'Требуется проверка фактов.');assert.doesNotMatch(JSON.stringify(final.body),/PRIVATE ALVI|Stale overwrite|Stale rules/);
 assert.equal(await fs.readFile(blockedNetwork,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;}),'','review CRUD must not attempt any external provider request');
});
