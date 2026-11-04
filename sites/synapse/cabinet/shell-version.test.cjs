'use strict';
// №98: свежая версия ассетов оболочки из cabinet/shell-version.json (автовыпуск не меняет cabinet.html).
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const registrySource=fs.readFileSync(path.join(__dirname,'module-registry.js'),'utf8');

async function load({answer,lists=true,version='old-v'}={}){
  const calls=[];
  const setup=lists?`const shellAssets=["module-registry","content-settings"];const shellStyles=["shell","content-settings"];`:'';
  const html=`<!doctype html><html><head><link rel="stylesheet" href="cabinet/home.css?v=${version}">
<link rel="stylesheet" href="cabinet/shell.css?v=${version}"><link rel="stylesheet" href="cabinet/content-settings.css?v=${version}"></head><body>
<script>window.SB_CABINET_ASSET_VERSION=${JSON.stringify(version)};${setup}</script>
<script>${registrySource}</script></body></html>`;
  const dom=new JSDOM(html,{url:'https://cabinet.test/cabinet.html',runScripts:'dangerously',beforeParse(w){
    w.fetch=async(url,options={})=>{calls.push({url:String(url),cache:options.cache});
      if(answer===undefined)return {ok:false,status:404,json:async()=>({})};
      if(answer instanceof Error)throw answer;
      return {ok:true,status:200,json:async()=>answer};};
  }});
  const w=dom.window;
  const result=await w.SynapseModules.shellVersion;
  const d=w.document;
  return {w,d,calls,result,
    scripts:[...d.querySelectorAll('script[src]')].map(s=>s.getAttribute('src')),
    links:()=>[...d.querySelectorAll('link[rel="stylesheet"]')].map(l=>l.getAttribute('href'))};
}

test('есть shell-version.json: модули и стили оболочки грузятся с ?v=<commit>, реестр не перезагружается',async()=>{
  const f=await load({answer:{commit:'87d67d7f3c44de6c83ae34806fd18397a149814b'}});
  const v='87d67d7f3c44de6c83ae34806fd18397a149814b';
  assert.deepEqual(f.calls,[{url:'cabinet/shell-version.json',cache:'no-store'}]);
  assert.equal(f.result.version,v);
  assert.deepEqual(f.scripts,[`cabinet/content-settings.js?v=${v}`],'module-registry не грузится второй раз');
  assert.ok(f.links().includes(`cabinet/shell.css?v=${v}`)&&f.links().includes(`cabinet/content-settings.css?v=${v}`));
  assert.ok(f.links().includes('cabinet/shell.css?v=old-v'),'старый стиль остаётся до загрузки нового');
  f.d.querySelector(`link[href="cabinet/shell.css?v=${v}"]`).dispatchEvent(new f.w.Event('load'));
  assert.ok(!f.links().includes('cabinet/shell.css?v=old-v'),'после загрузки старый стиль снят');
  assert.ok(f.links().includes('cabinet/home.css?v=old-v'),'общие стили кабинета не трогаются');
  f.w.close();
});

test('нет файла, ошибка сети, неверный commit или та же версия — остаётся прежняя ?v',async()=>{
  for(const answer of [undefined,new Error('offline'),{commit:'../../x'},{commit:'ABCDEF1'},{commit:123},{}]){
    const f=await load({answer});
    assert.equal(f.result.version,'old-v',JSON.stringify(answer));
    assert.deepEqual(f.scripts,[]);assert.equal(f.links().length,3);
    f.w.close();
  }
  const same=await load({answer:{commit:'abcdef1'},version:'abcdef1'});
  assert.deepEqual(same.scripts,[]);same.w.close();
});

test('без списков shellAssets/shellStyles (стенды других тестов) файл версии не запрашивается',async()=>{
  const f=await load({answer:{commit:'abcdef1234'},lists:false});
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.scripts,[]);f.w.close();
});
