/* The native project chat runs in its own persistent frame. It receives no parent's cookies, tokens or identity. */
(()=>{
  'use strict';
  const root=document.getElementById('hugh-view'),views={};
  const cabinet=window.SbCabinet=window.SbCabinet||{};
  cabinet.registerView=(name,definition)=>{views[name]=definition;};
  let identity=null,selected=null,drafts=null,stopped=false;
  const companies=new Set(['palitra-love','alvi','avokado']);
  const error=message=>{root.replaceChildren();const p=document.createElement('p');p.className='team-error';p.setAttribute('role','alert');p.textContent=message;root.append(p);};
  const fingerprint=user=>JSON.stringify([user.userId,user.role,(user.companies||[]).map(c=>typeof c==='string'?c:c.id).sort()]);
  async function verifyIdentity(){
    const r=await fetch('/content/whoami',{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw Object.assign(new Error('Войдите в приложение заново.'),{status:r.status});
    const fresh=await r.json();
    if(!['owner','editor'].includes(fresh.role)||!/^[1-9]\d*$/.test(String(fresh.userId))||!Array.isArray(fresh.companies))throw Object.assign(new Error('Рабочий чат доступен участникам проекта.'),{status:403});
    if(identity&&fingerprint(fresh)!==fingerprint(identity))throw Object.assign(new Error('Учётная запись или доступ изменились. Откройте рабочий чат заново.'),{status:401});
    identity=fresh;return fresh;
  }
  const start=async()=>{
    try{
      selected=new URLSearchParams(location.search).get('company');
      if(!companies.has(selected))throw new Error('Выберите компанию в приложении.');
      await verifyIdentity();
      if(!identity.companies.some(c=>(typeof c==='string'?c:c.id)===selected))throw new Error('Нет доступа к проекту.');
      drafts=window.SynapseTeamDrafts.create({actor:identity.userId,storage:sessionStorage,indexedDB});
      const ctx={get identity(){return identity;},get selectedProjectId(){return selected;},get currentView(){return stopped?'':'hugh';},
        byId:id=>document.getElementById(id),drafts,verifyIdentity,
        onRevoked:message=>{stopped=true;error(message);}};
      if(!views.hugh)throw new Error('Рабочий чат не загрузился. Обновите страницу.');
      await views.hugh.render(root,ctx);
    }catch(e){stopped=true;error(e.message||'Не удалось открыть рабочий чат.');}
  };
  const geometry=()=>{
    const v=window.visualViewport,active=document.activeElement;
    const editing=active&&root.contains(active)&&active.matches('textarea,input:not([type=checkbox]):not([type=button]):not([type=submit])');
    if(editing&&v&&v.scale===1&&v.height>0){document.documentElement.style.setProperty('--team-height',v.height+'px');}
    else document.documentElement.style.removeProperty('--team-height');
  };
  window.visualViewport?.addEventListener('resize',geometry);window.addEventListener('resize',geometry);
  root.addEventListener('focusin',geometry);root.addEventListener('focusout',()=>requestAnimationFrame(geometry));
  window.addEventListener('pagehide',()=>{views.hugh?.unmount?.();drafts?.close();});
  window.addEventListener('pageshow',e=>{if(e.persisted){stopped=false;identity=null;start();}});
  cabinet.teamChatHost={start};
})();
