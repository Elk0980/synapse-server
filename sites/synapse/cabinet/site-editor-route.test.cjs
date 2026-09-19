// QA only: NODE_PATH=/tmp/palitra-dom-qa/node_modules node --test sites/synapse/cabinet/site-editor-route.test.cjs
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM,VirtualConsole}=require('jsdom');
const html=fs.readFileSync(path.join(__dirname,'../cabinet.html'),'utf8');

// Скрипт кабинета берётся из разобранного документа, а не поиском по тексту: перевод строк
// в рабочей копии может быть любым, и срез по '<script>\n' ломался бы на CRLF.
const cabinetScript=(()=>{
 const dom=new JSDOM(html);
 const found=[...dom.window.document.querySelectorAll('script:not([src])')]
  .map(node=>node.textContent).filter(text=>text.includes('canonicalSiteEditors'));
 dom.window.close();
 assert.equal(found.length,1,'inline-скрипт кабинета с маршрутизацией редакторов не найден');
 return found[0];
})();
const routingBlock=(()=>{
 const from=cabinetScript.indexOf('  const editorSupported =');
 const to=cabinetScript.indexOf('  const hasPermission =');
 assert.ok(from>=0&&to>from,'фрагмент маршрутизации редакторов не найден');
 const block=cabinetScript.slice(from,to);
 assert.ok(block.includes('canonicalSiteEditors')&&block.includes('redirectEditorHash'),'фрагмент вырезан не полностью');
 return block;
})();

const site=(id,company,status,{active=true,editSite=true}={})=>({
 id,name:id,company:{id:company,name:company},isActive:active,publicationStatus:status,
 publicUrl:`https://${id}.test/`,editorUrls:{site:`/site-editor.html?site=${id}`,price:`/price-editor.html?site=${company}`},
 capabilities:{view:true,create:false,editSite,editPrice:true,delete:false}});
// Порядок как у сервера: список отсортирован по названию, черновики впереди основного сайта.
const CATALOG={
 avokado:[site('avokado','avokado','draft'),site('avokado2','avokado','draft'),site('avokado3','avokado','published')],
 alvi:[site('alvi','alvi','published')],
 empty:[]};
const PROFILE={login:'owner',role:'owner',displayName:'Owner',permissions:[],csrfToken:'qa-csrf',
 companies:[{id:'avokado',name:'Авокадо'},{id:'alvi',name:'ALVI'}]};

// Полная страница кабинета с настоящими обработчиками: клик проверяется тем же кодом,
// который работает у владельца, а не вырезанным фрагментом.
function page({catalog='avokado',fail=false,hold=false,hash='#home'}={}){
 const errors=[],requested=[];let release;
 const gate=hold?new Promise(resolve=>{release=resolve;}):Promise.resolve();
 const vc=new VirtualConsole();vc.on('jsdomError',error=>errors.push(error.message));
 const dom=new JSDOM(html,{url:'https://cabinet.test/cabinet.html'+hash,runScripts:'outside-only',
  virtualConsole:vc,pretendToBeVisual:true});
 const w=dom.window,d=w.document;
 // jsdom не реализует matchMedia; кабинет спрашивает только про мобильную ширину.
 w.matchMedia=query=>({matches:false,media:query,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
 // jsdom не реализует scrollTo; кабинет зовёт его при смене раздела.
 w.scrollTo=()=>{};
 w.SbCabinet={views:new Proxy({},{get:()=>({render(){},updateSummary(){},initialize(){},onProjectChange(){}}),has:()=>true}),
  registerView(){},renderModuleGuide(){}};
 w.fetch=async(url)=>{
  const address=String(url);
  if(address.includes('/content/whoami'))return {ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(PROFILE))};
  if(address.includes('/content/sites')){
   requested.push(address);await gate;
   if(fail)throw new Error('network unavailable');
   const code=new w.URL(address,'https://cabinet.test/').searchParams.get('companyCode');
   const sites=(CATALOG[code==='avokado'?catalog:code]||[]).filter(item=>item.publicationStatus==='published');
   return {ok:true,status:200,json:async()=>({sites})};
  }
  return {ok:true,status:200,json:async()=>({})};};
 w.eval(cabinetScript);
 // Ждём и микрозадачи, и таймеры: смена hash доставляется отдельной задачей.
 const settle=async()=>{for(let i=0;i<20;i++){await new Promise(r=>setImmediate(r));await new Promise(r=>setTimeout(r,0));}};
 const byId=id=>d.getElementById(id);
 return {w,d,errors,requested,settle,
  release:async()=>{release?.();await settle();},
  siteLink:()=>byId('site-editor-link'),priceLink:()=>byId('price-editor-link'),
  siteHref:()=>byId('site-editor-link').getAttribute('href'),
  priceHref:()=>byId('price-editor-link').getAttribute('href'),
  state:()=>byId('site-editor-link').dataset.editorState,
  notice:()=>byId('editor-link-notice').hidden?'':byId('editor-link-notice').textContent,
  sitesVisible:()=>d.querySelector('[data-view="sites"]').hidden===false,
  click:element=>{const event=new w.MouseEvent('click',{bubbles:true,cancelable:true});element.dispatchEvent(event);return event;},
  chooseCompany:async id=>{for(const button of d.querySelectorAll('#project-menu button')){
    if(button.textContent.includes(id==='alvi'?'ALVI':'Авокадо')){button.click();break;}}
   await settle();},
  close:()=>w.close()};
}

test('быстрый клик до ответа каталога не открывает чужой черновик',async()=>{
 const f=page({hold:true});try{
  await f.settle();
  assert.equal(f.state(),'loading');
  // Прежний адрес компании не выставляется даже на мгновение.
  assert.notEqual(f.siteHref(),'site-editor.html?site=avokado');
  assert.equal(f.siteHref(),'#site-editor');
  assert.equal(f.siteLink().hasAttribute('target'),false);
  const event=f.click(f.siteLink());
  assert.equal(event.defaultPrevented,true,'клик должен быть перехвачен, а не открыть редактор');
  assert.match(f.notice(),/Определяем основной сайт/);
  await f.release();
  assert.equal(f.state(),'ready');
  assert.equal(f.siteHref(),'/site-editor.html?site=avokado3');
  assert.equal(f.siteLink().getAttribute('target'),'_blank');
  assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

test('у разрешённой компании с пустым каталогом кнопка ведёт в «Сайты», прайс не блокируется',async()=>{
 const f=page({catalog:'empty'});try{
  await f.settle();
  assert.equal(f.state(),'missing');
  assert.equal(f.siteHref(),'#sites');
  assert.equal(f.siteLink().hasAttribute('target'),false);
  // Прайс Авокадо общий и от каталога сайтов не зависит.
  assert.equal(f.priceHref(),'price-editor.html?site=avokado');
  assert.equal(f.priceLink().getAttribute('aria-disabled'),'false');
  const event=f.click(f.siteLink());
  assert.equal(event.defaultPrevented,true);
  assert.match(f.notice(),/нет опубликованного сайта/);
  await f.settle();
  assert.equal(f.w.location.hash,'#sites');
  assert.equal(f.sitesVisible(),true,'раздел «Сайты» должен действительно открыться');
  assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

test('недоступный каталог не отправляет в прежнюю версию и говорит об этом прямо',async()=>{
 const f=page({fail:true});try{
  await f.settle();
  assert.equal(f.state(),'unavailable');
  assert.equal(f.siteHref(),'#sites');
  assert.equal(f.requested.length,1,'сбой не должен сам себя повторять');
  const event=f.click(f.siteLink());
  assert.equal(event.defaultPrevented,true);
  assert.match(f.notice(),/Не удалось получить список сайтов/);
  assert.equal(f.priceHref(),'price-editor.html?site=avokado');
  await f.settle();
  assert.equal(f.sitesVisible(),true);
  // Повтор сделан только по клику пользователя, автоматических попыток нет.
  assert.equal(f.requested.length,2);
  assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

test('заход на #site-editor при недоступном каталоге делает один запрос и открывает «Сайты»',async()=>{
 const f=page({hash:'#site-editor',fail:true});try{
  await f.settle();await f.settle();
  assert.equal(f.requested.length,1,'ожидание на #site-editor не должно превращаться в очередь запросов');
  assert.equal(f.state(),'unavailable');
  assert.match(f.notice(),/Не удалось получить список сайтов/);
  assert.equal(f.w.location.hash,'#sites');
  assert.equal(f.sitesVisible(),true,'раздел «Сайты» должен быть виден, а не только адрес в строке');
  assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

test('заход на #site-editor с пустым каталогом открывает раздел «Сайты» с объяснением',async()=>{
 const f=page({hash:'#site-editor',catalog:'empty'});try{
  await f.settle();await f.settle();
  assert.equal(f.state(),'missing');
  assert.match(f.notice(),/нет опубликованного сайта/);
  assert.equal(f.w.location.hash,'#sites');
  assert.equal(f.sitesVisible(),true);
  assert.equal(f.requested.length,1);
  assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

test('ответ по прежней компании не меняет цель после смены компании',async()=>{
 const f=page({hold:true});try{
  await f.settle();
  assert.equal(f.state(),'loading');
  await f.chooseCompany('alvi');
  await f.release();
  // Пришедший позже ответ Авокадо не должен увести кнопку ALVI на avokado3.
  assert.equal(f.siteHref(),'/site-editor.html?site=alvi');
  assert.equal(f.priceHref(),'price-editor.html?site=alvi');
  assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});

// jsdom не выполняет location.replace и не даёт его подменить, поэтому успешный переход
// по хэшу проверяется на том же фрагменте кабинета с подставным location.
const routing=(initial='avokado')=>{
 const requested=[],replaced=[];let release;
 const gate=new Promise(resolve=>{release=resolve;});
 const dom=new JSDOM(html,{url:'https://cabinet.test/cabinet.html',runScripts:'outside-only'});
 const w=dom.window,d=w.document;
 const fake={hash:'#site-editor',replace:url=>replaced.push(url)};
 w.__deps={identity:{role:'owner',permissions:[]},byId:id=>d.getElementById(id),
  apiJson:async url=>{requested.push(url);await gate;
   const code=new w.URL(url,'https://cabinet.test/').searchParams.get('companyCode');
   return {sites:(CATALOG[code]||[]).filter(item=>item.publicationStatus==='published')};},
  location:fake,history:{replaceState(){}},navigate:()=>{}};
 w.eval(`window.__api=((deps)=>{
  let selectedProjectId=${JSON.stringify(initial)};
  const EDITOR_PROJECTS=Object.freeze(["alvi","avokado"]);
  const identity=deps.identity,byId=deps.byId,apiJson=deps.apiJson;
  const location=deps.location,history=deps.history,navigate=deps.navigate;
  const defaultView=()=>"home";
${routingBlock}
  return {updateEditorLinks,redirectEditorHash,choose:(id)=>{selectedProjectId=id;updateEditorLinks();}};
 })(window.__deps);`);
 const settle=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};
 return {w,d,api:w.__api,requested,replaced,fake,settle,
  release:async()=>{release();await settle();},close:()=>w.close()};
};

test('переход по #site-editor ждёт каталог и открывает основной сайт',async()=>{
 const f=routing();try{
  assert.equal(f.api.redirectEditorHash(),true);
  assert.deepEqual(f.replaced,[]);
  await f.release();
  assert.deepEqual(f.replaced,['/site-editor.html?site=avokado3']);
 }finally{f.close();}
});

test('ответ, пришедший после ухода с #site-editor или смены компании, никуда не уводит',async()=>{
 const left=routing();try{
  left.api.redirectEditorHash();
  left.fake.hash='#sites';
  await left.release();
  assert.deepEqual(left.replaced,[],'пользователь уже ушёл со страницы редактора');
 }finally{left.close();}
 const switched=routing();try{
  switched.api.redirectEditorHash();
  switched.api.choose('alvi');
  await switched.release();
  assert.deepEqual(switched.replaced,[],'ответ прежней компании не подменяет цель новой');
 }finally{switched.close();}
});

test('смена компании запрашивает каталог один раз на компанию',async()=>{
 const f=routing();try{
  await f.release();
  f.api.updateEditorLinks();await f.settle();
  assert.equal(f.d.getElementById('site-editor-link').getAttribute('href'),'/site-editor.html?site=avokado3');
  f.api.choose('alvi');await f.settle();
  assert.equal(f.d.getElementById('site-editor-link').getAttribute('href'),'/site-editor.html?site=alvi');
  f.api.choose('avokado');await f.settle();
  assert.equal(f.d.getElementById('site-editor-link').getAttribute('href'),'/site-editor.html?site=avokado3');
  assert.equal(f.requested.length,2,'разобранный ответ переиспользуется');
 }finally{f.close();}
});
