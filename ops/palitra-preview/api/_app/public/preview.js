/*
 * Palitra — тестовый просмотр внутри Telegram. Подключается ДО app.js.
 * 1) Оформление Mini App через официальный SDK: ready/expand, светлые цвета шапки и фона.
 *    initData и сведения о пользователе Telegram НЕ читаются и никуда не отправляются.
 * 2) Сброс тестовой сессии: сервер помечает ответы заголовком X-Preview-Session. После «reset» (или «new», когда
 *    сессия уже была — браузер не хранит cookie) база на сервере уже другая, а в памяти app.js остались прежние
 *    карточки, версии и черновики. Поэтому ЛЮБОЕ изменение через /api/ блокируется здесь, до сети, пока страница не
 *    перезагружена кнопкой «Начать заново». Чтение остаётся. Изменения ждут завершения уже начатых запросов к API,
 *    чтобы признак сброса из них был учтён раньше, чем уйдёт следующее изменение.
 * 3) Поколение базы (X-Preview-Context): запоминается из первого ответа и отправляется с каждым запросом к /api/.
 *    Другое поколение в ответе, X-Preview-Session: switched (тест переключён) или переключение без прочитанного
 *    ответа блокируют изменения так же, до перезагрузки. Повторной отправки переключения нет.
 */
'use strict';

(() => {
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  if (tg) {
    document.documentElement.classList.add('in-telegram');
    const call = (name, ...args) => { try { if (typeof tg[name] === 'function') tg[name](...args); } catch (_) { /* старый клиент Telegram */ } };
    call('ready');
    call('expand');
    call('setHeaderColor', '#F6F1E7');
    call('setBackgroundColor', '#F6F1E7');
    call('setBottomBarColor', '#F6F1E7');
  }

  const WAIT_MS = 10000; // сколько изменение ждёт уже начатые запросы; дольше — отказ с просьбой повторить
  const CONTEXT_KEY = 'palitra-preview-context-v1';
  const banner = document.getElementById('previewBanner');
  let seenSession = false;
  let locked = null; // null | 'reset' | 'cookie' | 'switched' | 'unknown' | 'context'
  // Поколение базы этой страницы (X-Preview-Context из первого ответа). Присылается в каждом запросе к /api/:
  // если cookie уже указывает на другую базу (новый тест в другой вкладке, потерянный ответ о переключении), сервер
  // отвечает 423 и ничего не меняет, а страница блокирует действия до осознанной перезагрузки.
  let expected = null;
  const pending = new Set();
  const LOCK = {
    reset: ['PREVIEW_RESET', 'Тестовая сессия сброшена: сервер просмотра перезапустился, вымышленные данные начаты заново. Прежние изменения не сохранились, новые отключены до перезагрузки — нажмите «Начать заново». Это не CRM.', 'Начать заново'],
    cookie: ['PREVIEW_RESET', 'Тестовая сессия не сохраняется: браузер не принимает её cookie. Изменения отключены — нажмите «Начать заново».', 'Начать заново'],
    switched: ['PREVIEW_SWITCHED', 'Тест переключён. Прежние действия этой страницы отключены — нажмите «Обновить страницу».', 'Обновить страницу'],
    unknown: ['PREVIEW_SWITCHED', 'Результат переключения теста не подтверждён: ответ сервера не дошёл. Действия отключены, повторной отправки не будет. Нажмите «Обновить страницу» — приложение покажет текущее состояние.', 'Обновить страницу'],
    context: ['PREVIEW_CONTEXT_CHANGED', 'Эта страница относится к другой тестовой базе: тест переключили в другой вкладке или ответ о переключении не дошёл. Действия отключены — нажмите «Обновить страницу».', 'Обновить страницу']
  };

  function forgetUnsent() {
    // Неподтверждённые попытки относились к прежней тестовой базе — в новой их проверять нельзя.
    try {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const key = sessionStorage.key(i);
        if (key && key.startsWith('palitra-unsent:')) sessionStorage.removeItem(key);
      }
    } catch (_) { /* хранилище недоступно */ }
  }
  function lock(kind) {
    if (locked) return;
    locked = kind;
    forgetUnsent();
    if (!banner) return;
    const p = document.createElement('p');
    p.textContent = LOCK[kind][1];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-secondary';
    button.id = 'previewRestart';
    button.textContent = LOCK[kind][2];
    button.addEventListener('click', () => window.location.reload());
    banner.replaceChildren(p, button);
    banner.hidden = false;
  }
  function refused(code, message) {
    return new Response(JSON.stringify({ error: message, code }), {
      status: 423, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Preview-Session': 'blocked' }
    });
  }
  function target(input, init) {
    const url = new URL(typeof input === 'string' ? input : input && input.url ? input.url : String(input), window.location.href);
    const method = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
    const api = url.origin === window.location.origin && url.pathname.startsWith('/api/');
    return { api, mutation: !['GET', 'HEAD'].includes(method), lifecycle: api && url.pathname === '/api/draft-test' && method === 'POST' };
  }
  /** Тот же запрос с поколением базы этой страницы (только для адресов-строк; тело и остальное не меняются). */
  function withContext(input, init) {
    if (!expected || (typeof input !== 'string' && !(input instanceof URL))) return init;
    const base = init && init.headers;
    const headers = {};
    if (base && typeof base.forEach === 'function') base.forEach((value, key) => { headers[key] = value; });
    else if (base && typeof base === 'object') Object.assign(headers, base);
    headers['X-Preview-Context'] = expected;
    return { ...(init || {}), headers };
  }
  function learn(generation) {
    if (!generation) return;
    if (expected === null) {
      expected = generation;
      // Неподтверждённые попытки из другой базы (прошлый тест в этой вкладке) нельзя проверять в этой.
      try {
        const prior = sessionStorage.getItem(CONTEXT_KEY);
        if (prior && prior !== generation) forgetUnsent();
        sessionStorage.setItem(CONTEXT_KEY, generation);
      } catch (_) { /* хранилище недоступно */ }
    } else if (generation !== expected) lock('context');
  }
  function settleAll() {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), WAIT_MS); });
    return Promise.race([Promise.allSettled([...pending]).then(() => true), timeout]).finally(() => clearTimeout(timer));
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const t = target(input, init);
    if (!t.api) return originalFetch(input, init);
    if (t.mutation) {
      if (pending.size && !(await settleAll())) {
        return refused('PREVIEW_BUSY', 'Данные ещё загружаются. Подождите и повторите — действие не отправлено.');
      }
      if (locked) {
        return locked === 'reset' || locked === 'cookie'
          ? refused('PREVIEW_RESET', 'Тестовая сессия сброшена — действие не отправлено. Нажмите «Начать заново».')
          : refused(LOCK[locked][0], 'Тест переключён или его состояние не подтверждено — действие не отправлено. Нажмите «Обновить страницу».');
      }
    }
    let release;
    const tracked = new Promise((resolve) => { release = resolve; });
    pending.add(tracked);
    try {
      let res;
      try { res = await originalFetch(input, withContext(input, init)); }
      catch (error) {
        // Переключение теста без ответа: исход неизвестен — старые действия блокируются, повтора нет.
        if (t.lifecycle) lock('unknown');
        throw error;
      }
      const get = (name) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null);
      const state = get('X-Preview-Session');
      if (state === 'reset') lock('reset');
      else if (state === 'new' && seenSession) lock('cookie');
      else if (state === 'switched') lock('switched');
      else if (t.lifecycle && !(res.status >= 400 && res.status < 500)) lock('unknown');
      if (state) seenSession = true;
      learn(get('X-Preview-Context'));
      return res;
    } finally {
      pending.delete(tracked);
      release();
    }
  };
})();
