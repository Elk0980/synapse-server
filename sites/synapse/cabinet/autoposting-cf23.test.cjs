'use strict';
// CF23 (клиент): версия для площадки и полная история карточки. Синтетический сервер в памяти по CONTRACT.md снимка
// CONTENT_FACTORY_CF23_BACKEND_REVIEW_20261001. Реальных API, публикаций и сообщений нет.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const scripts=['company-information.js','autoposting.js'].map(file=>fs.readFileSync(require.resolve('./'+file),'utf8'));
const clone=value=>JSON.parse(JSON.stringify(value));
const row=(id,extra={})=>({id,companyCode:'alpha',revision:4,contentRevision:3,status:'draft',title:'Материал '+id,text:'Проверенный текст',mediaUrls:['https://example.test/material.webp'],
  platformIds:['telegram'],scheduledAt:'2026-09-24T23:00:00Z',timezone:'Asia/Irkutsk',profileRevision:2,captions:{telegram:'Подпись'},deliveries:[],readiness:{ready:true,issues:[]},
  approval:{approved:false,stale:false},history:[],...extra});
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
const netError=()=>Object.assign(new Error('Failed to fetch'),{});
const httpError=(status,message,code)=>Object.assign(new Error(message),{status,...(code?{code}:{})});

/* Сервер: варианты по ключу запроса (повтор — исторический DTO первого ответа), история по курсору id DESC. */
function server({entries=[row(1)],history={}}={}){
  const posts=clone(entries),requests=new Map(),journal=new Map(Object.entries(history).map(([id,items])=>[Number(id),items]));
  const hooks={variant:null,get:null,history:null};
  const createVariant=(code,id,body)=>{
    const source=posts.find(item=>item.id===id&&item.companyCode===code);if(!source)throw httpError(404,'Публикация не найдена','NOT_FOUND');
    const serialized=JSON.stringify({postId:id,revision:body.revision,platformId:body.platformId}),seen=requests.get(code+':'+body.clientRequestId);
    if(seen){if(seen.payload!==serialized)throw httpError(409,'Этот запрос уже использован для другой версии','REQUEST_CONFLICT');return {...clone(seen.result),created:false};}
    if(source.archive?.archivedAt)throw httpError(409,'Карточка удалена','POST_ARCHIVED');
    if(source.revision!==body.revision)throw httpError(409,'Публикация уже изменена','REVISION_CONFLICT');
    if(source.planLinked)throw httpError(409,'Создайте и отдельно согласуйте версию нужной площадки в контент-плане.','PLAN_LINKED_POST');
    const child={...clone(source),id:Math.max(...posts.map(item=>item.id))+1,revision:1,contentRevision:1,platformIds:[body.platformId],scheduledAt:null,status:'draft',
      captions:{},approvalRequired:true,history:[],variantOf:{postId:source.id,revision:source.revision,contentRevision:source.contentRevision},
      rootIdea:source.rootIdea||{postId:source.id,contentRevision:source.contentRevision}};
    posts.push(child);const result={companyCode:code,created:true,post:clone(child)};requests.set(code+':'+body.clientRequestId,{payload:serialized,result});return result;
  };
  const readHistory=(code,id,params)=>{
    const source=posts.find(item=>item.id===id&&item.companyCode===code);if(!source)throw httpError(404,'Материал не найден');
    const limit=Number(params.get('limit')||30),before=params.get('before')?Number(params.get('before')):null;
    const rows=(journal.get(id)||[]).filter(item=>before===null||item.id<before).sort((a,b)=>b.id-a.id),items=rows.slice(0,limit);
    return {companyCode:code,postId:id,contentRevision:source.contentRevision,items:clone(items),hasMore:rows.length>limit,nextBefore:rows.length>limit?items.at(-1).id:null};
  };
  return {posts,requests,journal,hooks,createVariant,readHistory};
}

async function fixture({srv=server(),role='owner',permissions=[]}={}){
  const dom=new JSDOM('<section id="view"></section>',{url:'https://fixture.test/cabinet.html#content-factory/plan',runScripts:'outside-only'}),w=dom.window,d=w.document,views={},calls=[];
  const NativeDate=w.Date;w.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2026-09-24T23:30:00Z']));}static now(){return Date.parse('2026-09-24T23:30:00Z');}};
  w.SbCabinet={registerView:(name,view)=>{views[name]=view;}};scripts.forEach(source=>w.eval(source));
  const ctx={selectedProjectId:'alpha',identity:{role,permissions,companies:[{id:'alpha',name:'Тест А'},{id:'beta',name:'Тест Б'}]},
    csrfOptions:(method,body)=>({method,headers:{'X-CSRF-Token':'fixture'},body:JSON.stringify(body)}),
    apiJson:async(url,options={})=>{
      const parsed=new URL(url,'https://fixture.test'),code=parsed.searchParams.get('companyCode'),path=parsed.pathname,method=options.method||'GET',call={code,path,method,url,options,query:parsed.searchParams};calls.push(call);
      if(path.endsWith('/company-information'))return {companyCode:code,revision:2,profile:{timezone:'Asia/Irkutsk'}};
      if(path.endsWith('/settings'))return {timezone:'Asia/Irkutsk',channels:[{id:'telegram',platform:'telegram',name:'Telegram',enabled:true,connected:true,revision:1,provider:'direct'}]};
      if(path.endsWith('/starter-plan'))return {companyCode:code,available:false};
      if(path.endsWith('/calendar')){
        const from=parsed.searchParams.get('from'),to=parsed.searchParams.get('to');
        const items=srv.posts.filter(item=>item.companyCode===code).map(item=>{const publishDate=item.scheduledAt?w.SbCabinet.companyTime.toLocal(item.scheduledAt,'Asia/Irkutsk').slice(0,10):null;return {...clone(item),publishDate,effectiveDate:publishDate,dateKind:publishDate?'schedule':null};});
        return {companyCode:code,from,to,timezone:'Asia/Irkutsk',today:'2026-09-25',posts:items.filter(item=>item.effectiveDate&&item.effectiveDate>=from&&item.effectiveDate<=to),undated:items.filter(item=>!item.effectiveDate),truncated:false,undatedTruncated:false};
      }
      if(path.endsWith('/archived'))return {companyCode:code,posts:[]};
      if(path.endsWith('/posts'))return {companyCode:code,posts:clone(srv.posts.filter(item=>item.companyCode===code&&(srv.listArchived||!item.archive?.archivedAt)))};
      const variant=path.match(/\/posts\/(\d+)\/variants$/);
      if(variant){assert.equal(method,'POST');assert.equal(options.headers['X-CSRF-Token'],'fixture');const body=JSON.parse(options.body);
        if(srv.hooks.variant)return clone(await srv.hooks.variant({code,id:Number(variant[1]),body,call}));return clone(srv.createVariant(code,Number(variant[1]),body));}
      const history=path.match(/\/posts\/(\d+)\/history$/);
      if(history){assert.equal(method,'GET');if(srv.hooks.history)return clone(await srv.hooks.history({code,id:Number(history[1]),call}));return srv.readHistory(code,Number(history[1]),parsed.searchParams);}
      const one=path.match(/\/posts\/(\d+)$/);assert.ok(one,path);
      const item=srv.posts.find(value=>value.id===Number(one[1])&&value.companyCode===code);
      if(method==='GET'){if(srv.hooks.get){const out=await srv.hooks.get({code,id:Number(one[1]),call});if(out!==undefined)return clone(out);}if(!item)throw httpError(404,'Не найдено');return clone(item);}
      throw Error('Unexpected write '+method+' '+path);
    }};
  await views.autoposting.render(d.getElementById('view'),ctx);
  const f={w,d,ctx,views,calls,srv,node:id=>d.getElementById(id),settle,
    set(id,value,type='change'){const node=f.node(id);node.value=value;node.dispatchEvent(new w.Event(type,{bubbles:true}));},
    async click(selector){const node=d.querySelector(selector);assert.ok(node,selector);node.click();await settle();},
    async open(id){f.set('autoposting-select',String(id));await settle();},
    writes:()=>calls.filter(call=>call.method!=='GET'),status:()=>f.node('autoposting-status').textContent,
    variantStatus:()=>d.querySelector('[data-variant-status]')?.textContent||'',
    historyBody:()=>d.querySelector('[data-ap-history] [data-ap-history-body]'),
    async expandHistory(){const node=d.querySelector('[data-ap-history]');node.open=true;node.dispatchEvent(new w.Event('toggle'));await settle();},
    close:()=>w.close()};
  await settle();return f;
}
const pickVariant=async(f,platform)=>{f.set('autoposting-variant-platform',platform);await f.click('#autoposting-variant-create');};

// ---------- Версия для площадки ----------
test('CF23 версия: одна из семи площадок, POST с ключом и сохранённой версией; после 201 — свежий GET новой карточки, а не квитанция', async()=>{
  const f=await fixture();try{
    await f.open(1);
    const panel=f.d.querySelector('[data-variant]');assert.ok(panel);assert.equal(panel.open,false,'действие свёрнуто');
    assert.deepEqual([...f.d.querySelectorAll('#autoposting-variant-platform option')].map(o=>o.value).filter(Boolean),['telegram','vk','instagram','youtube_shorts','tiktok','rutube','max']);
    assert.ok(f.d.querySelector('[aria-controls="ap-hint-f-autoposting-variant-platform"]'),'у поля есть «?»');
    // Сервер «после создания» отдаёт свежую карточку с ручной правкой: экран должен показать её, а не снимок ответа.
    f.srv.hooks.get=({id})=>{const item=f.srv.posts.find(p=>p.id===id);if(id===2&&item)return {...item,title:'Правка после создания',revision:2};};
    await f.click('#autoposting-variant-create');
    assert.match(f.variantStatus(),/Выберите площадку/);assert.equal(f.writes().length,0,'без площадки ничего не отправлено');
    await pickVariant(f,'tiktok');
    const post=f.writes().at(-1);
    assert.equal(post.path,'/content/crm/autoposting/posts/1/variants');assert.equal(post.code,'alpha');
    const body=JSON.parse(post.options.body);assert.deepEqual(Object.keys(body).sort(),['clientRequestId','platformId','revision']);
    assert.equal(body.revision,4);assert.equal(body.platformId,'tiktok');assert.match(body.clientRequestId,/^[A-Za-z0-9_-]{8,100}$/);
    assert.ok(f.calls.some(c=>c.method==='GET'&&c.path==='/content/crm/autoposting/posts/2'),'свежий GET новой карточки');
    assert.equal(f.node('autoposting-select').value,'2');assert.equal(f.node('autoposting-title').value,'Правка после создания');
    assert.match(f.d.querySelector('[data-variant-origin]').textContent,/из материала №1 \(содержимое v3\)/);
    assert.match(f.status(),/Версия создана: материал №2 для TikTok\. Черновик без даты, нужно своё согласование/);
    assert.equal(f.srv.posts.find(p=>p.id===1).revision,4,'источник не изменён');assert.equal(f.writes().length,1);
  }finally{f.close();}
});

test('CF23 версия: ответ потерян — «Отправить ещё раз» тем же ключом и телом, площадку не сменить; повтор 200 — та же карточка, второй нет', async()=>{
  const f=await fixture();try{
    await f.open(1);let first=true;
    f.srv.hooks.variant=({code,id,body})=>{const result=f.srv.createVariant(code,id,body);if(first){first=false;throw netError();}return result;};
    await pickVariant(f,'vk');
    assert.match(f.variantStatus(),/Ответ не получен.*Версия могла быть создана.*тот же запрос/);
    assert.match(f.node('autoposting-variant-create').textContent,/Отправить ещё раз \(ВКонтакте\)/);
    assert.equal(f.node('autoposting-variant-platform').disabled,true);
    assert.equal(f.node('autoposting-select').value,'1','ничего не открыто');
    await f.click('#autoposting-variant-create');
    const [a,b]=f.writes().map(c=>JSON.parse(c.options.body));assert.deepEqual(a,b,'тот же ключ и тело');
    assert.equal(f.srv.posts.filter(p=>p.variantOf).length,1,'вторая версия не создана');
    assert.equal(f.node('autoposting-select').value,'2');assert.match(f.status(),/уже была создана раньше: материал №2/);
    assert.ok(f.calls.some(c=>c.method==='GET'&&c.path==='/content/crm/autoposting/posts/2'));
  }finally{f.close();}
});

test('CF23 версия: свежая карточка не загрузилась — номер созданной версии и «Открыть №…» без повторного создания', async()=>{
  const f=await fixture();try{
    await f.open(1);let fail=true;
    f.srv.hooks.get=({id})=>{if(id===2&&fail)throw httpError(503,'Ошибка сервера, попробуйте позже');};
    await pickVariant(f,'max');
    assert.match(f.status(),/Версия создана: материал №2\. Загрузить её текущую карточку не удалось — повторно создавать не нужно/);
    assert.equal(f.node('autoposting-select').value,'1');
    fail=false;await f.click('[data-variant-open="2"]');
    assert.equal(f.node('autoposting-select').value,'2');assert.equal(f.writes().length,1,'POST был один');
  }finally{f.close();}
});

test('CF23 версия: PLAN_LINKED_POST и другие отказы — понятная причина, без автоповтора и без нового ключа', async()=>{
  const f=await fixture({srv:server({entries:[row(1,{planLinked:true})]})});try{
    await f.open(1);await pickVariant(f,'instagram');
    assert.match(f.variantStatus(),/пришёл из контент-плана.*отдельную версию идеи в плане и согласуйте.*Ничего не создано/);
    assert.equal(f.node('autoposting-variant-create').textContent,'Создать версию');assert.equal(f.node('autoposting-variant-platform').disabled,false);
    assert.equal(f.writes().length,1);assert.ok(!f.calls.some(c=>c.path.endsWith('/posts/2')));
    f.srv.posts[0].planLinked=false;f.srv.posts[0].revision=5; // карточку изменили в другом окне
    await f.click('#autoposting-variant-create');
    assert.match(f.variantStatus(),/уже изменена в другом окне/);
    const keys=f.writes().map(c=>JSON.parse(c.options.body).clientRequestId);assert.notEqual(keys[0],keys[1],'новое явное нажатие после отказа — новый ключ');
    // Как в настоящем стенде: код отказа лежит в details.code и до кабинета не доходит — виден текст сервера, без автоповтора.
    f.srv.hooks.variant=()=>{throw httpError(409,'Создайте и отдельно согласуйте версию нужной площадки в контент-плане.');};
    await f.click('#autoposting-variant-create');
    assert.match(f.variantStatus(),/Сервер отказал: Создайте и отдельно согласуйте версию нужной площадки в контент-плане\. Ничего не создано; новый запрос автоматически не отправлялся/);
    assert.equal(f.node('autoposting-variant-create').textContent,'Создать версию');
  }finally{f.close();}
});

test('CF23 версия: несохранённые правки — предупреждение, версия из сохранённой, ввод остаётся в исходной карточке', async()=>{
  const f=await fixture();try{
    await f.open(1);
    f.set('autoposting-text','Несохранённая правка','input');await settle();
    assert.equal(f.d.querySelector('[data-variant-dirty]').hidden,false);assert.equal(f.node('autoposting-variant-create').textContent,'Создать из сохранённой версии');
    await pickVariant(f,'telegram');
    assert.equal(JSON.parse(f.writes()[0].options.body).revision,4,'сохранённая версия источника');
    assert.equal(f.node('autoposting-select').value,'2');assert.match(f.status(),/несохранённые правки остались в нём/);
    await f.open(1);assert.equal(f.node('autoposting-text').value,'Несохранённая правка','ввод не потерян');
  }finally{f.close();}
});

test('CF23 версия: смена компании во время запроса — новая карточка не открывается; повтор остаётся тем же запросом', async()=>{
  const f=await fixture();try{
    await f.open(1);let release;const gate=new Promise(r=>{release=r;});
    f.srv.hooks.variant=async({code,id,body})=>{await gate;return f.srv.createVariant(code,id,body);};
    f.set('autoposting-variant-platform','youtube_shorts');f.node('autoposting-variant-create').click();await settle();
    f.set('autoposting-company','beta');await settle();
    release();await settle();
    assert.ok(!f.calls.some(c=>c.path.endsWith('/posts/2')),'карточку новой версии не загружали');
    assert.notEqual(f.node('autoposting-select').value,'2');
    f.set('autoposting-company','alpha');await settle();await f.open(1);
    assert.match(f.node('autoposting-variant-create').textContent,/Отправить ещё раз \(YouTube Shorts\)/,'исход неизвестен — повтор тем же запросом');
    await f.click('#autoposting-variant-create');
    assert.equal(f.srv.posts.filter(p=>p.variantOf).length,1);assert.equal(f.node('autoposting-select').value,'2');
  }finally{f.close();}
});

test('CF23 версия: удалённая карточка и просмотр без права правки — действия нет; связь версии видна', async()=>{
  const child=row(2,{variantOf:{postId:1,revision:4,contentRevision:3},rootIdea:{postId:7,contentRevision:2},platformIds:['vk']});
  const f=await fixture({srv:server({entries:[row(1),child]}),role:'client',permissions:['autoposting.view']});try{
    await f.open(2);
    assert.equal(f.d.querySelector('[data-variant]'),null,'без права правки создавать нельзя');
    assert.match(f.d.querySelector('[data-variant-origin]').textContent,/из материала №1 \(содержимое v3\); исходная идея — материал №7\. У версии своё согласование/);
  }finally{f.close();}
  const archivedSrv=server({entries:[row(1,{archive:{archivedAt:'2026-09-20T00:00:00Z'}}),row(3)]});archivedSrv.listArchived=true;
  const g=await fixture({srv:archivedSrv});try{
    await g.open(1);assert.equal(g.d.querySelector('[data-variant]'),null,'удалённая карточка источником не предлагается');
    await g.open(3);assert.ok(g.d.querySelector('[data-variant]'),'у обычной карточки действие есть');
  }finally{g.close();}
});

// ---------- Полная история ----------
const entriesFor=(count,id=1)=>Array.from({length:count},(_,i)=>({id:1000+i,action:['submitted','approved','rejected','edited'][i%4],contentRevision:1+Math.floor(i/4),
  comment:i===count-1?'<img src=x onerror=alert(1)> последний':`запись ${i}`,actorName:i%5===0?'':'Влад',createdAt:new Date(Date.UTC(2026,8,1,0,i)).toISOString()}));

test('CF23 история: раскрытие — курсор до конца (65 записей), без дублей, экранирование; форма и комментарий не пересоздаются', async()=>{
  const srv=server({entries:[row(1,{history:[{action:'submitted',contentRevision:3,comment:'',actorName:'Влад',createdAt:'2026-09-20T01:00:00Z'}]})],history:{1:entriesFor(65)}});
  let duplicate=true;
  srv.hooks.history=({code,id,call})=>{const page=srv.readHistory(code,id,call.query);
    if(call.query.get('before')&&duplicate){duplicate=false;page.items.unshift(clone(srv.journal.get(1).find(x=>x.id===Number(call.query.get('before')))));} // сервер повторил запись на стыке
    return page;};
  const f=await fixture({srv});try{
    await f.open(1);
    const details=f.d.querySelector('[data-ap-history]');assert.equal(details.open,false);
    assert.match(details.querySelector('summary').textContent,/История согласования \(в карточке: 1\)/);
    assert.match(f.historyBody().textContent,/Предварительно — последние записи из карточки \(1\), не вся история/);
    assert.ok(!f.calls.some(c=>c.path.endsWith('/history')),'до раскрытия не запрашивается');
    const comment=f.node('autoposting-reject-comment');comment.value='Набранный комментарий возврата';
    await f.expandHistory();
    const first=f.calls.filter(c=>c.path.endsWith('/history'));assert.equal(first.length,1);assert.equal(first[0].query.get('limit'),'30');assert.equal(first[0].query.get('before'),null);
    assert.equal(f.d.querySelectorAll('[data-history-full] li').length,30);
    await f.click('[data-history-more]');await f.click('[data-history-more]');
    const pages=f.calls.filter(c=>c.path.endsWith('/history')).map(c=>c.query.get('before'));assert.deepEqual(pages,[null,'1035','1005']);
    const ids=[...f.d.querySelectorAll('[data-history-full] li')].map(li=>li.dataset.historyId);
    assert.equal(ids.length,65);assert.equal(new Set(ids).size,65,'дубль на стыке страниц отброшен');
    assert.equal(f.d.querySelector('[data-history-more]'),null);assert.match(f.historyBody().textContent,/Это вся история: записей 65/);
    assert.equal(f.d.querySelector('[data-history-full] img'),null,'комментарий экранирован');
    assert.match(f.historyBody().textContent,/исполнитель не указан/);
    assert.equal(f.node('autoposting-reject-comment'),comment,'форма возврата не пересоздана');assert.equal(comment.value,'Набранный комментарий возврата');
    assert.ok(f.calls.filter(c=>c.path.endsWith('/history')).every(c=>c.method==='GET'));assert.equal(f.writes().length,0);
  }finally{f.close();}
});

test('CF23 история: 403 и 404 — не пустая история; предварительные записи названы; «Повторить» загружает', async()=>{
  for(const [status,pattern] of [[403,/Нет права просматривать историю этой карточки\. Это не пустая история/],[404,/Карточка не найдена в этой компании/]]){
    const srv=server({entries:[row(1,{history:[{action:'approved',contentRevision:3,comment:'',actorName:'Влад',createdAt:'2026-09-20T01:00:00Z'}]})],history:{1:entriesFor(3)}});
    let fail=true;srv.hooks.history=({code,id,call})=>{if(fail)throw httpError(status,'x');return srv.readHistory(code,id,call.query);};
    const f=await fixture({srv});try{
      await f.open(1);await f.expandHistory();
      assert.match(f.historyBody().textContent,pattern);assert.doesNotMatch(f.historyBody().textContent,/Записей истории нет/);
      assert.match(f.historyBody().textContent,/Ниже — только предварительные записи из карточки/);
      fail=false;await f.click('[data-history-retry]');
      assert.equal(f.d.querySelectorAll('[data-history-full] li').length,3);assert.match(f.historyBody().textContent,/Это вся история: записей 3/);
    }finally{f.close();}
  }
});

test('CF23 история: поздний ответ не попадает в другую карточку; у каждой карточки своё состояние', async()=>{
  const srv=server({entries:[row(1),row(2,{title:'Второй'})],history:{1:entriesFor(4),2:[{id:5000,action:'submitted',contentRevision:1,comment:'вторая карточка',actorName:'Анна',createdAt:'2026-09-21T00:00:00Z'}]}});
  let release;const gate=new Promise(r=>{release=r;});
  srv.hooks.history=async({code,id,call})=>{if(id===1)await gate;return srv.readHistory(code,id,call.query);};
  const f=await fixture({srv});try{
    await f.open(1);await f.expandHistory();assert.match(f.historyBody().textContent,/Загружаем полную историю/);
    await f.open(2);
    const details=f.d.querySelector('[data-ap-history]');if(!details.open)await f.expandHistory();
    release();await settle();
    assert.equal(f.d.querySelector('[data-ap-history]').dataset.apHistory,'2');
    assert.deepEqual([...f.d.querySelectorAll('[data-history-full] li')].map(li=>li.dataset.historyId),['5000'],'чужие записи не попали');
    await f.open(1);if(!f.d.querySelector('[data-ap-history]').open)await f.expandHistory();
    assert.equal(f.d.querySelectorAll('[data-history-full] li').length,4,'ответ сохранён за своей карточкой');
  }finally{f.close();}
});

test('CF23 история: смена компании во время загрузки — ответ отброшен', async()=>{
  const srv=server({entries:[row(1)],history:{1:entriesFor(2)}});
  let release;const gate=new Promise(r=>{release=r;});
  srv.hooks.history=async({code,id,call})=>{await gate;return srv.readHistory(code,id,call.query);};
  const f=await fixture({srv});try{
    await f.open(1);await f.expandHistory();
    f.set('autoposting-company','beta');await settle();release();await settle();
    assert.equal(f.d.querySelectorAll('[data-history-full] li').length,0);assert.equal(f.d.querySelector('[data-ap-history]'),null);
  }finally{f.close();}
});
