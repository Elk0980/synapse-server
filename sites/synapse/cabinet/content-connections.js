(() => {
  'use strict';
  /* Контент → Подключения (контракт А, id content-connections). Статусы — только чтение GET /content-connections:
     статус площадки считает сервер по факту данных и настроек; ключи сюда не приходят — только «есть / нет».
     №149 (решение Влада 05.11.2026): блок «Подключение площадок» (ключ Onlypult, профили, токен Telegram, ключ ВК,
     автоотправка, «Сохранить», «Проверить») живёт только здесь — тем же компонентом cabinet.channelsPanel из
     autoposting.js, без свёрток; «Постинг» ведёт сюда ссылкой. */
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (v) => (typeof v === 'string' && /^https?:\/\/[^\s<>"']+$/i.test(v) ? v : '');
  const STATUS = { green: ['🟢', 'Подключено'], yellow: ['🟡', 'Частично'], red: ['🔴', 'Не подключено'] };
  const MODE = { live: 'LIVE', manual: 'РУЧНОЙ ВВОД', none: 'НЕТ ДАННЫХ' };
  const stamp = (v) => (v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString('ru-RU', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' (Бангкок)' : '—');
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v.split('-').reverse().join('.') : '—');

  /* Куда ведёт кнопка «Подключить»/«Настроить»: channel — форма площадки в блоке ниже на этом же экране
     (id канала настроек постинга); href — другой экран кабинета, где поле уже есть (2ГИС — организация в
     «Потенциале 2ГИС»). Метрика, Директ, Карты, YCLIENTS, Telegram-бот, сайт — поля ввода в ЛК нет, кнопки нет. */
  const SETUP = Object.freeze({
    instagram: { channel: 'instagram', need: 'autoposting.view' },
    tiktok: { channel: 'tiktok', need: 'autoposting.view' },
    youtube: { channel: 'youtube_shorts', need: 'autoposting.view' },
    vk: { channel: 'vk', need: 'autoposting.view' },
    telegram_channel: { channel: 'telegram', need: 'autoposting.view' },
    max: { channel: 'max', need: 'autoposting.view' },
    two_gis: { href: '#platform-demand', need: 'analytics.view' },
  });
  function setupLink(p, can) {
    const target = SETUP[p.id];
    if (!target || !can(target.need)) return '';
    const text = p.status === 'red' ? 'Подключить' : 'Настроить';
    if (target.href) return `<a class="plain-button cc-setup" href="${esc(target.href)}" data-cc-setup="${esc(p.id)}">${text}</a>`;
    return `<button type="button" class="plain-button cc-setup" data-cc-setup="${esc(p.id)}" data-cc-channel="${esc(target.channel)}">${text}</button>`;
  }

  function card(p, can = () => true) {
    const [icon, word] = STATUS[p.status] || STATUS.red, href = safeUrl(p.link);
    return `<article class="cc-card cc-${esc(p.status)}" data-cc-platform="${esc(p.id)}" data-cc-status="${esc(p.status)}">
      <header><h3>${esc(p.label)}</h3><span class="cc-pill" title="${esc(word)}">${icon} ${esc(p.statusText)}</span></header>
      <p class="cc-meta"><span class="cc-mode cc-mode-${esc(p.dataMode)}">${esc(MODE[p.dataMode] || MODE.none)}</span>
        ${p.lastDataDate ? `данные по ${esc(day(p.lastDataDate))}` : 'данных в ЛК нет'}</p>
      ${p.facts?.length ? `<ul class="cc-facts">${p.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
      ${p.next ? `<p class="cc-next"><b>Что нужно:</b> ${esc(p.next)}</p>` : ''}
      <p class="cc-link cc-actions">${setupLink(p, can)}${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">Открыть площадку ↗</a>` : '<span>Ссылки в CRM нет</span>'}</p>
    </article>`;
  }

  function render(el, data, can = () => true) {
    const count = (s) => data.platforms.filter((p) => p.status === s).length;
    el.innerHTML = `<div class="cc-root"><div class="content-header"><h1>Подключения</h1>
      <p>Площадки компании и что из них реально приходит в ЛК за последние ${esc(data.days)} дн. Проверено ${esc(stamp(data.checkedAt))}.</p></div>
      <p class="cc-summary" data-cc-summary>🟢 ${count('green')} подключено · 🟡 ${count('yellow')} частично · 🔴 ${count('red')} не подключено</p>
      <div class="cc-grid">${data.platforms.map((p) => card(p, can)).join('')}</div>
      ${can('autoposting.view') ? '<section class="cc-channels card" data-cc-channels aria-labelledby="cc-channels-title"><h2 id="cc-channels-title">Подключение площадок</h2><div data-cc-channels-host></div></section>' : ''}
      <details class="cc-legend card"><summary>Как считается статус</summary><ul>
        <li>🟢 — за последние ${esc(data.days)} дн. есть данные из автоматического источника (Onlypult, API площадки, счётчик ЛК, заявки в CRM).</li>
        <li>🟡 — площадка настроена (аккаунт, постинг, ключ) или подтверждена владельцем, но свежих автоматических данных нет; либо данные только ручным вводом.</li>
        <li>🔴 — в ЛК нет ни настройки, ни данных. Ссылка из CRM сама по себе подключением не считается.</li>
        <li>${esc(data.note || '')}</li></ul></details></div>`;
  }

  /* Кнопка карточки прокручивает к форме площадки в блоке ниже и ставит курсор в первое поле.
     Формы ещё нет (не загрузилось, нет права) — показываем сам блок. */
  function bindSetup(el) {
    el.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-cc-channel]');
      if (!button) return;
      const form = [...el.querySelectorAll('[data-cc-channels-host] [data-channel]')].find((node) => node.dataset.channel === button.dataset.ccChannel);
      const target = form || el.querySelector('[data-cc-channels]');
      if (!target) return;
      target.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      const field = form?.querySelector('[data-channel-field="target"],[data-channel-field="token"]');
      if (field && !field.disabled) field.focus({ preventScroll: true });
    });
  }

  function mountChannels(el, ctx) {
    const host = el.querySelector('[data-cc-channels-host]'), factory = window.SbCabinet?.channelsPanel?.create;
    if (!host) return null;
    if (typeof factory !== 'function') { host.innerHTML = '<p class="cc-note">Блок подключения площадок не загрузился. Обновите страницу.</p>'; return null; }
    const api = (path, method, body) => {
      const rel = 'crm' + path;
      if (method === 'PUT') return ctx.api.put(rel, body);
      if (method === 'POST') return ctx.api.post(rel, body);
      return ctx.api.get(rel);
    };
    const panel = factory(host, {
      request: api,
      role: () => ctx.user?.role || '',
      canEdit: () => (typeof ctx.can === 'function' ? ctx.can('autoposting.edit') : ctx.user?.role === 'owner'),
      companyCode: () => ctx.companyCode,
      companyName: () => ctx.companyName || '',
    });
    panel.ready = panel.load();
    return panel;
  }

  async function mount(el, ctx) {
    const can = (p) => (typeof ctx.can === 'function' ? ctx.can(p) : ctx.user?.role === 'owner');
    if (!can('autoposting.view') && !can('analytics.view')) { el.innerHTML = '<div class="card"><p>Подключения доступны по праву «Автопостинг: просмотр» или «Аналитика: просмотр».</p></div>'; return; }
    el.innerHTML = '<p class="cc-loading" role="status">Загружаем подключения…</p>';
    const code = String(ctx.companyCode || '').toLowerCase();
    let panel = null;
    ctx.signal?.addEventListener?.('abort', () => panel?.destroy(), { once: true });
    try {
      const data = await ctx.crm('/content-connections', { companyCode: code }, { signal: ctx.signal });
      if (ctx.signal?.aborted || String(data?.companyCode || '').toLowerCase() !== code) return;
      render(el, data, can);
      bindSetup(el);
      panel = mountChannels(el, ctx);
      await panel?.ready;
    } catch (error) {
      if (ctx.signal?.aborted) return;
      el.innerHTML = `<div class="card cc-error" role="alert"><p>Подключения не загрузились: ${esc(error?.message || 'ошибка запроса')}.</p></div>`;
      if (can('autoposting.view')) {
        el.insertAdjacentHTML('beforeend', '<section class="cc-channels card" data-cc-channels aria-labelledby="cc-channels-title"><h2 id="cc-channels-title">Подключение площадок</h2><div data-cc-channels-host></div></section>');
        panel = mountChannels(el, ctx);
        await panel?.ready;
      }
    }
  }

  const definition = { title: 'Подключения', mount };
  (window.SbCabinet = window.SbCabinet || {}).contentConnections = { render, card, definition };
  const register = () => window.SynapseModules?.register?.('content-connections', definition);
  if (window.SynapseModules) register(); else document.addEventListener('DOMContentLoaded', register, { once: true });
})();
