const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const source = fs.readFileSync(__dirname + '/callback.js', 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(fetch, url = 'https://spaalvi-38.ru/?utm_source=vk') {
  const dom = new JSDOM(html.match(/<form class="callback-form"[\s\S]*?<\/form>/)[0], {
    url,runScripts:'outside-only'
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

test('callback joins the existing visit and preserves all saved campaign fields after navigation', async () => {
  let body;
  const f=fixture(async(_,options)=>{body=JSON.parse(options.body);return {ok:true,status:201,json:async()=>({id:5})};}, 'https://spaalvi-38.ru/?unrelated=private');
  try {
    const w=f.dom.window;
    w.localStorage.setItem('synapse_cid','existing-visitor');
    w.localStorage.setItem('synapse_ft',JSON.stringify({ts:Date.now(),source:'vk',utmSource:'vk',utmMedium:'social',utmCampaign:'three-days',utmContent:'day-1',utmTerm:'spa'}));
    await f.submit();
    assert.equal(body.clientId,'existing-visitor');assert.equal(body.source,'vk');
    assert.equal(body.utmSource,'vk');assert.equal(body.utmMedium,'social');assert.equal(body.utmCampaign,'three-days');
    assert.equal(body.utmContent,'day-1');assert.equal(body.utmTerm,'spa');
    assert.ok(!JSON.stringify(body).includes('private'));
  } finally {f.dom.window.close();}
});

test('new UTM replaces old campaign; expired, future, denied and DNT storage cannot restore attribution', async () => {
  for (const mode of ['new','expired','future','denied','dnt']) {
    let body;
    const f=fixture(async(_,options)=>{body=JSON.parse(options.body);return {ok:true,status:201,json:async()=>({id:5})};},
      'https://spaalvi-38.ru/' + (mode==='new'?'?utm_source=yandex&utm_content=day-2':''));
    try {
      const w=f.dom.window;
      w.localStorage.setItem('synapse_cid','existing-visitor');
      w.localStorage.setItem('synapse_ft',JSON.stringify({ts:Date.now()+(mode==='future'?86400000:mode==='expired'?-31*86400000:0),source:'vk',utmSource:'vk',utmMedium:'old-medium'}));
      if(mode==='denied')Object.defineProperty(w,'localStorage',{get(){throw Error('denied');}});
      if(mode==='dnt')Object.defineProperty(w.navigator,'doNotTrack',{value:'1'});
      await f.submit();
      assert.equal(body.utmSource,mode==='new'?'yandex':undefined);
      assert.equal(body.utmMedium,undefined);
      if(['denied','dnt'].includes(mode))assert.equal(body.clientId,undefined);
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
