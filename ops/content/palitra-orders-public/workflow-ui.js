/* Palitra Love: этапы, автоответ и установка. Данные только через внедрённый same-origin host.
   Этот модуль не даёт прав по роли экрана и не создаёт клиентов, чаты, уведомления или свою БД. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.defineProperty(root, 'PalitraWorkflowUI', { value: api, writable: false });
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const REQUIREMENTS = Object.freeze({ contact_confirmed: 'Связались с клиентом', details_confirmed: 'Детали заказа согласованы', payment_confirmed: 'Оплата подтверждена', photo_sent: 'Фото отправлено клиенту', handover_confirmed: 'Заказ передан клиенту', feedback_requested: 'Отзыв запрошен' });
  const CHANNELS = Object.freeze({ app: 'Чат приложения', phone: 'Телефон', telegram: 'Telegram', whatsapp: 'WhatsApp' });
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const idOk = (id) => Number.isSafeInteger(id) && id > 0;
  function create({ document: doc, window: win, request, memoUpload, onUnauthorized = () => {}, onChanged = () => {}, onState = () => {}, now = () => Date.now() }) {
    const h = (tag, props, ...children) => {
      const el = doc.createElement(tag);
      for (const [key, value] of Object.entries(props || {})) {
        if (value == null || value === false) continue;
        if (key === 'text') el.textContent = String(value);
        else if (['value', 'checked', 'disabled', 'selected'].includes(key)) el[key] = value;
        else if (key === 'class') el.className = value;
        else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
        else el.setAttribute(key, value === true ? '' : String(value));
      }
      for (const child of children.flat(Infinity)) if (child != null && child !== false) el.append(typeof child === 'object' ? child : String(child));
      return el;
    };
    const button = (text, onclick, props = {}) => h('button', { type: 'button', class: 'app-btn app-btn--ghost', text, onclick, ...props });
    const field = (label, input) => h('label', { class: 'field' }, h('span', { class: 'field__label', text: label }), input);
    const input = (value, oninput, props = {}) => h('input', { type: 'text', class: 'app-input', value, oninput: (e) => oninput(e.target.value), ...props });
    const textarea = (value, oninput, props = {}) => h('textarea', { rows: '3', class: 'app-input', value, oninput: (e) => oninput(e.target.value), ...props });
    const help = text => win.PalitraHelp ? win.PalitraHelp.button(text) : msg(text);
    const msg = (text, error = false) => h('p', { class: error ? 'app-error' : 'muted', role: error ? 'alert' : 'status', text });
    let identity = { key: '', role: '', member: false, permissions: [] }, epoch = 0;
    let settings = null, widgetSettings = null, completionSettings = null, funnelReport = null;
    const orders = new Map();
    const questionnaires = new Map();
    let installEvent = null, installed = false, onboardingExpanded = false, pushStatus = '', installBusy = false;
    const onboardingRoots = new Set();
    const guideExpandedImages = new Set();
    const onboardingFocus = new WeakMap();
    const memoryPrefs = new Map();
    // Клиентские карточки независимы от прежнего модального onboarding и его off/nextAt.
    const clientOfferRoots = new Map(), clientOfferEntries = new Map(), clientInstallMemory = new Map();
    const notificationDefaults = Object.freeze({"installTitle": "Заказ всегда под рукой", "notificationTitle": "Уведомления Palitra Love", "installClientText": "Добавьте Palitra Love на главный экран, чтобы возвращаться в чат и отслеживать заказ. Это необязательно.", "installStaffText": "Закрепите приложение, чтобы быстро открывать заказы и переписку.", "installedText": "Приложение уже открыто с главного экрана. Выберите, хотите ли получать уведомления на этом устройстве.", "installButton": "Установить приложение", "installHelpButton": "Как добавить на главный экран", "installBusyText": "Подтвердите в браузере…", "deviceHeading": "Уведомления на этом устройстве", "enableButton": "Включить уведомления", "disableButton": "Отключить уведомления", "laterButton": "Позже", "neverButton": "Больше не предлагать", "pushUnavailableText": "Push-уведомления пока не подключены. Заказы и сообщения проверяйте в приложении. Установка сама по себе push не включает.", "iosInstallText": "Для push на iPhone/iPad сначала добавьте приложение на экран Домой и откройте его оттуда (iOS/iPadOS 16.4 или новее).", "permissionDeniedText": "Уведомления запрещены в браузере. Откройте настройки этого сайта → «Уведомления» и разрешите их, если хотите получать push.", "subscribedText": "Уведомления подключены на этом устройстве.", "unsubscribedText": "Уведомления отключены на этом устройстве.", "permissionPromptText": "Подтвердите разрешение браузера.", "unconfirmedText": "Подписка не подтверждена сервером. Push пока не включён.", "subscribeErrorText": "Не удалось подключить уведомления. Можно продолжить без них.", "closeLabel": "Закрыть предложение", "iosStep1": "Откройте эту страницу в Safari. Если вы пришли из Telegram или другой соцсети, откройте ссылку во внешнем браузере Safari.", "iosStep2": "Нажмите «Ещё» (…) внизу справа, затем «Поделиться». В другом виде Safari кнопка «Поделиться» может быть сразу на панели.", "iosStep3": "Выберите «На экран Домой». Если пункта нет, прокрутите список действий ниже.", "iosStep4": "Оставьте «Открывать как веб-приложение» включённым, нажмите «Добавить». Открывайте Palitra Love с нового значка.", "androidStep1": "Откройте страницу в Chrome и нажмите меню ⋮ вверху справа.", "androidStep2": "Выберите «Установить приложение» или «Добавить на главный экран». Название пункта зависит от версии Chrome.", "androidStep3": "Подтвердите установку и открывайте Palitra Love с нового значка.", "desktopStep1": "Откройте меню браузера ⋮ или ….", "desktopStep2": "Выберите «Установить приложение» или «Приложения» → «Установить этот сайт как приложение».", "desktopStep3": "Подтвердите установку и открывайте Palitra Love с нового значка.", "guideExampleText": "Пример интерфейса; название сайта и пункты меню могут отличаться. У вас будет Palitra Love.", "guideImageButton": "Увеличить изображение", "guideSourceLabel": "Официальная инструкция", "guideBackButton": "Вернуться к шагам"});
    const notificationLimits = Object.freeze({"installTitle": 160, "notificationTitle": 160, "installClientText": 2000, "installStaffText": 2000, "installedText": 2000, "installButton": 120, "installHelpButton": 120, "installBusyText": 120, "deviceHeading": 160, "enableButton": 120, "disableButton": 120, "laterButton": 120, "neverButton": 120, "pushUnavailableText": 2000, "iosInstallText": 2000, "permissionDeniedText": 2000, "subscribedText": 2000, "unsubscribedText": 2000, "permissionPromptText": 2000, "unconfirmedText": 2000, "subscribeErrorText": 2000, "closeLabel": 120, "iosStep1": 400, "iosStep2": 400, "iosStep3": 400, "iosStep4": 400, "androidStep1": 400, "androidStep2": 400, "androidStep3": 400, "desktopStep1": 400, "desktopStep2": 400, "desktopStep3": 400, "guideExampleText": 400, "guideImageButton": 120, "guideSourceLabel": 120, "guideBackButton": 120});
    let notificationTexts = {}, notificationLoadedAt = 0, notificationLoading = false;
    const txt = (key) => typeof notificationTexts[key] === 'string' ? notificationTexts[key] : notificationDefaults[key];
    async function loadNotificationTexts() {
      // Only fixed public-copy routes. Never fetch or publish the private Forms board.
      if (notificationLoading || notificationLoadedAt && now() - notificationLoadedAt < 30000 || typeof win.fetch !== 'function' || !win.location) return;
      const host = win.location.hostname;
      const path = host === 'palitra-love.ru' || host === 'palitra-love-draft-1.synapsebusiness.ru' ? '/love-app/notification-texts.json'
        : host === 'synapse.synapsebusiness.ru' ? '/content/palitra/notification-texts' : null;
      if (!path) return;
      notificationLoading = true; notificationLoadedAt = now();
      try {
        const response = await win.fetch(path, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error' });
        if (!response.ok) return;
        const raw = await response.text(); if (raw.length > 131072) return;
        const body = JSON.parse(raw);
        if (!body || body.schema !== 1 || !Number.isSafeInteger(body.revision) || body.revision < 0 || !body.notificationTexts || typeof body.notificationTexts !== 'object' || Array.isArray(body.notificationTexts)) return;
        const safe = {};
        for (const key of Object.keys(body.notificationTexts)) {
          const value = body.notificationTexts[key];
          if (!Object.hasOwn(notificationLimits, key) || typeof value !== 'string' || Array.from(value).length > notificationLimits[key] || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f<>]/u.test(value)) return;
          if (notificationLimits[key] < 400 && /[\t\n\r]/u.test(value)) return;
          safe[key] = value;
        }
        if (new TextEncoder().encode(JSON.stringify(safe)).byteLength > 65536) return;
        if (JSON.stringify(safe) !== JSON.stringify(notificationTexts)) { notificationTexts = safe; repaintOnboarding(); }
      } catch (_) { /* Chat and explicit install/Push controls stay usable with defaults. */ }
      finally { notificationLoading = false; }
    }
    // Установка на устройство и режим текущего окна — разные признаки.
    const standaloneMode = () => Boolean(win.navigator && win.navigator.standalone) || Boolean(win.matchMedia && win.matchMedia('(display-mode: standalone)').matches);
    const nativeInstalled = () => installed || standaloneMode();
    function allowed(permission) { return identity.member === true && (identity.role === 'owner' || identity.permissions.includes(permission)); }
    const canRead = () => allowed('crm.view');
    const canWrite = () => allowed('crm.edit');
    const isOwner = () => identity.member === true && identity.role === 'owner';
    function setIdentity(next) {
      const sanitized = { key: typeof next.key === 'string' ? next.key : '', role: next.role || '', member: next.member === true, permissions: Array.isArray(next.permissions) ? next.permissions.filter((p) => typeof p === 'string') : [] };
      if (JSON.stringify(identity) !== JSON.stringify(sanitized)) {
        for (const state of [completionSettings, funnelReport]) if (state) for (const root of state.roots) root.replaceChildren(msg('Сеанс изменился. Откройте раздел заново.'));
        completionSettings = null; funnelReport = null;
      }
      if (JSON.stringify(identity) !== JSON.stringify(sanitized)) { for (const s of orders.values()) for (const root of s.roots) if (root.adviceOnly) root.replaceChildren(); epoch++; settings = null; if (widgetSettings) for (const root of widgetSettings.roots) root.replaceChildren(msg('Сеанс изменился. Откройте настройки заново.')); widgetSettings = null; orders.clear(); questionnaires.clear(); for (const root of onboardingRoots) root.remove(); onboardingRoots.clear(); for (const s of clientOfferRoots.values()) s.root.remove(); clientOfferRoots.clear(); onboardingExpanded = false; pushStatus = ''; guideExpandedImages.clear(); }
      identity = sanitized;
    }
    async function call(path, method = 'GET', body) {
      if (!request) throw new Error('Этапы заказа ещё не подключены. Обновите страницу позже.');
      try { return await request(path, { method, ...(body === undefined ? {} : { body }) }); }
      catch (error) { if (error.status === 401) onUnauthorized(error); throw error; }
    }
    const requestId = () => win.crypto && typeof win.crypto.randomUUID === 'function' ? win.crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.floor(Math.random() * 16); return (c === 'x' ? r : (r & 3) | 8).toString(16); });
    function resultConfig(data) { const value = data && data.config || data; if (!value || !Number.isSafeInteger(value.revision) || !value.autoReply || !Array.isArray(value.stages)) throw new Error('Сервер не подтвердил настройки.'); return value; }
    const resourceRef = id => typeof id==='string' && /^thread:[1-9]\d{0,14}$/.test(id) ? id : `native-order:${id}`;
    const resourcePath = id => typeof id==='string' ? `threads/${id.slice(7)}` : `orders/${id}`;
    const resourceOk = id => idOk(id) || typeof id==='string' && /^thread:[1-9]\d{0,14}$/.test(id);
    function resultOrder(data, orderId) { const value = data && data.order || data; if (!value || (value.orderRef !== resourceRef(orderId) && !(typeof orderId==='string' && value.threadRef===orderId && /^native-order:[1-9]\d{0,14}$/.test(value.orderRef))) || !Number.isSafeInteger(value.revision) || !Array.isArray(value.stages) || !Array.isArray(value.missing)) throw new Error('Сервер не подтвердил этап именно этого заказа.'); return value; }
    // Independent website-chat settings. Orders keep their existing settings and receipts.
    const WIDGET_SETTINGS_PATH = '/content/palitra/workflow/widget-settings';
    const widgetPlain = (v, max, empty = true) => typeof v === 'string' && v.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v) && (empty || Boolean(v.trim()));
    async function widgetCall(path, method = 'GET', body) {
      let timer;
      try { return await Promise.race([call(path, method, body), new Promise((_, reject) => { timer = win.setTimeout(() => reject(new Error('Не удалось подтвердить результат. Проверьте сохранение.')), 15000); })]); }
      finally { win.clearTimeout(timer); }
    }
    function widgetValue(value) {
      const keys = (v, expected) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === expected.slice().sort().join(',');
      const clean = { revision: value && value.revision, welcomeText: value && value.welcomeText, autoReply: value && value.autoReply, contact: value && value.contact, invitation: value && value.invitation, appearance: value && value.appearance };
      if (!keys(value, Object.hasOwn(value || {}, 'duplicate') ? [...Object.keys(clean), 'duplicate'] : Object.keys(clean)) || !Number.isSafeInteger(clean.revision) || clean.revision < 0
        || Object.hasOwn(value, 'duplicate') && typeof value.duplicate !== 'boolean' || !widgetPlain(clean.welcomeText, 1200)
        || !keys(clean.autoReply, ['enabled', 'text']) || typeof clean.autoReply.enabled !== 'boolean' || !widgetPlain(clean.autoReply.text, 3000, !clean.autoReply.enabled)
        || !keys(clean.contact, ['enabled', 'text']) || typeof clean.contact.enabled !== 'boolean' || !widgetPlain(clean.contact.text, 300, !clean.contact.enabled)
        || !keys(clean.invitation, ['enabled', 'text', 'delaySeconds']) || typeof clean.invitation.enabled !== 'boolean' || !widgetPlain(clean.invitation.text, 300, !clean.invitation.enabled)
        || !Number.isInteger(clean.invitation.delaySeconds) || clean.invitation.delaySeconds < 0 || clean.invitation.delaySeconds > 3600
        || !keys(clean.appearance, ['width', 'height', 'radius', 'accent']) || !Number.isInteger(clean.appearance.width) || clean.appearance.width < 280 || clean.appearance.width > 440
        || !Number.isInteger(clean.appearance.height) || clean.appearance.height < 360 || clean.appearance.height > 680 || !Number.isInteger(clean.appearance.radius) || clean.appearance.radius < 12 || clean.appearance.radius > 40
        || typeof clean.appearance.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(clean.appearance.accent)) throw new Error('Сервер не подтвердил настройки чата на сайте.');
      return copy(clean);
    }
    const widgetSame = (value, body) => ['welcomeText', 'autoReply', 'contact', 'invitation', 'appearance'].every(key => JSON.stringify(value[key]) === JSON.stringify(body[key]));
    function widgetSettingsPanel() {
      if (!isOwner()) return h('section', { class: 'card workflow', 'data-widget-settings': 'forbidden' }, msg('Настройки чата доступны администратору.'));
      if (!widgetSettings) widgetSettings = { data: null, draft: null, loading: false, saving: false, pending: null, error: '', message: '', roots: new Set() };
      for (const old of widgetSettings.roots) if (!old.isConnected) widgetSettings.roots.delete(old);
      const root = h('section', { class: 'card workflow', 'data-widget-settings': 'settings' });
      widgetSettings.roots.add(root); paintWidget(root);
      if (!widgetSettings.data && !widgetSettings.loading && !widgetSettings.error) readWidgetSettings();
      return root;
    }
    function paintAllWidget() { if (widgetSettings) for (const root of widgetSettings.roots) if (root.isConnected) paintWidget(root); }
    async function readWidgetSettings({ reset = false } = {}) {
      const s = widgetSettings, token = epoch; if (!isOwner() || !s || s.loading || s.saving) return;
      s.loading = true; s.error = ''; paintAllWidget();
      try {
        const value = widgetValue(await widgetCall(WIDGET_SETTINGS_PATH));
        if (token !== epoch || s !== widgetSettings || !isOwner()) return;
        const cleanDraft = !s.draft || s.data && widgetSame(s.draft, s.data);
        s.data = value;
        if (s.pending && value.revision > s.pending.expectedRevision && widgetSame(value, s.pending)) {
          s.pending = null; s.draft = copy(value); s.conflict = false; s.message = 'Настройки сохранены.';
        } else if (!s.draft || reset || cleanDraft) { s.draft = copy(value); s.conflict = false; s.message = ''; }
        else if (value.revision !== s.draft.revision) { s.conflict = true; s.error = 'На сервере другая версия. Выберите настройки с сервера или явно сохраните свои правки поверх неё.'; }
      } catch (error) { if (token === epoch && s === widgetSettings) s.error = error.message; }
      finally { if (token === epoch && s === widgetSettings) { s.loading = false; paintAllWidget(); } }
    }
    function paintWidget(root) {
      const s = widgetSettings; if (!s) return;
      const header = h('h2', { class: 'text__title', text: 'Чат на сайте' });
      if (s.pending && !s.saving) {
        root.replaceChildren(header, msg(s.error || 'Исход сохранения ещё не подтверждён.', true), msg('Правки сохранены в этой вкладке. Проверка прочитает настройки, повтор отправит тот же запрос.'),
          button('Проверить сохранение', () => readWidgetSettings(), { disabled: s.loading }), button('Повторить то же сохранение', saveWidgetSettings, { disabled: s.loading })); return;
      }
      if (!s.draft) { root.replaceChildren(header, msg(s.loading ? 'Загружаем настройки…' : s.error || 'Загружаем настройки…', Boolean(s.error)), ...(!s.loading && s.error ? [button('Повторить чтение', () => readWidgetSettings())] : [])); return; }
      const draft = s.draft, busy = s.saving || s.loading;
      const preview = h('div', { class: 'card', 'data-widget-preview': '', 'aria-label': 'Предпросмотр чата' });
      const paintPreview = () => {
        const color = /^#[0-9a-f]{6}$/i.test(draft.appearance.accent) ? draft.appearance.accent : '#69723e';
        const radius = Number.isInteger(draft.appearance.radius) && draft.appearance.radius >= 12 && draft.appearance.radius <= 40 ? draft.appearance.radius : 28;
        preview.style.borderRadius = `${radius}px`; preview.style.border = `1px solid ${color}`; preview.style.maxWidth = `${draft.appearance.width >= 280 && draft.appearance.width <= 440 ? draft.appearance.width : 360}px`; preview.style.minHeight = `${draft.appearance.height >= 360 && draft.appearance.height <= 680 ? Math.round(draft.appearance.height / 2) : 260}px`;
        preview.replaceChildren(h('strong', { text: 'Palitra Love' }), ...(draft.invitation.enabled ? [h('p', { text: draft.invitation.text })] : []), h('p', { text: draft.welcomeText }),
          ...(draft.contact.enabled ? [h('p', { class: 'muted', text: draft.contact.text })] : []), h('p', { class: 'muted', text: '📎  Сообщение  ·  Отправить' }));
      };
      const edit = change => value => { change(value); s.message = ''; paintPreview(); };
      const number = (name, key, min, max) => field(name, input(draft.appearance[key], edit(v => { draft.appearance[key] = v === '' ? null : Number(v); }), { type: 'number', min: String(min), max: String(max), step: '1', disabled: busy, 'data-widget-field': key }));
      const area = h('div', { class: 'workflow__settings' }, header, help('Отдельные настройки виджета и чата приложения. Приветствия новых заказов настраиваются в разделе «Автоответ и этапы».'),
        h('h3', { text: 'Приглашение к диалогу' }),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: draft.invitation.enabled, disabled: busy, 'data-widget-field': 'inviteEnabled', onchange: e => { draft.invitation.enabled = e.target.checked; paintPreview(); } }), 'Показывать приглашение на сайте'),
        field('Показать через, секунд', input(draft.invitation.delaySeconds, edit(v => { draft.invitation.delaySeconds = v === '' ? null : Number(v); }), { type: 'number', min: '0', max: '3600', step: '1', disabled: busy, 'data-widget-field': 'inviteDelay' })),
        field('Текст приглашения', textarea(draft.invitation.text, edit(v => { draft.invitation.text = v; }), { maxlength: '300', disabled: busy, 'data-widget-field': 'inviteText' })),
        help('Небольшое сообщение рядом с кнопкой чата. Чат открывается по нажатию. После открытия этого окна или закрытия приглашения оно больше не появляется в этом сеансе сайта.'),
        h('h3', { text: 'Приветствие при открытии' }), field('Текст приветствия', textarea(draft.welcomeText, edit(v => { draft.welcomeText = v; }), { maxlength: '1200', disabled: busy, 'data-widget-field': 'welcomeText' })),
        help('Появляется в пустом чате. Если текст пустой, приветствие скрыто.'), h('h3', { text: 'Ответ после первого сообщения' }),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: draft.autoReply.enabled, disabled: busy, 'data-widget-field': 'autoEnabled', onchange: e => { draft.autoReply.enabled = e.target.checked; } }), 'Отправлять автоответ после первого сообщения клиента'),
        field('Текст автоответа чата', textarea(draft.autoReply.text, edit(v => { draft.autoReply.text = v; }), { maxlength: '3000', disabled: busy, 'data-widget-field': 'autoText' })),
        help('Отправляется один раз при начале переписки без заказа. Ответы по новым заявкам сохраняют свои настройки.'), h('h3', { text: 'Номер для связи' }),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: draft.contact.enabled, disabled: busy, 'data-widget-field': 'contactEnabled', onchange: e => { draft.contact.enabled = e.target.checked; paintPreview(); } }), 'Предлагать оставить номер телефона'),
        field('Текст запроса номера', textarea(draft.contact.text, edit(v => { draft.contact.text = v; }), { maxlength: '300', disabled: busy, 'data-widget-field': 'contactText' })), help('Клиент может писать и прикладывать файлы без номера.'),
        h('h3', { text: 'Оформление окна' }), number('Ширина окна, px', 'width', 280, 440), number('Высота окна, px', 'height', 360, 680), number('Скругление углов, px', 'radius', 12, 40),
        field('Цвет кнопок', input(draft.appearance.accent, edit(v => { draft.appearance.accent = v; }), { type: 'color', disabled: busy, 'data-widget-field': 'accent' })),
        help('На телефоне окно подстраивается под экран и клавиатуру.'), h('h3', { text: 'Предпросмотр' }), preview,
        ...(s.error ? [msg(s.error, true)] : []), ...(s.message ? [msg(s.message)] : []),
        h('div', { class: 'workflow__buttons' }, button(s.saving ? 'Сохраняем…' : 'Сохранить настройки чата', saveWidgetSettings, { class: 'app-btn', disabled: busy || s.conflict, 'data-widget-save': '' }),
          ...(s.conflict && s.data.revision > s.draft.revision ? [button('Сохранить мои правки поверх новой версии', () => { s.draft.revision = s.data.revision; s.conflict = false; saveWidgetSettings(); }, { disabled: busy })] : []),
          button('Перечитать с сервера', () => readWidgetSettings(), { disabled: busy }), button('Сбросить мои изменения', () => { s.draft = copy(s.data); s.conflict = false; s.error = ''; s.message = ''; paintAllWidget(); }, { disabled: busy })));
      root.replaceChildren(area); paintPreview();
    }
    async function saveWidgetSettings() {
      const s = widgetSettings, token = epoch; if (!isOwner() || !s || s.saving || s.loading || s.conflict || !s.draft || !s.data) return;
      if (!s.pending) {
        try {
          const draft = widgetValue(copy(s.draft));
          draft.welcomeText = draft.welcomeText.trim(); draft.autoReply.text = draft.autoReply.text.trim(); draft.contact.text = draft.contact.text.trim(); draft.invitation.text = draft.invitation.text.trim(); draft.appearance.accent = draft.appearance.accent.toLowerCase();
          s.pending = { expectedRevision: draft.revision, requestId: requestId(), welcomeText: draft.welcomeText, autoReply: copy(draft.autoReply), contact: copy(draft.contact), invitation: copy(draft.invitation), appearance: copy(draft.appearance) };
        } catch (_) { s.error = 'Проверьте тексты, размеры окна и цвет.'; paintAllWidget(); return; }
      }
      const body = copy(s.pending); s.saving = true; s.error = ''; s.message = ''; paintAllWidget();
      try {
        const receipt = await widgetCall(WIDGET_SETTINGS_PATH, 'PUT', body), value = widgetValue(receipt);
        if (token !== epoch || s !== widgetSettings || !isOwner()) return;
        if (receipt.duplicate === true && value.revision > body.expectedRevision && !widgetSame(value, body)) {
          s.pending = null; s.data = value; s.conflict = true; s.error = 'Ваше сохранение прошло, но настройки уже изменились снова. Можно принять настройки с сервера или явно сохранить свои правки поверх новой версии.'; return;
        }
        if (value.revision <= body.expectedRevision || !widgetSame(value, body)) throw new Error('Сервер не подтвердил именно эти настройки. Проверьте результат.');
        s.data = value; s.draft = copy(value); s.pending = null; s.message = 'Настройки чата сохранены.';
      } catch (error) {
        if (token === epoch && s === widgetSettings) {
          if ([400, 401, 403, 409, 422].includes(error.status)) s.pending = null;
          if (error.status === 409) s.conflict = true;
          s.error = error.status === 409 ? 'Настройки уже изменились. Перечитайте их с сервера перед сохранением.' : error.message;
        }
      } finally { if (token === epoch && s === widgetSettings) { s.saving = false; paintAllWidget(); } }
    }

    function settingsPanel() {
      if (!isOwner()) return h('section', { class: 'card workflow', 'data-workflow': 'forbidden' }, msg('Настройки автоответа и этапов доступны собственнику.'));
      if (!settings) settings = { data: null, draft: null, loading: false, saving: false, error: '', message: '', pending: null, roots: new Set() };
      for (const old of settings.roots) if (!old.isConnected) settings.roots.delete(old);
      const root = h('section', { class: 'card workflow', 'data-workflow': 'settings' });
      settings.roots.add(root);
      paintSettings(root);
      if (!settings.data && !settings.loading && !settings.error) loadSettings();
      return root;
    }
    function paintAllSettings() { if (settings) for (const root of settings.roots) if (root.isConnected) paintSettings(root); }
    async function loadSettings({ replaceDraft = false } = {}) {
      const s = settings, token = epoch; if (!s || s.loading) return;
      s.loading = true; s.error = ''; paintAllSettings();
      try { const value = resultConfig(await call('/content/palitra/workflow')); if (token !== epoch || s !== settings) return; s.data = copy(value); if (!s.draft || replaceDraft) s.draft = copy(value); }
      catch (error) { if (token === epoch && s === settings) s.error = error.message; }
      finally { if (token === epoch && s === settings) { s.loading = false; paintAllSettings(); } }
    }
    function paintSettings(root) {
      const s = settings; if (!s) return;
      const header = h('h2', { class: 'text__title', text: 'Автоответ и этапы заказа' });
      if (s.pending && !s.saving) { root.replaceChildren(header, msg(s.error || 'Исход сохранения ещё не подтверждён.', true), msg('Ваш текст сохранён в этой вкладке. Повтор отправляет тот же запрос, чтобы не создать дубликат.'),
        button('Повторить то же сохранение', saveSettings), button('Перечитать с сервера', () => loadSettings()),
        button('Сверил результат — вернуться к правкам', () => { s.pending = null; s.error = ''; paintAllSettings(); })); return; }
      if (!s.draft) { root.replaceChildren(...[header, msg(s.loading ? 'Загружаем настройки…' : s.error || 'Нет настроек.', Boolean(s.error)), !s.loading ? button('Повторить чтение', () => loadSettings()) : null].filter(Boolean)); return; }
      const draft = s.draft, busy = s.saving;
      const auto = draft.autoReply;
      const questions = Array.isArray(auto.questions) ? auto.questions : (auto.questions = []);
      const area = h('div', { class: 'workflow__settings' }, header,
        h('h3', { text: 'Приветствие при новой заявке' }),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: auto.enabled, disabled: busy, 'data-auto-enabled': '', onchange: (e) => { auto.enabled = e.target.checked; } }), 'Отправлять приветствие при создании каждой новой заявки'),
        field('Текст автоответа', textarea(auto.text || '', (v) => { auto.text = v; }, { maxlength: '3000', disabled: busy, 'data-auto-text': '' })),
        help('Сообщение появляется в общем чате после создания каждой новой заявки. Первое сообщение клиента не требуется. Повторная отправка той же заявки не создаёт дубль.'),
        h('h3', { text: 'Необязательные вопросы' }),
        ...questions.map((q, i) => h('div', { class: 'workflow__row' }, field(`Вопрос ${i + 1}`, input(q.label, (v) => { q.label = v; }, { disabled: busy, maxlength: '180' })),
          field('Варианты ответа — по одному в строке', textarea((q.options || []).join('\n'), (v) => { q.options = v.split('\n').map((t) => t.trim()).filter(Boolean); }, { disabled: busy, maxlength: '1500' })),
          button('Удалить вопрос', () => { questions.splice(i, 1); paintAllSettings(); }, { disabled: busy }))),
        button('Добавить вопрос', () => { questions.push({ id: `question_${requestId().replace(/-/g, '').slice(0, 16)}`, label: '', options: [] }); paintAllSettings(); }, { disabled: busy || questions.length >= 6 }),
        h('h3', { text: 'Этапы продаж' }), help('Условия относятся к текущему этапу. Переход откроется после подтверждений. Изменения настроек не переписывают цепочку уже начатого заказа.'),
        ...draft.stages.map((stage, i) => h('fieldset', { class: 'workflow__stage', disabled: busy },
          h('legend', { text: `Этап ${i + 1}` }), field('Название', input(stage.label, (v) => { stage.label = v; }, { disabled: busy, maxlength: '100' })),
          field('Подсказка менеджеру', textarea(stage.hint || '', (v) => { stage.hint = v; }, { disabled: busy, maxlength: '500' })),
          h('strong', { text: 'Для следующего этапа требуется' }), ...Object.entries(REQUIREMENTS).map(([key, label]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: (stage.requirements || []).includes(key), disabled: busy,
            onchange: (e) => { stage.requirements = e.target.checked ? [...new Set([...(stage.requirements || []), key])] : (stage.requirements || []).filter((x) => x !== key); } }), label)),
          h('div', { class: 'workflow__buttons' }, button('↑ Выше', () => { [draft.stages[i - 1], draft.stages[i]] = [stage, draft.stages[i - 1]]; paintAllSettings(); }, { disabled: busy || i === 0, 'aria-label': `Этап ${i + 1} выше` }),
            button('↓ Ниже', () => { [draft.stages[i + 1], draft.stages[i]] = [stage, draft.stages[i + 1]]; paintAllSettings(); }, { disabled: busy || i === draft.stages.length - 1, 'aria-label': `Этап ${i + 1} ниже` }),
            button('Удалить этап', () => { draft.stages.splice(i, 1); paintAllSettings(); }, { disabled: busy || draft.stages.length <= 2 })))),
        button('Добавить этап', () => { draft.stages.push({ id: `stage_${requestId().replace(/-/g, '').slice(0, 16)}`, label: 'Новый этап', hint: '', requirements: [] }); paintAllSettings(); }, { disabled: busy || draft.stages.length >= 20 }),
        s.error ? msg(s.error, true) : null, s.message ? msg(s.message) : null,
        h('div', { class: 'workflow__buttons' }, button(busy ? 'Сохраняем…' : s.pending ? 'Повторить то же сохранение' : 'Сохранить настройки', saveSettings, { class: 'app-btn', disabled: busy, 'data-save-settings': '' }),
          button('Перечитать с сервера', () => loadSettings(), { disabled: busy }), button('Сбросить мои изменения', () => { s.draft = copy(s.data); s.error = ''; s.pending = null; paintAllSettings(); }, { disabled: busy })));
      root.replaceChildren(area);
    }
    async function saveSettings() {
      const s = settings, token = epoch; if (!s || s.saving || !isOwner()) return;
      if (s.draft.stages.some((x) => !x.label.trim()) || (s.draft.autoReply.enabled && !s.draft.autoReply.text.trim())) { s.error = 'Заполните названия этапов и текст включённого автоответа.'; paintAllSettings(); return; }
      if (s.draft.stages.at(-1).requirements.length) { s.error = 'Последний этап завершает цепочку. Уберите у него условия перехода или переместите его выше.'; paintAllSettings(); return; }
      if (s.draft.autoReply.questions.some((q) => !q.label.trim() || q.options.length > 8 || q.options.some((v) => v.length > 100))) { s.error = 'Укажите текст каждого вопроса. Можно до восьми вариантов, каждый до 100 символов.'; paintAllSettings(); return; }
      const body = s.pending || { expectedRevision: s.data.revision, requestId: requestId(), config: { autoReply: copy(s.draft.autoReply), stages: copy(s.draft.stages) } };
      s.pending = body; s.saving = true; s.error = ''; s.message = ''; paintAllSettings();
      try { const value = resultConfig(await call('/content/palitra/workflow', 'PUT', body)); if (token !== epoch || s !== settings) return; s.data = copy(value); s.draft = copy(value); s.pending = null; s.message = 'Настройки сохранены на сервере.'; }
      catch (error) { if (token !== epoch || s !== settings) return; s.error = error.status === 409 ? 'Настройки уже изменились. Ваш ввод сохранён. Перечитайте сервер, затем сверьте и сохраните изменения.' : `${error.message} Исход сохранения уточните чтением; повтор использует тот же запрос.`; if (error.status) s.pending = null; }
      finally { if (token === epoch && s === settings) { s.saving = false; paintAllSettings(); } }
    }
    function orderPanel(orderId, { compact = false, detailsContent = null } = {}) {
      if (!resourceOk(orderId) || !canRead()) return null;
      if (!orders.has(orderId)) orders.set(orderId, { data: null, loading: false, busy: false, readAt: 0, error: '', drafts: new Map(), pending: null, roots: new Set() });
      const s = orders.get(orderId), root = h('section', { class: `card workflow${compact ? ' workflow--compact' : ''}`, 'data-workflow-order': String(orderId) });
      if (compact) { root.setAttribute('data-workflow-manual', ''); root.detailsContent = detailsContent; }
      for (const old of s.roots) if (!old.isConnected) s.roots.delete(old);
      s.roots.add(root); paintOrder(root, orderId);
      const active = doc.activeElement, editing = active && active.closest && active.closest(`[data-workflow-order="${orderId}"]`) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
      if (!editing && !s.loading && !s.busy && (!s.data || now() - s.readAt > 5000) && !s.error) loadOrder(orderId);
      return root;
    }
    // Separate staff-only DOM projection, never appended to ordinary customer messages.
    function orderResponseAdvice(orderId, threadId) {
      if (!resourceOk(orderId) || !idOk(threadId) || !canRead() || !orders.has(orderId)) return null;
      const s = orders.get(orderId), root = h('div', { class: 'chat__staff-reminder', 'aria-live': 'polite' });
      root.adviceOnly = true; root.adviceThreadId = threadId;
      s.roots.add(root); paintOrder(root, orderId);
      return root;
    }
    function paintAllOrders(orderId) { const s = orders.get(orderId); if (s) for (const root of s.roots) if (root.isConnected) paintOrder(root, orderId); }
    async function loadOrder(orderId) {
      const s = orders.get(orderId), token = epoch; if (!s || s.loading) return;
      s.loading = true; s.error = ''; paintAllOrders(orderId);
      try { const data = resultOrder(await call(`/content/palitra/workflow/${resourcePath(orderId)}`), orderId); if (token !== epoch || orders.get(orderId) !== s) return; s.data = copy(data); s.readAt = now(); s.manualConflict = false; }
      catch (error) { if (token === epoch && orders.get(orderId) === s) s.error = error.message; }
      finally { if (token === epoch && orders.get(orderId) === s) { s.loading = false; paintAllOrders(orderId); } }
    }
    function paintOrder(root, orderId) {
      const s = orders.get(orderId); if (!s) return;
      if (root.adviceOnly) {
        const advice = !s.error && !s.loading ? staffCallAdvice(s.data, orderId, root.adviceThreadId) : null;
        root.replaceChildren(...(advice ? [advice] : []));
        return;
      }
      if (root.classList.contains('workflow--compact') || s.data && s.data.stages.some(stage => stage.id === 'issued' && stage.entryRequirement === 'handedOver')) { root.classList.add('workflow--compact'); paintManualOrder(root, orderId, s); return; }
      const header = h('h3', { text: 'Этапы заказа' });
      if (!s.data) { root.replaceChildren(...[header, msg(s.loading ? 'Загружаем этапы…' : s.error || 'Нет данных этапов.', Boolean(s.error)), s.loading ? null : button('Повторить чтение', () => loadOrder(orderId))].filter(Boolean)); return; }
      const d = s.data, stage = d.stages.find((x) => x.id === d.currentStageId);
      const rows = (d.missing || []).filter((r) => Object.hasOwn(REQUIREMENTS, r));
      const children = [header, h('strong', { class: 'workflow__current', text: stage ? stage.label : 'Этап не определён' }), stage && stage.hint ? msg(stage.hint) : null,
        h('ol', { class: 'workflow__timeline' }, ...d.stages.map((st) => h('li', { class: st.id === d.currentStageId ? 'is-current' : '', 'aria-current': st.id === d.currentStageId ? 'step' : null, text: st.label }))),
        help('Можно общаться в удобном клиенту канале. Подтвердите результат здесь — Дарья увидит его в истории заказа.')];
      for (const requirement of rows) {
        if (!s.drafts.has(requirement)) s.drafts.set(requirement, { channel: 'app', note: '', attachmentRef: '' });
        const draft = s.drafts.get(requirement), writable = canWrite() && d.canEdit !== false && !d.terminal && !s.busy;
        const select = h('select', { class: 'app-input', value: draft.channel, disabled: !writable, 'aria-label': `Канал: ${REQUIREMENTS[requirement]}`, onchange: (e) => { draft.channel = e.target.value; paintAllOrders(orderId); } },
          ...Object.entries(CHANNELS).map(([value, label]) => h('option', { value, text: label, ...(value === draft.channel ? { selected: true } : {}) })));
        const photos = Array.isArray(d.availablePhotos) ? d.availablePhotos : [];
        const photoChoice = requirement === 'photo_sent' && draft.channel === 'app' ? field('Уже отправленное фото в этом чате', h('select', { class: 'app-input', disabled: !writable, value: draft.attachmentRef,
          onchange: (e) => { draft.attachmentRef = e.target.value; } }, h('option', { value: '', text: 'Выберите отправленное фото' }),
          ...photos.map((photo) => h('option', { value: photo.attachmentRef, text: photo.label || `Фото ${photo.id}`, ...(photo.attachmentRef === draft.attachmentRef ? { selected: true } : {}) })))) : null;
        children.push(h('fieldset', { class: 'workflow__confirmation' }, h('legend', { text: REQUIREMENTS[requirement] }), field('Где подтвердили', select), photoChoice,
          requirement === 'photo_sent' && draft.channel === 'app' && !photos.length ? msg('Сначала отправьте фото клиенту. Затем обновите этапы. Выбор файла сам по себе отправку не подтверждает.') : null,
          field(draft.channel === 'app' ? 'Комментарий' : 'Что подтвердили с клиентом в этом канале', textarea(draft.note, (v) => { draft.note = v; }, { disabled: !writable, maxlength: '1000', 'aria-label': `Подтверждение: ${REQUIREMENTS[requirement]}` })),
          button(`Подтвердить: ${REQUIREMENTS[requirement].toLowerCase()}`, () => confirmOrder(orderId, requirement), { disabled: !writable, 'data-confirm': requirement })));
      }
      if (!canWrite()) children.push(msg('Вы можете просматривать заказ. Изменять этапы может сотрудник с правом редактирования CRM.'));
      children.push(s.error ? msg(s.error, true) : null,
        button(d.cancelled ? 'Заказ отменён' : d.terminal ? 'Заказ завершён' : d.nextStage ? `Следующий этап: ${d.nextStage.label}` : 'Завершить этап', () => mutateOrder(orderId, 'advance'),
          { class: 'app-btn', disabled: !canWrite() || s.busy || d.allowed !== true || d.terminal === true, 'data-advance': '' }),
        button(s.loading ? 'Обновляем…' : 'Обновить этапы', () => loadOrder(orderId), { disabled: s.loading || s.busy }),
        s.pending ? button('Повторить прежний запрос', () => s.pending.action === 'stage' ? setManualStage(orderId, s.pending.body.stageId) : mutateOrder(orderId, s.pending.action), { disabled: s.busy || !canWrite(), 'data-workflow-manual-action': s.pending.action === 'stage' }) : null,
        h('details', { class: 'workflow__history' }, h('summary', { text: 'История подтверждений' }), ...(d.confirmations || []).map((c) => h('p', { text: `${REQUIREMENTS[c.requirement] || c.requirement} · ${CHANNELS[c.channel] || c.channel} · ${c.actor && c.actor.label || 'Менеджер'} · ${c.at || ''}${c.note ? ` — ${c.note}` : ''}` }))));
      root.replaceChildren(...children.filter(Boolean));
    }
    function manualTargets(data) {
      if (!data || data.cancelled || data.canEdit === false) return [];
      const allowed = Array.isArray(data.manualStageIds) ? data.manualStageIds : [];
      return data.stages.filter(stage => allowed.includes(stage.id) && stage.id !== data.currentStageId);
    }
    function paintManualOrder(root, orderId, s) {
      const d = s.data, label = id => d?.stages.find(stage => stage.id === id)?.label || id;
      const stage = d?.stages.find(value => value.id === d.currentStageId), targets = manualTargets(d);
      const stageRow = d ? h('div', { class: 'workflow__stage-row' }, h('span', { text: 'Этап' }),
        canWrite() && d.canEdit !== false && !d.cancelled && targets.length ? h('select', { class: 'app-input workflow__stage-select', 'aria-label': 'Этап заказа', value: s.stageDraft?.stageId || d.currentStageId,
          disabled: s.busy || Boolean(s.pending) || s.manualConflict || !targets.length, onchange: event => { if (orders.get(orderId) === s) void setManualStage(orderId, event.target.value); } },
          h('option', { value: d.currentStageId, selected: !s.stageDraft, text: stage?.label || 'Этап не определён' }), ...targets.map(value => h('option', { value: value.id, selected: s.stageDraft?.stageId === value.id, text: value.label })))
          : h('strong', { class: 'workflow__current', text: stage?.label || 'Этап не определён' })) : msg(s.loading ? 'Загружаем этап…' : 'Этап сейчас недоступен.');
      const eventDate = at => Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
      const history = d ? [h('h4', { text: 'История этапов' }), ...(Array.isArray(d.history) ? d.history : []).map(event => h('p', { class: 'workflow__audit', text: `${eventDate(event.at)} · ${event.actor?.label || 'Сотрудник'} · ${event.action === 'set-stage' ? `${label(event.stageId)} → ${label(event.nextStageId)}` : label(event.nextStageId || event.stageId || '')}${event.reason ? ` · Причина: ${event.reason}` : ''}` })),
        ...(d.confirmations?.length ? [h('h4', { text: 'Сохранённые подтверждения' }), ...d.confirmations.map(c => h('p', { text: `${REQUIREMENTS[c.requirement] || c.requirement} · ${CHANNELS[c.channel] || c.channel} · ${c.actor?.label || 'Менеджер'} · ${c.at || ''}${c.note ? ` — ${c.note}` : ''}` }))] : [])] : [];
      const details = h('details', { class: 'workflow__details', open: Boolean(s.expanded), ontoggle: event => { if (event.currentTarget.isConnected) s.expanded = event.currentTarget.open; } },
        h('summary', { text: typeof orderId==='string' ? `Чат №${orderId.slice(7)} · подробности и история` : `Заявка №${orderId} · подробности и история` }), typeof root.detailsContent === 'function' ? root.detailsContent() : null, ...history,
        button(s.loading ? 'Обновляем…' : 'Обновить этап', () => loadOrder(orderId), { disabled: s.loading || s.busy }),
        s.pending?.action === 'stage' ? button('Повторить изменение этапа', () => { if (orders.get(orderId) === s) return setManualStage(orderId, s.pending.body.stageId); }, { disabled: s.busy || !canWrite(), 'data-stage-retry': '' }) : null);
      root.replaceChildren(...[stageRow, stageConfirmation(orderId, s), s.busy ? msg('Сохраняем этап…') : null, s.error ? msg(s.error, true) : null, details].filter(Boolean));
    }
    function staffCallAdvice(data, orderId, threadId) {
      const advice = data?.staffResponseAdvice;
      if (!canRead() || !advice || advice.kind !== 'manager-no-reply' || advice.orderId !== orderId || !idOk(advice.threadId) || advice.threadId !== threadId || !idOk(advice.messageId)
        || typeof advice.key !== 'string' || !advice.key || advice.key.length > 512 || typeof advice.text !== 'string' || advice.text.length > 1000
        || !Number.isFinite(Date.parse(advice.dueAt)) || Date.parse(advice.dueAt) > now()) return null;
      const contact = advice.contact, phone = contact && contact.channel === 'phone' && typeof contact.href === 'string' && /^tel:\+?[0-9]{5,20}$/.test(contact.href)
        && typeof contact.label === 'string' && contact.label.length <= 100;
      return h('aside', { class: 'chat__msg is-theirs chat__advice', 'data-staff-response-advice': advice.key, 'aria-label': 'Служебное напоминание Синапс Бизнес' },
        h('div', { class: 'chat__message-head' }, h('span', { class: 'chat__meta', text: typeof orderId==='string' ? `Синапс Бизнес · Чат №${orderId.slice(7)}` : `Синапс Бизнес · Заявка №${orderId}` })),
        h('span', { class: 'chat__staff-only', text: 'Только сотрудникам' }),
        h('span', { class: 'chat__text', text: advice.text }),
        phone ? h('div', { class: 'chat__advice-actions' }, h('a', { class: 'chat__order', href: contact.href, text: contact.label || 'Позвонить клиенту' })) : null);
    }
    function stageConfirmation(orderId, s) {
      const draft = s.stageDraft; if (!draft) return null;
      const target = s.data?.stages.find(stage => stage.id === draft.stageId);
      if (!target) return null;
      const locked = s.busy || Boolean(s.pending) || !canWrite() || s.manualConflict || s.data.canEdit === false;
      const controls = [], validate = () => stageDraftBody(s, target) !== null;
      let submit;
      const changed = () => { if (submit) submit.disabled = locked || !validate(); onState(); };
      if (draft.requirement === 'reason') controls.push(field('Причина отказа', textarea(draft.reason, value => { draft.reason = value; changed(); }, { maxlength: '300', disabled: locked, 'data-stage-reason': '' })));
      else if (draft.requirement === 'paymentReceived' || draft.requirement === 'handedOver') {
        const text = draft.requirement === 'paymentReceived' ? 'Чек получен, оплату подтвердили' : 'Заказ фактически передан клиенту';
        controls.push(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: draft.confirmed, disabled: locked, 'data-stage-fact': '', onchange: event => { draft.confirmed = event.target.checked; changed(); } }), text));
      } else if (draft.requirement === 'photoSent') {
        const photos = Array.isArray(s.data.availablePhotos) ? s.data.availablePhotos : [];
        controls.push(field('Где отправили фото готового заказа', h('select', { class: 'app-input', value: draft.channel, disabled: locked, 'data-stage-photo-channel': '', onchange: event => { draft.channel = event.target.value; draft.attachmentRef = ''; paintAllOrders(orderId); onState(); } },
          ...Object.entries(CHANNELS).map(([value, text]) => h('option', { value, text, selected: draft.channel === value })))));
        if (draft.channel === 'app') controls.push(field('Уже отправленное фото', h('select', { class: 'app-input', value: draft.attachmentRef, disabled: locked, 'data-stage-photo-ref': '', onchange: event => { draft.attachmentRef = event.target.value; changed(); } },
          h('option', { value: '', text: 'Выберите фото из переписки' }), ...photos.map(photo => h('option', { value: photo.attachmentRef, text: photo.label || `Фото ${photo.messageId}`, selected: photo.attachmentRef === draft.attachmentRef })))),
          !photos.length ? msg('Сначала отправьте фото клиенту в переписке. Затем обновите этап.') : null);
        else controls.push(field('Подтвердите, какое фото уже отправили', textarea(draft.note, value => { draft.note = value; changed(); }, { maxlength: '1000', disabled: locked, 'data-stage-photo-note': '' })));
      }
      submit = button('Подтвердить', () => { if (orders.get(orderId) === s) return setManualStage(orderId, draft.stageId, { confirmed: true }); }, { class: 'app-btn', disabled: locked || !validate(), 'data-stage-confirm': '' });
      return h('fieldset', { class: 'workflow__confirmation workflow__stage-confirm' }, h('legend', { text: target.label }), ...controls,
        s.data.revision !== draft.revision ? msg('Заказ изменился. Отмените этот выбор и выберите этап заново.', true) : null,
        h('div', { class: 'workflow__buttons' }, submit, button('Отмена', () => { if (!s.busy && !s.pending) { s.stageDraft = null; s.error = ''; paintAllOrders(orderId); onState(); } }, { disabled: s.busy || Boolean(s.pending), 'data-stage-cancel': '' })));
    }
    function stageDraftBody(s, target) {
      const draft = s.stageDraft;
      if (!draft || draft.stageId !== target.id || draft.revision !== s.data.revision) return null;
      if (draft.requirement === 'reason') return draft.reason.trim() && draft.reason.trim().length <= 300 ? { reason: draft.reason.trim() } : null;
      if (draft.requirement === 'paymentReceived') return draft.confirmed === true ? { confirmation: { paymentReceived: true } } : null;
      if (draft.requirement === 'handedOver') return draft.confirmed === true ? { confirmation: { handedOver: true } } : null;
      if (draft.requirement === 'photoSent') {
        if (!Object.hasOwn(CHANNELS, draft.channel) || draft.note.length > 1000) return null;
        if (draft.channel === 'app') return (Array.isArray(s.data.availablePhotos) ? s.data.availablePhotos : []).some(photo => photo.attachmentRef === draft.attachmentRef) ? { confirmation: { photoSent: true, channel: 'app', note: '', attachmentRef: draft.attachmentRef } } : null;
        return draft.note.trim() ? { confirmation: { photoSent: true, channel: draft.channel, note: draft.note.trim() } } : null;
      }
      return null;
    }
    async function setManualStage(orderId, stageId, { confirmed = false } = {}) {
      const s = orders.get(orderId), token = epoch;
      if (!s || s.busy || !s.data || !canWrite() || s.manualConflict) return;
      if (s.pending && (s.pending.action !== 'stage' || s.pending.body.stageId !== stageId)) return;
      if (!s.pending && s.data.canEdit === false) return;
      if (!s.pending && !manualTargets(s.data).some(stage => stage.id === stageId)) { paintAllOrders(orderId); return; }
      const target = s.data.stages.find(stage => stage.id === stageId), requirement = target?.entryRequirement;
      let extra = {};
      if (!s.pending && requirement) {
        if (!['reason', 'paymentReceived', 'photoSent', 'handedOver'].includes(requirement)) { s.error = 'Обновите приложение для этого этапа.'; paintAllOrders(orderId); return; }
        if (!confirmed) { s.stageDraft = { stageId, requirement, revision: s.data.revision, reason: '', confirmed: false, channel: 'app', note: '', attachmentRef: '' }; s.error = ''; paintAllOrders(orderId); onState(); return; }
        extra = stageDraftBody(s, target); if (!extra) return;
      }
      const body = s.pending ? s.pending.body : { expectedRevision: s.data.revision, requestId: requestId(), stageId, ...extra };
      s.pending = { action: 'stage', body }; s.busy = true; s.error = ''; paintAllOrders(orderId); onState();
      try {
        const response = await call(`/content/palitra/workflow/${resourcePath(orderId)}/stage`, 'POST', body), result = resultOrder(response, orderId), receipt = response && response.stageReceipt;
        if (token !== epoch || orders.get(orderId) !== s) return;
        if (!receipt || receipt.requestId !== body.requestId || receipt.stageId !== body.stageId || receipt.revision !== body.expectedRevision + 1 || !Number.isSafeInteger(result.revision) || result.revision < receipt.revision || !result.stages.some(stage => stage.id === result.currentStageId)) throw new Error('Сервер не подтвердил именно это изменение этапа.');
        s.data = copy(result); s.readAt = now(); s.pending = null; s.stageDraft = null; onChanged(orderId);
      } catch (error) {
        if (token !== epoch || orders.get(orderId) !== s) return;
        s.expanded = true;
        if (error.status === 409) { s.pending = null; s.manualConflict = true; s.error = 'Этап уже изменился. Обновите его перед новым выбором.'; }
        else if (error.status >= 400 && error.status < 500 && error.status !== 408) { s.pending = null; s.error = error.message; }
        else s.error = `${error.message} Исход изменения неизвестен. Обновите данные или явно повторите тот же запрос.`;
      } finally { if (token === epoch && orders.get(orderId) === s) { s.busy = false; paintAllOrders(orderId); onState(); } }
    }
    const memoRef = value => value === null || typeof value === 'string' && /^(thread:[1-9]\d{0,15}|(?:upload|memo):[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(value);
    const memoAsset = asset => Boolean(asset && typeof asset.reference === 'string' && /^memo:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(asset.reference)
      && typeof asset.name === 'string' && asset.name.length <= 180 && ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(asset.contentType) && asset.kind === (asset.contentType === 'application/pdf' ? 'document' : 'photo')
      && Number.isFinite(Date.parse(asset.createdAt)) && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= 2 * 1024 * 1024 && /^[a-f0-9]{64}$/.test(asset.sha256));
    function completionValue(data) {
      if (!data || !Number.isSafeInteger(data.revision) || data.revision < 0 || typeof data.reviewText !== 'string' || typeof data.memoText !== 'string'
        || [data.reviewText, data.memoText].filter(Boolean).join('\n\n').length > 4000 || !memoRef(data.memoAttachmentRef) || typeof data.canEdit !== 'boolean') throw new Error('Сервер не подтвердил настройки завершения заказа.');
      return { revision: data.revision, reviewText: data.reviewText, memoText: data.memoText, memoAttachmentRef: data.memoAttachmentRef, canEdit: data.canEdit };
    }
    function completionSettingsPanel() {
      if (!canWrite()) return null;
      if (!completionSettings) completionSettings = { data: null, draft: null, pending: null, loading: false, busy: false, error: '', message: '', roots: new Set(), choices: [], assetsLoading: false, assetsLoaded: false, file: null, uploadPending: null, uploadBusy: false, uploadError: '' };
      const s = completionSettings;
      for (const old of s.roots) if (!old.isConnected) s.roots.delete(old);
      const root = h('section', { class: 'card workflow', 'data-completion-settings': '' }); s.roots.add(root); paintCompletion(root);
      if (!s.data && !s.loading && !s.error) void loadCompletion();
      if (!s.assetsLoaded && !s.assetsLoading) void loadMemoAssets();
      return root;
    }
    function paintAllCompletion() { if (completionSettings) for (const root of completionSettings.roots) if (root.isConnected) paintCompletion(root); }
    function completionDirty(s) {
      return Boolean(s && (s.busy || s.pending || s.uploadBusy || s.uploadPending || s.file || s.draft && s.data
        && ['reviewText', 'memoText', 'memoAttachmentRef'].some(key => s.draft[key] !== s.data[key])));
    }
    async function loadMemoAssets() {
      const s = completionSettings, token = epoch; if (!s || s.assetsLoading || !canWrite()) return;
      s.assetsLoading = true;
      try { const data = await call('/content/palitra/workflow/memo-assets');
        if (!data || data.ok !== true || !Array.isArray(data.assets) || data.assets.length > 500 || data.assets.some(asset => !memoAsset(asset))) throw new Error('Не удалось подтвердить список памяток.');
        if (token !== epoch || s !== completionSettings) return;
        s.choices = data.assets.map(asset => ({ attachmentRef: asset.reference, label: asset.name })); s.assetsLoaded = true;
      } catch (error) { if (token === epoch && s === completionSettings) s.uploadError = error.message; }
      finally { if (token === epoch && s === completionSettings) { s.assetsLoading = false; paintAllCompletion(); } }
    }
    async function uploadMemo() {
      const s = completionSettings, token = epoch;
      if (!s || !s.file || s.uploadBusy || s.busy || s.pending || !canWrite() || s.data?.canEdit !== true || typeof memoUpload !== 'function') return;
      const current = s.uploadPending || { file: s.file, requestId: requestId() }; s.uploadPending = current; s.uploadBusy = true; s.uploadError = ''; paintAllCompletion(); onState();
      try { const data = await memoUpload(current), asset = data && data.asset;
        if (token !== epoch || s !== completionSettings) return;
        if (!data || data.ok !== true || typeof data.duplicate !== 'boolean' || !memoAsset(asset) || asset.reference !== 'memo:' + current.requestId || asset.size !== current.file.size || asset.contentType !== current.file.type) throw new Error('Сервер не подтвердил файл памятки. Повторите ту же загрузку.');
        if (!s.choices.some(choice => choice.attachmentRef === asset.reference)) s.choices.push({ attachmentRef: asset.reference, label: asset.name });
        s.draft.memoAttachmentRef = asset.reference; s.file = null; s.uploadPending = null; s.message = 'Файл загружен. Сохраните памятку, чтобы прикрепить его к завершению заказа.';
      } catch (error) { if (token === epoch && s === completionSettings) { s.uploadError = error.message; if (error.status >= 400 && error.status < 500 && error.status !== 408) s.uploadPending = null; } }
      finally { if (token === epoch && s === completionSettings) { s.uploadBusy = false; paintAllCompletion(); onState(); } }
    }
    async function loadCompletion() {
      const s = completionSettings, token = epoch; if (!s || s.loading || s.busy || !canWrite()) return;
      s.loading = true; s.error = ''; paintAllCompletion();
      try { const data = completionValue(await call('/content/palitra/workflow/completion-settings')); if (token !== epoch || s !== completionSettings) return; const preserve = completionDirty(s); s.data = data; if (!s.draft || !preserve) s.draft = copy(data); }
      catch (error) { if (token === epoch && s === completionSettings) s.error = error.message; }
      finally { if (token === epoch && s === completionSettings) { s.loading = false; paintAllCompletion(); onState(); } }
    }
    function paintCompletion(root) {
      const s = completionSettings; if (!s) return;
      const heading = h('h3', { text: 'После выдачи заказа' });
      if (!s.draft) { root.replaceChildren(heading, msg(s.loading ? 'Загружаем настройки…' : s.error || 'Настройки пока недоступны.'), button('Обновить', loadCompletion, { disabled: s.loading })); return; }
      const draft = s.draft, locked = s.busy || Boolean(s.pending) || s.uploadBusy || Boolean(s.uploadPending) || s.data.canEdit !== true || !canWrite();
      const choices = s.choices.filter((value, index, all) => all.findIndex(item => item.attachmentRef === value.attachmentRef) === index);
      if (draft.memoAttachmentRef && !choices.some(value => value.attachmentRef === draft.memoAttachmentRef)) choices.unshift({ attachmentRef: draft.memoAttachmentRef, label: 'Прикреплённая памятка' });
      const picker = typeof memoUpload === 'function' ? h('div', { class: 'workflow__memo-upload' }, field('Загрузить памятку — PDF или изображение, до 2 МБ', h('input', { type: 'file', accept: 'application/pdf,image/jpeg,image/png,image/webp', disabled: locked, 'data-completion-memo-file': '', onchange: event => {
        const file = event.target.files && event.target.files[0]; if (!file || locked || s !== completionSettings) return;
        if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 2 * 1024 * 1024 || typeof file.name !== 'string' || file.name.length > 180) { s.uploadError = 'Выберите PDF, JPG, PNG или WEBP до 2 МБ.'; paintAllCompletion(); return; }
        s.file = file; s.uploadError = ''; paintAllCompletion(); onState();
      } })), s.file ? msg(s.file.name) : null, button(s.uploadBusy ? 'Загружаем…' : s.uploadPending ? 'Повторить ту же загрузку' : 'Загрузить памятку', () => { if (s === completionSettings) return uploadMemo(); }, { disabled: !s.file || s.uploadBusy || s.busy || Boolean(s.pending) || s.data.canEdit !== true, 'data-completion-memo-upload': '' }),
        s.file ? button('Убрать выбранный файл', () => { if (s === completionSettings && !s.uploadBusy && !s.uploadPending && !s.pending && !s.busy) { s.file = null; s.uploadError = ''; paintAllCompletion(); onState(); } }, { disabled: s.uploadBusy || Boolean(s.uploadPending) || s.busy || Boolean(s.pending), 'data-completion-memo-remove': '' }) : null) : null;
      root.replaceChildren(...[heading, help('После подтверждения получения заказа клиенту придёт памятка, затем отдельная просьба оставить отзыв.'),
        field('Просьба оставить отзыв', textarea(draft.reviewText, value => { draft.reviewText = value; onState(); }, { maxlength: '4000', disabled: locked, 'data-completion-review-text': '' })),
        field('Памятка клиенту', textarea(draft.memoText, value => { draft.memoText = value; onState(); }, { maxlength: '4000', disabled: locked, 'data-completion-memo-text': '' })),
        choices.length ? field('Файл памятки', h('select', { class: 'app-input', disabled: locked, value: draft.memoAttachmentRef || '', 'data-completion-memo-ref': '', onchange: event => { draft.memoAttachmentRef = event.target.value || null; onState(); } },
          h('option', { value: '', text: 'Без файла', selected: !draft.memoAttachmentRef }), ...choices.map(choice => h('option', { value: choice.attachmentRef, text: choice.label, selected: choice.attachmentRef === draft.memoAttachmentRef })))) : null,
        picker, s.uploadError ? msg(s.uploadError, true) : null, s.error ? msg(s.error, true) : null, s.message ? msg(s.message) : null,
        s.pending ? msg('Исход сохранения неизвестен. Повтор использует тот же запрос и тот же текст.') : null,
        h('div', { class: 'workflow__buttons' }, button(s.busy ? 'Сохраняем…' : s.pending ? 'Повторить то же сохранение' : 'Сохранить памятку', () => { if (s === completionSettings) return saveCompletion(); }, { class: 'app-btn', disabled: s.busy || s.uploadBusy || Boolean(s.uploadPending) || s.data.canEdit !== true || !canWrite(), 'data-completion-save': '' }),
          button('Обновить', loadCompletion, { disabled: s.loading || s.busy }))].filter(Boolean));
    }
    async function saveCompletion() {
      const s = completionSettings, token = epoch;
      if (!s || !s.data || !s.draft || s.busy || s.uploadBusy || s.uploadPending || !canWrite() || s.data.canEdit !== true) return;
      if (!s.pending && ([s.draft.reviewText, s.draft.memoText].filter(Boolean).join('\n\n').length > 4000 || !memoRef(s.draft.memoAttachmentRef)
        || s.draft.memoAttachmentRef !== s.data.memoAttachmentRef && !s.choices.some(choice => choice.attachmentRef === s.draft.memoAttachmentRef) && s.draft.memoAttachmentRef !== null)) { s.error = 'Тексты вместе — до 4000 символов. Файл выберите из доступных материалов.'; paintAllCompletion(); return; }
      const body = s.pending || { expectedRevision: s.data.revision, requestId: requestId(), reviewText: s.draft.reviewText.trim(), memoText: s.draft.memoText.trim(), memoAttachmentRef: s.draft.memoAttachmentRef };
      s.pending = body; s.busy = true; s.error = ''; s.message = ''; paintAllCompletion(); onState();
      try { const response = await call('/content/palitra/workflow/completion-settings', 'PUT', body), data = completionValue(response), receipt = response.completionReceipt; if (token !== epoch || s !== completionSettings) return;
        const exact = data.revision === body.expectedRevision + 1 && data.reviewText === body.reviewText && data.memoText === body.memoText && data.memoAttachmentRef === body.memoAttachmentRef;
        if (!receipt || receipt.requestId !== body.requestId || receipt.revision !== body.expectedRevision + 1 || data.revision < receipt.revision
          || (!exact && !(response.duplicate === true && data.revision > receipt.revision))) throw new Error('Сервер не подтвердил именно эту памятку. Повторите тот же запрос.');
        s.data = data; s.draft = copy(data); s.pending = null; s.message = exact ? 'Памятка сохранена.' : 'Ваше сохранение подтверждено. После него памятку изменили; показана текущая версия.';
      } catch (error) { if (token === epoch && s === completionSettings) { s.error = error.status === 409 ? 'Настройки изменились. Обновите их перед сохранением.' : error.message; if (error.status >= 400 && error.status < 500 && error.status !== 408) s.pending = null; } }
      finally { if (token === epoch && s === completionSettings) { s.busy = false; paintAllCompletion(); onState(); } }
    }
    function funnelReportPanel() {
      if (!canRead()) return null;
      if (!funnelReport) funnelReport = { loading: false, data: null, error: '', roots: new Set() };
      const s = funnelReport; for (const old of s.roots) if (!old.isConnected) s.roots.delete(old);
      const root = h('section', { class: 'card workflow', 'data-funnel-report': '' }); s.roots.add(root); paintFunnelReport(root);
      if (!s.data && !s.loading && !s.error) void loadFunnelReport(); return root;
    }
    async function loadFunnelReport() {
      const s = funnelReport, token = epoch; if (!s || s.loading || !canRead()) return;
      s.loading = true; s.error = ''; for (const root of s.roots) if (root.isConnected) paintFunnelReport(root);
      try { const data = await call('/content/palitra/workflow/funnel-report'), count = value => Number.isSafeInteger(value) && value >= 0;
        if (!data || data.schema !== 1 || !count(data.total) || !count(data.cancelled) || !count(data.withoutReason) || !Array.isArray(data.byStage) || data.byStage.length > 30 || !Array.isArray(data.refusals) || data.refusals.length > 500
          || data.byStage.some(row => !row || typeof row.label !== 'string' || row.label.length > 100 || !count(row.count)) || data.refusals.some(row => !row || typeof row.reason !== 'string' || row.reason.length > 300 || !count(row.count))) throw new Error('Сервер не подтвердил статистику заказов.');
        if (token === epoch && s === funnelReport) s.data = copy(data);
      } catch (error) { if (token === epoch && s === funnelReport) s.error = error.message; }
      finally { if (token === epoch && s === funnelReport) { s.loading = false; for (const root of s.roots) if (root.isConnected) paintFunnelReport(root); } }
    }
    function paintFunnelReport(root) {
      const s = funnelReport; if (!s) return;
      root.replaceChildren(...[h('h3', { text: 'Заказы и отказы' }), s.data ? h('div', {}, msg('Всего заказов: ' + s.data.total),
        ...s.data.byStage.map(row => msg(row.label + ': ' + row.count)), msg('Отказы: ' + s.data.cancelled),
        ...s.data.refusals.map(row => msg(row.reason + ': ' + row.count)), s.data.withoutReason ? msg('Прежние отказы без причины: ' + s.data.withoutReason) : null) : msg(s.loading ? 'Загружаем статистику…' : 'Статистика пока недоступна.'),
        s.error ? msg(s.error, true) : null, button(s.loading ? 'Обновляем…' : 'Обновить', loadFunnelReport, { disabled: s.loading })].filter(Boolean));
    }
    function confirmOrder(orderId, requirement) {
      const s = orders.get(orderId), draft = s && s.drafts.get(requirement); if (!s || !draft || !canWrite()) return;
      if (s.pending) { s.error = 'Сначала уточните результат предыдущего действия или повторите прежний запрос.'; paintAllOrders(orderId); return; }
      if (draft.channel !== 'app' && !draft.note.trim()) { s.error = 'Опишите подтверждение клиента в выбранном канале.'; paintAllOrders(orderId); return; }
      if (requirement === 'photo_sent' && draft.channel === 'app' && !draft.attachmentRef) { s.error = 'Выберите фото, которое уже отправлено в этот чат.'; paintAllOrders(orderId); return; }
      mutateOrder(orderId, 'confirm', { requirement, channel: draft.channel, note: draft.note.trim(), ...(draft.channel === 'app' && draft.attachmentRef && requirement === 'photo_sent' ? { attachmentRef: draft.attachmentRef } : {}) });
    }
    async function mutateOrder(orderId, action, patch = {}) {
      const s = orders.get(orderId), token = epoch; if (!s || s.busy || !s.data || !canWrite()) return;
      if (s.pending && s.pending.action !== action) { s.error = 'Сначала уточните результат предыдущего действия чтением или повторите прежний запрос.'; paintAllOrders(orderId); return; }
      const body = s.pending ? s.pending.body : { expectedRevision: s.data.revision, requestId: requestId(), ...patch };
      s.pending = { action, body }; s.busy = true; s.error = ''; paintAllOrders(orderId);
      try { const result = resultOrder(await call(`/content/palitra/workflow/${resourcePath(orderId)}/${action}`, 'POST', body), orderId); if (token !== epoch || orders.get(orderId) !== s) return; s.data = copy(result); s.readAt = now(); s.pending = null; onChanged(orderId); }
      catch (error) { if (token !== epoch || orders.get(orderId) !== s) return; s.expanded = true; s.error = error.status === 409 ? 'Заказ изменился. Обновите этапы и проверьте текущие подтверждения.' : `${error.message} Проверьте результат обновлением; неизвестный запрос можно повторить без изменений.`; if (error.status) s.pending = null; }
      finally { if (token === epoch && orders.get(orderId) === s) { s.busy = false; paintAllOrders(orderId); } }
    }
    function questionnairePanel(key, items, send) {
      const questions = Array.isArray(items) ? items.filter((q) => q && typeof q.id === 'string' && typeof q.label === 'string').slice(0, 8) : [];
      if (!questions.length || typeof key !== 'string' || typeof send !== 'function') return null;
      if (!questionnaires.has(key)) questionnaires.set(key, { answers: {}, busy: false, sent: false, error: '', mounts: new Set() });
      const s = questionnaires.get(key), root = h('details', { class: 'card workflow questionnaire', 'data-questionnaire': key });
      for (const old of s.mounts) if (!old.root.isConnected) s.mounts.delete(old);
      const repaint = () => { for (const mount of s.mounts) if (mount.root.isConnected) mount.paint(); };
      const paint = () => {
        const content = [h('summary', { text: s.sent ? 'Ответы отправлены менеджеру' : 'Расскажите о празднике — по желанию' }), help('Можно ответить на вопросы или сразу написать менеджеру в чате.')];
        if (!s.sent) {
          for (const question of questions) {
            if (!Object.hasOwn(s.answers, question.id)) s.answers[question.id] = '';
            const control = input(s.answers[question.id], (value) => { s.answers[question.id] = value; }, { disabled: s.busy, maxlength: '300', 'aria-label': question.label });
            const choices = Array.isArray(question.options) ? question.options.filter((x) => typeof x === 'string').slice(0, 12) : [];
            content.push(field(question.label, control));
            if (choices.length) content.push(h('div', { class: 'workflow__buttons' }, ...choices.map((value) => button(value, () => { s.answers[question.id] = value; control.value = value; }, { disabled: s.busy }))));
          }
          content.push(button(s.busy ? 'Отправляем ответы…' : 'Отправить ответы в этот чат', async () => {
            if (s.busy) return;
            const text = questions.map((q) => s.answers[q.id].trim() ? `${q.label}: ${s.answers[q.id].trim()}` : '').filter(Boolean).join('\n');
            if (!text) { s.error = 'Ответьте хотя бы на один вопрос или продолжите обычную переписку.'; paint(); return; }
            const token = epoch; s.busy = true; s.error = ''; paint();
            try { await send(text); if (token === epoch && questionnaires.get(key) === s) s.sent = true; }
            catch (error) { if (token === epoch && questionnaires.get(key) === s) s.error = error.message; }
            finally { if (token === epoch && questionnaires.get(key) === s) { s.busy = false; repaint(); } }
          }, { class: 'app-btn', disabled: s.busy, 'data-send-questionnaire': '' }));
        }
        if (s.error) content.push(msg(s.error, true));
        root.replaceChildren(...content);
      };
      s.mounts.add({ root, paint }); paint(); return root;
    }
    function rememberClient(map, key, value, limit) {
      map.delete(key); map.set(key, value);
      while (map.size > limit) {
        const first = map.keys().next().value, old = map.get(first);
        if (map === clientOfferRoots) old.root.remove();
        map.delete(first);
      }
    }
    function clientInstallKey(conversation, phase) {
      return 'palitra:client-install-offer:v1:' + JSON.stringify([identity.key, conversation, phase]);
    }
    function clientInstallSeen(key) {
      // При quota-error чтение storage может работать: уже записанная память всё равно важнее null.
      if (clientInstallMemory.has(key)) return true;
      try { return win.localStorage.getItem(key) === '1'; } catch (_) { return false; }
    }
    function clientOfferLive(s) { return s.token === epoch && s.actor === identity.key && clientOfferRoots.get(s.key) === s; }
    function clientOfferVisible(node) {
      if (!node || !node.isConnected || node.hidden || doc.visibilityState === 'hidden') return false;
      for (let p = node; p; p = p.parentElement) if (p.hidden || p.style && p.style.display === 'none') return false;
      if (typeof node.getClientRects === 'function' && !node.getClientRects().length) return false;
      if (typeof node.getBoundingClientRect !== 'function') return false;
      const r = node.getBoundingClientRect();
      let top = win.visualViewport && win.visualViewport.offsetTop || 0, left = win.visualViewport && win.visualViewport.offsetLeft || 0;
      const height = win.visualViewport && win.visualViewport.height || win.innerHeight || doc.documentElement && doc.documentElement.clientHeight;
      const width = win.visualViewport && win.visualViewport.width || win.innerWidth || doc.documentElement && doc.documentElement.clientWidth;
      let bottom = height ? top + height : Infinity, right = width ? left + width : Infinity;
      if (typeof win.getComputedStyle === 'function') for (let p = node; p; p = p.parentElement) {
        const style = win.getComputedStyle(p);
        if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) return false;
        if (p === node || typeof p.getBoundingClientRect !== 'function') continue;
        const clip = p.getBoundingClientRect();
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY || style.overflow)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX || style.overflow)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
      }
      return r.width > 0 && r.height > 0 && Math.min(r.bottom, bottom) > Math.max(r.top, top) && Math.min(r.right, right) > Math.max(r.left, left);
    }
    function markClientInstall(s) {
      if (!clientOfferLive(s) || !s.installEligible || s.installMarked || !clientOfferVisible(s.root.querySelector('[data-client-install-offer]'))) return;
      s.installMarked = true;
      clientInstallMemory.set(s.installKey, true);
      try { win.localStorage.setItem(s.installKey, '1'); } catch (_) { /* Память вкладки остаётся действительной. */ }
    }
    function scheduleClientMark(s) {
      if (s.markQueued) return;
      s.markQueued = true;
      const run = () => { s.markQueued = false; s.mountChecked = true; markClientInstall(s); };
      if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(run);
      else Promise.resolve().then(run);
    }
    function pruneClientRoots(keep = '') {
      for (const [key, s] of clientOfferRoots) if (key !== keep && !s.root.isConnected && s.mountChecked) clientOfferRoots.delete(key);
    }
    function repaintClientOffers() {
      pruneClientRoots();
      for (const s of clientOfferRoots.values()) if (s.root.isConnected && clientOfferLive(s)) paintClientOffers(s);
    }
    function paintClientOffers(s) {
      if (!clientOfferLive(s)) return;
      const push = win.PalitraPushService, isInstalled = nativeInstalled();
      const ios = /iPad|iPhone|iPod/.test(win.navigator && win.navigator.userAgent || '') || /Macintosh/.test(win.navigator && win.navigator.userAgent || '') && Number(win.navigator && win.navigator.maxTouchPoints) > 1;
      const connected = Boolean(push && push.state && push.state.subscribed === true && push.state.serverSaved === true);
      const children = [], liveAction = () => clientOfferLive(s) && s.root.isConnected;
      const dismissPush = () => { if (!liveAction()) return; s.entry.closed = true; s.guide = ''; paintClientOffers(s); };
      const dismissInstall = () => { if (!liveAction()) return; markClientInstall(s); s.installClosed = true; s.guide = ''; paintClientOffers(s); };
      const showGuide = kind => { if (!liveAction()) return; s.guide = s.guide === kind ? '' : kind; paintClientOffers(s); };
      if (!s.entry.closed && !connected && !(push && push.checking === true)) {
        const body = [h('h3', { text: txt('notificationTitle') }),
          button('×', dismissPush, { class: 'client-chat-offers__close', 'aria-label': 'Закрыть предложение уведомлений', 'data-client-push-close': '' })];
        const configured = Boolean(push && push.deliveryReady === true && typeof push.subscribe === 'function');
        if (ios && !standaloneMode()) {
          body.push(msg(txt('iosInstallText')),
            button(txt('installHelpButton'), () => showGuide('push'), { 'data-client-push-guide': '', 'aria-expanded': String(s.guide === 'push') }));
          if (!configured) body.push(msg(push && push.lastError ? pushDiagnostic(push.lastError, txt('pushUnavailableText')) : txt('pushUnavailableText')));
        }
        else if (win.Notification && win.Notification.permission === 'denied') body.push(msg(txt('permissionDeniedText')));
        else if (!configured) body.push(msg(push && push.lastError ? pushDiagnostic(push.lastError, txt('pushUnavailableText')) : txt('pushUnavailableText')));
        else body.push(msg('Получайте уведомления об ответах по заказу. На этом устройстве подключение необязательно.'),
          button(s.pushBusy ? txt('permissionPromptText') : txt('enableButton'), async () => {
            if (!liveAction() || s.pushBusy) return;
            s.pushBusy = true; s.status = ''; paintClientOffers(s);
            try {
              const receipt = await push.subscribe();
              if (!clientOfferLive(s)) return;
              if (receipt && receipt.subscribed === true && receipt.serverSaved === true) s.entry.closed = true;
              else s.status = txt('unconfirmedText');
            } catch (error) { if (clientOfferLive(s)) s.status = pushDiagnostic(error, txt('subscribeErrorText')); }
            finally { if (clientOfferLive(s)) { s.pushBusy = false; paintClientOffers(s); } }
          }, { disabled: s.pushBusy, 'data-client-push-enable': '' }));
        if (s.status) body.push(msg(s.status));
        if (s.guide === 'push') body.push(installationGuide(ios));
        body.push(button(txt('laterButton'), dismissPush, { 'data-client-push-later': '' }));
        children.push(h('section', { class: 'client-chat-offers__item client-chat-offers__push', 'data-client-push-offer': '' }, body));
      }
      if (s.installEligible && !s.installClosed && !isInstalled) {
        const body = [h('h3', { text: txt('installTitle') }),
          button('×', dismissInstall, { class: 'client-chat-offers__close', 'aria-label': 'Закрыть предложение установки', 'data-client-install-close': '' }),
          msg(s.phase === 'done' ? 'Заказ завершён. Сохраните приложение, чтобы возвращаться к переписке и новым заказам.' : txt('installClientText')),
          button(s.installBusy ? txt('installBusyText') : installEvent ? txt('installButton') : txt('installHelpButton'), async () => {
            if (!liveAction() || s.installBusy) return;
            markClientInstall(s);
            if (!installEvent) { showGuide('install'); return; }
            const event = installEvent; installEvent = null; s.installBusy = true; paintClientOffers(s);
            try { await event.prompt(); await event.userChoice; }
            catch (_) { if (clientOfferLive(s)) s.guide = 'install'; }
            finally { if (clientOfferLive(s)) { s.installBusy = false; paintClientOffers(s); } repaintOnboarding(); }
          }, { disabled: s.installBusy, 'data-client-install-action': '', 'aria-expanded': String(s.guide === 'install') })];
        if (s.guide === 'install') body.push(installationGuide(ios));
        body.push(button(txt('laterButton'), dismissInstall, { 'data-client-install-later': '' }));
        children.push(h('section', { class: 'client-chat-offers__item client-chat-offers__install', 'data-client-install-offer': '', 'data-client-install-phase': s.phase }, body));
      }
      s.root.replaceChildren(...children); s.root.hidden = !children.length;
      scheduleClientMark(s);
    }
    function clientChatOffers({ entryKey, conversationKey, completed } = {}) {
      if (!identity.key || typeof entryKey !== 'string' || !entryKey || entryKey.length > 2048 || typeof conversationKey !== 'string' || !/^thread:[1-9]\d{0,15}$/.test(conversationKey) || typeof completed !== 'boolean') return null;
      void loadNotificationTexts();
      const phase = completed ? 'done' : 'start', entryId = JSON.stringify([identity.key, entryKey]);
      const key = JSON.stringify([entryId, conversationKey, phase]);
      pruneClientRoots(key);
      let s = clientOfferRoots.get(key);
      if (!s) {
        let entry = clientOfferEntries.get(entryId);
        if (!entry) { entry = { closed: false }; rememberClient(clientOfferEntries, entryId, entry, 64); }
        const installKey = clientInstallKey(conversationKey, phase);
        s = { key, actor: identity.key, token: epoch, entry, phase, installKey, installEligible: !clientInstallSeen(installKey), installMarked: false, installClosed: false, pushBusy: false, installBusy: false, guide: '', status: '',
          root: h('section', { class: 'client-chat-offers card', 'data-client-chat-offers': '', 'aria-label': 'Уведомления и приложение' }) };
        rememberClient(clientOfferRoots, key, s, 12);
      }
      paintClientOffers(s); return s.root;
    }
    // Здесь сохраняется только выбор показа подсказки на устройстве. Это не авторизация и не подписка.
    function prefKey() { return `palitra:onboarding:v1:${identity.key || 'anonymous'}`; }
    function readPref() { try { return JSON.parse(win.localStorage.getItem(prefKey()) || '{}'); } catch (_) { return memoryPrefs.get(prefKey()) || {}; } }
    function savePref(value) { memoryPrefs.set(prefKey(), value); try { win.localStorage.setItem(prefKey(), JSON.stringify(value)); } catch (_) { /* приватный режим: память вкладки */ } }
    function onboardingPanel(role, moment, { force = false, embedded = false } = {}) {
      const staff = role === 'staff' || role === 'admin';
      if (!identity.key || (staff ? moment !== 'login' : role !== 'client' || moment !== 'chat')) return null;
      void loadNotificationTexts();
      const pref = readPref();
      if (!force && (pref.off === true || Number(pref.nextAt) > now())) return null;
      const provider = win.PalitraPushService;
      if (!force && provider && provider.state && provider.state.subscribed === true && provider.state.serverSaved === true) return null;
      for (const old of onboardingRoots) if (!old.isConnected) onboardingRoots.delete(old);
      // Both automatic offers and explicit settings float above the current page.
      if (!force && [...onboardingRoots].some((old) => old.isConnected && old.getAttribute('data-notification-settings') === 'true')) return null;
      if (force) for (const old of onboardingRoots) if (old.getAttribute('data-onboarding-popup') === 'true') { old.remove(); onboardingRoots.delete(old); }
      const root = h('section', { class: embedded ? 'card app-onboarding' : 'app-onboarding-popup', 'data-onboarding': role, ...(!embedded ? { 'data-onboarding-popup': 'true' } : { 'data-onboarding-embedded': 'true' }), ...(force ? { 'data-notification-settings': 'true' } : {}) });
      if (!embedded) {
        onboardingFocus.set(root, doc.activeElement);
        root.addEventListener('click', (event) => { if (event.target === root) dismissOnboarding(root); });
        root.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissOnboarding(root); return; }
          if (event.key !== 'Tab') return;
          const controls = [...root.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')].filter((el) => !el.hidden);
          if (!controls.length) { event.preventDefault(); return; }
          const index = controls.indexOf(doc.activeElement);
          if (event.shiftKey && index <= 0) { event.preventDefault(); controls[controls.length - 1].focus(); }
          else if (!event.shiftKey && (index < 0 || index === controls.length - 1)) { event.preventDefault(); controls[0].focus(); }
        });
      }
      onboardingRoots.add(root); paintOnboarding(root, staff); return root;
    }
    function dismissOnboarding(root, off = false) {
      savePref(off ? { off: true } : { nextAt: now() + 86400000 });
      removeOnboarding(root);
    }
    function removeOnboarding(root, restoreFocus = true) {
      const popup = root.getAttribute('data-onboarding-popup') === 'true';
      const previous = onboardingFocus.get(root);
      root.remove(); onboardingRoots.delete(root);
      if (popup && restoreFocus) {
        const composer = doc.querySelector('.chat__input');
        const fallback = composer && !composer.disabled ? composer : null;
        const target = previous && previous.isConnected && typeof previous.focus === 'function' && previous !== doc.body ? previous : fallback;
        if (target && typeof target.focus === 'function') target.focus();
      }
    }
    function repaintOnboarding() { for (const root of onboardingRoots) if (root.isConnected) paintOnboarding(root, root.getAttribute('data-onboarding') !== 'client'); repaintClientOffers(); }
    function installationGuide(ios) {
      const android = /Android/.test(win.navigator && win.navigator.userAgent || '');
      const platform = ios ? 'ios' : android ? 'android' : 'desktop';
      const total = ios ? 4 : 3;
      const source = ios ? 'https://support.apple.com/en-lamr/guide/iphone/iphea86e5236/26/ios/26'
        : `https://support.google.com/chrome/answer/9658361?hl=ru&co=GENIE.Platform%3D${android ? 'Android' : 'Desktop'}`;
      const guide = h('section', { class: 'app-guide', 'aria-label': 'Инструкция установки' });
      guide.append(h('p', { class: 'app-guide__example', text: txt('guideExampleText') }));
      const steps = h('ol', { class: 'app-onboarding__steps' });
      const assetRoot = win.location && (/^\/chat(?:\/|$)/.test(String(win.location.pathname || '')) || String(win.location.pathname || '').startsWith('/love-app/')) ? '/love-app/assets/install-guide/' : 'assets/install-guide/';
      function picture(file, style, alt, credit, marks = []) {
        const figure = h('figure', { class: `app-guide__figure${guideExpandedImages.has(file) ? ' is-expanded' : ''}` });
        const viewport = h('div', { class: `app-guide__picture app-guide__picture--${style}` }, h('img', { src: assetRoot + file, alt, loading: 'lazy', decoding: 'async' }));
        for (const mark of marks) viewport.append(h('span', { class: `app-guide__mark app-guide__mark--${mark}`, 'aria-hidden': 'true' }));
        const expand = button(txt(guideExpandedImages.has(file) ? 'guideBackButton' : 'guideImageButton'), () => {
          const wide = figure.classList.toggle('is-expanded');
          if (wide) guideExpandedImages.add(file); else guideExpandedImages.delete(file);
          expand.textContent = txt(wide ? 'guideBackButton' : 'guideImageButton');
          expand.setAttribute('aria-expanded', String(wide));
        }, { class: 'app-guide__zoom', 'aria-expanded': String(guideExpandedImages.has(file)), 'data-guide-image': file });
        figure.append(h('div', { class: 'app-guide__scroll', tabindex: '0', 'aria-label': 'Скриншот инструкции; увеличенное изображение можно прокручивать' }, viewport), expand, h('figcaption', { text: credit }));
        return figure;
      }
      for (let i = 1; i <= total; i++) {
        const step = h('li', {}, h('p', { text: txt(`${platform}Step${i}`) }));
        if (ios && i === 2) {
          // Icon reference, clearly separate from the real screenshots below.
          step.append(h('div', { class: 'app-guide__controls', 'aria-label': 'Значки кнопок Safari' }, h('span', { text: 'Ещё' }), h('b', { text: '•••' }), h('span', { text: '→' }), h('span', { text: 'Поделиться' }), h('b', { text: '↑' })));
        }
        if (ios && i === 3) step.append(picture('ios-share-steps.png', 'ios-share', 'Пример меню Safari: На экран Домой выделено красной рамкой.', 'Safari: пример предыдущего вида меню, CDC/NIOSH.'));
        if (ios && i === 4) step.append(picture('ios-add-home.png', 'ios-add', 'Safari: переключатель Open as Web App и кнопка Add. Это пример другого сайта.', 'Safari 26: скриншот WebKit. Add — Добавить.', ['add','toggle']));
        if (android && i === 2) step.append(picture('android-menu.png', 'android-menu', 'Меню Chrome: Add to Home screen отмечено стрелкой.', 'Chrome: пример Google, пункт Добавить на главный экран.'));
        if (android && i === 3) {
          step.append(picture('android-choice.png', 'android-choice', 'После добавления на главный экран выберите Install.', 'Chrome: пример Google, Install — Установить.'));
          step.append(picture('android-install.png', 'android-install', 'Окно установки Chrome: кнопка Install внизу справа.', 'Chrome: подтверждение установки, пример Google.', ['install']));
        }
        steps.append(step);
      }
      guide.append(steps, h('a', { class: 'app-guide__source', 'data-guide-source': '', href: source, target: '_blank', rel: 'noopener noreferrer', text: txt('guideSourceLabel') }));
      return guide;
    }
    function pushDiagnostic(error, fallback) {
      const code = error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : '';
      const status = error && Number.isInteger(error.status) && error.status >= 100 && error.status < 600 ? error.status : 0;
      const operation = error && ['capability', 'subscription', 'subscription/status'].includes(error.operation) ? error.operation : '';
      const message = error && error.name === 'PalitraPushError' && typeof error.message === 'string' ? error.message : fallback;
      const details = [code, status ? `HTTP ${status}` : '', operation].filter(Boolean).join(' · ');
      return message + (details ? ` (${details})` : '');
    }
    function paintOnboarding(root, staff) {
      const isInstalled = nativeInstalled(), inStandalone = standaloneMode();
      const notificationSettings = root.getAttribute('data-notification-settings') === 'true';
      const push = win.PalitraPushService;
      // Автоматическое предложение не служит настройкой отключения подписки.
      if (!notificationSettings && push && push.state && push.state.subscribed === true && push.state.serverSaved === true) {
        removeOnboarding(root, root.contains(doc.activeElement));
        return;
      }
      // До подтверждения состояния установленного приложения окно не вспыхивает.
      const waitingForStatus = !notificationSettings && root.getAttribute('data-onboarding-embedded') !== 'true' && isInstalled && !pushStatus && (!push || push.deliveryReady !== true || !push.state);
      root.hidden = waitingForStatus;
      root.style.display = waitingForStatus ? 'none' : '';
      if (waitingForStatus) return;
      const ios = /iPad|iPhone|iPod/.test(win.navigator && win.navigator.userAgent || '') || /Macintosh/.test(win.navigator && win.navigator.userAgent || '') && Number(win.navigator && win.navigator.maxTouchPoints) > 1;
      const children = [h('h3', { text: isInstalled ? txt('notificationTitle') : txt('installTitle') }),
        msg(inStandalone ? txt('installedText') : installed ? 'Приложение добавлено на устройство. Сейчас эта страница открыта в браузере.' : staff ? txt('installStaffText') : txt('installClientText')),
        button(installBusy ? txt('installBusyText') : !isInstalled && installEvent ? txt('installButton') : txt('installHelpButton'), async () => {
          if (isInstalled || !installEvent) { onboardingExpanded = !onboardingExpanded; repaintOnboarding(); return; }
          const event = installEvent; installEvent = null; installBusy = true; repaintOnboarding();
          try { await event.prompt(); await event.userChoice; } catch (_) { onboardingExpanded = true; }
          finally { installBusy = false; repaintOnboarding(); }
        }, { class: 'app-btn', disabled: installBusy, 'data-install': '' }),
        onboardingExpanded ? installationGuide(ios) : null];
      // Самого разрешения Notification недостаточно: без sender+subscription нельзя обещать push на закрытом сайте.
      const configured = Boolean(push && push.deliveryReady === true && typeof push.getStatus === 'function' && typeof push.subscribe === 'function');
      const permission = win.Notification && win.Notification.permission;
      if (staff || configured || root.getAttribute('data-notification-settings') === 'true') {
        children.push(h('h4', { text: txt('deviceHeading') }));
        if (!configured) children.push(msg(push && push.lastError ? pushDiagnostic(push.lastError, txt('pushUnavailableText')) : txt('pushUnavailableText')));
        else if (ios && !inStandalone) children.push(msg(txt('iosInstallText')));
        else if (permission === 'denied') children.push(msg(txt('permissionDeniedText')));
        else if (push.state && push.state.subscribed === true && push.state.serverSaved === true) children.push(msg(txt('subscribedText')),
          notificationSettings ? button(txt('disableButton'), async () => { const token = epoch; try { await push.unsubscribe(); if (token === epoch) { pushStatus = txt('unsubscribedText'); repaintOnboarding(); } } catch (error) { if (token === epoch) { pushStatus = pushDiagnostic(error, txt('subscribeErrorText')); repaintOnboarding(); } } }, { 'data-disable-push': '' }) : null);
        else children.push(button(txt('enableButton'), async () => {
          // subscribe запускается только этим явным нажатием. Провайдер обязан запросить разрешение,
          // создать browser subscription и подтвердить её сохранение на сервере для ТЕКУЩЕГО аккаунта.
          const token = epoch; pushStatus = txt('permissionPromptText'); repaintOnboarding();
          try { const receipt = await push.subscribe(); if (token !== epoch) return;
            const connected = receipt && receipt.serverSaved === true && receipt.subscribed === true;
            if (connected && !notificationSettings) { removeOnboarding(root, root.contains(doc.activeElement)); return; }
            pushStatus = connected ? txt('subscribedText') : txt('unconfirmedText');
            if (receipt && receipt.statusError) pushStatus += ' ' + pushDiagnostic(receipt.statusError, txt('unconfirmedText'));
          } catch (error) { if (token === epoch) pushStatus = pushDiagnostic(error, txt('subscribeErrorText')); }
          if (token === epoch) repaintOnboarding();
        }, { 'data-enable-push': '' }));
      }
      if (pushStatus) children.push(msg(pushStatus));
      if (root.getAttribute('data-onboarding-embedded') !== 'true' || !notificationSettings) children.push(h('div', { class: 'workflow__buttons' }, button(txt('laterButton'), () => dismissOnboarding(root), { 'data-onboarding-later': '' }),
        button(txt('neverButton'), () => dismissOnboarding(root, true), { 'data-onboarding-off': '' })));
      const content = children.filter(Boolean);
      if (root.getAttribute('data-onboarding-popup') !== 'true') { root.replaceChildren(...content); return; }
      const oldPanel = root.querySelector('.app-onboarding-popup__dialog');
      const scrollTop = oldPanel ? oldPanel.scrollTop : 0;
      const hadFocus = root.contains(doc.activeElement);
      const focusedGuide = hadFocus && doc.activeElement.getAttribute('data-guide-image');
      const focusedSource = hadFocus && doc.activeElement.hasAttribute('data-guide-source');
      const focusedAction = hadFocus ? ['data-install','data-enable-push','data-disable-push','data-onboarding-later','data-onboarding-off','data-onboarding-close'].find((key) => doc.activeElement.hasAttribute(key)) : null;
      const panel = h('div', { class: 'card app-onboarding app-onboarding-popup__dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': (isInstalled ? txt('notificationTitle') : txt('installTitle')) || (isInstalled ? notificationDefaults.notificationTitle : notificationDefaults.installTitle), tabindex: '-1' },
        button('×', () => dismissOnboarding(root), { class: 'app-onboarding-popup__close', 'aria-label': txt('closeLabel') || notificationDefaults.closeLabel, 'data-onboarding-close': '' }), ...content);
      root.replaceChildren(panel);
      panel.scrollTop = scrollTop;
      const token = epoch;
      Promise.resolve().then(() => {
        if (token !== epoch || !root.isConnected || root.hidden) return;
        const control = focusedGuide ? [...panel.querySelectorAll('[data-guide-image]')].find((el) => el.getAttribute('data-guide-image') === focusedGuide)
          : focusedSource ? panel.querySelector('[data-guide-source]') : focusedAction && panel.querySelector(`[${focusedAction}]`);
        if (control && !control.disabled) control.focus();
        else if (!root.contains(doc.activeElement)) panel.querySelector('button').focus();
      });
    }
    if (typeof win.addEventListener === 'function') {
      win.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installEvent = event; repaintOnboarding(); });
      win.addEventListener('appinstalled', () => { installed = true; installEvent = null; repaintOnboarding(); });
      win.addEventListener('palitra:push-ready', repaintOnboarding);
      win.addEventListener('resize', () => { for (const s of clientOfferRoots.values()) scheduleClientMark(s); });
      win.addEventListener('scroll', () => { for (const s of clientOfferRoots.values()) scheduleClientMark(s); }, { passive: true });
    }
    if (typeof doc.addEventListener === 'function') {
      doc.addEventListener('scroll', () => { for (const s of clientOfferRoots.values()) scheduleClientMark(s); }, true);
      doc.addEventListener('visibilitychange', () => { for (const s of clientOfferRoots.values()) scheduleClientMark(s); });
    }
    return Object.freeze({ setIdentity, canRead, canWrite, isOwner, settingsPanel, widgetSettingsPanel, completionSettingsPanel, funnelReportPanel, orderPanel, orderResponseAdvice, questionnairePanel, onboardingPanel, clientChatOffers, reloadOrder: loadOrder, hasPendingOrderAction: () => [...orders.values()].some(s => s.busy || s.pending || s.stageDraft) || completionDirty(completionSettings) });
  }
  return Object.freeze({ create, REQUIREMENTS, CHANNELS });
});
