const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM,VirtualConsole}=require('jsdom');
const html=fs.readFileSync(path.join(__dirname,'../cabinet.html'),'utf8');
const parsed=new JSDOM(html);
const shell=[...parsed.window.document.querySelectorAll('script:not([src])')].map(n=>n.textContent).find(t=>t.includes('canonicalSiteEditors'));
parsed.window.close();
function page(hash='#content-factory',permissions=['autoposting.view'],role='client',{crm=null,editor=false}={}){
 const errors=[],renders=[];
 const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM(html,{url:'https://cabinet.test/cabinet.html'+hash,runScripts:'outside-only',virtualConsole:vc,pretendToBeVisual:true});
 const w=dom.window,d=w.document;
 w.matchMedia=q=>({matches:false,media:q,addEventListener(){},removeEventListener(){}});w.scrollTo=()=>{};
 const views={};
 for(const view of ['autoposting','media-mentor-rollout','media-mentor','content-factory-settings','content-factory-stats'])views[view]={render(node,ctx){renders.push([view,ctx.selectedProjectId]);if(!node.firstChild)node.innerHTML=editor&&view==='autoposting'?'<details id="autoposting-editor"><summary>Редактор</summary><select id="autoposting-select"><option value="">Новый черновик</option><option value="5">Карточка 5</option></select><input id="autoposting-title" aria-label="Название"></details>':'<input aria-label="Черновик">';},onProjectChange(ctx){renders.push([view,ctx.selectedProjectId]);}};
 w.SbCabinet={views:new Proxy(views,{get:(o,k)=>o[k]||{render(){},initialize(){},updateSummary(){}}}),registerView(){},renderModuleGuide(){}};
 w.localStorage.setItem('sb-menu-v1:qa',JSON.stringify({favorites:['autoposting','media-mentor-rollout','media-mentor','content-factory']}));
 w.eval(fs.readFileSync(path.join(__dirname,'menu-preferences.js'),'utf8'));
 const requests=[];w.fetch=async(url,options={})=>{requests.push({url:String(url),method:options.method||'GET'});const answer=crm&&String(url).startsWith('/content/crm/')?crm(String(url)):null;return {ok:true,status:200,json:async()=>answer||({login:'qa',displayName:'QA',role,permissions,csrfToken:'qa',companies:[{id:'one',name:'Первый'},{id:'two',name:'Второй'}]})};};
 if(crm||editor)w.eval(fs.readFileSync(path.join(__dirname,'content-factory.js'),'utf8'));
 w.eval(shell);
 const settle=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setTimeout(r,0));};
 return {w,d,errors,renders,requests,settle,close:()=>w.close(),visible:id=>!d.getElementById(id).hidden};
}
test('один пункт, старое избранное, переходы и сохранение редактора',async()=>{
 const f=page();try{
 await f.settle();const {w,d}=f;
 assert.equal(w.location.hash,'#content-factory/plan');
 assert.equal(d.querySelectorAll('#marketing-menu [data-view-link="content-factory"]').length,1);
 assert.equal(d.querySelector('#autoposting-link'),null);assert.equal(d.querySelector('#media-mentor-rollout-link'),null);
 assert.equal(d.querySelectorAll('.menu-favorites a').length,1);
 assert.equal(d.querySelector('.menu-favorites a').textContent,'Контент завод');
 const input=d.querySelector('#autoposting-view input');input.value='Несохранённый материал';
 d.querySelector('[href="#content-factory/settings"]').click();await f.settle();
 assert.ok(f.visible('content-factory-settings-view'));assert.ok(!f.visible('autoposting-view'));
 assert.equal(d.getElementById('mobile-title').textContent,'Контент завод');assert.match(d.title,/^Контент завод — /);
 assert.equal(d.getElementById('content-factory-link').getAttribute('aria-current'),'page');
 w.history.back();await f.settle();assert.ok(f.visible('autoposting-view'));assert.equal(input.value,'Несохранённый материал');
 w.history.forward();await f.settle();assert.ok(f.visible('content-factory-settings-view'));
 d.querySelector('[href="#content-factory/plan"]').click();await f.settle();assert.equal(input,d.querySelector('#autoposting-view input'));
 assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});
for(const [old,canonical,view] of [['autoposting','plan','autoposting'],['content-factory/materials','plan','autoposting'],['media-mentor-rollout','progress','media-mentor-rollout'],['media-mentor','plan/proposals','media-mentor']])test('старая ссылка '+old,async()=>{
 const f=page('#'+old);try{await f.settle();assert.equal(f.w.location.hash,'#content-factory/'+canonical);assert.ok(f.visible(view+'-view'));assert.deepEqual(f.errors,[]);}finally{f.close();}
});
test('общее право не открывает материалы без прежнего разрешения',async()=>{
 const f=page('#content-factory',['content-factory.view']);try{
 await f.settle();assert.ok(f.visible('content-factory-view'));assert.equal(f.renders.length,0);
 assert.ok([...f.d.querySelectorAll('[data-factory-view]')].every(n=>n.hidden));
 f.w.location.hash='#content-factory/progress';await f.settle();assert.ok(f.visible('access-denied-view'));assert.equal(f.renders.length,0);
 }finally{f.close();}
});
test('без прав единый пункт скрыт и прямая ссылка закрыта',async()=>{
 const f=page('#content-factory/plan',[]);try{await f.settle();assert.ok(!f.visible('content-factory-link'));assert.ok(f.visible('access-denied-view'));assert.equal(f.renders.length,0);}finally{f.close();}
});
test('смена компании сохраняет вкладку и передаёт новый контекст',async()=>{
 const f=page('#content-factory/progress');try{await f.settle();[...f.d.querySelectorAll('#project-menu button')].find(n=>n.textContent.includes('Второй')).click();await f.settle();assert.equal(f.w.location.hash,'#content-factory/progress');assert.deepEqual(f.renders.at(-1),['media-mentor-rollout','two']);}finally{f.close();}
});

test('CF1: четыре вкладки по порядку, вход — Контент-план, подсветка подмаршрутов',async()=>{
 const f=page('#content-factory');try{
 await f.settle();const {w,d}=f;
 const tabs=[...d.querySelectorAll('#content-factory-header [data-factory-view]')];
 assert.deepEqual(tabs.map(n=>n.textContent),['Контент-план','Исходники','Статистика','Настройки модуля']);
 assert.deepEqual(tabs.map(n=>n.getAttribute('href')),['#content-factory/plan','#content-factory/sources','#content-factory/stats','#content-factory/settings']);
 assert.ok(tabs.every(n=>!n.hidden));
 assert.equal(tabs[0].getAttribute('aria-current'),'page');
 assert.equal(d.querySelector('#media-mentor-link'),null,'пункт «Бриф и план» убран из меню');
 for(const [hash,view,tab] of [['#content-factory/plan/proposals','media-mentor',0],['#content-factory/sources','telegram-sources',1],['#content-factory/stats','content-factory-stats',2],['#content-factory/progress','media-mentor-rollout',2],['#content-factory/settings','content-factory-settings',3]]){
  w.location.hash=hash;await f.settle();
  assert.equal(w.location.hash,hash);assert.ok(f.visible(view+'-view'),hash);
  assert.deepEqual(tabs.map(n=>n.getAttribute('aria-current')==='page'),tabs.map((n,i)=>i===tab),hash);
  assert.equal(d.getElementById('content-factory-plan-bar').hidden,tab!==0,'строка действий только на Контент-плане: '+hash);
 }
 assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});
test('CF1: ссылка на карточку из уведомления сохраняет параметры при переходе со старого адреса',async()=>{
 for(const old of ['#autoposting?company=one&post=5&revision=2','#content-factory/materials?company=one&post=5&revision=2']){
  const f=page(old);try{await f.settle();assert.equal(f.w.location.hash,'#content-factory/plan?company=one&post=5&revision=2',old);assert.ok(f.visible('autoposting-view'));}finally{f.close();}
 }
});
test('CF1: первый вход во все вкладки ничего не генерирует и не пишет',async()=>{
 const f=page('#content-factory',['autoposting.view','autoposting.edit','analytics.view'],'owner');try{
 await f.settle();
 for(const hash of ['#content-factory/plan','#content-factory/plan/proposals','#content-factory/sources','#content-factory/stats','#content-factory/settings']){f.w.location.hash=hash;await f.settle();}
 assert.deepEqual(f.requests.filter(r=>r.method!=='GET'),[],'записей нет');
 assert.deepEqual(f.requests.filter(r=>/media-mentor-(suggest|analyze|review)/.test(r.url)),[],'модель не вызывается');
 const bar=f.d.getElementById('content-factory-plan-bar');
 assert.ok(bar.querySelector('[data-factory-action="compose"]'));assert.ok(bar.querySelector('[data-factory-action="create"]'));
 assert.equal(bar.querySelector('a[href="#content-factory/plan/proposals"]'),null,'CF3-R1: ссылки в прежний параллельный модуль в строке действий нет');
 assert.deepEqual([...bar.querySelectorAll('button,a')].map(n=>n.textContent.trim()),['Составить план','Создать публикацию'],'две главные кнопки');
 }finally{f.close();}
});

test('CF1/CF2: «Составить план» показывает сводку вводных; открытие ничего не запускает, запуск — отдельной кнопкой',async()=>{
 const crm=url=>{
  const code=new URL(url,'https://x').searchParams.get('companyCode');
  if(url.startsWith('/content/crm/media-mentor/inputs/months/'))return {companyCode:code,month:url.split('/').pop().split('?')[0],publicationCount:31,inputs:{}};
  if(url.startsWith('/content/crm/media-mentor/inputs'))return {companyCode:code,timezone:'Asia/Irkutsk',profile:{revision:1,fields:{genders:['women','men'],ageFrom:null,ageTo:null}}};
  if(url.startsWith('/content/crm/media-mentor'))return {companyCode:code,brief:{revision:2,fields:{product:'Шары под ключ',audience:'',pains:['Нет времени на оформление']}}};
  return null;
 };
 const f=page('#content-factory/plan',['autoposting.view','autoposting.edit'],'client',{crm});try{
  await f.settle();
  f.d.querySelector('[data-factory-action="compose"]').click();await f.settle();
  const panel=f.d.getElementById('content-factory-compose');
  assert.equal(panel.hidden,false);
  assert.match(panel.textContent,/Шары под ключ/);
  assert.match(panel.textContent,/женщины и мужчины/);
  assert.match(panel.textContent,/Сначала заполните: аудиторию/);
  assert.match(panel.textContent,/Ничего не согласуется, не планируется и не публикуется автоматически/);
  assert.ok(panel.querySelector('a[href="#content-factory/settings"]'));
  assert.equal(panel.querySelector('[data-cf-gen="start"]').disabled,true,'вводные не полны — запуск недоступен');
  assert.deepEqual(f.requests.filter(r=>r.method!=='GET'),[]);
  assert.deepEqual(f.requests.filter(r=>/media-mentor-(suggest|analyze|review)/.test(r.url)),[]);
  f.w.location.hash='#content-factory/settings';await f.settle();
  assert.equal(panel.hidden,true,'сводка закрывается вне Контент-плана');
 }finally{f.close();}
});
test('CF1: «Создать публикацию» открывает существующий редактор и не подменяет открытую карточку',async()=>{
 const f=page('#content-factory/plan/proposals',['autoposting.view','autoposting.edit'],'client',{editor:true});try{
  await f.settle();
  f.d.querySelector('[data-factory-action="create"]').click();await f.settle();
  assert.equal(f.w.location.hash,'#content-factory/plan');
  const editor=f.d.getElementById('autoposting-editor');
  assert.equal(editor.open,true);
  assert.equal(f.d.activeElement,f.d.getElementById('autoposting-title'));
  f.d.getElementById('autoposting-select').value='5';editor.open=false;
  f.d.querySelector('[data-factory-action="create"]').click();await f.settle();
  assert.equal(f.d.getElementById('autoposting-select').value,'5','открытая карточка не подменена');
  assert.equal(f.d.activeElement,f.d.getElementById('autoposting-select'));
  assert.match(f.d.querySelector('[data-factory-bar-status]').textContent,/Новый черновик/);
  assert.deepEqual(f.requests.filter(r=>r.method!=='GET'),[]);
 }finally{f.close();}
});
