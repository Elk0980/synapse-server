// QA only: NODE_PATH=/tmp/palitra-dom-qa/node_modules node --test sites/synapse/cabinet/account-access.test.cjs
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {JSDOM,VirtualConsole}=require('jsdom');
const {COMPANIES,PERMISSIONS,DEPENDENCIES,PRICE_CLIENT_PRESET}=require('../../../ops/content/auth-store');
const html=fs.readFileSync(path.join(__dirname,'../cabinet.html'),'utf8');
const script=fs.readFileSync(path.join(__dirname,'account.js'),'utf8');
async function fixture(fail=false) {
 const errors=[],created=[],views={}; let rejectOptions=fail, resolveOptions;
 const gate=new Promise(resolve=>{resolveOptions=resolve;});
 const vc=new VirtualConsole();vc.on('jsdomError',error=>errors.push(error.message));
 const dom=new JSDOM(html,{url:'https://cabinet.test/cabinet.html',runScripts:'outside-only',virtualConsole:vc});
 const w=dom.window,d=w.document;
 w.SbCabinet={registerView:(name,view)=>{views[name]=view;}};
 w.eval(script);
 const escapeHTML=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const options={companies:Object.entries(COMPANIES).map(([id,c])=>({id,...c})),permissions:PERMISSIONS,dependencies:DEPENDENCIES,presets:[PRICE_CLIENT_PRESET]};
 views.accounts.initialize({identity:{role:'owner',csrfToken:'synthetic-csrf'},byId:id=>d.getElementById(id),escapeHTML,
  apiJson:async(url,opts={})=>{
   if(url.endsWith('/access-options')){await gate;if(rejectOptions)throw Error('network unavailable');return options;}
   if(opts.method==='POST'){
    const body=JSON.parse(opts.body);assert.equal(typeof body.password,'string');assert.ok(body.password.length>=12);
    // Never retain generated test passwords in logs, snapshots or fixtures.
    delete body.password;created.push(body);return {};
   }
   return {accounts:[]};
  }});
 const settle=async()=>{for(let i=0;i<4;i++)await new Promise(r=>setImmediate(r));};
 const fill=()=>{const f=d.querySelector('#account-create');f.elements.login.value='qa_client';f.elements.displayName.value='QA';
  const secret=crypto.randomBytes(24).toString('hex');f.elements.password.value=secret;f.elements.confirm.value=secret;};
 return {w,d,created,errors,settle,fill,ready:async()=>{resolveOptions();await settle();},retry:async()=>{rejectOptions=false;d.querySelector('#account-access-retry').click();await settle();},close:()=>w.close()};
}
test('creation waits for options; preset grants exactly one project and three permissions',async()=>{
 const f=await fixture();try {
  assert.equal(f.d.querySelector('#account-create-submit').disabled,true);
  await f.ready();assert.equal(f.d.querySelectorAll('[name="companies"]:checked').length,0);
  assert.equal(f.d.querySelectorAll('[name="permissions"]:checked').length,0);
  const preset=f.d.querySelector('#account-access-preset');preset.value='client-price';preset.dispatchEvent(new f.w.Event('change'));
  f.fill();f.d.querySelector('#account-create-submit').click();await f.settle();assert.equal(f.created.length,0);
  assert.match(f.d.querySelector('#account-create-result').textContent,/ровно один проект/);
  f.d.querySelector('[name="companies"][value="palitra-love"]').click();f.fill();
  f.d.querySelector('#account-create-submit').click();await f.settle();
  assert.equal(f.created.length,1);assert.deepEqual(f.created[0].companies,['palitra-love']);
  assert.deepEqual(f.created[0].permissions.sort(),['price.edit','price.view','sites.view']);
  assert.equal(f.d.querySelector('[name="password"]').value,'');assert.equal(f.d.querySelector('[name="confirm"]').value,'');
  assert.equal(f.d.querySelectorAll('[name="companies"]:checked').length,0);
  assert.equal(f.d.querySelectorAll('[name="permissions"]:checked').length,0);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});
test('manual access preserves only checked projects/permissions and dependency errors prevent creation',async()=>{
 const f=await fixture();try {
  await f.ready();for(const id of ['alvi','avokado'])f.d.querySelector(`[name="companies"][value="${id}"]`).click();
  f.d.querySelector('[name="permissions"][value="price.edit"]').click();f.fill();
  f.d.querySelector('#account-create-submit').click();await f.settle();assert.equal(f.created.length,0);
  f.d.querySelector('[name="permissions"][value="price.view"]').click();f.fill();
  f.d.querySelector('#account-create-submit').click();await f.settle();
  assert.deepEqual(f.created[0].companies,['alvi','avokado']);assert.deepEqual(f.created[0].permissions.sort(),['price.edit','price.view']);
 }finally{f.close();}
});
test('failed access load stays disabled with visible retry and recovers',async()=>{
 const f=await fixture(true);try{await f.ready();assert.equal(f.d.querySelector('#account-create-submit').disabled,true);
 assert.match(f.d.querySelector('#account-access-status').textContent,/Не удалось загрузить/);
 assert.equal(f.d.querySelector('#account-access-retry').hidden,false);await f.retry();
 assert.equal(f.d.querySelector('#account-create-submit').disabled,false);assert.deepEqual(f.errors,[]);
 }finally{f.close();}
});
test('Palitra client sidebar opens its price editor and does not enable the site editor',async()=>{
 const f=await fixture();try{
  await f.ready();
  const code=html.slice(html.indexOf('  const editorSupported ='),html.indexOf('  const redirectEditorHash ='));
  f.w.eval('const EDITOR_PROJECTS=["alvi","avokado"]; let selectedProjectId="palitra-love"; const identity={role:"editor",permissions:["sites.view","price.view","price.edit"]}; const byId=id=>document.getElementById(id);'+code+'; updateEditorLinks();');
  const price=f.d.querySelector('#price-editor-link'),site=f.d.querySelector('#site-editor-link');
  assert.equal(price.getAttribute('href'),'/price-editor-palitra.html');assert.equal(price.getAttribute('aria-disabled'),'false');
  assert.equal(site.getAttribute('aria-disabled'),'true');
 }finally{f.close();}
});
