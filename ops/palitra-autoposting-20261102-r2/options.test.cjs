'use strict';
// spec 049 · 02.11.2026: все параметры Onlypult в форме, наборы по умолчанию компании, понятные ошибки.
const test=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const Composer=require('./src/palitra-publication-composer.js');
const settle=async(n=5)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const ids=['telegram','vk','youtube_shorts','instagram','tiktok','max'];
const context={timezone:'Europe/Moscow',profileRevision:7,channels:ids.map(id=>({id,name:id,connected:true,enabled:true}))};
async function make(extra={}){const dom=new JSDOM('<main></main>',{url:'https://synapse.synapsebusiness.ru',pretendToBeVisual:true});const w=dom.window,d=w.document;const saved=[];
 const api=Composer.create({document:d,window:w,date:'2026-11-02',canApprove:true,readContext:async()=>context,uploadAsset:async()=>({url:'https://synapse.synapsebusiness.ru/content/publishing-assets/palitra-love/'+'a'.repeat(32)+'.jpg',sha256:'b'.repeat(64)}),
  saveDraft:async body=>{saved.push(body);return{id:90,revision:1,status:'draft'};},...extra});
 d.body.append(api.element);await settle();
 const q=sel=>api.element.querySelector(sel);
 const set=(name,value)=>{const el=q(`[name="${name}"]`);if(el.type==='checkbox')el.checked=value;else el.value=value;el.dispatchEvent(new w.Event(el.type==='checkbox'||el.tagName==='SELECT'?'change':'input',{bubbles:true}));};
 const attach=()=>{const input=q('[name="media"]');Object.defineProperty(input,'files',{configurable:true,value:[new w.File(['x'],'x.jpg',{type:'image/jpeg'})]});input.dispatchEvent(new w.Event('change',{bubbles:true}));};
 const submit=async()=>{q('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle(10);};
 return {dom,w,d,api,q,set,attach,submit,saved,close:()=>{api.dispose();dom.window.close();}};}
test('набор компании подставляется только в новую публикацию Палитры и виден в форме',async()=>{
 const p=await make({companyCode:'palitra-love'});try{assert.equal(p.q('[name="tiktokPrivacy"]').value,'PUBLIC_TO_EVERYONE');assert.match(p.q('[name="tiktokPrivacy"]').closest('label').textContent,/по умолчанию для компании/);}finally{p.close();}
 const other=await make({companyCode:'avokado'});try{assert.equal(other.q('[name="tiktokPrivacy"]').value,'');}finally{other.close();}
 const none=await make();try{assert.equal(none.q('[name="tiktokPrivacy"]').value,'');}finally{none.close();}
});
test('блок площадки виден только когда она отмечена; дополнительные поля свёрнуты',async()=>{
 const p=await make();try{
  const group=id=>p.q(`.palitra-composer-platform-options[data-platform="${id}"]`);
  assert.equal(group('telegram').hidden,true);p.set('platform-telegram',true);await settle();
  assert.equal(group('telegram').hidden,false);assert.equal(group('telegram').querySelector('details').open,false);
  assert.equal(group('vk').hidden,true);
 }finally{p.close();}
});
test('все параметры уходят в черновик в формате сервера; пробный Reels только для ролика',async()=>{
 const p=await make();try{
  p.set('title','Вымышленный');p.set('text','Текст');for(const id of ['telegram','vk','youtube_shorts','instagram','max'])p.set('platform-'+id,true);p.attach();await settle();
  p.set('telegram-pin_message','true');p.set('telegram-show_caption_above_media','true');p.set('telegram-poll_question','Какой букет?');p.set('telegram-poll_options','Розы\n\n Пионы ');p.set('telegram-poll_anonymous','false');
  p.set('telegram-delete_after_value','3');p.set('telegram-delete_after_unit','days');
  p.set('vk-disable_comment','true');p.set('vk-attachments_mode','grid');p.set('youtube_shorts-privacy','unlisted');p.set('max-pin_message','true');
  p.set('instagram-first_comment','  Ссылка в профиле ');p.set('instagram-graduation_strategy','MANUAL');
  await p.submit();
  assert.equal(p.saved.length,1,p.q('[role="alert"]')?.textContent);
  const o=p.saved[0].platformOptions;
  assert.deepEqual(o.telegram,{pin_message:true,show_caption_above_media:true,poll_question:'Какой букет?',poll_options:['Розы','Пионы'],poll_anonymous:false,delete_after_value:3,delete_after_unit:'days'});
  assert.deepEqual(o.vk,{disable_comment:true,attachments_mode:'grid'});assert.deepEqual(o.youtube_shorts,{privacy:'unlisted'});assert.deepEqual(o.max,{pin_message:true});
  assert.equal(o.instagram.first_comment,'Ссылка в профиле');assert.equal(Object.hasOwn(o.instagram,'graduation_strategy'),false,'для поста пробный Reels не отправляется');
 }finally{p.close();}
});
test('неполные опрос и автоудаление останавливают сохранение с понятной причиной',async()=>{
 for(const [fields,pattern] of [[{'telegram-poll_options':'А\nБ'},/вопрос опроса/],[{'telegram-poll_question':'В','telegram-poll_options':'Один'},/от 2 до 10/],[{'telegram-delete_after_value':'5'},/автоудаления/],[{'telegram-poll_question':'В','telegram-poll_options':'А\nА'},/повторяются/]]){
  const p=await make();try{p.set('title','Вымышленный');p.set('text','Текст');p.set('platform-telegram',true);p.attach();await settle();
   for(const [k,v] of Object.entries(fields))p.set(k,v);await p.submit();
   assert.equal(p.saved.length,0);assert.match(p.q('[role="alert"]').textContent,pattern);
   assert.equal(p.q('.palitra-composer-platform-options[data-platform="telegram"] details').open,true,'блок раскрыт к ошибке');}finally{p.close();}
 }
});
