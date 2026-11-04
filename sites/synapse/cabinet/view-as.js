 'use strict';
(() => {
  const key='synapse-view-as', nativeFetch=window.fetch.bind(window);
  const token=()=>sessionStorage.getItem(key);
  window.fetch=(input,options={})=>{
    const url=new URL(input instanceof Request?input.url:input,location.href);
    if (url.origin===location.origin && url.pathname.startsWith('/content/') && token()) {
      const headers=new Headers(options.headers || (input instanceof Request?input.headers:undefined));
      headers.set('X-View-As',token());
      options={...options,headers};
    }
    return nativeFetch(input,options);
  };
  const exit=()=>{sessionStorage.removeItem(key);location.reload();};
  window.SynapseViewAs={render(profile){
    const start=document.getElementById('view-as-start');
    if (start) {
      start.hidden=profile.role!=='owner'||!!profile.viewAs;
      start.onclick=async()=>{
        try {
          const response=await fetch('/content/view-as');
          if (!response.ok) throw Error('Не удалось получить список людей');
          const {users}=await response.json(),dialog=document.createElement('dialog');
          const title=document.createElement('h2');title.textContent='Посмотреть как…';dialog.append(title);
          for (const user of users) {
            const button=document.createElement('button');button.textContent=user.name||user.login;
            button.style.cssText='display:block;margin:12px;max-width:90%;white-space:normal';
            button.onclick=async()=>{
              const r=await fetch('/content/view-as',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':profile.csrfToken},body:JSON.stringify({userId:user.id})});
              if (!r.ok) {title.textContent='Не удалось включить просмотр';return;}
              sessionStorage.setItem(key,(await r.json()).token);location.reload();
            };dialog.append(button);
          }
          const close=document.createElement('button');close.textContent='Отмена';close.onclick=()=>{dialog.close();dialog.remove();};dialog.append(close);
          document.body.append(dialog);dialog.showModal();
        } catch {start.textContent='Повторить выбор человека';}
      };
    }
    document.getElementById('view-as-banner')?.remove();
    if (profile.viewAs || token()) {
      const banner=document.createElement('div');banner.id='view-as-banner';banner.setAttribute('role','status');
      banner.style.cssText='position:sticky;top:0;z-index:10000;background:#fff0b5;color:#222;padding:10px;overflow-wrap:anywhere';
      banner.append(document.createTextNode(`Вы смотрите как ${profile.viewAs?.name||'сотрудник'} — только просмотр · `));
      const button=document.createElement('button');button.textContent='Выйти';button.onclick=exit;banner.append(button);document.body.prepend(banner);
    }
  }};
  // Expired/revoked token must remain recoverable before whoami succeeds.
  document.addEventListener('DOMContentLoaded',async()=>{
    if(!token())return;
    window.SynapseViewAs.render({viewAs:{}});
    if(location.pathname.endsWith('/cabinet.html'))return;
    try {const r=await fetch('/content/whoami');if(r.ok)window.SynapseViewAs.render(await r.json());}catch{}
  });
})();
