/* Отдельный список приватных исходников. Подключается владельцем экрана материалов;
   не меняет общий роутер и не включает приём Telegram. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SbCabinet = root.SbCabinet || {}).telegramSources = api;
}(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  function mount({element, companyCode, request}) {
    if (!/^[a-z0-9_-]{1,64}$/.test(companyCode) || typeof request !== 'function') throw new Error('Не указан проект исходников');
    const doc = element.ownerDocument; let stopped = false, loading = false, cursor = null;
    const make = (tag, text) => { const node = doc.createElement(tag); if (text) node.textContent = text; return node; };
    const heading = make('h3', 'Исходники из Telegram'), status = make('p', 'Загружаем исходники…');
    status.setAttribute('role', 'status');
    const note = make('p', 'Здесь появляются новые материалы после подключения. Старую историю бот не загружает. Публикации создаются и согласуются отдельно.');
    const list = make('ul'), more = make('button', 'Показать ещё'); more.type = 'button'; more.hidden = true;
    const retry = make('button', 'Повторить загрузку'); retry.type = 'button'; retry.hidden = true;
    element.replaceChildren(heading, status, note, list, more, retry);
    const link = (label, href) => { const a = make('a', label); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; };
    async function load() {
      if (stopped || loading) return;
      loading = true; retry.hidden = true; more.disabled = true;
      try {
        const data = await request(`/content/telegram-sources/${companyCode}${cursor ? '?before=' + cursor : ''}`);
        if (stopped) return;
        for (const item of data.items || []) {
          const row = make('li'), title = make('strong', item.name || 'Сообщение с исходниками'); row.append(title);
          row.append(make('p', item.status === 'stored' ? 'Файл сохранён' : item.status === 'text' ? 'Текст сохранён' : 'Нужен ручной импорт'));
          if (item.caption) row.append(make('p', item.caption));
          if (item.reason) row.append(make('p', item.reason));
          if (Number.isFinite(item.size)) row.append(make('p', `${(item.size / 1024 / 1024).toLocaleString('ru-RU', {maximumFractionDigits: 1})} МБ`));
          // Серверные ссылки также ограничены своей компанией и HTTPS Telegram.
          if (item.status === 'stored' && new RegExp(`^/content/telegram-sources/${companyCode}/[1-9]\\d*/file$`).test(item.fileUrl || '')) row.append(link('Скачать файл', item.fileUrl));
          if (/^https:\/\/t\.me\/c\/\d+\/\d+$/.test(item.telegramUrl || '')) { row.append(doc.createTextNode(' · ')); row.append(link('Открыть сообщение в Telegram', item.telegramUrl)); }
          list.append(row);
        }
        cursor = Number.isSafeInteger(data.nextBefore) && data.nextBefore > 0 ? data.nextBefore : null;
        more.hidden = !cursor;
        status.textContent = `${data.enabled ? 'Приём новых исходников включён.' : 'Приём новых исходников выключен.'}${list.children.length ? '' : ' Сохранённых исходников пока нет.'}`;
      } catch { if (!stopped) { status.textContent = 'Не удалось загрузить исходники. Проверьте доступ к проекту и повторите.'; retry.hidden = false; } }
      finally { loading = false; more.disabled = false; }
    }
    more.addEventListener('click', load); retry.addEventListener('click', load); void load();
    return {destroy() { stopped = true; element.replaceChildren(); }};
  }
  return {mount};
}));
