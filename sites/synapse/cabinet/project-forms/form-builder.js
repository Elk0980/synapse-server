/* Локальная доска: поля формы и их настройки. Значения посетителя живут только в переданном объекте values. */
'use strict';

(() => {
  const TYPES = [
    ['text', 'Короткий текст'], ['textarea', 'Длинный текст'], ['tel', 'Телефон'],
    ['email', 'Электронная почта'], ['number', 'Число'], ['select', 'Список'], ['checkbox', 'Флажок'],
  ];
  const TYPE_IDS = new Set(TYPES.map(([id]) => id));
  const PARTS = [['name', 'Показывать имя'], ['channel', 'Показывать канал связи'], ['contact', 'Показывать контакт'], ['hint', 'Показывать пояснение']];
  const PART_IDS = new Set(PARTS.map(([id]) => id));
  const hiddenPartsOf = (block) => {
    const hidden = new Set((Array.isArray(block.hiddenParts) ? block.hiddenParts : []).filter((part) => PART_IDS.has(part)));
    if (block.phoneOnly === true) { hidden.add('channel'); hidden.add('hint'); }
    return hidden;
  };
  const partVisible = (block, part) => !hiddenPartsOf(block).has(part);
  const partOrderOf = (block) => [...new Set([...(Array.isArray(block.partOrder) ? block.partOrder.filter((part) => PART_IDS.has(part)) : []), ...PART_IDS])];
  const MAX_FIELDS = 30;
  const MAX_OPTIONS = 50;
  const text = (value) => value === null || value === undefined ? '' : String(value);
  const typeOf = (field) => TYPE_IDS.has(field && field.type) ? field.type : 'text';
  const fieldsOf = (block) => (Array.isArray(block.fields) ? block.fields : []).slice(0, MAX_FIELDS).filter((f) => f && typeof f === 'object' && !Array.isArray(f));
  const optionsOf = (field) => (Array.isArray(field.options) ? field.options : [])
    .slice(0, MAX_OPTIONS).map((option) => text(option && typeof option === 'object' ? option.label ?? option.value : option).trim()).filter(Boolean);
  const fieldKey = (field, index) => text(field.id) || `field-${index + 1}`;
  const readValue = (values, key) => values && Object.hasOwn(values, key) ? values[key] : '';
  const writeValue = (values, key, value) => {
    // В том числе безопасно для случайного id «__proto__» из импортированного проекта.
    Object.defineProperty(values, key, { value, enumerable: true, configurable: true, writable: true });
  };

  function enabledChannels(block, channels) {
    const available = (Array.isArray(channels) ? channels : []).filter((channel) => channel && typeof channel.id === 'string');
    if (block.type === 'helpform' && !partVisible(block, 'channel')) return available.filter((channel) => channel.id === 'call');
    if (!Array.isArray(block.channels)) return available;
    const selected = new Set(block.channels);
    const result = available.filter((channel) => selected.has(channel.id));
    // Даже после некорректного ручного импорта форма не остаётся без способа связи.
    return result.length ? result : available.slice(0, 1);
  }

  function uniqueId(ctx, used, prefix = 'field') {
    let id;
    do { id = text(ctx.nextId(prefix)); } while (!id || used.has(id));
    return id;
  }

  function inspector(ctx) {
    const { block, h, textField, selectField, edited, refresh } = ctx;
    if (!block || !['helpform', 'form', 'input'].includes(block.type)) return null;
    const box = h('section', { class: 'fb-settings', dataset: { formBuilder: block.type } },
      h('h3', { class: 'ins-sub', text: block.type === 'input' ? 'Настройки поля' : 'Настройки формы' }));
    const save = () => edited();
    const structureChanged = () => { save(); refresh(); };
    const checkField = (label, checked, onChange, detail) => {
      const id = ctx.nextId('fb-setting');
      return h('div', { class: 'fb-check-setting' },
        h('label', { class: 'fb-check-setting__label', for: id },
          h('input', { id, type: 'checkbox', checked, onchange: (event) => onChange(event.target.checked) }),
          h('span', { text: label })), detail ? h('p', { class: 'hint', text: detail }) : null);
    };
    const optionEditor = (owner, label = 'Варианты списка — по одному в строке') => textField(label, optionsOf(owner).join('\n'), (value) => {
      owner.options = value.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, MAX_OPTIONS);
      save();
    }, { area: true, rows: 4 });

    if (block.type === 'input') {
      box.append(selectField('Вид поля', TYPE_IDS.has(block.inputType) ? block.inputType : 'text', TYPES, (value) => {
        block.inputType = value; structureChanged();
      }), checkField('Обязательное поле', block.required === true, (checked) => { block.required = checked; save(); }));
      if (block.inputType === 'select') box.append(optionEditor(block));
      return box;
    }

    if (block.type === 'helpform') {
      box.append(checkField('Раскрывать по кнопке', block.collapsible === true, (checked) => {
        block.collapsible = checked;
        if (checked && block.toggleLabel === undefined) block.toggleLabel = 'Подобрать индивидуально';
        structureChanged();
      }));
      if (block.collapsible === true) box.append(textField('Кнопка раскрытия', text(block.toggleLabel), (value) => { block.toggleLabel = value; save(); }));
      box.append(checkField('Только имя и телефон', block.phoneOnly === true, (checked) => {
        block.phoneOnly = checked;
        if (checked && (block.contactLabel == null || ['Контакт', 'Ваш контакт'].includes(text(block.contactLabel).trim()))) block.contactLabel = 'Номер телефона';
        structureChanged();
      }, 'Показывать два поля. Настройки остальных полей и способов связи сохранятся.'));
      const partsBox = h('fieldset', { class: 'fb-channels' }, h('legend', { text: 'Состав формы' }));
      let draggedPart = null;
      const movePart = (part, target, after = false) => {
        if (!PART_IDS.has(part) || !PART_IDS.has(target) || part === target) return;
        const order = partOrderOf(block).filter((id) => id !== part);
        order.splice(order.indexOf(target) + Number(after), 0, part);
        block.partOrder = order; structureChanged();
      };
      for (const part of partOrderOf(block)) {
        const label = PARTS.find(([id]) => id === part)[1];
        const row = h('div', { class: 'fb-field-card', dataset: { formPart: part },
          ondragover: (event) => { if (draggedPart) { event.preventDefault(); event.stopPropagation(); } },
          ondrop: (event) => {
            if (!draggedPart) return;
            event.preventDefault(); event.stopPropagation();
            const from = draggedPart; draggedPart = null;
            const bounds = row.getBoundingClientRect();
            movePart(from, part, event.clientY >= bounds.top + bounds.height / 2);
          } });
        const order = partOrderOf(block), at = order.indexOf(part);
        row.append(h('div', { class: 'fb-field-tools' },
          h('button', { type: 'button', class: 'btn btn--small', draggable: 'true', text: '↕', title: 'Перетащите, чтобы изменить порядок', 'aria-label': `Переместить: ${label}`,
            ondragstart: (event) => { event.stopPropagation(); draggedPart = part; if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', part); } },
            ondragend: (event) => { event.stopPropagation(); draggedPart = null; } }),
          h('button', { type: 'button', class: 'btn btn--small', text: '↑', title: 'Выше', disabled: at === 0, onclick: () => movePart(part, order[at - 1]) }),
          h('button', { type: 'button', class: 'btn btn--small', text: '↓', title: 'Ниже', disabled: at === order.length - 1, onclick: () => movePart(part, order[at + 1], true) })),
          checkField(label, partVisible(block, part), (checked) => {
            const hidden = hiddenPartsOf(block);
            if (checked) hidden.delete(part); else hidden.add(part);
            block.phoneOnly = false;
            block.hiddenParts = PARTS.map(([id]) => id).filter((id) => hidden.has(id));
            structureChanged();
          }));
        partsBox.append(row);
      }
      partsBox.append(h('p', { class: 'hint', text: 'В боевом приложении для приёма заявки нужны имя и телефон. Скрытие полей здесь проверяет макет и не меняет эти требования.' }));
      box.append(partsBox);
      box.append(textField('Подсказка в поле имени', text(block.namePlaceholder), (value) => { block.namePlaceholder = value; save(); }),
        checkField('Имя обязательно', block.nameRequired !== false, (checked) => { block.nameRequired = checked; save(); }),
        checkField(block.phoneOnly === true ? 'Телефон обязателен' : 'Контакт обязателен', block.contactRequired !== false, (checked) => { block.contactRequired = checked; save(); }),
        textField('Общая подсказка в поле контакта', text(block.contactPlaceholder), (value) => { block.contactPlaceholder = value; save(); }),
        h('p', { class: 'hint', text: 'Пустой текст подсказки останется пустым. Если настройка ещё не задана, используется подсказка способа связи.' }));
      if (block.phoneOnly === true) return box;
      const channels = Array.isArray(ctx.channels) ? ctx.channels : [];
      const currentChannels = () => new Set(enabledChannels(block, channels).map((channel) => channel.id));
      const channelChecks = [];
      const updateChecks = () => {
        const selected = currentChannels();
        for (const item of channelChecks) {
          item.input.checked = selected.has(item.id);
          item.input.disabled = selected.size === 1 && selected.has(item.id);
        }
      };
      const channelBox = h('fieldset', { class: 'fb-channels' }, h('legend', { text: 'Способы связи' }));
      for (const channel of channels) {
        const id = ctx.nextId('fb-channel');
        const input = h('input', { id, type: 'checkbox', checked: currentChannels().has(channel.id), onchange: (event) => {
          const selected = currentChannels();
          if (event.target.checked) selected.add(channel.id);
          else if (selected.size > 1) selected.delete(channel.id);
          block.channels = channels.filter((c) => selected.has(c.id)).map((c) => c.id);
          updateChecks(); save();
        } });
        channelChecks.push({ id: channel.id, input });
        channelBox.append(h('label', { class: 'fb-channel', for: id }, input, h('span', { text: channel.label })));
      }
      updateChecks();
      channelBox.append(h('p', { class: 'hint', text: 'Оставьте хотя бы один способ связи.' }));
      box.append(channelBox);
      const perChannel = block.contactPlaceholders && typeof block.contactPlaceholders === 'object' && !Array.isArray(block.contactPlaceholders) ? block.contactPlaceholders : {};
      const details = h('details', { class: 'fb-placeholder-details' }, h('summary', { text: 'Подсказки контакта для каждого канала' }));
      for (const channel of channels) details.append(textField(channel.label, Object.hasOwn(perChannel, channel.id) ? text(perChannel[channel.id]) : '', (value) => {
        if (!block.contactPlaceholders || typeof block.contactPlaceholders !== 'object' || Array.isArray(block.contactPlaceholders)) block.contactPlaceholders = {};
        Object.defineProperty(block.contactPlaceholders, channel.id, { value, configurable: true, enumerable: true, writable: true });
        save();
      }));
      box.append(details, textField('Пояснение под контактами', block.hint == null ? 'Продолжим в чате. Контакт пригодится, если не сможем связаться здесь.' : text(block.hint),
        (value) => { block.hint = value; save(); }, { area: true, rows: 3 }));
    }

    const fields = fieldsOf(block);
    const heading = block.type === 'helpform' ? 'Дополнительные поля' : 'Поля формы';
    box.append(h('h4', { class: 'fb-fields-title', text: `${heading} · ${fields.length}/${MAX_FIELDS}` }));
    if (!fields.length) box.append(h('p', { class: 'hint', text: block.type === 'helpform'
      ? 'Имя, способ связи и контакт уже есть. Здесь можно добавить пожелания, дату, бюджет или другой вопрос.'
      : 'Добавьте поля, которые посетитель должен заполнить.' }));

    // Идентификаторы назначаются только вслед за пользовательской правкой. Просмотр импортированной формы не меняет проект.
    const prepareIds = () => {
      const used = new Set();
      for (const field of fieldsOf(block)) {
        if (!field.id || used.has(text(field.id))) field.id = uniqueId(ctx, used);
        used.add(text(field.id));
      }
    };
    const updateField = (field, key, value, structural = false) => {
      prepareIds(); field[key] = value;
      if (structural) structureChanged(); else save();
    };
    const move = (field, delta) => {
      if (!Array.isArray(block.fields)) return;
      const from = block.fields.indexOf(field), to = from + delta;
      if (from < 0 || to < 0 || to >= block.fields.length) return;
      prepareIds(); block.fields.splice(to, 0, block.fields.splice(from, 1)[0]); structureChanged();
    };

    fields.forEach((field, index) => {
      const hidden = field.hidden === true;
      const card = h('div', { class: `fb-field-card${hidden ? ' is-hidden' : ''}`, dataset: { fieldId: fieldKey(field, index) } },
        h('div', { class: 'fb-field-card__head' },
          h('h5', { text: `${index + 1}. ${text(field.label) || TYPES.find(([id]) => id === typeOf(field))[1]}${hidden ? ' · убрано' : ''}` }),
          h('span', { class: 'fb-field-card__type', text: TYPES.find(([id]) => id === typeOf(field))[1] })));
      card.append(h('div', { class: 'fb-field-tools' },
        h('button', { type: 'button', class: 'btn btn--small', text: '↑', title: 'Выше', 'aria-label': 'Переместить поле выше', disabled: index === 0, onclick: () => move(field, -1) }),
        h('button', { type: 'button', class: 'btn btn--small', text: '↓', title: 'Ниже', 'aria-label': 'Переместить поле ниже', disabled: index === fields.length - 1, onclick: () => move(field, 1) }),
        h('button', { type: 'button', class: 'btn btn--small', text: 'Дублировать', disabled: fields.length >= MAX_FIELDS, onclick: () => {
          if (!Array.isArray(block.fields) || block.fields.length >= MAX_FIELDS) return;
          prepareIds();
          const id = uniqueId(ctx, new Set(block.fields.map((f) => text(f.id))));
          const copy = { ...field, id, hidden: false };
          if (Array.isArray(field.options)) copy.options = field.options.map((option) => option && typeof option === 'object' ? { ...option } : option);
          block.fields.splice(block.fields.indexOf(field) + 1, 0, copy);
          const originalStyle = block.textStyles && block.textStyles[`field:${field.id}`];
          if (originalStyle && typeof originalStyle === 'object' && !Array.isArray(originalStyle)) block.textStyles[`field:${id}`] = { ...originalStyle };
          structureChanged();
        } }),
        h('button', { type: 'button', class: `btn btn--small${hidden ? '' : ' btn--danger'}`, text: hidden ? 'Вернуть поле' : 'Убрать', onclick: () => updateField(field, 'hidden', !hidden, true) })));
      if (!hidden) {
        card.append(textField('Подпись поля', text(field.label), (value) => updateField(field, 'label', value)),
          selectField('Вид поля', typeOf(field), TYPES, (value) => updateField(field, 'type', value, true)));
        if (typeOf(field) !== 'checkbox') card.append(textField('Подсказка', text(field.placeholder), (value) => updateField(field, 'placeholder', value)));
        card.append(checkField('Обязательное поле', field.required === true, (checked) => updateField(field, 'required', checked)));
        if (typeOf(field) === 'select') card.append(optionEditor(field));
      }
      box.append(card);
    });

    let addType = 'text';
    const addButton = h('button', { type: 'button', class: 'btn fb-add-field', text: '+ Добавить поле', disabled: fields.length >= MAX_FIELDS, onclick: () => {
      if (!Array.isArray(block.fields)) block.fields = [];
      if (block.fields.length >= MAX_FIELDS) return;
      prepareIds();
      const id = uniqueId(ctx, new Set(block.fields.map((f) => text(f.id))));
      const field = { id, type: addType, label: TYPES.find(([t]) => t === addType)[1], placeholder: '', required: false };
      if (addType === 'select') field.options = ['Первый вариант', 'Второй вариант'];
      block.fields.push(field); structureChanged();
    } });
    box.append(h('div', { class: 'fb-add' }, selectField('Новое поле', addType, TYPES, (value) => { addType = value; }), addButton));
    if (fields.length >= MAX_FIELDS) box.append(h('p', { class: 'hint', text: 'В одной форме можно создать до 30 полей, включая убранные.' }));
    return box;
  }

  function render(ctx) {
    const { block, h } = ctx;
    if (!block || !['helpform', 'form'].includes(block.type) || block.type === 'helpform' && block.phoneOnly === true) return null;
    const values = ctx.values && typeof ctx.values === 'object' && !Array.isArray(ctx.values) ? ctx.values : {};
    const wrapper = h('div', { class: 'form-fields' });
    fieldsOf(block).forEach((field, index) => {
      if (field.hidden === true) return;
      const key = fieldKey(field, index), type = typeOf(field), id = ctx.nextId('form-field');
      const label = text(field.label ?? 'Поле');
      const controlClass = 'app-input form-fields__control';
      const labelText = h('span', { class: 'field__label', dataset: { textField: `field:${key}` }, text: label });
      const requiredMark = field.required === true ? h('span', { class: 'form-fields__required', title: 'Обязательное поле', 'aria-hidden': true, text: ' *' }) : null;
      const props = { id, class: controlClass, name: `extra:${key}`, required: field.required === true, autocomplete: 'off', placeholder: text(field.placeholder),
        dataset: { formField: key }, value: text(readValue(values, key)), oninput: (event) => writeValue(values, key, event.target.value) };
      let control;
      if (type === 'checkbox') {
        control = h('input', { id, type: 'checkbox', name: `extra:${key}`, required: field.required === true,
          checked: readValue(values, key) === true, dataset: { formField: key }, onchange: (event) => writeValue(values, key, event.target.checked) });
        wrapper.append(h('div', { class: 'form-fields__field form-fields__field--checkbox' },
          h('label', { class: 'form-fields__checkbox', for: id }, control, h('span', {}, labelText, requiredMark))));
        return;
      }
      if (type === 'textarea') control = h('textarea', { ...props, rows: 3 });
      else if (type === 'select') {
        const value = text(readValue(values, key));
        const options = optionsOf(field);
        control = h('select', { id, class: controlClass, name: `extra:${key}`, required: field.required === true, dataset: { formField: key },
          onchange: (event) => writeValue(values, key, event.target.value) },
          h('option', { value: '', selected: !options.includes(value), text: text(field.placeholder) || 'Выберите вариант' }),
          options.map((option) => h('option', { value: option, selected: option === value, text: option })));
      } else control = h('input', { ...props, type, ...(type === 'number' ? { step: 'any' } : {}) });
      wrapper.append(h('div', { class: 'form-fields__field' },
        h('label', { class: 'field form-fields__label', for: id }, labelText, requiredMark), control));
    });
    return wrapper;
  }

  function validate(block, values = {}) {
    if (block.type === 'helpform' && block.phoneOnly === true) return '';
    for (const [index, field] of fieldsOf(block).entries()) {
      if (field.hidden === true) continue;
      const label = text(field.label).trim() || 'Поле';
      const type = typeOf(field), value = readValue(values, fieldKey(field, index));
      if (type === 'checkbox') {
        if (field.required === true && value !== true) return `${label}: поставьте флажок.`;
        continue;
      }
      const entered = text(value).trim();
      if (field.required === true && !entered) return `${label}: заполните поле.`;
      if (!entered) continue;
      if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entered)) return `${label}: укажите корректную электронную почту.`;
      if (type === 'number' && !Number.isFinite(Number(entered))) return `${label}: укажите число.`;
      if (type === 'select' && !optionsOf(field).includes(text(value))) return `${label}: выберите вариант из списка.`;
    }
    return '';
  }

  window.BoardFormBuilder = Object.freeze({ inspector, render, validate, enabledChannels, partVisible, partOrder: partOrderOf, types: TYPES.map((entry) => [...entry]), maxFields: MAX_FIELDS, maxOptions: MAX_OPTIONS });
})();
