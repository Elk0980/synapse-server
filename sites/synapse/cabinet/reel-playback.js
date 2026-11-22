(() => {
"use strict";
const sb=window.SbCabinet=window.SbCabinet||{},sessions=new WeakMap();
function previewUrl(media){
  try{const u=new URL(media,location.href);
    if(u.origin!==location.origin||!/^\/content\/publishing-assets\/[a-z0-9_-]{1,64}\/[a-f0-9]{32}\.mp4$/.test(u.pathname))return null;
    u.hash="";u.search="?preview=mobile-v1";return u.href;
  }catch{return null;}
}
function attach(player,media,{signal,onStatus=()=>{}}={}){
  sessions.get(player)?.destroy();
  const url=previewUrl(media);if(!url)return null;
  let alive=true,timer=null,inflight=null,attempts=0,ready=false;
  player.removeAttribute('src');
  const active=()=>alive&&player.isConnected&&!signal?.aborted;
  const hint=()=>onStatus('Готовим видео для просмотра… После подготовки нажмите «Смотреть».',false);
  function destroy(){alive=false;clearTimeout(timer);inflight?.abort();signal?.removeEventListener('abort',destroy);}
  function fail(){if(active())onStatus('Не удалось подготовить видео. Нажмите «Повторить загрузку».',true);}
  async function poll(){
    if(!active()){destroy();return;}
    hint();inflight=new AbortController();const timeout=setTimeout(()=>inflight?.abort(),15000);
    try{
      const response=await fetch(url+'&status=1',{signal:inflight.signal,cache:'no-store',credentials:'omit',redirect:'error'});
      // При старом сервере этот URL может вернуть исходное видео: не читаем его как JSON/Blob.
      if(!response.ok||!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')||'')){
        await response.body?.cancel();throw Error('PREVIEW_STATUS_UNAVAILABLE');
      }
      const state=await response.json();if(!active())return;
      if(state.state==='ready'){ready=true;player.src=url;onStatus('',false);return;}
      if(!['queued','preparing','busy'].includes(state.state)||++attempts>=90)throw Error('PREVIEW_FAILED');
      timer=setTimeout(poll,2000);
    }catch{fail();}finally{clearTimeout(timeout);inflight=null;}
  }
  const api={get ready(){return ready;},hint,destroy,retry:()=>{destroy();return attach(player,media,{signal,onStatus});}};
  sessions.set(player,api);signal?.addEventListener('abort',destroy,{once:true});void poll();return api;
}
sb.reelPlayback={previewUrl,attach,get:player=>sessions.get(player)};
})();
