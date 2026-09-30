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
