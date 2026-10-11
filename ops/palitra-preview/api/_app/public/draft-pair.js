/*
 * Palitra — парный тест приложения с сайтом-черновиком (только страница тестового просмотра). Подключается после
 * preview.js и до app.js; принятый app.js не меняется.
 * - Кнопка «Проверить с черновиком» (только роли сотрудников) создаёт на сервере НОВУЮ чистую тестовую сессию без
 *   примеров и перезагружает страницу. Сессия сотрудника остаётся в его cookie на этом адресе; в ссылку на черновик
 *   сервер кладёт только отдельный ключ покупателя во фрагменте — его здесь не хранят и не пересылают никуда, кроме
 *   открытия ссылки по нажатию.
 * - Признак пары приходит заголовком X-Preview-Pair в ответе /api/bootstrap, поэтому после перезагрузки панель сама
 *   показывает тот же тест. Сброс/перезапуск сервера по-прежнему обрабатывает preview.js (423, «Начать заново»).
 * - Бот, почта и уведомления ничего не отправляют: панель только объясняет порядок проверки.
 */
'use strict';

(() => {
  const box = document.getElementById('draftPair');
  if (!box) return;
  const select = document.getElementById('actorSelect');
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const STAFF = ['darya', 'varvara', 'vlad'];
  const state = { healthLoaded: false, enabled: false, paired: null, info: null, busy: false, confirm: false, unknown: false, error: '' };

  function actor() {
    if (select && select.value) return select.value;
    try { return sessionStorage.getItem('palitra-demo-actor') || 'varvara'; } catch (_) { return 'varvara'; }
  }
  const isStaffRole = () => STAFF.includes(actor());
  function forgetUnsent() {
    // Неподтверждённые попытки относились к прежней тестовой базе — в новой их проверять нельзя.
    try {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const key = sessionStorage.key(i);
        if (key && key.startsWith('palitra-unsent:')) sessionStorage.removeItem(key);
      }
    } catch (_) { /* хранилище недоступно */ }
  }
  async function request(path, options = {}) {
    const res = await window.fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options,
      headers: { Accept: 'application/json', 'X-Demo-Actor': actor(), ...(options.headers || {}) } });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { res, data };
  }

  /* Наблюдение за загрузкой данных приложения: пара определяется по ответу сервера, а не по сохранённым данным. */
  const previous = window.fetch;
  window.fetch = async function (input, init) {
    const res = await previous.call(window, input, init);
    try {
      const url = new URL(typeof input === 'string' ? input : input && input.url ? input.url : String(input), window.location.href);
      if (url.origin === window.location.origin && url.pathname === '/api/bootstrap' && res.headers && typeof res.headers.get === 'function') {
        const paired = res.headers.get('X-Preview-Pair') === 'active';
        if (paired !== state.paired) { state.paired = paired; refresh(); }
      }
    } catch (_) { /* не мешаем запросу приложения */ }
    return res;
  };

  async function refresh() {
    try {
      if (!state.healthLoaded) {
        const { data } = await request('/api/health');
        state.enabled = Boolean(data && data.testConnection === 'enabled');
        state.healthLoaded = true;
      }
      if (state.paired) {
        const { res, data } = await request('/api/draft-test');
        state.info = res.ok && data && data.pair ? data.pair : null;
      } else state.info = null;
    } catch (_) { /* нет связи — панель покажет общий текст */ }
    render();
  }
  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    const b = window.crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  /* Запуск, новый тест и выход: каждое нажатие — один requestId. Неизвестный исход НЕ повторяется: preview.js уже
     заблокировал старые действия, а перезагрузка покажет, что на самом деле произошло на сервере. */
  async function act(action) {
    if (state.busy || state.unknown) return;
    state.busy = true; state.error = ''; render();
    let res = null, data = null;
    try { ({ res, data } = await request('/api/draft-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, requestId: uuid() }) })); }
    catch (_) { res = null; }
    if (res && [200, 201].includes(res.status) && data && data.ok === true) { forgetUnsent(); window.location.reload(); return; }
    if (res && res.status >= 400 && res.status < 500 && res.headers.get('X-Preview-Session') !== 'switched' && data && typeof data.error === 'string') {
      state.error = data.error; // сервер явно отказал — ничего не изменилось
      state.busy = false; state.confirm = false; render();
      return;
    }
    // Ответ не дошёл или не читается: тест мог переключиться. Без повтора — только обновление страницы.
    state.unknown = true; state.busy = false; state.confirm = false;
    state.error = 'Результат не подтверждён: ответ сервера не дошёл. Повторно не отправляем — нажмите «Обновить страницу», приложение покажет текущее состояние.';
    render();
  }

  /* ---------- разметка ---------- */
  function node(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function button(label, kind, onClick) {
    const b = node('button', `btn ${kind} draft-pair-btn`, label);
    b.type = 'button';
    if (state.busy) b.setAttribute('aria-disabled', 'true');
    b.addEventListener('click', () => { if (!state.busy) onClick(); });
    return b;
  }
  const clock = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : ''; };
  const day = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : ''; };

  function render() {
    const parts = [];
    const actions = node('div', 'draft-pair-actions');
    if (state.unknown) {
      parts.push(node('h2', 'draft-pair-title', 'Проверьте состояние теста'));
      actions.append(button('Обновить страницу', 'btn-primary', () => window.location.reload()));
    } else if (state.paired) {
      const info = state.info;
      parts.push(node('h2', 'draft-pair-title', 'Парный тест с сайтом-черновиком'));
      parts.push(node('p', 'draft-pair-warn', `Это проверка, не CRM и не настоящие заказы. Данные живут только в памяти тестового сервера${info ? ` — до ${clock(info.expiresAt)}` : ''}: не дольше 6 часов, при простое ${info ? info.idleMinutes : 60} минут или перезапуске сервера тест сбросится. Бот, почта и уведомления ничего не отправляют.`));
      if (info && info.price && info.price.updatedAt) parts.push(node('p', 'draft-pair-note', `Цены — снимок публичного прайса черновика от ${day(info.price.updatedAt)}, не живой прайс.`));
      if (!isStaffRole()) {
        parts.push(node('p', 'draft-pair-note', 'Вы смотрите глазами тестового покупателя черновика: здесь те же его заказы, что и на сайте в «Моих тестовых заказах». Имя вымышленное.'));
      } else if (info && info.draftUrl) {
        const steps = node('ol', 'draft-pair-steps');
        for (const text of ['Откройте черновик кнопкой ниже — ссылка срабатывает в одном браузере.',
          'На сайте дождитесь надписи «Тест сайта с приложением Palitra» и отправьте обычную форму или корзину.',
          'Вернитесь в это меню Telegram и нажмите «Обновить»: заявка на подбор — в «Обращениях», корзина — сразу в «Заказах» (источник «Сайт»). Сами уведомления не приходят — смотрите после обновления.']) steps.append(node('li', '', text));
        parts.push(steps);
        const link = node('a', 'btn btn-primary draft-pair-btn', 'Открыть черновик');
        link.href = info.draftUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.addEventListener('click', (ev) => {
          if (tg && typeof tg.openLink === 'function') { ev.preventDefault(); try { tg.openLink(info.draftUrl); } catch (_) { window.open(info.draftUrl, '_blank', 'noopener'); } }
        });
        actions.append(link);
      } else if (info && info.claimed) {
        parts.push(node('p', 'draft-pair-note', 'Ссылка уже открыта на черновике. Покупатель видит свои заказы там — «Мои тестовые заказы». После его действий нажмите «Обновить». Для другого браузера начните новый тест.'));
      } else {
        parts.push(node('p', 'draft-pair-note', 'Сведения о тесте не загрузились. Нажмите «Обновить».'));
      }
      actions.append(button('Обновить', 'btn-secondary', () => window.location.reload()));
      if (isStaffRole()) {
        if (state.confirm) {
          parts.push(node('p', 'draft-pair-warn', 'Начать новый тест? Текущие тестовые заказы и ссылка перестанут действовать.'));
          actions.append(button('Да, новый тест', 'btn-primary', () => act('restart')), button('Отмена', 'btn-quiet', () => { state.confirm = false; render(); }));
        } else actions.append(button('Новый тест', 'btn-quiet', () => { state.confirm = true; render(); }));
      }
      actions.append(button('Выйти из теста', 'btn-quiet', () => act('leave')));
    } else if (state.paired === false && state.enabled) {
      parts.push(node('h2', 'draft-pair-title', 'Проверить путь с сайта'));
      if (isStaffRole()) {
        parts.push(node('p', 'draft-pair-note', 'Создаст отдельный чистый тест: без примеров, с прайсом черновика. Вы получите ссылку на черновик для покупателя, а его заказ появится здесь. Текущие примеры этой сессии закроются.'));
        actions.append(button(state.busy ? 'Создаём тест…' : 'Проверить с черновиком', 'btn-primary', () => act('start')));
      } else {
        parts.push(node('p', 'draft-pair-note', 'Тест с сайтом-черновиком запускает сотрудник — выберите Дарью, Варвару или Влада.'));
      }
    } else { box.hidden = true; box.replaceChildren(); return; }
    if (state.error) parts.push(node('p', 'draft-pair-error', state.error));
    if (actions.childNodes.length) parts.push(actions);
    box.replaceChildren(...parts);
    box.hidden = false;
  }

  if (select) select.addEventListener('change', () => { state.confirm = false; state.error = ''; refresh(); });
})();
