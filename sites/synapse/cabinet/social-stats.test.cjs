'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const tick=()=>new Promise(resolve=>setImmediate(resolve));const settle=async()=>{for(let i=0;i<8;i++)await tick();};
const platform=(label,over={})=>({label,configured:false,provider:null,enabled:false,access:{status:'not_configured',missing:['аккаунт площадки не настроен в кабинете']},dataStatus:'no_data',lastCollectedAt:null,lastRun:null,totals:{},latest:{},days:{},kinds:[],...over});
const overview=(code='demo-travel')=>({companyCode:code,from:'2026-09-01',to:'2026-09-18',timezone:'Asia/Bangkok',platforms:{
  instagram:platform('Instagram',{configured:true,provider:'direct',enabled:true,access:{status:'missing_access',missing:['Meta-приложение и App Review','решение владельца']},lastRun:{status:'missing_access',date:'2026-09-18',missing:['Meta-приложение и App Review'],error:''}}),
  tiktok:platform('TikTok'),youtube:platform('YouTube'),
  vk:platform('ВКонтакте',{configured:true,provider:'direct',enabled:true,dataStatus:'complete',lastCollectedAt:'2026-09-18T02:00:00.000Z',lastRun:{status:'ok',date:'2026-09-18',missing:[],error:''},totals:{views:40,reach:25},latest:{followers:{value:87,date:'2026-09-18'}},days:{'2026-09-17':{views:{value:40,kind:'organic'},reach:{value:25,kind:'organic'}}},kinds:['organic']}),
  telegram:platform('Telegram',{configured:true,provider:'direct',enabled:true,dataStatus:'partial',lastRun:{status:'partial',date:'2026-09-18',missing:['просмотры постов: Bot API их не отдаёт'],error:''},latest:{followers:{value:1234,date:'2026-09-18'}},totals:{},days:{},kinds:[]})},
  socialAggregate:{views:40,impressions:null,likes:null,comments:null,shares:null,saves:null,reach:null,reachNote:'Охват площадок не суммируется: уникальный охват — UNKNOWN.'},
  crm:{posts:[{platform:'instagram',platformPostId:'ig-1',url:'https://www.instagram.com/reel/abc/',contentId:'12',leads:2,sales:1,revenue:15000,confidence:'utm'}],bySource:[{source:'instagram',leads:3,sales:2,revenue:24000}],note:'Только по подтверждённой метке.'},
  runs:[{id:1,platform:'vk',provider:'direct',trigger:'schedule',date:'2026-09-18',started_at:'2026-09-18T02:00:00.000Z',finished_at:'2026-09-18T02:00:01.000Z',status:'ok',rows:7,error:'',missing:[]}]});
/* Записи выхода после проекции подтверждений (PR #350): только подтверждение, ручной ввод, собранный пост с подтверждением и спором
   карточек, запись без связи (UNKNOWN) и подтверждение с адресом, по которому переходить нельзя. */
const attributionOverview=()=>{const data=overview();data.crm={note:'Только по подтверждённой метке.',bySource:[],byContent:[],
  receipts:{projected:3,merged:1,receiptOnly:2,skipped:0,note:'Подтверждение — ссылка и время выхода, а не сбор по API.'},
  posts:[
    {platform:'telegram',platformPostId:'receipt:5',url:'https://t.me/demo/42',contentId:'',publishedAt:'2026-09-18T10:00:00.000Z',leads:0,sales:0,revenue:0,attribution:'none_in_period',confidence:'none',
      provenance:'external_receipt',provider:null,sources:0,identities:[],receipts:[{referenceId:'receipt:5',url:'https://t.me/demo/42',publishedAt:'2026-09-18T10:00:00.000Z',contentId:''}],contentIdCandidates:[]},
    {platform:'vk',platformPostId:'wall-1_10',url:'https://vk.com/wall-1_10',contentId:'77',publishedAt:'2026-09-18T08:00:00.000Z',leads:1,sales:1,revenue:3000,attribution:'exact',confidence:'url',
      provenance:'stored',provider:'manual',sources:1,identities:[{platformPostId:'wall-1_10',provider:'manual',contentId:'77'}],receipts:[],contentIdCandidates:[]},
    {platform:'youtube',platformPostId:'yt-1',url:'https://www.youtube.com/shorts/abc',contentId:'12',publishedAt:'2026-09-17T09:00:00.000Z',leads:0,sales:0,revenue:0,attribution:'none_in_period',confidence:'none',
      provenance:'stored_with_receipt',provider:'direct',sources:2,identities:[{platformPostId:'yt-1',provider:'direct',contentId:'12'},{platformPostId:'yt-1-manual',provider:'manual',contentId:'34'}],
      receipts:[{referenceId:'receipt:9',url:'https://www.youtube.com/shorts/abc',publishedAt:'2026-09-17T09:00:00.000Z',contentId:'34'}],contentIdCandidates:['12','34']},
    {platform:'instagram',platformPostId:'ig-9',url:'',contentId:'',publishedAt:null,leads:0,sales:0,revenue:0,attribution:'unknown',confidence:'none',
      provenance:'stored',provider:'onlypult',sources:1,identities:[{platformPostId:'ig-9',provider:'onlypult',contentId:''}],receipts:[],contentIdCandidates:[]},
    {platform:'tiktok',platformPostId:'receipt:11',url:'javascript:alert(1)',contentId:'',publishedAt:null,leads:0,sales:0,revenue:0,attribution:'none_in_period',confidence:'none',
      provenance:'external_receipt',provider:null,sources:0,identities:[],receipts:[{referenceId:'receipt:11',url:'javascript:alert(1)',publishedAt:null,contentId:''}],contentIdCandidates:[]},
  ]};return data;};
function fixture({role='owner',permissions=[],override}={}) {
  const dom=new JSDOM('<section id="view"></section>',{url:'https://cabinet.example.test/',runScripts:'outside-only'}),w=dom.window,d=w.document,views={},calls=[];
  w.SbCabinet={registerView:(name,view)=>{views[name]=view;}};w.eval(fs.readFileSync(__dirname+'/social-stats.js','utf8'));
  const ctx={selectedProjectId:'demo-travel',identity:{role,permissions,companies:[{id:'demo-travel',name:'Демо-проект'}]},csrfOptions:(method,body)=>({method,headers:{'X-CSRF-Token':'t'},body:JSON.stringify(body)}),
    apiJson:async(url,options={})=>{const u=new URL(url,'https://cabinet.example.test/');const call={path:u.pathname,code:u.searchParams.get('companyCode'),method:options.method||'GET',body:options.body?JSON.parse(options.body):null};calls.push(call);
      if(override){const r=await override(call);if(r!==undefined)return r;}
      if(call.path==='/content/crm/social-stats')return overview(call.code);
      if(call.path==='/content/crm/social-stats/baseline')return {companyCode:call.code,latest:null,versions:[]};
      if(call.path==='/content/crm/social-stats/accounts')return {companyCode:call.code,accounts:['instagram','tiktok','youtube','vk','telegram'].map(p=>({platform:p,label:p,accountRef:'',provider:'manual',enabled:false,kind:'organic',collectHour:6,revision:0,access:{status:'not_configured',missing:[]}}))};
      if(call.path==='/content/crm/social-stats/collect')return {status:'missing_access',missing:['x']};
      if(call.path==='/content/crm/social-stats/import')return {ok:true,rows:call.body.rows.length};
      throw new Error('unexpected '+call.path);}};
  return {w,d,ctx,calls,views,container:d.getElementById('view'),render:async()=>{views['social-stats'].render(d.getElementById('view'),ctx);await settle();},close:()=>w.close()};
}
test('сводка: UNKNOWN показывается прочерком, не нулём; уникальный охват не суммируется; статусы доступа и список недостающего честные; атрибуция по UTM',async()=>{
  const f=fixture();try{
    await f.render();const text=f.container.textContent;
    assert.match(text,/Уникальный охват—|Уникальный охват\s*—/);assert.match(text,/не суммируется/);
    const ig=f.container.querySelector('[data-platform="instagram"]');assert.match(ig.textContent,/нет доступа/);assert.match(ig.textContent,/Meta-приложение/);assert.doesNotMatch(ig.textContent,/\b0\b/);
    {const tg=f.container.querySelector('[data-platform="telegram"]').textContent;assert.match(tg,/собрано частично/);assert.match(tg,/Подписчики/);assert.match(tg,/1\s?234/);}
    assert.match(f.container.querySelector('[data-platform="tiktok"]').textContent,/не настроен/);
    assert.match(f.container.querySelector('.social-crm').textContent,/UTM-метка/);assert.match(f.container.querySelector('.social-crm').textContent.replace(/\u00a0/g,' '),/15 000/);
    assert.doesNotMatch(f.container.innerHTML,/token|Bearer/i);
    assert.ok(f.container.querySelector('#social-accounts-form'),'владелец видит настройки');
    assert.ok(f.calls.every(c=>c.code==='demo-travel'));
  }finally{f.close();}
});
test('исходная точка показывает отсутствие данных честно и фиксируется только после подтверждения даты',async()=>{
  const f=fixture({override:async call=>{
    if(call.path==='/content/crm/social-stats/baseline'&&call.method==='GET')return {companyCode:call.code,
      latest:{version:1,from:'2026-09-01',to:'2026-09-18',cutoverDate:'2026-09-19',createdAt:'2026-09-19T00:00:00Z',sourceNote:'первый пост',
        snapshot:{status:'no_data',coverageNote:'Статистика не подключена',platforms:{},postsRecorded:0,posts:[]}},versions:[]};
    if(call.path==='/content/crm/social-stats/baseline'&&call.method==='POST')return {companyCode:call.code};
  }});
  try{
    await f.render();
    const baseline=f.container.querySelector('#social-baseline-content');
    assert.match(baseline.textContent,/Показателей за период нет/);
    assert.match(baseline.textContent,/Статистика не подключена/);
    assert.match(baseline.textContent,/Исторические публикации не записаны/);
    const form=f.container.querySelector('#social-baseline-form');
    form.elements.from.value='2026-09-01';form.elements.to.value='2026-09-18';form.elements.cutoverDate.value='2026-09-19';
    form.elements.sourceNote.value='ссылка на первый пост';form.elements.confirmedStart.checked=true;
    form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await settle();
    const write=f.calls.find(c=>c.path==='/content/crm/social-stats/baseline'&&c.method==='POST');
    assert.equal(write.body.confirmedStart,true);assert.equal(write.body.to,'2026-09-18');
    assert.equal(write.code,'demo-travel');
  }finally{f.close();}
});

test('что видим до старта: выводы, источник и пробелы рядом, подтверждения не прибавлены к публикациям',async()=>{
  const f=fixture({override:async call=>{
    if(call.path!=='/content/crm/social-stats/baseline')return;
    return {companyCode:call.code,versions:[],latest:{version:2,from:'2026-09-16',to:'2026-09-18',
      cutoverDate:'2026-09-19',createdAt:'2026-09-19T00:00:00Z',sourceNote:'синтетическая дата',
      snapshot:{platforms:{vk:{totals:{reach:20},aggregation:{reach:'sum'}}},posts:[],receipts:[]},
      assessment:{version:1,basis:'frozen_snapshot',periodDays:3,
        platforms:[{platform:'vk',datesWithMetrics:2,periodDays:3,dateEvidence:'dated_metrics',missingDates:1,
          metrics:['views','followers'],hasPointValues:true,sources:[{provider:'manual',capturedAt:'2026-09-18T12:00:00Z',
            note:'архив <img src=x onerror=alert(1)>'}]}],unconfiguredPlatforms:['tiktok'],
        publications:{recorded:1,detailed:1,withMetrics:1,receiptsRecorded:1,truncated:false,
          sources:[{provider:'manual',note:'архив публикаций'}]},
        limitations:['Подтверждения не прибавляются к числу записей.','Уникальный охват не суммируется. По просмотрам нельзя сделать вывод о продажах.'],
        actions:['До запуска добавьте выгрузку за недостающую дату.','Сохраните тексты для оценки содержания.']}}};
  }});
  try{
    await f.render();const section=f.container.querySelector('.social-baseline-assessment');
    assert.equal(section.getAttribute('aria-label'),'Что видим до старта');
    assert.match(section.textContent,/сохранённой версии 2/);
    assert.match(section.textContent,/Дат хотя бы с одним показателем: 2 из 3/);
    assert.match(section.textContent,/не хватает дат с показателями: 1/);
    assert.match(section.textContent,/Значение на отдельную дату не заменяет дневную историю/);
    const metricRow=section.querySelector('.social-baseline-findings > li');
    assert.match(metricRow.textContent,/Источник:.*Ручной ввод/s);
    assert.match(metricRow.textContent,/архив <img/);
    assert.match(metricRow.textContent,/Для сравнения:/);
    assert.equal(section.querySelector('img'),null);
    assert.match(section.textContent,/Записей о публикациях: 1/);
    assert.match(section.textContent,/Подтверждения владельца: 1; к числу записей их не прибавляем/);
    assert.match(section.textContent,/Тексты в снимке не сохранены, качество содержания не оценено/);
    assert.match(section.textContent,/Что сделать до запуска/);
    assert.doesNotMatch(section.textContent,/балл|готовность|Записей о публикациях: 2/);
    assert.match(f.container.querySelector('.social-baseline-grid').textContent,/не уникальные люди за период/);
    assert.ok(f.calls.every(call=>call.method==='GET'),'разбор сам ничего не собирает и не записывает');
  }finally{f.close();}
});

test('ранний снимок и неизвестные числа не превращаются в нули или оценку качества',async()=>{
  const f=fixture({override:async call=>{
    if(call.path!=='/content/crm/social-stats/baseline')return;
    return {companyCode:call.code,versions:[],latest:{version:1,from:'2026-09-16',to:'2026-09-18',snapshot:{},
      assessment:{basis:'frozen_snapshot',platforms:[{platform:'vk',datesWithMetrics:null,periodDays:3,missingDates:null,
        dateEvidence:'none',metrics:[],sources:[]}],publications:{recorded:null,detailed:null,withMetrics:null,
          receiptsRecorded:null,sources:[]},limitations:[],actions:[]}}};
  }});
  try{
    await f.render();const section=f.container.querySelector('.social-baseline-assessment');
    assert.match(section.textContent,/Число дат с показателями неизвестно/);
    assert.match(section.textContent,/Записей о публикациях: —/);
    assert.match(section.textContent,/Подтверждения владельца: —/);
    assert.match(section.textContent,/Источник:.*в снимке не указан/s);
    assert.doesNotMatch(section.textContent,/публикациях: 0|просмотры: 0|все данные|всё готово/);
  }finally{f.close();}
  const old=fixture({override:async call=>call.path==='/content/crm/social-stats/baseline'?
    {companyCode:call.code,versions:[],latest:{version:1,snapshot:{}}}:undefined});
  try{
    await old.render();assert.match(old.container.querySelector('.social-baseline-assessment').textContent,
      /разбор этой версии ещё не получен/);
  }finally{old.close();}
});

test('выводы ДО занимают одну колонку на телефоне и не создают узкую таблицу',()=>{
  const css=fs.readFileSync(__dirname+'/social-stats.css','utf8');
  assert.match(css,/\.social-baseline-findings \{ display:grid; grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css,/\.social-baseline-assessment \{[^}]*min-width:0;[^}]*overflow-wrap:anywhere;/);
  assert.match(css,/@media \(max-width:430px\) \{\s*\.social-baseline-assessment \{ padding:12px; \}/);
});

test('замер «ДО» разделяет измерения площадки, исторические посты и подтверждения владельца',async()=>{
  const f=fixture({override:async call=>{
    if(call.path!=='/content/crm/social-stats/baseline')return;
    return {companyCode:call.code,latest:{version:2,from:'2026-09-01',to:'2026-09-18',cutoverDate:'2026-09-19',
      createdAt:'2026-09-19T00:00:00Z',sourceNote:'первый пост',snapshot:{status:'partial',
        coverageNote:'Доступны только записанные сведения',platforms:{instagram:{accountConfigured:true,accountRef:'travel',
          coverage:'partial',recordedDays:1,periodDays:18,totals:{views:120},
          sources:[{provider:'manual',capturedAt:'2026-09-18T10:00:00Z',note:'экспорт Insights'}],
          measurements:[{metric:'views',value:120,date:'2026-09-17',provider:'manual',capturedAt:'2026-09-18T10:00:00Z',completeness:'partial'}]}},
        postsRecorded:3,postsTruncated:true,posts:[
          {platform:'instagram',url:'https://www.instagram.com/reel/demo/',publishedAt:'2026-09-12T08:00:00Z',
            source:{provider:'direct',capturedAt:'2026-09-18T10:00:00Z'},metrics:[
              {metric:'views',value:125,date:'2026-09-18',provider:'direct',capturedAt:'2026-09-18T10:00:00Z'},
              {metric:'likes',value:0,date:'2026-09-18',provider:'direct',capturedAt:'2026-09-18T10:00:00Z'}]},
          {platform:'tiktok',url:'',publishedAt:'2026-09-10T08:00:00Z',source:{provider:'manual',note:'<script>bad</script>'},metrics:[]}],
        receiptsRecorded:1,receipts:[{platform:'telegram',url:'javascript:alert(1)',publishedAt:'2026-09-11T08:00:00Z',
          source:{type:'owner_confirmation',capturedAt:'2026-09-12T08:00:00Z',note:'ссылка от владельца'},metrics:null}]}}
      ,versions:[{version:2,from:'2026-09-01',to:'2026-09-18',createdAt:'2026-09-19T00:00:00Z'},
        {version:1,from:'2026-08-01',to:'2026-08-31',createdAt:'2026-09-01T00:00:00Z'}]};
  }});
  try{
    await f.render();
    const baseline=f.container.querySelector('#social-baseline-content');
    const instagram=baseline.querySelector('.social-baseline-platform');
    assert.match(instagram.textContent,/Часть дней без записанных показателей/);
    assert.match(instagram.textContent,/Дней хотя бы с одним показателем: 1 из 18/);
    assert.match(instagram.textContent,/Ручной ввод, не сбор по API/);
    assert.match(instagram.textContent,/экспорт Insights/);
    assert.match(instagram.textContent,/частичные данные/);
    const sections=[...baseline.querySelectorAll('.social-baseline-history')];
    assert.equal(sections.length,2);
    assert.match(sections[0].querySelector('summary').textContent,/Исторические публикации: записано 3/);
    assert.match(sections[0].textContent,/Просмотры:\s*125/);
    assert.match(sections[0].textContent,/Реакции:\s*0/,'известный ноль сохранён');
    assert.match(sections[0].textContent,/Показатели этой публикации не записаны/);
    assert.match(sections[0].textContent,/Показано 2 из 3 записанных публикаций/);
    assert.match(sections[1].querySelector('summary').textContent,/Подтверждения владельца: записано 1/);
    assert.match(sections[1].textContent,/не является статистикой площадки/);
    assert.doesNotMatch(sections[1].textContent,/125/,'показатели собранного поста не приписаны подтверждению');
    assert.equal(sections[1].querySelector('a'),null,'небезопасная ссылка подтверждения не открывается');
    assert.equal(baseline.querySelector('script'),null,'заметка источника экранирована');
    assert.doesNotMatch(baseline.innerHTML,/href="javascript:/);
    assert.match(baseline.textContent,/История исходной точки: 2 версий/);
    const css=fs.readFileSync(__dirname+'/social-stats.css','utf8');
    assert.match(css,/@media \(max-width:430px\)[\s\S]*\.social-baseline-grid[^\n]*grid-template-columns:1fr/);
  }finally{f.close();}
});
test('вводный текст не называет чужую компанию; подтверждение ведёт на публикацию, ручной ввод не выдаётся за API, спор карточек и UNKNOWN показаны честно',async()=>{
  const f=fixture({override:async call=>{if(call.path==='/content/crm/social-stats')return attributionOverview();}});try{
    await f.render();
    assert.doesNotMatch(f.container.textContent,/ТайСабай/,'вводный текст нейтрален к выбранной компании');
    assert.match(f.container.querySelector('.content-header').textContent,/выбранной компании/);
    const rows=[...f.container.querySelectorAll('.social-posts tbody tr')];assert.equal(rows.length,5);
    for(const td of f.container.querySelectorAll('.social-posts td')) assert.ok(td.getAttribute('data-label'),'у каждой ячейки осталась подпись для узкого экрана');
    const crmText=f.container.querySelector('.social-crm').textContent;
    assert.match(crmText,/зафиксированные в CRM обращения/);assert.match(crmText,/не что в соцсетях не обращались/);
    assert.match(crmText,/не подключает сбор просмотров|сбор просмотров им не подключается/);
    assert.match(crmText,/Подтверждений прочитано: 3/);

    const receipt=rows[0],receiptCell=receipt.querySelector('[data-label="Публикация"]'),receiptLink=receiptCell.querySelector('a');
    assert.equal(receiptLink.textContent,'Открыть публикацию');assert.equal(receiptLink.getAttribute('href'),'https://t.me/demo/42');
    assert.equal(receiptLink.getAttribute('rel'),'noopener noreferrer');
    {const visible=receiptCell.cloneNode(true);visible.querySelectorAll('details').forEach(d=>d.remove());assert.doesNotMatch(visible.textContent,/receipt:/,'внутренний идентификатор не в основном потоке');}
    assert.match(receiptCell.querySelector('.social-ids').textContent,/receipt:5/,'служебная ссылка спрятана в подробностях');
    assert.match(receipt.querySelector('[data-label="Как записано"]').textContent,/Подтверждено вручную/);
    assert.doesNotMatch(receipt.querySelector('[data-label="Как записано"]').textContent,/API/);

    const manual=rows[1].querySelector('[data-label="Как записано"]').textContent;
    assert.match(manual,/Ручной ввод/);assert.doesNotMatch(manual,/Прямой API/);assert.match(manual,/не сбор по API/);

    const merged=rows[2];assert.match(merged.querySelector('[data-label="Как записано"]').textContent,/Прямой API площадки/);
    assert.match(merged.querySelector('[data-label="Как записано"]').textContent,/Подтверждено вручную/);
    const material=merged.querySelector('[data-label="Материал"]');
    assert.match(material.querySelector('.social-conflict').textContent,/Спорная связь с материалом/);
    assert.match(material.textContent,/не приписывается ни одному материалу/);
    assert.match(material.querySelector('details').textContent,/12/);assert.match(material.querySelector('details').textContent,/34/);
    assert.match(merged.querySelector('.social-ids').textContent,/yt-1-manual/);

    const unknown=rows[3];
    for(const label of ['Обращения','Продажи','Выручка']) assert.equal(unknown.querySelector(`[data-label="${label}"]`).textContent,'—',`${label}: UNKNOWN показан прочерком, не нулём`);
    assert.equal(rows[1].querySelector('[data-label="Обращения"]').textContent,'1','известное число сохранено');

    const unsafe=rows[4].querySelector('[data-label="Публикация"]');
    assert.equal(unsafe.querySelector('a'),null,'небезопасный адрес ссылкой не становится');
    assert.doesNotMatch(f.container.innerHTML,/javascript:/i);
    assert.match(unsafe.textContent,/непригодна для перехода/);
    assert.ok(f.calls.every(c=>c.code==='demo-travel'&&c.method==='GET'));
  }finally{f.close();}
});
test('аналитик читает, но не видит настроек и импорта; поздний ответ другой компании не рисуется; ключ в поле аккаунта отклоняется у владельца',async()=>{
  const viewer=fixture({role:'marketer',permissions:['analytics.view']});try{await viewer.render();assert.equal(viewer.container.querySelector('#social-accounts-form'),null);assert.equal(viewer.container.querySelector('#social-import-form'),null);assert.ok(viewer.calls.every(c=>c.method==='GET'));}finally{viewer.close();}
  const none=fixture({role:'marketer',permissions:[]});try{await none.render();assert.equal(none.container.children.length,0);assert.equal(none.calls.length,0);}finally{none.close();}
  let release;const gate=new Promise(r=>{release=r;});let first=true;
  const f=fixture({override:async call=>{if(call.path==='/content/crm/social-stats'&&first){first=false;await gate;return overview('demo-travel');}}});
  try{
    f.views['social-stats'].render(f.container,f.ctx);await settle();
    f.ctx.selectedProjectId='alvi';release();await settle();
    assert.equal(f.container.querySelector('.social-grid'),null,'ответ прежней компании не отрисован');
    f.ctx.selectedProjectId='demo-travel';await f.render();
    const form=f.container.querySelector('#social-accounts-form');form.elements['vk.accountRef'].value='token=abc';form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await settle();
    assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);assert.match(f.container.querySelector('#social-accounts-state').textContent,/Ключи сюда вводить нельзя/);
    form.elements['vk.accountRef'].value='club240466302';form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));await settle();
    const put=f.calls.find(c=>c.method==='PUT');assert.equal(put.body.accounts.find(a=>a.platform==='vk').accountRef,'club240466302');assert.equal(put.body.accounts[0].timezone,'Asia/Bangkok');
  }finally{f.close();}
});
