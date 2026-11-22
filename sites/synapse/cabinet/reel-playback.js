(() => {
"use strict";
const sb=window.SbCabinet=window.SbCabinet||{},sessions=new WeakMap();
const FULL_FILE='Показываем полный файл — может грузиться дольше';
function previewUrl(media){
  try{const u=new URL(media,location.href);
    if(u.origin!==location.origin||!/^\/content\/publishing-assets\/[a-z0-9_-]{1,64}\/[a-f0-9]{32}\.mp4$/.test(u.pathname))return null;
    u.hash="";u.search="?preview=mobile-v1";return u.href;
  }catch{return null;}
}
function attach(player,media,{signal,onStatus=()=>{}}={}){
  sessions.get(player)?.destroy();
  const url=previewUrl(media);if(!url)return null;
  let alive=true,timer=null,inflight=null,attempts=0,ready=false,fallback=false,api,state='preparing';
  const started=performance.now(),MAX_WAIT=60000;
  player.removeAttribute('src');
  const active=()=>alive&&player.isConnected&&!signal?.aborted;
  const hint=()=>{if(active())onStatus(fallback?FULL_FILE:
    (state==='queued'||state==='busy'?'Просмотр ждёт очереди':'Готовим просмотр')+' — прошло '+Math.floor((performance.now()-started)/1000)+' с. После подготовки нажмите «Смотреть».',fallback);};
  function destroy(){alive=false;clearTimeout(timer);clearInterval(progress);inflight?.abort();signal?.removeEventListener('abort',destroy);player.removeEventListener('error',mediaError);if(sessions.get(player)===api)sessions.delete(player);}
  function fail(){if(active()){clearTimeout(timer);clearInterval(progress);ready=true;fallback=true;inflight?.abort();player.src=media;hint();}}
  function mediaError(){if(ready&&!fallback)fail();}
  async function poll(){
    if(!active()){destroy();return;}
    hint();inflight=new AbortController();const timeout=setTimeout(()=>inflight?.abort(),15000);
    try{
      const response=await fetch(url+'&status=1',{signal:inflight.signal,cache:'no-store',credentials:'omit',redirect:'error'});
      // При старом сервере этот URL может вернуть исходное видео: не читаем его как JSON/Blob.
      if(!response.ok||!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')||'')){
        await response.body?.cancel();throw Error('PREVIEW_STATUS_UNAVAILABLE');
      }
      const result=await response.json();if(!active()||ready)return;state=result.state;
      if(state==='ready'){ready=true;clearInterval(progress);player.src=url;onStatus('',false);return;}
      if(!['queued','preparing','busy'].includes(state)||++attempts>=30||performance.now()-started>=MAX_WAIT)throw Error('PREVIEW_FAILED');
      hint();
      timer=setTimeout(poll,2000);
    }catch{if(!ready)fail();}finally{clearTimeout(timeout);inflight=null;}
  }
  const progress=setInterval(()=>{if(!active())destroy();else if(!ready){if(performance.now()-started>=MAX_WAIT)fail();else hint();}},1000);
  api={get ready(){return ready;},get fallback(){return fallback;},hint,destroy,retry:()=>{destroy();return attach(player,media,{signal,onStatus});}};
  sessions.set(player,api);player.addEventListener('error',mediaError);signal?.addEventListener('abort',destroy,{once:true});void poll();return api;
}
function thumbnail(player,media){
  const url=previewUrl(media);if(!url)return;
  player.addEventListener('error',()=>{player.src=media+'#t=0.5';},{once:true});
  player.src=url+'&cached=1#t=0.5';
}
sb.reelPlayback={previewUrl,attach,thumbnail,get:player=>sessions.get(player)};
})();
