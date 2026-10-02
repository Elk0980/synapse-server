'use strict';
// Связанные реальные модули, две синтетические БД; сеть и production logic не используются.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {createContentPlanJobs}=require('../crm/content-plan-jobs');
const {createContentPlanDispatch}=require('../crm/content-plan-dispatch');
const {createContentPlanRunner}=require('./content-plan-runner');
const {createHughOwnerAlerts}=require('./hugh-owner-alerts');
const {createProjectChat}=require('./project-chat');
const {createAuthStore}=require('./auth-store');
const ROOM='palitra-love',OTHER='alvi';
const HASH=`scrypt$16384$8$1$${Buffer.alloc(16,7).toString('base64url')}$${Buffer.alloc(32,9).toString('base64url')}`;

function fixture(t,{lostAck=null}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'content-plan-notifications-'));
 const crm=new DatabaseSync(':memory:');
 crm.exec("CREATE TABLE companies(id INTEGER PRIMARY KEY,code TEXT,is_deleted INTEGER DEFAULT 0); INSERT INTO companies VALUES(1,'palitra-love',0),(2,'alvi',0)");
 const f={dir,crm,now:Date.now(),runners:[],ackLost:false};
 f.jobs=createContentPlanJobs(crm,{now:()=>f.now});f.dispatch=createContentPlanDispatch({jobs:f.jobs});
 const denyFetch=async()=>{throw Error('Тест запрещает внешние запросы');};
 function openContent(){
  f.db=new DatabaseSync(path.join(dir,'content.sqlite'));f.db.exec('PRAGMA foreign_keys=ON');
  f.auth=createAuthStore(f.db,`synthetic:owner:${HASH}`);
  f.chat=createProjectChat({db:f.db,authStore:f.auth,assetsDir:dir,now:()=>f.now,fallback:{env:{}},
   reviewReminders:{enabled:false},fetchImpl:denyFetch,
   requireSession:req=>{if(!req.session)throw Object.assign(Error('Нет сессии'),{status:401});return req.session;},
   requireCsrf:()=>{throw Error('Тест использует только чтение ЛК');},
   readBody:async()=>{throw Error('Тест использует только чтение ЛК');},
   sendJson:(res,status,body)=>{res.statusCode=status;res.payload=body;}});
  f.alerts=createHughOwnerAlerts({db:f.db,now:()=>f.now});
 }
 openContent();
 f.restart=()=>{f.chat.stopWorker();f.db.close();openContent();};
 f.enqueue=(code,month,questions=[])=>f.jobs.enqueue(code,{clientRequestId:'notify_'+code+'_'+month.replace('-','_'),month,questions,
  snapshot:{timezone:'Europe/Moscow',brief:{assets:[]},monthInputs:{platforms:['telegram'],perDay:{telegram:1},
   excludedDays:Array.from({length:30},(_,i)=>month+'-'+String(i+2).padStart(2,'0'))}}});
 f.runner=()=>{
  const runner=createContentPlanRunner({crmUrl:'https://synthetic.invalid',crmApiKey:'synthetic-key',alerts:f.alerts,
   fallback:{reply:async payload=>{const context=JSON.parse(JSON.parse(payload).messages[0].content),slot=context.slots[0];
    return {model:'synthetic-only',text:JSON.stringify({proposals:[{...slot,format:'post',role:'reach',topic:'Синтетический план',text:'Проверка'}]})};}},
   fetchImpl:async(url,options)=>{
    assert.equal(new URL(url).origin,'https://synthetic.invalid');assert.equal(options.headers['x-api-key'],'synthetic-key');
    const action=url.split('/').pop(),body=JSON.parse(options.body);
    const lose=action==='ack-alert'&&lostAck&&!f.ackLost;
    if(lose&&lostAck==='before'){f.ackLost=true;throw Error('CRM-квитанция потеряна до обработки ack');}
    const payload=f.dispatch.handle(action,body);
    if(lose){f.ackLost=true;throw Error('CRM обработала ack, но ответ потерян');}
    return {ok:true,status:200,json:async()=>payload};
   }});
  f.runners.push(runner);return runner;
 };
 f.read=async(code=ROOM,userId=1)=>{
  const response={},request={method:'GET',headers:{},session:{user:f.auth.getById(userId),csrf:'synthetic-csrf'}};
  assert.equal(await f.chat.handle(request,response,new URL('https://synthetic.invalid/content/project-chat/'+code)),true);
  assert.equal(response.statusCode,200);return response.payload;
 };
 t.after(async()=>{for(const runner of f.runners)await runner.stop();f.chat.stopWorker();f.db.close();crm.close();
  const resolved=path.resolve(dir),temp=path.resolve(os.tmpdir())+path.sep;
  assert.ok(resolved.startsWith(temp)&&path.basename(resolved).startsWith('content-plan-notifications-'));
  fs.rmSync(resolved,{recursive:true,force:true});});
 return f;
}

async function domAlerts(t,f,code=ROOM){
 // DOM запускается только по явно переданному readonly источнику общей QA.
 const source=process.env.CONTENT_PLAN_NOTIFICATIONS_UI_SOURCE;if(!source)return null;
 const {JSDOM}=require('jsdom'),dom=new JSDOM('<section id="hugh-view"></section>',{runScripts:'outside-only',url:'https://synthetic.invalid/cabinet.html'});
 const w=dom.window,views={};t.after(()=>{views.hugh?.unmount();w.close();});
 w.AbortSignal.any=()=>new w.AbortController().signal;w.AbortSignal.timeout=()=>new w.AbortController().signal;
 w.setTimeout=()=>1;w.clearTimeout=()=>{};
 w.SbCabinet={registerView:(name,view)=>{views[name]=view;}};
 w.fetch=async(input,options={})=>{
  assert.equal(options.method||'GET','GET','просмотр уведомления не отправляет сообщение');
  const pathname=new URL(input,'https://synthetic.invalid').pathname;
  if(pathname.endsWith('/resolve'))return {ok:true,status:200,json:async()=>({shared:false})};
  assert.equal(pathname,'/content/project-chat/'+code);
  return {ok:true,status:200,json:async()=>f.read(code)};
 };
 w.eval(fs.readFileSync(source,'utf8'));
 await views.hugh.render(w.document.getElementById('hugh-view'),{identity:{role:'owner',userId:1,csrfToken:'synthetic-csrf',displayName:'Владелец',permissions:[]},
  selectedProjectId:code,currentView:'hugh',byId:id=>w.document.getElementById(id)});
 for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));
 const alerts=w.document.querySelector('[data-pc-alerts]');assert.ok(alerts);assert.equal(alerts.hidden,false);
 return alerts.textContent;
}

test('связанные succeeded/failed/delayed/needs_input видны владельцу в своей компании, участнику не раскрываются',async t=>{
 const f=fixture(t),runner=f.runner();
 const success=f.enqueue(ROOM,'2026-10');await runner.runOne();assert.equal(f.jobs.get(ROOM,success.id).job.status,'succeeded');
 f.enqueue(ROOM,'2026-11');let lease=f.dispatch.handle('claim').task.lease;f.dispatch.handle('error',{lease,code:'BUDGET_EXCEEDED'});
 f.enqueue(ROOM,'2026-12');lease=f.dispatch.handle('claim').task.lease;f.dispatch.handle('error',{lease,code:'PROVIDER_UNAVAILABLE'});
 f.enqueue(OTHER,'2026-10',[{id:'product',target:'brief.product',text:'Уточните продукт',required:true}]);
 await runner.sync();
 const own=await f.read(),other=await f.read(OTHER);
 assert.equal(own.ownerAlerts.length,3);assert.equal(other.ownerAlerts.length,1);
 for(const alert of own.ownerAlerts){assert.match(alert.text,/palitra-love/);assert.doesNotMatch(alert.text,/alvi/);assert.equal(alert.status,'pending');}
 assert.ok(own.ownerAlerts.some(a=>/готовы к просмотру/.test(a.text)));assert.ok(own.ownerAlerts.some(a=>/остановлена/.test(a.text)));
 assert.ok(own.ownerAlerts.some(a=>/задерживается/.test(a.text)));assert.match(other.ownerAlerts[0].text,/нужны уточнения/);
 const member=f.auth.create(1,{login:'member',displayName:'Участник',password:'synthetic-password',companies:[ROOM],permissions:[]},HASH);
 f.db.prepare('INSERT INTO project_chat_members(company_code,user_id) VALUES(?,?)').run(ROOM,member.id);
 assert.equal(Object.hasOwn(await f.read(ROOM,member.id),'ownerAlerts'),false);
 const rendered=await domAlerts(t,f);if(rendered){assert.match(rendered,/Ожидает отправки/);assert.doesNotMatch(rendered,/Доставлено в Telegram/);assert.doesNotMatch(rendered,/alvi/);}
});

test('CRM ack означает pending; настоящий bridge выдаёт owner без клиентского адреса, receipt подтверждает sent в ЛК',async t=>{
 const f=fixture(t),runner=f.runner();f.enqueue(ROOM,'2026-10');await runner.runOne();await runner.sync();
 assert.deepEqual(f.dispatch.handle('alerts').alerts,[]);assert.equal((await f.read()).ownerAlerts[0].status,'pending');
 // Даже при клиентской привязке адрес уведомления остаётся owner, получателя выбирает Telegram-мост.
 f.db.prepare('UPDATE project_chat_rooms SET telegram_chat_id=? WHERE company_code=?').run('-10000001',ROOM);
 const pending=f.chat.bridge.pendingTelegram();assert.equal(pending.length,1);
 assert.equal(pending[0].audience,'owner');assert.equal(pending[0].chatId,null);assert.equal(pending[0].companyCode,ROOM);
 assert.match(pending[0].id,/^owner-alert:\d+$/);assert.deepEqual(f.chat.bridge.pendingTelegram(),[]);
 assert.equal(f.chat.bridge.acknowledgeTelegram(pending[0].id,{ok:true,externalMessageIds:['synthetic-telegram-501']}).status,'sent');
 assert.equal((await f.read()).ownerAlerts[0].status,'sent');assert.deepEqual(f.chat.bridge.pendingTelegram(),[]);
 const rendered=await domAlerts(t,f);if(rendered)assert.match(rendered,/Доставлено в Telegram/);
});

test('потеря CRM ack после durable INSERT до/после обработки: повтор sync сохраняет ровно одно уведомление',async t=>{
 for(const lostAck of ['before','after']){
  const f=fixture(t,{lostAck}),runner=f.runner();f.enqueue(ROOM,'2026-10');await runner.runOne();
  await assert.rejects(runner.sync(),/CRM/);
  assert.equal((await f.read()).ownerAlerts.length,1);assert.equal((await f.read()).ownerAlerts[0].status,'pending');
  assert.equal(f.dispatch.handle('alerts').alerts.length,lostAck==='before'?1:0);
  await runner.sync();await runner.sync();
  assert.equal((await f.read()).ownerAlerts.length,1);assert.deepEqual(f.dispatch.handle('alerts').alerts,[]);
  assert.equal(f.chat.bridge.pendingTelegram().length,1);assert.deepEqual(f.chat.bridge.pendingTelegram(),[]);
 }
});

test('потерянная Telegram-квитанция переживает перезапуск БД: uncertain виден в ЛК, слепой повтор отсутствует',async t=>{
 const f=fixture(t),runner=f.runner();f.enqueue(ROOM,'2026-10');await runner.runOne();await runner.sync();
 const send=f.chat.bridge.pendingTelegram()[0];assert.ok(send);let syntheticSends=0;
 const sendWithoutReceipt=()=>{syntheticSends++;throw Error('Telegram принял, квитанция потеряна');};
 assert.throws(sendWithoutReceipt,/квитанция потеряна/);assert.equal((await f.read()).ownerAlerts[0].status,'sending');
 await runner.stop();f.restart();assert.equal((await f.read()).ownerAlerts[0].status,'sending');
 f.now+=360001;
 assert.deepEqual(f.chat.bridge.pendingTelegram(),[]);assert.equal((await f.read()).ownerAlerts[0].status,'uncertain');
 await f.runner().sync();assert.deepEqual(f.chat.bridge.pendingTelegram(),[]);assert.equal(syntheticSends,1);
 assert.match((await f.read()).ownerAlerts[0].error,/неизвестен/);
 const rendered=await domAlerts(t,f);if(rendered){assert.match(rendered,/Доставка уточняется/);assert.doesNotMatch(rendered,/Доставлено в Telegram/);}
});
