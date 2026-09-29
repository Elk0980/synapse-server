'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {JSDOM}=require('jsdom');
const clone=value=>JSON.parse(JSON.stringify(value)),tick=()=>new Promise(resolve=>setImmediate(resolve));
const org=code=>code==='alvi'?'70000001061502047':'70000000000000002';
const settings=code=>({revision:1,configured:true,organizationId:org(code),organizationName:code+' в 2ГИС',city:'Иркутск',cabinetUrl:'https://account.2gis.com/orgs/'+org(code)+'/statistics/'});
const input=(code='alvi',kind='rubric_demand')=>({organizationId:org(code),organizationName:code+' в 2ГИС',city:'Иркутск',sourceUrl:'https://account.2gis.com/orgs/'+org(code)+'/statistics/',reportKind:kind,periodStart:'2026-09-01',periodEnd:'2026-09-16',granularity:'month',capturedAt:'2026-09-17T10:00:00Z',originalFilename:'report.xls',rows:[
  {periodStart:'2026-09-01',periodEnd:'2026-09-16',category:'Массаж',metric:kind==='rubric_demand'?'searches':'share_percent',value:kind==='rubric_demand'?150:12.5,partial:true},
  ...(kind==='rubric_demand'?[{periodStart:'2026-09-01',periodEnd:'2026-09-16',category:'Все рубрики',metric:'searches',value:900,partial:true}]:[])
]});
const snapshot=(code='alvi',kind='rubric_demand')=>({id:code+'-'+kind,...input(code,kind),importedAt:'2026-09-17T11:00:00Z'});
const record=code=>({company:{code,name:code==='alvi'?'АЛВИ':'Авокадо'},settings:settings(code),categories:{revision:1,items:[]},datasets:[snapshot(code)],history:[snapshot(code)],summary:{available:true,periods:[]}});
function fixture({role='owner',permissions=[],override,empty=false}={}) {
  const dom=new JSDOM('<section id="view"></section>',{url:'https://cabinet.example.test/',runScripts:'outside-only'}),w=dom.window,d=w.document,views={},calls=[];
  w.SbCabinet={registerView:(name,view)=>{views[name]=view;}};
  for(const file of ['platform-links.js','platform-demand.js'])w.eval(fs.readFileSync(__dirname+'/'+file,'utf8'));
  const data={alvi:record('alvi'),avokado:record('avokado')};if(empty){data.alvi.datasets=[];data.alvi.history=[];}
  const ctx={selectedProjectId:'alvi',identity:{role,permissions,companies:[{id:'alvi',name:'АЛВИ'},{id:'avokado',name:'Авокадо'}]},csrfOptions:(method,body)=>({method,headers:{'X-CSRF-Token':'test-csrf'},body:JSON.stringify(body)}),
    apiJson:async(url,options={})=>{
      const u=new URL(url,'https://cabinet.example.test/'),code=u.searchParams.get('companyCode'),call={path:u.pathname,code,method:options.method||'GET',body:options.body?JSON.parse(options.body):null,options,search:u.searchParams};calls.push(call);
      if(override){const result=await override(call);if(result!==undefined)return clone(result);}
      if(call.path.endsWith('/settings')){assert.equal(call.body.revision,data[code].settings.revision);data[code].settings={...call.body,configured:true,revision:call.body.revision+1};return {settings:clone(data[code].settings)};}
      if(call.path.endsWith('/categories')){assert.equal(call.body.revision,data[code].categories.revision);data[code].categories={revision:call.body.revision+1,items:call.body.items};return {categories:clone(data[code].categories)};}
      if(call.path.endsWith('/import')){const item={id:code+'-imported',...call.body,importedAt:'2026-09-17T11:30:00Z'};data[code].datasets=[item];data[code].history.unshift(item);return {dataset:clone(item),duplicate:false};}
      if(call.path.includes('/datasets/'))return {dataset:clone(data[code].history.find(item=>String(item.id)===decodeURIComponent(call.path.split('/').at(-1))))};
      assert.equal(call.path,'/content/crm/platform-demand');return clone(data[code]);
    }};
  const f={w,d,ctx,data,calls,views,container:d.getElementById('view'),node:id=>d.getElementById('demand-'+id),settle:async()=>{for(let i=0;i<7;i++)await tick();},set(id,value,event='input'){const node=f.node(id);node.value=value;node.dispatchEvent(new w.Event(event,{bubbles:true}));},submit(id){f.node(id).dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));},async render(){await views['platform-demand'].render(f.container,ctx);},close:()=>w.close()};return f;
}
function preview(f,value=input()){f.set('json',JSON.stringify(value));f.submit('import-form');}
function confirm(f){f.node('confirm').checked=true;f.node('confirm').dispatchEvent(new f.w.Event('change',{bubbles:true}));}

test('view permissions cause no unscoped calls; analytics viewers only read and cannot submit mutations',async()=>{
  for(const permissions of [[],['analytics.view']]){const f=fixture({role:'marketer',permissions});try{
    await f.render();assert.equal(f.calls.length,permissions.length?1:0);
    if(permissions.length){assert.match(f.container.textContent,/Потенциал 2ГИС/);assert.equal(f.node('json').disabled,true);f.submit('settings-form');f.submit('category-form');f.submit('import-form');await f.settle();assert.ok(f.calls.every(c=>c.method==='GET'));}
  }finally{f.close();}}
});

test('empty saved reports are distinct from zero demand and request failure',async()=>{
  const f=fixture({empty:true});try{await f.render();assert.match(f.node('report').textContent,/Пустой список не означает нулевой спрос/);assert.ok(f.container.querySelector('a[href="#analytics-through"]'));assert.match(f.container.textContent,/выберите такой же период/);}finally{f.close();}
  const failed=fixture({override:()=>{throw Error('secret raw backend details');}});try{await failed.render();assert.match(failed.node('status').textContent,/Не удалось/);assert.doesNotMatch(failed.container.textContent,/secret raw/);assert.doesNotMatch(failed.node('report').textContent,/Пустой список/);}finally{failed.close();}
});

test('counts, percentages and partial periods have distinct table cells; aggregate is not a category choice',async()=>{
  const f=fixture();try{f.data.alvi.datasets=[snapshot('alvi','search_share')];f.data.alvi.history=f.data.alvi.datasets;await f.render();
    const cells=f.node('report').querySelector('tbody tr').cells;assert.equal(cells[2].textContent,'—');assert.match(cells[3].textContent,/12,5 %/);assert.match(cells[1].textContent,/Неполный период/);assert.match(f.node('report').textContent,/проценты разных строк не складываются/);
    assert.match(f.node('report').textContent,/Получен из 2ГИС/);assert.match(f.node('report').textContent,/Сохранён в ЛК/);
  }finally{f.close();}
  const count=fixture();try{await count.render();assert.equal([...count.node('category').options].some(o=>o.value==='Все рубрики'),false);assert.equal(count.node('report').querySelector('tbody tr').cells[2].textContent,'150');assert.equal(count.node('report').querySelector('tbody tr').cells[3].textContent,'—');}finally{count.close();}
});

test('JSON preview performs no mutation; unchecked confirmation blocks import; explicit save is scoped with CSRF',async()=>{
  const f=fixture();try{await f.render();preview(f);assert.equal(f.node('preview').hidden,false);assert.match(f.node('preview').textContent,/Будет сохранено в компанию: АЛВИ/);assert.equal(f.calls.length,1);assert.equal(f.node('import-save').disabled,true);
    f.node('import-save').click();assert.equal(f.calls.length,1);confirm(f);assert.equal(f.node('import-save').disabled,false);f.node('import-save').click();await f.settle();
    const write=f.calls.find(c=>c.method==='POST');assert.equal(write.code,'alvi');assert.equal(write.path,'/content/crm/platform-demand/import');assert.equal(write.body.organizationId,'70000001061502047');assert.equal(write.options.headers['X-CSRF-Token'],'test-csrf');assert.equal(write.body.rows[0].value,150);assert.match(f.node('status').textContent,/Отчёт сохранён/);assert.equal(f.node('preview').hidden,true);assert.equal(f.node('confirm').checked,false);
  }finally{f.close();}
});

test('editing report or settings invalidates the preview and its confirmation',async()=>{
  const f=fixture();try{await f.render();preview(f);confirm(f);f.set('json',JSON.stringify(input())+' ');assert.equal(f.node('import-save').disabled,true);assert.equal(f.node('preview').hidden,true);
    preview(f);confirm(f);const field=f.node('settings-form').elements.city;field.value='Другой город';field.dispatchEvent(new f.w.Event('input',{bubbles:true}));assert.equal(f.node('preview').hidden,true);assert.equal(f.node('confirm').checked,false);assert.ok(f.calls.every(c=>c.method==='GET'));
  }finally{f.close();}
});

test('mismatched company organization, unsafe source, mixed units, invalid dates and malformed JSON cannot reach POST',async()=>{
  const f=fixture();try{await f.render();const invalid=[];
    invalid.push(input('avokado'));for(const edit of [v=>{v.sourceUrl+='?access_token=sentinel';},v=>{v.rows[0].metric='share_percent';},v=>{v.rows[0].periodEnd='2026-10-01';},v=>{v.periodStart='2026-02-30';},v=>{v.rows[0].value='150';},v=>{v.rows[0].value=-1;},v=>{v.rows[0].value=1.5;},v=>{v.extra='not allowed';}]){const value=input();edit(value);invalid.push(value);}
    const percent=input('alvi','search_share');percent.rows[0].value=101;invalid.push(percent);
    for(const value of invalid){preview(f,value);assert.equal(f.node('preview').hidden,true);assert.equal(f.node('import-save').disabled,true);}
    f.set('json','{broken');f.submit('import-form');assert.match(f.node('status').textContent,/Не удалось прочитать JSON/);assert.ok(f.calls.every(c=>c.method==='GET'));assert.doesNotMatch(f.node('status').textContent,/sentinel/);
  }finally{f.close();}
});

test('classification and reason are saved explicitly with category revision and displayed as escaped text',async()=>{
  const f=fixture({role:'marketer',permissions:['analytics.view','crm.edit']});try{await f.render();f.set('category','Массаж','change');f.set('classification','target','change');f.set('reason','<img src=x onerror=bad()>');assert.equal(f.calls.length,1);f.submit('category-form');await f.settle();
    const write=f.calls.find(c=>c.path.endsWith('/categories'));assert.equal(write.method,'PUT');assert.equal(write.code,'alvi');assert.deepEqual(write.body,{revision:1,items:[{category:'Массаж',classification:'target',reason:'<img src=x onerror=bad()>'}]});
    assert.match(f.node('report').textContent,/Целевая/);assert.match(f.node('report').textContent,/<img src=x onerror=bad\(\)>/);assert.equal(f.container.querySelector('img'),null);
  }finally{f.close();}
});

test('organization settings keep long ID as a string and reject a URL for another organization',async()=>{
  const f=fixture();try{await f.render();const form=f.node('settings-form');form.elements.cabinetUrl.value='https://account.2gis.com/orgs/42/';f.submit('settings-form');await f.settle();assert.equal(f.calls.length,1);
    form.elements.cabinetUrl.value=settings('alvi').cabinetUrl;f.submit('settings-form');await f.settle();const write=f.calls.find(c=>c.path.endsWith('/settings'));assert.equal(write.body.organizationId,'70000001061502047');assert.equal(typeof write.body.organizationId,'string');assert.equal(write.body.revision,1);assert.match(f.node('status').textContent,/Организация сохранена/);
  }finally{f.close();}
});

test('company switch clears pasted data, source links and rows immediately and ignores a late old response',async()=>{
  let release;const f=fixture({override:call=>call.code==='avokado'?new Promise(resolve=>{release=resolve;}):undefined});try{await f.render();preview(f);confirm(f);
    const next=f.views['platform-demand'].onProjectChange({...f.ctx,selectedProjectId:'avokado'});await f.settle();assert.equal(f.node('json').value,'');assert.equal(f.node('preview').hidden,true);assert.equal(f.node('report').textContent,'');assert.equal(f.node('source-links').children.length,0);
    await f.views['platform-demand'].onProjectChange(f.ctx);release(record('avokado'));await next;assert.match(f.node('report').textContent,/alvi в 2ГИС/);assert.doesNotMatch(f.node('report').textContent,/avokado/);
  }finally{f.close();}
});

test('late import response cannot populate another company or cause a follow-up request in its scope',async()=>{
  let release;const f=fixture({override:call=>call.path.endsWith('/import')?new Promise(resolve=>{release=resolve;}):undefined});try{await f.render();preview(f);confirm(f);f.node('import-save').click();await f.settle();
    await f.views['platform-demand'].onProjectChange({...f.ctx,selectedProjectId:'avokado'});const before=f.calls.length;release({dataset:snapshot('alvi'),duplicate:false});await f.settle();assert.equal(f.calls.length,before);assert.match(f.node('report').textContent,/avokado в 2ГИС/);assert.doesNotMatch(f.node('report').textContent,/alvi/);assert.equal(f.node('preview').hidden,true);
  }finally{f.close();}
});

test('history selection reads exact dataset and refuses a different organization returned by the server',async()=>{
  const f=fixture({override:call=>call.path.includes('/datasets/')?{dataset:snapshot('avokado')}:undefined});try{const older={...snapshot('alvi'),id:'old-snapshot',capturedAt:'2026-09-16T10:00:00Z'};f.data.alvi.history.push(older);await f.render();f.set('dataset','old-snapshot','change');await f.settle();
    const call=f.calls.find(c=>c.path.endsWith('/datasets/old-snapshot'));assert.equal(call.code,'alvi');assert.equal(call.method,'GET');assert.doesNotMatch(f.node('report').textContent,/avokado/);assert.match(f.node('status').textContent,/Не удалось/);
  }finally{f.close();}
});

test('losing analytics access clears the section and prevents a pending response from reviving it',async()=>{
  let release;const f=fixture({role:'marketer',permissions:['analytics.view','crm.edit'],override:()=>new Promise(resolve=>{release=resolve;})});try{const pending=f.render();await f.settle();f.views['platform-demand'].render(f.container,{...f.ctx,identity:{...f.ctx.identity,permissions:[]}});release(record('alvi'));await pending;assert.equal(f.container.children.length,0);assert.equal(f.calls.length,1);
  }finally{f.close();}
});

test('the reviewed UI import is accepted by the actual backend in memory; aggregate flags are derived and duplicate is honest',async()=>{
  const {DatabaseSync}=require('node:sqlite');
  const {createPlatformDemand}=require('../../../ops/crm/platform-demand');
  const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE companies(code TEXT PRIMARY KEY,name TEXT,is_deleted INTEGER DEFAULT 0); INSERT INTO companies VALUES('alvi','АЛВИ',0),('avokado','Авокадо',0)");
  const backend=createPlatformDemand(db,{now:()=>Date.parse('2026-09-18T12:00:00Z')});
  const {configured,...configuration}=settings('alvi');backend.saveSettings('alvi',{...configuration,revision:0});
  const f=fixture({override:call=>{
    if(call.path.endsWith('/import'))return backend.importDataset(call.code,call.body);
    if(call.path.endsWith('/categories'))return backend.saveCategories(call.code,call.body);
    if(call.path.endsWith('/settings'))return backend.saveSettings(call.code,call.body);
    if(call.path.includes('/datasets/'))return backend.getDataset(call.code,call.path.split('/').at(-1));
    return backend.get(call.code);
  }});
  try{await f.render();const report=input();report.sourceUrl+='?period=custom&dateFrom=2026-09-01&dateTo=2026-09-16';
    preview(f,report);assert.equal(f.node('preview').hidden,false);assert.match(f.node('preview').textContent,/Итог площадки/);confirm(f);f.node('import-save').click();await f.settle();
    assert.match(f.node('status').textContent,/Отчёт сохранён/);assert.equal(backend.get('alvi').datasets.length,1);assert.equal(backend.get('avokado').datasets.length,0);
    assert.ok(backend.get('alvi').datasets[0].rows.find(row=>row.category==='Все рубрики').isAggregate);
    preview(f,report);confirm(f);f.node('import-save').click();await f.settle();assert.match(f.node('status').textContent,/уже сохранён/);assert.equal(backend.get('alvi').historyTotal,1);
    const wrong=clone(report);wrong.rows[0].isAggregate=true;preview(f,wrong);assert.equal(f.node('preview').hidden,true);
  }finally{f.close();db.close();}
});

test('search-share phrases are never offered as rubrics: only server categories and rubric_demand rows fill the classification select',async()=>{
  const f=fixture();try{
    const share={...snapshot('alvi','search_share'),id:'alvi-share',rows:[
      {periodStart:'2026-09-01',periodEnd:'2026-09-16',category:'авокадо',metric:'share_percent',value:29.3,partial:true},
      {periodStart:'2026-09-01',periodEnd:'2026-09-16',category:'прочее',metric:'share_percent',value:24.1,partial:true}]};
    f.data.alvi.history.push(share);f.data.alvi.categories.items=[{category:'Эпиляция',classification:'unclassified',reason:''}];
    await f.render();
    const options=()=>[...f.node('category').options].filter(option=>option.value).map(option=>option.textContent);
    assert.deepEqual(options(),['Эпиляция','Массаж'],'rubric snapshot: server rubrics plus quantitative rows');
    f.set('dataset','alvi-share','change');await f.settle();
    assert.deepEqual(options(),['Эпиляция'],'share snapshot adds no phrases');
    assert.doesNotMatch(f.node('category').innerHTML,/авокадо|прочее/);
  }finally{f.close();}
});

/* Фактические показатели компании 2ГИС. Компании, организации, филиалы и числа
   в этих проверках синтетические: реальная выгрузка ALVI в тесты не попадает. */
const M_ORG='70000000000000101',M_BRANCH='70000000000000102';
const mDay=index=>`2026-09-${String(index).padStart(2,'0')}`;
function metricsFixture(t,{role='owner',permissions=[],filename='appearance.xlsx'}={}) {
  const {DatabaseSync}=require('node:sqlite');
  const {createPlatformDemand}=require('../../../ops/crm/platform-demand');
  const {createPlatformCompanyMetrics}=require('../../../ops/crm/platform-company-metrics');
  const db=new DatabaseSync(':memory:');
  db.exec("CREATE TABLE companies(code TEXT PRIMARY KEY,name TEXT,is_deleted INTEGER DEFAULT 0); INSERT INTO companies VALUES('alvi','АЛВИ',0),('avokado','Авокадо',0)");
  const demand=createPlatformDemand(db,{now:()=>Date.parse('2026-09-30T05:00:00Z')});
  const metrics=createPlatformCompanyMetrics(db,{now:()=>Date.parse('2026-09-30T05:00:00Z')});
  const actor={userId:1,userName:'Владелец'};
  for(const code of ['alvi','avokado'])demand.saveSettings(code,{revision:demand.get(code).settings.revision,organizationId:M_ORG,organizationName:'Демо',city:'Демоград',
    cabinetUrl:`https://account.2gis.com/orgs/${M_ORG}/stats`,branchId:M_BRANCH},actor);
  const f=fixture({role,permissions,override:call=>{
    if(call.path.endsWith('/company-metrics'))return metrics.summary(call.code,call.search.get('from'),call.search.get('to'));
    if(call.path.endsWith('/company-metrics/preview'))return metrics.preview(call.code,call.body,actor);
    if(call.path.endsWith('/company-metrics/import'))return metrics.importReports(call.code,call.body,actor);
    if(call.path.endsWith('/settings'))return demand.saveSettings(call.code,call.body,actor);
    if(call.path.endsWith('/import'))return demand.importDataset(call.code,call.body);
    if(call.path.endsWith('/categories'))return demand.saveCategories(call.code,call.body);
    return demand.get(call.code);
  }});
  return {f,db,demand,metrics,actor,filename};
}
// Импорт всегда парой «предпросмотр → подтверждение»: подтверждение привязано к состоянию данных.
const mSeed=(ctxf,list,over={})=>{const seen=ctxf.metrics.preview('alvi',{reports:list},ctxf.actor);
  return ctxf.metrics.importReports('alvi',{settingsRevision:ctxf.demand.get('alvi').settings.revision,
    dataRevision:seen.dataRevision,packageHash:seen.packageHash,confirmReplace:seen.requiresConfirmation,reports:list,...over},ctxf.actor);};
const mReport=(over={})=>({reportKind:'appearance',periodStart:mDay(1),periodEnd:mDay(3),granularity:'day',timezone:null,
  capturedDate:'2026-09-29',capturedAt:null,sourceKind:'official_xlsx',sourceUrl:`https://account.2gis.com/orgs/${M_ORG}/stats`,
  originalFilename:'appearance.xlsx',originalFileSha256:'a'.repeat(64),scopeNote:null,
  rows:[{date:mDay(1),metric:'appearance_views',value:10,sourcePosition:'A2'},
        {date:mDay(2),metric:'appearance_views',value:0,sourcePosition:'A3'},
        {date:mDay(1),metric:'search_position',value:4,sourcePosition:'B2'},
        {date:mDay(2),metric:'search_position',value:7,sourcePosition:'B3'}],...over});

test('все одиннадцать показателей показаны; измеренный ноль отличается от отсутствия данных; позиция в выдаче не суммируется',async t=>{
  const {f,metrics,demand,actor}=metricsFixture(t);
  mSeed({metrics,demand,actor},[mReport()]);
  try{
    await f.render();f.set('metrics-from',mDay(1));f.set('metrics-to',mDay(3));f.submit('metrics-period');await f.settle();
    const table=f.node('metrics-body').querySelector('table');
    assert.equal(table.tBodies[0].rows.length,11,'словарь показателей выводится целиком, а не только заполненные строки');
    const row=name=>[...table.tBodies[0].rows].find(item=>item.cells[0].textContent.includes(name));
    const views=row('Показы');
    assert.equal(views.cells[1].textContent.trim(),'10','измеренный ноль входит в сумму и не превращает её в «нет данных»');
    assert.match(views.cells[3].textContent,/2 \/ 3/,'третий день не загружен и считается пропуском, а не нулём');
    assert.match(views.cells[4].textContent,/0/);
    const position=row('Позиция в выдаче');
    assert.match(position.cells[1].textContent,/не считается/,'позиция в выдаче не суммируется и не усредняется');
    assert.match(position.cells[2].textContent,/4 — 7/);
    const empty=row('Клики в адрес');
    assert.match(empty.cells[4].textContent,/—/);
    assert.match(f.node('metrics-body').textContent,/измеренных нулей: 1/);
    assert.match(f.node('metrics-body').textContent,/Конверсия между отчётами не считается/);
    assert.doesNotMatch(f.node('metrics-body').textContent,/состоявшихся звонк/i);
  }finally{f.close();}
});

test('без подтверждённого филиала показатели не запрашиваются и блок честно объясняет причину',async t=>{
  const {f,db}=metricsFixture(t);
  db.exec("UPDATE platform_demand_settings SET branch_id=''");
  try{
    await f.render();await f.settle();
    assert.equal(f.calls.some(call=>call.path.includes('company-metrics')),false);
    assert.match(f.node('metrics-status').textContent,/Укажите филиал организации/);
    assert.match(f.node('metrics-body').textContent,/ещё не загружены/);
  }finally{f.close();}
});

test('аналитик показатели только читает: блока загрузки нет и запись не уходит',async t=>{
  const {f,metrics,demand,actor}=metricsFixture(t,{role:'marketer',permissions:['analytics.view']});
  mSeed({metrics,demand,actor},[mReport()]);
  try{
    await f.render();f.set('metrics-from',mDay(1));f.set('metrics-to',mDay(3));f.submit('metrics-period');await f.settle();
    assert.equal(f.node('metrics-import').hidden,true);
    assert.equal(f.node('metrics-save').disabled,true);
    f.node('metrics-save').click();await f.settle();
    assert.ok(f.calls.every(call=>call.method==='GET'),'у аналитика не появляется ни одного изменяющего запроса');
    assert.match(f.node('metrics-body').textContent,/Показы/);
  }finally{f.close();}
});

test('загрузка файла: предпросмотр ничего не пишет, замена дат требует подтверждения, повтор не удваивает итоги',async t=>{
  const {f,metrics}=metricsFixture(t);
  const put=value=>{const file=new f.w.File([JSON.stringify(value)],'reports.json',{type:'application/json'});
    Object.defineProperty(f.node('metrics-file'),'files',{value:[file],configurable:true});
    f.node('metrics-file').dispatchEvent(new f.w.Event('change',{bubbles:true}));};
  try{
    await f.render();await f.settle();
    put({reports:[mReport()]});await f.settle();
    assert.equal(f.node('metrics-preview').hidden,false);
    assert.match(f.node('metrics-preview').textContent,/Будет загружено в компанию: АЛВИ/);
    assert.match(f.node('metrics-preview').textContent,/Совпадающих дат нет/);
    assert.equal(metrics.summary('alvi',mDay(1),mDay(3)).coverage.knownValues,0,'предпросмотр ничего не сохранил');
    f.node('metrics-save').click();await f.settle();
    assert.match(f.node('metrics-status').textContent,/Загружено отчётов: 1/);
    const after=metrics.summary('alvi',mDay(1),mDay(3));
    assert.equal(after.coverage.knownValues,4);
    assert.equal(f.node('metrics-preview').hidden,true);
    put({reports:[mReport()]});await f.settle();
    assert.match(f.node('metrics-preview').textContent,/уже загружен/);
    f.node('metrics-save').click();await f.settle();
    assert.equal(metrics.summary('alvi',mDay(1),mDay(3)).coverage.knownValues,4,'повтор тех же чисел ничего не прибавил');
    put({reports:[mReport({rows:[{date:mDay(1),metric:'appearance_views',value:99,sourcePosition:'A2'}]})]});await f.settle();
    assert.match(f.node('metrics-preview').textContent,/было 10 → станет 99/);
    assert.ok(f.node('metrics-preview').querySelector('.demand-warning'));
  }finally{f.close();}
});

test('смена компании очищает предпросмотр и показатели прежней компании',async t=>{
  const {f}=metricsFixture(t);
  const put=value=>{const file=new f.w.File([JSON.stringify(value)],'reports.json',{type:'application/json'});
    Object.defineProperty(f.node('metrics-file'),'files',{value:[file],configurable:true});
    f.node('metrics-file').dispatchEvent(new f.w.Event('change',{bubbles:true}));};
  try{
    await f.render();await f.settle();put({reports:[mReport()]});await f.settle();
    assert.equal(f.node('metrics-preview').hidden,false);
    await f.views['platform-demand'].render(f.container,{...f.ctx,selectedProjectId:'avokado'});await f.settle();
    assert.equal(f.node('metrics-preview').hidden,true);
    assert.equal(f.node('metrics-preview').textContent,'');
    assert.equal(f.node('metrics-save').disabled,true);
    f.node('metrics-save').click();await f.settle();
    assert.equal(f.calls.some(call=>call.method==='POST'&&call.path.includes('company-metrics/import')),false);
  }finally{f.close();}
});

test('название файла и подпись источника выводятся как текст, разметка из них не исполняется',async t=>{
  const {f,metrics,demand,actor}=metricsFixture(t);
  mSeed({metrics,demand,actor},[mReport({originalFilename:'<img src=x onerror=alert(1)>.xlsx'})]);
  try{
    await f.render();f.set('metrics-from',mDay(1));f.set('metrics-to',mDay(3));f.submit('metrics-period');await f.settle();
    f.node('metrics-history-box').open=true;
    assert.equal(f.node('metrics-history').querySelector('img'),null);
    assert.match(f.node('metrics-history').textContent,/<img src=x onerror=alert\(1\)>\.xlsx/);
    assert.equal(f.container.querySelector('script'),null);
  }finally{f.close();}
});

test('филиал настраивается в форме организации, а сохранение сбрасывает прежние показатели',async t=>{
  const {f,db}=metricsFixture(t);
  db.exec("UPDATE platform_demand_settings SET branch_id=''");
  try{
    await f.render();await f.settle();
    const form=f.node('settings-form');
    assert.ok(form.elements.branchId,'поле филиала есть в форме организации');
    assert.equal(form.elements.branchId.value,'');
    assert.match(f.node('metrics-status').textContent,/Укажите филиал организации/);
    form.elements.branchId.value=M_BRANCH;f.submit('settings-form');await f.settle();
    const saved=f.calls.find(call=>call.path.endsWith('/settings')&&call.method==='PUT');
    assert.equal(saved.body.branchId,M_BRANCH,'филиал уходит на сервер');
    assert.ok(f.calls.some(call=>call.path.endsWith('/company-metrics')),'показатели перечитаны для подтверждённого филиала');
    assert.match(f.node('metrics-body').textContent,/Организация/);
  }finally{f.close();}
});

test('правка формы организации сбрасывает подтверждённый предпросмотр показателей',async t=>{
  const {f}=metricsFixture(t);
  try{
    await f.render();await f.settle();
    const file=new f.w.File([JSON.stringify({reports:[mReport()]})],'reports.json',{type:'application/json'});
    Object.defineProperty(f.node('metrics-file'),'files',{value:[file],configurable:true});
    f.node('metrics-file').dispatchEvent(new f.w.Event('change',{bubbles:true}));await f.settle();
    assert.equal(f.node('metrics-preview').hidden,false);
    f.node('settings-form').elements.city.value='Другой город';
    f.node('settings-form').dispatchEvent(new f.w.Event('input',{bubbles:true}));
    assert.equal(f.node('metrics-preview').hidden,true,'предпросмотр относился к прежним настройкам');
    assert.equal(f.node('metrics-save').disabled,true);
  }finally{f.close();}
});

test('пустые строки, известные значения и измеренные нули в покрытии не путаются',async t=>{
  const {f,metrics,demand,actor}=metricsFixture(t);
  mSeed({metrics,demand,actor},[mReport({periodStart:mDay(1),periodEnd:mDay(2),rows:[
    {date:mDay(1),metric:'appearance_views',value:0,sourcePosition:'A2'},
    {date:mDay(2),metric:'appearance_views',value:null,sourcePosition:'A3'}]})]);
  try{
    await f.render();f.set('metrics-from',mDay(1));f.set('metrics-to',mDay(3));f.submit('metrics-period');await f.settle();
    const body=f.node('metrics-body').textContent;
    assert.match(body,/из них с измерениями: 1/,'день с пустым значением измеренным не считается');
    assert.match(body,/пустыми значениями/);
    assert.match(body,/Известных значений: 1 из 2 прочитанных строк, из них измеренных нулей: 1/);
    const views=[...f.node('metrics-body').querySelectorAll('tbody tr')]
      .find(row=>row.cells[0].textContent.includes('Показы'));
    assert.equal(views.cells[1].textContent.trim(),'0','измеренный ноль показан как ноль, а не как прочерк');
    assert.match(views.cells[4].textContent,/нет данных/);
  }finally{f.close();}
});

test('предпросмотр объясняет изменение условий сбора при тех же числах',async t=>{
  const {f,metrics,demand,actor}=metricsFixture(t);
  const base=(over={})=>mReport({reportKind:'pagevisits',periodStart:mDay(1),periodEnd:mDay(1),
    rows:[{date:mDay(1),metric:'page_visits',value:5,sourcePosition:'A2'}],...over});
  mSeed({metrics,demand,actor},[base()]);
  const put=value=>{const file=new f.w.File([JSON.stringify(value)],'reports.json',{type:'application/json'});
    Object.defineProperty(f.node('metrics-file'),'files',{value:[file],configurable:true});
    f.node('metrics-file').dispatchEvent(new f.w.Event('change',{bubbles:true}));};
  try{
    await f.render();await f.settle();
    put({reports:[base({timezone:'Asia/Irkutsk',scopeNote:'partner_sites_excluded'})]});await f.settle();
    const text=f.node('metrics-preview').textContent;
    assert.doesNotMatch(text,/ничего не добавит/,'это не повтор');
    assert.match(text,/Изменились условия или подтверждение источника/);
    assert.match(text,/часовой пояс — было «не указан», станет «Asia\/Irkutsk»/);
    assert.match(text,/охват источника — было «без ограничения»/);
    assert.match(text,/изменились условия сбора/);
    f.node('metrics-save').click();await f.settle();
    assert.match(f.node('metrics-status').textContent,/Загружено отчётов: 1/);
  }finally{f.close();}
});
