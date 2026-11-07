(() => {
  'use strict';
  /* Контент → Подключения (контракт А, id content-connections). Читает GET /content-connections:
     статус площадки считает сервер по факту данных и настроек; ключи сюда не приходят — только «есть / нет».
     Макет Влада 07.11: шапка CfKit (▦, ⇅ — статус или название), карточки площадок одной колонкой,
     🟢/🟡/🔴, ссылка на страницу из ссылок компании (CRM). «Подключить» ведёт прямо к вводу ключа
     в существующей форме (Постинг → «Подключение площадок» или «Соцсети» → «Аккаунты и источники»),
     «Проверить» — к существующей кнопке «Проверить доступ» канала публикации. Своих форм ключей здесь нет. */
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (v) => (typeof v === 'string' && /^https?:\/\/[^\s<>"']+$/i.test(v) ? v : '');
  const STATUS = { green: ['🟢', 'подключено'], yellow: ['🟡', 'частично'], red: ['🔴', 'нет'] };
  const RANK = { red: 0, yellow: 1, green: 2 };
  const MODE = { live: 'LIVE', manual: 'РУЧНОЙ ВВОД', none: 'НЕТ ДАННЫХ' };
  const SORTS = [{ id: 'status', label: 'Статус: не подключено → частично → подключено' }, { id: 'name', label: 'Название' }];
  /* Площадка Подключений → канал публикации (форма ключа в «Постинге») и аккаунт статистики («Соцсети»). */
  const CHANNEL = { instagram: 'instagram', tiktok: 'tiktok', youtube: 'youtube_shorts', vk: 'vk', telegram_channel: 'telegram', max: 'max' };
  const SOCIAL = { instagram: 'instagram', tiktok: 'tiktok', youtube: 'youtube', vk: 'vk', telegram_channel: 'telegram' };
  const stamp = (v) => (v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString('ru-RU', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' (Бангкок)' : '—');
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v.split('-').reverse().join('.') : '—');
  const kit = () => (typeof window !== 'undefined' && window.CfKit && typeof window.CfKit.header === 'function' ? window.CfKit : null);
  const state = { sort: 'status' };

  /* Какие действия доступны карточке: только существующие потоки кабинета, без новых форм и запросов. */
  function actions(p, can) {
    const list = [], channel = CHANNEL[p.id], social = SOCIAL[p.id], pub = p.settings?.publishing || null;
    const edit = can('autoposting.edit'), owner = can('owner');
    if (channel && pub?.key) list.push({ act: 'check', label: 'Проверить', target: channel, enabled: edit,
      hint: edit ? 'Проверить доступ канала публикации (ничего не публикует)' : 'Проверка доступна по праву «Контент: менять материалы и каналы»' });
    if (p.status !== 'green') {
      if (channel && !pub?.connected) list.push({ act: 'connect', label: 'Подключить', target: channel, enabled: edit,
        hint: edit ? 'Открыть ввод ключа канала публикации' : 'Ключ вводит владелец или человек с правом «Контент: менять материалы и каналы»' });
      else if (social) list.push({ act: 'stats', label: 'Подключить', target: social, enabled: owner,
        hint: owner ? 'Открыть аккаунт статистики площадки' : 'Аккаунты статистики настраивает владелец' });
      else if (p.id === 'two_gis') list.push({ act: 'gis', label: 'Подключить', target: 'two_gis', enabled: can('analytics.view'),
        hint: 'Открыть настройки 2ГИС в «Спросе площадок»' });
    }
    return list;
  }

  function card(p, can = () => false) {
    const [icon, word] = STATUS[p.status] || STATUS.red, href = safeUrl(p.link);
    const btn = (a) => `<button type="button" class="cc-btn${a.act === 'check' ? ' cc-btn-ghost' : ''}" data-cc-act="${a.act}" data-cc-target="${esc(a.target)}"${a.enabled ? '' : ' disabled'} title="${esc(a.hint)}">${esc(a.label)}</button>`;
    const list = actions(p, can), buttons = list.map(btn).join('');
    // Телефон (макет #conn): в строке одно действие — «Подключить» или «↗ ссылка»; «Проверить» и ссылка — в «Подробнее».
    const checks = list.filter((a) => a.act === 'check').map(btn).join('');
    return `<article class="cc-card cc-${esc(p.status)}" data-cc-platform="${esc(p.id)}" data-cc-status="${esc(p.status)}">
      <div class="cc-row"><span class="cc-dot" aria-hidden="true"></span><h3>${esc(p.label)}</h3><span class="cc-word" title="${esc(p.statusText)}"><span class="cc-ico" aria-hidden="true">${icon}</span> ${esc(word)}</span>
        <span class="cc-sp"></span>${href ? `<a class="cc-page" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="Страница площадки из ссылок компании">↗ ссылка</a>` : ''}${buttons ? `<span class="cc-acts">${buttons}</span>` : ''}</div>
      <p class="cc-status-text">${esc(p.statusText)}${href ? '' : ' · <span class="cc-nolink">ссылки в карточке компании нет</span>'}</p>
      <details class="cc-more"><summary>Подробнее</summary>
        ${href || checks ? `<p class="cc-more-acts">${href ? `<a class="cc-page" href="${esc(href)}" target="_blank" rel="noopener noreferrer">↗ ссылка</a>` : ''}${checks}</p>` : ''}
        <p class="cc-meta"><span class="cc-mode cc-mode-${esc(p.dataMode)}">${esc(MODE[p.dataMode] || MODE.none)}</span>
          ${p.lastDataDate ? `данные по ${esc(day(p.lastDataDate))}` : 'данных в ЛК нет'}</p>
        ${p.facts?.length ? `<ul class="cc-facts">${p.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
        ${p.next ? `<p class="cc-next"><b>Что нужно:</b> ${esc(p.next)}</p>` : ''}</details>
    </article>`;
  }

  function sorted(list, sort) {
    const byName = (a, b) => String(a.label).localeCompare(String(b.label), 'ru');
    return [...list].sort(sort === 'name' ? byName : (a, b) => ((RANK[a.status] ?? 0) - (RANK[b.status] ?? 0)) || byName(a, b));
  }

  function render(el, data, can = () => false) {
    const count = (s) => data.platforms.filter((p) => p.status === s).length;
    const K = kit();
    el.innerHTML = `<div class="cc-root">${K ? '<div data-cc-header></div>' : '<div class="content-header"><h1>Подключения</h1></div>'}
      <p class="cc-summary" data-cc-summary>🟢 ${count('green')} подключено · 🟡 ${count('yellow')} частично · 🔴 ${count('red')} не подключено</p>
      <div class="cc-list">${sorted(data.platforms, state.sort).map((p) => card(p, can)).join('')}</div>
      <p class="cc-checked">Данные за последние ${esc(data.days)} дн. · проверено ${esc(stamp(data.checkedAt))}</p>
      <details class="cc-legend"><summary>Как считается статус</summary><ul>
        <li>🟢 — за последние ${esc(data.days)} дн. есть данные из автоматического источника (Onlypult, API площадки, счётчик ЛК, заявки в CRM).</li>
        <li>🟡 — площадка настроена (аккаунт, постинг, ключ) или подтверждена владельцем, но свежих автоматических данных нет; либо данные только ручным вводом.</li>
        <li>🔴 — в ЛК нет ни настройки, ни данных. Ссылка из CRM сама по себе подключением не считается.</li>
        <li>«Подключить» открывает существующий ввод ключа; у площадок без такого ввода в ЛК (Метрика, Директ, YCLIENTS, Яндекс Карты, Telegram-бот, сайт) — только «Что нужно» в «Подробнее».</li>
        <li>${esc(data.note || '')}</li></ul></details></div>`;
    if (K) {
      const head = K.header({ title: 'Подключения', actions: ['sheet', 'sort'], sortOptions: SORTS,
        sortKey: 'content-connections', onSort: (id) => { state.sort = id; render(el, data, can); } });
      // Макет #conn: на ПК «Подключения», на телефоне «Площадки».
      const title = head.querySelector('.cfk-title');
      if (title) { title.innerHTML = '<span class="cc-t-pc">Подключения</span><span class="cc-t-ph">Площадки</span>'; head.classList.add('cc-head'); }
      el.querySelector('[data-cc-header]').replaceWith(head);
    }
  }

  /* Переход к существующей форме: экран монтируется асинхронно, поэтому ждём нужный узел до 8 с. */
  function reveal(doc, { route, details, target, focus, click }, navigate) {
    navigate(route);
    if (!target) return;
    const started = Date.now();
    const tick = () => {
      const box = details ? doc.querySelector(details) : null, node = target ? doc.querySelector(target) : null;
      if (box && !box.open && (node || Date.now() - started > 1500)) box.open = true;
      const button = node && click ? node.querySelector(click) : null;
      // Форма ещё грузится (кнопки выключены) — ждём; после 8 с только показываем место, без нажатия.
      if (node && (!click || (button && !button.disabled))) {
        if (box) box.open = true;
        node.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        if (button) button.click(); else node.querySelector(focus)?.focus?.();
        return;
      }
      if (Date.now() - started < 8000) setTimeout(tick, 200);
      else if (node) { node.scrollIntoView?.({ block: 'center' }); (button || node.querySelector(focus))?.focus?.(); }
    };
    setTimeout(tick, 120);
  }
  const ROUTES = {
    connect: (t) => ({ route: 'content/posting', details: '.autoposting-connections', target: `#autoposting-channels [data-channel="${t}"]`, focus: '[data-channel-field="token"]' }),
    check: (t) => ({ route: 'content/posting', details: '.autoposting-connections', target: `#autoposting-channels [data-channel="${t}"]`, click: '[data-check-channel]' }),
    stats: (t) => ({ route: 'social-stats', details: '.social-settings', target: `#social-accounts [data-platform="${t}"]`, focus: 'input,select' }),
    gis: () => ({ route: 'platform-demand', details: null, target: null }),
  };

  async function mount(el, ctx) {
    const can = (p) => (p === 'owner' ? ctx.user?.role === 'owner' : typeof ctx.can === 'function' ? ctx.can(p) : ctx.user?.role === 'owner');
    if (!can('autoposting.view') && !can('analytics.view')) { el.innerHTML = '<div class="card"><p>Подключения доступны по праву «Автопостинг: просмотр» или «Аналитика: просмотр».</p></div>'; return; }
    if (kit()) state.sort = window.CfKit.getSort?.('content-connections', SORTS) || 'status';
    el.innerHTML = '<p class="cc-loading" role="status">Загружаем подключения…</p>';
    const code = String(ctx.companyCode || '').toLowerCase();
    el.onclick = (event) => {
      const button = event.target.closest('[data-cc-act]');
      if (!button || button.disabled || typeof ctx.navigate !== 'function') return;
      const route = ROUTES[button.dataset.ccAct]?.(button.dataset.ccTarget);
      if (route) reveal(el.ownerDocument, route, ctx.navigate);
    };
    try {
      const data = await ctx.crm('/content-connections', { companyCode: code }, { signal: ctx.signal });
      if (ctx.signal?.aborted || String(data?.companyCode || '').toLowerCase() !== code) return;
      render(el, data, can);
    } catch (error) {
      if (ctx.signal?.aborted) return;
      el.innerHTML = `<div class="card cc-error" role="alert"><p>Подключения не загрузились: ${esc(error?.message || 'ошибка запроса')}.</p></div>`;
    }
  }
  function unmount(el) { el.onclick = null; }

  const definition = { title: 'Подключения', mount, unmount };
  (window.SbCabinet = window.SbCabinet || {}).contentConnections = { render, card, actions, sorted, definition, state, SORTS };
  const register = () => window.SynapseModules?.register?.('content-connections', definition);
  if (window.SynapseModules) register(); else document.addEventListener('DOMContentLoaded', register, { once: true });
})();
