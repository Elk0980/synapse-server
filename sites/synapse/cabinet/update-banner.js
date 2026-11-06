/* №179: обновление только по нажатию, с сохранением введённых черновиков. */
(function(root){
  'use strict';
  function createUpdateBanner({window:w,document:d,fetch:request,reload=()=>w.location.reload(),interval=300000}){
    const valid=v=>typeof v==='string'&&/^[0-9a-f]{7,40}$/.test(v);
    let baseline=valid(w.SB_CABINET_ASSET_VERSION)?w.SB_CABINET_ASSET_VERSION:null,pending=false,busy=false,stopped=false,button=null;
    const dirty=()=>[...d.querySelectorAll('input,textarea,[contenteditable="true"]')].some(el=>{
      if(el.disabled||['hidden','button','submit','reset','checkbox','radio','range','color'].includes(el.type))return false;
      return el.type==='file'?el.files?.length>0:Boolean((el.isContentEditable?el.textContent:el.value||'').trim());
    });
    function place(){
      if(!button)return;
      const viewport=w.visualViewport,bottom=viewport?Math.max(0,w.innerHeight-viewport.height-viewport.offsetTop):0;
      let gap=w.innerWidth<=760?140:96;
      for(const el of d.querySelectorAll('.mobile-nav,.mobile-bottom-nav,.sb-chat-fab,.sbc-composer,.chat-composer')){
        const r=el.getBoundingClientRect();if(r.width&&r.height&&r.top<w.innerHeight&&r.top>w.innerHeight/2)gap=Math.max(gap,w.innerHeight-r.top+12);
      }
      button.style.bottom=(gap+bottom)+'px';
    }
    function show(){
      if(button||stopped)return;
      button=d.createElement('button');button.type='button';button.className='sb-update-banner';button.textContent='Есть обновление — нажмите';button.setAttribute('aria-live','polite');
      button.onclick=()=>{if(dirty()){button.title='Сначала сохраните или очистите черновик';button.setAttribute('aria-label','Есть обновление. Сначала сохраните или очистите черновик');button.dataset.waiting='true';return;}reload();};
      d.body.append(button);place();
    }
    async function check(){
      if(busy||stopped)return;busy=true;
      try{const response=await request('/cabinet/shell-version.json',{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(10000)});
        if(!response.ok)return;const data=await response.json();if(stopped||!valid(data?.commit))return;
        if(!baseline)baseline=data.commit;
        else if(data.commit!==baseline){pending=true;show();}
      }catch(error){/* Без сети прежняя страница и черновики продолжают работать. */}finally{busy=false;}
    }
    const visible=()=>{if(d.visibilityState==='visible')void check();};
    d.addEventListener('visibilitychange',visible);w.addEventListener('resize',place);w.visualViewport?.addEventListener('resize',place);
    const timer=w.setInterval(()=>{if(d.visibilityState!=='hidden')void check();},interval);
    void check();
    return {check,dirty,get pending(){return pending;},stop(){stopped=true;w.clearInterval(timer);d.removeEventListener('visibilitychange',visible);w.removeEventListener('resize',place);w.visualViewport?.removeEventListener('resize',place);button?.remove();}};
  }
  if(typeof module==='object'&&module.exports)module.exports={createUpdateBanner};
  else if(!root.SynapseUpdateBanner){
    const start=()=>{if(!root.SynapseUpdateBanner)root.SynapseUpdateBanner=createUpdateBanner({window:root,document:root.document,fetch:root.fetch.bind(root)});};
    if(root.document.readyState==='loading')root.document.addEventListener('DOMContentLoaded',start,{once:true});else start();
  }
})(typeof window==='object'?window:globalThis);
