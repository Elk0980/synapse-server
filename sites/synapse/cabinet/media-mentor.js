(() => {
  'use strict';
  /* Бриф компании и контент-план на 7–14 дней. Тексты вводит человек: модели здесь не вызываются,
     публикация не выполняется. Согласование конкретной версии плана — решение по тексту,
     а не разрешение публиковать. Всё, что приходит с сервера, выводится как текст. */
  const sb = window.SbCabinet = window.SbCabinet || {};
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const PATH = '/media-mentor';
  const STATUS = {absent: 'План ещё не составлен', pending: 'Ждёт согласования',
    approved: 'Согласовано', rejected: 'Отклонено', needs_reapproval: 'Нужно пересогласовать'};
  const day = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value).split('-').reverse().join('.') : '—');
  const moment = (value) => (value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleDateString('ru-RU', {day: '2-digit', month: '2-digit', year: 'numeric'}) : '—');
  const canRead = (ctx) => ctx.identity?.role === 'owner' || ctx.identity?.permissions?.includes('autoposting.view');
  const canEdit = (ctx) => ctx.identity?.role === 'owner' || ctx.identity?.permissions?.includes('autoposting.edit');
  const canDecide = (ctx) => ctx.identity?.role === 'owner';
  const newId = () => (window.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random()}`).replace(/-/g, '').slice(0, 12);
  const options = (list, selected) => list.map((item) =>
    `<option value="${esc(item.id)}"${item.id === selected ? ' selected' : ''}>${esc(item.label)}</option>`).join('');
  let epoch = 0;

  function briefMarkup(data, edit) {
    const fields = data.brief.fields, vocabulary = data.vocabulary;
    const readOnlyList = (items, render) => (items.length
      ? `<ul class="mentor-list">${items.map(render).join('')}</ul>` : '<p class="mentor-note">Не заполнено</p>');
    if (!edit) {
      return `<dl class="mentor-brief-view">
        <div><dt>Цель</dt><dd>${esc(fields.goal) || '—'}</dd></div>
        <div><dt>Продукт</dt><dd>${esc(fields.product) || '—'}</dd></div>
        <div><dt>Аудитория</dt><dd>${esc(fields.audience) || '—'}</dd></div>
        <div><dt>Боли клиента</dt><dd>${readOnlyList(fields.pains, (item) => `<li>${esc(item)}</li>`)}</dd></div>
        <div><dt>Подтверждённые факты</dt><dd>${readOnlyList(fields.confirmedFacts,
    (item) => `<li>${esc(item.statement)}<br><span class="mentor-note">Источник: ${esc(item.source)}</span></li>`)}</dd></div>
        <div><dt>Исходники</dt><dd>${readOnlyList(fields.assets,
    (item) => `<li>${esc(item.title)} · ${esc(item.kind)}${item.note ? `<br><span class="mentor-note">${esc(item.note)}</span>` : ''}</li>`)}</dd></div>
        <div><dt>Комфорт съёмки</dt><dd>${esc(vocabulary.shootingComfort.find((level) => level.id === fields.shootingComfort.level)?.label || fields.shootingComfort.level)}${fields.shootingComfort.notes ? `<br><span class="mentor-note">${esc(fields.shootingComfort.notes)}</span>` : ''}</dd></div>
        <div><dt>Площадки</dt><dd>${fields.platforms.map((id) =>
    esc(vocabulary.platforms.find((item) => item.id === id)?.label || id)).join(', ') || '—'}</dd></div></dl>`;
    }
    return `<form id="mentor-brief-form" class="crm-form mentor-form">
      <input type="hidden" name="revision" value="${esc(data.brief.revision)}">
      <label class="wide">Цель<textarea name="goal" rows="2" maxlength="2000">${esc(fields.goal)}</textarea></label>
      <label class="wide">Продукт<textarea name="product" rows="2" maxlength="2000">${esc(fields.product)}</textarea></label>
      <label class="wide">Аудитория<textarea name="audience" rows="2" maxlength="2000">${esc(fields.audience)}</textarea></label>
      <label class="wide">Боли клиента — по одной в строке<textarea name="pains" rows="3">${esc(fields.pains.join('\n'))}</textarea></label>
      <fieldset class="wide mentor-rows" data-rows="facts"><legend>Подтверждённые факты</legend>
        <p class="mentor-note">Факт без источника не считается подтверждённым: укажите, откуда он взят.</p>
        <div data-rows-body>${fields.confirmedFacts.map((fact) => factRow(fact)).join('')}</div>
        <button class="plain-button" type="button" data-add="facts">Добавить факт</button></fieldset>
      <fieldset class="wide mentor-rows" data-rows="assets"><legend>Исходники</legend>
        <p class="mentor-note">Материалы описываются словами: ссылок и загрузки файлов на этом этапе нет.</p>
        <div data-rows-body>${fields.assets.map((asset) => assetRow(asset, vocabulary.assetKinds)).join('')}</div>
        <button class="plain-button" type="button" data-add="assets">Добавить исходник</button></fieldset>
      <label>Комфорт съёмки<select name="comfortLevel">${options(vocabulary.shootingComfort, fields.shootingComfort.level)}</select></label>
      <label class="wide">Что учесть при съёмке<textarea name="comfortNotes" rows="2" maxlength="2000">${esc(fields.shootingComfort.notes)}</textarea></label>
      <fieldset class="wide mentor-platforms"><legend>Площадки компании</legend>
        ${vocabulary.platforms.map((platform) => `<label class="mentor-checkbox"><input type="checkbox" name="platform"
          value="${esc(platform.id)}"${fields.platforms.includes(platform.id) ? ' checked' : ''}>${esc(platform.label)}</label>`).join('')}</fieldset>
      <div class="crm-actions wide"><button class="plain-button" type="submit">Сохранить бриф</button>
        <span id="mentor-brief-state" role="status"></span></div></form>`;
  }

  const factRow = (fact = {id: '', statement: '', source: ''}) => `<div class="mentor-row" data-row>
    <input type="hidden" data-field="id" value="${esc(fact.id)}">
    <label>Факт<input data-field="statement" maxlength="1000" required value="${esc(fact.statement)}"></label>
    <label>Источник<input data-field="source" maxlength="500" required value="${esc(fact.source)}"></label>
    <button class="plain-button" type="button" data-remove>Удалить</button></div>`;
  const assetRow = (asset = {id: '', title: '', kind: 'photo', note: ''}, kinds = []) => `<div class="mentor-row" data-row>
    <input type="hidden" data-field="id" value="${esc(asset.id)}">
    <label>Название<input data-field="title" maxlength="300" required value="${esc(asset.title)}"></label>
    <label>Тип<select data-field="kind">${options(kinds, asset.kind)}</select></label>
    <label>Заметка<input data-field="note" maxlength="1000" value="${esc(asset.note)}"></label>
    <button class="plain-button" type="button" data-remove>Удалить</button></div>`;

  function dayRow(item, data) {
    const fields = data.brief.fields, vocabulary = data.vocabulary;
    const platforms = vocabulary.platforms.filter((platform) => fields.platforms.includes(platform.id));
    const assets = [{id: '', label: 'Без исходника'}, ...fields.assets.map((asset) => ({id: asset.id, label: asset.title}))];
    return `<div class="mentor-row mentor-day" data-row>
      <label>Дата<input data-field="date" type="date" required value="${esc(item.date)}"></label>
      <label>Площадка<select data-field="platform">${options(platforms, item.platform)}</select></label>
      <label>Формат<select data-field="format">${options(vocabulary.formats, item.format)}</select></label>
      <label>Роль<select data-field="role">${options(vocabulary.roles, item.role)}</select></label>
      <label class="wide">Тема<input data-field="topic" maxlength="300" required value="${esc(item.topic)}"></label>
      <label class="wide">Зацепка<input data-field="hook" maxlength="500" value="${esc(item.hook)}"></label>
      <label>Исходник<select data-field="assetId">${options(assets, item.assetId)}</select></label>
      <label class="wide">Заметка наставника<textarea data-field="mentorNote" rows="2" maxlength="2000">${esc(item.mentorNote)}</textarea></label>
      <button class="plain-button" type="button" data-remove>Убрать день</button></div>`;
  }

  function planMarkup(data, edit) {
    const plan = data.plan, vocabulary = data.vocabulary;
    const label = (list, id) => esc(list.find((item) => item.id === id)?.label || id);
    const view = plan ? `<p class="mentor-note">Версия ${esc(plan.revision)} по брифу ${esc(plan.briefRevision)} ·
        ${esc(day(plan.startDate))} — ${esc(day(plan.endDate))} · ${esc(plan.windowDays)} дней · обновлён ${esc(moment(plan.updatedAt))}</p>
      <ol class="mentor-plan-list">${plan.days.map((item) => `<li><strong>${esc(day(item.date))}</strong> ·
        ${label(vocabulary.platforms, item.platform)} · ${label(vocabulary.formats, item.format)} ·
        ${label(vocabulary.roles, item.role)}<br>${esc(item.topic)}${item.hook ? `<br><span class="mentor-note">${esc(item.hook)}</span>` : ''}${item.mentorNote ? `<br><span class="mentor-note">${esc(item.mentorNote)}</span>` : ''}</li>`).join('')}</ol>`
      : '<p class="mentor-note">План ещё не составлен.</p>';
    if (!edit) return view;
    if (!data.brief.revision) {
      return `${view}<p class="mentor-note">Сначала сохраните бриф компании — план составляется по нему.</p>`;
    }
    if (!data.brief.fields.platforms.length) {
      return `${view}<p class="mentor-note">Выберите площадки в брифе: без них план составить нельзя.</p>`;
    }
    return `${view}<form id="mentor-plan-form" class="crm-form mentor-form">
      <input type="hidden" name="planRevision" value="${esc(plan ? plan.revision : 0)}">
      <input type="hidden" name="briefRevision" value="${esc(data.brief.revision)}">
      <p class="mentor-note">План охватывает от ${esc(vocabulary.minDays)} до ${esc(vocabulary.maxDays)} дней подряд,
        не больше трёх материалов на дату. Дни идут по возрастанию даты.</p>
      <div class="mentor-rows wide" data-rows="days"><div data-rows-body>${(plan ? plan.days : []).map((item) => dayRow(item, data)).join('')}</div>
        <button class="plain-button" type="button" data-add="days">Добавить день</button></div>
      <div class="crm-actions wide"><button class="plain-button" type="submit">Сохранить план</button>
        <span id="mentor-plan-state" role="status"></span></div></form>`;
  }

  function approvalMarkup(data, ctx) {
    const approval = data.approval, plan = data.plan;
    const decided = approval.decidedAt
      ? `<p class="mentor-note">Последнее решение: ${esc(approval.decision === 'approved' ? 'согласовано' : 'отклонено')} ·
         версия плана ${esc(approval.planRevision)} · ${esc(approval.actorName || '—')} · ${esc(moment(approval.decidedAt))}${approval.comment ? `<br>${esc(approval.comment)}` : ''}</p>`
      : '<p class="mentor-note">Решений по этой версии ещё нет.</p>';
    // Решать можно только по плану, составленному по текущей версии брифа.
    const canAct = canDecide(ctx) && !!plan && plan.briefRevision === data.brief.revision;
    return `<section class="card mentor-approval" data-status="${esc(approval.status)}">
      <h2>Согласование версии плана</h2>
      <p><strong>${esc(STATUS[approval.status] || approval.status)}</strong>${approval.reason ? ` · ${esc(approval.reason)}` : ''}</p>
      <p class="mentor-note">Согласование относится к конкретной версии плана и означает решение по тексту.
        Это не разрешение публиковать: ничего не отправляется и очередь публикаций не создаётся.</p>
      ${decided}
      ${canAct ? `<form id="mentor-decision-form" class="crm-form">
        <input type="hidden" name="planRevision" value="${esc(plan.revision)}">
        <input type="hidden" name="briefRevision" value="${esc(data.brief.revision)}">
        <label class="wide">Комментарий (обязателен при отклонении)<textarea name="comment" rows="2" maxlength="2000"></textarea></label>
        <div class="crm-actions wide"><button class="plain-button" type="submit" value="approved" name="decision">Согласовать версию</button>
          <button class="plain-button" type="submit" value="rejected" name="decision">Отклонить</button>
          <span id="mentor-decision-state" role="status"></span></div></form>`
    : `<p class="mentor-note">${canDecide(ctx) ? 'Сначала обновите план под свежий бриф.' : 'Решение принимает владелец кабинета.'}</p>`}
      ${data.approvals.length ? `<details><summary>История решений (${esc(data.approvals.length)})</summary>
        <ol class="mentor-history">${data.approvals.map((item) => `<li>${esc(moment(item.decidedAt))} · версия ${esc(item.planRevision)} ·
          ${esc(item.decision === 'approved' ? 'согласовано' : 'отклонено')} · ${esc(item.actorName || '—')}${item.comment ? `<br>${esc(item.comment)}` : ''}</li>`).join('')}</ol></details>` : ''}
    </section>`;
  }

  // Перенос согласованной версии плана в черновики автопостинга. Кнопка ничего не публикует
  // и ничего не ставит в очередь: об этом сказано рядом с ней, а не мелким шрифтом.
  function transferMarkup(data, ctx) {
    const state = data.transfer;
    if (!state) return '';
    const edit = canEdit(ctx);
    // Задание и исходник показываются прямо у черновика: искать их вручную не нужно.
    const done = state.current ? `<p>Перенесено ${esc(moment(state.current.transferredAt))} ·
        ${esc(state.current.postIds.length)} черновиков · ${esc(state.current.actorName || '—')} ·
        план v${esc(state.current.planRevision)}, бриф v${esc(state.current.briefRevision)}</p>
      <ul class="mentor-drafts">${state.current.items.map((item) => `<li>
        <details><summary>${esc(day(item.planDate))} · ${esc(item.planPlatform)} · черновик №${esc(item.postId)}</summary>
        <p><strong>${esc(item.topic)}</strong></p>
        <p class="mentor-note">Формат: ${esc(item.format || '—')} · роль: ${esc(item.role || '—')}${item.hook ? ` · зацепка: ${esc(item.hook)}` : ''}</p>
        ${item.mentorNote ? `<p class="mentor-note">Заметка наставника: ${esc(item.mentorNote)}</p>` : ''}
        ${item.asset ? `<p class="mentor-asset"><span>Исходник из брифа (описание словами):</span> ${esc(item.asset.title)} · ${esc(item.asset.kind)}${item.asset.note ? `<br>${esc(item.asset.note)}` : ''}
          <br><span class="mentor-note">Это описание, а не загруженный файл: материал нужно добавить отдельно.</span></p>`
    : '<p class="mentor-note">Исходник в плане не указан.</p>'}
        <p class="mentor-material" data-has-media="${item.hasMedia ? 'yes' : 'no'}">
          <span>Материал:</span> ${item.hasMedia ? `добавлен · файлов ${esc(item.mediaCount)}` : 'не добавлен'}</p>
        ${edit ? `<label class="mentor-upload">Добавить свой материал (фото JPEG, PNG, WebP или видео MP4, WebM)
          <input type="file" data-material-file="${esc(item.postId)}"
            accept="image/jpeg,image/png,image/webp,video/mp4,video/webm"></label>
          <button class="plain-button" type="button" data-material-add="${esc(item.postId)}"
            data-post-revision="${esc(item.postRevision)}">Загрузить и приложить к карточке</button>
          <span data-material-state="${esc(item.postId)}" role="status"></span>` : ''}
        <button class="plain-button" type="button" data-brief-context="${esc(item.postId)}">Показать бриф этой версии</button>
        <div data-brief-context-body="${esc(item.postId)}"></div></details></li>`).join('')}</ul>` : '';
    return `<section class="card mentor-transfer" data-can="${state.canTransfer ? 'yes' : 'no'}">
      <h2>Перенос в черновики автопостинга</h2>
      <p class="mentor-note">${esc(state.notice)}</p>
      <p class="mentor-note">Остаются незаполненными: ${state.leavesUnfilled.map((item) => esc(item)).join(' · ')}.</p>
      <p class="mentor-note">${esc(state.repeatProtection)}: повтор по той же версии вернёт те же черновики.</p>
      ${state.current ? `<p class="mentor-note">${esc(state.materialNotice)} Без файла ждут заданий: ${esc(state.awaitingMaterial)}.</p>` : ''}
      ${state.newVersionNotice ? `<p class="mentor-warning" role="note">${esc(state.newVersionNotice)}</p>` : ''}
      ${done}
      ${edit && state.canTransfer ? `<form id="mentor-transfer-form" class="crm-form">
        <input type="hidden" name="planRevision" value="${esc(state.planRevision)}">
        <input type="hidden" name="briefRevision" value="${esc(state.briefRevision)}">
        <div class="crm-actions wide"><button class="plain-button" type="submit">Перенести план в черновики</button>
          <span id="mentor-transfer-state" role="status"></span></div></form>`
    : `<p class="mentor-note">${esc(edit ? state.blockedReason : 'Переносит план тот, у кого есть право правки автопостинга.')}</p>`}
      ${state.history.length ? `<details><summary>Прошлые переносы (${esc(state.history.length)})</summary>
        <ol class="mentor-history">${state.history.map((item) => `<li>Версия плана ${esc(item.planRevision)} ·
          ${esc(item.dayCount)} дней · ${esc(moment(item.transferredAt))} · ${esc(item.actorName || '—')}</li>`).join('')}</ol></details>` : ''}
    </section>`;
  }

  function markup(data, ctx) {
    const edit = canEdit(ctx);
    return `<p class="card mentor-notice" role="note">${esc(data.notice)}</p>
      <section class="card mentor-brief"><h2>Бриф компании</h2>
        <p class="mentor-note">Версия ${esc(data.brief.revision)}${data.brief.updatedAt ? ` · обновлён ${esc(moment(data.brief.updatedAt))}` : ''}.
          ${edit ? 'Тексты вводите сами: подсказок модели здесь нет.' : 'У вас только просмотр.'}</p>
        ${briefMarkup(data, edit)}
        ${data.brief.history.length ? `<details><summary>История брифа (${esc(data.brief.history.length)})</summary>
          <ol class="mentor-history">${data.brief.history.map((item) => `<li>Версия ${esc(item.revision)} · ${esc(moment(item.createdAt))} ·
            ${esc(item.actorName || '—')}${item.reason ? `<br>${esc(item.reason)}` : ''}</li>`).join('')}</ol></details>` : ''}</section>
      <section class="card mentor-plan"><h2>Контент-план</h2>
        ${planMarkup(data, edit)}
        ${data.plan && data.plan.history.length ? `<details><summary>История плана (${esc(data.plan.history.length)})</summary>
          <ol class="mentor-history">${data.plan.history.map((item) => `<li>Версия ${esc(item.revision)} по брифу ${esc(item.briefRevision)} ·
            ${esc(moment(item.createdAt))} · ${esc(item.actorName || '—')}</li>`).join('')}</ol></details>` : ''}</section>
      ${approvalMarkup(data, ctx)}${transferMarkup(data, ctx)}`;
  }

  const rowValues = (row) => Object.fromEntries([...row.querySelectorAll('[data-field]')]
    .map((field) => [field.dataset.field, field.value.trim()]));
  // Полностью пустую строку, которую добавили и бросили, убираем до проверки полей:
  // иначе обязательное поле пустой строки не даст сохранить весь бриф.
  const pruneEmptyRows = (form) => form.querySelectorAll('[data-rows="facts"] [data-row],[data-rows="assets"] [data-row]')
    .forEach((row) => {
      const values = rowValues(row);
      if (Object.entries(values).every(([key, value]) => key === 'id' || key === 'kind' || !value)) row.remove();
    });

  function collectBrief(form) {
    const facts = [...form.querySelectorAll('[data-rows="facts"] [data-row]')].map(rowValues)
      .filter((row) => row.statement || row.source)
      .map((row) => ({id: row.id || newId(), statement: row.statement, source: row.source}));
    const assets = [...form.querySelectorAll('[data-rows="assets"] [data-row]')].map(rowValues)
      .filter((row) => row.title)
      .map((row) => ({id: row.id || newId(), title: row.title, kind: row.kind, note: row.note}));
    return {goal: form.elements.goal.value.trim(), product: form.elements.product.value.trim(),
      audience: form.elements.audience.value.trim(),
      pains: form.elements.pains.value.split('\n').map((line) => line.trim()).filter(Boolean),
      confirmedFacts: facts, assets,
      shootingComfort: {level: form.elements.comfortLevel.value, notes: form.elements.comfortNotes.value.trim()},
      platforms: [...form.querySelectorAll('input[name="platform"]:checked')].map((box) => box.value)};
  }
  const collectDays = (form) => [...form.querySelectorAll('[data-rows="days"] [data-row]')].map(rowValues)
    .map((row) => ({date: row.date, platform: row.platform, format: row.format, role: row.role,
      topic: row.topic, hook: row.hook, assetId: row.assetId, mentorNote: row.mentorNote}));

  function bind(container, node, ctx, data) {
    const code = ctx.selectedProjectId;
    const busy = (form, state) => form.querySelectorAll('button,input,select,textarea')
      .forEach((element) => { element.disabled = state; });
    node.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => {
      const kind = button.dataset.add, body = button.closest('[data-rows]').querySelector('[data-rows-body]');
      const markupFor = kind === 'facts' ? factRow()
        : kind === 'assets' ? assetRow(undefined, data.vocabulary.assetKinds)
          : dayRow({date: '', platform: data.brief.fields.platforms[0] || '', format: 'post', role: 'reach',
            topic: '', hook: '', assetId: '', mentorNote: ''}, data);
      body.insertAdjacentHTML('beforeend', markupFor);
      body.lastElementChild.querySelector('[data-remove]')
        .addEventListener('click', (event) => event.target.closest('[data-row]').remove());
    }));
    node.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click',
      (event) => event.target.closest('[data-row]').remove()));

    const submit = async (form, stateId, path, method, body) => {
      const state = node.querySelector(stateId);
      busy(form, true);
      state.textContent = 'Сохраняем…';
      try {
        await ctx.crmQuery(path, {companyCode: code}, ctx.csrfOptions(method, body));
        if (ctx.selectedProjectId !== code) return;
        await load(container, ctx);
      } catch (error) {
        if (ctx.selectedProjectId !== code) return;
        busy(form, false);
        state.textContent = error.message;
      }
    };
    node.querySelector('#mentor-brief-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      pruneEmptyRows(form);
      if (!form.reportValidity()) return;
      void submit(form, '#mentor-brief-state', `${PATH}/brief`, 'PUT',
        {revision: Number(form.elements.revision.value), brief: collectBrief(form)});
    });
    node.querySelector('#mentor-plan-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      if (!form.reportValidity()) return;
      void submit(form, '#mentor-plan-state', `${PATH}/plan`, 'PUT',
        {planRevision: Number(form.elements.planRevision.value),
          briefRevision: Number(form.elements.briefRevision.value), days: collectDays(form)});
    });
    /* Материал принимается существующим приёмом файлов автопостинга и прикладывается
       к той же карточке. Второго склада нет: загрузка идёт в /content/publishing-assets
       своей компании, а ссылка дописывается в mediaUrls карточки существующим маршрутом. */
    node.querySelectorAll('[data-material-add]').forEach((button) => button.addEventListener('click', async () => {
      const postId = button.dataset.materialAdd;
      const input = node.querySelector(`[data-material-file="${postId}"]`);
      const state = node.querySelector(`[data-material-state="${postId}"]`);
      const item = (data.transfer?.current?.items || []).find((row) => String(row.postId) === String(postId));
      const file = input?.files?.[0];
      if (!file) { state.textContent = 'Выберите файл материала.'; return; }
      button.disabled = true;
      state.textContent = 'Загружаем материал…';
      try {
        const uploaded = await ctx.apiJson(
          `${data.transfer.materialUploadPath}?companyCode=${encodeURIComponent(code)}`,
          {method: 'POST', body: file,
            headers: {'Content-Type': file.type, 'X-CSRF-Token': ctx.identity.csrfToken}});
        if (ctx.selectedProjectId !== code) return;
        await ctx.crmQuery(`/autoposting/posts/${encodeURIComponent(postId)}`, {companyCode: code},
          ctx.csrfOptions('PATCH', {revision: Number(button.dataset.postRevision),
            mediaUrls: [...(item ? item.mediaUrls : []), uploaded.url]}));
        if (ctx.selectedProjectId !== code) return;
        await load(container, ctx);
      } catch (error) {
        if (ctx.selectedProjectId !== code) return;
        button.disabled = false;
        state.textContent = error.message;
      }
    }));
    // Бриф согласованной версии подгружается по требованию из неизменяемой версии.
    node.querySelectorAll('[data-brief-context]').forEach((button) => button.addEventListener('click', async () => {
      const postId = button.dataset.briefContext;
      const body = node.querySelector(`[data-brief-context-body="${postId}"]`);
      button.disabled = true;
      body.textContent = 'Загружаем бриф версии…';
      try {
        const info = await ctx.crmQuery(`${PATH}/plan/transfer/${encodeURIComponent(postId)}`, {companyCode: code});
        if (ctx.selectedProjectId !== code || !body.isConnected) return;
        const brief = info.brief;
        body.innerHTML = `<p class="mentor-note">${esc(info.notice)}</p>
          <dl class="mentor-brief-view">
            <div><dt>Цель</dt><dd>${esc(brief.goal) || '—'}</dd></div>
            <div><dt>Продукт</dt><dd>${esc(brief.product) || '—'}</dd></div>
            <div><dt>Аудитория</dt><dd>${esc(brief.audience) || '—'}</dd></div>
            <div><dt>Боли клиента</dt><dd>${brief.pains.length ? `<ul class="mentor-list">${brief.pains.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : '—'}</dd></div>
            <div><dt>Подтверждённые факты</dt><dd>${brief.confirmedFacts.length ? `<ul class="mentor-list">${brief.confirmedFacts.map((item) => `<li>${esc(item.statement)}<br><span class="mentor-note">Источник: ${esc(item.source)}</span></li>`).join('')}</ul>` : '—'}</dd></div>
            <div><dt>Комфорт съёмки</dt><dd>${esc(brief.shootingComfort.level)}${brief.shootingComfort.notes ? `<br><span class="mentor-note">${esc(brief.shootingComfort.notes)}</span>` : ''}</dd></div>
          </dl>`;
      } catch (error) {
        if (ctx.selectedProjectId !== code || !body.isConnected) return;
        button.disabled = false;
        body.textContent = error.message;
      }
    }));
    node.querySelector('#mentor-transfer-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      void submit(form, '#mentor-transfer-state', `${PATH}/plan/transfer`, 'POST',
        {planRevision: Number(form.elements.planRevision.value),
          briefRevision: Number(form.elements.briefRevision.value)});
    });
    const decision = node.querySelector('#mentor-decision-form');
    if (decision) {
      decision.addEventListener('submit', (event) => {
        event.preventDefault();
        const form = event.currentTarget, choice = event.submitter?.value || 'approved';
        const comment = form.elements.comment.value.trim();
        if (choice === 'rejected' && !comment) {
          node.querySelector('#mentor-decision-state').textContent = 'Укажите, что исправить в плане.';
          return;
        }
        void submit(form, '#mentor-decision-state', `${PATH}/plan/decision`, 'POST',
          {planRevision: Number(form.elements.planRevision.value),
            briefRevision: Number(form.elements.briefRevision.value), decision: choice, comment});
      });
    }
  }

  async function load(container, ctx) {
    const id = ++epoch, code = ctx.selectedProjectId;
    const node = container.querySelector('#mentor-content');
    if (!node) return;
    try {
      const data = await ctx.crmQuery(PATH, {companyCode: code});
      // Ответ прежней компании не рисуется: бриф и план не смешиваются между компаниями.
      if (id !== epoch || ctx.selectedProjectId !== code || !node.isConnected) return;
      if (data.companyCode !== String(code).toLowerCase()) throw new Error('Ответ другой компании');
      node.innerHTML = markup(data, ctx);
      bind(container, node, ctx, data);
    } catch (error) {
      if (id === epoch && node.isConnected) {
        node.innerHTML = `<p class="crm-error" role="alert">Не удалось загрузить бриф и план: ${esc(error.message)}</p>`;
      }
    }
  }

  function render(container, ctx) {
    if (!canRead(ctx)) {
      container.innerHTML = '<div class="content-header"><h1>Бриф и план</h1></div>' +
        '<div class="card"><p>Раздел доступен по праву «Автопостинг: просмотр». Обратитесь к владельцу кабинета.</p></div>';
      return;
    }
    container.innerHTML = `<div class="content-header"><h1>Бриф и план</h1>
      <p>Бриф компании и контент-план на 7–14 дней. Тексты вводит человек, подсказок модели здесь нет.
        Согласование версии плана — решение по тексту, а не разрешение публиковать.</p></div>
      <div id="mentor-content" aria-live="polite"><p>Загружаем бриф и план…</p></div>`;
    void load(container, ctx);
  }

  sb.mediaMentor = {render, load};
  sb.registerView('media-mentor', {title: 'Бриф и план', render, onProjectChange: render});
})();
