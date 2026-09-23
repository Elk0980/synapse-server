const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const source = fs.readFileSync(__dirname + '/track.js','utf8');

test('served studio pages load the updated tracker once, including direct price and contacts entries',()=>{
  for(const [company,pages]of [['alvi',['index.html']],['avokado3',['index.html','price.html','contacts.html']]]) {
    for(const page of pages) {
      const html=fs.readFileSync(__dirname+'/../'+company+'/'+page,'utf8');
      const dom=new JSDOM(html);
      try {
        const scripts=[...dom.window.document.scripts];
        const trackers=scripts.filter(script=>script.src.includes('/track.js'));
        assert.equal(trackers.length,1,company+'/'+page);
        assert.equal(trackers[0].dataset.company,company==='avokado3'?'avokado':company);
        assert.ok(trackers[0].src.endsWith('?v=20260924-booking'));
        for(const script of scripts.filter(script=>script.src.includes('callback.js')))assert.ok(script.src.endsWith('?v=20260924-attribution'));
      } finally {dom.window.close();}
    }
  }
});

function fixture(company='alvi',dnt=false) {
  const dom=new JSDOM('<script data-company="'+company+'"></script><a id="booking" href="https://n1070017.yclients.com/?o=s123">Запись</a><a id="fake" href="https://yclients.com.example.test/">Чужой сайт</a>',{
    url:'https://example.test/?utm_source=vk&utm_medium=social&utm_campaign=three-days&utm_content=day-1',runScripts:'outside-only'
  });
  const w=dom.window,events=[];
  Object.defineProperty(w.document,'currentScript',{value:w.document.querySelector('script')});
  Object.defineProperty(w.navigator,'doNotTrack',{value:dnt?'1':'0'});
  w.fetch=async (url,options)=>{assert.equal(url,'/track');events.push(JSON.parse(options.body));return {ok:true};};
  w.eval(source);
  return {dom,events,click(id){w.document.getElementById(id).dispatchEvent(new w.MouseEvent('click',{bubbles:true}));}};
}

test('Yclients produces a booking intent with the same campaign and visitor, never a completed booking',()=>{
  for(const company of ['alvi','avokado']) {
    const f=fixture(company);
    try {
      f.click('booking');f.click('fake');
      assert.equal(f.events.length,2);
      const [visit,click]=f.events;
      assert.equal(click.type,'click');assert.equal(click.target,'booking');assert.equal(click.companyCode,company);
      assert.equal(click.clientId,visit.clientId);assert.equal(click.utmContent,'day-1');
      assert.equal(click.utmCampaign,'three-days');assert.equal(click.utmSource,'vk');
      assert.equal(click.contact,undefined);assert.equal(click.amount,undefined);
      assert.equal(f.dom.window.document.getElementById('booking').getAttribute('href'),'https://n1070017.yclients.com/?o=s123');
    } finally {f.dom.window.close();}
  }
});

test('DoNotTrack and unsupported company produce no events or identifier',()=>{
  for(const [company,dnt]of [['alvi',true],['taisabai',false]]) {
    const f=fixture(company,dnt);
    try {f.click('booking');assert.deepEqual(f.events,[]);assert.equal(f.dom.window.localStorage.getItem('synapse_cid'),null);}
    finally {f.dom.window.close();}
  }
});

test('Yclients ru domains count as booking intents but suffix lookalikes do not',()=>{
  const f=fixture();
  try {
    const link=f.dom.window.document.getElementById('booking');
    for(const host of ['yclients.ru','n1070017.yclients.ru']) {
      link.setAttribute('href','https://'+host+'/');
      f.click('booking');
      assert.equal(f.events.at(-1).target,'booking');
    }
    assert.equal(f.events.length,3);
    link.setAttribute('href','https://yclients.ru.evil.test/');
    f.click('booking');
    assert.equal(f.events.length,3);
  } finally {f.dom.window.close();}
});
