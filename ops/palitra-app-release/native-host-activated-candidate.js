/* Palitra Love Заказы — хост рабочего подключения к существующему Synapse (подготовлен, не включён).

   Открывается только на разрешённых адресах: кабинет https://synapse.synapsebusiness.ru (whoami cookie + CSRF)
   и магазин https://palitra-love.ru (сессия аккаунта /api/draft-account/session, portal через штатный crm-session.js,
   чат сайта /api/customer-chat/*). Новой авторизации нет: только существующие относительные маршруты моста.

   ФЛАГИ ВЫКЛЮЧЕНЫ. Сеть, CRM и чат сайта E/R1 включает Root правкой этого файла в проверенном выпуске после native-proof
   (свободное окно общего сервера, origin/CSP, PALITRA_APP_ORIGIN). Адрес, роль, localStorage и данные макета флаги
   не меняют. Пока network=false, транспорт отказывает до fetch, и оболочка показывает «подключение выключено».
   CSRF/токены живут только в замыкании этого файла и в штатном crm-session.js; в state оболочки, URL и манифест не идут. */
'use strict';
(() => {
  const B = window.SynapseBridge;
  const FLAGS = Object.freeze({ network: true, crm: true, e1Native: true });
  const CABINET = B.ORIGINS.synapse, SHOP = B.ORIGINS.shop;
  const origin = window.location.origin;
  /* Точка входа задаётся страницей: shop.html (data-entry="shop", data-auth="site", штатный crm-session.js до этого файла)
     или cabinet.html (data-entry="cabinet", без инициализации магазина). Страница работает только на «своём» адресе. */
  const root = document.documentElement;
  const entry = root.dataset.entry === 'shop' || root.dataset.entry === 'cabinet' ? root.dataset.entry : '';
  const allowed = (entry === 'cabinet' && origin === CABINET) || (entry === 'shop' && origin === SHOP && root.dataset.auth === 'site');
  let cabinetCsrf = '', accountCsrf = '', chatCsrf = '';
  const listeners = [];
  let host;
  if (!allowed) {
    // Чужой адрес (в том числе localhost/127.0.0.1) или страница другого входа: транспорта нет — «Подключение не настроено».
    host = { mode: 'blocked', reason: entry ? 'origin' : 'entry' };
  } else {
    // Штатный crm-session.js — только на входе магазина и только в режиме сайта (cookie аккаунта + CSRF, не Telegram).
    const session = entry === 'shop' && window.PalitraSession && window.PalitraSession.auth === 'site' && typeof window.PalitraSession.request === 'function' ? window.PalitraSession : null;
    const transport = B.createNativeTransport({
      // fetch внедряется только здесь, на разрешённом адресе; мост сам глобальный fetch не трогает.
      fetch: (url, init) => window.fetch(url, init),
      host: {
        origin, portalOrigin: SHOP, allowNetwork: FLAGS.network, e1Native: FLAGS.e1Native,
        cabinet: { get csrfToken() { return cabinetCsrf; } },
        account: { get csrf() { return accountCsrf; } },
        chat: { get csrf() { return chatCsrf; } },
        portal: FLAGS.crm && session ? { request: (path, options) => session.request(path, options) } : null,
      },
    });
    host = {
      mode: 'native', verified: true, origin, transport, e1Native: FLAGS.e1Native,
      // Автоперечитывание открытого чата (5 с) — только при включённых сети и чате сайта E/R1.
      chatAutoRefresh: FLAGS.network === true && FLAGS.e1Native === true,
      // Только наличие сессий своего адреса; роли и identity оболочка берёт из ответов whoami/bootstrap.
      getAuthContext: () => (entry === 'cabinet' ? { cabinetSession: true } : { shopSession: true, guest: true, portalAvailable: FLAGS.crm && Boolean(session) }),
      acceptCabinetCsrf: (value) => { cabinetCsrf = typeof value === 'string' ? value : ''; },
      acceptAccountCsrf: (value) => { accountCsrf = typeof value === 'string' ? value : ''; },
      acceptChatSession: (value) => { chatCsrf = typeof value === 'string' ? value : ''; },
      onAuthChange: (fn) => { if (typeof fn === 'function') listeners.push(fn); },
    };
    // Штатное событие завершения portal-сессии (crm-session.js) — смена identity: прежние данные и CSRF очищаются.
    window.addEventListener('palitra:session-ended', () => { cabinetCsrf = ''; accountCsrf = ''; chatCsrf = ''; for (const fn of listeners) fn(); });
  }
  Object.defineProperty(window, 'PalitraShellHost', { value: Object.freeze(host), writable: false, configurable: false });
})();
