'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomBytes}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {createAuthStore}=require('./auth-store'),{hashPassword}=require('./passwords');
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

test('real content to CRM demand imports enforce analytics permission, organization and company scope, CSRF and idempotency without external requests',{timeout:45000},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'platform-demand-http-')),children=[];
 const contentDb=path.join(directory,'content.sqlite'),crmDb=path.join(directory,'crm.sqlite'),blockedNetwork=path.join(directory,'blocked-network.log');
 const password='Local-demand-fixture-password',key=randomBytes(32).toString('hex');
 t.after(async()=>{
  for(const child of children.reverse())if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(directory,{recursive:true,force:true});
 });
 const authDb=new DatabaseSync(contentDb),auth=createAuthStore(authDb,`owner:owner:${hashPassword(password)}`),owner=auth.getByLogin('owner');
 for(const [login,permissions]of [['analyst',['analytics.view']],['crmreader',['crm.view']],['writer',['crm.edit']],['unrelated',['autoposting.view','autoposting.edit']]])
  auth.create(owner.id,{login,displayName:login,password,companies:['avokado'],permissions},hashPassword(password));
 authDb.close();
 const crmPort=await freePort(),contentPort=await freePort(),crmBase=`http://127.0.0.1:${crmPort}`,contentBase=`http://127.0.0.1:${contentPort}`;
 const preload=path.join(directory,'local-network-only.cjs');
 await fs.writeFile(preload,`
 'use strict';
 const fs=require('node:fs'),net=require('node:net');
 const allowed=process.env.DEMAND_TEST_ALLOWED_ORIGIN?new URL(process.env.DEMAND_TEST_ALLOWED_ORIGIN):null;
 function blocked(){fs.appendFileSync(${JSON.stringify(blockedNetwork)},'blocked\\n');throw new Error('External network disabled by demand fixture');}
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
 const sessions={};for(const login of ['owner','analyst','crmreader','writer','unrelated']){const result=await request(contentBase,'/content/login',{method:'POST',body:{login,password}});assert.equal(result.status,200);const cookie=result.headers.get('set-cookie').split(';')[0];const profile=await request(contentBase,'/content/whoami',{headers:{cookie}});sessions[login]={cookie,'x-csrf-token':profile.body.csrfToken};}
 const through=(who,route,options={})=>request(contentBase,'/content/crm'+route,{...options,headers:{...sessions[who],...options.headers}});
 const cabinetUrl='https://account.2gis.com/orgs/12345/statistics/demand';
 const settings={revision:0,organizationId:'12345',organizationName:'Студия',city:'Иркутск',cabinetUrl};
 const imported={organizationId:'12345',organizationName:'Студия',city:'Иркутск',sourceUrl:cabinetUrl,reportKind:'rubric_demand',periodStart:'2026-08-01',periodEnd:'2026-08-31',granularity:'month',capturedAt:'2026-09-01T12:00:00Z',originalFilename:'demand.xls',rows:[{periodStart:'2026-08-01',periodEnd:'2026-08-31',category:'Массаж',metric:'searches',value:20,partial:false}]};
 const categories={revision:0,items:[{category:'Массаж',classification:'target',reason:'Наш профиль'}]};
 const routes=[['GET','/platform-demand',undefined],['GET','/platform-demand/datasets/1',undefined],['PUT','/platform-demand/settings',settings],['POST','/platform-demand/import',imported],['PUT','/platform-demand/categories',categories]];
 for(const [method,route,body]of routes){
  const scoped=route+'?companyCode=avokado';
  assert.equal((await request(contentBase,'/content/crm'+scoped,{method,body,headers:{'x-api-key':key,'x-synapse-crm-identity':identity()}})).status,401);
  assert.equal((await request(crmBase,scoped,{method,body,headers:{'x-synapse-crm-identity':identity()}})).status,401);
  assert.equal((await request(crmBase,scoped,{method,body,headers:{'x-api-key':key}})).status,403);
  assert.equal((await through('unrelated',scoped,{method,body,headers:{'x-synapse-crm-identity':identity()}})).status,403);
  assert.equal((await through('owner',route,{method,body})).status,400,'company must be explicitly selected');
  assert.equal((await direct(route,{method,body})).status,400);
  const who=method==='GET'?'analyst':'writer',permission=method==='GET'?'analytics.view':'crm.edit';
  assert.equal((await through(who,route+'?companyCode=alvi',{method,body,headers:{'x-synapse-crm-identity':identity()}})).status,403,'forged owner headers cannot bypass the session company');
  assert.equal((await direct(scoped,{method,body,headers:{'x-synapse-crm-identity':identity([permission],'editor',['alvi'])}})).status,403,'CRM independently enforces company scope');
  if(method==='GET'){
   for(const name of ['crmreader','writer'])assert.equal((await through(name,scoped)).status,403,'CRM permissions alone do not grant demand analytics');
   assert.equal((await direct(scoped,{headers:{'x-synapse-crm-identity':identity(['crm.view','crm.edit'],'editor',['avokado'])}})).status,403);
  }else{
   for(const name of ['analyst','crmreader'])assert.equal((await through(name,scoped,{method,body})).status,403,'analytics viewing does not grant writes');
   for(const csrf of ['', 'invalid-fixture-token'])assert.equal((await through('writer',scoped,{method,body,headers:{'x-csrf-token':csrf}})).status,403);
  }
 }
 const initial=await through('analyst','/platform-demand?companyCode=avokado');assert.equal(initial.status,200,JSON.stringify(initial.body));assert.equal(initial.body.company.code,'avokado');assert.deepEqual(initial.body.datasets,[]);assert.deepEqual(initial.body.categories.items,[]);assert.match(initial.headers.get('cache-control'),/no-store/);
 assert.equal((await through('owner','/platform-demand?companyCode=missing')).status,404);
 const unconfigured=await through('writer','/platform-demand/import?companyCode=avokado',{method:'POST',body:imported});assert.equal(unconfigured.status,409);assert.equal(unconfigured.body.code,'CONFIGURATION_REQUIRED');
 const saved=await through('writer','/platform-demand/settings?companyCode=avokado',{method:'PUT',body:settings});assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.settings.revision,1);assert.equal(saved.body.settings.organizationId,'12345');
 const stale=await through('writer','/platform-demand/settings?companyCode=avokado',{method:'PUT',body:{...settings,organizationName:'Stale overwrite'}});assert.equal(stale.status,409);assert.equal(stale.body.code,'REVISION_CONFLICT');assert.match(stale.headers.get('cache-control'),/no-store/);assert.deepEqual(Object.keys(stale.body).sort(),['code','error']);
 const wrongOrg=await through('writer','/platform-demand/import?companyCode=avokado',{method:'POST',body:{...imported,organizationId:'67890',sourceUrl:'https://account.2gis.com/orgs/67890/statistics/demand'}});assert.equal(wrongOrg.status,409);assert.equal(wrongOrg.body.code,'ORG_MISMATCH');
 const invalid=await through('writer','/platform-demand/import?companyCode=avokado',{method:'POST',body:{...imported,rows:[{...imported.rows[0],value:-1}]}});assert.equal(invalid.status,400);assert.equal(invalid.body.code,'VALIDATION_ERROR');
 const first=await through('writer','/platform-demand/import?companyCode=avokado',{method:'POST',body:imported});assert.equal(first.status,201,JSON.stringify(first.body));assert.equal(first.body.duplicate,false);assert.ok(first.body.dataset.id);
 const repeat=await through('writer','/platform-demand/import?companyCode=avokado',{method:'POST',body:imported});assert.equal(repeat.status,200);assert.equal(repeat.body.duplicate,true);assert.equal(repeat.body.dataset.id,first.body.dataset.id);
 const classified=await through('writer','/platform-demand/categories?companyCode=avokado',{method:'PUT',body:categories});assert.equal(classified.status,200,JSON.stringify(classified.body));assert.equal(classified.body.categories.revision,1);assert.deepEqual(classified.body.categories.items,categories.items);
 const staleCategories=await through('writer','/platform-demand/categories?companyCode=avokado',{method:'PUT',body:{...categories,items:[]}});assert.equal(staleCategories.status,409);assert.equal(staleCategories.body.code,'REVISION_CONFLICT');
 const otherSettings={...settings,organizationId:'67890',organizationName:'PRIVATE ALVI STUDIO',cabinetUrl:'https://account.2gis.com/orgs/67890/statistics/demand'};
 assert.equal((await through('owner','/platform-demand/settings?companyCode=alvi',{method:'PUT',body:otherSettings})).status,200);
 const otherImport={...imported,organizationId:'67890',organizationName:'PRIVATE ALVI STUDIO',sourceUrl:otherSettings.cabinetUrl,rows:[{...imported.rows[0],category:'PRIVATE ALVI CATEGORY',value:55}]};
 const foreign=await through('owner','/platform-demand/import?companyCode=alvi',{method:'POST',body:otherImport});assert.equal(foreign.status,201);assert.equal(foreign.body.duplicate,false);assert.notEqual(foreign.body.dataset.id,first.body.dataset.id);
 const foreignDuplicate=await through('owner','/platform-demand/import?companyCode=alvi',{method:'POST',body:otherImport});assert.equal(foreignDuplicate.status,200);assert.equal(foreignDuplicate.body.duplicate,true);
 const own=await through('analyst','/platform-demand?companyCode=avokado');assert.equal(own.status,200);assert.equal(own.body.datasets.length,1);assert.equal(own.body.datasets[0].id,first.body.dataset.id);assert.equal(own.body.settings.organizationId,'12345');assert.equal(own.body.settings.organizationName,'Студия');assert.equal(own.body.categories.revision,1);assert.deepEqual(own.body.categories.items,categories.items);assert.ok(own.body.summary);assert.ok(Array.isArray(own.body.history));assert.doesNotMatch(JSON.stringify(own.body),/PRIVATE ALVI|Stale overwrite/);
 const detail=await through('analyst',`/platform-demand/datasets/${first.body.dataset.id}?companyCode=avokado`);assert.equal(detail.status,200);assert.equal(detail.body.dataset.id,first.body.dataset.id);assert.equal(detail.body.dataset.rows[0].value,20);
 for(const who of ['owner','analyst']){const cross=await through(who,`/platform-demand/datasets/${foreign.body.dataset.id}?companyCode=avokado`);assert.equal(cross.status,404);assert.equal(cross.body.code,'NOT_FOUND');assert.doesNotMatch(JSON.stringify(cross.body),/PRIVATE ALVI/);}
 const other=await through('owner','/platform-demand?companyCode=alvi');assert.equal(other.body.datasets.length,1);assert.equal(other.body.datasets[0].id,foreign.body.dataset.id);assert.deepEqual(other.body.categories.items,[{category:'PRIVATE ALVI CATEGORY',classification:'unclassified',reason:''}],'category classifications do not leak between companies');
 // Explicitly selecting the same organization for two companies must not merge their imports.
 const sameOrganization=await through('owner','/platform-demand/settings?companyCode=alvi',{method:'PUT',body:{...settings,revision:1}});assert.equal(sameOrganization.status,200);
 const previousOrganization=await through('owner',`/platform-demand/datasets/${foreign.body.dataset.id}?companyCode=alvi`);assert.equal(previousOrganization.status,404);assert.equal(previousOrganization.body.code,'NOT_FOUND','old organization snapshots are not returned under new settings');
 const independentlyImported=await through('owner','/platform-demand/import?companyCode=alvi',{method:'POST',body:imported});assert.equal(independentlyImported.status,201);assert.equal(independentlyImported.body.duplicate,false);assert.notEqual(independentlyImported.body.dataset.id,first.body.dataset.id);
 const unchanged=await through('analyst','/platform-demand?companyCode=avokado');assert.equal(unchanged.body.datasets.length,1);assert.equal(unchanged.body.datasets[0].id,first.body.dataset.id);assert.deepEqual(unchanged.body.categories.items,categories.items);
 assert.equal(await fs.readFile(blockedNetwork,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;}),'','manual imports and settings never attempt a provider connection');
});
