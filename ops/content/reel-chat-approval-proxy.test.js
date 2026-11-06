'use strict';
// №166 сквозь настоящие content + CRM: «Материалы» → общий чат компании → «Согласовано» → итоги публикации в том же чате.
// Внешняя сеть заблокирована; доставки площадок записываются в базу CRM напрямую (живой отправки нет).
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomBytes}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {createAuthStore}=require('./auth-store'),{hashPassword}=require('./passwords');
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

test('Рилс на согласование в чате через proxy: CSRF и права, карточка видна участникам, решение и итоги публикации',{timeout:90000},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'reel-chat-proxy-')),children=[],connections=[];
  const contentDb=path.join(directory,'content.sqlite'),crmDb=path.join(directory,'crm.sqlite');
  const password='Local-reel-chat-fixture-password',key=randomBytes(32).toString('hex');
  t.after(async()=>{for(const child of children.reverse())if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
    for(const db of connections)db.close();await fs.rm(directory,{recursive:true,force:true});});
  const authDb=new DatabaseSync(contentDb),auth=createAuthStore(authDb,`owner:owner:${hashPassword(password)}`),owner=auth.getByLogin('owner');
  for(const [login,displayName,permissions,companies]of [['smm','СММ',['autoposting.view','autoposting.edit'],['avokado']],['lena','Лена',['autoposting.view','autoposting.edit','autoposting.approve'],['avokado']],
    ['alien','Чужой',['autoposting.view','autoposting.edit','autoposting.approve'],['alvi']]])
    auth.create(owner.id,{login,displayName,password,companies,permissions},hashPassword(password));
  authDb.close();
  const crmPort=await freePort(),contentPort=await freePort(),crmBase=`http://127.0.0.1:${crmPort}`,contentBase=`http://127.0.0.1:${contentPort}`;
  const preload=path.join(directory,'local-network-only.cjs');
  await fs.writeFile(preload,`'use strict';
  const net=require('node:net'),allowed=process.env.REEL_TEST_ALLOWED_ORIGIN?new URL(process.env.REEL_TEST_ALLOWED_ORIGIN):null;
  const blocked=()=>{throw new Error('External network disabled by reel chat fixture');};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(input,options)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!allowed||url.origin!==allowed.origin)blocked();return originalFetch(input,options);};
  const originalConnect=net.Socket.prototype.connect;
  net.Socket.prototype.connect=function(...args){const values=Array.isArray(args[0])?args[0]:args;const options=typeof values[0]==='object'?values[0]:{port:values[0],host:typeof values[1]==='string'?values[1]:'localhost'};
    if(!allowed||options.host!==allowed.hostname||String(options.port)!==allowed.port)blocked();return originalConnect.apply(this,args);};
  require('node:tls').connect=blocked;`);
  async function start(file,env,base){let errors='';const child=spawn(process.execPath,['--require',preload,file],{env:{...process.env,...env},stdio:['ignore','ignore','pipe'],windowsHide:true});children.push(child);child.stderr.on('data',chunk=>errors+=chunk);
    for(let attempt=0;attempt<200;attempt++){if(child.exitCode!==null)throw Error('Service failed: '+errors);try{const response=await fetch(base+'/health',{signal:AbortSignal.timeout(500)});await response.text();return;}catch{await new Promise(resolve=>setTimeout(resolve,25));}}throw Error('Service not ready: '+errors);}
  await start(path.join(__dirname,'../crm/server.js'),{PORT:String(crmPort),DATABASE_PATH:crmDb,API_KEY:key,RATE_LIMIT_MAX:'10000',STRICT_ORIGIN:'',REEL_TEST_ALLOWED_ORIGIN:'',LEADS_SMTP_HOST:'',LEADS_SMTP_USER:'',LEADS_SMTP_PASSWORD:'',LEADS_NOTIFY_EMAIL:''},crmBase);
  await start(path.join(__dirname,'server.js'),{PORT:String(contentPort),DATABASE_PATH:contentDb,AUTH_USERS:'',API_KEY:'',CRM_URL:crmBase,CRM_API_KEY:key,SEED_DIR:directory,ASSETS_DIR:path.join(directory,'assets'),
    SESSION_SECRET:randomBytes(32).toString('hex'),REEL_TEST_ALLOWED_ORIGIN:crmBase,HUGH_RUNNER_URL:'',CHAT_URL:'',CHAT_API_KEY:''},contentBase);
  async function request(base,route,{method='GET',body,headers={}}={}){const response=await fetch(base+route,{method,headers:{...headers,...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
    const text=await response.text();return {status:response.status,body:text?JSON.parse(text):null,headers:response.headers};}
  const ownerIdentity=Buffer.from(JSON.stringify({v:1,userId:1,role:'owner',permissions:[],companyCodes:[]})).toString('base64url');
  for(const code of ['avokado','alvi'])assert.equal((await request(crmBase,'/companies',{method:'POST',body:{code,name:'Local '+code},headers:{'x-api-key':key,'x-synapse-crm-identity':ownerIdentity}})).status,201);
  const sessions={};
  for(const login of ['owner','smm','lena','alien']){const result=await request(contentBase,'/content/login',{method:'POST',body:{login,password}});assert.equal(result.status,200,login);
    const cookie=result.headers.get('set-cookie').split(';')[0];const profile=await request(contentBase,'/content/whoami',{headers:{cookie}});sessions[login]={cookie,'x-csrf-token':profile.body.csrfToken};}
  const as=(who,route,options={})=>request(contentBase,'/content'+route,{...options,headers:{...sessions[who],...options.headers}});
  const chat=async who=>(await as(who,'/people/team-chat?companyCode=avokado&room=common')).body;
  const waitFor=async(who,check)=>{for(let i=0;i<60;i++){const data=await chat(who);if(data?.messages&&check(data.messages))return data.messages;await new Promise(r=>setTimeout(r,100));}throw Error('Чат не дождался состояния');};

  const mediaUrl='https://synapse.synapsebusiness.ru/content/publishing-assets/avokado/'+'a'.repeat(32)+'.mp4';
  const reel=await as('smm','/crm/autoposting/reels?companyCode=avokado',{method:'POST',body:{title:'Рилс №1',platforms:['vk','telegram'],mediaUrl,durationMs:12000}});
  assert.equal(reel.status,201,JSON.stringify(reel.body));
  const send=`/crm/autoposting/reels/${reel.body.id}/chat-approvals?companyCode=avokado`,body={clientRequestId:'proxy-1',version:1,platformIds:['vk','telegram'],text:'Подпись'};
  assert.equal((await as('smm',send,{method:'POST',body,headers:{'x-csrf-token':'bad'}})).status,403,'CSRF обязателен');
  assert.equal((await as('alien',`/crm/autoposting/reels/${reel.body.id}/chat-approvals?companyCode=avokado`,{method:'POST',body})).status,403,'чужая компания');
  const sent=await as('smm',send,{method:'POST',body});assert.equal(sent.status,201,JSON.stringify(sent.body));
  const approvalId=sent.body.approval.id;
  const messages=await waitFor('lena',list=>list.some(m=>m.kind==='reel-approval'));
  const card=messages.find(m=>m.kind==='reel-approval');
  assert.equal(card.author_name,'СММ');const payload=JSON.parse(card.payload);
  assert.deepEqual([payload.approvalId,payload.status,payload.mediaUrl,payload.caption],[approvalId,'pending',mediaUrl,'Подпись']);
  assert.equal((await as('alien','/people/team-chat?companyCode=avokado&room=common')).status,403,'другая компания не читает общий чат');
  const approve=`/crm/autoposting/reels/${reel.body.id}/chat-approvals/${approvalId}/approve?companyCode=avokado`;
  const denied=await as('smm',approve,{method:'POST',body:{}});assert.equal(denied.status,403,'proxy: без autoposting.approve');
  assert.equal((await as('lena',approve,{method:'POST',body:{},headers:{'x-csrf-token':'bad'}})).status,403);
  const ok=await as('lena',approve,{method:'POST',body:{}});assert.equal(ok.status,200,JSON.stringify(ok.body));
  assert.equal(ok.body.approval.approvedBy,'Лена');
  await waitFor('smm',list=>list.some(m=>m.kind==='reel-approval'&&JSON.parse(m.payload).status==='approved'));
  // Итоги: прямой ВК с реальной ссылкой, Telegram — ошибка. Записываются в CRM как это сделал бы автопостинг.
  const crm=new DatabaseSync(crmDb);connections.push(crm);crm.exec('PRAGMA busy_timeout=5000');
  const insert=crm.prepare(`INSERT INTO autoposting_deliveries(post_id,channel_id,channel_revision,status,external_id,url,error_code,finished_at) VALUES(?,?,1,?,?,?,?,?)`);
  insert.run(ok.body.approval.postId,'vk','published','-1_2','https://vk.com/wall-1_2',null,new Date().toISOString());
  insert.run(ok.body.approval.postId,'telegram','failed',null,null,'PUBLISH_FAILED',new Date().toISOString());
  await new Promise(r=>setTimeout(r,10500)); // интервал синхронизации при чтении чата — 10 с
  const done=await waitFor('lena',list=>list.some(m=>m.kind==='reel-published'));
  const result=done.filter(m=>m.kind==='reel-published');assert.equal(result.length,1);
  assert.equal(result[0].text,'Рилс «Рилс №1» — итоги публикации:\nВКонтакте: https://vk.com/wall-1_2\nTelegram: ошибка публикации — площадка не подтвердила публикацию');
  assert.equal(JSON.parse(done.find(m=>m.kind==='reel-approval').payload).status,'partial');
  await new Promise(r=>setTimeout(r,10500));
  assert.equal((await chat('lena')).messages.filter(m=>m.kind==='reel-published').length,1,'повторная синхронизация не дублирует итоги');
});
