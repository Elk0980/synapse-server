(() => {
  'use strict';
  const STATUS = {inbox:'Входящие', planned:'Запланировано', in_progress:'В работе', done:'Готово', cancelled:'Отменено'};
  const STAGES = {code:'Код', connected:'Подключено', verified:'Проверено', accepted:'Принято'};
  const PRIORITY = {low:'Низкий', normal:'Обычный', high:'Высокий', urgent:'Срочный'};
  const PROJECTS = {'synapse-business':'Synapse', alvi:'ALVI', avokado:'Авокадо', palitra:'Палитра', taisabai:'TaiSabai'};
  const UNASSIGNED = '__unassigned__';
  const controllers = new WeakMap();
  const waitingRequests = new Map();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[ch]));
  const safeUrl = value => {
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; }
    catch { return ''; }
  };
  const linkedText = value => esc(value);
  const waitingAge = since => {
    const minutes=Math.max(0,Math.floor((Date.now()-Date.parse(since))/60000));
    if(minutes<1)return 'Ждёт меньше минуты';
    if(minutes<60)return `Ждёт ${minutes} мин`;
    const hours=Math.floor(minutes/60);
    return hours<24?`Ждёт ${hours} ч ${minutes%60} мин`:`Ждёт ${Math.floor(hours/24)} дн ${hours%24} ч`;
  };
  const day = () => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Bangkok', year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date());
  const stamp = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString('ru-RU') : ''; };
  const options = (values, selected) => Object.entries(values).map(([value, label]) => `<option value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}>${esc(label)}</option>`).join('');
  const dueSort = (a,b) => (a.due_date || '9999').localeCompare(b.due_date || '9999') || b.id-a.id;

  function mount(container, ctx, initial = {}) {
    if (ctx.identity?.role !== 'owner') return null;
    const prior = controllers.get(container);
    if (prior) { void prior.render(initial); return prior; }
    let alive = true, sequence = 0, detailSequence = 0, focusBeforeSheet, draggedId;
    let tasks = [], products = [], agents = [], taskSheet, createSheet;
    let structuralTaskIds = new Set();
    const overviewCache = new Map();
    const waitingInflight = {
      has:id=>waitingRequests.has(`${key}:${id}`),get:id=>waitingRequests.get(`${key}:${id}`),
      set:(id,value)=>waitingRequests.set(`${key}:${id}`,value),delete:id=>waitingRequests.delete(`${key}:${id}`)
    };
    const syncWaitingTask = id => taskSheet?.body.querySelector(`[data-wait-task="${id}"]`)?.dispatchEvent(new Event('tb-wait-sync'));
    const key = `sb-task-board:${ctx.identity.userId || ctx.identity.id || ctx.identity.login || 'owner'}`;
    const legacyPrefix = `sb-task:${ctx.identity.userId || ctx.identity.id || ctx.identity.login || 'owner'}`;
    const read = suffix => { try { return JSON.parse(sessionStorage.getItem(`${key}:${suffix}`) || 'null'); } catch { return null; } };
    const write = (suffix, value) => { try { if (value === null) sessionStorage.removeItem(`${key}:${suffix}`); else sessionStorage.setItem(`${key}:${suffix}`, JSON.stringify(value)); } catch { /* Текущая форма продолжает работать. */ } };
    const clearDraft = (suffix,snapshot) => { if (JSON.stringify(read(suffix)) !== snapshot) return false; write(suffix,null); return true; };
    const legacyDraft = suffix => {
      const legacyKey = `${legacyPrefix}:${suffix}`;
      try {
        const snapshot = sessionStorage.getItem(legacyKey), value = JSON.parse(snapshot || 'null');
        return value && typeof value === 'object' && !Array.isArray(value) ? {...value,_legacy:{key:legacyKey,snapshot}} : null;
      } catch { return null; }
    };
    const clearLegacy = origin => {
      if (!origin || typeof origin.key !== 'string' ||
        ![`${legacyPrefix}:comment:`,`${legacyPrefix}:create:`].some(prefix => origin.key.startsWith(prefix))) return;
      try { if (sessionStorage.getItem(origin.key) === origin.snapshot) sessionStorage.removeItem(origin.key); } catch { /* Старый черновик остаётся доступным. */ }
    };
    const persistComment = (id,value) => write(`comment:${id}`,{...(read(`comment:${id}`) || {}),text:value});
    const mediaTheme = window.matchMedia?.('(prefers-color-scheme: dark)');
    let themeMode;
    try { themeMode = localStorage.getItem(`${key}:theme`); } catch {}
    if (!['system','light','dark'].includes(themeMode)) themeMode = 'system';
    const theme = () => themeMode === 'system' ? (mediaTheme?.matches ? 'dark' : 'light') : themeMode;
    const applyTheme = () => {
      const active = theme(); container.dataset.tbTheme = active;
      document.body.classList.toggle('tb-owner-theme-light',active === 'light'); document.body.classList.toggle('tb-owner-theme-dark',active === 'dark');
      document.querySelectorAll('.tb-sheet').forEach(node => { node.dataset.tbTheme = active; });
      const button = container.querySelector('[data-board-theme]'); if (button) button.textContent = {system:'Тема: система',light:'Светлая тема',dark:'Тёмная тема'}[themeMode];
    };
    const saved = read('filters') || {};
    const state = {view:initial.view || saved.view || 'board', project:initial.project ?? saved.project ?? '', product:initial.product ?? saved.product ?? '', search:'', ...initial};
    const tool = (name, args = {}) => ctx.crmQuery(`/coordination/mcp/${name}`, {}, ctx.csrfOptions('POST', args));
    const name = code => code === UNASSIGNED ? 'Без проекта' : PROJECTS[code] || ctx.identity.companies?.find(item => (item.id || item.code) === code)?.name || code || 'Без проекта';
    const productNames = () => [...products.map(item=>item.name),...Object.values(PROJECTS),...(ctx.identity.companies || []).map(item=>item.name)];
    const ownerDecision = task => window.SbTaskOverview?.decision(task,productNames());
    const ownerText = (value,max=120) => window.SbTaskOverview?.ownerText(value,max,productNames()) || '';
    const projects = () => [...new Set([...ctx.identity.companies?.map(item => item.id || item.code).filter(Boolean) || [], ...tasks.map(task => task.company_code || UNASSIGNED)])];
    const matchesProject = (task,project=state.project) => !project || (task.company_code || UNASSIGNED) === project;
    const isVisibleWork = task => task.status !== 'cancelled' && !task.product_placeholder && !structuralTaskIds.has(task.id);
    const displayTitle = task => window.SbTaskOverview?.title(task) || String(task.title || '').replace(/^\s*(?:Цель|Модуль|Направление)\s*·\s*/i,'').trim();
    const childProgress = task => {
      const children = tasks.filter(item => item.parent_task_id === task.id && item.company_code === task.company_code && isVisibleWork(item));
      return {count:children.length,done:children.filter(item => item.status === 'done').length};
    };
    const filtered = () => tasks.filter(task => isVisibleWork(task) && matchesProject(task) && (!state.product || String(task.product_id) === String(state.product)) && (!state.search || `${task.title} ${task.assignee_name}`.toLowerCase().includes(state.search.toLowerCase())));
    const stageDots = task => `<span class="tb-stages" aria-label="Этапы">${Object.entries(STAGES).map(([code,label]) => {
      const stage = task.coordination?.milestones?.[code];
      return `<span class="tb-stage" data-state="${esc(stage?.state || 'pending')}" title="${label}: ${stage?.state === 'confirmed' ? 'подтверждено' : stage?.state === 'not_required' ? 'не требуется' : 'ожидает'}"><span class="tb-sr">${label}: ${stage?.state === 'confirmed' ? 'подтверждено' : 'ожидает'}</span></span>`;
    }).join('')}</span>`;
    const taskMeta = task => { const children = childProgress(task); return `<span class="tb-task-meta"><span>№${Number(task.id)}</span>${task.assignee_name || task.reviewer_name ? `<span>${esc(task.assignee_name)}${task.reviewer_name ? ` → ${esc(task.reviewer_name)}` : ''}</span>` : ''}${task.due_date ? `<time class="${task.due_date < day() && !['done','cancelled'].includes(task.status) ? 'tb-overdue' : ''}" datetime="${esc(task.due_date)}">${esc(task.due_date)}</time>` : ''}${children.count ? `<span title="Подзадачи">${children.done}/${children.count}</span>` : ''}${task.no_report ? '<span class="tb-overdue">Нет отчёта</span>' : ''}</span>`; };
    const card = task => `<button type="button" class="tb-task" data-task-open="${Number(task.id)}" draggable="true">${task.product_name ? `<span class="tb-product-label">${esc(task.product_name)}</span>` : ''}<strong>${esc(displayTitle(task))}</strong>${stageDots(task)}${taskMeta(task)}</button>`;
    const statusCount = (records, status) => records.filter(task => task.status === status).length;
    const summary = code => {
      const records = tasks.filter(task => isVisibleWork(task) && matchesProject(task,code)), working = records.filter(task => task.status === 'in_progress');
      return `<button type="button" class="tb-project-card" data-project="${esc(code)}"><strong>${esc(name(code))}</strong><span class="tb-status-bar" aria-label="Распределение задач">${Object.keys(STATUS).filter(status => status !== 'cancelled').map(status => `<i data-status="${status}" style="flex:${statusCount(records,status)}" title="${STATUS[status]}: ${statusCount(records,status)}"></i>`).join('')}</span><span class="tb-project-counts">В работе ${working.length} · План ${statusCount(records,'planned')} · Входящие ${statusCount(records,'inbox')}</span>${records.some(task => task.no_report) ? `<span class="tb-overdue">Нет отчёта ${records.filter(task => task.no_report).length}</span>` : ''}${working.length ? `<span class="tb-current">Сейчас: ${esc(working.map(displayTitle).join(' · '))}</span>` : ''}</button>`;
    };
    const notice = (text, error = false) => {
      const node = container.querySelector('[data-board-notice]'); if (node) { node.textContent = text; node.setAttribute('role', error ? 'alert' : 'status'); }
    };
    const percentage = value => `<span class="tb-percentage">${Number(value) || 0}%</span><progress max="100" value="${Number(value) || 0}" aria-label="Готовность"></progress>`;
    const overviewMarkup = () => {
      const helper = window.SbTaskOverview; if (!helper) return '';
      const model = helper.build(tasks.filter(task => matchesProject(task)),productNames());
      const waiting = model.waiting.length ? `<section class="tb-waiting" data-waiting><h2>Ждут Влада <span>${model.waiting.length}</span></h2><div>${model.waiting.map(task => {
        const since = typeof task.waiting_since === 'string' && Number.isFinite(Date.parse(task.waiting_since)) ? task.waiting_since : '';
        return `<article class="tb-waiting-row"><button type="button" class="tb-waiting-open" data-task-open="${task.id}"><span class="tb-waiting-id">№${task.id} · ${esc(name(task.company_code))}</span><strong>${esc(ownerDecision(task).question)}</strong></button>${linksMarkup(task)}${waitingInstructions(task)}${since ? `<time datetime="${esc(since)}">${esc(waitingAge(since))}</time>` : '<span class="tb-waiting-date">Ждёт решения · начало не зафиксировано</span>'}</article>`;
      }).join('')}</div></section>` : '';
      if (state.view !== 'projects') return waiting;
      const help = `<details class="tb-how" data-board-guide><summary>Как читать доску</summary><p>Цель → Модули → Задачи → Этапы</p><p>Завершённая задача даёт 100%. Для остальных каждый подтверждённый этап даёт 25%: код, подключено, проверено, принято Владом. Отметки этапов сохраняются.</p><p>Процент модуля — среднее по уникальным задачам состава: непосредственные подзадачи, ссылки состава и задачи с указанием модуля в описании. Процент цели — среднее процентов её модулей с равным весом: 100% и 0% у двух модулей дают цели 50%. Вложенные задачи не заменяют этапы родительской задачи. Неподтверждённые этапы незавершённой задачи дают 0%.</p></details>`;
      const goals = model.goals.map(goal => `<article class="tb-goal" data-goal="${goal.task.id}"><div class="tb-overview-title"><button type="button" data-task-open="${goal.task.id}"><span>Цель</span><strong>${esc(goal.title)}</strong></button>${percentage(goal.progress)}</div>${goal.current.length || goal.next.length ? `<p>Сейчас строим: ${esc(goal.current.map(module => module.title).join(', ') || 'модуль ещё не начат')}${goal.next.length ? ` → потом: ${esc(goal.next.map(module => module.title).join(', '))}` : ''}</p>` : ''}</article>`).join('');
      const modules = model.modules || model.directions;
      const activeModules = modules.filter(module => module.started);
      const directions = activeModules.length ? `<section class="tb-directions" data-active-directions data-modules><h2>Модули</h2><div class="tb-direction-grid">${activeModules.map(module => `<article class="tb-direction" data-module-id="${module.task.id}"><div class="tb-overview-title"><button type="button" data-task-open="${module.task.id}"><strong>${esc(module.title)}</strong></button>${percentage(module.progress)}</div><p class="tb-module-state">Работа начата</p>${module.why ? `<p class="tb-direction-why">Зачем: ${esc(module.why)}</p>` : ''}${module.task.assignee_name || module.task.reviewer_name ? `<p class="tb-direction-people">${module.task.assignee_name ? `Ведёт ${esc(module.task.assignee_name)}` : ''}${module.task.reviewer_name ? ` · Принимает ${esc(module.task.reviewer_name)}` : ''}</p>` : ''}<div class="tb-direction-current tb-module-tasks">${module.allMembers.map(task => `<button type="button" class="tb-module-task" data-module-task="${task.id}" data-task-open="${task.id}"><strong>№${task.id} ${esc(displayTitle(task))}</strong><span class="tb-module-task-progress">${helper.progress(task)}%</span><span class="tb-module-task-stage">${esc(helper.stageText(task))}</span></button>`).join('') || '<p class="tb-direction-people">Задач пока нет</p>'}</div></article>`).join('')}</div></section>` : '';
      const next = modules.filter(module => !module.started);
      const upcoming = next.length ? `<section class="tb-upcoming"><h2>Дальше по плану</h2><div>${next.map(direction => `<button type="button" data-task-open="${direction.task.id}">${esc(direction.title)} · ${direction.progress}%</button>`).join('')}</div></section>` : '';
      const now = model.now.length ? `<section class="tb-now" data-now-tasks><h2>Сейчас в работе</h2>${model.now.map(item => `<button type="button" class="tb-now-row" data-task-open="${item.task.id}"><span class="tb-now-direction">${esc(item.directions.length ? item.directions.map(direction => direction.title).join(' · ') : 'Вне цели')}</span><strong>№${item.task.id} ${esc(displayTitle(item.task))}</strong>${stageDots(item.task)}<span class="tb-now-stage">${esc(item.stage)}</span></button>`).join('')}</section>` : '';
      return `<div class="tb-overview">${waiting}${help}${goals}${directions}${upcoming}${now}${tasks.some(task => task._overview_incomplete) ? '<p class="tb-overview-incomplete">Часть сведений пока недоступна. Обновите доску для проверки.</p>' : ''}</div>`;
    };
    async function hydrateOverview(records) {
      if (!window.SbTaskOverview) return records;
      const result = [...records], pending = records.map((task,index) => ({task,index})).filter(({task}) => !task.product_placeholder && (task.description_truncated === true || !Object.hasOwn(task,'description') || !Object.hasOwn(task,'waiting_since') || !Object.hasOwn(task.coordination || {},'blocker') || !Object.hasOwn(task.coordination || {},'nextAction') || !Object.hasOwn(task.coordination || {},'owner_question') || (window.SbTaskOverview.isWaiting(task) && !Array.isArray(task.coordination?.links))));
      let cursor = 0;
      await Promise.all(Array.from({length:Math.min(3,pending.length)},async () => {
        while (cursor < pending.length && alive) {
          const {task,index} = pending[cursor++], signature = JSON.stringify([task.coordination?.revision,task.updated_at,...['blocker','nextAction','owner_question','if_yes','if_no','owner_minutes'].map(key => task.coordination?.[key])]);
          const cached = overviewCache.get(task.id);
          if (cached?.signature === signature && task.coordination?.revision !== undefined) { result[index] = {...task,...cached.value,coordination:{...task.coordination,...cached.value.coordination}}; continue; }
          try {
            const data = await tool('task_get',{task_id:task.id,comments_limit:1,subtasks_limit:1}), full = data.task || data;
            if (full.id !== task.id || full.company_code !== task.company_code) throw Error('Область карточки изменилась');
            const value = {description:full.description,description_truncated:false,created_at:full.created_at,waiting_since:full.waiting_since,coordination:{...task.coordination,...full.coordination}};
            result[index] = {...task,...value}; overviewCache.set(task.id,{signature,value});
          } catch { result[index] = {...task,_overview_incomplete:true}; }
        }
      }));
      return result;
    }
    const updateStatus = async (id, status) => {
      const task = tasks.find(item => item.id === Number(id));
      try { await tool('task_update', {task_id:Number(id), status, revision:task?.coordination?.revision}); await render(); }
      catch (error) { notice(error.message, true); }
    };
    async function load() {
      const records = []; let page, offset = 0;
      do {
        page = await tool('tasks_list', {limit:100, offset,overview:true});
        records.push(...(page.tasks || [])); offset = records.length;
      } while (page.tasks?.length && offset < (page.pagination?.total ?? page.total ?? 0));
      const [productData, agentData] = await Promise.all([tool('products_list',{limit:100,offset:0}), tool('agents_list')]);
      const allProducts = [...(productData.products || [])];
      while (allProducts.length < (productData.pagination?.total || 0)) {
        const next = await tool('products_list',{limit:100,offset:allProducts.length});
        if (!next.products?.length) break;
        allProducts.push(...next.products);
      }
      return {tasks:await hydrateOverview(records), products:allProducts, agents:agentData.agents || []};
    }
    // Background refresh must not replace the search field or quick-task input while someone types.
    const editingField = () => { const field = document.activeElement; return !!field && container.contains(field) && !!field.matches?.('[data-board-search],[data-quick-task] input'); };
    let deferredRefresh = false;
    async function render(next = {}, {background = false} = {}) {
      Object.assign(state, next);
      const version = ++sequence;
      if (!tasks.length) container.innerHTML = '<p class="tb-loading" role="status">Загрузка задач…</p>';
      try {
        const data = await load(); if (!alive || version !== sequence) return;
        ({tasks, products, agents} = data);
        if (background && editingField()) { deferredRefresh = true; return; }
        draw();
        if (next.taskId) await openTask(Number(next.taskId));
      } catch (error) {
        if (!alive || version !== sequence) return;
        if (!container.querySelector('[data-board-notice]')) container.innerHTML = '<div class="tb-board"><p data-board-notice role="alert"></p><button type="button" data-board-retry>Повторить загрузку</button></div>';
        notice(error.message, true); container.querySelector('[data-board-retry]')?.addEventListener('click', () => render());
      }
    }
    function draw() {
      write('filters', {view:state.view, project:state.project, product:state.product});
      structuralTaskIds = new Set(window.SbTaskOverview?.build(tasks).structuralIds || tasks.filter(task => /^\s*(?:Цель|Модуль|Направление)\s*·\s*/i.test(task.title || '')).map(task => task.id));
      const records = filtered().sort(dueSort), visibleProducts = products.filter(item => !state.project || item.company_code === state.project);
      let body;
      if (state.view === 'projects') body = `<div class="tb-projects">${projects().map(summary).join('') || '<p>Проектов пока нет.</p>'}</div>`;
      else if (state.view === 'agents') body = `<div class="tb-agents">${agents.map(agent => {
        const href = safeUrl(agent.chat_url || agent.chat);
        return `<article class="tb-agent"><strong>${esc(agent.name)}</strong><span>${esc({work:'Работает',wait:'Ожидает',idle:'Свободен',error:'Ошибка',unknown:'Неизвестно'}[agent.state] || agent.state)}</span>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">Открыть чат ↗</a>` : ''}${agent.last_event ? `<p>${esc(agent.last_event)}</p>` : ''}${agent.last_event_at ? `<small>${esc(stamp(agent.last_event_at))}</small>` : ''}${agent.no_report ? '<span class="tb-overdue">Нет отчёта</span>' : ''}</article>`;
      }).join('') || '<p>Агенты пока не зарегистрированы.</p>'}</div>`;
      else if (['plan','today'].includes(state.view)) {
        const planned = state.view === 'today' ? records.filter(task => task.due_date && task.due_date <= day() && !['done','cancelled'].includes(task.status)) : records;
        body = `${state.view === 'today' ? `<p class="tb-day">До ${esc(day())} · Бангкок</p>` : ''}<div class="tb-plan">${['in_progress','planned','inbox','done'].map(status => {
          const list = planned.filter(task => task.status === status);
          const rows = list.map(task => `<button type="button" class="tb-plan-row" data-task-open="${Number(task.id)}"><span class="tb-dot" data-status="${status}"></span><span class="tb-plan-title"><strong>${esc(displayTitle(task))}</strong>${task.product_name ? `<small>${esc(task.product_name)}</small>` : ''}</span>${taskMeta(task)}${stageDots(task)}</button>`).join('');
          return ['done','cancelled'].includes(status) ? `<details class="tb-plan-group"><summary>${STATUS[status]} <span>${list.length}</span></summary>${rows}</details>` : `<section class="tb-plan-group"><h3>${STATUS[status]} <span>${list.length}</span></h3>${rows || '<p class="tb-empty">Нет задач</p>'}</section>`;
        }).join('')}</div>`;
      } else body = `<div class="tb-columns" aria-label="Доска по статусам">${['inbox','planned','in_progress','done'].map(status => `<section class="tb-column" data-drop-status="${status}"><h3><span class="tb-dot" data-status="${status}"></span>${STATUS[status]} <span>${statusCount(records,status)}</span></h3><div>${records.filter(task => task.status === status).map(card).join('') || '<p class="tb-empty">Нет задач</p>'}</div></section>`).join('')}</div>`;
      if (state.view === 'agents' && window.SbTaskOverview) {
        const pending=window.SbTaskOverview.build(tasks.filter(task=>matchesProject(task)),productNames()).unprepared;
        if (pending.length) body += `<section data-question-queue><h3>Подготовить вопросы</h3>${pending.map(task=>`<button type="button" data-task-open="${task.id}">№${task.id} · Вопрос не оформлен</button>`).join('')}</section>`;
      }
      const legacy = tasks.filter(task => task.product_placeholder && task.status !== 'cancelled' && matchesProject(task));
      container.innerHTML = `<div class="tb-board"><header class="tb-toolbar"><div class="tb-heading"><h2>Задачи</h2><button type="button" class="tb-primary" data-create-task>+ Задача</button></div><nav class="tb-project-tabs" aria-label="Проекты"><button type="button" data-project="" aria-pressed="${!state.project}">Все проекты</button>${projects().map(code => `<button type="button" data-project="${esc(code)}" aria-pressed="${state.project === code}">${esc(name(code))}</button>`).join('')}</nav><div class="tb-controls"><nav class="tb-view-tabs" aria-label="Вид задач">${Object.entries({board:'Доска',plan:'План',today:'План дня',projects:'Обзор',agents:'Агенты'}).map(([view,label]) => `<button type="button" data-board-view="${view}" aria-pressed="${state.view === view}">${label}</button>`).join('')}</nav><button type="button" data-board-refresh aria-label="Обновить доску">↻</button><input type="search" data-board-search aria-label="Поиск задач" placeholder="Поиск задач" value="${esc(state.search)}"></div>${visibleProducts.length ? `<nav class="tb-product-chips" aria-label="Продукты"><button type="button" data-product="" aria-pressed="${!state.product}">Все продукты</button>${visibleProducts.map(product => `<button type="button" data-product="${product.id}" aria-pressed="${String(state.product) === String(product.id)}">${esc(product.name)}</button>`).join('')}</nav>` : ''}</header><p class="tb-notice" data-board-notice role="status"></p>${state.project && !['agents','projects'].includes(state.view) ? '<form class="tb-quick" data-quick-task><input name="title" required maxlength="300" aria-label="Новая задача" placeholder="Что сделать?"><button type="submit">+ Задача</button></form>' : ''}${body}${legacy.length ? `<details class="tb-cancelled"><summary>Прежние продукты · ${legacy.length}</summary><div class="tb-cancelled-list">${legacy.map(card).join('')}</div></details>` : ''}</div>`;
      container.querySelector('.tb-board').insertAdjacentHTML('afterbegin',overviewMarkup());
      container.querySelectorAll('[data-project]').forEach(button => button.onclick = () => { state.project = button.dataset.project; state.product = ''; if (state.view === 'projects') state.view = 'plan'; draw(); });
      container.querySelectorAll('[data-product]').forEach(button => button.onclick = () => { state.product = button.dataset.product; draw(); });
      container.querySelectorAll('[data-board-view]').forEach(button => button.onclick = () => { state.view = button.dataset.boardView; draw(); });
      container.querySelector('[data-board-refresh]').onclick = () => render();
      const themeButton = document.createElement('button'); themeButton.type = 'button'; themeButton.dataset.boardTheme = '';
      themeButton.onclick = () => { themeMode = {system:'light',light:'dark',dark:'system'}[themeMode]; try { localStorage.setItem(`${key}:theme`,themeMode); } catch {} applyTheme(); };
      container.querySelector('.tb-controls').append(themeButton); applyTheme();
      container.querySelector('[data-create-task]').onclick = () => openCreate();
      container.querySelector('[data-board-search]').oninput = event => {
        state.search = event.target.value;
        const start = event.target.selectionStart; draw(); const field = container.querySelector('[data-board-search]'); field.focus(); field.setSelectionRange?.(start,start);
      };
      container.querySelectorAll('[data-task-open]').forEach(button => {
        button.onclick = () => openTask(Number(button.dataset.taskOpen));
        button.ondragstart = event => { draggedId = Number(button.dataset.taskOpen); event.dataTransfer?.setData('text/plain', String(draggedId)); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; };
        button.ondragend = () => { draggedId = null; };
      });
      container.querySelectorAll('[data-drop-status]').forEach(column => {
        column.ondragover = event => { if (draggedId) event.preventDefault(); };
        column.ondrop = event => { if (!draggedId) return; event.preventDefault(); const id = draggedId; draggedId = null; void updateStatus(id,column.dataset.dropStatus); };
      });
      const quick = container.querySelector('[data-quick-task]');
      if (state.project === UNASSIGNED) quick?.remove();
      if (quick) {
        quick.elements.title.value = read(`quick:${state.project}`)?.title || '';
        quick.oninput = () => write(`quick:${state.project}`,{title:quick.elements.title.value});
        quick.onsubmit = event => { event.preventDefault(); openCreate({title:quick.elements.title.value.trim(), project:state.project}); };
      }
    }
    function sheet(title, className, onClose, beforeClose) {
      const overlay = document.createElement('div'); overlay.className = 'tb-overlay';
      overlay.innerHTML = `<section class="tb-sheet ${className}" role="dialog" aria-modal="true" aria-label="${esc(title)}" tabindex="-1"><header class="tb-sheet-header"><h2>${esc(title)}</h2><button type="button" data-sheet-close aria-label="Закрыть">×</button></header><div data-sheet-body></div></section>`;
      overlay.querySelector('.tb-sheet').dataset.tbTheme = theme();
      document.body.append(overlay); focusBeforeSheet = document.activeElement;
      const previousFocus = focusBeforeSheet;
      const close = () => { if (!overlay.isConnected) return; beforeClose?.(); overlay.remove(); onClose?.(); if (previousFocus?.isConnected) previousFocus.focus(); };
      overlay.querySelector('[data-sheet-close]').onclick = close;
      overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
      overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key !== 'Tab') return;
        const items = [...overlay.querySelectorAll('button,a[href],input,select,textarea,[tabindex="0"]')].filter(item => !item.disabled && !item.hidden && !item.closest('[hidden]'));
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      });
      overlay.querySelector('[data-sheet-close]').focus();
      return {overlay, body:overlay.querySelector('[data-sheet-body]'), close};
    }
    const taskLinks = task => task.coordination?.links || task.links || [];
    const waitingInstructions = task => `<details class="tb-waiting-instructions" data-waiting-instructions><summary>Полный текст ожидания</summary><p class="tb-waiting-text">${esc(task.coordination?.blocker || window.SbTaskOverview.waitingNeed(task))}</p>${task.coordination?.nextAction ? `<p class="tb-waiting-text"><b>Следующий шаг</b>\n${esc(task.coordination.nextAction)}</p>` : ''}</details>`;
    const linksMarkup = task => `<div class="tb-waiting-links">${taskLinks(task).map(link=>{const href=safeUrl(link.url);return href?`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(link.label||href)} ↗</a>`:'';}).join('')}</div>`;

    const chatUrl = task => safeUrl(task.chat_url) || safeUrl(taskLinks(task).find(link => /^чат/i.test(link.label || ''))?.url) || safeUrl(agents.find(agent => agent.name === task.assignee_name)?.chat_url || agents.find(agent => agent.name === task.assignee_name)?.chat);
    const productOptions = (project, selected) => `<option value="">Без продукта</option>${products.filter(product => product.company_code === project).map(product => `<option value="${product.id}"${Number(product.id) === Number(selected) ? ' selected' : ''}>${esc(product.name)}</option>`).join('')}`;
    function waitingPanel(task,own) {
      const decision=ownerDecision(task);
      if (!window.SbTaskOverview?.isWaiting(task) || !decision) return;
      const id = task.id, draftKey = `waitreply:${id}`, previous = read(draftKey) || {};
      const panel = document.createElement('section'); panel.className = 'tb-waiting-actions'; panel.dataset.waitingActions = ''; panel.dataset.waitTask = String(id); panel.dataset.ownerDecision = '';
      panel.innerHTML = `<h3>Ждёт вашего решения</h3><p data-owner-question><strong>${esc(decision.question)}</strong></p><p>Да → ${esc(decision.yes)}</p><p>Нет → ${esc(decision.no)}</p><p>Ваше время: ${decision.minutes === 0 ? 'меньше минуты' : decision.minutes+' мин.'}</p>${linksMarkup(task)}<form data-wait-reply><label data-wait-custom ${previous.text ? '' : 'hidden'}>Свой вариант<textarea name="text" maxlength="3990" required>${esc(previous.text || '')}</textarea></label><div class="tb-wait-buttons"><button type="button" data-wait-choice="Да">Да</button><button type="button" data-wait-choice="Нет">Нет</button><button type="button" data-wait-own>Свой вариант</button><button type="submit" data-wait-submit ${previous.text ? '' : 'hidden'}>Отправить ответ</button><button type="button" data-wait-check hidden>Проверить отправку</button></div><p data-wait-result role="status"></p></form><button type="button" data-wait-clear>Снять ожидание</button>`;
      own.body.querySelector('.tb-task-project').after(panel);
      // №108 + №88: вопрос остаётся простым, полный текст ожидания — рядом, свёрнутым блоком.
      panel.insertAdjacentHTML('afterend',waitingInstructions(task));
      const form = panel.querySelector('form'), result = panel.querySelector('[data-wait-result]');
      const showError = error => { result.textContent=ownerText(error.message,200) || 'Не удалось подтвердить действие. Откройте расширенную карточку.'; const diagnostic=own.body.querySelector('[data-detail-result]'); if (diagnostic) diagnostic.textContent=error.message; };
      const canClearBlocker = window.SbTaskOverview.hasWaitingBlocker(task);
      const canClearNextStep = window.SbTaskOverview.hasWaitingNextStep?.(task) === true;
      const canClearWaiting = canClearBlocker || canClearNextStep;
      if (!canClearWaiting) {
        panel.querySelector('[data-wait-clear]').hidden = true;
        const hint = document.createElement('p'); hint.className = 'tb-waiting-hint';
        hint.textContent = 'Ожидание задано назначением — измените план задачи.';
        const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Открыть план задачи'; edit.dataset.waitEditPlan = '';
        edit.onclick = () => { const plan = own.body.querySelector('[data-plan-form]'); if (plan) { plan.closest('details').open = true; plan.elements.executor.focus(); } };
        panel.append(hint,edit);
      }
      panel.querySelector('[data-wait-own]').onclick = () => { panel.querySelector('[data-wait-custom]').hidden=false; panel.querySelector('[data-wait-submit]').hidden=false; form.elements.text.focus(); };
      const persist = () => write(draftKey,{...(read(draftKey) || {}),text:form.elements.text.value});
      const sync = () => {
        const pending = read(draftKey)?.pending, running = waitingInflight.has(id);
        form.querySelector('[type=submit]').disabled = !!pending || running;
        form.querySelectorAll('[data-wait-choice]').forEach(button => { button.disabled = !!pending || running; });
        form.querySelector('[data-wait-check]').hidden = !pending;
        form.querySelector('[data-wait-check]').disabled = running;
        if (running) result.textContent = 'Ответ отправляется…';
        else if (pending) result.textContent = `${pending.error ? 'Не удалось подтвердить действие. ' : ''}Исход отправки ещё не подтверждён. Отправка не повторяется автоматически; сначала проверьте результат.`;
      };
      panel.addEventListener('tb-wait-sync',sync);
      const finish = pending => {
        const current = read(draftKey);
        if (current?.pending?.id !== pending.id) return;
        const text = pending.fromField && current.text === pending.inputAtSend ? '' : current.text || '';
        if (text) write(draftKey,{...current,text,pending:undefined}); else write(draftKey,null);
        if (own.overlay.isConnected && form.elements.text.value === pending.inputAtSend && pending.fromField) form.elements.text.value = '';
      };
      form.oninput = persist;
      const send = async (text,fromField) => {
        if (waitingInflight.has(id) || read(draftKey)?.pending || !String(text).trim()) return;
        persist();
        const pending = {id:`reply:${Date.now()}:${Math.random().toString(36).slice(2)}`,text:`ОТВЕТ: ${String(text).trim()}`,inputAtSend:form.elements.text.value,fromField,baselineId:Math.max(0,...(task.comments || []).map(item => Number(item.id) || 0))};
        waitingInflight.set(id,pending.id); write(draftKey,{...(read(draftKey) || {}),pending}); sync(); result.textContent = 'Ответ отправляется…';
        try {
          await tool('task_comment',{task_id:id,author:'Влад',text:pending.text}); finish(pending);
          if (alive) await render();
          if (taskSheet === own) { await openTask(id); taskSheet?.body.querySelector('[data-wait-result]')?.append('Ответ добавлен в ход работы.'); }
        } catch (error) {
          const current = read(draftKey);
          if (current?.pending?.id === pending.id) write(draftKey,{...current,pending:{...current.pending,error:error.message}});
          if (own.overlay.isConnected) { sync(); showError(error); result.append(" Отправка не повторяется автоматически; сначала проверьте результат."); }
        } finally {
          if (waitingInflight.get(id) === pending.id) waitingInflight.delete(id);
          window.dispatchEvent(new CustomEvent('sb-waiting-reply-settled',{detail:{key,id}}));
        }
      };
      form.onsubmit = event => { event.preventDefault(); void send(form.elements.text.value,true); };
      form.querySelectorAll('[data-wait-choice]').forEach(button => button.onclick = () => send(button.dataset.waitChoice,false));
      form.querySelector('[data-wait-check]').onclick = async event => {
        const button = event.currentTarget, pending = read(draftKey)?.pending; if (waitingInflight.has(id) || !pending) return; button.disabled = true;
        try {
          let found = false, complete = false, offset = 0;
          for (let page=0;page<5 && !found && !complete;page++) {
            const data = await tool('task_get',{task_id:id,comments_limit:20,comments_offset:offset,subtasks_limit:1}), latest = data.task || data, comments = latest.comments || [];
            if (latest.id !== id || latest.company_code !== task.company_code) throw Error('Область карточки изменилась. Откройте задачу заново.');
            found = comments.some(item => item.id>pending.baselineId && item.author === 'Влад' && item.text === pending.text);
            offset += comments.length;
            complete = comments.some(item => item.id<=pending.baselineId) || comments.length<20 || offset >= (latest.comments_pagination?.total ?? Infinity);
          }
          if (found) { finish(pending); await render(); if (taskSheet === own) { await openTask(id); taskSheet?.body.querySelector('[data-wait-result]')?.append('Ранее отправленный ответ найден.'); } }
          else if (complete) {
            const current = read(draftKey); if (current?.pending?.id === pending.id) write(draftKey,{...current,pending:undefined});
            sync(); result.textContent = 'Ответ не найден среди последних комментариев. Проверьте ход работы; повторная отправка возможна только по вашему действию.';
          } else result.textContent = 'Проверена часть истории. Исход отправки ещё неизвестен; повтор остаётся заблокирован.';
        } catch (error) { showError(error); result.append(" Ответ остаётся в черновике."); }
        finally { button.disabled = false; }
      };
      panel.querySelector('[data-wait-clear]').onclick = async event => {
        if (!canClearWaiting) return;
        const button = event.currentTarget; button.disabled = true;
        try {
          const patch = {task_id:id,revision:task.coordination?.revision};
          if (canClearBlocker) patch.blocker = '';
          if (canClearNextStep) patch.next_step = window.SbTaskOverview.stripWaitingPrefix(task.coordination.nextAction);
          await tool('task_update',patch); await render();
          if (taskSheet === own) {
            await openTask(id);
            const body = taskSheet?.body, residual = body?.querySelector('[data-waiting-actions]');
            const output = residual?.querySelector('[data-wait-result]') || body?.querySelector('[data-detail-result]');
            if (output) output.textContent = residual ? 'Маркер ожидания снят. Ожидание остаётся в карточке: проверьте план задачи.' : 'Маркер ожидания снят.';
          }
        }
        catch (error) { showError(error); button.disabled = false; }
      };
      sync();
    }
    function compactDetails(task,own) {
      const details=document.createElement('details'); details.dataset.taskTechnical='';
      details.innerHTML='<summary>Расширенная карточка</summary>';
      details.append(...own.body.childNodes); own.body.append(details);
      const panel=details.querySelector('[data-waiting-actions]');
      if (panel) { own.body.prepend(panel); const full=details.querySelector('[data-waiting-instructions]'); if (full) panel.after(full); for (const node of panel.querySelectorAll('[data-wait-clear],.tb-waiting-hint,[data-wait-edit-plan]')) details.append(node); }
      else { const summary=document.createElement('section'); summary.dataset.taskSimple=''; summary.innerHTML=`<h3>${esc(window.SbTaskOverview?.isWaiting(task) ? 'Вопрос пока не оформлен' : displayTitle(task))}</h3>`; own.body.prepend(summary); }
      const next=window.SbTaskOverview?.hasWaitingNextStep(task) ? '' : ownerText(task.coordination?.nextAction);
      if (next) { const line=document.createElement('p'); line.className='tb-simple-next'; line.textContent=`Следующий шаг: ${next}`; line.title=next; details.before(line); }
      details.open=read(`details:${task.id}`)===true;
      details.ontoggle=()=>write(`details:${task.id}`,details.open);
      details.addEventListener('click',event=>{ if (event.target.closest('[data-wait-edit-plan]')) details.open=true; });
    }
    async function openTask(id) {
      taskSheet?.close(); createSheet?.close();
      const current = ++detailSequence;
      taskSheet = sheet(`Задача №${id}`, 'tb-task-sheet', () => { ++detailSequence; taskSheet = null; }, () => {
        const body = taskSheet?.body, plan = body?.querySelector('[data-plan-form]'), comment = body?.querySelector('[data-comment-form]');
        if (plan?.dataset.dirty) write(`plan:${id}`,Object.fromEntries(new FormData(plan)));
        if (comment?.elements.text.value) persistComment(id,comment.elements.text.value);
        const waitReply = body?.querySelector('[data-wait-reply]');
        if (waitReply) write(`waitreply:${id}`,{...(read(`waitreply:${id}`) || {}),text:waitReply.elements.text.value});
        body?.querySelectorAll('[data-stage-form]').forEach(form => { if (form.dataset.dirty) write(`stage:${id}:${form.dataset.stageForm}`,Object.fromEntries(new FormData(form))); });
      });
      const own = taskSheet; own.body.innerHTML = '<p role="status">Загрузка задачи…</p>';
      try {
        const data = await tool('task_get', {task_id:id,comments_limit:3,subtasks_limit:20});
        if (!alive || current !== detailSequence || taskSheet !== own) return;
        const task = data.task || data, coord = task.coordination || {}, href = chatUrl(task), draftKey = `plan:${id}`, draft = read(draftKey) || {};
        if (task.status === 'cancelled') { own.body.innerHTML = '<p role="status">Задача снята с доски.</p>'; return; }
        if (read(`comment:${id}`) === null) {
          const previous = legacyDraft(`comment:${task.company_code}:${id}`);
          if (typeof previous?.text === 'string') write(`comment:${id}`,previous);
        }
        const field = (key, fallback = '') => draft[key] ?? fallback;
        const parentTasks = tasks.filter(item => item.status !== 'cancelled' && item.company_code === task.company_code && item.id !== id && !item.parent_task_id);
        const listComment = comment => `<li data-comment-id="${Number(comment.id)}"><small>${esc(comment.author)} · ${esc(stamp(comment.created_at))}</small><p>${linkedText(comment.text)}</p></li>`;
        own.body.innerHTML = `<h3 class="tb-task-title">${esc(displayTitle(task))}</h3><p class="tb-task-project">${esc(name(task.company_code))}${task.product_name ? ` · ${esc(task.product_name)}` : ''}</p>${href ? `<a class="tb-chat-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">Открыть чат исполнителя ↗</a>` : ''}<p><a href="#tasks/record/${Number(id)}" data-task-record>Расширенная карточка · вложения и работа помощников</a></p><dl class="tb-facts">${coord.result ? `<div><dt>Результат</dt><dd>${linkedText(coord.result)}</dd></div>` : ''}${task.assignee_name ? `<div><dt>Делает</dt><dd>${esc(task.assignee_name)}</dd></div>` : ''}${task.reviewer_name ? `<div><dt>Проверяет</dt><dd>${esc(task.reviewer_name)}</dd></div>` : ''}${task.due_date ? `<div><dt>Срок</dt><dd>${esc(task.due_date)}</dd></div>` : ''}${coord.nextAction ? `<div><dt>Следующий шаг</dt><dd>${linkedText(coord.nextAction)}</dd></div>` : ''}${coord.blocker ? `<div><dt>Мешает</dt><dd>${linkedText(coord.blocker)}</dd></div>` : ''}</dl><div class="tb-status-buttons" aria-label="Статус задачи">${Object.entries(STATUS).map(([status,label]) => `<button type="button" data-detail-status="${status}" aria-pressed="${task.status === status}">${label}</button>`).join('')}</div><p data-detail-result role="status"></p>${task.description ? `<details class="tb-description"><summary>Описание · показать всё</summary><p>${linkedText(task.description)}</p></details>` : ''}<section class="tb-detail-section"><h3>Этапы</h3>${Object.entries(STAGES).map(([code,label]) => {
          const stage = coord.milestones?.[code] || {};
          return `<details class="tb-milestone"><summary><span class="tb-stage" data-state="${esc(stage.state || 'pending')}"></span>${label}${stage.checkedAt ? `<time>${esc(stamp(stage.checkedAt))}</time>` : ''}</summary>${stage.evidence ? `<p>${linkedText(stage.evidence)}</p>` : ''}<form data-stage-form="${code}"><label>Основание<textarea name="evidence" maxlength="4000" required>${esc(stage.evidence || '')}</textarea></label><label>Дата проверки<input name="checked_at" type="datetime-local" required></label><button type="submit">Подтвердить этап</button><p data-stage-result role="status"></p></form></details>`;
        }).join('')}</section>${taskLinks(task).length ? `<section class="tb-detail-section"><h3>Ссылки</h3><ul>${taskLinks(task).map(link => { const url = safeUrl(link.url); return url ? `<li><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(link.label || url)}</a></li>` : ''; }).join('')}</ul></section>` : ''}<section class="tb-detail-section"><h3>Подзадачи <span>${childProgress(task).done}/${childProgress(task).count}</span></h3><ul class="tb-subtasks" data-subtasks>${(task.subtasks || []).filter(isVisibleWork).map(item => `<li><button type="button" data-child-open="${item.id}">${STATUS[item.status] || ''} · №${item.id} ${esc(displayTitle(item))}</button></li>`).join('')}</ul>${(task.subtasks_pagination?.total || 0) > (task.subtasks || []).length ? '<button type="button" data-subtasks-more>Ещё подзадачи</button>' : ''}<button type="button" data-add-subtask>+ Подзадача</button></section><details class="tb-detail-section"${Object.keys(draft).length ? ' open' : ''}><summary>План задачи</summary><form class="tb-form" data-plan-form><label>Исполнитель<input name="executor" maxlength="200" value="${esc(field('executor',task.assignee_name))}"></label><label>Проверяет<input name="reviewer" maxlength="200" value="${esc(field('reviewer',task.reviewer_name))}"></label><label>Срок<input name="due_date" type="date" value="${esc(field('due_date',task.due_date))}"></label><label>Приоритет<select name="priority">${options(PRIORITY,field('priority',task.priority))}</select></label><label class="tb-wide">Следующий шаг<textarea name="next_step" maxlength="4000">${esc(field('next_step',coord.nextAction))}</textarea></label><label class="tb-wide">Мешает<textarea name="blocker" maxlength="4000">${esc(field('blocker',coord.blocker))}</textarea></label><label class="tb-wide">Чат исполнителя<input name="chat_url" type="url" value="${esc(field('chat_url',href))}" placeholder="https://"></label><label>Продукт<select name="product_id">${productOptions(task.company_code,field('product_id',task.product_id))}</select></label><label>Родительская задача<select name="parent_id"><option value="">Без родителя</option>${parentTasks.map(item => `<option value="${item.id}"${String(field('parent_id',task.parent_task_id)) === String(item.id) ? ' selected' : ''}>№${item.id} ${esc(displayTitle(item))}</option>`).join('')}</select></label><button type="submit">Сохранить план</button><p class="tb-wide" data-plan-result role="status"></p></form></details><section class="tb-detail-section"><h3>Ход работы</h3><ol class="tb-comments" data-comments>${(task.comments || []).map(listComment).join('')}</ol>${(task.comments_pagination?.total || 0) > (task.comments || []).length ? '<button type="button" data-comments-more>Все комментарии</button>' : ''}<form class="tb-comment-form" data-comment-form><label>Комментарий от Влада<textarea name="text" maxlength="10000" required>${esc(read(`comment:${id}`)?.text || '')}</textarea></label><button type="submit">Добавить комментарий</button><p data-comment-result role="status"></p></form></section>`;
        const result = own.body.querySelector('[data-detail-result]');
        const module = window.SbTaskOverview?.build(tasks.map(item => item.id === task.id ? task : item)).modules?.find(item => item.task.id === task.id);
        if (module) {
          own.body.querySelector('.tb-task-project').insertAdjacentHTML('afterend',`<section class="tb-detail-section" data-module-composition><h3>Задачи модуля</h3><div class="tb-direction-current tb-module-tasks">${module.allMembers.map(item => `<button type="button" class="tb-module-task" data-module-task="${item.id}" data-child-open="${item.id}"><strong>№${item.id} ${esc(displayTitle(item))}</strong><span class="tb-module-task-progress">${window.SbTaskOverview.progress(item)}%</span><span class="tb-module-task-stage">${esc(window.SbTaskOverview.stageText(item))}</span></button>`).join('') || '<p class="tb-direction-people">Задач пока нет</p>'}</div></section>`);
        }
        waitingPanel(task,own);
        own.body.querySelector('[data-task-record]').onclick = event => {
          event.preventDefault();
          if (task.company_code && ctx.selectedProjectId !== task.company_code) ctx.chooseProject?.(task.company_code);
          if (ctx.navigate) ctx.navigate(`tasks/record/${Number(id)}`);
          else location.hash = `tasks/record/${Number(id)}`;
        };
        own.body.querySelectorAll('[data-detail-status]').forEach(button => button.onclick = async () => {
          button.disabled = true;
          try { await tool('task_update', {task_id:id,status:button.dataset.detailStatus,revision:coord.revision}); await render(); if (taskSheet === own) await openTask(id); }
          catch (error) { result.textContent = error.message; button.disabled = false; }
        });
        own.body.querySelectorAll('[data-child-open]').forEach(button => button.onclick = () => openTask(Number(button.dataset.childOpen)));
        own.body.querySelector('[data-add-subtask]').onclick = () => openCreate({project:task.company_code,parent_id:id,product_id:task.product_id});
        const plan = own.body.querySelector('[data-plan-form]');
        plan.oninput = () => { plan.dataset.dirty = 'true'; write(draftKey,Object.fromEntries(new FormData(plan))); };
        plan.onsubmit = async event => {
          event.preventDefault(); const button = plan.querySelector('[type=submit]'); button.disabled = true;
          const snapshot = JSON.stringify(read(draftKey));
          const payload = Object.fromEntries(new FormData(plan)); payload.product_id = payload.product_id ? Number(payload.product_id) : null; payload.parent_id = payload.parent_id ? Number(payload.parent_id) : null;
          try { await tool('task_update', {task_id:id,revision:coord.revision,...payload}); clearDraft(draftKey,snapshot); plan.dataset.dirty = ''; await render(); if (taskSheet === own) await openTask(id); }
          catch (error) { plan.querySelector('[data-plan-result]').textContent = error.message; button.disabled = false; }
        };
        own.body.querySelectorAll('[data-stage-form]').forEach(form => {
          const draft = read(`stage:${id}:${form.dataset.stageForm}`);
          if (draft) { form.elements.evidence.value = draft.evidence || ''; form.elements.checked_at.value = draft.checked_at || ''; }
          form.oninput = () => { form.dataset.dirty = 'true'; write(`stage:${id}:${form.dataset.stageForm}`,Object.fromEntries(new FormData(form))); };
          form.onsubmit = async event => {
          event.preventDefault(); const button = form.querySelector('[type=submit]'); button.disabled = true;
          const draftKey = `stage:${id}:${form.dataset.stageForm}`, snapshot = JSON.stringify(read(draftKey));
          try { await tool('task_update', {task_id:id,revision:coord.revision,stage:form.dataset.stageForm,evidence:form.elements.evidence.value.trim(),checked_at:new Date(form.elements.checked_at.value).toISOString()}); form.dataset.dirty = ''; clearDraft(draftKey,snapshot); await render(); if (taskSheet === own) await openTask(id); }
          catch (error) { form.querySelector('[data-stage-result]').textContent = error.message; button.disabled = false; }
          };
        });
        const comment = own.body.querySelector('[data-comment-form]');
        comment.oninput = () => persistComment(id,comment.elements.text.value);
        comment.onsubmit = async event => {
          event.preventDefault(); const button = comment.querySelector('[type=submit]'); button.disabled = true;
          const submittedText = comment.elements.text.value, snapshot = JSON.stringify(read(`comment:${id}`));
          const origin = read(`comment:${id}`)?._legacy;
          try {
            const response = await tool('task_comment', {task_id:id,author:'Влад',text:submittedText.trim()});
            clearLegacy(origin);
            clearDraft(`comment:${id}`,snapshot); if (comment.elements.text.value === submittedText) comment.elements.text.value = '';
            const list = own.body.querySelector('[data-comments]');
            if (!list.querySelector(`[data-comment-id="${Number(response.comment.id)}"]`)) { list.insertAdjacentHTML('afterbegin',listComment(response.comment)); commentsOffset++; }
            comment.querySelector('[data-comment-result]').textContent = 'Комментарий добавлен';
          }
          catch (error) { comment.querySelector('[data-comment-result]').textContent = `${error.message}. Проверьте ход работы перед повторной отправкой.`; }
          finally { button.disabled = false; }
        };
        let commentsOffset = (task.comments || []).length, subtasksOffset = (task.subtasks || []).length;
        const more = (collection, offset) => tool('task_get', {task_id:id,comments_limit:20,subtasks_limit:20,[`${collection}_offset`]:offset});
        own.body.querySelector('[data-comments-more]')?.addEventListener('click', async event => {
          const button = event.currentTarget; button.disabled = true;
          try {
            const response = await more('comments',commentsOffset), next = response.task || response, list = own.body.querySelector('[data-comments]');
            const shown = new Set([...list.querySelectorAll('[data-comment-id]')].map(node => Number(node.dataset.commentId)));
            list.insertAdjacentHTML('beforeend',(next.comments || []).filter(item => !shown.has(Number(item.id))).map(listComment).join(''));
            commentsOffset += next.comments?.length || 0; button.hidden = commentsOffset >= (next.comments_pagination?.total || 0);
          }
          catch (error) { result.textContent = error.message; } finally { button.disabled = false; }
        });
        own.body.querySelector('[data-subtasks-more]')?.addEventListener('click', async event => {
          const button = event.currentTarget; button.disabled = true;
          try { const response = await more('subtasks',subtasksOffset), next = response.task || response; const list = own.body.querySelector('[data-subtasks]'); for (const item of next.subtasks || []) { if (!isVisibleWork(item)) continue; const li = document.createElement('li'), child = document.createElement('button'); child.type = 'button'; child.textContent = `${STATUS[item.status] || ''} · №${item.id} ${displayTitle(item)}`; child.onclick = () => openTask(item.id); li.append(child); list.append(li); } subtasksOffset += next.subtasks?.length || 0; button.hidden = subtasksOffset >= (next.subtasks_pagination?.total || 0); }
          catch (error) { result.textContent = error.message; } finally { button.disabled = false; }
        });
        compactDetails(task,own);
      } catch (error) { if (taskSheet === own) own.body.innerHTML = `<p role="alert">${esc(ownerText(error.message,200) || 'Не удалось открыть задачу. Попробуйте обновить доску.')}</p><details data-task-technical><summary>Расширенная карточка</summary><p class="tb-diagnostic">${esc(error.message)}</p></details>`; }
    }
    function openCreate(preset = {}) {
      taskSheet?.close(); createSheet?.close();
      if (read('create') === null) {
        const requestedProject = preset.project || (state.project !== UNASSIGNED ? state.project : '') || ctx.selectedProjectId || '';
        const previous = legacyDraft(`create:${requestedProject}:${preset.parent_id || ''}`);
        const previousProject = previous?.project || previous?.companyCode || requestedProject;
        if (previous && projects().includes(previousProject) && (!preset.project || preset.project === previousProject) && (!state.project || state.project === previousProject)) {
          write('create',{...previous,project:previousProject,executor:previous.executor ?? previous.assigneeName ?? '',due_date:previous.due_date ?? previous.dueDate ?? '',parent_id:preset.parent_id || previous.parent_id || null});
        }
      }
      const draft = {...(read('create') || {}),...preset}; let draftRef = draft.client_ref || `board:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      let rememberCreate;
      createSheet = sheet('Новая задача','tb-create-sheet',() => { createSheet = null; }, () => rememberCreate?.());
      const own = createSheet;
      own.body.innerHTML = `<form class="tb-form" data-create-form><label class="tb-wide">Что сделать<input name="title" required maxlength="300" value="${esc(draft.title || '')}" autofocus></label><div class="tb-wide tb-duplicates" data-create-duplicates aria-live="polite"></div><label>Проект<select name="project" required><option value="">Выберите проект</option>${projects().filter(code => code !== UNASSIGNED).map(code => `<option value="${esc(code)}"${(draft.project || state.project) === code ? ' selected' : ''}>${esc(name(code))}</option>`).join('')}</select></label><label>Продукт<select name="product_id">${productOptions(draft.project || state.project,draft.product_id || state.product)}<option value="new">+ Новый продукт</option></select></label><label class="tb-wide" data-new-product hidden>Новый продукт<input name="new_product" maxlength="200" value="${esc(draft.new_product || '')}"></label><label>Исполнитель<input name="executor" maxlength="200" value="${esc(draft.executor || '')}"></label><label>Проверяет<input name="reviewer" maxlength="200" value="${esc(draft.reviewer || '')}"></label><label>Срок<input name="due_date" type="date" value="${esc(draft.due_date || '')}"></label><label>Приоритет<select name="priority">${options(PRIORITY,draft.priority || 'normal')}</select></label><label class="tb-wide">Чат<input name="chat_url" type="url" placeholder="https://" value="${esc(draft.chat_url || '')}"></label><label class="tb-wide">Подробности<textarea name="description" maxlength="10000">${esc(draft.description || '')}</textarea></label><label class="tb-wide tb-force" data-force-label hidden><input name="force" type="checkbox">Создать отдельную задачу несмотря на совпадение</label><button type="submit">Создать задачу</button><p class="tb-wide" data-create-result role="status"></p></form>`;
      const form = own.body.querySelector('form'), duplicates = own.body.querySelector('[data-create-duplicates]'); let timer, duplicateSequence = 0, sending = false;
      const payload = () => {
        draftRef = read('create')?.client_ref || draftRef;
        const values = Object.fromEntries(new FormData(form));
        const data = {title:values.title.trim(),project:values.project,executor:values.executor.trim(),reviewer:values.reviewer.trim(),due_date:values.due_date,priority:values.priority,chat_url:values.chat_url.trim(),description:values.description.trim(),status:draft._legacy && STATUS[draft.status] ? draft.status : 'inbox',source:'manual',client_ref:draftRef};
        if (Array.isArray(draft.links)) data.links = draft.links;
        if (draft.parent_id) data.parent_id = Number(draft.parent_id);
        if (values.product_id === 'new') data.new_product = values.new_product.trim();
        else if (values.product_id) data.product_id = Number(values.product_id);
        if (values.force) data.force = true;
        return data;
      };
      let created = false;
      const saveDraft = () => { if (!created) { draftRef = read('create')?.client_ref || draftRef; write('create',{...draft,...Object.fromEntries(new FormData(form)),parent_id:draft.parent_id,client_ref:draftRef}); } };
      rememberCreate = saveDraft;
      const showDuplicates = data => {
        const matches = data.possible_duplicates || [], found = matches.filter(item => item.status !== 'cancelled'), similarProducts = data.possible_product_duplicates || [];
        duplicates.innerHTML = `${found.length ? '<strong>Похожие задачи — можно открыть существующую:</strong>' : ''}${found.map(task => `<button type="button" data-existing-task="${Number(task.id)}">№${task.id} ${esc(displayTitle(task))}</button>`).join('')}${matches.length > found.length ? '<p>Есть прежнее совпадение. Для отдельной задачи подтвердите создание.</p>' : ''}${similarProducts.length ? `<p>Похожие продукты: ${similarProducts.map(product => `<button type="button" data-existing-product="${product.id}">${esc(product.name)}</button>`).join('')}</p>` : ''}`;
        form.querySelector('[data-force-label]').hidden = !(matches.length || similarProducts.length);
        duplicates.querySelectorAll('[data-existing-task]').forEach(button => button.onclick = () => { saveDraft(); openTask(Number(button.dataset.existingTask)); });
        duplicates.querySelectorAll('[data-existing-product]').forEach(button => button.onclick = () => { form.elements.product_id.value = button.dataset.existingProduct; form.querySelector('[data-new-product]').hidden = true; saveDraft(); });
      };
      const searchDuplicates = () => {
        clearTimeout(timer); const version = ++duplicateSequence; form.elements.force.checked = false;
        timer = setTimeout(async () => {
          const args = payload(); if (!args.title || !args.project || createSheet !== own) return;
          try { const data = await tool('task_duplicates', {title:args.title,project:args.project,...(args.product_id ? {product_id:args.product_id} : {}),...(args.new_product ? {new_product:args.new_product} : {})}); if (version === duplicateSequence && createSheet === own) showDuplicates(data); }
          catch (error) { if (createSheet === own) form.querySelector('[data-create-result]').textContent = error.message; }
        },300);
      };
      form.oninput = event => { saveDraft(); if (['title','project','product_id','new_product'].includes(event.target.name)) searchDuplicates(); };
      form.elements.project.onchange = () => { form.elements.product_id.innerHTML = productOptions(form.elements.project.value,'') + '<option value="new">+ Новый продукт</option>'; form.querySelector('[data-new-product]').hidden = true; saveDraft(); searchDuplicates(); };
      form.elements.product_id.onchange = () => { form.querySelector('[data-new-product]').hidden = form.elements.product_id.value !== 'new'; saveDraft(); searchDuplicates(); };
      form.onsubmit = async event => {
        event.preventDefault(); if (sending) return; sending = true; const button = form.querySelector('[type=submit]'); button.disabled = true; clearTimeout(timer); ++duplicateSequence;
        const args = payload(); saveDraft(); const snapshot = JSON.stringify(read('create'));
        try {
          if (!args.title || !args.project) throw Error('Укажите задачу и проект');
          if (form.elements.product_id.value === 'new' && !args.new_product) throw Error('Укажите название продукта');
          const attemptKey = `create-attempt:${args.client_ref}`;
          // Не заменяем первый неизвестный запрос новым текстом той же формы.
          // Его client_ref мог уже закрепиться за созданной задачей.
          const earlierAttempt = read(attemptKey);
          if (!earlierAttempt) write(attemptKey,args);
          const data = await tool('task_create',args);
          if (data.created === false && !data.task) { write(attemptKey,null); showDuplicates(data); form.querySelector('[data-create-result]').textContent = 'Проверьте похожие задачи и продукты'; return; }
          const comparable = value => JSON.stringify(Object.fromEntries(Object.entries(value || {}).filter(([key]) => !['client_ref','force'].includes(key)).sort(([a],[b]) => a.localeCompare(b))));
          const replayChanged = data.task && Object.entries({title:'title',description:'description',project:'company_code',executor:'assignee_name',reviewer:'reviewer_name',due_date:'due_date',priority:'priority',chat_url:'chat_url'})
            .some(([input,stored]) => Object.hasOwn(data.task,stored) && String(data.task[stored] ?? '') !== String(args[input] ?? ''));
          const recoveredEarlier = data.created === false && data.task &&
            ((earlierAttempt && comparable(earlierAttempt) !== comparable(args)) || replayChanged);
          if (!recoveredEarlier) clearLegacy(draft._legacy);
          write(attemptKey,null);
          created = true;
          if (recoveredEarlier || !clearDraft('create',snapshot)) {
            const newer = read('create'); if (newer?.client_ref === draftRef) write('create',{...newer,force:undefined,client_ref:`board:${Date.now()}:${Math.random().toString(36).slice(2)}`});
          }
          const quick = read(`quick:${args.project}`); if (!recoveredEarlier && quick?.title.trim() === args.title) write(`quick:${args.project}`,null);
          const stillOpen = createSheet === own; own.close(); state.project = args.project; await render();
          if (stillOpen && data.task?.id) {
            await openTask(data.task.id);
            if (recoveredEarlier) {
              const message = `Восстановлена ранее созданная задача №${data.task.id}. Изменённый текст «${args.title}» сохранён в черновике новой задачи.`;
              notice(message); const result = taskSheet?.body.querySelector('[data-detail-result]'); if (result) result.textContent = message;
            }
          }
        } catch (error) { form.querySelector('[data-create-result]').textContent = `${error.message}. Черновик сохранён; перед повтором проверьте доску.`; }
        finally { sending = false; button.disabled = false; }
      };
      if (draft.product_id === 'new') { form.elements.product_id.value = 'new'; form.querySelector('[data-new-product]').hidden = false; }
      if (draft._legacy) {
        const info = document.createElement('p'); info.className = 'tb-wide'; info.textContent = `Восстановлен черновик: ${name(draft.project)}${draft.parent_id ? ` · подзадача №${draft.parent_id}` : ''}`;
        form.prepend(info);
      }
      if (Array.isArray(draft.links) && draft.links.length) {
        const links = document.createElement('div'); links.className = 'tb-wide';
        links.innerHTML = `<strong>Ссылки из черновика</strong><ul>${draft.links.map(link => { const url = safeUrl(link.url); return `<li>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(link.label || url)}</a>` : esc(link.label || link.url)}</li>`; }).join('')}</ul>`;
        form.append(links);
      }
      saveDraft(); form.elements.title.focus(); if (draft.title) searchDuplicates();
    }
    let recovery=null;
    const recover = ({force = false} = {}) => {
      if (!alive || document.visibilityState === 'hidden') return Promise.resolve();
      if (!force && editingField()) { deferredRefresh = true; return Promise.resolve(); }
      if(recovery)return recovery;
      deferredRefresh = false;
      recovery=render({}, {background:!force}).then(()=>{if(alive&&(taskSheet||createSheet))notice('Доска обновлена. Открытый черновик сохранён.');}).finally(()=>{recovery=null;});
      return recovery;
    };
    const pageShow = () => { void recover(); };
    const visibility = () => { if (document.visibilityState === 'visible') void recover(); };
    const focus = () => { void recover(); };
    let pull=null;
    const touchStart=event=>{
      if(taskSheet||createSheet||window.scrollY>0||event.touches?.length!==1||event.target.closest('input,textarea,button,a,select,[contenteditable]')){pull=null;return;}
      pull={x:event.touches[0].clientX,y:event.touches[0].clientY,distance:0};
    };
    const touchMove=event=>{
      if(!pull||event.touches?.length!==1)return;
      const dy=event.touches[0].clientY-pull.y,dx=Math.abs(event.touches[0].clientX-pull.x);
      pull.distance=dy>dx*2?dy:0;
      if(pull.distance>20&&event.cancelable)event.preventDefault();
    };
    const touchEnd=()=>{const distance=pull?.distance||0;pull=null;if(distance>=75){notice('Обновляем доску…');void recover({force:true});}};
    // Apply a postponed refresh once the field loses focus (checked after focus settles).
    const focusOut=()=>{ if(!deferredRefresh)return; window.setTimeout(()=>{ if(alive&&deferredRefresh&&!editingField())void recover(); },0); };
    const touchCancel=()=>{pull=null;};
    const refreshTimer=window.setInterval(()=>void recover(),45000);
    container.addEventListener('touchstart',touchStart,{passive:true});container.addEventListener('touchmove',touchMove,{passive:false});container.addEventListener('touchend',touchEnd);container.addEventListener('touchcancel',touchCancel);container.addEventListener('focusout',focusOut);
    const replySettled = event => { if (event.detail?.key === key) syncWaitingTask(event.detail.id); };
    window.addEventListener('pageshow',pageShow);window.addEventListener('focus',focus); document.addEventListener('visibilitychange',visibility);
    window.addEventListener('sb-waiting-reply-settled',replySettled);
    mediaTheme?.addEventListener?.('change',applyTheme);
    const controller = {render,openTask,destroy:() => { alive = false; ++sequence; ++detailSequence; taskSheet?.close(); createSheet?.close(); window.removeEventListener('pageshow',pageShow);window.removeEventListener('focus',focus);window.clearInterval(refreshTimer);container.removeEventListener('touchstart',touchStart);container.removeEventListener('touchmove',touchMove);container.removeEventListener('touchend',touchEnd);container.removeEventListener('touchcancel',touchCancel);container.removeEventListener('focusout',focusOut); window.removeEventListener('sb-waiting-reply-settled',replySettled); document.removeEventListener('visibilitychange',visibility); mediaTheme?.removeEventListener?.('change',applyTheme); document.body.classList.remove('tb-owner-theme-light','tb-owner-theme-dark'); delete container.dataset.tbTheme; controllers.delete(container); }};
    controllers.set(container,controller); void render(initial); return controller;
  }
  window.SbTaskBoard = Object.freeze({mount});
})();
