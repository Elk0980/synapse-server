const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const script=fs.readFileSync(require.resolve('./company-team.js'),'utf8');
test('форма отправляет фиксированную роль и текущую компанию, без произвольных прав',async()=>{
  const dom=new JSDOM('<main id="company-team-view"></main>',{runScripts:'outside-only'}),w=dom.window;
  try {
    let view;const calls=[];
    w.SbCabinet={registerView:(id,v)=>{view=v;}};w.eval(script);
    const ctx={selectedProjectId:'alvi',identity:{role:'editor',permissions:['team.manage'],csrfToken:'test'},escapeHTML:s=>String(s).replaceAll('<','&lt;'),apiJson:async(path,options)=>{calls.push({path,options});return {members:[]};}};
    const c=w.document.querySelector('main');await view.render(c,ctx);
    const f=c.querySelector('form');f.elements.login.value='new_master';f.elements.displayName.value='Мастер';f.elements.password.value='Example-Password-42';f.elements.confirmation.value='Example-Password-42';
    f.dispatchEvent(new w.Event('submit',{cancelable:true}));await new Promise(setImmediate);
    const sent=calls.find(x=>x.options?.method==='POST');assert.ok(sent);const body=JSON.parse(sent.options.body);
    assert.equal(body.companyCode,'alvi');assert.equal(body.staffRole,'master');assert.equal(body.permissions,undefined);assert.equal(body.role,undefined);
    assert.equal(sent.options.headers['X-CSRF-Token'],'test');assert.equal(f.elements.password.value,'');
    assert.match(c.textContent,/Сотрудник добавлен/);
    ctx.selectedProjectId='avokado';f.dispatchEvent(new w.Event('submit',{cancelable:true}));await new Promise(setImmediate);
    assert.equal(calls.filter(x=>x.options?.method==='POST').length,1);
  }finally{w.close();}
});
test('пользователь без team.manage не получает форму',async()=>{
  const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window;
  try{let view;w.SbCabinet={registerView:(id,v)=>view=v};w.eval(script);await view.render(w.document.querySelector('main'),{selectedProjectId:'alvi',identity:{role:'editor',permissions:[]}});assert.equal(w.document.querySelector('form'),null);}finally{w.close();}
});
