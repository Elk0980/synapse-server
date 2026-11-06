/* Авторские настройки меню. Все мутации — через Root change; нет сети, project/seed writes и HTML-ввода. */
'use strict';

(() => {
  const FONTS = [['system', 'Системный'], ['inter', 'Inter'], ['roboto', 'Roboto'], ['open-sans', 'Open Sans'],
    ['montserrat', 'Montserrat'], ['nunito-sans', 'Nunito Sans'], ['lora', 'Lora']];
  const FONT_IDS = new Set(FONTS.map(([id]) => id));
  const ALIGNMENTS = [['left', 'Слева'], ['center', 'По центру'], ['right', 'Справа']];
  const MAX_ITEMS = 50;
  let uid = 0;
  const text = (value) => value === undefined || value === null ? '' : String(value);
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const own = (value, key) => !!value && Object.hasOwn(value, key);
  const itemsOf = (menu) => (Array.isArray(menu?.items) ? menu.items : []).filter((item) => object(item));
  const controlId = () => `mb-control-${++uid}`;
  const styleOf = (holder, field) => cleanStyle(own(holder, 'textStyles') && own(holder.textStyles, field) ? holder.textStyles[field] : null);

  function cleanStyle(value) {
    const raw = object(value), style = {};
    if (!raw) return style;
    if (own(raw, 'font') && FONT_IDS.has(raw.font)) style.font = raw.font;
    if (own(raw, 'size') && Number.isFinite(raw.size) && raw.size >= 10 && raw.size <= 72) style.size = Math.round(raw.size);
    for (const key of ['bold', 'italic', 'underline']) if (own(raw, key) && typeof raw[key] === 'boolean') style[key] = raw[key];
    if (own(raw, 'align') && ALIGNMENTS.some(([id]) => id === raw.align)) style.align = raw.align;
    if (own(raw, 'color') && /^#[a-f0-9]{6}$/i.test(text(raw.color))) style.color = raw.color.toLowerCase();
    if (own(raw, 'lineHeight') && Number.isFinite(raw.lineHeight) && raw.lineHeight >= 1 && raw.lineHeight <= 2.5) style.lineHeight = Math.round(raw.lineHeight * 100) / 100;
    return style;
  }

  function newItemId(role, menu) {
    const used = new Set(itemsOf(menu).map((item) => text(item.id)));
    const safeRole = text(role).replace(/[^a-z0-9_-]/gi, '') || 'role';
    let id;
    do { id = `menu:${safeRole}:item:${Date.now().toString(36)}-${++uid}`; } while (used.has(id));
    return id;
  }

  function prepareIds(menu, role) {
    const used = new Set();
    for (const item of itemsOf(menu)) {
      const id = text(item.id);
      if (!id || used.has(id)) item.id = newItemId(role, menu);
      used.add(text(item.id));
    }
  }

  function renderEditor(ctx) {
    const { h, role, getMenu, frames, change } = ctx;
    const menu = getMenu(), items = itemsOf(menu).slice(0, MAX_ITEMS);
    const box = h('section', { class: 'mb-editor', dataset: { menuRole: role } },
      h('h3', { class: 'ins-sub', text: 'Настройки меню' }),
      h('p', { class: 'hint', text: 'Надписи, оформление и переходы меню этой роли. Изменения сохраняются в макете.' }));
    const itemRef = (item, index) => ({ id: item.id && items.filter((other) => other.id === item.id).length === 1 ? item.id : null, index });
    const resolve = (actual, ref) => ref ? (ref.id ? itemsOf(actual).find((item) => item.id === ref.id) : itemsOf(actual)[ref.index]) : actual;
    const current = (ref) => resolve(getMenu(), ref);
    const mutate = (ref, fn, rebuild = false) => {
      if (!current(ref)) return;
      change((actual) => {
        const holder = resolve(actual, ref); if (!holder) return;
        prepareIds(actual, role); fn(holder, actual);
      }, { rebuild });
    };
    const textInput = (label, value, onInput) => {
      const id = controlId();
      return h('div', { class: 'ins-field' }, h('label', { for: id, text: label }),
        h('input', { id, type: 'text', value, maxlength: 120, oninput: (event) => onInput(event.target.value) }));
    };
    const selectInput = (label, value, options, onChange) => {
      const id = controlId();
      return h('div', { class: 'ins-field' }, h('label', { for: id, text: label }),
        h('select', { id, onchange: (event) => onChange(event.target.value) }, options.map(([key, name, disabled]) => h('option', {
          value: key, text: name, selected: key === value, disabled: disabled === true }))));
    };

    function styleControls(ref, field, heading) {
      const defaults = { font: 'system', size: ref ? 15 : 18, bold: true, italic: false, underline: false, align: 'left', color: '#26261f' };
      const stored = () => styleOf(current(ref), field);
      const effective = () => ({ ...defaults, ...stored() });
      const set = (key, value) => mutate(ref, (holder) => {
        const next = stored();
        if (value === undefined) delete next[key]; else next[key] = value;
        const clean = cleanStyle(next);
        if (!own(holder, 'textStyles') || !object(holder.textStyles)) Object.defineProperty(holder, 'textStyles', { value: {}, writable: true, configurable: true, enumerable: true });
        if (Object.keys(clean).length) Object.defineProperty(holder.textStyles, field, { value: clean, writable: true, configurable: true, enumerable: true });
        else if (own(holder.textStyles, field)) delete holder.textStyles[field];
        if (!Object.keys(holder.textStyles).length) delete holder.textStyles;
      });
      const section = h('details', { class: 'mb-styles' }, h('summary', { text: heading }));
      section.append(selectInput('Шрифт', effective().font, FONTS, (value) => { if (FONT_IDS.has(value)) set('font', value); }));
      const sizeId = controlId();
      const size = h('input', { id: sizeId, type: 'number', min: 10, max: 72, step: 1, value: effective().size, oninput: (event) => {
        const value = event.target.value.trim(), n = Number(value);
        if (value && Number.isFinite(n) && n >= 10 && n <= 72) set('size', Math.round(n));
      }, onchange: (event) => {
        if (!event.target.value.trim()) { set('size', undefined); return; }
        const n = Number(event.target.value); if (!Number.isFinite(n)) return;
        const value = Math.round(Math.max(10, Math.min(72, n))); event.target.value = String(value); set('size', value);
      } });
      section.append(h('div', { class: 'ins-field' }, h('label', { for: sizeId, text: 'Размер, px' }), size));
      const tools = h('div', { class: 'mb-style-tools', role: 'group', 'aria-label': 'Начертание' });
      for (const [key, label, symbol] of [['bold', 'Жирный', 'Ж'], ['italic', 'Курсив', 'К'], ['underline', 'Подчёркнутый', 'Ч']]) {
        const button = h('button', { type: 'button', class: `mb-style-tool${effective()[key] ? ' is-active' : ''}`,
          title: label, 'aria-label': label, 'aria-pressed': String(effective()[key]), text: symbol, onclick: () => {
            set(key, !effective()[key]);
            button.classList.toggle('is-active', effective()[key]); button.setAttribute('aria-pressed', String(effective()[key]));
          } });
        tools.append(button);
      }
      section.append(tools, selectInput('Выравнивание', effective().align, ALIGNMENTS, (value) => {
        if (ALIGNMENTS.some(([id]) => id === value)) set('align', value);
      }));
      const colorId = controlId();
      section.append(h('div', { class: 'ins-field' }, h('label', { for: colorId, text: 'Цвет' }),
        h('input', { id: colorId, class: 'mb-color', type: 'color', value: effective().color, oninput: (event) => {
          if (/^#[a-f0-9]{6}$/i.test(event.target.value)) set('color', event.target.value.toLowerCase());
        } })));
      section.append(h('button', { type: 'button', class: 'btn btn--small', text: 'Сбросить оформление', onclick: () => {
        mutate(ref, (holder) => {
          if (own(holder, 'textStyles') && own(holder.textStyles, field)) delete holder.textStyles[field];
          if (own(holder, 'textStyles') && object(holder.textStyles) && !Object.keys(holder.textStyles).length) delete holder.textStyles;
        }, true);
      } }));
      return section;
    }

    box.append(textInput('Заголовок меню', text(menu?.title), (value) => mutate(null, (actual) => { actual.title = value; })),
      styleControls(null, 'title', 'Оформление заголовка'));
    const allowedFrames = () => (typeof frames === 'function' ? frames() : []).filter((frame) => frame && frame.role === role && !frame.hidden && typeof frame.id === 'string');
    box.append(h('h4', { class: 'mb-items-title', text: `Пункты меню · ${items.length}/${MAX_ITEMS}` }));
    if (!items.length) box.append(h('p', { class: 'hint', text: 'Добавьте первый пункт и выберите страницу.' }));
    items.forEach((item, index) => {
      const ref = itemRef(item, index);
      const heading = h('h5', { text: `${index + 1}. ${text(item.label) || 'Без названия'}` });
      const card = h('div', { class: `mb-item${item.hidden ? ' is-hidden' : ''}`, dataset: { menuItem: text(item.id) } },
        h('div', { class: 'mb-item__head' }, heading, item.hidden ? h('span', { class: 'mb-item__badge', text: 'Скрыт' }) : null));
      const move = (delta) => mutate(ref, (holder, actual) => {
        const from = actual.items.indexOf(holder), to = from + delta;
        if (from < 0 || to < 0 || to >= actual.items.length) return;
        actual.items.splice(to, 0, actual.items.splice(from, 1)[0]);
      }, true);
      card.append(h('div', { class: 'mb-item__tools' },
        h('button', { type: 'button', class: 'btn btn--small', text: '↑', title: 'Выше', 'aria-label': 'Переместить пункт выше', disabled: index === 0, onclick: () => move(-1) }),
        h('button', { type: 'button', class: 'btn btn--small', text: '↓', title: 'Ниже', 'aria-label': 'Переместить пункт ниже', disabled: index === items.length - 1, onclick: () => move(1) }),
        h('button', { type: 'button', class: 'btn btn--small', text: 'Дублировать', disabled: items.length >= MAX_ITEMS, onclick: () => mutate(ref, (holder, actual) => {
          if (itemsOf(actual).length >= MAX_ITEMS) return;
          const copy = JSON.parse(JSON.stringify(holder));
          copy.id = newItemId(role, actual); copy.hidden = false;
          if (object(copy.textStyles)) for (const key of Object.keys(copy.textStyles)) {
            const clean = cleanStyle(copy.textStyles[key]);
            if (Object.keys(clean).length) Object.defineProperty(copy.textStyles, key, { value: clean, writable: true, configurable: true, enumerable: true });
            else delete copy.textStyles[key];
          }
          actual.items.splice(actual.items.indexOf(holder) + 1, 0, copy);
        }, true) }),
        h('button', { type: 'button', class: 'btn btn--small', text: item.hidden ? 'Показать' : 'Скрыть', onclick: () => mutate(ref, (holder) => { holder.hidden = !holder.hidden; }, true) }),
        h('button', { type: 'button', class: 'btn btn--small btn--danger', text: 'Удалить', onclick: () => mutate(ref, (holder, actual) => {
          const at = actual.items.indexOf(holder); if (at >= 0) actual.items.splice(at, 1);
        }, true) })));
      card.append(textInput('Надпись пункта', text(item.label), (value) => {
        mutate(ref, (holder) => { holder.label = value; }); heading.textContent = `${index + 1}. ${value || 'Без названия'}`;
      }));
      const options = [['', '— выберите страницу —'], ...allowedFrames().map((frame) => [frame.id, `${frame.id} · ${text(frame.title)}`])];
      const target = text(item.target);
      if (target && !options.some(([id]) => id === target)) options.push([target, `${target} · недоступная страница`, true]);
      const routeError = h('p', { class: 'mb-route-error', role: 'status', hidden: true });
      const targetControl = selectInput('Переход на страницу', target, options, (value) => {
        if (value && !allowedFrames().some((frame) => frame.id === value)) {
          routeError.textContent = 'Эта страница недоступна для роли меню.'; routeError.hidden = false;
          targetControl.querySelector('select').value = text(current(ref)?.target); return;
        }
        routeError.hidden = true; mutate(ref, (holder) => { holder.target = value; });
      });
      card.append(targetControl, routeError, styleControls(ref, 'label', 'Оформление пункта'));
      box.append(card);
    });
    box.append(h('button', { type: 'button', class: 'btn mb-add-item', text: '+ Добавить пункт', disabled: items.length >= MAX_ITEMS, onclick: () => change((actual) => {
      if (!Array.isArray(actual.items)) actual.items = [];
      if (itemsOf(actual).length >= MAX_ITEMS) return;
      prepareIds(actual, role);
      actual.items.push({ id: newItemId(role, actual), label: 'Новый пункт', target: '', hidden: false });
    }, { rebuild: true }) }),
    h('p', { class: 'hint', text: 'Скрытый пункт сохраняется в меню. Удалённый пункт можно вернуть через «Отменить» на доске.' }));
    return box;
  }

  window.BoardMenuBuilder = Object.freeze({ renderEditor, cleanStyle, maxItems: MAX_ITEMS });
})();
