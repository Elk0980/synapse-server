/*
 * Palitra Love — защищённый вход в приложение (Telegram Mini App или аккаунт сайта).
 * Токен сессии живёт только в замыкании этого модуля: не в URL, не в localStorage/sessionStorage.
 * Telegram: подписанное initData обменивается один раз за открытие, без автоматических повторов;
 *   initDataUnsafe и параметры адреса не читаются — личность определяет только сервер по подписи.
 * Сайт: сервер сам проверяет cookie аккаунта и CSRF; страница отправляет пустое тело и не передаёт личность.
 */
'use strict';

(() => {
  const AUTH = document.documentElement.dataset.auth === 'site' ? 'site' : 'telegram';
  const EXCHANGE_PATH = AUTH === 'site' ? '/api/crm/session/site' : '/api/crm/session/telegram';
  const TOKEN_RE = /^pcrm\.[A-Za-z0-9_-]{43}$/;
  const METHODS = ['GET', 'POST', 'PUT'];
  // Только внутренние пути приложения (/api/<путь> → /api/crm/<путь>); остальное отклоняется до сети.
  const ROUTES = [
    /^\/bootstrap$/,
    /^\/summary$/,
    /^\/price$/,
    /^\/settings\/email$/,
    /^\/orders$/,
    /^\/inquiries$/,
    /^\/(?:orders|inquiries)\/[1-9]\d{0,14}(?:\/action)?$/,
    /^\/customers\/[1-9]\d{0,14}$/,
  ];

  const MSG = {
    noTelegram: 'Откройте приложение через бот Palitra.',
    reopen: AUTH === 'site'
      ? 'Не удалось подтвердить вход. Обновите страницу или войдите в аккаунт сайта заново.'
      : 'Не удалось подтвердить вход. Закройте приложение и откройте его заново через бот Palitra.',
    denied: 'Доступ закрыт. Если это ошибка, напишите администратору Palitra.',
    ended: AUTH === 'site'
      ? 'Сессия завершена. Обновите страницу или войдите в аккаунт сайта заново.'
      : 'Сессия завершена. Закройте приложение и откройте его заново через бот Palitra.',
    network: 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.',
    unreadable: 'Ответ сервера не удалось прочитать. Проверьте результат перед повтором.',
    endedUnknown: 'Сессия завершилась, пока сохранялись данные. Откройте приложение заново и нажмите «Проверить сохранение».',
    badPath: 'Действие недоступно в приложении.',
  };

  class SessionError extends Error {
    constructor(message, status, code) {
      super(message);
      this.name = 'SessionError';
      this.status = status;
      this.code = code;
    }
  }

  let token = null;
  let ended = false;
  let readyPromise = null;

  function webApp() {
    const tg = window.Telegram;
    return tg && tg.WebApp ? tg.WebApp : null;
  }

  // Сессия больше недействительна: токен уничтожен, диалоги закрыты, приложение само стирает данные.
  function end() {
    token = null;
    if (ended) return;
    ended = true;
    for (const d of document.querySelectorAll('dialog[open]')) {
      try { d.close(); } catch (_) { /* диалог уже закрыт */ }
    }
    window.dispatchEvent(new CustomEvent('palitra:session-ended'));
  }

  async function readJson(res) {
    try { return await res.json(); } catch (_) { return null; }
  }

  // PALITRA-CRM: CSRF исходной сессии сайта — штатный маршрут того же адреса: аккаунт магазина
  // (GET /api/draft-account/session, только с вошедшим покупателем) или кабинет Synapse (GET /content/whoami).
  // Личность по-прежнему определяет сервер по cookie; страница передаёт лишь CSRF той же сессии.
  async function siteCsrf() {
    for (const path of ['/api/draft-account/session', '/content/whoami']) {
      let res;
      try {
        res = await fetch(path, { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      } catch (_) { continue; }
      if (!res.ok) continue;
      const data = await readJson(res);
      if (path === '/api/draft-account/session' && data && data.user && typeof data.csrf === 'string' && data.csrf) return data.csrf;
      if (path === '/content/whoami' && data && typeof data.csrfToken === 'string' && data.csrfToken) return data.csrfToken;
    }
    return '';
  }

  async function exchange() {
    let body;
    let app = null;
    let csrf = '';
    if (AUTH === 'telegram') {
      app = webApp();
      const initData = app && typeof app.initData === 'string' ? app.initData : '';
      if (!initData) {
        ended = true;
        throw new SessionError(MSG.noTelegram, 401, 'no_telegram');
      }
      body = { initData };
    } else {
      body = {};
      // PALITRA-CRM: сервер принимает обмен сайта только с CSRF исходной сессии (аккаунт магазина или кабинет Synapse).
      csrf = await siteCsrf();
      if (!csrf) {
        ended = true;
        throw new SessionError(MSG.reopen, 401, 'reopen');
      }
    }
    let res;
    try {
      res = await fetch(EXCHANGE_PATH, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
        body: JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
      });
    } catch (_) {
      // Исход неизвестен: initData могло быть уже израсходовано, повтор не делаем.
      ended = true;
      throw new SessionError(MSG.reopen, 0, 'reopen');
    }
    const data = await readJson(res);
    const value = res.ok && data && typeof data.token === 'string' ? data.token : '';
    if (!TOKEN_RE.test(value)) {
      ended = true;
      throw new SessionError(res.status === 403 ? MSG.denied : MSG.reopen, res.status || 401, res.status === 403 ? 'denied' : 'reopen');
    }
    token = value;
    if (app) {
      try { app.ready(); app.expand(); } catch (_) { /* старый клиент Telegram — приложение работает и без этого */ }
    }
  }

  function ready() {
    if (!readyPromise) readyPromise = exchange();
    return readyPromise;
  }

  function mapPath(path) {
    if (typeof path !== 'string' || !path.startsWith('/api/')) return null;
    const rest = path.slice(4);
    return ROUTES.some((re) => re.test(rest)) ? `/api/crm${rest}` : null;
  }

  async function request(path, { method = 'GET', body } = {}) {
    const url = mapPath(path);
    if (!url || !METHODS.includes(method)) throw new SessionError(MSG.badPath, 404, 'bad_path');
    if (ended && !token) throw new SessionError(MSG.ended, 401, 'ended');
    await ready();
    if (!token) throw new SessionError(MSG.ended, 401, 'ended');
    const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
      });
    } catch (_) {
      throw new SessionError(MSG.network, 0, 'network');
    }
    // Сервер сам отклонил ЭТОТ запрос входом — подтверждённый отказ: действие не выполнено.
    if (res.status === 401) {
      end();
      throw new SessionError(MSG.ended, 401, 'ended');
    }
    // Изменение уже ушло на сервер и не было им отклонено. Если сессию тем временем завершил ДРУГОЙ запрос,
    // результат этой записи неизвестен (могла выполниться): приложение сохраняет то же тело и requestId,
    // данные ответа после выхода не отдаются. Для чтения (GET) — прежнее «сессия завершена».
    const endedMeanwhile = () => (method === 'GET'
      ? new SessionError(MSG.ended, 401, 'ended')
      : new SessionError(MSG.endedUnknown, 0, 'ended_unknown'));
    const data = await readJson(res);
    // Успешный статус без читаемого JSON: запись могла выполниться — для приложения это неизвестный исход
    // (оно сохранит то же тело и requestId), а не подтверждённый отказ.
    if (res.ok && (!data || typeof data !== 'object')) {
      if (ended || !token) throw endedMeanwhile();
      throw new SessionError(MSG.unreadable, res.status, 'unreadable');
    }
    if (!res.ok || !data || data.error) {
      // Текст ошибки — только короткая строка сервера; пустой текст приложение заменит своим.
      const message = data && typeof data.error === 'string' && data.error.length <= 300 ? data.error : '';
      const code = data && typeof data.code === 'string' && /^[A-Z_]{2,32}$/.test(data.code) ? data.code : 'failed';
      throw new SessionError(message, res.status, code);
    }
    // Другой запрос мог получить 401, пока этот ответ ещё шёл: данные не отдаются, запись — неизвестный исход.
    if (ended || !token) throw endedMeanwhile();
    return data;
  }

  Object.defineProperty(window, 'PalitraSession', {
    value: Object.freeze({ ready, request, auth: AUTH }),
    writable: false,
    configurable: false,
  });
})();
