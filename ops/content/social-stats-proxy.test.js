'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomBytes}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {createAuthStore}=require('./auth-store'),{hashPassword}=require('./passwords');
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

test('аналитика соцсетей через прокси: analytics.view читает, настройки и импорт — только владелец, CSRF, изоляция компаний, без доступа — ни одной цифры, plan-summary и секреты закрыты',{timeout:60000},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'social-stats-http-')),children=[];
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

 // чтение
 assert.equal((await through('unrelated','/social-stats?companyCode=avokado')).status,403);
 assert.equal((await through('crmreader','/social-stats?companyCode=avokado')).status,403,'crm.view не даёт аналитику соцсетей');
 assert.equal((await through('analyst','/social-stats?companyCode=alvi')).status,403,'чужая компания');
 assert.equal((await through('owner','/social-stats')).status,400,'компания обязательна');
 const view=await through('analyst','/social-stats?companyCode=avokado&from=2026-09-01&to=2026-09-18');assert.equal(view.status,200,JSON.stringify(view.body));
 assert.equal(view.body.companyCode,'avokado');assert.equal(view.body.socialAggregate.reach,null);assert.equal(view.body.platforms.instagram.access.status,'not_configured');assert.match(view.headers.get('cache-control'),/no-store/);
 // Метрика использует те же границы компаний и отдельное право аналитики.
 const mr='/metrika/report?companyCode=avokado&from=2026-09-01&to=2026-09-24';
 const missingMetrika=await through('analyst',mr);
 assert.equal(missingMetrika.status,200);assert.equal(missingMetrika.body.status,'not_configured');assert.equal(missingMetrika.body.metrics,null);
 assert.equal((await through('crmreader',mr)).status,403);
 assert.equal((await through('unrelated',mr)).status,403);
 assert.equal((await through('analyst',mr.replace('avokado','alvi'))).status,403);
 assert.equal((await through('owner','/metrika/report')).status,400);
 assert.equal((await through('owner',mr,{method:'POST',body:{}})).status,405);
 assert.equal((await through('owner',mr.replace('2026-09-01','2026-02-30'))).status,400);
 // настройки — только владелец
 const accounts={accounts:[{platform:'instagram',accountRef:'@example.travel',provider:'direct',revision:0,timezone:'Asia/Bangkok'},{platform:'telegram',accountRef:'@ch',provider:'direct',revision:0}]};
 assert.equal((await through('writer','/social-stats/accounts?companyCode=avokado',{method:'PUT',body:accounts})).status,403,'crm.edit без роли владельца не настраивает');
 assert.equal((await through('owner','/social-stats/accounts?companyCode=avokado',{method:'PUT',body:accounts,headers:{'x-csrf-token':'bad'}})).status,403,'CSRF');
 const saved=await through('owner','/social-stats/accounts?companyCode=avokado',{method:'PUT',body:accounts});assert.equal(saved.status,200,JSON.stringify(saved.body));
 assert.equal(saved.body.accounts.find(a=>a.platform==='instagram').revision,1);
 assert.equal((await through('owner','/social-stats/accounts?companyCode=avokado',{method:'PUT',body:{accounts:[{platform:'vk',accountRef:'bearer abc',revision:0}]}})).status,400,'похоже на ключ — отказ');
 // сбор без доступа: честный статус, без чисел
 const ig=await through('writer','/social-stats/collect?companyCode=avokado',{method:'POST',body:{platform:'instagram'}});assert.equal(ig.status,200);assert.equal(ig.body.status,'missing_access');assert.ok(ig.body.missing.length>=2);
 const tg=await through('writer','/social-stats/collect?companyCode=avokado',{method:'POST',body:{platform:'telegram'}});assert.equal(tg.body.status,'missing_access','подключение Telegram не сохранено');
 assert.equal((await through('analyst','/social-stats/collect?companyCode=avokado',{method:'POST',body:{platform:'telegram'}})).status,403);
 const after=await through('analyst','/social-stats?companyCode=avokado&from=2026-09-01&to=2026-09-18');
 assert.equal(Object.keys(after.body.platforms.instagram.totals).length,0);assert.equal(after.body.platforms.instagram.lastRun.status,'missing_access');assert.equal(after.body.runs.length,2);
 // ручной импорт — владелец; чужая компания не видит
 assert.equal((await through('writer','/social-stats/import?companyCode=avokado',{method:'POST',body:{platform:'instagram',capturedAt:'2026-09-18T01:00:00Z',sourceNote:'скриншот',rows:[{date:'2026-09-17',metric:'views',value:900}]}})).status,403);
 const imported=await through('owner','/social-stats/import?companyCode=avokado',{method:'POST',body:{platform:'instagram',capturedAt:'2026-09-18T01:00:00Z',sourceNote:'скриншот Insights',rows:[{date:'2026-09-17',metric:'views',value:900}]}});
 assert.equal(imported.status,200,JSON.stringify(imported.body));assert.equal(imported.body.rows,1);
 assert.equal((await through('analyst','/social-stats?companyCode=avokado&from=2026-09-17&to=2026-09-17')).body.platforms.instagram.totals.views,900);
 assert.equal((await through('owner','/social-stats?companyCode=alvi&from=2026-09-17&to=2026-09-17')).body.socialAggregate.views,null,'другая компания не видит');
 assert.doesNotMatch(JSON.stringify(after.body),/token|Bearer|op_[a-f0-9]/i);
 // Закреплённый замер «до» читает аналитик только своей компании, а создаёт владелец с CSRF.
 const baselineRoute='/social-stats/baseline?companyCode=avokado';
 const baselineBody={cutoverDate:'2026-09-19',from:'2026-09-17',to:'2026-09-17',sourceNote:'Дата начала по плану владельца',confirmedStart:true};
 assert.equal((await through('writer',baselineRoute,{method:'POST',body:baselineBody})).status,403);
 assert.equal((await through('analyst',baselineRoute,{method:'POST',body:baselineBody})).status,403);
 assert.equal((await through('owner',baselineRoute,{method:'POST',body:baselineBody,headers:{'x-csrf-token':'bad'}})).status,403);
 assert.equal((await through('owner',baselineRoute,{method:'POST',body:{...baselineBody,confirmedStart:false}})).status,400);
 const frozen=await through('owner',baselineRoute,{method:'POST',body:baselineBody});
 assert.equal(frozen.status,200,JSON.stringify(frozen.body));assert.equal(frozen.body.version,1);
 assert.equal(frozen.body.snapshot.platforms.instagram.totals.views,900);
 assert.equal((await through('owner',baselineRoute,{method:'POST',body:baselineBody})).body.unchanged,true);
 assert.equal((await through('analyst',baselineRoute)).body.latest.version,1);
 assert.equal((await through('analyst','/social-stats/baseline?companyCode=alvi')).status,403);
 assert.equal((await through('crmreader',baselineRoute)).status,403);
 assert.equal((await through('analyst','/social-stats/baseline?companyCode=avokado&version=99')).status,404);
 const updated=await through('owner','/social-stats/import?companyCode=avokado',{method:'POST',body:{platform:'instagram',capturedAt:'2026-09-18T02:00:00Z',sourceNote:'проверенная выгрузка',rows:[{date:'2026-09-17',metric:'views',value:950}]}});
 assert.equal(updated.status,200);
 const refrozen=await through('owner',baselineRoute,{method:'POST',body:baselineBody});assert.equal(refrozen.body.version,2);
 assert.equal(refrozen.body.snapshot.platforms.instagram.totals.views,950);
 assert.equal((await through('analyst',baselineRoute+'&version=1')).body.latest.snapshot.platforms.instagram.totals.views,900,'первая версия неизменна');
 // служебная сводка плана из кабинета недоступна, по ключу сервиса — доступна
 assert.equal((await through('owner','/autoposting/plan-summary?companyCode=avokado')).status,404);
 assert.equal((await direct('/autoposting/plan-summary?companyCode=avokado')).status,200);
});
