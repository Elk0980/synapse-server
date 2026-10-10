/*
 * Palitra — тестовый просмотр внутри Telegram. Подключается ДО app.js.
 * 1) Оформление Mini App через официальный SDK: ready/expand, светлые цвета шапки и фона.
 *    initData и сведения о пользователе Telegram НЕ читаются и никуда не отправляются.
 * 2) Сброс тестовой сессии: сервер помечает ответы заголовком X-Preview-Session. После «reset» (или «new», когда
 *    сессия уже была — браузер не хранит cookie) база на сервере уже другая, а в памяти app.js остались прежние
 *    карточки, версии и черновики. Поэтому ЛЮБОЕ изменение через /api/ блокируется здесь, до сети, пока страница не
 *    перезагружена кнопкой «Начать заново». Чтение остаётся. Изменения ждут завершения уже начатых запросов к API,
 *    чтобы признак сброса из них был учтён раньше, чем уйдёт следующее изменение.
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
  const banner = document.getElementById('previewBanner');
  let seenSession = false;
  let locked = null; // null | 'reset' | 'cookie'
  const pending = new Set();

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
    p.textContent = kind === 'cookie'
      ? 'Тестовая сессия не сохраняется: браузер не принимает её cookie. Изменения отключены — нажмите «Начать заново».'
      : 'Тестовая сессия сброшена: сервер просмотра перезапустился, вымышленные данные начаты заново. Прежние изменения не сохранились, новые отключены до перезагрузки — нажмите «Начать заново». Это не CRM.';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-secondary';
    button.id = 'previewRestart';
    button.textContent = 'Начать заново';
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
    return { api: url.origin === window.location.origin && url.pathname.startsWith('/api/'), mutation: !['GET', 'HEAD'].includes(method) };
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
      if (locked) return refused('PREVIEW_RESET', 'Тестовая сессия сброшена — действие не отправлено. Нажмите «Начать заново».');
    }
    let release;
    const tracked = new Promise((resolve) => { release = resolve; });
    pending.add(tracked);
    try {
      const res = await originalFetch(input, init);
      const state = res.headers && typeof res.headers.get === 'function' ? res.headers.get('X-Preview-Session') : null;
      if (state === 'reset') lock('reset');
      else if (state === 'new' && seenSession) lock('cookie');
      if (state) seenSession = true;
      return res;
    } finally {
      pending.delete(tracked);
      release();
    }
  };
})();
