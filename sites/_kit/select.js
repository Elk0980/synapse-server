/* Site kit: выпадающий список в стиле сайта. Источник — sites/_kit/select.js.
   Копии в sites/<сайт>/assets/kit/ создаёт tools/site-kit/sync.js: правьте только источник.

   Прогрессивное улучшение. Нативный <select> остаётся в DOM: имя, значение, required,
   FormData и обработчики сайта (change/input) работают как раньше. На устройствах с мышью
   рядом строится кнопка role=combobox и список role=listbox (шаблон WAI-ARIA «select-only
   combobox»). На сенсорных экранах остаётся системный список — он удобнее пальцем; сам
   контрол оформлен select.css. Отказ на конкретном списке: атрибут data-kit-native. */
(function (root) {
  'use strict';
  if (!root || !root.document || root.SiteKitSelect) return;
  const doc = root.document;
  const VERSION = '1';
  let uid = 0;

  const coarse = () => typeof root.matchMedia === 'function' && root.matchMedia('(pointer: coarse)').matches;
  const eligible = (select) => select instanceof root.HTMLSelectElement && !select.multiple && !(select.size > 1)
    && !select.closest('[data-kit-native]') && !select.dataset.kitSelect;

  function labelText(select) {
    const label = select.labels && select.labels[0];
    if (!label) return select.getAttribute('aria-label') || select.name || '';
    if (!label.contains(select)) return label.textContent.trim();
    let text = '';
    for (const node of label.childNodes) {
      if (node === select || (node.nodeType === 1 && (node.matches('select, .kit-select, input, textarea, button') || node.contains(select)))) continue;
      text += node.textContent;
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  function build(select) {
    const id = 'kit-select-' + (++uid);
    // Подпись читается до вставки кнопки: после неё <label> подписывает уже кнопку.
    const name = labelText(select);
    const box = doc.createElement('span');
    box.className = 'kit-select';
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'kit-select__button';
    button.id = id;
    button.setAttribute('role', 'combobox');
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', id + '-list');
    const value = doc.createElement('span');
    value.className = 'kit-select__value';
    button.append(value);
    const list = doc.createElement('ul');
    list.className = 'kit-select__list';
    list.id = id + '-list';
    list.setAttribute('role', 'listbox');
    list.tabIndex = -1;
    list.hidden = true;
    box.append(button, list);
    // Кнопка — первый «подписываемый» элемент внутри <label>: клик по подписи открывает список.
    // Нативный список переезжает внутрь обёртки: подсказка браузера о required
    // показывается у видимого контрола, а не в углу страницы.
    select.before(box);
    box.append(select);
    select.classList.add('kit-select__native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    let items = [];
    let active = -1;
    let typed = '';
    let typedAt = 0;
    const isOpen = () => !list.hidden;

    function renderOptions() {
      list.textContent = '';
      items = [];
      for (const el of select.children) {
        const group = el.tagName === 'OPTGROUP' ? el : null;
        if (group) {
          const head = doc.createElement('li');
          head.className = 'kit-select__group';
          head.setAttribute('role', 'presentation');
          head.textContent = group.label;
          list.append(head);
        }
        for (const option of group ? group.children : [el]) {
          if (option.tagName !== 'OPTION' || option.hidden) continue;
          const li = doc.createElement('li');
          li.className = 'kit-select__option';
          li.id = id + '-opt-' + items.length;
          li.setAttribute('role', 'option');
          li.textContent = option.label || option.textContent;
          if (option.disabled || (group && group.disabled)) li.setAttribute('aria-disabled', 'true');
          li.dataset.index = String(option.index);
          list.append(li);
          items.push({ li, option });
        }
      }
    }

    function render() {
      const current = select.options[select.selectedIndex];
      value.textContent = current ? (current.label || current.textContent) : '';
      button.disabled = select.disabled;
      button.setAttribute('aria-label', name);
      if (select.required) button.setAttribute('aria-required', 'true'); else button.removeAttribute('aria-required');
      for (const { li, option } of items) li.setAttribute('aria-selected', option.selected ? 'true' : 'false');
    }

    function setActive(index) {
      if (items[active]) items[active].li.classList.remove('is-active');
      active = index;
      const item = items[active];
      if (!item) { button.removeAttribute('aria-activedescendant'); return; }
      item.li.classList.add('is-active');
      button.setAttribute('aria-activedescendant', item.li.id);
      if (typeof item.li.scrollIntoView === 'function') item.li.scrollIntoView({ block: 'nearest' });
    }

    function step(from, delta) {
      for (let i = from + delta; i >= 0 && i < items.length; i += delta) {
        if (items[i].li.getAttribute('aria-disabled') !== 'true') return i;
      }
      return from;
    }

    function open() {
      if (isOpen() || select.disabled) return;
      renderOptions();
      render();
      list.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      const rect = box.getBoundingClientRect();
      const below = (root.innerHeight || 0) - rect.bottom;
      box.classList.toggle('kit-select--up', below < 220 && rect.top > below);
      const selected = items.findIndex((item) => item.option.selected);
      setActive(selected >= 0 ? selected : step(-1, 1));
      doc.addEventListener('pointerdown', outside, true);
    }

    function close() {
      if (!isOpen()) return;
      list.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      button.removeAttribute('aria-activedescendant');
      box.classList.remove('kit-select--up');
      doc.removeEventListener('pointerdown', outside, true);
    }

    function choose(index) {
      const item = items[index];
      if (!item || item.li.getAttribute('aria-disabled') === 'true') return;
      if (select.selectedIndex !== item.option.index) {
        nativeSet(select, 'selectedIndex', item.option.index);
        select.dispatchEvent(new root.Event('input', { bubbles: true }));
        select.dispatchEvent(new root.Event('change', { bubbles: true }));
      }
      render();
    }

    function outside(event) { if (!box.contains(event.target)) close(); }

    function typeahead(key) {
      const now = Date.now();
      typed = (now - typedAt > 700 ? '' : typed) + key.toLowerCase();
      typedAt = now;
      if (!items.length) renderOptions();
      const start = isOpen() ? active : items.findIndex((item) => item.option.selected);
      const order = items.map((_, i) => (i + start + (typed.length > 1 ? 0 : 1)) % items.length);
      const hit = order.find((i) => items[i].li.getAttribute('aria-disabled') !== 'true'
        && items[i].li.textContent.trim().toLowerCase().startsWith(typed));
      if (hit === undefined) return;
      if (isOpen()) setActive(hit); else { choose(hit); }
    }

    button.addEventListener('click', (event) => {
      event.preventDefault();
      if (isOpen()) close(); else open();
    });
    button.addEventListener('keydown', (event) => {
      const key = event.key;
      if (!isOpen()) {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Home', 'End'].includes(key)) {
          event.preventDefault();
          open();
          if (key === 'Home') setActive(step(-1, 1));
          if (key === 'End') setActive(step(items.length, -1));
        } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          typeahead(key);
        }
        return;
      }
      if (key === 'ArrowDown') { event.preventDefault(); setActive(step(active, 1)); }
      else if (key === 'ArrowUp' && event.altKey) { event.preventDefault(); choose(active); close(); }
      else if (key === 'ArrowUp') { event.preventDefault(); setActive(step(active, -1)); }
      else if (key === 'Home') { event.preventDefault(); setActive(step(-1, 1)); }
      else if (key === 'End') { event.preventDefault(); setActive(step(items.length, -1)); }
      else if (key === 'PageDown') { event.preventDefault(); setActive(Math.min(items.length - 1, active + 10)); }
      else if (key === 'PageUp') { event.preventDefault(); setActive(Math.max(0, active - 10)); }
      else if (key === 'Enter' || key === ' ') { event.preventDefault(); choose(active); close(); }
      // Escape закрывает только список, как у системного select: панель/корзина сайта остаётся открытой.
      else if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      else if (key === 'Tab') { choose(active); close(); }
      else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) typeahead(key);
    });
    // mousedown не уводит фокус с кнопки; click внутри <label> не должен повторно нажимать кнопку.
    list.addEventListener('mousedown', (event) => event.preventDefault());
    list.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const li = event.target.closest('.kit-select__option');
      if (!li) return;
      choose(items.findIndex((item) => item.li === li));
      close();
      button.focus();
    });
    list.addEventListener('pointermove', (event) => {
      const li = event.target.closest('.kit-select__option');
      const index = items.findIndex((item) => item.li === li);
      if (index >= 0 && index !== active && li.getAttribute('aria-disabled') !== 'true') setActive(index);
    });
    button.addEventListener('blur', () => root.setTimeout(() => { if (!box.contains(doc.activeElement)) close(); }, 0));

    // Синхронизация с нативным списком: события сайта, сброс формы, программная смена значения.
    select.addEventListener('change', render);
    select.addEventListener('invalid', () => button.setAttribute('aria-invalid', 'true'));
    select.addEventListener('change', () => button.removeAttribute('aria-invalid'));
    select.addEventListener('focus', () => button.focus());
    if (select.form) select.form.addEventListener('reset', () => root.setTimeout(render, 0));
    for (const prop of ['value', 'selectedIndex']) {
      const proto = Object.getOwnPropertyDescriptor(root.HTMLSelectElement.prototype, prop);
      Object.defineProperty(select, prop, {
        configurable: true,
        get() { return proto.get.call(this); },
        // return true: обёртка jsdom (тесты) считает ложный результат сеттера ошибкой.
        set(v) { proto.set.call(this, v); render(); return true; },
      });
    }
    if (typeof root.MutationObserver === 'function') {
      new root.MutationObserver(() => { if (isOpen()) renderOptions(); render(); })
        .observe(select, { attributes: true, attributeFilter: ['disabled', 'required'], childList: true, subtree: true, characterData: true });
    }
    renderOptions();
    render();
    return { button, list, open, close };
  }

  function nativeSet(select, prop, v) {
    Object.getOwnPropertyDescriptor(root.HTMLSelectElement.prototype, prop).set.call(select, v);
  }

  function enhance(select, options) {
    if (!eligible(select)) return null;
    const custom = (options && options.custom) || select.hasAttribute('data-kit-custom') || !coarse();
    select.dataset.kitSelect = custom ? 'custom' : 'native';
    return custom ? build(select) : null;
  }

  function enhanceAll(scope, options) {
    for (const select of (scope || doc).querySelectorAll('select')) enhance(select, options);
  }

  function start() {
    enhanceAll(doc);
    if (typeof root.MutationObserver === 'function' && doc.body) {
      new root.MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'SELECT') enhance(node); else if (node.querySelector) enhanceAll(node);
        }
      }).observe(doc.body, { childList: true, subtree: true });
    }
  }

  root.SiteKitSelect = { version: VERSION, enhance, enhanceAll };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start); else start();
})(typeof window !== 'undefined' ? window : null);
