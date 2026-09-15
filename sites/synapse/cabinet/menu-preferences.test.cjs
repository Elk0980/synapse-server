const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
function setup(){
  const shell=fs.readFileSync(require.resolve('../cabinet.html'),'utf8');
  const dom=new JSDOM(shell,{url:'https://example.test',runScripts:'outside-only'});
  const w=dom.window; w.matchMedia=()=>({matches:false});
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  w.eval(fs.readFileSync(require.resolve('./menu-preferences.js'),'utf8'));
  w.document.querySelector('.nav').addEventListener('click',event=>{
    const b=event.target.closest('.nav-category');if(!b)return;
    const open=b.getAttribute('aria-expanded')!=='true';b.setAttribute('aria-expanded',String(open));
    w.document.getElementById(b.getAttribute('aria-controls')).hidden=!open;
  });
  const init=login=>w.SbCabinet.initMenuPreferences({identity:{login},setDrawer(){}});
  init('owner');
  return {dom,w,d:w.document,init};
}
test('multiple categories remain expanded and their state survives reinitialization',()=>{
  const {dom,d,init}=setup();d.querySelector('#crm-category').click();d.querySelector('#analytics-category').click();
  assert.equal(d.querySelector('#crm-menu').hidden,false);assert.equal(d.querySelector('#analytics-menu').hidden,false);
  init('owner');assert.equal(d.querySelector('#crm-menu').hidden,false);assert.equal(d.querySelector('#analytics-menu').hidden,false);
  dom.window.close();
});
test('favorite and order preferences persist without moving records between categories or duplicating IDs',()=>{
  const {dom,d,init}=setup();d.querySelector('[data-menu-settings]').click();
  d.querySelector('.menu-option input').click();d.querySelector('.menu-option button:last-child').click();
  assert.equal(d.querySelector('.menu-favorites a').dataset.viewLink,'crm');
  assert.equal(d.querySelector('#crm-menu a').dataset.viewLink,'deals');
  assert.equal(d.querySelectorAll('#crm-link').length,1);
  init('owner');assert.equal(d.querySelector('#crm-menu a').dataset.viewLink,'deals');
  assert.equal(d.querySelector('.menu-favorites a').dataset.viewLink,'crm');
  init('other');assert.equal(d.querySelector('.menu-favorites').childElementCount,0);
  assert.equal(d.querySelector('#crm-menu a').dataset.viewLink,'crm');
  dom.window.close();
});
test('favorites respect original link visibility and disabled editor state',async()=>{
  const {dom,w,d,init}=setup();
  w.localStorage.setItem('sb-menu-v1:owner',JSON.stringify({favorites:['crm','editor:site']}));init('owner');
  d.querySelector('#crm-link').hidden=true;d.querySelector('#site-editor-link').setAttribute('aria-disabled','true');
  await new Promise(resolve=>w.setTimeout(resolve,0));
  assert.equal(d.querySelector('.menu-favorites [data-view-link="crm"]'),null);
  assert.equal(d.querySelector('.menu-favorites [data-editor-link]').getAttribute('aria-disabled'),'true');
  dom.window.close();
});
test('folding, pinning and expand-all controls preserve independent state',()=>{
  const {dom,d,init}=setup();d.querySelector('[data-menu-fold]').click();assert.ok(d.body.classList.contains('menu-collapsed'));
  init('owner');assert.ok(d.body.classList.contains('menu-collapsed'));
  d.querySelector('[data-menu-fold]').click();d.querySelector('[data-menu-pin]').click();
  assert.equal(d.querySelector('[data-menu-pin]').getAttribute('aria-pressed'),'false');
  d.querySelector('[data-menu-pin]').click();assert.equal(d.querySelector('[data-menu-pin]').getAttribute('aria-pressed'),'true');
  d.querySelector('[data-menu-expand]').click();assert.ok([...d.querySelectorAll('.subnav')].every(el=>!el.hidden));
  d.querySelector('[data-menu-collapse]').click();assert.ok([...d.querySelectorAll('.subnav')].every(el=>el.hidden));
  dom.window.close();
});
