// №308: реальная разметка и CSS кабинета, локальные синтетические комнаты, без сети.
const {chromium}=require('playwright-core');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),site=path.join(root,'sites/synapse'),out=path.join(root,'specs/308-mobile-chats');
fs.mkdirSync(out,{recursive:true});
const read=p=>fs.readFileSync(path.join(site,p),'utf8');
const base=p=>execFileSync('git',['show',`333fc6e381e93204d1a612e5032ad302158ce379:sites/synapse/${p}`],{cwd:root,encoding:'utf8',maxBuffer:4000000});
const cabinet=read('cabinet.html'),inline=[...cabinet.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n');
let markup=cabinet.match(/<body[^>]*>([\s\S]*?)<\/body>/)[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,'');
const messages=Array.from({length:55},(_,i)=>({id:i+101,user_id:i%3?3:2,author_name:i%3?'Марина':'Лена',text:[
 'Проверила материалы к ролику «Приехали на месяц — и не уехали». Обложка готова, можно посмотреть.',
 'Спасибо! Добавлю подписи и сверю даты выхода на площадках.',
 'Сохраним этот вариант. В начале оставим короткий рассказ о переезде в Паттайю.'
][i%3],created_at:`2026-11-21T10:${String(i).padStart(2,'0')}:00Z`}));
const metrics=[];
async function fixture(browser,version,width=390,height=844){
 const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:2,isMobile:width<761,hasTouch:width<761});
 await context.route('**/*',route=>route.abort());
 const p=await context.newPage();p.on('pageerror',e=>{throw e;});
 const styles=[read('cabinet/common.css'),inline,read('cabinet/workspace.css'),read('cabinet/shell.css'),version==='before'?base('cabinet/chats.css'):read('cabinet/chats.css')].join('\n');
 await p.setContent(`<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${styles}</style></head><body>${markup}</body></html>`);
 await p.evaluate(({messages,width,height})=>{
   document.body.dataset.cabinetView='chats';
   document.getElementById('app').hidden=false; document.getElementById('auth').hidden=true;
   document.getElementById('content-factory-header').hidden=true; document.getElementById('settings-tabs').hidden=true;
   document.querySelectorAll('[data-view]').forEach(n=>n.hidden=true);
   const main=document.getElementById('main-content');const view=document.createElement('section');view.className='view-panel';view.innerHTML='<div class="sb-module-root" id="qa-chats"></div>';main.append(view);
   document.getElementById('mobile-title').textContent='Чаты';
   document.querySelectorAll('[data-company-name]').forEach(n=>n.textContent='ТайСабай');
   const vv=new EventTarget();Object.assign(vv,{width,height,offsetTop:0,scale:1});Object.defineProperty(window,'visualViewport',{value:vv,configurable:true});
   window.qa={messages,defs:{},vv,intervals:[],calls:[]};window.setInterval=fn=>{qa.intervals.push(fn);return qa.intervals.length;};window.clearInterval=()=>{};
   window.SynapseModules={register:(id,def)=>qa.defs[id]=def};
 },{messages,width,height});
 await p.addScriptTag({content:version==='before'?base('cabinet/chats.js'):read('cabinet/chats.js')});
 await p.evaluate(async()=>{
  qa.controller=new AbortController();
  qa.ctx={companyCode:'taisabai',companyName:'ТайСабай',user:{id:2,role:'editor'},route:{params:new URLSearchParams()},signal:qa.controller.signal,
   api:{get:async(p,params={})=>{qa.calls.push(['GET',p,params]);if(p==='people/team-chat/rooms')return{hugh:'hugh:2',people:[{room:'dm:2-3',name:'Марина · редактор'},{room:'dm:2-4',name:'Монтажёр'}]};if(p==='people/team-chat')return{viewerId:2,room:params.room,messages:params.before?Array.from({length:10},(_,i)=>({...qa.messages[0],id:91+i,text:'Раннее сообщение '+i})):qa.messages,hasMore:!params.before};throw Error('Unexpected API '+p);},post:async()=>{throw Error('Отправки запрещены в visual QA');}}};
  await qa.defs.chats.mount(document.getElementById('qa-chats'),qa.ctx);
 });
 await p.waitForTimeout(100);
 return{p,context};
}
async function snap(p,name){await p.screenshot({path:path.join(out,name+'.jpg'),type:'jpeg',quality:80});}
async function measure(p,name){const m=await p.evaluate(()=>{
 const rect=s=>{const n=document.querySelector(s);if(!n)return null;const r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:r.height,width:r.width,display:getComputedStyle(n).display};};
 const list=document.querySelector('.sbc-messages');return{pageHeight:document.documentElement.scrollHeight,viewport:innerHeight,scrollY,head:rect('.sbc-conv__head'),list:rect('.sbc-messages'),compose:rect('.sbc-compose'),nav:rect('.mobile-shortcuts'),font:getComputedStyle(document.querySelector('.sbc-msg__text')).fontSize,textFont:getComputedStyle(document.querySelector('.sbc-compose textarea')).fontSize,bottom:list.scrollHeight-list.scrollTop-list.clientHeight};
 });metrics.push({name,...m});return m;}
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 for(const version of ['before','after']){
  const {p,context}=await fixture(browser,version);
  await snap(p,version+'-list');await p.locator('.sbc-room').first().click();await p.waitForTimeout(100);
  await snap(p,version+'-long');const full=await measure(p,version+'-long');
  if(version==='after'){
   assert.equal(full.nav.display,'none');assert.ok(full.list.height>650);assert.equal(full.compose.bottom,844);assert.ok(full.bottom<2);assert.equal(full.scrollY,0);
   // Один скролл: движение на границе ленты не прокручивает страницу.
   await p.locator('.sbc-messages').evaluate(n=>n.scrollTop=0);await p.mouse.move(190,150);await p.mouse.wheel(0,-400);await p.waitForTimeout(80);assert.equal(await p.evaluate(()=>scrollY),0);
   await p.locator('.sbc-messages').evaluate(n=>{n.scrollTop=n.scrollHeight;n.dispatchEvent(new Event('scroll'));});
  }
  await p.locator('.sbc-compose textarea').focus();
  await p.evaluate(()=>{qa.vv.height=480;qa.vv.dispatchEvent(new Event('resize'));const keyboard=document.createElement('div');keyboard.id='qa-keyboard';keyboard.style='position:fixed;z-index:999;top:480px;left:0;right:0;height:364px;background:#cdd0d6;color:#222;padding:16px 6px;font:18px Segoe UI;box-sizing:border-box;text-align:center';keyboard.innerHTML='<div style="font-size:13px;margin-bottom:20px">Эмуляция клавиатуры · visualViewport 480px</div>'+['й ц у к е н г ш щ з х','ф ы в а п р о л д ж э','⇧ я ч с м и т ь б ю ⌫','123　　　　 пробел　　　　 ↵'].map(s=>'<div style="padding:14px 0;margin:9px 0;border-radius:8px;background:#f8f8f8">'+s+'</div>').join('');document.body.append(keyboard);});
  await p.waitForTimeout(100);await snap(p,version+'-keyboard');const k=await measure(p,version+'-keyboard');
  if(version==='after'){
   assert.equal(k.compose.bottom,480);assert.ok(k.list.height>300);assert.ok(k.bottom<2);
   await p.evaluate(()=>{document.getElementById('qa-keyboard').remove();document.querySelector('.sbc-compose textarea').blur();qa.vv.height=844;qa.vv.dispatchEvent(new Event('resize'));});
   await p.locator('.sbc-messages').evaluate(n=>{n.scrollTop=400;n.dispatchEvent(new Event('scroll'));});
   await p.evaluate(()=>{qa.messages.push({id:156,user_id:3,author_name:'Марина',text:'Новое сообщение, пока вы читаете историю.',created_at:'2026-11-21T11:00:00Z'});qa.intervals.at(-1)();});await p.waitForTimeout(100);
   assert.equal(await p.locator('.sbc-messages').evaluate(n=>n.scrollTop),400);assert.ok(await p.locator('.sbc-new').isVisible());
   await p.locator('.sbc-new').click();assert.ok(await p.locator('.sbc-new').isHidden());
   await p.locator('.sbc-messages').evaluate(n=>{n.scrollTop=0;n.dispatchEvent(new Event('scroll'));});
   const anchor=await p.locator('.sbc-msg').first().evaluate(n=>n.getBoundingClientRect().top);
   await p.locator('.sbc-older').click();await p.waitForTimeout(100);
   assert.equal(await p.locator('.sbc-msg').nth(10).evaluate(n=>n.getBoundingClientRect().top),anchor,'История сохраняет положение прежнего сообщения');
   await p.locator('.sbc-info').click();assert.ok(await p.locator('.sbc-conv__hint').isVisible());assert.equal(await p.locator('.sbc-conv__head').evaluate(n=>n.getBoundingClientRect().height),53);await p.locator('.sbc-info').click();
   await p.locator('.sbc-compose textarea').fill('1\n2\n3\n4\n5\n6\n7');
   const growth=await p.locator('.sbc-compose textarea').evaluate(n=>({height:n.offsetHeight,scroll:n.scrollHeight,overflow:getComputedStyle(n).overflowY}));assert.ok(growth.height<140&&growth.scroll>growth.height);assert.equal(growth.overflow,'auto');
   for(const room of ['dm:2-3','hugh:2']){
    await p.locator('.sbc-back').click();assert.ok(await p.locator('.mobile-shortcuts').isVisible());
    await p.locator(`[data-room="${room}"]`).click();assert.ok(await p.locator('.mobile-shortcuts').isHidden());
    assert.equal(await p.locator('.sbc-compose').evaluate(n=>n.getBoundingClientRect().bottom),844);
   }
   await p.setViewportSize({width:761,height:844});await p.waitForFunction(()=>!document.body.classList.contains('sbc-mobile-chat-open'));
   await p.setViewportSize({width:760,height:844});await p.waitForFunction(()=>document.body.classList.contains('sbc-mobile-chat-open'));
   await p.evaluate(()=>qa.controller.abort());assert.equal(await p.evaluate(()=>document.body.classList.contains('sbc-mobile-chat-open')),false);
  }
  await context.close();
 }
 // Проверка компьютера с одинаковыми данными, точное сравнение геометрии и шрифтов.
 const desktop=[];
 for(const version of ['before','after']){const{p,context}=await fixture(browser,version,1440,1000);desktop.push(await measure(p,version+'-desktop'));await context.close();}
 for(const key of ['head','list','compose','font','textFont'])assert.deepEqual(desktop[1][key],desktop[0][key],`Desktop ${key}`);
 fs.writeFileSync(path.join(__dirname,'metrics.json'),JSON.stringify(metrics,null,2));console.log(JSON.stringify({screenshots:6,metrics},null,2));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
