(() => {
  'use strict';
  /* Контент → Подключения (контракт А, id content-connections). Только чтение GET /content-connections:
     статус площадки считает сервер по факту данных и настроек; ключи сюда не приходят — только «есть / нет». */
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (v) => (typeof v === 'string' && /^https?:\/\/[^\s<>"']+$/i.test(v) ? v : '');
  const STATUS = { green: ['🟢', 'Подключено'], yellow: ['🟡', 'Частично'], red: ['🔴', 'Не подключено'] };
  const MODE = { live: 'LIVE', manual: 'РУЧНОЙ ВВОД', none: 'НЕТ ДАННЫХ' };
  const stamp = (v) => (v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString('ru-RU', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' (Бангкок)' : '—');
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v.split('-').reverse().join('.') : '—');

  function card(p) {
    const [icon, word] = STATUS[p.status] || STATUS.red, href = safeUrl(p.link);
    return `<article class="cc-card cc-${esc(p.status)}" data-cc-platform="${esc(p.id)}" data-cc-status="${esc(p.status)}">
      <header><h3>${esc(p.label)}</h3><span class="cc-pill" title="${esc(word)}">${icon} ${esc(p.statusText)}</span></header>
      <p class="cc-meta"><span class="cc-mode cc-mode-${esc(p.dataMode)}">${esc(MODE[p.dataMode] || MODE.none)}</span>
        ${p.lastDataDate ? `данные по ${esc(day(p.lastDataDate))}` : 'данных в ЛК нет'}</p>
      ${p.facts?.length ? `<ul class="cc-facts">${p.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
      ${p.next ? `<p class="cc-next"><b>Что нужно:</b> ${esc(p.next)}</p>` : ''}
      <p class="cc-link">${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">Открыть площадку ↗</a>` : '<span>Ссылки в CRM нет</span>'}</p>
    </article>`;
  }

  function render(el, data) {
    const count = (s) => data.platforms.filter((p) => p.status === s).length;
    el.innerHTML = `<div class="cc-root"><div class="content-header"><h1>Подключения</h1>
      <p>Площадки компании и что из них реально приходит в ЛК за последние ${esc(data.days)} дн. Проверено ${esc(stamp(data.checkedAt))}.</p></div>
      <p class="cc-summary" data-cc-summary>🟢 ${count('green')} подключено · 🟡 ${count('yellow')} частично · 🔴 ${count('red')} не подключено</p>
      <div class="cc-grid">${data.platforms.map(card).join('')}</div>
      <details class="cc-legend card"><summary>Как считается статус</summary><ul>
        <li>🟢 — за последние ${esc(data.days)} дн. есть данные из автоматического источника (Onlypult, API площадки, счётчик ЛК, заявки в CRM).</li>
        <li>🟡 — площадка настроена (аккаунт, постинг, ключ) или подтверждена владельцем, но свежих автоматических данных нет; либо данные только ручным вводом.</li>
        <li>🔴 — в ЛК нет ни настройки, ни данных. Ссылка из CRM сама по себе подключением не считается.</li>
        <li>${esc(data.note || '')}</li></ul></details></div>`;
  }

  async function mount(el, ctx) {
    const can = (p) => (typeof ctx.can === 'function' ? ctx.can(p) : ctx.user?.role === 'owner');
    if (!can('autoposting.view') && !can('analytics.view')) { el.innerHTML = '<div class="card"><p>Подключения доступны по праву «Автопостинг: просмотр» или «Аналитика: просмотр».</p></div>'; return; }
    el.innerHTML = '<p class="cc-loading" role="status">Загружаем подключения…</p>';
    const code = String(ctx.companyCode || '').toLowerCase();
    try {
      const data = await ctx.crm('/content-connections', { companyCode: code }, { signal: ctx.signal });
      if (ctx.signal?.aborted || String(data?.companyCode || '').toLowerCase() !== code) return;
      render(el, data);
    } catch (error) {
      if (ctx.signal?.aborted) return;
      el.innerHTML = `<div class="card cc-error" role="alert"><p>Подключения не загрузились: ${esc(error?.message || 'ошибка запроса')}.</p></div>`;
    }
  }

  const definition = { title: 'Подключения', mount };
  (window.SbCabinet = window.SbCabinet || {}).contentConnections = { render, card, definition };
  const register = () => window.SynapseModules?.register?.('content-connections', definition);
  if (window.SynapseModules) register(); else document.addEventListener('DOMContentLoaded', register, { once: true });
})();
