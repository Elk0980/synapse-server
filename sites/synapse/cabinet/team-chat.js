'use strict';
(() => {
  const $ = id => document.getElementById(id), node = (tag,text) => {const n=document.createElement(tag);n.textContent=text;return n;};
  let context, company='', epoch=0, pending=null, busy=false, timer,visibilityKey='';
  const drafts=new Map(), messages=new Map();
  const fit=()=>document.documentElement.style.setProperty('--chat-height',String(window.visualViewport?.height || window.innerHeight)+'px');
  fit();window.visualViewport?.addEventListener('resize',fit);window.addEventListener('resize',fit);
  const storageKey=code=>`team-chat:${context.user.id}:${code}`;
  const save=()=>{if(!company)return;drafts.set(company,$('text').value);try{sessionStorage.setItem(storageKey(company),JSON.stringify({text:$('text').value,pending}));}catch{}};
  async function api(path,body) {
    let r;
    try { r=await fetch(`/content/people/${path}`,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(body?28000:20000),headers:{'content-type':'application/json',...(body?{'x-csrf-token':context.csrfToken}:{})},...(body?{body:JSON.stringify(body)}:{})}); }
    catch {throw Error(body?'Результат отправки не подтверждён. Повтор сохранённой отправки безопасен.':'Не удалось загрузить чат. Нажмите на проект для повтора.');}
    if(!r.ok){const error=await r.json().catch(()=>({}));throw Error(r.status===403&&error.details?.mustChangePassword?'Нужно сменить пароль. Откройте «Моя работа», сохранив этот чат.':r.status===401?'Войдите через «Моя работа» и вернитесь в чат.':r.status===403?'Доступ к проекту отозван.':body?'Результат отправки не подтверждён. Повтор сохранённой отправки безопасен.':'Не удалось загрузить чат. Нажмите на проект для повтора.');}
    return r.json();
  }
  const path=code=>`team-chat?companyCode=${encodeURIComponent(code)}`;
  function render() {
    const list=$('messages'),nearBottom=list.scrollHeight-list.scrollTop-list.clientHeight<80;
    list.replaceChildren();
    for(const m of [...messages.values()].sort((a,b)=>a.id-b.id)) {
      const li=node('li','');li.id=`message-${m.id}`;if(m.user_id===context.user.id)li.className='own';
      // specs/228: «Лео · Claude» / «Хью · Claude» — ответ ассистента с именем персоны.
      li.append(node('strong',m.user_id===0&&/^(Лео|Хью) · Claude$/.exec(m.author_name||'')?.[1]||m.author_name),node('span',m.text),node('time',new Date(m.created_at).toLocaleString('ru-RU')));
      if(m.answerAudit&&m.answerAudit.status!=='agent_redirect')li.append(node('small',`${m.answerAudit.model?m.answerAudit.model+' · ':''}${m.answerAudit.status==='approved'?'Проверено':m.answerAudit.status==='refused'?'Запрос отклонён':m.answerAudit.status==='agent_pending'?'Ждёт ответа Лео':m.answerAudit.status==='agent_answered'?'Ответ ниже':'Передано на проверку'}`));
      if(m.task_id)li.append(node('span',`Хью · задача №${m.task_id} на доске`));
      else if(m.command_state==='pending')li.append(node('span','Хью · создание задачи ещё не подтверждено'));
      list.append(li);
    }
    if(nearBottom)list.scrollTop=list.scrollHeight;
  }
  async function refresh(older=false) {
    const code=company,version=epoch;if(!code)return;
    try {
      const before=older&&messages.size?`&before=${Math.min(...messages.keys())}`:'';
      const data=await api(path(code)+before);if(version!==epoch)return;
      if(data.viewerId!==undefined&&data.viewerId!==context.user.id){messages.clear();render();$('review-queue')?.remove();$('compose').hidden=true;clearInterval(timer);$('notice').textContent='Сессия изменилась. Обновите страницу.';return;}
      if(visibilityKey&&data.visibilityKey!==visibilityKey)messages.clear();
      visibilityKey=data.visibilityKey||'';
      let queue=$('review-queue');
      if(data.reviewQueue){
        if(!queue){queue=node('details','');queue.id='review-queue';document.querySelector('.conversation header').append(queue);}
        queue.replaceChildren(node('summary',`Последние вопросы для проверки: ${data.reviewQueue.length}`));
        for(const item of data.reviewQueue)queue.append(node('p',`№${item.message_id}: ${item.text}`));
      }else queue?.remove();
      for(const m of data.messages)messages.set(m.id,m);render();
      if(older||!messages.size||!before)$('older').hidden=!data.hasMore;
      $('notice').textContent=pending?'Есть сохранённая отправка. Нажмите ➤, чтобы проверить её результат.':'';
    }catch(e){if(version===epoch){$('notice').textContent=e.message;if(/отозван|Войдите/.test(e.message)){$('compose').hidden=true;messages.clear();$('review-queue')?.remove();render();clearInterval(timer);}}}
  }
  async function select(code) {
    if(busy)return;save();company=code;epoch++;pending=null;visibilityKey='';messages.clear();$('review-queue')?.remove();
    try{const old=JSON.parse(sessionStorage.getItem(storageKey(code))||'null');if(old){drafts.set(code,old.text);pending=old.pending;}}catch{}
    $('text').value=drafts.get(code)||'';$('text').readOnly=Boolean(pending);
    $('title').textContent=context.companies.find(c=>c.id===code).name;$('compose').hidden=false;
    document.querySelector('.shell').classList.add('open');
    for(const b of $('rooms').children)b.setAttribute('aria-current',String(b.dataset.code===code));
    history.replaceState(null,'',`?companyCode=${encodeURIComponent(code)}${location.hash}`);
    const version=epoch,target=/^#message-([1-9]\d*)$/.exec(location.hash);
    if(target&&Number.isSafeInteger(Number(target[1])+1)) {
      try {
        const source=await api(path(code)+`&before=${Number(target[1])+1}`);
        if(version!==epoch)return;
        if(source.viewerId!==undefined&&source.viewerId!==context.user.id)throw Error('Сессия изменилась. Обновите страницу.');
        for(const m of source.messages)messages.set(m.id,m);render();
      }catch(e){if(version===epoch)$('notice').textContent=e.message;}
    }
    await refresh();if(version===epoch)document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }
  $('compose').onsubmit=async e=>{
    e.preventDefault();if(busy||!company)return;
    const code=company,version=epoch;
    pending ||= {text:$('text').value,clientMessageId:crypto.randomUUID()};save();busy=true;
    $('text').readOnly=true;$('compose').querySelector('[type=submit]').disabled=true;
    try {
      const data=await api(path(code),pending);if(version!==epoch)return;
      messages.set(data.message.id,data.message);pending=null;$('text').value='';save();await refresh();render();$('messages').scrollTop=$('messages').scrollHeight;$('notice').textContent='';
    }catch(e){if(version===epoch)$('notice').textContent=e.message;}
    finally{busy=false;$('text').readOnly=Boolean(pending);$('compose').querySelector('[type=submit]').disabled=false;}
  };
  $('text').oninput=save;$('older').onclick=()=>void refresh(true);
  $('back').onclick=()=>{if(!busy){save();document.querySelector('.shell').classList.remove('open');}};
  window.addEventListener('pagehide',()=>{save();clearInterval(timer);});
  void (async()=>{try{
    context=await api('context');$('notice').textContent='Выберите проект.';
    for(const c of context.companies){const b=node('button',c.name);b.dataset.code=c.id;b.onclick=()=>void select(c.id);$('rooms').append(b);}
    const requested=new URLSearchParams(location.search).get('companyCode');
    if(context.companies.some(c=>c.id===requested))await select(requested);
    timer=setInterval(()=>{if(!document.hidden&&!busy)void refresh();},5000);
  }catch(e){$('notice').textContent=e.message;}})();
})();
