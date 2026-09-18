'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomBytes}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {createAuthStore}=require('./auth-store'),{hashPassword}=require('./passwords');
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

// Подтверждение внешней публикации через существующий прокси кабинета: владелец компании, CSRF, изоляция компаний,
// проверка ссылки, идемпотентность, устаревшая версия содержимого и запрет повторной отправки отмеченной площадки.
test('подтверждение внешней публикации через прокси: только владелец и CSRF, чужая компания закрыта, ссылка проверяется, повтор идемпотентен, отправка не запускается',{timeout:60000},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'receipts-http-')),children=[];
 const contentDb=path.join(directory,'content.sqlite'),crmDb=path.join(directory,'crm.sqlite'),blockedNetwork=path.join(directory,'blocked-network.log');
 const password='Local-receipts-fixture-password',key=randomBytes(32).toString('hex');
 t.after(async()=>{
  for(const child of children.reverse())if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(directory,{recursive:true,force:true});
 });
 const authDb=new DatabaseSync(contentDb),auth=createAuthStore(authDb,`owner:owner:${hashPassword(password)}`),owner=auth.getByLogin('owner');
 for(const [login,permissions]of [['editor',['autoposting.view','autoposting.edit']],['viewer',['autoposting.view']]])
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
 const sessions={};for(const login of ['owner','editor','viewer']){const result=await request(contentBase,'/content/login',{method:'POST',body:{login,password}});assert.equal(result.status,200);
  const cookie=result.headers.get('set-cookie').split(';')[0];const profile=await request(contentBase,'/content/whoami',{headers:{cookie}});sessions[login]={cookie,'x-csrf-token':profile.body.csrfToken};}
 const through=(who,route,options={})=>request(contentBase,'/content/crm'+route,{...options,headers:{...sessions[who],...options.headers}});

 const profile=await through('owner','/company-information?companyCode=avokado');assert.equal(profile.status,200);
 const revision=profile.body.revision;
 const scheduledAt=new Date(Date.now()+3600000).toISOString().replace(/\.\d{3}Z$/,'.000Z');
 const created=await through('owner','/autoposting/posts?companyCode=avokado',{method:'POST',
  body:{title:'Утро на побережье',text:'Опубликовано через внешний сервис',platformIds:['telegram'],scheduledAt,timezone:'Asia/Bangkok',profileRevision:revision}});
 assert.equal(created.status,201,JSON.stringify(created.body));
 const post=created.body;assert.deepEqual(post.externalReceipts,[]);
 const other=await through('owner','/autoposting/posts?companyCode=alvi',{method:'POST',body:{title:'Чужая карточка',text:'Текст',profileRevision:(await through('owner','/company-information?companyCode=alvi')).body.revision}});
 assert.equal(other.status,201);
 const receipt={platform:'telegram',url:'https://t.me/taisabai/512',publishedAt:'2026-09-17T09:30:00.000Z',contentRevision:post.contentRevision};
 const route=(id,code)=>`/autoposting/posts/${id}/receipts?companyCode=${code}`;

 // права и CSRF
 assert.equal((await through('editor',route(post.id,'avokado'),{method:'POST',body:receipt})).status,403,'редактор не отмечает публикацию вне ЛК');
 assert.equal((await through('viewer',route(post.id,'avokado'),{method:'POST',body:receipt})).status,403);
 assert.equal((await through('owner',route(post.id,'avokado'),{method:'POST',body:receipt,headers:{'x-csrf-token':'bad'}})).status,403,'CSRF обязателен');
 assert.equal((await through('editor',route(other.body.id,'alvi'),{method:'POST',body:receipt})).status,403,'чужая компания закрыта редактору');
 assert.equal((await through('owner',route(post.id,'alvi'),{method:'POST',body:{...receipt,contentRevision:other.body.contentRevision}})).status,404,'карточка другой компании не найдена');
 assert.equal((await through('owner',route(post.id,'avokado'),{method:'GET'})).status,405);

 // ссылки: только https, только домен площадки, без учётных данных, разметки и параметров с токеном
 for(const url of ['http://t.me/taisabai/512','https://t.me.attacker.example/taisabai/512','https://user:pass@t.me/taisabai/512',
  'javascript:alert(1)','https://t.me/taisabai/512?token=secret','https://t.me/taisabai/512#session','https://t.me/taisabai',
  'https://t.me:8443/taisabai/512','<a href=x>']){
  const rejected=await through('owner',route(post.id,'avokado'),{method:'POST',body:{...receipt,url}});
  assert.equal(rejected.status,400,url);assert.doesNotMatch(JSON.stringify(rejected.body),/secret|attacker/,url);
 }
 // значения разрешённых параметров сверяются с форматом; повтор, лишний параметр и короткие ссылки отклоняются
 for(const [platform,url] of [['youtube_shorts','https://www.youtube.com/shorts/abcdefghi12?t=TOKEN'],
  ['youtube_shorts','https://www.youtube.com/watch?v=abcdefghi12&t=TOKEN'],['youtube_shorts','https://www.youtube.com/watch?v=abcdefghi12&v=other'],
  ['youtube_shorts','https://youtu.be/abcdefghi12'],['vk','https://vk.com/wall-1_2?z=SECRET'],['vk','https://vk.com/club1?w=SECRET'],
  ['tiktok','https://vm.tiktok.com/ZMabcdef/'],['instagram','https://www.instagram.com/p/AbCdEfGhIjK/?igsh=SESSION']]){
  const rejected=await through('owner',route(post.id,'avokado'),{method:'POST',body:{...receipt,platform,url}});
  assert.equal(rejected.status,400,`${platform} ${url}`);assert.doesNotMatch(JSON.stringify(rejected.body),/TOKEN|SECRET|SESSION/,url);
 }
 const canonical=await through('owner',route(post.id,'avokado'),{method:'POST',body:{...receipt,platform:'youtube_shorts',url:'https://www.youtube.com/watch?v=abcdefghi12'}});
 assert.equal(canonical.status,201,JSON.stringify(canonical.body));
 assert.equal(canonical.body.externalReceipts.find(item=>item.platform==='youtube_shorts').url,'https://www.youtube.com/watch?v=abcdefghi12');
 assert.equal((await through('owner',route(post.id,'avokado'),{method:'POST',body:{...receipt,contentRevision:post.contentRevision+5}})).status,409,'устаревшая версия содержимого');
 assert.equal((await through('owner',route(post.id,'avokado'),{method:'POST',body:{...receipt,publishedAt:new Date(Date.now()+86400000).toISOString().replace(/\.\d{3}Z$/,'.000Z')}})).status,400,'запланированное не считается опубликованным');

 // сохранение подтверждения: ничего не отправляется, одобрение и статус не меняются
 const saved=await through('owner',route(post.id,'avokado'),{method:'POST',body:receipt});
 assert.equal(saved.status,201,JSON.stringify(saved.body));
 const telegram=body=>body.externalReceipts.find(item=>item.platform==='telegram');
 assert.equal(saved.body.status,'draft');assert.equal(saved.body.approval.approved,false);assert.deepEqual(saved.body.deliveries,[]);
 assert.equal(saved.body.externalReceipts.length,2);
 assert.equal(telegram(saved.body).url,'https://t.me/taisabai/512');
 assert.equal(telegram(saved.body).stale,false);
 assert.match(saved.headers.get('cache-control'),/no-store/);
 // идемпотентность по компании+карточке+площадке+ссылке
 const repeat=await through('owner',route(post.id,'avokado'),{method:'POST',body:receipt});
 assert.equal(repeat.status,200);assert.equal(repeat.body.externalReceipts.length,2);
 assert.equal(telegram(repeat.body).id,telegram(saved.body).id);

 // участник с правом просмотра видит ссылку, чужая компания — нет
 const seen=await through('viewer',`/autoposting/posts/${post.id}?companyCode=avokado`);
 assert.equal(seen.status,200);assert.equal(telegram(seen.body).url,'https://t.me/taisabai/512');
 assert.equal((await through('viewer',`/autoposting/posts/${post.id}?companyCode=alvi`)).status,403);
 assert.equal((await through('owner',`/autoposting/posts/${post.id}?companyCode=alvi`)).status,404);

 // повторная отправка отмеченной площадки запрещена на сервере
 const blocked=await through('owner',`/autoposting/posts/${post.id}/schedule?companyCode=avokado`,{method:'POST',body:{revision:repeat.body.revision}});
 assert.equal(blocked.status,409,JSON.stringify(blocked.body));
 assert.equal(blocked.body.details?.code,'EXTERNAL_PUBLICATION_RECORDED');
 assert.deepEqual((await through('owner',`/autoposting/posts/${post.id}?companyCode=avokado`)).body.deliveries,[],'подтверждение не создаёт доставку');

 // правка содержимого сохраняет доказательство и не выдаёт новую версию за опубликованную
 const current=(await through('owner',`/autoposting/posts/${post.id}?companyCode=avokado`)).body;
 const edited=await through('owner',`/autoposting/posts/${post.id}?companyCode=avokado`,{method:'PATCH',body:{revision:current.revision,text:'Новый текст после публикации'}});
 assert.equal(edited.status,200,JSON.stringify(edited.body));
 assert.equal(edited.body.externalReceipts.length,2);assert.ok(edited.body.externalReceipts.every(item=>item.stale===true));
 assert.equal(telegram(edited.body).contentRevision,post.contentRevision);
 assert.equal((await through('owner',`/autoposting/posts/${post.id}/schedule?companyCode=avokado`,{method:'POST',body:{revision:edited.body.revision}})).status,409);

 // внешняя сеть не использовалась: подтверждение не обращается к провайдеру
 assert.equal(await fs.readFile(blockedNetwork,'utf8').catch(()=>''),'');
});
