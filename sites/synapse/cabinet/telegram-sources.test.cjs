const test=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {mount}=require('./telegram-sources');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('список исходников показывает ручной импорт и выключенный режим; чужие URL/XSS не исполняются',async()=>{
  const dom=new JSDOM('<div id="root"></div>',{url:'https://cabinet.example/'}),element=dom.window.document.querySelector('#root');
  const api=mount({element,companyCode:'palitra-love',request:async()=>({enabled:false,items:[{id:1,name:'<script>evil()</script>',caption:'<img src=x onerror=evil()>',status:'manual_import',size:65700000,reason:'Файл больше 20 МБ',telegramUrl:'https://t.me/c/111/1',fileUrl:'/content/telegram-sources/alvi/1/file'},
    {id:2,name:'saved.png',status:'stored',fileUrl:'/content/telegram-sources/palitra-love/2/file',telegramUrl:'javascript:evil()'}]})});
  await tick();assert.match(element.textContent,/Нужен ручной импорт/);assert.match(element.textContent,/выключен/);assert.match(element.textContent,/65,7|62,7/);
  assert.equal(element.querySelectorAll('img,script').length,0);assert.equal(element.querySelectorAll('a').length,2);
  assert.equal(element.querySelector('a').getAttribute('href'),'https://t.me/c/111/1');
  assert.ok([...element.querySelectorAll('a')].every(x=>!x.href.includes('alvi')&&!x.href.startsWith('javascript:')));api.destroy();dom.window.close();
});
test('смена проекта отбрасывает запоздалые исходники предыдущей компании',async()=>{
  const dom=new JSDOM('<div id="root"></div>'),element=dom.window.document.querySelector('#root');let finish;
  const first=mount({element,companyCode:'palitra-love',request:()=>new Promise(resolve=>finish=resolve)});first.destroy();
  const next=mount({element,companyCode:'alvi',request:async()=>({enabled:true,items:[]})});await tick();finish({enabled:true,items:[{name:'Чужой файл',status:'text'}]});await tick();
  assert.doesNotMatch(element.textContent,/Чужой файл/);assert.match(element.textContent,/Сохранённых исходников пока нет/);next.destroy();dom.window.close();
});
test('ошибка загрузки даёт повтор без потери уже полученной страницы',async()=>{
  const dom=new JSDOM('<div id="root"></div>'),element=dom.window.document.querySelector('#root');let attempts=0;
  const api=mount({element,companyCode:'palitra-love',request:async()=>{if(!attempts++)throw Error('offline');return {enabled:true,items:[{name:'Получено',status:'text'}]};}});
  await tick();assert.match(element.textContent,/Не удалось/);[...element.querySelectorAll('button')].find(x=>x.textContent==='Повторить загрузку').click();await tick();assert.match(element.textContent,/Получено/);api.destroy();dom.window.close();
});

test('owner-форма разделяет ссылку и ручное происхождение, показывает дубль и не публикует',async()=>{
  const dom=new JSDOM('<div id="root"></div>',{url:'https://cabinet.example'}),element=dom.window.document.querySelector('#root'),calls=[];
  const data={enabled:true,manualUploadAllowed:true,manualMaxBytes:256*1024*1024,sources:[{chatId:'-100111'}],items:[{name:'old.MOV',status:'stored',importMethod:'manual_archive',provenance:'Старая беседа <script>',telegramUrl:null}]};
  const api=mount({element,companyCode:'palitra-love',request:async()=>data,upload:async(url,body)=>{calls.push({url,body});return {duplicate:true};}});await tick();
  const form=element.querySelector('form'),file=form.querySelector('[type=file]'),mode=form.querySelector('select');
  assert.equal(form.hidden,false);assert.match(form.textContent,/не автоматическая/);assert.match(element.textContent,/без ссылки на сообщение/);assert.equal(element.querySelector('script'),null);
  Object.defineProperty(file,'files',{value:[new dom.window.File(['MOV'],'archive.MOV',{type:'video/quicktime'})]});
  mode.value='archive';mode.dispatchEvent(new dom.window.Event('change'));
  form.querySelector('textarea').value='История до миграции; дата; archive.MOV';
  form.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await tick();await tick();
  assert.equal(calls.length,1);assert.equal(calls[0].url,'/content/telegram-sources/palitra-love/manual-upload');
  assert.equal(calls[0].body.get('telegramUrl'),null);assert.equal(calls[0].body.get('sourceChatId'),'-100111');assert.equal(calls[0].body.get('provenance'),'История до миграции; дата; archive.MOV');
  assert.match(form.textContent,/Повтор не создан/);api.destroy();dom.window.close();
});

test('ручная форма скрыта у сотрудника; большой файл не отправляется; поздний результат после destroy не появляется',async()=>{
  const dom=new JSDOM('<div id="root"></div>'),element=dom.window.document.querySelector('#root');let uploads=0,finish;
  const denied=mount({element,companyCode:'palitra-love',request:async()=>({items:[],manualUploadAllowed:false}),upload:async()=>{uploads++;}});await tick();assert.equal(element.querySelector('form').hidden,true);denied.destroy();
  const api=mount({element,companyCode:'palitra-love',request:async()=>({items:[],manualUploadAllowed:true,manualMaxBytes:4,sources:[{chatId:'-100111'}]}),upload:()=>{uploads++;return new Promise(resolve=>finish=resolve);}});await tick();
  const form=element.querySelector('form'),file=form.querySelector('[type=file]');
  Object.defineProperty(file,'files',{configurable:true,value:[new dom.window.File(['12345'],'old.MOV')]});form.dispatchEvent(new dom.window.Event('submit'));await tick();assert.equal(uploads,0);assert.match(form.textContent,/превышает/);
  Object.defineProperty(file,'files',{value:[new dom.window.File(['123'],'old.MOV')]});form.querySelector('[type=url]').value='https://t.me/c/111/1';form.dispatchEvent(new dom.window.Event('submit'));await tick();assert.equal(uploads,1);
  api.destroy();element.textContent='Другая компания';finish({duplicate:false});await tick();assert.equal(element.textContent,'Другая компания');dom.window.close();
});
