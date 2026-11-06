(() => {
  'use strict';
  /* CfKit — общий набор вкладок Контент-завода (задачи доски №204/№205, макет Влада 07.11).
     Одна цепочка этапов, шапка вкладки («название + календарь ▦ ⇅» в одну строку), полоса дат
     с месячным календарём и стартовая точка ленты. Модуль ничего не загружает с сервера и не меняет
     этапы: вкладки передают сюда только уже полученные данные кабинета. Подключает content-factory.js. */
  const root = typeof window !== 'undefined' ? window : globalThis;
  if (root.CfKit && root.CfKit.version) return;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));

  /* Цепочка этапов (решение Влада 07.11 02:25–02:29): этапа «Снимается» нет; этап меняется сам по действию. */
  const STAGES = Object.freeze([
    {id: 'draft', label: 'Черновик', tone: 'gray'},
    {id: 'script_review', label: 'Сценарий на согласовании', tone: 'yellow'},
    {id: 'script_rework', label: 'Сценарий на доработке', tone: 'coral'},
    {id: 'planned', label: 'Запланировано', tone: 'blue'},
    {id: 'shot', label: 'Отснято', tone: 'violet'},
    {id: 'editing', label: 'В монтаже', tone: 'violet'},
    {id: 'edit_review', label: 'Монтаж на согласовании', tone: 'yellow'},
    {id: 'edit_rework', label: 'Монтаж на доработке', tone: 'coral'},
    {id: 'ready', label: 'Готово к выходу', tone: 'green'},
    {id: 'scheduled', label: 'Запланировано к выходу', tone: 'teal'},
    {id: 'published', label: 'Опубликовано', tone: 'green'},
    {id: 'publish_error', label: 'Ошибка публикации', tone: 'red'},
    {id: 'unpublished', label: 'Снято с публикации', tone: 'gray'},
  ].map((stage) => Object.freeze(stage)));
  const stageById = (id) => STAGES.find((stage) => stage.id === id) || null;
  function stageChip(id) {
    const stage = stageById(id);
    if (!stage) return `<span class="cfk-chip cfk-tone-gray" data-stage="">${esc(id ? String(id) : 'Этап неизвестен')}</span>`;
    return `<span class="cfk-chip cfk-tone-${stage.tone}" data-stage="${stage.id}">${esc(stage.label)}</span>`;
  }

  /* localStorage может быть недоступен (приватный режим, запрет сайта) — всегда через try/catch. */
  const store = {
    get(key) { try { return root.localStorage?.getItem(key) ?? null; } catch { return null; } },
    set(key, value) { try { root.localStorage?.setItem(key, value); } catch { /* выбор живёт до перезагрузки */ } },
  };
  const sortStorageKey = (key) => `cfkit.sort.${key}`;
  function getSort(key, options) {
    const list = Array.isArray(options) ? options : [];
    const saved = key ? store.get(sortStorageKey(key)) : null;
    return list.some((option) => option.id === saved) ? saved : (list[0]?.id ?? '');
  }

  const ICONS = {
    calendar: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    sheet: '<span aria-hidden="true">▦</span>',
    sort: '<span aria-hidden="true">⇅</span>',
  };

  /* Шапка вкладки: название и иконки в одну строку; название сокращается многоточием. ⚙ здесь нет. */
  function header(opts = {}) {
    const doc = opts.document || root.document;
    const actions = Array.isArray(opts.actions) ? opts.actions : ['calendar', 'sheet', 'sort'];
    const options = Array.isArray(opts.sortOptions) ? opts.sortOptions : [];
    // sortKey — ключ вкладки для запоминания выбора; если это id одного из пунктов — текущий выбор.
    const keyIsOption = options.some((option) => option.id === opts.sortKey);
    const storageKey = keyIsOption ? (opts.storageKey || opts.title || 'tab') : (opts.sortKey || opts.storageKey || opts.title || 'tab');
    let current = keyIsOption ? opts.sortKey : getSort(storageKey, options);
    let calendarOpen = Boolean(opts.calendarOpen);

    const el = doc.createElement('div');
    el.className = 'cfk-head';
    const buttons = actions.map((action) => {
      if (action === 'calendar') return `<button type="button" class="cfk-ico" data-cfk-act="calendar" aria-pressed="${calendarOpen}" title="Показать даты" aria-label="Показать или скрыть полосу дат">${ICONS.calendar}</button>`;
      if (action === 'sheet') {
        const url = /^https:\/\//i.test(String(opts.sheetUrl || '')) ? String(opts.sheetUrl) : '';
        return url
          ? `<a class="cfk-ico" data-cfk-act="sheet" href="${esc(url)}" target="_blank" rel="noopener" title="Открыть Google Таблицу" aria-label="Открыть Google Таблицу">${ICONS.sheet}</a>`
          : `<button type="button" class="cfk-ico" data-cfk-act="sheet" disabled aria-disabled="true" title="Google Таблица ещё не подключена" aria-label="Google Таблица ещё не подключена">${ICONS.sheet}</button>`;
      }
      if (action === 'sort' && options.length) return `<button type="button" class="cfk-ico" data-cfk-act="sort" aria-haspopup="menu" aria-expanded="false" title="Сортировка" aria-label="Сортировка">${ICONS.sort}</button>`;
      return '';
    }).join('');
    el.innerHTML = `<div class="cfk-head-row"><h2 class="cfk-title" title="${esc(opts.title || '')}">${esc(opts.title || '')}</h2>${opts.extraHtml || ''}<span class="cfk-sp"></span>${buttons}</div>` +
      (opts.lead ? `<p class="cfk-lead">${esc(opts.lead)}</p>` : '');

    const menuHtml = () => `<div class="cfk-sort-menu" role="menu" aria-label="Сортировка"><b>Сортировка</b>${options.map((option, index) =>
      `<button type="button" role="menuitemradio" aria-checked="${option.id === current}" class="cfk-sort-item${option.id === current ? ' on' : ''}" data-cfk-sort="${esc(option.id)}">${option.id === current ? '●' : '○'} ${esc(option.label)}${index === 0 ? ' <i>по умолчанию</i>' : ''}</button>`).join('')}</div>`;
    const closeMenu = () => {
      el.querySelector('.cfk-sort-menu')?.remove();
      el.querySelector('[data-cfk-act="sort"]')?.setAttribute('aria-expanded', 'false');
    };
    const setCalendar = (open) => {
      calendarOpen = Boolean(open);
      el.querySelector('[data-cfk-act="calendar"]')?.setAttribute('aria-pressed', String(calendarOpen));
    };
    el.addEventListener('click', (event) => {
      const sortItem = event.target.closest('[data-cfk-sort]');
      if (sortItem) {
        current = sortItem.dataset.cfkSort;
        store.set(sortStorageKey(storageKey), current);
        el.dataset.sort = current;
        closeMenu();
        opts.onSort?.(current);
        return;
      }
      const act = event.target.closest('[data-cfk-act]')?.dataset.cfkAct;
      if (act === 'calendar') { setCalendar(!calendarOpen); opts.onCalendar?.(calendarOpen); }
      if (act === 'sort') {
        if (el.querySelector('.cfk-sort-menu')) { closeMenu(); return; }
        el.querySelector('.cfk-head-row').insertAdjacentHTML('afterend', menuHtml());
        el.querySelector('[data-cfk-act="sort"]').setAttribute('aria-expanded', 'true');
      }
    });
    el.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });
    // Вкладки перерисовывают шапку: слушатель старой шапки снимается при первом щелчке после её удаления.
    const outside = (event) => {
      if (!el.isConnected) { doc.removeEventListener('click', outside); return; }
      if (!el.contains(event.target)) closeMenu();
    };
    doc.addEventListener('click', outside);
    el.dataset.sort = current;
    el.setCalendar = setCalendar;
    el.getSort = () => current;
    el.closeMenu = closeMenu;
    return el;
  }

  /* ---------- Даты ---------- */
  const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const atDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
  const fromKey = (key) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const toDate = (value) => value instanceof Date ? atDay(value) : (fromKey(value) || null);
  const longDate = (date) => `${date.getDate()} ${MONTHS_GEN[date.getMonth()]} ${date.getFullYear()} г.`;
  function todayIn(timeZone) {
    try {
      if (timeZone) return fromKey(new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date()));
    } catch { /* неизвестный пояс — местная дата устройства */ }
    return atDay(new Date());
  }

  /* Полоса дат: по умолчанию скрыта, середина увеличена «как под лупой» и выбрана. */
  function dateStrip(opts = {}) {
    const doc = opts.document || root.document;
    const win = doc.defaultView || root;
    let marked = new Set(opts.marked || []);
    const today = todayIn(opts.timeZone);
    let selected = toDate(opts.selected) || today;
    let range = [];
    let lock = 0, settleTimer = 0;

    const el = doc.createElement('div');
    el.className = 'cfk-dates';
    el.hidden = true;
    el.innerHTML = `<div class="cfk-dates-top"><button type="button" class="cfk-arrow" data-cfk-week="-1" aria-label="Неделя назад">‹</button>
      <button type="button" class="cfk-dates-title" data-cfk-month aria-label="Открыть календарь месяца"></button>
      <button type="button" class="cfk-arrow" data-cfk-week="1" aria-label="Неделя вперёд">›</button></div>
      <div class="cfk-rail" role="listbox" aria-label="Дни"></div>
      <span class="cfk-tz">${esc(opts.tz || '')}</span>`;
    const rail = el.querySelector('.cfk-rail');
    const title = el.querySelector('.cfk-dates-title');

    const buildRange = () => {
      const keys = [...marked].map(fromKey).filter(Boolean);
      let start = addDays(selected, -45), end = addDays(selected, 45);
      keys.forEach((date) => { if (date < start) start = date; if (date > end) end = date; });
      // Не больше ~13 месяцев в ленте: длинная история не тормозит прокрутку.
      if ((end - start) / 864e5 > 400) { start = addDays(selected, -200); end = addDays(selected, 200); }
      range = [];
      for (let d = addDays(start, -3); d <= addDays(end, 3); d = addDays(d, 1)) range.push(d);
      rail.innerHTML = range.map((date) => {
        const key = dayKey(date);
        return `<button type="button" role="option" class="cfk-day${marked.has(key) ? ' has' : ''}${key === dayKey(today) ? ' today' : ''}" data-cfk-day="${key}" aria-selected="false" aria-label="${esc(longDate(date))}${marked.has(key) ? ', есть рилс' : ''}"><span class="cfk-wd">${WD[date.getDay()]}</span><span class="cfk-dn">${date.getDate()}</span></button>`;
      }).join('');
    };
    const itemFor = (date) => rail.querySelector(`[data-cfk-day="${dayKey(date)}"]`);
    const sizeItems = () => { if (rail.clientWidth) rail.style.setProperty('--cfk-iw', `${rail.clientWidth / 7}px`); };
    const markSelected = () => {
      title.textContent = longDate(selected);
      rail.querySelectorAll('.cfk-day.on').forEach((item) => { item.classList.remove('on'); item.setAttribute('aria-selected', 'false'); });
      const item = itemFor(selected);
      if (item) { item.classList.add('on'); item.setAttribute('aria-selected', 'true'); }
    };
    // «Лупа»: чем ближе день к середине, тем он крупнее; ближайший к середине — выбранный.
    const lens = () => {
      const box = rail.getBoundingClientRect(), center = box.left + box.width / 2, step = box.width / 7 || 1;
      let best = null, bestDist = Infinity;
      rail.querySelectorAll('.cfk-day').forEach((item) => {
        const r = item.getBoundingClientRect(), dist = Math.abs(r.left + r.width / 2 - center) / step;
        if (dist < bestDist) { bestDist = dist; best = item; }
        item.style.setProperty('--k', Math.max(0, 1 - dist).toFixed(3));
      });
      return best;
    };
    const center = (smooth) => {
      const item = itemFor(selected);
      if (!item || !rail.clientWidth) return;
      const left = item.offsetLeft - (rail.clientWidth - item.offsetWidth) / 2;
      if (typeof rail.scrollTo === 'function') rail.scrollTo({left, behavior: smooth ? 'smooth' : 'auto'});
      else rail.scrollLeft = left;
    };
    const select = (date, {silent = false, smooth = true} = {}) => {
      const next = toDate(date);
      if (!next) return;
      const changed = dayKey(next) !== dayKey(selected);
      selected = next;
      if (!itemFor(selected)) buildRange();
      markSelected();
      lock = 1;
      center(smooth);
      win.setTimeout(() => { lock = 0; lens(); }, smooth ? 400 : 60);
      if (changed && !silent) opts.onSelect?.(new Date(selected));
    };
    const refresh = () => { sizeItems(); lock = 1; center(false); lens(); win.setTimeout(() => { lock = 0; center(false); lens(); }, 120); };

    rail.addEventListener('scroll', () => {
      if (win.requestAnimationFrame) win.requestAnimationFrame(lens); else lens();
      win.clearTimeout(settleTimer);
      settleTimer = win.setTimeout(() => {
        if (lock) return;
        const best = lens(), date = best && fromKey(best.dataset.cfkDay);
        if (!date || dayKey(date) === dayKey(selected)) return;
        selected = date;
        markSelected();
        opts.onSelect?.(new Date(selected));
      }, 140);
    }, {passive: true});
    el.addEventListener('click', (event) => {
      const day = event.target.closest('[data-cfk-day]');
      if (day) { select(day.dataset.cfkDay); return; }
      const week = event.target.closest('[data-cfk-week]');
      if (week) { select(addDays(selected, 7 * Number(week.dataset.cfkWeek))); return; }
      if (event.target.closest('[data-cfk-month]')) openMonth();
    });

    /* Месячный календарь: пн–вс, сегодня — пунктирный круг, выбранный — заливка, точка — есть рилс. */
    let monthEl = null, shown = null;
    const closeMonth = () => { monthEl?.remove(); monthEl = null; title.focus?.(); };
    const monthHtml = () => {
      const y = shown.getFullYear(), m = shown.getMonth(), offset = (new Date(y, m, 1).getDay() + 6) % 7, days = new Date(y, m + 1, 0).getDate();
      let cells = '';
      for (let i = 0; i < offset; i++) cells += '<span></span>';
      for (let d = 1; d <= days; d++) {
        const key = dayKey(new Date(y, m, d));
        cells += `<button type="button" class="cfk-cal-d${key === dayKey(selected) ? ' on' : ''}${key === dayKey(today) ? ' td' : ''}${marked.has(key) ? ' has' : ''}" data-cfk-pick="${key}" aria-label="${d} ${MONTHS_GEN[m]}${marked.has(key) ? ', есть рилс' : ''}">${d}</button>`;
      }
      return `<div class="cfk-cal-box"><div class="cfk-cal-h"><b>Календарь</b><button type="button" class="cfk-cal-x" data-cfk-close aria-label="Закрыть">✕</button></div>
        <div class="cfk-dates-top"><button type="button" class="cfk-arrow" data-cfk-mon="-1" aria-label="Предыдущий месяц">‹</button><b class="cfk-cal-t">${MONTHS[m]} ${y} г.</b><button type="button" class="cfk-arrow" data-cfk-mon="1" aria-label="Следующий месяц">›</button></div>
        <div class="cfk-cal-g">${['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map((w) => `<span class="cfk-cal-w">${w}</span>`).join('')}${cells}</div>
        <button type="button" class="cfk-cal-today" data-cfk-pick="${dayKey(today)}">Сегодня</button></div>`;
    };
    function openMonth() {
      shown = new Date(selected.getFullYear(), selected.getMonth(), 1);
      if (!monthEl) {
        monthEl = doc.createElement('div');
        monthEl.className = 'cfk-cal';
        monthEl.setAttribute('role', 'dialog');
        monthEl.setAttribute('aria-modal', 'true');
        monthEl.setAttribute('aria-label', 'Календарь месяца');
        monthEl.addEventListener('click', (event) => {
          const pick = event.target.closest('[data-cfk-pick]');
          if (pick) { const date = fromKey(pick.dataset.cfkPick); closeMonth(); select(date); return; }
          const mon = event.target.closest('[data-cfk-mon]');
          if (mon) { shown = new Date(shown.getFullYear(), shown.getMonth() + Number(mon.dataset.cfkMon), 1); monthEl.innerHTML = monthHtml(); return; }
          if (event.target.closest('[data-cfk-close]') || event.target === monthEl) closeMonth();
        });
        monthEl.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMonth(); });
        doc.body.append(monthEl);
      }
      monthEl.innerHTML = monthHtml();
      monthEl.querySelector('.cfk-cal-d.on, .cfk-cal-today')?.focus?.();
    }

    if (typeof win.ResizeObserver === 'function') new win.ResizeObserver(() => { if (!el.hidden && rail.clientWidth) refresh(); }).observe(rail);
    buildRange();
    markSelected();

    el.setOpen = (open) => { el.hidden = !open; if (open) refresh(); else closeMonth(); };
    el.toggle = (open) => el.setOpen(open === undefined ? el.hidden : open);
    el.setSelected = (date, options = {}) => select(date, {silent: true, smooth: false, ...options});
    el.getSelected = () => new Date(selected);
    el.setMarked = (next) => { marked = new Set(next || []); buildRange(); markSelected(); if (!el.hidden) refresh(); };
    el.openMonth = openMonth;
    el.closeMonth = closeMonth;
    return el;
  }

  /* Стартовая точка ленты: экран открывается на первом элементе, который не «выше»
     (неопубликованное); над ним — тонкая пунктирная линия, подпись видна при прокрутке вверх. */
  function feedStart(listEl, opts = {}) {
    if (!listEl) return null;
    const doc = listEl.ownerDocument, win = doc.defaultView || root;
    listEl.querySelectorAll(':scope .cfk-feed-sep, :scope .cfk-feed-ahead, :scope .cfk-feed-pad').forEach((node) => node.remove());
    const table = listEl.matches('table') ? listEl : listEl.querySelector(':scope > table');
    const host = table ? (table.tBodies[0] || table) : listEl;
    const items = [...host.children].filter((node) => node.tagName !== 'THEAD' && !(node.tagName === 'TR' && node.querySelector(':scope > th')));
    const hostTag = table ? 'tr' : /^(OL|UL)$/.test(host.tagName) ? 'li' : 'div';
    const isAbove = typeof opts.isAbove === 'function' ? opts.isAbove : () => false;
    const target = items.find((item) => !isAbove(item)) || null;
    const columns = table ? Math.max(1, ...[...table.querySelectorAll('tr')].map((row) => row.children.length)) : 1;
    const makeSep = (cls, label) => {
      if (!table) {
        // В списке <ol>/<ul> разделитель — тоже <li>, чтобы разметка оставалась допустимой.
        const node = doc.createElement(/^(OL|UL)$/.test(host.tagName) ? 'li' : 'div');
        node.className = cls;
        node.innerHTML = `<span>${esc(label)}</span>`;
        return node;
      }
      const row = doc.createElement('tr');
      row.className = cls;
      row.innerHTML = `<td colspan="${columns}"><span>${esc(label)}</span></td>`;
      return row;
    };
    let separator = null;
    if (target && target !== items[0]) {
      separator = makeSep('cfk-feed-sep', opts.aboveLabel || '↑ выше — опубликованные');
      target.before(separator);
    }
    if (opts.aheadSelector) {
      const ahead = items.find((item) => item.matches(opts.aheadSelector));
      if (ahead && ahead !== target) ahead.before(makeSep('cfk-feed-ahead', opts.aheadLabel || '↓ впереди'));
    }
    listEl.classList.add('cfk-feed');
    const state = {target, separator, start: 0};
    /* Короткая лента после стартовой точки всё равно встаёт наверх (замечание пакета D). Раньше добирали padding-bottom
       по scrollHeight: у короткой ленты scrollHeight не меньше высоты окна, и отступа не хватало; а лента с max-height
       растёт вместе с отступом (при content-box — тем более), и диапазон прокрутки не прибавлялся. Теперь последний
       элемент ленты — невидимая распорка: сначала с запасом (лента упирается в max-height), затем ровно по факту
       прокрутки. Лента без своей прокрутки (листается страница) распорку не получает. */
    const padTo = (offset) => {
      host.querySelector(':scope > .cfk-feed-pad')?.remove();
      const range = () => listEl.scrollHeight - listEl.clientHeight;
      if (!(offset > 0) || range() >= offset) return;
      const overflow = win.getComputedStyle?.(listEl)?.overflowY || '';
      if (!/auto|scroll/.test(overflow)) return;
      const pad = doc.createElement(hostTag);
      pad.className = 'cfk-feed-pad';
      pad.setAttribute('aria-hidden', 'true');
      if (table) pad.innerHTML = `<td colspan="${columns}"></td>`;
      const big = Math.ceil(offset + Math.max(win.innerHeight || 0, listEl.clientHeight) + 1);
      pad.style.height = `${big}px`;
      host.append(pad);
      const got = range();
      if (got < offset) { pad.remove(); return; }
      pad.style.height = `${Math.max(0, Math.ceil(big - (got - offset)))}px`;
    };
    const scrollToStart = () => {
      if (!separator) { listEl.scrollTop = 0; state.start = 0; listEl.classList.remove('cfk-feed-up'); return; }
      const head = table?.tHead?.offsetHeight || 0;
      const offset = separator.getBoundingClientRect().top - listEl.getBoundingClientRect().top + listEl.scrollTop - head;
      padTo(offset);
      listEl.scrollTop = offset;
      state.start = offset;
      listEl.classList.remove('cfk-feed-up');
    };
    if (!listEl._cfkFeedBound) {
      listEl._cfkFeedBound = true;
      listEl.addEventListener('scroll', () => {
        const current = listEl._cfkFeed;
        if (current?.separator) listEl.classList.toggle('cfk-feed-up', listEl.scrollTop < current.start - 8);
      }, {passive: true});
    }
    listEl._cfkFeed = state;
    // scroll:false — перерисовка той же ленты (раскрыли карточку): позиция пользователя не сбрасывается,
    // пересчитывается только стартовая точка для подписи «выше».
    const measure = () => {
      if (!separator) { state.start = 0; listEl.classList.remove('cfk-feed-up'); return; }
      const head = table?.tHead?.offsetHeight || 0;
      state.start = separator.getBoundingClientRect().top - listEl.getBoundingClientRect().top + listEl.scrollTop - head;
      padTo(state.start);
      listEl.classList.toggle('cfk-feed-up', listEl.scrollTop < state.start - 8);
    };
    const run = opts.scroll === false ? measure : scrollToStart;
    if (win.requestAnimationFrame) win.requestAnimationFrame(run); else run();
    state.refresh = scrollToStart;
    return state;
  }

  root.CfKit = Object.freeze({version: '1.0.0', STAGES, stage: stageById, stageChip, header, getSort, dateStrip, feedStart, dayKey, esc});
  try { root.dispatchEvent?.(new root.CustomEvent('cfkit:ready')); } catch { /* событие не обязательно */ }
})();
