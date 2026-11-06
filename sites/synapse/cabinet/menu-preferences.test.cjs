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
// №139: «Ещё» — старые и служебные разделы переносятся, не удаляются; возврат одним переключателем.
const navOrder=d=>[...d.querySelectorAll('.nav a.nav-link')].map(a=>a.dataset.viewLink||'editor:'+a.dataset.editorLink);
const pristine=()=>{const d=new JSDOM(fs.readFileSync(require.resolve('../cabinet.html'),'utf8')).window.document;return navOrder(d);};
test('more: listed sections move into «Ещё», emptied groups disappear, nothing is deleted',()=>{
  const {dom,w,d}=setup();const more=d.querySelector('#more-menu');
  assert.equal(w.SbCabinet.MENU_MORE_ITEMS.length,19);
  const inMore=[...more.querySelectorAll('a.nav-link')].map(a=>a.dataset.viewLink||'editor:'+a.dataset.editorLink);
  assert.deepEqual(inMore,[...w.SbCabinet.MENU_MORE_ITEMS].filter(id=>pristine().includes(id)));
  assert.equal(navOrder(d).length,pristine().length);
  assert.equal(new Set([...d.querySelectorAll('[id]')].map(e=>e.id)).size,d.querySelectorAll('[id]').length);
  const marketing=d.querySelector('[aria-controls="marketing-menu"]');
  assert.ok(marketing.classList.contains('nav-empty'));
  assert.deepEqual([...d.querySelectorAll('#analytics-menu a')].map(a=>a.dataset.viewLink),['analytics-through','ad-platforms']);
  assert.deepEqual([...d.querySelectorAll('#management-menu a')].map(a=>a.dataset.viewLink),['company-team']);
  assert.ok(more.contains(d.getElementById('editor-link-notice')));
  dom.window.close();
});
test('more: one switch returns every section to its old place and back',()=>{
  const {dom,w,d}=setup();
  d.querySelector('[data-menu-settings]').click();const box=d.querySelector('[data-menu-show-all]');assert.equal(box.checked,false);
  box.click();
  assert.equal(d.querySelectorAll('#more-menu a.nav-link').length,0);assert.equal(d.querySelector('#more-category').hidden,true);
  assert.deepEqual(navOrder(d).filter(id=>id!=='hugh'),pristine().filter(id=>id!=='hugh'));
  assert.ok(!d.querySelector('.nav-empty'));
  assert.equal(JSON.parse(w.localStorage.getItem('sb-menu-v1:owner')).showAll,true);
  assert.equal(d.querySelector('[data-menu-show-all]').checked,true);
  d.querySelector('[data-menu-show-all]').click();
  assert.equal(d.querySelectorAll('#more-menu a.nav-link').length,18);
  assert.equal(d.querySelectorAll('[data-menu-show-all]').length,1);
  dom.window.close();
});
test('more: permissions still hide moved links; active moved link opens «Ещё»; live-only «Формы проектов» moves too',async()=>{
  const shell=fs.readFileSync(require.resolve('../cabinet.html'),'utf8').replace('<a class="nav-link" id="hugh-link"','<a class="nav-link" id="project-forms-link" href="#project-forms" data-view-link="project-forms" hidden>Формы проектов</a>\n      <a class="nav-link" id="hugh-link"');
  const dom=new JSDOM(shell,{url:'https://example.test',runScripts:'outside-only'});const w=dom.window,d=w.document;w.matchMedia=()=>({matches:false});
  w.eval(fs.readFileSync(require.resolve('./menu-preferences.js'),'utf8'));
  w.SbCabinet.initMenuPreferences({identity:{login:'owner'},setDrawer(){}});
  const forms=d.getElementById('project-forms-link');assert.equal(forms.parentElement.id,'more-menu');assert.equal(d.querySelectorAll('#more-menu a.nav-link').length,19);
  [...d.querySelectorAll('#more-menu a.nav-link')].forEach(a=>{a.hidden=true;});
  await new Promise(r=>w.setTimeout(r,0));assert.equal(d.querySelector('#more-category').hidden,true);
  const reviews=d.getElementById('reviews-link');reviews.hidden=false;reviews.setAttribute('aria-current','page');
  await new Promise(r=>w.setTimeout(r,0));
  assert.equal(d.querySelector('#more-category').hidden,false);assert.equal(d.querySelector('#more-menu').hidden,false);
  w.localStorage.setItem('sb-menu-v1:owner',JSON.stringify({showAll:true}));w.SbCabinet.initMenuPreferences({identity:{login:'owner'},setDrawer(){}});
  assert.equal(forms.parentElement.className,'nav');assert.equal(forms.nextElementSibling.id,'hugh-link');
  dom.window.close();
});
