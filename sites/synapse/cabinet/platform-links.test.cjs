'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));
const profile = code => ({companyCode:code,revision:1,profile:{name:code,timezone:'Asia/Irkutsk',websiteUrl:`https://${code}.example.test/`,socials:[
  {type:'two_gis',url:`https://2gis.ru/${code}`}, {type:'vk',url:`https://vk.com/${code}`},
  {type:'telegram',url:`https://t.me/${code}_chat`}, {type:'telegram_channel',url:`https://t.me/${code}_channel`}
],services:[],promotions:[],materials:[]},checks:[],history:[]});
function fixture(scripts = [], override) {
  const dom = new JSDOM('<p id="project-name">АЛВИ</p><section id="view"></section><section id="ad-platforms-content"></section>',{url:'https://cabinet.example.test/',runScripts:'outside-only'});
  const w=dom.window,d=w.document,views={},calls=[];
  w.SbCabinet={registerView:(name,view)=>{views[name]=view;}};
  ['platform-links.js',...scripts].forEach(file=>w.eval(fs.readFileSync(__dirname+'/'+file,'utf8')));
  const ctx={selectedProjectId:'alvi',currentView:'ad-platforms',identity:{role:'owner',permissions:['analytics.view','crm.view','crm.edit'],companies:[{id:'alvi',name:'АЛВИ'},{id:'avokado',name:'Авокадо'}]},
    byId:id=>d.getElementById(id),escapeHTML:value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    scopeParams:()=>({companyCode:ctx.selectedProjectId}),periodDates:()=>({from:'2026-09-01',to:'2026-09-17'}),
    csrfOptions:(method,body)=>({method,body:JSON.stringify(body)}),
    crmQuery:async(path,params)=>{calls.push({path,code:params.companyCode,method:'GET'});return {sourceStats:[]};},
    apiJson:async(url,options={})=>{
      const parsed=new URL(url,'https://cabinet.example.test/'),code=parsed.searchParams.get('companyCode');
      const call={path:parsed.pathname,code,method:options.method||'GET'};calls.push(call);
      if(override){const result=await override(call);if(result!==undefined)return clone(result);}
      if(call.path.endsWith('/company-information'))return profile(code);
      if(call.path.endsWith('/vk-community/settings'))return {companyCode:code,groupId:code==='alvi'?'123':'456',connected:true,configured:true,revision:1};
      if(call.path.endsWith('/autoposting/settings'))return {companyCode:code,channels:[{id:'vk',platform:'vk',provider:'onlypult',name:'VK',target:'provider-profile',connected:true,enabled:false,revision:1}]};
      if(call.path.endsWith('/autoposting/posts'))return {companyCode:code,posts:[]};
      if(call.path.endsWith('/autoposting/starter-plan'))return {companyCode:code,available:false};
      throw Error('Unexpected mock route '+call.path);
    }};
  return {w,d,ctx,views,calls,helper:w.SbCabinet.platformLinks,container:d.getElementById('view'),close:()=>w.close(),settle:async()=>{for(let i=0;i<5;i++)await tick();}};
}

test('only explicit safe HTTPS links are rendered; credential parameters and malformed URLs are never echoed',()=>{
  const f=fixture();try{
    for(const value of ['javascript:alert(1)','data:text/html,bad','http://vk.com/alvi','//vk.com/alvi','https:vk.com/alvi','https://user:secret@vk.com/alvi','https://vk.com/alvi?access_token=sentinel','https://vk.com/alvi?accessToken=sentinel','https://vk.com/alvi?api_key=sentinel','https://vk.com/#token=sentinel','https://vk.com/\nscript','https://vk.com\\evil','https://localhost/path']) {
      assert.equal(f.helper.safeUrl(value),null,value);assert.equal(f.helper.link(value,'Test'),'');
    }
    f.container.innerHTML=f.helper.link('https://example.test/public?utm_source=vk','<img src=x onerror=bad()>');
    const a=f.container.querySelector('a');assert.equal(a.target,'_blank');assert.equal(a.rel,'noopener noreferrer');
    assert.equal(a.textContent,'<img src=x onerror=bad()>');assert.equal(f.container.querySelector('img'),null);
  }finally{f.close();}
});

test('analytics aliases point to the correct official destinations without claiming a connection',()=>{
  const f=fixture();try{
    for(const [id,url] of [['2gis','https://account.2gis.com/'],['dgis','https://account.2gis.com/'],['yandex-maps','https://business.yandex.ru/'],['yandex-business','https://business.yandex.ru/'],['vk-ads','https://ads.vk.com/'],['yandex-rsya','https://direct.yandex.ru/'],['telegram_channel','https://web.telegram.org/'],['onlypult','https://app.ru.onlypult.com/']]) {
      f.container.innerHTML=f.helper.cabinetLink(id);assert.equal(f.container.querySelector('a').href,url);assert.doesNotMatch(f.container.textContent,/подключ|вход выполнен/i);
    }
    assert.equal(f.helper.cabinetLink('__proto__'),'');assert.equal(f.helper.cabinetLink('unverified-platform'),'');
    f.container.innerHTML=f.helper.cabinetLink('vk');assert.equal(f.container.textContent,'Открыть ВКонтакте');
  }finally{f.close();}
});

test('public links require matching company, preserve custom rows, and keep Telegram chat and channel separate',()=>{
  const f=fixture();try{
    const record=profile('alvi');record.profile.socials.push({type:'custom',label:'Ещё',url:'https://other.example.test/'},{type:'custom',label:'Другая',url:'https://other2.example.test/'},{type:'vk',url:'https://vk.com/?token=secret'});
    assert.equal(f.helper.companyLinks({companyCode:'avokado',record}),'');
    assert.equal(f.helper.companyLink({companyCode:'avokado',record,platform:'vk'}),'');
    f.container.innerHTML=f.helper.companyLinks({companyCode:'alvi',record});
    assert.equal(f.container.querySelectorAll('[data-platform-link="public"]').length,7);
    assert.doesNotMatch(f.container.innerHTML,/secret/);
    f.container.innerHTML=f.helper.companyLink({companyCode:'alvi',record,platform:'telegram_channel'});assert.equal(f.container.querySelector('a').href,'https://t.me/alvi_channel');
    f.container.innerHTML=f.helper.companyLink({companyCode:'alvi',record,platform:'telegram'});assert.equal(f.container.querySelector('a').href,'https://t.me/alvi_chat');
  }finally{f.close();}
});

test('community shortcut requires verified matching settings and an exact numeric group ID',()=>{
  const f=fixture();try{
    for(const record of [{companyCode:'avokado',connected:true,groupId:123},{companyCode:'alvi',connected:false,groupId:123},{companyCode:'alvi',connected:true,groupId:'123?token=secret'},{companyCode:'alvi',connected:true,groupId:'-123'}])assert.equal(f.helper.vkCommunityLink({companyCode:'alvi',record}),'');
    f.container.innerHTML=f.helper.vkCommunityLink({companyCode:'alvi',record:{companyCode:'alvi',connected:true,groupId:123}});
    assert.equal(f.container.querySelector('a').href,'https://vk.com/club123');
  }finally{f.close();}
});

test('advertising cards expose official shortcuts while remaining manual and read-only',async()=>{
  const f=fixture(['analytics.js','ad-platforms.js']);try{
    f.views['ad-platforms'].render(f.d.getElementById('ad-platforms-content'),f.ctx);await f.settle();
    const card=f.d.querySelector('button[data-platform="vk"]').closest('.platform-status-item');
    assert.ok(card.querySelector('a[href="https://vk.com/"]'));assert.ok(card.querySelector('a[href="https://ads.vk.com/"]'));assert.match(card.textContent,/Нет ручного снимка/);
    assert.ok(f.d.querySelector('a[href="https://account.2gis.com/"]'));assert.ok(f.calls.every(c=>c.method==='GET'));
  }finally{f.close();}
});

test('company-information shows saved links, clears them immediately on switch and rejects late prior-company links',async()=>{
  let resolveNext;
  const f=fixture(['company-information.js'],call=>call.code==='avokado'?new Promise(resolve=>{resolveNext=resolve;}):undefined);
  try{
    await f.views['company-information'].render(f.container,f.ctx);
    const list=f.d.getElementById('information-platform-link-list');assert.ok(list.querySelector('a[href="https://alvi.example.test/"]'));
    const input=f.d.querySelector('#information-socials [data-row-field="url"]');input.value='https://unsaved.example.test/';input.dispatchEvent(new f.w.Event('input',{bubbles:true}));assert.doesNotMatch(list.innerHTML,/unsaved/);
    const next=f.views['company-information'].onProjectChange({...f.ctx,selectedProjectId:'avokado'});await f.settle();assert.equal(list.children.length,0);
    await f.views['company-information'].onProjectChange(f.ctx);resolveNext(profile('avokado'));await next;
    assert.ok(list.querySelector('a[href="https://alvi.example.test/"]'));assert.doesNotMatch(list.innerHTML,/avokado/);assert.ok(f.calls.every(c=>c.method==='GET'));
  }finally{f.close();}
});

test('VK view removes the old community link before the next company settings arrive',async()=>{
  let release;
  const f=fixture(['vk-community.js'],call=>call.code==='avokado'&&call.path.endsWith('/vk-community/settings')?new Promise(resolve=>{release=resolve;}):undefined);
  try{
    await f.views['vk-community'].render(f.container,f.ctx);assert.ok(f.d.querySelector('#vk-platform-links a[href="https://vk.com/club123"]'));
    const next=f.views['vk-community'].onProjectChange({...f.ctx,selectedProjectId:'avokado'});await f.settle();assert.equal(f.d.querySelector('a[href="https://vk.com/club123"]'),null);
    release({companyCode:'avokado',connected:true,configured:true,groupId:456,revision:1});await next;
    assert.ok(f.d.querySelector('#vk-platform-links a[href="https://vk.com/club456"]'));assert.ok(f.calls.every(c=>c.method==='GET'));
  }finally{f.close();}
});

test('autoposting separates company pages, provider cabinet and planning; switching clears old external links',async()=>{
  let release;
  const f=fixture(['company-information.js','autoposting.js'],call=>call.code==='avokado'&&call.path.endsWith('/company-information')?new Promise(resolve=>{release=resolve;}):undefined);
  try{
    await f.views.autoposting.render(f.container,f.ctx);
    assert.ok(f.d.querySelector('[data-channel-links] a[href="https://vk.com/alvi"]'));assert.ok(f.d.querySelector('[data-channel="vk"] a[href="https://app.ru.onlypult.com/"]'));
    assert.ok(f.d.querySelector('#autoposting-planning a[href="https://account.2gis.com/"]'));
    const next=f.views.autoposting.onProjectChange({...f.ctx,selectedProjectId:'avokado'});await f.settle();
    assert.equal(f.d.querySelector('[data-channel-links] a'),null);assert.equal(f.d.getElementById('autoposting-planning').children.length,0);
    release(profile('avokado'));await next;assert.ok(f.d.querySelector('[data-channel-links] a[href="https://vk.com/avokado"]'));assert.ok(f.calls.every(c=>c.method==='GET'));
  }finally{f.close();}
});
