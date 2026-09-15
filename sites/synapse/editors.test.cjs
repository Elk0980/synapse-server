// Requires jsdom (the existing Palitra editor tests use the same test dependency).
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {JSDOM,VirtualConsole}=require('jsdom');
const read=file=>fs.readFileSync(path.join(__dirname,file),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const response=(status,body)=>({ok:status>=200&&status<300,status,json:async()=>structuredClone(body)});
const serverSource=read('../../ops/content/server.js');
const validators=Object.fromEntries([['site','validateSite','safeAssetName'],['price','validatePrice','validateMarkdown']].map(([kind,name,next])=>{
  const source=serverSource.slice(serverSource.indexOf(`function ${name}(`),serverSource.indexOf(`function ${next}(`));
  const validate=vm.runInNewContext(source+`;${name}`,{fail(status,message,details){throw new Error(`${status}: ${message}: ${details.join('; ')}`);}});
  return [kind,validate];
}));

async function fixture(kind,site,{keyMode=false,seedOverride,defaultsOverride}={}) {
  const html=read(kind+'-editor.html');
  const code=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]).find(script=>script.includes('const params = new URLSearchParams'));
  const seed=seedOverride||JSON.parse(read(`../../ops/content/seed/${site}-${kind}.json`));
  const defaults=defaultsOverride||structuredClone(seed), calls=[],errors=[];
  let saved=structuredClone(seed), pending=null, delay=false;
  const vc=new VirtualConsole();vc.on('jsdomError',error=>errors.push(error.message));
  // No resources option: iframe, fonts and remote scripts cannot access the network.
  const dom=new JSDOM(html,{url:`https://synapse.synapsebusiness.ru/${kind}-editor.html?site=${site}`,runScripts:'outside-only',virtualConsole:vc});
  const w=dom.window,d=w.document;
  w.scrollTo=()=>{};w.alert=()=>{};w.confirm=()=>true;w.prompt=()=>keyMode?'synthetic-editor-key':assert.fail('A cookie session must not prompt for an API key');
  w.CSS={escape:value=>String(value)};
  w.URL.createObjectURL=()=> 'blob:qa-only';w.URL.revokeObjectURL=()=>{};
  w.Image=class{naturalWidth=1;naturalHeight=1;set src(value){queueMicrotask(()=>this.onload());}};
  w.fetch=async(url,opts={})=>{
    calls.push({url,opts});
    if(url==='/content/whoami')return keyMode?response(401,{}):response(200,{author:'QA',csrfToken:'synthetic-csrf'});
    if(url.startsWith('https://')&&url.endsWith('/data/site.json'))return response(200,defaults);
    if(url.startsWith('https://')&&url.endsWith('/data/price.json'))return response(200,defaults);
    assert.ok(url.startsWith(`/content/${site}/`),'only the selected content document can be accessed');
    assert.equal(opts.credentials,'same-origin');
    if(keyMode)assert.equal(opts.headers?.['X-API-Key'],'synthetic-editor-key','reads and writes both authenticate');
    else {
      assert.equal(opts.headers?.['X-API-Key'],undefined);
      if(opts.method&&opts.method!=='GET')assert.equal(opts.headers?.['X-CSRF-Token'],'synthetic-csrf');
    }
    if(url.endsWith('/assets'))return response(200,{url:'/api/assets/qa-photo.png'});
    if(url.endsWith('/history'))return response(200,{versions:[{version:1,created_at:'2026-09-15',author:'QA'}]});
    if(opts.method==='PUT') {
      const snapshot=JSON.parse(opts.body);
      validators[kind](snapshot);
      const finish=()=>{saved={...snapshot,version:(saved.version||0)+1,updatedAt:'2026-09-15T10:00:00Z'};return response(200,{version:saved.version,updatedAt:saved.updatedAt});};
      return delay?new Promise(resolve=>{pending=()=>resolve(finish());}):finish();
    }
    return response(200,saved);
  };
  if(kind==='price') {
    w.eval(read(`../${site}/price-render.js`));
    if(site==='avokado')w.eval(read('../avokado3/catalog.js'));
  }
  w.eval(code);
  const settle=async()=>{for(let i=0;i<8;i++)await tick();};
  await settle();
  return {w,d,calls,errors,settle,seed,
    save:()=>d.getElementById('ed-save').click(),saved:()=>saved,
    delaySave:()=>{delay=true;},finishSave:()=>{assert.ok(pending,'a save request is pending');delay=false;pending();pending=null;},
    close:()=>dom.window.close(),
  };
}

for(const [kind,site]of [['site','alvi'],['site','avokado3'],['price','alvi'],['price','avokado']]) {
  for(const keyMode of [false,true])test(`${kind} ${site}: opens, reads history and saves with ${keyMode?'explicit owner key':'cabinet cookie/CSRF'}`,async()=>{
    const f=await fixture(kind,site,{keyMode});try{
      assert.match(f.d.getElementById('ed-status').textContent,/Готово/);
      f.d.getElementById('ed-history').click();await f.settle();
      assert.ok(f.calls.some(call=>call.url.endsWith('/history')));
      f.save();await f.settle();
      assert.equal(f.calls.filter(call=>call.opts.method==='PUT').length,1);
      assert.match(f.d.getElementById('ed-status').textContent,/Сохранено/);
      assert.deepEqual(f.errors,[]);
    }finally{f.close();}
  });
}

for(const site of ['alvi','avokado3'])test(`site ${site}: typing during a save remains dirty and is sent by the next save`,async()=>{
  const f=await fixture('site',site);try{
    f.d.getElementById('ed-mode-list').click();
    const field=f.d.querySelector('textarea[data-field]');assert.ok(field);
    const key=field.dataset.field;
    field.value='First snapshot';field.dispatchEvent(new f.w.Event('input',{bubbles:true}));
    f.delaySave();f.save();await f.settle();
    field.value='Typed while saving';field.dispatchEvent(new f.w.Event('input',{bubbles:true}));
    f.d.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,cancelable:true}));
    assert.equal(f.calls.filter(call=>call.opts.method==='PUT').length,1,'keyboard shortcut cannot start a second concurrent save');
    f.finishSave();await f.settle();
    const savedField=()=>f.saved().sections.flatMap(section=>section.fields||[]).find(item=>item.key===key);
    assert.equal(savedField().value,'First snapshot');assert.equal(field.value,'Typed while saving');
    assert.match(f.d.getElementById('ed-status').textContent,/несохранённые/);
    assert.match(f.d.getElementById('ed-save').textContent,/•/);
    f.save();await f.settle();assert.equal(savedField().value,'Typed while saving');
    assert.doesNotMatch(f.d.getElementById('ed-save').textContent,/•/);assert.deepEqual(f.errors,[]);
  }finally{f.close();}
});

for(const site of ['alvi','avokado'])test(`price ${site}: an applied edit during save remains dirty; an open form is not replaced`,async()=>{
  const f=await fixture('price',site);try{
    const item=f.seed.categories.find(cat=>cat.items?.length).items[0];
    f.d.querySelector(`[data-edit="${item.id}"]`).click();
    let form=f.d.querySelector(`form[data-form="${item.id}"]`);
    f.delaySave();f.save();await f.settle();
    form.querySelector('[name="title"]').value='New draft during save';
    form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));
    f.d.querySelector(`[data-edit="${item.id}"]`).click();form=f.d.querySelector(`form[data-form="${item.id}"]`);
    const input=form.querySelector('[name="title"]');input.value='Still typing';input.focus();
    f.finishSave();await f.settle();
    assert.equal(f.d.querySelector(`form[data-form="${item.id}"]`),form);
    assert.equal(input.value,'Still typing');assert.equal(f.d.activeElement,input);
    assert.match(f.d.getElementById('ed-status').textContent,/несохранённые/);
    const firstSnapshot=JSON.parse(f.calls.find(call=>call.opts.method==='PUT').opts.body);
    assert.equal(f.saved().categories.flatMap(cat=>cat.items).find(it=>it.id===item.id).title,firstSnapshot.categories.flatMap(cat=>cat.items).find(it=>it.id===item.id).title);
    form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));f.save();await f.settle();
    assert.equal(f.saved().categories.flatMap(cat=>cat.items).find(it=>it.id===item.id).title,'Still typing');
    assert.deepEqual(f.errors,[]);
  }finally{f.close();}
});

test('site defaults add new fields inside existing sections without overwriting client copy, style or hidden state',async()=>{
  const seed=JSON.parse(read('../../ops/content/seed/avokado3-site.json'));
  const defaults=JSON.parse(read('../avokado3/data/site.json'));
  const existing=seed.sections.find(sec=>sec.fields?.length).fields[0];
  existing.value='Client-owned copy';existing.hidden=true;existing.layout={mobile:{x:17}};
  const f=await fixture('site','avokado3',{seedOverride:seed,defaultsOverride:defaults});try{
    f.d.getElementById('ed-mode-list').click();
    assert.ok(f.d.querySelector('textarea[data-field="contacts.contact-main-2"]'));
    f.save();await f.settle();
    const fields=f.saved().sections.flatMap(sec=>sec.fields||[]);
    assert.deepEqual(fields.find(field=>field.key===existing.key),existing);
    assert.ok(fields.some(field=>field.key==='price.gold-cta-2'));
    assert.equal(fields.filter(field=>field.key==='contacts.contact-main-2').length,1);
  }finally{f.close();}
});

test('Avokado uploaded price photo saves an absolute asset URL from the price namespace',async()=>{
  const f=await fixture('price','avokado');try{
    const id=f.seed.categories.find(cat=>cat.items?.length).items[0].id;
    f.d.querySelector(`[data-edit="${id}"]`).click();
    const upload=f.d.querySelector(`[data-photo-upload="${id}"]`);
    Object.defineProperty(upload,'files',{value:[new f.w.File(['qa'],'test.png',{type:'image/png'})]});
    upload.dispatchEvent(new f.w.Event('change',{bubbles:true}));await f.settle();
    const form=f.d.querySelector(`form[data-form="${id}"]`),url=form.querySelector('[name="photo"]').value;
    assert.equal(url,'https://synapse.synapsebusiness.ru/content/avokado/assets/qa-photo.png');
    form.dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true}));f.save();await f.settle();
    assert.equal(f.saved().categories.flatMap(cat=>cat.items).find(it=>it.id===id).photo,url);
    assert.equal(new URL(url,'https://avokado38.ru').pathname,'/content/avokado/assets/qa-photo.png');
    assert.deepEqual(f.errors,[]);
  }finally{f.close();}
});

test('the legacy Avokado editor shortcut opens the current avokado3 site document',()=>{
  const html=read('site-editor-avokado.html');
  assert.equal([...html.matchAll(/site-editor\.html\?site=([a-z0-9]+)/g)].length,3);
  assert.ok([...html.matchAll(/site-editor\.html\?site=([a-z0-9]+)/g)].every(match=>match[1]==='avokado3'));
});
