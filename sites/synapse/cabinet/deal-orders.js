(() => {
  const cabinet=window.SbCabinet ||= {};
  let ctx,root,deal,stages=[],generation=0,saving=false,tab='overview',contactPage=0,contactSearch='',pipeline='sale';
  const labels={overview:'Обзор',brief:'Бриф и показатели',estimate:'Смета',modules:'Модули',documents:'Документы',invoices:'Счета'};
  const moduleStages={not_started:'Не начато',access:'Доступы',configuration:'Настройка',testing:'Проверка',launched:'Запущен',support:'Сопровождение'};
  const purchases={planned:'Планируется',purchased:'Приобретён'};
  const invoiceStatuses={draft:'Черновик',issued:'Выставлен',paid:'Оплачен',cancelled:'Отменён'};
  const briefFields={goal:'Какого результата ждёт клиент?',audience:'Кто целевая аудитория?',problem:'Какая задача или проблема решается?',scope:'Что входит в работы?',constraints:'Бюджет, ограничения и зависимости',acceptance:'Как клиент будет принимать результат?',owner:'Кто согласует результат со стороны клиента?',deadline:'Согласованный срок'};
  const h=v=>ctx.escapeHTML(String(v??''));
  const money=v=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB'}).format(v||0);
  const editable=()=>ctx.hasPermission('crm.edit');
  const query=(path,params={},options={})=>ctx.crmQuery(path,{pipeline,...params,...ctx.scopeParams()},options);
  const disabled=()=>editable()?'':' disabled';
  const printLink=(kind,id='')=>`/content/crm/deals/${deal.id}/print?${new URLSearchParams({...ctx.scopeParams(),kind,...(id?{invoiceId:id}:{})})}`;
  const options=(choices,value)=>Object.entries(choices).map(([key,label])=>`<option value="${h(key)}"${key===value?' selected':''}>${h(label)}</option>`).join('');
  const stageSelect=value=>`<select style="border-left:5px solid ${h(stages.find(s=>s.code===value)?.color||'#8ab4f8')}" data-order-stage aria-label="Этап сделки"${disabled()}>${value?'':'<option value="">Добавить в воронку</option>'}${options(Object.fromEntries(stages.map(s=>[s.code,s.label])),value)}</select>`;
  const error=message=>{const target=root.querySelector('[data-order-error]');if(target){target.textContent=message;target.hidden=!message;}};
  const field=(key,label,value='',type='text')=>`<label>${h(label)}${type==='textarea'?`<textarea name="${key}"${disabled()}>${h(value)}</textarea>`:`<input type="${type}" name="${key}" value="${h(value)}"${disabled()}>`}</label>`;
  const saveButton=()=>editable()?'<button type="submit" class="primary-action">Сохранить изменения</button>':'';
  const patch=async(body)=>{
    if(saving)return false;saving=true;error('');
    const current=deal,version=generation;
    root.querySelectorAll('button[type=submit], [data-order-stage]').forEach(e=>e.disabled=true);
    try{
      const updated=await query(`/deals/${current.id}`,{},ctx.csrfOptions('PATCH',{version:current.version,...body}));
      if(version!==generation)return false;
      deal=updated;stages=updated.stages;renderDetail();
      root.querySelector('[data-order-status]').textContent='Сохранено';return true;
    }catch(e){if(version===generation)error(e.message);return false;}
    finally{saving=false;if(version===generation)root.querySelectorAll('button[type=submit], [data-order-stage]').forEach(e=>e.disabled=!editable());}
  };
  const header=()=>`<div class="content-header"><h1>Сделки и заказы</h1></div><p data-order-error class="crm-error" role="alert" hidden></p><p data-order-status role="status"></p>`;
  async function loadList(){
    const version=++generation;deal=null;root.innerHTML=header()+`<div class="order-toolbar"><button class="primary-action" data-order-create${disabled()}>Создать сделку</button><select data-order-pipeline aria-label="Воронка"><option value="sale">Продажи</option><option value="service">Сервис</option></select><input type="search" data-order-search aria-label="Поиск сделок" placeholder="Название сделки или компании">${ctx.identity.role==='owner'?'<button type="button" data-order-rules>Настроить воронку</button>':''}</div><div data-orders-list>Загрузка…</div>`;
    root.querySelector('[data-order-create]').onclick=showCreate;
    root.querySelector('[data-order-pipeline]').value=pipeline;
    root.querySelector('[data-order-pipeline]').onchange=e=>{pipeline=e.target.value;loadList();};
    root.querySelector('[data-order-rules]')?.addEventListener('click',showRules);
    let searchVersion=0,timer;
    const load=async()=>{
      const request=++searchVersion;
      try{const data=await query('/deals',{q:root.querySelector('[data-order-search]').value});if(version!==generation||request!==searchVersion)return;
        stages=data.stages;root.querySelector('[data-order-pipeline]').innerHTML=options(Object.fromEntries(data.pipelines.map(p=>[p.code,p.label])),pipeline);renderList(data);
      }catch(e){if(version===generation)error(e.message);}
    };
    root.querySelector('[data-order-search]').oninput=()=>{clearTimeout(timer);timer=setTimeout(load,250);};await load();
  }
  function renderList(data){
    const list=root.querySelector('[data-orders-list]');
    list.innerHTML=`<p class="muted">Сделок: ${data.total}${data.total>50?' · показаны первые 50, уточните поиск':''}</p><div class="orders-grid">${data.deals.map(d=>`<article class="card order-card" data-order-id="${d.id}"><div class="order-card-heading"><a href="#deals/${d.id}"><strong>№${d.id} · ${h(d.title)}</strong></a>${stageSelect(d.stage)}</div><p>${h(d.companyName)}</p><strong>${money(d.total)}</strong><p>${h(d.nextAction||'Следующий шаг не указан')}${d.nextDate?' · '+h(d.nextDate):''}</p><small>${(d.modules||[]).filter(m=>m.purchase==='purchased').length} приобретённых модулей</small></article>`).join('')||'<div class="card"><h2>Пока нет сделок</h2><p>Создайте отдельную сделку на каждую задачу или заказ клиента.</p></div>'}</div>`;
    list.querySelectorAll('[data-order-stage]').forEach(select=>select.onchange=async()=>{
      const current=data.deals.find(d=>String(d.id)===select.closest('[data-order-id]').dataset.orderId),target=select.value;select.value=current.stage||'';
      await transition(current,target,loadList);
    });
  }
  function showCreate(){
    const dialog=document.createElement('dialog');dialog.className='menu-settings order-create';dialog.setAttribute('aria-label','Новая сделка');
    dialog.innerHTML=`<form><header><h2>Новая сделка</h2><button type="button" data-close aria-label="Закрыть">×</button></header><div class="crm-form">${field('title','Название сделки *')}<label>Поиск компании<input name="q" type="search" placeholder="Название или город"></label><label>Компания *<select name="companyId" required disabled><option value="">Выберите компанию</option></select></label><p data-options-status role="status"></p><a href="#crm-companies/new" data-create-company>Добавить компанию в CRM</a><button type="submit" class="primary-action">Создать сделку</button><p class="crm-error" role="alert"></p></div></form>`;
    document.body.append(dialog);dialog.showModal();dialog.querySelector('[name=title]').required=true;
    const form=dialog.querySelector('form'),requestId=crypto.randomUUID();let request=0,timer;
    const close=()=>{dialog.close();dialog.remove();};dialog.querySelector('[data-close]').onclick=close;dialog.addEventListener('cancel',()=>dialog.remove());
    dialog.querySelector('[data-create-company]').onclick=close;
    const load=async()=>{const v=++request;form.elements.companyId.disabled=true;const status=dialog.querySelector('[data-options-status]');status.textContent='Поиск компаний…';try{const result=await query('/companies',{q:form.elements.q.value,limit:50,deleted:'exclude'});if(v!==request||!dialog.isConnected)return;form.elements.companyId.innerHTML='<option value="">Выберите компанию</option>'+result.companies.map(c=>`<option value="${c.id}">${h(c.name)}${c.city?' — '+h(c.city):''}</option>`).join('');form.elements.companyId.disabled=false;status.textContent=result.companies.length?'':'Компания не найдена';}catch(e){status.textContent=e.message;}};
    form.elements.q.oninput=()=>{++request;clearTimeout(timer);timer=setTimeout(load,250);};load();
    form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector('[type=submit]');if(button.disabled)return;if(form.elements.companyId.disabled||!form.elements.companyId.value)return;button.disabled=true;try{const created=await query('/deals',{},ctx.csrfOptions('POST',{title:form.elements.title.value,companyId:Number(form.elements.companyId.value),requestId}));close();location.hash=`deals/${created.id}`;}catch(e){form.querySelector('[role=alert]').textContent=e.message;button.disabled=false;}};
  }
  const metricCards=()=>`<div class="order-metrics">${(deal.metrics||[]).map(m=>`<article><h3>${h(m.name)}</h3><strong>${h(m.current||'—')} ${h(m.unit)}</strong><p>Цель: ${h(m.target||'—')} · Было: ${h(m.baseline||'—')}</p><small>${h(m.due||'Срок не указан')}${m.source?' · '+h(m.source):''}</small></article>`).join('')||'<p class="muted">Заполните ожидания и показатели в брифе — они появятся здесь.</p>'}</div>`;
  function overview(){
    const stage=stages.find(s=>s.code===deal.stage);
    return `<div class="order-summary"><div><small>Смета</small><strong>${money(deal.total)}</strong></div><div><small>Оплачено по отметкам менеджера</small><strong>${money((deal.invoices||[]).filter(i=>i.status==='paid').reduce((s,i)=>s+i.amount,0))}</strong></div><div><small>Запущено приобретённых модулей</small><strong>${(deal.modules||[]).filter(m=>m.purchase==='purchased'&&['launched','support'].includes(m.stage)).length} / ${(deal.modules||[]).filter(m=>m.purchase==='purchased').length}</strong></div></div>
    <h2>Ожидания и результат</h2><p>${h(deal.brief?.goal||'Цель ещё не сформулирована')}</p>${metricCards()}
    <section class="order-stage-guide"><h2>${h(stage?.label)}: как вести клиента дальше</h2><ol>${(stage?.steps||[]).map(s=>`<li>${h(s)}</li>`).join('')}</ol><p><b>Готовность к следующему этапу:</b> ${h(stage?.done)}</p></section>
    <form data-order-form="overview" class="crm-form">${field('title','Название сделки',deal.title)}${field('description','Основная информация',deal.description,'textarea')}${field('nextAction','Следующий шаг',deal.nextAction)}${field('nextDate','Дата следующего шага',deal.nextDate,'date')}${field('stageNote','План и результат текущего этапа',deal.stageNotes?.[pipeline+':'+deal.stage],'textarea')}<div>${saveButton()}</div></form>
    <h2>Приобретённые модули</h2>${(deal.modules||[]).filter(m=>m.purchase==='purchased').map(m=>`<p><strong>${h(m.name)}</strong> · ${h(moduleStages[m.stage])}${m.due?' · '+h(m.due):''}</p>`).join('')||'<p class="muted">Пока не отмечены. Добавьте их во вкладке «Модули».</p>'}<details><summary>История переходов</summary>${(deal.history||[]).map(e=>`<p>${h(e.createdAt)} · ${h(e.actor)}: ${h(e.from||'—')} → ${h(e.to)}${e.override?`<br><strong>Под ответственность владельца</strong>: ${h(e.reason)}<br>Не выполнено: ${h(e.missing.join('; '))}`:''}</p>`).join('')||'<p>Переходов пока нет. Существующие этапы перенесены из воронки компаний.</p>'}</details>`;
  }
  const schemas={
    metrics:[['name','Показатель'],['baseline','Исходное'],['target','Цель'],['current','Сейчас'],['unit','Единица'],['due','Срок','date'],['source','Источник проверки']],
    estimate:[['name','Работы / услуги'],['quantity','Количество','number'],['price','Цена, ₽','number']],
    modules:[['name','Модуль'],['purchase','Покупка',purchases],['stage','Внедрение',moduleStages],['owner','Ответственный'],['due','Срок','date'],['notes','Что осталось сделать','textarea']],
    documents:[['title','Название'],['url','Ссылка на документ','url'],['status','Статус']],
    invoices:[['number','Номер счёта'],['amount','Сумма, ₽','number'],['date','Дата','date'],['due','Оплатить до','date'],['status','Статус',invoiceStatuses],['seller','Исполнитель и платёжные реквизиты','textarea'],['buyer','Заказчик и реквизиты','textarea'],['purpose','Назначение платежа','textarea'],['notes','Условия, налоги и примечания','textarea']]
  };
  function rowMarkup(kind,row){
    return `<fieldset class="order-edit-row" data-row data-row-id="${h(row.id||'')}">${schemas[kind].map(([key,label,type])=>`<label>${h(label)}${typeof type==='object'?`<select data-field="${key}"${disabled()}>${options(type,row[key])}</select>`:type==='textarea'?`<textarea data-field="${key}"${disabled()}>${h(row[key])}</textarea>`:`<input data-field="${key}" type="${type||'text'}" value="${h(row[key])}"${type==='number'?' min="0" step="0.01"':''}${disabled()}>`}</label>`).join('')}${editable()?'<button type="button" data-remove-row>Убрать строку</button>':''}${kind==='invoices'&&row.id&&(deal.invoices||[]).some(i=>i.id===row.id)?`<a href="${h(printLink('invoice',row.id))}" target="_blank" rel="noopener">Открыть счёт / PDF</a>`:''}${kind==='documents'&&safeUrl(row.url)?`<a href="${h(row.url)}" target="_blank" rel="noopener">Открыть документ</a>`:''}</fieldset>`;
  }
  function rows(kind){return `<div data-rows="${kind}">${(deal[kind]||[]).map(r=>rowMarkup(kind,r)).join('')}</div>${editable()?`<button type="button" data-add-row="${kind}">Добавить ${({metrics:'показатель',estimate:'позицию',modules:'модуль',documents:'документ',invoices:'счёт'})[kind]}</button>`:''}`;}
  function formContent(){
    if(tab==='overview')return overview();
    if(tab==='brief')return `<form class="crm-form" data-order-form="brief">${Object.entries(briefFields).map(([key,label])=>field(key,label,deal.brief?.[key],'textarea')).join('')}<section class="wide"><h2>Показатели успеха</h2><p>Зафиксируйте исходное значение, цель и способ проверки. Текущие значения вводятся вручную.</p>${rows('metrics')}</section><div>${saveButton()}</div></form>`;
    const intro={estimate:'Смета относится только к этой сделке. Укажите состав работ, количество и цену.',modules:'Отмечайте приобретённые модули и фактический этап внедрения. Эти отметки не заменяют проверку подключения.',documents:'Добавляйте ссылки на договоры, материалы и закрывающие документы с нужными правами доступа.',invoices:'Счета создаются как черновики. Заполните реквизиты и условия перед передачей клиенту. Оплату отмечает менеджер после проверки.'}[tab];
    return `<p>${intro}</p>${tab==='estimate'?`<p><strong>Итого: ${money(deal.total)}</strong> · <a href="${h(printLink('estimate'))}" target="_blank" rel="noopener">Смета / PDF</a></p>`:''}${tab==='documents'?`<div class="order-toolbar"><a href="${h(printLink('brief'))}" target="_blank" rel="noopener">Сформировать бриф / PDF</a><a href="${h(printLink('estimate'))}" target="_blank" rel="noopener">Сформировать смету / PDF</a></div>${fileSection()}`:''}<form data-order-form="${tab}">${rows(tab)}<div class="order-save">${saveButton()}</div></form>`;
  }
  function safeUrl(value){try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch{return '';}}
  function contactIcons(c){
    const icons=[];
    if(c.phone){const phone=c.phone.replace(/[^+\d]/g,'');if(phone)icons.push(`<a href="tel:${h(phone)}" title="Позвонить" aria-label="Позвонить ${h(c.name)}">☎</a>`);}
    if(c.email)icons.push(`<a href="mailto:${h(encodeURIComponent(c.email))}" title="Написать на email" aria-label="Email ${h(c.name)}">@</a>`);
    (c.messengers||[]).forEach(m=>{let url=safeUrl(m.url);if(!url&&m.type==='telegram'&&/^@?[A-Za-z0-9_]{5,32}$/.test(m.handle||''))url='https://t.me/'+m.handle.replace(/^@/,'');if(url)icons.push(`<a href="${h(url)}" target="_blank" rel="noopener" title="${h(m.type)}" aria-label="${h(m.type)} ${h(c.name)}">${h(({telegram:'TG',whatsapp:'WA',vk:'VK',max:'MAX'})[m.type]||'↗')}</a>`);});
    if(editable())icons.push(`<button type="button" data-edit-contact="${c.id}" title="Редактировать контакт" aria-label="Редактировать ${h(c.name)}">✎</button>`);
    return icons.join('');
  }
  function renderContacts(data){
    const panel=root.querySelector('[data-order-contacts]');if(!panel)return;
    panel.innerHTML=data.contacts.map(c=>`<div class="order-contact"><strong>${h(c.name)}</strong><div>${contactIcons(c)}</div></div>`).join('')||'<p>Контактов пока нет.</p>';
    panel.insertAdjacentHTML('beforeend',`<div class="order-contact-pages"><button type="button" data-contact-prev${contactPage===0?' disabled':''}>←</button><small>${Math.min(contactPage*30+1,data.total)}–${Math.min(contactPage*30+data.contacts.length,data.total)} из ${data.total}</small><button type="button" data-contact-next${(contactPage+1)*30>=data.total?' disabled':''}>→</button></div>`);
    panel.querySelectorAll('[data-edit-contact]').forEach(b=>b.onclick=()=>editContact(data.contacts.find(c=>String(c.id)===b.dataset.editContact)));
    panel.querySelector('[data-contact-prev]').onclick=()=>{contactPage--;loadContacts();};panel.querySelector('[data-contact-next]').onclick=()=>{contactPage++;loadContacts();};
  }
  async function loadContacts(){const id=deal.id,version=generation;try{const data=await query(`/deals/${id}/contacts`,{q:contactSearch,offset:contactPage*30});if(version===generation&&deal?.id===id)renderContacts(data);}catch(e){error(e.message);}}
  function editContact(c){
    const dialog=document.createElement('dialog');dialog.className='menu-settings';dialog.setAttribute('aria-label','Редактировать контакт');
    dialog.innerHTML=`<form class="crm-form"><header class="wide"><h2>Контакт компании</h2><button type="button" data-close aria-label="Закрыть">×</button></header>${field('name','ФИО',c.name)}${field('phone','Телефон',c.phone)}${field('email','Email',c.email,'email')}<p class="wide">Изменения будут видны во всех сделках этой компании.</p>${saveButton()}<p class="crm-error" role="alert"></p></form>`;
    document.body.append(dialog);dialog.showModal();dialog.querySelector('[data-close]').onclick=()=>{dialog.close();dialog.remove();};dialog.addEventListener('cancel',()=>dialog.remove());
    dialog.querySelector('form').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,button=form.querySelector('[type=submit]');button.disabled=true;try{await query(`/deals/${deal.id}/contacts/${c.id}`,{},ctx.csrfOptions('PATCH',{name:form.elements.name.value,phone:form.elements.phone.value||null,email:form.elements.email.value||null}));dialog.close();dialog.remove();await loadContacts();}catch(error){form.querySelector('[role=alert]').textContent=error.message;button.disabled=false;}};
  }
  function renderDetail(){
    root.innerHTML=header()+`<a href="#deals">← Все сделки</a><div class="order-detail-heading"><h2>№${deal.id} · ${h(deal.title)}</h2><select data-detail-pipeline aria-label="Воронка сделки">${options(Object.fromEntries(deal.pipelines.map(p=>[p.code,p.label])),pipeline)}</select>${stageSelect(deal.stage)}</div><p>${h(deal.company.name)}</p><div class="order-layout"><aside class="card order-people"><h2>Контакты компании</h2><input type="search" data-contact-search placeholder="Найти контакт" aria-label="Поиск контакта"><div data-order-contacts></div><a href="#crm-companies/${deal.companyId}">Карточка компании →</a></aside><section class="card order-main"><nav class="order-tabs" aria-label="Разделы сделки">${Object.entries(labels).map(([key,label])=>`<button type="button" data-order-tab="${key}" aria-current="${tab===key?'page':'false'}">${label}</button>`).join('')}</nav><div data-order-content>${formContent()}</div></section></div>`;
    cabinet.renderModuleGuide?.(root,'deals',ctx);
    root.querySelector('[data-detail-pipeline]').onchange=async e=>{if(root.querySelector('[data-order-form]')?.dataset.dirty==='true'){e.target.value=pipeline;error('Сначала сохраните изменения.');return;}pipeline=e.target.value;try{deal=await query(`/deals/${deal.id}`);stages=deal.stages;renderDetail();}catch(err){error(err.message);}};
    root.querySelector('[data-order-stage]').onchange=e=>{const target=e.target.value;e.target.value=deal.stage||'';if(root.querySelector('[data-order-form]')?.dataset.dirty==='true'){error('Сначала сохраните изменения в форме.');return;}transition(deal,target,updated=>{deal=updated;stages=updated.stages;renderDetail();});};
    root.querySelectorAll('[data-order-tab]').forEach(button=>button.onclick=()=>{const form=root.querySelector('[data-order-form]');if(form?.dataset.dirty==='true'&&!confirm('Есть несохранённые изменения. Перейти без сохранения?'))return;tab=button.dataset.orderTab;renderDetail();});
    contactPage=0;contactSearch='';renderContacts({contacts:deal.contacts,total:deal.totalContacts});
    let timer;root.querySelector('[data-contact-search]').oninput=e=>{contactSearch=e.target.value;contactPage=0;clearTimeout(timer);timer=setTimeout(loadContacts,250);};
    bindForm();
    bindUpload();
  }
  function collectRows(form,kind){return [...form.querySelectorAll(`[data-rows="${kind}"] [data-row]`)].map(row=>{
    const value={};row.querySelectorAll('[data-field]').forEach(input=>value[input.dataset.field]=input.type==='number'?Number(input.value):input.value);
    if(kind==='invoices')value.id=row.dataset.rowId||crypto.randomUUID();return value;
  });}
  function bindForm(){
    const form=root.querySelector('[data-order-form]');if(!form)return;
    form.oninput=()=>{form.dataset.dirty='true';};
    form.onclick=e=>{const remove=e.target.closest('[data-remove-row]');if(remove){remove.closest('[data-row]').remove();form.dataset.dirty='true';}const add=e.target.closest('[data-add-row]');if(add){const kind=add.dataset.addRow;const defaults={estimate:{quantity:1,price:0},modules:{purchase:'planned',stage:'not_started'},invoices:{id:crypto.randomUUID(),date:new Date().toISOString().slice(0,10),amount:deal.total,status:'draft',buyer:deal.company.name,purpose:deal.title},documents:{status:'Черновик'}};form.querySelector(`[data-rows="${kind}"]`).insertAdjacentHTML('beforeend',rowMarkup(kind,defaults[kind]||{}));form.dataset.dirty='true';}};
    form.onsubmit=async e=>{e.preventDefault();let data={},title;
      if(tab==='overview'){title=form.elements.title.value;data={description:form.elements.description.value,nextAction:form.elements.nextAction.value,nextDate:form.elements.nextDate.value,...(deal.stage?{stageNotes:{...deal.stageNotes,[pipeline+':'+deal.stage]:form.elements.stageNote.value}}:{})};}
      else if(tab==='brief'){data.brief=Object.fromEntries(Object.keys(briefFields).map(k=>[k,form.elements[k].value]));data.metrics=collectRows(form,'metrics');}
      else data[tab]=collectRows(form,tab);
      await patch({...(title===undefined?{}:{title}),data});
    };
  }

  function modal(title,content){
    const d=document.createElement('dialog');d.className='menu-settings order-dialog';d.innerHTML=`<header><h2>${h(title)}</h2><button type="button" data-close aria-label="Закрыть">×</button></header>${content}`;document.body.append(d);d.showModal();d.querySelector('[data-close]').onclick=()=>{d.close();d.remove();};d.addEventListener('cancel',()=>d.remove());return d;
  }
  async function transition(current,target,done){
    if(!target)return;
    try{
      const fresh=await query(`/deals/${current.id}`),stage=fresh.stages.find(s=>s.code===target);if(!stage)return;
      const d=modal(`Перевести в «${stage.label}»`, `<form><p>Обязательные условия входа в этап</p><div>${stage.criteria.map(c=>c.type==='manual'?`<label class="order-check"><input type="checkbox" name="${c.id}" ${c.met?'checked':''}>${h(c.label)}</label>`:`<p>${c.met?'✓':'○'} ${h(c.label)}</p>`).join('')||'<p>Дополнительных условий нет.</p>'}</div>${ctx.identity.role==='owner'?'<label class="order-check"><input type="checkbox" name="override">Перейти под мою ответственность</label><label>Причина исключения<textarea name="reason"></textarea></label>':''}<p>Исключение и невыполненные условия сохранятся в истории сделки.</p><button type="submit">Перевести</button><p role="alert"></p></form>`);
      d.querySelector('form').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('[type=submit]');b.disabled=true;try{const checks={...fresh.checks};stage.criteria.filter(c=>c.type==='manual').forEach(c=>checks[c.id]=f.elements[c.id].checked);const updated=await query(`/deals/${fresh.id}`,{},ctx.csrfOptions('PATCH',{version:fresh.version,stage:target,data:{checks},...(f.elements.override?.checked?{override:{accepted:true,reason:f.elements.reason.value}}:{})}));d.close();d.remove();done(updated);}catch(err){f.querySelector('[role=alert]').textContent=err.message;b.disabled=false;}};
    }catch(e){error(e.message);}
  }
  async function showRules(){
    try{
      const data=await query('/deals/criteria');
      const card=s=>`<fieldset data-stage ${s.code?`data-code="${h(s.code)}"`:''}><legend>${h(s.label||'Новый этап')}</legend><div class="crm-form"><label>Название<input data-key="label" value="${h(s.label||'')}" required maxlength="40"></label><label>Цвет<input data-key="color" type="color" value="${h(s.color||'#8ab4f8')}"></label><label>Тип<select data-key="kind">${options({open:'В работе',won:'Заключена / успех',lost:'Отказ'},s.kind||'open')}</select></label><label class="order-check"><input data-key="attention" type="checkbox" ${s.attention?'checked':''}>Требует внимания</label></div><h3>Автоматические проверки</h3>${Object.entries(data.criterionLabels).map(([k,l])=>`<label class="order-check"><input data-rule="${k}" type="checkbox" ${s.rules?.required?.includes(k)?'checked':''}>${h(l)}</label>`).join('')}<p>Для успешного этапа договор и чек обязательны всегда.</p><label>Дополнительные критерии — каждый с новой строки<textarea data-key="manual">${h((s.rules?.manual||[]).join('\n'))}</textarea></label><label>Как вести клиента — каждый шаг с новой строки<textarea data-key="steps">${h((s.steps||[]).join('\n'))}</textarea></label><label>Результат этапа<textarea data-key="done">${h(s.done||'')}</textarea></label><div class="order-toolbar"><button type="button" data-up>↑ Выше</button><button type="button" data-down>↓ Ниже</button><button type="button" data-remove>Удалить этап</button></div></fieldset>`;
      const d=modal('Настроить воронку',`<form><label>Название воронки<input name="pipelineLabel" value="${h(data.label||root.querySelector('[data-order-pipeline]')?.selectedOptions[0]?.textContent||pipeline)}" maxlength="40" required></label><p>Названия и порядок этапов общие для воронки. Критерии и инструкции сохраняются для выбранного проекта. Этап со сделками удалить нельзя.</p><div data-stages>${data.stages.map(card).join('')}</div><button type="button" data-add>Добавить этап</button><button type="submit">Сохранить воронку</button><p role="alert"></p></form>`);
      d.onclick=e=>{const row=e.target.closest('[data-stage]'),list=d.querySelector('[data-stages]');if(e.target.matches('[data-add]'))list.insertAdjacentHTML('beforeend',card({}));if(!row)return;if(e.target.matches('[data-up]')&&row.previousElementSibling)list.insertBefore(row,row.previousElementSibling);if(e.target.matches('[data-down]')&&row.nextElementSibling)list.insertBefore(row.nextElementSibling,row);if(e.target.matches('[data-remove]'))row.remove();};
      d.querySelector('form').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('[type=submit]');b.disabled=true;try{const rows=[...f.querySelectorAll('[data-stage]')].map(row=>{const v={...(row.dataset.code?{code:row.dataset.code}:{}),required:[...row.querySelectorAll('[data-rule]:checked')].map(c=>c.dataset.rule)};row.querySelectorAll('[data-key]').forEach(i=>v[i.dataset.key]=i.type==='checkbox'?i.checked:['steps','manual'].includes(i.dataset.key)?i.value.split(/\r?\n/).map(t=>t.trim()).filter(Boolean):i.value);return v;});await query('/deals/criteria',{},ctx.csrfOptions('PUT',{label:f.elements.pipelineLabel.value,stages:rows}));d.close();d.remove();await loadList();}catch(err){f.querySelector('[role=alert]').textContent=err.message;b.disabled=false;}};
    }catch(e){error(e.message);}
  }
  function fileSection(){return `<section><h2>Прикреплённые файлы</h2>${(deal.files||[]).map(f=>`<p><a href="/content/crm/deals/${deal.id}/files/${h(f.id)}?${new URLSearchParams(ctx.scopeParams())}">${h(f.name)}</a> · ${h({contract:'Договор',receipt:'Чек',other:'Материал'}[f.kind])}</p>`).join('')||'<p>Файлов пока нет.</p>'}${editable()?'<form data-upload><label>Тип файла<select name="kind"><option value="contract">Договор</option><option value="receipt">Чек</option><option value="other">Другой документ</option></select></label><input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg,.docx" required><button type="submit">Прикрепить файл</button><small>PDF, JPG, PNG, DOCX, до 6 МБ</small><p role="alert"></p></form>':''}</section>`;}
  function bindUpload(){const f=root.querySelector('[data-upload]');if(!f)return;f.onsubmit=async e=>{e.preventDefault();const file=f.elements.file.files[0],b=f.querySelector('button');if(!file)return;b.disabled=true;try{if(file.size>6*1024*1024)throw new Error('Файл больше 6 МБ');const base64=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=reject;r.readAsDataURL(file);});await query(`/deals/${deal.id}/files`,{},ctx.csrfOptions('POST',{name:file.name,mime:file.type||'application/vnd.openxmlformats-officedocument.wordprocessingml.document',kind:f.elements.kind.value,base64}));deal=await query(`/deals/${deal.id}`);stages=deal.stages;renderDetail();}catch(err){f.querySelector('[role=alert]').textContent=err.message;b.disabled=false;}};}

  cabinet.registerView('deals',{
    title:'Сделки и заказы',
    async render(container,context){
      ctx=context;root=container.querySelector('#order-workspace');
      const legacy=location.hash==='#deals/companies';root.hidden=legacy;container.querySelector('#deals-legacy').hidden=!legacy;
      if(legacy){++generation;cabinet.legacyDeals.render(container,context);return;}
      const match=location.hash.match(/^#deals\/(\d+)$/);
      if(!ctx.hasPermission('crm.view')){root.textContent='Нет доступа к сделкам';return;}
      if(!match){await loadList();return;}
      const version=++generation;root.innerHTML=header()+'<p>Загрузка сделки…</p>';tab='overview';
      try{const data=await query(`/deals/${match[1]}`);if(version!==generation)return;deal=data;stages=data.stages;renderDetail();}catch(e){if(version===generation)error(e.message);}
    }
  });
})();
