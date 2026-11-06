'use strict';
/* specs/209-cf-stages: факты съёмки доходят до CRM только от прокси content. Настоящие content и CRM.
   Заголовок фактов из браузера удаляется; этап «Отснято» и часовой пояс компании приходят в ответе плана. Данные SAMPLE. */
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomBytes}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {createAuthStore}=require('./auth-store'),{hashPassword}=require('./passwords');
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

test('этап идеи через прокси: факты съёмки только от content, подделка из браузера удаляется, часовой пояс компании',{timeout:60000},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'stages-http-')),children=[];
 const contentDb=path.join(directory,'content.sqlite'),crmDb=path.join(directory,'crm.sqlite');
 const password='Local-stages-fixture-password',key=randomBytes(32).toString('hex');
 t.after(async()=>{
  for(const child of children.reverse())if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(directory,{recursive:true,force:true});
 });
 const authDb=new DatabaseSync(contentDb),auth=createAuthStore(authDb,`owner:owner:${hashPassword(password)}`),owner=auth.getByLogin('owner');
 auth.create(owner.id,{login:'smm',displayName:'SAMPLE smm',password,companies:['avokado'],permissions:['autoposting.view','autoposting.edit']},hashPassword(password));
 authDb.close();
 const crmPort=await freePort(),contentPort=await freePort(),crmBase=`http://127.0.0.1:${crmPort}`,contentBase=`http://127.0.0.1:${contentPort}`;
 async function start(file,env,base){let errors='';const child=spawn(process.execPath,[file],{env:{...process.env,...env},stdio:['ignore','ignore','pipe'],windowsHide:true});children.push(child);child.stderr.on('data',chunk=>errors+=chunk);
  for(let attempt=0;attempt<150;attempt++){if(child.exitCode!==null)throw Error('Service failed: '+errors);try{const response=await fetch(base+'/health',{signal:AbortSignal.timeout(500)});await response.text();return;}catch{await new Promise(resolve=>setTimeout(resolve,25));}}throw Error('Service not ready: '+errors);}
 await start(path.join(__dirname,'../crm/server.js'),{PORT:String(crmPort),DATABASE_PATH:crmDb,API_KEY:key,RATE_LIMIT_MAX:'10000',STRICT_ORIGIN:'',LEADS_SMTP_HOST:'',LEADS_SMTP_PORT:'465',LEADS_SMTP_USER:'',LEADS_SMTP_PASSWORD:'',LEADS_MAIL_FROM:'',LEADS_NOTIFY_EMAIL:'',LEADS_NOTIFY_EMAIL_ALVI:'',LEADS_NOTIFY_EMAIL_AVOKADO:''},crmBase);
 await start(path.join(__dirname,'server.js'),{PORT:String(contentPort),DATABASE_PATH:contentDb,AUTH_USERS:'',API_KEY:'',CRM_URL:crmBase,CRM_API_KEY:key,SEED_DIR:directory,ASSETS_DIR:path.join(directory,'assets'),SESSION_SECRET:randomBytes(32).toString('hex'),HUGH_RUNNER_URL:'',CHAT_URL:'',CHAT_API_KEY:''},contentBase);
 const identity=Buffer.from(JSON.stringify({v:1,userId:1,role:'owner',permissions:[],companyCodes:[]})).toString('base64url');
 async function request(base,route,{method='GET',body,headers={}}={}){const response=await fetch(base+route,{method,headers:{...headers,...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});const text=await response.text();return{status:response.status,body:text?JSON.parse(text):null,headers:response.headers};}
 const direct=(route,options={})=>request(crmBase,route,{...options,headers:{'x-api-key':key,'x-synapse-crm-identity':identity,...options.headers}});
 for(const code of ['avokado','alvi'])assert.equal((await direct('/companies',{method:'POST',body:{code,name:'Local '+code}})).status,201);
 const crm=new DatabaseSync(crmDb);crm.prepare("UPDATE companies SET timezone='Asia/Irkutsk' WHERE code='avokado'").run();crm.close();
 const sessions={};for(const login of ['owner','smm']){const result=await request(contentBase,'/content/login',{method:'POST',body:{login,password}});assert.equal(result.status,200);
  const cookie=result.headers.get('set-cookie').split(';')[0];const profile=await request(contentBase,'/content/whoami',{headers:{cookie}});sessions[login]={cookie,'x-csrf-token':profile.body.csrfToken};}
 const through=(who,route,options={})=>request(contentBase,'/content/crm'+route,{...options,headers:{...sessions[who],...options.headers}});
 const day=i=>({ideaId:`sample-${i}`,date:`2026-11-${String(9+i).padStart(2,'0')}`,platform:'vk',format:'reel',role:'reach',topic:`SAMPLE ${i}`,hook:'',variants:{vk:{text:'SAMPLE подпись'}}});
 assert.equal((await through('owner','/media-mentor/brief?companyCode=avokado',{method:'PUT',body:{revision:0,brief:{platforms:['vk']}}})).status,200);
 assert.equal((await through('owner','/media-mentor/plan?companyCode=avokado',{method:'PUT',body:{planRevision:0,briefRevision:1,days:[0,1,2].map(day)}})).status,200);
 // Съёмка: у sample-1 загружен дубль (раскадровки нет) — по правилу summary() это «Отснято».
 const content=new DatabaseSync(contentDb);
 content.prepare(`INSERT INTO shooting_uploads(company_code,idea_id,frame,kind,name,mime,size,disk_key,status,created_by,created_at)
   VALUES('avokado','sample-1',1,'take','a.mov','video/quicktime',1,'sample-key','stored','SAMPLE','2026-11-07T00:00:00Z')`).run();
 content.close();
 const forged=Buffer.from(JSON.stringify({v:1,companyCode:'avokado',reels:{'sample-0':[0,0,0,0,'editing']}})).toString('base64url');
 const plan=await through('smm','/media-mentor?companyCode=avokado',{headers:{'x-synapse-shooting-facts':forged}});
 assert.equal(plan.status,200,JSON.stringify(plan.body));
 const stages=Object.fromEntries(plan.body.plan.days.map(d=>[d.ideaId,d.stage]));
 assert.equal(stages['sample-1'],'shot');
 assert.equal(stages['sample-0'],'script_review','подделанный заголовок браузера удалён прокси');
 assert.equal(plan.body.plan.stageFacts.shooting,true);
 assert.deepEqual(plan.body.company,{code:'avokado',timeZone:'Asia/Irkutsk',timeZoneSource:'company'});
 // Сохранение плана, присланного обратно целиком с вычисленными полями, проходит и не создаёт новую версию.
 const echoed=await through('owner','/media-mentor/plan?companyCode=avokado',{method:'PUT',body:{planRevision:plan.body.plan.revision,briefRevision:1,days:plan.body.plan.days}});
 assert.equal(echoed.status,200,JSON.stringify(echoed.body));assert.equal(echoed.body.plan.revision,plan.body.plan.revision);
 // Прямой вызов CRM с ключом сервиса без фактов: этапы есть, но съёмка честно помечена недоступной.
 const raw=await direct('/media-mentor?companyCode=avokado');
 assert.equal(raw.body.plan.stageFacts.shooting,false);
});
