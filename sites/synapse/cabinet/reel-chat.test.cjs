'use strict';
// №166: карточка рилса на согласование и итоги публикации в «Чатах» (jsdom, настоящие chats.js и reel-chat.js; materials.js — отправка в чат).
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const flush=async()=>{for(let n=0;n<10;n++)await new Promise(setImmediate);};
const media='https://cabinet.test/content/publishing-assets/avokado/'+'a'.repeat(32)+'.mp4';
const card=over=>({v:1,approvalId:3,reelId:8,version:2,postId:40,title:'Рилс №1',caption:'Подпись к рилсу',mediaUrl:media,
  platforms:[{id:'instagram',label:'Instagram'},{id:'vk',label:'ВКонтакте'}],requestedBy:{id:5,name:'СММ'},requestedAt:'2026-11-05T10:00:00Z',
  status:'pending',statusLabel:'Ждёт согласования',open:true,approvedBy:null,approvedAt:null,edit:null,publication:{items:[],done:false},...over});
function load({permissions=['autoposting.view','autoposting.edit','autoposting.approve'],role='editor',onPost}={}){
  const dom=new JSDOM('<!doctype html><div id="host"></div>',{runScripts:'outside-only',pretendToBeVisual:true,url:'https://cabinet.test/'});
  const w=dom.window,defs=new Map(),calls=[],intervals=[];let messages=[{id:1,user_id:5,author_name:'СММ',kind:'reel-approval',text:'На согласование: рилс',payload:JSON.stringify(card()),created_at:'2026-11-05T10:00:00Z'}];
  w.setInterval=fn=>{intervals.push(fn);return intervals.length;};w.clearInterval=()=>{};
  w.SynapseModules={register:(id,d)=>defs.set(id,d)};
  const api={async get(p,params={}){calls.push(['GET',p,params]);
      if(p==='people/team-chat/rooms')return {viewerId:9,common:'common',hugh:'hugh:9',people:[]};
      if(p==='people/team-chat')return {messages:params.room==='common'?messages:[],hasMore:false,viewerId:9,room:params.room};
      throw Object.assign(Error('404'),{status:404});},
    async post(p,body){calls.push(['POST',p,body]);if(p==='people/team-chat/read')return {unread:0};return onPost?onPost(p,body):{};},
    async raw(method,p,body,options){calls.push(['RAW',method,p,options?.headers]);return {ok:true,status:201,json:async()=>({url:'https://cabinet.test/content/publishing-assets/avokado/'+'d'.repeat(32)+'.jpg'})};}};
  const ctx={moduleId:'chats',companyCode:'avokado',companyName:'Авокадо',user:{id:9,role},permissions,can:p=>role==='owner'||permissions.includes(p),
    signal:new w.AbortController().signal,route:{path:'',params:new w.URLSearchParams({room:'common'})},api,navigate(){}};
  for(const file of ['reel-chat.js','chats.js'])w.eval(fs.readFileSync(path.join(__dirname,file),'utf8'));
  const host=w.document.getElementById('host');
  return {w,host,calls,ctx,mount:()=>defs.get('chats').mount(host,ctx),set:value=>{messages=value;},poll:async()=>{for(const fn of intervals)fn();await flush();}};
}

test('Карточка: плеер playsinline с постером-кадром, название, подпись, площадки, версия, кнопки 44 px; HTML не исполняется',async t=>{
  const f=load();t.after(()=>f.w.close());await f.mount();await flush();
  const li=f.host.querySelector('[data-reel-approval="3"]');assert.ok(li,'карточка в общем чате');
  const video=li.querySelector('video');
  assert.equal(video.getAttribute('src'),media+'#t=0.1');assert.ok(video.controls);assert.ok(video.hasAttribute('playsinline'));assert.equal(video.preload,'metadata');
  assert.match(li.querySelector('.rc-title').textContent,/Рилс №1 v2/);
  assert.equal(li.querySelector('.rc-caption').textContent,'Подпись к рилсу');
  assert.deepEqual([...li.querySelectorAll('.rc-chips li')].map(n=>n.textContent),['Instagram','ВКонтакте']);
  assert.equal(li.querySelector('.rc-status').textContent,'Ждёт согласования');
  assert.deepEqual([...li.querySelectorAll('.rc-actions .rc-btn')].map(b=>b.textContent),['Согласовано','Нужны правки']);
  const css=fs.readFileSync(path.join(__dirname,'reel-chat.css'),'utf8');
  assert.match(css,/\.rc-btn \{[^}]*height: 44px; min-height: 44px;/,'кнопки одной высоты 44 px');
  f.set([{id:1,user_id:5,author_name:'СММ',kind:'reel-approval',text:'x',payload:JSON.stringify(card({title:'<img src=x onerror=alert(1)>'})),created_at:'2026-11-05T10:00:00Z'}]);
  await f.poll();assert.equal(f.host.querySelector('img'),null);
});

test('Опрос чата не пересоздаёт плеер; новый статус обновляет ту же карточку; новое сообщение не трогает старые узлы',async t=>{
  const f=load();t.after(()=>f.w.close());await f.mount();await flush();
  const video=f.host.querySelector('video'),li=video.closest('li');
  await f.poll();assert.equal(f.host.querySelector('video'),video,'без изменений — тот же элемент');
  f.set([{id:1,user_id:5,author_name:'СММ',kind:'reel-approval',text:'x',created_at:'2026-11-05T10:00:00Z',
    payload:JSON.stringify(card({status:'approved',statusLabel:'Согласовано — ждёт публикации',open:false,approvedBy:'Лена',approvedAt:'2026-11-05T10:05:00Z'}))},
    {id:2,user_id:9,author_name:'Лена',text:'Отлично',created_at:'2026-11-05T10:06:00Z'}]);
  await f.poll();
  assert.equal(f.host.querySelector('video'),video,'статус сменился — плеер тот же');assert.equal(f.host.querySelector('[data-reel-approval="3"]'),li);
  assert.equal(li.querySelector('.rc-status').textContent,'Согласовано — ждёт публикации');assert.match(li.textContent,/Согласовал\(а\): Лена/);
  assert.equal(li.querySelectorAll('.rc-actions .rc-btn').length,0,'после решения кнопок нет');
  assert.deepEqual([...f.host.querySelectorAll('.sbc-messages > li')].map(n=>n.textContent.includes('Отлично')),[false,true]);
});

test('«Согласовано»: один клик → существующий маршрут согласования, статус из ответа; ошибка прав показывается',async t=>{
  let fail=false;
  const f=load({onPost:(p)=>{if(fail)throw Object.assign(Error('Недостаточно прав'),{status:403});return {approval:{id:3,...card({status:'approved',statusLabel:'Согласовано — ждёт публикации',open:false,approvedBy:'Лена',approvedAt:'2026-11-05T10:05:00Z'})}};}});
  t.after(()=>f.w.close());await f.mount();await flush();
  f.host.querySelector('.rc-btn--ok').click();await flush();
  const post=f.calls.find(c=>c[0]==='POST'&&String(c[1]).startsWith('crm/'));
  assert.equal(JSON.stringify(post),JSON.stringify(['POST','crm/autoposting/reels/8/chat-approvals/3/approve',{}]));
  assert.equal(f.host.querySelector('.rc-status').textContent,'Согласовано — ждёт публикации');
  assert.match(f.host.querySelector('.rc-note').textContent,/Согласовано/);
  const g=load({onPost:()=>{throw Object.assign(Error('Недостаточно прав'),{status:403});}});t.after(()=>g.w.close());await g.mount();await flush();
  g.host.querySelector('.rc-btn--ok').click();await flush();
  assert.match(g.host.querySelector('.rc-note').textContent,/Нет права/);assert.equal(g.host.querySelector('.rc-status').textContent,'Ждёт согласования');
});

test('Права: без approve нет «Согласовано», без edit нет «Нужны правки», без прав — подсказка',async t=>{
  const a=load({permissions:['autoposting.view','autoposting.edit']});t.after(()=>a.w.close());await a.mount();await flush();
  assert.deepEqual([...a.host.querySelectorAll('.rc-actions .rc-btn')].map(b=>b.textContent),['Нужны правки']);
  const b=load({permissions:[]});t.after(()=>b.w.close());await b.mount();await flush();
  assert.equal(b.host.querySelectorAll('.rc-actions .rc-btn').length,0);assert.match(b.host.querySelector('.rc-note').textContent,/Согласует владелец/);
});

test('«Нужны правки»: окно с текстом и скриншотом → загрузка в хранилище → существующий requestEdit; пустой текст не уходит',async t=>{
  const f=load({onPost:(p,body)=>({approval:{id:3,...card({status:'changes_requested',statusLabel:'Нужны правки',open:false,edit:{id:12,taskId:77,comment:body.comment,byName:'Лена'}})}})});
  t.after(()=>f.w.close());await f.mount();await flush();
  f.host.querySelector('.rc-btn--warn').click();
  const dialog=f.host.querySelector('.rc-dialog');assert.equal(dialog.getAttribute('role'),'dialog');
  dialog.querySelector('form').dispatchEvent(new f.w.Event('submit',{cancelable:true}));await flush();
  assert.equal(f.calls.filter(c=>c[0]==='POST'&&String(c[1]).startsWith('crm/')).length,0,'пустой текст не отправляется');
  dialog.querySelector('textarea').value='Убери первые 2 секунды';
  const file=dialog.querySelector('input[type=file]'),shot=new f.w.File(['x'],'shot.png',{type:'image/png'});
  Object.defineProperty(file,'files',{value:[shot]});file.dispatchEvent(new f.w.Event('change'));
  dialog.querySelector('form').dispatchEvent(new f.w.Event('submit',{cancelable:true}));await flush();
  assert.equal(JSON.stringify(f.calls.find(c=>c[0]==='RAW')),JSON.stringify(['RAW','POST','publishing-assets',{'Content-Type':'image/png'}]));
  const post=f.calls.find(c=>c[0]==='POST'&&String(c[1]).startsWith('crm/'));
  assert.equal(post[1],'crm/autoposting/reels/8/chat-approvals/3/changes');
  assert.equal(JSON.stringify(post[2]),JSON.stringify({comment:'Убери первые 2 секунды',screenshotUrl:'https://cabinet.test/content/publishing-assets/avokado/'+'d'.repeat(32)+'.jpg'}));
  assert.equal(f.host.querySelector('.rc-dialog'),null,'окно закрылось');
  assert.equal(f.host.querySelector('.rc-status').textContent,'Нужны правки');assert.match(f.host.querySelector('.rc-card').textContent,/задача №77/);
});

test('Итоги публикации: ссылки https открываются в новой вкладке, без ссылки — ID, ошибки отдельно; javascript: не становится ссылкой',async t=>{
  const f=load();t.after(()=>f.w.close());
  f.set([{id:5,user_id:5,author_name:'Synapse · публикация',kind:'reel-published',created_at:'2026-11-05T11:00:00Z',text:'Рилс «Рилс №1» — итоги публикации:\n…',
    payload:JSON.stringify({v:1,approvalId:3,items:[{platformId:'vk',label:'ВКонтакте',state:'published',url:'https://vk.com/wall-1_2',source:'direct'},
      {platformId:'instagram',label:'Instagram',state:'published',url:null,source:'onlypult',providerPostId:'op123'},
      {platformId:'max',label:'MAX',state:'published',url:'javascript:alert(1)',source:'direct',externalId:'77'},
      {platformId:'telegram',label:'Telegram',state:'failed',error:'площадка не подтвердила публикацию'}]})}]);
  await f.mount();await flush();
  const links=[...f.host.querySelectorAll('.rc-result a')];
  assert.deepEqual(links.map(a=>[a.href,a.target,a.rel]).map(x=>[...x]),[['https://vk.com/wall-1_2','_blank','noopener noreferrer']]);
  const rows=[...f.host.querySelectorAll('.rc-result__item')].map(n=>n.textContent);
  assert.deepEqual(rows,['ВКонтакте: https://vk.com/wall-1_2','Instagram: опубликовано, ссылка недоступна (ID задания Onlypult op123)',
    'MAX: опубликовано, ссылка недоступна (ID 77)','Telegram: ошибка публикации — площадка не подтвердила публикацию']);
  assert.equal(f.host.querySelector('.rc-result__head').textContent,'Рилс «Рилс №1» — итоги публикации:');
});

test('«Материалы»: «Отправить на согласование в чат» — подпись из черновика, площадки, один ключ на попытку, переход в чат',async t=>{
  const dom=new JSDOM('<main id="view"></main>',{url:'https://cabinet.test/#content/materials',runScripts:'outside-only'});t.after(()=>dom.window.close());
  const w=dom.window,el=w.document.getElementById('view'),calls=[],navigations=[];let fail=1;
  w.SynapseModulesQueue=[];w.eval(fs.readFileSync(path.join(__dirname,'materials.js'),'utf8'));
  const reel={id:4,key:'reel:4',source:'materials',companyCode:'avokado',title:'Рилс №1',releaseDate:'',platforms:['instagram','vk'],postId:40,
    currentVersion:{version:2,mediaUrl:media},versionCount:2,openEdits:0,versions:[{version:1,mediaUrl:media},{version:2,mediaUrl:media}],edits:[],log:[]};
  const answer=async(method,p,body)=>{calls.push({method,p,body});
    if(p==='crm/autoposting/reels'&&method==='GET')return {companyCode:'avokado',reels:[reel]};
    if(p==='crm/autoposting/reels/4')return reel;
    if(p==='crm/autoposting/posts/40')return {id:40,text:'Подпись из черновика'};
    if(p==='crm/autoposting/reels/4/chat-approvals'){if(fail-->0)throw Object.assign(Error('Связь'),{status:503});return {approval:{id:3,title:'Рилс №1',version:2,statusLabel:'Ждёт согласования'}};}
    throw Object.assign(Error('unexpected '+p),{status:500});};
  const ctx={moduleId:'content-materials',companyCode:'avokado',can:p=>['autoposting.view','autoposting.edit'].includes(p),signal:new w.AbortController().signal,route:{path:''},
    api:{get:(p,params)=>answer('GET',p,undefined,params),post:(p,body)=>answer('POST',p,body)},navigate:r=>navigations.push(r)};
  const [,definition]=w.SynapseModulesQueue[0];await definition.mount(el,ctx);
  el.querySelector('[data-open="reel:4"]').click();await flush();
  el.querySelector('[data-chat-open]').click();await flush();
  const form=el.querySelector('[data-chat-form]');assert.equal(form.hidden,false);
  assert.equal(form.elements.text.value,'Подпись из черновика');
  form.querySelector('[data-chat-targets] input[value="instagram"]').checked=false;
  form.dispatchEvent(new w.Event('submit',{cancelable:true,bubbles:true}));await flush();
  assert.match(el.querySelector('[data-chat-status]').textContent,/Повтор безопасен/);
  form.dispatchEvent(new w.Event('submit',{cancelable:true,bubbles:true}));await flush();
  const sends=calls.filter(c=>c.p==='crm/autoposting/reels/4/chat-approvals');
  assert.equal(sends.length,2);assert.equal(sends[0].body.clientRequestId,sends[1].body.clientRequestId,'повтор после сбоя — тот же ключ');
  assert.equal(JSON.stringify({...sends[1].body,clientRequestId:'k'}),JSON.stringify({clientRequestId:'k',version:2,platformIds:['vk'],text:'Подпись из черновика'}));
  assert.match(el.querySelector('[data-chat-status]').textContent,/Отправлено в общий чат компании: «Рилс №1» v2/);
  [...el.querySelectorAll('[data-chat-status] button')].find(b=>b.textContent==='Открыть чат').click();
  assert.equal(JSON.stringify(navigations),JSON.stringify(['chats?room=common']));
});
