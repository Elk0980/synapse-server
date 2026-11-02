(() => {
"use strict";

const SbCabinet = window.SbCabinet = window.SbCabinet || {};
let ctx, byId, escapeHTML, crmQuery, csrfOptions, scopeParams, chooseProject, navigate;
let initialized = false;
const api = {};
const init = (context) => {
  ctx = context;
  ({ byId, escapeHTML, crmQuery, csrfOptions, scopeParams, chooseProject, navigate } = context);
  if (initialized) return;
  initialized = true;

  const TASK_ROLES = Object.freeze({
    owner: "Собственник",
    admin: "Администратор",
    marketer: "Маркетолог",
    synapse: "Synapse"
  });
  const TASK_STATUSES = Object.freeze({
    inbox: "Входящие",
    planned: "Запланировано",
    in_progress: "В работе",
    done: "Сделано",
    cancelled: "Отменено"
  });
  const TASK_PRIORITIES = Object.freeze({
    low: "Низкий",
    normal: "Обычный",
    high: "Высокий",
    urgent: "Срочный"
  });
  const TASK_SOURCES = Object.freeze({ manual: "Вручную", chat: "Чат", telegram: "Telegram", pipeline: "Воронка" });
  const TASK_PIPELINES = Object.freeze({ sale: "Продажа", service: "Сервис" });
  const FILTER_KEYS = ["status", "companyCode", "pipeline", "assigneeRole", "source", "q"];
  const taskState = {
    status: "", companyCode: "", pipeline: "", assigneeRole: "", source: "", q: "",
    companies: []
  };
  let renderVersion = 0;
  let searchTimer;
  const resourceLeases = new Map();
  const renderServerQueue = async () => {
    if(ctx.identity?.role !== 'owner') return;
    clearTimeout(boardTimer);
    const version=++renderVersion,content=byId('tasks-content');
    content.textContent='Загрузка очереди сервера…';
    try {
      const data=await crmQuery('/coordination/server-resource',{});
      if(version!==renderVersion||ctx.currentView!=='tasks')return;
      const states={unknown:'Требуется проверка',idle:'Свободен после проверки',running:'Занят'};
      const events={queued:'Ожидает',claimed:'Начало работы',renewed:'Работа продолжается',released:'Работа завершена',expired:'Пропущено завершение',confirmed_idle:'Свобода проверена',check_stale:'Проверка устарела',cancelled:'Ожидание отменено'};
      const holder=data.holder,lease=holder&&resourceLeases.get(holder.id);
      content.innerHTML=`<h2>Очередь общего сервера</h2><p><strong>${escapeHTML(states[data.state]||'Требуется проверка')}</strong> · время сервера: ${escapeHTML(displayDate(data.serverTime))}</p>
        <p>Проверено: ${escapeHTML(displayDate(data.checkedAt)||'Ещё не проверено')} · ${escapeHTML(data.evidence||'Нет основания')}</p>
        <p class="crm-muted">Перед изменениями исполнитель занимает ресурс, сообщает продолжение и завершение. Истёкшая аренда требует проверки результата. Произвольный SSH вне очереди технически не блокируется. Таймер не разрешает публикацию.</p>
        <div class="crm-actions"><button type="button" data-resource-back>К доске проектов</button><button type="button" data-resource-refresh>Обновить очередь</button></div>
        ${holder?`<section class="crm-card"><h3>Сейчас: ${escapeHTML(holder.executor)} · ${escapeHTML(holder.taskRef)}</h3><p>Чат: ${escapeHTML(holder.threadId)}<br>Область: ${escapeHTML(holder.scope)}<br>Начало: ${escapeHTML(displayDate(holder.startedAt))}<br>Аренда до: ${escapeHTML(displayDate(holder.leaseUntil))}</p>
        ${lease?`<label>Результат и проверка освобождения<textarea data-resource-release-note maxlength="2000"></textarea></label><button type="button" data-resource-release>Завершить и освободить</button>${data.state==='running'?'<button type="button" data-resource-renew>Продлить свою аренду</button>':''}`:'<p>Токена этой аренды в данной сессии нет. Не повторяйте занятие: продолжите в сессии исполнителя или проверьте исход.</p>'}</section>`:''}
        ${data.state!=='running'?`<form data-resource-idle><label>Основание свежей проверки свободы<textarea name="evidence" required maxlength="2000"></textarea></label>${holder?'<label>Проверенный исход<select name="outcome"><option value="">Выберите исход</option><option value="completed">Завершено</option><option value="stopped">Остановлено</option><option value="rolled_back">Откат выполнен</option><option value="no_write">Запись не начиналась</option></select></label>':''}<button type="submit">Подтвердить свободу после проверки</button></form>`:''}
        <h3>Ожидают</h3>${data.queue.map((r,i)=>`<article class="crm-card"><strong>${i+1}. ${escapeHTML(r.executor)} · ${escapeHTML(r.taskRef)}</strong><p>Чат: ${escapeHTML(r.threadId)}<br>${escapeHTML(r.scope)}<br>Не раньше: ${escapeHTML(displayDate(r.notBefore))} · ${r.durationMinutes}мин</p>${i===0&&data.state==='idle'?`<button type="button" data-resource-claim="${r.id}">Занять сервер</button>`:''}<button type="button" data-resource-cancel="${r.id}">Отменить ожидание</button></article>`).join('')||'<p>Очередь пуста.</p>'}
        <details><summary>Добавить работу в очередь</summary><form data-resource-add><label>Задача<input name="taskRef" required maxlength="120"></label><label>Постоянный ID чата<input name="threadId" required maxlength="200"></label><label>Исполнитель<input name="executor" required maxlength="200"></label><label>Область работы<textarea name="scope" required maxlength="2000"></textarea></label><label>Не раньше<input type="datetime-local" name="notBefore" required value="${escapeHTML(localDateInput(data.serverTime).slice(0,16))}"></label><label>Длительность, минут<input name="durationMinutes" type="number" min="5" max="60" value="15" required></label><button type="submit">Добавить в очередь</button></form></details>
        <p>Следующая проверка: ${escapeHTML(displayDate(data.nextCheckAt))}</p><p role="status" data-resource-message></p>
        <details><summary>Журнал сервера</summary>${data.history.map(h=>`<article><p>${escapeHTML(displayDate(h.at))} · ${escapeHTML(events[h.event]||h.event)}${h.executor?' · '+escapeHTML(h.executor):''}${h.taskRef?' · '+escapeHTML(h.taskRef):''}</p>${h.threadId?'<p>Чат: '+escapeHTML(h.threadId)+'<br>Область: '+escapeHTML(h.scope)+'</p>':''}<p>${escapeHTML(h.note)} · автор №${h.actorId}</p></article>`).join('')}</details>`;
      const current=()=>version===renderVersion&&ctx.currentView==='tasks';
      const send=async(body,button)=>{button.disabled=true;try{const result=await crmQuery('/coordination/server-resource/action',{},csrfOptions('POST',{revision:data.revision,...body}));if(result.leaseToken)resourceLeases.set(body.requestId,{leaseToken:result.leaseToken,fence:result.resource.fence});if(body.action==='release')resourceLeases.delete(body.requestId);if(current())await renderServerQueue();}catch(e){if(current()){content.querySelector('[data-resource-message]').textContent=e.message+' Сначала обновите очередь и проверьте результат; неизвестное действие не повторяйте.';}}};
      content.querySelector('[data-resource-back]').onclick=()=>renderCoordination(true);
      content.querySelector('[data-resource-refresh]').onclick=renderServerQueue;
      content.querySelectorAll('[data-resource-claim]').forEach(b=>b.onclick=()=>send({action:'claim',requestId:Number(b.dataset.resourceClaim)},b));
      content.querySelectorAll('[data-resource-cancel]').forEach(b=>b.onclick=()=>send({action:'cancel',requestId:Number(b.dataset.resourceCancel),evidence:'Владелец отменил ожидающую работу'},b));
      content.querySelector('[data-resource-renew]')?.addEventListener('click',event=>send({action:'renew',requestId:holder.id,...lease},event.target));
      content.querySelector('[data-resource-release]')?.addEventListener('click',event=>{const evidence=content.querySelector('[data-resource-release-note]').value.trim();if(!evidence){content.querySelector('[data-resource-message]').textContent='Укажите проверенный результат перед освобождением';return;}void send({action:'release',requestId:holder.id,...lease,evidence},event.target);});
      const idleForm=content.querySelector('[data-resource-idle]');
      if(idleForm)idleForm.onsubmit=event=>{event.preventDefault();void send({action:'confirm_idle',evidence:idleForm.elements.evidence.value,...(holder?{requestId:holder.id,outcome:idleForm.elements.outcome.value}:{})},idleForm.querySelector('button'));};
      const addForm=content.querySelector('[data-resource-add]'),requestKey=window.crypto.randomUUID();
      addForm.onsubmit=async event=>{event.preventDefault();const button=addForm.querySelector('button');button.disabled=true;try{const body=Object.fromEntries(['taskRef','threadId','executor','scope'].map(k=>[k,addForm.elements[k].value]));body.requestKey=requestKey;body.notBefore=new Date(addForm.elements.notBefore.value).toISOString();body.durationMinutes=Number(addForm.elements.durationMinutes.value);await crmQuery('/coordination/server-resource/requests',{},csrfOptions('POST',body));if(current())await renderServerQueue();}catch(e){if(current())content.querySelector('[data-resource-message]').textContent=e.message+' Проверьте очередь перед повтором.';}};
    }catch(e){if(version===renderVersion&&ctx.currentView==='tasks')content.textContent=e.message;}
  };
  const milestones = {code:'Код готов',connected:'Подключено',verified:'Проверено',accepted:'Принято'};
  const milestoneStates = {pending:'Не подтверждено',confirmed:'Подтверждено',not_required:'Не требуется'};
  const coordinationFields = {module:'Модуль',ownerThreadId:'Идентификатор ответственного чата',ownerThreadName:'Название чата',
    executorId:'Идентификатор исполнителя',executorName:'Исполнитель',verifiedModel:'Проверенная модель',
    modelCheckedAt:'Дата проверки модели',scope:'Область работы',acceptance:'Критерий готовности',
    result:'Подтверждённый результат',blocker:'Что мешает',nextAction:'Следующий шаг'};
  const localDateInput = value => {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0,23);
  };
  const displayDate = value => value ? new Date(value).toLocaleString('ru-RU') : '';
  const isoDateInput = value => value ? new Date(value).toISOString() : '';
  const dispatchStates={manual:'Вручную',queued:'В очереди',running:'Идёт разбор',needs_input:'Нужен ваш ответ',awaiting_executor:'Нужен исполнитель',blocked:'Нужна помощь',review:'Результат на проверке',done:'Принято',cancelled:'Остановлено'};
  const departments={coordination:'Координация',engineering:'Разработка',design:'Дизайн',marketing:'Маркетинг',analytics:'Аналитика',support:'Поддержка'};
  let boardTimer;
  const reviewMarkup=r=>r?`<p><strong>Вторая проверка: ${escapeHTML({passed:'существенных замечаний нет',changes:'есть замечания',unavailable:'не выполнена'}[r.verdict]||'неизвестно')}</strong>${r.model?' · '+escapeHTML(r.provider)+' / '+escapeHTML(r.model):''}</p><p>${escapeHTML(r.note)}${r.usage?.promptTokens!=null?' · Вход: '+r.usage.promptTokens+' токенов':''}${r.usage?.completionTokens!=null?' · Ответ: '+r.usage.completionTokens+' токенов':''}</p>`:'';
  const dispatchSummary = d => `<p><strong>${dispatchStates[d?.state]||'Вручную'}</strong>${d?.department?' · '+escapeHTML(departments[d.department]||d.department):''}</p>
    ${d?.question?`<p><strong>Вопрос:</strong> ${escapeHTML(d.question)}</p>`:''}
    ${d?.result?`<p style="white-space:pre-wrap">${escapeHTML(d.result)}</p>`:''}
    ${d?.model?`<p class="crm-muted">${escapeHTML(d.provider)} · ${escapeHTML(d.model)}${d.usage?.promptTokens!=null?' · Вход: '+d.usage.promptTokens+' токенов':''}${d.usage?.completionTokens!=null?' · Ответ: '+d.usage.completionTokens+' токенов':''}</p>`:''}`;
  const renderDispatchControls = (container, task, data, version) => {
    container.innerHTML=`<h3>Работа помощников</h3>${dispatchSummary(data)}${reviewMarkup(data.review)}<p class="crm-muted">Простой текст готовит недорогой API. Код, файлы и публикации ожидают подключённого исполнителя. Результат принимает владелец.</p>
      ${['manual','done','cancelled'].includes(data.state)?'':`<p>Исполнитель: ${escapeHTML(data.executor||'Не назначен')}. Попытки: ${data.attempts||0} из 2.</p>`}
      ${['needs_input','review','blocked','awaiting_executor'].includes(data.state)?'<label>Ответ или замечание<textarea data-dispatch-answer maxlength="2000" rows="3"></textarea></label>':''}
      <div class="crm-actions">${data.state==='manual'&&!['done','cancelled'].includes(task.status)?'<button type="button" data-dispatch-action="enqueue">Передать помощнику</button>':''}
      ${data.state==='needs_input'?'<button type="button" data-dispatch-action="answer">Ответить и продолжить</button>':''}
      ${data.state==='review'?'<button type="button" data-dispatch-action="accept">Принять результат</button><button type="button" data-dispatch-action="revise">Вернуть на исправление</button>':''}
      ${['blocked','awaiting_executor'].includes(data.state)?'<button type="button" data-dispatch-action="retry">Передать уточнение</button>':''}
      ${!['manual','done','cancelled'].includes(data.state)?'<button type="button" data-dispatch-action="cancel">Остановить обработку</button>':''}
      <button type="button" data-dispatch-refresh>Обновить состояние</button></div><p role="status" data-dispatch-status></p>
      <details><summary>История работы</summary>${(data.history||[]).map(h=>`<details><summary>${escapeHTML(displayDate(h.createdAt))} · ${escapeHTML(h.note)}</summary>${h.question?`<p>${escapeHTML(h.question)}</p>`:""}${h.result?`<pre style="white-space:pre-wrap">${escapeHTML(h.result)}</pre>`:""}${reviewMarkup(h.review)}${h.model?`<p>Модель: ${escapeHTML(h.model)}</p>`:""}</details>`).join('')||'<p>Работа ещё не запускалась.</p>'}</details>`;
    container.querySelector('[data-dispatch-refresh]').onclick=()=>renderTaskCard(task.id);
    container.querySelectorAll('[data-dispatch-action]').forEach(button=>button.onclick=async()=>{
      button.disabled=true;const action=button.dataset.dispatchAction;
      try{const next=await crmQuery(`/coordination/dispatch/${task.id}/${action==='enqueue'?'enqueue':'action'}`,{companyCode:task.companyCode},csrfOptions('POST',{revision:data.revision,action,text:container.querySelector('[data-dispatch-answer]')?.value||''}));
        if(version===renderVersion&&ctx.currentView==='tasks'){if(next.state==='done'){task.status='done';const select=container.parentElement.querySelector('[name=status]');if(select)select.value='done';}renderDispatchControls(container,task,next,version);}
      }catch(error){container.querySelector('[data-dispatch-status]').textContent=error.message;}finally{button.disabled=false;}
    });
  };
  const renderCoordination = async (allCompanies = false) => {
    if(ctx.identity?.role !== 'owner') return;
    clearTimeout(boardTimer);
    const version = ++renderVersion, content = byId('tasks-content');
    content.textContent = 'Загрузка доски…';
    try {
      loadTaskCompanies();
      const scope = allCompanies ? {} : scopeParams(), records = [];
      let page;
      do {
        page = await crmQuery('/coordination/tasks',{...scope,limit:200,offset:records.length});
        if(version !== renderVersion || ctx.currentView !== 'tasks') return;
        records.push(...page.tasks);
      } while(page.tasks.length && records.length < page.pagination.total);
      content.innerHTML = `<h2>Доска проектов</h2><p><a href="#system-settings">Экономика ИИ: расходы, остатки и резерв моделей</a></p><p>Ответственный чат и исполнитель указываются отдельно. Отметки готовности подтверждаются основанием и датой.</p>
        <p class="crm-muted">Поручение помощнику обрабатывается на сервере. Здесь видны вопросы, результаты и задачи без исполнителя. Codex и Claude не запускаются без подключённого моста.</p>
        <div class="crm-actions"><button class="plain-button" type="button" data-coord-back>К списку задач</button>
        <button class="plain-button" type="button" data-coord-add>Добавить задачу</button><button class="plain-button" type="button" data-coord-refresh>Обновить</button><button class="plain-button" type="button" data-coord-server>Очередь сервера</button><label><input type="checkbox" data-coord-all ${allCompanies?'checked':''}>Все проекты</label></div>
        <div class="coordination-board">${records.map(item=>`<article class="crm-card" style="padding:16px;margin:16px 0;border:1px solid currentColor;border-radius:12px;overflow-wrap:anywhere">
        <h3>#${item.taskId} · ${escapeHTML(item.title)}</h3>${dispatchSummary(item.dispatch)}<button class="plain-button" type="button" data-dispatch-open="${item.taskId}">Открыть задачу</button><p>${escapeHTML(taskCompanyName(item.companyCode))} · ${escapeHTML(item.module || 'Модуль не указан')}</p>
        <p>Ответственный чат: ${escapeHTML(item.ownerThreadName || item.ownerThreadId || 'Не назначен')}<br>Исполнитель: ${escapeHTML(item.executorName || item.assigneeName || 'Не назначен')}</p>
        <dl>${Object.entries(milestones).map(([key,label])=>`<dt><strong>${label}: ${milestoneStates[item.milestones[key].state]}</strong></dt><dd>${escapeHTML(item.milestones[key].evidence || 'Нет подтверждения')}${item.milestones[key].checkedAt?' · '+escapeHTML(displayDate(item.milestones[key].checkedAt)):''}</dd>`).join('')}</dl>
        <p>Результат: ${escapeHTML(item.result || 'Не указан')}<br>Что мешает: ${escapeHTML(item.blocker || 'Не указано')}<br>Следующий шаг: ${escapeHTML(item.nextAction || 'Не указан')}</p>
        <p class="crm-muted">Обновлено: ${escapeHTML(displayDate(item.updatedAt) || 'Ещё не проверено')}</p>
        <button class="plain-button" type="button" data-coord-edit="${item.taskId}">Обновить карточку</button></article>`).join('') || '<p>Задач пока нет. Добавьте задачу в общем списке.</p>'}</div>`;
      content.querySelector('[data-coord-back]').onclick = renderTaskList;
      content.querySelector('[data-coord-add]').onclick=openTaskCreate;
      content.querySelector('[data-coord-refresh]').onclick=()=>renderCoordination(allCompanies);
      content.querySelector('[data-coord-server]').onclick=renderServerQueue;
      content.querySelectorAll('[data-dispatch-open]').forEach(button=>button.onclick=()=>{const item=records.find(x=>String(x.taskId)===button.dataset.dispatchOpen);if(item.companyCode!==ctx.selectedProjectId)chooseProject(item.companyCode);navigate(taskRoute(item.taskId));});
      boardTimer=setTimeout(()=>{if(version===renderVersion&&ctx.currentView==='tasks'&&!document.querySelector('dialog[open]'))void renderCoordination(allCompanies);},15000);
      content.querySelector('[data-coord-all]').onchange = event=>renderCoordination(event.target.checked);
      content.querySelectorAll('[data-coord-edit]').forEach(button=>button.onclick=()=>editCoordination(records.find(item=>String(item.taskId)===button.dataset.coordEdit),allCompanies));
    } catch(error) {
      if(version===renderVersion) content.innerHTML = `<p role="alert">${escapeHTML(error.message)}</p>`;
    }
  };
  const editCoordination = (item, allCompanies) => {
    const content=byId('tasks-content'), version=++renderVersion;
    content.innerHTML = `<h2>${escapeHTML(item.title)}</h2><p>Компания: ${escapeHTML(taskCompanyName(item.companyCode))}. Изменения относятся к этой задаче. Даты и время — в часовом поясе вашего устройства.</p>
      <form class="crm-form" data-coord-form>${Object.entries(coordinationFields).map(([key,label])=>`<label>${label}${key==='modelCheckedAt'?`<input type="datetime-local" step="0.001" name="${key}" value="${escapeHTML(localDateInput(item[key]))}">`:`<textarea name="${key}" maxlength="${['scope','acceptance','result','blocker','nextAction'].includes(key)?4000:200}">${escapeHTML(item[key] || '')}</textarea>`}</label>`).join('')}
      ${Object.entries(milestones).map(([key,label])=>`<fieldset class="wide"><legend>${label}</legend><label>Состояние<select name="${key}-state">${taskOptions(milestoneStates,item.milestones[key].state)}</select></label>
      <label>Основание: проверка, ссылка или версия результата<textarea name="${key}-evidence" maxlength="4000">${escapeHTML(item.milestones[key].evidence)}</textarea></label>
      <label>Дата и время проверки<input type="datetime-local" step="0.001" name="${key}-checkedAt" value="${escapeHTML(localDateInput(item.milestones[key].checkedAt))}"></label></fieldset>`).join('')}
      <div class="crm-actions wide"><button class="plain-button" type="submit">Сохранить</button><button class="plain-button" type="button" data-coord-cancel>К доске</button></div><p data-coord-result role="status"></p></form>`;
    const form=content.querySelector('[data-coord-form]');
    form.querySelector('[data-coord-cancel]').onclick=()=>renderCoordination(allCompanies);
    form.onsubmit=async event=>{
      event.preventDefault(); const button=form.querySelector('[type=submit]'); button.disabled=true;
      const data=Object.fromEntries(Object.keys(coordinationFields).map(key=>[key,form.elements.namedItem(key).value.trim()]));
      data.milestones=Object.fromEntries(Object.keys(milestones).map(key=>[key,Object.fromEntries(['state','evidence','checkedAt'].map(field=>[field,form.elements.namedItem(`${key}-${field}`).value.trim()]))]));
      try {
        data.modelCheckedAt=isoDateInput(data.modelCheckedAt);
        Object.values(data.milestones).forEach(stage=>{stage.checkedAt=isoDateInput(stage.checkedAt);});
        await crmQuery(`/coordination/tasks/${item.taskId}`,{},csrfOptions('PUT',{revision:item.revision,data}));
        if(version===renderVersion && ctx.currentView==='tasks') await renderCoordination(allCompanies);
      } catch(error) {if(version===renderVersion) form.querySelector('[data-coord-result]').textContent=error.message;}
      finally {button.disabled=false;}
    };
  };
  const taskRoute = (id = "") => {
    const params = new URLSearchParams();
    FILTER_KEYS.forEach((key) => {
      if (key === "companyCode") return;
      if (taskState[key]) params.set(key, taskState[key]);
    });
    const query = params.toString();
    return `tasks${id ? `/${encodeURIComponent(id)}` : ""}${query ? `?${query}` : ""}`;
  };
  const saveTaskFilters = () => {
    clearTimeout(searchTimer);
    const hash = `#${taskRoute()}`;
    if (location.hash === hash) renderTaskList();
    else location.hash = hash;
  };
  const readTaskFilters = (query) => {
    const params = new URLSearchParams(query);
    const allowed = { status: TASK_STATUSES, pipeline: TASK_PIPELINES, assigneeRole: TASK_ROLES, source: TASK_SOURCES };
    FILTER_KEYS.forEach((key) => {
      const value = (params.get(key) || "").trim();
      taskState[key] = allowed[key] && !Object.hasOwn(allowed[key], value) ? "" : value;
    });
    taskState.companyCode = taskState.companyCode.toLowerCase();
    taskState.companyCode = "";
  };
  const taskOptions = (values, selected = "") => Object.entries(values).map(([value, label]) => {
    return `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`;
  }).join("");
  const taskCompanyName = (code) => {
    if (!code) return "Synapse";
    return taskState.companies.find((company) => company.code === code)?.name || code;
  };
  const loadTaskCompanies = () => {
    const companies = Array.isArray(ctx.identity?.companies) ? ctx.identity.companies : [];
    taskState.companies = companies.map((company) => {
      const code = typeof company?.id === "string" ? company.id.trim() : "";
      return { code, name: company?.name || code };
    }).filter((company) => company.code);
  };
  const canTransferTask = () => {
    return ctx.identity?.role === "owner" && ctx.hasPermission("crm.edit");
  };
  const taskCreateScope = (companyCode) => {
    if (!companyCode) return scopeParams();
    if (!taskState.companies.some((company) => company.code === companyCode)) {
      throw new Error("Выбранный проект недоступен");
    }
    return { companyCode };
  };
  const taskUpdateScope = (companyCode) => {
    const scope = scopeParams();
    return canTransferTask() && companyCode !== scope.companyCode ? {} : scope;
  };
  const taskCompanyOptions = (selected = "", emptyLabel = "Выберите проект") => {
    const options = taskState.companies.map((company) => {
      const value = company.code || "";
      return `<option value="${escapeHTML(value)}"${value === selected ? " selected" : ""}>` +
        `${escapeHTML(company.name || value)}</option>`;
    }).join("");
    return `<option value=""${selected ? "" : " selected"}>${escapeHTML(emptyLabel)}</option>${options}`;
  };
  const loadTasksSummary = async () => {
    const scope = scopeParams();
    try {
      const summary = await crmQuery("/tasks/summary", scope);
      if ((scopeParams().companyCode || "") !== (scope.companyCode || "")) return null;
      const badge = byId("tasks-badge");
      badge.textContent = summary.inbox || "";
      badge.hidden = !summary.inbox;
      return summary;
    } catch (error) {
      if ((scopeParams().companyCode || "") !== (scope.companyCode || "")) return null;
      byId("tasks-badge").hidden = true;
      return null;
    }
  };
  const taskStatusTabs = (summary = {}) => {
    const tabs = [
      ["inbox", "Входящие", summary.inbox],
      ["planned", "Запланировано", summary.planned],
      ["in_progress", "В работе", summary.in_progress],
      ["done", "Сделано", summary.done],
      ["", "Все", summary.total]
    ];
    return tabs.map(([value, label, count]) => `<button type="button" data-task-status-tab="${value}"
      aria-pressed="${String(taskState.status === value)}">${label} · ${count || 0}</button>`).join("");
  };
  const taskDueMarkup = (task) => {
    if (!task.dueDate) return '<span class="crm-muted">—</span>';
    const overdue = !["done", "cancelled"].includes(task.status) &&
      task.dueDate < new Date().toISOString().slice(0, 10);
    return `<span class="${overdue ? "tasks-overdue" : ""}">${escapeHTML(task.dueDate)}</span>`;
  };
  const taskActionsMarkup = (task) => {
    if (task.status === "inbox") {
      return `<div class="tasks-actions"><button type="button" data-task-quick="planned"
        data-task-id="${escapeHTML(task.id)}">Запланировать</button><button class="danger" type="button"
        data-task-quick="cancelled" data-task-id="${escapeHTML(task.id)}">Отклонить</button></div>`;
    }
    return `<select data-task-quick data-task-id="${escapeHTML(task.id)}" aria-label="Изменить статус">
      ${taskOptions(TASK_STATUSES, task.status)}</select>`;
  };
  const renderTaskList = async () => {
    const version = ++renderVersion;
    const filters = { ...taskState };
    const scope = scopeParams();
    const content = byId("tasks-content");
    content.textContent = "Загрузка…";
    try {
      await Promise.all([loadTaskCompanies(), loadTasksSummary()]);
      if (version !== renderVersion) return;
      const params = {
        ...scope,
        assigneeRole: filters.assigneeRole,
        source: filters.source,
        q: filters.q,
        limit: 200
      };
      const records = [];
      let total;
      do {
        const data = await crmQuery("/tasks", { ...params, offset: records.length });
        if (version !== renderVersion) return;
        const page = data.tasks || [];
        records.push(...page);
        total = data.pagination?.total ?? records.length;
        if (!page.length) break;
      } while (records.length < total);
      const filtered = records.filter((task) => {
        const pipeline = task.source === "pipeline" && /^pipeline:(sale|service):/.exec(task.sourceRef || "")?.[1];
        return !filters.pipeline || pipeline === filters.pipeline;
      });
      const summary = { inbox: 0, planned: 0, in_progress: 0, done: 0, total: filtered.length };
      filtered.forEach((task) => {
        if (Object.hasOwn(TASK_STATUSES, task.status)) summary[task.status] = (summary[task.status] || 0) + 1;
      });
      const tasks = filtered.filter((task) => !filters.status || task.status === filters.status);
      const rows = tasks.map((task) => {
        const source = task.source !== "manual"
          ? `<small>${escapeHTML(task.sourceAuthor || "—")} · ${TASK_SOURCES[task.source] || task.source}</small>`
          : "";
        return `<tr class="crm-row" tabindex="0" data-task-row="${escapeHTML(task.id)}">
          <td class="crm-grow"><span class="tasks-title"><strong>${escapeHTML(task.title)}</strong>
          ${source}</span></td>
          <td class="crm-compact" data-label="Проект">${escapeHTML(taskCompanyName(task.companyCode))}</td>
          <td class="crm-compact" data-label="Исполнитель"><span class="tasks-assignee">${TASK_ROLES[task.assigneeRole] || task.assigneeRole}
          ${task.assigneeName ? `<small>${escapeHTML(task.assigneeName)}</small>` : ""}</span></td>
          <td class="crm-compact" data-label="Приоритет"><span class="tasks-priority" data-priority="${escapeHTML(task.priority)}">
          ${TASK_PRIORITIES[task.priority] || task.priority}</span></td>
          <td class="crm-compact" data-label="Срок">${taskDueMarkup(task)}</td>
          <td class="crm-compact" data-label="Статус">${TASK_STATUSES[task.status] || task.status}</td>
          <td class="crm-compact" data-label="Действия">${taskActionsMarkup(task)}</td></tr>`;
      }).join("");
      content.innerHTML = `<div class="tasks-status-tabs" aria-label="Статус задачи">
        ${taskStatusTabs(summary)}</div><div class="crm-entity-toolbar" style="flex-wrap: wrap">
        <select data-task-pipeline-filter aria-label="Воронка"><option value="">Все воронки</option>
        ${taskOptions(TASK_PIPELINES, filters.pipeline)}</select>
        <select data-task-role-filter aria-label="Роль исполнителя"><option value="">Все исполнители</option>
        ${taskOptions(TASK_ROLES, taskState.assigneeRole)}</select>
        <select data-task-source-filter aria-label="Источник"><option value="">Все источники</option>
        ${taskOptions(TASK_SOURCES, taskState.source)}</select>
        <input type="search" data-task-search value="${escapeHTML(taskState.q)}" placeholder="Поиск"
          aria-label="Поиск задач"><button class="plain-button" type="button" data-task-add>Добавить</button>
        ${ctx.identity?.role === 'owner' ? '<button class="plain-button" type="button" data-task-coordination>Координация проектов</button>' : ''}
        </div><p class="crm-list-count">Показано ${tasks.length} из ${tasks.length}</p>
        <div class="crm-table-wrap"><table class="crm-table crm-entity-table"><thead><tr>
        <th class="crm-grow">Задача</th><th>Проект</th><th>Исполнитель</th><th>Приоритет</th><th>Срок</th>
        <th>Статус</th><th>Действия</th></tr></thead><tbody>${rows}</tbody></table></div>
        ${tasks.length ? "" : '<p class="crm-empty">Задач по этим фильтрам нет</p>'}`;
      bindTaskList();
    } catch (error) {
      if (version !== renderVersion) return;
      content.innerHTML = `<p class="crm-error" role="alert">Не удалось загрузить: ${escapeHTML(error.message)}</p>`;
    }
  };
  const updateTaskStatus = async (id, status) => {
    await crmQuery(`/tasks/${encodeURIComponent(id)}`, scopeParams(), csrfOptions("PATCH", { status }));
    await renderTaskList();
  };
  const bindTaskList = () => {
    const content = byId("tasks-content");
    content.querySelector('[data-task-coordination]')?.addEventListener('click',()=>renderCoordination());
    content.querySelectorAll("[data-task-status-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        taskState.status = button.dataset.taskStatusTab;
        saveTaskFilters();
      });
    });
    const selectors = {
      companyCode: "company", pipeline: "pipeline", assigneeRole: "role", source: "source"
    };
    Object.entries(selectors).forEach(([key, selector]) => {
      content.querySelector(`[data-task-${selector}-filter]`)?.addEventListener("change", (event) => {
        taskState[key] = event.target.value;
        saveTaskFilters();
      });
    });
    content.querySelector("[data-task-search]").addEventListener("input", (event) => {
      clearTimeout(searchTimer);
      taskState.q = event.target.value.trim();
      const hash = location.hash;
      searchTimer = setTimeout(() => {
        if (ctx.currentView === "tasks" && location.hash === hash) saveTaskFilters();
      }, 300);
    });
    content.querySelector("[data-task-add]").addEventListener("click", openTaskCreate);
    content.querySelectorAll("[data-task-row]").forEach((row) => {
      row.addEventListener("click", (event) => {
        if (!event.target.closest("button, select")) navigate(taskRoute(row.dataset.taskRow));
      });
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.target.closest("button, select")) {
          navigate(taskRoute(row.dataset.taskRow));
        }
      });
    });
    content.querySelectorAll("button[data-task-quick]").forEach((button) => {
      button.addEventListener("click", () => updateTaskStatus(button.dataset.taskId, button.dataset.taskQuick));
    });
    content.querySelectorAll("select[data-task-quick]").forEach((select) => {
      select.addEventListener("change", () => updateTaskStatus(select.dataset.taskId, select.value));
    });
  };
  const taskFormMarkup = (task) => `<form class="crm-form" data-task-form>
    <label class="wide">Название *<input name="title" required maxlength="300"
      value="${escapeHTML(task.title || "")}"></label>
    <label class="wide">Описание<textarea name="description">${escapeHTML(task.description || "")}</textarea></label>
    <label>Проект<select name="companyCode"${canTransferTask() ? "" : " disabled"}>
      ${taskCompanyOptions(task.companyCode || "")}</select></label>
    <label>Исполнитель<select name="assigneeRole">${taskOptions(TASK_ROLES, task.assigneeRole)}</select></label>
    <label>Имя исполнителя<input name="assigneeName" maxlength="200"
      value="${escapeHTML(task.assigneeName || "")}"></label>
    <label>Приоритет<select name="priority">${taskOptions(TASK_PRIORITIES, task.priority)}</select></label>
    <label>Срок<input name="dueDate" type="date" value="${escapeHTML(task.dueDate || "")}"></label>
    <label>Статус<select name="status">${taskOptions(TASK_STATUSES, task.status)}</select></label>
    <div class="crm-actions wide"><button class="plain-button" type="submit">Сохранить</button>
      <button class="danger" type="button" data-task-delete>Удалить</button></div>
    <p class="crm-card-status wide" data-task-result role="status"></p></form>`;
  const taskPayload = (form) => ({
    title: form.elements.title.value.trim(),
    description: form.elements.description.value.trim(),
    companyCode: form.elements.companyCode.value,
    assigneeRole: form.elements.assigneeRole.value,
    assigneeName: form.elements.assigneeName.value.trim(),
    priority: form.elements.priority.value,
    dueDate: form.elements.dueDate.value,
    status: form.elements.status.value
  });
  const renderTaskCard = async (id) => {
    clearTimeout(boardTimer);
    const version = ++renderVersion;
    const scope = scopeParams();
    const content = byId("tasks-content");
    content.textContent = "Загрузка…";
    try {
      await loadTaskCompanies();
      if (version !== renderVersion) return;
      const task = await crmQuery(`/tasks/${encodeURIComponent(id)}`, scope);
      if (version !== renderVersion) return;
      const source = task.source !== "manual" ? `<section class="tasks-source"><h3>Откуда</h3>
        <p>${escapeHTML(TASK_SOURCES[task.source] || task.source)} · ${escapeHTML(task.sourceAuthor || "—")}</p>
        <p>${escapeHTML(task.sourceRef || "—")}</p><p>${escapeHTML(task.createdAt || "—")}</p></section>` : "";
      content.innerHTML = `<a class="crm-card-back" href="#${escapeHTML(taskRoute())}" data-task-back>← К списку</a>
        <header class="crm-card-header"><h2>${escapeHTML(task.title)}</h2></header>${source}${taskFormMarkup(task)}${ctx.identity?.role==='owner'?'<section data-task-dispatch></section>':''}`;
      content.querySelector("[data-task-back]").addEventListener("click", (event) => {
        event.preventDefault();
        navigate(taskRoute());
      });
      if(ctx.identity?.role==='owner'){
        const dispatch=await crmQuery(`/coordination/dispatch/${task.id}`,{companyCode:task.companyCode});
        if(version!==renderVersion||ctx.currentView!=='tasks')return;
        renderDispatchControls(content.querySelector('[data-task-dispatch]'),task,dispatch,version);
      }
      const form = content.querySelector("[data-task-form]");
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const result = form.querySelector("[data-task-result]");
        try {
          const payload = taskPayload(form);
          await crmQuery(`/tasks/${encodeURIComponent(task.id)}`, taskUpdateScope(payload.companyCode),
            csrfOptions("PATCH", payload));
          if (version !== renderVersion || ctx.currentView !== "tasks") return;
          result.textContent = "Сохранено";
          if (payload.companyCode !== task.companyCode) {
            if (payload.companyCode) chooseProject(payload.companyCode);
            else navigate(taskRoute());
            return;
          }
          await loadTasksSummary();
        } catch (error) {
          result.textContent = error.message;
        }
      });
      form.querySelector("[data-task-delete]").addEventListener("click", async () => {
        if (prompt(`Введите название «${task.title}» для удаления`) !== task.title) return;
        try {
          await crmQuery(`/tasks/${encodeURIComponent(task.id)}`, scopeParams(), csrfOptions("DELETE"));
          await loadTasksSummary();
          navigate(taskRoute());
        } catch (error) {
          form.querySelector("[data-task-result]").textContent = error.message;
        }
      });
    } catch (error) {
      if (version !== renderVersion) return;
      content.innerHTML = `<p class="crm-error" role="alert">Не удалось загрузить: ${escapeHTML(error.message)}</p>`;
    }
  };
  const renderTasksRoute = () => {
    clearTimeout(searchTimer);
    const hash = location.hash.slice(1);
    const queryIndex = hash.indexOf("?");
    const route = queryIndex < 0 ? hash : hash.slice(0, queryIndex);
    readTaskFilters(queryIndex < 0 ? "" : hash.slice(queryIndex + 1));
    const id = decodeURIComponent(route.split("/")[1] || "");
    const canonical = `#${taskRoute(id)}`;
    if (location.hash !== canonical) history.replaceState(null, "", canonical);
    if(id==='board')renderCoordination(true);
    else if (id) renderTaskCard(id);
    else if(ctx.identity?.role==='owner')renderCoordination(true);
    else renderTaskList();
  };
  const openTaskCreate = async () => {
    const dialog = byId("task-create-dialog");
    const form = byId("task-create-form");
    await loadTaskCompanies();
    form.querySelector("[data-task-company]").innerHTML = taskCompanyOptions(
      ctx.selectedProjectId
    );
    form.querySelector("[data-task-role]").innerHTML = taskOptions(TASK_ROLES, "synapse");
    form.querySelector("[data-task-priority]").innerHTML = taskOptions(TASK_PRIORITIES, "normal");
    form.querySelector("[data-task-status]").innerHTML = taskOptions(TASK_STATUSES, "planned");
    form.dataset.sourceRef = `owner-board:${crypto.randomUUID()}`;
    form.elements.title.value = "";
    form.elements.description.value = "";
    form.elements.assigneeName.value = "";
    form.elements.dueDate.value = "";
    form.querySelector("[role=alert]").hidden = true;
    form.querySelector('[data-task-auto-label]')?.remove();
    if(ctx.identity?.role==='owner')form.insertAdjacentHTML('beforeend','<label data-task-auto-label><input type="checkbox" name="dispatchToAssistant" checked>Передать помощнику: разобрать, задать вопросы и подготовить результат</label>');
    dialog.showModal();
  };
  byId("task-create-dialog").querySelector("[data-task-create-close]").addEventListener("click", () => {
    byId("task-create-dialog").close();
  });
  byId("task-create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = form.querySelector("[role=alert]");
    if(form.dataset.saving)return;form.dataset.saving="1";
    const submit=form.querySelector("[type=submit]");if(submit)submit.disabled=true;
    try {
      const payload = taskPayload(form);
      const created = await crmQuery("/tasks", taskCreateScope(payload.companyCode), csrfOptions("POST", {
        ...payload,
        source: "manual",
        sourceRef: form.dataset.sourceRef || "",
        sourceAuthor: ""
      }));
      if(created?.id&&form.elements.dispatchToAssistant?.checked){
        try{await crmQuery(`/coordination/dispatch/${created.id}/enqueue`,{companyCode:payload.companyCode},csrfOptions('POST',{revision:0}));}
        catch{ /* Задача сохранена. Карточка покажет ручной режим и позволит передать без дубля. */ }
      }
      byId("task-create-dialog").close();
      const projectChanged = payload.companyCode && payload.companyCode !== ctx.selectedProjectId;
      if (projectChanged) chooseProject(payload.companyCode);
      else await loadTasksSummary();
      if (created?.id) navigate(taskRoute(created.id));
      else if (!projectChanged) renderTaskList();
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    } finally {delete form.dataset.saving;if(submit)submit.disabled=false;}
  });
  Object.assign(api, { renderTasksRoute, loadTasksSummary });
};

SbCabinet.registerView("tasks", {
  title: "Задачи",
  updateSummary(context) {
    init(context);
    api.loadTasksSummary();
  },
  render(container, context) {
    init(context);
    api.renderTasksRoute();
  },
  onProjectChange(context) {
    init(context);
    api.renderTasksRoute();
  },
});
})();
