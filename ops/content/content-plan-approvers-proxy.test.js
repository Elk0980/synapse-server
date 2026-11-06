'use strict';
/* №98 Б: согласующие контент-плана из «Настроек → Контент» через настоящий прокси content и CRM.
   Лена и Таня (просмотр + content-plan.approve) ставят свои отметки; план «к СММ» только когда отметили все
   назначенные; чужой компании и подделанному заголовку из браузера список не подменить. Данные SAMPLE. */
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomBytes}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {createAuthStore}=require('./auth-store'),{hashPassword}=require('./passwords');
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

test('согласующие из «Настроек → Контент» через прокси: свои отметки, все назначенные, изоляция компаний',{timeout:60000},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'approvers-http-')),children=[];
 const contentDb=path.join(directory,'content.sqlite'),crmDb=path.join(directory,'crm.sqlite'),blockedNetwork=path.join(directory,'blocked-network.log');
 const password='Local-approvers-fixture-password',key=randomBytes(32).toString('hex');
 t.after(async()=>{
  for(const child of children.reverse())if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(directory,{recursive:true,force:true});
 });
 const authDb=new DatabaseSync(contentDb),auth=createAuthStore(authDb,`owner:owner:${hashPassword(password)}`),owner=auth.getByLogin('owner');
 const made={};for(const [login,companies,permissions]of [['lena',['avokado'],['autoposting.view','content-plan.approve']],['tanya',['avokado'],['autoposting.view','content-plan.approve']],
  ['viewer',['avokado'],['autoposting.view']],['alien',['alvi'],['autoposting.view','content-plan.approve']]])
  made[login]=auth.create(owner.id,{login,displayName:'SAMPLE '+login,password,companies,permissions},hashPassword(password));
 // «Настройки → Контент» (контракт А): строка content_settings; таблицу создаёт модуль А, здесь — та же схема.
 authDb.exec('CREATE TABLE IF NOT EXISTS content_settings(company_code TEXT PRIMARY KEY,body TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL,updated_by INTEGER NOT NULL)');
 const ids=['lena','tanya','alien'].map(l=>auth.getByLogin(l).id);
 authDb.prepare('INSERT INTO content_settings VALUES(?,?,1,?,?)').run('avokado',JSON.stringify({approverUserIds:ids,shootingWeekdays:[],deadlineDays:2,platforms:[],caption:{font:'Inter',size:'m',color:'#ffffff',uppercase:false}}),new Date().toISOString(),owner.id);
 authDb.close();
 const crmPort=await freePort(),contentPort=await freePort(),crmBase=`http://127.0.0.1:${crmPort}`,contentBase=`http://127.0.0.1:${contentPort}`;
 const preload=path.join(directory,'local-network-only.cjs');
 await fs.writeFile(preload,`
 'use strict';
 const fs=require('node:fs'),net=require('node:net');
 const allowed=process.env.DEMAND_TEST_ALLOWED_ORIGIN?new URL(process.env.DEMAND_TEST_ALLOWED_ORIGIN):null;
 function blocked(){fs.appendFileSync(${JSON.stringify(blockedNetwork)},'blocked\\n');throw new Error('External network disabled by approvers fixture');}
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
 const sessions={};for(const login of ['owner','lena','tanya','viewer','alien']){const result=await request(contentBase,'/content/login',{method:'POST',body:{login,password}});assert.equal(result.status,200);
  const cookie=result.headers.get('set-cookie').split(';')[0];const profile=await request(contentBase,'/content/whoami',{headers:{cookie}});sessions[login]={cookie,'x-csrf-token':profile.body.csrfToken};}
 const through=(who,route,options={})=>request(contentBase,'/content/crm'+route,{...options,headers:{...sessions[who],...options.headers}});

 const day=i=>({date:`2026-11-${String(9+i).padStart(2,'0')}`,platform:'vk',format:'reel',role:'reach',topic:`SAMPLE ${i}`,hook:'SAMPLE хук',variants:{vk:{text:'SAMPLE подпись'}}});
 assert.equal((await through('owner','/media-mentor/brief?companyCode=avokado',{method:'PUT',body:{revision:0,brief:{platforms:['vk']}}})).status,200);
 const saved=await through('owner','/media-mentor/plan?companyCode=avokado',{method:'PUT',body:{planRevision:0,briefRevision:1,days:[0,1,2].map(day)}});
 assert.equal(saved.status,200,JSON.stringify(saved.body));
 const S='/media-mentor/plan/signoffs?companyCode=avokado';
 let state=(await through('lena',S)).body;
 assert.equal(state.approversSource,'settings');
 // В списке только люди этой компании с правом согласования: «alien» из другой компании отброшен.
 assert.deepEqual(state.approvers.map(a=>a.label),['SAMPLE lena','SAMPLE tanya']);
 const tick=(who,slot,extra={})=>through(who,S,{method:'POST',body:{planRevision:state.planRevision,briefRevision:state.briefRevision,slot,checked:true},...extra});
 const lenaSlot=state.approvers[0].slot,tanyaSlot=state.approvers[1].slot;
 assert.equal((await tick('viewer',lenaSlot)).status,403,'без content-plan.approve');
 assert.equal((await tick('tanya',lenaSlot)).status,403,'только свою отметку');
 assert.equal((await tick('owner','owner')).status,404,'при назначенных согласующих отметка владельца план не утверждает');
 // Подделанный заголовок из браузера удаляется прокси: viewer не становится согласующим.
 const forged=Buffer.from(JSON.stringify([{userId:1,label:'x'}])).toString('base64url');
 assert.equal((await through('owner',S,{headers:{'x-synapse-content-approvers':forged}})).body.approvers.length,2);
 assert.equal((await tick('lena',lenaSlot,{headers:{...sessions.lena,'x-csrf-token':'bad'}})).status,403,'CSRF обязателен');
 let result=await tick('lena',lenaSlot);assert.equal(result.status,200,JSON.stringify(result.body));
 assert.equal(result.body.stage,'approval');assert.equal(result.body.approvedIdeas,0,'одна отметка из двух план не утверждает');
 result=await tick('tanya',tanyaSlot);assert.equal(result.status,200);
 assert.equal(result.body.stage,'smm');assert.equal(result.body.approvedIdeas,3);
 // Чужая компания: другой список и нет доступа.
 assert.equal((await through('lena','/media-mentor/plan/signoffs?companyCode=alvi')).status,403);
 assert.equal((await through('alien','/media-mentor/plan/signoffs?companyCode=alvi')).body.approvers[0].slot,'owner');
});
