(() => {
 const sb=window.SbCabinet ||= {};let ctx,root,catalog,generation=0,financeData,offset=0;
 const h=v=>ctx.escapeHTML(String(v??'')),money=v=>v===null||v===undefined?'Уточняется':new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB'}).format(v),uid=()=>crypto.randomUUID();
 const localDay=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`};
 const request=(path,params={},options={})=>ctx.crmQuery(path,{...ctx.scopeParams(),...params},options);
 const error=m=>{const e=root.querySelector('[data-commercial-error]');if(e)e.textContent=m};
 const select=(name,label,choices,value)=>`<label>${label}<select name="${name}">${Object.entries(choices).map(([k,v])=>`<option value="${k}"${value===k?' selected':''}>${h(v)}</option>`).join('')}</select></label>`;
 const input=(name,label,value='',type='text')=>`<label>${label}<input name="${name}" type="${type}" value="${h(value)}"${type==='number'?' min="0" step="0.01"':''}></label>`;
 const area=(name,label,value='')=>`<label class="wide">${label}<textarea name="${name}">${h(value)}</textarea></label>`;
 const modal=(title,body)=>{const d=document.createElement('dialog');d.className='commercial-dialog';d.dataset.generation=String(generation);d.innerHTML=`<header><h2>${h(title)}</h2><button data-close type="button" aria-label="Закрыть">×</button></header>${body}`;document.body.append(d);d.showModal();d.querySelector('[data-close]').onclick=()=>{d.close();d.remove()};d.addEventListener('cancel',()=>d.remove());return d};
 const title=(name,text)=>`<div class="content-header"><h1>${name}</h1><p>${text}</p></div><p data-commercial-error role="alert"></p>`;
 async function loadCatalog(){const v=++generation;if(ctx.scopeParams().companyCode!=='synapse-business'){root.innerHTML=title('Модули и пакеты','Каталог услуг Synapse принадлежит компании Synapse Бизнес. Для выбранной компании здесь нет настроенного каталога.')+'<button type="button" data-open-synapse>Перейти в Synapse Бизнес</button>';root.querySelector('[data-open-synapse]').onclick=()=>ctx.chooseProject('synapse-business');return;}root.innerHTML=title('Модули и пакеты','Прайс Synapse. Условия владельца, стоимость модулей и конструктор предложений.')+'<p>Загрузка…</p>';try{const result=await request('/catalog');if(v!==generation)return;catalog=result;renderCatalog()}catch(e){if(v===generation)error(e.message)}}
 function priceComparison(base,price,suffix){if(price===null)return `<span>${money(base)} ${suffix} · итоговая цена не задана</span>`;return `<span>${price<base?`<s>${money(base)}</s> `:''}<strong>${money(price)} ${suffix}</strong>${price<base?` · экономия ${money(Math.round((base-price)*100)/100)}`:''}</span>`}
 function renderCatalog(){
  root.innerHTML=title('Модули и пакеты','Сначала состав и условия, затем цена. Разовые работы и подписка считаются отдельно.')+`<div class="commercial-actions"><button data-new-package>Создать пакет</button><button data-new-product>Добавить модуль</button></div><h2>Пакеты</h2><div class="commercial-grid">${catalog.packages.map(p=>`<article class="card commercial-card"><small>${p.status==='available'?'Готов к предложению':'Черновик'}</small><h3>${h(p.name)}</h3><ul>${p.lines.map(l=>`<li>${h(catalog.products.find(m=>m.id===l.productId)?.name)}${l.quantity>1?' × '+l.quantity:''}</li>`).join('')}</ul><div class="commercial-prices">${p.allAvailable?`<strong>${money(p.priceMonthly)} / мес</strong><span>Реализованные модули входят в подписку. Будущие разработки — по специальным условиям.</span>`:priceComparison(p.totals.once,p.priceOnce,'разово')+priceComparison(p.totals.monthly,p.priceMonthly,'/ мес')}</div>${p.totals.unknown?'<p>Есть модули с неустановленной ценой.</p>':''}<p>${h(p.terms)}</p><button data-package="${h(p.id)}">Настроить пакет</button></article>`).join('')}</div><h2>Модули</h2><div class="commercial-grid">${catalog.products.map(p=>`<article class="card commercial-card"><small>${p.status==='available'?'Можно предложить':'В разработке'}</small><h3>${h(p.name)}</h3><strong>${p.price!==null&&p.billing==='once'?'от ':''}${money(p.price)}${p.billing==='monthly'&&p.price!==null?' / мес':''}${p.priceMax!==null?' — '+money(p.priceMax):''}</strong><p>${h(p.description)}</p><p>${h(p.delivery)} · ${h(p.term)}</p><details><summary>Задача, выгода и план внедрения</summary><p><b>Боль:</b> ${h(p.problem)}</p><p><b>Преимущество:</b> ${h(p.benefit)}</p><p><b>Экономика:</b> ${h(p.economics)}</p><ol>${p.steps.map(t=>`<li>${h(t)}</li>`).join('')}</ol><p>${h(p.support)}</p>${p.dependencies.length?`<p>Требуется: ${p.dependencies.map(id=>h(catalog.products.find(p=>p.id===id)?.name||id)).join(', ')}</p>`:''}</details><button data-product="${h(p.id)}">Редактировать</button></article>`).join('')}</div>`;
  sb.renderModuleGuide?.(root,'catalog',ctx);root.querySelector('[data-new-package]').onclick=()=>editPackage();root.querySelector('[data-new-product]').onclick=()=>editProduct();root.querySelectorAll('[data-package]').forEach(b=>b.onclick=()=>editPackage(catalog.packages.find(p=>p.id===b.dataset.package)));root.querySelectorAll('[data-product]').forEach(b=>b.onclick=()=>editProduct(catalog.products.find(p=>p.id===b.dataset.product)));
 }
 async function persist(d,next){if(Number(d.dataset.generation)!==generation){d.querySelector('[role=alert]').textContent='Проект или раздел изменён. Откройте форму заново.';return;}const button=d.querySelector('[type=submit]');if(button.disabled)return;button.disabled=true;try{catalog=await request('/catalog',{},ctx.csrfOptions('PUT',next));d.close();d.remove();renderCatalog()}catch(e){d.querySelector('[role=alert]').textContent=e.message;button.disabled=false}}
 function editProduct(current){const p=current||{id:uid(),name:'',status:'development',billing:'once',price:null,priceMax:null,dependencies:[],steps:[]};
  const d=modal(current?'Редактировать модуль':'Новый модуль',`<form class="crm-form">${input('name','Название',p.name)}${select('status','Готовность',{available:'Можно предложить',development:'В разработке'},p.status)}${select('billing','Оплата',{once:'Разово',monthly:'Ежемесячно'},p.billing)}${input('price','Цена от, ₽ (пусто — неизвестна)',p.price,'number')}${input('priceMax','Максимальная цена, ₽',p.priceMax,'number')}${input('delivery','Срок реализации',p.delivery)}${input('term','Срок договора',p.term)}${area('description','Состав модуля',p.description)}${area('support','Обслуживание и дополнительные расходы',p.support)}${area('problem','Какую боль закрывает',p.problem)}${area('benefit','Преимущество для клиента',p.benefit)}${area('economics','Как оценивать финансовую выгоду',p.economics)}${area('steps','Шаги внедрения — каждый с новой строки',p.steps.join('\n'))}<fieldset class="wide"><legend>Обязательные модули</legend>${catalog.products.filter(v=>v.id!==p.id).map(v=>`<label class="commercial-check"><input type="checkbox" data-dependency="${h(v.id)}"${p.dependencies.includes(v.id)?' checked':''}>${h(v.name)}</label>`).join('')}</fieldset><button type="submit">Сохранить модуль</button><p role="alert"></p></form>`);d.querySelector('form').onsubmit=e=>{e.preventDefault();const f=e.currentTarget,value={...p};for(const key of ['name','status','billing','delivery','term','description','support','problem','benefit','economics'])value[key]=f.elements[key].value;for(const key of ['price','priceMax'])value[key]=f.elements[key].value===''?null:Number(f.elements[key].value);value.steps=f.elements.steps.value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);value.dependencies=[...f.querySelectorAll('[data-dependency]:checked')].map(i=>i.dataset.dependency);persist(d,{...catalog,products:current?catalog.products.map(v=>v.id===p.id?value:v):[...catalog.products,value]})};
 }
 function editPackage(current){const p=current||{id:uid(),name:'',status:'draft',lines:[],priceOnce:null,priceMonthly:null,terms:'',allAvailable:false};
  const d=modal(current?'Настроить пакет':'Новый пакет',`<form><div class="crm-form">${input('name','Название пакета',p.name)}${select('status','Статус',{draft:'Черновик',available:'Готов к предложению'},p.status)}</div><p>Выберите модули. Цены строк можно уточнить для конкретного состава работ. Модули в разработке не входят в готовый пакет.</p><div class="commercial-package-lines">${catalog.products.map(m=>{const l=p.lines.find(l=>l.productId===m.id);return `<div data-line="${h(m.id)}"><label class="commercial-check"><input data-pick type="checkbox"${l?' checked':''}>${h(m.name)} · ${m.billing==='monthly'?'в месяц':'разово'}${m.status==='development'?' · в разработке':''}</label><div class="crm-form">${input('q-'+m.id,'Количество',l?.quantity||1,'number')}${input('p-'+m.id,'Цена за модуль, ₽',l?l.unitPrice:m.price,'number')}</div></div>`}).join('')}</div><div class="commercial-summary" data-calculation role="status"></div><div class="crm-form">${input('priceOnce','Ваша цена разово, ₽',p.priceOnce,'number')}${input('priceMonthly','Ваша цена в месяц, ₽',p.priceMonthly,'number')}</div>${area('terms','Условия пакета',p.terms)}<label class="commercial-check"><input name="allAvailable" type="checkbox"${p.allAvailable?' checked':''}>Партнёрская программа: все реализованные модули и специальные предложения на будущие</label><p>Состав текущего предложения указан выше. Разработки не считаются подключёнными.</p><button type="submit">Сохранить пакет</button><p role="alert"></p></form>`);
  const f=d.querySelector('form'),collect=()=>[...f.querySelectorAll('[data-line]')].filter(r=>r.querySelector('[data-pick]').checked).map(r=>({productId:r.dataset.line,quantity:Number(f.elements['q-'+r.dataset.line].value),unitPrice:f.elements['p-'+r.dataset.line].value===''?null:Number(f.elements['p-'+r.dataset.line].value)}));
  const calc=()=>{const lines=collect();let once=0,monthly=0,unknown=false;const missing=new Set();for(const l of lines){const m=catalog.products.find(m=>m.id===l.productId);if(l.unitPrice===null)unknown=true;else if(m.billing==='monthly')monthly+=Math.round(l.unitPrice*100)*l.quantity;else once+=Math.round(l.unitPrice*100)*l.quantity;for(const id of m.dependencies)if(!lines.some(l=>l.productId===id))missing.add(id)}f.querySelector('[data-calculation]').innerHTML=`<h3>Расчёт пакета</h3>${f.elements.allAvailable.checked?`<p>Партнёрская подписка: ${money(f.elements.priceMonthly.value===''?null:Number(f.elements.priceMonthly.value))} / мес. Разовые работы входят в согласованный состав подписки.</p>`:priceComparison(once/100,f.elements.priceOnce.value===''?null:Number(f.elements.priceOnce.value),'разово')+priceComparison(monthly/100,f.elements.priceMonthly.value===''?null:Number(f.elements.priceMonthly.value),'/ мес')}${unknown?'<p>Уточните цену выбранных модулей.</p>':''}${missing.size?`<p>Нужно добавить: ${[...missing].map(id=>h(catalog.products.find(m=>m.id===id).name)).join(', ')}</p>`:''}`};f.oninput=calc;calc();f.onsubmit=e=>{e.preventDefault();const value={id:p.id,name:f.elements.name.value,status:f.elements.status.value,lines:collect(),priceOnce:f.elements.priceOnce.value===''?null:Number(f.elements.priceOnce.value),priceMonthly:f.elements.priceMonthly.value===''?null:Number(f.elements.priceMonthly.value),terms:f.elements.terms.value,allAvailable:f.elements.allAvailable.checked};persist(d,{...catalog,packages:current?catalog.packages.map(v=>v.id===p.id?value:v):[...catalog.packages,value]})};
 }
 async function loadFinance(params){const version=++generation;const today=localDay(),from=params?.from||today.slice(0,7)+'-01',to=params?.to||today;root.innerHTML=title('Финансы','Доходы, расходы и планы выбранного проекта. Записи вручную; счёт сам по себе не считается поступлением.')+`<form data-period class="commercial-actions">${input('from','С',from,'date')}${input('to','По',to,'date')}<button type="submit">Показать</button></form><div data-finance-body>Загрузка…</div>`;root.querySelector('[data-period]').onsubmit=e=>{e.preventDefault();offset=0;loadFinance({from:e.currentTarget.elements.from.value,to:e.currentTarget.elements.to.value})};try{const data=await request('/finances',{from,to,offset});if(version!==generation)return;financeData=data;renderFinance()}catch(e){if(version===generation)error(e.message)}}
 /* Расходы на ИИ: отдельные суммы факта, плана и оценки. Они не складываются между собой,
    а пополнение баланса и оплата клиента не входят в наш расход. */
 function aiSummaryBlock(ai){if(!ai)return '';
  const row=(label,value,hint)=>`<div><small>${h(label)}</small><strong>${money(value)}</strong>${hint?`<small>${h(hint)}</small>`:''}</div>`;
  return `<section class="card commercial-ai"><h2>Расходы на ИИ</h2>
   <div class="commercial-summary">${row('Фактически потрачено',ai.actual.spend,'подписки и потребление')}${row('Из них по счёту',ai.actual.invoiced)}${row('Из них расчётная оценка',ai.actual.estimated)}${row('План',ai.planned.spend,'не потрачено')}</div>
   <p>Пополнение баланса: ${money(ai.topups.actual)} факт · ${money(ai.topups.planned)} план — движение денег, не расход.</p>
   <p>Оплата клиента: ${money(ai.clientPaid.actual)} факт · ${money(ai.clientPaid.planned)} план — не наш расход.</p>
   <p>Операций с ИИ: ${h(ai.entries)} · без подтверждённой стоимости: ${h(ai.unknown.count)}${ai.unknown.withoutAmount?` (из них без суммы: ${h(ai.unknown.withoutAmount)})`:''}</p>
   ${Object.keys(ai.currencies).length?`<p>В валюте источника: ${Object.entries(ai.currencies).map(([c,v])=>`${h(c)} ${h(v.actual)} факт / ${h(v.planned)} план`).join(' · ')}</p>`:''}
   <p class="commercial-note">${h(ai.basis)}</p>
   <div class="commercial-actions"><button data-new-ai>Добавить расход на ИИ</button><button data-open-trials>Испытания моделей</button></div></section>`}
 function renderFinance(){const d=financeData;root.querySelector('[data-finance-body]').innerHTML=`<div class="commercial-summary">${[['Доходы',d.totals.income],['Расходы',d.totals.expense],['Остаток за период',d.totals.balance],['План доходов',d.totals.plannedIncome],['План расходов',d.totals.plannedExpense]].map(([l,v])=>`<div><small>${l}</small><strong>${money(v)}</strong></div>`).join('')}</div>${aiSummaryBlock(d.ai)}<div data-trials-body></div><div class="commercial-actions"><button data-new-entry="income">Добавить доход</button><button data-new-entry="expense">Добавить расход</button></div><div class="commercial-grid">${d.entries.map(e=>`<article class="card commercial-card"><small>${h(e.date)} · ${h({planned:'План',actual:'Факт',void:'Отменено'}[e.state])}</small><h3>${e.type==='income'?'+':'−'} ${money(e.amount)}</h3><strong>${h(e.category)}</strong><p>${h(e.counterparty)}</p><p>${h(e.note)}</p>${e.dealId?`<a href="#deals/${e.dealId}">Сделка №${e.dealId}</a>`:''}<button data-entry="${e.id}">Редактировать</button></article>`).join('')||'<p>За этот период операций нет.</p>'}</div><div class="commercial-actions"><button data-prev ${offset===0?'disabled':''}>Назад</button><span>${Math.min(offset+1,d.total)}–${Math.min(offset+100,d.total)} из ${d.total}</span><button data-next ${offset+100>=d.total?'disabled':''}>Дальше</button></div>`;sb.renderModuleGuide?.(root,'finance',ctx);/* Блока ИИ может не быть, если сервис ещё не обновлён: раздел Финансов от этого не ломается. */
  const aiButton=root.querySelector('[data-new-ai]');if(aiButton)aiButton.onclick=()=>editAiEntry();
  const trialsButton=root.querySelector('[data-open-trials]');if(trialsButton)trialsButton.onclick=()=>loadTrials();root.querySelectorAll('[data-new-entry]').forEach(b=>b.onclick=()=>editEntry(null,b.dataset.newEntry));root.querySelectorAll('[data-entry]').forEach(b=>b.onclick=()=>editEntry(d.entries.find(e=>String(e.id)===b.dataset.entry)));root.querySelector('[data-prev]').onclick=()=>{offset=Math.max(0,offset-100);loadFinance(d)};root.querySelector('[data-next]').onclick=()=>{offset+=100;loadFinance(d)}}
 function editEntry(current,type){const e=current||{type,state:'actual',date:localDay(),amount:'',category:'',counterparty:'',note:'',dealId:null};const requestId=uid(),d=modal(current?'Финансовая операция':'Новая операция',`<form class="crm-form">${select('type','Тип',{income:'Доход',expense:'Расход'},e.type)}${select('state','Статус',{actual:'Фактический платёж',planned:'Планируется',void:'Отменено'},e.state)}${input('date','Дата',e.date,'date')}${input('amount','Сумма, ₽',e.amount,'number')}${input('category','Категория',e.category)}${input('counterparty','Клиент / поставщик',e.counterparty)}<label>Сделка (необязательно)<select name="dealId"><option value="">Без сделки</option>${e.dealId?`<option value="${e.dealId}" selected>Сделка №${e.dealId}</option>`:''}</select></label>${area('note','Комментарий',e.note)}<p>Не отмечайте ожидаемый платёж как фактический. Отмена сохраняет запись и исключает её из расчёта.</p><button type="submit">Сохранить операцию</button><p role="alert"></p></form>`);const f=d.querySelector('form');f.elements.category.setAttribute('list','finance-category-choices');f.insertAdjacentHTML('beforeend','<datalist id="finance-category-choices">'+['Партнёры','Создание сайта','AI-автоматизация','Подписки на модули','API и AI-сервисы','Хостинг и серверы','Реклама','Оплата команды','Прочее'].map(v=>'<option value="'+h(v)+'"></option>').join('')+'</datalist>');request('/deals').then(result=>{if(!d.isConnected)return;const select=f.elements.dealId;result.deals.forEach(item=>{if(String(item.id)!==String(e.dealId))select.add(new Option('№'+item.id+' · '+item.title,item.id))})}).catch(err=>f.querySelector('[role=alert]').textContent=err.message);f.onsubmit=async ev=>{ev.preventDefault();if(Number(d.dataset.generation)!==generation){f.querySelector('[role=alert]').textContent='Проект изменён. Откройте операцию заново.';return;}const b=f.querySelector('[type=submit]');if(b.disabled)return;b.disabled=true;const body={requestId,...(current?{version:current.version}:{}),type:f.elements.type.value,state:f.elements.state.value,date:f.elements.date.value,amount:Number(f.elements.amount.value),category:f.elements.category.value,counterparty:f.elements.counterparty.value,note:f.elements.note.value,dealId:f.elements.dealId.value?Number(f.elements.dealId.value):null};try{await request('/finances'+(current?'/'+current.id:''),{},ctx.csrfOptions(current?'PATCH':'POST',body));d.close();d.remove();loadFinance(financeData)}catch(err){f.querySelector('[role=alert]').textContent=err.message;b.disabled=false}};
 }
 /* Форма расхода на ИИ. Неподтверждённая стоимость записывается нулём и не подменяется
    заглушкой; сумма в поле блокируется, чтобы это нельзя было сделать случайно. */
 function editAiEntry(){
  const requestId=uid();
  const d=modal('Расход на ИИ',`<form class="crm-form">
   ${select('state','Статус',{actual:'Фактический платёж',planned:'Планируется'},'actual')}
   ${input('date','Дата',localDay(),'date')}
   ${input('category','Категория','API и AI-сервисы')}
   ${input('service','Сервис или провайдер','')}
   ${input('accountLabel','Метка аккаунта (без ключей)','')}
   ${input('client','Клиент или интерфейс (не модель)','')}
   ${input('modelId','Фактическая модель (пусто — не подтверждена)','')}
   ${select('mode','Режим',{api:'API',subscription:'Подписка'},'api')}
   ${select('movement','Движение (для API)',{consumption:'Потребление',topup:'Пополнение баланса'},'consumption')}
   ${input('periodFrom','Период подписки с','','date')}${input('periodTo','по','','date')}
   ${select('paidBy','Платит',{us:'Мы',client:'Клиент'},'us')}
   ${select('costKnown','Стоимость',{yes:'Известна',no:'Не подтверждена'},'yes')}
   ${select('costBasis','Основание',{invoice:'Счёт провайдера',estimate:'Наш расчёт'},'invoice')}
   ${input('sourceCurrency','Валюта источника','USD')}${input('sourceAmount','Сумма в валюте источника','','number')}
   ${input('amount','Сумма в рублях','','number')}
   ${input('rateValue','Курс','','number')}${input('rateAt','Дата курса','','date')}${input('rateSource','Источник курса','')}
   ${area('confirmation','Чем подтверждено','')}
   <p class="commercial-note">Неподтверждённая стоимость записывается нулевой суммой. Пополнение баланса — движение денег, а не расход. Оплата клиента не наш расход.</p>
   <button type="submit">Сохранить расход</button><p role="alert"></p></form>`);
  const f=d.querySelector('form');
  const sync=()=>{const unknown=f.elements.costKnown.value==='no',estimate=f.elements.costBasis.value==='estimate';
   f.elements.costBasis.disabled=unknown&&false;
   if(unknown&&!estimate){f.elements.amount.value='0';f.elements.amount.readOnly=true;f.elements.sourceAmount.value='';f.elements.sourceAmount.readOnly=true}
   else{f.elements.amount.readOnly=false;f.elements.sourceAmount.readOnly=false}
   const api=f.elements.mode.value==='api';
   f.elements.movement.closest('label').hidden=!api;
   f.elements.periodFrom.closest('label').hidden=api;f.elements.periodTo.closest('label').hidden=api};
  f.onchange=sync;sync();
  f.onsubmit=async e=>{e.preventDefault();const b=f.querySelector('[type=submit]');if(b.disabled)return;b.disabled=true;
   const unknown=f.elements.costKnown.value==='no',api=f.elements.mode.value==='api';
   const rate=f.elements.rateValue.value?{value:Number(f.elements.rateValue.value),at:f.elements.rateAt.value,source:f.elements.rateSource.value}:null;
   const ai={service:f.elements.service.value,accountLabel:f.elements.accountLabel.value,
    client:f.elements.client.value||null,modelId:f.elements.modelId.value||null,mode:f.elements.mode.value,
    ...(api?{movement:f.elements.movement.value}:{periodFrom:f.elements.periodFrom.value,periodTo:f.elements.periodTo.value}),
    paidBy:f.elements.paidBy.value,costKnown:!unknown,
    costBasis:unknown?(f.elements.costBasis.value==='estimate'?'estimate':null):f.elements.costBasis.value,
    sourceCurrency:f.elements.sourceCurrency.value,
    sourceAmount:f.elements.sourceAmount.value===''?null:Number(f.elements.sourceAmount.value),
    rate,confirmation:f.elements.confirmation.value};
   const body={requestId,type:'expense',state:f.elements.state.value,date:f.elements.date.value,
    amount:Number(f.elements.amount.value||0),category:f.elements.category.value,counterparty:'',note:'',dealId:null,ai};
   try{await request('/finances',{},ctx.csrfOptions('POST',body));d.close();d.remove();loadFinance(financeData)}
   catch(err){f.querySelector('[role=alert]').textContent=err.message;b.disabled=false}};
 }
 /* Испытания кандидатов: устойчивое хранилище, только техничные поля.
    Тексты клиентов, ответы моделей и секреты сюда не попадают. */
 async function loadTrials(){const version=generation;let data;
  try{data=await request('/ai-trials')}catch(e){error(e.message);return}
  if(version!==generation)return;const body=root.querySelector('[data-trials-body]');if(!body)return;
  body.innerHTML=`<section class="card commercial-trials"><h2>Испытания моделей</h2>
   <p class="commercial-note">${h(data.conclusions.basis)}</p>
   <table><thead><tr><th>Провайдер и модель</th><th>Выборка</th><th>Успех</th><th>Попытки</th><th>Нарушения фактов / изоляции</th><th>Оценка</th><th>Стоимость принятой задачи</th></tr></thead>
   <tbody>${data.conclusions.models.map(m=>`<tr><td>${h(m.provider)}<br><small>${h(m.modelId)}</small></td><td>${h(m.sampleSize)}</td><td>${m.successRate===null?'—':h(m.successRate)+'%'}</td><td>${h(m.attempts)}</td><td>${h(m.factViolations)} / ${h(m.isolationViolations)}</td><td>${m.averageScore===null?'—':h(m.averageScore)}</td><td>${Object.entries(m.costPerAcceptedTask).map(([c,v])=>v===null?`${h(c)}: —`:`${h(c)} ${h(v)}`).join(' · ')||'—'}${m.costComplete?'':'<br><small>есть строки без стоимости</small>'}</td></tr>`).join('')||'<tr><td colspan="7">Испытаний пока нет.</td></tr>'}</tbody></table>
   <div class="commercial-actions"><button data-new-trial>Добавить испытание</button></div>
   <ol class="commercial-trial-list">${data.trials.map(t=>`<li>${h(t.setId)} · ${h(t.taskId)} · ${h(t.modelId)} · ${t.success?'успех':'неудача'} · вывод: ${h(t.verdict)}</li>`).join('')}</ol></section>`;
  body.querySelector('[data-new-trial]').onclick=()=>editTrial();
 }
 function editTrial(){
  const d=modal('Испытание модели',`<form class="crm-form">
   ${input('setId','Набор заданий','')}${input('taskId','Задача','')}
   ${input('provider','Провайдер','')}${input('modelId','Фактическая модель','')}
   ${input('role','Роль (необязательно)','')}
   ${input('attempts','Попытки','1','number')}${input('durationMs','Длительность, мс','0','number')}
   ${select('success','Результат',{no:'Неудача',yes:'Успех'},'no')}
   ${input('factViolations','Нарушения фактов','0','number')}${input('isolationViolations','Нарушения изоляции','0','number')}
   ${select('manualEdit','Правил человек',{no:'Нет',yes:'Да'},'no')}
   ${input('humanScore','Оценка человека 1–5 (пусто — нет)','','number')}
   ${input('reportRef','Ссылка на безопасный отчёт','')}
   ${select('costKnown','Стоимость',{yes:'Известна',no:'Неизвестна'},'no')}
   ${input('costCurrency','Валюта','USD')}${input('costAmount','Стоимость с учётом повторов','','number')}
   ${select('costBasis','Основание',{estimate:'Наш расчёт',invoice:'Счёт провайдера'},'estimate')}
   ${select('verdict','Вывод',{pending:'Ещё не решено',accepted:'Принято',rejected:'Отклонено',needs_review:'Нужна проверка'},'pending')}
   ${area('note','Основание вывода','')}
   <p class="commercial-note">Тексты клиентов, ответы моделей и ключи сюда не вносятся: только ссылка на безопасный отчёт.</p>
   <button type="submit">Сохранить испытание</button><p role="alert"></p></form>`);
  const f=d.querySelector('form');
  f.onsubmit=async e=>{e.preventDefault();const b=f.querySelector('[type=submit]');if(b.disabled)return;b.disabled=true;
   const known=f.elements.costKnown.value==='yes';
   const body={setId:f.elements.setId.value,taskId:f.elements.taskId.value,provider:f.elements.provider.value,
    modelId:f.elements.modelId.value,role:f.elements.role.value||null,
    attempts:Number(f.elements.attempts.value||1),durationMs:Number(f.elements.durationMs.value||0),
    success:f.elements.success.value==='yes',factViolations:Number(f.elements.factViolations.value||0),
    isolationViolations:Number(f.elements.isolationViolations.value||0),manualEdit:f.elements.manualEdit.value==='yes',
    humanScore:f.elements.humanScore.value===''?null:Number(f.elements.humanScore.value),
    reportRef:f.elements.reportRef.value,costKnown:known,costCurrency:f.elements.costCurrency.value||null,
    ...(known?{costAmount:Number(f.elements.costAmount.value||0),costBasis:f.elements.costBasis.value}:{costBasis:f.elements.costBasis.value}),
    verdict:f.elements.verdict.value,note:f.elements.note.value};
   try{await request('/ai-trials',{},ctx.csrfOptions('POST',body));d.close();d.remove();loadTrials()}
   catch(err){f.querySelector('[role=alert]').textContent=err.message;b.disabled=false}};
 }
 for(const view of ['catalog','finance'])sb.registerView(view,{title:view==='catalog'?'Модули и пакеты':'Финансы',render(container,context){ctx=context;root=container;if(ctx.identity.role!=='owner'){root.textContent='Раздел доступен владельцу';return}offset=0;view==='catalog'?loadCatalog():loadFinance()}});
})();
