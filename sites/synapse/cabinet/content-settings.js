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
  const check = (name, value, label, checked, disabled) => el('label', { className: 'cs-check' },
    el('input', { type: 'checkbox', name, value, checked, disabled }), el('span', { text: label }));

  function render(root, ctx, data, state) {
    const { settings, canEdit } = data;
    const disabled = !canEdit;
    const form = el('form', { className: 'cs-form', novalidate: true });
    const approvers = el('fieldset', { className: 'card cs-block' }, el('legend', { text: 'Кто согласует контент-план' }));
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
    const platforms = el('fieldset', { className: 'card cs-block' }, el('legend', { text: 'Площадки' }));
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
    form.append(sheet, approvers, days, deadline, platforms, style, actions);
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
        const saved = await ctx.settings.content.save(next, data.version);
        if (ctx.signal.aborted) return;
        render(root, ctx, saved, { message: `Сохранено · версия ${saved.version}` });
      } catch (error) {
        if (ctx.signal.aborted) return;
        state.busy = false;
        status.textContent = error.status === 409 ? 'Настройки уже изменил другой пользователь — обновите экран, ваши отметки не сохранены.' : `Не сохранено: ${error.message}`;
      }
    });
    const head = el('div', { className: 'content-header' }, el('h1', { text: 'Настройки контента' }),
      el('p', { className: 'muted', text: `Компания: ${ctx.companyName}. Эти значения используют контент-план, съёмка и постинг.` }));
    const meta = data.updatedAt ? el('p', { className: 'muted cs-meta', text: `Изменено: ${new Date(data.updatedAt).toLocaleString('ru-RU', { timeZone: 'Asia/Bangkok' })} (Бангкок) · ${data.updatedBy}` }) : null;
    const more = el('p', { className: 'muted cs-more' }, el('span', { text: 'Ещё: ' }),
      el('a', { href: '#content-factory/settings', text: 'вводные для плана' }), el('span', { text: ' · ' }),
      el('a', { href: '#content-factory/sources', text: 'исходники' }));
    root.replaceChildren(head, ...(meta ? [meta] : []), form, more);
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
