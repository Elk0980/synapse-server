const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const scripts=['company-information.js','autoposting.js'].map(file=>fs.readFileSync(require.resolve('./'+file),'utf8'));
const clone=value=>JSON.parse(JSON.stringify(value));
const row=(id,extra={})=>({id,companyCode:'alpha',revision:4,contentRevision:3,status:'draft',title:'Материал '+id,text:'Проверенный текст',mediaUrls:['https://example.test/material.webp'],platformIds:['telegram'],scheduledAt:'2026-09-24T23:00:00Z',timezone:'Asia/Irkutsk',profileRevision:2,captions:{telegram:'Подпись'},deliveries:[],readiness:{ready:true,issues:[]},approval:{approved:false,stale:false},...extra});
async function fixture({entries=[row(1)],role='owner',permissions=[],override,listIds}={}){
  const dom=new JSDOM('<section id="view"></section>',{url:'https://fixture.test',runScripts:'outside-only'}),w=dom.window,d=w.document,views={},calls=[],posts=clone(entries);
  const NativeDate=w.Date;w.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2026-09-24T23:30:00Z']));}static now(){return Date.parse('2026-09-24T23:30:00Z');}};
  w.SbCabinet={registerView:(name,view)=>{views[name]=view;}};scripts.forEach(source=>w.eval(source));
  const ctx={selectedProjectId:'alpha',identity:{role,permissions,companies:[{id:'alpha',name:'Тест А'},{id:'beta',name:'Тест Б'}]},csrfOptions:(method,body)=>({method,headers:{'X-CSRF-Token':'fixture'},body:JSON.stringify(body)}),apiJson:async(url,options={})=>{
    const parsed=new URL(url,'https://fixture.test'),code=parsed.searchParams.get('companyCode'),path=parsed.pathname,method=options.method||'GET',call={code,path,method,url,options};calls.push(call);
    if(override){const result=await override(call,posts);if(result!==undefined)return clone(result);}
    if(path.endsWith('/company-information'))return {companyCode:code,revision:2,profile:{timezone:'Asia/Irkutsk'}};
    if(path.endsWith('/settings'))return {timezone:'Asia/Irkutsk',channels:[{id:'telegram',platform:'telegram',name:'Telegram',enabled:true,connected:true,revision:1,provider:'direct'}]};
    if(path.endsWith('/starter-plan'))return {companyCode:code,available:false};
    if(path.endsWith('/calendar')){
      const from=parsed.searchParams.get('from'),to=parsed.searchParams.get('to');
      const items=posts.filter(item=>item.companyCode===code).map(item=>{const publishDate=item.scheduledAt?w.SbCabinet.companyTime.toLocal(item.scheduledAt,'Asia/Irkutsk').slice(0,10):null;return {...clone(item),publishDate,effectiveDate:publishDate||item.plannedDate||null,dateKind:publishDate?'schedule':item.plannedDate?'plan':null};});
      return {companyCode:code,from,to,timezone:'Asia/Irkutsk',today:'2026-09-25',posts:items.filter(item=>item.effectiveDate>=from&&item.effectiveDate<=to),undated:items.filter(item=>!item.effectiveDate),truncated:false,undatedTruncated:false};
    }
    if(path.endsWith('/posts'))return {companyCode:code,posts:clone(posts.filter(item=>item.companyCode===code&&(!listIds||listIds.includes(item.id))))};
    const match=path.match(/\/posts\/(\d+)(?:\/(approve))?$/);assert.ok(match,path);const item=posts.find(value=>value.id===Number(match[1])&&value.companyCode===code);assert.ok(item);
    if(method==='GET')return clone(item);
    const body=JSON.parse(options.body);assert.equal(body.revision,item.revision);assert.equal(options.headers['X-CSRF-Token'],'fixture');
    if(match[2]==='approve'){assert.equal(ctx.identity.role,'owner');assert.equal(body.approved,true);item.approval={approved:true,approvedRevision:item.contentRevision,stale:false};item.revision++;return clone(item);}
    if(method==='PATCH'){Object.assign(item,body);item.revision++;item.contentRevision++;item.approval={approved:false,stale:true};return clone(item);}
    throw Error('Unexpected write');
  }};
  await views.autoposting.render(d.getElementById('view'),ctx);
  const f={w,d,ctx,views,calls,posts,node:id=>d.getElementById(id),settle:async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));},set(id,value){const node=f.node(id);node.value=value;node.dispatchEvent(new w.Event('change',{bubbles:true}));},async click(selector){const node=d.querySelector(selector);assert.ok(node,selector);node.click();await f.settle();},visibleIds:()=>[...d.querySelectorAll('#autoposting-posts > .autoposting-daily-list > [data-daily-post]')].map(node=>node.dataset.dailyPost),close:()=>w.close()};return f;
}
test('today uses company timezone, separates planned date from publication time and keeps unknown dates separate',async()=>{
  const f=await fixture({entries:[row(1),row(2,{scheduledAt:null,plannedDate:'2026-09-25',planPlatform:'vk',platformIds:[],captions:{}}),row(3,{scheduledAt:null}),row(4,{scheduledAt:'2026-09-25T23:00:00Z'})]});try{
    assert.deepEqual(f.visibleIds(),['1','2']);assert.match(f.node('autoposting-calendar-zone').textContent,/Сегодня: 2026-09-25/);
    assert.match(f.d.querySelector('[data-daily-post="2"]').textContent,/Дата плана: 2026-09-25 · время публикации не задано/);
    assert.match(f.d.querySelector('.autoposting-undated').textContent,/Материал 3/);assert.equal(f.node('autoposting-editor').open,false);
    assert.ok([...f.d.querySelectorAll('[data-daily-approve]')].every(node=>!node.checked));assert.ok(f.calls.every(call=>call.method==='GET'));
  }finally{f.close();}
});
test('month fetch covers its real bounds, includes cards beyond legacy list and platform/date filters do no writes',async()=>{
  const f=await fixture({listIds:[1],entries:[row(1),row(2,{scheduledAt:'2026-10-10T01:00:00Z',platformIds:[],captions:{vk:'Текст'}}),row(3,{scheduledAt:'2026-10-11T01:00:00Z'})]});try{
    await f.click('[data-daily-view="month"]');f.set('autoposting-month','2026-10');await f.settle();assert.deepEqual(f.visibleIds(),['2','3']);
    const call=f.calls.filter(call=>call.path.endsWith('/calendar')).at(-1);assert.match(call.url,/from=2026-10-01&to=2026-10-31/);
    f.set('autoposting-daily-platform','vk');assert.deepEqual(f.visibleIds(),['2']);await f.click('[data-calendar-date="2026-10-11"]');assert.deepEqual(f.visibleIds(),[]);
    assert.ok(f.calls.every(call=>call.method==='GET'));assert.equal(f.posts.length,3);
  }finally{f.close();}
});
test('opening a card reuses the only editor; filters and range changes retain unsaved text, date and upload input',async()=>{
  const f=await fixture();try{
    await f.click('[data-open-post="1"]');assert.equal(f.node('autoposting-editor').open,true);assert.equal(f.d.querySelectorAll('#autoposting-form').length,1);
    f.set('autoposting-text','Несохранённая правка');f.set('autoposting-date','2026-10-02T12:10');const file=new f.w.File(['fixture'],'own.webp',{type:'image/webp'});Object.defineProperty(f.node('autoposting-photo'),'files',{value:[file]});
    f.set('autoposting-daily-platform','vk');await f.click('[data-daily-view="month"]');f.set('autoposting-month','2026-10');await f.settle();
    assert.equal(f.node('autoposting-text').value,'Несохранённая правка');assert.equal(f.node('autoposting-date').value,'2026-10-02T12:10');assert.equal(f.node('autoposting-photo').files[0],file);
    assert.ok(f.calls.every(call=>call.method==='GET'));assert.equal(f.posts[0].text,'Проверенный текст');
  }finally{f.close();}
});
test('explicit selected approval validates versions, reports partial failure and never retries or schedules',async()=>{
  const f=await fixture({entries:[row(1),row(2),row(3)],override:(call,posts)=>{
    if(call.path.endsWith('/2/approve'))throw Error('RAW_PROVIDER_FAILURE');
    if(call.path.endsWith('/posts/3')&&call.method==='GET')return {...posts[2],contentRevision:9};
  }});try{
    for(const id of [1,2,3])await f.click('[data-daily-approve="'+id+'"]');assert.ok(f.calls.every(call=>call.method==='GET'));
    await f.click('#autoposting-batch-approve');const writes=f.calls.filter(call=>call.method!=='GET');assert.equal(writes.length,2);
    assert.deepEqual(writes.map(call=>JSON.parse(call.options.body)),[{revision:4,approved:true},{revision:4,approved:true}]);
    assert.match(f.node('autoposting-batch-results').textContent,/Материал 1: Согласована версия 3/);assert.match(f.node('autoposting-batch-results').textContent,/Материал 2: Согласование не подтверждено/);assert.match(f.node('autoposting-batch-results').textContent,/Материал 3: Согласование не подтверждено/);
    assert.doesNotMatch(f.d.body.textContent,/RAW_PROVIDER_FAILURE/);assert.equal(f.node('autoposting-batch-approve').disabled,true);
    assert.equal(f.d.querySelector('[data-daily-approve="2"]').disabled,true);await f.click('#autoposting-batch-approve');assert.equal(f.calls.filter(call=>call.method!=='GET').length,2);
    assert.ok(!f.calls.some(call=>/schedule|publishing-assets/.test(call.path)));assert.equal(f.posts[0].status,'draft');
  }finally{f.close();}
});
test('read-only and editor permissions never grant batch approval, including synthetic events',async()=>{
  for(const permissions of [['autoposting.view'],['autoposting.view','autoposting.edit']]){const f=await fixture({role:'marketer',permissions});try{
    assert.equal(f.node('autoposting-batch').hidden,true);assert.equal(f.d.querySelector('[data-daily-approve]'),null);
    f.node('autoposting-batch-approve').disabled=false;await f.click('#autoposting-batch-approve');assert.ok(f.calls.every(call=>call.method==='GET'));
  }finally{f.close();}}
});
test('approval unavailable for incomplete, already approved, published, uncertain or locally modified cards',async()=>{
  const f=await fixture({entries:[row(1,{readiness:{ready:false,issues:['Добавьте файл']}}),row(2,{approval:{approved:true}}),row(3,{status:'published'}),row(4,{deliveries:[{status:'needs_review'}]}),row(5)]});try{
    for(const id of [1,2,3,4])assert.equal(f.d.querySelector('[data-daily-approve="'+id+'"]').disabled,true);
    await f.click('[data-open-post="5"]');f.set('autoposting-text','Правка');assert.equal(f.d.querySelector('[data-daily-approve="5"]').disabled,true);assert.ok(f.calls.every(call=>call.method==='GET'));
  }finally{f.close();}
});
test('company switch clears selected approvals and stale calendar response cannot leak another company',async()=>{
  let release;const f=await fixture({entries:[row(1),row(2,{companyCode:'beta'})],override:call=>call.code==='beta'&&call.path.endsWith('/calendar')?new Promise(resolve=>{release=()=>resolve({companyCode:'beta',from:'2026-09-25',to:'2026-10-25',posts:[row(2,{companyCode:'beta'})],undated:[]});}):undefined});try{
    await f.click('[data-daily-approve="1"]');const pending=f.views.autoposting.onProjectChange({...f.ctx,selectedProjectId:'beta'});await f.settle();assert.ok(!f.node('autoposting-posts').textContent.includes('Материал 1'));
    await f.views.autoposting.onProjectChange(f.ctx);release();await pending;assert.deepEqual(f.visibleIds(),['1']);assert.equal(f.node('autoposting-company').value,'alpha');assert.equal(f.d.querySelector('[data-daily-approve="1"]').checked,false);assert.ok(f.calls.every(call=>call.method==='GET'));
  }finally{f.close();}
});
test('unavailable or mismatched calendar is labelled incomplete instead of claiming full month',async()=>{
  for(const wrongScope of [false,true]){const f=await fixture({override:call=>{if(call.path.endsWith('/calendar')){if(wrongScope)return {companyCode:'beta',from:'2026-09-25',to:'2026-10-25',posts:[row(9,{companyCode:'beta'})],undated:[]};throw Error('Unavailable');}}});try{
    assert.match(f.node('autoposting-calendar-state').textContent,/до 200.*неполным/);assert.deepEqual(f.visibleIds(),['1']);assert.doesNotMatch(f.node('autoposting-posts').textContent,/Материал 9/);
  }finally{f.close();}}
});
test('hidden selections remain explicitly listed and removable without losing the editor draft',async()=>{
  const f=await fixture({entries:[row(1),row(2,{captions:{vk:'Подпись'},platformIds:[]})]});try{
    await f.click('[data-daily-approve="1"]');await f.click('[data-open-post="2"]');f.set('autoposting-text','Несохранённый текст');
    f.set('autoposting-daily-platform','vk');assert.deepEqual(f.visibleIds(),['2']);assert.match(f.node('autoposting-selected-list').textContent,/Материал 1 · версия 3/);assert.match(f.node('autoposting-selected-list').textContent,/за пределами текущего фильтра/);
    await f.click('[data-daily-unselect="1"]');assert.equal(f.node('autoposting-batch-approve').disabled,true);assert.equal(f.node('autoposting-text').value,'Несохранённый текст');assert.ok(f.calls.every(call=>call.method==='GET'));
  }finally{f.close();}
});
test('published cards show final status and empty today offers upcoming materials without writes',async()=>{
  const f=await fixture({entries:[row(1,{status:'published'}),row(2,{scheduledAt:'2026-09-25T23:00:00Z',platformIds:[],captions:{vk:'Подпись'}})]});try{
    const card=f.d.querySelector('[data-daily-post="1"]');assert.match(card.textContent,/Опубликовано/);assert.doesNotMatch(card.textContent,/Готово к проверке|Нужно подготовить/);
    f.set('autoposting-daily-platform','vk');assert.deepEqual(f.visibleIds(),[]);await f.click('[data-daily-upcoming]');assert.deepEqual(f.visibleIds(),['2']);assert.equal(f.views.autoposting.title,'Материалы');assert.ok(f.calls.every(call=>call.method==='GET'));
  }finally{f.close();}
});
