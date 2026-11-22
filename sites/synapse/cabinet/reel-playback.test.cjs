const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{JSDOM}=require('jsdom');
const source=fs.readFileSync(require.resolve('./reel-playback.js'),'utf8');
const media=n=>'https://cabinet.test/content/publishing-assets/alpha/'+n.repeat(32)+'.mp4';
const settle=()=>new Promise(r=>setTimeout(r,10));
function fixture(t,fetchImpl){const dom=new JSDOM('<video playsinline preload="metadata"></video>',{url:'https://cabinet.test',runScripts:'outside-only'});t.after(()=>dom.window.close());
 const w=dom.window;w.fetch=fetchImpl;w.eval(source);return {w,api:w.SbCabinet.reelPlayback,player:w.document.querySelector('video')};}
const json=state=>({ok:true,headers:{get:()=> 'application/json; charset=utf-8'},json:async()=>({state})});
test('preview клиента: ждёт готовность, не скачивает оригинал/Blob и не теряет жест в автозапуске',async t=>{
 let respond,calls=[];const f=fixture(t,(url,options)=>{calls.push({url,options});return new Promise(r=>respond=r);});let plays=0;f.player.play=()=>{plays++;};const messages=[];
 const ctl=f.api.attach(f.player,media('a'),{onStatus:(text,retry)=>messages.push({text,retry})});
 assert.equal(f.player.hasAttribute('src'),false);assert.equal(ctl.ready,false);ctl.hint();assert.equal(plays,0);
 assert.match(calls[0].url,/\?preview=mobile-v1&status=1$/);assert.equal(calls[0].options.credentials,'omit');
 respond(json('ready'));await settle();assert.equal(ctl.ready,true);assert.equal(f.player.src,media('a')+'?preview=mobile-v1');assert.equal(plays,0);
 assert.equal(messages.at(-1).text,'');assert.equal(f.player.getAttribute('preload'),'metadata');ctl.destroy();
});
test('preview клиента: старый сервер/video вместо JSON не читается целиком; повтор и отмена безопасны',async t=>{
 let cancelled=0,parsed=0;const f=fixture(t,async()=>({ok:true,headers:{get:()=> 'video/mp4'},body:{cancel:async()=>cancelled++},json:async()=>{parsed++;}}));const messages=[];
 const ctl=f.api.attach(f.player,media('a'),{onStatus:(text,retry)=>messages.push({text,retry})});await settle();assert.equal(cancelled,1);assert.equal(parsed,0);assert.equal(f.player.hasAttribute('src'),false);assert.equal(messages.at(-1).retry,true);
 f.w.fetch=async()=>json('ready');ctl.retry();await settle();assert.match(f.player.src,/preview=mobile-v1$/);
 let respond,aborted=false;f.w.fetch=(url,{signal})=>{signal.addEventListener('abort',()=>aborted=true);return new Promise(r=>respond=r);};
 const stale=f.api.attach(f.player,media('b'));stale.destroy();respond(json('ready'));await settle();assert.equal(aborted,true);assert.equal(f.player.hasAttribute('src'),false);
});
test('preview клиента: другая версия побеждает старый ответ; внешние/не-MP4 не запускают конверсию',async t=>{
 const pending=[];const f=fixture(t,()=>new Promise(r=>pending.push(r)));
 f.api.attach(f.player,media('a'));const next=f.api.attach(f.player,media('b'));pending[0](json('ready'));await settle();assert.equal(f.player.hasAttribute('src'),false);
 pending[1](json('ready'));await settle();assert.equal(f.player.src,media('b')+'?preview=mobile-v1');next.destroy();
 assert.equal(f.api.previewUrl('https://foreign.test'+new URL(media('a')).pathname),null);assert.equal(f.api.previewUrl(media('a').replace('.mp4','.webm')),null);
});
