const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const scripts=['company-information.js','autoposting.js'].map(file=>fs.readFileSync(require.resolve('./'+file),'utf8'));
const cabinetHtml=fs.readFileSync(require.resolve('../cabinet.html'),'utf8');
const shellRouting=cabinetHtml.slice(cabinetHtml.indexOf('  const defaultView ='),cabinetHtml.indexOf('  const setCategoryForView ='));
const {materialUrl}=require('../../../ops/content/content-review-reminders');
const clone=value=>JSON.parse(JSON.stringify(value));
const row=(id,extra={})=>({id,companyCode:'alpha',revision:4,contentRevision:3,status:'draft',title:'Материал '+id,text:'Проверенный текст',mediaUrls:['https://example.test/material.webp'],platformIds:['telegram'],scheduledAt:'2026-09-24T23:00:00Z',timezone:'Asia/Irkutsk',profileRevision:2,captions:{telegram:'Подпись'},deliveries:[],readiness:{ready:true,issues:[]},approval:{approved:false,stale:false},...extra});
async function fixture({entries=[row(1)],role='owner',permissions=[],override,listIds,coverage,companyCode='alpha',url='https://fixture.test',chooseProject=false,routeThroughShell=false,beforeRender}={}){
  const dom=new JSDOM('<section id="view"></section>',{url,runScripts:'outside-only'}),w=dom.window,d=w.document,views={},calls=[],posts=clone(entries);
  if(routeThroughShell){
    assert.match(shellRouting,/const viewFromHash =/);
    assert.equal(w.eval(`(()=>{const VIEW_TITLES={home:'Главная',autoposting:'Материалы','media-mentor-rollout':'Этапы'};const permittedView=()=>true;${shellRouting}\nreturn viewFromHash();})()`),'autoposting');
  }
  const NativeDate=w.Date;w.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2026-09-24T23:30:00Z']));}static now(){return Date.parse('2026-09-24T23:30:00Z');}};
  w.SbCabinet={registerView:(name,view)=>{views[name]=view;}};scripts.forEach(source=>w.eval(source));
  const ctx={selectedProjectId:companyCode,identity:{role,permissions,companies:[{id:companyCode,name:'Тест А'},{id:'beta',name:'Тест Б'}]},csrfOptions:(method,body)=>({method,headers:{'X-CSRF-Token':'fixture'},body:JSON.stringify(body)}),apiJson:async(url,options={})=>{
    const parsed=new URL(url,'https://fixture.test'),code=parsed.searchParams.get('companyCode'),path=parsed.pathname,method=options.method||'GET',call={code,path,method,url,options};calls.push(call);
    if(override){const result=await override(call,posts);if(result!==undefined)return clone(result);}
    if(path.endsWith('/company-information'))return {companyCode:code,revision:2,profile:{timezone:'Asia/Irkutsk'}};
    if(path.endsWith('/settings'))return {timezone:'Asia/Irkutsk',channels:[{id:'telegram',platform:'telegram',name:'Telegram',enabled:true,connected:true,revision:1,provider:'direct'}]};
    if(path.endsWith('/starter-plan'))return {companyCode:code,available:false};
    if(path.endsWith('/calendar')){
      const from=parsed.searchParams.get('from'),to=parsed.searchParams.get('to');
      const items=posts.filter(item=>item.companyCode===code).map(item=>{const publishDate=item.scheduledAt?w.SbCabinet.companyTime.toLocal(item.scheduledAt,'Asia/Irkutsk').slice(0,10):null;return {...clone(item),publishDate,effectiveDate:publishDate||item.plannedDate||null,dateKind:publishDate?'schedule':item.plannedDate?'plan':null};});
      return {companyCode:code,from,to,timezone:'Asia/Irkutsk',today:'2026-09-25',posts:items.filter(item=>item.effectiveDate>=from&&item.effectiveDate<=to),undated:items.filter(item=>!item.effectiveDate),truncated:false,undatedTruncated:false,coverage};
    }
    if(path.endsWith('/posts'))return {companyCode:code,posts:clone(posts.filter(item=>item.companyCode===code&&(!listIds||listIds.includes(item.id))))};
    const match=path.match(/\/posts\/(\d+)(?:\/(approve))?$/);assert.ok(match,path);const item=posts.find(value=>value.id===Number(match[1])&&value.companyCode===code);assert.ok(item);
    if(method==='GET')return clone(item);
    const body=JSON.parse(options.body);assert.equal(body.revision,item.revision);assert.equal(options.headers['X-CSRF-Token'],'fixture');
    if(match[2]==='approve'){assert.ok(ctx.identity.role==='owner'||ctx.identity.permissions.includes('autoposting.approve'));assert.equal(body.approved,true);item.approval={approved:true,approvedRevision:item.contentRevision,stale:false};if(body.schedule===true)item.status='scheduled';item.revision++;return clone(item);}
    if(method==='PATCH'){Object.assign(item,body);item.revision++;item.contentRevision++;item.approval={approved:false,stale:true};return clone(item);}
    throw Error('Unexpected write');
  }};
  if(chooseProject)ctx.chooseProject=code=>{ctx.selectedProjectId=code;w.history.replaceState(null,'','#content-factory/materials');void views.autoposting.onProjectChange(ctx);};
  if(beforeRender)beforeRender(w);
  await views.autoposting.render(d.getElementById('view'),ctx);
  const f={w,d,ctx,views,calls,posts,node:id=>d.getElementById(id),settle:async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));},set(id,value){const node=f.node(id);node.value=value;node.dispatchEvent(new w.Event('change',{bubbles:true}));},async click(selector){const node=d.querySelector(selector);assert.ok(node,selector);node.click();await f.settle();},visibleIds:()=>[...d.querySelectorAll('#autoposting-posts .ap-board [data-daily-post]')].map(node=>node.dataset.dailyPost),undatedIds:()=>[...d.querySelectorAll('#autoposting-posts .ap-undated [data-daily-post]')].map(node=>node.dataset.dailyPost),close:()=>w.close()};return f;
}
const palitraRow=extra=>row(1,{companyCode:'palitra-love',dayKey:'',captions:{},scheduledAt:'2026-09-25T01:00:00Z',approvalRequired:true,approveAndScheduleAvailable:true,...extra});

test('ссылка из напоминания проходит реальную маршрутизацию кабинета и открывает материал с проверкой версии',async()=>{
  for(const revision of [3,1]){
    const url=materialUrl('https://fixture.test/cabinet.html',{id:51,contentRevision:revision});
    const f=await fixture({companyCode:'palitra-love',entries:[palitraRow({id:51,scheduledAt:'2027-01-15T10:00:00Z'})],listIds:[],url,routeThroughShell:true});try{
      assert.equal(f.w.location.hash,`#content-factory/plan?company=palitra-love&post=51&revision=${revision}`);
      assert.equal(f.node('autoposting-editor').open,true);assert.equal(f.node('autoposting-select').value,'51');
      assert.ok(f.calls.some(call=>call.path.endsWith('/posts/51')&&call.code==='palitra-love'));
      assert.ok(f.calls.every(call=>call.method==='GET'));assert.equal(f.node('autoposting-approve-schedule').disabled,true);
      if(revision===1)assert.match(f.node('autoposting-status').textContent,/материал изменился/);
    }finally{f.close();}
  }
});

test('ссылка открывает конкретный материал за пределами списка и месяца, без одобрения или записи',async()=>{
  const f=await fixture({entries:[row(51,{scheduledAt:'2027-01-15T10:00:00Z'})],listIds:[],url:'https://fixture.test/#content-factory/materials?company=alpha&post=51&revision=3'});try{
    assert.equal(f.node('autoposting-editor').open,true);assert.equal(f.node('autoposting-select').value,'51');
    assert.ok(f.calls.some(call=>call.path.endsWith('/posts/51')));assert.ok(f.calls.every(call=>call.method==='GET'));
    assert.equal(f.node('autoposting-schedule').disabled,true);assert.match(f.node('autoposting-status').textContent,/Проверьте предпросмотр/);
  }finally{f.close();}
});
test('старая ссылка показывает предупреждение и текущую версию; неизвестная компания не запрашивается',async()=>{
  const stale=await fixture({url:'https://fixture.test/#content-factory/materials?company=alpha&post=1&revision=1'});try{
    assert.equal(stale.node('autoposting-editor').open,true);assert.match(stale.node('autoposting-status').textContent,/материал изменился/);
    assert.ok(stale.calls.every(call=>call.method==='GET'));assert.equal(stale.node('autoposting-schedule').disabled,true);
  }finally{stale.close();}
  for(const query of ['company=foreign&post=1&revision=3','company=alpha&post=1&post=2&revision=3','company=alpha&post=-1&revision=3']){
    const f=await fixture({url:'https://fixture.test/#content-factory/materials?'+query});try{
      assert.equal(f.node('autoposting-editor').open,false);assert.ok(!f.calls.some(call=>/\/posts\/\d+/.test(call.path)));
      assert.match(f.node('autoposting-status').textContent,/недоступен или ссылка неверна/);
    }finally{f.close();}
  }
});
test('ссылка меняет только доступную компанию через штатный выбор и переживает очистку hash оболочкой',async()=>{
  const f=await fixture({entries:[row(1),row(2,{companyCode:'beta'})],chooseProject:true,url:'https://fixture.test/#content-factory/materials?company=beta&post=2&revision=3'});try{
    await f.settle();assert.equal(f.ctx.selectedProjectId,'beta');assert.equal(f.node('autoposting-company').value,'beta');
    assert.equal(f.node('autoposting-select').value,'2');assert.ok(f.calls.every(call=>call.method==='GET'));
    assert.ok(f.calls.some(call=>call.path.endsWith('/posts/2')&&call.code==='beta'));
  }finally{f.close();}
});
test('ошибка доступа и чужая карточка в ответе не открываются по ссылке',async()=>{
  for(const mode of ['denied','wrong-company']){
    const f=await fixture({url:'https://fixture.test/#content-factory/materials?company=alpha&post=1&revision=3',override:call=>{
      if(call.path.endsWith('/posts/1')){if(mode==='denied')throw Error('403');return row(1,{companyCode:'beta'});}
    }});try{assert.equal(f.node('autoposting-editor').open,false);assert.match(f.node('autoposting-status').textContent,/Не удалось открыть материал/);assert.ok(f.calls.every(call=>call.method==='GET'));}finally{f.close();}
  }
});
test('переход по ссылке в уже открытом модуле сохраняет несохранённую правку и не выдаёт её за текущую согласованную версию',async()=>{
  const f=await fixture();try{
    await f.click('[data-open-post="1"]');f.set('autoposting-text','Локальная несохранённая версия');
    f.w.history.replaceState(null,'','#content-factory/materials?company=alpha&post=1&revision=1');
    await f.views.autoposting.render(f.d.getElementById('view'),f.ctx);
    assert.equal(f.node('autoposting-text').value,'Локальная несохранённая версия');assert.match(f.node('autoposting-status').textContent,/несохранённые правки/);
    assert.equal(f.node('autoposting-schedule').disabled,true);assert.ok(f.calls.every(call=>call.method==='GET'));
  }finally{f.close();}
});

test('Palitra: обычная карточка требует согласования; явная кнопка использует сохранённую версию после предпросмотра',async()=>{
  const f=await fixture({companyCode:'palitra-love',entries:[palitraRow()]});try{
    await f.click('[data-open-post="1"]');assert.equal(f.node('autoposting-approve-schedule').disabled,true);
    assert.match(f.d.querySelector('[data-approve-schedule-summary]').textContent,/Telegram/);
    assert.match(f.d.querySelector('[data-approve-schedule-summary]').textContent,/2026-09-25 09:00/);
    await f.click('#autoposting-preview');assert.equal(f.node('autoposting-schedule').disabled,true);assert.equal(f.node('autoposting-approve-schedule').disabled,false);
    assert.ok(f.calls.every(call=>call.method==='GET'));
    await f.click('#autoposting-approve-schedule');
    const writes=f.calls.filter(call=>call.method!=='GET');assert.equal(writes.length,1);assert.equal(writes[0].code,'palitra-love');
    assert.ok(writes[0].path.endsWith('/1/approve'));assert.deepEqual(JSON.parse(writes[0].options.body),{revision:4,approved:true,schedule:true});
    assert.equal(f.posts[0].status,'scheduled');assert.equal(f.node('autoposting-approve-schedule').disabled,true);
    await f.click('#autoposting-approve-schedule');assert.equal(f.calls.filter(call=>call.method!=='GET').length,1);
  }finally{f.close();}
});

test('Palitra: несохранённая правка, прошлое время и отключённый канал блокируют объединённое действие',async()=>{
  for(const scenario of ['dirty','past','channel','no-media']){
    const f=await fixture({companyCode:'palitra-love',entries:[palitraRow(scenario==='past'?{scheduledAt:'2026-09-24T22:00:00Z'}:scenario==='no-media'?{readiness:{ready:false,issues:['Нет материала']}}:{})],override:call=>scenario==='channel'&&call.path.endsWith('/settings')?{timezone:'Asia/Irkutsk',channels:[{id:'telegram',platform:'telegram',name:'Telegram',enabled:true,connected:false,revision:1}]}:undefined});try{
      await f.click('[data-open-post="1"]');await f.click('#autoposting-preview');if(scenario==='dirty')f.set('autoposting-text','Новая несохранённая версия');
      assert.equal(f.node('autoposting-approve-schedule').disabled,true,scenario);
      f.node('autoposting-approve-schedule').disabled=false;await f.click('#autoposting-approve-schedule');assert.ok(f.calls.every(call=>call.method==='GET'),scenario);
    }finally{f.close();}
  }
});

test('Palitra: права edit и approve обязательны даже при искусственном нажатии; другим компаниям кнопка не показана',async()=>{
  for(const permissions of [['autoposting.view','autoposting.edit'],['autoposting.view','autoposting.approve']]){
    const f=await fixture({companyCode:'palitra-love',entries:[palitraRow()],role:'marketer',permissions});try{
      await f.click('[data-open-post="1"]');await f.click('#autoposting-preview');assert.equal(f.node('autoposting-approve-schedule').disabled,true);
      f.node('autoposting-approve-schedule').disabled=false;await f.click('#autoposting-approve-schedule');assert.ok(f.calls.every(call=>call.method==='GET'));
    }finally{f.close();}
  }
  const other=await fixture();try{await other.click('[data-open-post="1"]');assert.equal(other.node('autoposting-approve-schedule'),null);}finally{other.close();}
});

test('Palitra: отказ при постановке не изображается успехом и не повторяется автоматически',async()=>{
  const f=await fixture({companyCode:'palitra-love',entries:[palitraRow()],override:call=>{if(call.path.endsWith('/approve'))throw Error('REVISION_CONFLICT');}});try{
    await f.click('[data-open-post="1"]');await f.click('#autoposting-preview');await f.click('#autoposting-approve-schedule');
    assert.equal(f.posts[0].status,'draft');assert.equal(f.posts[0].approval.approved,false);assert.equal(f.node('autoposting-approve-schedule').disabled,true);
    assert.equal(f.calls.filter(call=>call.method!=='GET').length,1);assert.match(f.d.body.textContent,/Не удалось подтвердить согласование и очередь/);
    assert.doesNotMatch(f.d.body.textContent,/REVISION_CONFLICT/);
  }finally{f.close();}
});

test('Palitra: текстовый Telegram доступен без изображения, но только с поддержанным подключением',async()=>{
  for(const provider of ['direct','onlypult']){
    const f=await fixture({companyCode:'palitra-love',entries:[palitraRow({mediaUrls:[],readiness:{ready:true,textOnly:true,issues:[]}})],override:call=>call.path.endsWith('/settings')?{timezone:'Asia/Irkutsk',channels:[{id:'telegram',platform:'telegram',name:'Telegram',enabled:true,connected:true,revision:1,provider}]}:undefined});try{
      await f.click('[data-open-post="1"]');await f.click('#autoposting-preview');assert.match(f.node('autoposting-preview-content').textContent,/Текстовая публикация/);
      assert.equal(f.node('autoposting-approve-schedule').disabled,provider!=='direct');
      await f.click('#autoposting-approve-schedule');assert.equal(f.calls.filter(call=>call.method!=='GET').length,provider==='direct'?1:0);
    }finally{f.close();}
  }
});
test('CF3-BOARD: доска открывается на текущей неделе по поясу компании, время отделено от даты плана, без даты — отдельной группой',async()=>{
  const f=await fixture({entries:[row(1),row(2,{scheduledAt:null,plannedDate:'2026-09-25',planPlatform:'vk',platformIds:[],captions:{}}),row(3,{scheduledAt:null}),row(4,{scheduledAt:'2026-09-25T23:00:00Z'})]});try{
    assert.match(f.node('autoposting-week-label').textContent,/Неделя 4 из 5 · 21–27 сентября 2026/);
    assert.deepEqual([...f.d.querySelectorAll('[data-board-day]')].map(node=>node.dataset.boardDay),['2026-09-21','2026-09-22','2026-09-23','2026-09-24','2026-09-25','2026-09-26','2026-09-27','undated']);
    assert.deepEqual(f.visibleIds(),['1','2','4'],'внутри дня: сначала со временем, потом только с датой плана');assert.deepEqual(f.undatedIds(),['3']);
    assert.match(f.node('autoposting-calendar-zone').textContent,/часовому поясу проекта Asia\/Irkutsk.*Сегодня: 2026-09-25/);
    assert.ok(f.d.querySelector('[data-board-day="2026-09-25"]').classList.contains('is-today'));
    assert.match(f.d.querySelector('[data-daily-post="1"] .ap-card-meta').textContent,/^07:00/);
    assert.match(f.d.querySelector('[data-daily-post="2"]').textContent,/время не задано/);
    assert.match(f.d.querySelector('.autoposting-undated').textContent,/Без даты · 1[\s\S]*Материал 3/);assert.equal(f.node('autoposting-editor').open,false);
    assert.ok([...f.d.querySelectorAll('[data-daily-approve]')].every(node=>!node.checked));assert.ok(f.calls.every(call=>call.method==='GET'));
    assert.ok(![...f.d.querySelectorAll('h2,h3')].some(node=>/^Материалы$/.test(node.textContent.trim())),'нет дубля «Материалы»');assert.equal(f.d.querySelector('h2').textContent,'Контент-план');
  }finally{f.close();}
});
test('CF3-BOARD: месяц грузится целиком, недели внутри месяца, переход к дате и фильтры ничего не пишут',async()=>{
  const f=await fixture({listIds:[1],entries:[row(1),row(2,{scheduledAt:'2026-10-10T01:00:00Z',platformIds:[],captions:{vk:'Текст'}}),row(3,{scheduledAt:'2026-10-11T01:00:00Z'})]});try{
    f.set('autoposting-month','2026-10');await f.settle();
    const call=f.calls.filter(call=>call.path.endsWith('/calendar')).at(-1);assert.match(call.url,/from=2026-10-01&to=2026-10-31/);
    assert.match(f.node('autoposting-week-label').textContent,/Неделя 1 из 5 · 1–4 октября 2026/,'первая неделя месяца короче семи дней');assert.deepEqual(f.visibleIds(),[]);
    await f.click('#autoposting-next-week');assert.deepEqual(f.visibleIds(),['2','3']);
    f.set('autoposting-daily-platform','vk');assert.deepEqual(f.visibleIds(),['2']);assert.match(f.node('autoposting-filter-count').textContent,/Активных фильтров: 1/);
    f.set('autoposting-jump','2026-09-25');await f.settle();assert.match(f.node('autoposting-week-label').textContent,/21–27 сентября/);
    assert.deepEqual(f.visibleIds(),[]);assert.match(f.node('autoposting-posts').textContent,/По выбранным фильтрам на этой неделе публикаций нет/);
    await f.click('[data-filter-reset]');assert.deepEqual(f.visibleIds(),['1']);assert.equal(f.node('autoposting-filter-reset').hidden,true);
    await f.click('#autoposting-prev-week');await f.click('#autoposting-prev-week');await f.click('#autoposting-prev-week');await f.click('#autoposting-prev-week');await f.settle();
    assert.match(f.node('autoposting-week-label').textContent,/Неделя 6 из 6 · 31 августа 2026/,'переход за пределы месяца переключает месяц');
    assert.ok(f.calls.every(call=>call.method==='GET'));assert.equal(f.posts.length,3);
  }finally{f.close();}
});
test('CF3-BOARD: карточка открывает единственный редактор окном поверх доски; закрытие и фильтры сохраняют несохранённый ввод',async()=>{
  const f=await fixture();try{
    await f.click('[data-daily-post="1"] .ap-card-title');assert.equal(f.node('autoposting-editor').open,true);assert.equal(f.d.querySelectorAll('#autoposting-form').length,1);
    assert.ok(f.d.body.classList.contains('autoposting-modal-open'));assert.equal(f.node('autoposting-editor').getAttribute('role'),'dialog');
    assert.match(f.node('autoposting-editor-title').textContent,/Публикация: Материал 1/);
    f.set('autoposting-text','Несохранённая правка');f.set('autoposting-date','2026-10-02T12:10');const file=new f.w.File(['fixture'],'own.webp',{type:'image/webp'});Object.defineProperty(f.node('autoposting-photo'),'files',{value:[file]});
    await f.click('#autoposting-editor-close');assert.equal(f.node('autoposting-editor').open,false);assert.ok(!f.d.body.classList.contains('autoposting-modal-open'));
    assert.equal(f.d.activeElement,f.d.querySelector('[data-open-post="1"]'),'фокус возвращается на карточку');
    assert.match(f.node('autoposting-status').textContent,/Несохранённые правки остались/);assert.match(f.d.querySelector('[data-daily-post="1"]').textContent,/Есть несохранённые правки/);
    f.set('autoposting-daily-platform','vk');f.set('autoposting-filter-status','draft');f.set('autoposting-month','2026-10');await f.settle();
    await f.click('#autoposting-prev-week');await f.settle();f.set('autoposting-daily-platform','');f.set('autoposting-filter-status','');
    await f.click('[data-open-post="1"]');
    assert.equal(f.node('autoposting-text').value,'Несохранённая правка');assert.equal(f.node('autoposting-date').value,'2026-10-02T12:10');assert.equal(f.node('autoposting-photo').files[0],file);
    f.node('autoposting-editor').dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(f.node('autoposting-editor').open,false);
    assert.ok(f.calls.every(call=>call.method==='GET'));assert.equal(f.posts[0].text,'Проверенный текст');
  }finally{f.close();}
});
test('CF3-BOARD: флажок — только выбор; пустая доска приглашает к настройке; телефонная полоска дней и панель фильтров; уход из вкладки закрывает окно без потери ввода',async()=>{
  const f=await fixture({entries:[row(1),row(2,{scheduledAt:'2026-09-22T02:00:00Z'})]});try{
    await f.click('[data-daily-approve="1"]');
    assert.equal(f.d.querySelector('[data-daily-post="1"] .ap-status').textContent,'Черновик','выбор не меняет статус');
    assert.match(f.node('autoposting-batch').textContent,/Флажок на карточке — только выбор/);assert.match(f.node('autoposting-batch-approve').textContent,/Согласовать выбранные \(1\)/);
    assert.ok(f.calls.every(call=>call.method==='GET'),'выбор ничего не пишет');assert.equal(f.node('autoposting-editor').open,false,'флажок не открывает окно');
    const strip=[...f.d.querySelectorAll('[data-strip-date]')];assert.equal(strip.length,7);assert.match(strip[1].getAttribute('aria-label'),/Вт, 22 сен: публикаций 1/);
    await f.click('[data-strip-date="2026-09-22"]');assert.ok(f.d.querySelector('[data-board-day="2026-09-22"]').classList.contains('is-selected'));
    assert.equal(f.node('autoposting-filters-toggle').getAttribute('aria-expanded'),'false');await f.click('#autoposting-filters-toggle');
    assert.equal(f.node('autoposting-filters-toggle').getAttribute('aria-expanded'),'true');assert.ok(f.node('autoposting-filters').classList.contains('is-open'));
    await f.click('#autoposting-overview');assert.equal(f.node('autoposting-month-controls').hidden,false);await f.click('[data-calendar-date="2026-09-03"]');
    assert.match(f.node('autoposting-week-label').textContent,/Неделя 1 из 5/);
    await f.click('[data-calendar-date="2026-09-22"]');await f.click('[data-open-post="2"]');f.set('autoposting-text','Ввод до ухода');
    f.views.autoposting.onLeave();assert.equal(f.node('autoposting-editor').open,false);assert.ok(!f.d.body.classList.contains('autoposting-modal-open'));
    await f.click('[data-open-post="2"]');assert.equal(f.node('autoposting-text').value,'Ввод до ухода');
  }finally{f.close();}
  const empty=await fixture({entries:[]});try{
    assert.match(empty.node('autoposting-posts').textContent,/На доске пока пусто/);assert.ok(empty.d.querySelector('#autoposting-posts a[href="#content-factory/settings"]'));
    assert.match(empty.node('autoposting-posts').textContent,/Без даты · 0/);
  }finally{empty.close();}
});
test('CF3-BOARD: правка согласованной карточки в окне сохраняется существующим PATCH, согласование снимается на карточке и в заголовке окна',async()=>{
  const f=await fixture({entries:[row(1,{approval:{approved:true,stale:false,approvedAt:'2026-09-24T01:00:00Z',approvedByName:'Владелец'}})]});try{
    assert.equal(f.d.querySelector('[data-daily-post="1"] .ap-status').textContent,'Согласовано');
    await f.click('[data-open-post="1"]');assert.match(f.node('autoposting-editor-note').textContent,/^Согласовано · содержимое v3/);
    f.set('autoposting-text','Новый текст');f.node('autoposting-form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await f.settle();
    const writes=f.calls.filter(call=>call.method!=='GET');assert.deepEqual(writes.map(call=>call.method+' '+call.path.replace(/^.*\/autoposting/,'')),['PATCH /posts/1']);
    assert.match(f.node('autoposting-editor-note').textContent,/^Черновик · содержимое v4/);
    assert.equal(f.d.querySelector('[data-daily-post="1"] .ap-status').textContent,'Черновик','прежнее согласование не переносится на новую версию');
  }finally{f.close();}
});
test('CF3-R1: окно публикации — предпросмотр и проверка отдельной колонкой, поля по порядку; видимые «Формат» и «Цель (ОВП)» вместо скрытой «Роли»',async()=>{
  const f=await fixture({entries:[row(1,{meta:{format:'reel',role:'affection'}})]});try{
    await f.click('[data-open-post="1"]');
    const preview=f.d.querySelector('#autoposting-editor .ap-editor-preview'),fields=f.d.querySelector('#autoposting-editor .ap-editor-fields');
    assert.ok(preview&&fields);for(const id of ['autoposting-media-preview','autoposting-preview','autoposting-preview-content','autoposting-approval','autoposting-schedule'])assert.ok(preview.contains(f.node(id)),id);
    assert.ok(preview.querySelector('#autoposting-media-preview img'),'файл виден в колонке предпросмотра');
    const order=['autoposting-title','autoposting-platforms','autoposting-format','autoposting-role','autoposting-date','autoposting-text','autoposting-save'].map(f.node);
    for(let i=1;i<order.length;i++)assert.ok(order[i-1].compareDocumentPosition(order[i])&f.w.Node.DOCUMENT_POSITION_FOLLOWING,order[i].id);
    for(const id of ['autoposting-format','autoposting-role'])assert.equal(f.node(id).closest('details'),f.node('autoposting-editor'),id+' не спрятан во вложенном свёрнутом блоке');
    assert.equal(f.node('autoposting-role').labels[0].textContent,'Цель (ОВП)','подпись связана с полем через for (CF5: рядом подсказка «?»)');assert.equal(f.node('autoposting-role').value,'affection');
    assert.deepEqual([...f.node('autoposting-role').options].map(o=>o.textContent),['Не указана','Охват','Влюбление','Продажи']);
    assert.doesNotMatch(f.node('autoposting-editor').textContent,/Роль|Охватный|На влюбление/);
  }finally{f.close();}
});
test('CF3-R1: одна метка статуса на доске, в заголовке окна, в строке состояния и в списке «Открыть материал»',async()=>{
  const f=await fixture({entries:[row(1,{approval:{approved:true,stale:false}}),row(2,{review:{state:'rejected'}}),row(3,{status:'scheduled',approval:{approved:true,stale:false}})]});try{
    for(const [id,label] of [['1','Согласовано'],['2','На доработке'],['3','Запланировано']]){
      assert.equal(f.d.querySelector(`[data-daily-post="${id}"] .ap-status`).textContent,label);
      await f.click(`[data-open-post="${id}"]`);
      assert.match(f.node('autoposting-editor-note').textContent,new RegExp('^'+label));assert.equal(f.node('autoposting-post-state').textContent,'Статус: '+label);
      assert.match(f.node('autoposting-select').selectedOptions[0].textContent,new RegExp('— '+label+'$'));
      await f.click('#autoposting-editor-close');
    }
    assert.doesNotMatch(f.node('autoposting-select').textContent,/— (Черновик|В плане)$/m,'статус доставки больше не выдаётся за общий статус');
  }finally{f.close();}
});
test('CF3-R1: одна явная кнопка «Согласовать» — существующий approve с ревизией, без расписания; права и несохранённый ввод соблюдаются',async()=>{
  const f=await fixture({entries:[row(1,{readiness:{ready:true,issues:[]}})]});try{
    await f.click('[data-open-post="1"]');const button=()=>f.node('autoposting-approve');
    assert.equal(button().tagName,'BUTTON');assert.equal(f.d.querySelectorAll('#autoposting-approve').length,1);assert.match(button().textContent,/^Согласовать · версия v3/);
    assert.match(f.node('autoposting-approval').textContent,/Согласование не ставит в план и ничего не публикует/);
    f.set('autoposting-text','Несохранённое');f.node('autoposting-text').dispatchEvent(new f.w.Event('input',{bubbles:true}));
    assert.equal(button().disabled,true,'с несохранённым вводом согласовать нельзя');button().disabled=false;await f.click('#autoposting-approve');
    assert.ok(f.calls.every(call=>call.method==='GET'),'искусственное нажатие при несохранённом вводе ничего не пишет');
    f.set('autoposting-text','Проверенный текст');f.node('autoposting-text').dispatchEvent(new f.w.Event('input',{bubbles:true}));
    await f.click('#autoposting-approve');
    const writes=f.calls.filter(call=>call.method!=='GET');assert.equal(writes.length,1);assert.match(writes[0].path,/\/posts\/1\/approve$/);assert.deepEqual(JSON.parse(writes[0].options.body),{revision:4,approved:true});
    assert.ok(!f.calls.some(call=>/schedule/.test(call.path)));assert.equal(f.posts[0].status,'draft','статус доставки не менялся');
    assert.match(f.node('autoposting-status').textContent,/Версия согласована\. В план не поставлена и не опубликована/);
    assert.equal(button().dataset.approved,'true');assert.match(button().textContent,/^Снять согласование/);
    assert.match(f.node('autoposting-editor-note').textContent,/^Согласовано/,'заголовок окна обновлён решением');assert.equal(f.node('autoposting-post-state').textContent,'Статус: Согласовано');
    assert.equal(f.d.querySelector('[data-daily-post="1"] .ap-status').textContent,'Согласовано');
  }finally{f.close();}
  for(const permissions of [['autoposting.view','autoposting.edit']]){const g=await fixture({role:'marketer',permissions});try{
    await g.click('[data-open-post="1"]');assert.equal(g.node('autoposting-approve').disabled,true);
    g.node('autoposting-approve').dispatchEvent(new g.w.Event('click',{bubbles:true}));await g.settle();assert.ok(g.calls.every(call=>call.method==='GET'),'без права approve записи нет');
  }finally{g.close();}}
});
test('CF3-R1: beforeunload спрашивает только при несохранённом вводе, в том числе отложенном в другой карточке',async()=>{
  const f=await fixture({entries:[row(1),row(2)]});try{
    const unload=()=>{const event=new f.w.Event('beforeunload',{cancelable:true});f.w.dispatchEvent(event);return event.defaultPrevented;};
    assert.equal(unload(),false,'без правок не мешаем');
    await f.click('[data-open-post="1"]');assert.equal(unload(),false);
    f.set('autoposting-text','Несохранённое');assert.equal(unload(),true);
    await f.click('#autoposting-editor-close');assert.equal(unload(),true,'правка, отложенная при закрытии окна, тоже защищена');
    await f.click('[data-open-post="2"]');assert.equal(f.node('autoposting-text').value,'Проверенный текст');assert.equal(unload(),true,'открыта другая карточка без правок, но правка карточки 1 ещё не сохранена');
    await f.click('#autoposting-editor-close');
    await f.click('[data-open-post="1"]');f.node('autoposting-form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await f.settle();
    assert.ok(f.calls.some(call=>call.method==='PATCH'));assert.equal(unload(),false,'после сохранения не спрашивает');
  }finally{f.close();}
});
// ---------- CF4: замечания к версии (контракт CONTENT_FACTORY_CF4_REVIEW_CONTRACT_20261001) ----------
const cf4Media=['https://example.test/clip-a.mp4','https://example.test/photo-b.jpg'];
// Синтетический сервер reject по контракту: повышает revision, «На доработке», группа замечаний со снимком файлов, пустая задача.
const cf4Reject=({mode='ok',saveOnError=false,status=409}={})=>{const log=[];return {log,override:(call,posts)=>{
  if(!/\/posts\/\d+\/reject$/.test(call.path))return undefined;
  const body=JSON.parse(call.options.body),item=posts.find(value=>value.id===Number(call.path.match(/\/posts\/(\d+)\//)[1]));log.push(body);
  const save=()=>{assert.equal(body.revision,item.revision);item.revision++;item.review={state:'rejected',comment:body.comment,byName:'Влад',at:'2026-09-25T00:00:00Z'};item.approval={approved:false,stale:false};
    item.reviewNotes=[...(item.reviewNotes||[]),...(body.annotations?.length?[{id:(item.reviewNotes||[]).length+10,contentRevision:item.contentRevision,mediaUrls:clone(item.mediaUrls),mediaSha256:'',
      annotations:body.annotations.map(a=>({category:a.category,comment:a.comment,timingKind:a.timingKind||'whole',startMs:a.startMs??null,endMs:a.endMs??null,mediaIndex:a.mediaIndex??null,durationVerified:false})),actorId:1,actorName:'Влад',createdAt:'2026-09-25T00:00:00Z'}]:[])];
    item.reviewTasks=[{taskId:77,contentRevision:item.contentRevision,status:'inbox',assigneeName:null,dueDate:null},...(item.reviewTasks||[])];return clone(item);};
  if(mode==='ok')return save();
  if(saveOnError)save();
  throw Object.assign(new Error(mode==='network'?'Failed to fetch':mode==='400'?'Конец интервала раньше начала':'Публикация уже изменена'),mode==='network'?{}:{status:mode==='400'?400:status});
}};};
const openNoteForm=async(f,id='1')=>{await f.click(`[data-open-post="${id}"]`);return f.node('autoposting-reject-form');};
const addNote=async(f,{category='text',comment,time})=>{
  f.node('ap-note-category').value=category;f.node('ap-note-comment').value=comment;
  if(time){if(f.node('ap-note-time').hidden)await f.click('#ap-note-time-toggle');
    f.d.querySelector(`[name="ap-note-kind"][value="${time.kind}"]`).checked=true;if(time.media!==undefined)f.node('ap-note-media').value=String(time.media);
    f.node('ap-note-start').value=time.start;f.node('ap-note-end').value=time.end||'';}
  else if(!f.node('ap-note-time').hidden)await f.click('#ap-note-time-toggle');
  await f.click('#ap-note-add');
};
test('CF4: компактная форма — категория и комментарий, время по «Указать момент»; три вида привязки уходят одним существующим reject',async()=>{
  const server=cf4Reject();const f=await fixture({entries:[row(1,{mediaUrls:cf4Media})],override:server.override});try{
    await openNoteForm(f);
    assert.equal(f.node('ap-note-time').hidden,true,'время скрыто, пока не нужно');assert.deepEqual([...f.node('ap-note-category').options].map(o=>o.textContent),['Текст','Музыка','Изображение / видеоряд','Другое']);
    const hint=f.d.querySelector('[aria-label="Подсказка: Замечание"]');assert.ok(hint);await f.click('[aria-label="Подсказка: Замечание"]');
    assert.equal(hint.getAttribute('aria-expanded'),'true');assert.match(f.node('ap-hint-note-comment').textContent,/На 00:12 заменить надпись/);assert.equal(f.node('ap-hint-note-comment').hidden,false);
    await f.click('#ap-note-add');assert.match(f.node('ap-note-error').textContent,/Напишите, что исправить/);
    await addNote(f,{comment:'x',time:{kind:'material',media:0,start:'1:75'}});assert.match(f.node('ap-note-error').textContent,/Укажите начало/);
    await addNote(f,{comment:'x',time:{kind:'editing_wish',start:'00:30',end:'00:20'}});assert.match(f.node('ap-note-error').textContent,/Конец раньше начала/);
    await addNote(f,{category:'text',comment:'Ко всему: короче'});
    await addNote(f,{category:'text',comment:'<img src=x onerror=alert(1)> надпись закрывает композицию',time:{kind:'material',media:0,start:'00:12'}});
    await addNote(f,{category:'music',comment:'Сменить трек',time:{kind:'editing_wish',start:'00:30',end:'00:45'}});
    assert.equal(f.d.querySelectorAll('#ap-notes-pending > li').length,3);assert.equal(f.node('ap-notes-pending').querySelector('img'),null,'текст замечания экранирован');
    assert.match(f.node('ap-reject-submit').textContent,/замечаний: 3/);assert.ok(f.calls.every(call=>call.method==='GET'),'добавление замечаний ничего не пишет');
    f.node('autoposting-reject-comment').value='Поправить надписи и музыку';await f.click('#ap-reject-submit');
    const writes=f.calls.filter(call=>call.method!=='GET');assert.equal(writes.length,1);assert.match(writes[0].path,/\/posts\/1\/reject$/);
    assert.deepEqual(server.log[0],{revision:4,comment:'Поправить надписи и музыку',annotations:[{category:'text',comment:'Ко всему: короче',timingKind:'whole'},
      {category:'text',comment:'<img src=x onerror=alert(1)> надпись закрывает композицию',timingKind:'material',startMs:12000,mediaIndex:0},{category:'music',comment:'Сменить трек',timingKind:'editing_wish',startMs:30000,endMs:45000}]});
    assert.match(f.node('autoposting-status').textContent,/Возвращено на доработку\. Замечаний: 3\. Задача доработки №77: Входящие · не назначен · срок не указан\. Уведомления не отправлялись, публикация не выполнялась\./);
    assert.equal(f.d.querySelector('[data-daily-post="1"] .ap-status').textContent,'На доработке');assert.equal(f.node('autoposting-post-state').textContent,'Статус: На доработке');
    const history=f.d.querySelector('.ap-review-notes');assert.ok(history);assert.match(history.textContent,/Версия содержимого v3 \(текущая\)/);
    assert.match(history.textContent,/Текст · 00:12 · в файле №1 \(clip-a\.mp4\)/);assert.match(history.textContent,/Музыка · 00:30–00:45 · пожелание к монтажу — Сменить трек/);assert.match(history.textContent,/ко всему материалу — Ко всему: короче/);
    assert.equal(history.querySelector('img'),null);assert.match(f.d.querySelector('[data-review-task="77"]').textContent,/Задача №77 · версия v3 · Входящие · Не назначен · Срок не указан/);
    assert.doesNotMatch(f.node('autoposting-approval').textContent,/приступил|уведомлени[ея] отправлен|исполнитель назначен|уже в работе/i,'нет обещаний исполнения или уведомления');assert.match(f.node('autoposting-approval').textContent,/уведомления отсюда не отправляются/);
    assert.equal(f.d.querySelectorAll('#ap-notes-pending > li').length,0,'отправленные замечания очищены');
  }finally{f.close();}
});
test('CF4: 409 и потерянный ответ — карточка перечитывается, повторной отправки нет; успех только по перечитанной карточке',async()=>{
  for(const [mode,saveOnError,expect] of [['409',false,/Карточка изменилась в другом окне\. Карточка перечитана: Черновик\. Возврат не подтверждён; замечания остались в форме/],
    ['network',false,/Ответ сервера не получен\. Карточка перечитана: Черновик\. Возврат не подтверждён/],['network',true,/Ответ не был получен, но по перечитанной карточке возврат сохранён\. Замечаний: 1\. Задача доработки №77/],
    ['500',true,/по перечитанной карточке возврат сохранён/]]){
    const server=cf4Reject({mode:mode==='500'?'500':mode,saveOnError,status:mode==='409'?409:500});
    const f=await fixture({entries:[row(1,{mediaUrls:cf4Media})],override:server.override});try{
      await openNoteForm(f);await addNote(f,{comment:'Светлее'});f.node('autoposting-reject-comment').value='Доработать';await f.click('#ap-reject-submit');
      assert.equal(server.log.length,1,mode+': отправка не повторялась');assert.ok(f.calls.some(call=>call.method==='GET'&&call.path.endsWith('/posts/1')),mode+': карточка перечитана');
      assert.match(f.node('autoposting-status').textContent,expect,mode);
      assert.equal(f.d.querySelectorAll('#ap-notes-pending > li').length,saveOnError?0:1,mode+': замечания '+(saveOnError?'очищены':'сохранены'));
    }finally{f.close();}
  }
  const bad=cf4Reject({mode:'400'});const g=await fixture({entries:[row(1,{mediaUrls:cf4Media})],override:bad.override});try{
    await openNoteForm(g);await addNote(g,{comment:'x'});g.node('autoposting-reject-comment').value='Доработать';await g.click('#ap-reject-submit');
    assert.match(g.node('autoposting-status').textContent,/Сервер не принял возврат: Конец интервала раньше начала\. Ничего не изменено; замечания остались в форме/);assert.equal(g.d.querySelectorAll('#ap-notes-pending > li').length,1);
  }finally{g.close();}
});
test('CF4: история привязана к версии и снимку файла; права; файл показан один раз; beforeunload видит неотправленные замечания',async()=>{
  const older={id:3,contentRevision:2,mediaUrls:['https://example.test/old-cut.mp4'],mediaSha256:'',annotations:[{category:'visual',comment:'Кадр тёмный',timingKind:'material',startMs:3000,endMs:null,mediaIndex:0,durationVerified:false}],actorId:1,actorName:'Влад',createdAt:'2026-09-20T01:00:00Z'};
  const entries=[row(1,{mediaUrls:cf4Media,reviewNotes:[older],reviewTasks:[{taskId:41,contentRevision:2,status:'in_progress',assigneeName:'Монтажёр',dueDate:'2026-09-30'}]})];
  const f=await fixture({entries});try{
    await openNoteForm(f);const text=f.d.querySelector('.ap-review-notes').textContent;
    assert.match(text,/Версия содержимого v2 — прежняя версия, файлы с тех пор могли измениться/);assert.match(text,/00:03 · в файле №1 \(old-cut\.mp4\)/,'индекс относится к снимку группы, не к текущему файлу');
    assert.doesNotMatch(text,/clip-a/);assert.match(f.d.querySelector('[data-review-task="41"]').textContent,/В работе · исполнитель Монтажёр · срок 2026-09-30/);
    const unload=()=>{const event=new f.w.Event('beforeunload',{cancelable:true});f.w.dispatchEvent(event);return event.defaultPrevented;};
    assert.equal(unload(),false);await addNote(f,{comment:'Неотправленное'});assert.equal(unload(),true,'неотправленное замечание защищено');
    const media=f.d.querySelector('.ap-editor-media');assert.equal(media.hidden,false);await f.click('#autoposting-preview');assert.equal(media.hidden,true,'после предпросмотра файл показан один раз');
    assert.ok(f.node('autoposting-preview-content').querySelector('.autoposting-media-preview'));
    f.set('autoposting-text','Правка');f.node('autoposting-text').dispatchEvent(new f.w.Event('input',{bubbles:true}));
  }finally{f.close();}
  const g=await fixture({entries,role:'marketer',permissions:['autoposting.view','autoposting.edit']});try{
    await openNoteForm(g);assert.equal(g.node('autoposting-reject-form'),null,'без права согласования формы возврата нет');assert.ok(g.d.querySelector('.ap-review-notes'),'история видна');
  }finally{g.close();}
});
test('CF4: тексты согласования короче, «одобр…» не осталось в окне публикации',async()=>{
  const f=await fixture({entries:[row(1,{approval:{approved:true,stale:false,approvedByName:'Влад',approvedAt:'2026-09-24T01:00:00Z'},platformApprovals:[{platformId:'telegram',platformLabel:'Telegram',state:'approved',stateLabel:'Согласовано',approved:true}]})]});try{
    await f.click('[data-open-post="1"]');const text=f.node('autoposting-editor').textContent;
    assert.doesNotMatch(text,/одобр/i);assert.match(text,/Решение относится только к отмеченным площадкам\./);assert.doesNotMatch(text,/С площадки, которую не трогаете/);
    assert.match(f.node('autoposting-approval').textContent,/Согласовано Влад · 2026-09-24 09:00\. Публикация начнётся только после «Поставить в план»\./);
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
test('approval unavailable for incomplete, published, uncertain or locally modified cards; already approved can be selected only to be returned',async()=>{
  const f=await fixture({entries:[row(1,{readiness:{ready:false,issues:['Добавьте файл']}}),row(2,{approval:{approved:true}}),row(3,{status:'published'}),row(4,{deliveries:[{status:'needs_review'}]}),row(5)]});try{
    for(const id of [1,3,4])assert.equal(f.d.querySelector('[data-daily-approve="'+id+'"]').disabled,true);
    // Назначение флажка изменилось: согласованную карточку выбирают, чтобы вернуть её на доработку.
    assert.equal(f.d.querySelector('[data-daily-approve="2"]').disabled,false,'согласованную карточку можно выбрать для возврата');
    await f.click('[data-daily-approve="2"]');await f.click('#autoposting-batch-approve');
    assert.ok(f.calls.every(call=>call.method==='GET'),'повторное массовое согласование уже одобренного не пишет ничего');
    assert.match(f.node('autoposting-batch-results').textContent,/Материал 2: Уже согласовано/);
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
test('CF3-BOARD: карточка показывает площадку подписью, формат, ОВП, время и один понятный статус; фильтры формата/ОВП/статуса',async()=>{
  const f=await fixture({entries:[row(1,{status:'published'}),row(2,{scheduledAt:'2026-09-25T23:00:00Z',platformIds:[],captions:{vk:'Подпись'},meta:{format:'reel',role:'sale'}}),
    row(3,{scheduledAt:'2026-09-23T02:30:00Z',review:{state:'pending'},meta:{format:'post',role:'reach'}}),row(4,{scheduledAt:'2026-09-23T03:00:00Z',approval:{approved:true,stale:false,approvedAt:'2026-09-22T01:00:00Z',approvedByName:'Владелец'}}),
    row(5,{scheduledAt:'2026-09-23T04:00:00Z',review:{state:'rejected'}})]});try{
    const card=id=>f.d.querySelector(`[data-daily-post="${id}"]`),status=id=>card(id).querySelector('.ap-status').textContent;
    assert.equal(status(1),'Опубликовано');assert.doesNotMatch(card(1).textContent,/Готово к проверке|Нужно подготовить/);
    assert.equal(status(3),'Ждёт согласования');assert.equal(status(4),'Согласовано');assert.equal(status(5),'На доработке');assert.equal(status(2),'Черновик');
    assert.match(card(4).textContent,/Согласовал Владелец · 2026-09-22 09:00/);
    assert.match(card(2).querySelector('.ap-chips').textContent,/ВКонтакте/);assert.equal(card(2).dataset.platform,'vk','цвет площадки задан и продублирован подписью');
    assert.match(card(2).querySelector('.ap-card-meta').textContent,/07:00 · Reels \/ Shorts \/ клип · ОВП: Продажи/);
    assert.ok(card(1).querySelector('.ap-thumb img'),'превью при наличии файла');
    f.set('autoposting-daily-platform','vk');assert.deepEqual(f.visibleIds(),['2']);f.set('autoposting-daily-platform','');
    f.set('autoposting-filter-format','post');assert.deepEqual(f.visibleIds(),['3']);f.set('autoposting-filter-format','none');assert.deepEqual(f.visibleIds(),['4','5','1']);f.set('autoposting-filter-format','');
    f.set('autoposting-filter-role','sale');assert.deepEqual(f.visibleIds(),['2']);f.set('autoposting-filter-role','');
    f.set('autoposting-filter-status','published');assert.deepEqual(f.visibleIds(),['1']);
    assert.equal(f.views.autoposting.title,'Контент-план');assert.ok(f.calls.every(call=>call.method==='GET'));
  }finally{f.close();}
});
test('daily view precedes folded company settings and approval controls appear only after selection',async()=>{
  const f=await fixture();try{
    const tools=f.d.querySelector('.autoposting-workspace-tools');assert.equal(tools.open,false);
    assert.ok(f.node('autoposting-posts').compareDocumentPosition(tools)&f.w.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(f.node('autoposting-batch').hidden,true);assert.equal(f.node('autoposting-status').textContent,'');
    await f.click('[data-daily-approve="1"]');assert.equal(f.node('autoposting-batch').hidden,false);assert.match(f.node('autoposting-batch').textContent,/Публикация не запускается/);
  }finally{f.close();}
});
test('only known current-plan gaps in the next three days create a preparation notice',async()=>{
  for(const basis of ['current_plan','none']){const f=await fixture({entries:[],coverage:{basis,uncoveredDates:['2026-09-24','2026-09-25','2026-09-27','2026-09-28'],unknownDates:['2026-09-26']}});try{
    const note=f.node('autoposting-plan-gaps');assert.equal(note.hidden,basis==='none');
    if(basis==='current_plan'){assert.match(note.textContent,/подготовить публикацию к 2026-09-25, 2026-09-27/);assert.doesNotMatch(note.textContent,/2026-09-24|2026-09-26|2026-09-28|запас|напоминан/);}
    assert.ok(f.calls.every(call=>call.method==='GET'));
  }finally{f.close();}}
});

test('массовый возврат на доработку: причина обязательна, вызывается существующий reject по каждой карточке, результат по каждой свой',async()=>{
  const seen=[];
  const f=await fixture({entries:[row(1,{approval:{approved:true}}),row(2,{approval:{approved:true}})],override:(call,posts)=>{
    if(!call.path.endsWith('/reject'))return undefined;
    const id=Number(call.path.match(/\/posts\/(\d+)\//)[1]),body=JSON.parse(call.options.body);
    seen.push({id,body});
    if(id===2)throw Object.assign(Error('RAW_PROVIDER_FAILURE'),{status:409});
    const item=posts.find(value=>value.id===id);item.revision++;item.approval={approved:false,stale:false};
    item.review={state:'rejected',comment:body.comment};return item;
  }});try{
    for(const id of [1,2])await f.click('[data-daily-approve="'+id+'"]');
    await f.click('#autoposting-batch-reject');
    assert.equal(seen.length,0,'без причины возврат не отправляется');
    f.set('autoposting-batch-reason','Переносим на следующую неделю');
    await f.click('#autoposting-batch-reject');
    assert.deepEqual(seen.map(item=>item.id),[1,2],'по каждой карточке отдельный вызов существующего reject');
    assert.equal(seen[0].body.comment,'Переносим на следующую неделю');
    assert.match(f.node('autoposting-batch-results').textContent,/Материал 1: Возвращено на доработку/);
    assert.match(f.node('autoposting-batch-results').textContent,/Материал 2: Возврат не подтверждён/);
    assert.doesNotMatch(f.d.body.textContent,/RAW_PROVIDER_FAILURE/,'сырая ошибка наружу не выводится');
    assert.ok(!f.calls.some(call=>/schedule|publish/.test(call.path)),'возврат ничего не публикует');
  }finally{f.close();}
});

test('частичное согласование в карточке: в план уходит только согласованная площадка, статус второй виден, согласование можно снять',async()=>{
  const platformApprovals=[{platformId:'telegram',platformLabel:'Telegram',state:'approved',stateLabel:'Согласовано',approved:true,stale:false,contentRevision:3,comment:'',byName:'Влад',at:null},
    {platformId:'vk',platformLabel:'ВКонтакте',state:'rejected',stateLabel:'На доработку',approved:false,stale:false,contentRevision:3,comment:'Нужен другой хук',byName:'Влад',at:null}];
  const writes=[];
  const f=await fixture({entries:[row(1,{platformIds:['telegram','vk'],captions:{telegram:'ТГ',vk:'ВК'},platformApprovals,
    // Дата в будущем относительно зафиксированного времени фикстуры: иначе кабинет справедливо не даёт ставить в план.
    scheduledAt:'2026-09-24T23:45:00Z',
    approval:{approved:false,stale:false,platforms:platformApprovals}})],override:(call,posts)=>{
      if(call.method==='GET'||!/\/(schedule|approve)$/.test(call.path))return undefined;
      writes.push({path:call.path,body:JSON.parse(call.options.body)});
      const item=posts[0];item.revision++;return item;
    }});try{
    await f.click('[data-open-post="1"]');
    // Предпросмотр — обязательное условие постановки в план; ВК в подключениях фикстуры нет вовсе,
    // и это не должно мешать отправке согласованного Telegram.
    await f.click('#autoposting-preview');
    const text=f.node('autoposting-approval').textContent;
    assert.match(text,/Telegram/);assert.match(text,/ВКонтакте/);
    assert.match(text,/Согласовано/);assert.match(text,/На доработку/);
    assert.match(text,/Нужен другой хук/,'причина по площадке видна');
    assert.match(text,/В план уйдут только согласованные площадки: Telegram/);
    assert.equal(f.node('autoposting-schedule').disabled,false,'несогласованный и даже неподключённый ВК не блокирует план для Telegram');
    await f.click('#autoposting-schedule');
    assert.equal(writes.length,1);assert.match(writes[0].path,/\/schedule$/);
    assert.deepEqual(writes[0].body.platformIds,['telegram'],'в план отправлена только согласованная площадка');
    await f.click('#autoposting-revoke-platforms');
    assert.equal(writes.length,2);assert.match(writes[1].path,/\/approve$/);
    assert.equal(writes[1].body.approved,false);
    assert.deepEqual(writes[1].body.platformIds,['telegram','vk'],'снятие относится к отмеченным площадкам');
  }finally{f.close();}
});

test('продолжение по оставшимся площадкам: кнопка вызывает split один раз, повтор не создаёт второй материал',async()=>{
  const platformApprovals=[{platformId:'telegram',platformLabel:'Telegram',state:'approved',stateLabel:'Согласовано',approved:true,stale:false,contentRevision:3,comment:'',byName:'Влад',at:null},
    {platformId:'vk',platformLabel:'ВКонтакте',state:'pending',stateLabel:'Ждёт согласования',approved:false,stale:false,contentRevision:3,comment:'',byName:null,at:null}];
  const parent=row(1,{status:'published',platformIds:['telegram','vk'],captions:{telegram:'ТГ',vk:'ВК'},platformApprovals,
    approval:{approved:false,stale:false,platforms:platformApprovals},
    deliveries:[{channelId:'telegram',status:'published'}],continuedPlatforms:[],continuedFrom:null});
  const child={...row(2,{platformIds:['vk'],captions:{vk:'ВК'},continuedFrom:{postId:1,contentRevision:3}}),title:'Материал 2'};
  const splits=[];
  const f=await fixture({entries:[parent],override:(call,posts)=>{
    if(!call.path.endsWith('/split'))return undefined;
    splits.push(JSON.parse(call.options.body));
    const source=posts[0];
    const created=splits.length===1;
    source.continuedPlatforms=[{platformId:'vk',platformLabel:'ВКонтакте',childPostId:2,createdAt:'2026-09-24T23:30:00Z'}];
    return {created,post:source,child};
  }});try{
    await f.click('[data-open-post="1"]');
    assert.match(f.node('autoposting-approval').textContent,/Продолжить по оставшимся площадкам/);
    await f.click('#autoposting-continue-remaining');
    assert.equal(splits.length,1);
    assert.deepEqual(splits[0].platformIds,['vk'],'продолжение запрашивается только по неотправленной площадке');
    assert.equal(splits[0].revision,parent.revision);
    assert.match(f.d.body.textContent,/Создан отдельный материал №2/);
    await f.click('[data-open-post="1"]');
    assert.match(f.node('autoposting-approval').textContent,/продолжена в отдельном материале №2/,'в исходной карточке видно, куда ушла работа');
    assert.equal(f.d.querySelector('#autoposting-continue-remaining'),null,'переданная площадка второй раз не предлагается');
    assert.ok(!f.calls.some(call=>/schedule/.test(call.path)),'продолжение ничего не планирует и не публикует');
  }finally{f.close();}
  // Продолжение создаёт черновик: достаточно права правки материалов, права согласования не требуется.
  const editor=await fixture({entries:[parent],role:'marketer',permissions:['autoposting.view','autoposting.edit']});try{
    await editor.click('[data-open-post="1"]');
    assert.ok(editor.d.querySelector('#autoposting-continue-remaining'),'редактор без права одобрения может продолжить работу');
  }finally{editor.close();}
  const viewer=await fixture({entries:[parent],role:'marketer',permissions:['autoposting.view']});try{
    await viewer.click('[data-open-post="1"]');
    assert.equal(viewer.d.querySelector('#autoposting-continue-remaining'),null,'только чтение продолжение не создаёт');
  }finally{viewer.close();}
});

test('карточка подключения YouTube Shorts: только Onlypult, по умолчанию выключено, есть загрузка профилей, проверка и сохранение',async()=>{
  const channels=[
    {id:'telegram',platform:'telegram',name:'Telegram',enabled:false,connected:true,revision:1,provider:'direct'},
    {id:'youtube_shorts',platform:'youtube_shorts',name:'YouTube Shorts',enabled:false,connected:false,revision:0,
     provider:'onlypult',target:'',caps:{maxText:5000,maxMedia:1,mediaMode:'video'}}];
  const f=await fixture({override:call=>call.path.endsWith('/settings')
    ?{timezone:'Asia/Irkutsk',channels}:undefined});try{
    f.d.querySelector('.autoposting-connections')?.setAttribute('open','');
    const card=[...f.d.querySelectorAll('[data-channel]')].find(node=>node.dataset.channel==='youtube_shorts');
    assert.ok(card,'карточка канала есть');
    const options=[...card.querySelectorAll('[data-channel-field="provider"] option')].map(node=>node.value);
    assert.deepEqual(options,['onlypult'],'прямого подключения в выборе нет');
    assert.equal(card.querySelector('[data-channel-field="provider"]').value,'onlypult');
    assert.equal(card.querySelector('[data-channel-field="enabled"]').checked,false,'по умолчанию отправка выключена');
    assert.ok(card.querySelector('[data-channel-field="name"]'),'название канала можно задать');
    assert.ok(card.querySelector('[data-channel-field="target"]'),'профиль выбирается списком');
    assert.ok(card.querySelector('[data-load-profiles="youtube_shorts"]'),'есть загрузка профилей');
    assert.ok(card.querySelector('[data-check-channel="youtube_shorts"]'),'есть проверка доступа');
    assert.ok(card.querySelector('button[type="submit"]'),'есть сохранение подключения');
    assert.match(card.textContent,/только через Onlypult/);
    assert.match(card.textContent,/заголовок|заголовка/i);
    // Подключённый, но выключенный канал больше не выглядит неподключённым.
    const platforms=f.node('autoposting-platforms').textContent;
    assert.match(platforms,/Telegram — отправка выключена/);
    assert.doesNotMatch(platforms,/Telegram — требуется подключение/);
    assert.ok(f.calls.every(call=>call.method==='GET'),'осмотр карточки ничего не сохраняет');
  }finally{f.close();}
});

test('карточка подключения названа своей площадкой, а требования YouTube не блокируют согласованный Telegram',async()=>{
  const channels=[
    {id:'telegram',platform:'telegram',name:'Telegram',enabled:true,connected:true,revision:1,provider:'direct'},
    {id:'youtube_shorts',platform:'youtube_shorts',name:'',enabled:false,connected:false,revision:0,provider:'onlypult',target:'',
     caps:{maxText:5000,maxMedia:1,mediaMode:'video'}}];
  const platformApprovals=[
    {platformId:'telegram',platformLabel:'Telegram',state:'approved',stateLabel:'Согласовано',approved:true,stale:false,contentRevision:3,comment:'',byName:'Влад',at:null},
    {platformId:'youtube_shorts',platformLabel:'YouTube Shorts',state:'pending',stateLabel:'Ждёт согласования',approved:false,stale:false,contentRevision:3,comment:'',byName:null,at:null}];
  const entry=row(1,{title:'З'.repeat(140),platformIds:['telegram','youtube_shorts'],captions:{telegram:'ТГ'},
    scheduledAt:'2026-09-24T23:45:00Z',platformApprovals,approval:{approved:false,stale:false,platforms:platformApprovals}});
  const f=await fixture({entries:[entry],override:call=>call.path.endsWith('/settings')
    ?{timezone:'Asia/Irkutsk',channels}:undefined});try{
    const youtubeCard=[...f.d.querySelectorAll('[data-channel]')].find(node=>node.dataset.channel==='youtube_shorts');
    assert.match(youtubeCard.querySelector('h3').textContent,/YouTube Shorts/,'канал назван своей площадкой, а не Telegram');
    const telegramCard=[...f.d.querySelectorAll('[data-channel]')].find(node=>node.dataset.channel==='telegram');
    assert.match(telegramCard.querySelector('h3').textContent,/Telegram/);
    await f.click('[data-open-post="1"]');
    await f.click('#autoposting-preview');
    const preview=f.node('autoposting-preview-content').textContent;
    assert.doesNotMatch(preview,/сократите его до 100 символов/,'длинное название несогласованного YouTube не мешает Telegram');
    assert.equal(f.node('autoposting-schedule').disabled,false,'согласованный Telegram ставится в план');
  }finally{f.close();}
});

test('когда YouTube Shorts согласован, длинное название и не ровно одно видео блокируют планирование, а предпросмотр называет публичный доступ',async()=>{
  const channels=[{id:'youtube_shorts',platform:'youtube_shorts',name:'YouTube Shorts',enabled:true,connected:true,revision:1,
    provider:'onlypult',target:'profile',caps:{maxText:5000,maxMedia:1,mediaMode:'video'}}];
  const approvals=[{platformId:'youtube_shorts',platformLabel:'YouTube Shorts',state:'approved',stateLabel:'Согласовано',
    approved:true,stale:false,contentRevision:3,comment:'',byName:'Влад',at:null}];
  const make=extra=>row(1,{platformIds:['youtube_shorts'],captions:{},scheduledAt:'2026-09-24T23:45:00Z',
    platformApprovals:approvals,approval:{approved:false,stale:false,platforms:approvals},...extra});
  const long=await fixture({entries:[make({title:'З'.repeat(101),mediaUrls:['https://example.test/clip.mp4']})],
    override:call=>call.path.endsWith('/settings')?{timezone:'Asia/Irkutsk',channels}:undefined});try{
    await long.click('[data-open-post="1"]');await long.click('#autoposting-preview');
    const text=long.node('autoposting-preview-content').textContent;
    assert.match(text,/сократите его до 100 символов/);
    assert.match(text,/публичный доступ/,'предпросмотр прямо говорит про публичный доступ');
    assert.equal(long.node('autoposting-schedule').disabled,true);
  }finally{long.close();}
  const two=await fixture({entries:[make({title:'Короткое название',mediaUrls:['https://example.test/a.mp4','https://example.test/b.mp4']})],
    override:call=>call.path.endsWith('/settings')?{timezone:'Asia/Irkutsk',channels}:undefined});try{
    await two.click('[data-open-post="1"]');await two.click('#autoposting-preview');
    assert.match(two.node('autoposting-preview-content').textContent,/ровно один видеофайл/);
    assert.equal(two.node('autoposting-schedule').disabled,true);
  }finally{two.close();}
});

test('кабинет не пускает в план картинку или http-ссылку для YouTube Shorts, и не мешает согласованному Telegram',async()=>{
  const channels=[{id:'youtube_shorts',platform:'youtube_shorts',name:'YouTube Shorts',enabled:true,connected:true,revision:1,
    provider:'onlypult',target:'profile',caps:{maxText:5000,maxMedia:1,mediaMode:'video'}}];
  const approvals=[{platformId:'youtube_shorts',platformLabel:'YouTube Shorts',state:'approved',stateLabel:'Согласовано',
    approved:true,stale:false,contentRevision:3,comment:'',byName:'Влад',at:null}];
  const make=mediaUrls=>row(1,{platformIds:['youtube_shorts'],captions:{},scheduledAt:'2026-09-24T23:45:00Z',
    title:'Короткое название',mediaUrls,platformApprovals:approvals,approval:{approved:false,stale:false,platforms:approvals}});
  for (const [name,mediaUrls] of [
    ['картинка вместо видео',['https://example.test/frame.jpg']],
    ['видео по http',['http://example.test/clip.mp4']],
    ['картинка с расширением в параметре',['https://example.test/frame.jpg?file=.mp4']],
    ['видео с фрагментом',['https://example.test/clip.mp4#t=1']],
    ['видео с параметром и фрагментом',['https://example.test/clip.mp4?x=1#t=1']],
  ]) {
    const f=await fixture({entries:[make(mediaUrls)],override:call=>call.path.endsWith('/settings')
      ?{timezone:'Asia/Irkutsk',channels}:undefined});try{
      await f.click('[data-open-post="1"]');await f.click('#autoposting-preview');
      assert.match(f.node('autoposting-preview-content').textContent,/ровно один видеофайл по HTTPS/,name);
      assert.equal(f.node('autoposting-schedule').disabled,true,name);
      assert.ok(!f.calls.some(call=>/schedule/.test(call.path)),name);
    }finally{f.close();}
  }
  const ok=await fixture({entries:[make(['https://example.test/clip.mp4?version=1'])],override:call=>call.path.endsWith('/settings')
    ?{timezone:'Asia/Irkutsk',channels}:undefined});try{
    await ok.click('[data-open-post="1"]');await ok.click('#autoposting-preview');
    assert.doesNotMatch(ok.node('autoposting-preview-content').textContent,/ровно один видеофайл по HTTPS/);
    assert.equal(ok.node('autoposting-schedule').disabled,false,'настоящий параметр запроса видео не ломает');
  }finally{ok.close();}
});

test('CF2: черновики из предложений контент-завода — список перечитывается, черновик открывается без одобрения и записи',async()=>{
  const f=await fixture({entries:[row(1),row(7,{title:'Черновик из предложения'})],listIds:[1]});try{
    const lists=()=>f.calls.filter(call=>call.path.endsWith('/posts')&&call.method==='GET').length;
    const before=lists();
    f.w.dispatchEvent(new f.w.CustomEvent('sb:content-factory-drafts',{detail:{companyCode:'beta'}}));await f.settle();
    assert.equal(lists(),before,'событие другой компании игнорируется');
    f.w.dispatchEvent(new f.w.CustomEvent('sb:content-factory-drafts',{detail:{companyCode:'alpha'}}));await f.settle();
    assert.equal(lists(),before+1,'список материалов перечитан');
    f.w.dispatchEvent(new f.w.CustomEvent('sb:content-factory-open-draft',{detail:{companyCode:'alpha',postId:7}}));await f.settle();
    assert.ok(f.calls.some(call=>call.path.endsWith('/posts/7')&&call.method==='GET'),'прямой GET черновика вне списка');
    assert.equal(f.node('autoposting-editor').open,true);assert.equal(f.node('autoposting-select').value,'7');
    assert.match(f.node('autoposting-status').textContent,/Материал из предложения открыт: Черновик, не согласован\./);
    f.w.dispatchEvent(new f.w.CustomEvent('sb:content-factory-open-draft',{detail:{companyCode:'beta',postId:1}}));await f.settle();
    assert.equal(f.node('autoposting-select').value,'7','чужая компания не открывает материал');
    assert.ok(f.calls.every(call=>call.method==='GET'),'ни одобрения, ни записи');
  }finally{f.close();}
});

test('CF2-UI-R1: повторное открытие материала из предложения показывает его фактическое состояние, а не «не согласован»',async()=>{
  const f=await fixture({entries:[row(1),row(8,{title:'Ранее созданный черновик',status:'scheduled',approval:{approved:true,approvedRevision:3,stale:false}})],listIds:[1]});try{
    const open=async()=>{f.w.dispatchEvent(new f.w.CustomEvent('sb:content-factory-open-draft',{detail:{companyCode:'alpha',postId:8}}));await f.settle();return f.node('autoposting-status').textContent;};
    let text=await open();
    assert.match(text,/В плане, согласован\./);
    assert.doesNotMatch(text,/не согласован|не запланирован/);
    const item=f.posts.find(value=>value.id===8);Object.assign(item,{status:'draft',approval:{approved:false,stale:true},contentRevision:4,revision:5});
    text=await open();
    assert.match(text,/Черновик, согласование снято после правки\./,'после изменения — текущее состояние из нового GET');
    const gets=f.calls.filter(call=>call.path.endsWith('/posts/8'));assert.equal(gets.length,2,'каждое открытие — свежий GET');
    assert.ok(f.calls.every(call=>call.method==='GET'));
  }finally{f.close();}
});
// ---------- CF5: удаление черновика и восстановление (контракт CONTENT_FACTORY_CF5_RECOVERY_CONTRACT_20261001) ----------
const archivedRow=(id,extra={})=>row(id,{title:'Удалённый '+id,scheduledAt:null,archive:{archivedAt:'2026-09-24T10:00:00Z',archivedBy:1},...extra});
// Синтетический сервер по контракту CF5: archive/restore {revision}, GET /autoposting/archived, GET /posts/:id читает и архив.
const cf5Server=({archive='ok',restore='ok',archived=[],readFails=false}={})=>{const log=[],store=clone(archived);let lost=false;return {log,store,override:(call,posts)=>{
  if(call.path.endsWith('/autoposting/archived')){log.push(['archived']);return {companyCode:call.code,posts:clone(store.filter(item=>item.companyCode===call.code))};}
  const match=call.path.match(/\/posts\/(\d+)(?:\/(archive|restore))?$/);if(!match)return undefined;const id=Number(match[1]);
  if(call.method==='GET'){if(readFails&&lost)throw Object.assign(Error('Failed to fetch'),{});const item=store.find(value=>value.id===id&&value.companyCode===call.code);return item?clone(item):undefined;}
  if(!match[2])return undefined;
  const body=JSON.parse(call.options.body);log.push([match[2],body]);assert.equal(call.options.headers['X-CSRF-Token'],'fixture');assert.deepEqual(Object.keys(body),['revision']);
  const mode=match[2]==='archive'?archive:restore;
  const save=()=>{
    if(match[2]==='archive'){const item=posts.find(value=>value.id===id);assert.equal(body.revision,item.revision);item.revision++;item.archive={archivedAt:'2026-09-25T02:00:00Z',archivedBy:1};item.status='draft';item.scheduledAt=null;item.approval={approved:false,stale:false};posts.splice(posts.indexOf(item),1);store.unshift(item);return clone(item);}
    const item=store.find(value=>value.id===id);assert.equal(body.revision,item.revision);item.revision++;item.archive={archivedAt:null,archivedBy:null};item.status='draft';item.review={state:'draft'};item.approval={approved:false,stale:false};item.scheduledAt=null;store.splice(store.indexOf(item),1);posts.push(item);return clone(item);};
  if(mode==='ok')return save();
  if(mode==='lost'){save();lost=true;throw Error('Failed to fetch');}
  if(mode==='scheduled'){const item=posts.find(value=>value.id===id);item.status='scheduled';item.revision++;throw Object.assign(Error('Публикация уже изменена'),{status:409});}
  if(mode==='409')throw Object.assign(Error('У материала есть незавершённая или подтверждённая отправка'),{status:409});
  if(mode==='500'){lost=true;throw Object.assign(Error('Ошибка сервера, попробуйте позже'),{status:500});}
  if(mode==='400')throw Object.assign(Error('Некорректные поля запроса'),{status:400});
  throw Error('mode '+mode);
}};};
const writesOf=f=>f.calls.filter(call=>call.method!=='GET');
test('CF5: «Удалить черновик» — понятное подтверждение, «Отмена» ничего не пишет; удаление одним archive {revision}, карточка уходит с доски в «Удалённые»',async()=>{
  const server=cf5Server();const f=await fixture({entries:[row(1,{title:'Отзыв клиента',reviewNotes:[],reviewTasks:[]}),row(2)],override:server.override});try{
    await f.click('[data-open-post="1"]');
    assert.equal(f.node('autoposting-archive-button').textContent,'Удалить черновик');assert.equal(f.node('autoposting-archive-yes'),null,'без подтверждения кнопки «Удалить» нет');
    await f.click('#autoposting-archive-button');
    assert.match(f.node('autoposting-archive-question').textContent,/^Удалить «Отзыв клиента»\? Материал уйдёт из плана в «Удалённые материалы»\. Текст, файлы, замечания и задачи сохранятся — его можно вернуть\.$/);
    assert.equal(f.d.activeElement,f.node('autoposting-archive-no'),'фокус на безопасном «Отмена»');
    await f.click('#autoposting-archive-no');assert.ok(f.node('autoposting-archive-button'));assert.equal(writesOf(f).length,0,'отмена ничего не пишет');
    await f.click('#autoposting-archive-button');await f.click('#autoposting-archive-yes');
    assert.deepEqual(server.log,[['archive',{revision:4}]]);assert.equal(writesOf(f).length,1,'ровно одна запись');
    assert.equal(f.node('autoposting-editor').open,false,'окно закрыто');assert.ok(!f.visibleIds().includes('1')&&!f.undatedIds().includes('1'),'карточки нет на доске');
    assert.ok(![...f.node('autoposting-select').options].some(option=>option.value==='1'),'и в списке «Открыть материал»');
    assert.match(f.node('autoposting-status').textContent,/^«Отзыв клиента» удалён из плана\. Вернуть можно в «Удалённых материалах» внизу доски\.$/);
    f.node('autoposting-archive').open=true;f.node('autoposting-archive').dispatchEvent(new f.w.Event('toggle'));await f.settle();
    const item=f.d.querySelector('[data-archived-post="1"]');assert.ok(item);assert.match(item.textContent,/Отзыв клиента/);assert.match(item.textContent,/Удалено 25\.09\.2026, 10:00/,'время — по поясу компании');
    assert.doesNotMatch(item.textContent,/Черновик|Согласовано|Запланировано/,'удалённый не выглядит действующим');
    assert.match(f.d.querySelector('#autoposting-archive > summary').textContent,/Удалённые материалы \(1\)/);
    assert.ok(f.calls.every(call=>!/approve|schedule|restore/.test(call.path)),'удаление не согласует, не планирует и не восстанавливает');
    assert.equal(f.w.eval('(()=>{const e=new Event("beforeunload",{cancelable:true});dispatchEvent(e);return e.defaultPrevented;})()'),false,'после удаления несохранённого нет');
  }finally{f.close();}
});
test('CF5: что удалить нельзя — запланированное сначала снять с публикации; отправляемое, опубликованное, без права правки и с несохранённой правкой',async()=>{
  const server=cf5Server();const f=await fixture({entries:[row(1,{status:'scheduled'}),row(2,{status:'publishing'}),row(3,{status:'published'}),row(4,{externalReceipts:[{platform:'telegram',url:'https://t.me/c/1',publishedAt:'2026-09-24T10:00:00Z'}]}),row(5,{status:'failed'}),row(6,{status:'cancelled'}),row(7)],override:server.override});try{
    await f.click('[data-open-post="1"]');assert.equal(f.node('autoposting-archive-button'),null);assert.match(f.node('autoposting-archive-zone').textContent,/^Чтобы удалить материал, сначала снимите его с публикации\.$/);
    assert.equal(f.node('autoposting-cancel').hidden,false,'рядом — «Снять с публикации»');
    for(const id of ['2','3','4']){f.node('autoposting-editor').open=false;await f.click(`[data-open-post="${id}"]`);assert.equal(f.node('autoposting-archive-zone').textContent,'',id);}
    for(const id of ['5','6','7']){f.node('autoposting-editor').open=false;await f.click(`[data-open-post="${id}"]`);assert.ok(f.node('autoposting-archive-button'),id);}
    f.node('autoposting-text').value='Несохранённая правка';f.node('autoposting-text').dispatchEvent(new f.w.Event('input',{bubbles:true}));await f.settle();
    assert.equal(f.node('autoposting-archive-button').disabled,true);assert.match(f.node('autoposting-archive-note').textContent,/Сначала сохраните правки/);
    assert.equal(writesOf(f).length,0);
  }finally{f.close();}
  const view=await fixture({role:'editor',permissions:['autoposting.view'],entries:[row(1)],override:cf5Server().override});try{
    await view.click('[data-open-post="1"]');assert.equal(view.node('autoposting-archive-zone').textContent,'','без права правки удалять нельзя');
    view.node('autoposting-archive').open=true;view.node('autoposting-archive').dispatchEvent(new view.w.Event('toggle'));await view.settle();
    assert.equal(view.d.querySelector('[data-restore-post]'),null,'и восстанавливать тоже');
  }finally{view.close();}
});
test('CF5: 409 и неизвестный исход удаления — карточка перечитывается, вслепую не повторяется; 400 — ничего не изменено',async()=>{
  for(const [mode,check] of [
    ['scheduled',f=>{assert.match(f.node('autoposting-status').textContent,/^Удаление не выполнено: материал стоит в плане — сначала снимите его с публикации\. Карточка перечитана: Запланировано\. Повторно ничего не отправлялось\.$/);
      assert.equal(f.node('autoposting-editor').open,true);assert.equal(f.node('autoposting-archive-button'),null);assert.equal(f.d.querySelector('[data-daily-post="1"] .ap-status').textContent,'Запланировано');}],
    ['409',f=>{assert.match(f.node('autoposting-status').textContent,/^Удаление не выполнено: У материала есть незавершённая или подтверждённая отправка\. Карточка перечитана: Черновик\. Повторно ничего не отправлялось\.$/);assert.ok(f.visibleIds().includes('1'));}],
    ['lost',f=>{assert.match(f.node('autoposting-status').textContent,/удалён — это подтверждено после перечитывания карточки\. Повторно ничего не отправлялось/);assert.ok(!f.visibleIds().includes('1'));assert.equal(f.node('autoposting-editor').open,false);}],
    ['500',f=>{assert.match(f.node('autoposting-status').textContent,/^Не удалось подтвердить удаление и перечитать карточку\. Обновите статусы, прежде чем удалять снова\.$/);assert.ok(f.visibleIds().includes('1'));}],
    ['400',f=>{assert.match(f.node('autoposting-status').textContent,/^Сервер не принял удаление: Некорректные поля запроса\. Ничего не изменено\.$/);}]]){
    const server=cf5Server({archive:mode,readFails:mode==='500'});const f=await fixture({entries:[row(1)],override:server.override});try{
      await f.click('[data-open-post="1"]');await f.click('#autoposting-archive-button');await f.click('#autoposting-archive-yes');
      assert.equal(writesOf(f).length,1,mode+': одна попытка, без повторной отправки');
      const reread=f.calls.filter(call=>call.method==='GET'&&call.path.endsWith('/posts/1')).length;assert.equal(reread,mode==='400'?0:1,mode+': перечитывание');
      check(f);
    }finally{f.close();}
  }
});
test('CF5: «Удалённые материалы» — восстановление отдельной кнопкой, один restore {revision}; черновик без согласования и даты; 409/потерянный ответ перечитываются',async()=>{
  const server=cf5Server({archived:[archivedRow(9,{title:'Отзыв (удалён)',reviewNotes:[{id:1,contentRevision:3,mediaUrls:[],annotations:[{category:'text',comment:'x',timingKind:'whole'}]}]})]});
  const f=await fixture({entries:[row(1)],override:server.override});try{
    assert.equal(f.node('autoposting-archive').open,false,'список свёрнут');assert.ok(!f.calls.some(call=>call.path.endsWith('/archived')),'и не грузится, пока не раскрыт');
    f.node('autoposting-archive').open=true;f.node('autoposting-archive').dispatchEvent(new f.w.Event('toggle'));await f.settle();
    const item=f.d.querySelector('[data-archived-post="9"]');assert.match(item.textContent,/Отзыв \(удалён\)Удалено 24\.09\.2026, 18:00 · замечаний: 1/);
    await f.click('[data-restore-post="9"]');
    assert.deepEqual(server.log.filter(entry=>entry[0]!=='archived'),[['restore',{revision:4}]]);assert.equal(writesOf(f).length,1);
    assert.equal(f.d.querySelector('[data-archived-post="9"]'),null,'ушёл из удалённых');
    assert.match(f.node('autoposting-status').textContent,/^«Отзыв \(удалён\)» восстановлен как черновик\. Согласование и дата отправки не возвращаются — проверьте материал и согласуйте заново\.$/);
    assert.ok(f.undatedIds().includes('9'),'вернулся на доску (без даты)');assert.equal(f.d.querySelector('[data-daily-post="9"] .ap-status').textContent,'Черновик');
    assert.ok(f.calls.every(call=>!/approve|schedule|archive$/.test(call.path)),'восстановление не согласует и не планирует');
  }finally{f.close();}
  for(const [mode,expect,stays] of [['409',/^Восстановление не выполнено: У материала есть незавершённая или подтверждённая отправка\. Материал остался в удалённых; карточка перечитана\. Повторно ничего не отправлялось\.$/,true],
    ['lost',/^«Удалённый 9» уже восстановлен — это подтверждено после перечитывания карточки: Черновик\. Повторно ничего не отправлялось\.$/,false]]){
    const srv=cf5Server({restore:mode,archived:[archivedRow(9)]});const g=await fixture({entries:[row(1)],override:srv.override});try{
      g.node('autoposting-archive').open=true;g.node('autoposting-archive').dispatchEvent(new g.w.Event('toggle'));await g.settle();
      await g.click('[data-restore-post="9"]');assert.equal(writesOf(g).length,1,mode);
      assert.match(g.node('autoposting-status').textContent,expect);assert.equal(Boolean(g.d.querySelector('[data-archived-post="9"]')),stays);assert.equal(g.undatedIds().includes('9'),!stays);
    }finally{g.close();}
  }
});
test('CF5: удалённый материал по ссылке или из предложений не открывается как действующий — показан в «Удалённых» с датой',async()=>{
  const f=await fixture({entries:[row(1)],override:cf5Server({archived:[archivedRow(9,{title:'Шары (удалён)'})]}).override,url:'https://fixture.test/#content-factory/materials?company=alpha&post=9&revision=3'});try{
    assert.equal(f.node('autoposting-editor').open,false,'окно не открыто');assert.equal(f.node('autoposting-archive').open,true);
    assert.equal(f.d.querySelector('[data-archived-post="9"]').dataset.focus,'true');
    assert.match(f.node('autoposting-status').textContent,/^Материал «Шары \(удалён\)» удалён 24\.09\.2026, 18:00\. Он в «Удалённых материалах» внизу доски — его можно восстановить\.$/);
    assert.ok(!f.visibleIds().includes('9')&&!f.undatedIds().includes('9'));assert.equal(writesOf(f).length,0);
    f.w.dispatchEvent(new f.w.CustomEvent('sb:content-factory-open-draft',{detail:{companyCode:'alpha',postId:9}}));await f.settle();
    assert.equal(f.node('autoposting-editor').open,false);assert.match(f.node('autoposting-status').textContent,/удалён 24\.09\.2026/);assert.equal(writesOf(f).length,0);
  }finally{f.close();}
  // Защита: если в обычный список попадёт архивная карточка, на доске она не показывается.
  const g=await fixture({entries:[row(1),archivedRow(2)]});try{assert.ok(!g.visibleIds().includes('2')&&!g.undatedIds().includes('2'));}finally{g.close();}
});
test('CF5: подсказки «?» с примером у всех полей окна публикации; не входят в имя поля; доступны и при просмотре',async()=>{
  const ids=['autoposting-select','autoposting-title','autoposting-format','autoposting-role','autoposting-date','autoposting-timezone','autoposting-text','autoposting-photo','autoposting-day','autoposting-origin','autoposting-media',
    'ap-meta-audience','ap-meta-hook','ap-meta-idea','ap-meta-hughNote','ap-meta-metrics','ap-meta-methodSource','autoposting-reject-comment','autoposting-receipt-platform','autoposting-receipt-url','autoposting-receipt-date','autoposting-receipt-note'];
  for(const [role,permissions] of [['owner',[]],['editor',['autoposting.view']]]){
    const f=await fixture({role,permissions,entries:[row(1,{mediaUrls:['https://example.test/clip.mp4']})]});try{
      await f.click('[data-open-post="1"]');
      for(const id of role==='owner'?ids:ids.filter(id=>!/reject|receipt/.test(id))){
        const node=f.node(id);assert.ok(node,id);const hint=f.d.querySelector(`[aria-controls="ap-hint-f-${id}"]`),text=f.node('ap-hint-f-'+id);
        assert.ok(hint&&text,id+': есть подсказка');assert.equal(hint.disabled,false,id+': подсказка доступна');assert.equal(text.hidden,true);assert.match(text.textContent,/Например/,id+': с примером');
        assert.equal(node.labels.length,1,id);assert.doesNotMatch(node.labels[0].textContent,/Подсказка|\?/,id+': «?» не попадает в подпись');
      }
      for(const group of ['autoposting-platforms','autoposting-captions','autoposting-options']){const text=f.node('ap-hint-f-'+group);assert.ok(text,group);assert.match(text.textContent,/Например/,group);}
      await f.click('[aria-controls="ap-hint-f-autoposting-role"]');assert.equal(f.node('ap-hint-f-autoposting-role').hidden,false);assert.match(f.node('ap-hint-f-autoposting-role').textContent,/Охват → Влюбление → Продажи/);
      await f.click('[aria-controls="ap-hint-f-autoposting-role"]');assert.equal(f.node('ap-hint-f-autoposting-role').hidden,true);
      assert.equal(writesOf(f).length,0);
    }finally{f.close();}
  }
});
test('CF5: «Отметить текущий момент» берёт video.currentTime; момент позже конца ролика не принимается; у фото — ручной ввод',async()=>{
  const f=await fixture({entries:[row(1,{mediaUrls:['https://example.test/clip-a.mp4','https://example.test/photo-b.jpg']})],override:cf4Reject().override});try{
    await openNoteForm(f);await f.click('#ap-note-time-toggle');f.d.querySelector('[name="ap-note-kind"][value="material"]').checked=true;f.node('ap-note-media').value='0';
    const video=f.d.querySelector('#autoposting-media-preview video');assert.ok(video,'видео в колонке предпросмотра');
    Object.defineProperty(video,'currentTime',{configurable:true,value:72.46});Object.defineProperty(video,'duration',{configurable:true,value:90});
    await f.click('#ap-note-mark');assert.equal(f.node('ap-note-start').value,'01:12.4');assert.equal(f.node('ap-note-error').textContent,'');
    f.node('ap-note-comment').value='Надпись закрывает лицо';await f.click('#ap-note-add');
    assert.match(f.node('ap-notes-pending').textContent,/01:12\.4 · в файле №1 \(clip-a\.mp4\)/);
    if(f.node('ap-note-time').hidden)await f.click('#ap-note-time-toggle');f.d.querySelector('[name="ap-note-kind"][value="material"]').checked=true;f.node('ap-note-media').value='0';
    f.node('ap-note-comment').value='После конца';f.node('ap-note-start').value='01:35';await f.click('#ap-note-add');
    assert.match(f.node('ap-note-error').textContent,/^Момент позже конца ролика \(01:30\)\.$/);assert.equal(f.d.querySelectorAll('#ap-notes-pending > li').length,1);
    f.node('ap-note-media').value='1';await f.click('#ap-note-mark');assert.match(f.node('ap-note-error').textContent,/Для фото и пожелания к монтажу укажите время вручную/);
  }finally{f.close();}
});
test('CF5: повторный возврат на доработку идёт с новой актуальной ревизией; история показывает обе группы, задачи — обе',async()=>{
  const server=cf4Reject();const f=await fixture({entries:[row(1,{mediaUrls:cf4Media})],override:server.override});try{
    await openNoteForm(f);await addNote(f,{comment:'Светлее фон'});f.node('autoposting-reject-comment').value='Первый возврат';await f.click('#ap-reject-submit');
    assert.equal(server.log[0].revision,4);assert.equal(f.node('autoposting-editor').open,true);assert.ok(f.node('autoposting-reject-form'),'форма возврата доступна и на доработке');
    await addNote(f,{category:'music',comment:'Другой трек',time:{kind:'editing_wish',start:'00:05'}});f.node('autoposting-reject-comment').value='Второй возврат';await f.click('#ap-reject-submit');
    assert.equal(server.log.length,2);assert.equal(server.log[1].revision,5,'вторая отправка — с ревизией после первого возврата');
    assert.deepEqual(server.log[1].annotations,[{category:'music',comment:'Другой трек',timingKind:'editing_wish',startMs:5000}]);
    assert.match(f.node('autoposting-status').textContent,/^Возвращено на доработку\. Замечаний: 1\./);
    assert.match(f.d.querySelector('.ap-review-notes > summary').textContent,/Вся история замечаний: групп 2 · замечаний 2/);
    assert.equal(writesOf(f).length,2);
  }finally{f.close();}
});

// ---------- CF6: открытие из статистики и свёрнутая история ----------
test('CF6: открытие из статистики — новый GET, окно открыто, сообщение нейтральное по текущей карточке; запрос из общего слота выполняется после загрузки',async()=>{
  const published=row(42,{status:'published',title:'Опубликованный отзыв',contentRevision:5,approval:{approved:true,stale:false}});
  const f=await fixture({entries:[row(1),published],listIds:[1]});try{
    f.w.dispatchEvent(new f.w.CustomEvent('sb:content-factory-open-draft',{detail:{companyCode:'alpha',postId:42,source:'stats'}}));await f.settle();
    assert.ok(f.calls.some(call=>call.method==='GET'&&call.path.endsWith('/posts/42')&&call.code==='alpha'),'карточка перечитана');
    assert.equal(f.node('autoposting-editor').open,true);assert.equal(f.node('autoposting-select').value,'42');
    const text=f.node('autoposting-status').textContent;
    assert.equal(text,'Материал №42 открыт из статистики. Текущее состояние: Опубликовано, содержимое v5.');
    assert.doesNotMatch(text,/черновик|предложени/i,'опубликованная карточка не выдаётся за черновик или предложение');
    assert.ok(f.calls.every(call=>call.method==='GET'),'открытие ничего не пишет');
  }finally{f.close();}
  // Вкладка создаётся уже после клика в статистике: запрос ждёт в общем слоте и выполняется после загрузки.
  const g=await fixture({entries:[row(1),published],listIds:[1],beforeRender:w=>{w.SbCabinet.pendingMaterialOpen={companyCode:'alpha',postId:42,source:'stats'};}});try{
    await g.settle();assert.equal(g.node('autoposting-editor').open,true);assert.equal(g.node('autoposting-select').value,'42');
    assert.equal(g.w.SbCabinet.pendingMaterialOpen,null,'слот очищен — повторного открытия не будет');assert.match(g.node('autoposting-status').textContent,/открыт из статистики/);
  }finally{g.close();}
});
test('CF6: запрос из статистики другой компании не открывает чужую карточку и не запрашивает её',async()=>{
  const f=await fixture({entries:[row(1),row(42,{companyCode:'beta'})],beforeRender:w=>{w.SbCabinet.pendingMaterialOpen={companyCode:'beta',postId:42,source:'stats'};}});try{
    await f.settle();
    assert.equal(f.node('autoposting-editor').open,false);assert.ok(!f.calls.some(call=>call.path.endsWith('/posts/42')),'чужая карточка не запрашивается');
    assert.match(f.node('autoposting-status').textContent,/^Материал из статистики не открыт: выбрана другая компания\.$/);assert.equal(f.w.SbCabinet.pendingMaterialOpen,null);
    f.w.dispatchEvent(new f.w.CustomEvent('sb:content-factory-open-draft',{detail:{companyCode:'beta',postId:42,source:'stats'}}));await f.settle();
    assert.equal(f.node('autoposting-editor').open,false);assert.ok(!f.calls.some(call=>call.path.endsWith('/posts/42')));
  }finally{f.close();}
});
test('CF13: открытие из «Исходников» — свежий GET карточки, а не квитанция прикрепления; чужая компания не открывается',async()=>{
  const edited=row(42,{status:'draft',title:'Правлено вручную после прикрепления',contentRevision:7});
  const f=await fixture({entries:[row(1),edited],listIds:[1]});try{
    f.w.dispatchEvent(new f.w.CustomEvent('sb:content-factory-open-draft',{detail:{companyCode:'alpha',postId:42,source:'sources'}}));await f.settle();
    assert.ok(f.calls.some(call=>call.method==='GET'&&call.path.endsWith('/posts/42')&&call.code==='alpha'),'карточка перечитана');
    assert.equal(f.node('autoposting-editor').open,true);assert.equal(f.node('autoposting-select').value,'42');
    assert.match(f.node('autoposting-status').textContent,/^Материал №42 открыт из «Исходников»\. Текущее состояние: .*, содержимое v7\.$/);
    assert.ok(f.calls.every(call=>call.method==='GET'),'открытие ничего не пишет');
  }finally{f.close();}
  const g=await fixture({entries:[row(1),row(42,{companyCode:'beta'})],beforeRender:w=>{w.SbCabinet.pendingMaterialOpen={companyCode:'beta',postId:42,source:'sources'};}});try{
    await g.settle();assert.equal(g.node('autoposting-editor').open,false);assert.ok(!g.calls.some(call=>call.path.endsWith('/posts/42')));
    assert.match(g.node('autoposting-status').textContent,/^Материал из «Исходников» не открыт: выбрана другая компания\.$/);
  }finally{g.close();}
});
test('CF6: история замечаний свёрнута, последняя доработка видна компактно; все группы и версии в списке; раскрытие не теряет несохранённую правку',async()=>{
  const groups=[{id:1,contentRevision:2,mediaUrls:['https://example.test/old.mp4'],annotations:[{category:'visual',comment:'Темно',timingKind:'whole'}],actorName:'Влад',createdAt:'2026-09-20T01:00:00Z'},
    {id:2,contentRevision:3,mediaUrls:['https://example.test/material.webp'],annotations:[{category:'music',comment:'Тише',timingKind:'whole'}],actorName:'Влад',createdAt:'2026-09-22T01:00:00Z'},
    {id:3,contentRevision:3,mediaUrls:['https://example.test/material.webp'],annotations:[{category:'text',comment:'Короче подпись <b>x</b>',timingKind:'whole'},{category:'other',comment:'Ещё',timingKind:'whole'}],actorName:'Дарья',createdAt:'2026-09-24T01:00:00Z'}];
  const f=await fixture({entries:[row(1,{reviewNotes:groups}),row(2)]});try{
    await f.click('[data-open-post="1"]');
    const details=f.d.querySelector('[data-review-history="1"]');assert.ok(details);assert.equal(details.open,false,'по умолчанию свёрнута');
    assert.equal(details.querySelector('summary').textContent,'Вся история замечаний: групп 3 · замечаний 4');
    assert.equal(details.querySelectorAll('.ap-note-group').length,3,'DTO не обрезан: все группы на месте');assert.match(details.textContent,/Версия содержимого v2 — прежняя версия/);
    const last=f.d.querySelector('[data-review-last]');assert.match(last.textContent,/^Последняя доработка: замечаний 2 · версия v3 \(текущая\) · Дарья · 24\.09\.2026, 09:00 — Текст: Короче подпись <b>x<\/b>$/);
    assert.equal(last.querySelector('b'),null,'текст экранирован');
    f.node('autoposting-text').value='Несохранённая правка';f.node('autoposting-text').dispatchEvent(new f.w.Event('input',{bubbles:true}));await f.settle();
    details.open=true;details.dispatchEvent(new f.w.Event('toggle'));await f.settle();
    assert.equal(f.node('autoposting-text').value,'Несохранённая правка','раскрытие не трогает ввод');
    f.node('autoposting-editor').open=false;await f.click('[data-open-post="2"]');f.node('autoposting-editor').open=false;await f.click('[data-open-post="1"]');
    assert.equal(f.node('autoposting-text').value,'Несохранённая правка','после переключения карточек правка на месте');
    assert.equal(f.d.querySelector('[data-review-history="1"]').open,true,'и история осталась раскрытой');
    assert.ok(f.calls.every(call=>call.method==='GET'),'раскрытие истории ничего не запрашивает и не пишет');
    assert.ok(!f.calls.some(call=>/history|notes/.test(call.path)),'отдельной серверной загрузки истории нет');
  }finally{f.close();}
});
