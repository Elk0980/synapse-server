(() => {
  'use strict';
  /* Сводка соцсетей и атрибуция CRM. Правила отображения: нет данных — «—», не 0; уникальный охват не суммируется;
     статусы доступа показываются честно с перечнем того, чего недостаёт; ключи в интерфейс не попадают. */
  const sb = window.SbCabinet = window.SbCabinet || {};
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = value => (typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value) : '—');
  const stamp = value => (value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ru-RU', { timeZone: 'Asia/Bangkok' }) + ' (Бангкок)' : '—');
  const day = value => (/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? value.split('-').reverse().join('.') : '—');
  const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'vk', 'telegram'];
  const METRIC_LABELS = { followers: 'Подписчики', follower_change: 'Прирост подписчиков', reach: 'Охват', impressions: 'Показы', views: 'Просмотры', profile_visits: 'Переходы в профиль', likes: 'Реакции', comments: 'Комментарии', shares: 'Репосты', saves: 'Сохранения', clicks: 'Клики', link_clicks: 'Переходы по ссылке', watch_time_seconds: 'Время просмотра, с', avg_watch_seconds: 'Среднее время, с', retention_percent: 'Удержание, %', posts_published: 'Публикаций' };
  const ACCESS = { ok: 'данные собираются', not_configured: 'аккаунт не настроен', missing_access: 'нет доступа', unsupported: 'не поддерживается', depends_on_connection: 'зависит от подключения площадки', manual: 'ручной ввод' };
  const RUN = { ok: 'собрано', partial: 'собрано частично', missing_access: 'нет доступа', unsupported: 'не поддерживается', failed: 'ошибка сбора' };
  const KIND = { organic: 'органика', paid: 'реклама', mixed: 'смешано', unknown: 'не размечено' };
  const PROVIDER = { direct: 'прямой API', onlypult: 'Onlypult (временно)', manual: 'ручной ввод' };
  /* Подписи источника записи в атрибуции: ручной ввод не называется сбором по API, подтверждение владельца — тем более. */
  const POST_SOURCE = { direct: 'Прямой API площадки', onlypult: 'Onlypult (временно)', manual: 'Ручной ввод, не сбор по API' };
  const CONFIDENCE = { utm: 'UTM-метка', url: 'URL поста' };
  /* В интерфейс уходят только деловые http(s)-ссылки: адрес с иной схемой (javascript:, data:) или с пробелами и кавычками ссылкой не становится. */
  const safeUrl = value => { const raw = String(value ?? '').trim(); return /^https?:\/\/[^\s<>"']+$/i.test(raw) ? raw : ''; };
  const link = (url, text, extra = '') => { const href = safeUrl(url); return href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer"${extra}>${esc(text)}</a>` : esc(text); };
  const allowed = (ctx, write = false) => ctx.identity?.role === 'owner' || (!write && ctx.identity?.permissions?.includes('analytics.view'));
  const isoDay = (offset = 0) => { const d = new Date(Date.now() + offset * 86400000); return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); };
  let requestId = 0;
  const state = { from: isoDay(-29), to: isoDay(0) };

  function render(container, ctx) {
    if (!allowed(ctx)) { container.replaceChildren(); return; }
    const owner = ctx.identity?.role === 'owner';
    container.innerHTML = `<div class="content-header"><h1>Соцсети</h1><p>Ежедневные снимки по площадкам выбранной компании и связь с обращениями CRM. Данных нет — показываем «—», не ноль. Часовой пояс: Asia/Bangkok.</p></div>
      <div class="card social-toolbar"><label>С <input type="date" id="social-from" value="${esc(state.from)}"></label><label>По <input type="date" id="social-to" value="${esc(state.to)}"></label>
        <button type="button" class="plain-button" id="social-refresh">Показать</button></div>
      <div id="social-content" aria-live="polite"><p>Загрузка…</p></div>
      ${owner ? `<details class="card social-settings"><summary>Аккаунты и источники (владелец)</summary><p class="social-note">Здесь только идентификаторы аккаунтов и выбор источника. Ключи и права живут в подключениях площадок (Автопостинг) или у провайдера; сюда их вводить нельзя.</p><div id="social-accounts"></div></details>
      <details class="card social-import"><summary>Ручной ввод реальных чисел (владелец)</summary><p class="social-note">Для площадок без API-доступа: числа из кабинета площадки с датой снятия и источником (скриншот, выгрузка). Это не автоматический сбор и не заглушка — без чисел строка не сохраняется.</p>
        <form id="social-import-form" class="crm-form"><label>Площадка<select name="platform">${PLATFORMS.map(p => `<option value="${p}">${p}</option>`).join('')}</select></label>
        <label>Момент снятия<input name="capturedAt" type="datetime-local" required></label><label class="wide">Источник<input name="sourceNote" required maxlength="300" placeholder="скриншот Insights 18.09"></label>
        <label class="wide">Строки JSON<textarea name="rows" rows="4" placeholder='[{"date":"2026-09-17","metric":"views","value":900}]'></textarea></label>
        <div class="crm-actions wide"><button class="plain-button" type="submit">Сохранить снимок</button><span id="social-import-state" role="status"></span></div></form></details>` : ''}`;
    const load = async () => {
      const id = ++requestId, company = ctx.selectedProjectId, from = container.querySelector('#social-from').value, to = container.querySelector('#social-to').value;
      state.from = from; state.to = to;
      const content = container.querySelector('#social-content');
      try {
        const [data, accounts] = await Promise.all([
          ctx.apiJson(`/content/crm/social-stats?companyCode=${encodeURIComponent(company)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
          owner ? ctx.apiJson(`/content/crm/social-stats/accounts?companyCode=${encodeURIComponent(company)}`) : null,
        ]);
        if (id !== requestId || ctx.selectedProjectId !== company) return;
        if (data.companyCode !== String(company).toLowerCase()) throw new Error('Ответ другой компании');
        content.innerHTML = overviewMarkup(data);
        if (owner && accounts) renderAccounts(container, ctx, accounts, load);
        bind(container, ctx, data, load);
      } catch (error) { if (id === requestId) content.innerHTML = `<p class="crm-error" role="alert">Не удалось загрузить: ${esc(error.message)}</p>`; }
    };
    container.querySelector('#social-refresh').addEventListener('click', load);
    container.querySelector('#social-import-form')?.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget, out = container.querySelector('#social-import-state');
      let rows; try { rows = JSON.parse(form.elements.rows.value || '[]'); } catch { out.textContent = 'Некорректный JSON строк.'; return; }
      try {
        const result = await ctx.apiJson(`/content/crm/social-stats/import?companyCode=${encodeURIComponent(ctx.selectedProjectId)}`, ctx.csrfOptions('POST', {
          platform: form.elements.platform.value, capturedAt: new Date(form.elements.capturedAt.value).toISOString(), sourceNote: form.elements.sourceNote.value.trim(), rows }));
        out.textContent = `Сохранено строк: ${result.rows}. Источник записан в журнал.`; await load();
      } catch (error) { out.textContent = error.message; }
    });
    void load();
  }
  function overviewMarkup(data) {
    const agg = data.socialAggregate || {};
    const cards = PLATFORMS.map(p => { const item = data.platforms[p]; const totals = item.totals || {}, latest = item.latest || {};
      const status = item.lastRun ? RUN[item.lastRun.status] || item.lastRun.status : ACCESS[item.access?.status] || '—';
      return `<article class="card social-platform" data-platform="${p}" data-status="${esc(item.lastRun?.status || item.access?.status || 'none')}"><h2>${esc(item.label)}</h2>
        <p class="social-status">${item.configured ? `${esc(PROVIDER[item.provider] || item.provider)} · ${item.enabled ? 'включён' : 'выключен'}` : 'не настроен'} · <strong>${esc(status)}</strong></p>
        <dl class="social-metrics">${Object.entries(latest).map(([m, v]) => `<div><dt>${esc(METRIC_LABELS[m] || m)} (на ${esc(day(v.date))})</dt><dd>${num(v.value)}</dd></div>`).join('')}
        ${Object.entries(totals).map(([m, v]) => `<div><dt>${esc(METRIC_LABELS[m] || m)} ${item.aggregation?.[m] === 'avg' ? '— невзвешенное среднее по дням' : 'за период'}</dt><dd>${num(v)}</dd></div>`).join('') || '<div><dt>Данных за период</dt><dd>—</dd></div>'}</dl>
        ${item.dataStatus === 'partial' ? '<p class="social-note">Есть незавершённые дни: текущий день обновляется в течение суток, итог — после закрытия дня.</p>' : ''}
        ${(item.history || []).length ? `<details class="social-missing"><summary>Прежние аккаунты площадки (не входят в сводку)</summary><ul>${item.history.map(h => `<li>${esc(h.accountRef)}: дней ${num(h.days)}${Object.entries(h.totals || {}).map(([m, v]) => `, ${esc(METRIC_LABELS[m] || m)} ${num(v)}`).join('')}</li>`).join('')}</ul></details>` : ''}
        <p class="social-note">Свежесть: ${esc(stamp(item.lastCollectedAt))} · разметка: ${(item.kinds || []).map(k => KIND[k] || k).join(', ') || '—'}</p>
        ${(item.lastRun?.missing?.length || item.access?.missing?.length) ? `<details class="social-missing"><summary>Чего недостаёт</summary><ul>${(item.lastRun?.missing?.length ? item.lastRun.missing : item.access.missing).map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
        ${item.lastRun?.error ? `<p class="crm-error">${esc(item.lastRun.error)}</p>` : ''}
        <button type="button" class="plain-button" data-collect="${p}">Собрать сейчас</button></article>`; }).join('');
    const days = new Map();
    for (const p of PLATFORMS) for (const [d, metrics] of Object.entries(data.platforms[p].days || {})) { days.set(d, days.get(d) || {}); days.get(d)[p] = metrics; }
    const dayRows = [...days.keys()].sort().reverse().map(d => `<tr><td data-label="День">${esc(day(d))}</td>${PLATFORMS.map(p => { const m = days.get(d)[p]; return `<td data-label="${esc(data.platforms[p].label)}">${m ? Object.entries(m).map(([k, v]) => `${esc(METRIC_LABELS[k] || k)}: ${num(v.value)}${v.kind && v.kind !== 'unknown' ? ` (${KIND[v.kind]})` : ''}`).join('<br>') : '—'}</td>`; }).join('')}</tr>`).join('');
    const crm = data.crm || { posts: [], bySource: [], byContent: [] };
    return `<section class="social-aggregate card"><h2>Агрегат соцсетей</h2><dl class="social-metrics"><div><dt>Просмотры (сумма площадок)</dt><dd>${num(agg.views)}</dd></div><div><dt>Показы</dt><dd>${num(agg.impressions)}</dd></div><div><dt>Реакции</dt><dd>${num(agg.likes)}</dd></div><div><dt>Комментарии</dt><dd>${num(agg.comments)}</dd></div><div><dt>Репосты</dt><dd>${num(agg.shares)}</dd></div><div><dt>Уникальный охват</dt><dd>—</dd></div></dl><p class="social-note">${esc(agg.reachNote || '')}</p></section>
      <div class="social-grid">${cards}</div>
      <section class="card"><h2>По дням</h2>${dayRows ? `<div class="crm-table-wrap"><table class="crm-table crm-entity-table social-days"><thead><tr><th>День</th>${PLATFORMS.map(p => `<th>${esc(data.platforms[p].label)}</th>`).join('')}</tr></thead><tbody>${dayRows}</tbody></table></div>` : '<p>За выбранный период снимков нет.</p>'}</section>
      ${crmMarkup(crm)}
      <section class="card"><h2>Журнал сборов</h2>${data.runs?.length ? `<ul class="social-runs">${data.runs.slice(0, 15).map(r => `<li>${esc(day(r.date))} · ${esc(data.platforms[r.platform]?.label || r.platform)} · ${esc(PROVIDER[r.provider] || r.provider)} · <strong>${esc(RUN[r.status] || r.status)}</strong> · строк ${num(r.rows)} · ${esc(stamp(r.finished_at || r.started_at))}${r.error ? ` · ${esc(r.error)}` : ''}${r.missing?.length ? ` · недостаёт: ${esc(r.missing.join('; '))}` : ''}</li>`).join('')}</ul>` : '<p>Сборов ещё не было.</p>'}</section>`;
  }
  /* Запись выхода: собранный пост (stored), собранный пост с подтверждением владельца (stored_with_receipt) или только подтверждение
     (external_receipt). Подтверждение — ссылка и время выхода от владельца, поэтому провайдером сбора оно не подписывается, а ручной
     ввод не выдаётся за API. Служебная ссылка receipt:<id> в основной поток не выносится: она видна в «Исходных идентификаторах». */
  function originCell(post) {
    if (post.provenance === 'external_receipt') return `<strong class="social-badge">Подтверждено вручную</strong><p class="social-note">Ссылка и время выхода записаны владельцем. Показателей площадки у такой записи нет, и подтверждение не подключает сбор просмотров.</p>`;
    const provider = post.provider ? esc(POST_SOURCE[post.provider] || post.provider) : post.sources > 1 ? 'Источники с разными провайдерами' : '—';
    return `${provider}${post.provenance === 'stored_with_receipt' ? '<br><strong class="social-badge">Подтверждено вручную</strong>' : ''}${post.sources > 1 ? `<p class="social-note">Один адрес публикации, источников записи: ${num(post.sources)}.</p>` : ''}`;
  }
  function postCell(post) {
    if (post.provenance === 'external_receipt') return safeUrl(post.url) ? link(post.url, 'Открыть публикацию') : 'Ссылка подтверждения непригодна для перехода';
    return link(post.url, post.platformPostId || '—');
  }
  function materialCell(post) {
    const candidates = post.contentIdCandidates || [];
    if (!candidates.length) return esc(post.contentId || '—');
    return `<strong class="social-conflict">Спорная связь с материалом</strong><p class="social-note">Метка UTM по этой записи не приписывается ни одному материалу: к какому из них относится обращение — неизвестно.</p>
      <details class="social-ids"><summary>Материалы-кандидаты</summary><ul>${candidates.map(c => `<li>${esc(c)}</li>`).join('')}</ul>${post.contentId ? `<p class="social-note">В записи сохранён материал ${esc(post.contentId)} — значение собранного поста; спор оно не решает.</p>` : ''}</details>`;
  }
  function identifiersCell(post) {
    const rows = [...(post.identities || []).map(i => `<li>Источник: ${esc(i.platformPostId || '—')} · ${esc(POST_SOURCE[i.provider] || i.provider || '—')}${i.contentId ? ` · материал ${esc(i.contentId)}` : ''}</li>`),
      ...(post.receipts || []).map(r => `<li>Подтверждение: ${esc(r.referenceId || '—')}${r.publishedAt ? ` · ${esc(stamp(r.publishedAt))}` : ''}${safeUrl(r.url) ? ` · ${link(r.url, 'ссылка')}` : ''}${r.contentId ? ` · материал ${esc(r.contentId)}` : ''}</li>`)];
    return rows.length ? `<details class="social-ids"><summary>Исходные идентификаторы</summary><ul>${rows.join('')}</ul></details>` : '';
  }
  /* Ноль обращений показывается только там, где искать было по чему (ссылка или материал). Без связи это UNKNOWN — «—», не ноль. */
  const linked = (post, value) => (post.attribution === 'unknown' ? '—' : num(value));
  function crmMarkup(crm) {
    const posts = crm.posts || [], receipts = crm.receipts;
    return `<section class="card social-crm"><h2>Атрибуция CRM</h2><p class="social-note">${esc(crm.note || '')}</p>
      <p class="social-note">Строки ниже — зафиксированные в CRM обращения с однозначной связью (адрес публикации в переходе или метка материала). Ноль означает, что таких обращений не зафиксировано, а не что в соцсетях не обращались: переписка в директе, комментарии и звонки без метки сюда не попадают.</p>
      <p class="social-note">Подтверждение публикации — доказательство выхода материала, а не сбор по API: показателей площадки у него нет, сбор просмотров им не подключается, и нули вместо неизвестных чисел не ставятся.</p>
      ${receipts ? `<p class="social-note">Подтверждений прочитано: ${num(receipts.projected)} · объединено с собранными постами: ${num(receipts.merged)} · только подтверждение: ${num(receipts.receiptOnly)}${receipts.skipped ? ` · площадка вне аналитики: ${num(receipts.skipped)}` : ''}</p>` : ''}
      ${posts.length ? `<div class="crm-table-wrap"><table class="crm-table crm-entity-table social-posts"><thead><tr><th>Площадка</th><th>Публикация</th><th>Материал</th><th>Обращения</th><th>Продажи</th><th>Выручка</th><th>Как записано</th><th>Основание связи</th></tr></thead><tbody>${posts.map(p => `<tr data-provenance="${esc(p.provenance || 'stored')}"><td data-label="Площадка">${esc(p.platform)}</td>
        <td data-label="Публикация">${postCell(p)}${identifiersCell(p)}</td><td data-label="Материал">${materialCell(p)}</td>
        <td data-label="Обращения">${linked(p, p.leads)}</td><td data-label="Продажи">${linked(p, p.sales)}</td><td data-label="Выручка">${linked(p, p.revenue)}</td>
        <td data-label="Как записано">${originCell(p)}</td><td data-label="Основание связи">${esc(CONFIDENCE[p.confidence] || 'однозначной связи нет')}</td></tr>`).join('')}</tbody></table></div>` : '<p>Записей публикаций со связью пока нет: атрибуция неизвестна. Это не значит, что обращений в соцсетях не было.</p>'}
      ${(crm.byContent || []).length ? `<h3>По контенту без однозначной площадки</h3><p class="social-note">Метка указывает на контент, но не на конкретный пост: считается один раз, ни одному посту не приписано.</p><ul>${crm.byContent.map(g => `<li>материал ${esc(g.contentId || g.url)} (${g.platforms.map(esc).join(', ')}): обращений ${num(g.leads)}, продаж ${num(g.sales)}, выручка ${num(g.revenue)}</li>`).join('')}</ul>` : ''}
      <h3>Обращения по источникам за период</h3>${(crm.bySource || []).length ? `<ul>${crm.bySource.map(s => `<li>${esc(s.source)}: обращений ${num(s.leads)}, продаж ${num(s.sales)}, выручка ${num(s.revenue)}</li>`).join('')}</ul>` : '<p>Обращений с зафиксированным источником за период нет.</p>'}</section>`;
  }
  function bind(container, ctx, data, load) {
    container.querySelectorAll('[data-collect]').forEach(button => button.addEventListener('click', async () => {
      if (ctx.identity?.role !== 'owner' && !ctx.identity?.permissions?.includes('crm.edit')) { button.textContent = 'Нужно право редактирования'; return; }
      button.disabled = true;
      try { const run = await ctx.apiJson(`/content/crm/social-stats/collect?companyCode=${encodeURIComponent(ctx.selectedProjectId)}`, ctx.csrfOptions('POST', { platform: button.dataset.collect })); button.textContent = RUN[run.status] || run.status; await load(); }
      catch (error) { button.disabled = false; button.textContent = error.message; }
    }));
  }
  function renderAccounts(container, ctx, accounts, load) {
    const node = container.querySelector('#social-accounts'); if (!node) return;
    node.innerHTML = `<form id="social-accounts-form" class="crm-form">${accounts.accounts.map(a => `<fieldset class="wide social-account" data-platform="${a.platform}"><legend>${esc(a.label)} · ${esc(ACCESS[a.access?.status] || a.access?.status || '')}</legend>
      <input type="hidden" name="${a.platform}.revision" value="${a.revision}"><label>Аккаунт (@имя, ID, club…)<input name="${a.platform}.accountRef" value="${esc(a.accountRef)}" maxlength="200"></label>
      <label>Источник<select name="${a.platform}.provider">${['direct', 'onlypult', 'manual'].map(p => `<option value="${p}"${a.provider === p ? ' selected' : ''}>${PROVIDER[p]}</option>`).join('')}</select></label>
      <label>Разметка<select name="${a.platform}.kind">${Object.entries(KIND).map(([k, l]) => `<option value="${k}"${a.kind === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Час сбора (Бангкок)<input name="${a.platform}.collectHour" type="number" min="0" max="23" value="${a.collectHour}"></label>
      <label class="autoposting-checkbox"><input type="checkbox" name="${a.platform}.enabled"${a.enabled ? ' checked' : ''}>Собирать</label>
      ${a.access?.missing?.length ? `<p class="social-note">Недостаёт: ${esc(a.access.missing.join('; '))}</p>` : ''}</fieldset>`).join('')}
      <div class="crm-actions wide"><button class="plain-button" type="submit">Сохранить аккаунты</button><span id="social-accounts-state" role="status"></span></div></form>`;
    node.querySelector('#social-accounts-form').addEventListener('submit', async event => {
      event.preventDefault(); const form = event.currentTarget, out = node.querySelector('#social-accounts-state');
      const payload = { accounts: PLATFORMS.map(p => ({ platform: p, revision: Number(form.elements[`${p}.revision`].value), accountRef: form.elements[`${p}.accountRef`].value.trim(), provider: form.elements[`${p}.provider`].value,
        kind: form.elements[`${p}.kind`].value, collectHour: Number(form.elements[`${p}.collectHour`].value), enabled: form.elements[`${p}.enabled`].checked, timezone: 'Asia/Bangkok' })) };
      if (payload.accounts.some(a => /(?:token|key|secret|password|bearer)/i.test(a.accountRef))) { out.textContent = 'Ключи сюда вводить нельзя.'; return; }
      try { await ctx.apiJson(`/content/crm/social-stats/accounts?companyCode=${encodeURIComponent(ctx.selectedProjectId)}`, ctx.csrfOptions('PUT', payload)); out.textContent = 'Сохранено.'; await load(); }
      catch (error) { out.textContent = error.message; }
    });
  }
  sb.registerView('social-stats', { title: 'Соцсети', render, onProjectChange: render });
})();
