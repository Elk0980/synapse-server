/* Palitra Love Заказы — мобильная оболочка поверх существующих контрактов Synapse (14.10.2026).
   Экраны, подписи и порядок блоков — из снимка макета (PALITRA_DESIGN, только оформление/навигация). Данные — только
   через SynapseBridge и внедрённый host: в локальном предпросмотре это in-memory mock (index.html). Оболочка сама не
   создаёт native-транспорт, не читает fetch, не держит БД/таймеров/опроса. Роль экранов выводится из ответов
   backend (whoami / portal actor); переключатель «Предпросмотр» есть только у mock-хоста и выбирает набор fixture. */
'use strict';

(() => {
  const B = window.SynapseBridge, DESIGN = window.PALITRA_DESIGN, HOST = window.PalitraShellHost;
  const $ = (id) => document.getElementById(id);
  const ui = { header: $('header'), body: $('body'), overlay: $('overlay'), toast: $('toast') };
  /* Меню ролей. Источник — визуальная модель редактора: project.menus[role] (после явной правки меню), иначе
     прежние стандартные пункты с frame.menuVisible/menuLabel/menuOrder — та же формула, что в редакторе
     (LOCAL_BOARD/dist/app.js defaultMenuItems/effectiveMenu/visibleMenuItems). Пункт меню — только навигация:
     цель обязана быть существующей нескрытой страницей той же роли; доступ к экрану ограничивают права backend. */
  const DEFAULT_MENU = {
    client: [['Каталог', 'K02'], ['Ваши заказы', 'K04'], ['Оставить отзыв', 'K08']],
    staff: [['Фото', 'S06'], ['Каталог редактор', 'S07'], ['Заказы', 'S02']],
    admin: [['Фото', 'A06'], ['Каталог редактор', 'A07'], ['Заказы', 'A02'], ['Отчёты', 'A08']],
  };
  const MENU_HOME = { client: 'K01', staff: 'S01', admin: 'A01' };
  const MENU_HOME_LABEL = { client: 'Главная', staff: 'Главное меню', admin: 'Главное меню' };
  const ROLE_LABEL = { client: 'Клиент', staff: 'Сотрудник', admin: 'Админ' };
  const MENU_TITLE = { client: 'Пользователь', staff: 'Сотрудник', admin: 'Админ' };
  const FORM_CHANNELS = [['telegram', 'Telegram', 'text', 'Номер телефона или @никнейм'], ['whatsapp', 'WhatsApp', 'tel', 'Номер телефона'], ['max', 'MAX', 'text', 'Номер или ссылка MAX'],
    ['call', 'Звонок', 'tel', 'Номер телефона'], ['vk', 'ВКонтакте', 'text', 'Ссылка или имя профиля']];
  const CHANNEL_LABEL = { telegram: 'Telegram', telegram_id: 'Telegram', whatsapp: 'WhatsApp', max: 'MAX', phone: 'Телефон', call: 'Звонок', vk: 'ВКонтакте', instagram: 'Instagram' };
  const PROOF_LABEL = { 'installed-read': 'установлено ранее (чтение подтверждено)', 'accepted-local': 'принято локально, native0', 'reviewed-not-enabled': 'проверено, включение не подтверждено' };

  /* ---------- DOM ---------- */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = String(value);
      else if (key === 'value') el.value = String(value);
      else if (key === 'checked' || key === 'disabled' || key === 'readOnly' || key === 'selected') el[key] = Boolean(value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  function icon(d, size = 20) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' })) el.setAttribute(k, String(v));
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    for (const [k, v] of Object.entries({ d, fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) p.setAttribute(k, v);
    el.append(p);
    return el;
  }
  const chevron = () => { const el = icon('M6 9l6 6 6-6'); el.classList.add('chev'); return el; };
  let toastTimer = 0;
  function toast(text) { ui.toast.textContent = text; ui.toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 3600); }
  const str = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}` : ''; };

  /* ---------- макет ---------- */
  const frames = () => { const existing = DESIGN ? DESIGN.frames : []; return existing.some((f) => f.id === 'A10') ? existing : [...existing, { id: 'A10', role: 'admin', kind: 'workflow', device: 'phone', title: 'Автоответ и этапы', blocks: [] }]; };
  const frameById = (id) => frames().find((f) => f.id === id) || null;
  const blocks = (frame, type) => (frame ? frame.blocks.filter((b) => !type || b.type === type) : []);
  const mobileFrame = (role, kind) => frames().find((f) => f.role === role && f.kind === kind && f.device !== 'desktop') || null;
  function ordersFrames(role) { const a = mobileFrame(role, 'orders'); const t = a && a.orderTabs; return t ? { active: frameById(t.active), history: frameById(t.history) } : { active: a, history: mobileFrame(role, 'history') }; }
  const FONT = { system: "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif", inter: "'Inter', system-ui, sans-serif", roboto: "'Roboto', system-ui, sans-serif",
    'open-sans': "'Open Sans', system-ui, sans-serif", montserrat: "'Montserrat', system-ui, sans-serif", 'nunito-sans': "'Nunito Sans', system-ui, sans-serif", lora: "'Lora', Georgia, serif" };
  // Оформление текста — только allowlist редактора: шрифт из списка, размер 10–72, B/I/U, выравнивание, #rrggbb, интервал 1–2.5.
  function applyStyle(s, el) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return el;
    if (Object.prototype.hasOwnProperty.call(FONT, s.font)) el.style.fontFamily = FONT[s.font];
    if (Number.isFinite(s.size) && s.size >= 10 && s.size <= 72) el.style.fontSize = `${Math.round(s.size)}px`;
    if (typeof s.bold === 'boolean') el.style.fontWeight = s.bold ? '700' : '400';
    if (typeof s.italic === 'boolean') el.style.fontStyle = s.italic ? 'italic' : 'normal';
    if (typeof s.underline === 'boolean') el.style.textDecoration = s.underline ? 'underline' : 'none';
    if (['left', 'center', 'right', 'justify'].includes(s.align)) el.style.textAlign = s.align;
    if (typeof s.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.color)) el.style.color = s.color;
    if (Number.isFinite(s.lineHeight) && s.lineHeight >= 1 && s.lineHeight <= 2.5) el.style.lineHeight = String(s.lineHeight);
    return el;
  }
  const styleOf = (holder, field) => (holder && holder.textStyles && typeof holder.textStyles === 'object' && Object.prototype.hasOwnProperty.call(holder.textStyles, field) ? holder.textStyles[field] : null);
  /* ---------- меню из модели ---------- */
  const visibleFrame = (id, role) => { const f = typeof id === 'string' ? frameById(id) : null; return f && f.role === role && f.hidden !== true && f.device !== 'desktop' ? f : null; };
  function defaultMenuItems(role) {
    const defaults = [...(frameById(MENU_HOME[role]) ? [[MENU_HOME_LABEL[role], MENU_HOME[role]]] : []), ...(DEFAULT_MENU[role] || [])];
    const items = defaults.filter(([, id]) => { const f = visibleFrame(id, role); return f && f.menuVisible !== false; });
    for (const f of frames()) if (f.role === role && f.hidden !== true && f.menuVisible === true && !items.some(([, id]) => id === f.id)) items.push([f.title, f.id]);
    const rank = (entry) => (Number.isFinite(frameById(entry[1]).menuOrder) ? frameById(entry[1]).menuOrder : items.findIndex(([, id]) => id === entry[1]));
    return items.map(([label, id]) => [typeof frameById(id).menuLabel === 'string' ? frameById(id).menuLabel : label, id]).sort((a, b) => rank(a) - rank(b));
  }
  function effectiveMenu(role) {
    const menus = DESIGN && DESIGN.menus && typeof DESIGN.menus === 'object' ? DESIGN.menus : null;
    const stored = menus && Object.prototype.hasOwnProperty.call(menus, role) ? menus[role] : null;
    if (stored && typeof stored === 'object' && !Array.isArray(stored) && Array.isArray(stored.items)) return { explicit: true, menu: stored };
    return { explicit: false, menu: { id: `menu:${role}`, type: 'menu', title: MENU_TITLE[role], items: defaultMenuItems(role).map(([label, target]) => ({ id: `menu:${role}:${target}`, label, target, hidden: false })) } };
  }
  // Видимые пункты: стабильный строковый id без повторов, не скрыт, цель — нескрытая страница той же роли.
  function visibleMenuItems(role) {
    const seen = new Set();
    return effectiveMenu(role).menu.items.filter((item) => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || seen.has(item.id) || item.hidden === true) return false;
      if (!visibleFrame(item.target, role)) return false;
      seen.add(item.id);
      return true;
    });
  }
  function homeFrame(role) {
    if (visibleFrame(MENU_HOME[role], role)) return MENU_HOME[role];
    const first = visibleMenuItems(role)[0];
    if (first) return first.target;
    const any = frames().find((f) => f.role === role && f.hidden !== true && f.device !== 'desktop');
    return any ? any.id : null;
  }
  function applyTextStyles(block, root) {
    const styles = block.textStyles && typeof block.textStyles === 'object' ? block.textStyles : null;
    if (!styles) return;
    for (const el of root.querySelectorAll('[data-text-field]')) applyStyle(styleOf(block, el.dataset.textField), el);
  }

  /* ---------- host, auth, мост ---------- */
  const preview = Boolean(HOST && HOST.mode === 'preview' && HOST.service);
  const auth = { preview: '', cabinetSession: false, portalSession: false, cabinet: null, portal: null, account: null, chat: null, guest: false, e1Native: false };
  const tickets = B.createTickets();
  let bridge = null;
  if (preview) bridge = B.createBridge({ transport: B.createMockTransport(HOST.service), getAuth: () => auth });
  else if (HOST && HOST.mode === 'native' && HOST.transport && HOST.transport.kind === 'native' && HOST.verified === true) {
    // Только проверенный host Root (разрешённый origin, identity/CSRF/session) может передать native-транспорт.
    bridge = B.createBridge({ transport: HOST.transport, getAuth: () => auth });
  }
  const caps = () => B.capabilities(auth);
  function uiRole() {
    if ((auth.portal && auth.portal.role === 'owner') || (auth.cabinet && auth.cabinet.member && auth.cabinet.role === 'owner')) return 'admin';
    if ((auth.portal && auth.portal.role === 'admin') || (auth.cabinet && auth.cabinet.member)) return 'staff';
    if (auth.portal || auth.account || auth.guest) return 'client';
    return '';
  }
  const workflow = window.PalitraWorkflowUI ? window.PalitraWorkflowUI.create({ document, window, request: HOST && HOST.workflow ? HOST.workflow.request : null, onUnauthorized: (error) => endSession('cabinet', error.message) }) : null;
  function workflowIdentity() { if (workflow) workflow.setIdentity({ key: actorKey(), role: auth.cabinet ? auth.cabinet.role : 'client', member: Boolean(auth.cabinet && auth.cabinet.member), permissions: auth.cabinet ? auth.cabinet.permissions : [] }); }
  const actorKey = () => (auth.cabinet ? `cabinet:${auth.cabinet.userId}` : '') + (auth.portal ? `|portal:${auth.portal.id}` : '') + (auth.account ? `|account:${auth.account.opaque}` : '');

  /* ---------- состояние ---------- */
  const state = { role: '', frameId: null, params: {}, menuOpen: false, works: false, error: '', notice: '', authError: '',
    bootstrap: null, native: null, detail: null, links: null, chat: null, summary: null, clientThread: null, clientThreads: null, clientThreadLinked: false };
  // Черновики — только память страницы, ключ: актор + typed сущность. Смена/отзыв identity их очищает.
  const drafts = new Map();
  const draftKey = (kind, ref) => `${actorKey()}#${kind}#${ref ? B.refKey(ref) : 'none'}`;
  const pendingSends = new Map();   // актор+сущность → { requestId, body, unknown }
  // F2: отправки «в полёте» по ключу актор+typed сущность: повторный клик/Enter/submit во время await не создаёт вторую.
  const inflight = new Set();
  // Подтверждённые backend счётчики (0, если не подключено или ответа не было). В модель макета не пишутся.
  const counts = { orders: 0 };
  // Начальное состояние формы K01. Смена/отзыв identity возвращает к нему ВСЁ (ввод, попытку, квитанцию прежнего клиента);
  // ошибка проверки или сети в той же identity ввод не трогает.
  const initialForm = () => ({ name: '', channel: 'telegram', contact: '', consent: false, expanded: false, status: '', message: '', busy: false, attempt: null, receipt: null });
  const form = initialForm();
  const utm = (() => { try { return B.sanitizeUtm(Object.fromEntries(new URLSearchParams(location.search))); } catch (_) { return {}; } })();
  if (location.search) { try { history.replaceState(null, '', location.pathname + location.hash); } catch (_) { /* не обязательно */ } }

  /* ---------- навигация: экран + typed параметры, «Назад» без обрезки истории ---------- */
  const nav = [];
  let initialWorkflowRoute = location.hash === '#A10';
  const entryKey = (id, params) => `${id}?${new URLSearchParams(params).toString()}`;
  const contextKey = () => `${tickets.epoch}|${actorKey()}|${entryKey(state.frameId, state.params)}`;
  const canGoBack = () => nav.some((e) => frameById(e.id) && entryKey(e.id, e.params) !== entryKey(state.frameId, state.params));
  const paramRef = (name, ns) => (state.params[name] ? B.parseRef(state.params[name], ns) : null);
  function open(id, params = {}, { back = false, replace = false } = {}) {
    const frame = frameById(id);
    if (!frame) { toast(`Экран ${id || '—'} не найден в макете`); return; }
    if (frame.role !== state.role) { toast('Этот экран для другой роли'); return; }
    if (frame.hidden === true) { toast('Страница убрана в редакторе'); return; }
    const next = entryKey(id, params), current = state.frameId ? entryKey(state.frameId, state.params) : '';
    if (!back && !replace && current && current !== next) {
      const top = nav[nav.length - 1];
      if (!top || entryKey(top.id, top.params) !== current) nav.push({ id: state.frameId, params: { ...state.params } });
    }
    const oldOrder = state.params.order, oldChat = state.params.chat;
    state.frameId = id; state.params = { ...params }; state.menuOpen = false; state.works = false; state.installOpen = false; state.error = ''; state.notice = '';
    tickets.bumpNav();
    // Данные другой сущности не показываются ни мгновения: до ответа — «Загрузка…».
    if (params.order !== oldOrder) { state.detail = null; state.links = null; }
    if (params.chat !== oldChat || params.order !== oldOrder) state.chat = null;
    try { history.replaceState(null, '', `#${next.replace(/\?$/, '')}`); } catch (_) { /* адрес не обязателен */ }
    stopChatRefresh();
    render({ fresh: true });
    loadScreen();
  }
  function goBack() {
    while (nav.length) {
      const e = nav.pop();
      if (frameById(e.id) && entryKey(e.id, e.params) !== entryKey(state.frameId, state.params)) { open(e.id, e.params, { back: true }); return; }
    }
    render();
  }
  function go(target, params = {}) {
    if (target === '@site') return openLinkNotice('site.open');
    if (target === '@works') { state.works = true; render(); return; }
    if (!target) { toast('Это действие пока не подключено'); return; }
    const frame = frameById(target);
    if (frame && frame.role === state.role) open(target, params); else toast('Этот экран для другой роли');
  }
  function openLinkNotice(name) { toast(`Откроется по ссылке: ${B.linkUrl(name)}`); }

  /* ---------- вход и смена identity ---------- */
  function clearIdentityData() {
    tickets.bumpEpoch();
    drafts.clear(); pendingSends.clear(); inflight.clear(); counts.orders = 0;
    if (workflow) workflow.setIdentity({ key: '', role: '', member: false, permissions: [] });
    Object.assign(form, initialForm());
    stopChatRefresh();
    destroyFrames();   // F6: прежний редактор не появляется после смены/отзыва identity
    Object.assign(state, { bootstrap: null, native: null, detail: null, links: null, chat: null, summary: null, clientThread: null, clientThreads: null, clientThreadLinked: false, error: '' });
    state.installOpen = false;
    nav.length = 0;
  }
  function endSession(space, message) {
    auth[space] = null;
    if (space === 'cabinet') auth.cabinetSession = false;
    if (space === 'portal') auth.portalSession = false;
    if (space === 'account') { auth.account = null; auth.chat = null; }
    clearIdentityData();
    state.authError = message || 'Сессия завершена. Войдите штатно и откройте приложение заново.';
    state.role = uiRole(); state.frameId = null;
    if (state.role && homeFrame(state.role)) open(homeFrame(state.role), {}, { replace: true }); else render();
  }
  async function signIn(previewRole) {
    if (!bridge) return;
    const epoch = tickets.epoch + 1;
    let shopProbe = false, portalAvailable = false;
    clearIdentityData();
    if (preview) {
      // Предпросмотр: набор синтетических сессий mock (не права и не native identity).
      const p = HOST.service.PREVIEW[previewRole];
      Object.assign(auth, { preview: previewRole || '', cabinetSession: Boolean(p && p.cabinet), portalSession: Boolean(p && p.portal), cabinet: null, portal: null,
        account: p && p.account ? { ...p.account } : null, chat: null, guest: false });
    } else {
      // Native: только флаги наличия сессий от доверенного host (getAuthContext); роли и identity — из ответов whoami/bootstrap.
      let ctx = {};
      try { ctx = typeof HOST.getAuthContext === 'function' ? HOST.getAuthContext() || {} : {}; } catch (_) { ctx = {}; }
      const account = ctx.account && B.accountRef(ctx.account.opaque) ? { opaque: ctx.account.opaque } : null;
      Object.assign(auth, { preview: '', cabinetSession: ctx.cabinetSession === true, portalSession: ctx.portalSession === true, cabinet: null, portal: null,
        account, chat: null, guest: ctx.guest === true && !account, e1Native: HOST.e1Native === true });
      shopProbe = ctx.shopSession === true; portalAvailable = ctx.portalAvailable === true;
    }
    state.authError = '';
    const live = () => tickets.epoch === epoch;
    try {
      // Native магазин: существующая сессия аккаунта (гость или вошедший). Имя/контакт формы правом не являются.
      if (!preview && shopProbe) {
        const session = B.parseAccountSession(await bridge.call('account.session')); if (!live()) return;
        auth.account = { opaque: session.opaque }; auth.guest = !session.signedIn;
        if (typeof HOST.acceptAccountCsrf === 'function') HOST.acceptAccountCsrf(session.csrf);
        // Заказы покупателя — через штатный crm-session (только вошедший покупатель и включённый CRM host-флаг).
        if (session.signedIn && portalAvailable) auth.portalSession = true;
      }
      if (auth.cabinetSession) {
        const who = await bridge.call('staff.identity'); if (!live()) return;
        auth.cabinet = B.parseIdentity(who);
        // CSRF кабинета — только транспорту host (память), не в state/URL/манифест.
        if (!preview && typeof HOST.acceptCabinetCsrf === 'function') HOST.acceptCabinetCsrf(auth.cabinet.csrfToken);
      }
      if (auth.portalSession) { const data = await bridge.call('portal.bootstrap'); if (!live()) return; auth.portal = B.parsePortalActor(data); state.bootstrap = data; }
      if (auth.account) {
        // Чат сайта необязателен для входа: выключенный E/отказ — chat.ready=false, общая заявка честно блокируется формой.
        let session = null;
        try { session = await bridge.call('customer.chat.session', { body: {} }); } catch (failure) { if (!live()) return; if (failure.status === 401) throw failure; session = null; }
        if (!live()) return;
        const csrf = session && session.ok === true && typeof session.csrfToken === 'string' ? session.csrfToken : '';
        auth.chat = { ready: Boolean(session && session.ok === true && (preview || csrf)) };
        if (!preview && typeof HOST.acceptChatSession === 'function') HOST.acceptChatSession(csrf);
      }
    } catch (error) {
      if (!live()) return;
      state.authError = error.code === 'NATIVE_DISABLED' ? 'Приложение временно недоступно. Попробуйте обновить страницу позже.' : error.message;
      if (error.status === 401) Object.assign(auth, { cabinetSession: false, portalSession: false, cabinet: null, portal: null });
    }
    state.role = uiRole();
    nav.length = 0; state.frameId = null;
    // Единственная стартовая ссылка настроек: роль и членство уже подтверждены backend.
    const requestedWorkflow = initialWorkflowRoute; initialWorkflowRoute = false;
    workflowIdentity();
    const destination = requestedWorkflow && state.role === 'admin' && workflow && workflow.isOwner() && visibleFrame('A10', 'admin') ? 'A10' : homeFrame(state.role);
    if (state.role && destination) open(destination, {}, { replace: true }); else render();
    refreshCounts(epoch);   // после определения роли по ответам backend
  }

  /* Счётчик уведомлений у пунктов «заказы»: только подтверждённый unread backend.
     Клиент — 0 (в E webchat и CRM нет unread); owner кабинета — legacy aggregate client-bot.unread. Заявки/work=new — не unread.
     Нет подключения или ответа — 0. Ничего не пишется в макет. */
  async function refreshCounts(epoch) {
    if (!bridge) return;
    const c = caps();
    let n = 0;
    try {
      // В E-чате и CRM нет серверного unread/read cursor — у клиента 0. Число заявок/work=new — не unread.
      // Сотрудник (owner кабинета): единственный подтверждённый aggregate — legacy unread GET /content/palitra/client-bot.
      if (state.role && state.role !== 'client' && c['native.orders']) n = B.parseUnread(await bridge.call('legacy.bot.summary'));
    } catch (_) { n = 0; }
    if (epoch !== tickets.epoch) return;
    counts.orders = n;
    render();
  }

  /* ---------- загрузка: билет контекста проверяется до любого присваивания ---------- */
  async function loadScreen({ refresh = false } = {}) {
    if (!bridge) return;
    const key = contextKey(), ticket = tickets.take(key);
    const frame = frameById(state.frameId);
    const type = screenType(frame), role = state.role, c = caps();
    const order = paramRef('order'), chat = paramRef('chat');
    const next = {};
    let error = '';
    try {
      if (type === 'orders' || (type === 'detail' && order && (order.ns === 'crm-order' || order.ns === 'crm-inquiry') && role === 'client')) {
        if (c['portal.staff'] || c['portal.customer']) next.bootstrap = await bridge.call('portal.bootstrap');
        if (role !== 'client' && c['native.orders']) next.native = await bridge.call('native.orders.list', { query: { limit: 50 } });
      }
      if (type === 'detail' && order) {
        if (order.ns === 'crm-order' && (role === 'client' ? c['portal.customer'] : c['portal.staff'])) next.detail = B.parseCrmOrder(await bridge.call('portal.order.detail', { ref: order }), order);
        if (order.ns === 'native-order' && c['native.orders']) {
          const list = await bridge.call('native.orders.list', { query: { limit: 50 } });
          next.native = list;
          const row = Array.isArray(list.orders) ? list.orders.find((o) => o.id === order.id) : null;
          next.detail = row ? { native: row } : { missing: true };
          if (row) next.links = B.parseOrderLinks(await bridge.call('native.order.dialog', { ref: order }));
        }
      }
      if (type === 'chat') {
        if (role === 'client' && c['customer.chat']) {
          const data = await bridge.call('customer.chat.threads', { body: {} });
          const own = (data && Array.isArray(data.threads) ? data.threads : []).filter((t) => t && typeof t.id === 'number' && B.parsePositiveId(t.id) !== null)
            .map((t) => ({ ref: B.makeRef('thread', t.id), orderRef: typeof t.orderId === 'number' && B.parsePositiveId(t.orderId) !== null ? B.makeRef('native-order', t.orderId) : null }));
          next.clientThreads = own;
          if (!refresh && order && order.ns === 'crm-order' && c['portal.customer']) next.detail = B.parseCrmOrder(await bridge.call('portal.order.detail', { ref: order }), order);
          const known = refresh ? state.detail : next.detail;
          // Выбор: явно выбранный typed thread из своих; иначе — только подтверждённая связь siteOrderId → thread.orderId. Никакого «первого».
          // Ссылка на native-заявку: явная (квитанция/карточка заявки) или siteOrderId CRM-заказа, если backend его отдаёт.
          const siteParam = paramRef('site', 'native-order');
          const site = siteParam || (known && typeof known.siteOrderId === 'number' ? B.makeRef('native-order', known.siteOrderId) : null);
          // Thread открывается, только если он в списке своих (E grant этой chat-сессии) и его orderId совпал с native-заявкой.
          const picked = chat && chat.ns === 'thread' ? own.find((t) => B.sameRef(t.ref, chat) && (!site || (t.orderRef && B.sameRef(t.orderRef, site))))
            : site ? own.find((t) => t.orderRef && B.sameRef(t.orderRef, site)) : null;
          next.clientThreadMismatch = Boolean(chat && chat.ns === 'thread' && !picked);
          next.clientThread = picked ? picked.ref : null;
          next.clientThreadLinked = Boolean(picked && site && picked.orderRef && B.sameRef(picked.orderRef, site));
          next.chat = picked ? await bridge.call('customer.chat.messages', { body: { threadId: picked.ref.id } }) : null;
        } else if (chat && (chat.ns === 'legacy' || chat.ns === 'thread')) {
          next.chat = await bridge.call(chat.ns === 'legacy' ? 'legacy.read' : 'thread.read', { ref: chat });
        }
      }
      if (type === 'reports' && c['portal.summary']) next.summary = await bridge.call('portal.summary');
    } catch (failure) {
      if (!tickets.live(ticket, key)) return;   // поздняя ошибка прежнего экрана не показывается
      if (failure.status === 401 || failure.code === 'SESSION_ENDED') { endSession(failure.space || spaceOf(type, order, chat), failure.message); return; }
      error = failure.message;
      if (failure.status === 404 && type === 'detail') next.detail = { missing: true };
    }
    if (!tickets.live(ticket, key)) return;     // поздний ответ A после перехода к B — не применяется и не рисуется
    for (const [field, value] of Object.entries({ ...next, error })) if (tickets.accept(ticket, field)) state[field] = value;
    render();
    scheduleChatRefresh();   // один управляемый таймер на открытый чат (только native-host с chatAutoRefresh)
  }

  /* ---------- перечитывание открытой переписки ----------
     Вручную — кнопка «Обновить переписку» (все хосты). Автоматически — раз в 5 с, только если доверенный native-host явно
     выдал chatAutoRefresh (network && e1Native), открыт чат, страница видима. Один таймер на контекст чата: переход,
     смена/отзыв identity и скрытие страницы его снимают. Только существующие чтения (threads/messages, thread.read,
     legacy.read) через тот же loadScreen с билетами; заявок и сообщений не отправляет. Это не бизнес-таймер 300 с. */
  const CHAT_REFRESH_MS = 5000;
  const autoChatRefresh = !preview && Boolean(HOST && HOST.mode === 'native' && HOST.chatAutoRefresh === true);
  let chatTimer = null, chatRefreshing = false, composing = false, lastChatInput = 0;
  function chatOpenNow() {
    if (!bridge || !state.role || screenType(frameById(state.frameId)) !== 'chat') return false;
    if (state.role === 'client') return Boolean(caps()['customer.chat'] && state.clientThread);
    const ref = paramRef('chat');
    return Boolean(ref && (ref.ns === 'thread' || ref.ns === 'legacy') && caps()['native.orders']);
  }
  function readRefreshOpenNow() {
    if (chatOpenNow()) return true;
    if (!bridge || !state.role || state.role === 'client' || !caps()['native.orders']) return false;
    const type = screenType(frameById(state.frameId)), ref = paramRef('order');
    return type === 'orders' || (type === 'detail' && ref && ref.ns === 'native-order');
  }
  function stopChatRefresh() { if (chatTimer) clearTimeout(chatTimer); chatTimer = null; }
  // Идёт набор (IME или ввод в поле чата только что): опрос откладывается, поле не пересоздаётся посреди набора.
  const typingNow = () => composing || (document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('chat__input') && Date.now() - lastChatInput < 1500);
  function scheduleChatRefresh() {
    stopChatRefresh();
    if (!autoChatRefresh || document.hidden || !readRefreshOpenNow()) return;
    const key = contextKey();
    chatTimer = setTimeout(() => {
      chatTimer = null;
      if (key !== contextKey() || document.hidden || !readRefreshOpenNow()) return;
      if (typingNow() || (screenType(frameById(state.frameId)) !== 'chat' && document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName))) { scheduleChatRefresh(); return; }
      loadScreen({ refresh: true });
    }, CHAT_REFRESH_MS);
  }
  async function refreshChat() {
    if (chatRefreshing || !chatOpenNow()) return;
    chatRefreshing = true; render();
    try { await loadScreen({ refresh: true }); } finally { chatRefreshing = false; render(); }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopChatRefresh(); else scheduleChatRefresh(); });
  const spaceOf = (type, order, chat) => (chat ? 'cabinet' : order && order.ns === 'native-order' ? 'cabinet' : state.role === 'client' && type === 'chat' ? 'account' : 'portal');
  function screenType(frame) {
    if (!frame) return '';
    if (frame.id === 'A10') return 'workflow';
    if (frame.kind === 'orders' || frame.kind === 'history') return 'orders';
    if (frame.kind === 'editor') return /фото/i.test(frame.title) || frame.id.endsWith('06') ? 'photos' : 'catalog';
    return frame.kind || 'generic';
  }

  /* ---------- отрисовка ---------- */
  function render({ fresh = false } = {}) {
    const active = document.activeElement;
    const focusKey = active && active.dataset ? active.dataset.focus : '';
    const caret = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const top = ui.body.scrollTop;
    const oldList = ui.body.querySelector('.chat__list');
    const listTop = oldList ? oldList.scrollTop : null;
    workflowIdentity();
    renderHeader();
    const frame = frameById(state.frameId);
    const phone = $('phone');
    if (phone) {
      if (bridge && state.role === 'client' && frame && frame.presentation === 'celebration') phone.classList.add('phone--celebration');
      else phone.classList.remove('phone--celebration');
    }
    const content = !DESIGN ? [h('p', { class: 'app-error', text: 'Нет снимка макета.' })]
      : !bridge ? [notConnected()]
        : !state.role ? [h('div', { class: 'app-empty' }, h('p', { text: state.authError || 'Вход не подтверждён. Откройте приложение штатно.' }), loginLink())]
          : screen(frame);
    ui.body.replaceChildren(...content);
    showFrame(state.role && frame ? activeSlot(frame) : null);
    ui.overlay.replaceChildren(state.menuOpen ? roleMenu() : '', state.works ? worksSheet() : '', state.installOpen ? installSheet() : '');
    if (!fresh) ui.body.scrollTop = top;
    const newList = ui.body.querySelector('.chat__list');
    if (!fresh && newList && listTop !== null) newList.scrollTop = listTop;
    if (focusKey) {
      const el = ui.body.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`);
      if (el) { el.focus(); if (caret && typeof el.setSelectionRange === 'function') { try { el.setSelectionRange(caret[0], caret[1]); } catch (_) { /* поле без выделения */ } } }
    }
  }
  // Вход/регистрация — только существующие страницы сайта; имя и контакт из формы правом доступа не являются.
  const loginLink = () => h('a', { class: 'app-btn app-btn--ghost', href: `${B.ORIGINS.shop}/account/login?next=%2Flove-app%2Fshop.html`, target: '_blank', rel: 'noopener noreferrer', text: 'Войти или зарегистрироваться на сайте Palitra Love ↗' });
  function notConnected() {
    return h('section', { class: 'card' }, h('h2', { class: 'text__title', text: 'Подключение не настроено' }),
      h('p', { text: 'Откройте приложение по рабочей ссылке Palitra Love. Если оно не загружается, попробуйте обновить страницу позже.' }));
  }
  function renderHeader() {
    // replaceChildren converts null to a visible text node; filter optional header children first.
    ui.header.replaceChildren(...[
      h('button', { type: 'button', class: 'app-burger', 'aria-label': 'Меню', 'aria-expanded': String(state.menuOpen), onclick: () => { state.menuOpen = !state.menuOpen; state.works = false; render(); } }, h('span'), h('span'), h('span')),
      h('button', { type: 'button', class: 'app-back', 'aria-label': 'Назад', title: 'Назад', hidden: !canGoBack(), onclick: goBack }, icon('M15 5l-7 7 7 7', 22)),
      h('span', { class: 'app-title', text: DESIGN ? str(DESIGN.appTitle) || 'Palitra Love заказы' : 'Palitra Love заказы' }),
      preview ? h('span', { class: 'app-mode', title: 'Синтетические данные, без сети', text: 'Предпросмотр' }) : null].filter((child) => child !== null && child !== undefined && child !== false));
  }
  function capabilityList() {
    const c = caps();
    const rows = [['Заявки с сайта (native)', c['native.orders']], ['Чат сайта E/R1', c['native.threads'] === 'accepted-local' ? 'принят локально, native0' : c['native.threads']],
      ['CRM (сотрудник)', c['portal.staff']], ['CRM (покупатель)', c['portal.customer']], ['Отчёты собственника', c['portal.summary']],
      ['Редактор каталога', c['editor.catalog']], ['Редактор фото', c['editor.photos'] === 'delegated' ? 'проверит сам редактор' : c['editor.photos']],
      ['Чат покупателя', c['customer.chat'] ? (preview ? 'предпросмотр (native0)' : true) : false], ['Напоминание через 5 мин', 'серверная связка не подключена']];
    return h('ul', { class: 'caps' }, rows.map(([label, value]) => h('li', { class: `caps__item${value === true ? ' is-on' : value ? ' is-partial' : ''}` },
      h('span', { text: label }), h('span', { class: 'caps__state', text: value === true ? 'подключено' : value ? String(value) : 'не подключено' }))));
  }
  // Какому праву backend соответствует экран: пункт меню не даёт доступа, а только ведёт на экран.
  function screenAllowed(frame) {
    const c = caps(), type = screenType(frame), staff = state.role !== 'client';
    if (type === 'workflow') return Boolean(workflow && workflow.isOwner());
    if (type === 'photos') return Boolean(c['editor.photos']);
    if (type === 'catalog') return Boolean(c['editor.catalog']);
    if (type === 'reports') return c['portal.summary'] === true;
    if (type === 'orders' || type === 'detail') return staff ? Boolean(c['native.orders'] || c['portal.staff']) : c['portal.customer'] === true;
    if (type === 'chat') return staff ? Boolean(c['native.orders']) : c['customer.chat'] === true;
    return true;
  }
  function roleMenu() {
    const role = state.role;
    const { menu } = role ? effectiveMenu(role) : { menu: null };
    const items = role ? visibleMenuItems(role) : [];
    const orders = role ? ordersFrames(role) : {};
    // Пустая строка названия/пункта сохраняется как есть; отсутствующее название — подпись роли.
    const title = menu && typeof menu.title === 'string' ? menu.title : role ? MENU_TITLE[role] : 'Нет входа';
    return h('div', { class: 'app-menu', role: 'dialog', 'aria-label': 'Меню', dataset: { menu: menu ? str(menu.id) : '' } },
      h('div', { class: 'app-menu__panel' },
        applyStyle(styleOf(menu, 'title'), h('p', { class: 'app-menu__role', text: title })),
        items.map((item) => {
          const target = item.target, frame = frameById(target);
          const current = target === state.frameId || (orders.active && target === orders.active.id && orders.history && state.frameId === orders.history.id);
          const allowed = screenAllowed(frame);
          return applyStyle(styleOf(item, 'label'), h('button', { type: 'button', class: `app-menu__item${current ? ' is-current' : ''}${allowed ? '' : ' is-locked'}`, dataset: { menuItem: item.id },
            disabled: !allowed, 'aria-disabled': allowed ? null : 'true', title: allowed ? null : 'Нет подтверждённого доступа',
            onclick: () => { if (!allowed) return; state.menuOpen = false; open(target); } },
          h('span', { class: 'app-menu__label', text: typeof item.label === 'string' ? item.label : '' }), allowed ? countBadge(target) : h('span', { class: 'app-menu__lock', text: state.role === 'client' && !auth.portal ? 'нужен вход' : 'нет доступа' })));
        }),
        workflow && workflow.isOwner() && !items.some((item) => item.target === 'A10') ? h('button', { type: 'button', class: 'app-menu__item', onclick: () => { state.menuOpen = false; open('A10'); } }, 'Автоответ и этапы') : null,
        workflow ? h('button', { type: 'button', class: 'app-menu__item', onclick: () => { state.menuOpen = false; state.installOpen = true; render(); } }, 'Установка и уведомления') : null,
        // Покупатель без входа: обычный вход/регистрация существующего сайта (не создаём аккаунт и не авторизуем по форме).
        role === 'client' && !auth.portal ? loginLink() : null,
        preview ? h('div', { class: 'app-menu__demo' }, h('p', { class: 'app-menu__demo-title', text: 'Доступ в предпросмотре' }), capabilityList(),
          preview ? [h('p', { class: 'app-menu__demo-title', text: 'Предпросмотр: набор синтетических сессий — не вход и не права' }),
            h('div', { class: 'seg', role: 'group', 'aria-label': 'Предпросмотр' }, Object.entries(HOST.service.PREVIEW).map(([id, p]) =>
              h('button', { type: 'button', class: 'seg__btn', 'aria-pressed': String(auth.preview === id), text: p.label, onclick: () => { state.menuOpen = false; signIn(id); } })))] : null) : null),
      h('button', { type: 'button', class: 'app-menu__shade', 'aria-label': 'Закрыть меню', onclick: () => { state.menuOpen = false; render(); } }));
  }
  function installSheet() {
    return h('div', { class: 'app-sheet', role: 'dialog', 'aria-label': 'Установка и уведомления' },
      h('div', { class: 'app-sheet__head' }, h('strong', { text: 'Установка и уведомления' }), h('button', { type: 'button', class: 'app-sheet__close', 'aria-label': 'Закрыть', text: '×', onclick: () => { state.installOpen = false; render(); } })),
      workflow ? workflow.onboardingPanel(state.role, state.role === 'client' ? 'chat' : 'login', { force: true }) : null);
  }
  function worksSheet() {
    return h('div', { class: 'app-sheet', role: 'dialog', 'aria-label': 'Наши работы' },
      h('div', { class: 'app-sheet__head' }, h('strong', { text: 'Наши работы' }), h('button', { type: 'button', class: 'app-sheet__close', 'aria-label': 'Закрыть', text: '×', onclick: () => { state.works = false; render(); } })),
      h('p', { class: 'app-sheet__note', text: 'Фото работ ведутся штатным редактором фото сайта; здесь они не копируются.' }));
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (state.menuOpen || state.works || state.installOpen)) { state.menuOpen = false; state.works = false; state.installOpen = false; render(); } });

  function screen(frame) {
    if (!frame) return [h('p', { class: 'app-empty', text: 'Экран не найден.' })];
    const out = [];
    if (state.authError) out.push(h('p', { class: 'app-error', role: 'alert', text: state.authError }));
    if (state.error) out.push(h('p', { class: 'app-error', role: 'alert', text: state.error }));
    const type = screenType(frame);
    if (type === 'workflow') { if (workflow) out.push(workflow.settingsPanel()); else out.push(h('p', { class: 'hint', text: 'Настройки ещё не подключены.' })); }
    else if (type === 'orders') out.push(...ordersScreen(frame));
    else if (type === 'detail') out.push(...(state.role === 'client' ? clientDetail(frame) : staffDetail(frame)));
    else if (type === 'chat') out.push(...(state.role === 'client' ? clientChat(frame) : staffChat(frame)));
    else if (type === 'review') out.push(...reviewScreen(frame));
    else if (type === 'photos') out.push(...editorScreen(frame, 'editor.photos.open'));
    else if (type === 'catalog') out.push(...editorScreen(frame, 'editor.catalog.open'));
    else if (type === 'reports') out.push(...reportsScreen(frame));
    else if (type === 'website') out.push(...frame.blocks.map((b) => (b.type === 'website' ? (b.label ? h('p', { class: 'muted', text: str(b.label) }) : null) : genericBlock(b))).filter(Boolean));
    else {
      const visual = frame.blocks.map(genericBlock).filter(Boolean);
      if (frame.presentation === 'celebration') {
        visual.forEach(decorateCelebrationButton);
        if (typeof frame.eyebrow === 'string') visual.unshift(h('p', { class: 'celebration-eyebrow', text: frame.eyebrow }));
        const categories = Array.isArray(frame.categories) ? frame.categories.slice(0, 3) : [];
        if (categories.length) visual.push(h('div', { class: 'celebration-categories' }, categories.map((item, index) => h('button', {
          type: 'button', class: 'celebration-category', dataset: { categoryTarget: str(item.target) }, onclick: () => go(item.target),
        }, celebrationIcon(item.icon || ['gift', 'heart', 'star'][index]), applyStyle(styleOf(item, 'label'), h('span', { text: str(item.label) }))))));
      }
      out.push(...visual);
    }
    if (workflow && state.role !== 'client' && frame.id === MENU_HOME[state.role]) { const panel = workflow.onboardingPanel(state.role, 'login'); if (panel) out.unshift(panel); }
    return out;
  }

  // Оформление K01 меняет только представление: поля и обработчики заявки остаются существующими.
  function celebrationIcon(kind) {
    const paths = {
      gift: ['M10 18h20v15H10z', 'M8 13h24v5H8z', 'M20 13v20', 'M20 13c-8 0-10-8-5-8 4 0 5 8 5 8z', 'M20 13c8 0 10-8 5-8-4 0-5 8-5 8z'],
      heart: ['M20 32S6 23 6 14c0-8 10-10 14-3 4-7 14-5 14 3 0 9-14 18-14 18z'],
      star: ['M20 5l4 10 11 1-8 7 2 11-9-6-9 6 2-11-8-7 11-1z'],
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [k, v] of Object.entries({ class: 'celebration-category__icon', viewBox: '0 0 40 40', width: '40', height: '40', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(k, v);
    for (const d of paths[kind] || paths.star) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      for (const [k, v] of Object.entries({ d, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.15', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) p.setAttribute(k, v);
      svg.append(p);
    }
    return svg;
  }
  function decorateCelebrationButton(block) {
    const button = block.classList.contains('app-btn') ? block : block.querySelector('.helpform-toggle');
    if (!button) return;
    button.classList.add('celebration-cta');
    const oldChevron = button.querySelector('.chev');
    if (oldChevron) oldChevron.remove();
    const leading = icon(button.classList.contains('helpform-toggle') ? 'M12 3l2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4z' : 'M5 8h14l1 13H4z M8 8V6a4 4 0 0 1 8 0v2', 20);
    leading.classList.add('celebration-cta__icon');
    const arrow = icon('M4 12h16m-6-6 6 6-6 6', 20);
    arrow.classList.add('celebration-cta__arrow');
    button.replaceChildren(leading, ...button.childNodes, arrow);
  }

  /* ---------- обычные блоки макета ---------- */
  function genericBlock(block) {
    let el = null;
    if (block.type === 'hero') el = h('div', { class: 'hero' }, h('h1', { class: 'hero__title', dataset: { textField: 'title' }, text: str(block.title).trim() }),
      block.subtitle ? h('p', { class: 'hero__sub', dataset: { textField: 'subtitle' }, text: str(block.subtitle) }) : null);
    else if (block.type === 'button') el = buttonBlock(block);
    else if (block.type === 'text') el = (block.title || block.text) ? h('div', { class: 'text' }, block.title ? h('h2', { class: 'text__title', dataset: { textField: 'title' }, text: str(block.title) }) : null,
      block.text ? h('p', { class: 'text__body', dataset: { textField: 'text' }, text: str(block.text) }) : null) : null;
    else if (block.type === 'helpform') el = helpForm(block);
    if (el) { el.classList.add('blk'); applyTextStyles(block, el); }
    return el;
  }
  // Контурный кружок с количеством — у целей вида «заказы» (как в редакторе: kind === 'orders'). Число — только из counts.
  const ordersTarget = (target) => { const f = typeof target === 'string' ? frameById(target) : null; return Boolean(f && f.kind === 'orders'); };
  function countBadge(target) {
    if (!ordersTarget(target)) return null;
    return h('span', { class: 'notification-count', dataset: { notificationSource: 'orders.unread' }, 'aria-label': `Уведомлений по заказам: ${counts.orders}`, text: String(counts.orders) });
  }
  function buttonBlock(block, onclick = null, extra = '') {
    // В принятом снимке у этой кнопки A01 цель пуста; явные переходы редактора сохраняем.
    const target = !block.target && block.id === 'A01-b-mv8glw8qa' && state.frameId === 'A01' && state.role === 'admin' && workflow && workflow.isOwner() ? 'A10' : block.target;
    const badge = countBadge(target);
    return h('button', { type: 'button', class: `app-btn${extra}${badge ? ' has-notification-count' : ''}`, onclick: onclick || (() => go(target)) },
      h('span', { class: 'app-btn__label', dataset: { textField: 'label' }, text: str(block.label) || 'Кнопка' }), badge);
  }

  /* ---------- форма K01 → shop.request.create (kind=request) ---------- */
  function helpForm(block) {
    const channel = () => FORM_CHANNELS.find((c) => c[0] === form.channel) || FORM_CHANNELS[0];
    const contact = h('input', { id: 'help-contact', class: 'app-input', type: channel()[2], placeholder: channel()[3], value: form.contact, autocomplete: 'off', maxlength: '100',
      dataset: { focus: 'help-contact', field: 'K01-b6.contact' }, oninput: (e) => { form.contact = e.target.value; } });
    const body = h('form', { class: 'helpform', novalidate: true, dataset: { block: str(block.id) }, onsubmit: (e) => { e.preventDefault(); submitRequest(); } },
      block.title ? h('h2', { class: 'text__title', dataset: { textField: 'title' }, text: str(block.title) }) : null,
      block.subtitle ? h('p', { class: 'helpform__sub', dataset: { textField: 'subtitle' }, text: str(block.subtitle) }) : null,
      h('label', { class: 'field', for: 'help-name' }, h('span', { class: 'field__label', dataset: { textField: 'nameLabel' }, text: str(block.nameLabel) || 'Имя' })),
      h('input', { id: 'help-name', class: 'app-input', type: 'text', maxlength: '80', autocomplete: 'off', value: form.name, dataset: { focus: 'help-name', field: 'K01-b6.name' }, oninput: (e) => { form.name = e.target.value; } }),
      h('label', { class: 'field', for: 'help-channel' }, h('span', { class: 'field__label', dataset: { textField: 'messengerLabel' }, text: str(block.messengerLabel) || 'Канал связи' })),
      h('select', { id: 'help-channel', class: 'app-input', dataset: { focus: 'help-channel', field: 'K01-b6.channel' }, onchange: (e) => {
        form.channel = e.target.value; const c = channel(); contact.type = c[2]; contact.placeholder = c[3];
      } }, FORM_CHANNELS.map(([id, label]) => h('option', { value: id, selected: id === form.channel, text: label }))),
      h('label', { class: 'field', for: 'help-contact' }, h('span', { class: 'field__label', dataset: { textField: 'contactLabel' }, text: str(block.contactLabel) || 'Контакт' })),
      contact,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'help-consent', checked: form.consent, dataset: { focus: 'help-consent', field: 'K01-b6.consent' }, onchange: (e) => { form.consent = e.target.checked; } }),
        h('span', { text: 'Согласен(на) на обработку персональных данных для связи по заявке' })),
      h('button', { type: 'submit', class: 'app-btn', disabled: form.busy }, h('span', { class: 'app-btn__label', dataset: { textField: 'submitLabel' }, text: str(block.submitLabel) || 'Отправить' })),
      h('p', { class: `form-status${form.status ? ` is-${form.status}` : ''}`, role: 'status', text: form.message }),
      form.receipt ? receiptActions(form.receipt) : null,
      form.receipt && preview ? h('p', { class: 'muted', text: 'Предпросмотр: заявка создана в памяти страницы, на сервер ничего не отправлено.' }) : null);
    if (block.collapsible !== true) return body;
    const panel = h('div', { class: 'helpform-panel', id: 'help-panel', hidden: !form.expanded }, body);
    const toggle = h('button', { type: 'button', class: 'app-btn helpform-toggle', 'aria-expanded': String(form.expanded), 'aria-controls': 'help-panel',
      onclick: () => { form.expanded = !form.expanded; panel.hidden = !form.expanded; toggle.setAttribute('aria-expanded', String(form.expanded)); } },
    h('span', { class: 'helpform-toggle__label', dataset: { textField: 'toggleLabel' }, text: str(block.toggleLabel) || 'Подобрать индивидуально' }), chevron());
    return h('div', { class: 'helpform-wrap' }, toggle, panel);
  }
  // Причина, по которой общая заявка сейчас не отправляется (или '' — можно).
  function sharedGate() {
    if (!auth.account || auth.guest) return 'Чтобы заявка появилась в вашем кабинете и в переписке с менеджером, войдите или зарегистрируйтесь на сайте Palitra Love. Введённые данные сохранены в форме.';
    if (!auth.chat || !auth.chat.ready) return 'Чат сайта сейчас не готов — общая заявка с перепиской не отправляется. Данные сохранены в форме.';
    return '';
  }
  // Действия после квитанции: экран заказов и точный чат этой заявки (thread из квитанции, сверка с orderId — при открытии).
  function receiptActions(receipt) {
    const orders = ordersFrames('client').active, chat = mobileFrame('client', 'chat');
    return h('div', { class: 'ins-actions' },
      orders ? h('button', { type: 'button', class: 'app-btn app-btn--ghost', onclick: () => open(orders.id) }, 'Ваша заявка') : null,
      chat && receipt.thread ? h('button', { type: 'button', class: 'app-btn', dataset: { receiptChat: B.refKey(receipt.thread) },
        onclick: () => open(chat.id, { chat: B.refKey(receipt.thread), site: B.refKey(receipt.order) }) }, 'Чат') : null);
  }
  // Перечитать собственные данные покупателя после записи (bootstrap и чаты), без новой отправки.
  async function reread(epoch) {
    if (!bridge || epoch !== tickets.epoch) return;
    try { if (caps()['portal.customer']) { const data = await bridge.call('portal.bootstrap'); if (epoch === tickets.epoch) { tickets.commitNow('bootstrap'); state.bootstrap = data; } } } catch (_) { /* покажет экран заказов */ }
    if (epoch === tickets.epoch) render();
  }
  async function submitRequest() {
    if (form.busy) return;
    // Тот же requestId — только для той же попытки: неизвестный исход повторяется тем же телом; изменённая форма — новая попытка.
    const values = { name: form.name, channel: form.channel, contact: form.contact, consent: form.consent };
    const previous = form.attempt;
    const candidate = B.buildShopRequest(values, { requestId: previous ? previous.body.requestId : B.newRequestId(), utm, page: '/' });
    // Черновик формы не меняется: при блокировке значения остаются в полях.
    if (!candidate.ok) { form.status = 'error'; form.message = candidate.reasons.join(' '); render(); return; }
    let attempt;
    if (previous && B.fingerprintOf(previous.body) === B.fingerprintOf(candidate.body)) attempt = previous;          // та же попытка — тот же requestId
    else if (previous && previous.unknown) { form.status = 'error'; form.message = 'Исход прошлой отправки неизвестен: сначала повторите её без изменений.'; render(); return; }
    else attempt = { body: previous ? { ...candidate.body, requestId: B.newRequestId() } : candidate.body, unknown: false };
    // Общая заявка «в кабинете + переписка»: только вошедший покупатель с готовым чатом сайта. Иначе — честный отказ до отправки.
    const gate = sharedGate();
    if (gate) { form.status = 'error'; form.message = gate; render(); return; }
    form.attempt = attempt; form.busy = true; form.status = ''; form.message = 'Отправляем…'; render();
    const epoch = tickets.epoch;
    try {
      const data = await bridge.call('shop.request.create', { body: attempt.body });
      if (epoch !== tickets.epoch) return;
      let receipt;
      try { receipt = B.parseShopReceipt(data, attempt.body.requestId); }
      catch (_) { throw Object.assign(new Error('Ответ не подтвердил заявку — исход неизвестен'), { code: 'UNKNOWN_OUTCOME' }); }
      form.receipt = receipt;
      form.attempt = null; form.status = 'ok';
      form.message = receipt.chatMissing
        ? `Заявка №${receipt.order.id} записана, но сервер не подтвердил переписку к ней. Повторно не отправляем — проверьте «Ваши заказы».`
        : `Заявка №${receipt.order.id} принята${receipt.duplicate ? ' (повтор той же заявки, без дубля)' : ''}. Переписка с менеджером — в «Чат».`;
      reread(epoch);   // перечитать backend: список заявок и чаты — источник истины, не форма
    } catch (error) {
      if (epoch !== tickets.epoch) return;
      if (error.code === 'UNKNOWN_OUTCOME') { attempt.unknown = true; form.status = 'error'; form.message = `${error.message}. Нажмите ещё раз — уйдёт та же заявка с тем же номером запроса.`; }
      else { form.attempt = error.status === 409 ? null : attempt; form.status = 'error'; form.message = error.message; }
    } finally { if (epoch === tickets.epoch) { form.busy = false; render(); } }
  }

  /* ---------- менеджер фреймов: один iframe/placeholder на функцию ----------
     Встраивание — только same-origin Synapse для редакторов при подключённом host; каталог/сайт магазина — другой
     origin: обычная ссылка. В предпросмотре чужие страницы не загружаются, показывается placeholder. */
  /* F6: слоты живут в постоянном контейнере рядом с телом экрана (не внутри него): обычный переход меняет только
     видимость, iframe не отсоединяется и его browsing context не пересоздаётся. Смена/отзыв identity уничтожает
     контейнер и кэш — прежний редактор после смены пользователя не появляется. */
  const frameSlots = new Map();
  let frameHost = null;
  function ensureFrameHost() {
    if (frameHost && frameHost.parentNode) return frameHost;
    frameHost = h('div', { class: 'frame-host', id: 'frame-host', hidden: true });
    const phone = ui.body.parentNode;
    if (phone) phone.append(frameHost);
    return frameHost;
  }
  function destroyFrames() {
    // Выгрузить прежние редакторы (about:blank) и убрать контейнер целиком; следующий вход создаст новые.
    for (const { node } of frameSlots.values()) for (const f of node.querySelectorAll('iframe')) f.setAttribute('src', 'about:blank');
    frameSlots.clear();
    if (frameHost) { frameHost.replaceChildren(); frameHost.remove(); }
    frameHost = null;
  }
  function activeSlot(frame) {
    const type = screenType(frame), c = caps();
    if (type === 'photos') return c['editor.photos'] ? 'editor.photos.open' : null;
    if (type === 'catalog') return c['editor.catalog'] ? 'editor.catalog.open' : null;
    if (type === 'website' && blocks(frame, 'website').length) return state.role === 'client' ? 'catalog.open' : 'site.open';
    return null;
  }
  function showFrame(name) {
    if (!name && !frameHost) return;
    const host = ensureFrameHost();
    if (name && !frameSlots.has(name)) host.append(frameSlot(name));
    for (const [key, slot] of frameSlots) slot.node.hidden = key !== name;
    host.hidden = !name;
  }
  function frameSlot(name, caption = '') {
    if (frameSlots.has(name)) return frameSlots.get(name).node;
    const link = B.LINKS[name];
    const url = B.linkUrl(name);
    const sameOrigin = !preview && HOST && HOST.origin === B.ORIGINS[link.origin] && link.origin === 'synapse';
    let node;
    if (sameOrigin) {
      const frame = h('iframe', { class: 'slot__frame', title: link.title, src: link.path, referrerpolicy: 'same-origin' });
      const fallback = h('p', { class: 'slot__fallback', hidden: true }, 'Редактор нельзя показать внутри приложения. ', h('a', { href: link.path, target: '_blank', rel: 'noopener noreferrer', text: 'Открыть в новой вкладке' }));
      frame.addEventListener('load', () => {
        let ok = false;
        try { ok = frame.contentWindow.location.origin === window.location.origin; } catch (_) { ok = false; }   // только проверка origin, DOM не читается
        fallback.hidden = ok; frame.hidden = !ok;
      });
      node = h('div', { class: 'slot', dataset: { slot: name } }, h('a', { class: 'app-btn app-btn--ghost app-btn--small', href: url, target: '_blank', rel: 'noopener noreferrer', text: 'Открыть редактор отдельно ↗' }), frame, fallback);
    } else {
      node = h('div', { class: 'slot slot--placeholder', dataset: { slot: name } },
        h('p', { class: 'slot__title', text: preview ? `${link.title} — существующий экран Synapse (в предпросмотре не загружается)` : link.title }),
        caption ? h('p', { class: 'muted', text: caption }) : null,
        h('a', { class: `app-btn app-btn--ghost${link.origin === 'synapse' ? ' app-btn--small' : ''}`, href: url, target: '_blank', rel: 'noopener noreferrer', text: link.origin === 'shop' ? 'Открыть на сайте Palitra Love ↗' : 'Открыть редактор отдельно ↗' }),
        h('p', { class: 'muted', text: link.origin === 'shop' ? 'Каталог и цены — на сайте магазина; копий товаров и фото здесь нет.' : 'Права, CSRF и сохранение — внутри штатного редактора.' }));
    }
    frameSlots.set(name, { node, link: name });
    return node;
  }
  function editorScreen(frame, linkName) {
    const c = caps();
    const allowed = linkName === 'editor.catalog.open' ? c['editor.catalog'] : c['editor.photos'];
    const texts = blocks(frame, 'text').map(genericBlock).filter(Boolean);
    if (!allowed) return [...texts, h('p', { class: 'hint', text: 'Нет подтверждённого доступа кабинета Synapse к этому редактору.' })];
    return texts;   // сам редактор — в постоянном слоте frame-host (showFrame)
  }

  /* ---------- заказы: «Активные / История» ---------- */
  function crmOrders() { return state.bootstrap && Array.isArray(state.bootstrap.orders) ? state.bootstrap.orders.filter((o) => B.parsePositiveId(o.id) !== null) : null; }
  const FOLLOWUP_ALERT = 'Клиент не написал в чат. Свяжитесь удобным для него способом';
  function contactDue(o) { const f = o && o.nativeContactFollowup; return Boolean(caps()['native.orders'] && state.role !== 'client' && f && f.orderRef === `native-order:${o.id}` && /^thread:[1-9]\d*$/.test(f.threadRef) && f.state === 'due'); }
  function nativeOrders() { return state.native && Array.isArray(state.native.orders) ? state.native.orders.filter((o) => B.parsePositiveId(o.id) !== null) : null; }
  const crmHistory = (o) => o.status === 'done' || o.status === 'cancelled';
  const nativeHistory = (o) => ['done', 'cancelled'].includes(o.work && o.work.status);
  function ordersScreen(frame) {
    const { active, history } = ordersFrames(state.role);
    const c = caps(), staff = state.role !== 'client';
    const tab = (group) => blocks(frame, 'button').find((b) => b.orderGroup === group);
    const detail = mobileFrame(state.role, 'detail');
    const out = [];
    for (const [group, target] of [['active', active], ['history', history]]) {
      if (!target) continue;
      const openNow = frame.id === target.id;
      const label = str((tab(group) || {}).label) || (group === 'active' ? 'Активные' : 'История');
      out.push(h('button', { type: 'button', class: 'order-toggle', 'aria-expanded': String(openNow), onclick: () => { if (!openNow) open(target.id); } }, h('span', { class: 'order-toggle__label', text: label }), chevron()));
      if (!openNow) continue;
      const isHistory = group === 'history';
      const sections = [];
      const crm = crmOrders();
      if (staff ? c['portal.staff'] : c['portal.customer']) {
        const list = crm === null ? null : crm.filter((o) => crmHistory(o) === isHistory);
        sections.push(h('div', { class: 'order-section' }, staff ? h('p', { class: 'order-section__title', text: 'Заказы CRM' }) : null,
          list === null ? h('p', { class: 'app-empty', text: 'Загрузка…' }) : list.length ? list.map((o) => orderCard({
            ref: B.makeRef('crm-order', o.id), name: staff ? o.name : (auth.portal && auth.portal.name), title: `Заказ №${o.id}`, status: o.stageLabel || '', details: o.wishes, nextAction: staff ? o.nextAction : '',
          }, detail)) : h('p', { class: 'app-empty', text: isHistory ? 'Здесь появятся выполненные заказы.' : 'Активных заказов нет.' })));
      } else if (!staff) sections.push(h('p', { class: 'hint', text: 'Заказы видны после штатного входа в аккаунт магазина или через бот Palitra.' }), loginLink());
      // Собственные заявки (простая форма — CRM inquiry до оформления заказа): отдельно от заказов CRM, только из bootstrap.requests.
      if (!staff && !isHistory && c['portal.customer'] && state.bootstrap) {
        const requests = B.parsePortalRequests(state.bootstrap);
        if (requests.length) sections.unshift(h('div', { class: 'order-section' }, h('p', { class: 'order-section__title', text: 'Ваши заявки' }),
          requests.map((r) => orderCard({ ref: r.ref, name: auth.portal && auth.portal.name, title: r.site ? `Заявка №${r.site.id}` : `Обращение №${r.ref.id}`,
            status: 'Получена', details: r.site ? 'Менеджер свяжется с вами в переписке по этой заявке.' : 'Связь заявки с перепиской сервер пока не передаёт.' }, detail))));
      }
      if (staff && !isHistory && c['portal.staff'] && state.bootstrap && Array.isArray(state.bootstrap.inquiries)) {
        const inquiries = state.bootstrap.inquiries.filter((q) => q && typeof q.id === 'number' && B.parsePositiveId(q.id) !== null && q.status === 'open');
        if (inquiries.length) sections.push(h('div', { class: 'order-section' }, h('p', { class: 'order-section__title', text: 'Обращения CRM' }),
          inquiries.map((q) => {
            const site = typeof q.siteOrderId === 'number' ? B.makeRef('native-order', q.siteOrderId) : null;
            const card = { ref: B.makeRef('crm-inquiry', q.id), name: str(q.name), title: site ? `Обращение №${q.id} · заявка сайта №${site.id}` : `Обращение №${q.id}`, status: str(q.sourceLabel), details: str(q.summary) };
            // Карточка ведёт к той же native-заявке (заявки и переписка — только owner кабинета); иначе — статичная.
            return site && c['native.orders'] ? h('button', { type: 'button', class: 'order', dataset: { ref: B.refKey(card.ref) }, onclick: () => open(detail.id, { order: B.refKey(site) }) },
              orderCard(card, null, { button: false }).childNodes) : orderCard(card, null, { button: false });
          })));
      }
      if (staff) {
        if (c['native.orders']) {
          const nat = nativeOrders();
          const list = nat === null ? null : nat.filter((o) => nativeHistory(o) === isHistory);
          sections.push(h('div', { class: 'order-section' }, h('p', { class: 'order-section__title', text: `Заявки с сайта${list && list.some(contactDue) ? ' · связаться: ' + list.filter(contactDue).length : ''}` }),
            list === null ? h('p', { class: 'app-empty', text: 'Загрузка…' }) : list.length ? list.map((o) => orderCard({
              ref: B.makeRef('native-order', o.id), name: o.name, title: `Заявка сайта №${o.id}`, status: B.WORK_LABELS[o.work && o.work.status] || 'Новая', details: o.comment, nextAction: contactDue(o) ? FOLLOWUP_ALERT : null,
            }, detail)) : h('p', { class: 'app-empty', text: 'Нет заявок в этом списке.' })));
        } else sections.push(h('p', { class: 'hint', text: 'Заявки и переписка доступны участнику Palitra Love с правом просмотра CRM.' }));
        if (!c['portal.staff']) sections.push(h('p', { class: 'hint', text: 'CRM Palitra: нет подтверждённой сессии сотрудника portal.' }));
      }
      out.push(h('div', { class: 'order-group', role: 'region', 'aria-label': label }, sections));
    }
    for (const b of blocks(frame, 'button')) { if (b.orderGroup) continue; const t = frameById(b.target); if (t && t.kind === 'detail') continue; out.push(buttonBlock(b)); }
    return out;
  }
  function orderCard(o, detail, { button = true } = {}) {
    const kids = [o.name ? h('span', { class: 'order__client', text: o.name }) : null,
      h('span', { class: 'order__head' }, h('strong', { text: o.title }), o.status ? h('span', { class: 'order__status', text: o.status }) : null),
      h('span', { class: 'order__ns', text: o.ref.ns === 'native-order' ? 'заявка с сайта' : o.ref.ns === 'crm-inquiry' ? 'заявка (до оформления заказа)' : 'заказ CRM' }),
      o.nextAction ? h('span', { class: 'order__stage', text: `Следующий шаг: ${o.nextAction}` }) : null,
      o.details ? h('span', { class: 'order__details', text: o.details }) : null,
      button ? h('span', { class: 'order__more', text: 'Открыть →' }) : null];
    return button && detail ? h('button', { type: 'button', class: 'order', dataset: { ref: B.refKey(o.ref) }, onclick: () => open(detail.id, { order: B.refKey(o.ref) }) }, kids)
      : h('div', { class: 'order order--static', dataset: { ref: B.refKey(o.ref) } }, kids);
  }

  /* ---------- заказ клиента (CRM portal customer) ---------- */
  function clientDetail(frame) {
    const inquiry = paramRef('order', 'crm-inquiry');
    if (inquiry) return clientRequestDetail(frame, inquiry);
    const ref = paramRef('order', 'crm-order');
    if (!ref) return [h('p', { class: 'app-empty', text: 'Откройте заказ из списка.' })];
    const d = state.detail;
    if (!d) return [h('p', { class: 'app-empty', text: 'Загрузка…' })];
    if (d.missing) return [h('p', { class: 'app-empty', text: 'Заказ не найден.' })];
    const chat = mobileFrame('client', 'chat');
    return frame.blocks.map((b) => {
      if (b.type === 'status') return h('section', { class: 'statuses' }, h('h2', { class: 'text__title', text: str(b.title) || 'Статус' }), h('p', { class: 'status is-active', text: d.stageLabel || '' }),
        Array.isArray(d.history) && d.history.length ? h('ul', { class: 'history' }, d.history.map((x) => h('li', { text: `${fmtDate(x.createdAt)} · ${x.label}` }))) : null);
      if (b.type === 'order') return orderCard({ ref, name: auth.portal && auth.portal.name, title: `Заказ №${ref.id}`, status: d.stageLabel, details: d.wishes }, null, { button: false });
      if (b.type === 'button') { const t = frameById(b.target); if (chat && t && t.kind === 'chat') return buttonBlock(b, () => open(chat.id, { order: B.refKey(ref) }), ' app-btn--big'); return buttonBlock(b); }
      return genericBlock(b);
    }).filter(Boolean);
  }

  function clientRequestDetail(frame, ref) {
    if (!state.bootstrap) return [h('p', { class: 'app-empty', text: 'Загрузка…' })];
    const r = B.parsePortalRequests(state.bootstrap).find((x) => B.sameRef(x.ref, ref));
    if (!r) return [h('p', { class: 'app-empty', text: 'Заявка не найдена.' })];
    const chat = mobileFrame('client', 'chat');
    return frame.blocks.map((b) => {
      if (b.type === 'status') return h('section', { class: 'statuses' }, h('h2', { class: 'text__title', text: str(b.title) || 'Статус' }), h('p', { class: 'status is-active', text: 'Заявка получена' }),
        h('p', { class: 'muted', text: 'Заказ оформит менеджер после согласования; этапы появятся здесь.' }));
      if (b.type === 'order') return orderCard({ ref, name: auth.portal && auth.portal.name, title: r.site ? `Заявка №${r.site.id}` : `Обращение №${ref.id}`, status: 'Получена', details: fmtDate(r.createdAt) }, null, { button: false });
      if (b.type === 'button') {
        const t = frameById(b.target);
        if (chat && t && t.kind === 'chat') {
          // Чат — только по ссылке на собственную native-заявку; доступ проверит E grant и совпадение thread.orderId.
          const button = buttonBlock(b, r.site ? () => open(chat.id, { order: B.refKey(ref), site: B.refKey(r.site) }) : () => {}, ' app-btn--big');
          if (!r.site) button.disabled = true;
          return h('div', { class: 'blk' }, button, r.site ? null : h('p', { class: 'muted', text: 'Связь этой заявки с перепиской сервер не передаёт — чат здесь не открывается.' }));
        }
        return buttonBlock(b);
      }
      return genericBlock(b);
    }).filter(Boolean);
  }

  /* ---------- карточка сотрудника: CRM или заявка сайта ---------- */
  function staffDetail(frame) {
    const ref = paramRef('order');
    if (!ref || (ref.ns !== 'crm-order' && ref.ns !== 'native-order')) return [h('p', { class: 'app-empty', text: 'Откройте заказ из списка заказов.' })];
    // Прямой адрес не обходит права: без подтверждённого доступа карточка не запрашивается.
    if (ref.ns === 'native-order' && !caps()['native.orders']) return [h('p', { class: 'hint', text: 'Нет подтверждённого доступа к CRM Palitra Love.' })];
    if (ref.ns === 'crm-order' && !caps()['portal.staff']) return [h('p', { class: 'hint', text: 'Карточка CRM доступна сотруднику с подтверждённой сессией portal.' })];
    const d = state.detail;
    if (!d) return [h('p', { class: 'app-empty', text: 'Загрузка…' })];
    if (d.missing) return [h('p', { class: 'app-empty', text: 'Заказ не найден.' })];
    return ref.ns === 'crm-order' ? crmDetail(frame, ref, d) : nativeDetail(frame, ref, d.native);
  }
  function directContact(channel, contact) {
    const target = B.contactLink(channel, contact);
    const label = `Связаться · ${CHANNEL_LABEL[channel] || channel}`;
    const box = h('div', { class: 'contact' }, h('p', { class: 'contact__value' }, h('span', { class: 'muted', text: `${CHANNEL_LABEL[channel] || channel}: ` }), h('span', { class: 'contact__raw', text: str(contact) })));
    if (!target) box.append(h('button', { type: 'button', class: 'app-btn app-btn--ghost', disabled: true, text: label }), h('p', { class: 'contact__hint', text: 'Контакт не распознан для ссылки — свяжитесь вручную.' }));
    else if (target.kind === 'copy') box.append(h('button', { type: 'button', class: 'app-btn app-btn--ghost', text: `${label} (копировать)`, onclick: () => (preview ? toast('Предпросмотр: контакт подготовлен к копированию') : copyText(target.text)) }));
    else box.append(h('a', { class: 'app-btn app-btn--ghost contact__btn', href: target.href, ...(target.kind === 'url' ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
      onclick: (e) => { if (preview) { e.preventDefault(); toast(`Предпросмотр: подготовлено ${target.href}`); } } }, label));
    box.append(h('p', { class: 'contact__hint', text: 'Нажатие не отмечает, что связь состоялась или клиент ответил.' }));
    return box;
  }
  function copyText(text) {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') { toast('Копирование недоступно — выделите контакт вручную.'); return; }
    navigator.clipboard.writeText(text).then(() => toast('Контакт скопирован'), () => toast('Не удалось скопировать — выделите контакт вручную.'));
  }
  function crmDetail(frame, ref, d) {
    const staffChatFrame = mobileFrame(state.role, 'chat');
    const stages = B.CRM_STAGES, index = stages.indexOf(d.stage);
    const next = index >= 0 ? stages[index + 1] : null;
    const noteKey = draftKey('note', ref);
    const out = [orderCard({ ref, name: d.name, title: `Заказ №${ref.id}`, status: d.stageLabel, details: d.wishes }, null, { button: false })];
    if (d.customer) out.push(h('section', { class: 'customer' }, h('p', { class: 'customer__title', text: 'Клиент' }), h('p', { class: 'customer__name', text: str(d.customer.name) }),
      directContact(d.customer.channel, d.customer.contact)));
    out.push(h('section', { class: 'sales' }, h('h2', { class: 'text__title', text: 'Этап заказа (сервер CRM)' }),
      h('ol', { class: 'sales__chips' }, stages.map((s, i) => h('li', { class: `sales__chip${i < index ? ' is-done' : ''}${i === index ? ' is-current' : ''}`, text: B.CRM_STAGE_LABELS[s] }))),
      d.nextAction ? h('p', { class: 'sales__hint' }, h('strong', { text: 'Что сделать: ' }), d.nextAction) : null,
      next && d.status === 'active' ? h('button', { type: 'button', class: 'app-btn', dataset: { action: 'stage-next' }, disabled: inflight.has(`stage:${draftKey('stage', ref)}`), onclick: () => crmStage(ref, d, next) }, `Перейти к этапу «${B.CRM_STAGE_LABELS[next]}»`) : null,
      h('p', { class: 'muted', text: 'Доступен только следующий этап; условия (состав, оплата, фото, дата) проверяет сервер.' })));
    out.push(h('section', { class: 'customer' }, h('label', { class: 'field', for: 'note-text' }, h('span', { class: 'field__label', text: 'Заметка к заказу' })),
      h('textarea', { id: 'note-text', class: 'app-input', rows: '2', maxlength: '2000', value: drafts.get(noteKey) || '', dataset: { focus: `note-${B.refKey(ref)}` }, oninput: (e) => { drafts.set(noteKey, e.target.value); } }),
      h('button', { type: 'button', class: 'app-btn app-btn--small app-btn--ghost', text: 'Сохранить заметку', onclick: () => crmNote(ref) }),
      Array.isArray(d.notes) && d.notes.length ? h('ul', { class: 'customer__notes' }, d.notes.map((n) => h('li', {}, h('span', { class: 'customer__note-ch', text: `${str(n.author)} · ${fmtDate(n.createdAt)}` }), h('span', { text: str(n.text) })))) : null));
    out.push(notifyCard(d));
    // Номер заказа CRM не превращается в номер заявки/диалога: чат — только по серверной связи siteOrderId.
    const site = B.makeRef('native-order', d.siteOrderId);
    for (const b of blocks(frame, 'button')) {
      const t = frameById(b.target);
      if (!(t && t.kind === 'chat')) continue;
      const detail = mobileFrame(state.role, 'detail');
      const button = buttonBlock(b, site && detail ? () => open(detail.id, { order: B.refKey(site) }) : () => {}, ' app-btn--big');
      if (!site || !caps()['native.orders'] || !staffChatFrame) button.disabled = true;
      out.push(h('div', { class: 'blk' }, button, h('p', { class: 'muted', text: site ? `Переписка — в заявке сайта №${site.id}.` : 'У заказа CRM нет связанной заявки сайта: переписка здесь не открывается.' })));
    }
    return out;
  }
  function notifyCard(d) {
    const status = d.notification && typeof d.notification.status === 'string' ? d.notification.status : 'not_configured';
    const first = d.firstReply && typeof d.firstReply === 'object' ? d.firstReply : null;
    return h('section', { class: 'notice' }, h('span', { class: 'notice__badge', text: 'Уведомления' }),
      h('p', { text: `Уведомление команды: ${status === 'not_configured' ? 'не настроено' : status}` }),
      h('p', { class: 'muted', text: first ? `Ожидание ответа клиента: до ${fmtDate(first.dueAt)} · ${str(first.state)}` : '«5 минут без сообщения клиента» — отдельная серверная связка в существующем планировщике, пока не подключена. Оболочка своего таймера не ведёт.' }));
  }
  async function crmAction(ref, body, success, lockKey) {
    if (inflight.has(lockKey)) return false;   // F2: второй клик во время await — без второго действия
    inflight.add(lockKey);
    const epoch = tickets.epoch, key = contextKey();
    let done = false;
    try {
      const pending = bridge.call('portal.order.action', { ref, body }, { order: state.detail });
      render();   // кнопка этапа недоступна, пока ждём ответ
      const data = await pending;
      if (epoch !== tickets.epoch) return false;
      const receipt = B.parseCrmAction(data, ref);   // F1: { ok, replayed, order } того же crm-order:N
      if (key === contextKey()) { tickets.commitNow('detail'); state.detail = receipt.order; }
      pendingSends.delete(lockKey);
      toast(receipt.replayed ? `${success} (повтор без дубля)` : success);
      done = true;
    } catch (error) {
      if (epoch !== tickets.epoch) return false;
      if (error.status === 401) { endSession('portal', error.message); return false; }
      if (error.code === 'UNKNOWN_OUTCOME' || error.code === 'BAD_RESPONSE') { const p = pendingSends.get(lockKey); if (p) p.unknown = true; }
      else pendingSends.delete(lockKey);
      toast(error.message);
      if (error.status === 409 && key === contextKey()) loadScreen();   // свежие данные, ввод сохраняется
    } finally { if (epoch === tickets.epoch) { inflight.delete(lockKey); render(); } }
    return done;
  }
  function crmStage(ref, d, next) {
    // Тот же requestId для той же попытки (этот заказ, version, следующий этап), пока исход не подтверждён.
    const lockKey = `stage:${draftKey('stage', ref)}`;
    const p = pendingSends.get(lockKey);
    const body = p && p.version === d.version && p.next === next ? p.body : { requestId: B.newRequestId(), action: 'stage', version: d.version, value: next };
    pendingSends.set(lockKey, { body, version: d.version, next, unknown: false });
    crmAction(ref, body, `Этап: ${B.CRM_STAGE_LABELS[next]}`, lockKey);
  }
  function crmNote(ref) {
    const key = draftKey('note', ref), text = (drafts.get(key) || '').trim();
    if (!text) { toast('Напишите заметку'); return; }
    const pendKey = `note:${key}`;
    if (inflight.has(pendKey)) return;
    const pending = pendingSends.get(pendKey);
    const body = pending && pending.text === text ? pending.body : { requestId: B.newRequestId(), action: 'note', text };
    pendingSends.set(pendKey, { text, body });
    crmAction(ref, body, 'Заметка сохранена', pendKey).then((ok) => { if (ok && state.detail && Array.isArray(state.detail.notes) && state.detail.notes.some((n) => n.text === text)) { drafts.delete(key); render(); } });
  }
  function nativeDetail(frame, ref, o) {
    const links = state.links;
    const stagePanel = workflow ? workflow.orderPanel(ref.id) : null;
    const chatFrame = mobileFrame(state.role, 'chat');
    const status = o.work && o.work.status || 'new';
    const out = [orderCard({ ref, name: o.name, title: `Заявка сайта №${ref.id}`, status: B.WORK_LABELS[status], details: o.comment }, null, { button: false }),
      h('section', { class: 'customer' }, h('p', { class: 'customer__title', text: 'Клиент' }), h('p', { class: 'customer__name', text: str(o.name) }), contactDue(o) ? h('p', { class: 'hint', role: 'status', text: FOLLOWUP_ALERT }) : null, directContact(o.contactChannel, o.contact)),
      h('section', { class: 'sales' }, h('label', { class: 'field', for: 'work-status' }, h('span', { class: 'field__label', text: 'Обработка заявки' })),
        h('select', { id: 'work-status', class: 'app-input', disabled: !caps()['native.write'], dataset: { focus: 'work-status' }, onchange: (e) => nativeWork(ref, e.target.value, status) },
          B.WORK_STATUSES.map((s) => h('option', { value: s, selected: s === status, text: B.WORK_LABELS[s] }))),
        h('p', { class: 'muted', text: 'Статус обработки отделён от доставки уведомления.' }),
        Object.entries(B.CHECKLIST_ITEMS).map(([item, label]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: Boolean(o.checklist && o.checklist[item]), disabled: !caps()['native.write'], dataset: { focus: `check-${item}` },
          onchange: (e) => nativeChecklist(ref, item, e.target.checked, o.checklist ? o.checklist.revision : 0) }), h('span', { text: label }))))];
    if (links && links.error) out.push(h('p', { class: 'app-error', text: links.error }));
    const chatButtons = [];
    if (chatFrame && links && links.thread) chatButtons.push(h('button', { type: 'button', class: 'app-btn app-btn--big', dataset: { chat: B.refKey(links.thread) }, onclick: () => open(chatFrame.id, { chat: B.refKey(links.thread), order: B.refKey(ref) }) }, 'Чат клиента (сайт)'));
    if (chatFrame && links && links.legacy) chatButtons.push(h('button', { type: 'button', class: `app-btn${links.thread ? ' app-btn--ghost' : ' app-btn--big'}`, dataset: { chat: B.refKey(links.legacy) }, onclick: () => open(chatFrame.id, { chat: B.refKey(links.legacy), order: B.refKey(ref) }) }, links.thread ? 'Прежняя переписка в боте (отдельная история)' : 'Чат клиента (бот)'));
    if (links && !links.thread && !links.legacy && !links.error) chatButtons.push(h('p', { class: 'muted', text: 'У этой заявки нет переписки.' }));
    if (!links) chatButtons.push(h('p', { class: 'muted', text: 'Проверяем переписку…' }));
    if (stagePanel) out.splice(1, 0, stagePanel);
    out.push(h('div', { class: 'blk' }, chatButtons), notifyCard({}));
    return out;
  }
  async function nativeWrite(name, ref, body, success) {
    if (!caps()['native.write']) { toast('Нет права изменять CRM.'); return; }
    const epoch = tickets.epoch, key = contextKey();
    try {
      await bridge.call(name, { ref, body });
      if (epoch !== tickets.epoch) return;
      toast(success);
    } catch (error) {
      if (epoch !== tickets.epoch) return;
      if (error.status === 401) { endSession('cabinet', error.message); return; }
      toast(error.message);
    }
    if (key === contextKey()) loadScreen();   // точное состояние — повторным чтением
  }
  const nativeWork = (ref, status, expected) => nativeWrite('native.order.work', ref, { status, expected }, `Статус: ${B.WORK_LABELS[status]}`);
  const nativeChecklist = (ref, item, checked, revision) => nativeWrite('native.order.checklist', ref, { item, checked, revision: Number.isSafeInteger(revision) ? revision : 0 }, 'Отметка сохранена');

  /* ---------- переписка сотрудника: legacy:N и thread:N — разные истории ---------- */
  function staffChat(frame) {
    const ref = paramRef('chat');
    if (!ref || (ref.ns !== 'legacy' && ref.ns !== 'thread')) return [h('p', { class: 'app-empty', text: 'Откройте переписку из карточки заявки.' })];
    if (!caps()['native.orders']) return [h('p', { class: 'hint', text: 'Нет подтверждённого доступа к переписке CRM Palitra Love.' })];
    const data = state.chat;
    if (!data) return [h('p', { class: 'app-empty', text: 'Загрузка…' })];
    const order = paramRef('order', 'native-order'), detail = mobileFrame(state.role, 'detail');
    const name = ref.ns === 'legacy' ? data.dialog && data.dialog.name : data.thread && data.thread.name;
    const kind = ref.ns === 'legacy' ? { max: 8000, op: 'legacy.reply', label: 'Ответ клиенту в Telegram' } : { max: 4000, op: 'thread.reply', label: 'Ответ клиенту (чат сайта)' };
    const stagePanel = order && workflow ? workflow.orderPanel(order.id) : null;
    return [stagePanel, chatView({ name: str(name), readOnly: !caps()['native.write'], subtitle: ref.ns === 'legacy' ? 'Переписка в боте' : 'Чат на сайте', messages: data.messages, mine: ['operator', 'manager', 'owner'],
      orderButton: order && detail ? { label: `Заявка №${order.id}`, go: () => open(detail.id, { order: B.refKey(order) }) } : null,
      draft: draftKey('chat', ref), max: kind.max, placeholder: kind.label, send: () => staffReply(ref, kind) }),
    ref.ns === 'thread' && auth.e1Native !== true ? h('p', { class: 'muted', text: 'Переписка сейчас недоступна. Свяжитесь с клиентом выбранным им способом.' }) : null,
    ...blocks(frame, 'text').map(genericBlock)].filter(Boolean);
  }
  function chatView({ name, subtitle, messages, mine, orderButton, draft, max, placeholder, send, readOnly = false }) {
    const list = h('div', { class: 'chat__list', 'aria-live': 'polite' }, (Array.isArray(messages) ? messages : []).map((m) => h('div', { class: `chat__msg ${mine.includes(m.author) ? 'is-mine' : 'is-theirs'}` },
      h('span', { class: 'chat__meta', text: CHANNEL_AUTHOR[m.author] || str(m.author) }), h('span', { class: 'chat__text', text: str(m.text) }))));
    const input = h('textarea', { class: 'app-input chat__input', disabled: readOnly, rows: '1', maxlength: String(max), placeholder, value: drafts.get(draft) || '', 'aria-label': placeholder, dataset: { focus: `chat-${draft}` },
      oninput: (e) => { drafts.set(draft, e.target.value); lastChatInput = Date.now(); },
      oncompositionstart: () => { composing = true; }, oncompositionend: () => { composing = false; lastChatInput = Date.now(); }, onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!readOnly) send(); } } });
    return h('div', { class: 'chat' },
      h('div', { class: 'chat__head' }, h('div', { class: 'chat__who' }, h('strong', { class: 'chat__client', text: name || 'Клиент' }), h('span', { class: 'chat__title', text: subtitle })),
        orderButton ? h('button', { type: 'button', class: 'chat__order', onclick: orderButton.go }, orderButton.label) : null),
      h('button', { type: 'button', class: 'chat__order chat__refresh', dataset: { chatRefresh: 'manual' }, disabled: chatRefreshing, onclick: () => refreshChat() }, chatRefreshing ? 'Обновляем…' : 'Обновить переписку'),
      list, h('form', { class: 'chat__compose', novalidate: true, onsubmit: (e) => { e.preventDefault(); if (!readOnly) send(); } }, input,
        h('button', { type: 'submit', class: 'app-btn app-btn--small', disabled: readOnly || inflight.has(draft), text: inflight.has(draft) ? 'Отправляется…' : 'Отправить' })));
  }
  const CHANNEL_AUTHOR = { client: 'Клиент', customer: 'Клиент', operator: 'Менеджер', manager: 'Менеджер', owner: 'Владелец', shop: 'Palitra Love', system: 'Бот' };
  async function sendWithReceipt({ draft, op, ref, bodyFor, receiptKind, receiptTarget, space }) {
    if (inflight.has(draft)) return;   // F2: эта отправка уже в полёте — второй клик/Enter/submit ничего не создаёт
    const text = (drafts.get(draft) || '').trim();
    if (!text) return;
    const pend = pendingSends.get(draft);
    // Неизвестный исход: тот же requestId и то же тело; новая отправка не считается проверкой первой.
    const body = pend && pend.unknown ? pend.body : bodyFor(text, B.newRequestId());
    if (pend && pend.unknown && pend.text !== text) { toast('Исход прошлой отправки неизвестен: повторите её без изменений текста.'); return; }
    pendingSends.set(draft, { body, text, unknown: false });
    inflight.add(draft);
    const epoch = tickets.epoch, key = contextKey();
    try {
      const pending = bridge.call(op, ref ? { ref, body } : { body });
      render();   // кнопка «Отправляется…» недоступна, пока ждём ответ
      const data = await pending;
      if (epoch !== tickets.epoch) return;
      if (!B.receiptOk(receiptKind, receiptTarget, data)) throw Object.assign(new Error('Ответ сервера не подтвердил отправку — исход неизвестен'), { code: 'UNKNOWN_OUTCOME' });
      drafts.delete(draft); pendingSends.delete(draft);
      if (key === contextKey()) loadScreen();
    } catch (error) {
      if (epoch !== tickets.epoch) return;
      if (error.status === 401) { endSession(space, error.message); return; }
      if (error.code === 'UNKNOWN_OUTCOME') pendingSends.set(draft, { body, text, unknown: true });
      else pendingSends.delete(draft);
      toast(error.message);
    } finally { if (epoch === tickets.epoch) inflight.delete(draft); }
    render();
  }
  function staffReply(ref, kind) {
    if (!caps()['native.write']) { toast('Нет права отвечать клиенту.'); return; }
    sendWithReceipt({ draft: draftKey('chat', ref), op: kind.op, ref, bodyFor: (text, requestId) => ({ requestId, text }), receiptKind: ref.ns, receiptTarget: ref, space: 'cabinet' });
  }

  /* ---------- чат покупателя (E/R1 предпросмотр) ---------- */
  function clientChat(frame) {
    const c = caps();
    const chatBlock = blocks(frame, 'chat')[0] || {};
    if (!c['customer.chat']) return [h('div', { class: 'app-empty' }, h('p', { text: 'Чтобы открыть переписку по заявке, войдите в свой аккаунт Palitra Love. Если вход уже выполнен, обновите страницу.' })), ...blocks(frame, 'text').map(genericBlock).filter(Boolean)];
    const threads = state.clientThreads, thread = state.clientThread, data = state.chat;
    if (!threads) return [h('p', { class: 'app-empty', text: 'Загрузка…' })];
    const order = paramRef('order', 'crm-order') || paramRef('order', 'crm-inquiry'), site = paramRef('site', 'native-order');
    const detail = mobileFrame('client', 'detail'), self = mobileFrame('client', 'chat');
    if (!thread) {
      const why = state.clientThreadMismatch
        ? 'Эта переписка не найдена среди ваших чатов в текущей сессии или относится к другой заявке — она не открыта. Выберите свою переписку из списка.'
        : site ? `Переписка по заявке №${site.id} в текущей сессии чата не найдена. Доступ к чату даёт только сессия, в которой заявка отправлена.`
          : order ? `Связь заказа №${order.id} с чатом сервер не подтвердил — откройте нужную переписку сами.` : 'Откройте переписку по нужной заявке.';
      // Нет подтверждённой связи заказа с чатом: явный выбор своего чата; отправки до выбора нет.
      return [h('section', { class: 'card' }, h('h2', { class: 'text__title', text: 'Выберите переписку' }),
        h('p', { class: `muted${state.clientThreadMismatch ? ' is-error' : ''}`, dataset: { chatGate: state.clientThreadMismatch ? 'mismatch' : site ? 'no-thread' : 'choose' }, text: why }),
        threads.length ? threads.map((t) => h('button', { type: 'button', class: 'app-btn app-btn--ghost', dataset: { thread: B.refKey(t.ref) },
          onclick: () => open(self.id, { ...(order ? { order: B.refKey(order) } : {}), chat: B.refKey(t.ref) }) },
        t.orderRef ? `Переписка по заявке сайта №${t.orderRef.id}` : `Переписка №${t.ref.id}`)) : h('p', { class: 'app-empty', text: 'Переписки пока нет.' })),
      ...blocks(frame, 'text').map(genericBlock).filter(Boolean)];
    }
    if (!data) return [h('p', { class: 'app-empty', text: 'Загрузка…' })];
    const own = threads.find((t) => B.sameRef(t.ref, thread));
    const questionnaire = workflow ? workflow.questionnairePanel(B.refKey(thread), data.autoReplyQuestions, async (text) => {
      const key = draftKey('chat', thread);
      if ((drafts.get(key) || '').trim()) throw new Error('В поле сообщения уже есть текст. Сначала отправьте его или закончите редактирование.');
      drafts.set(key, text);
      await sendWithReceipt({ draft: key, op: 'customer.chat.send', ref: null, bodyFor: (bodyText, requestId) => ({ threadId: thread.id, requestId, text: bodyText }), receiptKind: 'chat', receiptTarget: thread, space: 'account' });
      if (drafts.has(key)) throw new Error('Ответы ещё не подтверждены сервером. Проверьте поле сообщения и повторите ту же отправку.');
    }) : null;
    return [workflow ? workflow.onboardingPanel('client', 'chat') : null, questionnaire, chatView({ name: auth.portal ? auth.portal.name : 'Вы', subtitle: own && own.orderRef ? `Заявка сайта №${own.orderRef.id}` : str(chatBlock.title) || 'Менеджер Palitra', messages: data.messages, mine: ['customer'],
      orderButton: order && detail && state.clientThreadLinked ? { label: order.ns === 'crm-inquiry' && own && own.orderRef ? `Заявка №${own.orderRef.id}` : `Заказ №${order.id}`, go: () => open(detail.id, { order: B.refKey(order) }) } : null,
      draft: draftKey('chat', thread), max: 4000, placeholder: str(chatBlock.placeholder) || 'Сообщение', send: () => sendWithReceipt({ draft: draftKey('chat', thread), op: 'customer.chat.send', ref: null,
        bodyFor: (text, requestId) => ({ threadId: thread.id, requestId, text }), receiptKind: 'chat', receiptTarget: thread, space: 'account' }) }),
    preview ? h('p', { class: 'muted', text: 'Предпросмотр чата сайта E/R1: синтетические сообщения, native0.' }) : null, ...blocks(frame, 'text').map(genericBlock).filter(Boolean)].filter(Boolean);
  }

  /* ---------- отзыв и отчёты ---------- */
  function reviewScreen(frame) {
    return [h('p', { class: 'hint', text: 'Отправка отзыва пока недоступна. Вы можете написать менеджеру в чате заказа.' }),
      ...blocks(frame, 'input').map((b) => h('label', { class: 'field' }, h('span', { class: 'field__label', text: str(b.label) }), h('input', { class: 'app-input', type: 'text', placeholder: str(b.placeholder), disabled: true }))),
      ...blocks(frame, 'button').map((b) => h('button', { type: 'button', class: 'app-btn app-btn--ghost', disabled: true, text: str(b.label) }))];
  }
  function reportsScreen(frame) {
    const texts = blocks(frame, 'text').map(genericBlock).filter(Boolean);
    if (!caps()['portal.summary']) return [...texts, h('p', { class: 'hint', text: 'Отчёты доступны собственнику после входа в его аккаунт. Если вы уже вошли, обновите страницу.' })];
    const s = state.summary;
    if (!s) return [...texts, h('p', { class: 'app-empty', text: 'Загрузка…' })];
    const row = (k, v) => [h('dt', { text: k }), h('dd', { text: String(v) })];
    return [...texts, h('section', { class: 'card' }, h('h2', { class: 'text__title', text: 'Сводка CRM' }), h('dl', { class: 'report' },
      row('Активные заказы', s.orders.active), row('Выполнены', s.orders.done), row('Отменены', s.orders.cancelled), row('Просрочены', s.orders.overdue),
      ...B.CRM_STAGES.map((st) => row(B.CRM_STAGE_LABELS[st], (s.orders.byStage || {})[st] ?? 0)),
      ...Object.entries(s.bySource30d || {}).map(([k, v]) => row(`Источник 30 дн.: ${k}`, v))))];
  }

  /* ---------- запуск ---------- */
  render();
  if (bridge && preview) signIn(HOST.initialPreview && HOST.service.PREVIEW[HOST.initialPreview] ? HOST.initialPreview : 'client');
  else if (bridge) signIn('');
  // Доверенный host сообщает о смене/отзыве identity (выход, другой пользователь): новая эпоха, данные/черновики/фреймы очищаются.
  if (bridge && !preview && typeof HOST.onAuthChange === 'function') HOST.onAuthChange(() => signIn(''));
  window.PalitraShellDebug = preview ? Object.freeze({ state, auth, nav, drafts, frameSlots, signIn, open }) : undefined;
})();
