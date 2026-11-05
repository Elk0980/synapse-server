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
     только скрываются (несохранённые правки в памяти редактора не теряются); при выходе закрываются.

   PALITRA-WEBCHAT-PHASEC 14.10.2026: в той же вкладке «Переписка» — две независимые истории по типизированной ссылке
   { kind:'legacy'|'thread', id }: legacy:N — прежний диалог клиентского бота (вложения, ответ до 8000 символов),
   thread:N — чат сайта (только текст, ответ до 4000; виден на сайте, копия в Telegram — отдельным статусом). Свои
   списки, курсоры, запросы, черновики и квитанции; legacy:1 и thread:1 — разные клиенты, истории не склеиваются.
   Черновик и выделение сохраняются по владельцу и ссылке; неразрешённая отправка v3 хранит ссылку (запись v2
   переносится как legacy:N без потери). */
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
  // PALITRA-WEBCHAT-PHASEC: неразрешённая отправка с типизированной ссылкой; прежний префикс v2 читается для переноса.
  const PENDING_V3 = 'palitra-work-unknown-reply-v3:';
  const KINDS = Object.freeze({
    legacy: Object.freeze({ max: 8000, label: 'Ответ клиенту в Telegram', hint: '',
      read: (id) => `${API}/client-dialogs/${encodeURIComponent(id)}`, reply: (id) => `${API}/client-dialogs/${encodeURIComponent(id)}/reply` }),
    thread: Object.freeze({ max: 4000, label: 'Ответ клиенту', hint: 'Виден в чате на сайте; копия в Telegram — если подключён.',
      read: (id) => `${API}/customer-threads/${encodeURIComponent(id)}`, reply: (id) => `${API}/customer-threads/${encodeURIComponent(id)}/reply` })
  });
  const THREAD_AUTHOR = Object.freeze({ customer: 'Клиент', owner: 'Владелец', manager: 'Менеджер' });
  const THREAD_SOURCE = Object.freeze({ web: 'чат на сайте', telegram: 'Telegram клиента', app: 'приложение', manager_telegram: 'Telegram менеджера' });
  const COPY_CHANNEL = Object.freeze({ manager_telegram: 'Копия менеджеру', customer_telegram: 'Копия клиенту' });
  const COPY_STATUS = Object.freeze({ queued: 'в очереди', not_queued: 'Telegram не подключён или копия не поставлена', sent: 'доставлено в Telegram',
    failed: 'не доставлено', uncertain: 'доставка не подтверждена' });
  // PALITRA-WEBCHAT-PHASED1: файлы из Telegram (клиента и менеджера) видны здесь; отправка файла из приложения — ещё нет (D2).
  const THREAD_TEXT_ONLY = 'Фото, видео, голосовые и файлы из Telegram видны здесь. Из приложения пока уходит только текст — отправить файл отсюда нельзя.';
  const THREAD_FILES = 'Фото, видео, голосовые и файлы из Telegram видны здесь. Из приложения можно отправить один файл до 20 МБ — текст станет подписью.';
  const FILE_KIND = Object.freeze({ photo: 'Фото', voice: 'Голосовое сообщение', audio: 'Аудио', video: 'Видео', video_note: 'Видеосообщение',
    animation: 'Анимация', document: 'Файл', sticker: 'Стикер' });
  const FILE_STATE = Object.freeze({ pending: 'Файл ещё загружается из Telegram.', too_large: 'Файл больше 20 МБ: сохранены только сведения о нём.',
    quota_exceeded: 'Хранилище файлов заполнено: файл не сохранён.', unavailable: 'Telegram не отдал файл боту.' });
  // PALITRA-WEBCHAT-PHASEE: + `upload:<UUID>` — файл, отправленный с сайта или из приложения (защищённый маршрут своей переписки).
  const FILE_REF = /^(thread:[1-9]\d{0,15}|upload:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
  const UPLOAD_REF = /^upload:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const MAX_UPLOAD = 20 * 1024 * 1024;
  const MAX_CAPTION = 4000;
  const UPLOAD_TIMEOUT_MS = 120000;

  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  const state = { user: null, csrf: '', epoch: 0, authSeq: 0, loginAttempt: 0, seq: { orders: 0, dialogs: 0, threads: 0, dialog: 0, earlier: 0 }, tab: 'orders', loaded: {},
    ordersCursor: null, dialogsCursor: null, threadsCursor: null, ref: null, view: null, composerRef: null, pages: new Map(), scrolls: new Map(),
    returnKey: '', pending: null, sending: false, frames: {}, poll: 0,
    // PHASEE: выбранный файл { file, name, size, sha256, key (`user|ref`), epoch } — только в памяти страницы.
    file: null, fileSeq: 0,
    // Repair R1: файл выбран, sha256 ещё считается — { seq, key, epoch, name, size }; пока он есть, отправки нет.
    filePreparing: null };
  const readers = new Set();  // AbortController текущих GET: отменяются при смене эпохи
  const vault = new Map();    // userId → неразрешённая отправка; дублирует sessionStorage, если он недоступен
  const drafts = new Map();   // `${userId}|${kind}:${id}` → обычный черновик { text, start, end }: только память страницы

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
    saveDraft();  // черновик прежнего владельца остаётся только за ним (ключ по userId), на экране его больше нет
    closeFrames();
    state.loaded = {}; state.ordersCursor = null; state.dialogsCursor = null; state.threadsCursor = null;
    state.ref = null; state.view = null; state.composerRef = null; state.pending = null; state.returnKey = '';
    state.pages.clear(); state.scrolls.clear();
    $('orders-list').replaceChildren(); $('dialogs-list').replaceChildren(); $('threads-list').replaceChildren(); $('chat-messages').replaceChildren();
    $('chat-title').textContent = ''; $('chat-meta').textContent = ''; $('chat-note').textContent = '';
    for (const id of ['orders-status', 'dialogs-status', 'threads-status', 'chat-status']) panelStatus(id, '');
    $('orders-more').hidden = true; $('dialogs-more').hidden = true; $('threads-more').hidden = true; $('chat-earlier').hidden = true;
    $('composer-text').readOnly = false; $('composer-text').value = ''; composerState('');
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
    if (name === 'chat') {
      if (!state.loaded.threads) loadThreads();
      if (!state.loaded.dialogs) loadDialogs();
      if (state.ref && state.view) openRef(state.ref, { quiet: true });
    }
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
    cardLegacy(card, null);
    try {
      const { data } = await api(`${API}/orders/${order.id}/dialog`);
      if (!live()) return;
      // PALITRA-WEBCHAT-PHASEC: ссылки заявки — только согласованные пары threadId/threadRef и dialogId/dialogRef.
      const links = orderLinks(data);
      if (links.error) { cardNote(card, links.error, true); return; }
      const target = links.thread || links.legacy;
      if (!target) {
        cardNote(card, 'По этой заявке переписки пока нет: клиент не писал ни в чат на сайте, ни в бот Palitra. Свяжитесь по контакту из заявки.');
        return;
      }
      // Обе связи: открывается чат сайта этой заявки, прежняя переписка в боте — отдельной кнопкой; истории не склеиваются.
      cardNote(card, links.thread && links.legacy ? 'Есть и прежняя переписка в боте — это отдельная история.' : '');
      if (links.thread && links.legacy) cardLegacy(card, links.legacy, order.id);
      setTab('chat');
      openRef(target, { orderId: order.id });
    } catch (error) {
      if (!live() || error.status === 401) return;
      cardNote(card, `Переписку не удалось проверить: ${error.message}`, true);
    } finally { if (live()) button.disabled = false; }
  }
  // Ответ GET orders/:id/dialog: { dialogId, dialogRef, threadId, threadRef }. Номер и ссылка обязаны совпадать.
  function orderLinks(data) {
    const out = { thread: null, legacy: null, error: '' };
    const given = (value) => value !== null && value !== undefined;
    if (given(data.threadId) || given(data.threadRef)) {
      const ref = makeRef('thread', data.threadId);
      if (ref && data.threadRef === refKey(ref)) out.thread = ref;
      else out.error = 'Сервер вернул несогласованную ссылку на чат сайта — переписка не открыта.';
    }
    if (given(data.dialogId) || given(data.dialogRef)) {
      const ref = makeRef('legacy', data.dialogId);
      // Прежний ответ без dialogRef допустим; если dialogRef есть — он обязан совпасть с dialogId.
      if (ref && (!given(data.dialogRef) || data.dialogRef === refKey(ref))) out.legacy = ref;
      else out.error = 'Сервер вернул несогласованную ссылку на переписку в боте — переписка не открыта.';
    }
    return out;
  }
  function cardLegacy(card, ref, orderId) {
    const old = card.querySelector('.pw-card__legacy');
    if (old) old.remove();
    if (!ref) return;
    const button = el('button', 'pw-btn pw-btn--quiet pw-card__legacy', 'Открыть прежнюю переписку в боте');
    button.type = 'button';
    button.addEventListener('click', () => { setTab('chat'); openRef(ref, { orderId }); });
    card.querySelector('.pw-card__note').after(button);
  }
  $('orders-refresh').addEventListener('click', () => { state.ordersCursor = null; loadOrders(); });
  $('orders-more').addEventListener('click', () => loadOrders({ append: true }));

  /* ---------- переписка: типизированные ссылки (PALITRA-WEBCHAT-PHASEC) ----------
     legacy:N и thread:N — разные истории: у каждой свои маршруты, список и курсор (nextCursor/beforeId против
     nextBefore/before), черновик и отправка. Номера разных видов не сравниваются и не передаются чужим маршрутам. */
  function makeRef(kind, id) { return Object.hasOwn(KINDS, kind) && Number.isSafeInteger(id) && id > 0 ? Object.freeze({ kind, id }) : null; }
  const refKey = (ref) => `${ref.kind}:${ref.id}`;
  const sameRef = (a, b) => Boolean(a && b && a.kind === b.kind && a.id === b.id);
  const draftKey = (userId, ref) => `${userId}|${refKey(ref)}`;
  const kindOf = (ref) => KINDS[ref ? ref.kind : 'legacy'];
  const loadChatLists = () => { loadThreads(); loadDialogs(); };
  function listButton(ref) {
    const button = el('button', 'pw-dialog');
    button.type = 'button';
    button.dataset.ref = refKey(ref);
    button.addEventListener('click', () => openRef(ref));
    return button;
  }
  // Новая страница списка не дублирует уже показанную строку той же ссылки.
  function fillList(list, items, append) {
    if (!append) list.replaceChildren();
    const shown = new Set([...list.querySelectorAll('[data-ref]')].map((node) => node.dataset.ref));
    for (const item of items) {
      if (shown.has(item.key)) continue;
      shown.add(item.key);
      list.append(item.node);
    }
    focusReturn();
  }
  // «Все диалоги»: фокус возвращается на строку той ссылки, из которой вышли (и после перерисовки списка).
  function focusReturn() {
    if (!state.returnKey || state.ref) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected && active.id !== 'chat-back') return;
    const button = [...$('chat-list-wrap').querySelectorAll('[data-ref]')].find((node) => node.dataset.ref === state.returnKey);
    if (button) button.focus();
  }
  async function loadDialogs({ append = false } = {}) {
    if (!state.user) return;
    const live = ticket('dialogs');
    panelStatus('dialogs-status', 'Загружаем переписку в боте…');
    $('dialogs-more').hidden = true;
    try {
      const cursor = append && state.dialogsCursor ? `&beforeId=${encodeURIComponent(state.dialogsCursor)}` : '';
      const { data } = await api(`${API}/client-dialogs?limit=30${cursor}`);
      if (!live()) return;
      const list = $('dialogs-list');
      const items = [];
      for (const dialog of Array.isArray(data.dialogs) ? data.dialogs : []) {
        const ref = makeRef('legacy', dialog && dialog.id);
        if (ref) items.push({ key: refKey(ref), node: dialogItem(ref, dialog) });
      }
      fillList(list, items, append);
      state.dialogsCursor = data.nextCursor || null;
      state.loaded.dialogs = true;
      $('dialogs-more').hidden = !state.dialogsCursor;
      panelStatus('dialogs-status', list.childElementCount ? '' : 'Клиенты ещё не писали в бот Palitra.');
    } catch (error) {
      if (!live() || error.status === 401) return;
      panelStatus('dialogs-status', error.status === 404 ? 'Клиентский бот Palitra не подключён.' : `Переписка не загрузилась: ${error.message}`, true);
    }
  }
  async function loadThreads({ append = false } = {}) {
    if (!state.user) return;
    const live = ticket('threads');
    panelStatus('threads-status', 'Загружаем чаты сайта…');
    $('threads-more').hidden = true;
    try {
      const cursor = append && state.threadsCursor ? `&before=${encodeURIComponent(state.threadsCursor)}` : '';
      const { data } = await api(`${API}/customer-threads?limit=30${cursor}`);
      if (!live()) return;
      const list = $('threads-list');
      const items = [];
      for (const thread of Array.isArray(data.threads) ? data.threads : []) {
        const ref = makeRef('thread', thread && thread.id);
        if (ref) items.push({ key: refKey(ref), node: threadItem(ref, thread) });
      }
      fillList(list, items, append);
      state.threadsCursor = Number.isSafeInteger(data.nextBefore) && data.nextBefore > 0 ? data.nextBefore : null;
      state.loaded.threads = true;
      $('threads-more').hidden = !state.threadsCursor;
      panelStatus('threads-status', list.childElementCount ? '' : 'Клиенты ещё не писали в чат на сайте.');
    } catch (error) {
      if (!live() || error.status === 401) return;
      panelStatus('threads-status', `Чаты сайта не загрузились: ${error.message}`, true);
    }
  }
  function dialogItem(ref, dialog) {
    const li = el('li');
    const button = listButton(ref);
    const top = el('span', 'pw-dialog__top');
    top.append(el('strong', '', dialog.name || 'Клиент Telegram'));
    if (dialog.unread) top.append(el('span', 'pw-badge', `${dialog.unread} новых`));
    button.append(top);
    const meta = ['Telegram-бот', dialog.username ? `@${dialog.username}` : '', dialog.orderId ? `заявка №${dialog.orderId}` : '', when(dialog.lastMessageAt)].filter(Boolean).join(' · ');
    if (meta) button.append(el('span', 'pw-muted', meta));
    if (dialog.lastMessage) button.append(el('span', 'pw-dialog__last', dialog.lastMessage));
    li.append(button);
    return li;
  }
  function threadItem(ref, thread) {
    const li = el('li');
    const button = listButton(ref);
    const top = el('span', 'pw-dialog__top');
    top.append(el('strong', '', Number.isSafeInteger(thread.orderId) && thread.orderId > 0 ? `Заявка №${thread.orderId}` : 'Чат на сайте'));
    if (Number.isSafeInteger(thread.undelivered) && thread.undelivered > 0) top.append(el('span', 'pw-badge pw-badge--warn', `без доставки: ${thread.undelivered}`));
    button.append(top);
    button.append(el('span', 'pw-muted', ['Сайт', thread.telegramLinked === true ? 'Telegram подключён' : '', when(thread.lastMessageAt)].filter(Boolean).join(' · ')));
    if (thread.lastMessage) button.append(el('span', 'pw-dialog__last', thread.lastMessage));
    li.append(button);
    return li;
  }
  function rememberScroll() { if (state.ref && !$('chat-view').hidden) state.scrolls.set(refKey(state.ref), window.scrollY); }
  // Список: черновик открытой ссылки остаётся в поле и в памяти (composerRef), позиция чтения запоминается.
  function showDialogList() {
    rememberScroll();
    $('chat').classList.remove('is-open'); $('chat-view').hidden = true;
    state.ref = null; state.view = null; stopPoll(); renderComposer();
  }
  async function openRef(ref, { quiet = false, orderId = null } = {}) {
    if (!state.user || !ref || !Object.hasOwn(KINDS, ref.kind)) return;
    const live = ticket('dialog');
    const key = refKey(ref);
    const switching = !sameRef(state.ref, ref);
    // Отправка недоступна, пока не загружена именно эта ссылка; черновик другой ссылки сюда не переносится.
    if (switching) { rememberScroll(); state.view = null; }
    state.ref = ref;
    state.returnKey = '';
    $('chat').classList.add('is-open');
    $('chat-view').hidden = false;
    if (!sameRef(state.composerRef, ref)) { saveDraft(); clearFile(); state.composerRef = ref; restoreDraft(ref); composerState(''); }
    const cached = switching ? state.pages.get(key) || null : null;
    if (switching) {
      if (cached) {
        // Возврат A→B→A: уже прочитанные страницы и позиция чтения — сразу; свежий ответ сервера ниже уточнит.
        renderView(cached);
        const y = state.scrolls.get(key);
        if (Number.isFinite(y)) window.scrollTo(0, y);
      } else {
        $('chat-title').textContent = 'Диалог'; $('chat-meta').textContent = ''; $('chat-note').textContent = '';
        $('chat-earlier').hidden = true; $('chat-messages').replaceChildren();
      }
    }
    panelStatus('chat-status', quiet || cached ? '' : 'Загружаем сообщения…');
    renderComposer();
    try {
      const { data } = await api(KINDS[ref.kind].read(ref.id));
      if (!live() || !sameRef(state.ref, ref)) return;
      const view = viewOf(ref, data, state.pages.get(key) || null);
      // Переход из заявки: история обязана принадлежать этой заявке.
      if (orderId !== null && view.orderId !== orderId) throw Object.assign(new ApiError('Сервер вернул переписку другой заявки — ответ отсюда не отправляется.', 200), { mismatch: true });
      state.view = view;
      state.pages.set(key, view);
      // Repair R1: загрузки для этой ссылки выключены — выбор файла снимается явно (иначе его нельзя ни отправить, ни убрать).
      if (!view.uploads && (currentFile() || preparingNow())) { clearFile(); composerState('Отправка файлов сейчас недоступна — выбранный файл убран, подпись осталась в поле.', 'error'); }
      renderView(view);
      panelStatus('chat-status', '');
      renderComposer();
      if (ref.kind === 'legacy' && data.dialog.unread) api(`${KINDS.legacy.read(ref.id)}/read`, { method: 'POST', body: {} }).catch(() => {});
      schedulePoll(view);
      if (!quiet) $('chat-title').focus({ preventScroll: Boolean(cached) });
    } catch (error) {
      if (!live() || error.status === 401) return;
      // Чужой ответ (другой диалог, чат или заявка): composer этой ссылки остаётся закрытым.
      if (error.mismatch) { state.view = null; state.pages.delete(key); }
      panelStatus('chat-status', error.status === 404 ? 'Диалог не найден.' : `Сообщения не загрузились: ${error.message}`, true);
      renderComposer();
    }
  }
  const validThreadMessage = (m) => Boolean(m && typeof m === 'object' && Number.isSafeInteger(m.id) && m.id > 0);
  function mergeById(older, newer) {
    const map = new Map();
    for (const m of older) map.set(m.id, m);
    for (const m of newer) map.set(m.id, m);
    return [...map.values()].sort((a, b) => a.id - b.id);
  }
  // Проверенное представление ответа сервера; несовпадение номера — ошибка, а не «другой диалог на экране».
  function viewOf(ref, data, previous) {
    const mismatch = (text) => Object.assign(new ApiError(text, 200), { mismatch: true });
    // PHASEE: выбор файла — только если сервер прямо сообщил, что загрузки включены (иначе — прежний текстовый ответ).
    const uploads = data.uploads && data.uploads.enabled === true && Number.isSafeInteger(data.uploads.maxBytes) && data.uploads.maxBytes > 0
      ? { maxBytes: Math.min(data.uploads.maxBytes, MAX_UPLOAD) } : null;
    if (ref.kind === 'legacy') {
      if (!data.dialog || Number(data.dialog.id) !== ref.id || (data.messages !== undefined && !Array.isArray(data.messages))) throw mismatch('Сервер вернул другой диалог.');
      const dialog = data.dialog, messages = Array.isArray(data.messages) ? data.messages : [];
      return { ref, kind: 'legacy', uploads, orderId: data.order && Number.isSafeInteger(data.order.id) ? data.order.id : null,
        title: dialog.name || 'Клиент Telegram',
        meta: [dialog.username ? `@${dialog.username}` : '', data.order ? `заявка №${data.order.id} · ${WORK[data.order.work && data.order.work.status] || ''}` : ''].filter(Boolean).join(' · '),
        messages, nextBefore: null, waiting: messages.some((m) => m && m.direction === 'out' && ['pending', 'sending'].includes(m.deliveryStatus)) };
    }
    const thread = data.thread;
    if (!thread || thread.id !== ref.id || !Array.isArray(data.messages)) throw mismatch('Сервер вернул другой чат.');
    const fresh = data.messages.filter(validThreadMessage);
    const nextBefore = Number.isSafeInteger(data.nextBefore) && data.nextBefore > 0 ? data.nextBefore : null;
    let messages = fresh, cursor = nextBefore;
    if (previous && previous.messages.length) {
      // Тихое обновление не стирает подгруженные ранние страницы, если свежая страница с ними смыкается.
      const newest = previous.messages[previous.messages.length - 1].id;
      if (nextBefore === null || !fresh.length || fresh[0].id <= newest) { messages = mergeById(previous.messages, fresh); cursor = nextBefore === null ? null : previous.nextBefore; }
    }
    const orderId = Number.isSafeInteger(thread.orderId) && thread.orderId > 0 ? thread.orderId : null;
    return { ref, kind: 'thread', uploads, orderId, title: orderId ? `Заявка №${orderId} · чат на сайте` : 'Чат на сайте',
      meta: thread.telegramLinked === true ? 'Сайт · Telegram клиента подключён' : 'Сайт · Telegram клиента не подключён',
      messages, nextBefore: cursor,
      waiting: messages.some((m) => Array.isArray(m.deliveries) && m.deliveries.some((d) => d && d.status === 'queued')) };
  }
  function renderView(view) {
    $('chat-title').textContent = view.title;
    $('chat-meta').textContent = view.meta;
    $('chat-note').textContent = view.kind === 'thread' ? (view.uploads ? THREAD_FILES : THREAD_TEXT_ONLY) : '';
    $('chat-earlier').hidden = !(view.kind === 'thread' && view.nextBefore);
    renderMessages(view);
  }
  /* Repair R1: дочерние узлы приводятся к нужному порядку без снятия с документа тех, что остаются: снятый узел теряет
     фокус (ссылка файла, плеер). Лишние удаляются, недостающие вставляются; стоящий на месте узел не трогается. */
  function patchChildren(parent, desired) {
    const keep = new Set(desired);
    for (const child of [...parent.childNodes]) if (!keep.has(child)) child.remove();
    let cursor = parent.firstChild;
    for (const node of desired) {
      if (node === cursor) { cursor = cursor.nextSibling; continue; }
      parent.insertBefore(node, cursor);
    }
  }
  // Изменённое сообщение (статус копии, отметка правки) обновляется на месте: неизменные вложения остаются теми же узлами.
  function updateMessage(existing, fresh) {
    existing.className = fresh.className;
    const reusable = new Map();
    for (const child of existing.children) if (child.dataset.fileKey) reusable.set(child.dataset.fileKey, child);
    const desired = [...fresh.childNodes].map((child) => {
      const old = child.dataset && child.dataset.fileKey ? reusable.get(child.dataset.fileKey) : null;
      return old && old.dataset.fileSig === child.dataset.fileSig ? old : child;
    });
    patchChildren(existing, desired);
  }
  // Сообщения по ключу вида: неизменные узлы не пересоздаются и не снимаются; первое видимое сообщение остаётся на месте
  // экрана (подгрузка ранних страниц, тихое обновление), новые сообщения не прокручивают читающего.
  // Другая ссылка или эпоха — список строится заново: прежние узлы (и фокус в них) в чужую переписку не переносятся.
  function renderMessages(view) {
    const list = $('chat-messages');
    const owner = `${state.epoch}|${refKey(view.ref)}`;
    if (list.dataset.owner !== owner) { list.replaceChildren(); list.dataset.owner = owner; }
    let anchor = null;
    for (const node of list.children) {
      if (!node.dataset.key) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom > 0) { anchor = { key: node.dataset.key, top: rect.top }; break; }
    }
    const old = new Map();
    for (const node of list.children) if (node.dataset.key) old.set(node.dataset.key, node);
    const nodes = [];
    for (const message of view.messages) {
      const key = `${view.kind}:${message && message.id}`, sig = JSON.stringify(message), known = old.get(key);
      if (known && known.dataset.sig === sig) { nodes.push(known); continue; }
      const node = view.kind === 'thread' ? threadMessage(message, view.ref.id) : legacyMessage(message, view.ref.id);
      if (known) { updateMessage(known, node); known.dataset.sig = sig; nodes.push(known); continue; }
      node.dataset.key = key; node.dataset.sig = sig;
      nodes.push(node);
    }
    if (!nodes.length) nodes.push(el('li', 'pw-muted', 'Сообщений пока нет.'));
    patchChildren(list, nodes);
    if (anchor) {
      const same = nodes.find((node) => node.dataset.key === anchor.key);
      if (same) { const shift = same.getBoundingClientRect().top - anchor.top; if (shift) window.scrollBy(0, shift); }
    }
  }
  function legacyMessage(message, dialogId) {
    const item = el('li', `pw-msg pw-msg--${message.direction === 'in' ? 'in' : message.direction === 'system' ? 'system' : 'out'}`);
    item.append(el('span', 'pw-msg__meta', `${AUTHOR[message.authorType] || ''} · ${when(message.createdAt)}${message.edited ? ' · изменено клиентом' : ''}`));
    if (message.text) item.append(el('p', 'pw-msg__text', message.text));
    for (const file of Array.isArray(message.attachments) ? message.attachments : []) {
      if (file.status === 'stored' && !file.superseded) {
        const link = el('a', 'pw-msg__file', `Файл: ${file.name || 'вложение'}`);
        // PHASEE: файл, отправленный владельцем из приложения, — маршрут именно этого диалога и ссылка `upload:<UUID>`;
        // прежние вложения бота — прежним числовым маршрутом.
        const upload = UPLOAD_REF.test(String(file.ref || '')) && file.ref === file.id && Number.isSafeInteger(dialogId) ? file.ref : null;
        link.href = upload ? `${API}/client-dialogs/${dialogId}/attachments/${upload}` : `${API}/client-dialogs/attachments/${encodeURIComponent(file.id)}`;
        link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.dataset.fileKey = upload || `legacy:${file.id}`; link.dataset.fileSig = JSON.stringify(file);
        item.append(link);
      } else item.append(el('span', 'pw-muted', `Файл не сохранён${file.error ? `: ${file.error}` : ''}`));
    }
    if (message.direction !== 'in' && DELIVERY[message.deliveryStatus]) {
      const status = el('span', `pw-msg__status is-${message.deliveryStatus}`, DELIVERY[message.deliveryStatus]);
      if (message.deliveryStatus === 'failed' && message.deliveryError) status.textContent = `Не доставлено: ${message.deliveryError}`;
      item.append(status);
    }
    return item;
  }
  // Сообщение чата сайта: автор и источник ядра; «Сохранено в чате на сайте» — не «прочитано» и не доставка;
  // копии менеджеру и клиенту — отдельными строками со своим статусом (sent — только квитанция Telegram).
  /* PALITRA-WEBCHAT-PHASED1: вложение чата сайта — только защищённый маршрут владельца и ссылка сервера thread:<id>
     (сессия кабинета), без адресов из текста и без file_id. Встроенно — только проверенные сервером картинка/звук/видео,
     без автозапуска; иначе — «Скачать файл». Прежние вложения диалогов бота рисует legacyMessage, как раньше. */
  function threadAttachment(threadId, file, index = 0) {
    const box = el('div', 'pw-file');
    const match = FILE_REF.exec(String(file && file.ref || ''));
    // Repair R1: ключ и подпись вложения — по ним неизменный блок (ссылка, плеер) переносится в обновлённое сообщение.
    box.dataset.fileKey = match ? match[1] : `index:${index}`;
    box.dataset.fileSig = `${threadId}|${JSON.stringify(file)}`;
    const label = file && file.kind === 'sticker' && file.animated === true ? 'Анимированный стикер' : FILE_KIND[file && file.kind] || 'Файл';
    const size = Number.isSafeInteger(file && file.size) && file.size > 0
      ? (file.size >= 1048576 ? `${(file.size / 1048576).toFixed(1).replace('.', ',')} МБ` : `${Math.max(1, Math.round(file.size / 1024))} КБ`) : '';
    box.append(el('span', 'pw-file__kind', [label, size].filter(Boolean).join(' · ')));
    if (!match || !Number.isSafeInteger(threadId) || file.storageStatus !== 'stored') {
      box.append(el('span', `pw-msg__status is-${file && file.storageStatus === 'pending' ? 'queued' : 'failed'}`,
        `${FILE_STATE[file && file.storageStatus] || 'Файл недоступен.'}${file && file.error && file.storageStatus !== 'pending' ? ` ${file.error}` : ''}`));
      return box;
    }
    const url = `${API}/customer-threads/${threadId}/attachments/${match[1]}`;
    if (file.presentation === 'image') {
      const image = el('img', 'pw-file__image');
      image.alt = label; image.loading = 'lazy'; image.decoding = 'async'; image.src = url;
      box.append(image);
    } else if (file.presentation === 'audio') {
      const audio = el('audio', 'pw-file__audio');
      audio.controls = true; audio.preload = 'none'; audio.src = url;
      box.append(audio);
    } else if (file.presentation === 'video') {
      const video = el('video', `pw-file__video${file.kind === 'video_note' ? ' pw-file__video--round' : ''}`);
      video.controls = true; video.preload = 'metadata'; video.playsInline = true; video.src = url;
      box.append(video);
    }
    const link = el('a', 'pw-msg__file', file.presentation === 'download' ? `Скачать файл${file.name ? `: ${file.name}` : ''}` : 'Скачать');
    link.href = url; link.setAttribute('download', '');
    box.append(link);
    return box;
  }
  function threadMessage(message, threadId) {
    const item = el('li', `pw-msg pw-msg--${message.author === 'customer' ? 'in' : 'out'}`);
    item.append(el('span', 'pw-msg__meta', [THREAD_AUTHOR[message.author] || 'Участник', THREAD_SOURCE[message.source] || '', when(message.createdAt),
      Number.isSafeInteger(message.replacesMessageId) ? 'изменено (новая версия)' : ''].filter(Boolean).join(' · ')));
    if (typeof message.text === 'string' && message.text) item.append(el('p', 'pw-msg__text', message.text));
    (Array.isArray(message.attachments) ? message.attachments : []).forEach((file, index) => item.append(threadAttachment(threadId, file, index)));
    if (message.edited === true) item.append(el('span', 'pw-msg__status', 'Есть новая версия ниже'));
    if (message.web === 'stored') item.append(el('span', 'pw-msg__status is-stored', 'Сохранено в чате на сайте'));
    for (const copy of Array.isArray(message.deliveries) ? message.deliveries : []) {
      const label = copy && COPY_CHANNEL[copy.channel];
      if (!label) continue;
      const known = Object.hasOwn(COPY_STATUS, copy.status);
      const reason = ['failed', 'uncertain', 'not_queued'].includes(copy.status) && typeof copy.reason === 'string' && copy.reason ? ` — ${copy.reason}` : '';
      item.append(el('span', `pw-msg__status is-${known ? copy.status : 'unknown'}`, `${label}: ${known ? COPY_STATUS[copy.status] : 'статус неизвестен'}${reason}`));
    }
    return item;
  }
  async function loadEarlier() {
    const view = state.view;
    if (!state.user || !view || view.kind !== 'thread' || !view.nextBefore) return;
    const ref = view.ref, live = ticket('earlier'), button = $('chat-earlier');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const { data } = await api(`${KINDS.thread.read(ref.id)}?before=${encodeURIComponent(view.nextBefore)}&limit=50`);
      if (!live() || !sameRef(state.ref, ref) || !state.view || !sameRef(state.view.ref, ref)) return;
      if (!data.thread || data.thread.id !== ref.id || !Array.isArray(data.messages)) throw new ApiError('Сервер вернул другой чат.', 200);
      const next = { ...state.view, messages: mergeById(data.messages.filter(validThreadMessage), state.view.messages),
        nextBefore: Number.isSafeInteger(data.nextBefore) && data.nextBefore > 0 ? data.nextBefore : null };
      state.view = next;
      state.pages.set(refKey(ref), next);
      renderView(next);
    } catch (error) {
      if (!live() || error.status === 401) return;
      panelStatus('chat-status', `Ранние сообщения не загрузились: ${error.message}`, true);
    } finally { button.disabled = false; }
  }
  function stopPoll() { clearTimeout(state.poll); state.poll = 0; }
  // Тихое перечитывание открытой переписки — только в видимой вкладке «Переписка» (чаще, пока ответ или копия в
  // очереди); без повторной отправки и без вмешательства в поле ответа и фокус.
  function schedulePoll(view) {
    stopPoll();
    if (!view) return;
    const live = epochTicket(), ref = view.ref;
    state.poll = setTimeout(() => {
      state.poll = 0;
      if (!live() || !state.user || !sameRef(state.ref, ref)) return;
      if (state.tab === 'chat' && document.visibilityState === 'visible') openRef(ref, { quiet: true });
    }, view.waiting ? 8000 : 20000);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.user && state.tab === 'chat' && state.ref && state.view) openRef(state.ref, { quiet: true });
  });
  $('chat-back').addEventListener('click', () => {
    const ref = state.ref;
    showDialogList();
    state.returnKey = ref ? refKey(ref) : '';
    focusReturn();
    loadChatLists();
  });
  $('chat-refresh').addEventListener('click', () => { if (state.ref) openRef(state.ref, { quiet: true }); });
  $('chat-earlier').addEventListener('click', loadEarlier);
  $('dialogs-refresh').addEventListener('click', () => { state.dialogsCursor = null; state.threadsCursor = null; loadChatLists(); });
  $('dialogs-more').addEventListener('click', () => loadDialogs({ append: true }));
  $('threads-more').addEventListener('click', () => loadThreads({ append: true }));

  /* ---------- ответ клиенту ---------- */
  const uuid = () => {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    const b = window.crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  function composerState(text, kind = '') { const node = $('composer-state'); node.textContent = text || ''; node.dataset.state = kind; }
  const updateCount = () => { $('composer-count').textContent = `${$('composer-text').value.length} / ${kindOf(state.ref).max}`; };
  $('composer-text').addEventListener('input', () => { updateCount(); saveDraft(); });
  $('composer-text').addEventListener('blur', saveDraft);

  /* PALITRA-WEBCHAT-PHASEC: обычный черновик — по владельцу и ссылке, вместе с выделением; только память страницы
     (без cookie, CSRF и паролей). Поле с неразрешённой отправкой (readonly) черновиком не считается. */
  function saveDraft() {
    const field = $('composer-text'), ref = state.composerRef, record = state.pending;
    if (!state.user || !ref || field.readOnly) return;
    // В поле ссылки с неразрешённой отправкой — текст этой отправки, а не черновик: иначе он ушёл бы второй раз.
    // PHASEE: у файла подпись уже в записи, поле остаётся обычным черновиком (поздние правки не теряются).
    if (record && record.type !== 'file' && record.userId === state.user.id && sameRef(record.ref, ref)) return;
    const key = draftKey(state.user.id, ref);
    if (field.value) drafts.set(key, { text: field.value, start: field.selectionStart, end: field.selectionEnd });
    else drafts.delete(key);
  }
  function restoreDraft(ref) {
    const field = $('composer-text');
    const draft = state.user ? drafts.get(draftKey(state.user.id, ref)) : null;
    field.readOnly = false;
    field.value = draft ? draft.text : '';
    if (draft) { try { field.setSelectionRange(draft.start, draft.end); } catch (_) { /* выделение не обязательно */ } }
  }

  /* Неразрешённая отправка v3: { v:3, userId, ref:{kind,id}, requestId, text, unknown, inFlight }. Хранится по userId
     (память страницы и sessionStorage вкладки), без CSRF и паролей. Снимается только квитанцией сервера, доказанным
     отказом первой попытки или явным «Отказаться». Запись прежнего формата v2 ({dialogId}) переносится как legacy:N:
     новая записывается раньше, чем удаляется прежняя, — неразрешённая отправка не теряется при смене префикса. */
  const pendingKey = (userId) => `${PENDING_V3}${userId}`;
  const legacyPendingKey = (userId) => `${PENDING_PREFIX}${userId}`;
  const readStored = (key) => { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (_) { return null; } };
  /* PALITRA-WEBCHAT-PHASEE: файл — та же запись v3 с type:'file' и сведениями { name, size, sha256, uploadRef? }; text —
     подпись (может быть пустой, до 4000 символов). Сам файл — только в памяти страницы. Прежние текстовые записи — как раньше. */
  function validRecord(record, userId) {
    if (!record || typeof record !== 'object' || record.v !== 3 || record.userId !== userId || !record.ref) return false;
    const ref = makeRef(record.ref.kind, record.ref.id);
    if (!ref || !REQUEST_ID.test(String(record.requestId)) || typeof record.text !== 'string') return false;
    if (record.type === 'file') {
      return record.text.length <= MAX_CAPTION && typeof record.name === 'string' && record.name.length > 0 && record.name.length <= 180
        && Number.isSafeInteger(record.size) && record.size > 0 && record.size <= MAX_UPLOAD && /^[0-9a-f]{64}$/.test(String(record.sha256))
        && (record.uploadRef === undefined || UPLOAD_REF.test(String(record.uploadRef)));
    }
    return record.type === undefined && record.text.trim() !== '' && record.text.length <= KINDS[ref.kind].max;
  }
  function migrateV2(record, userId) {
    if (!record || typeof record !== 'object' || record.v !== 2 || record.userId !== userId || !Number.isSafeInteger(record.dialogId) || record.dialogId < 1
      || typeof record.text !== 'string' || record.text.trim() === '' || record.text.length > 8000 || !REQUEST_ID.test(String(record.requestId))) return null;
    return { v: 3, userId, ref: makeRef('legacy', record.dialogId), requestId: record.requestId, text: record.text, unknown: true, inFlight: false };
  }
  function loadPending(userId) {
    let record = vault.get(userId) || readStored(pendingKey(userId));
    if (!validRecord(record, userId)) {
      record = migrateV2(readStored(legacyPendingKey(userId)), userId);
      if (!record) return null;
      if (writeRecord(record)) { try { sessionStorage.removeItem(legacyPendingKey(userId)); } catch (_) { /* остаётся прежняя копия */ } }
    }
    // После нового входа или перезагрузки исход прежней попытки неизвестен, даже если она ещё «отправлялась».
    return { ...record, ref: makeRef(record.ref.kind, record.ref.id), unknown: true, inFlight: false };
  }
  function writeRecord(record) {
    vault.set(record.userId, record);
    let stored = true;
    try { sessionStorage.setItem(pendingKey(record.userId), JSON.stringify({ ...record, ref: { kind: record.ref.kind, id: record.ref.id } })); }
    catch (_) { stored = false; /* остаётся в памяти страницы */ }
    if (state.user && state.user.id === record.userId) state.pending = record;
    return stored;
  }
  function clearRecord(record) {
    const held = vault.get(record.userId);
    if (held && held.requestId === record.requestId) vault.delete(record.userId);
    for (const key of [pendingKey(record.userId), legacyPendingKey(record.userId)]) {
      const saved = readStored(key);
      if (saved && saved.requestId === record.requestId) { try { sessionStorage.removeItem(key); } catch (_) { /* недоступно */ } }
    }
    if (state.pending && state.pending.requestId === record.requestId) state.pending = null;
  }
  // Единственная проверка для любой отправки: что можно сделать в открытой сейчас ссылке от имени текущего пользователя.
  function replyGate() {
    if (!state.user || state.sending) return { mode: 'busy' };
    if (!state.ref || !state.view || !sameRef(state.view.ref, state.ref)) return { mode: 'busy' };
    const record = state.pending;
    if (!record) return { mode: 'new' };
    if (record.userId === state.user.id && sameRef(record.ref, state.ref)) return { mode: 'retry', record };
    return { mode: 'blocked', record };
  }
  // Квитанция — только точная: legacy {ok, тот же dialogId, messageId}; чат сайта {ok, тот же threadId, message.id}.
  function receiptOk(ref, data) {
    if (!data || data.ok !== true) return false;
    if (ref.kind === 'legacy') return Number.isSafeInteger(data.dialogId) && data.dialogId === ref.id && Number.isSafeInteger(data.messageId) && data.messageId > 0;
    return Number.isSafeInteger(data.threadId) && data.threadId === ref.id && Boolean(data.message) && typeof data.message === 'object'
      && Number.isSafeInteger(data.message.id) && data.message.id > 0;
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
    openRef(record.ref);
  });
  pendingNote.append(pendingOpen);
  $('panel-chat').prepend(pendingNote);

  /* ---------- PALITRA-WEBCHAT-PHASEE: один файл в открытую переписку (чат сайта и прежний диалог бота) ----------
     «Прикрепить файл» монтируется в существующую форму ответа (HTML не меняется) и видна, только если сервер сообщил
     uploads.enabled для этой ссылки. Файл — в памяти страницы, sha256 считается один раз; текст поля — подпись.
     Отправка: prepare (тот же requestId при повторе) → байты (тот же upload:<UUID>) → точная квитанция с этим файлом. */
  const picker = { box: null, input: null, name: null, remove: null };
  const fileKeyOf = (ref) => (state.user && ref ? draftKey(state.user.id, ref) : '');
  const uploadsPath = (ref) => (ref.kind === 'thread' ? `${API}/customer-threads/${ref.id}/uploads` : `${API}/client-dialogs/${ref.id}/uploads`);
  const sizeText = (size) => (Number.isSafeInteger(size) && size > 0 ? (size >= 1048576 ? `${(size / 1048576).toFixed(1).replace('.', ',')} МБ` : `${Math.max(1, Math.round(size / 1024))} КБ`) : '');
  function mountPicker() {
    if (picker.box) return;
    const box = el('div', 'pw-attach');
    box.id = 'composer-attach';
    const input = el('input', 'pw-attach__input');
    input.type = 'file'; input.id = 'composer-file';
    input.setAttribute('aria-describedby', 'composer-file-name');
    const label = el('label', 'pw-btn pw-btn--quiet pw-attach__pick', 'Прикрепить файл');
    label.htmlFor = 'composer-file';
    const name = el('span', 'pw-muted pw-attach__name');
    name.id = 'composer-file-name';
    const remove = el('button', 'pw-btn pw-btn--quiet pw-attach__remove', 'Убрать');
    remove.type = 'button'; remove.hidden = true;
    box.append(input, label, name, remove);
    $('composer-text').after(box);
    input.addEventListener('change', () => { const file = input.files && input.files[0]; pickFile(file || null); });
    remove.addEventListener('click', () => { clearFile(); renderComposer(); composerState(''); input.focus(); });
    Object.assign(picker, { box, input, name, remove });
  }
  function currentFile() {
    const file = state.file;
    return file && file.epoch === state.epoch && file.key === fileKeyOf(state.composerRef) ? file : null;
  }
  function renderPicker() {
    const view = state.view;
    const on = Boolean(state.user && state.ref && view && sameRef(view.ref, state.ref) && view.uploads);
    if (!on) { if (picker.box) picker.box.hidden = true; return; }
    mountPicker();
    picker.box.hidden = false;
    const record = state.pending, file = currentFile(), preparing = preparingNow() ? state.filePreparing : null;
    const here = Boolean(record && record.type === 'file' && record.userId === state.user.id && sameRef(record.ref, state.ref));
    picker.input.disabled = state.sending;
    picker.remove.hidden = !(file || preparing);
    picker.remove.disabled = state.sending;
    picker.name.textContent = file ? `${file.name} · ${sizeText(file.size)}`
      : preparing ? `${preparing.name} · ${sizeText(preparing.size)} · проверяем файл…`
        : here ? `Неотправленный файл: ${record.name} · ${sizeText(record.size)}. Для повтора выберите этот же файл.` : 'Файл не выбран';
  }
  // Repair R1: файл выбран, sha256 ещё считается — только для последнего выбора этой ссылки, пользователя и эпохи.
  function preparingNow() {
    const p = state.filePreparing;
    return Boolean(p && p.seq === state.fileSeq && p.epoch === state.epoch && p.key === fileKeyOf(state.composerRef));
  }
  function clearFile() {
    state.fileSeq += 1;
    state.file = null;
    state.filePreparing = null;
    if (picker.input) picker.input.value = '';
  }
  async function sha256Hex(file) {
    const digest = await window.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
  }
  async function pickFile(file) {
    clearFile();
    renderComposer();
    if (!file || !state.view || !state.view.uploads) return;
    const max = state.view.uploads.maxBytes;
    if (!file.size) { picker.input.value = ''; composerState('Файл пустой — выберите другой.', 'error'); picker.input.focus(); return; }
    if (file.size > max) { picker.input.value = ''; composerState(`Файл больше ${Math.round(max / 1048576)} МБ — выберите файл поменьше.`, 'error'); picker.input.focus(); return; }
    const seq = state.fileSeq, key = fileKeyOf(state.composerRef), epoch = state.epoch;
    // Repair R1: пока считается sha256 — «файл готовится»: «Отправить» и повтор файла закрыты, подпись не уходит текстом.
    state.filePreparing = { seq, key, epoch, name: file.name, size: file.size };
    renderComposer();
    composerState('Проверяем файл…', 'pending');
    let sha256;
    try { sha256 = await sha256Hex(file); }
    catch (_) {
      // Только свой (последний) выбор: ошибка снимает «готовится», поле с подписью не трогается.
      if (seq === state.fileSeq) { state.filePreparing = null; picker.input.value = ''; renderComposer(); composerState('Файл не удалось прочитать — выберите его ещё раз.', 'error'); }
      return;
    }
    if (seq !== state.fileSeq) return;   // выбор устарел: новый выбор, «Убрать», другая ссылка — их состояние не трогаем
    state.filePreparing = null;
    if (epoch !== state.epoch || key !== fileKeyOf(state.composerRef)) { if (state.user) renderComposer(); return; }
    state.file = { file, name: file.name, size: file.size, sha256, key, epoch };
    renderComposer();
    const record = state.pending;
    if (record && record.type === 'file' && state.user && record.userId === state.user.id && sameRef(record.ref, state.composerRef)) {
      const same = record.size === file.size && record.sha256 === sha256;
      composerState(same ? 'Это тот же файл. Нажмите «Проверить и повторить ту же отправку».'
        : 'Это другой файл: неотправленный файл можно повторить только тем же файлом или отказаться от него.', same ? '' : 'error');
    } else composerState('');
  }
  // Байты файла — тем же правилам, что у api(): эпоха, 401 — экран входа, 5xx/408/обрыв — исход неизвестен.
  async function apiFile(path, file) {
    const epoch = state.epoch, attempt = state.authSeq;
    const controller = new AbortController();
    readers.add(controller);
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    let res, data = null;
    try {
      res = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/octet-stream', ...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}) }, body: file });
      try { data = await res.json(); } catch (_) { data = null; }
    } catch (_) {
      throw new ApiError('Нет ответа сервера. Проверьте связь.', 0, { unknown: true });
    } finally { clearTimeout(timer); readers.delete(controller); }
    if (res.status === 401) {
      if (epoch === state.epoch && attempt === state.authSeq) sessionEnded();
      throw new ApiError('Сессия закончилась. Войдите снова.', 401, { refused: true });
    }
    if (!res.ok) {
      const message = data && typeof data.error === 'string' && data.error ? data.error : `Сервер не выполнил запрос (${res.status})`;
      const unknown = res.status >= 500 || res.status === 408;
      throw Object.assign(new ApiError(message, res.status, { unknown, refused: !unknown }), { code: data && typeof data.code === 'string' ? data.code : '' });
    }
    if (!data || typeof data !== 'object') throw new ApiError('Ответ сервера не удалось прочитать.', res.status, { unknown: true });
    return { status: res.status, data };
  }
  const stepError = (message, status, code) => Object.assign(new ApiError(message, status, { unknown: true }), { code });
  // Точная квитанция файла: чат сайта — тот же threadId и сообщение с этой загрузкой; прежний диалог — тот же dialogId,
  // настоящий messageId и завершённая эта загрузка.
  function fileReceiptOk(record, data) {
    if (!data || data.ok !== true) return false;
    if (record.ref.kind === 'legacy') {
      return data.dialogId === record.ref.id && Number.isSafeInteger(data.messageId) && data.messageId > 0
        && Boolean(data.upload) && data.upload.ref === record.uploadRef && data.upload.state === 'committed';
    }
    return data.threadId === record.ref.id && Boolean(data.message) && Number.isSafeInteger(data.message.id) && data.message.id > 0
      && Array.isArray(data.message.attachments) && data.message.attachments.some((a) => a && a.ref === record.uploadRef);
  }
  const sameFile = (record, picked) => Boolean(picked && picked.key === draftKey(record.userId, record.ref) && picked.size === record.size && picked.sha256 === record.sha256);
  async function transmitFile(record) {
    const epoch = state.epoch;
    const retry = record.unknown === true;
    state.sending = true;
    record.inFlight = true;
    writeRecord(record);  // до запроса: выход, 401 или перезагрузка не теряют requestId и сведения о файле
    renderComposer();
    composerState(retry ? 'Проверяем ту же отправку файла…' : 'Отправляем файл…', 'pending');
    let outcome;
    try {
      let data;
      // После перезагрузки или таймаута — сначала только чтение состояния той же загрузки.
      if (record.uploadRef) ({ data } = await api(`${uploadsPath(record.ref)}/${record.uploadRef}`));
      else {
        ({ data } = await api(uploadsPath(record.ref), { method: 'POST', body: { requestId: record.requestId, name: record.name, size: record.size, sha256: record.sha256, caption: record.text } }));
        const target = record.ref.kind === 'thread' ? data && data.threadId : data && data.dialogId;
        if (!data || data.ok !== true || target !== record.ref.id || !data.upload || !UPLOAD_REF.test(String(data.upload.ref))) {
          throw new ApiError('Сервер не подтвердил подготовку файла.', 200, { unknown: true });
        }
        record.uploadRef = data.upload.ref;
        writeRecord(record);
      }
      const upload = (data && data.upload) || {};
      if (upload.state !== 'committed') {
        if (upload.state === 'receiving') throw stepError('Файл ещё загружается. Проверьте отправку чуть позже.', 409, 'IN_PROGRESS');
        if (upload.state === 'expired' || upload.state === 'rejected') {
          throw stepError('Срок этой загрузки истёк, сообщение не создано. Нажмите «Отказаться от этой отправки» и отправьте файл заново.', 410, 'EXPIRED');
        }
        const picked = currentFile();
        if (!sameFile(record, picked)) throw stepError(`Выберите тот же файл (${record.name}, ${sizeText(record.size)}) и нажмите «Проверить и повторить ту же отправку».`, 0, 'RESELECT');
        ({ data } = await apiFile(`${uploadsPath(record.ref)}/${record.uploadRef}/bytes`, picked.file));
      }
      if (!fileReceiptOk(record, data)) throw new ApiError('Сервер не подтвердил файл в переписке.', 200, { unknown: true });
      clearRecord(record);
      outcome = { accepted: true, duplicate: data.duplicate === true };
    } catch (error) {
      if (!retry && error.refused && !record.uploadRef) {
        // Отказ подготовки (4xx до записи): файла на сервере нет — подпись остаётся в поле, выбранный файл — тоже.
        clearRecord(record);
        outcome = { refused: true, error };
      } else {
        record.inFlight = false; record.unknown = true;
        writeRecord(record);
        outcome = { unknown: true, error };
      }
    } finally { state.sending = false; }
    if (!state.user) return;
    renderComposer();
    if (epoch !== state.epoch) return;
    const visible = sameRef(state.ref, record.ref);
    if (outcome.accepted) {
      // Очищается только отправленное: подпись — если её не меняли, выбранный файл — если это тот же файл.
      const key = draftKey(record.userId, record.ref);
      if (sameRef(state.composerRef, record.ref)) { if ($('composer-text').value === record.text) { $('composer-text').value = ''; drafts.delete(key); } }
      else if (drafts.get(key) && drafts.get(key).text === record.text) drafts.delete(key);
      if (sameFile(record, state.file)) clearFile();
      renderComposer();
      const text = outcome.duplicate ? 'Этот файл уже был отправлен раньше — повтор не создан.'
        : record.ref.kind === 'thread' ? 'Файл сохранён в чате на сайте. Копия в Telegram — отдельным статусом у сообщения.'
          : 'Файл поставлен в очередь. «Доставлено» появится после подтверждения Telegram.';
      if (visible) { composerState(text, 'ok'); await openRef(record.ref, { quiet: true }); } else say(text);
    } else if (outcome.refused) {
      if (visible) { composerState(`Файл не отправлен: ${outcome.error.message}`, 'error'); if (picker.input) picker.input.focus(); }
      else say(`Файл в другом диалоге не отправлен: ${outcome.error.message}`, true);
    } else if (visible) {
      const code = outcome.error.code || '';
      composerState(['RESELECT', 'EXPIRED', 'IN_PROGRESS'].includes(code) ? outcome.error.message
        : outcome.error.status === 422 ? `${outcome.error.message} Номер запроса сохранён.`
          : 'Не удалось подтвердить, принят ли файл. Нажмите «Проверить и повторить ту же отправку» — дубля не будет.', 'error');
    }
  }

  function renderComposer() {
    const field = $('composer-text'), record = state.pending, ref = state.ref, kind = kindOf(ref);
    const here = Boolean(record && state.user && record.userId === state.user.id && sameRef(record.ref, ref));
    const ready = Boolean(state.user && ref && state.view && sameRef(state.view.ref, ref));
    // Подпись, предел и подсказка — по виду открытой ссылки: чат сайта 4000, прежний диалог бота 8000.
    $('composer-label').textContent = kind.label;
    field.maxLength = kind.max;
    $('composer-hint').textContent = kind.hint;
    $('composer-hint').hidden = !kind.hint;
    $('composer-unknown').hidden = !(here && record.unknown);
    // Repair R1: пока считается sha256 выбранного файла — ни «Отправить», ни повтора файла.
    const preparing = preparingNow();
    $('composer-retry').disabled = state.sending || (preparing && here && record.type === 'file');
    $('composer-drop').disabled = state.sending;
    $('composer-send').disabled = state.sending || !ready || Boolean(record) || preparing;
    const textRecord = here && record.type !== 'file';
    field.readOnly = textRecord;
    if (textRecord) field.value = record.text;
    renderPicker();
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
    composerState(retry ? 'Проверяем ту же отправку…' : record.ref.kind === 'thread' ? 'Сохраняем ответ в чате…' : 'Ставим ответ в очередь…', 'pending');
    let outcome;
    try {
      const { data } = await api(KINDS[record.ref.kind].reply(record.ref.id), { method: 'POST', body: { requestId: record.requestId, text: record.text } });
      // Квитанция — только точная (receiptOk), своя для каждого вида. Иначе исход неизвестен.
      if (!receiptOk(record.ref, data)) throw new ApiError('Сервер не подтвердил запись ответа.', 200, { unknown: true });
      clearRecord(record);
      outcome = { accepted: true, duplicate: data.duplicate === true };
    } catch (error) {
      if (!retry && error.refused) {
        // Отказ первой попытки (4xx до записи): этот запрос не принят, текст остаётся черновиком своей ссылки.
        clearRecord(record);
        drafts.set(draftKey(record.userId, record.ref), { text: record.text, start: record.text.length, end: record.text.length });
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
    const visible = sameRef(state.ref, record.ref);
    if (outcome.accepted) {
      // Поздняя квитанция очищает только поле своей ссылки: черновик другой ссылки не трогается.
      drafts.delete(draftKey(record.userId, record.ref));
      if (sameRef(state.composerRef, record.ref)) { $('composer-text').value = ''; renderComposer(); }
      const text = record.ref.kind === 'thread'
        ? (outcome.duplicate ? 'Этот ответ уже был сохранён раньше — повтор не создан.' : 'Ответ сохранён в чате на сайте. Копия в Telegram — отдельным статусом у сообщения.')
        : (outcome.duplicate ? 'Этот ответ уже был поставлен в очередь раньше — повтор не создан.' : 'Ответ поставлен в очередь. «Доставлено» появится после подтверждения Telegram.');
      if (visible) { composerState(text, 'ok'); await openRef(record.ref, { quiet: true }); } else say(text);
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
    // Repair R1: файл ещё проверяется — подпись не отправляется обычным текстом, ждём готовности файла.
    if (preparingNow()) { composerState('Проверяем файл…', 'pending'); return; }
    const text = $('composer-text').value, max = KINDS[state.ref.kind].max;
    // PHASEE: выбранный файл этой ссылки — отправка файла (подпись до 4000 символов, можно без неё); иначе — прежний текст.
    const selected = currentFile();
    if (selected && !(state.view && state.view.uploads)) { composerState('Отправка файлов сейчас недоступна — уберите файл или ответьте позже.', 'error'); return; }
    const picked = selected;
    if (picked) {
      if (text.length > MAX_CAPTION) { composerState(`Подпись к файлу длиннее ${MAX_CAPTION} символов — сократите её.`, 'error'); return; }
      transmitFile({ v: 3, type: 'file', userId: state.user.id, ref: state.ref, requestId: uuid(), text, name: picked.name.slice(0, 180), size: picked.size,
        sha256: picked.sha256, unknown: false, inFlight: false });
      return;
    }
    if (!text.trim()) { composerState('Напишите текст ответа.', 'error'); return; }
    if (text.length > max) { composerState(`Ответ длиннее ${max} символов — сократите его.`, 'error'); return; }
    // Текст переходит в неразрешённую отправку: обычный черновик этой ссылки больше не нужен.
    drafts.delete(draftKey(state.user.id, state.ref));
    transmit({ v: 3, userId: state.user.id, ref: state.ref, requestId: uuid(), text, unknown: false, inFlight: false });
  });
  $('composer-retry').addEventListener('click', () => {
    const gate = replyGate();
    if (gate.mode !== 'retry' || !gate.record.unknown) return;
    if (gate.record.type === 'file' && preparingNow()) { composerState('Проверяем файл…', 'pending'); return; }   // Repair R1
    if (gate.record.type === 'file') transmitFile(gate.record); else transmit(gate.record);
  });
  $('composer-drop').addEventListener('click', () => {
    // Отказаться можно и в диалоге, который сейчас не загружается (например, 404): выбран тот же диалог и тот же автор.
    const record = state.pending;
    if (!state.user || state.sending || !record || record.userId !== state.user.id || !sameRef(record.ref, state.ref)) return;
    clearRecord(record);
    // Подпись файла — обычный черновик поля: при отказе от файла он не стирается.
    if (record.type !== 'file') $('composer-text').value = '';
    renderComposer();
    composerState('Повтор снят. Если сервер уже принял первую отправку, ответ всё равно уйдёт клиенту и будет виден в истории — отменить его отсюда нельзя.');
    say('');
    openRef(state.ref, { quiet: true });
  });

  start();
})();
