(() => {
  'use strict';
  const sb = window.SbCabinet = window.SbCabinet || {};
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const STATES = {new:'Новый', in_progress:'В работе', answered:'Ответ опубликован'};
  const TITLES = {two_gis:'2ГИС',yandex_maps:'Яндекс Карты',vk:'ВКонтакте',flamp:'Flamp',other:'Другая площадка'};
  const safeUrl = value => { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
  const link = (url,label) => safeUrl(url) ? `<a class="plain-button" href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>` : '';
  const allowed = (ctx,kind) => ctx.identity?.role === 'owner' || ctx.identity?.permissions?.includes('crm.'+kind);
  let controller;
  function create(container,context) {
    let ctx=context, company='', epoch=0, busy=false, data=null, selected=null, offset=0, searchTimer;
    const get=id=>container.querySelector('#reviews-'+id);
    const editable=()=>allowed(ctx,'edit');
    const options=(items,empty)=>`${empty ? `<option value="">${esc(empty)}</option>`:''}${Object.entries(items).map(([id,name])=>`<option value="${esc(id)}">${esc(name)}</option>`).join('')}`;
    const api=(path='',method,body)=>ctx.apiJson('/content/crm/reviews'+path+'?companyCode='+encodeURIComponent(company)+(!path&&!method?'&'+new URLSearchParams({offset:String(offset),limit:'100',platform:get('platform-filter').value,status:get('state-filter').value,q:get('search').value.trim()}):''),method?ctx.csrfOptions(method,body):undefined);
    const status=text=>{get('status').textContent=text;};
    const controls=()=>{
      container.querySelectorAll('form input,form textarea,form select,form button,[data-write]').forEach(el=>el.disabled=busy||!editable()||!data);
      get('refresh').disabled=busy;
      get('previous').disabled=busy||!offset;
      get('next').disabled=busy||!data?.pagination?.hasMore;
      ['platform-filter','state-filter','search'].forEach(id=>get(id).disabled=busy);
    };
    const run=async (label,work)=>{
      if(busy)return; busy=true; const stamp=epoch;status(label);controls();
      const current=()=>stamp===epoch && company===String(ctx.selectedProjectId||'') && allowed(ctx,'view');
      try {await work(current);}catch(error){if(current()) status(error.status===409?'Запись уже изменилась. Обновите раздел, затем повторите изменение.':error.message||'Не удалось сохранить. Попробуйте ещё раз.');}
      finally{if(current()){busy=false;controls();}}
    };
    const validate=value=>{if(value?.company?.code!==company)throw Error('Получены данные другой компании. Обновите раздел.');return value;};
    const itemDate=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleDateString('ru-RU'):'';
    container.classList.add('reviews-view');
    container.innerHTML=`<header class="reviews-heading"><div><h2>Отзывы</h2><p id="reviews-company"></p></div><button class="plain-button" id="reviews-refresh" type="button">Обновить список</button></header>
      <p id="reviews-status" role="status" aria-live="polite"></p>
      <div id="reviews-counts" class="reviews-counts"></div>
      <details class="card reviews-connections"><summary>Площадки и правила работы</summary><p>Кабинеты открываются в новой вкладке. Ссылки и правила сохраняются отдельно для каждой компании.</p><div id="reviews-platforms" class="reviews-platforms"></div></details>
      <section class="card reviews-workflow"><h3>Как обработать отзыв</h3><ol><li>Добавьте отзыв и ссылку на оригинал.</li><li>Подготовьте и сохраните ответ.</li><li>Опубликуйте его в кабинете площадки.</li><li>Проверьте публикацию и отметьте результат здесь.</li></ol><p>Автоматическая загрузка и отправка пока не подключены. Сохранение ответа в ЛК создаёт черновик.</p></section>
      <details class="card" id="reviews-add"><summary>Добавить отзыв</summary><form id="reviews-add-form" class="reviews-fields">
      <label>Площадка<select name="platform" required>${options(TITLES)}</select></label><label>Автор<input name="author" maxlength="200" required></label>
      <label>Оценка<select name="rating">${options({'1':'1 — очень плохо','2':'2','3':'3','4':'4','5':'5 — отлично'},'Без оценки')}</select></label><label>Дата отзыва<input name="publishedAt" type="date"></label>
      <label class="reviews-wide">Ссылка на оригинал<input name="sourceUrl" type="url" placeholder="https://…" required maxlength="2000"></label>
      <label class="reviews-wide">Текст отзыва<textarea name="text" rows="4" maxlength="12000" required></textarea></label><button class="primary-button" type="submit">Добавить в очередь</button></form></details>
      <div class="reviews-filters"><label>Площадка<select id="reviews-platform-filter">${options(TITLES,'Все площадки')}</select></label><label>Статус<select id="reviews-state-filter">${options(STATES,'Все статусы')}</select></label><label>Поиск<input id="reviews-search" type="search" maxlength="300" placeholder="Автор или текст"></label></div>
      <div class="reviews-actions reviews-pager"><span id="reviews-page-label"></span><div><button class="plain-button" type="button" id="reviews-previous">Назад</button> <button class="plain-button" type="button" id="reviews-next">Далее</button></div></div>
      <div class="reviews-inbox"><section id="reviews-list" aria-label="Список отзывов"></section><section id="reviews-detail" class="card" tabindex="-1" aria-label="Работа с отзывом"><p>Выберите отзыв из списка.</p></section></div>`;
    function drawPlatforms(){
      get('platforms').innerHTML=(data.platforms||[]).map(p=>`<article class="reviews-platform"><h3>${esc(p.name||TITLES[p.key]||p.key)}</h3><p class="reviews-muted">${esc(p.reason||'Работа через кабинет площадки. Автоматическая синхронизация не подключена.')}</p><div class="reviews-actions">${link(p.cabinetUrl,p.cabinetLabel||'Открыть площадку')}${link(p.publicUrl,'Страница компании')}</div><details><summary>Ссылка и правила заполнения</summary><form data-platform-form="${esc(p.key)}"><label>Прямая ссылка на кабинет компании<input name="cabinetUrl" type="url" value="${esc(p.cabinetUrl||'')}" maxlength="2000" placeholder="https://…"></label><label>Правила для этой компании<textarea name="rules" rows="5" maxlength="12000" placeholder="Здесь запишем шаги по вашему показу: поля, источники данных, проверка и публикация.">${esc(p.rules||'')}</textarea></label><p class="reviews-muted">Указывайте рабочие ссылки без паролей и ключей. Для разных филиалов фиксируйте адрес и карточку в правилах.</p><button class="plain-button" type="submit">Сохранить правила</button></form></details></article>`).join('');
    }
    function filtered(){const q=get('search').value.trim().toLocaleLowerCase('ru');return (data?.items||[]).filter(r=>(!get('platform-filter').value||r.platform===get('platform-filter').value)&&(!get('state-filter').value||r.status===get('state-filter').value)&&(!q||[r.author,r.text,r.draftReply].join(' ').toLocaleLowerCase('ru').includes(q)));}
    function drawList(){
      const items=data?.items||[];
      const counts=data?.counts||{total:items.length,new:items.filter(r=>r.status==='new').length,in_progress:items.filter(r=>r.status==='in_progress').length,answered:items.filter(r=>r.status==='answered').length};
      get('counts').innerHTML=[['Всего',counts.total],['Ждут ответа',counts.new+counts.in_progress],['Ответ опубликован',counts.answered]].map(([name,count])=>`<div><strong>${count}</strong><span>${name}</span></div>`).join('');
      const total=data?.pagination?.total??items.length;
      get('page-label').textContent=total?`Показано ${offset+1}–${offset+items.length} из ${total}`:'Нет отзывов по выбранным условиям';
      const rows=filtered();get('list').innerHTML=rows.length?rows.map(r=>`<button class="reviews-row" type="button" data-review="${esc(r.id)}" aria-pressed="${String(String(selected)===String(r.id))}"><span class="reviews-row-meta">${esc(TITLES[r.platform]||r.platform)} · ${esc(itemDate(r.publishedAt))}</span><strong>${esc(r.author||'Без имени')}${r.rating!=null?` <span aria-label="Оценка ${esc(r.rating)} из 5">${esc(r.rating)} ★</span>`:''}</strong><span class="reviews-excerpt">${esc(r.text)}</span><span class="reviews-badge" data-state="${esc(r.status)}">${esc(STATES[r.status]||r.status)}</span></button>`).join(''):`<div class="card reviews-empty"><h3>${items.length?'Ничего не найдено':'Пока нет отзывов'}</h3><p>${items.length?'Измените фильтры или поиск.':'Добавьте первый отзыв из кабинета площадки. Он появится только у выбранной компании.'}</p></div>`;
    }
    function drawDetail(){
      const r=data?.items?.find(item=>String(item.id)===String(selected));
      if(!r){get('detail').innerHTML='<p>Выберите отзыв из списка.</p>';return;}
      const p=data.platforms?.find(item=>item.key===r.platform);
      get('detail').innerHTML=`<div class="reviews-row-meta">${esc(TITLES[r.platform])} · ${esc(itemDate(r.publishedAt))}</div><h3>${esc(r.author)}</h3><p class="reviews-full-text">${esc(r.text)}</p><div class="reviews-actions">${link(r.sourceUrl,'Оригинал отзыва')}${link(p?.cabinetUrl,'Кабинет площадки')}</div>
      ${r.status==='answered'?`<section class="reviews-published"><h4>Опубликованный ответ</h4><p class="reviews-full-text">${esc(r.publishedReply)}</p><p>Публикация отмечена вручную${r.confirmedAt?' · '+esc(itemDate(r.confirmedAt)):''}.</p>${link(r.replyUrl,'Проверить ответ')}</section>`:''}
      <form id="reviews-reply-form"><label>Черновик ответа<textarea name="draftReply" rows="6" maxlength="10000" placeholder="Ответ от имени компании">${esc(r.draftReply||'')}</textarea></label><label>Внутренняя заметка<textarea name="note" rows="2" maxlength="10000" placeholder="Что проверить и кому передать">${esc(r.note||'')}</textarea></label><div class="reviews-actions"><button class="primary-button" type="submit">Сохранить черновик</button><button class="plain-button" type="button" id="reviews-copy" data-write>Скопировать ответ</button></div><p class="reviews-muted">Копирование не отправляет ответ и не меняет статус.</p></form>
      ${r.status!=='answered'?`<details><summary>Отметить опубликованный ответ</summary><form id="reviews-confirm-form"><p>Сначала откройте площадку и убедитесь, что ответ опубликован. Ожидание модерации ещё не означает публикацию.</p><label>Фактически опубликованный текст<textarea name="publishedReply" rows="4" maxlength="10000" required>${esc(r.draftReply||'')}</textarea></label><label>Ссылка на отзыв с ответом<input name="replyUrl" type="url" value="${esc(r.sourceUrl||'')}" maxlength="2000" required></label><label class="reviews-checkbox"><input type="checkbox" required>Я проверил опубликованный ответ на площадке</label><button class="plain-button" type="submit">Подтвердить публикацию</button></form></details>`:''}`;
      get('reply-form').addEventListener('submit',event=>{event.preventDefault();const f=event.currentTarget;save(r,{draftReply:f.elements.draftReply.value,note:f.elements.note.value,...(r.status==='new'?{status:'in_progress'}:{})},'Черновик сохранён. На площадку он не отправлен.');});
      get('copy').addEventListener('click',async()=>{try{const value=get('reply-form').elements.draftReply.value;if(!value.trim()){status('Сначала напишите ответ.');return;}await navigator.clipboard.writeText(value);status('Ответ скопирован. Откройте оригинал и опубликуйте его на площадке.');}catch{status('Не удалось скопировать автоматически. Выделите текст ответа и скопируйте его вручную.');}});
      get('confirm-form')?.addEventListener('submit',event=>{event.preventDefault();const f=event.currentTarget;if(f.reportValidity())save(r,{status:'answered',publishedReply:f.elements.publishedReply.value,replyUrl:f.elements.replyUrl.value},'Публикация отмечена вами. Автоматическая проверка площадки не выполнялась.');});
      controls();
    }
    function save(item,patch,success){if(!editable())return;void run('Сохраняем…',async current=>{await api('/'+encodeURIComponent(item.id),'PATCH',{revision:item.revision,...patch});if(!current())return;const refreshed=await api();if(!current())return;data=validate(refreshed);drawList();drawDetail();status(success);});}
    function loadPage(nextOffset=0){if(busy)return;offset=nextOffset;selected=null;drawDetail();void run('Обновляем список…',async current=>{const result=await api();if(!current())return;data=validate(result);drawList();status('Список из ЛК обновлён. Внешняя синхронизация не выполнялась.');});}
    async function load(code){
      company=String(code||'');epoch++;clearTimeout(searchTimer);busy=false;data=null;selected=null;offset=0;get('page-label').textContent='';get('platforms').replaceChildren();get('counts').replaceChildren();get('list').replaceChildren();get('detail').innerHTML='<p>Выберите отзыв из списка.</p>';get('add-form').reset();get('add').open=false;
      get('platform-filter').value='';get('state-filter').value='';get('search').value='';get('company').textContent=ctx.identity?.companies?.find(c=>String(c.id)===company)?.name||company;controls();
      if(!company||!allowed(ctx,'view')){status('Выберите доступную компанию.');return;}
      await run('Загружаем отзывы выбранной компании…',async current=>{const result=await api();if(!current())return;data=validate(result);drawPlatforms();drawList();status('Список из ЛК обновлён. Отзывы с внешних площадок автоматически не загружались.');});
    }
    get('refresh').addEventListener('click',()=>void load(company));
    ['platform-filter','state-filter'].forEach(id=>get(id).addEventListener('change',()=>loadPage(0)));
    get('search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadPage(0),300);});
    get('previous').addEventListener('click',()=>loadPage(Math.max(0,offset-100)));
    get('next').addEventListener('click',()=>loadPage(offset+100));
    get('list').addEventListener('click',event=>{const button=event.target.closest('[data-review]');if(button&&!busy){selected=button.dataset.review;drawList();drawDetail();if(window.matchMedia?.('(max-width:760px)').matches)get('detail').focus();}});
    get('platforms').addEventListener('submit',event=>{const f=event.target.closest('[data-platform-form]');if(!f)return;event.preventDefault();const p=data.platforms.find(p=>p.key===f.dataset.platformForm);if(!p||!editable()||!f.reportValidity())return;void run('Сохраняем правила…',async current=>{const result=await api('/platforms/'+p.key,'PUT',{revision:p.revision,cabinetUrl:f.elements.cabinetUrl.value,rules:f.elements.rules.value});if(!current())return;const row=result.platform||result;data.platforms=data.platforms.map(p=>p.key===row.key?row:p);drawPlatforms();drawDetail();status('Правила и ссылка сохранены для этой компании.');});});
    get('add-form').addEventListener('submit',event=>{event.preventDefault();const f=event.currentTarget;if(!editable()||!f.reportValidity())return;const payload={platform:f.elements.platform.value,author:f.elements.author.value,rating:f.elements.rating.value?Number(f.elements.rating.value):null,text:f.elements.text.value,sourceUrl:f.elements.sourceUrl.value,...(f.elements.publishedAt.value?{publishedAt:f.elements.publishedAt.value+'T00:00:00.000Z'}:{})};void run('Добавляем отзыв…',async current=>{const result=await api('','POST',payload);if(!current())return;const row=result.item||result;offset=0;get('platform-filter').value='';get('state-filter').value='';get('search').value='';const refreshed=await api();if(!current())return;data=validate(refreshed);selected=row.id;if(!data.items.some(r=>r.id===row.id))data.items.unshift(row);f.reset();get('add').open=false;drawList();drawDetail();status(result.duplicate?'Этот отзыв уже есть в очереди.':'Отзыв добавлен в очередь выбранной компании.');});});
    return {ready:load(ctx.selectedProjectId),update(next){ctx=next;if(!allowed(ctx,'view')){epoch++;clearTimeout(searchTimer);data=null;container.replaceChildren();controller=null;return;}if(company!==String(ctx.selectedProjectId||''))return load(ctx.selectedProjectId);controls();}};
  }
  sb.registerView('reviews',{title:'Отзывы',render(container,ctx){if(!allowed(ctx,'view')){controller?.update(ctx);container.replaceChildren();return;}if(!controller)controller=create(container,ctx);else return controller.update(ctx);return controller.ready;},onProjectChange(ctx){return controller?.update(ctx);}});
})();
