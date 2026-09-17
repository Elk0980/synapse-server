'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const SOURCE=fs.readFileSync(require.resolve('./reviews.js'),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value)),tick=()=>new Promise(resolve=>setImmediate(resolve));
const review=(id=1,companyCode='avokado')=>({id,companyCode,platform:'two_gis',author:'Автор '+companyCode,text:'Отзыв '+companyCode,rating:4,publishedAt:'2026-09-17T00:00:00.000Z',sourceUrl:'https://2gis.ru/irkutsk/firm/123/tab/reviews',status:'new',draftReply:'',note:'',publishedReply:'',replyUrl:'',revision:1});
const snapshot=(code,items=[])=>({company:{code,name:code==='avokado'?'Авокадо':'АЛВИ'},items,platforms:[{key:'two_gis',name:'2ГИС',cabinetUrl:'https://account.2gis.com/',publicUrl:'https://2gis.ru/irkutsk/firm/123',rules:'Правила '+code,revision:0,canSync:false,canReply:false,reason:'Работа вручную'}]});

async function fixture({role='owner',permissions=[],initialCode='avokado',data,override}={}){
 const dom=new JSDOM('<section id="view"></section>',{url:'https://cabinet.test/',runScripts:'outside-only'}),w=dom.window,d=w.document,views={},calls=[],copied=[];
 const stores=data||{avokado:snapshot('avokado',[review()]),alvi:snapshot('alvi',[review(2,'alvi')])};
 Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async text=>copied.push(text)}});
 w.fetch=()=>{throw Error('External requests are disabled in the reviews UI fixture');};
 w.SbCabinet={registerView:(name,view)=>{views[name]=view;}};w.eval(SOURCE);
 const ctx={selectedProjectId:initialCode,identity:{role,permissions,companies:[{id:'avokado',name:'Авокадо'},{id:'alvi',name:'АЛВИ'}]},
  csrfOptions:(method,body)=>({method,headers:{'X-CSRF-Token':'fixture-csrf'},body:JSON.stringify(body)}),
  apiJson:async(url,options={})=>{
   const parsed=new URL(url,'https://cabinet.test'),code=parsed.searchParams.get('companyCode'),body=options.body===undefined?undefined:JSON.parse(options.body);
   const call={url,path:parsed.pathname,code,query:Object.fromEntries(parsed.searchParams),method:options.method||'GET',body,options};calls.push(call);
   assert.equal(parsed.origin,'https://cabinet.test');assert.match(call.path,/^\/content\/crm\/reviews(?:\/|$)/);assert.ok(stores[code]);
   if(override){const value=await override(call);if(value!==undefined)return clone(value);}
   const store=stores[code];
   if(call.method==='GET'){
    const offset=Number(call.query.offset||0),limit=Number(call.query.limit||100),q=(call.query.q||'').toLocaleLowerCase('ru');
    const matches=store.items.filter(item=>(!call.query.platform||item.platform===call.query.platform)&&(!call.query.status||item.status===call.query.status)&&(!q||[item.author,item.text,item.draftReply].join(' ').toLocaleLowerCase('ru').includes(q)));
    const counts={total:store.items.length,...Object.fromEntries(['new','in_progress','answered'].map(status=>[status,store.items.filter(item=>item.status===status).length]))};
    return clone({...store,items:matches.slice(offset,offset+limit),counts,pagination:{total:matches.length,limit,offset,hasMore:offset+limit<matches.length}});
   }
   if(call.method==='POST'){
    const existing=store.items.find(item=>item.platform===body.platform&&item.sourceUrl===body.sourceUrl&&item.author===body.author&&item.text===body.text);
    if(existing)return {item:clone(existing),duplicate:true};
    const item={...review(Math.max(0,...Object.values(stores).flatMap(s=>s.items.map(item=>item.id)))+1,code),...body};store.items.unshift(item);return {item:clone(item),duplicate:false};
   }
   if(call.method==='PATCH'){
    const item=store.items.find(item=>String(item.id)===call.path.split('/').at(-1));assert.ok(item);assert.equal(body.revision,item.revision);Object.assign(item,body,{revision:item.revision+1});return {item:clone(item)};
   }
   if(call.method==='PUT'){
    const platform=store.platforms.find(item=>item.key===call.path.split('/').at(-1));assert.ok(platform);assert.equal(body.revision,platform.revision);Object.assign(platform,body,{revision:platform.revision+1});return {platform:clone(platform)};
   }
   throw Error('Unexpected fixture operation');
  }};
 const f={w,d,ctx,views,calls,copied,stores,node:id=>d.getElementById(id==='view'?'view':'reviews-'+id),settle:async()=>{for(let i=0;i<6;i++)await tick();},close:()=>w.close()};
 f.ready=views.reviews.render(f.node('view'),ctx);await f.ready;return f;
}
function openReview(f,id=1){f.node('list').querySelector(`[data-review="${id}"]`).click();}
async function submit(f,form){form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await f.settle();}
function fillNew(f,{author='Новый автор',text='Новый отзыв',sourceUrl='https://2gis.ru/irkutsk/firm/123/tab/reviews?review_id=new'}={}){
 const form=f.node('add-form');form.elements.author.value=author;form.elements.text.value=text;form.elements.sourceUrl.value=sourceUrl;return form;
}

test('reviews are read-only for viewers and absent without view permission; revoked access removes current data',async()=>{
 const denied=await fixture({role:'editor'});try{assert.equal(denied.calls.length,0);assert.equal(denied.node('view').children.length,0);}finally{denied.close();}
 const f=await fixture({role:'editor',permissions:['crm.view']});try{
  assert.equal(f.calls.length,1);openReview(f);
  for(const node of f.node('view').querySelectorAll('form input,form textarea,form select,form button,[data-write]'))assert.equal(node.disabled,true,node.outerHTML);
  await submit(f,f.node('reply-form'));await submit(f,fillNew(f));await submit(f,f.node('platforms').querySelector('form'));
  assert.ok(f.calls.every(call=>call.method==='GET'));
  await f.views.reviews.render(f.node('view'),{...f.ctx,identity:{...f.ctx.identity,permissions:[]}});
  assert.equal(f.node('view').children.length,0);assert.equal(f.d.body.textContent.includes('Отзыв avokado'),false);
 }finally{f.close();}
});

test('switching companies clears review, reply and add forms immediately and ignores a delayed old GET',async()=>{
 let release,delay=false;const f=await fixture({override:call=>delay&&call.method==='GET'&&call.code==='avokado'?new Promise(resolve=>{release=resolve;}):undefined});
 try{openReview(f);f.node('reply-form').elements.draftReply.value='UNSAVED AVOKADO REPLY';fillNew(f,{text:'UNSAVED AVOKADO REVIEW'});
  delay=true;f.node('refresh').click();await f.settle();assert.equal(typeof release,'function');
  await f.views.reviews.onProjectChange({...f.ctx,selectedProjectId:'alvi'});
  assert.equal(f.node('company').textContent,'АЛВИ');assert.equal(f.node('add-form').elements.text.value,'');assert.equal(f.node('reply-form'),null);assert.equal(f.node('add').open,false);
  assert.doesNotMatch(f.d.body.textContent,/UNSAVED AVOKADO|Отзыв avokado/);
  release(snapshot('avokado',[{...review(90),text:'STALE PRIVATE AVOKADO'}]));await f.settle();
  assert.doesNotMatch(f.d.body.textContent,/STALE PRIVATE AVOKADO|Отзыв avokado/);assert.match(f.node('list').textContent,/Отзыв alvi/);assert.equal(f.node('refresh').disabled,false);
 }finally{f.close();}
});

test('switching companies clears existing unsaved fields before the destination GET resolves',async()=>{
 let release;const f=await fixture({override:call=>call.method==='GET'&&call.code==='alvi'?new Promise(resolve=>{release=resolve;}):undefined});
 try{openReview(f);f.node('reply-form').elements.draftReply.value='PRIVATE REPLY';fillNew(f,{text:'PRIVATE NEW REVIEW'});f.node('add').open=true;
  const changing=f.views.reviews.onProjectChange({...f.ctx,selectedProjectId:'alvi'});await f.settle();
  assert.equal(f.node('reply-form'),null);assert.equal(f.node('add-form').elements.text.value,'');assert.equal(f.node('list').children.length,0);assert.equal(f.node('platforms').children.length,0);assert.doesNotMatch(f.d.body.textContent,/Отзыв avokado|PRIVATE REPLY|PRIVATE NEW REVIEW/);
  release(snapshot('alvi',[review(2,'alvi')]));await changing;assert.match(f.node('list').textContent,/Отзыв alvi/);
 }finally{f.close();}
});

test('review and platform text are escaped and unsafe source, cabinet and reply links are absent',async()=>{
 const malicious='<img src=x onerror="alert(1)"><script>attack()</script>';
 const data={avokado:snapshot('avokado',[{...review(),author:malicious,text:malicious,draftReply:malicious,note:malicious,status:'answered',publishedReply:malicious,sourceUrl:'javascript:alert(1)',replyUrl:'https://user:password@example.test/'}]),alvi:snapshot('alvi')};
 Object.assign(data.avokado.platforms[0],{name:malicious,rules:malicious,reason:malicious,cabinetUrl:'javascript:alert(1)',publicUrl:'data:text/html,attack'});
 const f=await fixture({data});try{openReview(f);assert.equal(f.node('view').querySelectorAll('img,script').length,0);assert.equal(f.node('view').querySelectorAll('a').length,0);assert.ok(f.node('detail').textContent.includes(malicious));assert.equal(f.node('reply-form').elements.draftReply.value,malicious);assert.equal(f.node('platforms').querySelector('[name=rules]').value,malicious);assert.equal(f.calls.length,1);}finally{f.close();}
});

test('adding the same review twice preserves one queue item and sends only company-scoped explicit POSTs',async()=>{
 const f=await fixture({data:{avokado:snapshot('avokado'),alvi:snapshot('alvi')}});try{
  await submit(f,fillNew(f));const id=f.stores.avokado.items[0].id;assert.equal(f.node('list').querySelectorAll('[data-review]').length,1);assert.equal(f.node('add-form').elements.text.value,'');
  await submit(f,fillNew(f));assert.equal(f.node('list').querySelectorAll('[data-review]').length,1);assert.equal(f.stores.avokado.items.length,1);assert.equal(f.stores.avokado.items[0].id,id);assert.match(f.node('status').textContent,/уже есть в очереди/);
  const posts=f.calls.filter(call=>call.method==='POST');assert.equal(posts.length,2);assert.ok(posts.every(call=>call.code==='avokado'&&call.path==='/content/crm/reviews'&&call.options.headers['X-CSRF-Token']==='fixture-csrf'));assert.ok(posts.every(call=>!Object.hasOwn(call.body,'status')));
 }finally{f.close();}
});

test('saving and copying a draft never publish or mark it answered',async()=>{
 const f=await fixture({role:'editor',permissions:['crm.view','crm.edit']});try{openReview(f);f.node('reply-form').elements.draftReply.value='Спасибо! Проверим детали.';f.node('reply-form').elements.note.value='Внутренняя заметка';
  const before=f.calls.length;f.node('copy').click();await f.settle();assert.equal(f.calls.length,before);assert.deepEqual(f.copied,['Спасибо! Проверим детали.']);assert.equal(f.stores.avokado.items[0].status,'new');
  await submit(f,f.node('reply-form'));const saved=f.calls.filter(call=>call.method==='PATCH').at(-1);assert.equal(saved.path,'/content/crm/reviews/1');assert.equal(saved.code,'avokado');assert.deepEqual(saved.body,{revision:1,draftReply:'Спасибо! Проверим детали.',note:'Внутренняя заметка',status:'in_progress'});
  assert.equal(f.stores.avokado.items[0].status,'in_progress');assert.equal(f.stores.avokado.items[0].revision,2);assert.match(f.node('status').textContent,/На площадку он не отправлен/);
  const afterSave=f.calls.length;f.node('copy').click();await f.settle();assert.equal(f.calls.length,afterSave);assert.equal(f.calls.filter(call=>call.method!=='GET').length,1);assert.equal(f.stores.avokado.items[0].status,'in_progress');assert.ok(f.calls.every(call=>call.path.startsWith('/content/crm/reviews')));
 }finally{f.close();}
});

test('manual publication confirmation requires checked evidence, text and a valid URL before PATCH',async()=>{
 const f=await fixture();try{openReview(f);const form=f.node('confirm-form'),checked=form.querySelector('[type=checkbox]');form.elements.publishedReply.value='Фактически опубликованный ответ';const before=f.calls.length;
  await submit(f,form);assert.equal(f.calls.length,before,'unchecked confirmation cannot save');checked.checked=true;
  form.elements.replyUrl.value='';await submit(f,form);assert.equal(f.calls.length,before,'empty URL cannot save');
  form.elements.replyUrl.value='not a url';await submit(f,form);assert.equal(f.calls.length,before,'malformed URL cannot save');
  form.elements.replyUrl.value='https://2gis.ru/irkutsk/firm/123/tab/reviews?review_id=1';form.elements.publishedReply.value='';await submit(f,form);assert.equal(f.calls.length,before,'empty published text cannot save');
  form.elements.publishedReply.value='Фактически опубликованный ответ';await submit(f,form);
  assert.deepEqual(f.calls.filter(call=>call.method==='PATCH').at(-1).body,{revision:1,status:'answered',publishedReply:'Фактически опубликованный ответ',replyUrl:'https://2gis.ru/irkutsk/firm/123/tab/reviews?review_id=1'});assert.equal(f.stores.avokado.items[0].status,'answered');assert.match(f.node('status').textContent,/Автоматическая проверка площадки не выполнялась/);assert.equal(f.node('confirm-form'),null);
  assert.deepEqual([...f.node('counts').querySelectorAll('strong')].map(node=>Number(node.textContent)),[1,0,1],'confirmed publication refreshes the global status counts');
 }finally{f.close();}
});

test('review and platform revision conflicts keep entered values and explain refresh without claiming success',async()=>{
 const f=await fixture({override:call=>{if(['PATCH','PUT'].includes(call.method))throw Object.assign(Error('Internal conflict detail'),{status:409});}});
 try{openReview(f);f.node('reply-form').elements.draftReply.value='Сохранить этот ввод';await submit(f,f.node('reply-form'));assert.equal(f.node('reply-form').elements.draftReply.value,'Сохранить этот ввод');assert.match(f.node('status').textContent,/уже изменилась.*Обновите раздел/);assert.equal(f.stores.avokado.items[0].revision,1);assert.doesNotMatch(f.node('status').textContent,/Internal conflict|Черновик сохранён/);
  const form=f.node('platforms').querySelector('form');form.elements.rules.value='Новые правила';await submit(f,form);assert.equal(form.elements.rules.value,'Новые правила');assert.match(f.node('status').textContent,/уже изменилась/);assert.equal(f.calls.at(-1).body.revision,0);assert.equal(f.stores.avokado.platforms[0].revision,0);
 }finally{f.close();}
});

test('late write responses cannot replace another company and revoked permission ignores pending responses',async()=>{
 let release;const f=await fixture({override:call=>call.method==='PATCH'?new Promise(resolve=>{release=resolve;}):undefined});
 try{openReview(f);f.node('reply-form').elements.draftReply.value='Old company draft';f.node('reply-form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await f.settle();
  await f.views.reviews.onProjectChange({...f.ctx,selectedProjectId:'alvi'});release({item:{...review(),author:'STALE WRITE AUTHOR',revision:2}});await f.settle();assert.match(f.node('list').textContent,/Отзыв alvi/);assert.doesNotMatch(f.d.body.textContent,/STALE WRITE AUTHOR|Черновик сохранён/);
  openReview(f,2);f.node('reply-form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await f.settle();
  await f.views.reviews.render(f.node('view'),{...f.ctx,selectedProjectId:'alvi',identity:{...f.ctx.identity,role:'editor',permissions:[]}});release({item:{...review(2,'alvi'),author:'REVOKED PRIVATE DATA',revision:2}});await f.settle();assert.equal(f.node('view').children.length,0);assert.doesNotMatch(f.d.body.textContent,/REVOKED PRIVATE DATA/);
 }finally{f.close();}
});

test('review pagination reaches all rows while filters search the full company queue and counts stay global',async()=>{
 const items=Array.from({length:210},(_,index)=>({...review(index+1),platform:index<100?'two_gis':'vk',status:index<100?'new':index<200?'answered':'in_progress',author:index<200?'Обычный автор':'Искомый автор',text:'Отзыв №'+(index+1)}));
 const f=await fixture({data:{avokado:snapshot('avokado',items),alvi:snapshot('alvi')}});
 const counts=()=>[...f.node('counts').querySelectorAll('strong')].map(node=>Number(node.textContent));
 const ids=()=>[...f.node('list').querySelectorAll('[data-review]')].map(node=>Number(node.dataset.review));
 async function change(id,value){f.node(id).value=value;f.node(id).dispatchEvent(new f.w.Event('change',{bubbles:true}));await f.settle();}
 try{
  assert.equal(ids().length,100);assert.equal(f.node('previous').disabled,true);assert.equal(f.node('next').disabled,false);assert.deepEqual(counts(),[210,110,100]);
  const seen=new Set(ids());f.node('next').click();await f.settle();ids().forEach(id=>seen.add(id));assert.equal(ids()[0],101);assert.match(f.node('page-label').textContent,/101–200 из 210/);assert.deepEqual(counts(),[210,110,100]);
  f.node('next').click();await f.settle();ids().forEach(id=>seen.add(id));assert.equal(ids().length,10);assert.equal(seen.size,210);assert.equal(f.node('next').disabled,true);assert.match(f.node('page-label').textContent,/201–210 из 210/);
  f.node('previous').click();await f.settle();assert.equal(ids()[0],101);
  await change('platform-filter','vk');assert.equal(f.calls.at(-1).query.offset,'0');assert.equal(f.calls.at(-1).query.platform,'vk');assert.equal(ids().length,100);assert.match(f.node('page-label').textContent,/из 110/);assert.deepEqual(counts(),[210,110,100]);
  await change('state-filter','in_progress');assert.equal(f.calls.at(-1).query.status,'in_progress');assert.deepEqual(ids(),Array.from({length:10},(_,i)=>201+i));assert.equal(f.node('previous').disabled,true);assert.equal(f.node('next').disabled,true);assert.deepEqual(counts(),[210,110,100]);
  await change('platform-filter','');await change('state-filter','');assert.equal(ids()[0],1);
  f.node('search').value='  Искомый автор  ';f.node('search').dispatchEvent(new f.w.Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,350));await f.settle();
  assert.equal(f.calls.at(-1).query.q,'Искомый автор');assert.equal(f.calls.at(-1).query.offset,'0');assert.deepEqual(ids(),Array.from({length:10},(_,i)=>201+i),'search finds matches beyond the first unfiltered page');assert.deepEqual(counts(),[210,110,100]);
  assert.ok(f.calls.every(call=>call.method==='GET'&&call.code==='avokado'));
 }finally{f.close();}
});
