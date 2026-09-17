(() => {
  "use strict";
  /* Хост Telegram Mini App для общего чата проекта. Сам чат — это тот же cabinet/project-chat.js,
     что и в кабинете; здесь только вход по подписи Telegram, узкая сессия участника, тема и
     размеры Telegram, экраны «откройте из Telegram», «код привязки» и «откройте заново».
     Токен живёт только в памяти этой страницы: не в cookie, не в адресе, не в разметке. */
  const tg = window.Telegram && window.Telegram.WebApp;
  const root = document.getElementById("miniapp");
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const views = {};
  const cabinet = window.SbCabinet = window.SbCabinet || {};
  cabinet.registerView = (name, definition) => { views[name] = definition; };
  const session = { token: null, companies: [], identity: null, company: null };
  const authHeaders = () => (session.token ? { Authorization: "Bearer " + session.token } : {});
  // Фото и PDF читаются тем же защищённым маршрутом, что и в кабинете, но с заголовком вместо cookie.
  // Заголовок уходит только на маршрут вложений открытого проекта на этом же домене; редиректы запрещены,
  // чтобы токен не утёк на другой адрес.
  const ASSET_PATH = /^\/content\/project-chat\/([a-z0-9_-]+)\/attachments\/\d+$/;
  const fetchAsset = async url => {
    let target;
    try { target = new URL(String(url), location.origin); } catch (_) { throw new Error("Файл недоступен"); }
    const match = target.pathname.match(ASSET_PATH);
    if (target.origin !== location.origin || !match || match[1] !== session.company || !session.token) throw new Error("Файл недоступен");
    const response = await fetch(target.href, { headers: authHeaders(), credentials: "omit", cache: "no-store", redirect: "error" });
    if (!response.ok) throw new Error("Файл недоступен");
    return response.blob();
  };
  const screen = html => { root.innerHTML = html; };
  const closeButton = () => (tg && typeof tg.close === "function" ? '<p><button type="button" class="ma-button" data-ma-close>Закрыть</button></p>' : "");
  const reopenScreen = message => `<section class="ma-screen"><h1>Чат проекта</h1><p>${escape(message)}</p><p class="ma-muted">Закройте это окно и снова откройте чат из Telegram — данные входа Telegram действуют только на одно открытие.</p>${closeButton()}</section>`;
  const outsideScreen = () => '<section class="ma-screen"><h1>Чат проекта</h1><p>Откройте чат проекта из Telegram: по ссылке или кнопке бота Synapse Business.</p><p class="ma-muted">В обычном браузере эта страница не работает — здесь нет данных Telegram, по которым сервер узнаёт участника.</p></section>';
  const unlinkedScreen = data => `<section class="ma-screen"><h1>Чат проекта</h1><p>Ваш Telegram ещё не привязан к аккаунту участника.</p><p>Сообщите владельцу проекта этот код:</p><p class="ma-code" aria-label="Код привязки">${escape(data.linkCode || "")}</p><p class="ma-muted">Код действует ${escape(minutesLeft(data.expiresAt))}. Владелец привязывает его в кабинете, в разделе «Участники». После привязки закройте это окно и откройте чат снова.</p>${closeButton()}</section>`;
  const noRoomsScreen = () => `<section class="ma-screen"><h1>Чат проекта</h1><p>Ваш Telegram привязан, но владелец ещё не добавил вас в участники чата проекта.</p><p class="ma-muted">Когда вас добавят, закройте это окно и откройте чат снова.</p>${closeButton()}</section>`;
  const noProjectScreen = () => `<section class="ma-screen"><h1>Чат проекта</h1><p>Откройте чат по ссылке своего проекта — её даёт владелец или она закреплена в группе проекта.</p><p class="ma-muted">Ссылка указывает проект, к которому вас привяжут. Без неё код привязки не выдаётся.</p>${closeButton()}</section>`;
  const notConfiguredScreen = () => `<section class="ma-screen"><h1>Чат проекта</h1><p>Вход в чат проекта из Telegram пока не включён.</p><p class="ma-muted">Пока чат доступен в кабинете Synapse Business.</p>${closeButton()}</section>`;
  const chooserScreen = () => `<section class="ma-screen"><h1>Выберите проект</h1><ul class="ma-list">${session.companies.map(company => `<li><button type="button" class="ma-button" data-ma-company="${escape(company.code)}">${escape(company.title)}</button></li>`).join("")}</ul></section>`;
  const minutesLeft = value => {
    const minutes = Math.round((Date.parse(value) - Date.now()) / 60000);
    return Number.isFinite(minutes) && minutes > 0 ? `ещё ${minutes} мин` : "недолго";
  };
  // Тема и размеры Telegram переводятся в переменные, которыми уже пользуется project-chat.css.
  const color = value => (/^#[0-9a-fA-F]{6}$/.test(String(value || "")) ? value : "");
  const setVar = (name, value) => { if (value) document.documentElement.style.setProperty(name, value); };
  const applyTheme = () => {
    const theme = (tg && tg.themeParams) || {};
    setVar("--surface", color(theme.bg_color));
    setVar("--surface-soft", color(theme.secondary_bg_color));
    setVar("--text", color(theme.text_color));
    setVar("--muted", color(theme.hint_color));
    setVar("--accent", color(theme.button_color) || color(theme.link_color));
    setVar("--line", color(theme.section_separator_color) || color(theme.hint_color));
    document.documentElement.dataset.theme = tg && tg.colorScheme === "dark" ? "dark" : "light";
  };
  const applyViewport = () => {
    const height = (tg && Number(tg.viewportStableHeight)) || window.innerHeight;
    if (height > 0) setVar("--ma-viewport", `${Math.round(height)}px`);
    const safe = (tg && tg.safeAreaInset) || {}, content = (tg && tg.contentSafeAreaInset) || {};
    for (const side of ["top", "right", "bottom", "left"]) {
      setVar(`--ma-safe-${side}`, `${Math.max(0, Number(safe[side]) || 0) + Math.max(0, Number(content[side]) || 0)}px`);
    }
  };
  let back = null;
  const showBack = handler => { back = handler; if (tg && tg.BackButton) tg.BackButton.show(); };
  const hideBack = () => { back = null; if (tg && tg.BackButton) tg.BackButton.hide(); };
  const context = () => ({
    identity: { role: "member", userId: session.identity.userId, csrfToken: "", displayName: session.identity.displayName, permissions: [],
      companies: session.companies.map(company => ({ id: company.code, name: company.title })) },
    get selectedProjectId() { return session.company; },
    get currentView() { return "hugh"; },
    byId: id => document.getElementById(id),
    escapeHTML: escape,
    authHeaders, fetchAsset,
    // Отозванный доступ или истёкшая сессия: токен забывается, показывается экран повторного открытия.
    onRevoked: message => { session.token = null; session.company = null; hideBack(); leaveRoom(); screen(reopenScreen(message)); }
  });
  // Уход из комнаты освобождает её вид целиком: опрос, blob-адреса файлов, диалоги, поздние ответы.
  const leaveRoom = () => { if (views.hugh && typeof views.hugh.unmount === "function") views.hugh.unmount(); };
  const open = async code => {
    session.company = code;
    screen('<section id="hugh-view" class="ma-room"></section>');
    if (session.companies.length > 1) showBack(() => { session.company = null; hideBack(); leaveRoom(); screen(chooserScreen()); });
    else hideBack();
    if (!views.hugh) { screen(reopenScreen("Чат не загрузился.")); return; }
    await views.hugh.render(root.querySelector("#hugh-view"), context());
  };
  const start = async () => {
    if (!tg || typeof tg.initData !== "string" || !tg.initData) { screen(outsideScreen()); return; }
    if (typeof tg.ready === "function") tg.ready();
    if (typeof tg.expand === "function") tg.expand();
    applyTheme(); applyViewport();
    if (typeof tg.onEvent === "function") {
      tg.onEvent("themeChanged", applyTheme);
      tg.onEvent("viewportChanged", applyViewport);
      tg.onEvent("safeAreaChanged", applyViewport);
      tg.onEvent("contentSafeAreaChanged", applyViewport);
    }
    if (tg.BackButton && typeof tg.BackButton.onClick === "function") tg.BackButton.onClick(() => { if (back) back(); });
    screen('<section class="ma-screen"><p class="ma-muted">Проверяем доступ…</p></section>');
    // Проект сервер читает из подписанного start_param внутри initData; незаверенные подсказки не отправляются.
    let response, data;
    try {
      response = await fetch("/content/project-chat-miniapp/session", { method: "POST", credentials: "omit", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: tg.initData }) });
      data = await response.json().catch(() => ({}));
    } catch (_) {
      screen(reopenScreen("Не удалось связаться с сервером."));
      return;
    }
    if (response.status === 200 && data.token) {
      session.token = data.token;
      session.companies = Array.isArray(data.companies) ? data.companies : [];
      session.identity = data.identity || { userId: 0, displayName: "Участник" };
      const hinted = session.companies.find(company => company.code === data.startParam);
      if (session.companies.length === 1 || hinted) await open((hinted || session.companies[0]).code);
      else if (session.companies.length) screen(chooserScreen());
      else screen(noRoomsScreen());
      return;
    }
    if (response.status === 403 && data.state === "unlinked") { screen(unlinkedScreen(data)); return; }
    if (response.status === 403 && data.state === "no_rooms") { screen(noRoomsScreen()); return; }
    if (response.status === 403 && data.state === "no_project") { screen(noProjectScreen()); return; }
    if (response.status === 503) { screen(notConfiguredScreen()); return; }
    if (response.status === 429) { screen(reopenScreen("Слишком много попыток входа. Подождите несколько минут.")); return; }
    // 401/409 и всё остальное: данные входа устарели или уже использованы — нужен новый запуск из Telegram.
    screen(reopenScreen(data.state === "replayed" ? "Эти данные входа уже использованы." : "Сессия чата истекла."));
  };
  root.addEventListener("click", event => {
    const button = event.target.closest("button[data-ma-close],button[data-ma-company]");
    if (!button) return;
    if (button.dataset.maClose !== undefined) { if (tg && typeof tg.close === "function") tg.close(); return; }
    if (button.dataset.maCompany && session.companies.some(company => company.code === button.dataset.maCompany)) open(button.dataset.maCompany);
  });
  cabinet.miniAppHost = { start };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { start(); });
  else start();
})();
