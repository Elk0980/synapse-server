(function(){
  'use strict';
  const sb=window.SbCabinet=window.SbCabinet||{};
  let promptEvent=null, panel, context, config, registration;
  const installed=()=>matchMedia('(display-mode: standalone)').matches || navigator.standalone===true;
  function device(){
    const ua=navigator.userAgent;
    const ios=/iPhone|iPad|iPod/.test(ua)||(/Macintosh/.test(ua)&&navigator.maxTouchPoints>1);
    return {ios,mobile:ios||/Android/.test(ua),embedded:/Telegram|Instagram|FBAN|FBAV|; wv\)/i.test(ua),
      browser:/SamsungBrowser/.test(ua)?'Samsung Internet':/EdgA|EdgiOS/.test(ua)?'Edge':/Firefox|FxiOS/.test(ua)?'Firefox':/Chrome|CriOS/.test(ua)?'Chrome':/Safari/.test(ua)?'Safari':'ваш браузер'};
  }
  function instructions(d){
    if(d.embedded)return ['Откройте меню встроенного браузера и выберите «Открыть в браузере».','После открытия вернитесь к установке в личном кабинете.'];
    if(d.ios)return ['Нажмите «Поделиться» в меню браузера.','Выберите «На экран Домой» и нажмите «Добавить». Если такого пункта нет, откройте этот адрес в Safari.','Откройте ЛК новой иконкой. Затем включите уведомления здесь. Для push нужен iOS 16.4 или новее.'];
    if(d.browser==='Samsung Internet')return ['Откройте меню ☰ и выберите «Добавить страницу в» → «Главный экран».','Подтвердите добавление и откройте ЛК новой иконкой.'];
    return ['Откройте меню ⋮ браузера и выберите «Установить приложение» или «Добавить на главный экран».','Подтвердите установку. Если такого пункта нет, откройте ЛК в Chrome и повторите.'];
  }
  const request=async(path,body)=>{
    const response=await fetch('/content/push/'+path,{credentials:'same-origin',cache:'no-store',
      ...(body?{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':context.csrfToken},body:JSON.stringify(body)}:{})});
    const data=await response.json(); if(!response.ok)throw new Error(data.error||'Не удалось выполнить действие. Попробуйте ещё раз.'); return data;
  };
  function status(text){panel.querySelector('[data-mobile-status]').textContent=text;}
  function update(){
    const d=device(),hasInstall=installed(), supported='Notification'in window&&'PushManager'in window&&'serviceWorker'in navigator;
    panel.querySelector('[data-install-copy]').textContent=hasInstall?'ЛК уже открыт как приложение.':`Ваш браузер: ${d.browser}. Открывайте кабинет одним нажатием с главного экрана.`;
    const list=panel.querySelector('ol');list.replaceChildren();
    if(!hasInstall)instructions(d).forEach(text=>{const li=document.createElement('li');li.textContent=text;list.append(li);});
    list.hidden=hasInstall;
    panel.querySelector('[data-install]').hidden=hasInstall||!promptEvent;
    const enable=panel.querySelector('[data-push]');
    enable.disabled=!config?.ready||!registration||!supported||(d.ios&&!hasInstall)||Notification.permission==='denied';
    panel.querySelector('[data-push-copy]').textContent=!config?.ready?'Уведомления появятся после подключения доставки. Установить ЛК можно уже сейчас.':
      d.ios&&!hasInstall?'Сначала добавьте ЛК на экран Домой и откройте его новой иконкой.':
      !supported?'Этот браузер не поддерживает push. Откройте ЛК в поддерживаемом браузере.':
      Notification.permission==='denied'?'Уведомления запрещены. Разрешите их в настройках браузера или приложения, затем вернитесь сюда.':'Включите уведомления на этом устройстве. Разрешение запросит браузер.';
  }
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();promptEvent=event;if(panel)update();});
  window.addEventListener('appinstalled',()=>{promptEvent=null;if(panel)update();});
  sb.initMobileInstall=async function(profile){
    context=profile;if(panel){update();return;}
    const d=device();if(!d.mobile)return;
    panel=document.createElement('section');panel.className='mobile-install card';panel.hidden=true;panel.setAttribute('aria-label','Установка ЛК и уведомления');
    panel.innerHTML='<div class="mobile-install-head"><h2>ЛК всегда под рукой</h2><button type="button" data-close aria-label="Закрыть подсказку">×</button></div><p data-install-copy></p><ol></ol><button type="button" class="primary-button" data-install hidden>Установить ЛК</button><h3>Уведомления</h3><p data-push-copy></p><div class="mobile-install-actions"><button type="button" data-push disabled>Включить уведомления</button><button type="button" data-test hidden>Проверить доставку</button><button type="button" data-off hidden>Отключить</button></div><p role="status" data-mobile-status></p><button type="button" data-later>Позже</button>';
    const app=document.getElementById('app');app.append(panel);
    const reopen=document.createElement('button');reopen.type='button';reopen.className='plain-button';reopen.textContent='Установка и уведомления';
    (document.querySelector('.sidebar-footer')||app).append(reopen);reopen.onclick=()=>{panel.hidden=false;update();panel.querySelector('[data-close]').focus();};
    const close=()=>{panel.hidden=true;try{localStorage.setItem('sb.mobile-install.snooze',String(Date.now()));}catch{}reopen.focus();};
    panel.querySelector('[data-close]').onclick=close;panel.querySelector('[data-later]').onclick=close;
    panel.addEventListener('keydown',e=>{if(e.key==='Escape')close();});
    let dismissed=0;try{dismissed=Number(localStorage.getItem('sb.mobile-install.snooze'))||0;}catch{}
    panel.hidden=Date.now()-dismissed<7*86400000;update();
    panel.querySelector('[data-install]').onclick=async()=>{const event=promptEvent;if(!event)return;promptEvent=null;await event.prompt();await event.userChoice;update();};
    try{config=await request('config');if('serviceWorker'in navigator&&window.isSecureContext){await navigator.serviceWorker.register('/cabinet-sw.js',{scope:'/'});registration=await navigator.serviceWorker.ready;const existing=await registration.pushManager.getSubscription();panel.querySelector('[data-off]').hidden=!existing;}}catch{status('Проверить доступность уведомлений пока не удалось.');}update();
    const key=()=>Uint8Array.from(atob(config.publicKey.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
    panel.querySelector('[data-push]').onclick=async()=>{
      const button=panel.querySelector('[data-push]');button.disabled=true;
      try{const sub=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key()});await request('subscribe',{subscription:sub.toJSON()});status('Устройство подключено. Теперь можно проверить доставку.');panel.querySelector('[data-test]').hidden=false;panel.querySelector('[data-off]').hidden=false;}
      catch(e){status(e.name==='NotAllowedError'?'Разрешение не получено. Его можно изменить в настройках браузера.':e.message);}finally{update();}
    };
    panel.querySelector('[data-test]').onclick=async()=>{try{const sub=await registration.pushManager.getSubscription();if(!sub)throw new Error('Сначала включите уведомления.');await request('test',{endpoint:sub.endpoint});status('Проверочное уведомление передано службе доставки. Проверьте телефон.');}catch(e){status(e.message);}};
    panel.querySelector('[data-off]').onclick=async()=>{try{const sub=await registration.pushManager.getSubscription();if(sub){await request('unsubscribe',{endpoint:sub.endpoint});await sub.unsubscribe();}panel.querySelector('[data-test]').hidden=true;panel.querySelector('[data-off]').hidden=true;status('Уведомления на этом устройстве отключены.');}catch(e){status(e.message);}};
  };
})();

