'use strict';
// 03.11.2026: пост 833 ушёл в Instagram с фото 600×800 из веб-версии Telegram и выглядел мутно. Форма больше не принимает фото уже 1080 пикселей.
const test=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const Composer=require('./src/palitra-publication-composer.js');
const settle=async(n=8)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const ids=['telegram','vk','youtube_shorts','instagram','tiktok','max'];
const context={timezone:'Europe/Moscow',profileRevision:7,channels:ids.map(id=>({id,name:id,connected:true,enabled:true}))};
async function make(sizes){const dom=new JSDOM('<main></main>',{url:'https://synapse.synapsebusiness.ru',pretendToBeVisual:true});const w=dom.window,d=w.document;
 let n=0;w.URL.createObjectURL=()=>'blob:https://synapse.synapsebusiness.ru/'+(++n);w.URL.revokeObjectURL=()=>{};
 if(sizes)w.createImageBitmap=async file=>({...sizes[file.name],close(){}});
 const api=Composer.create({document:d,window:w,date:'2026-11-03',canApprove:true,readContext:async()=>context,uploadAsset:async()=>({url:'https://synapse.synapsebusiness.ru/content/publishing-assets/palitra-love/'+'a'.repeat(32)+'.jpg',sha256:'b'.repeat(64)}),saveDraft:async()=>({id:90,revision:1,status:'draft'})});
 d.body.append(api.element);await settle();
 const attach=async names=>{const input=api.element.querySelector('[name="media"]');Object.defineProperty(input,'files',{configurable:true,value:names.map(n=>new w.File(['x'],n,{type:'image/jpeg'}))});input.dispatchEvent(new w.Event('change',{bubbles:true}));await settle();};
 return{api,attach,text:()=>api.element.textContent,close(){api.dispose();dom.window.close();}};}
test('фото уже 1080 пикселей не принимается и объяснено, что делать',async()=>{const f=await make({'tg.jpg':{width:600,height:800},'ok.jpg':{width:1080,height:1350}});try{await f.attach(['ok.jpg','tg.jpg']);assert.match(f.text(),/Фото «tg\.jpg» слишком маленькое: 600×800/);assert.match(f.text(),/оригинал из галереи телефона/);assert.doesNotMatch(f.text(),/ok\.jpg ·/);}finally{f.close();}});
test('фото от 1080 пикселей принимаются',async()=>{const f=await make({'a.jpg':{width:1080,height:1350},'b.jpg':{width:3024,height:4032}});try{await f.attach(['a.jpg','b.jpg']);assert.doesNotMatch(f.text(),/слишком маленькое/);assert.match(f.text(),/a\.jpg/);assert.match(f.text(),/b\.jpg/);}finally{f.close();}});
test('без возможности измерить фото форма работает как раньше',async()=>{const f=await make(null);try{await f.attach(['x.jpg']);assert.doesNotMatch(f.text(),/слишком маленькое/);assert.match(f.text(),/x\.jpg/);}finally{f.close();}});
