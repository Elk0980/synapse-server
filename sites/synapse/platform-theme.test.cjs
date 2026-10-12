'use strict';
// Тема интерфейса платформы: системная по умолчанию, ручной выбор, сохранение, смена системной темы
// без перезагрузки, недопустимое значение и запрещённое хранилище.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const SOURCE=fs.readFileSync(path.join(__dirname,'platform-theme.js'),'utf8');
const SHELL=fs.readFileSync(path.join(__dirname,'cabinet.html'),'utf8');
const PAGE=`<!doctype html><html lang="ru"><head><meta name="theme-color" content="#0b0908"><meta name="color-scheme" content="dark"></head>
<body><label>Тема<select data-sb-theme-select><option value="system">Как в системе</option><option value="light">Светлая</option><option value="dark">Тёмная</option></select></label></body></html>`;

function systemScheme(dark){
  const listeners=new Set();
  return {get matches(){return dark;},media:'(prefers-color-scheme: dark)',
    addEventListener:(type,listener)=>{if(type==='change')listeners.add(listener);},removeEventListener:(type,listener)=>listeners.delete(listener),
    flip(next){dark=next;listeners.forEach(listener=>listener({matches:dark}));}};
}
function open({dark=false,stored,blockStorage=false,media=systemScheme(dark)}={}){
  const dom=new JSDOM(PAGE,{url:'https://synapse.example.test/cabinet.html',runScripts:'outside-only'});
  const w=dom.window;
  if(stored!==undefined)w.localStorage.setItem('sb-theme',stored);
  if(blockStorage)Object.defineProperty(w,'localStorage',{configurable:true,get(){throw new w.DOMException('Хранилище запрещено','SecurityError');}});
  w.matchMedia=query=>{assert.equal(query,'(prefers-color-scheme: dark)');return media;};
  w.eval(SOURCE);
  const root=w.document.documentElement,select=w.document.querySelector('[data-sb-theme-select]');
  return {w,dom,media,root,select,
    theme:()=>root.dataset.theme,
    choose(value){select.value=value;select.dispatchEvent(new w.Event('change',{bubbles:true}));},
    meta:name=>w.document.querySelector(`meta[name="${name}"]`).content,close:()=>w.close()};
}

test('по умолчанию тема берётся из системы и переключается без перезагрузки',()=>{
  const light=open({dark:false});try{
    assert.equal(light.theme(),'light');assert.equal(light.root.dataset.themePreference,'system');
    assert.equal(light.select.value,'system');assert.equal(light.meta('color-scheme'),'light');
    light.media.flip(true);
    assert.equal(light.theme(),'dark');assert.equal(light.meta('color-scheme'),'dark');assert.equal(light.meta('theme-color'),'#0b0908');
  }finally{light.close();}
  const dark=open({dark:true});try{assert.equal(dark.theme(),'dark');assert.equal(dark.w.localStorage.getItem('sb-theme'),null);}finally{dark.close();}
});

test('ручной выбор применяется сразу, сохраняется между страницами и не меняется вслед за системой',()=>{
  const first=open({dark:true});let saved;try{
    first.choose('light');
    assert.equal(first.theme(),'light');assert.equal(first.w.SbTheme.preference,'light');
    saved=first.w.localStorage.getItem('sb-theme');assert.equal(saved,'light');
    first.media.flip(false);first.media.flip(true);
    assert.equal(first.theme(),'light','ручной выбор важнее системной темы');
  }finally{first.close();}
  const next=open({dark:true,stored:saved});try{
    assert.equal(next.theme(),'light','следующая страница сразу открывается в выбранной теме');assert.equal(next.select.value,'light');
    next.choose('system');
    assert.equal(next.theme(),'dark');assert.equal(next.w.localStorage.getItem('sb-theme'),null,'«Как в системе» снимает сохранённый выбор');
    next.media.flip(false);assert.equal(next.theme(),'light');
  }finally{next.close();}
});

test('выбор в другой вкладке применяется через событие хранилища',()=>{
  const f=open({dark:false});try{
    f.w.localStorage.setItem('sb-theme','dark');
    f.w.dispatchEvent(new f.w.StorageEvent('storage',{key:'sb-theme',newValue:'dark'}));
    assert.equal(f.theme(),'dark');assert.equal(f.select.value,'dark');
  }finally{f.close();}
});

test('недопустимое сохранённое значение и неизвестный выбор сводятся к системной теме',()=>{
  const f=open({dark:true,stored:'purple'});try{
    assert.equal(f.w.SbTheme.preference,'system');assert.equal(f.theme(),'dark');
    f.w.SbTheme.set('sepia');assert.equal(f.w.SbTheme.preference,'system');assert.equal(f.w.localStorage.getItem('sb-theme'),null);
  }finally{f.close();}
});

test('запрещённое хранилище не ломает страницу: системная тема и выбор в пределах страницы',()=>{
  const f=open({dark:false,blockStorage:true});try{
    assert.equal(f.theme(),'light');
    f.choose('dark');assert.equal(f.theme(),'dark');assert.equal(f.select.value,'dark');
    f.media.flip(false);assert.equal(f.theme(),'dark');
  }finally{f.close();}
});

test('без matchMedia остаётся прежняя тёмная тема, подписчики получают смену',()=>{
  const dom=new JSDOM(PAGE,{url:'https://synapse.example.test/cabinet.html',runScripts:'outside-only'});const w=dom.window;
  try{
    delete w.matchMedia;w.matchMedia=undefined;w.eval(SOURCE);
    assert.equal(w.document.documentElement.dataset.theme,'dark');
    const seen=[];const stop=w.SbTheme.subscribe(state=>seen.push(state.theme));
    w.SbTheme.set('light');stop();w.SbTheme.set('dark');
    assert.deepEqual(seen,['light']);
  }finally{w.close();}
});

test('кабинет подключает тему блокирующим скриптом в <head> до стилей и показывает переключатель',()=>{
  const d=new JSDOM(SHELL).window.document;
  const script=d.head.querySelector('script[src^="platform-theme.js"]');
  assert.ok(script,'скрипт темы в <head>');
  assert.equal(script.defer||script.async||script.type==='module',false,'без defer/async: тема выставляется до первой отрисовки');
  const firstStyle=d.head.querySelector('link[rel="stylesheet"]');
  assert.ok(script.compareDocumentPosition(firstStyle)&4,'скрипт стоит раньше первой таблицы стилей');
  assert.ok(d.head.querySelector('link[rel="stylesheet"][href^="platform-theme.css"]'));
  const select=d.querySelector('#sidebar [data-sb-theme-select]');
  assert.deepEqual([...select.options].map(o=>[o.value,o.textContent]),[['system','Как в системе'],['light','Светлая'],['dark','Тёмная']]);
  assert.equal(select.closest('label').textContent.includes('Тема'),true,'у переключателя есть видимая подпись');
});

test('системная тема встроенного хоста меняется, ручной выбор сохраняет приоритет',()=>{
  const page=open({dark:false});try{
    let host='dark';page.w.SbTheme.useSystemTheme(()=>host);
    assert.equal(page.theme(),'dark');
    page.choose('light');host='dark';page.w.SbTheme.refresh();
    assert.equal(page.theme(),'light');
    page.choose('system');assert.equal(page.theme(),'dark');
    host='light';page.w.SbTheme.refresh();assert.equal(page.theme(),'light');
    page.w.SbTheme.useSystemTheme(null);page.media.flip(true);assert.equal(page.theme(),'dark');
  }finally{page.close();}
});

test('форма входа и инструменты получают общий выбор темы без дублей и смены содержимого',()=>{
  const dom=new JSDOM('<main data-sb-theme-host><p id="content">Неизменённый образец</p><iframe src="about:blank"></iframe></main>',{url:'https://synapse.example.test/editor.html',runScripts:'outside-only'});
  const w=dom.window;try{
    w.matchMedia=()=>systemScheme(false);w.eval(SOURCE);
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    assert.equal(w.document.querySelectorAll('[data-sb-theme-select]').length,1);
    const select=w.document.querySelector('[data-sb-theme-select]');
    select.value='dark';select.dispatchEvent(new w.Event('change',{bubbles:true}));
    assert.equal(w.document.documentElement.dataset.theme,'dark');
    assert.equal(w.document.getElementById('content').textContent,'Неизменённый образец');
    assert.equal(w.document.querySelector('iframe').contentDocument.documentElement.dataset.theme,undefined);
  }finally{w.close();}
});

test('вход, редакторы и мини-приложение подключают общий контроллер до своих стилей',()=>{
  for(const file of ['cabinet.html','site-editor.html','price-editor.html','price-editor-palitra.html','miniapp.html']){
    const html=fs.readFileSync(path.join(__dirname,file),'utf8');
    assert.ok(html.indexOf('platform-theme.js')<html.indexOf('</head>'),file);
    assert.ok(html.includes('data-sb-theme-host'),file);
  }
});

test('каждый цвет оболочки --sb-* объявлен в обеих темах; перекрашивание без filter',()=>{
  const workspace=fs.readFileSync(path.join(__dirname,'cabinet/workspace.css'),'utf8');
  const light=fs.readFileSync(path.join(__dirname,'platform-theme.css'),'utf8');
  const dark=workspace+light.slice(0,light.indexOf(':root[data-theme="light"]'));
  const lightRoot=light.slice(light.indexOf(':root[data-theme="light"]'));
  const used=new Set([...[dark,light,SHELL].join('\n').matchAll(/var\((--sb-[\w-]+)/g)].map(m=>m[1]));
  assert.ok(used.size>5);
  for(const name of used){
    assert.match(dark,new RegExp(`${name}:`),`${name} в тёмной теме`);
    assert.match(lightRoot.slice(0,lightRoot.indexOf('}')),new RegExp(`${name}:`),`${name} в светлой теме`);
  }
  assert.doesNotMatch(light,/filter\s*:/);
});
