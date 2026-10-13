/* Palitra — чат по заявке на сайте магазина (PALITRA-WEBCHAT-PHASEC 14.10.2026). Страница /chat того же адреса,
   только текст. Принятый HTTP PhaseB: POST /api/customer-chat/{session,threads,messages,message,telegram-link,revoke}.

   Правила:
   - доступ — собственная cookie чата (HttpOnly, её ставит только сервер) и CSRF чата в памяти страницы (заголовок
     X-Palitra-Chat-CSRF). ?thread=N в адресе — только выбор: доступ проверяет сервер. Номер заявки, имя, телефон и
     @ник доступа не дают, по ним ничего не ищется;
   - сессия: GET /api/draft-account/session (CSRF гостя или покупателя) → POST session {} с X-CSRF-Token аккаунта.
     Новая сессия не получает прежнюю историю — об этом сказано прямо, а не «восстановлено»;
   - тексты — только textContent: без HTML, разметки и автоматических ссылок;
   - сообщение: requestId создаётся один раз и записывается до отправки. Исход неизвестен при отсутствии ответа, 408,
     5xx, нечитаемой или неточной квитанции — повтор только кнопкой тем же requestId в том же чате; пока он не решён,
     новые сообщения не отправляются. Квитанция — ok, тот же threadId и положительный message.id. «Сохранено в чате» —
     не «прочитано» и не доставка в Telegram (у сообщений покупателя статусов доставки нет);
   - Telegram: только ссылка сервера в строгом формате c_, обычный переход в этом же окне; «Начать» нажимает сам клиент. */
'use strict';

(() => {
  const API = '/api/customer-chat/';
  const MAX = 4000, PAGE = 50, LIST_PAGE = 20, TIMEOUT_MS = 15000, POLL_MS = 15000;
  const ACCOUNT_CSRF = /^[A-Za-z0-9_-]{16,128}$/;
  const CHAT_CSRF = /^[A-Za-z0-9_-]{43}$/;
  const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const TELEGRAM_LINK = /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{1,28}[Bb][Oo][Tt]\?start=c_[A-Za-z0-9_-]{32}$/;
  const THREAD_PARAM = /^[1-9]\d{0,15}$/;
  // PALITRA-WEBCHAT-PHASEE: один файл до 20 МБ; ссылка загрузки — только серверная `upload:<UUID>`.
  const MAX_UPLOAD = 20 * 1024 * 1024;
  const UPLOAD_REF = /^upload:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const UPLOAD_TIMEOUT_MS = 120000;
  const PENDING_KEY = 'palitra-chat-pending-v1';
  const DRAFT_PREFIX = 'palitra-chat-draft-v1:';
  const LAST_KEY = 'palitra-chat-last-v1';
  const SESSION_LOST = new Set(['NO_SESSION', 'EXPIRED', 'REVOKED']);
  const START_TEXT = 'Откроется Telegram. Нажмите «Начать», чтобы связать переписку с этой заявкой.';
  const UNKNOWN_TEXT = 'Исход прошлой отправки неизвестен. Проверьте переписку выше и нажмите «Проверить и повторить ту же отправку»: уйдёт то же сообщение с тем же номером запроса, дубля не будет.';
  const BLOCKED_TEXT = 'Сначала проверьте неотправленное сообщение в другой заявке: пока его исход неизвестен, новые сообщения не отправляются.';
  const NOT_HERE = 'Этот чат недоступен в текущей сессии браузера. Доступ к чату не восстанавливается по номеру заявки или контактам.';
  const LINK_REASONS = Object.freeze({
    BOT_DISABLED: 'Telegram для магазина пока не подключён — пишите здесь, менеджер ответит в этом чате.',
    BRIDGE_NOT_READY: 'Telegram сейчас недоступен — пишите здесь, менеджер ответит в этом чате.',
    RATE_LIMITED: 'Слишком много ссылок подряд — попробуйте через несколько минут.'
  });
  const SEND_ERRORS = Object.freeze({
    TOO_LONG: `Сообщение длиннее ${MAX} символов — сократите его.`,
    EMPTY: 'Напишите текст сообщения.',
    RATE_LIMITED: 'Слишком много сообщений подряд. Подождите немного — текст сохранён.',
    THREAD: NOT_HERE
  });

  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };
  const positive = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
  const when = (iso) => {
    const time = Date.parse(iso || '');
    return Number.isFinite(time) ? new Date(time).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  };
  // Хранилище вкладки: только номера, черновики и неразрешённая отправка — без cookie, CSRF и ссылок START.
  const store = (() => {
    try { const s = window.sessionStorage; s.getItem(LAST_KEY); return s; } catch (_) { /* недоступно */ }
    const map = new Map();
    return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
  })();
  const readJson = (key) => { try { return JSON.parse(store.getItem(key) || 'null'); } catch (_) { return null; } };
  const writeJson = (key, value) => { try { store.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; } };
  const forget = (key) => { try { store.removeItem(key); } catch (_) { /* недоступно */ } };

  const state = { csrf: '', epoch: 0, seq: { list: 0, thread: 0, earlier: 0 }, threadsBefore: null, threadId: null, thread: null,
    messages: [], before: null, pageGen: 0, pending: null, memoryPending: null, sending: false, poll: 0, returnId: null,
    // PHASEE: загрузки включены сервером ({maxBytes}) и выбранный файл { file, name, size, sha256, threadId, epoch } — только в памяти.
    uploadInfo: null, file: null, fileSeq: 0,
    // PHASEE repair R1: файл выбран, sha256 ещё считается — { seq, threadId, epoch, name, size }; пока он есть, отправки нет.
    filePreparing: null };

  /* ---------- сеть ---------- */
  class ChatError extends Error {
    constructor(message, status, code, { unknown = false, refused = false } = {}) { super(message); this.status = status; this.code = code; this.unknown = unknown; this.refused = refused; }
  }
  function ticket(name) {
    const epoch = state.epoch, number = ++state.seq[name];
    return () => epoch === state.epoch && state.seq[name] === number;
  }
  async function request(path, { method = 'POST', body, headers = {}, write = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res, data = null;
    try {
      res = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined });
      try { data = await res.json(); } catch (_) { data = null; }
    } catch (_) {
      throw new ChatError('Нет ответа сервера. Проверьте связь.', 0, 'NETWORK', { unknown: write });
    } finally { clearTimeout(timer); }
    return { res, data };
  }
  // Запрос чата: CSRF чата из памяти; 401 «сессии нет/истекла/закрыта» — экран новой сессии (поздний ответ прежней эпохи — нет).
  async function chat(route, body, { write = false } = {}) {
    const epoch = state.epoch;
    const { res, data } = await request(API + route, { body, headers: { 'X-Palitra-Chat-CSRF': state.csrf }, write });
    const code = data && typeof data.code === 'string' ? data.code : '';
    const message = data && typeof data.error === 'string' && data.error ? data.error : `Сервер не выполнил запрос (${res.status})`;
    if (res.status === 401 && SESSION_LOST.has(code)) {
      if (epoch === state.epoch) sessionLost();
      throw new ChatError(message, 401, code, { refused: write });
    }
    if (!res.ok) {
      // Ни 5xx, ни 408 не доказывают, что запись не состоялась.
      const unknown = write && (res.status >= 500 || res.status === 408);
      throw new ChatError(message, res.status, code, { unknown, refused: write && !unknown });
    }
    if (!data || typeof data !== 'object' || data.ok !== true) throw new ChatError('Ответ сервера не удалось прочитать.', res.status, 'UNREADABLE', { unknown: write });
    return data;
  }

  /* ---------- экран ---------- */
  const say = (text, error = false) => { const node = $('pc-status'); node.textContent = text || ''; node.dataset.state = error ? 'error' : ''; node.hidden = !text; };
  const viewStatus = (text, error = false) => { const node = $('pc-view-status'); node.textContent = text || ''; node.dataset.state = error ? 'error' : ''; };
  const sendState = (text, kind = '') => { const node = $('pc-state'); node.textContent = text || ''; node.dataset.state = kind; };
  const telegramNote = (text, error = false) => { const node = $('pc-telegram-note'); node.textContent = text || ''; node.dataset.state = error ? 'error' : ''; };
  function hideMain() {
    stopPoll();
    $('pc-main').hidden = true;
    $('pc-main').classList.remove('is-open');
    $('pc-view').hidden = true;
    $('pc-title').textContent = '';
    $('pc-threads').replaceChildren();
    $('pc-messages').replaceChildren();
    $('pc-threads-more').hidden = true;
    clearFile();
    state.threadId = null; state.thread = null; state.messages = []; state.before = null; state.threadsBefore = null;
  }
  function showList() {
    saveDraft();
    stopPoll();
    $('pc-main').classList.remove('is-open');
    $('pc-view').hidden = true;
    state.returnId = state.threadId;
    clearFile();
    state.threadId = null; state.thread = null; state.messages = []; state.before = null;
    $('pc-messages').replaceChildren();
    renderComposer();
  }

  /* ---------- сессия ---------- */
  async function accountCsrf() {
    const { res, data } = await request('/api/draft-account/session', { method: 'GET' });
    if (!res || res.status !== 200 || !data || typeof data.csrf !== 'string' || !ACCOUNT_CSRF.test(data.csrf)) return '';
    return data.csrf;
  }
  async function boot({ restart = false } = {}) {
    state.epoch += 1;
    const epoch = state.epoch;
    state.csrf = '';
    hideMain();
    $('pc-restart-wrap').hidden = true;
    $('pc-revoke').disabled = false;  // кнопка новой эпохи не наследует состояние незавершённого revoke прежней
    say('Открываем чат…');
    let created = false;
    try {
      const account = await accountCsrf();
      if (epoch !== state.epoch) return;
      if (!account) { say('Не удалось подтвердить сессию магазина. Обновите страницу.', true); $('pc-restart-wrap').hidden = false; return; }
      const { res, data } = await request(`${API}session`, { body: {}, headers: { 'X-CSRF-Token': account } });
      if (epoch !== state.epoch) return;
      if (res.status === 200 && data && data.ok === true && typeof data.csrfToken === 'string' && CHAT_CSRF.test(data.csrfToken)) {
        state.csrf = data.csrfToken;
        created = data.created === true;
      } else if (data && data.ok === false && (data.code === 'CHAT_DISABLED' || (res.status === 404 && data.code === 'NOT_FOUND'))) {
        // Принятый HTTP при выключенном чате отвечает на этот маршрут 404 {code:'NOT_FOUND'}: страница честно говорит, что чата нет.
        say('Чат на сайте сейчас недоступен. Заявки принимаются как обычно — менеджер свяжется по контакту из заявки.');
        return;
      } else {
        say(`Чат не открылся: ${data && typeof data.error === 'string' && data.error ? data.error : `ответ сервера ${res.status}`}`, true);
        $('pc-restart-wrap').hidden = false;
        return;
      }
    } catch (_) {
      if (epoch === state.epoch) { say('Чат не открылся: нет связи с сервером.', true); $('pc-restart-wrap').hidden = false; }
      return;
    }
    say(created ? (restart ? 'Открыта новая сессия чата. Прежняя переписка этого браузера в ней недоступна.'
      : 'Новая сессия чата в этом браузере: здесь появятся чаты заявок, отправленных отсюда.') : '');
    $('pc-main').hidden = false;
    state.pending = loadPending();
    await loadThreads();
    if (epoch !== state.epoch) return;
    const wanted = requestedThread();
    if (wanted) openThread(wanted, { focus: true });
  }
  function requestedThread() {
    const raw = new URLSearchParams(window.location.search).get('thread');
    if (raw !== null) return THREAD_PARAM.test(raw) ? Number(raw) : null;
    const last = readJson(LAST_KEY);
    if (last && positive(last.threadId)) return last.threadId;
    const buttons = $('pc-threads').querySelectorAll('[data-thread-id]');
    return buttons.length === 1 ? Number(buttons[0].dataset.threadId) : null;
  }
  // Сессия чата закончилась (истекла, закрыта, cookie нет): прежняя переписка здесь недоступна, новая сессия — пустая.
  function sessionLost() {
    state.epoch += 1;
    state.csrf = '';
    hideMain();
    say('Сессия чата закончилась. Прежняя переписка в этом браузере больше недоступна: доступ не восстанавливается по номеру заявки или контактам. Черновик сохранён.', true);
    $('pc-restart-wrap').hidden = false;
  }
  $('pc-restart').addEventListener('click', () => boot({ restart: true }));

  /* ---------- мои заявки ---------- */
  async function loadThreads({ append = false } = {}) {
    if (!state.csrf) return;
    const live = ticket('list');
    $('pc-list-status').textContent = 'Загружаем ваши заявки…';
    $('pc-threads-more').hidden = true;
    try {
      const body = { limit: LIST_PAGE, ...(append && state.threadsBefore ? { before: state.threadsBefore } : {}) };
      const data = await chat('threads', body);
      if (!live()) return;
      if (!Array.isArray(data.threads)) throw new ChatError('Ответ сервера не удалось прочитать.', 200, 'UNREADABLE');
      const list = $('pc-threads');
      if (!append) list.replaceChildren();
      const shown = new Set([...list.querySelectorAll('[data-thread-id]')].map((node) => node.dataset.threadId));
      for (const thread of data.threads) {
        const id = thread && positive(thread.id);
        if (!id || shown.has(String(id))) continue;
        shown.add(String(id));
        list.append(threadItem(thread));
      }
      state.threadsBefore = positive(data.nextBefore);
      $('pc-threads-more').hidden = !state.threadsBefore;
      $('pc-list-status').textContent = list.childElementCount ? '' : 'В этом браузере пока нет чатов по заявкам. Чат появляется после заявки, отправленной отсюда.';
      if (state.returnId && !state.threadId) {
        const button = list.querySelector(`[data-thread-id="${state.returnId}"]`);
        if (button && (document.activeElement === document.body || !document.activeElement || !document.activeElement.isConnected)) button.focus();
      }
    } catch (error) {
      if (!live() || (error.status === 401 && SESSION_LOST.has(error.code))) return;
      $('pc-list-status').textContent = `Заявки не загрузились: ${error.message}`;
    }
  }
  function threadItem(thread) {
    const li = el('li');
    const button = el('button', 'pc-thread');
    button.type = 'button';
    button.dataset.threadId = String(thread.id);
    button.append(el('strong', '', positive(thread.orderId) ? `Заявка №${thread.orderId}` : 'Чат по заявке'));
    button.append(el('span', 'pc-muted', [thread.telegramLinked === true ? 'Telegram подключён' : '', when(thread.lastMessageAt || thread.createdAt)].filter(Boolean).join(' · ')));
    button.addEventListener('click', () => openThread(thread.id, { focus: true }));
    li.append(button);
    return li;
  }
  $('pc-threads-more').addEventListener('click', () => loadThreads({ append: true }));
  $('pc-back').addEventListener('click', () => {
    const id = state.threadId;
    showList();
    const button = id ? $('pc-threads').querySelector(`[data-thread-id="${id}"]`) : null;
    if (button) button.focus();
    loadThreads();
  });

  /* ---------- переписка заявки ---------- */
  const validMessage = (m) => Boolean(m && typeof m === 'object' && positive(m.id));
  function mergeById(older, newer) {
    const map = new Map();
    for (const m of older) map.set(m.id, m);
    for (const m of newer) map.set(m.id, m);
    return [...map.values()].sort((a, b) => a.id - b.id);
  }
  async function openThread(id, { quiet = false, focus = false } = {}) {
    if (!state.csrf || !positive(id)) return;
    const live = ticket('thread');
    const switching = state.threadId !== id;
    if (switching) {
      saveDraft();
      clearFile();   // PHASEE: выбранный файл относится только к своему чату
      state.threadId = id; state.thread = null; state.messages = []; state.before = null; state.pageGen += 1;
      $('pc-messages').replaceChildren();
      $('pc-title').textContent = 'Чат по заявке';
      $('pc-telegram-state').textContent = ''; $('pc-telegram').hidden = true; telegramNote(''); $('pc-new-below').textContent = '';
      $('pc-earlier').hidden = true;
    }
    $('pc-main').classList.add('is-open');
    $('pc-view').hidden = false;
    if (switching) { restoreDraft(id); sendState(''); }
    if (!quiet) viewStatus('Загружаем сообщения…');
    renderComposer();
    try {
      const data = await chat('messages', { threadId: id, limit: PAGE });
      if (!live() || state.threadId !== id) return;
      if (!data.thread || data.thread.id !== id || !Array.isArray(data.messages)) throw new ChatError('Сервер вернул другой чат.', 200, 'MISMATCH');
      const fresh = data.messages.filter(validMessage);
      const nextBefore = positive(data.nextBefore);
      let messages = fresh, before = nextBefore, merged = false;
      if (!switching && state.messages.length) {
        // Тихое обновление не стирает уже загруженные ранние сообщения, если новая страница с ними смыкается.
        const newest = state.messages[state.messages.length - 1].id;
        if (nextBefore === null || !fresh.length || fresh[0].id <= newest) { messages = mergeById(state.messages, fresh); before = nextBefore === null ? null : state.before; merged = true; }
      }
      const hadNewest = state.messages.length ? state.messages[state.messages.length - 1].id : 0;
      // Repair P01: история заменена новой страницей — начатые раньше «Показать ранее» к ней больше не относятся.
      if (!merged) state.pageGen += 1;
      state.thread = data.thread; state.messages = messages; state.before = before;
      // PHASEE: выбор файла — только если сервер прямо сообщил, что загрузки включены (иначе — прежний «только текст»).
      state.uploadInfo = data.uploads && data.uploads.enabled === true && positive(data.uploads.maxBytes)
        ? { maxBytes: Math.min(data.uploads.maxBytes, MAX_UPLOAD) } : null;
      // Repair R1: загрузки выключены — выбор файла снимается явно (иначе его нельзя было бы ни отправить, ни убрать).
      if (!state.uploadInfo && (state.file || state.filePreparing)) { clearFile(); sendState('Отправка файлов сейчас недоступна — выбранный файл убран, подпись осталась в поле.', 'error'); }
      renderThread();
      viewStatus('');
      writeJson(LAST_KEY, { orderId: positive(data.thread.orderId), threadId: id });
      if (switching) {
        const last = $('pc-messages').lastElementChild;
        if (last && typeof last.scrollIntoView === 'function') last.scrollIntoView({ block: 'end' });
      } else if (messages.length && messages[messages.length - 1].id > hadNewest && !nearBottom()) {
        $('pc-new-below').textContent = 'Есть новые сообщения ниже.';
      }
      renderComposer();
      if (focus) $('pc-title').focus({ preventScroll: true });
      schedulePoll();
    } catch (error) {
      if (!live() || (error.status === 401 && SESSION_LOST.has(error.code))) return;
      if (error.code === 'MISMATCH' || error.status === 404) { state.thread = null; state.messages = []; $('pc-messages').replaceChildren(); }
      viewStatus(error.status === 404 ? NOT_HERE : `Сообщения не загрузились: ${error.message}`, true);
      renderComposer();
      // Сбой тихого чтения доступного чата не останавливает опрос навсегда.
      if (quiet && state.thread && state.thread.id === id) schedulePoll();
    }
  }
  function nearBottom() {
    const last = $('pc-messages').lastElementChild;
    if (!last) return true;
    return last.getBoundingClientRect().top < window.innerHeight;
  }
  function renderThread() {
    const thread = state.thread;
    $('pc-title').textContent = positive(thread.orderId) ? `Заявка №${thread.orderId}` : 'Чат по заявке';
    const linked = thread.telegramLinked === true;
    $('pc-telegram-state').textContent = linked ? 'Telegram подключён к этой заявке: ответы менеджера придут и туда.' : 'Можно продолжить переписку в Telegram — она останется и здесь.';
    $('pc-telegram').hidden = linked;
    $('pc-earlier').hidden = !state.before;
    renderMessages();
  }
  /* PALITRA-WEBCHAT-PHASED1: вложения сообщения. Адрес — только собственный защищённый маршрут этого чата и ссылки
     сервера `thread:<id>` (cookie этой сессии, без токенов в адресе); адреса из полученного текста не используются.
     Картинка/звук/видео — только при проверенном сервером способе показа, без автозапуска; иначе — «Скачать файл».
     Не сохранённый файл — честное состояние. Подпись (caption) — текст сообщения, выводится один раз. */
  const FILE_KIND = Object.freeze({ photo: 'Фото', voice: 'Голосовое сообщение', audio: 'Аудио', video: 'Видео', video_note: 'Видеосообщение',
    animation: 'Анимация', document: 'Файл', sticker: 'Стикер' });
  const FILE_STATE = Object.freeze({ pending: 'Файл ещё загружается — появится здесь сам.', too_large: 'Файл больше 20 МБ: здесь сохранены только сведения о нём.',
    quota_exceeded: 'Хранилище файлов заполнено: файл не сохранён.', unavailable: 'Telegram не отдал файл — он остался только в Telegram.' });
  // PALITRA-WEBCHAT-PHASEE: + `upload:<UUID>` — файл, отправленный с сайта или из приложения (тот же защищённый маршрут чата).
  const FILE_REF = /^(thread:[1-9]\d{0,15}|upload:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
  const sizeText = (size) => (positive(size) ? (size >= 1048576 ? `${(size / 1048576).toFixed(1).replace('.', ',')} МБ` : `${Math.max(1, Math.round(size / 1024))} КБ`) : '');
  function attachmentNode(threadId, file, index = 0) {
    const box = el('div', 'pc-file');
    const match = FILE_REF.exec(String(file && file.ref || ''));
    // Repair R1: ключ и подпись вложения — по ним неизменный блок (ссылка, плеер) переносится в обновлённое сообщение.
    box.dataset.fileKey = match ? match[1] : `index:${index}`;
    box.dataset.fileSig = `${threadId}|${JSON.stringify(file)}`;
    const label = file && file.kind === 'sticker' && file.animated === true ? 'Анимированный стикер' : FILE_KIND[file && file.kind] || 'Файл';
    box.append(el('span', 'pc-file__kind', [label, sizeText(file && file.size)].filter(Boolean).join(' · ')));
    if (!match || !positive(threadId) || file.storageStatus !== 'stored') {
      box.append(el('span', 'pc-file__state', FILE_STATE[file && file.storageStatus] || 'Файл недоступен.'));
      return box;
    }
    const url = `/api/customer-chat/threads/${threadId}/attachments/${match[1]}`;
    if (file.presentation === 'image') {
      const image = el('img', 'pc-file__image');
      image.alt = label; image.loading = 'lazy'; image.decoding = 'async'; image.src = url;
      box.append(image);
    } else if (file.presentation === 'audio') {
      const audio = el('audio', 'pc-file__audio');
      audio.controls = true; audio.preload = 'none'; audio.src = url;
      box.append(audio);
    } else if (file.presentation === 'video') {
      const video = el('video', `pc-file__video${file.kind === 'video_note' ? ' pc-file__video--round' : ''}`);
      video.controls = true; video.preload = 'metadata'; video.playsInline = true; video.src = url;
      box.append(video);
    }
    const link = el('a', 'pc-file__download', file.presentation === 'download' ? `Скачать файл${file.name ? `: ${file.name}` : ''}` : 'Скачать');
    link.href = url; link.setAttribute('download', '');
    box.append(link);
    return box;
  }
  function messageNode(m) {
    const own = m.author === 'customer';
    const item = el('li', `pc-msg pc-msg--${own ? 'own' : 'shop'}`);
    const who = own ? `Вы · ${m.channel === 'telegram' ? 'из Telegram' : 'на сайте'}` : 'Магазин';
    item.append(el('span', 'pc-msg__meta', [who, when(m.createdAt), positive(m.replacesMessageId) ? 'изменено (новая версия)' : ''].filter(Boolean).join(' · ')));
    if (typeof m.text === 'string' && m.text) item.append(el('p', 'pc-msg__text', m.text));
    (Array.isArray(m.attachments) ? m.attachments : []).forEach((file, index) => item.append(attachmentNode(state.threadId, file, index)));
    if (m.edited === true) item.append(el('span', 'pc-msg__status', 'Есть новая версия ниже'));
    if (own && m.stored === true) item.append(el('span', 'pc-msg__status', 'Сохранено в чате'));
    return item;
  }
  /* Repair R1: дочерние узлы приводятся к нужному порядку без снятия с документа тех, что остаются: снятый узел теряет
     фокус (ссылка «Скачать», плеер). Лишние удаляются, недостающие вставляются; стоящий на месте узел не трогается. */
  function patchChildren(parent, desired) {
    const keep = new Set(desired);
    for (const child of [...parent.childNodes]) if (!keep.has(child)) child.remove();
    let cursor = parent.firstChild;
    for (const node of desired) {
      if (node === cursor) { cursor = cursor.nextSibling; continue; }
      parent.insertBefore(node, cursor);
    }
  }
  // Изменённое сообщение (отметка правки, статус) обновляется на месте: неизменные блоки вложений остаются теми же узлами.
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
  // Сообщения по ключу: неизменные узлы не пересоздаются и не снимаются; первое видимое сообщение остаётся на месте экрана.
  function renderMessages() {
    const list = $('pc-messages');
    let anchor = null;
    for (const node of list.children) {
      if (!node.dataset.key) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom > 0) { anchor = { key: node.dataset.key, top: rect.top }; break; }
    }
    const old = new Map();
    for (const node of list.children) if (node.dataset.key) old.set(node.dataset.key, node);
    const nodes = state.messages.map((m) => {
      const key = String(m.id), sig = JSON.stringify(m), known = old.get(key);
      if (known && known.dataset.sig === sig) return known;
      const node = messageNode(m);
      if (known) { updateMessage(known, node); known.dataset.sig = sig; return known; }
      node.dataset.key = key; node.dataset.sig = sig;
      return node;
    });
    if (!nodes.length) nodes.push(el('li', 'pc-muted', 'Сообщений пока нет. Напишите менеджеру — ответ появится здесь.'));
    patchChildren(list, nodes);
    if (anchor) {
      const same = nodes.find((node) => node.dataset.key === anchor.key);
      if (same) { const shift = same.getBoundingClientRect().top - anchor.top; if (shift) window.scrollBy(0, shift); }
    }
  }
  $('pc-earlier').addEventListener('click', async () => {
    const id = state.threadId, before = state.before, gen = state.pageGen, button = $('pc-earlier');
    if (!id || !before || button.disabled) return;
    const live = ticket('earlier');
    button.disabled = true;
    try {
      const data = await chat('messages', { threadId: id, before, limit: PAGE });
      if (!live() || state.threadId !== id) return;
      // Repair P01: ответ применяется, только если загруженная история и её граница те же, что при запросе. Иначе
      // (тихое обновление заменило страницу) он устарел: текущая граница и «Показать ранее» остаются как есть.
      if (state.pageGen !== gen || state.before !== before) return;
      if (!data.thread || data.thread.id !== id || !Array.isArray(data.messages)) throw new ChatError('Сервер вернул другой чат.', 200, 'MISMATCH');
      state.messages = mergeById(data.messages.filter(validMessage), state.messages);
      state.before = positive(data.nextBefore);
      renderThread();
    } catch (error) {
      if (live() && !(error.status === 401 && SESSION_LOST.has(error.code))) viewStatus(`Ранние сообщения не загрузились: ${error.message}`, true);
    } finally { button.disabled = false; }
  });
  function stopPoll() { clearTimeout(state.poll); state.poll = 0; }
  // Тихое перечитывание открытого чата — только видимая страница, без повторной отправки.
  function schedulePoll() {
    stopPoll();
    const id = state.threadId, epoch = state.epoch;
    if (!id) return;
    state.poll = setTimeout(() => {
      state.poll = 0;
      if (epoch !== state.epoch || state.threadId !== id) return;
      if (document.visibilityState !== 'visible') return;   // скрытая страница: обновит visibilitychange
      // Repair P02: во время отправки цикл не теряется, а переносится (один таймер: schedulePoll сначала гасит прежний).
      if (state.sending) { schedulePoll(); return; }
      openThread(id, { quiet: true });
    }, POLL_MS);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.csrf && state.threadId && state.thread && !state.sending) openThread(state.threadId, { quiet: true });
  });
  window.addEventListener('scroll', () => { if (nearBottom()) $('pc-new-below').textContent = ''; }, { passive: true });

  /* ---------- Telegram ---------- */
  function isTelegramLink(value) {
    if (typeof value !== 'string' || !TELEGRAM_LINK.test(value)) return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 't.me' && !url.port && !url.username && !url.password && !url.hash
        && [...url.searchParams.keys()].join(',') === 'start' && /^c_[A-Za-z0-9_-]{32}$/.test(url.searchParams.get('start') || '');
    } catch (_) { return false; }
  }
  $('pc-telegram').addEventListener('click', async () => {
    const button = $('pc-telegram');
    const id = state.thread ? state.thread.id : null, epoch = state.epoch;
    if (button.disabled || !id) return;
    button.disabled = true;
    telegramNote('Получаем ссылку на Telegram…');
    try {
      const data = await chat('telegram-link', { threadId: id });
      if (epoch !== state.epoch || state.threadId !== id) return;
      if (!isTelegramLink(data.url)) { telegramNote('Сервер вернул непроверенную ссылку — Telegram не открываем.', true); return; }
      saveDraft();
      writeJson(LAST_KEY, { orderId: positive(state.thread && state.thread.orderId), threadId: id });
      telegramNote(START_TEXT);
      button.textContent = 'Получить ссылку ещё раз';
      window.location.assign(data.url);
    } catch (error) {
      if (epoch !== state.epoch || (error.status === 401 && SESSION_LOST.has(error.code))) return;
      telegramNote(LINK_REASONS[error.code] || `Ссылку на Telegram получить не удалось: ${error.message}`, true);
      button.textContent = 'Получить ссылку ещё раз';
    } finally { button.disabled = false; }
  });

  /* ---------- черновик и отправка ---------- */
  const draftKey = (id) => `${DRAFT_PREFIX}${id}`;
  function saveDraft() {
    const field = $('pc-text'), id = state.threadId;
    if (!id || field.readOnly) return;
    if (field.value) writeJson(draftKey(id), { text: field.value, start: field.selectionStart, end: field.selectionEnd });
    else forget(draftKey(id));
  }
  function restoreDraft(id) {
    const field = $('pc-text'), draft = readJson(draftKey(id));
    field.readOnly = false;
    field.value = draft && typeof draft.text === 'string' ? draft.text.slice(0, MAX) : '';
    if (draft && Number.isSafeInteger(draft.start) && Number.isSafeInteger(draft.end)) { try { field.setSelectionRange(draft.start, draft.end); } catch (_) { /* не обязательно */ } }
  }
  const updateCount = () => { $('pc-count').textContent = `${$('pc-text').value.length} / ${MAX}`; };
  $('pc-text').addEventListener('input', () => { updateCount(); saveDraft(); });
  $('pc-text').addEventListener('blur', saveDraft);

  /* Неразрешённая отправка: { v, threadId, requestId, text, unknown, inFlight } — до ответа сервера и после неизвестного
     исхода. Снимается только точной квитанцией, доказанным отказом первой попытки или явным «Отказаться».
     PALITRA-WEBCHAT-PHASEE: файл — та же запись с type:'file' и сведениями { name, size, sha256, uploadRef? }; text — подпись
     (может быть пустой). Сам файл — только в памяти страницы; после перезагрузки его нужно выбрать снова (сверка размера
     и sha256), номер запроса тот же. Прежние текстовые записи (без type) читаются как раньше. */
  function validRecord(record) {
    if (!record || typeof record !== 'object' || record.v !== 1 || positive(record.threadId) === null || !REQUEST_ID.test(String(record.requestId))) return false;
    if (record.type === 'file') {
      return typeof record.text === 'string' && record.text.length <= MAX && typeof record.name === 'string' && record.name.length > 0 && record.name.length <= 180
        && positive(record.size) !== null && record.size <= MAX_UPLOAD && /^[0-9a-f]{64}$/.test(String(record.sha256))
        && (record.uploadRef === undefined || UPLOAD_REF.test(String(record.uploadRef)));
    }
    return record.type === undefined && typeof record.text === 'string' && record.text.trim() !== '' && record.text.length <= MAX;
  }
  function loadPending() {
    const record = state.memoryPending || readJson(PENDING_KEY);
    // После перезагрузки исход прежней попытки неизвестен, даже если она «отправлялась».
    return validRecord(record) ? { ...record, unknown: true, inFlight: false } : null;
  }
  function writeRecord(record) {
    state.memoryPending = record;
    writeJson(PENDING_KEY, record);
    state.pending = record;
  }
  function clearRecord(record) {
    if (state.memoryPending && state.memoryPending.requestId === record.requestId) state.memoryPending = null;
    const saved = readJson(PENDING_KEY);
    if (saved && saved.requestId === record.requestId) forget(PENDING_KEY);
    if (state.pending && state.pending.requestId === record.requestId) state.pending = null;
  }
  function gate() {
    if (state.sending || !state.csrf || !state.thread || state.thread.id !== state.threadId) return { mode: 'busy' };
    const record = state.pending;
    if (!record) return { mode: 'new' };
    return record.threadId === state.threadId ? { mode: 'retry', record } : { mode: 'blocked', record };
  }
  function renderComposer() {
    const field = $('pc-text'), record = state.pending;
    const here = Boolean(record && record.threadId === state.threadId);
    const ready = Boolean(state.csrf && state.thread && state.thread.id === state.threadId);
    $('pc-unknown').hidden = !(here && record.unknown);
    // Repair R1: пока считается sha256 выбранного файла — ни «Отправить», ни повтора файла.
    const preparing = preparingNow();
    $('pc-retry').disabled = state.sending || (preparing && here && record.type === 'file');
    $('pc-drop').disabled = state.sending;
    $('pc-send').disabled = state.sending || !ready || Boolean(record) || preparing;
    $('pc-blocked').hidden = !(record && !here && state.threadId);
    // PHASEE: у файла поле остаётся черновиком (подпись уже в записи): поздние правки сохраняются и после квитанции.
    const textRecord = here && record.type !== 'file';
    field.readOnly = textRecord;
    if (textRecord) field.value = record.text;
    renderPicker();
    if (record && !here && ready) sendState(BLOCKED_TEXT, 'error');
    else if (here && record.unknown && !state.sending) sendState(UNKNOWN_TEXT, 'error');
    updateCount();
  }
  const uuid = () => {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    const b = window.crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };

  /* ---------- PALITRA-WEBCHAT-PHASEE: один файл в этот чат ----------
     Кнопка «Прикрепить файл» появляется, только если сервер сообщил uploads.enabled. Файл читается один раз (sha256 для
     сверки), в памяти страницы; без base64, превью и автоматических отправок. Текст поля — подпись (можно без неё).
     Отправка: prepare (тот же requestId при повторе) → байты (тот же upload:<UUID>) → точная квитанция с этим файлом. */
  const picker = { box: null, input: null, name: null, remove: null };
  function mountPicker() {
    if (picker.box) return;
    const box = el('div', 'pc-attach');
    box.id = 'pc-attach';
    const input = el('input', 'pc-attach__input');
    input.type = 'file'; input.id = 'pc-file';
    input.setAttribute('aria-describedby', 'pc-file-name');
    const label = el('label', 'pc-btn pc-btn--quiet pc-attach__pick', 'Прикрепить файл');
    label.htmlFor = 'pc-file';
    const name = el('span', 'pc-muted pc-attach__name');
    name.id = 'pc-file-name';
    const remove = el('button', 'pc-btn pc-btn--quiet pc-attach__remove', 'Убрать');
    remove.type = 'button'; remove.hidden = true;
    box.append(input, label, name, remove);
    $('pc-text').after(box);
    input.addEventListener('change', () => { const file = input.files && input.files[0]; pickFile(file || null); });
    remove.addEventListener('click', () => { clearFile(); renderComposer(); sendState(''); input.focus(); });
    Object.assign(picker, { box, input, name, remove });
  }
  function renderPicker() {
    const on = Boolean(state.uploadInfo && state.thread && state.thread.id === state.threadId);
    const note = $('pc-files-note');
    if (note && note.firstChild && note.firstChild.nodeType === 3) {
      note.firstChild.textContent = on ? 'Фото, видео, голосовые и файлы из Telegram видны здесь. С сайта можно отправить один файл до 20 МБ — текст станет подписью. '
        : 'Фото, видео, голосовые и файлы из Telegram видны здесь. С сайта пока отправляется только текст. ';
    }
    if (!on) { if (picker.box) picker.box.hidden = true; return; }
    mountPicker();
    picker.box.hidden = false;
    const record = state.pending, file = state.file, preparing = preparingNow() ? state.filePreparing : null;
    const here = Boolean(record && record.threadId === state.threadId && record.type === 'file');
    picker.input.disabled = state.sending;
    picker.remove.hidden = !(file || preparing);
    picker.remove.disabled = state.sending;
    picker.name.textContent = file ? `${file.name} · ${sizeText(file.size)}`
      : preparing ? `${preparing.name} · ${sizeText(preparing.size)} · проверяем файл…`
        : here ? `Неотправленный файл: ${record.name} · ${sizeText(record.size)}. Для повтора выберите этот же файл.` : 'Файл не выбран';
  }
  // Repair R1: расчёт хеша относится только к последнему выбору в этом чате и этой сессии.
  function preparingNow() {
    const p = state.filePreparing;
    return Boolean(p && p.seq === state.fileSeq && p.threadId === state.threadId && p.epoch === state.epoch);
  }
  function clearFile() {
    state.fileSeq += 1;   // поздний расчёт хеша прежнего выбора больше ничего не меняет
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
    if (!file) return;
    const max = state.uploadInfo ? state.uploadInfo.maxBytes : MAX_UPLOAD;
    if (!file.size) { picker.input.value = ''; sendState('Файл пустой — выберите другой.', 'error'); picker.input.focus(); return; }
    if (file.size > max) { picker.input.value = ''; sendState(`Файл больше ${Math.round(max / 1048576)} МБ — выберите файл поменьше.`, 'error'); picker.input.focus(); return; }
    const seq = state.fileSeq, threadId = state.threadId, epoch = state.epoch;
    // Repair R1: пока считается sha256, выбор — «файл готовится»: «Отправить» и повтор файла закрыты, подпись не уходит текстом.
    state.filePreparing = { seq, threadId, epoch, name: file.name, size: file.size };
    renderComposer();
    sendState('Проверяем файл…', 'pending');
    let sha256;
    try { sha256 = await sha256Hex(file); }
    catch (_) {
      // Только свой (последний) выбор: ошибка снимает «готовится», поле с подписью не трогается.
      if (seq === state.fileSeq) { state.filePreparing = null; picker.input.value = ''; renderComposer(); sendState('Файл не удалось прочитать — выберите его ещё раз.', 'error'); }
      return;
    }
    if (seq !== state.fileSeq) return;   // выбор устарел: новый выбор, «Убрать», другой чат или сессия — их состояние не трогаем
    state.filePreparing = null;
    if (threadId !== state.threadId || epoch !== state.epoch) { renderComposer(); return; }
    state.file = { file, name: file.name, size: file.size, sha256, threadId, epoch };
    renderComposer();
    const record = state.pending;
    if (record && record.type === 'file' && record.threadId === threadId) {
      sendState(record.size === file.size && record.sha256 === sha256 ? 'Это тот же файл. Нажмите «Проверить и повторить ту же отправку».'
        : 'Это другой файл: неотправленный файл можно повторить только тем же файлом или отказаться от него.', record.size === file.size && record.sha256 === sha256 ? '' : 'error');
    } else sendState('');
  }
  // Ответ чата (кроме JSON-POST): те же правила, что у chat(): 401 сессии — экран новой сессии; 5xx/408/обрыв записи — неизвестно.
  async function chatFetch(path, { method, body = undefined, write = false }) {
    const epoch = state.epoch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), write ? UPLOAD_TIMEOUT_MS : TIMEOUT_MS);
    let res, data = null;
    try {
      res = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', 'X-Palitra-Chat-CSRF': state.csrf, ...(body !== undefined ? { 'Content-Type': 'application/octet-stream' } : {}) }, body });
      try { data = await res.json(); } catch (_) { data = null; }
    } catch (_) {
      throw new ChatError('Нет ответа сервера. Проверьте связь.', 0, 'NETWORK', { unknown: write });
    } finally { clearTimeout(timer); }
    const code = data && typeof data.code === 'string' ? data.code : '';
    const message = data && typeof data.error === 'string' && data.error ? data.error : `Сервер не выполнил запрос (${res.status})`;
    if (res.status === 401 && SESSION_LOST.has(code)) {
      if (epoch === state.epoch) sessionLost();
      throw new ChatError(message, 401, code, { refused: write });
    }
    if (!res.ok) {
      const unknown = write && (res.status >= 500 || res.status === 408);
      throw new ChatError(message, res.status, code, { unknown, refused: write && !unknown });
    }
    if (!data || typeof data !== 'object' || data.ok !== true) throw new ChatError('Ответ сервера не удалось прочитать.', res.status, 'UNREADABLE', { unknown: write });
    return data;
  }
  const uploadsPath = (threadId) => `${API}threads/${threadId}/uploads`;
  // Точная квитанция файла: тот же чат, настоящее сообщение и в нём именно эта загрузка.
  const fileReceiptOk = (record, data) => Boolean(data && data.threadId === record.threadId && data.message && typeof data.message === 'object'
    && positive(data.message.id) && Array.isArray(data.message.attachments) && data.message.attachments.some((a) => a && a.ref === record.uploadRef));
  const sameFile = (record, picked) => Boolean(picked && picked.threadId === record.threadId && picked.size === record.size && picked.sha256 === record.sha256);
  async function transmitFile(record) {
    const epoch = state.epoch;
    const retry = record.unknown === true;
    state.sending = true;
    record.inFlight = true;
    writeRecord(record);  // до запроса: перезагрузка или обрыв не теряют requestId и сведения о файле
    renderComposer();
    sendState(retry ? 'Проверяем ту же отправку файла…' : 'Отправляем файл…', 'pending');
    let outcome;
    try {
      let data = null;
      // После перезагрузки или таймаута — сначала только чтение состояния той же загрузки.
      if (record.uploadRef) data = await chatFetch(`${uploadsPath(record.threadId)}/${record.uploadRef}`, { method: 'GET' });
      else {
        data = await chat(`threads/${record.threadId}/uploads`, { requestId: record.requestId, name: record.name, size: record.size, sha256: record.sha256, caption: record.text }, { write: true });
        if (data.threadId !== record.threadId || !data.upload || !UPLOAD_REF.test(String(data.upload.ref))) throw new ChatError('Сервер не подтвердил подготовку файла.', 200, 'RECEIPT', { unknown: true });
        record.uploadRef = data.upload.ref;
        writeRecord(record);
      }
      const upload = data.upload || {};
      if (upload.state !== 'committed') {
        if (upload.state === 'receiving') throw new ChatError('Файл ещё загружается. Проверьте отправку чуть позже.', 409, 'IN_PROGRESS', { unknown: true });
        if (upload.state === 'expired' || upload.state === 'rejected') {
          throw new ChatError('Срок этой загрузки истёк, сообщение не создано. Нажмите «Отказаться от этой отправки» и отправьте файл заново.', 410, 'EXPIRED', { unknown: true });
        }
        if (!sameFile(record, state.file)) throw new ChatError(`Выберите тот же файл (${record.name}, ${sizeText(record.size)}) и нажмите «Проверить и повторить ту же отправку».`, 0, 'RESELECT', { unknown: true });
        data = await chatFetch(`${uploadsPath(record.threadId)}/${record.uploadRef}/bytes`, { method: 'POST', body: state.file.file, write: true });
      }
      if (!fileReceiptOk(record, data)) throw new ChatError('Сервер не подтвердил файл в чате.', 200, 'RECEIPT', { unknown: true });
      clearRecord(record);
      outcome = { accepted: true, duplicate: data.duplicate === true };
    } catch (error) {
      if (!retry && error.refused && !record.uploadRef) {
        // Отказ подготовки (4xx до записи): файла на сервере нет — подпись остаётся в поле, файл выбран как был.
        clearRecord(record);
        outcome = { refused: true, error };
      } else {
        record.inFlight = false; record.unknown = true;
        writeRecord(record);
        outcome = { unknown: true, error };
      }
    } finally { state.sending = false; }
    renderComposer();
    if (epoch !== state.epoch) return;
    if (state.thread && state.thread.id === state.threadId) schedulePoll();
    const visible = state.threadId === record.threadId;
    if (outcome.accepted) {
      // Очищается только отправленное: подпись — если поле не меняли, файл — если выбран тот же.
      if (visible && $('pc-text').value === record.text) { $('pc-text').value = ''; forget(draftKey(record.threadId)); }
      else if (!visible) { const draft = readJson(draftKey(record.threadId)); if (draft && draft.text === record.text) forget(draftKey(record.threadId)); }
      if (sameFile(record, state.file)) clearFile();
      if (visible) { renderComposer(); sendState(outcome.duplicate ? 'Этот файл уже был сохранён раньше — повтор не создан.' : 'Файл сохранён в чате. Менеджер ответит здесь.', 'ok'); openThread(record.threadId, { quiet: true }); }
    } else if (outcome.refused) {
      if (visible) { renderComposer(); sendState(`Файл не отправлен: ${SEND_ERRORS[outcome.error.code] || outcome.error.message}`, 'error'); if (picker.input) picker.input.focus(); }
    } else if (visible) {
      sendState(outcome.error.code === 'RESELECT' || outcome.error.code === 'EXPIRED' || outcome.error.code === 'IN_PROGRESS' ? outcome.error.message
        : ['SIZE_MISMATCH', 'HASH_MISMATCH'].includes(outcome.error.code) ? `${outcome.error.message} Номер запроса сохранён.`
          : 'Не удалось подтвердить, сохранён ли файл. Нажмите «Проверить и повторить ту же отправку» — дубля не будет.', 'error');
    }
  }
  async function transmit(record) {
    const epoch = state.epoch;
    const retry = record.unknown === true;
    state.sending = true;
    record.inFlight = true;
    writeRecord(record);  // до запроса: перезагрузка или обрыв посреди отправки не теряют requestId
    renderComposer();
    sendState(retry ? 'Проверяем ту же отправку…' : 'Отправляем…', 'pending');
    let outcome;
    try {
      const data = await chat('message', { threadId: record.threadId, requestId: record.requestId, text: record.text }, { write: true });
      // Квитанция — только точная: тот же threadId и положительный message.id. Иначе исход неизвестен.
      if (data.threadId !== record.threadId || !data.message || typeof data.message !== 'object' || !positive(data.message.id)) {
        throw new ChatError('Сервер не подтвердил сообщение.', 200, 'RECEIPT', { unknown: true });
      }
      clearRecord(record);
      outcome = { accepted: true, duplicate: data.duplicate === true };
    } catch (error) {
      if (!retry && error.refused) {
        // Отказ первой попытки (4xx до записи): этот запрос не принят, текст возвращается в черновик своей заявки.
        clearRecord(record);
        writeJson(draftKey(record.threadId), { text: record.text, start: record.text.length, end: record.text.length });
        outcome = { refused: true, error };
      } else {
        record.inFlight = false; record.unknown = true;
        writeRecord(record);
        outcome = { unknown: true, error };
      }
    } finally { state.sending = false; }
    renderComposer();
    if (epoch !== state.epoch) return;
    // Repair P02: после любой развязки отправки открытый чат этой эпохи снова читается по своему циклу (без повтора записи).
    if (state.thread && state.thread.id === state.threadId) schedulePoll();
    const visible = state.threadId === record.threadId;
    if (outcome.accepted) {
      forget(draftKey(record.threadId));
      if (visible) { $('pc-text').value = ''; renderComposer(); sendState(outcome.duplicate ? 'Это сообщение уже было сохранено раньше — повтор не создан.' : 'Сохранено в чате. Менеджер ответит здесь.', 'ok'); openThread(record.threadId, { quiet: true }); }
    } else if (outcome.refused) {
      if (visible) { $('pc-text').value = record.text; renderComposer(); sendState(`Сообщение не отправлено: ${SEND_ERRORS[outcome.error.code] || outcome.error.message}`, 'error'); }
    } else if (visible) {
      sendState(retry ? `Повтор не подтверждён: ${outcome.error.message} Исход по-прежнему неизвестен — сообщение и номер запроса сохранены.`
        : 'Не удалось подтвердить, сохранено ли сообщение. Проверьте переписку и нажмите «Проверить и повторить ту же отправку» — дубля не будет.', 'error');
    }
  }
  $('pc-composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const g = gate();
    if (g.mode === 'blocked') { renderComposer(); sendState(BLOCKED_TEXT, 'error'); return; }
    if (g.mode === 'retry') { sendState(UNKNOWN_TEXT, 'error'); return; }  // «Отправить» не повторяет
    if (g.mode !== 'new') return;
    // Repair R1: файл ещё проверяется — подпись не отправляется обычным текстом, ждём готовности файла.
    if (preparingNow()) { sendState('Проверяем файл…', 'pending'); return; }
    const text = $('pc-text').value;
    // PHASEE: выбранный файл этого чата — отправка файла (подпись можно не писать); иначе — прежний текст.
    const selected = state.file && state.file.threadId === state.threadId && state.file.epoch === state.epoch ? state.file : null;
    if (selected && !state.uploadInfo) { sendState('Отправка файлов сейчас недоступна — уберите файл или отправьте текст позже.', 'error'); return; }
    const picked = selected;
    if (picked) {
      if (text.length > MAX) { sendState(SEND_ERRORS.TOO_LONG, 'error'); return; }
      transmitFile({ v: 1, type: 'file', threadId: state.threadId, requestId: uuid(), text, name: picked.name.slice(0, 180), size: picked.size,
        sha256: picked.sha256, unknown: false, inFlight: false });
      return;
    }
    if (!text.trim()) { sendState(SEND_ERRORS.EMPTY, 'error'); return; }
    if (text.length > MAX) { sendState(SEND_ERRORS.TOO_LONG, 'error'); return; }
    forget(draftKey(state.threadId));
    transmit({ v: 1, threadId: state.threadId, requestId: uuid(), text, unknown: false, inFlight: false });
  });
  $('pc-retry').addEventListener('click', () => {
    const g = gate();
    if (g.mode !== 'retry' || !g.record.unknown) return;
    if (g.record.type === 'file' && preparingNow()) { sendState('Проверяем файл…', 'pending'); return; }   // Repair R1
    if (g.record.type === 'file') transmitFile(g.record); else transmit(g.record);
  });
  $('pc-drop').addEventListener('click', () => {
    const record = state.pending;
    if (state.sending || !record || record.threadId !== state.threadId) return;
    clearRecord(record);
    // Подпись файла — это черновик поля: при отказе от файла он не стирается.
    if (record.type !== 'file') $('pc-text').value = '';
    renderComposer();
    sendState('Повтор снят. Если сервер уже принял первую отправку, сообщение всё равно останется в переписке — отменить его отсюда нельзя.');
    if (state.thread) openThread(state.threadId, { quiet: true });
  });
  $('pc-open-pending').addEventListener('click', () => { const record = state.pending; if (record) openThread(record.threadId, { focus: true }); });

  /* ---------- выход из чата на этом устройстве ---------- */
  $('pc-revoke').addEventListener('click', async () => {
    const button = $('pc-revoke');
    if (button.disabled || !state.csrf) return;
    if (state.pending) { say('Сначала проверьте неотправленное сообщение: пока его исход неизвестен, выход из чата отложен.', true); return; }
    // Repair I08: ответ относится только к эпохе, в которой нажата кнопка. Если за время запроса сессия закончилась и
    // открыта новая, поздний успех или отказ прежнего revoke ничего не меняет: ни экран, ни CSRF, ни кнопку новой сессии.
    const epoch = state.epoch;
    button.disabled = true;
    try {
      await chat('revoke', {});
    } catch (error) {
      if (epoch !== state.epoch) return;
      button.disabled = false;
      if (!(error.status === 401 && SESSION_LOST.has(error.code))) say(`Выйти не удалось: ${error.message}`, true);
      return;
    }
    if (epoch !== state.epoch) return;
    button.disabled = false;
    state.epoch += 1;
    state.csrf = '';
    hideMain();
    forget(LAST_KEY);
    say('Вы вышли из чата на этом устройстве. Прежняя переписка в этом браузере больше недоступна.');
    $('pc-restart-wrap').hidden = false;
  });

  boot();
})();
