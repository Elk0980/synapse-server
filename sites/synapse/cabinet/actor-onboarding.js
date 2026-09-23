(() => {
  'use strict';

  const sb = window.SbCabinet = window.SbCabinet || {};
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g,
    (char) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  const questions = [
    {key: 'direction', label: 'О каком направлении компании вы рассказываете?',
      why: 'Чтобы темы относились к вашей работе, а направления компании не смешивались.', max: 200,
      placeholder: 'Например, недвижимость'},
    {key: 'role', label: 'Что вы готовы делать для контента?',
      why: 'Чтобы предложить посильное первое задание с учётом вашего опыта.', max: 500,
      placeholder: 'Например, объяснять выбор объектов и отвечать на вопросы'},
    {key: 'cameraComfort', label: 'Как вам удобнее начинать съёмку?',
      why: 'Чтобы не требовать появления в кадре, если вы пока к этому не готовы.', options: [
        ['unknown', 'Пока не знаю'], ['off_camera', 'Без моего лица'],
        ['small_steps', 'Постепенно попробую'], ['on_camera', 'Мне комфортно в кадре']]},
    {key: 'voiceComfort', label: 'Как вам удобнее работать с голосом?',
      why: 'Чтобы выбрать между текстом, короткой озвучкой и разговорным видео.', options: [
        ['unknown', 'Пока не знаю'], ['text_only', 'Пока только текст'],
        ['short_voice', 'Короткая озвучка'], ['comfortable', 'Могу говорить свободно']]},
    {key: 'boundaries', label: 'Что не стоит предлагать вам для съёмки?',
      why: 'Чтобы уважать личные границы, не показывать лишнее и согласовать формат заранее.', max: 2000,
      placeholder: 'Например, не снимать семью и дом'},
    {key: 'suggestions', label: 'Что улучшить в нашей работе?',
      why: 'Чтобы ваши идеи попали к команде уже на старте.', max: 2000,
      placeholder: 'Любое предложение — даже небольшое'},
  ];
  const keys = questions.map((item) => item.key);
  const optionLabel = (key, value) => questions.find((item) => item.key === key)?.options
    ?.find(([code]) => code === value)?.[1] || 'Не указано';
  const can = (ctx, permission) => ctx.identity?.role === 'owner' ||
    ctx.identity?.permissions?.includes(`actor-onboarding.${permission}`);
  const endpoint = (code, summary = false) => `/content/actor-onboarding${summary ? '/summary' : ''}` +
    `?companyCode=${encodeURIComponent(code)}`;
  const date = (value) => value && Number.isFinite(Date.parse(value)) ?
    new Date(value).toLocaleDateString('ru-RU') : 'ещё нет';
  const empty = () => ({direction: '', role: '', cameraComfort: 'unknown',
    voiceComfort: 'unknown', boundaries: '', suggestions: ''});

  let current = null;
  let sequence = 0;
  const drafts = new Map();
  const draftKey = (state) => `${state.actorId ?? state.ctx.identity?.userId ?? 'unknown'}:${state.code}`;
  const live = (state) => current === state && state.id === sequence &&
    state.ctx.selectedProjectId === state.code && state.container.isConnected;
  const field = (item, value) => {
    const id = `actor-onboarding-${item.key}`;
    let control;
    if (item.options) control = `<select id="${id}" name="${item.key}">${item.options.map(([code, label]) =>
      `<option value="${code}"${value === code ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
    else if (item.max > 500) control = `<textarea id="${id}" name="${item.key}" maxlength="${item.max}"
      rows="3" placeholder="${esc(item.placeholder)}">${esc(value)}</textarea>`;
    else control = `<input id="${id}" name="${item.key}" type="text" maxlength="${item.max}"
      value="${esc(value)}" placeholder="${esc(item.placeholder)}">`;
    return `<section class="actor-onboarding-question" data-actor-step="${keys.indexOf(item.key)}" hidden>
      <span class="actor-onboarding-kicker">Вопрос ${keys.indexOf(item.key) + 1} из ${keys.length}</span>
      <label for="${id}">${esc(item.label)}</label>
      <p class="actor-onboarding-why"><strong>Зачем:</strong> ${esc(item.why)}</p>${control}</section>`;
  };
  function readForm(form) {
    const result = {};
    questions.forEach((item) => { result[item.key] = form.elements.namedItem(item.key).value.trim(); });
    return result;
  }
  function status(state, message, error = false) {
    if (!live(state)) return;
    const node = state.container.querySelector('[data-actor-status]');
    node.textContent = message;
    node.dataset.error = String(error);
  }
  function showStep(state) {
    if (!live(state)) return;
    const node = state.container;
    node.querySelectorAll('[data-actor-step]').forEach((panel, index) => {
      panel.hidden = index !== state.step;
    });
    node.querySelector('[data-actor-progress]').textContent = `Шаг ${state.step + 1} из ${keys.length}`;
    node.querySelector('[data-actor-progress-bar]').style.width = `${(state.step + 1) * 100 / keys.length}%`;
    node.querySelector('[data-actor-prev]').hidden = state.step === 0;
    node.querySelector('[data-actor-next]').hidden = state.step === keys.length - 1;
    node.querySelector('[data-actor-save]').textContent = state.step === keys.length - 1 ?
      'Сохранить ответы' : 'Сохранить сейчас';
  }
  function summaryMarkup(data) {
    const rows = Array.isArray(data?.participants) ? data.participants : [];
    return `<div class="actor-onboarding-summary-head"><div><h2>Готовность команды</h2>
      <p>${Number(data?.ready) || 0} из ${Number(data?.total) || 0} участников заполнили основные ответы.</p></div>
      <button type="button" class="plain-button" data-actor-refresh-summary>Обновить</button></div>
      <p class="actor-onboarding-private">Здесь нет личных пояснений, границ съёмки и предложений участников.</p>
      ${rows.length ? `<ul class="actor-onboarding-people">${rows.map((item) => {
        const ready = Boolean(item.direction && item.role && item.cameraComfort !== 'unknown' &&
          item.voiceComfort !== 'unknown');
        return `<li><strong>${esc(item.actorName || 'Участник')}</strong>
          <span class="actor-onboarding-badge" data-ready="${ready}">${ready ? 'Анкета готова' : 'Анкета в работе'}</span>
          <span>Кадр: ${esc(optionLabel('cameraComfort', item.cameraComfort))}</span>
          <span>Голос: ${esc(optionLabel('voiceComfort', item.voiceComfort))}</span>
          <small>Обновлено: ${esc(date(item.updatedAt))}</small></li>`;
      }).join('')}</ul>` : '<p>Участники пока не сохранили ответы.</p>'}`;
  }
  function renderForm(state, response) {
    if (!live(state)) return;
    state.actorId = response.actorId;
    const server = response.profile || empty();
    const draft = drafts.get(draftKey(state));
    state.revision = draft?.revision ?? response.revision;
    state.profile = Object.fromEntries(keys.map((key) => [key, String(draft?.profile?.[key] ?? server[key] ?? empty()[key])]));
    state.step = Math.min(draft?.step ?? 0, keys.length - 1);
    const company = state.ctx.identity?.companies?.find((item) => item.id === state.code);
    const node = state.container;
    node.innerHTML = `<div class="content-header actor-onboarding-header"><h1>Моя анкета для контента</h1>
      <p>Компания: <strong>${esc(company?.name || state.code)}</strong>. Ответы помогут подобрать темы и комфортный формат для вас.</p></div>
      <div class="actor-onboarding-layout"><section class="card actor-onboarding-card">
        <div class="actor-onboarding-top"><div><strong>${esc(response.actorName || 'Мои ответы')}</strong>
          <small>Версия ${esc(response.revision)} · обновлено ${esc(date(response.updatedAt))}</small></div>
          <span data-actor-progress></span></div>
        <div class="actor-onboarding-track" aria-hidden="true"><span data-actor-progress-bar></span></div>
        <p class="actor-onboarding-private">Вы меняете только свою анкету. Руководитель видит готовность и выбранный формат, но не ваши свободные ответы.</p>
        <form data-actor-form>${questions.map((item) => field(item, state.profile[item.key])).join('')}
          <div class="actor-onboarding-actions"><button type="button" class="plain-button" data-actor-prev>Назад</button>
            <button type="button" class="plain-button" data-actor-next>Дальше</button>
            <button type="submit" class="plain-button" data-actor-save>Сохранить сейчас</button></div>
          <p data-actor-status role="status" aria-live="polite"></p></form>
        <button type="button" class="actor-onboarding-reload" data-actor-reload>Загрузить сохранённые ответы заново</button>
      </section>${can(state.ctx, 'manage') ? `<section class="card actor-onboarding-summary" data-actor-summary
        aria-label="Готовность команды"><p>Загружаем готовность команды…</p></section>` : ''}</div>`;
    showStep(state);
    if (draft) status(state, draft.revision !== response.revision ?
      'На сервере есть новая версия. Ваши несохранённые ответы остались в форме; перед записью загрузите актуальную версию.' :
      'Несохранённые ответы восстановлены. Нажмите «Сохранить», когда будете готовы.',
    draft.revision !== response.revision);
    const form = node.querySelector('[data-actor-form]');
    form.addEventListener('input', () => {
      state.profile = readForm(form);
      drafts.set(draftKey(state), {profile: {...state.profile}, revision: state.revision, step: state.step});
    });
    form.addEventListener('change', () => {
      state.profile = readForm(form);
      drafts.set(draftKey(state), {profile: {...state.profile}, revision: state.revision, step: state.step});
    });
    node.querySelector('[data-actor-prev]').addEventListener('click', () => {state.step--; showStep(state);});
    node.querySelector('[data-actor-next]').addEventListener('click', () => {state.step++; showStep(state);});
    node.querySelector('[data-actor-reload]').addEventListener('click', () => {
      drafts.delete(draftKey(state));
      void load(state);
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!live(state) || state.busy) return;
      state.profile = readForm(form);
      state.busy = true;
      form.querySelectorAll('button,input,textarea,select').forEach((item) => {item.disabled = true;});
      status(state, 'Сохраняем ваши ответы…');
      try {
        const data = await state.ctx.apiJson(endpoint(state.code), state.ctx.csrfOptions('PUT',
          {revision: state.revision, profile: state.profile}));
        if (!live(state)) return;
        if (data.companyCode !== state.code || data.actorId !== response.actorId) throw Error('Ответ другой анкеты');
        state.revision = data.revision;
        node.querySelector('.actor-onboarding-top small').textContent =
          `Версия ${data.revision} · обновлено ${date(data.updatedAt)}`;
        drafts.delete(draftKey(state));
        status(state, 'Ответы сохранены. Вы сможете изменить их позже.');
        if (can(state.ctx, 'manage')) void loadSummary(state);
      } catch (error) {
        if (!live(state)) return;
        drafts.set(draftKey(state), {profile: {...state.profile}, revision: state.revision, step: state.step});
        status(state, error.status === 409 ?
          'Анкета уже изменилась на сервере. Ваш ввод сохранён здесь; загрузите актуальную версию и внесите правки снова.' :
          `Не удалось сохранить ответы: ${error.message}`, true);
      } finally {
        if (live(state)) {
          state.busy = false;
          form.querySelectorAll('button,input,textarea,select').forEach((item) => {item.disabled = false;});
        }
      }
    });
    node.querySelector('[data-actor-refresh-summary]')?.addEventListener('click', () => void loadSummary(state));
  }
  async function loadSummary(state) {
    if (!can(state.ctx, 'manage')) return;
    const target = state.container.querySelector('[data-actor-summary]');
    if (!target) return;
    const requestId = state.summaryVersion = (state.summaryVersion || 0) + 1;
    try {
      const data = await state.ctx.apiJson(endpoint(state.code, true));
      if (!live(state) || !target.isConnected || requestId !== state.summaryVersion) return;
      if (data.companyCode !== state.code) throw Error('Ответ другой компании');
      target.innerHTML = summaryMarkup(data);
      target.querySelector('[data-actor-refresh-summary]').addEventListener('click', () => void loadSummary(state));
    } catch (error) {
      if (live(state) && target.isConnected && requestId === state.summaryVersion)
        target.innerHTML = `<p role="alert">Не удалось загрузить готовность команды: ${esc(error.message)}</p>`;
    }
  }
  async function load(state) {
    if (!live(state)) return;
    state.container.innerHTML = '<div class="content-header"><h1>Моя анкета для контента</h1></div>' +
      '<div class="card" role="status">Загружаем ваши ответы…</div>';
    try {
      const data = await state.ctx.apiJson(endpoint(state.code));
      if (!live(state)) return;
      if (data.companyCode !== state.code) throw Error('Ответ другой компании');
      renderForm(state, data);
      if (can(state.ctx, 'manage')) void loadSummary(state);
    } catch (error) {
      if (live(state)) state.container.innerHTML = `<div class="content-header"><h1>Моя анкета для контента</h1></div>
        <div class="card" role="alert">Не удалось загрузить анкету: ${esc(error.message)}</div>`;
    }
  }
  function render(container, ctx) {
    sequence++;
    if (!can(ctx, 'self')) {
      current = null;
      container.innerHTML = '<div class="content-header"><h1>Моя анкета для контента</h1></div>' +
        '<div class="card">У вас нет доступа к личной анкете этой компании.</div>';
      return;
    }
    const code = String(ctx.selectedProjectId || '');
    if (!code) {
      current = null;
      container.innerHTML = '<div class="card">Сначала выберите компанию.</div>';
      return;
    }
    current = {id: sequence, container, ctx, code, revision: 0, step: 0, busy: false};
    void load(current);
  }
  sb.registerView('actor-onboarding', {title: 'Моя анкета', render,
    onProjectChange(ctx) {if (current?.container) render(current.container, ctx);}});
})();
