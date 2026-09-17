const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const source = fs.readFileSync(__dirname + '/callback.js', 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(fetch) {
  const dom = new JSDOM(html.match(/<form class="callback-form"[\s\S]*?<\/form>/)[0], {
    url:'https://spaalvi-38.ru/?utm_source=vk',runScripts:'outside-only'
  });
  const w=dom.window, form=w.document.querySelector('form');
  w.fetch=fetch;w.eval(source);
  form.elements.name.value='Анна';form.elements.phone.value='+7 999 123-45-67';form.elements.consent.checked=true;
  form.dispatchEvent(new w.Event('input',{bubbles:true}));
  return {dom,form,async submit(){form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle();}};
}
test('ALVI sends the optional multiline comment with the callback and preserves the empty-comment flow',async()=>{
  for(const value of ['  Интересует программа для двоих.\nПерезвонить после 18:00.  ','']) {
    let body;
    const f=fixture(async(url,options)=>{assert.equal(url,'/api/leads');body=JSON.parse(options.body);return {ok:true,status:201,json:async()=>({id:5})};});
    try {
      assert.equal(f.form.elements.comment.disabled,true);
      assert.equal(f.form.querySelector('.callback-form__comment').hidden,true);
      if(value)f.form.elements.addComment.click();
      f.form.elements.comment.value=value;await f.submit();
      assert.equal(body.companyCode,'alvi');assert.equal(body.source,'vk');
      assert.equal(body.comment,value.trim()||'Просьба перезвонить клиенту');
      assert.ok(f.form.classList.contains('is-success'));
    } finally {f.dom.window.close();}
  }
});
test('ALVI keeps the comment after a failed or duplicate request and rejects oversize input without sending',async()=>{
  for(const duplicate of [false,true]) {
    let calls=0;
    const f=fixture(async()=>{calls++;if(!duplicate)throw Error('network');return {ok:true,status:200,json:async()=>({id:5,deduplicated:true})};});
    try {
      f.form.elements.addComment.click();
      assert.equal(f.form.querySelector('.callback-form__comment').hidden,false);
      f.form.elements.comment.value='я'.repeat(1001);await f.submit();assert.equal(calls,0);
      assert.match(f.form.textContent,/1000/);
      f.form.elements.comment.value='Удобно после 18:00';await f.submit();
      assert.equal(calls,1);assert.equal(f.form.elements.comment.value,'Удобно после 18:00');
      assert.equal(f.form.elements.comment.disabled,false);assert.ok(!f.form.classList.contains('is-success'));
      assert.match(f.form.querySelector('[role=status]').textContent,duplicate?/уже есть/:/Не удалось подтвердить/);
      f.form.elements.addComment.click();
      assert.equal(f.form.querySelector('.callback-form__comment').hidden,true);
      assert.equal(f.form.elements.comment.value,'Удобно после 18:00');
      f.form.elements.addComment.click();assert.equal(f.form.elements.comment.disabled,false);
    } finally {f.dom.window.close();}
  }
});
