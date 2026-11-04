(() => {
  'use strict';
  /* Контент → Статистика (контракт А, id content-stats). Читает существующий GET /social-stats (право
     analytics.view): сводная таблица по соцсетям + вкладки по площадкам. Метка у каждой цифры —
     LIVE (Onlypult/API), РУЧНОЙ ВВОД или НЕТ ДАННЫХ. Нет значения — «—», не ноль. Ничего не собирает. */
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(v) : '—');
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v.split('-').reverse().join('.') : '—');
  const PLATFORMS = [['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['youtube', 'YouTube'], ['vk', 'ВКонтакте'], ['telegram', 'Telegram']];
  const METRICS = { followers: 'Подписчики', follower_change: 'Прирост подписчиков', reach: 'Охват', impressions: 'Показы', views: 'Просмотры', profile_visits: 'Переходы в профиль', likes: 'Реакции', comments: 'Комментарии', shares: 'Репосты', saves: 'Сохранения', clicks: 'Клики', link_clicks: 'Переходы по ссылке', watch_time_seconds: 'Время просмотра, с', avg_watch_seconds: 'Среднее время, с', retention_percent: 'Удержание, %', posts_published: 'Публикаций' };
  const ENGAGEMENT = ['likes', 'comments', 'shares', 'saves'];
  const DAILY = ['views', 'reach', 'likes', 'comments', 'follower_change'];
  const isoDay = (offset) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offset * 86400000));
  const state = { days: 30, tab: 'summary' };

  /* Метка по фактическим провайдерам строк периода и последнего lifetime-замера. */
  function mode(p) {
    const providers = new Set();
    for (const metrics of Object.values(p?.days || {})) for (const m of Object.values(metrics)) if (m && m.value !== null) providers.add(m.provider);
    for (const m of Object.values(p?.latest || {})) if (m && m.value !== null) providers.add(m.provider);
    const live = [...providers].some((x) => x === 'onlypult' || x === 'direct'), manual = providers.has('manual');
    return live && manual ? ['mixed', 'LIVE + РУЧНОЙ ВВОД'] : live ? ['live', 'LIVE'] : manual ? ['manual', 'РУЧНОЙ ВВОД'] : ['none', 'НЕТ ДАННЫХ'];
  }
  const followers = (p) => (typeof p?.latest?.followers?.value === 'number' ? p.latest.followers.value : p?.totals?.followers ?? null);
  const engagement = (p) => { const v = ENGAGEMENT.map((m) => p?.totals?.[m]).filter((x) => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
  const badge = ([kind, text]) => `<span class="cs-badge cs-${kind}">${esc(text)}</span>`;

  function summary(data) {
    const rows = PLATFORMS.map(([id, label]) => { const p = data.platforms?.[id] || {};
      return `<tr data-cs-row="${id}"><th scope="row"><button type="button" class="cs-link" data-cs-tab="${id}">${esc(label)}</button></th>
        <td data-label="Подписчики">${num(followers(p))}</td><td data-label="Охват">${num(p.totals?.reach)}</td>
        <td data-label="Просмотры">${num(p.totals?.views)}</td><td data-label="Вовлечённость">${num(engagement(p))}</td>
        <td data-label="Источник">${badge(mode(p))}</td></tr>`; }).join('');
    const agg = data.socialAggregate || {}, eng = ENGAGEMENT.map((m) => agg[m]).filter((x) => typeof x === 'number');
    return `<div class="cs-table-wrap"><table class="cs-table" data-cs-summary><thead><tr><th>Площадка</th><th>Подписчики</th><th>Охват</th><th>Просмотры</th><th>Вовлечённость</th><th>Источник</th></tr></thead>
      <tbody>${rows}</tbody><tfoot><tr><th scope="row">Все соцсети</th><td data-label="Подписчики">не суммируются</td><td data-label="Охват">не суммируется</td>
      <td data-label="Просмотры">${num(agg.views)}</td><td data-label="Вовлечённость">${num(eng.length ? eng.reduce((a, b) => a + b, 0) : null)}</td><td></td></tr></tfoot></table></div>
      <p class="cs-note">Вовлечённость — сумма реакций, комментариев, репостов и сохранений там, где площадка их отдаёт. Охват разных площадок не складывается: один человек может быть на нескольких.</p>`;
  }

  function platformTab(data, id, label) {
    const p = data.platforms?.[id] || {}, totals = Object.entries(p.totals || {}).filter(([, v]) => typeof v === 'number');
    const dates = Object.keys(p.days || {}).sort().reverse();
    const missing = p.access?.missing?.length ? `<p class="cs-note">Чего не хватает: ${esc(p.access.missing.join('; '))}.</p>` : '';
    return `<section class="cs-platform" data-cs-platform="${id}"><h2>${esc(label)} ${badge(mode(p))}</h2>
      <p class="cs-note">Подписчики: <b>${num(followers(p))}</b>${p.latest?.followers?.date ? ` на ${day(p.latest.followers.date)}` : ''}. Последний сбор: ${p.lastRun ? `${esc(day(p.lastRun.date))}, ${esc(p.lastRun.status)}` : 'не запускался'}.</p>${missing}
      ${totals.length ? `<dl class="cs-totals">${totals.map(([m, v]) => `<div><dt>${esc(METRICS[m] || m)}</dt><dd>${num(v)}</dd></div>`).join('')}</dl>` : '<p class="cs-empty">За период данных нет.</p>'}
      ${dates.length ? `<div class="cs-table-wrap"><table class="cs-table cs-daily"><thead><tr><th>Дата</th>${DAILY.map((m) => `<th>${esc(METRICS[m])}</th>`).join('')}</tr></thead><tbody>
        ${dates.map((d) => `<tr><th scope="row">${day(d)}</th>${DAILY.map((m) => `<td data-label="${esc(METRICS[m])}">${num(p.days[d][m]?.value)}${p.days[d][m]?.provider === 'manual' ? ' <small>ручн.</small>' : ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}</section>`;
  }

  function render(el, data) {
    const tabs = [['summary', 'Сводка'], ...PLATFORMS];
    el.innerHTML = `<div class="cs-root"><div class="content-header"><h1>Статистика</h1>
      <p>Соцсети компании за ${day(data.from)}–${day(data.to)} (Бангкок). LIVE — собрано автоматически, РУЧНОЙ ВВОД — внесено вручную, НЕТ ДАННЫХ — цифр нет.</p></div>
      <div class="cs-toolbar"><label>Период <select data-cs-days>${[7, 14, 30, 90].map((d) => `<option value="${d}"${d === state.days ? ' selected' : ''}>${d} дн.</option>`).join('')}</select></label>
        <a class="plain-button" href="#content-factory/stats">По публикациям</a><a class="plain-button" href="#social-stats">Настроить сбор</a></div>
      <div class="cs-tabs" role="tablist">${tabs.map(([id, label]) => `<button type="button" role="tab" data-cs-tab="${id}" aria-selected="${id === state.tab}">${esc(label)}</button>`).join('')}</div>
      <div data-cs-body>${state.tab === 'summary' ? summary(data) : platformTab(data, state.tab, PLATFORMS.find(([id]) => id === state.tab)[1])}</div></div>`;
  }

  async function mount(el, ctx) {
    const can = (p) => (typeof ctx.can === 'function' ? ctx.can(p) : ctx.user?.role === 'owner');
    if (!can('analytics.view')) { el.innerHTML = '<div class="card"><p>Статистика соцсетей доступна по праву «Аналитика: просмотр». Статистика по публикациям — в <a href="#content-factory/stats">прежнем разделе</a>.</p></div>'; return; }
    const code = String(ctx.companyCode || '').toLowerCase();
    let data = null;
    const load = async () => {
      el.innerHTML = '<p class="cs-loading" role="status">Загружаем статистику…</p>';
      try {
        const result = await ctx.crm('/social-stats', { companyCode: code, from: isoDay(-(state.days - 1)), to: isoDay(0) }, { signal: ctx.signal });
        if (ctx.signal?.aborted || String(result?.companyCode || '').toLowerCase() !== code) return;
        data = result; render(el, data);
      } catch (error) {
        if (!ctx.signal?.aborted) el.innerHTML = `<div class="card" role="alert"><p>Статистика не загрузилась: ${esc(error?.message || 'ошибка запроса')}.</p></div>`;
      }
    };
    el.onclick = (event) => { const tab = event.target.closest('[data-cs-tab]'); if (tab && data) { state.tab = tab.dataset.csTab; render(el, data); } };
    el.onchange = (event) => { if (event.target.matches('[data-cs-days]')) { state.days = Number(event.target.value) || 30; void load(); } };
    await load();
  }
  function unmount(el) { el.onclick = null; el.onchange = null; }

  const definition = { title: 'Статистика', mount, unmount };
  (window.SbCabinet = window.SbCabinet || {}).contentStats = { render, mode, engagement, definition, state };
  const register = () => window.SynapseModules?.register?.('content-stats', definition);
  if (window.SynapseModules) register(); else document.addEventListener('DOMContentLoaded', register, { once: true });
})();
