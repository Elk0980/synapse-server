/* Read-only response times. No forecasts, sends, connection changes or storage. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.defineProperty(root, 'PalitraResponseReportUI', { value: api, writable: false });
})(typeof globalThis === 'undefined' ? window : globalThis, () => {
  const LABELS = Object.freeze({ site: 'Сайт', telegram: 'Telegram', vk: 'ВКонтакте', instagram: 'Instagram', youtube: 'YouTube', tiktok: 'TikTok' });
  const ids = Object.keys(LABELS), count = value => Number.isSafeInteger(value) && value >= 0;
  const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  function envelope(value) {
    if (!value || value.schema !== 'palitra-response-report/v1' || value.companyCode !== 'palitra-love' || !date(value.asOf) || !value.coverage || !['observing', 'not_started'].includes(value.coverage.status) || !Array.isArray(value.channels) || value.channels.length !== ids.length || new Set(value.channels.map(row => row.id)).size !== ids.length) throw new Error('REPORT_INVALID');
    if (value.coverage.status === 'observing' && (!date(value.observationStartedAt) || Date.parse(value.observationStartedAt) > Date.parse(value.asOf))) throw new Error('REPORT_INVALID');
    for (const row of value.channels) {
      if (!ids.includes(row.id) || !['connected', 'not_connected', 'unobserved'].includes(row.status)) throw new Error('REPORT_INVALID');
      for (const metric of [row.first, row.subsequent]) if (!metric || !count(metric.sampleCount) || (metric.sampleCount === 0 ? metric.medianSeconds !== null : typeof metric.medianSeconds !== 'number' || !Number.isFinite(metric.medianSeconds) || metric.medianSeconds < 0)) throw new Error('REPORT_INVALID');
      for (const waiting of [row.waiting, row.beforeObservationWaiting]) if (!waiting || !count(waiting.count) || !Number.isSafeInteger(row.waiting.count + row.beforeObservationWaiting.count) || (waiting.count === 0 ? waiting.oldestSince !== null : !date(waiting.oldestSince) || Date.parse(waiting.oldestSince) > Date.parse(value.asOf))) throw new Error('REPORT_INVALID');
    }
    return value;
  }
  function duration(seconds) {
    if (seconds < 60) return `${seconds.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} с`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} мин${seconds % 60 >= 1 ? ` ${Math.floor(seconds % 60)} с` : ''}`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours} ч ${minutes % 60} мин` : `${Math.floor(hours / 24)} д ${hours % 24} ч`;
  }
  const when = value => new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  function create({ document: doc, window: win, read } = {}) {
    if (!doc || !win || typeof read !== 'function') throw new TypeError('Нужен разрешённый источник отчёта');
    const h = (tag, props, ...children) => { const node = doc.createElement(tag); for (const [key, value] of Object.entries(props || {})) { if (key === 'text') node.textContent = value; else if (key === 'onclick') node.addEventListener('click', value); else if (key === 'disabled') node.disabled = Boolean(value); else node.setAttribute(key, value); } for (const child of children.flat(Infinity)) if (child != null && child !== false) node.append(child); return node; };
    const element = h('section', { 'data-response-report': '', 'aria-label': 'Фактическое время ответа' });
    let current = null, controller = null, seq = 0, disposed = false, error = '', loading = false;
    function paint() {
      const children = [h('div', { class: 'manager-workspace__heading' }, h('h2', { class: 'text__title', text: 'Время ответа' }), h('button', { type: 'button', class: 'app-btn app-btn--ghost', disabled: loading, 'aria-label': error ? 'Повторить загрузку отчёта времени ответа' : 'Обновить отчёт времени ответа', onclick: () => { void refresh(); }, text: loading ? 'Загружаем…' : error ? 'Повторить' : 'Обновить' }))];
      if (loading) children.push(h('p', { role: 'status', text: 'Загружаем фактические замеры…' }));
      if (error) children.push(h('p', { class: 'app-error', role: 'alert', text: error }));
      if (current) {
        const observing = current.coverage.status === 'observing';
        children.push(h('p', { class: 'muted', text: `По состоянию на ${when(current.asOf)}` }), h('p', { class: 'muted', text: observing ? `Наблюдение с ${when(current.observationStartedAt)}. До запуска время ответа не измерялось.` : 'Наблюдение ещё не началось. Замеров пока нет.' }));
        for (const id of ids) {
          const channel = current.channels.find(row => row.id === id), total = channel.waiting.count + channel.beforeObservationWaiting.count;
          const oldest = [channel.waiting.oldestSince, channel.beforeObservationWaiting.oldestSince].filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
          const metric = (label, value) => [h('dt', { text: label }), h('dd', { text: value.sampleCount ? `${duration(value.medianSeconds)} · замеров: ${value.sampleCount}` : '— · Ещё нет данных' })];
          children.push(h('section', { class: 'card', 'data-response-channel': id }, h('h3', { text: LABELS[id] }), h('p', { class: 'muted', role: 'status', text: channel.status === 'connected' ? 'Подключено' : channel.status === 'not_connected' ? 'Не подключено' : 'Нет подтверждения подключения' }),
            h('dl', { class: 'report' }, metric('Медиана первого ответа', channel.first), metric('Медиана следующих ответов', channel.subsequent)),
            h('p', { text: observing && (total > 0 || channel.status === 'connected') ? `Ждут ответа сейчас: ${total}` : observing ? 'Ожидают ответа: нет подтверждённых данных' : 'Ожидают ответа: ещё нет данных' }),
            observing && oldest ? h('p', { class: 'muted', text: `Самое давнее обращение — ${when(oldest)} · ${duration(Math.max(0, Math.floor((Date.parse(current.asOf) - Date.parse(oldest)) / 1000)))}` }) : null,
            observing && channel.beforeObservationWaiting.count ? h('p', { class: 'muted', text: `Из них до начала наблюдения: ${channel.beforeObservationWaiting.count}. В медианы эти ожидания не входят.` }) : null));
        }
        children.push(h('p', { class: 'muted', text: 'В Telegram ответ учитывается после подтверждения доставки. Для сообщений приложения доступно время последнего обновления подтверждения; для прежних ботов — время завершения отправки.' }));
      }
      element.replaceChildren(...children);
    }
    async function refresh() {
      if (disposed || doc.hidden) return;
      if (controller) controller.abort();
      const own = new win.AbortController(), ticket = ++seq; controller = own; current = null; error = ''; loading = true; paint();
      try {
        const value = envelope(await read({ signal: own.signal }));
        if (disposed || seq !== ticket || own.signal.aborted) return;
        current = value;
      } catch (_) { if (disposed || seq !== ticket || own.signal.aborted) return; current = null; error = 'Не удалось загрузить отчёт. Повторите чтение.'; }
      finally { if (!disposed && seq === ticket && !own.signal.aborted) { loading = false; controller = null; paint(); } }
    }
    function visibility() { if (doc.hidden) { seq++; controller?.abort(); controller = null; current = null; loading = false; paint(); } else void refresh(); }
    function dispose() { if (disposed) return; disposed = true; seq++; controller?.abort(); controller = null; current = null; element.replaceChildren(); doc.removeEventListener('visibilitychange', visibility); }
    doc.addEventListener('visibilitychange', visibility); paint(); void refresh();
    return Object.freeze({ element, refresh, dispose });
  }
  return Object.freeze({ create });
});
