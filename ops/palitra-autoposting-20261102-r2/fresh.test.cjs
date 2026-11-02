'use strict';
// 02.11.2026: уведомление «Вышло» в приложении и тихое обновление дня.
const test=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const Tasks=require('./src/palitra-content-tasks-ui.js');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const now=new Date();const today=now.toISOString().slice(0,10);
const pub=(key,postId,url,ago=600000)=>({postId,revision:3,contentRevision:2,title:'Тест',excerpt:'',format:'reel',key,basis:'confirmed-delivery',at:new Date(Date.now()-ago).toISOString(),url,publishedContentRevision:2,copyable:false,copyUnavailableReason:'payload-not-recorded'});
const day=channels=>({schema:'palitra-content-day/v1',companyCode:'palitra-love',date:today,today,timezone:'Europe/Moscow',actorScope:'palitra-love:1',coverage:{complete:true,unknownDateCount:0},capabilities:{duplicateDraft:false},channels});
const ch=(id,name,published)=>({id,platform:id,name,connected:true,enabled:true,published,planned:[]});
async function open(value,companyCode){const dom=new JSDOM('',{url:'https://synapse.synapsebusiness.ru',pretendToBeVisual:true});const w=dom.window;w.HTMLElement.prototype.scrollTo=function(){};
 let reads=0;const api=Tasks.create({document:w.document,window:w,companyCode,read:async()=>{reads++;return typeof value==='function'?value(reads):value;}});w.document.body.append(api.element);await settle();await settle();
 return {w,api,reads:()=>reads,close(){api.dispose();dom.window.close();}};}
test('вышедшая публикация видна наверху: ссылка на пост, иначе страница площадки',async()=>{
 const f=await open(day([ch('vk','ВКонтакте',[pub('d:1:vk',75,null)]),ch('youtube_shorts','YouTube Shorts',[pub('d:1:yt',75,'https://www.youtube.com/shorts/aaaaaaaaaaa')]),ch('telegram','Telegram',[pub('d:1:tg',75,null)])]));
 try{const box=f.api.element.querySelector('.content-day__fresh');assert.ok(box,'есть уведомление');assert.match(box.textContent,/Вышло/);assert.equal(box.querySelectorAll('.content-day__fresh-post').length,1,'одна карточка на материал');
  const links=[...box.querySelectorAll('a')].map(a=>[a.textContent,a.href]);
  assert.deepEqual(links,[['Открыть страницу','https://vk.com/club241948768'],['Открыть публикацию','https://www.youtube.com/shorts/aaaaaaaaaaa'],['Открыть страницу','https://t.me/palitralovee']]);
  [...box.querySelectorAll('button')].find(b=>b.textContent==='Скрыть').click();
  assert.equal(f.api.element.querySelector('.content-day__fresh'),null,'скрытое не возвращается');
 }finally{f.close();}
});
test('старые и чужого дня публикации уведомление не создают',async()=>{
 const f=await open(day([ch('vk','ВКонтакте',[pub('d:2:vk',80,null,13*3600000)])]));
 try{assert.equal(f.api.element.querySelector('.content-day__fresh'),null);}finally{f.close();}
});

test('03.11.2026: раздел работает для Алви: свой день принимается, чужой — нет, страниц Палитры нет',async()=>{
 const alviDay=v=>({...day([ch('vk','ВКонтакте',[pub('d:9:vk',90,null)])]),companyCode:v});
 let f=await open(alviDay('alvi'),'alvi');
 try{const box=f.api.element.querySelector('.content-day__fresh');assert.ok(box);assert.match(box.textContent,/ВКонтакте · \d\d:\d\d · ссылка недоступна/);assert.equal(box.querySelectorAll('a').length,0);}finally{f.close();}
 f=await open(alviDay('palitra-love'),'alvi');
 try{assert.equal(f.api.element.querySelector('.content-day__fresh'),null,'день другой компании не показывается');}finally{f.close();}
});
