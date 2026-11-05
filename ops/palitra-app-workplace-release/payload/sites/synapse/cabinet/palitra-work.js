/* Palitra — рабочее место (PALITRA-APP-WORKPLACE 13.10.2026). Один адрес для браузера и Telegram WebView:
   https://synapse.synapsebusiness.ru/cabinet/palitra-work.html. Четыре вкладки: Заявки / Переписка / Товары / Сайт.

   Правила:
   - вход — обычный кабинет Synapse (POST /content/login, cookie synapse_session HttpOnly), роль — только из ответа
     GET /content/whoami этой сессии; CSRF живёт только в памяти страницы, токенов в URL и постоянном хранилище нет;
     Telegram initData входом не считается;
   - данные — только ответы сервера (без демо и без «сохранено» по локальному состоянию); 401 — экран входа;
   - каждое чтение привязано к эпохе сессии и к своему номеру запроса: ответ, пришедший после выхода, 401, смены
     аккаунта или более нового запроса того же списка/диалога, экран не меняет;
   - тексты клиентов и заявок выводятся только через textContent;
   - ответ клиенту: requestId создаётся один раз на текст и записывается до отправки. Исход неизвестен при отсутствии
     ответа, 408, любом 5xx (включая 503) и нечитаемом ответе. Неизвестная запись принадлежит одному пользователю и
     одному диалогу: повторить её можно только отдельной кнопкой в том же диалоге тем же requestId; пока она не решена,
     новые ответы не отправляются ни в один диалог. Снимается запись только подтверждением сервера (квитанция
     повтора) или явным «Отказаться»; отказ повторной попытки (401/403/4xx/5xx) исход первой не доказывает.
     «Доставлено» — только по статусу сервера после подтверждения Telegram;
   - «Товары» и «Сайт» — постоянные iframe штатных редакторов того же адреса: создаются один раз и при смене вкладки
     только скрываются (несохранённые правки в памяти редактора не теряются); при выходе закрываются. */
'use strict';

(() => {
  const SITE = 'palitra';
  const API = `/content/${SITE}`;
  const TIMEOUT_MS = 15000;
  const PENDING_PREFIX = 'palitra-work-unknown-reply-v2:';
  const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const FRAMES = Object.freeze({
    products: Object.freeze({ src: '/price-editor-palitra.html?site=https%3A%2F%2Fpalitra-love.ru', path: '/price-editor-palitra.html', title: 'Товары и прайс Palitra' }),
    site: Object.freeze({ src: '/cabinet/site-photos.html', path: '/cabinet/site-photos.html', title: 'Фото сайта Palitra' })
  });
  // Пункты меню внутри редакторов: точные пути того же адреса. Остальные ссылки ведут себя как обычно.
  const FRAME_ROUTES = Object.freeze({ '/price-editor-palitra.html': 'products', '/cabinet/site-photos.html': 'site' });
  const FRAME_EXTERNAL = new Set(['/palitra-review/']);  // таблица задач запрещает встраивание — отдельная вкладка
  const FRAME_STAY = new Set(['/cabinet/palitra-editor.html']);  // старый хаб: в приложении не нужен
  const TABS = ['orders', 'chat', 'products', 'site'];
  const WORK = Object.freeze({ new: 'Новая', in_work: 'В работе', done: 'Выполнена', cancelled: 'Отменена' });
  const NOTIFY = Object.freeze({ pending: 'в очереди', sending: 'отправляется', sent: 'доставлено', uncertain: 'доставка не подтверждена',
    error: 'не доставлено', not_queued: 'не поставлено в очередь', missing_binding: 'группа не настроена' });
  const DELIVERY = Object.freeze({ pending: 'В очереди', sending: 'Отправляется', sent: 'Доставлено', uncertain: 'Доставка не подтверждена', failed: 'Не доставлено' });
  const CHANNEL = Object.freeze({ phone: 'Телефон', whatsapp: 'WhatsApp', telegram: 'Telegram', max: 'MAX' });
  const AUTHOR = Object.freeze({ client: 'Клиент', operator: 'Менеджер', system: 'Бот' });
  const UNKNOWN_TEXT = 'Исход прошлой отправки неизвестен. Проверьте историю выше и нажмите «Проверить и повторить ту же отправку»: уйдёт тот же ответ с тем же номером запроса, дубля не будет.';
  const BLOCKED_TEXT = 'Проверьте предыдущий ответ: его отправка в другом диалоге не завершена или исход неизвестен. Пока он не решён, новые ответы не отправляются.';

  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  const state = { user: null, csrf: '', epoch: 0, authSeq: 0, loginAttempt: 0, seq: { orders: 0, dialogs: 0, dialog: 0 }, tab: 'orders', loaded: {},
    ordersCursor: null, dialogsCursor: null, dialogId: null, dialog: null, composerDialog: null, pending: null, sending: false, frames: {}, poll: 0 };
  const readers = new Set();  // AbortController текущих GET: отменяются при смене эпохи
  const vault = new Map();    // userId → неразрешённая отправка; дублирует sessionStorage, если он недоступен

  /* ---------- эпоха сессии и номера запросов ---------- */
  // Ответ чтения применяется, только если с его начала не сменилась эпоха и не начат более новый запрос того же вида.
  function ticket(name) {
    const epoch = state.epoch, number = ++state.seq[name];
    return () => epoch === state.epoch && state.seq[name] === number;
  }
  function epochTicket() {
    const epoch = state.epoch;
    return () => epoch === state.epoch;
  }
  /* Попытка входа: проверка входа при загрузке (start), отправка формы входа, выход. Цепочка попытки (её whoami,
     login, logout, catch и finally) меняет экран и вызывает enter, только пока не начата другая попытка и не сменилась
     эпоха. Новая попытка сразу освобождает форму входа от прежней: поздняя прежняя цепочка её больше не трогает.
     Билет берётся после собственного invalidate() цепочки; enter() сам начинает новую эпоху, поэтому проверка — до него. */
  function authTicket() {
    const number = ++state.authSeq, epoch = state.epoch;
    if (state.loginAttempt) { state.loginAttempt = 0; resetLoginButton(); }
    return { number, live: () => state.authSeq === number && state.epoch === epoch };
  }
  function resetLoginButton() { const button = $('pw-login-submit'); button.disabled = false; button.textContent = 'Войти'; }
  // Новая эпоха: выход, 401, новый вход. Начатые чтения отменяются, их поздние ответы экран не меняют.
  function invalidate() {
    state.epoch += 1;
    for (const controller of readers) controller.abort();
    readers.clear();
    stopPoll();
  }

  /* ---------- сеть ---------- */
  /* Исход записи: unknown — запрос мог быть принят (нет ответа, 408, любой 5xx, нечитаемый ответ);
     refused — получен отказ 4xx (кроме 408): именно этот запрос сервер не принял. Для чтения оба флага false. */
  class ApiError extends Error {
    constructor(message, status, { unknown = false, refused = false } = {}) { super(message); this.status = status; this.unknown = unknown; this.refused = refused; }
  }
  async function api(path, { method = 'GET', body, auth = true } = {}) {
    const write = method !== 'GET';
    const epoch = state.epoch, attempt = state.authSeq;
    const controller = new AbortController();
    if (!write) readers.add(controller);
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res, data = null;
    try {
      res = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(write && state.csrf ? { 'X-CSRF-Token': state.csrf } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined });
      try { data = await res.json(); } catch (_) { data = null; }
    } catch (_) {
      // Запрос мог дойти до сервера: для записи исход неизвестен.
      throw new ApiError('Нет ответа сервера. Проверьте связь.', 0, { unknown: write });
    } finally { clearTimeout(timer); readers.delete(controller); }
    if (res.status === 401 && auth) {
      // Поздний 401 запроса прежней эпохи или прежней попытки входа не закрывает новую сессию и не мешает новому входу.
      if (epoch === state.epoch && attempt === state.authSeq) sessionEnded();
      throw new ApiError('Сессия закончилась. Войдите снова.', 401, { refused: write });
    }
    if (!res.ok) {
      const message = data && typeof data.error === 'string' && data.error ? data.error : `Сервер не выполнил запрос (${res.status})`;
      // Ни код 5xx, ни текст ошибки не доказывают, что запись не состоялась (прокси мог ответить после commit).
      const unknown = write && (res.status >= 500 || res.status === 408);
      throw new ApiError(message, res.status, { unknown, refused: write && !unknown && res.status >= 400 && res.status < 500 });
    }
    if (!data || typeof data !== 'object') throw new ApiError('Ответ сервера не удалось прочитать.', res.status, { unknown: write });
    return { status: res.status, data };
  }

  /* ---------- вход ---------- */
  const say = (text, error = false) => { const node = $('pw-status'); node.textContent = text || ''; node.dataset.state = error ? 'error' : ''; node.hidden = !text; };
  function showOnly(section) {
    $('pw-login').hidden = section !== 'login';
    $('pw-denied').hidden = section !== 'denied';
    $('pw-main').hidden = section !== 'main';
    $('pw-tabs').hidden = section !== 'main';
    $('pw-user').hidden = !(section === 'main' || section === 'denied');
  }
  // Проверка входа по cookie. Возвращает true, только если именно эта цепочка вошла (вызвала enter).
  async function start() {
    const auth = authTicket();
    say('Проверяем вход…');
    try {
      const { data } = await api('/content/whoami');
      if (!auth.live()) return false;  // поздний ответ: после выхода или другого входа старый аккаунт не возвращается
      enter(data);
      return Boolean(state.user);
    } catch (error) {
      if (!auth.live() || error.status === 401) return false;  // 401 актуальной попытки уже показал вход (api → sessionEnded)
      say(`${error.message} Обновите страницу.`, true);
      return false;
    }
  }
  function enter(identity) {
    const id = Number(identity && identity.userId);
    if (!identity || !Number.isSafeInteger(id) || typeof identity.csrfToken !== 'string' || !identity.csrfToken) {
      say('Сервер не подтвердил вход. Обновите страницу.', true);
      return;
    }
    // Каждый вход — новая эпоха и чистый экран: ничего из прежней сессии или другого аккаунта не переносится.
    invalidate();
    clearView();
    state.user = { id, name: String(identity.displayName || identity.login || 'Владелец'), role: identity.role };
    state.csrf = identity.csrfToken;
    $('pw-user-name').textContent = state.user.name;
    say('');
    if (identity.role !== 'owner') { showOnly('denied'); return; }
    showOnly('main');
    // Неразрешённая отправка возвращается только тому же пользователю.
    state.pending = loadPending(id);
    if (state.pending) say('Есть ответ клиенту с неизвестным исходом. Откройте «Переписку»: повторить его можно только в том же диалоге.');
    renderComposer();
    setTab(state.tab, { focus: false });
  }
  function showLogin(note) {
    showOnly('login');
    say('');
    $('pw-login-note').textContent = note || 'Обычный логин и пароль кабинета Synapse.';
    $('pw-login-error').textContent = '';
    const login = $('pw-login-form').elements.login;
    if (login && document.activeElement !== login) login.focus();
  }
  // Экран прежней сессии: списки, диалог, черновик и редакторы убираются; неразрешённая отправка остаётся за автором
  // (vault/sessionStorage по userId), но из памяти страницы удаляется — другой аккаунт её не увидит.
  function clearView() {
    closeFrames();
    state.loaded = {}; state.ordersCursor = null; state.dialogsCursor = null;
    state.dialogId = null; state.dialog = null; state.composerDialog = null; state.pending = null;
    $('orders-list').replaceChildren(); $('dialogs-list').replaceChildren(); $('chat-messages').replaceChildren();
    $('chat-title').textContent = ''; $('chat-meta').textContent = '';
    for (const id of ['orders-status', 'dialogs-status', 'chat-status']) panelStatus(id, '');
    $('orders-more').hidden = true; $('dialogs-more').hidden = true;
    $('composer-text').value = ''; composerState('');
    showDialogList();
    renderComposer();
  }
  function endSession(note) {
    invalidate();
    clearView();
    state.user = null; state.csrf = '';
    $('pw-user-name').textContent = '';
    showLogin(note);
  }
  function sessionEnded() {
    const user = state.user;
    endSession(user ? `Сессия закончилась. Войдите снова.${vault.has(user.id) ? ' Ответ клиенту с неизвестным исходом сохранён за вашим аккаунтом до проверки.' : ''}` : '');
  }
  $('pw-login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget, button = $('pw-login-submit'), error = $('pw-login-error');
    if (button.disabled) return;
    const login = form.elements.login.value.trim(), password = form.elements.password.value;
    if (!login || !password) { error.textContent = 'Введите логин и пароль.'; return; }
    form.elements.password.value = '';  // пароль живёт только в этой цепочке, в поле не остаётся
    const auth = authTicket();
    state.loginAttempt = auth.number;
    state.csrf = '';  // форма входа видна только без сессии: CSRF прежней сессии в новую попытку не уходит
    button.disabled = true; error.textContent = ''; button.textContent = 'Входим…';
    let step = 'login';
    try {
      await api('/content/login', { method: 'POST', body: { login, password }, auth: false });
      if (!auth.live()) return;
      step = 'whoami';
      const { data } = await api('/content/whoami');
      if (!auth.live()) return;  // поздний ответ входа: после выхода или другой попытки экран не меняется
      enter(data);
    } catch (failure) {
      if (state.authSeq !== auth.number) return;  // начата другая попытка входа или выход
      if (step === 'whoami' && failure.status === 401) {
        // Своя же проверка входа получила 401 (api уже показал экран входа): cookie сессии не сохранилась.
        error.textContent = 'Вход не подтвердился: браузер не сохранил сессию. Проверьте, что cookie для этого адреса разрешены, и войдите снова.';
        return;
      }
      if (!auth.live()) return;
      error.textContent = failure.status === 401 ? 'Неверный логин или пароль.' : failure.message;
      showOnly('login');
    } finally {
      // Форма принадлежит этой попытке, пока её не забрала новая (authTicket уже освободил кнопку).
      if (state.loginAttempt === auth.number) { state.loginAttempt = 0; resetLoginButton(); }
    }
  });
  $('pw-logout').addEventListener('click', async () => {
    const button = $('pw-logout');
    if (button.disabled) return;
    button.disabled = true;
    const user = state.user;
    // Экран, редакторы и чтения прежней сессии гасятся сразу: поздние ответы не вернут данные после выхода.
    invalidate();
    clearView();
    // Прежний аккаунт забывается сразу; CSRF остаётся только для самого запроса выхода.
    state.user = null;
    $('pw-user-name').textContent = '';
    showOnly('none');
    say('Выходим…');
    const auth = authTicket();  // после invalidate: эта цепочка сама сменила эпоху
    try {
      await api('/content/logout', { method: 'POST', body: {}, auth: false });
      if (!auth.live()) return;  // поздний ответ выхода не трогает CSRF и экран уже начатого нового входа
      state.csrf = '';
      showLogin(`Вы вышли из кабинета.${user && vault.has(user.id) ? ' Ответ клиенту с неизвестным исходом сохранён за вашим аккаунтом в этой вкладке до проверки.' : ''}`);
    } catch (error) {
      if (!auth.live()) return;
      state.csrf = '';
      // Выход не подтверждён: экран восстанавливается только штатной проверкой входа и свежими данными новой эпохи.
      if (await start()) say(`Выход не подтверждён сервером: ${error.message} Повторите выход.`, true);
    } finally { button.disabled = false; }
  });

  /* ---------- вкладки ---------- */
  function setTab(name, { focus = true } = {}) {
    if (!TABS.includes(name) || !state.user) return;
    state.tab = name;
    for (const tab of TABS) {
      const button = $(`tab-${tab}`), panel = $(`panel-${tab}`), on = tab === name;
      button.setAttribute('aria-selected', String(on));
      button.tabIndex = on ? 0 : -1;
      panel.hidden = !on;
    }
    if (focus) $(`tab-${name}`).focus();
    if (name === 'orders' && !state.loaded.orders) loadOrders();
    if (name === 'chat' && !state.loaded.dialogs) loadDialogs();
    else if (name === 'chat' && state.dialogId && state.dialog) openDialog(state.dialogId, { quiet: true });
    if (FRAMES[name]) ensureFrame(name);
  }
  $('pw-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (button) setTab(button.dataset.tab);
  });
  $('pw-tabs').addEventListener('keydown', (event) => {
    const index = TABS.indexOf(state.tab);
    const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    setTab(TABS[next]);
  });

  /* ---------- редакторы во вкладках ---------- */
  function frameNote(name, text, { reloadButton = false, openLink = false } = {}) {
    const note = $(`${name}-note`);
    note.replaceChildren();
    if (!text) { note.hidden = true; return; }
    note.append(el('p', '', text));
    const row = el('div', 'pw-row');
    if (openLink) {
      const link = el('a', 'pw-btn', 'Открыть редактор в новой вкладке');
      link.href = FRAMES[name].src; link.target = '_blank'; link.rel = 'noopener noreferrer';
      row.append(link);
    }
    if (reloadButton) {
      const button = el('button', 'pw-btn pw-btn--quiet', 'Вернуть редактор');
      button.type = 'button';
      button.addEventListener('click', () => { const item = state.frames[name]; if (item) { frameNote(name, ''); item.frame.src = FRAMES[name].src; } });
      row.append(button);
    }
    if (row.childNodes.length) note.append(row);
    note.hidden = false;
  }
  function ensureFrame(name) {
    if (state.frames[name]) return;
    const config = FRAMES[name];
    const frame = el('iframe', 'pw-frame');
    frame.title = config.title;
    frame.setAttribute('referrerpolicy', 'same-origin');
    const item = { frame, loaded: false, timer: 0 };
    frame.addEventListener('load', () => { item.loaded = true; clearTimeout(item.timer); inspectFrame(name); });
    item.timer = setTimeout(() => { if (!item.loaded && state.frames[name] === item) frameNote(name, 'Редактор долго не открывается.', { openLink: true }); }, 20000);
    state.frames[name] = item;
    frame.src = config.src;
    $(`${name}-host`).append(frame);
  }
  function inspectFrame(name) {
    const item = state.frames[name];
    if (!item) return;
    const config = FRAMES[name];
    let doc, loc;
    try { doc = item.frame.contentDocument; loc = item.frame.contentWindow.location; } catch (_) { doc = null; }
    // Встраивание запрещено заголовками или открылась чужая страница — честная обычная ссылка на тот же редактор.
    if (!doc || !loc || loc.href === 'about:blank' || loc.origin !== window.location.origin) {
      frameNote(name, 'Редактор нельзя показать внутри приложения.', { openLink: true });
      return;
    }
    if (loc.pathname !== config.path) {
      frameNote(name, 'Редактор перешёл на другую страницу.', { reloadButton: true, openLink: true });
      return;
    }
    frameNote(name, '');
    if (doc.__palitraWorkRouted) return;
    doc.__palitraWorkRouted = true;
    doc.addEventListener('click', (event) => {
      const link = event.target && typeof event.target.closest === 'function' ? event.target.closest('a[href]') : null;
      if (!link) return;
      let url;
      try { url = new URL(link.getAttribute('href'), loc.href); } catch (_) { return; }
      if (url.origin !== window.location.origin) return;  // «Открыть сайт» и прочие внешние ссылки — как есть
      if (Object.hasOwn(FRAME_ROUTES, url.pathname)) { event.preventDefault(); setTab(FRAME_ROUTES[url.pathname]); return; }
      if (FRAME_EXTERNAL.has(url.pathname)) { event.preventDefault(); window.open(url.href, '_blank', 'noopener,noreferrer'); return; }
      if (FRAME_STAY.has(url.pathname)) event.preventDefault();
    }, true);
  }
  function closeFrames() {
    for (const name of Object.keys(state.frames)) {
      const item = state.frames[name];
      clearTimeout(item.timer);
      item.frame.remove();
      frameNote(name, '');
    }
    state.frames = {};
  }

  /* ---------- форматирование ---------- */
  const when = (iso) => {
    const time = Date.parse(iso || '');
    return Number.isFinite(time) ? new Date(time).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  };
  const rub = (kopecks) => (Number.isFinite(Number(kopecks)) ? `${(Number(kopecks) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽` : '');
  const digitsOf = (value) => { let d = String(value || '').replace(/\D/g, ''); if (d.length === 11 && d.startsWith('8')) d = `7${d.slice(1)}`; return d; };
  function panelStatus(id, text, error = false) { const node = $(id); node.textContent = text || ''; node.dataset.state = error ? 'error' : ''; }

  /* ---------- заявки ---------- */
  async function loadOrders({ append = false } = {}) {
    if (!state.user) return;
    const live = ticket('orders');
    panelStatus('orders-status', 'Загружаем заявки…');
    $('orders-more').hidden = true;
    try {
      const cursor = append && state.ordersCursor ? `&beforeId=${encodeURIComponent(state.ordersCursor)}` : '';
      const { data } = await api(`${API}/orders?limit=20${cursor}`);
      if (!live()) return;
      const list = $('orders-list');
      if (!append) list.replaceChildren();
      for (const order of Array.isArray(data.orders) ? data.orders : []) list.append(orderCard(order));
      state.ordersCursor = data.nextCursor || null;
      state.loaded.orders = true;
      $('orders-more').hidden = !state.ordersCursor;
      panelStatus('orders-status', list.childElementCount ? '' : 'Заявок пока нет.');
    } catch (error) {
      if (!live() || error.status === 401) return;
      panelStatus('orders-status', `Заявки не загрузились: ${error.message}`, true);
    }
  }
  function notifyLine(label, job) {
    if (job === null) return null;
    const status = job && job.status ? (NOTIFY[job.status] || job.status) : 'не отправлялось';
    return el('p', 'pw-card__line', `${label}: ${status}`);
  }
  function contactAction(order) {
    const channel = order.contactChannel || 'phone';
    const contact = order.contact || order.phone || '';
    const box = el('div', 'pw-card__contact');
    box.append(el('p', 'pw-card__line', `${CHANNEL[channel] || 'Контакт'}: ${contact}`));
    let href = '', label = '';
    if ((channel === 'phone' || channel === 'whatsapp') && digitsOf(contact).length >= 10) {
      href = channel === 'phone' ? `tel:+${digitsOf(contact)}` : `https://wa.me/${digitsOf(contact)}`;
      label = channel === 'phone' ? 'Позвонить' : 'Открыть WhatsApp (вне приложения)';
    } else if (channel === 'telegram' && /^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(contact)) {
      href = `https://t.me/${contact.slice(1)}`; label = 'Открыть Telegram (личный чат, вне приложения)';
    } else if (channel === 'max') {
      box.append(el('p', 'pw-muted', 'Связь через MAX — вне приложения.'));
    }
    if (href) {
      const link = el('a', 'pw-btn pw-btn--quiet', label);
      link.href = href;
      if (!href.startsWith('tel:')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      box.append(link);
    }
    return box;
  }
  function orderCard(order) {
    const card = el('li', 'pw-card');
    card.dataset.orderId = String(order.id);
    const head = el('div', 'pw-card__head');
    head.append(el('h2', 'pw-card__title', `Заявка №${order.id}`), el('span', 'pw-muted', `${order.kind === 'cart' ? 'Корзина' : 'Подбор'} · ${when(order.createdAt)}`));
    card.append(head);
    if (order.name) card.append(el('p', 'pw-card__name', order.name));
    card.append(contactAction(order));
    if (Array.isArray(order.items) && order.items.length) {
      const items = el('ul', 'pw-card__items');
      for (const item of order.items) items.append(el('li', '', `${item.title || item.id} × ${item.qty}${item.price === null || item.price === undefined ? ' — цена уточняется' : ''}`));
      card.append(items);
      card.append(el('p', 'pw-card__line', `Итого по известным ценам: ${rub(order.knownTotal)}${order.unknownCount ? ` (ещё ${order.unknownCount} поз. уточняются)` : ''}`));
    }
    const delivery = [order.deliveryAddress, order.deliveryDate, order.deliveryInterval].filter(Boolean).join(' · ');
    if (delivery) card.append(el('p', 'pw-card__line', `Получение: ${delivery}`));
    if (order.comment) card.append(el('p', 'pw-card__comment', order.comment));
    for (const line of [notifyLine('Уведомление менеджеру', order.notify || undefined), notifyLine('Уведомление группе', order.groupNotify)]) if (line) card.append(line);

    const work = order.work && WORK[order.work.status] ? order.work.status : 'new';
    const workBox = el('div', 'pw-card__work');
    workBox.append(el('p', 'pw-card__line', `Обработка: ${WORK[work]}${order.work && order.work.updatedBy ? ` · ${order.work.updatedBy}` : ''}`));
    const row = el('div', 'pw-row');
    for (const status of ['in_work', 'done', 'cancelled', 'new']) {
      if (status === work) continue;
      const button = el('button', 'pw-btn pw-btn--quiet', status === 'new' ? 'Вернуть в новые' : WORK[status]);
      button.type = 'button';
      button.addEventListener('click', () => setWork(card, order, status, work, button));
      row.append(button);
    }
    workBox.append(row);
    card.append(workBox);

    if (order.checklist && Array.isArray(order.checklist.items)) {
      const checks = el('div', 'pw-card__checks');
      checks.append(el('p', 'pw-muted', 'Ручные отметки менеджера (не подтверждение доставки):'));
      for (const item of order.checklist.items) {
        const button = el('button', `pw-check${item.checked ? ' is-on' : ''}`, `${item.checked ? '✓' : '○'} ${item.label}`);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(Boolean(item.checked)));
        button.addEventListener('click', () => setCheck(card, order, item, button));
        checks.append(button);
      }
      card.append(checks);
    }
    const chat = el('button', 'pw-btn', 'Переписка');
    chat.type = 'button';
    chat.addEventListener('click', () => openOrderDialog(card, order, chat));
    card.append(chat);
    card.append(el('p', 'pw-card__note', ''));
    return card;
  }
  const cardNote = (card, text, error = false) => { const node = card.querySelector('.pw-card__note'); node.textContent = text || ''; node.dataset.state = error ? 'error' : ''; };
  async function setWork(card, order, status, expected, button) {
    if (button.disabled) return;
    const live = epochTicket();
    for (const node of card.querySelectorAll('.pw-card__work button')) node.disabled = true;
    cardNote(card, 'Сохраняем статус…');
    try {
      const { data } = await api(`${API}/orders/${order.id}/work`, { method: 'PUT', body: { status, expected } });
      if (!live()) return;
      const next = orderCard({ ...order, work: data.work });
      card.replaceWith(next);
      cardNote(next, data.changed ? `Статус сохранён: ${WORK[data.work.status]}` : `Статус уже был: ${WORK[data.work.status]}`);
    } catch (error) {
      if (!live() || error.status === 401) return;
      for (const node of card.querySelectorAll('.pw-card__work button')) node.disabled = false;
      cardNote(card, error.status === 409 ? 'Статус уже изменён в другом месте. Обновите список.' : error.unknown
        ? 'Не удалось подтвердить сохранение. Обновите список и проверьте статус.' : error.message, true);
    }
  }
  async function setCheck(card, order, item, button) {
    if (button.disabled) return;
    const live = epochTicket();
    button.disabled = true;
    cardNote(card, 'Сохраняем отметку…');
    try {
      const { data } = await api(`${API}/orders/${order.id}/checklist`, { method: 'PUT', body: { item: item.key, checked: !item.checked, revision: item.revision } });
      if (!live()) return;
      const next = orderCard(data.order || order);
      card.replaceWith(next);
      cardNote(next, data.changed ? 'Отметка сохранена.' : 'Отметка уже была сохранена.');
    } catch (error) {
      if (!live() || error.status === 401) return;
      button.disabled = false;
      cardNote(card, error.status === 409 ? 'Отметка уже изменена в другом месте. Обновите список.' : error.message, true);
    }
  }
  async function openOrderDialog(card, order, button) {
    if (button.disabled) return;
    const live = epochTicket();
    button.disabled = true;
    cardNote(card, 'Ищем переписку по этой заявке…');
    try {
      const { data } = await api(`${API}/orders/${order.id}/dialog`);
      if (!live()) return;
      if (Number.isSafeInteger(data.dialogId) && data.dialogId > 0) {
        cardNote(card, '');
        setTab('chat');
        openDialog(data.dialogId);
      } else {
        cardNote(card, 'По этой заявке клиент не писал в бот Palitra, поэтому ответить из приложения нельзя. Свяжитесь по контакту из заявки.');
      }
    } catch (error) {
      if (!live() || error.status === 401) return;
      cardNote(card, `Переписку не удалось проверить: ${error.message}`, true);
    } finally { if (live()) button.disabled = false; }
  }
  $('orders-refresh').addEventListener('click', () => { state.ordersCursor = null; loadOrders(); });
  $('orders-more').addEventListener('click', () => loadOrders({ append: true }));

  /* ---------- переписка ---------- */
  async function loadDialogs({ append = false } = {}) {
    if (!state.user) return;
    const live = ticket('dialogs');
    panelStatus('dialogs-status', 'Загружаем переписку…');
    $('dialogs-more').hidden = true;
    try {
      const cursor = append && state.dialogsCursor ? `&beforeId=${encodeURIComponent(state.dialogsCursor)}` : '';
      const { data } = await api(`${API}/client-dialogs?limit=30${cursor}`);
      if (!live()) return;
      const list = $('dialogs-list');
      if (!append) list.replaceChildren();
      for (const dialog of Array.isArray(data.dialogs) ? data.dialogs : []) list.append(dialogItem(dialog));
      state.dialogsCursor = data.nextCursor || null;
      state.loaded.dialogs = true;
      $('dialogs-more').hidden = !state.dialogsCursor;
      panelStatus('dialogs-status', list.childElementCount ? '' : 'Клиенты ещё не писали в бот Palitra.');
    } catch (error) {
      if (!live() || error.status === 401) return;
      panelStatus('dialogs-status', error.status === 404 ? 'Клиентский бот Palitra не подключён.' : `Переписка не загрузилась: ${error.message}`, true);
    }
  }
  function dialogItem(dialog) {
    const li = el('li');
    const button = el('button', 'pw-dialog');
    button.type = 'button';
    button.dataset.dialogId = String(dialog.id);
    const top = el('span', 'pw-dialog__top');
    top.append(el('strong', '', dialog.name || 'Клиент Telegram'));
    if (dialog.unread) top.append(el('span', 'pw-badge', `${dialog.unread} новых`));
    button.append(top);
    const meta = [dialog.username ? `@${dialog.username}` : '', dialog.orderId ? `заявка №${dialog.orderId}` : '', when(dialog.lastMessageAt)].filter(Boolean).join(' · ');
    if (meta) button.append(el('span', 'pw-muted', meta));
    if (dialog.lastMessage) button.append(el('span', 'pw-dialog__last', dialog.lastMessage));
    button.addEventListener('click', () => openDialog(dialog.id));
    li.append(button);
    return li;
  }
  function showDialogList() { $('chat').classList.remove('is-open'); $('chat-view').hidden = true; state.dialogId = null; state.dialog = null; stopPoll(); renderComposer(); }
  async function openDialog(id, { quiet = false } = {}) {
    const dialogId = Number(id);
    if (!state.user || !Number.isSafeInteger(dialogId) || dialogId < 1) return;
    const live = ticket('dialog');
    // Отправка недоступна, пока не загружен именно этот диалог; черновик другого диалога сюда не переносится.
    if (state.dialogId !== dialogId) state.dialog = null;
    state.dialogId = dialogId;
    if (state.composerDialog !== dialogId) { state.composerDialog = dialogId; $('composer-text').value = ''; composerState(''); }
    $('chat').classList.add('is-open');
    $('chat-view').hidden = false;
    if (!quiet) { $('chat-title').textContent = 'Диалог'; $('chat-meta').textContent = ''; $('chat-messages').replaceChildren(); }
    panelStatus('chat-status', quiet ? '' : 'Загружаем сообщения…');
    renderComposer();
    try {
      const { data } = await api(`${API}/client-dialogs/${encodeURIComponent(dialogId)}`);
      if (!live() || state.dialogId !== dialogId) return;
      if (!data.dialog || Number(data.dialog.id) !== dialogId) throw new ApiError('Сервер вернул другой диалог.', 200);
      state.dialog = data;
      renderDialog(data);
      panelStatus('chat-status', '');
      renderComposer();
      if (data.dialog.unread) api(`${API}/client-dialogs/${encodeURIComponent(dialogId)}/read`, { method: 'POST', body: {} }).catch(() => {});
      schedulePoll(data);
      if (!quiet) $('chat-title').focus();
    } catch (error) {
      if (!live() || error.status === 401) return;
      panelStatus('chat-status', error.status === 404 ? 'Диалог не найден.' : `Сообщения не загрузились: ${error.message}`, true);
    }
  }
  function renderDialog(data) {
    const dialog = data.dialog || {};
    $('chat-title').textContent = dialog.name || 'Клиент Telegram';
    $('chat-meta').textContent = [dialog.username ? `@${dialog.username}` : '', data.order ? `заявка №${data.order.id} · ${WORK[data.order.work && data.order.work.status] || ''}` : ''].filter(Boolean).join(' · ');
    const list = $('chat-messages');
    list.replaceChildren();
    for (const message of Array.isArray(data.messages) ? data.messages : []) {
      const item = el('li', `pw-msg pw-msg--${message.direction === 'in' ? 'in' : message.direction === 'system' ? 'system' : 'out'}`);
      item.append(el('span', 'pw-msg__meta', `${AUTHOR[message.authorType] || ''} · ${when(message.createdAt)}${message.edited ? ' · изменено клиентом' : ''}`));
      if (message.text) item.append(el('p', 'pw-msg__text', message.text));
      for (const file of Array.isArray(message.attachments) ? message.attachments : []) {
        if (file.status === 'stored' && !file.superseded) {
          const link = el('a', 'pw-msg__file', `Файл: ${file.name || 'вложение'}`);
          link.href = `${API}/client-dialogs/attachments/${encodeURIComponent(file.id)}`; link.target = '_blank'; link.rel = 'noopener noreferrer';
          item.append(link);
        } else item.append(el('span', 'pw-muted', `Файл не сохранён${file.error ? `: ${file.error}` : ''}`));
      }
      if (message.direction !== 'in' && DELIVERY[message.deliveryStatus]) {
        const status = el('span', `pw-msg__status is-${message.deliveryStatus}`, DELIVERY[message.deliveryStatus]);
        if (message.deliveryStatus === 'failed' && message.deliveryError) status.textContent = `Не доставлено: ${message.deliveryError}`;
        item.append(status);
      }
      list.append(item);
    }
    if (!list.childElementCount) list.append(el('li', 'pw-muted', 'Сообщений пока нет.'));
  }
  function stopPoll() { clearTimeout(state.poll); state.poll = 0; }
  // Пока ответ в очереди или отправляется — спокойное перечитывание с сервера, без повторной отправки.
  function schedulePoll(data) {
    stopPoll();
    const waiting = (data.messages || []).some((m) => m.direction === 'out' && ['pending', 'sending'].includes(m.deliveryStatus));
    if (!waiting) return;
    const live = epochTicket(), dialogId = state.dialogId;
    state.poll = setTimeout(() => {
      state.poll = 0;
      if (!live() || !state.user || state.dialogId !== dialogId) return;
      if (state.tab === 'chat' && document.visibilityState === 'visible') openDialog(dialogId, { quiet: true });
    }, 8000);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.user && state.tab === 'chat' && state.dialogId && state.dialog) openDialog(state.dialogId, { quiet: true });
  });
  $('chat-back').addEventListener('click', () => { showDialogList(); loadDialogs(); });
  $('chat-refresh').addEventListener('click', () => { if (state.dialogId) openDialog(state.dialogId, { quiet: true }); });
  $('dialogs-refresh').addEventListener('click', () => { state.dialogsCursor = null; loadDialogs(); });
  $('dialogs-more').addEventListener('click', () => loadDialogs({ append: true }));

  /* ---------- ответ клиенту ---------- */
  const uuid = () => {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    const b = window.crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  function composerState(text, kind = '') { const node = $('composer-state'); node.textContent = text || ''; node.dataset.state = kind; }
  const updateCount = () => { $('composer-count').textContent = `${$('composer-text').value.length} / 8000`; };
  $('composer-text').addEventListener('input', updateCount);

  /* Неразрешённая отправка: { v, userId, dialogId, requestId, text, unknown, inFlight }. Хранится по userId (память
     страницы и sessionStorage вкладки), без CSRF и паролей. Снимается только квитанцией сервера, доказанным отказом
     первой попытки или явным «Отказаться». */
  const pendingKey = (userId) => `${PENDING_PREFIX}${userId}`;
  function validRecord(record, userId) {
    return Boolean(record) && typeof record === 'object' && record.v === 2 && record.userId === userId
      && Number.isSafeInteger(record.dialogId) && record.dialogId > 0 && typeof record.text === 'string' && record.text.trim() !== ''
      && record.text.length <= 8000 && REQUEST_ID.test(String(record.requestId));
  }
  function loadPending(userId) {
    let record = vault.get(userId) || null;
    if (!record) { try { record = JSON.parse(sessionStorage.getItem(pendingKey(userId)) || 'null'); } catch (_) { record = null; } }
    if (!validRecord(record, userId)) return null;
    // После нового входа или перезагрузки исход прежней попытки неизвестен, даже если она ещё «отправлялась».
    return { ...record, unknown: true };
  }
  function writeRecord(record) {
    vault.set(record.userId, record);
    try { sessionStorage.setItem(pendingKey(record.userId), JSON.stringify(record)); } catch (_) { /* остаётся в памяти страницы */ }
    if (state.user && state.user.id === record.userId) state.pending = record;
  }
  function clearRecord(record) {
    const held = vault.get(record.userId);
    if (held && held.requestId === record.requestId) vault.delete(record.userId);
    try {
      const saved = JSON.parse(sessionStorage.getItem(pendingKey(record.userId)) || 'null');
      if (saved && saved.requestId === record.requestId) sessionStorage.removeItem(pendingKey(record.userId));
    } catch (_) { /* недоступно */ }
    if (state.pending && state.pending.requestId === record.requestId) state.pending = null;
  }
  // Единственная проверка для любой отправки: что можно сделать в открытом сейчас диалоге от имени текущего пользователя.
  function replyGate() {
    if (!state.user || state.sending) return { mode: 'busy' };
    const viewed = state.dialog && state.dialog.dialog ? Number(state.dialog.dialog.id) : null;
    if (!state.dialogId || viewed !== state.dialogId) return { mode: 'busy' };
    const record = state.pending;
    if (!record) return { mode: 'new' };
    if (record.userId === state.user.id && record.dialogId === state.dialogId) return { mode: 'retry', record };
    return { mode: 'blocked', record };
  }
  // Блок «Проверьте предыдущий ответ» над перепиской: только переход к диалогу записи, без отправки.
  const pendingNote = el('div', 'pw-frame-note');
  pendingNote.hidden = true;
  pendingNote.append(el('p', '', BLOCKED_TEXT));
  const pendingOpen = el('button', 'pw-btn', 'Открыть диалог с этим ответом');
  pendingOpen.type = 'button';
  pendingOpen.addEventListener('click', () => {
    const record = state.pending;
    if (!record || !state.user || record.userId !== state.user.id) return;
    setTab('chat');
    openDialog(record.dialogId);
  });
  pendingNote.append(pendingOpen);
  $('panel-chat').prepend(pendingNote);

  function renderComposer() {
    const field = $('composer-text'), record = state.pending;
    const here = Boolean(record && state.user && record.userId === state.user.id && record.dialogId === state.dialogId);
    const ready = Boolean(state.user && state.dialogId && state.dialog && state.dialog.dialog && Number(state.dialog.dialog.id) === state.dialogId);
    $('composer-unknown').hidden = !(here && record.unknown);
    $('composer-retry').disabled = state.sending;
    $('composer-drop').disabled = state.sending;
    $('composer-send').disabled = state.sending || !ready || Boolean(record);
    field.readOnly = here;
    if (here) field.value = record.text;
    pendingNote.hidden = !(record && state.user && !here);
    if (record && !here && ready) composerState(BLOCKED_TEXT, 'error');
    else if (here && record.unknown && !state.sending) composerState(UNKNOWN_TEXT, 'error');
    updateCount();
  }
  async function transmit(record) {
    const epoch = state.epoch;
    const retry = record.unknown === true;
    state.sending = true;
    record.inFlight = true;
    writeRecord(record);  // до запроса: выход, 401 или перезагрузка посреди отправки не теряют requestId
    renderComposer();
    composerState(retry ? 'Проверяем ту же отправку…' : 'Ставим ответ в очередь…', 'pending');
    let outcome;
    try {
      const { data } = await api(`${API}/client-dialogs/${encodeURIComponent(record.dialogId)}/reply`, { method: 'POST', body: { requestId: record.requestId, text: record.text } });
      // Квитанция — только точная: ok:true, тот же целый dialogId, положительный целый messageId. Иначе исход неизвестен.
      if (data.ok !== true || !Number.isSafeInteger(data.dialogId) || data.dialogId !== record.dialogId
        || !Number.isSafeInteger(data.messageId) || data.messageId < 1) {
        throw new ApiError('Сервер не подтвердил запись ответа.', 200, { unknown: true });
      }
      clearRecord(record);
      outcome = { accepted: true, duplicate: data.duplicate === true };
    } catch (error) {
      if (!retry && error.refused) {
        // Отказ первой попытки (4xx до записи): этот запрос не принят, текст остаётся черновиком.
        clearRecord(record);
        outcome = { refused: true, error };
      } else {
        // Неизвестный исход или отказ повтора: исход первой попытки не доказан — запись остаётся за автором.
        record.inFlight = false; record.unknown = true;
        writeRecord(record);
        outcome = { unknown: true, error };
      }
    } finally { state.sending = false; }
    if (!state.user) return;  // экран входа: запись сохранена за автором до его нового входа
    renderComposer();
    if (epoch !== state.epoch) return;  // другая сессия: сообщения о прошлой попытке не показываются
    const visible = state.dialogId === record.dialogId;
    if (outcome.accepted) {
      if (visible) { $('composer-text').value = ''; renderComposer(); }
      const text = outcome.duplicate ? 'Этот ответ уже был поставлен в очередь раньше — повтор не создан.' : 'Ответ поставлен в очередь. «Доставлено» появится после подтверждения Telegram.';
      if (visible) { composerState(text, 'ok'); await openDialog(record.dialogId, { quiet: true }); } else say(text);
    } else if (outcome.refused) {
      if (visible) composerState(`Ответ не отправлен: ${outcome.error.message}`, 'error');
      else say(`Ответ в другом диалоге не отправлен: ${outcome.error.message}`, true);
    } else if (visible) {
      composerState(retry ? `Повтор не подтверждён: ${outcome.error.message} Исход по-прежнему неизвестен — запись и номер запроса сохранены.`
        : 'Не удалось подтвердить, принят ли ответ. Проверьте историю выше и нажмите «Проверить и повторить ту же отправку» — дубля не будет.', 'error');
    }
  }
  $('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const gate = replyGate();
    if (gate.mode === 'blocked') { renderComposer(); composerState(BLOCKED_TEXT, 'error'); return; }
    if (gate.mode === 'retry') { composerState(UNKNOWN_TEXT, 'error'); return; }  // кнопка «Отправить» не повторяет
    if (gate.mode !== 'new') return;
    const text = $('composer-text').value;
    if (!text.trim()) { composerState('Напишите текст ответа.', 'error'); return; }
    if (text.length > 8000) { composerState('Ответ длиннее 8000 символов — сократите его.', 'error'); return; }
    transmit({ v: 2, userId: state.user.id, dialogId: state.dialogId, requestId: uuid(), text, unknown: false, inFlight: false });
  });
  $('composer-retry').addEventListener('click', () => {
    const gate = replyGate();
    if (gate.mode !== 'retry' || !gate.record.unknown) return;
    transmit(gate.record);
  });
  $('composer-drop').addEventListener('click', () => {
    // Отказаться можно и в диалоге, который сейчас не загружается (например, 404): выбран тот же диалог и тот же автор.
    const record = state.pending;
    if (!state.user || state.sending || !record || record.userId !== state.user.id || record.dialogId !== state.dialogId) return;
    clearRecord(record);
    $('composer-text').value = '';
    renderComposer();
    composerState('Повтор снят. Если сервер уже принял первую отправку, ответ всё равно уйдёт клиенту и будет виден в истории — отменить его отсюда нельзя.');
    say('');
    openDialog(state.dialogId, { quiet: true });
  });

  start();
})();
