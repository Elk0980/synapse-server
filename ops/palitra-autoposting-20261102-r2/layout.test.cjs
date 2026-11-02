'use strict';
// spec 049 · 2026-11-02: порядок формы «сначала контент, потом площадки» и один открытый предпросмотр.
const test=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const Composer=require('./src/palitra-publication-composer.js');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const ids=['telegram','vk','youtube_shorts','instagram','tiktok'];
const context={timezone:'Europe/Moscow',profileRevision:7,channels:ids.map(id=>({id,name:id,connected:true,enabled:true}))};
async function make(){const dom=new JSDOM('<main></main>',{url:'https://synapse.synapsebusiness.ru',pretendToBeVisual:true});const w=dom.window,d=w.document;
 const api=Composer.create({document:d,window:w,date:'2026-11-02',canApprove:true,readContext:async()=>context,uploadAsset:async()=>{throw Error('x');},saveDraft:async()=>{throw Error('x');}});
 d.body.append(api.element);for(let i=0;i<5;i++)await settle();return {dom,w,d,api};}
test('порядок: название, текст, файлы, площадки, дополнительные настройки, публикация',async()=>{const f=await make();try{
 const form=f.api.element.querySelector('form'),kids=[...form.children];
 const at=sel=>kids.findIndex(n=>n.matches(sel)||n.querySelector(sel));
 const order=['[name="title"]','[name="text"]','[name="media"]','.palitra-composer-channels','details.palitra-composer-advanced','[name="publicationStatus"]'].map(at);
 const adv=f.api.element.querySelector('details.palitra-composer-advanced');assert.equal(adv.open,false);for(const name of ['format','timezone','date'])assert.ok(adv.contains(f.api.element.querySelector(`[name="${name}"]`)),name);
 assert.ok(order.every(i=>i>=0),JSON.stringify(order));
 assert.deepEqual([...order].sort((a,b)=>a-b),order);
}finally{f.api.dispose();f.dom.window.close();}});
test('отмеченная площадка раскрывает свой предпросмотр и закрывает остальные',async()=>{const f=await make();try{
 const box=id=>f.api.element.querySelector(`[name="platform-${id}"]`);
 const open=()=>[...f.api.element.querySelectorAll('.palitra-composer-details')].filter(d=>d.open).length;
 for(const id of ids){box(id).checked=true;box(id).dispatchEvent(new f.w.Event('change',{bubbles:true}));}
 for(let i=0;i<3;i++)await settle();
 assert.equal(open(),1);
 assert.equal(box('tiktok').closest('.palitra-composer-channel').querySelector('details').open,true);
 const vk=box('vk').closest('.palitra-composer-channel').querySelector('details');vk.open=true;vk.dispatchEvent(new f.w.Event('toggle'));
 for(let i=0;i<3;i++)await settle();
 assert.equal(open(),1);assert.equal(vk.open,true);
 assert.ok(ids.every(id=>box(id).checked),'отметки площадок не снимаются');
}finally{f.api.dispose();f.dom.window.close();}});
test('аудитория TikTok видна сразу при отмеченном TikTok; видео-пост уходит как Reels',async()=>{const f=await make();try{
 const box=f.api.element.querySelector('[name="platform-tiktok"]'),req=f.api.element.querySelector('.palitra-composer-required');
 assert.equal(req.hidden,true);box.checked=true;box.dispatchEvent(new f.w.Event('change',{bubbles:true}));for(let i=0;i<3;i++)await settle();
 assert.equal(req.hidden,false);assert.ok(req.querySelector('[name="tiktokPrivacy"]'));assert.equal(f.api.element.querySelector('details.palitra-composer-advanced').contains(req),false);
}finally{f.api.dispose();f.dom.window.close();}});
