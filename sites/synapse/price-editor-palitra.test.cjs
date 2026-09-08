// QA dependency only: npm install --prefix /tmp/palitra-dom-qa jsdom
// NODE_PATH=/tmp/palitra-dom-qa/node_modules node --test sites/synapse/price-editor-palitra.test.cjs
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM,VirtualConsole}=require('jsdom');
const root=__dirname;
const html=fs.readFileSync(path.join(root,'price-editor-palitra.html'),'utf8');
const renderer=fs.readFileSync(path.join(root,'price-render-palitra.js'),'utf8');
const code=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const seed=JSON.parse(fs.readFileSync(path.join(root,'../palitra-love/data/price.json'),'utf8'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const profile={role:'editor',permissions:['price.edit','site_editor.edit'],companies:[{id:'palitra-love'}],csrfToken:'synthetic-csrf-only'};
async function fixture(initialProfile=profile, transport=null){
  const errors=[],calls=[];let identity=initialProfile;let saved=structuredClone(seed);let uploads=0;
  const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(html,{url:'https://cabinet.test/price-editor-palitra.html?api=https://untrusted.test',runScripts:'outside-only',virtualConsole:vc});
  const w=dom.window;w.AbortController=AbortController;w.scrollTo=()=>{};w.alert=()=>{};w.confirm=()=>true;w.prompt=()=>{throw Error('Unexpected prompt');};
  Object.defineProperty(w,'localStorage',{get(){throw Error('Editor must not access browser storage');}});
  w.CSS={escape:s=>s};w.URL.createObjectURL=()=> 'blob:synthetic-qa';w.URL.revokeObjectURL=()=>{};
  w.Image=class{naturalWidth=1;naturalHeight=1;set src(v){queueMicrotask(()=>this.onload());}};
  const response=(status,body)=>({ok:status>=200&&status<300,status,json:async()=>body});
  w.fetch=async(url,opts={})=>{
    calls.push({url,opts});assert.ok(url.startsWith('/content/'));assert.equal(opts.credentials,'same-origin');
    assert.equal(opts.headers?.['X-API-Key'],undefined);
    if (transport) return transport(url, opts);
    if(url==='/content/whoami')return identity?response(200,identity):response(401,{});
    if(url.endsWith('/history'))return response(200,{versions:[{version:1,created_at:'2026-09-04',author:'QA'}]});
    if(opts.method && opts.method!=='GET')assert.equal(opts.headers['X-CSRF-Token'],profile.csrfToken);
    if(url.includes('/restore/')){saved={...structuredClone(seed),version:3};return response(200,{ok:true,version:3});}
    if(url.endsWith('/assets')){uploads++;return response(200,{url:'/api/assets/qa.png'});}
    if(opts.method==='PUT'){saved={...JSON.parse(opts.body),version:2,updatedAt:'2026-09-08T18:00:00Z'};return response(200,{ok:true,version:2,updatedAt:saved.updatedAt});}
    return response(200,structuredClone(saved));
  };
  w.eval(renderer);w.eval(code);for(let i=0;i<5;i++)await tick();
  return {w,d:w.document,calls,errors,setIdentity:p=>{identity=p;},uploads:()=>uploads,saved:()=>saved,
    settle:async()=>{for(let i=0;i<5;i++)await tick();},close:()=>dom.window.close()};
}
test('session bootstrap and save use same-origin CSRF without keys/storage',async()=>{
 const f=await fixture();try{
 assert.equal(f.d.querySelector('#ed-key'),null);assert.equal(f.d.querySelector('#ed-save').disabled,false);
 f.d.querySelector('#ed-save').click();await f.settle();
 const put=f.calls.find(c=>c.opts.method==='PUT');assert.ok(put);assert.deepEqual(JSON.parse(put.opts.body).categories,seed.categories);
 assert.match(f.d.querySelector('#ed-status').textContent,/Сохранено/);assert.match(f.d.querySelector('#ed-sub').textContent,/версия 2/);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});
test('missing session shows login link and prevents save, retry restores editor',async()=>{
 const f=await fixture(null);try{
 assert.equal(f.d.querySelector('#ed-save').disabled,true);assert.match(f.d.querySelector('#ed-status').textContent,/Войдите в кабинет/);
 assert.equal(f.d.querySelector('#ed-login').hidden,false);assert.equal(f.d.querySelector('#ed-login').getAttribute('href'),'/cabinet.html');
 assert.equal(f.calls.some(c=>c.opts.method==='PUT'),false);
 f.setIdentity(profile);f.d.querySelector('#ed-session-retry').click();await f.settle();assert.equal(f.d.querySelector('#ed-save').disabled,false);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});
test('expired session never reports saved and retains the open price for retry',async()=>{
 const f=await fixture();try{
 const before=f.d.querySelector('#ed-content').innerHTML;f.setIdentity(null);f.d.querySelector('#ed-save').click();await f.settle();
 assert.equal(f.calls.some(c=>c.opts.method==='PUT'),false);assert.match(f.d.querySelector('#ed-status').textContent,/Не сохранено/);
 assert.equal(f.d.querySelector('#ed-content').innerHTML,before);assert.equal(f.d.querySelector('#ed-save').disabled,true);
 f.setIdentity(profile);f.d.querySelector('#ed-session-retry').click();await f.settle();assert.equal(f.d.querySelector('#ed-content').innerHTML,before);assert.equal(f.d.querySelector('#ed-save').disabled,false);
 }finally{f.close();}
});
test('a user without Palitra edit access receives an explicit refusal',async()=>{
 const f=await fixture({...profile,companies:[{id:'alvi'}]});try{assert.equal(f.d.querySelector('#ed-save').disabled,true);assert.match(f.d.querySelector('#ed-status').textContent,/Нет права/);assert.equal(f.calls.length,1);}finally{f.close();}
});
test('history and restore use the session; restore sends CSRF',async()=>{
 const f=await fixture();try{f.d.querySelector('#ed-history').click();await f.settle();assert.ok(f.d.querySelector('[data-restore]'));f.d.querySelector('[data-restore]').click();await f.settle();assert.ok(f.calls.find(c=>c.url.endsWith('/restore/1')&&c.opts.headers['X-CSRF-Token']));assert.match(f.d.querySelector('#ed-sub').textContent,/версия 3/);assert.deepEqual(f.errors,[]);}finally{f.close();}
});
test('photo upload uses the same session/CSRF request wrapper',async()=>{
 const f=await fixture();try{
 f.d.querySelector('[data-edit]').click();const input=f.d.querySelector('[data-photo-upload]');assert.ok(input);
 Object.defineProperty(input,'files',{value:[new f.w.File(['qa'],'qa.png',{type:'image/png'})]});input.dispatchEvent(new f.w.Event('change',{bubbles:true}));await f.settle();
 assert.equal(f.uploads(),1);const upload=f.calls.find(c=>c.url.endsWith('/assets'));assert.equal(upload.opts.headers['X-CSRF-Token'],profile.csrfToken);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});
test('real local content server accepts saves/history/restore initiated by editor DOM clicks',async()=>{
 const {spawn}=require('node:child_process'),{once}=require('node:events'),crypto=require('node:crypto'),net=require('node:net');
 const service=path.resolve(root,'../../ops/content');const {hashPassword}=require(service+'/passwords');
 const dir=fs.mkdtempSync('/tmp/palitra-editor-session-');const password=crypto.randomBytes(20).toString('hex');
 const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
 const child=spawn(process.execPath,[service+'/server.js'],{env:{...process.env,PORT:String(port),DATABASE_PATH:dir+'/db.sqlite',SEED_DIR:service+'/seed',ASSETS_DIR:dir+'/assets',API_KEY:'',AUTH_USERS:`owner:owner:${hashPassword(password)}`,SESSION_SECRET:crypto.randomBytes(32).toString('hex')},stdio:'ignore'});
 const base='http://127.0.0.1:'+port;let f;
 async function until(check){for(let i=0;i<150;i++){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw Error('local QA timeout: '+(f?.d.querySelector('#ed-status')?.textContent || '')+'; '+JSON.stringify(f?.errors || []));}
 try{
  await until(async()=>{try{return (await fetch(base+'/health')).ok;}catch{return false;}});
  const login=await fetch(base+'/content/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login:'owner',password})});assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const initial=await (await fetch(base+'/content/palitra/price')).json();
  f=await fixture(profile,(url,opts)=>fetch(base+url,{...opts,headers:{...opts.headers,cookie}}));
  await until(()=>!f.d.querySelector('#ed-save').disabled);
  f.d.querySelector('#ed-save').click();await until(()=>/Сохранено/.test(f.d.querySelector('#ed-status').textContent));
  const saved=await (await fetch(base+'/content/palitra/price')).json();assert.equal(saved.version,initial.version+1);assert.deepEqual(saved.categories,initial.categories);
  f.d.querySelector('#ed-history').click();await until(()=>f.d.querySelector('[data-restore="1"]'));
  f.d.querySelector('[data-restore="1"]').click();await until(()=>/Возвращена версия/.test(f.d.querySelector('#ed-status').textContent));
  const restored=await (await fetch(base+'/content/palitra/price')).json();assert.equal(restored.version,saved.version+1);
  assert.deepEqual(restored.categories,initial.categories);assert.deepEqual(f.errors,[]);
 }finally{if(f)f.close();if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}fs.rmSync(dir,{recursive:true,force:true});}
});
