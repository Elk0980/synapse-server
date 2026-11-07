'use strict';
/* Настройки → Контент (№98). Экран регистрируется в реестре модулей как «settings-content»;
   данные и права — GET/PUT /content/content-settings (ops/content/content-settings.js). */
(() => {
  const WEEKDAYS = [[1, 'Пн'], [2, 'Вт'], [3, 'Ср'], [4, 'Чт'], [5, 'Пт'], [6, 'Сб'], [7, 'Вс']];
  const PLATFORM_NAMES = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', vk: 'ВКонтакте', telegram: 'Telegram', max: 'MAX', dzen: 'Дзен' };
  const SIZE_NAMES = { s: 'Мелкий', m: 'Средний', l: 'Крупный' };
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (value === false || value === undefined || value === null) return;
      if (key === 'text') node.textContent = value;
      else if (key === 'className') node.className = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    });
    node.append(...children.filter(Boolean));
    return node;
  };
  /* №208: Настройки → Контент-план → «Уведомления» — кому о каком этапе сообщать. Только выбор; отправка по матрице
     пока не делается. Ключ settings.notificationMatrix (ops/content/content-settings.js); у старого сервера его нет. */
  const STAGES = [['script_review', 'Сценарий на согласовании'], ['script_rework', 'Сценарий на доработке'], ['planned', 'Сценарий согласован → Запланировано'],
    ['shot', 'Отснято'], ['edit_review', 'Монтаж на согласовании'], ['edit_rework', 'Монтаж на доработке'], ['ready', 'Готово к выходу'],
    ['published', 'Опубликовано'], ['publish_error', 'Ошибка публикации']];
  const ROLES = [['owner', 'Владелец', 'Влад.'], ['approver', 'Согласующий', 'Согл.'], ['content', 'Контент (СММ)', 'Конт.'], ['shooting', 'Съёмка', 'Съёмка'], ['editor', 'Монтажёр', 'Монт.']];
  const ALL = ROLES.map(([id]) => id);
  const MATRIX_DEFAULTS = { script_review: ['owner', 'approver'], script_rework: ['content'], planned: ['content', 'shooting'], shot: ['content', 'editor'],
    edit_review: ['approver', 'content'], edit_rework: ['editor'], ready: ['content'], published: ALL, publish_error: ['owner', 'content'] };
  const OLD_SERVER = 'Сохранение заработает после обновления сервера. Отметки пока не сохранены; остальные настройки работают.';
  const cloneMatrix = (m) => Object.fromEntries(STAGES.map(([stage]) => [stage, Array.isArray(m?.[stage]) ? ALL.filter((r) => m[stage].includes(r)) : [...MATRIX_DEFAULTS[stage]]]));
  const tabKey = 'sb.settings-content.tab';
  const TABS = [['platforms', 'Площадки'], ['people', 'Участники'], ['notifications', 'Уведомления']];
  // Прежнее значение 'main' (вкладка «Площадки и стиль») открывает «Площадки».
  const pickTab = (value) => value === 'main' ? 'platforms' : TABS.some(([id]) => id === value) ? value : '';
  const readTab = () => { try { return window.localStorage.getItem(tabKey) || ''; } catch { return ''; } };
  const writeTab = (tab) => { try { window.localStorage.setItem(tabKey, tab); } catch { /* память вкладки не обязательна */ } };

  function notifications(ctx, state) {
    const data = state.data, canEdit = data.canEdit;
    state.supported = Boolean(data.settings && typeof data.settings.notificationMatrix === 'object' && data.settings.notificationMatrix);
    if (!state.matrix || state.matrixVersion !== data.version) { state.matrix = cloneMatrix(data.settings.notificationMatrix); state.matrixVersion = data.version; }
    const status = el('p', { className: 'cs-status', role: 'status', 'aria-live': 'polite', 'data-csn-status': true,
      text: state.notifyMessage || (canEdit ? '' : 'Только просмотр: менять может владелец или настройщик компании.') });
    const head = el('tr', {}, el('th', { scope: 'col', text: 'Этап' }), ...ROLES.map(([, label, short]) =>
      el('th', { scope: 'col' }, el('span', { className: 'csn-long', text: label }), el('span', { className: 'csn-short', 'aria-hidden': 'true', text: short }))));
    const body = el('tbody');
    STAGES.forEach(([stage, label]) => body.append(el('tr', {}, el('th', { scope: 'row', text: label }), ...ROLES.map(([role, roleLabel]) => el('td', {},
      el('input', { type: 'checkbox', 'data-stage': stage, 'data-role': role, 'aria-label': `${label} — ${roleLabel}`,
        checked: state.matrix[stage].includes(role), disabled: !canEdit }))))));
    const table = el('table', { className: 'csn-matrix', 'data-csn-matrix': true }, el('thead', {}, head), body);
    const box = el('section', { className: 'card cs-block csn-notify', 'data-csn-notify': true },
      el('h2', { className: 'csn-notify-title', text: 'Контент-план · уведомления' }),
      el('p', { className: 'muted csn-lead' }, el('span', { text: 'Отметьте, кому сообщать о каждом этапе. Кто в какой роли — во вкладке ' }),
        el('a', { href: '#settings/content/people', 'data-csn-goto': 'people', text: '«Участники»' }), el('span', { text: '.' }),
        el('span', { className: 'csn-lead-save', text: canEdit ? ' Сохраняется сразу.' : '' })),
      el('div', { className: 'csn-matrix-wrap' }, table), status,
      el('p', { className: 'muted csn-foot', text: 'У каждой компании свои настройки. Куда приходит уведомление (Telegram-бот, пуш, чат Хью) — выбор каждого человека в его профиле. Отправка по этой таблице подключается отдельно.' }));

    const say = (text) => { state.notifyMessage = text; status.textContent = text; };
    async function flush() {
      if (state.saving) { state.pending = true; return; }
      if (state.blocked) { say(OLD_SERVER); return; }
      state.saving = true; state.pending = false;
      say('Сохраняю…');
      try {
        const saved = await ctx.settings.content.save({ ...state.data.settings, notificationMatrix: cloneMatrix(state.matrix) }, state.data.version);
        if (ctx.signal.aborted) return;
        state.data = saved; state.matrixVersion = saved.version;
        if (saved.settings?.notificationMatrix) state.supported = true;
        say(saved.settings?.notificationMatrix ? `Сохранено · версия ${saved.version}` : OLD_SERVER);
        if (!saved.settings?.notificationMatrix) state.blocked = true;
      } catch (error) {
        if (ctx.signal.aborted) return;
        if (error.status === 409) {
          say('Настройки уже изменил другой пользователь — показаны актуальные отметки, повторите выбор.');
          try { const fresh = await ctx.settings.content.get(); if (!ctx.signal.aborted) { state.data = fresh; state.matrix = null; state.redraw?.(); } } catch { /* остаётся сообщение */ }
        } else if (error.status === 400 && !state.supported) { state.blocked = true; say(OLD_SERVER); }
        else say(`Не сохранено: ${error.message}`);
      } finally {
        state.saving = false;
        if (state.pending && !state.blocked && !ctx.signal.aborted) void flush();
      }
    }
    table.addEventListener('change', (event) => {
      const input = event.target.closest('input[data-stage]');
      if (!input || !canEdit) return;
      const list = new Set(state.matrix[input.dataset.stage]);
      if (input.checked) list.add(input.dataset.role); else list.delete(input.dataset.role);
      state.matrix[input.dataset.stage] = ALL.filter((r) => list.has(r));
      void flush();
    });
    return box;
  }

  const check = (name, value, label, checked, disabled) => el('label', { className: 'cs-check' },
    el('input', { type: 'checkbox', name, value, checked, disabled }), el('span', { text: label }));

  function render(root, ctx, data, state) {
    state.data = data;
    const { settings, canEdit } = data;
    const disabled = !canEdit;
    const form = el('form', { className: 'cs-form', novalidate: true });
    const approvers = el('fieldset', { className: 'card cs-block', 'data-cs-approvers': true }, el('legend', { text: 'Кто согласует контент-план' }));
    if (data.candidates.length) {
      const list = el('div', { className: 'cs-grid' });
      data.candidates.forEach((person) => list.append(check('approver', person.id,
        person.role === 'owner' ? `${person.name} · владелец` : person.name, settings.approverUserIds.includes(person.id), disabled)));
      approvers.append(list, el('p', { className: 'muted', text: 'Отмеченные ставят галочку согласования; после неё план уходит СММ. Никто не отмечен — согласует владелец.' }));
    } else {
      approvers.append(el('p', { className: 'muted', text: 'В компании пока нет людей с правом «content-plan.approve». Право выдаёт владелец в «Настройка аккаунтов».' }));
    }
    const days = el('fieldset', { className: 'card cs-block' }, el('legend', { text: 'Дни недели съёмки' }));
    const dayList = el('div', { className: 'cs-days' });
    WEEKDAYS.forEach(([value, label]) => dayList.append(check('weekday', value, label, settings.shootingWeekdays.includes(value), disabled)));
    days.append(dayList);
    const deadline = el('fieldset', { className: 'card cs-block' }, el('legend', { text: 'Дедлайн съёмки' }),
      el('label', { className: 'cs-inline' }, el('input', { type: 'number', name: 'deadlineDays', min: 0, max: 60, step: 1,
        value: settings.deadlineDays, inputmode: 'numeric', disabled }), el('span', { text: 'дней до выхода рилса' })));
    const platforms = el('fieldset', { className: 'card cs-block' }, el('legend', { text: 'Площадки компании' }));
    const platformList = el('div', { className: 'cs-grid' });
    data.options.platforms.forEach((id) => platformList.append(check('platform', id, PLATFORM_NAMES[id] || id, settings.platforms.includes(id), disabled)));
    platforms.append(platformList);
    const caption = settings.caption;
    const font = el('select', { name: 'font', disabled });
    data.options.fonts.forEach((name) => font.append(el('option', { value: name, selected: name === caption.font, text: name })));
    const size = el('select', { name: 'size', disabled });
    data.options.sizes.forEach((name) => size.append(el('option', { value: name, selected: name === caption.size, text: SIZE_NAMES[name] || name })));
    const preview = el('p', { className: 'cs-preview', text: 'Так будут выглядеть титры' });
    const style = el('fieldset', { className: 'card cs-block' }, el('legend', { text: 'Стиль титров' }),
      el('div', { className: 'cs-grid' },
        el('label', { className: 'cs-field' }, el('span', { text: 'Шрифт' }), font),
        el('label', { className: 'cs-field' }, el('span', { text: 'Размер' }), size),
        el('label', { className: 'cs-field' }, el('span', { text: 'Цвет' }), el('input', { type: 'color', name: 'color', value: caption.color, disabled })),
        check('uppercase', '1', 'ЗАГЛАВНЫМИ', caption.uppercase, disabled)),
      preview);
    const status = el('p', { className: 'cs-status', role: 'status', 'aria-live': 'polite', text: state.message || '' });
    const actions = el('div', { className: 'cs-actions' },
      canEdit ? el('button', { type: 'submit', className: 'plain-button cs-save', text: 'Сохранить' }) : el('p', { className: 'muted', text: 'Только просмотр: менять может владелец или настройщик компании.' }),
      status);
    const sheet = el('fieldset', {className:'card cs-block'}, el('legend', {text:'Таблица контент-плана'}),
      el('label', {className:'cs-field'}, el('span', {text:'Ссылка Google Таблицы'}), el('input', {type:'url',name:'contentPlanSheetUrl',value:settings.contentPlanSheetUrl || '',maxlength:2048,disabled,placeholder:'https://docs.google.com/spreadsheets/d/…'})),
      !settings.contentPlanSheetUrl && canEdit ? el('p',{className:'muted',text:'Указать таблицу: вставьте ссылку и сохраните настройки.'}) : null);
    /* Макет 07.11: «Площадки» — площадки, таблица, дни и сроки съёмки, стиль титров; «Участники» — кто согласует и где роли.
       Одна форма и одно сохранение на обе вкладки (тот же PUT /content/content-settings). */
    const roles = el('section', { className: 'card cs-block cs-roles', 'data-cs-roles': true },
      el('h2', { className: 'cs-block-title', text: 'Роли в уведомлениях' }),
      el('p', { className: 'muted', text: `Роли: ${ROLES.map(([, label]) => label).join(', ')}. Права и роли людям выдаёт владелец в «Настройка аккаунтов»; отдельного списка людей по ролям сервер пока не отдаёт.` }),
      el('p', {}, el('a', { href: '#accounts', text: 'Открыть «Настройка аккаунтов»' })));
    const platformsPane = el('div', { className: 'cs-pane', 'data-cs-pane': 'platforms' }, platforms, sheet, days, deadline, style);
    const peoplePane = el('div', { className: 'cs-pane', 'data-cs-pane': 'people' }, approvers, roles);
    form.append(platformsPane, peoplePane, actions);
    const updatePreview = () => {
      preview.style.fontFamily = `"${form.elements.font.value}", system-ui, sans-serif`;
      preview.style.fontSize = { s: '18px', m: '24px', l: '32px' }[form.elements.size.value] || '24px';
      preview.style.color = form.elements.color.value;
      preview.style.textTransform = form.elements.uppercase.checked ? 'uppercase' : 'none';
    };
    form.addEventListener('input', updatePreview);
    updatePreview();
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!canEdit || state.busy) return;
      const values = (name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
      const deadlineDays = Number(form.elements.deadlineDays.value);
      if (!Number.isInteger(deadlineDays) || deadlineDays < 0 || deadlineDays > 60) { status.textContent = 'Дедлайн: целое число от 0 до 60.'; return; }
      const next = {
        approverUserIds: values('approver').map(Number), shootingWeekdays: values('weekday').map(Number), deadlineDays,
        platforms: values('platform'), contentPlanSheetUrl: form.elements.contentPlanSheetUrl.value.trim(),
        caption: { font: form.elements.font.value, size: form.elements.size.value, color: form.elements.color.value, uppercase: form.elements.uppercase.checked }
      };
      state.busy = true;
      status.textContent = 'Сохраняю…';
      try {
        const saved = await ctx.settings.content.save(next, state.data.version);
        if (ctx.signal.aborted) return;
        state.busy = false; state.message = `Сохранено · версия ${saved.version}`; state.notifyMessage = '';
        render(root, ctx, saved, state);
      } catch (error) {
        if (ctx.signal.aborted) return;
        state.busy = false;
        status.textContent = error.status === 409 ? 'Настройки уже изменил другой пользователь — обновите экран, ваши отметки не сохранены.' : `Не сохранено: ${error.message}`;
      }
    });
    const head = el('div', { className: 'content-header' }, el('h1', { text: 'Настройки → Контент-план' }),
      el('p', { className: 'muted', text: `Компания: ${ctx.companyName}. Эти значения используют контент-план, съёмка и постинг.` }));
    const meta = data.updatedAt ? el('p', { className: 'muted cs-meta', text: `Изменено: ${new Date(data.updatedAt).toLocaleString('ru-RU', { timeZone: 'Asia/Bangkok' })} (Бангкок) · ${data.updatedBy}` }) : null;
    const more = el('p', { className: 'muted cs-more' }, el('span', { text: 'Ещё: ' }),
      el('a', { href: '#content-factory/settings', text: 'вводные для плана' }), el('span', { text: ' · ' }),
      el('a', { href: '#content-factory/sources', text: 'исходники' }));
    // Вкладки как в макете: «Площадки · Участники · Уведомления»; адрес #settings/content/<вкладка> открывает её сразу.
    const tab = state.tab || pickTab(ctx.route?.path) || pickTab(readTab()) || 'platforms';
    state.tab = tab;
    const tabs = el('div', { className: 'csn-tabs', role: 'tablist', 'aria-label': 'Разделы настроек контента' },
      ...TABS.map(([id, label]) => el('button', { type: 'button', role: 'tab', className: 'csn-tab',
        'data-csn-tab': id, 'aria-selected': String(id === tab), text: label })));
    const notify = notifications(ctx, state);
    const show = (id) => {
      state.tab = id;
      tabs.querySelectorAll('[data-csn-tab]').forEach((node) => node.setAttribute('aria-selected', String(node.dataset.csnTab === id)));
      form.hidden = id === 'notifications'; more.hidden = id !== 'platforms'; notify.hidden = id !== 'notifications';
      form.querySelectorAll('[data-cs-pane]').forEach((pane) => { pane.hidden = pane.dataset.csPane !== id; });
    };
    show(tab);
    tabs.addEventListener('click', (event) => {
      const button = event.target.closest('[data-csn-tab]');
      if (!button) return;
      writeTab(button.dataset.csnTab); show(button.dataset.csnTab);
    });
    notify.addEventListener('click', (event) => {
      const link = event.target.closest('[data-csn-goto]');
      if (!link) return;
      event.preventDefault(); writeTab(link.dataset.csnGoto); show(link.dataset.csnGoto);
    });
    state.redraw = () => render(root, ctx, state.data, state);
    root.replaceChildren(head, ...(meta ? [meta] : []), tabs, form, notify, more);
  }

  window.SynapseModules?.register('settings-content', {
    title: 'Настройки контента',
    async mount(root, ctx) {
      root.replaceChildren(el('p', { className: 'muted', role: 'status', text: 'Загружаю настройки контента…' }));
      try {
        const data = await ctx.settings.content.get();
        if (!ctx.signal.aborted) render(root, ctx, data, {});
      } catch (error) {
        if (ctx.signal.aborted) return;
        const retry = el('button', { type: 'button', className: 'plain-button', text: 'Повторить' });
        retry.addEventListener('click', () => this.mount(root, ctx));
        root.replaceChildren(el('section', { className: 'card cs-block' }, el('p', { text: `Настройки не загрузились: ${error.message}` }), retry));
      }
    }
  });
})();
