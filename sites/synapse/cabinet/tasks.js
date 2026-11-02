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
  const TASK_SOURCES = Object.freeze({ manual: "Вручную", claude: "Claude", gpt: "GPT", chat: "Чат", telegram: "Telegram", pipeline: "Воронка" });
  const TASK_PIPELINES = Object.freeze({ sale: "Продажа", service: "Сервис" });
  const FILTER_KEYS = ["status", "companyCode", "pipeline", "assigneeRole", "source", "q"];
  const taskState = {
    status: "", companyCode: "", pipeline: "", assigneeRole: "", source: "", q: "",
    companies: []
  };
  let renderVersion = 0;
  let searchTimer;
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
  let boardView = 'board';
  let createParentId = null;
  const ownerTool = (name, args = {}) => crmQuery(`/coordination/mcp/${name}`, {}, csrfOptions('POST', args));
  const bangkokDay = (value = new Date()) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(value);
  const taskDraftKey = key => `sb-task:${ctx.identity?.userId || ctx.identity?.id || ctx.identity?.login || 'owner'}:${key}`;
  const readDraft = key => {
    try { return JSON.parse(sessionStorage.getItem(taskDraftKey(key)) || 'null'); } catch { return null; }
  };
  const writeDraft = (key, value) => {
    try {
      if (value === null) sessionStorage.removeItem(taskDraftKey(key));
      else sessionStorage.setItem(taskDraftKey(key), JSON.stringify(value));
    } catch { /* Недоступное хранилище не мешает работе текущей формы. */ }
  };
  const safeTaskUrl = value => {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  };
  const linksMarkup = links => `<div class="tasks-mcp-links">${(Array.isArray(links) ? links : []).map(link => {
    const url = safeTaskUrl(link?.url);
    if (!url) return '';
    const label = escapeHTML(link.label || url), href = escapeHTML(url);
    const preview = link.kind === 'image'
      ? `<img src="${href}" alt="${label}" loading="lazy" referrerpolicy="no-referrer">`
      : link.kind === 'video'
        ? `<video src="${href}" controls preload="none" referrerpolicy="no-referrer"></video>` : '';
    return `<figure>${preview}<figcaption><a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a></figcaption></figure>`;
  }).join('')}</div>`;
  const progressMarkup = task => Number(task.subtask_count) > 0
    ? `<p>Подзадачи: <strong>${Number(task.subtask_done) || 0}/${Number(task.subtask_count)}</strong> <progress max="${Number(task.subtask_count)}" value="${Number(task.subtask_done) || 0}" aria-label="Готовность подзадач"></progress></p>` : '';
  const boardTabs = () => `<div class="tasks-status-tabs" aria-label="Раздел задач">${[
    ['board', 'Доска'], ['today', 'План дня'], ['agents', 'Агенты']
  ].map(([value, label]) => `<button type="button" data-owner-task-tab="${value}" aria-pressed="${boardView === value}">${label}</button>`).join('')}</div>`;
  const bindBoardTabs = allCompanies => {
    byId('tasks-content').querySelectorAll('[data-owner-task-tab]').forEach(button => {
      button.onclick = () => {
        boardView = button.dataset.ownerTaskTab;
        history.replaceState(null, '', `#${taskRoute(boardView)}`);
        void renderCoordination(allCompanies);
      };
    });
  };
  const projectTaskLink = (id, companyCode, label) => `<a href="#${escapeHTML(taskRoute(id))}" data-owner-task-open="${Number(id)}" data-task-project="${escapeHTML(companyCode || '')}">${label}</a>`;
  const bindProjectTaskLinks = container => {
    container.querySelectorAll('[data-owner-task-open]').forEach(link => {
      link.onclick = event => {
        event.preventDefault();
        const companyCode = link.dataset.taskProject;
        if (companyCode && companyCode !== ctx.selectedProjectId) chooseProject(companyCode);
        navigate(taskRoute(link.dataset.ownerTaskOpen));
      };
    });
  };
  if (!document.getElementById('tasks-mcp-styles')) {
    const style = document.createElement('style');
    style.id = 'tasks-mcp-styles';
    style.textContent = `
      #tasks-content .tasks-mcp-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr));
        gap: 16px;
      }
      #tasks-content .tasks-mcp-grid > .crm-card {
        margin: 0 !important;
        min-width: 0;
      }
      #tasks-content .tasks-mcp-detail {
        border-top: 1px solid #d8dde5;
        margin-top: 24px;
        padding-top: 16px;
        overflow-wrap: anywhere;
      }
      #tasks-content .tasks-mcp-links {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }
      #tasks-content .tasks-mcp-links figure {
        margin: 0;
        max-width: 100%;
        width: 220px;
      }
      #tasks-content .tasks-mcp-links img,
      #tasks-content .tasks-mcp-links video {
        display: block;
        max-width: 100%;
        max-height: 220px;
        border-radius: 8px;
      }
      #tasks-content .tasks-mcp-links figcaption,
      #tasks-content .tasks-mcp-meta span {
        overflow-wrap: anywhere;
      }
      #tasks-content .tasks-mcp-alert {
        color: var(--red, #ff9c9c);
        font-weight: 600;
      }
      #tasks-content progress {
        max-width: 100%;
        vertical-align: middle;
      }
      #tasks-content .tasks-mcp-comments {
        padding: 0;
        list-style: none;
      }
      #tasks-content .tasks-mcp-comments li {
        padding: 12px 0;
        border-bottom: 1px solid #d8dde5;
      }
      #tasks-content .tasks-mcp-comments p {
        white-space: pre-wrap;
      }
      #tasks-content .tasks-mcp-detail textarea {
        min-height: 72px;
      }
      #tasks-content .tasks-mcp-detail fieldset {
        min-width: 0;
      }
      #tasks-content .tasks-mcp-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 20px;
      }
      @media (max-width: 600px) {
        #tasks-content .tasks-mcp-detail .crm-form {
          display: grid;
          grid-template-columns: minmax(0, 1fr);
        }
        #tasks-content .tasks-mcp-detail .crm-form > * {
          max-width: 100%;
          min-width: 0;
        }
        #tasks-content .tasks-status-tabs {
          display: flex;
          flex-wrap: wrap;
        }
        #tasks-content .tasks-mcp-grid {
          grid-template-columns: minmax(0, 1fr);
        }
      }
    `;
    document.head.append(style);
  }
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
      if (boardView === 'agents') {
        const data = await ownerTool('agents_list');
        if (version !== renderVersion || ctx.currentView !== 'tasks') return;
        content.innerHTML = `${boardTabs()}<h2>Агенты</h2><p class="crm-muted">Состояние сообщают сами агенты. Запись в каталоге не подтверждает запуск.</p>
          <button class="plain-button" type="button" data-agents-refresh>Обновить</button><div class="tasks-mcp-grid">${(data.agents || []).map(agent => `<article class="crm-card" style="padding:16px;border:1px solid #d8dde5;border-radius:12px;overflow-wrap:anywhere">
          <h3>${escapeHTML(agent.name)}</h3><p>${escapeHTML(agent.kind)} · ${escapeHTML({work:'Работает',wait:'Ожидает',idle:'Свободен',unknown:'Неизвестно',error:'Ошибка'}[agent.state] || agent.state)}</p>
          <p>${escapeHTML(agent.function || '')}${agent.chat ? '<br>' + escapeHTML(agent.chat) : ''}</p><p>Режим: ${escapeHTML({permanent:'Постоянный',periodic:'Периодический',event:'По событию',once:'Разовый'}[agent.mode] || agent.mode)}</p>
          <p>Последнее событие: ${escapeHTML(agent.last_event || 'Нет отчёта')}<br>${escapeHTML(displayDate(agent.last_event_at))}</p>
          ${agent.no_report ? '<p class="tasks-mcp-alert">Нет отчёта больше 60 минут</p>' : ''}<h4>Активные задачи</h4><ul>${(agent.active_tasks || []).map(task => `<li>${projectTaskLink(task.id,task.company_code,`#${Number(task.id)} · ${escapeHTML(task.title)}`)} · ${escapeHTML(TASK_STATUSES[task.status] || task.status)}</li>`).join('') || '<li>Нет активных задач</li>'}</ul></article>`).join('') || '<p>Агенты пока не зарегистрированы.</p>'}</div>`;
        bindBoardTabs(allCompanies);
        bindProjectTaskLinks(content);
        content.querySelector('[data-agents-refresh]').onclick = () => renderCoordination(allCompanies);
        boardTimer = setTimeout(() => {
          if (version === renderVersion && ctx.currentView === 'tasks') void renderCoordination(allCompanies);
        }, 30000);
        return;
      }
      const scope = allCompanies ? {} : scopeParams(), records = [];
      let page;
      do {
        page = await crmQuery('/coordination/tasks',{...scope,limit:200,offset:records.length});
        if(version !== renderVersion || ctx.currentView !== 'tasks') return;
        records.push(...page.tasks);
      } while(page.tasks.length && records.length < page.pagination.total);
      const shown = boardView === 'today' ? records.filter(item => item.due_date && item.due_date <= bangkokDay() && !['done','cancelled'].includes(item.taskStatus)) : records;
      content.innerHTML = `${boardTabs()}<h2>${boardView === 'today' ? 'План дня' : 'Доска проектов'}</h2>${boardView === 'today' ? `<p>Срок до ${escapeHTML(bangkokDay())} включительно · Asia/Bangkok</p>` : ''}<p><a href="#system-settings">Экономика ИИ: расходы, остатки и резерв моделей</a></p><p>Ответственный чат и исполнитель указываются отдельно. Отметки готовности подтверждаются основанием и датой.</p>
        <p class="crm-muted">Поручение помощнику обрабатывается на сервере. Здесь видны вопросы, результаты и задачи без исполнителя. Codex и Claude не запускаются без подключённого моста.</p>
        <div class="crm-actions"><button class="plain-button" type="button" data-coord-back>К списку задач</button>
        <button class="plain-button" type="button" data-coord-add>Добавить задачу</button><button class="plain-button" type="button" data-coord-refresh>Обновить</button><label><input type="checkbox" data-coord-all ${allCompanies?'checked':''}>Все проекты</label></div>
        <div class="coordination-board tasks-mcp-grid">${shown.map(item=>`<article class="crm-card" style="padding:16px;margin:16px 0;border:1px solid currentColor;border-radius:12px;overflow-wrap:anywhere">
        <h3>#${item.taskId} · ${escapeHTML(item.title)}</h3>${dispatchSummary(item.dispatch)}<button class="plain-button" type="button" data-dispatch-open="${item.taskId}">Открыть задачу</button><p>${escapeHTML(taskCompanyName(item.companyCode))} · ${escapeHTML(item.module || 'Модуль не указан')}</p>
        <p>Ответственный чат: ${escapeHTML(item.ownerThreadName || item.ownerThreadId || 'Не назначен')}<br>Исполнитель: ${escapeHTML(item.executorName || item.assigneeName || 'Не назначен')}<br>Проверяющий: ${escapeHTML(item.reviewer_name || 'Не назначен')}</p>
        <p>${escapeHTML(TASK_STATUSES[item.taskStatus] || item.taskStatus)} · ${escapeHTML(TASK_SOURCES[item.source] || item.source || 'Вручную')}${item.due_date ? ' · Срок: ' + escapeHTML(item.due_date) : ''}</p>
        ${item.parent_task_id ? `<p>Подзадача ${projectTaskLink(item.parent_task_id,item.companyCode,`#${Number(item.parent_task_id)}`)}</p>` : ''}${progressMarkup(item)}${item.no_report ? '<p class="tasks-mcp-alert">Нет отчёта больше 60 минут</p>' : ''}
        <dl>${Object.entries(milestones).map(([key,label])=>`<dt><strong>${label}: ${milestoneStates[item.milestones[key].state]}</strong></dt><dd>${escapeHTML(item.milestones[key].evidence || 'Нет подтверждения')}${item.milestones[key].checkedAt?' · '+escapeHTML(displayDate(item.milestones[key].checkedAt)):''}</dd>`).join('')}</dl>
        <p>Результат: ${escapeHTML(item.result || 'Не указан')}<br>Что мешает: ${escapeHTML(item.blocker || 'Не указано')}<br>Следующий шаг: ${escapeHTML(item.nextAction || 'Не указан')}</p>
        ${linksMarkup(item.links)}
        <p class="crm-muted">Обновлено: ${escapeHTML(displayDate(item.updatedAt) || 'Ещё не проверено')}</p>
        <button class="plain-button" type="button" data-coord-edit="${item.taskId}">Обновить карточку</button></article>`).join('') || '<p>Задач пока нет. Добавьте задачу в общем списке.</p>'}</div>`;
      content.querySelector('[data-coord-back]').onclick = renderTaskList;
      content.querySelector('[data-coord-add]').onclick=()=>openTaskCreate();
      bindBoardTabs(allCompanies);
      bindProjectTaskLinks(content);
      content.querySelector('[data-coord-refresh]').onclick=()=>renderCoordination(allCompanies);
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
      if (Array.isArray(item.links)) data.links = item.links;
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
      task.dueDate < bangkokDay();
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
    content.querySelector("[data-task-add]").addEventListener("click", () => openTaskCreate());
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
  const linkEditorMarkup = (link = {}) => `<fieldset data-task-link-row><legend>Ссылка</legend>
    <label>Адрес<input type="url" data-task-link-url value="${escapeHTML(link.url || '')}" maxlength="2000" placeholder="https://"></label>
    <label>Подпись<input data-task-link-label value="${escapeHTML(link.label || '')}" maxlength="200"></label>
    <label>Тип<select data-task-link-kind>${taskOptions({link:'Ссылка',image:'Фото',video:'Видео'}, link.kind || 'link')}</select></label>
    <button type="button" data-task-link-remove>Убрать ссылку</button></fieldset>`;
  const commentMarkup = comment => `<li data-task-comment-id="${Number(comment.id) || ''}"><strong>${escapeHTML(comment.author)}</strong> · ${escapeHTML(displayDate(comment.created_at))}<p>${escapeHTML(comment.text)}</p></li>`;
  const subtaskMarkup = (child, companyCode) => `<li data-task-subtask-id="${Number(child.id)}">${projectTaskLink(child.id,child.company_code || companyCode,`#${Number(child.id)} · ${escapeHTML(child.title)}`)} · ${escapeHTML(TASK_STATUSES[child.status] || child.status)}</li>`;
  const renderOwnerTaskPanel = async (container, id, version) => {
    if (!container || ctx.identity?.role !== 'owner') return;
    try {
      // Открытые сеансы со старой CRM сохраняют прежнюю карточку до обновления сервиса.
      const current = await crmQuery(`/coordination/tasks/${encodeURIComponent(id)}`, {});
      if (version !== renderVersion || ctx.currentView !== 'tasks') return;
      if (!Object.hasOwn(current, 'reviewer_name')) {
        container.innerHTML = '<p class="crm-muted">Расширенная координация появится после обновления сервиса задач.</p>';
        return;
      }
      const data = await ownerTool('task_get', {task_id: Number(id),comments_limit:20,subtasks_limit:20});
      if (version !== renderVersion || ctx.currentView !== 'tasks') return;
      const task = data.task || data, coordination = task.coordination || {};
      let commentsPage = task.comments_pagination || {total:task.comments?.length || 0,limit:20,offset:0};
      let subtasksPage = task.subtasks_pagination || {total:task.subtasks?.length || 0,limit:20,offset:0};
      let commentsOffset = commentsPage.offset + (task.comments?.length || 0);
      let subtasksOffset = subtasksPage.offset + (task.subtasks?.length || 0);
      const draft = readDraft(`comment:${task.company_code}:${id}`);
      container.innerHTML = `<h3>Координация и проверка</h3><p class="tasks-mcp-meta"><span>Источник: ${escapeHTML(TASK_SOURCES[task.source] || task.source)}</span><span>Исполнитель: ${escapeHTML(task.assignee_name || 'Не назначен')}</span><span>Проверяющий: ${escapeHTML(task.reviewer_name || 'Не назначен')}</span></p>
        ${task.parent_task_id ? `<p>Родительская задача: ${projectTaskLink(task.parent_task_id,task.company_code,`#${Number(task.parent_task_id)}`)}</p>` : ''}
        ${task.no_report ? '<p class="tasks-mcp-alert">Нет отчёта больше 60 минут</p>' : ''}
        <dl>${Object.entries(milestones).map(([key,label]) => {
          const stage = coordination.milestones?.[key] || {state:'pending'};
          return `<dt><strong>${label}: ${escapeHTML(milestoneStates[stage.state] || stage.state)}</strong></dt><dd>${escapeHTML(stage.evidence || 'Нет подтверждения')}${stage.checkedAt ? ' · ' + escapeHTML(displayDate(stage.checkedAt)) : ''}</dd>`;
        }).join('')}</dl>${linksMarkup(coordination.links)}
        <form class="crm-form" data-owner-task-update><label>Исполнитель<input name="executor" maxlength="200" value="${escapeHTML(task.assignee_name || '')}"></label>
        <label>Проверяющий<input name="reviewer" maxlength="200" value="${escapeHTML(task.reviewer_name || '')}"></label>
        <label>Статус<select name="status">${taskOptions(TASK_STATUSES,task.status)}</select></label><label>Срок<input name="due_date" type="date" value="${escapeHTML(task.due_date || '')}"></label>
        <label>Что мешает<textarea name="blocker" maxlength="4000">${escapeHTML(coordination.blocker || '')}</textarea></label><label>Следующий шаг<textarea name="next_step" maxlength="4000">${escapeHTML(coordination.nextAction || '')}</textarea></label>
        <fieldset class="wide"><legend>Подтверждение этапа</legend><label>Этап<select name="stage"><option value="">Без изменения этапов</option>${taskOptions(milestones)}</select></label>
        <label>Основание<textarea name="evidence" maxlength="4000"></textarea></label><label>Когда проверено<input name="checked_at" type="datetime-local" step="0.001"></label></fieldset>
        <div class="wide" data-task-link-editors>${(coordination.links || []).map(linkEditorMarkup).join('')}</div><button type="button" data-task-link-add>Добавить ссылку, фото или видео</button>
        <div class="crm-actions wide"><button class="plain-button" type="submit">Сохранить координацию</button></div><p class="wide" role="status" data-owner-task-result></p></form>
        <h3>Подзадачи</h3>${progressMarkup(task)}<ul data-task-subtasks-list>${(task.subtasks || []).map(child => subtaskMarkup(child,task.company_code)).join('') || '<li data-task-subtasks-empty>Подзадач пока нет</li>'}</ul>
        <button type="button" data-task-subtasks-more${subtasksOffset >= subtasksPage.total ? ' hidden' : ''}>Показать ещё подзадачи</button><p role="status" data-task-subtasks-result></p>
        ${task.parent_task_id ? '' : '<button type="button" data-task-add-child>Добавить подзадачу</button>'}
        <h3>Комментарии</h3><ul class="tasks-mcp-comments" data-task-comments-list>${(task.comments || []).map(commentMarkup).join('') || '<li data-task-comments-empty>Комментариев пока нет</li>'}</ul>
        <button type="button" data-task-comments-more${commentsOffset >= commentsPage.total ? ' hidden' : ''}>Показать ещё комментарии</button><p role="status" data-task-comments-result></p>
        <form data-task-comment-form><label>Новый комментарий<textarea name="text" required maxlength="4000" rows="3">${escapeHTML(draft?.text || '')}</textarea></label><button type="submit">Добавить комментарий</button><p role="status" data-task-comment-result></p></form>`;
      const form = container.querySelector('[data-owner-task-update]');
      bindProjectTaskLinks(container);
      const bindPage = collection => {
        const button = container.querySelector(`[data-task-${collection}-more]`);
        const result = container.querySelector(`[data-task-${collection}-result]`);
        button.onclick = async () => {
          if (button.disabled) return;
          button.disabled = true;
          result.textContent = '';
          try {
            const args = {task_id:Number(id),comments_limit:20,subtasks_limit:20};
            args[`${collection}_offset`] = collection === 'comments' ? commentsOffset : subtasksOffset;
            const response = await ownerTool('task_get', args);
            if (!button.isConnected || version !== renderVersion || ctx.currentView !== 'tasks') return;
            const next = response.task || response, items = next[collection] || [];
            const list = container.querySelector(`[data-task-${collection}-list]`);
            container.querySelector(`[data-task-${collection}-empty]`)?.remove();
            const marker = collection === 'comments' ? 'comment' : 'subtask';
            const existingIds = new Set([...list.querySelectorAll(`[data-task-${marker}-id]`)].map(item => item.dataset[collection === 'comments' ? 'taskCommentId' : 'taskSubtaskId']));
            const additions = items.filter(item => !item.id || !existingIds.has(String(item.id)));
            list.insertAdjacentHTML('beforeend', additions.map(item => collection === 'comments' ? commentMarkup(item) : subtaskMarkup(item,task.company_code)).join(''));
            if (collection === 'comments') {
              commentsPage = next.comments_pagination;
              commentsOffset = commentsPage.offset + items.length;
              button.hidden = commentsOffset >= commentsPage.total || !items.length;
            } else {
              subtasksPage = next.subtasks_pagination;
              subtasksOffset = subtasksPage.offset + items.length;
              button.hidden = subtasksOffset >= subtasksPage.total || !items.length;
              bindProjectTaskLinks(list);
            }
          } catch (error) {
            if (button.isConnected) result.textContent = error.message;
          } finally { button.disabled = false; }
        };
      };
      bindPage('comments');
      bindPage('subtasks');
      const bindLinkRemove = () => form.querySelectorAll('[data-task-link-remove]').forEach(button => {
        button.onclick = () => button.closest('[data-task-link-row]').remove();
      });
      bindLinkRemove();
      form.querySelector('[data-task-link-add]').onclick = () => {
        form.querySelector('[data-task-link-editors]').insertAdjacentHTML('beforeend', linkEditorMarkup());
        bindLinkRemove();
      };
      form.onsubmit = async event => {
        event.preventDefault();
        const button = form.querySelector('[type=submit]'), result = form.querySelector('[data-owner-task-result]');
        if (button.disabled) return;
        button.disabled = true;
        try {
          const payload = Object.fromEntries(['executor','reviewer','status','due_date','blocker','next_step'].map(key => [key, form.elements.namedItem(key).value.trim()]));
          payload.task_id = Number(id);
          payload.revision = coordination.revision || 0;
          payload.links = [...form.querySelectorAll('[data-task-link-row]')].map(row => ({
            url: row.querySelector('[data-task-link-url]').value.trim(), label: row.querySelector('[data-task-link-label]').value.trim(), kind: row.querySelector('[data-task-link-kind]').value
          })).filter(link => link.url || link.label);
          if (payload.links.some(link => !safeTaskUrl(link.url))) throw new Error('Укажите полный адрес ссылки http:// или https://');
          if (form.elements.stage.value) {
            payload.stage = form.elements.stage.value;
            payload.evidence = form.elements.evidence.value.trim();
            payload.checked_at = isoDateInput(form.elements.checked_at.value);
            if (!payload.evidence || !payload.checked_at) throw new Error('Для подтверждения этапа укажите основание и дату проверки');
          }
          await ownerTool('task_update', payload);
          if (version !== renderVersion || ctx.currentView !== 'tasks') return;
          const legacy = byId('tasks-content').querySelector('[data-task-form]');
          if (legacy) {
            legacy.elements.status.value = payload.status;
            legacy.elements.assigneeName.value = payload.executor;
            legacy.elements.dueDate.value = payload.due_date;
          }
          await renderOwnerTaskPanel(container, id, version);
          container.querySelector('[data-owner-task-result]').textContent = 'Сохранено';
          void loadTasksSummary();
        } catch (error) { result.textContent = error.message; }
        finally { button.disabled = false; }
      };
      container.querySelector('[data-task-add-child]')?.addEventListener('click', () => openTaskCreate({id:Number(id),companyCode:task.company_code}));
      const commentForm = container.querySelector('[data-task-comment-form]');
      const commentKey = `comment:${task.company_code}:${id}`;
      commentForm.elements.text.oninput = () => writeDraft(commentKey, {text:commentForm.elements.text.value});
      commentForm.onsubmit = async event => {
        event.preventDefault();
        const button = commentForm.querySelector('[type=submit]');
        if (button.disabled) return;
        button.disabled = true;
        try {
          const response = await ownerTool('task_comment', {task_id:Number(id),author:ctx.identity?.userName || ctx.identity?.name || ctx.identity?.login || 'Owner',text:commentForm.elements.text.value.trim()});
          writeDraft(commentKey, null);
          if (version === renderVersion && ctx.currentView === 'tasks' && commentForm.isConnected) {
            container.querySelector('[data-task-comments-empty]')?.remove();
            container.querySelector('[data-task-comments-list]').insertAdjacentHTML('afterbegin', commentMarkup(response.comment));
            commentForm.elements.text.value = '';
            commentForm.querySelector('[data-task-comment-result]').textContent = 'Комментарий добавлен';
            commentsPage.total++;
            // Новый комментарий сдвигает границу последующих страниц истории.
            commentsOffset++;
          }
        } catch (error) { commentForm.querySelector('[data-task-comment-result]').textContent = error.message; }
        finally { button.disabled = false; }
      };
    } catch (error) {
      if (version === renderVersion) container.innerHTML = `<p role="alert">Не удалось загрузить координацию: ${escapeHTML(error.message)}</p>`;
    }
  };
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
        <header class="crm-card-header"><h2>${escapeHTML(task.title)}</h2></header>${source}${taskFormMarkup(task)}${ctx.identity?.role==='owner'?'<section class="tasks-mcp-detail" data-owner-task-detail></section><section data-task-dispatch></section>':''}`;
      content.querySelector("[data-task-back]").addEventListener("click", (event) => {
        event.preventDefault();
        navigate(taskRoute());
      });
      if(ctx.identity?.role==='owner'){
        void renderOwnerTaskPanel(content.querySelector('[data-owner-task-detail]'), task.id, version);
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
    if (['board','today','agents'].includes(id)) { boardView = id; renderCoordination(true); }
    else if (id) renderTaskCard(id);
    else if(ctx.identity?.role==='owner')renderCoordination(true);
    else renderTaskList();
  };
  const openTaskCreate = async (parent = null) => {
    const dialog = byId("task-create-dialog");
    const form = byId("task-create-form");
    createParentId = parent?.id || null;
    await loadTaskCompanies();
    const companyCode = parent?.companyCode || ctx.selectedProjectId;
    const draftKey = `create:${companyCode}:${createParentId || ''}`;
    const draft = readDraft(draftKey);
    form.dataset.draftKey = draftKey;
    form.querySelector("[data-task-company]").innerHTML = taskCompanyOptions(
      draft?.companyCode || companyCode
    );
    form.querySelector("[data-task-company]").disabled = Boolean(createParentId);
    form.querySelector("[data-task-role]").innerHTML = taskOptions(TASK_ROLES, "synapse");
    form.querySelector("[data-task-priority]").innerHTML = taskOptions(TASK_PRIORITIES, "normal");
    form.querySelector("[data-task-status]").innerHTML = taskOptions(TASK_STATUSES, "planned");
    form.dataset.sourceRef = draft?.client_ref || `owner-board:${crypto.randomUUID()}`;
    form.querySelector('[data-task-reviewer-label]')?.remove();
    form.querySelector('[data-task-parent-label]')?.remove();
    if (ctx.identity?.role === 'owner') {
      form.insertAdjacentHTML('beforeend', '<label data-task-reviewer-label>Проверяющий<input name="reviewer" maxlength="200"></label>');
      if (createParentId) form.insertAdjacentHTML('beforeend', `<p class="wide" data-task-parent-label>Подзадача задачи #${Number(createParentId)}</p>`);
    }
    ['title','description','assigneeName','dueDate'].forEach(key => { form.elements.namedItem(key).value = draft?.[key] || ''; });
    ['assigneeRole','priority','status','reviewer'].forEach(key => {
      if (draft?.[key] && form.elements.namedItem(key)) form.elements.namedItem(key).value = draft[key];
    });
    form.querySelector("[role=alert]").hidden = true;
    form.querySelector('[data-task-auto-label]')?.remove();
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
      writeDraft(form.dataset.draftKey, {...payload,reviewer:form.elements.namedItem('reviewer')?.value || '',client_ref:form.dataset.sourceRef});
      let created;
      if (ctx.identity?.role === 'owner') {
        taskCreateScope(payload.companyCode);
        const data = await ownerTool('task_create', {
          client_ref: form.dataset.sourceRef, title:payload.title, description:payload.description,
          project:payload.companyCode, priority:payload.priority, due_date:payload.dueDate,
          executor:payload.assigneeName, reviewer:form.elements.namedItem('reviewer')?.value.trim() || '',
          parent_id:createParentId, source:'manual',status:payload.status
        });
        created = data.task;
      } else created = await crmQuery("/tasks", taskCreateScope(payload.companyCode), csrfOptions("POST", {
        ...payload,
        source: "manual",
        sourceRef: form.dataset.sourceRef || "",
        sourceAuthor: ""
      }));
      writeDraft(form.dataset.draftKey, null);
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
  byId('task-create-form').addEventListener('input', event => {
    const form = event.currentTarget;
    if (form.dataset.draftKey) writeDraft(form.dataset.draftKey, {
      ...taskPayload(form), reviewer:form.elements.namedItem('reviewer')?.value || '',client_ref:form.dataset.sourceRef
    });
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
