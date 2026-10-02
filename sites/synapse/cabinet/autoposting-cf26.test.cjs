'use strict';
// CF26 (клиент): старая карточка из контент-плана (post.planLink) ведёт к ТЕКУЩЕЙ версии идеи в плане, а не к независимой копии.
// Синтетический сервер в памяти по CONTRACT.md снимка CONTENT_FACTORY_CF26_BACKEND_REVIEW_20261001. Реальных API, публикаций и сообщений нет.
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

const LINK={ideaId:'idea-7',platform:'telegram',contentRevision:2,planRevision:5,briefRevision:3};

test('CF26 planLink: в окне карточки — переход к версии идеи в плане вместо создания независимой копии', async()=>{
  const f=await fixture({srv:server({entries:[row(1,{planLink:LINK,planLinked:true}),row(2)]})});try{
    await f.open(1);
    const note=f.d.querySelector('[data-plan-link]');assert.ok(note,'строка связи с планом');
    assert.equal(note.dataset.planLink,'idea-7');
    assert.match(note.textContent,/Материал из контент-плана: идея idea-7 · Telegram/);
    assert.match(note.textContent,/создана из содержимого v2 — это версия на момент переноса/,'старая версия названа исторической');
    const link=note.querySelector('[data-plan-link-open]');
    assert.equal(link.textContent,'Открыть версию идеи в плане');
    assert.equal(link.getAttribute('href'),'#content-factory/plan/proposals?company=alpha&idea=idea-7&platform=telegram');
    assert.equal(f.d.querySelector('#autoposting-variant-create'),null,'независимая копия не предлагается');
    assert.equal(f.d.querySelector('details[data-variant]'),null);
    assert.equal(f.writes().length,0,'открытие карточки ничего не пишет');
    // Обычный материал — как в CF23.
    await f.open(2);
    assert.equal(f.d.querySelector('[data-plan-link]'),null);assert.ok(f.d.querySelector('#autoposting-variant-create'));
  }finally{f.close();}
});

test('CF26 planLink: ссылка строится только из planLink — название, происхождение, methodSource и дата не используются', async()=>{
  const misleading={title:'Идея idea-999 · vk',origin:'media_mentor_plan',meta:{methodSource:'Медиа-наставник · идея idea-999 · площадка vk · версия содержимого 9'},dayKey:'2026-10-09'};
  const f=await fixture({srv:server({entries:[row(1,{...misleading,planLink:{...LINK,ideaId:'idea_A-1',platform:'vk',contentRevision:4}})]})});try{
    await f.open(1);
    const href=f.d.querySelector('[data-plan-link-open]').getAttribute('href');
    assert.equal(href,'#content-factory/plan/proposals?company=alpha&idea=idea_A-1&platform=vk');
    assert.doesNotMatch(href,/999/);
  }finally{f.close();}
});

test('CF26 planLink: неполная связь — пояснение без ссылки и без создания копии; просмотр без права правки — только переход', async()=>{
  for(const bad of [{},{...LINK,ideaId:''},{...LINK,platform:'Tele gram'},{...LINK,contentRevision:0},{...LINK,contentRevision:'2'},'idea-7',{...LINK,ideaId:'<img>'}]){
    const f=await fixture({srv:server({entries:[row(1,{planLink:bad})]})});try{
      await f.open(1);
      const note=f.d.querySelector('[data-plan-link]');assert.equal(note.dataset.planLink,'invalid',JSON.stringify(bad));
      assert.equal(note.querySelector('a'),null);assert.equal(f.d.querySelector('#autoposting-variant-create'),null);
      assert.equal(note.querySelector('img'),null,'значения экранируются');
    }finally{f.close();}
  }
  const viewer=await fixture({role:'viewer',permissions:['autoposting.view'],srv:server({entries:[row(1,{planLink:LINK})]})});try{
    await viewer.open(1);assert.ok(viewer.d.querySelector('[data-plan-link-open]'),'при просмотре переход есть');
  }finally{viewer.close();}
});
