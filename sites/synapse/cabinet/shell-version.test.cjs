'use strict';
// №98: модули и версия оболочки из /cabinet/shell-modules.json и /cabinet/shell-version.json (без правки cabinet.html).
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const registrySource=fs.readFileSync(path.join(__dirname,'module-registry.js'),'utf8');
const C='87d67d7f3c44de6c83ae34806fd18397a149814b';

async function load({modules,version,lists=true,v='old-v'}={}){
  const calls=[];
  const setup=lists?`const shellAssets=["module-registry","content-settings"];const shellStyles=["shell","content-settings"];`:'';
  const tags=lists?`<link rel="stylesheet" href="cabinet/shell.css?v=${v}"><link rel="stylesheet" href="cabinet/content-settings.css?v=${v}">`:'';
  const html=`<!doctype html><html><head><link rel="stylesheet" href="cabinet/home.css?v=${v}">${tags}</head><body>
<script>window.SB_CABINET_ASSET_VERSION=${JSON.stringify(v)};${setup}</script>
<script>${registrySource}</script>${lists?`<script src="cabinet/content-settings.js?v=${v}"></script>`:''}</body></html>`;
  const answers={'/cabinet/shell-modules.json':modules,'/cabinet/shell-version.json':version};
  const dom=new JSDOM(html,{url:'https://cabinet.test/cabinet.html',runScripts:'dangerously',beforeParse(w){
    w.fetch=async(url,options={})=>{calls.push({url:String(url),cache:options.cache});const answer=answers[String(url)];
      if(answer===undefined)return {ok:false,status:404,json:async()=>({})};
      if(answer instanceof Error)throw answer;
      return {ok:true,status:200,json:async()=>answer};};
  }});
  const w=dom.window,d=w.document,before=new Set([...d.querySelectorAll('script[src]')].map(s=>s.getAttribute('src')));
  const result=await w.SynapseModules.shellVersion;
  return {w,d,calls,result,
    added:()=>[...d.querySelectorAll('script[src]')].map(s=>s.getAttribute('src')).filter(src=>!before.has(src)),
    links:()=>[...d.querySelectorAll('link[rel="stylesheet"]')].map(l=>l.getAttribute('href'))};
}

test('новый модуль из shell-modules.json грузится без правки cabinet.html; оба файла — no-store',async()=>{
  const f=await load({modules:{assets:['content-settings','content-plan'],styles:['shell','content-plan']}});
  assert.deepEqual(f.calls.map(c=>[c.url,c.cache]).sort(),[['/cabinet/shell-modules.json','no-store'],['/cabinet/shell-version.json','no-store']]);
  assert.equal(f.result.source,'shell-modules.json');assert.equal(f.result.version,'old-v');
  assert.deepEqual(f.added(),['/cabinet/content-plan.js?v=old-v'],'уже загруженный content-settings той же версии не повторяется');
  assert.ok(f.links().includes('/cabinet/content-plan.css?v=old-v'));
  assert.equal(f.links().filter(h=>h.includes('shell.css')).length,1,'shell.css той же версии не дублируется');
  f.w.close();
});

test('свежая версия: модули оболочки перезагружаются с ?v=<commit>, старый CSS снимается после загрузки, реестр — нет',async()=>{
  const f=await load({modules:{assets:['module-registry','content-settings'],styles:['shell']},version:{commit:C}});
  assert.equal(f.result.version,C);
  assert.deepEqual(f.added(),[`/cabinet/content-settings.js?v=${C}`]);
  assert.ok(f.links().includes('cabinet/shell.css?v=old-v'),'до загрузки нового старый стиль на месте');
  f.d.querySelector(`link[href="/cabinet/shell.css?v=${C}"]`).dispatchEvent(new f.w.Event('load'));
  assert.ok(!f.links().includes('cabinet/shell.css?v=old-v'));
  assert.ok(f.links().includes('cabinet/home.css?v=old-v'),'общие стили кабинета не трогаются');
  f.w.close();
});

test('запасной список cabinet.html, если JSON недоступен или испорчен; плохие версии игнорируются',async()=>{
  for(const modules of [undefined,new Error('offline'),[],{assets:'content-plan'},{other:1}]){
    const f=await load({modules,version:{commit:C}});
    assert.equal(f.result.source,'cabinet.html',JSON.stringify(modules));
    assert.deepEqual(f.added(),[`/cabinet/content-settings.js?v=${C}`]);f.w.close();
  }
  for(const version of [undefined,new Error('x'),{commit:'../../x'},{commit:'ABCDEF1'},{commit:123},{}]){
    const f=await load({version});
    assert.equal(f.result.version,'old-v');assert.deepEqual(f.added(),[]);assert.equal(f.links().length,3);f.w.close();
  }
});

test('имена строго по шаблону и только /cabinet/ того же origin',async()=>{
  const bad=['../evil','https://evil.test/x','//evil.test/x','Content','a','x'.repeat(49),'a/b','a.js','a?x=1','a#b',' a',1,null];
  const f=await load({modules:{assets:[...bad,'content-ok'],styles:bad}});
  assert.deepEqual(f.added(),['/cabinet/content-ok.js?v=old-v']);
  assert.equal(f.links().length,3,'ни одного стиля из неверных имён');
  for(const src of [...f.d.querySelectorAll('script[src],link[href]')].map(n=>n.getAttribute('src')||n.getAttribute('href'))){
    const url=new URL(src,'https://cabinet.test/cabinet.html');
    assert.equal(url.origin,'https://cabinet.test');assert.ok(url.pathname.startsWith('/cabinet/'),src);
  }
  f.w.close();
});

test('без списков shellAssets (стенды других тестов) ничего не запрашивается',async()=>{
  const f=await load({modules:{assets:['content-plan']},version:{commit:C},lists:false});
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.added(),[]);f.w.close();
});
