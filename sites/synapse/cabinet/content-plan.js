(() => {
  'use strict';
  /* №98 Б «Контент → Контент-план» — модуль 'content-plan' по контракту А
     (specs/098-content-shell/contracts/module-registry.md). Анкета (автосохранение частями), план по анкете
     через Хью (существующая подсказка Медиа-наставника), краткий вид и полный табличный («как Google Таблица»),
     импорт CSV/XLSX из PR 496, согласование галочками → «к СММ». Хранилище — существующий план /media-mentor.
     Публикаций здесь нет. Всё, что пришло с сервера, выводится как текст. */
  const sb = window.SbCabinet = window.SbCabinet || {};
  const CRM = 'crm/media-mentor', SUGGEST = 'media-mentor-suggest';
  const Q = [['goals', 'Цели', 'Чего ждём от контента: записи, узнаваемость, доверие…'],
    ['audience', 'Аудитория', 'Кто смотрит, их ситуация и вопросы'],
    ['tone', 'Тон', 'Например: дружески, с юмором, без канцелярита'],
    ['rubrics', 'Рубрики', 'По строке на рубрику'],
    ['frequency', 'Частота', 'Например: 7 рилсов в неделю, Telegram ежедневно'],
    ['onCamera', 'Кто в кадре', 'Мастера, администратор, клиенты (с согласия)…'],
    ['constraints', 'Ограничения', 'Чего нельзя показывать и говорить']];
  const STAGE = {none: 'Плана ещё нет', approval: 'На согласовании', smm: 'Согласовано — к СММ, в «Съёмке»'};
  const VSTATUS = {approved: 'Согласовано', pending: 'На согласовании', rejected: 'На доработке', empty: 'Нет подписи', excluded: 'Исключено'};
  const PROD = {planned: 'Запланировано', shot: 'Отснято', editing: 'В монтаже', draft: 'Черновик'};
  const REEL = ['topic', 'hook', 'script', 'broll', 'style', 'props', 'filmingBy'];
  const LABEL = {topic: 'Тема', hook: 'Хук — первые 1–2 с', script: 'Сценарий (строка «Имя: реплика»)', broll: 'Вставки (B-roll)',
    style: 'Стиль', props: 'Реквизит', filmingBy: 'Кто снимает', caption: 'Подпись к публикации'};
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const day = (iso) => { try { return new Date(iso + 'T00:00:00Z').toLocaleDateString('ru-RU', {day: '2-digit', month: '2-digit', weekday: 'short', timeZone: 'UTC'}); } catch { return iso; } };
  const isoIn = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  /* Сценарий по ролям: «Имя: реплика». Строка без имени — действие/ремарка. */
  const roles = (script) => String(script || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const m = /^([^:]{1,40}):\s*(.+)$/.exec(line);
    return m ? {actor: m[1].trim(), line: m[2]} : {actor: '', line};
  });
  const caption = (idea) => idea.variants?.[idea.platform]?.text || Object.values(idea.variants || {}).find((v) => v.text)?.text || '';
  const rolesTable = (lines) => `<table class="cp-script"><tbody>${lines.map((l) => `<tr><th scope="row">${esc(l.actor || '—')}</th><td>${esc(l.line)}</td></tr>`).join('')}</tbody></table>`;

  /* Доступ к API только через ctx контракта А: компания, CSRF и сессия добавляются оболочкой. */
  const io = (ctx) => ({
    get: (path) => ctx.api.get(CRM + path),
    put: (path, body) => ctx.api.put(CRM + path, body),
    post: (path, body) => ctx.api.post(CRM + path, body),
    suggest: (body) => ctx.api.post(SUGGEST, body)
  });
  /* Прежний импорт PR 496 ждёт контекст вида кабинета — даём ему узкий переходник поверх ctx.api. */
  const legacyCtx = (ctx) => ({
    identity: {role: ctx.user?.role, permissions: ctx.can('autoposting.edit') ? ['autoposting.edit'] : []},
    csrfOptions: (method, body) => ({method, body}),
    crmQuery: (path, params, options = {}) => ctx.api[(options.method || 'GET') === 'GET' ? 'get' : options.method.toLowerCase()](
      'crm' + path, ...(options.method && options.method !== 'GET' ? [options.body] : []))
  });

  let state = null, epoch = 0;

  async function mount(container, ctx) {
    const mine = ++epoch, code = String(ctx.companyCode || '').toLowerCase(), api = io(ctx);
    if (!code) { container.innerHTML = '<p class="cp-note">Выберите компанию.</p>'; return; }
    container.innerHTML = '<p class="cp-note" role="status">Загружаем контент-план…</p>';
    try {
      const [mentor, questionnaire, signoffs, settings] = await Promise.all([api.get(''), api.get('/questionnaire'), api.get('/plan/signoffs'),
        // Настройки → Контент (агент А) могут быть ещё не выпущены: экран работает и без них.
        Promise.resolve().then(() => ctx.settings?.content?.get()).catch(() => null)]);
      if (mine !== epoch || ctx.signal?.aborted) return;
      const view = ctx.route?.params?.get?.('view') === 'full' ? 'full' : 'short';
      state = {code, ctx, api, container, mentor, questionnaire, signoffs, settings: settings || null,
        view: state?.code === code ? state.view : view, open: state?.code === code ? state.open : new Set(), pending: {}, saving: null, suggestion: null};
      draw();
    } catch (error) {
      if (mine === epoch && !ctx.signal?.aborted) container.innerHTML = `<p class="cp-error" role="alert">${esc(error.status === 403
        ? 'Нет доступа к контент-плану этой компании.' : error.message || 'Не удалось загрузить контент-план')}</p>`;
    }
  }

  function approversNote() {
    const {settings, signoffs: s, ctx} = state, ids = settings?.settings?.approverUserIds || [];
    const names = ids.map((id) => settings.candidates?.find((c) => c.id === id)?.name || `#${id}`);
    const set = ctx.can('settings.edit') ? ' <button type="button" class="plain-button cp-small" data-cp="settings">Настроить</button>' : '';
    if (!settings) return `<p class="cp-note">Кто согласует, задаётся в «Настройках → Контент». Пока согласует владелец.${set}</p>`;
    if (!ids.length) return `<p class="cp-note">В «Настройках → Контент» согласующие не выбраны — согласует владелец.${set}</p>`;
    return `<p class="cp-note">Согласуют по «Настройкам → Контент»: ${esc(names.join(', '))}.${set}</p>${s.approversSource === 'stub'
      ? '<p class="cp-warn">Сервер не принял выбранных согласующих (нет права «согласование контент-плана» в этой компании) — пока согласует владелец.</p>' : ''}`;
  }

  function draw() {
    const {mentor, questionnaire: q, signoffs: s, ctx, container} = state, edit = ctx.can('autoposting.edit');
    const vocab = mentor.vocabulary || {platforms: []}, platformLabel = (id) => vocab.platforms.find((p) => p.id === id)?.label || id;
    const days = mentor.plan?.days || [], states = mentor.variants || [];
    const statusOf = (idea) => { const list = states.filter((v) => v.ideaId === idea.ideaId);
      return list.find((v) => v.status === 'rejected')?.status || list.find((v) => v.status === 'pending')?.status
        || list.find((v) => v.status === 'approved')?.status || list[0]?.status || 'empty'; };
    const platforms = (idea) => Object.keys(idea.variants || {[idea.platform]: 1}).map(platformLabel).join(', ');
    const status = (idea) => { const st = statusOf(idea);
      return `<span class="cp-st" data-status="${esc(st)}">${esc(VSTATUS[st] || st)}${idea.productionStatus ? ' · ' + esc(PROD[idea.productionStatus] || '') : ''}</span>`; };
    container.innerHTML = `<section class="cp">
      <header class="cp-head"><div><h2>Контент-план</h2><p class="cp-stage" data-stage="${esc(s.stage)}">${esc(STAGE[s.stage] || s.stage)}</p></div>
        <div class="cp-actions">
          ${edit ? '<button type="button" class="plain-button" data-cp="questionnaire">Написать контент-план</button>' : ''}
          <button type="button" class="plain-button" data-cp="chat">Чат с Хью</button></div></header>
      <details class="cp-card cp-q" ${q.filled < q.total && !days.length ? 'open' : ''}><summary>Анкета проекта · заполнено ${q.filled} из ${q.total}</summary>
        <p class="cp-note">Можно заполнять частями и дополнять потом: каждое поле сохраняется само. ${esc((q.rules || []).join(' '))}</p>
        <form class="cp-q-form" data-cp-form>${Q.map(([key, label, hint]) => `<label>${label}<textarea data-q="${key}" rows="2" maxlength="2000" placeholder="${esc(hint)}" ${edit ? '' : 'readonly'}>${esc(q.fields[key])}</textarea></label>`).join('')}
          <fieldset><legend>Площадки</legend>${vocab.platforms.map((p) => `<label class="cp-check"><input type="checkbox" data-q-platform="${esc(p.id)}" ${q.fields.platforms.includes(p.id) ? 'checked' : ''} ${edit ? '' : 'disabled'}> ${esc(p.label)}</label>`).join('')}</fieldset>
        </form><p class="cp-note" data-cp-saved role="status">${q.updatedAt ? `Сохранено${q.updatedBy ? ' · ' + esc(q.updatedBy) : ''}` : 'Ещё не сохранялась'}</p>
        ${edit ? `<div class="cp-gen"><label>Начало<input type="date" data-cp-start value="${isoIn(1)}"></label>
          <label>Дней<select data-cp-days><option>7</option><option>14</option></select></label>
          <button type="button" class="plain-button" data-cp="generate">Сформировать план через Хью</button></div>
          <div data-cp-suggest></div><div data-cp-import></div>` : ''}</details>
      <section class="cp-card cp-approve"><h3>Согласование</h3>
        ${s.planRevision ? `<ul class="cp-approvers">${s.approvers.map((a) => `<li><label class="cp-check"><input type="checkbox" data-signoff="${esc(a.slot)}" ${a.checked ? 'checked' : ''} ${a.canCheck ? '' : 'disabled'}> ${esc(a.label)}${a.userId && a.userId === ctx.user?.id ? ' (вы)' : ''}</label>
          <span class="cp-note">${a.checked ? `✓ ${esc(a.actorName)}` : 'ждёт отметки'}</span></li>`).join('')}</ul>
          ${s.emptyIdeas.length ? `<p class="cp-warn">Без подписи — не войдут в согласование: ${s.emptyIdeas.length}. Откройте строку и заполните подпись.</p>` : ''}`
          : '<p class="cp-note">Согласовывать пока нечего: сначала сформируйте или импортируйте план.</p>'}
        ${approversNote()}<p class="cp-note">Согласовано материалов: ${s.approvedIdeas} из ${s.ideas}. Когда отметят все — план уходит к СММ и в «Съёмку».</p></section>
      ${days.length ? `<div class="cp-views" role="group" aria-label="Вид плана">
        <button type="button" class="plain-button" data-cp-view="short" aria-pressed="${state.view === 'short'}">Кратко</button>
        <button type="button" class="plain-button" data-cp-view="full" aria-pressed="${state.view === 'full'}">Полный план (таблица)</button></div>` : ''}
      ${state.view === 'full' && days.length ? sheet(days, platforms, status) : `<ol class="cp-list">${days.map((idea, index) => {
        const open = state.open.has(idea.ideaId);
        return `<li class="cp-row" data-idea="${esc(idea.ideaId)}"><button type="button" class="cp-line" data-toggle aria-expanded="${open}">
          <span class="cp-n">№${index + 1}</span><span class="cp-date">${esc(day(idea.date))}</span>
          <span class="cp-pl">${esc(platforms(idea))}</span><span class="cp-topic">${esc(idea.topic)}</span>${status(idea)}</button>
          ${open ? full(idea, edit) : ''}</li>`; }).join('')}</ol>`}
      <p class="cp-error" data-cp-error role="alert" hidden></p></section>`;
    wire();
    if (edit) installImport();
  }

  /* Полный план — одна строка на рилс, как в таблице «КОНТЕНТ ПЛАН»; на телефоне строки становятся карточками. */
  function sheet(days, platforms, status) {
    const cols = ['№', 'Дата', 'Площадки', 'Тема', 'Хук (1–2 с)', 'Вставки (B-roll)', 'Стиль', 'Сценарий по ролям', 'Реквизит', 'Кто снимает', 'Статус'];
    const cell = (i, html) => `<td data-label="${esc(cols[i])}">${html}</td>`;
    return `<div class="cp-sheet-wrap"><table class="cp-sheet"><thead><tr>${cols.map((c) => `<th scope="col">${c}</th>`).join('')}</tr></thead><tbody>
      ${days.map((idea, index) => { const lines = roles(idea.script);
        return `<tr data-idea="${esc(idea.ideaId)}">${cell(0, `<button type="button" class="cp-link" data-open-row>№${index + 1}</button>`)}${cell(1, esc(day(idea.date)))}
        ${cell(2, esc(platforms(idea)))}${cell(3, `<b>${esc(idea.topic)}</b>`)}${cell(4, esc(idea.hook))}${cell(5, esc(idea.broll))}${cell(6, esc(idea.style))}
        ${cell(7, lines.length ? rolesTable(lines) : '')}${cell(8, esc(idea.props))}${cell(9, esc(idea.filmingBy))}${cell(10, status(idea))}</tr>`; }).join('')}
      </tbody></table></div>`;
  }

  function full(idea, edit) {
    const lines = roles(idea.script), actors = [...new Set(lines.map((l) => l.actor).filter(Boolean))];
    const block = (key, value) => value ? `<div><dt>${LABEL[key]}</dt><dd>${esc(value)}</dd></div>` : '';
    return `<div class="cp-full"><dl>
      ${block('hook', idea.hook)}${block('broll', idea.broll)}${block('style', idea.style)}
      <div><dt>Сценарий по ролям${actors.length ? ` · ${esc(actors.join(', '))}` : ''}</dt><dd>${lines.length ? rolesTable(lines) : '<span class="cp-note">Сценарий не заполнен</span>'}</dd></div>
      ${block('props', idea.props)}${block('filmingBy', idea.filmingBy)}${block('caption', caption(idea))}
      ${idea.mentorNote ? `<div><dt>Задание Хью</dt><dd>${esc(idea.mentorNote)}</dd></div>` : ''}</dl>
      ${edit ? `<details class="cp-edit"><summary>Изменить</summary><form data-edit="${esc(idea.ideaId)}">
        ${[...REEL, 'caption'].map((key) => `<label>${LABEL[key]}<textarea name="${key}" rows="${key === 'script' ? 6 : 2}">${esc(key === 'caption' ? caption(idea) : idea[key] || '')}</textarea></label>`).join('')}
        <button type="submit" class="plain-button">Сохранить строку</button><p class="cp-note">После правки строка снова уходит на согласование.</p></form></details>` : ''}</div>`;
  }

  const error = (message) => { const node = state.container.querySelector('[data-cp-error]'); if (node) { node.hidden = !message; node.textContent = message || ''; } };

  /* Автосохранение анкеты: одно поле — одна правка, запросы идут строго по очереди с последней ревизией. */
  function queueSave(patch) {
    Object.assign(state.pending, patch);
    clearTimeout(state.timer);
    state.timer = setTimeout(flush, 700);
  }
  async function flush() {
    if (!state || state.saving || !Object.keys(state.pending).length) return;
    const mine = state, fields = mine.pending; mine.pending = {};
    const saved = mine.container.querySelector('[data-cp-saved]');
    if (saved) saved.textContent = 'Сохраняем…';
    mine.saving = (async () => {
      try {
        mine.questionnaire = await mine.api.put('/questionnaire', {revision: mine.questionnaire.revision, fields});
        if (saved) saved.textContent = `Сохранено · заполнено ${mine.questionnaire.filled} из ${mine.questionnaire.total}`;
      } catch (err) {
        if (saved) saved.textContent = err.status === 409 ? 'Анкету изменил другой человек — обновите страницу.' : `Не сохранено: ${err.message}`;
        if (err.status !== 409) mine.pending = {...fields, ...mine.pending};
      } finally { mine.saving = null; if (state === mine && Object.keys(mine.pending).length) queueSave({}); }
    })();
  }

  async function savePlan(days, reason) {
    const {mentor, api, ctx, container} = state;
    days = [...days].sort((a, b) => a.date.localeCompare(b.date));
    await api.put('/plan', {planRevision: mentor.plan?.revision || 0, briefRevision: mentor.brief.revision, days, reason});
    await mount(container, ctx);
  }

  /* Пустые поля брифа дополняются из анкеты; заполненные подтверждённые поля не переписываются. */
  async function briefFromQuestionnaire() {
    const {mentor, questionnaire: q, api} = state, b = mentor.brief.fields || {}, patch = {};
    if (!b.goal && q.fields.goals) patch.goal = q.fields.goals;
    if (!b.audience && q.fields.audience) patch.audience = q.fields.audience;
    if (!(b.platforms || []).length && q.fields.platforms.length) patch.platforms = q.fields.platforms;
    if (!Object.keys(patch).length) return;
    state.mentor = await api.put('/brief', {revision: mentor.brief.revision, brief: patch, reason: 'Пустые поля брифа дополнены из анкеты контент-плана'});
  }

  async function generate(button) {
    const mine = state, node = mine.container.querySelector('[data-cp-suggest]');
    button.disabled = true; node.innerHTML = '<p class="cp-note" role="status">Хью составляет план… это может занять до минуты.</p>';
    try {
      clearTimeout(mine.timer); await flush(); await mine.saving; await briefFromQuestionnaire();
      const answer = await mine.api.suggest({startDate: mine.container.querySelector('[data-cp-start]').value,
        days: Number(mine.container.querySelector('[data-cp-days]').value)});
      if (state !== mine) return;
      mine.suggestion = answer.status === 'ok' ? answer.items : [];
      node.innerHTML = mine.suggestion.length ? `<p class="cp-note">${esc(answer.notice || '')}</p><ol class="cp-suggest">${mine.suggestion.map((i) =>
        `<li><b>${esc(day(i.date))}</b> · ${esc(i.platform)} · ${esc(i.topic)}${i.hook ? `<br><span class="cp-note">Хук: ${esc(i.hook)}</span>` : ''}</li>`).join('')}</ol>
        <button type="button" class="plain-button" data-cp="accept">Добавить ${mine.suggestion.length} в план</button>`
        : `<p class="cp-warn">${esc(answer.notice || 'Хью не предложил материалов.')}</p>`;
      node.querySelector('[data-cp="accept"]')?.addEventListener('click', accept);
    } catch (err) { if (state === mine) node.innerHTML = `<p class="cp-error" role="alert">${esc(err.message || 'Не удалось сформировать план')}</p>`; }
    finally { button.disabled = false; }
  }

  /* Подпись версии — из хука и темы: без текста версия не согласуется и не попадает в счётчик пятницы. */
  async function accept() {
    const items = state.suggestion.map((i) => ({date: i.date, platform: i.platform, format: i.format, role: i.role, topic: i.topic,
      hook: i.hook || '', assetId: i.assetId || '', mentorNote: i.mentorNote || '',
      variants: {[i.platform]: {text: [i.hook, i.topic].filter(Boolean).join('\n\n')}}}));
    try { await savePlan([...(state.mentor.plan?.days || []), ...items], 'План сформирован Хью по анкете'); }
    catch (err) { error(err.message); }
  }

  /* Импорт CSV/XLSX — существующий модуль PR 496; добавленные строки сразу сохраняются в план. */
  function installImport() {
    const host = state.container.querySelector('[data-cp-import]'), mine = state;
    if (!host || !sb.reelPlanImport?.install) return;
    const anchor = document.createElement('div'); host.append(anchor);
    sb.reelPlanImport.install({node: host, data: mine.mentor, ctx: legacyCtx(mine.ctx), code: mine.code, form: anchor,
      collectDays: () => mine.mentor.plan?.days || [], isCurrent: () => state === mine,
      appendDays: (items) => { savePlan([...(mine.mentor.plan?.days || []), ...items], 'Импорт плана из CSV/XLSX').catch((err) => error(err.message)); }});
  }

  async function saveRow(form) {
    const id = form.dataset.edit, data = Object.fromEntries(new FormData(form));
    const days = state.mentor.plan.days.map((idea) => {
      if (idea.ideaId !== id) return idea;
      const next = {...idea};
      for (const key of REEL) next[key] = key === 'script' ? data[key].replace(/\r\n?/g, '\n') : data[key].trim();
      const platform = idea.variants?.[idea.platform] ? idea.platform : Object.keys(idea.variants || {})[0] || idea.platform;
      next.variants = {...idea.variants, [platform]: {...(idea.variants?.[platform] || {}), text: data.caption.trim()}};
      return next;
    });
    try { await savePlan(days, 'Строка плана изменена'); } catch (err) { error(err.message); }
  }

  async function signoff(input) {
    const {api, ctx, container, signoffs: s} = state; input.disabled = true;
    try {
      await api.post('/plan/signoffs', {planRevision: s.planRevision, briefRevision: s.briefRevision, slot: input.dataset.signoff, checked: input.checked});
      await mount(container, ctx);
    } catch (err) { input.checked = !input.checked; input.disabled = false; error(err.message); }
  }

  function wire() {
    const root = state.container, ctx = state.ctx;
    root.querySelectorAll('[data-q]').forEach((field) => field.addEventListener('input', () => queueSave({[field.dataset.q]: field.value})));
    root.querySelectorAll('[data-q-platform]').forEach((box) => box.addEventListener('change', () =>
      queueSave({platforms: [...root.querySelectorAll('[data-q-platform]:checked')].map((b) => b.dataset.qPlatform)})));
    root.querySelectorAll('[data-toggle]').forEach((button) => button.addEventListener('click', () => {
      const id = button.closest('[data-idea]').dataset.idea;
      state.open.has(id) ? state.open.delete(id) : state.open.add(id); draw();
    }));
    root.querySelectorAll('[data-open-row]').forEach((button) => button.addEventListener('click', () => {
      state.open.add(button.closest('[data-idea]').dataset.idea); state.view = 'short'; draw();
    }));
    root.querySelectorAll('[data-cp-view]').forEach((button) => button.addEventListener('click', () => { state.view = button.dataset.cpView; draw(); }));
    root.querySelectorAll('[data-edit]').forEach((form) => form.addEventListener('submit', (event) => { event.preventDefault(); void saveRow(form); }));
    root.querySelectorAll('[data-signoff]').forEach((input) => input.addEventListener('change', () => void signoff(input)));
    root.querySelector('[data-cp="questionnaire"]')?.addEventListener('click', () => { const d = root.querySelector('.cp-q'); d.open = true; d.querySelector('textarea')?.focus(); });
    root.querySelector('[data-cp="generate"]')?.addEventListener('click', (event) => void generate(event.currentTarget));
    root.querySelector('[data-cp="settings"]')?.addEventListener('click', () => ctx.navigate('settings/content'));
    root.querySelector('[data-cp="chat"]').addEventListener('click', () => ctx.openHughChat());
  }

  const definition = {title: 'Контент-план', mount,
    unmount() { epoch++; if (state) clearTimeout(state.timer); state = null; }};
  sb.contentPlan = {definition, roles};
  // Реестр каркаса (контракт А). Без реестра — очередь SynapseModulesQueue: реестр А разбирает её при загрузке.
  if (typeof window.SynapseModules?.register === 'function') window.SynapseModules.register('content-plan', definition);
  else (window.SynapseModulesQueue = window.SynapseModulesQueue || []).push(['content-plan', definition]);
})();
