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
 const ctl=f.api.attach(f.player,media('a'),{onStatus:(text,retry)=>messages.push({text,retry})});await settle();assert.equal(cancelled,1);assert.equal(parsed,0);assert.equal(f.player.src,media('a'));assert.equal(ctl.fallback,true);assert.equal(messages.at(-1).retry,true);
 f.w.fetch=async()=>json('ready');ctl.retry();await settle();assert.match(f.player.src,/preview=mobile-v1$/);
 let respond,aborted=false;f.w.fetch=(url,{signal})=>{signal.addEventListener('abort',()=>aborted=true);return new Promise(r=>respond=r);};
 const stale=f.api.attach(f.player,media('b'));stale.destroy();respond(json('ready'));await settle();assert.equal(aborted,true);assert.equal(f.player.hasAttribute('src'),false);
});

for(const [name,respond]of [
 ['failed (в том числе нет FFmpeg/файл сверх лимита)',async()=>json('failed')],
 ['статус404',async()=>({ok:false,headers:{get:()=> 'application/json'}})],
 ['статус503',async()=>({ok:false,headers:{get:()=> 'application/json'}})],
 ['неверныйJSON',async()=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>{throw Error('JSON');}})],
 ['сеть недоступна',async()=>{throw Error('NETWORK');}]
])test('preview fallback: '+name,async t=>{
 let calls=0,plays=0;const messages=[];const f=fixture(t,()=>{calls++;return respond();});f.player.play=()=>{plays++;};
 const ctl=f.api.attach(f.player,media('a'),{onStatus:(text,retry)=>messages.push({text,retry})});await settle();
 assert.equal(ctl.ready,true);assert.equal(ctl.fallback,true);assert.equal(f.player.src,media('a'));assert.equal(plays,0,'не запускаем оригинал без нового жеста');
 assert.deepEqual(messages.at(-1),{text:'Показываем полный файл — может грузиться дольше',retry:true});assert.equal(calls,1);
 f.player.dispatchEvent(new f.w.Event('error'));assert.equal(f.player.src,media('a'),'нет цикла повторов оригинала');ctl.destroy();
});

test('preview fallback: истёк HTTP timeout; исчерпано ожидание busy/queued/preparing',async t=>{
 const timed=fixture(t,(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('TIMEOUT')))));
 const set=timed.w.setTimeout;let timeout;
 timed.w.setTimeout=(fn,ms)=>ms===15000?(timeout=fn,12345):set(fn,ms);
 const tc=timed.api.attach(timed.player,media('a'));timeout();await settle();assert.equal(tc.fallback,true);assert.equal(timed.player.src,media('a'));tc.destroy();
 const queue=[];let calls=0;const statuses=['busy','queued','preparing'];
 const f=fixture(t,async()=>json(statuses[calls++%3]));const nativeSet=f.w.setTimeout;
 f.w.setTimeout=(fn,ms)=>ms===2000?(queue.push(fn),23456):nativeSet(fn,ms);
 const ctl=f.api.attach(f.player,media('b'));await settle();
 while(queue.length&&!ctl.ready&&calls<100)await queue.shift()();
 assert.equal(ctl.fallback,true);assert.equal(f.player.src,media('b'));assert.equal(calls,90);assert.equal(queue.length,0);ctl.destroy();
});

test('preview fallback: ошибка загрузки готовой копии; миниатюра без кеша возвращается к оригиналу один раз',async t=>{
 const f=fixture(t,async()=>json('ready'));const ctl=f.api.attach(f.player,media('a'));await settle();
 f.player.dispatchEvent(new f.w.Event('error'));assert.equal(ctl.fallback,true);assert.equal(f.player.src,media('a'));ctl.destroy();
 const thumbnail=f.w.document.createElement('video');thumbnail.preload='metadata';let writes=0;
 const attr=Object.getOwnPropertyDescriptor(f.w.HTMLMediaElement.prototype,'src');
 Object.defineProperty(thumbnail,'src',{get:()=>attr.get.call(thumbnail),set:value=>{writes++;attr.set.call(thumbnail,value);}});
 f.api.thumbnail(thumbnail,media('b'));assert.match(thumbnail.src,/preview=mobile-v1&cached=1#t=0.5$/);
 thumbnail.dispatchEvent(new f.w.Event('error'));assert.equal(thumbnail.src,media('b')+'#t=0.5');
 thumbnail.dispatchEvent(new f.w.Event('error'));assert.equal(writes,2);assert.equal(thumbnail.preload,'metadata');
});
test('preview клиента: другая версия побеждает старый ответ; внешние/не-MP4 не запускают конверсию',async t=>{
 const pending=[];const f=fixture(t,()=>new Promise(r=>pending.push(r)));
 f.api.attach(f.player,media('a'));const next=f.api.attach(f.player,media('b'));pending[0](json('failed'));await settle();assert.equal(f.player.hasAttribute('src'),false);
 pending[1](json('ready'));await settle();assert.equal(f.player.src,media('b')+'?preview=mobile-v1');next.destroy();
 assert.equal(f.api.previewUrl('https://foreign.test'+new URL(media('a')).pathname),null);assert.equal(f.api.previewUrl(media('a').replace('.mp4','.webm')),null);
});
