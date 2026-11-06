(() => {
  'use strict';
  /* Контент → Статистика (контракт А, id content-stats). Читает существующий GET /social-stats (право
     analytics.view): площадки компании + публикации (crm.posts — заявки, postMetrics — последние измерения поста).
     Макет Влада 07.11: шапка CfKit (календарь, ▦, ⇅ — дата публикации, просмотры, вовлечённость, заявки), полоса дат,
     вкладки «Сводная» + площадки. Сюда перенесена таблица публикаций прежней «По публикациям».
     Только реальные числа: нет значения — «—» с пометкой, не ноль. Ничего не собирает и не запускает. */
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(v) : '—');
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v.split('-').reverse().join('.') : '—');
  const PLATFORMS = [['instagram', 'Instagram', 'IG'], ['tiktok', 'TikTok', 'TT'], ['youtube', 'YouTube', 'YT'], ['vk', 'ВКонтакте', 'VK'], ['telegram', 'Telegram', 'TG']];
  const METRICS = { followers: 'Подписчики', follower_change: 'Прирост подписчиков', reach: 'Охват', impressions: 'Показы', views: 'Просмотры', profile_visits: 'Переходы в профиль', likes: 'Реакции', comments: 'Комментарии', shares: 'Репосты', saves: 'Сохранения', clicks: 'Клики', link_clicks: 'Переходы по ссылке', watch_time_seconds: 'Время просмотра, с', avg_watch_seconds: 'Среднее время, с', retention_percent: 'Удержание, %', posts_published: 'Публикаций' };
  const ENGAGEMENT = ['likes', 'comments', 'shares', 'saves'];
  const DAILY = ['views', 'reach', 'likes', 'comments', 'follower_change'];
  const SORTS = [{ id: 'date', label: 'Дата публикации' }, { id: 'views', label: 'Просмотры' }, { id: 'engagement', label: 'Вовлечённость' }, { id: 'leads', label: 'Заявки' }];
  const TZ = 'Asia/Bangkok';
  const isoDay = (offset) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offset * 86400000));
  const localDay = (iso) => { const ms = Date.parse(String(iso || '')); return Number.isFinite(ms) ? new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)) : ''; };
  const RUN = { ok: 'успешно', partial: 'частично', missing_access: 'нет доступа', unsupported: 'не поддерживается', failed: 'ошибка' };
  const kit = () => (typeof window !== 'undefined' && window.CfKit && typeof window.CfKit.header === 'function' ? window.CfKit : null);
  const state = { days: 30, tab: 'summary', sort: 'date', calOpen: false, strip: null };
  const NO_DATA = 'нет данных с площадки';

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
  const sum = (list) => { const v = list.filter((x) => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
  const cellNum = (v, note = NO_DATA) => (typeof v === 'number' ? num(v) : `<span class="cs-dash" title="${esc(note)}">—</span>`);

  /* Публикации: строки attribution (crm.posts — ссылка, дата, заявки, карточка) + последние измерения поста (postMetrics).
     Значения разных источников одного адреса не складываются: берётся первое (свежая запись) и это помечается. */
  const postKey = (p) => `${p.platform}|${p.url || ''}|${p.publishedAt || ''}`;
  function measured(post) {
    const values = new Map(), multi = new Set();
    for (const source of post?.sources || []) for (const m of source.measurements || []) {
      if (!m || !m.hasValue || typeof m.value !== 'number') continue;
      if (values.has(m.metric)) { if (values.get(m.metric) !== m.value) multi.add(m.metric); continue; }
      values.set(m.metric, m.value);
    }
    const get = (metric) => (values.has(metric) ? values.get(metric) : null);
    return { views: get('views'), engagement: sum(ENGAGEMENT.map(get)), multi: multi.size > 0, receiptOnly: Boolean(post?.receiptOnly) };
  }
  function publications(data, titles = new Map()) {
    const byKey = new Map((data.postMetrics?.posts || []).map((p) => [postKey(p), p]));
    const base = Array.isArray(data.crm?.posts) ? data.crm.posts : (data.postMetrics?.posts || []);
    const posts = base.map((p) => {
      const m = measured(byKey.get(postKey(p)));
      const leads = p.attribution === 'exact' ? Number(p.leads) || 0 : p.attribution === 'none_in_period' ? 0 : null;
      return { platform: p.platform, url: p.url, date: localDay(p.publishedAt), views: m.views, engagement: m.engagement, multi: m.multi,
        receiptOnly: m.receiptOnly || p.provenance === 'external_receipt', leads, leadsKnown: leads !== null,
        autopostingId: Number.isSafeInteger(p.autopostingId) && p.autopostingId > 0 ? p.autopostingId : null };
    });
    // Один материал на нескольких площадках — одна строка «рилса»; без связанной карточки — строка на публикацию.
    const rows = [], byCard = new Map();
    for (const post of posts) {
      if (post.autopostingId && byCard.has(post.autopostingId)) { byCard.get(post.autopostingId).posts.push(post); continue; }
      const row = { id: post.autopostingId ? `card:${post.autopostingId}` : `post:${rows.length}`, autopostingId: post.autopostingId, posts: [post] };
      rows.push(row);
      if (post.autopostingId) byCard.set(post.autopostingId, row);
    }
    for (const row of rows) {
      row.date = row.posts.map((p) => p.date).filter(Boolean).sort()[0] || '';
      row.views = sum(row.posts.map((p) => p.views));
      row.engagement = sum(row.posts.map((p) => p.engagement));
      row.leads = sum(row.posts.map((p) => p.leads));
      row.title = (row.autopostingId && titles.get(row.autopostingId)) || (row.autopostingId ? `Материал №${row.autopostingId}` : `Публикация ${PLATFORMS.find(([id]) => id === row.posts[0].platform)?.[1] || row.posts[0].platform}`);
    }
    return { rows, posts };
  }
  function order(rows, sort) {
    const val = (row) => (sort === 'date' ? row.date || '' : row[sort]);
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b), xn = x === null || x === '', yn = y === null || y === '';
      if (xn || yn) return xn === yn ? 0 : xn ? 1 : -1;
      return sort === 'date' ? (x < y ? 1 : x > y ? -1 : 0) : y - x;
    });
  }

  function accounts(data) {
    const rows = PLATFORMS.map(([id, label]) => { const p = data.platforms?.[id] || {};
      return `<tr data-cs-row="${id}"><th scope="row"><button type="button" class="cs-link" data-cs-tab="${id}">${esc(label)}</button></th>
        <td data-label="Подписчики">${num(followers(p))}</td><td data-label="Охват">${num(p.totals?.reach)}</td>
        <td data-label="Просмотры">${num(p.totals?.views)}</td><td data-label="Вовлечённость">${num(engagement(p))}</td>
        <td data-label="Источник">${badge(mode(p))}</td></tr>`; }).join('');
    const agg = data.socialAggregate || {}, eng = ENGAGEMENT.map((m) => agg[m]).filter((x) => typeof x === 'number');
    // На ПК сводка площадок раскрыта; на телефоне свёрнута, чтобы первыми были публикации (как в макете).
    const wide = typeof window.matchMedia !== 'function' || !window.matchMedia('(max-width: 640px)').matches;
    return `<details class="cs-acc"${wide ? ' open' : ''}><summary class="cs-sub">Площадки за период</summary><div class="cs-table-wrap"><table class="cs-table" data-cs-summary><thead><tr><th>Площадка</th><th>Подписчики</th><th>Охват</th><th>Просмотры</th><th>Вовлечённость</th><th>Источник</th></tr></thead>
      <tbody>${rows}</tbody><tfoot><tr><th scope="row">Все соцсети</th><td data-label="Подписчики">не суммируются</td><td data-label="Охват">не суммируется</td>
      <td data-label="Просмотры">${num(agg.views)}</td><td data-label="Вовлечённость">${num(eng.length ? eng.reduce((a, b) => a + b, 0) : null)}</td><td></td></tr></tfoot></table></div></details>`;
  }

  function pubTable(rows, platformId) {
    if (!rows.length) return `<p class="cs-empty" data-cs-pubs-empty>${platformId ? 'Публикаций этой площадки в ЛК нет' : 'Известных публикаций в ЛК нет'} — сбор публикаций не подключён или ещё ничего не вышло.</p>`;
    const cols = platformId ? [] : PLATFORMS;
    const head = `<tr><th scope="col">Рилс</th><th scope="col">Дата</th>${cols.map(([, label, short]) => `<th scope="col" class="cs-pf" title="Просмотры: ${esc(label)}">${esc(label)}</th>`).join('')}<th scope="col">Просмотры</th><th scope="col">Вовлечённость</th><th scope="col">Заявки</th></tr>`;
    const body = rows.map((row) => {
      const posts = platformId ? row.posts.filter((p) => p.platform === platformId) : row.posts;
      const link = posts.length === 1 && /^https:\/\//.test(posts[0].url || '') ? ` <a href="${esc(posts[0].url)}" target="_blank" rel="noopener noreferrer" class="cs-out" title="Открыть публикацию">↗</a>` : '';
      const multi = posts.some((p) => p.multi) ? ' <small title="У публикации несколько источников с разными значениями: показано свежее, значения не складываются">*</small>' : '';
      const note = posts.every((p) => p.receiptOnly) ? 'подтверждение выхода без статистики площадки' : NO_DATA;
      const per = cols.map(([id, label]) => { const list = posts.filter((p) => p.platform === id);
        return `<td class="cs-pf" data-label="${esc(label)}">${list.length ? cellNum(sum(list.map((p) => p.views)), note) : '<span class="cs-nopub" title="Не публиковалось">·</span>'}</td>`; }).join('');
      const leads = sum(posts.map((p) => p.leads));
      return `<tr data-cs-pub="${esc(row.id)}" data-date="${esc(row.date)}"><th scope="row">${esc(row.title)}${link}</th><td data-label="Дата">${esc(day(row.date))}</td>${per}
        <td data-label="Просмотры">${cellNum(sum(posts.map((p) => p.views)), note)}${multi}</td><td data-label="Вовлечённость">${cellNum(sum(posts.map((p) => p.engagement)), note)}</td>
        <td data-label="Заявки">${cellNum(leads, 'связь публикации с заявками не подтверждена')}</td></tr>`;
    }).join('');
    return `<div class="cs-table-wrap"><table class="cs-table cs-pubs" data-cs-pubs><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  }

  function platformTab(data, id, label, pubs) {
    const p = data.platforms?.[id] || {}, totals = Object.entries(p.totals || {}).filter(([, v]) => typeof v === 'number');
    const dates = Object.keys(p.days || {}).sort().reverse();
    const missing = p.access?.missing?.length ? `<p class="cs-note">Чего не хватает: ${esc(p.access.missing.join('; '))}.</p>` : '';
    const rows = order(pubs.rows.filter((row) => row.posts.some((x) => x.platform === id)).map((row) => {
      const own = row.posts.filter((x) => x.platform === id);
      return { ...row, views: sum(own.map((x) => x.views)), engagement: sum(own.map((x) => x.engagement)), leads: sum(own.map((x) => x.leads)) };
    }), state.sort);
    return `<section class="cs-platform" data-cs-platform="${id}"><h3 class="cs-sub">${esc(label)} ${badge(mode(p))}</h3>
      <p class="cs-note">Подписчики: <b>${num(followers(p))}</b>${p.latest?.followers?.date ? ` на ${day(p.latest.followers.date)}` : ''}. Последний сбор: ${p.lastRun ? `${esc(day(p.lastRun.date))}, ${esc(RUN[p.lastRun.status] || p.lastRun.status)}` : 'не запускался'}.</p>${missing}
      ${totals.length ? `<dl class="cs-totals">${totals.map(([m, v]) => `<div><dt>${esc(METRICS[m] || m)}</dt><dd>${num(v)}</dd></div>`).join('')}</dl>` : '<p class="cs-empty">За период данных нет.</p>'}
      <h3 class="cs-sub">Публикации</h3>${pubTable(rows, id)}
      ${dates.length ? `<details class="cs-days-box"><summary>По дням</summary><div class="cs-table-wrap"><table class="cs-table cs-daily"><thead><tr><th>Дата</th>${DAILY.map((m) => `<th>${esc(METRICS[m])}</th>`).join('')}</tr></thead><tbody>
        ${dates.map((d) => `<tr><th scope="row">${day(d)}</th>${DAILY.map((m) => `<td data-label="${esc(METRICS[m])}">${num(p.days[d][m]?.value)}${p.days[d][m]?.provider === 'manual' ? ' <small>ручн.</small>' : ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>` : ''}</section>`;
  }

  function render(el, data, titles = new Map()) {
    const tabs = [['summary', 'Сводная', 'Все'], ...PLATFORMS];
    const pubs = publications(data, titles), K = kit();
    const body = state.tab === 'summary'
      ? `<h3 class="cs-sub">Публикации</h3>${pubTable(order(pubs.rows, state.sort), '')}${accounts(data)}`
      : platformTab(data, state.tab, PLATFORMS.find(([id]) => id === state.tab)[1], pubs);
    el.innerHTML = `<div class="cs-root">${K ? '<div data-cs-header></div><div data-cs-dates></div>' : '<div class="content-header"><h1>Статистика</h1></div>'}
      <div class="cs-tabs" role="tablist">${tabs.map(([id, label, short]) => `<button type="button" role="tab" data-cs-tab="${id}" aria-selected="${id === state.tab}"><span class="cs-long">${esc(label)}</span><span class="cs-short" aria-hidden="true">${esc(short)}</span></button>`).join('')}</div>
      <div data-cs-body>${body}</div>
      <div class="cs-toolbar"><label>Период измерений <select data-cs-days>${[7, 14, 30, 90].map((d) => `<option value="${d}"${d === state.days ? ' selected' : ''}>${d} дн.</option>`).join('')}</select></label>
        <span class="cs-note">${day(data.from)}–${day(data.to)} (Бангкок)</span><a class="plain-button" href="#social-stats">Настроить сбор</a></div>
      <p class="cs-note">«—» — данных с площадки нет (нет доступа или сбор не подключён), это не ноль. Просмотры и вовлечённость публикации — последнее измерение за период; вовлечённость — реакции, комментарии, репосты и сохранения там, где площадка их отдаёт. Заявки — связанные с публикацией по ссылке или метке, сутки по UTC. Охват разных площадок не складывается. Публикации — последние известные (до 200), не только за период.</p></div>`;
    if (K) mountKit(el, K, pubs);
  }

  /* Шапка и полоса дат CfKit: полоса живёт между перерисовками; день из полосы прокручивает таблицу к его публикациям. */
  function mountKit(el, K, pubs) {
    el.querySelector('[data-cs-header]')?.replaceWith(K.header({ title: 'Статистика', actions: ['calendar', 'sheet', 'sort'], sortOptions: SORTS,
      sortKey: 'content-stats', calendarOpen: state.calOpen, onSort: (id) => { state.sort = id; state.redraw?.(); },
      onCalendar: (open) => { state.calOpen = open; state.strip?.setOpen(open); } }));
    const marked = new Set(pubs.posts.map((p) => p.date).filter(Boolean));
    if (!state.strip) state.strip = K.dateStrip({ tz: 'Время: Бангкок', timeZone: TZ, marked, selected: new Date(), onSelect: (date) => jumpTo(el, K.dayKey(date)) });
    else state.strip.setMarked(marked);
    const slot = el.querySelector('[data-cs-dates]');
    if (slot) { slot.replaceWith(state.strip); state.strip.setOpen(state.calOpen); }
  }
  function jumpTo(el, key) {
    const rows = [...el.querySelectorAll('[data-cs-pub]')];
    const row = rows.find((r) => r.dataset.date === key) || (state.sort === 'date' ? rows.find((r) => r.dataset.date && r.dataset.date <= key) : null);
    if (!row) return;
    rows.forEach((r) => r.classList.remove('cs-hit'));
    row.classList.add('cs-hit');
    row.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }

  async function mount(el, ctx) {
    const can = (p) => (typeof ctx.can === 'function' ? ctx.can(p) : ctx.user?.role === 'owner');
    if (!can('analytics.view')) { el.innerHTML = '<div class="card"><p>Статистика доступна по праву «Аналитика: просмотр».</p></div>'; return; }
    state.strip = null;
    if (kit()) state.sort = window.CfKit.getSort?.('content-stats', SORTS) || 'date';
    const code = String(ctx.companyCode || '').toLowerCase();
    let data = null, titles = new Map(), epoch = 0;
    state.redraw = () => { if (data) render(el, data, titles); };
    const load = async () => {
      const mine = ++epoch;
      el.innerHTML = '<p class="cs-loading" role="status">Загружаем статистику…</p>';
      const from = isoDay(-(state.days - 1)), to = isoDay(0);
      try {
        // Названия рилсов — из календаря материалов (право просмотра контента, сервер отдаёт не больше 31 дня);
        // старше или без права — «Материал №…».
        const [result, calendar] = await Promise.all([
          ctx.crm('/social-stats', { companyCode: code, from, to }, { signal: ctx.signal }),
          can('autoposting.view') ? ctx.crm('/autoposting/calendar', { companyCode: code, from: isoDay(-30), to }, { signal: ctx.signal }).catch(() => null) : null]);
        if (mine !== epoch || ctx.signal?.aborted || String(result?.companyCode || '').toLowerCase() !== code) return;
        titles = new Map();
        if (calendar && String(calendar.companyCode || '').toLowerCase() === code) {
          for (const post of [...(calendar.posts || []), ...(calendar.undatedPosts || [])]) if (post?.id && post.title) titles.set(post.id, String(post.title));
        }
        data = result; render(el, data, titles);
      } catch (error) {
        if (mine === epoch && !ctx.signal?.aborted) el.innerHTML = `<div class="card" role="alert"><p>Статистика не загрузилась: ${esc(error?.message || 'ошибка запроса')}.</p></div>`;
      }
    };
    el.onclick = (event) => { const tab = event.target.closest('[data-cs-tab]'); if (tab && data) { state.tab = tab.dataset.csTab; render(el, data, titles); } };
    el.onchange = (event) => { if (event.target.matches('[data-cs-days]')) { state.days = Number(event.target.value) || 30; void load(); } };
    await load();
  }
  function unmount(el) { el.onclick = null; el.onchange = null; state.strip = null; state.redraw = null; }

  const definition = { title: 'Статистика', mount, unmount };
  (window.SbCabinet = window.SbCabinet || {}).contentStats = { render, mode, engagement, publications, order, definition, state, SORTS };
  const register = () => window.SynapseModules?.register?.('content-stats', definition);
  if (window.SynapseModules) register(); else document.addEventListener('DOMContentLoaded', register, { once: true });
})();
