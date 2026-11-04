(() => {
  'use strict';
  /* №98 Б «Контент → Контент-план». Анкета нового проекта (автосохранение частями), план по анкете
     через Хью (существующая подсказка Медиа-наставника), краткий и полный вид рилсов, согласование
     галочками → «к СММ». Хранилище — существующий план /media-mentor; публикаций здесь нет.
     Всё, что пришло с сервера, выводится как текст. */
  const sb = window.SbCabinet = window.SbCabinet || {};
  const PATH = '/media-mentor', SUGGEST = '/content/media-mentor-suggest';
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

  let state = null, epoch = 0;
  const canEdit = (ctx) => ctx.identity?.role === 'owner' || (ctx.identity?.permissions || []).includes('autoposting.edit');

  async function load(container, ctx) {
    const mine = ++epoch, code = String(ctx.selectedProjectId || '').toLowerCase();
    if (!code) { container.innerHTML = '<p class="cp-note">Выберите компанию.</p>'; return; }
    container.innerHTML = '<p class="cp-note" role="status">Загружаем контент-план…</p>';
    try {
      const [mentor, questionnaire, signoffs] = await Promise.all([
        ctx.crmQuery(PATH, {companyCode: code}), ctx.crmQuery(`${PATH}/questionnaire`, {companyCode: code}),
        ctx.crmQuery(`${PATH}/plan/signoffs`, {companyCode: code})]);
      if (mine !== epoch || String(ctx.selectedProjectId || '').toLowerCase() !== code) return;
      state = {code, ctx, container, mentor, questionnaire, signoffs, open: state?.code === code ? state.open : new Set(), pending: {}, saving: null, suggestion: null};
      draw();
    } catch (error) {
      if (mine === epoch) container.innerHTML = `<p class="cp-error" role="alert">${esc(error.message || 'Не удалось загрузить контент-план')}</p>`;
    }
  }

  function draw() {
    const {mentor, questionnaire: q, signoffs: s, ctx, container} = state, edit = canEdit(ctx);
    const vocab = mentor.vocabulary || {platforms: []}, platformLabel = (id) => vocab.platforms.find((p) => p.id === id)?.label || id;
    const days = mentor.plan?.days || [], states = mentor.variants || [];
    const statusOf = (idea) => { const list = states.filter((v) => v.ideaId === idea.ideaId);
      return list.find((v) => v.status === 'rejected')?.status || list.find((v) => v.status === 'pending')?.status
        || list.find((v) => v.status === 'approved')?.status || list[0]?.status || 'empty'; };
    container.innerHTML = `<section class="cp">
      <header class="cp-head"><div><h2>Контент-план</h2><p class="cp-stage" data-stage="${esc(s.stage)}">${esc(STAGE[s.stage] || s.stage)}</p></div>
        <div class="cp-actions">
          ${edit ? '<button type="button" class="plain-button" data-cp="questionnaire">Написать контент-план</button>' : ''}
          ${edit ? '<button type="button" class="plain-button" data-cp="import">Импорт CSV/XLSX</button>' : ''}
          <button type="button" class="plain-button" data-cp="chat">Чат с Хью</button></div></header>
      <details class="cp-card cp-q" ${q.filled < q.total && !days.length ? 'open' : ''}><summary>Анкета проекта · заполнено ${q.filled} из ${q.total}</summary>
        <p class="cp-note">Можно заполнять частями: каждое поле сохраняется само. ${esc((q.rules || []).join(' '))}</p>
        <form class="cp-q-form" data-cp-form>${Q.map(([key, label, hint]) => `<label>${label}<textarea data-q="${key}" rows="2" maxlength="2000" placeholder="${esc(hint)}" ${edit ? '' : 'readonly'}>${esc(q.fields[key])}</textarea></label>`).join('')}
          <fieldset><legend>Площадки</legend>${vocab.platforms.map((p) => `<label class="cp-check"><input type="checkbox" data-q-platform="${esc(p.id)}" ${q.fields.platforms.includes(p.id) ? 'checked' : ''} ${edit ? '' : 'disabled'}> ${esc(p.label)}</label>`).join('')}</fieldset>
        </form><p class="cp-note" data-cp-saved role="status">${q.updatedAt ? `Сохранено${q.updatedBy ? ' · ' + esc(q.updatedBy) : ''}` : 'Ещё не сохранялась'}</p>
        ${edit ? `<div class="cp-gen"><label>Начало<input type="date" data-cp-start value="${isoIn(1)}"></label>
          <label>Дней<select data-cp-days><option>7</option><option>14</option></select></label>
          <button type="button" class="plain-button" data-cp="generate">Сформировать план через Хью</button></div>
          <div data-cp-suggest></div>` : ''}</details>
      <section class="cp-card cp-approve"><h3>Согласование</h3>
        ${s.planRevision ? `<ul class="cp-approvers">${s.approvers.map((a) => `<li><label class="cp-check"><input type="checkbox" data-signoff="${esc(a.slot)}" ${a.checked ? 'checked' : ''} ${a.canCheck ? '' : 'disabled'}> ${esc(a.label)}</label>
          <span class="cp-note">${a.checked ? `✓ ${esc(a.actorName)}` : 'ждёт отметки'}</span></li>`).join('')}</ul>
          ${s.approversSource === 'stub' ? '<p class="cp-note">Список согласующих задаётся в «Настройках → Контент». Пока согласует владелец.</p>' : ''}
          ${s.emptyIdeas.length ? `<p class="cp-warn">Без подписи — не войдут в согласование: ${s.emptyIdeas.length}. Откройте строку и заполните подпись.</p>` : ''}`
          : '<p class="cp-note">Согласовывать пока нечего: сначала сформируйте или импортируйте план.</p>'}
        <p class="cp-note">Согласовано материалов: ${s.approvedIdeas} из ${s.ideas}.</p></section>
      <ol class="cp-list">${days.map((idea, index) => {
        const st = statusOf(idea), open = state.open.has(idea.ideaId);
        return `<li class="cp-row" data-idea="${esc(idea.ideaId)}"><button type="button" class="cp-line" data-toggle aria-expanded="${open}">
          <span class="cp-n">№${index + 1}</span><span class="cp-date">${esc(day(idea.date))}</span>
          <span class="cp-pl">${esc(Object.keys(idea.variants || {[idea.platform]: 1}).map(platformLabel).join(', '))}</span>
          <span class="cp-topic">${esc(idea.topic)}</span><span class="cp-st" data-status="${esc(st)}">${esc(VSTATUS[st] || st)}${idea.productionStatus ? ' · ' + esc(PROD[idea.productionStatus] || '') : ''}</span></button>
          ${open ? full(idea, edit) : ''}</li>`; }).join('')}</ol>
      <p class="cp-error" data-cp-error role="alert" hidden></p></section>`;
    wire();
  }

  function full(idea, edit) {
    const lines = roles(idea.script), actors = [...new Set(lines.map((l) => l.actor).filter(Boolean))];
    const block = (key, value) => value ? `<div><dt>${LABEL[key]}</dt><dd>${esc(value)}</dd></div>` : '';
    return `<div class="cp-full"><dl>
      ${block('hook', idea.hook)}${block('broll', idea.broll)}${block('style', idea.style)}
      <div><dt>Сценарий по ролям${actors.length ? ` · ${esc(actors.join(', '))}` : ''}</dt><dd>${lines.length ? `<table class="cp-script"><tbody>${lines.map((l) => `<tr><th scope="row">${esc(l.actor || '—')}</th><td>${esc(l.line)}</td></tr>`).join('')}</tbody></table>` : '<span class="cp-note">Сценарий не заполнен</span>'}</dd></div>
      ${block('props', idea.props)}${block('filmingBy', idea.filmingBy)}${block('caption', caption(idea))}
      ${idea.mentorNote ? `<div><dt>Задание Хью</dt><dd>${esc(idea.mentorNote)}</dd></div>` : ''}</dl>
      ${edit ? `<details class="cp-edit"><summary>Изменить</summary><form data-edit="${esc(idea.ideaId)}">
        ${[...REEL, 'caption'].map((key) => `<label>${LABEL[key]}<textarea name="${key}" rows="${key === 'script' ? 6 : 2}">${esc(key === 'caption' ? caption(idea) : idea[key] || '')}</textarea></label>`).join('')}
        <button type="submit" class="plain-button">Сохранить строку</button><p class="cp-note">После правки строка снова уходит на согласование.</p></form></details>` : ''}</div>`;
  }

  const error = (message) => { const node = state.container.querySelector('[data-cp-error]'); if (node) { node.hidden = !message; node.textContent = message || ''; } };
  const opts = (method, body) => state.ctx.csrfOptions(method, body);

  /* Автосохранение анкеты: одно поле — одна правка, запросы идут строго по очереди с последней ревизией. */
  function queueSave(patch) {
    Object.assign(state.pending, patch);
    clearTimeout(state.timer);
    state.timer = setTimeout(flush, 700);
  }
  async function flush() {
    if (state.saving || !Object.keys(state.pending).length) return;
    const fields = state.pending, mine = state; state.pending = {};
    const saved = state.container.querySelector('[data-cp-saved]');
    if (saved) saved.textContent = 'Сохраняем…';
    state.saving = (async () => {
      try {
        mine.questionnaire = await mine.ctx.crmQuery(`${PATH}/questionnaire`, {companyCode: mine.code}, opts('PUT', {revision: mine.questionnaire.revision, fields}));
        if (saved) saved.textContent = `Сохранено · заполнено ${mine.questionnaire.filled} из ${mine.questionnaire.total}`;
      } catch (err) {
        if (saved) saved.textContent = err.status === 409 ? 'Анкету изменил другой человек — обновите страницу.' : `Не сохранено: ${err.message}`;
        if (err.status !== 409) Object.assign(mine.pending, fields, mine.pending);
      } finally { mine.saving = null; if (state === mine && Object.keys(mine.pending).length) queueSave({}); }
    })();
  }

  async function savePlan(days, reason) {
    const {mentor, ctx, code} = state;
    days = [...days].sort((a, b) => a.date.localeCompare(b.date));
    await ctx.crmQuery(`${PATH}/plan`, {companyCode: code}, opts('PUT', {planRevision: mentor.plan?.revision || 0, briefRevision: mentor.brief.revision, days, reason}));
    await load(state.container, ctx);
  }

  /* Пустые поля брифа дополняются из анкеты; заполненные подтверждённые поля не переписываются. */
  async function briefFromQuestionnaire() {
    const {mentor, questionnaire: q, ctx, code} = state, b = mentor.brief.fields || {}, patch = {};
    if (!b.goal && q.fields.goals) patch.goal = q.fields.goals;
    if (!b.audience && q.fields.audience) patch.audience = q.fields.audience;
    if (!(b.platforms || []).length && q.fields.platforms.length) patch.platforms = q.fields.platforms;
    if (!Object.keys(patch).length) return;
    state.mentor = await ctx.crmQuery(`${PATH}/brief`, {companyCode: code}, opts('PUT', {revision: mentor.brief.revision, brief: patch, reason: 'Пустые поля брифа дополнены из анкеты контент-плана'}));
  }

  async function generate(button) {
    const node = state.container.querySelector('[data-cp-suggest]'), mine = state;
    button.disabled = true; node.innerHTML = '<p class="cp-note" role="status">Хью составляет план… это может занять до минуты.</p>';
    try {
      await flush(); await state.saving; await briefFromQuestionnaire();
      const answer = await mine.ctx.apiJson(`${SUGGEST}?companyCode=${encodeURIComponent(mine.code)}`, opts('POST', {
        startDate: state.container.querySelector('[data-cp-start]').value, days: Number(state.container.querySelector('[data-cp-days]').value)}));
      if (state !== mine) return;
      mine.suggestion = answer.status === 'ok' ? answer.items : [];
      node.innerHTML = mine.suggestion.length ? `<p class="cp-note">${esc(answer.notice || '')}</p><ol class="cp-suggest">${mine.suggestion.map((i) =>
        `<li><b>${esc(day(i.date))}</b> · ${esc(i.platform)} · ${esc(i.topic)}${i.hook ? `<br><span class="cp-note">Хук: ${esc(i.hook)}</span>` : ''}</li>`).join('')}</ol>
        <button type="button" class="plain-button" data-cp="accept">Добавить ${mine.suggestion.length} в план</button>`
        : `<p class="cp-warn">${esc(answer.notice || 'Хью не предложил материалов.')}</p>`;
      node.querySelector('[data-cp="accept"]')?.addEventListener('click', accept);
    } catch (err) { node.innerHTML = `<p class="cp-error" role="alert">${esc(err.message || 'Не удалось сформировать план')}</p>`; }
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
    const {ctx, code, signoffs: s} = state; input.disabled = true;
    try {
      state.signoffs = await ctx.crmQuery(`${PATH}/plan/signoffs`, {companyCode: code}, opts('POST',
        {planRevision: s.planRevision, briefRevision: s.briefRevision, slot: input.dataset.signoff, checked: input.checked}));
      await load(state.container, ctx);
    } catch (err) { input.checked = !input.checked; input.disabled = false; error(err.message); }
  }

  function openChat() {
    const detail = {source: 'content-plan', companyCode: state.code};
    const chat = window.SynapseModules?.get?.('hugh-chat');
    if (chat?.open) chat.open(detail);
    else if (window.SynapseModules?.open) window.SynapseModules.open('hugh-chat', detail);
    else { window.dispatchEvent(new CustomEvent('synapse:hugh-chat', {detail})); state.ctx.navigate?.('hugh'); }
  }

  function wire() {
    const root = state.container;
    root.querySelectorAll('[data-q]').forEach((field) => field.addEventListener('input', () => queueSave({[field.dataset.q]: field.value})));
    root.querySelectorAll('[data-q-platform]').forEach((box) => box.addEventListener('change', () =>
      queueSave({platforms: [...root.querySelectorAll('[data-q-platform]:checked')].map((b) => b.dataset.qPlatform)})));
    root.querySelectorAll('[data-toggle]').forEach((button) => button.addEventListener('click', () => {
      const id = button.closest('[data-idea]').dataset.idea;
      state.open.has(id) ? state.open.delete(id) : state.open.add(id); draw();
    }));
    root.querySelectorAll('[data-edit]').forEach((form) => form.addEventListener('submit', (event) => { event.preventDefault(); void saveRow(form); }));
    root.querySelectorAll('[data-signoff]').forEach((input) => input.addEventListener('change', () => void signoff(input)));
    root.querySelector('[data-cp="questionnaire"]')?.addEventListener('click', () => { const d = root.querySelector('.cp-q'); d.open = true; d.querySelector('textarea')?.focus(); });
    root.querySelector('[data-cp="generate"]')?.addEventListener('click', (event) => void generate(event.currentTarget));
    // Импорт таблицы (CSV/XLSX) — существующий импорт PR 496 в «Предложениях плана».
    root.querySelector('[data-cp="import"]')?.addEventListener('click', () => { location.hash = '#content-factory/plan/proposals'; });
    root.querySelector('[data-cp="chat"]').addEventListener('click', openChat);
  }

  const definition = {title: 'Контент-план', mount: load, render: load,
    unmount() { epoch++; if (state) clearTimeout(state.timer); state = null; },
    onProjectChange(ctx) { if (state?.container) void load(state.container, ctx); }};
  sb.contentPlan = {definition, roles};
  // Реестр каркаса (агент А); без него — прежняя регистрация вида кабинета.
  if (typeof window.SynapseModules?.register === 'function') window.SynapseModules.register('content-plan', definition);
  else (window.SynapseModulesPending = window.SynapseModulesPending || []).push(['content-plan', definition]);
  sb.registerView?.('content-plan', {...definition, onLeave: definition.unmount});
})();
