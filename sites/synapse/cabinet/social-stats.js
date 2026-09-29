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
  const PLATFORM_LABELS = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', vk: 'ВКонтакте', telegram: 'Telegram' };
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
  const ACCESS_STATUS = { not_configured: 'не настроен', unchecked: 'сохранён, но не проверен', connected: 'проверен', error: 'проверка не прошла' };
  /* Список аналитических профилей принадлежит КОНКРЕТНОЙ компании и конкретной ревизии
     ключа. Общий кэш показывал профиль одной компании в кабинете другой, а запоздалый
     ответ мог принести чужой список. Поэтому кэш хранит свой ключ и сверяется с текущим;
     каждая загрузка помечается номером, и устаревший ответ отбрасывается. */
  let profilesCache = null;   // { company, revision, profiles, error }
  let profilesRequest = 0;
  const profilesKey = (ctx, access) => `${String(ctx.selectedProjectId || '').toLowerCase()}|${access?.revision ?? ''}`;
  const profilesFresh = (ctx, access) => (profilesCache && profilesCache.key === profilesKey(ctx, access) ? profilesCache : null);
  const dropProfiles = () => { profilesCache = null; profilesRequest += 1; };
  /* Аналитический профиль Onlypult подходит аккаунту, только если совпала площадка.
     Профиль публикаций (числовой ID) аналитическим не является и в список не попадает. */
  const profilesFor = (list, platform) => (list || []).filter((item) => item.platform === platform);

  function render(container, ctx) {
    if (!allowed(ctx)) { container.replaceChildren(); return; }
    const owner = ctx.identity?.role === 'owner';
    container.innerHTML = `<div class="content-header"><h1>Соцсети</h1><p>Ежедневные снимки по площадкам выбранной компании и связь с обращениями CRM. Данных нет — показываем «—», не ноль. Часовой пояс: Asia/Bangkok.</p></div>
      <div class="card social-toolbar"><label>С <input type="date" id="social-from" value="${esc(state.from)}"></label><label>По <input type="date" id="social-to" value="${esc(state.to)}"></label>
        <button type="button" class="plain-button" id="social-refresh">Показать</button></div>
      <section class="card social-baseline"><div class="social-baseline-head"><div><h2>До начала нашей работы</h2>
        <p class="social-note">Фиксируем исходную точку отдельно от обновляемой статистики. Нет доступа к числам — это «неизвестно», а не ноль.</p></div></div>
        <div id="social-baseline-content" aria-live="polite"><p>Загружаем исходную точку…</p></div>
        ${owner ? `<details class="social-baseline-create"><summary>Зафиксировать исходную точку</summary>
          <p class="social-note">Дата начала — первый наш материал. Период «до» должен закончиться раньше неё. Числа берутся только из уже записанной статистики и публикаций.</p>
          <form id="social-baseline-form" class="crm-form">
            <label>Дата первого нашего материала<input name="cutoverDate" type="date" required value="${esc(isoDay(0))}"></label>
            <label>Период до: с<input name="from" type="date" required value="${esc(isoDay(-30))}"></label>
            <label>Период до: по<input name="to" type="date" required value="${esc(isoDay(-1))}"></label>
            <label class="wide">Откуда известна дата начала<input name="sourceNote" maxlength="300" required placeholder="Например, ссылка на первый согласованный пост"></label>
            <label class="wide"><input name="confirmedStart" type="checkbox" required> Подтверждаю дату первого нашего материала</label>
            <div class="crm-actions wide"><button type="submit" class="plain-button">Зафиксировать «ДО»</button>
              <span id="social-baseline-state" role="status"></span></div></form></details>` : ''}</section>
      <section class="card social-insights"><h2>Что видно по данным</h2>
        <p class="social-note">Выводы по сохранённым измерениям: что изменилось, насколько полны данные и что ещё нужно проверить.</p>
        <div id="social-insights" aria-live="polite"><p>Загрузка…</p></div></section>
      <div id="social-content" aria-live="polite"><p>Загрузка…</p></div>
      ${owner ? `<details class="card social-analytics-access"><summary>Аналитический доступ Onlypult (владелец)</summary>
        <p class="social-note">Отдельный ключ кабинета Onlypult для чтения аналитики Instagram и TikTok. Он не заменяет подключение публикаций и хранится отдельно. Ключ показывается только один раз — вам; кабинет его не отображает и не возвращает. ВКонтакте, Telegram, YouTube, 2ГИС и MAX этот источник не покрывает.</p>
        <div id="social-analytics-access"></div></details>
      <details class="card social-settings"><summary>Аккаунты и источники (владелец)</summary><p class="social-note">Здесь только идентификаторы аккаунтов и выбор источника. Ключи и права живут в подключениях площадок (Автопостинг) или у провайдера; сюда их вводить нельзя.</p><div id="social-accounts"></div></details>
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
        const [data, accounts, baseline, access, insights] = await Promise.all([
          ctx.apiJson(`/content/crm/social-stats?companyCode=${encodeURIComponent(company)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
          owner ? ctx.apiJson(`/content/crm/social-stats/accounts?companyCode=${encodeURIComponent(company)}`) : null,
          ctx.apiJson(`/content/crm/social-stats/baseline?companyCode=${encodeURIComponent(company)}`),
          // Состояние аналитического доступа не должно ронять всю страницу, если источник молчит.
          owner ? ctx.apiJson(`/content/crm/social-stats/analytics/access?companyCode=${encodeURIComponent(company)}`).catch(() => null) : null,
          // Сводка выводов не должна ронять страницу, если расчёт недоступен.
          ctx.apiJson(`/content/crm/social-stats/insights?companyCode=${encodeURIComponent(company)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).catch((error) => ({ failed: error.message })),
        ]);
        if (id !== requestId || ctx.selectedProjectId !== company) return;
        if (data.companyCode !== String(company).toLowerCase() || baseline.companyCode !== String(company).toLowerCase()) throw new Error('Ответ другой компании');
        /* Ответ предыдущей компании или предыдущего периода отбрасывается целиком:
           сверка идёт по номеру запроса И по коду компании в самом ответе. */
        const box = container.querySelector('#social-insights');
        if (box) {
          if (!insights || insights.failed) box.innerHTML = `<p class="crm-error" role="alert">Выводы не рассчитаны: ${esc(insights?.failed || 'ответ не получен')}</p>`;
          else if (insights.companyCode !== String(company).toLowerCase()
            || insights.requestedPeriod?.from !== from || insights.requestedPeriod?.to !== to) {
            box.innerHTML = '<p class="social-note">Выводы относятся к другому запросу и не показаны. Обновите период.</p>';
          } else box.innerHTML = insightsMarkup(insights);
        }
        content.innerHTML = overviewMarkup(data);
        container.querySelector('#social-baseline-content').innerHTML = baselineMarkup(baseline);
        const cached = owner ? profilesFresh(ctx, access) : null;
        if (owner) renderAnalyticsAccess(container, ctx, access, load, cached);
        if (owner && accounts) renderAccounts(container, ctx, accounts, load, cached);
        bind(container, ctx, data, load);
      } catch (error) { if (id === requestId) content.innerHTML = `<p class="crm-error" role="alert">Не удалось загрузить: ${esc(error.message)}</p>`; }
    };
    container.querySelector('#social-refresh').addEventListener('click', load);
    container.querySelector('#social-baseline-form')?.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget, out = container.querySelector('#social-baseline-state');
      const code = ctx.selectedProjectId;
      if (form.elements.to.value >= form.elements.cutoverDate.value || form.elements.from.value > form.elements.to.value) {
        out.textContent = 'Период «до» должен закончиться раньше первого нашего материала.'; return;
      }
      const body = {cutoverDate: form.elements.cutoverDate.value, from: form.elements.from.value,
        to: form.elements.to.value, sourceNote: form.elements.sourceNote.value.trim(), confirmedStart: form.elements.confirmedStart.checked};
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      out.textContent = 'Фиксируем исходную точку…';
      try {
        await ctx.apiJson(`/content/crm/social-stats/baseline?companyCode=${encodeURIComponent(code)}`,
          ctx.csrfOptions('POST', body));
        if (ctx.selectedProjectId !== code) return;
        out.textContent = 'Исходная точка сохранена отдельной версией.';
        await load();
      } catch (error) { if (ctx.selectedProjectId === code) out.textContent = error.message; }
      finally { button.disabled = false; }
    });
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
  const baselineProvider = value => POST_SOURCE[value] || (value ? String(value) : 'источник не указан');
  function baselineSource(source) {
    if (!source) return 'Источник не указан';
    return `${esc(baselineProvider(source.provider))}${source.capturedAt ? ` · снято ${esc(stamp(source.capturedAt))}` : ''}
      ${source.note ? ` · ${esc(source.note)}` : ''}${source.runId ? ` · сбор №${esc(source.runId)}` : ''}`;
  }
  function baselineMetric(row) {
    return `<li><strong>${esc(METRIC_LABELS[row.metric] || row.metric || 'Показатель')}:</strong> ${num(row.value)}
      ${row.date ? ` · ${esc(day(row.date))}` : ''}${row.period === 'lifetime' ? ' · значение на дату' : ''}
      ${row.completeness && row.completeness !== 'complete' ? ` · ${esc(row.completeness === 'partial' ? 'частичные данные' : 'полнота неизвестна')}` : ''}
      <small>${baselineSource(row)}</small></li>`;
  }
  function baselineAssessment(item) {
    const assessment = item.assessment;
    if (!assessment || assessment.basis !== 'frozen_snapshot') {
      return '<section class="social-baseline-assessment" aria-label="Что видим до старта"><h3>Что видим до старта</h3>' +
        '<p>Краткий разбор этой версии ещё не получен. Ниже доступны сохранённые числа и источники; отсутствие разбора не означает нулевой результат.</p></section>';
    }
    const sourceLine = (part) => `<p class="social-note"><strong>Источник:</strong> ${part.sources?.length ?
      baselineSource(part.sources[0]) + (part.sources.length > 1 || part.sourcesTruncated ? ' · остальные источники — в подробностях снимка' : '') :
      'в снимке не указан; уточните происхождение данных перед сравнением.'}</p>`;
    const publications = assessment.publications || {};
    return `<section class="social-baseline-assessment" aria-label="Что видим до старта">
      <h3>Что видим до старта</h3><p class="social-note">Выводы только по сохранённой версии ${esc(item.version)} за
        ${esc(day(item.from))} — ${esc(day(item.to))}. Текущая статистика сюда не подмешивается.</p>
      <ul class="social-baseline-findings">${(assessment.platforms || []).map((part) => `<li>
        <strong>${esc(PLATFORM_LABELS[part.platform] || part.platform)}</strong>
        <p>${part.datesWithMetrics === null ? 'Число дат с показателями неизвестно.' :
    `Дат хотя бы с одним показателем: ${num(part.datesWithMetrics)} из ${num(part.periodDays)}.`}
          ${part.dateEvidence === 'stored_count' ? 'Число взято из сводки снимка; исходные даты не сохранены.' : ''}
          ${part.metrics?.length ? `Записаны: ${part.metrics.map((key) => esc(METRIC_LABELS[key] || key)).join(', ')}.` : 'Значения показателей неизвестны.'}</p>
        ${sourceLine(part)}<p class="social-note"><strong>Для сравнения:</strong>
          ${part.missingDates > 0 ? `не хватает дат с показателями: ${num(part.missingDates)}; пропуски не равны нулю.` :
    part.missingDates === 0 ? 'наличие показателя на каждую дату не означает полноту всех метрик.' : 'покрытие периода неизвестно.'}
          ${part.hasPointValues ? 'Значение на отдельную дату не заменяет дневную историю.' : ''}</p></li>`).join('')}
        ${assessment.unconfiguredPlatforms?.length ? `<li><strong>Пробелы в снимке</strong><p>Нет сохранённых показателей:
          ${assessment.unconfiguredPlatforms.map((id) => esc(PLATFORM_LABELS[id] || id)).join(', ')}.</p>
          <p class="social-note">Наличие источника и результаты этих площадок по этому снимку не подтверждены. Для нужных площадок добавьте выгрузку или отметьте отсутствие доступа.</p></li>` : ''}
        <li><strong>Прежние публикации</strong><p>Записей о публикациях: ${num(publications.recorded)}.
          ${publications.detailed ? `В подробных записях с показателями: ${num(publications.withMetrics)} из ${num(publications.detailed)}.` :
    'Числа по отдельным публикациям неизвестны.'}
          Подтверждения владельца: ${num(publications.receiptsRecorded)}; к числу записей их не прибавляем.</p>
          ${sourceLine(publications)}<p class="social-note"><strong>Для сравнения:</strong>
            ${publications.truncated ? 'в снимке сохранена только часть подробных записей; ' : ''}полнота архива не подтверждена.
            Тексты в снимке не сохранены, качество содержания не оценено.</p></li></ul>
      <details class="social-baseline-assessment-limits"><summary>Что мешает сравнению</summary>
        <ul>${(assessment.limitations || []).map((text) => `<li>${esc(text)}</li>`).join('')}</ul></details>
      <div class="social-baseline-next"><h4>Что сделать до запуска</h4>
        <ol>${(assessment.actions || []).map((text) => `<li>${esc(text)}</li>`).join('')}</ol></div>
    </section>`;
  }
  function baselineMarkup(data) {
    const item = data.latest;
    if (!item) return '<p>Исходная точка ещё не зафиксирована. Выберите подтверждённую дату первого нашего материала и период до неё.</p>';
    const snapshot = item.snapshot || {}, platforms = snapshot.platforms || {};
    const cards = PLATFORMS.map((id) => {
      const part = platforms[id] || {}, totals = part.totals || {}, sources = part.sources || [], measurements = part.measurements || [];
      const metrics = Object.entries(totals).map(([key, value]) => `<div><dt>${esc(key === 'reach' && part.aggregation?.reach === 'sum' ?
        'Охват — сумма суточных значений, не уникальные люди за период' : METRIC_LABELS[key] || key)}</dt><dd>${num(value)}</dd></div>`).join('');
      const coverage = part.coverage === 'days_recorded' ? 'Есть показатели на каждый день; полнота метрик неизвестна'
        : part.coverage === 'partial' ? 'Часть дней без записанных показателей'
          : part.coverage === 'account_not_configured' ? 'Аккаунт не настроен' : 'Показатели не записаны';
      const sourceRows = sources.slice(0, 12), metricRows = measurements.slice(-20).reverse();
      return `<article class="social-baseline-platform"><strong>${esc(PLATFORM_LABELS[id])}</strong>
        <span class="social-baseline-coverage">${esc(coverage)}</span>
        <dl class="social-metrics">${metrics || '<div><dt>Показатели</dt><dd>—</dd></div>'}</dl>
        <p class="social-note">Дней хотя бы с одним показателем: ${num(part.recordedDays)} из ${num(part.periodDays)}.
          ${part.accountConfigured ? `Аккаунт: ${esc(part.accountRef || '—')}.` : ''}</p>
        <details><summary>Источники измерений: ${num(sources.length)}${part.sourcesTruncated ? '+' : ''}</summary>
          ${sourceRows.length ? `<ul class="social-baseline-evidence">${sourceRows.map(source => `<li>${baselineSource(source)}</li>`).join('')}</ul>
            ${sources.length > sourceRows.length || part.sourcesTruncated ? `<p class="social-note">Показаны первые ${num(sourceRows.length)} источников; список в снимке длиннее.</p>` : ''}`
            : '<p class="social-note">Источник не записан.</p>'}</details>
        <details><summary>Исходные измерения: ${num(measurements.length)}</summary>
          ${metricRows.length ? `<ul class="social-baseline-evidence">${metricRows.map(baselineMetric).join('')}</ul>
            ${measurements.length > metricRows.length ? `<p class="social-note">Показаны последние ${num(metricRows.length)} измерений.</p>` : ''}`
            : '<p class="social-note">Измерений нет.</p>'}</details></article>`;
    }).join('');
    const posts = (snapshot.posts || []).slice(0, 30), receipts = (snapshot.receipts || []).slice(0, 30);
    return `<div class="social-baseline-meta"><strong>Версия ${esc(item.version)} · период ${esc(day(item.from))} — ${esc(day(item.to))}</strong>
      <span>Первый наш материал: ${esc(day(item.cutoverDate))} · зафиксировано ${esc(stamp(item.createdAt))}</span>
      <span>Основание даты: ${esc(item.sourceNote || '—')}</span>
      <span>${snapshot.status === 'no_data' ? 'Показателей за период нет' : 'Данные частичные'} · ${esc(snapshot.coverageNote || '')}</span>
      <p class="social-note">Это замер записанного, а не полный архив соцсетей. Исторические публикации и подтверждения владельца могут относиться к одному выходу; их количество не складываем.</p></div>
      ${baselineAssessment(item)}
      <div class="social-baseline-grid">${cards}</div>
      <details class="social-baseline-history"><summary>Исторические публикации: записано ${num(snapshot.postsRecorded)}</summary>
        <p class="social-note">Показаны только публикации, уже найденные в системе. Числа взяты из записанных измерений, сравнивать разные посты без оценки покрытия нельзя.</p>
        ${posts.length ? `<ul class="social-baseline-posts">${posts.map((post) => {
          const metrics = post.metrics || [], visible = metrics.slice(0, 12);
          return `<li><div><strong>${esc(PLATFORM_LABELS[post.platform] || post.platform || 'Площадка не указана')}</strong> · ${esc(day(String(post.publishedAt || '').slice(0, 10)))}
            · ${safeUrl(post.url) ? link(post.url, 'Открыть публикацию') : 'Ссылка не записана'}</div>
            <p class="social-note">Запись: ${baselineSource(post.source || { provider: post.provider })}</p>
            ${visible.length ? `<ul class="social-baseline-evidence">${visible.map(baselineMetric).join('')}</ul>
              ${metrics.length > visible.length ? `<p class="social-note">Показаны первые ${num(visible.length)} из ${num(metrics.length)} измерений.</p>` : ''}`
              : '<p class="social-note">Показатели этой публикации не записаны — просмотры и реакции неизвестны.</p>'}</li>`;
        }).join('')}</ul>${snapshot.postsTruncated || Number(snapshot.postsRecorded) > posts.length ? `<p class="social-note">Показано ${num(posts.length)} из ${num(snapshot.postsRecorded)} записанных публикаций.</p>` : ''}`
          : '<p>Исторические публикации не записаны.</p>'}</details>
      <details class="social-baseline-history"><summary>Подтверждения владельца: записано ${num(snapshot.receiptsRecorded)}</summary>
        <p class="social-note">Подтверждение говорит о выходе публикации, но не является статистикой площадки и не даёт просмотров.</p>
        ${receipts.length ? `<ul class="social-baseline-posts">${receipts.map(receipt => `<li><strong>${esc(PLATFORM_LABELS[receipt.platform] || receipt.platform || 'Площадка не указана')}</strong>
          · ${esc(day(String(receipt.publishedAt || '').slice(0, 10)))} · ${safeUrl(receipt.url) ? link(receipt.url, 'Открыть публикацию') : 'Ссылка не записана'}
          <p class="social-note">Подтверждено владельцем${receipt.source?.capturedAt ? ` · ${esc(stamp(receipt.source.capturedAt))}` : ''}${receipt.source?.note ? ` · ${esc(receipt.source.note)}` : ''}.
          Показатели не записаны.</p></li>`).join('')}</ul>${snapshot.receiptsTruncated || Number(snapshot.receiptsRecorded) > receipts.length ? `<p class="social-note">Показано ${num(receipts.length)} из ${num(snapshot.receiptsRecorded)} подтверждений.</p>` : ''}`
          : '<p>Подтверждений владельца за период нет.</p>'}</details>
      ${(data.versions || []).length > 1 ? `<details><summary>История исходной точки: ${(data.versions || []).length} версий</summary><ol>${data.versions.map((row) =>
        `<li>Версия ${esc(row.version)} · ${esc(day(row.from))} — ${esc(day(row.to))} · ${esc(stamp(row.createdAt))}</li>`).join('')}</ol></details>` : ''}`;
  }
  /* «Что видно по данным». Разметка только показывает уже посчитанное: ни одного расчёта,
     ни одного досчёта нуля здесь нет. Семь состояний площадок видны всегда, 2ГИС стоит
     отдельным блоком, подробные источники раскрываются по желанию. */
  const INSIGHT_PLATFORMS = ['instagram', 'tiktok', 'youtube', 'vk', 'telegram', 'max'];
  const INSIGHT_LABELS = { ...PLATFORM_LABELS, max: 'MAX', posts: 'Публикации', crm: 'Обращения CRM' };
  const COMPARISON = { ok: 'сравнение допустимо', not_comparable: 'сравнивать нельзя', none: 'сравнения нет' };
  function insightSources(item) {
    const parts = [];
    if (item.sources?.accountRef) parts.push(`аккаунт ${item.sources.accountRef}`);
    if (item.sources?.timezone) parts.push(`сутки ${item.sources.timezone}`);
    if (item.sources?.provider) parts.push(`источник ${PROVIDER[item.sources.provider] || item.sources.provider}`);
    if (item.sources?.sourceNote) parts.push(`происхождение: ${item.sources.sourceNote}`);
    if (item.sources?.organizationId) parts.push(`организация ${item.sources.organizationId}`);
    if (item.sources?.branchId) parts.push(`филиал ${item.sources.branchId}`);
    if (item.sources?.reportIds?.length) parts.push(`отчёты ${item.sources.reportIds.join(', ')}`);
    if (item.dates?.measuredAt) parts.push(`измерено ${day(item.dates.measuredAt)}`);
    if (item.dates?.previousMeasuredAt) parts.push(`прежнее измерение ${day(item.dates.previousMeasuredAt)}`);
    if (item.dates?.from && item.dates?.to) parts.push(`период ${day(item.dates.from)} — ${day(item.dates.to)}`);
    if (item.dates?.previousFrom) parts.push(`сравниваемый период ${day(item.dates.previousFrom)} — ${day(item.dates.previousTo)}`);
    if (item.reason) parts.push(`причина: ${item.reason}`);
    return parts;
  }
  const insightLine = (item) => `<li data-rule="${esc(item.ruleId)}" data-comparison="${esc(item.comparison)}">
    <p>${esc(item.text)}</p>
    ${insightSources(item).length ? `<details class="social-missing"><summary>Источник и границы (${esc(COMPARISON[item.comparison] || item.comparison)})</summary><ul>${insightSources(item).map(part => `<li>${esc(part)}</li>`).join('')}</ul></details>` : ''}</li>`;
  function insightsMarkup(data) {
    const period = `${esc(day(data.requestedPeriod?.from))} — ${esc(day(data.requestedPeriod?.to))}`;
    const compare = data.comparisonPeriod ? `${esc(day(data.comparisonPeriod.from))} — ${esc(day(data.comparisonPeriod.to))}` : '—';
    const social = INSIGHT_PLATFORMS.map(p => {
      const items = (data.social || []).filter(item => item.platform === p);
      return `<article class="social-insight-platform" data-insight-platform="${p}"><h3>${esc(INSIGHT_LABELS[p] || p)}</h3>
        ${items.length ? `<ul class="social-runs">${items.map(insightLine).join('')}</ul>`
          : '<p class="social-note">Наблюдений нет: измерений по этой площадке не сохранено. Это отсутствие данных, а не ноль.</p>'}</article>`;
    }).join('');
    const extra = (data.observations || []).filter(item => ['posts', 'crm'].includes(item.platform));
    const gis = data.companyMetrics || [];
    return `<p class="social-note">Выбранный период: ${period} · сравниваемый период: ${compare}${data.requestedPeriod?.timezone ? ` · сутки ${esc(data.requestedPeriod.timezone)}` : ''}${data.requestedPeriod?.includesToday ? ' · в период входит незавершённый день' : ''} · правила ${esc(data.rulesVersion)}</p>
      <div class="social-insight-grid">${social}</div>
      <article class="social-insight-platform" data-insight-platform="gis"><h3>2ГИС · загруженные отчёты</h3>
        ${gis.length ? `<ul class="social-runs">${gis.map(insightLine).join('')}</ul>`
          : '<p class="social-note">Загруженных отчётов 2ГИС нет. Это отсутствие данных, а не ноль.</p>'}</article>
      ${extra.length ? `<article class="social-insight-platform" data-insight-platform="posts-crm"><h3>Публикации и обращения</h3>
        <ul class="social-runs">${extra.map(insightLine).join('')}</ul></article>` : ''}
      ${(data.limitations || []).length ? `<details class="social-missing" open><summary>Чего по этим данным сказать нельзя</summary><ul>${data.limitations.map(line => `<li>${esc(line)}</li>`).join('')}</ul></details>` : ''}
      ${(data.nextSteps || []).length ? `<details class="social-missing"><summary>Следующий шаг</summary><ul>${data.nextSteps.map(line => `<li>${esc(line)}</li>`).join('')}</ul></details>` : ''}`;
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
        ${item.dataStatus === 'lifetime_only' ? '<p class="social-note">Есть только замер состояния на дату (подписчики): суточного ряда по этой площадке пока нет.</p>' : ''}
        <p class="social-note">Свежесть: ${esc(stamp(item.lastCollectedAt))} · разметка: ${(item.kinds || []).map(k => KIND[k] || k).join(', ') || '—'}${item.timezone ? ` · сутки ${esc(item.timezone)}` : ''}</p>
        ${(item.lastRun?.missing?.length || item.access?.missing?.length) ? `<details class="social-missing"><summary>Чего недостаёт</summary><ul>${(item.lastRun?.missing?.length ? item.lastRun.missing : item.access.missing).map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
        ${/* Происхождение измерения — не ошибка: раньше пометка источника ручного импорта красилась красным. */''}
        ${item.lastRun?.sourceNote ? `<p class="social-note">Источник измерения: ${esc(item.lastRun.sourceNote)}</p>` : ''}
        ${item.lastRun?.error ? `<p class="crm-error">${esc(item.lastRun.error)}</p>` : ''}
        ${(item.pendingDates || []).length ? `<p class="social-note">Ждут повтора: ${esc(item.pendingDates.map(d => day(d.date)).join(', '))}</p>` : ''}
        <div class="crm-actions"><label class="social-collect-date">Дата сбора<input type="date" data-collect-date="${p}" max="${esc(isoDay(0))}" value="${esc(isoDay(0))}"></label>
        <button type="button" class="plain-button" data-collect="${p}">Собрать сейчас</button></div>
        <p class="social-note" data-collect-result="${p}" role="status"></p></article>`; }).join('');
    const days = new Map();
    for (const p of PLATFORMS) for (const [d, metrics] of Object.entries(data.platforms[p].days || {})) { days.set(d, days.get(d) || {}); days.get(d)[p] = metrics; }
    const dayRows = [...days.keys()].sort().reverse().map(d => `<tr><td data-label="День">${esc(day(d))}</td>${PLATFORMS.map(p => { const m = days.get(d)[p]; return `<td data-label="${esc(data.platforms[p].label)}">${m ? Object.entries(m).map(([k, v]) => `${esc(METRIC_LABELS[k] || k)}: ${num(v.value)}${v.kind && v.kind !== 'unknown' ? ` (${KIND[v.kind]})` : ''}`).join('<br>') : '—'}</td>`; }).join('')}</tr>`).join('');
    const crm = data.crm || { posts: [], bySource: [], byContent: [] };
    return `<section class="social-aggregate card"><h2>Агрегат соцсетей</h2><dl class="social-metrics"><div><dt>Просмотры (сумма площадок)</dt><dd>${num(agg.views)}</dd></div><div><dt>Показы</dt><dd>${num(agg.impressions)}</dd></div><div><dt>Реакции</dt><dd>${num(agg.likes)}</dd></div><div><dt>Комментарии</dt><dd>${num(agg.comments)}</dd></div><div><dt>Репосты</dt><dd>${num(agg.shares)}</dd></div><div><dt>Уникальный охват</dt><dd>—</dd></div></dl><p class="social-note">${esc(agg.reachNote || '')}</p></section>
      <div class="social-grid">${cards}</div>
      <section class="card"><h2>По дням</h2>${dayRows ? `<div class="crm-table-wrap"><table class="crm-table crm-entity-table social-days"><thead><tr><th>День</th>${PLATFORMS.map(p => `<th>${esc(data.platforms[p].label)}</th>`).join('')}</tr></thead><tbody>${dayRows}</tbody></table></div>` : '<p>За выбранный период снимков нет.</p>'}</section>
      ${crmMarkup(crm)}
      ${postMetricsMarkup(data.postMetrics)}
      <section class="card"><h2>Журнал сборов</h2>${data.runs?.length ? `<ul class="social-runs">${data.runs.slice(0, 15).map(r => `<li>${esc(day(r.date))} · ${esc(data.platforms[r.platform]?.label || r.platform)} · ${esc(PROVIDER[r.provider] || r.provider)} · <strong>${esc(RUN[r.status] || r.status)}</strong> · строк ${num(r.rows)} · ${esc(stamp(r.finished_at || r.started_at))}${r.sourceNote ? ` · источник: ${esc(r.sourceNote)}` : ''}${r.error ? ` · <span class="crm-error">${esc(r.error)}</span>` : ''}${r.missing?.length ? ` · недостаёт: ${esc(r.missing.join('; '))}` : ''}</li>`).join('')}</ul>` : '<p>Сборов ещё не было.</p>'}</section>`;
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
  /* Показатели публикаций: только сохранённые измерения. Значение пустое — данных нет; ноль — измеренный ноль.
     Даты не складываются: у метрики поста не сохранён признак периода, поэтому показывается последнее измерение
     внутри выбранного интервала. Источники одного адреса остаются раздельными. */
  const COMPLETENESS_LABEL = { complete: 'измерение полное', partial: 'измерение неполное', unknown: 'полнота неизвестна' };
  /* Единицы приходят с сервера как есть (views/count/people/seconds/percent). Название метрики уже говорит,
     что измерено, поэтому «просмотры» и «штуки» не дублируются; секунды и проценты остаются однозначными. */
  const UNIT_LABEL = { views: '', count: '', people: 'человек', seconds: 'с', percent: '%' };
  const unitSuffix = unit => { const label = UNIT_LABEL[unit]; return label === undefined ? (unit ? ` ${unit}` : '') : (label ? ` ${label}` : ''); };
  function postMetricsMarkup(report) {
    if (!report) return '<section class="card social-post-metrics"><h2>Показатели публикаций</h2><p>Раздел ещё не получен от сервера.</p></section>';
    const coverage = report.coverage || {}, posts = report.posts || [], summary = report.summary || {};
    const measured = value => (value === null || value === undefined ? '<span class="social-no-data">нет данных</span>' : esc(String(value)));
    const rows = posts.map(post => {
      const sources = (post.sources || []).map(source => {
        const list = (source.measurements || []).map(m => `<li>${esc(METRIC_LABELS[m.metric] || m.metric)}: ${measured(m.value)}${m.hasValue ? esc(unitSuffix(m.unit)) : ''} · за ${esc(day(m.date))} · собрано ${esc(stamp(m.collectedAt))} · ${esc(PROVIDER[m.provider] || m.provider || 'источник не указан')}${m.sourceField ? ` · поле ${esc(m.sourceField)}` : ''} · ${esc(COMPLETENESS_LABEL[m.completeness] || COMPLETENESS_LABEL.unknown)} · запись ${esc(m.referenceId)}</li>`).join('');
        return `<li>Источник ${esc(source.referenceId)} · ${esc(source.platformPostId || '—')} · ${esc(POST_SOURCE[source.provider] || source.provider || '—')}${list ? `<ul>${list}</ul>` : '<p class="social-note">Измерений за период нет.</p>'}</li>`;
      }).join('');
      return `<tr><td data-label="Площадка">${esc(post.platformLabel || post.platform)}</td>
        <td data-label="Публикация">${safeUrl(post.url) ? link(post.url, 'ссылка') : '—'}${post.publishedAt ? `<br>${esc(stamp(post.publishedAt))}` : ''}</td>
        <td data-label="Измерения">${post.receiptOnly
          ? '<p class="social-note">Подтверждение владельца: ссылка и время выхода. Показателей площадки у такой записи нет.</p>'
          : sources ? `<ul class="social-post-sources">${sources}</ul>` : '<p class="social-note">Исходных записей нет.</p>'}</td></tr>`;
    }).join('');
    const line = (label, value) => `<li>${esc(label)}: ${esc(String(value))}</li>`;
    const block = (title, items) => (items || []).length
      ? `<h3>${esc(title)}</h3><ul>${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : '';
    return `<section class="card social-post-metrics"><h2>Показатели публикаций</h2>
      <p class="social-note">${esc(report.note || '')}</p>
      <p class="social-note">В списке — последние сохранённые публикации архива компании, а не выборка по датам публикации: выбранный период фильтрует только измерения.</p>
      ${rows ? `<div class="crm-table-wrap"><table class="crm-table crm-entity-table"><thead><tr><th>Площадка</th><th>Публикация</th><th>Измерения за период</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<p>Сохранённых публикаций у компании нет.</p>'}
      <h3>Покрытие</h3><ul class="social-coverage">
        ${line('Публикаций сохранено', coverage.storedPostsTotal ?? 0)}
        ${line('Из них прочитано', `${coverage.storedPostsRead ?? 0}${coverage.storedPostsTruncated ? ` (не показано ${coverage.storedPostsOmitted ?? 0})` : ''}`)}
        ${line('Исходных записей', coverage.sourceRows ?? 0)}
        ${line('Из них со строками измерений', coverage.sourcesWithMeasurements ?? 0)}
        ${line('Из них с известными значениями', coverage.sourcesWithKnownValues ?? 0)}
        ${line('Строк измерений прочитано', coverage.measurementsRead ?? 0)}
        ${line('Из них с известным значением', coverage.knownValues ?? 0)}
        ${line('Подтверждений владельца сохранено', coverage.receiptsTotal ?? 0)}
        ${line('Из них прочитано', `${coverage.receiptsRead ?? 0}${coverage.receiptsTruncated ? ` (не показано ${coverage.receiptsOmitted ?? 0})` : ''}`)}
        ${line('Даты измерений', (coverage.measurementDates || []).length ? (coverage.measurementDates || []).map(day).join(', ') : 'нет')}
        ${line('Подтверждений владельца без собранного поста', coverage.receiptsOnly ?? 0)}
        ${line('Подтверждений с площадкой вне аналитики', coverage.receiptsSkipped ?? 0)}
      </ul><p class="social-note">${esc(coverage.note || '')}</p>
      ${block('Что видно', summary.visible)}
      ${block('Чего пока нельзя заключить', summary.cannotConclude)}
      ${block('Следующий шаг', summary.nextStep)}</section>`;
  }
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
    /* Ручной сбор идёт тем же путём, что и фоновый: тот же /social-stats/collect, та же
       аренда, та же очередь повторов. Отдельной «ручной» ветки сбора нет. */
    container.querySelectorAll('[data-collect]').forEach(button => button.addEventListener('click', async () => {
      const platform = button.dataset.collect, out = container.querySelector(`[data-collect-result="${platform}"]`);
      if (ctx.identity?.role !== 'owner' && !ctx.identity?.permissions?.includes('crm.edit')) { if (out) out.textContent = 'Нужно право редактирования.'; return; }
      const chosen = container.querySelector(`[data-collect-date="${platform}"]`)?.value || '';
      button.disabled = true; if (out) out.textContent = 'Собираем…';
      try {
        const run = await ctx.apiJson(`/content/crm/social-stats/collect?companyCode=${encodeURIComponent(ctx.selectedProjectId)}`,
          ctx.csrfOptions('POST', { platform, ...(chosen ? { date: chosen } : {}) }));
        const message = [`${RUN[run.status] || run.status} за ${day(run.date)}`,
          run.closed ? 'сутки закрыты' : 'сутки ещё идут',
          `записей: ${num(run.rows)}`,
          run.missing?.length ? `недостаёт: ${run.missing.join('; ')}` : ''].filter(Boolean).join(' · ');
        await load();
        // Перерисовка заменила узлы: результат ставится в свежий, иначе он пропадал сразу.
        const fresh = container.querySelector(`[data-collect-result="${platform}"]`);
        if (fresh) fresh.textContent = message;
      } catch (error) { const fresh = container.querySelector(`[data-collect-result="${platform}"]`) || out; if (fresh) fresh.textContent = error.message; }
      button.disabled = false;
    }));
  }
  /* Аналитический доступ: сохранение ключа, проверка и загрузка списка профилей an_….
     Ключ уходит одним полем и обратно не возвращается: кабинет знает только «настроен или
     нет» и состояние проверки. Пустое поле при сохранении прежний ключ НЕ стирает. */
  function renderAnalyticsAccess(container, ctx, access, load, cached) {
    const node = container.querySelector('#social-analytics-access'); if (!node) return;
    if (!access) { node.innerHTML = '<p class="crm-error" role="alert">Состояние аналитического доступа не прочитано. Обновите страницу.</p>'; return; }
    const checked = access.checked ? 'подключение подтверждено на текущем ключе' : 'текущий ключ проверкой не подтверждён';
    node.innerHTML = `<form id="social-analytics-form" class="crm-form">
      <p class="social-status">Onlypult Analytics: <strong>${esc(access.configured ? ACCESS_STATUS[access.status] || access.status : 'не настроен')}</strong> · ${esc(checked)}${access.checkedAt ? ` · проверен ${esc(stamp(access.checkedAt))}` : ''}</p>
      ${access.status === 'error' && access.statusCode ? `<p class="crm-error">Последняя проверка не прошла: ${esc(access.statusCode)}</p>` : ''}
      <input type="hidden" name="revision" value="${esc(access.revision)}">
      <label class="wide">Ключ доступа к аналитике<input name="credential" type="password" autocomplete="off" maxlength="400" placeholder="${access.configured ? 'ключ сохранён — оставьте пустым, чтобы не менять' : 'вставьте ключ кабинета Onlypult'}"></label>
      <div class="crm-actions wide">
        <button class="plain-button" type="submit">Сохранить доступ</button>
        <button class="plain-button" type="button" data-analytics="check">Проверить и загрузить профили</button>
        ${access.configured ? '<button class="plain-button" type="button" data-analytics="remove">Убрать доступ</button>' : ''}
        <span id="social-analytics-state" role="status"></span></div>
      ${cached?.error ? `<p class="crm-error" role="alert">${esc(cached.error)}</p>` : ''}
      ${cached?.profiles ? (cached.profiles.length
        ? `<p class="social-note">Аналитических профилей получено: ${num(cached.profiles.length)}. Профиль выбирается у площадки ниже.</p>
           <ul class="social-runs">${cached.profiles.map((item) => `<li>${esc(item.id)} · ${esc(PLATFORM_LABELS[item.platform] || item.platform)} · аккаунт площадки ${esc(item.nativeAccountId || 'не назван')}${item.timezone ? ` · сутки ${esc(item.timezone)}` : ''}</li>`).join('')}</ul>`
        : '<p class="social-note">Источник ответил, но аналитических профилей (an_…) в кабинете нет. Подключение аналитики недостающее: профиль нужно завести на стороне Onlypult — без него сбор не запускается и цифры не появятся.</p>') : ''}</form>`;
    const out = node.querySelector('#social-analytics-state');
    node.querySelector('#social-analytics-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget, credential = form.elements.credential.value.trim();
      try {
        await ctx.apiJson(`/content/crm/social-stats/analytics/access?companyCode=${encodeURIComponent(ctx.selectedProjectId)}`,
          ctx.csrfOptions('PUT', { revision: Number(form.elements.revision.value), credential }));
        form.elements.credential.value = '';
        dropProfiles();
        out.textContent = 'Сохранено. Проверьте доступ, чтобы подтвердить подключение.';
        await load();
      } catch (error) { out.textContent = error.message; }
    });
    node.querySelector('[data-analytics="check"]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget; button.disabled = true; out.textContent = 'Проверяем…';
      /* Ответ принадлежит той компании и той ревизии ключа, с которыми ушёл запрос.
         Запоздалый ответ после переключения компании отбрасывается целиком. */
      const ticket = ++profilesRequest, key = profilesKey(ctx, access), company = ctx.selectedProjectId;
      try {
        const listing = await ctx.apiJson(`/content/crm/social-stats/analytics/profiles?companyCode=${encodeURIComponent(company)}`);
        if (ticket !== profilesRequest || ctx.selectedProjectId !== company) return;
        const profiles = Array.isArray(listing.profiles) ? listing.profiles : [];
        profilesCache = { key, profiles, error: '' };
        out.textContent = profiles.length ? 'Доступ подтверждён.' : 'Доступ подтверждён, но профилей аналитики нет.';
      } catch (error) {
        if (ticket !== profilesRequest || ctx.selectedProjectId !== company) return;
        profilesCache = { key, profiles: null, error: error.message };
        out.textContent = error.message;
      }
      button.disabled = false;
      await load();
    });
    node.querySelector('[data-analytics="remove"]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget; button.disabled = true;
      try {
        await ctx.apiJson(`/content/crm/social-stats/analytics/access?companyCode=${encodeURIComponent(ctx.selectedProjectId)}`,
          ctx.csrfOptions('DELETE', { revision: Number(node.querySelector('[name="revision"]').value) }));
        dropProfiles();
        out.textContent = 'Доступ убран. История измерений и доказательств сохранена.';
        await load();
      } catch (error) { out.textContent = error.message; button.disabled = false; }
    });
  }
  function renderAccounts(container, ctx, accounts, load, cached) {
    const node = container.querySelector('#social-accounts'); if (!node) return;
    /* Система суток — настоящий выбор, а не навязанный Asia/Bangkok: аккаунту в Иркутске
       нужен свой день. Сохранённый пояс остаётся в списке, даже если его нет в подсказке. */
    const zones = [...new Set([...(accounts.timezones || ['Asia/Bangkok']), ...accounts.accounts.map((a) => a.timezone).filter(Boolean)])];
    node.innerHTML = `<form id="social-accounts-form" class="crm-form">${accounts.accounts.map(a => {
      const options = profilesFor(cached?.profiles, a.platform);
      return `<fieldset class="wide social-account" data-platform="${a.platform}"><legend>${esc(a.label)} · ${esc(ACCESS[a.access?.status] || a.access?.status || '')}${a.configured ? '' : ' · аккаунт не указан'}</legend>
      <input type="hidden" name="${a.platform}.revision" value="${a.revision}"><label>Аккаунт (@имя, ID, club…)<input name="${a.platform}.accountRef" value="${esc(a.accountRef)}" maxlength="200"></label>
      <label>Источник<select name="${a.platform}.provider">${['direct', 'onlypult', 'manual'].map(p => `<option value="${p}"${a.provider === p ? ' selected' : ''}>${PROVIDER[p]}</option>`).join('')}</select></label>
      <label>Аналитический профиль Onlypult<select name="${a.platform}.providerRef">
        <option value="">не выбран</option>
        ${options.map((item) => `<option value="${esc(item.id)}"${a.providerRef === item.id ? ' selected' : ''}>${esc(item.id)} · аккаунт ${esc(item.nativeAccountId || 'не назван')}${item.timezone ? ` · ${esc(item.timezone)}` : ''}</option>`).join('')}
        ${a.providerRef && !options.some((item) => item.id === a.providerRef) ? `<option value="${esc(a.providerRef)}" selected>${esc(a.providerRef)} · в загруженном списке нет</option>` : ''}
      </select></label>
      ${!cached?.profiles ? '<p class="social-note">Список профилей не загружен: проверьте аналитический доступ выше.</p>'
        : !options.length ? '<p class="social-note">Аналитических профилей этой площадки у источника нет. Недостающее подключение: заведите профиль в Onlypult — сбор без него не запускается.</p>' : ''}
      <label>Разметка<select name="${a.platform}.kind">${Object.entries(KIND).map(([k, l]) => `<option value="${k}"${a.kind === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Система суток<select name="${a.platform}.timezone">${zones.map((z) => `<option value="${esc(z)}"${a.timezone === z ? ' selected' : ''}>${esc(z)}</option>`).join('')}</select></label>
      <label>Час сбора (по выбранным суткам)<input name="${a.platform}.collectHour" type="number" min="0" max="23" value="${a.collectHour}"></label>
      <label class="autoposting-checkbox"><input type="checkbox" name="${a.platform}.enabled"${a.enabled ? ' checked' : ''}>Собирать</label>
      ${a.access?.missing?.length ? `<p class="social-note">Недостаёт: ${esc(a.access.missing.join('; '))}</p>` : ''}</fieldset>`; }).join('')}
      <div class="crm-actions wide"><button class="plain-button" type="submit">Сохранить аккаунты</button><span id="social-accounts-state" role="status"></span></div></form>`;
    node.querySelector('#social-accounts-form').addEventListener('submit', async event => {
      event.preventDefault(); const form = event.currentTarget, out = node.querySelector('#social-accounts-state');
      const payload = { accounts: PLATFORMS.map(p => ({ platform: p, revision: Number(form.elements[`${p}.revision`].value), accountRef: form.elements[`${p}.accountRef`].value.trim(), provider: form.elements[`${p}.provider`].value,
        providerRef: form.elements[`${p}.providerRef`].value.trim(),
        kind: form.elements[`${p}.kind`].value, collectHour: Number(form.elements[`${p}.collectHour`].value), enabled: form.elements[`${p}.enabled`].checked,
        timezone: form.elements[`${p}.timezone`].value })) };
      if (payload.accounts.some(a => /(?:token|key|secret|password|bearer)/i.test(a.accountRef))) { out.textContent = 'Ключи сюда вводить нельзя.'; return; }
      try { await ctx.apiJson(`/content/crm/social-stats/accounts?companyCode=${encodeURIComponent(ctx.selectedProjectId)}`, ctx.csrfOptions('PUT', payload)); out.textContent = 'Сохранено.'; await load(); }
      catch (error) { out.textContent = error.message; }
    });
  }
  sb.registerView('social-stats', { title: 'Соцсети', render, onProjectChange: render });
})();
