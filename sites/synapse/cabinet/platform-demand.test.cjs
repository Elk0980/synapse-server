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
      const u=new URL(url,'https://cabinet.example.test/'),code=u.searchParams.get('companyCode'),call={path:u.pathname,code,method:options.method||'GET',body:options.body?JSON.parse(options.body):null,options};calls.push(call);
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
