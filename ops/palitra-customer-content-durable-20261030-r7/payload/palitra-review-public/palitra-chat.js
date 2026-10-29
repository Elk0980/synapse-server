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
/* PALITRA_RU_PHONE_CORE_BEGIN */
const palitraRuPhone = (() => {
const digits = value => String(value ?? '').replace(/\D/g, '');
const allowed = value => /^[+\d\s().-]*$/.test(String(value ?? ''));

function parseWhole(value) {
  if (!allowed(value)) return { ok: false, code: 'NON_PHONE_TEXT' };
  if (String(value).trim().startsWith('+') && !String(value).trim().startsWith('+7')) return { ok: false, code: 'NOT_RU_PHONE' };
  let national = digits(value);
  if (national.length === 11 && /^[78]/.test(national)) national = national.slice(1);
  else if (String(value).trim().startsWith('+7')) national = national.slice(1);
  if (national.length > 10) return { ok: false, code: 'NOT_RU_PHONE' };
  return { ok: true, national, complete: national.length === 10,
    canonical: national.length === 10 ? '+7' + national : null };
}

function format(national) {
  if (!/^\d{0,10}$/.test(national)) throw new TypeError('national must contain 0..10 digits');
  if (!national) return '+7';
  let result = '+7 (' + national.slice(0, 3);
  if (national.length >= 3) result += ')';
  if (national.length > 3) result += ' ' + national.slice(3, 6);
  if (national.length > 6) result += '-' + national.slice(6, 8);
  if (national.length > 8) result += '-' + national.slice(8, 10);
  return result;
}

function digitIndex(text, selection) {
  // The one country-code digit is a protected prefix; all offsets are NATIONAL.
  return Math.max(0, Math.min(10, digits(String(text).slice(0, selection)).length - 1));
}

function caret(national, index) {
  const text = format(national);
  if (index <= 0) return national ? text.indexOf('(') + 1 : 2;
  let seen = 0;
  for (let i = 2; i < text.length; i++) if (/\d/.test(text[i]) && ++seen === index) return i + 1;
  return text.length;
}

function edit(national, start, end, data, inputType) {
  if (!/^\d{0,10}$/.test(national)) throw new TypeError('bad prior national');
  start = Math.max(0, Math.min(national.length, start));
  end = Math.max(start, Math.min(national.length, end));
  if (inputType === 'deleteContentBackward' && start === end) start = Math.max(0, start - 1);
  if (inputType === 'deleteContentForward' && start === end) end = Math.min(national.length, end + 1);
  let insert = '';
  if (!String(inputType).startsWith('delete')) {
    if (!allowed(data)) return { ok: false, national, selection: start, code: 'NON_PHONE_TEXT' };
    insert = digits(data);
    // A pasted complete number is a whole-field replacement. An 8 inside national digits is kept.
    if (inputType === 'insertFromPaste' && (insert.length === 11 && /^[78]/.test(insert) || String(data).trim().startsWith('+7'))) {
      const whole = parseWhole(data);
      return whole.ok ? { ...whole, selection: whole.national.length } : { ...whole, national, selection: start };
    }
  }
  const next = national.slice(0, start) + insert + national.slice(end);
  if (next.length > 10) return { ok: false, national, selection: start, code: 'TOO_MANY_DIGITS' };
  return { ok: true, national: next, selection: start + insert.length,
    complete: next.length === 10, canonical: next.length === 10 ? '+7' + next : null };
}
function bindMask(input, onValue) {
  if (!input || input.dataset.palitraRuMask === '1') return null;
  const initial = parseWhole(input.value);
  // Unknown existing international value is preserved, never silently reinterpreted.
  if (!initial.ok) return null;
  const prior = {type:input.type,inputmode:input.getAttribute('inputmode'),autocomplete:input.getAttribute('autocomplete')};
  input.dataset.palitraRuMask = '1';
  input.type = 'tel'; input.inputMode = 'tel'; input.autocomplete = 'tel';
  let national = initial.national, composing = false, selfInput = false;
  const listeners = [];
  const listen = (type, listener) => { input.addEventListener(type, listener); listeners.push([type, listener]); };
  const paint = (index, notify) => {
    input.value = format(national);
    input.setCustomValidity(national.length === 10 ? '' : 'Укажите номер телефона: +7 и 10 цифр.');
    if (index !== undefined) input.setSelectionRange(caret(national, index), caret(national, index));
    if (onValue) onValue(input.value);
    if (notify) {
      selfInput = true;
      input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }));
      selfInput = false;
    }
  };
  const apply = (data, type) => {
    const start = digitIndex(input.value, input.selectionStart ?? input.value.length);
    const end = digitIndex(input.value, input.selectionEnd ?? input.value.length);
    const result = edit(national, start, end, data, type);
    if (result.ok) national = result.national;
    paint(result.selection, true);
  };
  listen('beforeinput', event => {
    if (composing || event.isComposing || !event.cancelable) return;
    const type = event.inputType || '';
    if (type.startsWith('delete') || type.startsWith('insert') && event.data !== null && type !== 'insertFromPaste') {
      event.preventDefault(); apply(event.data ?? '', type);
    }
  });
  listen('paste', event => {
    if (!event.clipboardData || !event.cancelable) return;
    event.preventDefault(); apply(event.clipboardData.getData('text'), 'insertFromPaste');
  });
  const fallback = () => {
    const offset = digitIndex(input.value, input.selectionStart ?? input.value.length);
    const result = parseWhole(input.value);
    if (result.ok) national = result.national;
    paint(offset, false);
  };
  listen('input', () => { if (!composing && !selfInput) fallback(); });
  listen('compositionstart', () => { composing = true; });
  listen('compositionend', () => { composing = false; fallback(); });
  paint(undefined, false);
  return { refresh: fallback, dispose() {
    for (const [type, listener] of listeners) input.removeEventListener(type, listener);
    delete input.dataset.palitraRuMask;
    input.setCustomValidity('');
    input.type = prior.type;
    for(const [name,value] of [['inputmode',prior.inputmode],['autocomplete',prior.autocomplete]]) { if(value===null) input.removeAttribute(name); else input.setAttribute(name,value); }
  } };
}

function bindConditional(input, onValue) {
  let binding = null, kind = null;
  const drafts = new Map();
  return { sync(phone) {
    const next = phone ? 'phone' : 'free';
    if(next === kind) { if(binding) binding.refresh(); else if(phone) binding=bindMask(input,onValue); return; }
    const priorKind=kind;
    if(kind !== null) drafts.set(kind,input.value);
    if(binding) { binding.dispose(); binding=null; }
    if(drafts.has(next)) input.value=drafts.get(next);
    else if(phone && priorKind==='free' && !parseWhole(input.value).ok) input.value='+7';
    kind=next;
    if(phone) binding=bindMask(input,onValue);
    else if(onValue) onValue(input.value);
  }, reset() { if(binding) binding.dispose(); binding=null; kind=null; drafts.clear(); }, dispose() { if(binding) binding.dispose(); binding=null; drafts.clear(); } };
}

return {bindMask,bindConditional};
})();
/* PALITRA_RU_PHONE_CORE_END */

  const API = '/api/customer-chat/';
  const WIDGET = window.location.pathname === '/chat/widget';
  const WELCOME = 'Здравствуйте! Поможем подобрать шары и оформление для вашего праздника. Напишите нам.';
  let widgetSettings = { revision: 0, welcomeText: WELCOME, contact: { enabled: true, text: 'Номер для связи — по желанию' }, appearance: { width: 360, height: 520, radius: 28, accent: '#69723e' }, invitation: { enabled: true, text: 'Нужна помощь с выбором шаров? Напишите нам.', delaySeconds: 15 } };
  let widgetSettingsLoading = false;
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
  // PALITRA-COMPOSER-BOTTOM: старый HTML нормализуется до той же структуры без пересоздания поля,
  // выбранного File, кнопок и их обработчиков. Состояния отправки всегда выше последней строки ввода.
  function normalizeChatLayout() {
    const view = $('pc-view'), form = $('pc-composer'), field = $('pc-text');
    let history = $('pc-history');
    if (!history) {
      history = el('div', 'pc-history'); history.id = 'pc-history';
      for (const node of [...view.childNodes]) if (node !== form) history.append(node);
      view.prepend(history);
    }
    let actions = $('pc-actions');
    if (!actions) {
      actions = el('details', 'pc-actions'); actions.id = 'pc-actions';
      actions.append(el('summary', '', 'Действия чата'));
      const telegram = $('pc-telegram'), telegramRow = telegram.parentElement;
      actions.append($('pc-telegram-state'), telegramRow, $('pc-telegram-note'), $('pc-revoke'));
      history.querySelector('.pc-head').after(actions);
    }
    const obsolete = $('pc-files-note');
    if (obsolete) obsolete.remove();
    field.rows = 1; field.placeholder = 'Написать сообщение';
    const label = form.querySelector('label[for="pc-text"]');
    if (label) { label.className = 'pc-sr-only'; label.textContent = 'Сообщение'; }
    let row = $('pc-compose-row');
    if (!row) { row = el('div', 'pc-compose-row'); row.id = 'pc-compose-row'; form.append(row); }
    row.append(field, $('pc-send'));
    let feedback = $('pc-compose-feedback');
    if (!feedback) { feedback = el('div', 'pc-compose-feedback'); feedback.id = 'pc-compose-feedback'; row.before(feedback); }
    feedback.append($('pc-state'), $('pc-blocked'), $('pc-unknown'));
    let selected = $('pc-selected');
    if (!selected) { selected = el('div', 'pc-selected'); selected.id = 'pc-selected'; selected.hidden = true; feedback.prepend(selected); }
    const count = $('pc-count'); count.hidden = true; count.setAttribute('aria-hidden', 'true'); feedback.append(count);
    for (const node of [...form.children]) {
      if (node !== row && node !== feedback && node !== label && !node.children.length) node.remove();
    }
    form.append(row);
    let contact = $('pc-contact');
    if (!contact) {
      contact = el('section', 'pc-contact'); contact.id = 'pc-contact'; contact.setAttribute('aria-label', 'Номер для связи');
      const prompt = el('p', '', 'Оставьте номер, чтобы менеджер мог связаться с вами.');
      const contactForm = el('form', 'pc-contact__form'); contactForm.id = 'pc-contact-form'; contactForm.noValidate = true;
      const field = el('input'); field.id = 'pc-phone'; field.type = 'tel'; field.autocomplete = 'tel'; field.maxLength = 32; field.placeholder = '+7…'; field.setAttribute('aria-label', 'Номер телефона');
      const button = el('button', 'pc-btn pc-btn--quiet', 'Отправить номер'); button.id = 'pc-contact-send'; button.type = 'submit';
      const status = el('p', 'pc-note'); status.id = 'pc-contact-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      contactForm.append(field, button); contact.append(prompt, contactForm, status);
    }
    history.insertBefore(contact, $('pc-messages'));
    if (!$('pc-contact-edit')) { const edit = el('button', 'pc-btn pc-btn--quiet', 'Изменить номер'); edit.type = 'button'; edit.id = 'pc-contact-edit'; edit.hidden = true; actions.append(edit); }
    if (!$('pc-app')) { const app = el('a', 'pc-btn pc-btn--quiet', 'Открыть приложение'); app.id = 'pc-app'; app.href = '/love-app/shop.html#K_SITE_CHAT'; app.target = '_blank'; app.rel = 'noopener noreferrer'; actions.append(app); }
    if (WIDGET) {
      document.documentElement.classList.add('pc-widget');
      field.placeholder = 'Сообщение';
      view.setAttribute('aria-label', 'Переписка с Palitra Love'); view.removeAttribute('aria-labelledby');
      const summary = actions.querySelector('summary');
      summary.textContent = '⋯'; summary.title = 'Действия чата'; summary.setAttribute('aria-label', 'Действия чата');
      contact.querySelector('p').textContent = 'Номер для связи — по желанию';
      $('pc-contact-send').textContent = 'Оставить';
      let welcome = $('pc-welcome');
      if (!welcome) {
        welcome = el('aside', 'pc-welcome'); welcome.id = 'pc-welcome'; welcome.hidden = true;
        welcome.setAttribute('aria-label', 'Приветствие Palitra Love');
        welcome.append(el('strong', 'pc-welcome__brand', 'Palitra Love'), el('p', '', WELCOME));
        history.insertBefore(welcome, $('pc-messages'));
      }
    }
    // iOS с клавиатурой меняет visual viewport, но может сохранять прежнюю высоту layout viewport.
    const fitViewport = () => {
      const viewport = window.visualViewport;
      if (!viewport || !(viewport.height > 0)) return;
      $('pc').style.setProperty('--pc-viewport-height', `${viewport.height}px`);
      $('pc').style.setProperty('--pc-viewport-top', `${Math.max(0, viewport.offsetTop || 0)}px`);
      fitComposerField();
    };
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', fitViewport, { passive: true });
      window.visualViewport.addEventListener('scroll', fitViewport, { passive: true });
      fitViewport();
    }
    window.addEventListener('resize', fitComposerField, { passive: true });
  }
  normalizeChatLayout();
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
    messages: [], before: null, scope: null, pageGen: 0, pending: null, memoryPending: null, sending: false, poll: 0, returnId: null,
    // PHASEE: загрузки включены сервером ({maxBytes}) и выбранный файл { file, name, size, sha256, threadId, epoch } — только в памяти.
    uploadInfo: null, file: null, fileSeq: 0, empty: false, contactRequest: null, contactEdit: false,
    // PHASEE repair R1: файл выбран, sha256 ещё считается — { seq, threadId, epoch, name, size }; пока он есть, отправки нет.
    filePreparing: null, orderLifecycle: null };

  // Клиентские предложения не открывают сессию и не меняют текущий ввод/файл.
  const offersUI = window.PalitraWorkflowUI && typeof window.PalitraWorkflowUI.create === 'function'
    ? window.PalitraWorkflowUI.create({ document, window, request: null }) : null;
  const offersHost = el('div', 'pc-offers'); offersHost.id = 'pc-offers'; offersHost.hidden = true;
  $('pc-view').insertBefore(offersHost, $('pc-history'));
  let offerEntry = 0, offerOpen = false, offerIdentity = '', authPushRefreshEpoch = -1, parentAcknowledged = false;
  function resetClientOffers() {
    offerOpen = false; offerIdentity = ''; state.orderLifecycle = null;
    offersHost.replaceChildren(); offersHost.hidden = true;
    if (offersUI) offersUI.setIdentity({ key: '', role: 'client' });
  }
  function paintClientOffers({ entry = false } = {}) {
    if (!offersUI || !state.csrf || !state.thread || state.thread.id !== state.threadId || $('pc-view').hidden) return;
    const identity = 'legacy-thread:' + state.thread.id;
    if (identity !== offerIdentity) { offersUI.setIdentity({ key: identity, role: 'client' }); offerIdentity = identity; offerOpen = false; }
    if (entry || !offerOpen) {
      offerEntry++;
      const provider = window.PalitraPushService;
      // Auth-ready or late adapter initialization already reads this initial session once.
      if (authPushRefreshEpoch === state.epoch) authPushRefreshEpoch = -1;
      else if (provider && provider.checking !== true && typeof provider.refresh === 'function') {
        try { Promise.resolve(provider.refresh()).catch(() => {}); } catch (_) { /* Explicit controls remain available. */ }
      }
    }
    offerOpen = true;
    const root = offersUI.clientChatOffers({ entryKey: 'legacy:' + state.epoch + ':' + offerEntry,
      conversationKey: 'thread:' + state.thread.id, completed: Boolean(state.orderLifecycle && state.orderLifecycle.completed === true) });
    if (root && offersHost.firstElementChild !== root) offersHost.replaceChildren(root);
    offersHost.hidden = !root;
  }
  function emitPushSession(type) {
    const provider = window.PalitraPushService;
    authPushRefreshEpoch = type === 'palitra:push-auth-ready' && provider && typeof provider.refresh === 'function' ? state.epoch : -1;
    window.dispatchEvent(new CustomEvent(type));
  }
  async function pushRequest(operation, options = {}) {
    const method = options.method || 'GET';
    const permitted = operation === 'capability' ? method === 'GET' : operation === 'subscription' ? ['GET', 'POST', 'DELETE'].includes(method) : operation === 'subscription/status' && method === 'POST';
    const epoch = state.epoch, csrf = state.csrf;
    if (!permitted || !CHAT_CSRF.test(csrf)) throw Object.assign(new Error('Откройте свой чат для подключения уведомлений.'), { status: 403 });
    const { res, data } = await request(API + 'push/' + operation, { method, headers: { 'X-Palitra-Chat-CSRF': csrf },
      ...(method !== 'GET' ? { body: options.body } : {}) });
    if (epoch !== state.epoch || csrf !== state.csrf) throw Object.assign(new Error('Сеанс изменился. Откройте чат заново.'), { status: 403 });
    if (res.status === 401 && data && SESSION_LOST.has(data.code)) sessionLost();
    if (!res.ok || !data || typeof data !== 'object') throw Object.assign(new Error('Не удалось подтвердить подключение уведомлений.'), { status: res.status, code: data && data.code, operation, method });
    return data;
  }
  // Только собственная cookie и текущий CSRF. Host не предоставляет доступ по номеру заявки.
  if (!window.PalitraShellHost) Object.defineProperty(window, 'PalitraShellHost', { writable: false, configurable: false,
    value: Object.freeze({ mode: 'native', verified: true, origin: window.location.origin, push: Object.freeze({ get authenticated() { return Boolean(state.csrf); },
      scopePath: '/love-app/', workerPath: '/love-app/palitra-sw.js', request: pushRequest }) }) });

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
  const viewStatus = (text, error = false) => { const node = $('pc-view-status'); node.textContent = text || ''; node.dataset.state = error ? 'error' : ''; const retry = $('pc-refresh'); if (WIDGET && retry) retry.hidden = !error; };
  const sendState = (text, kind = '') => { const node = $('pc-state'); node.textContent = text || ''; node.dataset.state = kind; };
  const telegramNote = (text, error = false) => { const node = $('pc-telegram-note'); node.textContent = text || ''; node.dataset.state = error ? 'error' : ''; };
  function hideMain() {
    contactPrefill.reset();
    ownAccountPhone.invalidate();
    resetClientOffers();
    stopPoll();
    $('pc-main').hidden = true;
    $('pc-main').classList.remove('is-open');
    $('pc-view').hidden = true;
    $('pc-title').textContent = '';
    $('pc-threads').replaceChildren();
    $('pc-messages').replaceChildren();
    $('pc-threads-more').hidden = true;
    clearFile();
    state.threadId = null; state.thread = null; state.messages = []; state.before = null; state.scope = null; state.threadsBefore = null; state.empty = false; state.contactRequest = null;
    paintWelcome();
  }
  function showList() {
    resetClientOffers();
    saveDraft();
    stopPoll();
    $('pc-main').classList.remove('is-open');
    $('pc-view').hidden = true;
    state.returnId = state.threadId;
    clearFile();
    state.threadId = null; state.thread = null; state.messages = []; state.before = null; state.scope = null; state.empty = false;
    $('pc-messages').replaceChildren();
    renderComposer();
  }

  /* Empty sessions and owned histories share this renderer; opening performs no start/write. */
  const composerReady = () => Boolean(state.csrf && (state.empty || state.thread && state.thread.id === state.threadId));
  // Presentation only: no message ID, invented time, stored receipt or write on opening an empty conversation.
  function paintWelcome() { const node = $('pc-welcome'); if (node) { node.querySelector('p').textContent = widgetSettings.welcomeText; node.hidden = !composerReady() || state.messages.length > 0 || !widgetSettings.welcomeText.trim(); } }
  const contactState = value => value && typeof value.needed === 'boolean' && typeof value.provided === 'boolean' && value.needed !== value.provided ? value : null;
  function canLeaveChat(nextId) {
    if (state.sending || state.file || state.filePreparing || state.pending && state.pending.threadId !== nextId) { sendState('Сначала завершите текущую отправку или уберите выбранный файл. Черновик сохранён.', 'error'); return false; }
    return true;
  }
  /* PALITRA_ACCEPTED_CONTACT_PREFILL_BEGIN */
  function createContactPrefillController({ input, getContext, phoneKit }) {
    const drafts = new Map(); let activeKey = null, active = null, binding = null, suspended = false, disposed = false, unboundDirty = false;
    const stopMask = () => { if (binding) binding.dispose(); binding = null; };
    const refreshMask = () => {
      if (disposed) return;
      if (binding) binding.refresh(); else binding = phoneKit.bindMask(input);
    };
    const empty = value => !String(value).trim() || /^\+7\s*$/.test(String(value).trim());
    const valid = (value, context) => {
      const thread = context.thread;
      if (!value || Object.keys(value).sort().join(',') !== 'name,orderId,phone,source,threadId' || value.source !== 'accepted-order'
        || !thread || thread.id !== context.threadId || !Number.isSafeInteger(thread.orderId) || thread.orderId < 1
        || value.threadId !== thread.id || value.orderId !== thread.orderId || typeof value.name !== 'string' || value.name.length > 100
        || /[\x00-\x1f\x7f]/.test(value.name) || typeof value.phone !== 'string' || !/^\+[1-9]\d{9,14}$/.test(value.phone)) return null;
      return value;
    };
    function clearInvalidAccountInjection(context) {
      if (context.pending || context.sending) return;
      const account = context.account, user = account?.status === 'ready' && account.epoch === context.epoch ? account.user : null;
      for (const entry of drafts.values()) {
        if (entry.injectedSource !== 'account' || entry.dirty || entry.injected === null
          || user && user.id === entry.accountId && user.phone === entry.accountPhone) continue;
        if (entry === active && input.value === entry.injected) { input.value = ''; refreshMask(); }
        if (entry.value === entry.injected) entry.value = '';
        entry.injected = null; entry.injectedSource = null;
      }
    }
    function sync({ enabled = true } = {}) {
      if (disposed || suspended) return;
      const context = getContext();
      // Unknown/contact/file attempts retain their exact previous body and displayed phone.
      if (context.pending || context.sending) { stopMask(); return; }
      clearInvalidAccountInjection(context);
      const seed = context.thread;
      if (!context.ready || !enabled || !context.empty && (!seed || seed.id !== context.threadId)) return;
      const key = context.empty ? `${context.epoch}|empty` : `${context.epoch}|${seed.id}|${seed.orderId === null ? 'loose' : seed.orderId}`;
      if (key !== activeKey) {
        if (active) active.value = input.value;
        stopMask(); activeKey = key;
        active = drafts.get(key) || { value: input.value, dirty: unboundDirty || !empty(input.value), injected: null };
        if (!drafts.has(key) && drafts.size) active = { value: '', dirty: false, injected: null };
        unboundDirty = false; drafts.set(key, active); input.value = active.value; refreshMask();
      } else refreshMask();
      const request = context.contactRequest;
      const accepted = request && request.needed === true && request.provided === false ? valid(request.prefill, context) : null;
      const account = context.account;
      const own = context.empty && context.threadId === null && context.thread === null && request?.provided !== true
        && account?.status === 'ready' && account.epoch === context.epoch && account.user
        && /^\+[1-9]\d{9,14}$/.test(account.user.phone) ? account.user : null;
      const suggestion = accepted || (own ? { phone: own.phone } : null);
      if (!suggestion) {
        if (!active.dirty && active.injected !== null && input.value === active.injected) { input.value = ''; active.injected = null; refreshMask(); active.value = input.value; }
        return;
      }
      if (active.dirty || !empty(input.value)) return;
      stopMask(); input.value = suggestion.phone; refreshMask(); active.injected = input.value; active.value = input.value;
      active.injectedSource = accepted ? 'accepted-order' : 'account';
      if (own && !accepted) { active.accountId = own.id; active.accountPhone = own.phone; }
    }
    const dirty = () => { if (active) { active.dirty = true; active.value = input.value; active.injected = null; } else unboundDirty = true; };
    input.addEventListener('input', dirty); input.addEventListener('change', dirty);
    const resetForm = () => {
      if (active) { active.dirty = true; active.injected = null; } else unboundDirty = true;
      const captured = activeKey;
      queueMicrotask(() => { if (!disposed && !suspended && captured === activeKey && !getContext().pending) { refreshMask(); if (active) active.value = input.value; } });
    };
    input.form?.addEventListener('reset', resetForm);
    return {
      sync,
      accountChanged() { if (!disposed) clearInvalidAccountInjection(getContext()); },
      reset() { stopMask(); drafts.clear(); active = null; activeKey = null; unboundDirty = false; if (!getContext().pending) input.value = ''; },
      suspend() { suspended = true; }, resume() { suspended = false; },
      dispose() { disposed = true; stopMask(); drafts.clear(); input.removeEventListener('input', dirty); input.removeEventListener('change', dirty); input.form?.removeEventListener('reset', resetForm); }
    };
  }
  const contactPrefill = createContactPrefillController({ input: $('pc-phone'), phoneKit: palitraRuPhone,
    getContext: () => ({ epoch: state.epoch, ready: composerReady(), empty: state.empty, threadId: state.threadId, thread: state.thread,
      contactRequest: state.contactRequest, pending: state.pending, sending: state.sending, account: ownAccountPhone.snapshot() }) });
  /* PALITRA_ACCEPTED_CONTACT_PREFILL_END */


  /* PALITRA_OWN_ACCOUNT_PHONE_VIEW_BEGIN */
  // Readonly presentation state. Same successful existing session response; never a grant/identity setter.
  function createOwnAccountPhoneView({ getEpoch, changed }) {
    let generation = 0;
    let current = Object.freeze({ epoch: getEpoch(), generation, status: 'unavailable', user: null });
    const publish = (status, user = null) => {
      current = Object.freeze({ epoch: getEpoch(), generation, status, user });
      try { changed(); } catch (_) { /* Presentation failure must not change the existing account/chat handshake. */ }
    };
    const project = user => {
      if (user === null) return null;
      if (!user || typeof user !== 'object' || Array.isArray(user) || typeof user.id !== 'string'
        || !/^[A-Za-z0-9_-]{1,128}$/.test(user.id) || typeof user.phone !== 'string' || user.phone.length > 32
        || !/^\+?[0-9\s().-]*$/.test(user.phone)) return undefined;
      let phone = user.phone.trim(), digits = phone.replace(/\D/g, '');
      if (!phone) phone = '';
      else if (phone.startsWith('+') && /^[1-9]\d{9,14}$/.test(digits)) phone = '+' + digits;
      else if (/^[78]\d{10}$/.test(digits)) phone = '+7' + digits.slice(1);
      else if (/^\d{10}$/.test(digits)) phone = '+7' + digits;
      else return undefined;
      return Object.freeze({ id: user.id, phone });
    };
    const live = ticket => ticket && ticket.epoch === getEpoch() && ticket.generation === generation;
    return Object.freeze({
      snapshot: () => current,
      begin() { generation++; const ticket = Object.freeze({ epoch: getEpoch(), generation }); publish('loading'); return ticket; },
      finish(ticket, value) {
        if (!live(ticket)) return false;
        const user = project(value); publish(user === undefined ? 'unavailable' : 'ready', user === undefined ? null : user); return user !== undefined;
      },
      fail(ticket) { if (live(ticket)) publish('unavailable'); },
      invalidate() { generation++; publish('unavailable'); }
    });
  }
  const ownAccountPhone = createOwnAccountPhoneView({ getEpoch: () => state.epoch, changed: () => {
    contactPrefill.accountChanged();
    if (state.empty && state.threadId === null && state.thread === null && composerReady() && document.visibilityState === 'visible') paintContact();
  } });
  let ownAccountRefresh = null, ownAccountRefreshRequested = false;
  const canRefreshOwnAccountPhone = () => state.empty && state.threadId === null && state.thread === null && composerReady()
    && !state.pending && !state.sending && document.visibilityState === 'visible';
  function requestOwnAccountPhoneRefresh() {
    if (!canRefreshOwnAccountPhone()) return;
    if (ownAccountRefresh) { ownAccountRefreshRequested = true; return; }
    const snapshot = ownAccountPhone.snapshot();
    if (snapshot.epoch === state.epoch && snapshot.status === 'ready') return;
    ownAccountRefresh = accountCsrf().catch(() => {}).finally(() => {
      ownAccountRefresh = null;
      if (ownAccountRefreshRequested) { ownAccountRefreshRequested = false; queueMicrotask(requestOwnAccountPhoneRefresh); }
    });
  }
  function invalidateOwnAccountPhone({ refresh = false } = {}) {
    ownAccountPhone.invalidate();
    if (refresh) requestOwnAccountPhoneRefresh();
  }
  let ownAccountInvalidationChannel = null;
  try {
    if (typeof window.BroadcastChannel === 'function') {
      ownAccountInvalidationChannel = new window.BroadcastChannel('palitra-account-invalidation-v1');
      ownAccountInvalidationChannel.addEventListener('message', event => {
        if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)
          || Object.keys(event.data).sort().join(',') !== 'type,version' || event.data.version !== 1 || event.data.type !== 'invalidate') return;
        invalidateOwnAccountPhone({ refresh: true });
      });
    }
  } catch (_) { /* Readiness comes from same-origin GET, never from a cross-tab message. */ }
  window.addEventListener('focus', () => {
    if (canRefreshOwnAccountPhone()) invalidateOwnAccountPhone({ refresh: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') invalidateOwnAccountPhone();
    else if (canRefreshOwnAccountPhone()) invalidateOwnAccountPhone({ refresh: true });
  });
  /* PALITRA_OWN_ACCOUNT_PHONE_VIEW_END */


  function paintContact() {
    const known = contactState(state.contactRequest), ready = composerReady(), provided = Boolean(known && known.provided), record = state.pending;
    const pendingContact = Boolean(record && record.type === 'contact');
    const enabled = !WIDGET || widgetSettings.contact.enabled || pendingContact;
    $('pc-contact').hidden = !ready || !enabled || provided && !state.contactEdit && !pendingContact;
    $('pc-contact-edit').hidden = !ready || !provided || WIDGET && !widgetSettings.contact.enabled;
    if (WIDGET) $('pc-contact').querySelector('p').textContent = widgetSettings.contact.text;
    $('pc-contact-send').disabled = !ready || state.sending || Boolean(record);
    $('pc-phone').readOnly = Boolean(record && record.type === 'contact');
    if (record && record.type === 'contact' && record.threadId === state.threadId) $('pc-phone').value = record.phone;
    contactPrefill.sync({ enabled });
  }
  function showEmptyChat() {
    if (!state.csrf) return;
    resetClientOffers();
    state.empty = true; state.threadId = null; state.thread = null; state.messages = []; state.before = null; state.scope = null; state.contactRequest = null;
    state.uploadInfo = { maxBytes: MAX_UPLOAD }; // Local selection only; the explicit start request verifies upload availability.
    $('pc-main').classList.add('is-open'); $('pc-view').hidden = false;
    $('pc-title').textContent = 'Чат с Palitra Love'; $('pc-telegram-state').textContent = ''; $('pc-telegram').hidden = true; $('pc-earlier').hidden = true; $('pc-messages').replaceChildren();
    restoreDraft(null); sendState(''); paintContact(); renderComposer();
    requestOwnAccountPhoneRefresh();
  }
  function validStartReceipt(data) {
    return Boolean(data && data.ok === true && typeof data.duplicate === 'boolean' && positive(data.threadId) && data.thread && data.thread.id === data.threadId && (data.thread.orderId === null || positive(data.thread.orderId)) && contactState(data.contactRequest));
  }
  function adoptStartedThread(record, data) {
    const old = record.threadId;
    record.threadId = data.threadId;
    if (state.threadId === old && (old !== null || state.empty)) {
      if (state.file && state.file.threadId === old) state.file.threadId = data.threadId;
      state.threadId = data.threadId; state.thread = data.thread; state.empty = false; state.contactRequest = data.contactRequest;
      const field = $('pc-text'); if (field.value) writeJson(draftKey(data.threadId), { text: field.value, start: field.selectionStart, end: field.selectionEnd });
      forget(draftKey(null)); writeJson(LAST_KEY, { threadId: data.threadId, orderId: positive(data.thread.orderId) });
    }
  }
  $('pc-contact-edit').addEventListener('click', () => { state.contactEdit = true; paintContact(); $('pc-phone').focus(); });
  $('pc-contact-form').addEventListener('submit', event => {
    event.preventDefault();
    if (gate().mode !== 'new') { sendState('Сначала проверьте текущую отправку выше поля сообщения.', 'error'); return; }
    if ($('pc-phone').dataset.palitraRuMask === '1' && !$('pc-phone').checkValidity()) { $('pc-phone').reportValidity(); return; }
    const phone = $('pc-phone').value.trim();
    if (!phone || phone.length > 32) { $('pc-contact-status').textContent = 'Введите номер телефона с кодом страны.'; return; }
    const requestId = uuid(); let body = state.empty ? { requestId, phone } : { threadId: state.threadId, requestId, phone };
    if (state.empty) body = window.PalitraAttribution?.enrich(body) || body;
    transmitContact({ v: 1, type: 'contact', action: state.empty ? 'start' : 'contact', threadId: state.threadId, requestId, phone, body, unknown: false, inFlight: false });
  });
  async function transmitContact(record) {
    const epoch = state.epoch, retry = record.unknown === true;
    state.sending = true; record.inFlight = true; writeRecord(record); renderComposer(); $('pc-contact-status').textContent = 'Отправляем номер…';
    try {
      const data = await chat(record.action === 'start' ? 'start' : 'contact', record.body, { write: true });
      if (epoch !== state.epoch) return;
      if (record.action === 'start' && (!validStartReceipt(data) || record.threadId !== null && data.threadId !== record.threadId) || record.action !== 'start' && (data.threadId !== record.threadId || typeof data.duplicate !== 'boolean') || !data.message || !positive(data.message.id) || !contactState(data.contactRequest) || data.contactRequest.provided !== true) throw new ChatError('Не удалось подтвердить отправку номера. Проверьте ту же отправку.', 200, 'RECEIPT', { unknown: true });
      if (record.action === 'start') adoptStartedThread(record, data);
      clearRecord(record); state.contactRequest = data.contactRequest; state.contactEdit = false; $('pc-contact-status').textContent = ''; sendState('Номер отправлен.', 'ok');
      void openThread(record.threadId, { quiet: true });
    } catch (error) {
      if (epoch !== state.epoch) return;
      if (!retry && error.refused) clearRecord(record);
      else { record.inFlight = false; record.unknown = true; writeRecord(record); }
      $('pc-contact-status').textContent = error.unknown || record.unknown ? 'Не удалось подтвердить отправку номера. Проверьте и повторите ту же отправку выше поля сообщения.' : error.message;
    } finally { if (epoch === state.epoch) { state.sending = false; renderComposer(); } }
  }

  /* ---------- сессия ---------- */
  async function accountCsrf() {
    const ownTicket = ownAccountPhone.begin();
    let answer;
    try { answer = await request('/api/draft-account/session', { method: 'GET' }); }
    catch (error) { ownAccountPhone.fail(ownTicket); throw error; }
    const { res, data } = answer;
    if (!res || res.status !== 200 || !data || typeof data.csrf !== 'string' || !ACCOUNT_CSRF.test(data.csrf)) { ownAccountPhone.fail(ownTicket); return ''; }
    ownAccountPhone.finish(ownTicket, data.user);
    return data.csrf;
  }
  async function boot({ restart = false } = {}) {
    state.epoch += 1; state.sending = false;
    const epoch = state.epoch;
    state.csrf = '';
    emitPushSession('palitra:session-ended');
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
        emitPushSession('palitra:push-auth-ready');
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
    const listed = await loadThreads();
    if (epoch !== state.epoch || !listed) return;
    if (state.pending && state.pending.action === 'start' && state.pending.threadId === null) { showEmptyChat(); return; }
    const wanted = requestedThread();
    if (wanted) openThread(wanted, { focus: true }); else showEmptyChat();
  }
  function requestedThread() {
    const raw = new URLSearchParams(window.location.search).get('thread');
    if (raw !== null) return THREAD_PARAM.test(raw) ? Number(raw) : null;
    const last = readJson(LAST_KEY);
    const buttons = $('pc-threads').querySelectorAll('[data-thread-id]');
    if (last && positive(last.threadId) && [...buttons].some(button => Number(button.dataset.threadId) === last.threadId)) return last.threadId;
    return buttons.length ? Number(buttons[0].dataset.threadId) : null;
  }
  // Сессия чата закончилась (истекла, закрыта, cookie нет): прежняя переписка здесь недоступна, новая сессия — пустая.
  function sessionLost() {
    state.epoch += 1;
    state.csrf = '';
    emitPushSession('palitra:session-ended');
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
      $('pc-list-status').textContent = list.childElementCount ? '' : 'Начните переписку с Palitra Love.';
      if (state.returnId && !state.threadId) {
        const button = list.querySelector(`[data-thread-id="${state.returnId}"]`);
        if (button && (document.activeElement === document.body || !document.activeElement || !document.activeElement.isConnected)) button.focus();
      }
      return true;
    } catch (error) {
      if (!live() || (error.status === 401 && SESSION_LOST.has(error.code))) return false;
      $('pc-list-status').textContent = `Заявки не загрузились: ${error.message}`;
    }
  }
  function threadItem(thread) {
    const li = el('li');
    const button = el('button', 'pc-thread');
    button.type = 'button';
    button.dataset.threadId = String(thread.id);
    button.append(el('strong', '', positive(thread.orderId) ? `Заявка №${thread.orderId}` : 'Чат с Palitra Love'));
    button.append(el('span', 'pc-muted', [thread.telegramLinked === true ? 'Telegram подключён' : '', when(thread.lastMessageAt || thread.createdAt)].filter(Boolean).join(' · ')));
    button.addEventListener('click', () => openThread(thread.id, { focus: true }));
    li.append(button);
    return li;
  }
  $('pc-threads-more').addEventListener('click', () => loadThreads({ append: true }));
  $('pc-back').addEventListener('click', () => {
    const id = state.threadId;
    if (!canLeaveChat()) return;
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
  // Same customer cookie and compose target; URL IDs and other message threads never grant access.
  function conversationPage(data, seed, before = null) {
    const bad = () => { throw new ChatError('Сервер не подтвердил общую переписку. Обновите её.', 409, 'CONVERSATION_SCOPE_CHANGED'); };
    if (!data || !data.thread || data.thread.id !== seed || !data.seedThread || data.seedThread.id !== seed
      || !(data.seedThread.orderId === null || positive(data.seedThread.orderId)) || data.thread.orderId !== data.seedThread.orderId
      || !data.composeThread || data.composeThread.id !== seed || data.composeThread.orderId !== data.seedThread.orderId
      || !data.scope || data.scope.view !== 'conversation-v1' || !['session-grants', 'single-thread'].includes(data.scope.kind)
      || data.scope.limited !== (data.scope.kind === 'single-thread') || !/^[a-f0-9]{64}$/.test(data.scope.key || '')
      || !Array.isArray(data.messages) || data.messages.length > PAGE) bad();
    const seen = new Set();
    for (const m of data.messages) {
      if (!validMessage(m) || !['customer', 'shop'].includes(m.author) || typeof m.text !== 'string' || !positive(m.threadId) || !(m.orderId === null || positive(m.orderId)) || seen.has(m.id)
        || (before !== null && m.id >= before) || (data.scope.kind === 'single-thread' && (m.threadId !== seed || m.orderId !== data.seedThread.orderId))) bad();
      seen.add(m.id);
    }
    const messages = data.messages.slice().sort((a, b) => a.id - b.id), cursor = data.nextBefore == null ? null : data.nextBefore;
    if (cursor !== null && (!positive(cursor) || !messages.length || cursor !== messages[0].id || (before !== null && cursor >= before))) bad();
    // Completion is a narrow projection of this verified owned seed, never a staff API or message inference.
    const lifecycle = data.orderLifecycle;
    if (lifecycle != null && (typeof lifecycle !== 'object' || Array.isArray(lifecycle)
      || Object.keys(lifecycle).sort().join(',') !== 'completed,orderId' || !positive(lifecycle.orderId)
      || lifecycle.orderId !== data.thread.orderId || typeof lifecycle.completed !== 'boolean')) bad();
    // Public customer reader ignores all staff-only fields, even if an invalid response contains them.
    return { thread: data.thread, scope: data.scope, messages, nextBefore: cursor, uploads: data.uploads, contactRequest: data.contactRequest,
      orderLifecycle: lifecycle == null ? null : { orderId: lifecycle.orderId, completed: lifecycle.completed } };
  }
  function invalidateConversation() {
    resetClientOffers();
    stopPoll(); state.thread = null; state.messages = []; state.before = null; state.scope = null; state.pageGen += 1;
    state.seq.earlier += 1; $('pc-messages').replaceChildren(); $('pc-earlier').hidden = true;
    // The composer node, draft, pending request, selected File and seed threadId remain untouched.
  }
  const refresh = el('button', 'pc-btn pc-btn--quiet', 'Обновить переписку');
  refresh.type = 'button'; refresh.id = 'pc-refresh';
  refresh.addEventListener('click', () => { if (state.threadId && !state.sending) openThread(state.threadId); });
  if (WIDGET) { refresh.textContent = 'Повторить загрузку'; refresh.hidden = true; $('pc-view-status').after(refresh); }
  else $('pc-title').after(refresh);
  async function openThread(id, { quiet = false, focus = false } = {}) {
    if (!state.csrf || !positive(id)) return;
    if (id !== state.threadId && !canLeaveChat(id)) return;
    const live = ticket('thread');
    const switching = state.threadId !== id;
    if (switching) {
      resetClientOffers();
      saveDraft();
      clearFile();   // PHASEE: выбранный файл относится только к своему чату
      state.threadId = id; state.thread = null; state.messages = []; state.before = null; state.scope = null; state.pageGen += 1; state.empty = false; state.contactRequest = null; state.contactEdit = false;
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
      const data = conversationPage(await chat('messages', { threadId: id, limit: PAGE, view: 'conversation-v1' }), id);
      if (!live() || state.threadId !== id) return;
      if (state.scope && state.scope.key !== data.scope.key) throw new ChatError('Состав переписки изменился. Обновите переписку.', 409, 'CONVERSATION_SCOPE_CHANGED');
      const fresh = data.messages;
      const nextBefore = positive(data.nextBefore);
      let messages = fresh, before = nextBefore, merged = false;
      if (!switching && state.messages.length && state.scope && state.scope.key === data.scope.key) {
        // Тихое обновление не стирает уже загруженные ранние сообщения, если новая страница с ними смыкается.
        const previousIds = new Set(state.messages.map(m => m.id)), overlap = fresh.some(m => previousIds.has(m.id));
        if (nextBefore !== null && overlap) { const retained = state.messages.filter(m => m.id < fresh[0].id); messages = mergeById(retained, fresh); before = retained.length ? state.before : nextBefore; merged = true; }
      }
      const hadNewest = state.messages.length ? state.messages[state.messages.length - 1].id : 0;
      // Repair P01: история заменена новой страницей — начатые раньше «Показать ранее» к ней больше не относятся.
      if (!merged) state.pageGen += 1;
      state.thread = data.thread; state.messages = messages; state.before = before; state.scope = data.scope; state.contactRequest = data.contactRequest; state.orderLifecycle = data.orderLifecycle; paintContact();
      // PHASEE: выбор файла — только если сервер прямо сообщил, что загрузки включены (иначе — прежний «только текст»).
      state.uploadInfo = data.uploads && data.uploads.enabled === true && positive(data.uploads.maxBytes)
        ? { maxBytes: Math.min(data.uploads.maxBytes, MAX_UPLOAD) } : null;
      // Repair R1: загрузки выключены — выбор файла снимается явно (иначе его нельзя было бы ни отправить, ни убрать).
      if (!state.uploadInfo && (state.file || state.filePreparing)) sendState('Отправка файлов сейчас недоступна. Выбранный файл и подпись сохранены.', 'error');
      renderThread();
      viewStatus('');
      writeJson(LAST_KEY, { orderId: positive(data.thread.orderId), threadId: id });
      if (switching) {
        const history = $('pc-history'); history.scrollTop = history.scrollHeight;
      } else if (messages.length && messages[messages.length - 1].id > hadNewest && !nearBottom()) {
        $('pc-new-below').textContent = 'Есть новые сообщения ниже.';
      }
      renderComposer();
      if (focus) $('pc-title').focus({ preventScroll: true });
      schedulePoll();
    } catch (error) {
      if (!live() || (error.status === 401 && SESSION_LOST.has(error.code))) return;
      if (error.code === 'MISMATCH' || error.status === 404 || error.status === 409 || error.status === 403) invalidateConversation();
      viewStatus(error.status === 404 ? NOT_HERE : `Сообщения не загрузились: ${error.message}`, true);
      renderComposer();
      // Сбой тихого чтения доступного чата не останавливает опрос навсегда.
      if (quiet && state.thread && state.thread.id === id) schedulePoll();
    }
  }
  function nearBottom() {
    const last = $('pc-messages').lastElementChild;
    if (!last) return true;
    return last.getBoundingClientRect().top < $('pc-history').getBoundingClientRect().bottom;
  }
  function renderThread() {
    const thread = state.thread;
    $('pc-title').textContent = positive(thread.orderId) ? `Заявка №${thread.orderId}` : 'Чат с Palitra Love';
    const linked = thread.telegramLinked === true;
    $('pc-telegram-state').textContent = linked ? 'Telegram подключён к этой заявке: ответы менеджера придут и туда.' : 'Можно продолжить переписку в Telegram — она останется и здесь.';
    $('pc-telegram').hidden = linked;
    $('pc-earlier').hidden = !state.before;
    renderMessages();
    paintClientOffers();
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
    const avatar = el('span', `pc-msg__avatar${own ? '' : ' pc-msg__avatar--palitra'}`);
    avatar.setAttribute('aria-hidden', 'true');
    const fallback = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    fallback.setAttribute('viewBox', '0 0 24 24'); fallback.setAttribute('focusable', 'false');
    const head = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); head.setAttribute('cx', '12'); head.setAttribute('cy', '8'); head.setAttribute('r', '4');
    const body = document.createElementNS('http://www.w3.org/2000/svg', 'path'); body.setAttribute('d', 'M4 22v-3a8 8 0 0 1 16 0v3'); fallback.append(head, body); avatar.append(fallback);
    if (!own) { const image = el('img', 'pc-msg__avatar-image'); image.alt = ''; image.decoding = 'async'; image.src = 'https://synapse.synapsebusiness.ru/content/publishing-assets/palitra-love/ec50ad5bcef0a3e0521fa0238cd68628.webp'; image.addEventListener('error', () => image.remove(), { once: true }); avatar.append(image); }
    const meta = el('span', 'pc-msg__meta', [who, m.orderId === null ? 'Переписка без номера заявки' : `Заявка №${m.orderId}`, positive(m.replacesMessageId) ? 'изменено (новая версия)' : ''].filter(Boolean).join(' · '));
    const time = when(m.createdAt);
    if (time) { const node = el('time', 'pc-msg__time', time); node.dateTime = m.createdAt; meta.append(document.createTextNode(' · '), node); }
    item.append(avatar, meta);
    if (typeof m.text === 'string' && m.text) item.append(el('p', 'pc-msg__text', m.text));
    (Array.isArray(m.attachments) ? m.attachments : []).forEach((file, index) => item.append(attachmentNode(m.threadId, file, index)));
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
    const history = $('pc-history');
    let anchor = null;
    for (const node of list.children) {
      if (!node.dataset.key) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom > history.getBoundingClientRect().top) { anchor = { key: node.dataset.key, top: rect.top }; break; }
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
    if (!nodes.length && !WIDGET) nodes.push(el('li', 'pc-muted', 'Сообщений пока нет. Напишите менеджеру — ответ появится здесь.'));
    patchChildren(list, nodes);
    paintWelcome();
    if (anchor) {
      const same = nodes.find((node) => node.dataset.key === anchor.key);
      if (same) { const shift = same.getBoundingClientRect().top - anchor.top; if (shift) history.scrollTop += shift; }
    }
  }
  $('pc-earlier').addEventListener('click', async () => {
    const id = state.threadId, before = state.before, gen = state.pageGen, scope = state.scope && state.scope.key, button = $('pc-earlier');
    if (!id || !before || button.disabled) return;
    const live = ticket('earlier');
    button.disabled = true;
    try {
      const data = conversationPage(await chat('messages', { threadId: id, before, limit: PAGE, view: 'conversation-v1' }), id, before);
      if (!live() || state.threadId !== id) return;
      // Repair P01: ответ применяется, только если загруженная история и её граница те же, что при запросе. Иначе
      // (тихое обновление заменило страницу) он устарел: текущая граница и «Показать ранее» остаются как есть.
      if (state.pageGen !== gen || state.before !== before) return;
      if (!scope || !state.scope || state.scope.key !== scope || data.scope.key !== scope) { invalidateConversation(); viewStatus('Состав переписки изменился. Обновите переписку.', true); renderComposer(); return; }
      state.messages = mergeById(data.messages, state.messages);
      state.before = positive(data.nextBefore);
      renderThread();
    } catch (error) {
      if (live() && !(error.status === 401 && SESSION_LOST.has(error.code))) {
        if ([403, 404, 409].includes(error.status)) { invalidateConversation(); renderComposer(); }
        viewStatus(`Ранние сообщения не загрузились: ${error.message}`, true);
      }
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
  let away = document.visibilityState !== 'visible';
  // BFCache and visibility may run in separate tasks: consume one recorded departure once.
  function foregroundClientEntry() {
    if (document.visibilityState !== 'visible' || !state.csrf || !state.thread || state.thread.id !== state.threadId) return;
    paintClientOffers({ entry: true });
  }
  function returnToClientChat() {
    if (!away || document.visibilityState !== 'visible') return;
    away = false; foregroundClientEntry();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') { away = true; return; }
    returnToClientChat();
    if (state.csrf && state.threadId && state.thread && !state.sending) openThread(state.threadId, { quiet: true });
  });
  window.addEventListener('pagehide', () => { away = true; invalidateOwnAccountPhone(); contactPrefill.suspend(); });
  window.addEventListener('pageshow', event => {
    contactPrefill.resume();
    if (event.persisted === true) invalidateOwnAccountPhone({ refresh: true });
    if (event.persisted === true) { returnToClientChat(); if (state.csrf && state.threadId && state.thread && !state.sending) openThread(state.threadId, { quiet: true }); }
  });
  window.addEventListener('message', event => {
    if (window.parent === window || event.source !== window.parent || event.origin !== window.location.origin
      || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)
      || Object.keys(event.data).length !== 1 || event.data.type !== 'palitra:client-chat-entry') return;
    const initialAcknowledgement = !parentAcknowledged; parentAcknowledged = true;
    if (!initialAcknowledgement) foregroundClientEntry();
  });
  window.addEventListener('scroll', () => { if (nearBottom()) $('pc-new-below').textContent = ''; }, { passive: true });
  $('pc-history').addEventListener('scroll', () => { if (nearBottom()) $('pc-new-below').textContent = ''; }, { passive: true });

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
      if (window.location.pathname === '/chat/widget') {
        const link = el('a', 'pc-btn pc-btn--quiet', 'Открыть Telegram'); link.href = data.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        $('pc-telegram-note').replaceChildren(link);
      } else window.location.assign(data.url);
    } catch (error) {
      if (epoch !== state.epoch || (error.status === 401 && SESSION_LOST.has(error.code))) return;
      telegramNote(LINK_REASONS[error.code] || `Ссылку на Telegram получить не удалось: ${error.message}`, true);
      button.textContent = 'Получить ссылку ещё раз';
    } finally { button.disabled = false; }
  });

  /* ---------- черновик и отправка ---------- */
  const draftKey = (id) => `${DRAFT_PREFIX}${id === null ? 'new' : id}`;
  function saveDraft() {
    const field = $('pc-text'), id = state.threadId;
    if ((!id && !state.empty) || field.readOnly) return;
    if (field.value) writeJson(draftKey(id), { text: field.value, start: field.selectionStart, end: field.selectionEnd });
    else forget(draftKey(id));
  }
  function restoreDraft(id) {
    const field = $('pc-text'), draft = readJson(draftKey(id));
    field.readOnly = false;
    field.value = draft && typeof draft.text === 'string' ? draft.text.slice(0, MAX) : '';
    if (draft && Number.isSafeInteger(draft.start) && Number.isSafeInteger(draft.end)) { try { field.setSelectionRange(draft.start, draft.end); } catch (_) { /* не обязательно */ } }
  }
  function fitComposerField() {
    const field = $('pc-text');
    if (!field) return;
    if (!field.value) { field.style.height = '44px'; field.style.overflowY = 'hidden'; field.scrollTop = 0; return; }
    const scroll = field.scrollTop;
    const style = window.getComputedStyle(field);
    const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
    field.style.height = '44px';
    const content = field.scrollHeight + border;
    const height = Math.min(112, Math.max(44, content));
    field.style.height = `${height}px`;
    field.style.overflowY = content > height ? 'auto' : 'hidden';
    field.scrollTop = content > height ? scroll : 0;
  }
  const updateCount = () => { $('pc-count').textContent = `${$('pc-text').value.length} / ${MAX}`; fitComposerField(); };
  $('pc-text').addEventListener('input', () => { updateCount(); saveDraft(); });
  $('pc-text').addEventListener('blur', saveDraft);

  /* Неразрешённая отправка: { v, threadId, requestId, text, unknown, inFlight } — до ответа сервера и после неизвестного
     исхода. Снимается только точной квитанцией, доказанным отказом первой попытки или явным «Отказаться».
     PALITRA-WEBCHAT-PHASEE: файл — та же запись с type:'file' и сведениями { name, size, sha256, uploadRef? }; text — подпись
     (может быть пустой). Сам файл — только в памяти страницы; после перезагрузки его нужно выбрать снова (сверка размера
     и sha256), номер запроса тот же. Прежние текстовые записи (без type) читаются как раньше. */
  function validRecord(record) {
    if (!record || typeof record !== 'object' || record.v !== 1 || !REQUEST_ID.test(String(record.requestId))) return false;
    if (record.action === 'start') {
      if (!(record.threadId === null || positive(record.threadId)) || !record.body || record.body.requestId !== record.requestId) return false;
      const field = record.type === 'file' ? 'upload' : record.type === 'contact' ? 'phone' : 'text';
      const hasAttribution = Object.prototype.hasOwnProperty.call(record.body, 'attributionToken');
      if (hasAttribution && (typeof record.body.attributionToken !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{64}$/.test(record.body.attributionToken))) return false;
      if (Object.keys(record.body).sort().join(',') !== ['requestId', field, ...(hasAttribution ? ['attributionToken'] : [])].sort().join(',')) return false;
      if (field === 'text' && record.body.text !== record.text || field === 'phone' && record.body.phone !== record.phone) return false;
      if (field === 'upload' && (!record.body.upload || Object.keys(record.body.upload).sort().join(',') !== 'caption,name,sha256,size' || record.body.upload.name !== record.name || record.body.upload.size !== record.size || record.body.upload.sha256 !== record.sha256 || record.body.upload.caption !== record.text)) return false;
    } else if (positive(record.threadId) === null || record.action !== undefined && record.action !== 'contact') return false;
    if (record.type === 'contact') return ['start','contact'].includes(record.action) && typeof record.phone === 'string' && record.phone.length > 0 && record.phone.length <= 32 && record.body && record.body.requestId === record.requestId && record.body.phone === record.phone && (record.action === 'start' || record.body.threadId === record.threadId && Object.keys(record.body).sort().join(',') === 'phone,requestId,threadId');
    if (record.type === 'file') {
      return typeof record.text === 'string' && record.text.length <= MAX && typeof record.name === 'string' && record.name.length > 0 && record.name.length <= 180
        && positive(record.size) !== null && record.size <= MAX_UPLOAD && /^[0-9a-f]{64}$/.test(String(record.sha256))
        && (record.uploadRef === undefined || positive(record.threadId) && UPLOAD_REF.test(String(record.uploadRef)));
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
    if (state.sending || !composerReady()) return { mode: 'busy' };
    const record = state.pending;
    if (!record) return { mode: 'new' };
    return record.threadId === state.threadId ? { mode: 'retry', record } : { mode: 'blocked', record };
  }
  function renderComposer() {
    const field = $('pc-text'), record = state.pending;
    const here = Boolean(record && record.threadId === state.threadId);
    const ready = composerReady();
    $('pc-unknown').hidden = !(here && record.unknown);
    // Repair R1: пока считается sha256 выбранного файла — ни «Отправить», ни повтора файла.
    const preparing = preparingNow();
    $('pc-retry').disabled = state.sending || (preparing && here && record.type === 'file');
    $('pc-drop').disabled = state.sending;
    $('pc-send').disabled = state.sending || !ready || Boolean(record) || preparing;
    $('pc-blocked').hidden = !(record && !here && state.threadId);
    // PHASEE: у файла поле остаётся черновиком (подпись уже в записи): поздние правки сохраняются и после квитанции.
    const textRecord = here && record.type === undefined;
    field.readOnly = textRecord;
    if (textRecord) field.value = record.text;
    renderPicker();
    if (record && !here && ready) sendState(BLOCKED_TEXT, 'error');
    else if (here && record.unknown && !state.sending) sendState(UNKNOWN_TEXT, 'error');
    updateCount(); paintContact(); paintWelcome();
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
    const label = el('label', 'pc-btn pc-btn--quiet pc-attach__pick');
    label.htmlFor = 'pc-file';
    input.setAttribute('aria-label', 'Прикрепить файл');
    label.title = 'Прикрепить файл';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.8'); icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round');
    icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('focusable', 'false');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M8 12.5 14.7 5.8a3.5 3.5 0 0 1 5 5l-9.4 9.4a5 5 0 0 1-7.1-7.1L13 3.4');
    const inner = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    inner.setAttribute('d', 'm8 12.5 6-6a1.5 1.5 0 0 1 2.1 2.1l-7.4 7.5');
    icon.append(path, inner); label.append(icon, el('span', 'pc-sr-only', 'Прикрепить файл'));
    const name = el('span', 'pc-muted pc-attach__name');
    name.id = 'pc-file-name';
    const remove = el('button', 'pc-btn pc-btn--quiet pc-attach__remove', 'Убрать');
    remove.type = 'button'; remove.hidden = true;
    box.append(input, label);
    $('pc-text').before(box);
    $('pc-selected').append(name, remove);
    input.addEventListener('change', () => { const file = input.files && input.files[0]; pickFile(file || null); });
    remove.addEventListener('click', () => { clearFile(); renderComposer(); sendState(''); input.focus(); });
    Object.assign(picker, { box, input, name, remove });
  }
  function renderPicker() {
    const on = Boolean(state.uploadInfo && composerReady());
    mountPicker();
    picker.box.hidden = false;
    if (!on) {
      const file = state.file, preparing = preparingNow() ? state.filePreparing : null;
      picker.input.disabled = true; picker.remove.disabled = state.sending; picker.remove.hidden = !(file || preparing);
      $('pc-selected').hidden = !(file || preparing);
      picker.name.textContent = file ? `${file.name} · ${sizeText(file.size)}` : preparing ? `${preparing.name} · проверяем файл…` : '';
      return;
    }
    const record = state.pending, file = state.file, preparing = preparingNow() ? state.filePreparing : null;
    const here = Boolean(record && record.threadId === state.threadId && record.type === 'file');
    $('pc-selected').hidden = !(file || preparing || here);
    picker.input.disabled = state.sending;
    picker.remove.hidden = !(file || preparing);
    picker.remove.disabled = state.sending;
    picker.name.textContent = file ? `${file.name} · ${sizeText(file.size)}`
      : preparing ? `${preparing.name} · ${sizeText(preparing.size)} · проверяем файл…`
        : here ? `Неотправленный файл: ${record.name} · ${sizeText(record.size)}. Для повтора выберите этот же файл.` : '';
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
        data = await chat(record.action === 'start' ? 'start' : `threads/${record.threadId}/uploads`, record.action === 'start' ? record.body : { requestId: record.requestId, name: record.name, size: record.size, sha256: record.sha256, caption: record.text }, { write: true });
        if (epoch !== state.epoch) return;
        if (record.action === 'start') {
          if (!validStartReceipt(data) || record.threadId !== null && data.threadId !== record.threadId || !data.upload || !UPLOAD_REF.test(String(data.upload.ref)) || !['prepared','receiving','committed','expired','rejected'].includes(data.upload.state)) throw new ChatError('Не удалось подтвердить начало отправки файла. Проверьте ту же отправку.', 200, 'RECEIPT', { unknown: true });
          adoptStartedThread(record, data);
        }
        if (data.threadId !== record.threadId || !data.upload || !UPLOAD_REF.test(String(data.upload.ref))) throw new ChatError('Сервер не подтвердил подготовку файла.', 200, 'RECEIPT', { unknown: true });
        record.uploadRef = data.upload.ref;
        writeRecord(record);
      }
      if (epoch !== state.epoch) return;
      const upload = data.upload || {};
      if (upload.state !== 'committed') {
        if (upload.state === 'receiving') throw new ChatError('Файл ещё загружается. Проверьте отправку чуть позже.', 409, 'IN_PROGRESS', { unknown: true });
        if (upload.state === 'expired' || upload.state === 'rejected') {
          throw new ChatError('Срок этой загрузки истёк, сообщение не создано. Нажмите «Отказаться от этой отправки» и отправьте файл заново.', 410, 'EXPIRED', { unknown: true });
        }
        if (!sameFile(record, state.file)) throw new ChatError(`Выберите тот же файл (${record.name}, ${sizeText(record.size)}) и нажмите «Проверить и повторить ту же отправку».`, 0, 'RESELECT', { unknown: true });
        data = await chatFetch(`${uploadsPath(record.threadId)}/${record.uploadRef}/bytes`, { method: 'POST', body: state.file.file, write: true });
      }
      if (epoch !== state.epoch) return;
      if (!fileReceiptOk(record, data)) throw new ChatError('Сервер не подтвердил файл в чате.', 200, 'RECEIPT', { unknown: true });
      clearRecord(record);
      outcome = { accepted: true, duplicate: data.duplicate === true };
    } catch (error) {
      if (epoch !== state.epoch) return;
      if (!retry && error.refused && !record.uploadRef) {
        // Отказ подготовки (4xx до записи): файла на сервере нет — подпись остаётся в поле, файл выбран как был.
        clearRecord(record);
        outcome = { refused: true, error };
      } else {
        record.inFlight = false; record.unknown = true;
        writeRecord(record);
        outcome = { unknown: true, error };
      }
    } finally { if (epoch === state.epoch) state.sending = false; }
    if (epoch !== state.epoch) return;
    renderComposer();
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
      const data = await chat(record.action === 'start' ? 'start' : 'message', record.action === 'start' ? record.body : { threadId: record.threadId, requestId: record.requestId, text: record.text }, { write: true });
      if (epoch !== state.epoch) return;
      if (record.action === 'start') {
        if (!validStartReceipt(data) || record.threadId !== null && data.threadId !== record.threadId || !data.message || !positive(data.message.id)) throw new ChatError('Не удалось подтвердить отправку. Проверьте ту же отправку.', 200, 'RECEIPT', { unknown: true });
        adoptStartedThread(record, data);
      }
      // Квитанция — только точная: тот же threadId и положительный message.id. Иначе исход неизвестен.
      if (data.threadId !== record.threadId || !data.message || typeof data.message !== 'object' || !positive(data.message.id)) {
        throw new ChatError('Сервер не подтвердил сообщение.', 200, 'RECEIPT', { unknown: true });
      }
      clearRecord(record);
      outcome = { accepted: true, duplicate: data.duplicate === true };
    } catch (error) {
      if (epoch !== state.epoch) return;
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
    } finally { if (epoch === state.epoch) state.sending = false; }
    if (epoch !== state.epoch) return;
    renderComposer();
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
      const record = { v: 1, type: 'file', threadId: state.threadId, requestId: uuid(), text, name: picked.name.slice(0, 180), size: picked.size,
        sha256: picked.sha256, unknown: false, inFlight: false };
      if (state.empty) { record.action = 'start'; record.body = { requestId: record.requestId, upload: { name: record.name, size: record.size, sha256: record.sha256, caption: text } }; record.body = window.PalitraAttribution?.enrich(record.body) || record.body; }
      transmitFile(record);
      return;
    }
    if (!text.trim()) { sendState(SEND_ERRORS.EMPTY, 'error'); return; }
    if (text.length > MAX) { sendState(SEND_ERRORS.TOO_LONG, 'error'); return; }
    forget(draftKey(state.threadId));
    const record = { v: 1, threadId: state.threadId, requestId: uuid(), text, unknown: false, inFlight: false };
    if (state.empty) { record.action = 'start'; record.body = { requestId: record.requestId, text }; record.body = window.PalitraAttribution?.enrich(record.body) || record.body; }
    transmit(record);
  });
  $('pc-retry').addEventListener('click', () => {
    const g = gate();
    if (g.mode !== 'retry' || !g.record.unknown) return;
    if (g.record.type === 'file' && preparingNow()) { sendState('Проверяем файл…', 'pending'); return; }   // Repair R1
    if (g.record.type === 'file') transmitFile(g.record); else if (g.record.type === 'contact') transmitContact(g.record); else transmit(g.record);
  });
  $('pc-drop').addEventListener('click', () => {
    const record = state.pending;
    if (state.sending || !record || record.threadId !== state.threadId) return;
    clearRecord(record);
    // Подпись файла — это черновик поля: при отказе от файла он не стирается.
    if (record.type === undefined) $('pc-text').value = '';
    renderComposer();
    sendState('Повтор снят. Если сервер уже принял первую отправку, сообщение всё равно останется в переписке — отменить его отсюда нельзя.');
    if (state.thread) openThread(state.threadId, { quiet: true });
  });
  $('pc-open-pending').addEventListener('click', () => { const record = state.pending; if (record && canLeaveChat(record.threadId)) { if (record.threadId) openThread(record.threadId, { focus: true }); else showEmptyChat(); } });

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
    emitPushSession('palitra:session-ended');
    hideMain();
    forget(LAST_KEY);
    say('Вы вышли из чата на этом устройстве. Прежняя переписка в этом браузере больше недоступна.');
    $('pc-restart-wrap').hidden = false;
  });

  // Public presentation settings never change session grants, messages or the current composer/file DOM.
  function parseWidgetSettings(data) {
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    if (!object(data) || data.ok !== true || !object(data.settings)) return null;
    const value = data.settings, contact = value.contact, appearance = value.appearance, invitation = value.invitation;
    const bounded = (number, min, max) => Number.isInteger(number) && number >= min && number <= max;
    if (!Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.welcomeText !== 'string' || value.welcomeText.length > 1200
      || !object(contact) || typeof contact.enabled !== 'boolean' || typeof contact.text !== 'string' || contact.text.length > 300 || contact.enabled && !contact.text.trim()
      || !object(appearance) || !bounded(appearance.width, 280, 440) || !bounded(appearance.height, 360, 680) || !bounded(appearance.radius, 12, 40)
      || typeof appearance.accent !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(appearance.accent)
      || !object(invitation) || typeof invitation.enabled !== 'boolean' || typeof invitation.text !== 'string' || invitation.text.length > 300 || invitation.enabled && !invitation.text.trim()
      || !bounded(invitation.delaySeconds, 0, 3600)) return null;
    return { revision: value.revision, welcomeText: value.welcomeText, contact: { enabled: contact.enabled, text: contact.text },
      appearance: { width: appearance.width, height: appearance.height, radius: appearance.radius, accent: appearance.accent },
      invitation: { enabled: invitation.enabled, text: invitation.text, delaySeconds: invitation.delaySeconds } };
  }
  async function refreshWidgetSettings() {
    if (!WIDGET || widgetSettingsLoading) return;
    widgetSettingsLoading = true;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(API + 'widget-settings', { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) return;
      const next = parseWidgetSettings(await response.json());
      if (!next || next.revision < widgetSettings.revision) return;
      widgetSettings = next;
      document.documentElement.style.setProperty('--pc-olive', next.appearance.accent);
      document.documentElement.style.setProperty('--pc-olive-dark', next.appearance.accent);
      paintWelcome(); paintContact();
    } catch (_) { /* Keep the last verified presentation/default; ordinary chat does not depend on config. */ }
    finally { clearTimeout(timer); widgetSettingsLoading = false; }
  }
  if (WIDGET) {
    refreshWidgetSettings();
    setInterval(() => { if (document.visibilityState === 'visible') refreshWidgetSettings(); }, 60000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshWidgetSettings(); });
  }
  boot();
})();

/* Reviewed application explanations; isolated per document, no requests or editor state changes. */
(()=>{if(!['https://palitra-love.ru','https://palitra-love-draft-1.synapsebusiness.ru'].includes(location.origin) || !['/chat','/chat/widget'].includes(location.pathname) || window.PalitraHelp)return;
function h(tag,props,...kids){const node=document.createElement(tag);for(const [k,v]of Object.entries(props||{})){if(v===null||v===undefined||v===false)continue;if(k==='class')node.className=v;else if(k==='text')node.textContent=String(v);else if(k==='dataset')Object.assign(node.dataset,v);else if(k.startsWith('on')&&typeof v==='function')node.addEventListener(k.slice(2),v);else node.setAttribute(k,v===true?'':String(v));}for(const child of kids.flat(Infinity)){if(child!==null&&child!==undefined&&child!==false)node.append(typeof child==='object'?child:String(child));}return node;}
  // PALITRA_APP_HELP_BEGIN: only reviewed, static explanations; never data, errors or consent.
  const appHelpTexts = new Set([
    'Фото работ ведутся штатным редактором фото сайта; здесь они не копируются.',
    'Продолжим в чате. Контакт пригодится, если не сможем связаться здесь.',
    'Нажатие не отмечает, что связь состоялась или клиент ответил.',
    'Palitra Love · данные существующей CRM за выбранный период по московскому времени. Заявки сайта и этапы доставки ведутся в разделе «Заказы».',
    'Каталог и цены — на сайте магазина; копий товаров и фото здесь нет.',
    'Права, CSRF и сохранение — внутри штатного редактора.',
    'Статус обработки отделён от доставки уведомления.',
    'Можно несколько слов: «выписка мальчик». Цена — цифрами: 9270.',
    '(можно несколько; товар останется одним, без копий)',
    'Так товар называется на сайте, в корзине и в заявке.',
    '7720 → «7 720 руб.»; копейки через запятую. Пусто — «Цена уточняется». Текст («от 5000») сохранится как есть, но корзина его не посчитает.',
    'Показывается покупателю в карточке товара.',
    'Что входит в набор. Можно по строкам.',
    'Необязательно. Служебная строка «Цена из публикации…» на сайте не показывается.',
    'Перетащите фото мышью или пальцем. С клавиатуры: стрелки — сдвиг (с Shift — крупнее), «+» и «−» — масштаб, Home — по центру. Сам файл фото не меняется.',
    'Внутренние разделы прайса и старые адреса /catalog/…. Каждый товар лежит в одном разделе; поводы на сайте выбираются в карточке товара. «Показать на сайте» добавляет раздел в каталог сайта как категорию с тем же названием.',
    'Временная подборка собирает товары выбранных категорий на время праздника. Товары и обычные категории не меняются и не удаляются; вне дат подборки на сайте нет.',
    'Товар из нескольких выбранных категорий показывается в подборке один раз.',
    'Для сцены нужны три кадра: для компьютера (горизонтальный, на сайте 16:9), для планшета (горизонтальный, 4:3) и для телефона (вертикальный). Тексты, кнопки и смена сцен не меняются.',
    'При замене фото у этой карточки отключается прежний ролик, чтобы не показывать чужой набор. Новое фото плавно движется, как у карточки «День рождения мужчины». Остальные карточки не меняются.',
    'Меняется только фото и его подпись. Ссылки, суммы и надписи остаются прежними.',
    'Первые 4 фото видны сразу, остальные открываются кнопкой «Показать ещё» (если фото 4 или меньше, кнопки нет). В галерее остаётся хотя бы одно фото. Фото, убранное из показа, остаётся в хранилище материалов, и его можно вернуть.',
    'Порядок категорий на главной задаётся в редакторе прайса',
    'Внутренний раздел (старые адреса /catalog/…). Поводы на сайте выбираются выше.',
    'По одному пункту в строке. Сайт это поле сейчас не показывает.',
    'Можно продолжить переписку в Telegram — она останется и здесь.',
    '«На сайте» ставится только после проверки работающей страницы: нужны ссылка и дата. Статус работы «Отменено» оставляет задачу видимой, но исправлением она не считается — даже если раньше была опубликована.',
    'Ожидается объект с полями schemaVersion, asOf и tasks. Уже существующие задачи обновляются по их идентификатору реестра, копии не создаются.',
    'В режиме «По обращению» начните сообщение с «Хью». В режиме замены Хью участвует в обсуждении проекта.',
    'У одного собственника может быть несколько сайтов в одной переписке. Метка сайта у задачи принимается только из этого списка.'
  ]);
  const appHelp = (()=>{
    let opened=null,sequence=0,scanQueued=false;
    function close(restore=false) {
      if(!opened)return;const old=opened;opened=null;clearTimeout(old.timer);
      old.button.setAttribute('aria-expanded','false');old.pop.remove();
      window.removeEventListener('resize',old.position);window.removeEventListener('scroll',old.position,true);
      window.visualViewport?.removeEventListener('resize',old.position);window.visualViewport?.removeEventListener('scroll',old.position);
      if(restore && old.button.isConnected)old.button.focus({preventScroll:true});
    }
    function helpPosition(anchor,pop,viewport,composer) {
      const gap=8,left=viewport.left+gap,right=viewport.right-gap,top=viewport.top+gap;
      const bottom=Math.max(top+1,Math.min(viewport.bottom-gap,composer?.top>top?composer.top-gap:Infinity));
      const width=Math.max(1,Math.min(320,right-left)),height=Math.max(1,bottom-top);
      const x=Math.min(Math.max(left,anchor.left),Math.max(left,right-width));
      const below=anchor.bottom+gap,above=anchor.top-gap-pop.height;
      const y=below+pop.height<=bottom?below:above>=top?above:Math.min(Math.max(top,below),Math.max(top,bottom-Math.min(pop.height,height)));
      return {left:x,top:y,width,maxHeight:height};
    }
    function button(text,label='Пояснение') {
      const copy=text==='Права, CSRF и сохранение — внутри штатного редактора.'?'Доступ и сохранение изменений проверяются в редакторе.':text;
      const id='app-help-'+(++sequence),trigger=h('button',{type:'button',class:'app-help__trigger','aria-label':label,'aria-expanded':'false','aria-controls':id,text:'?'});
      trigger.addEventListener('click',event=>{
        if(opened?.button===trigger){close();return;}close();
        const pop=h('section',{id,class:'app-help__popover',role:'region','aria-label':label},h('p',{text:copy}),h('button',{type:'button',class:'app-help__close','aria-label':'Закрыть пояснение',text:'×',onclick:()=>close(pop.contains(document.activeElement))}));
        const position=()=>{
          if(!trigger.isConnected){close();return;}
          const v=window.visualViewport,l=v?.offsetLeft||0,t=v?.offsetTop||0;
          // Measure after setting the phone-safe width so wrapping cannot extend below the composer.
          pop.style.width=Math.max(1,Math.min(320,(v?.width||window.innerWidth)-16))+'px';
          const composer=document.querySelector('.chat__dock, .chat__compose, #pc-compose, .pc-compose-row, [data-pc-compose]')?.getBoundingClientRect();
          const r=helpPosition(trigger.getBoundingClientRect(),pop.getBoundingClientRect(),{left:l,top:t,right:l+(v?.width||window.innerWidth),bottom:t+(v?.height||window.innerHeight)},composer);
          Object.assign(pop.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',maxHeight:r.maxHeight+'px'});
        };
        (trigger.closest('dialog[open]') || document.body).append(pop);trigger.setAttribute('aria-expanded','true');
        opened={button:trigger,pop,position,timer:setTimeout(()=>close(pop.contains(document.activeElement)),6000)};
        position();window.addEventListener('resize',position);window.addEventListener('scroll',position,true);
        window.visualViewport?.addEventListener('resize',position);window.visualViewport?.addEventListener('scroll',position);
        if(event.detail===0)pop.querySelector('button').focus({preventScroll:true});
      });
      return h('span',{class:'app-help'},trigger);
    }
    function scan(root=document) {
      if(typeof activeCompany!=='undefined' && activeCompany!=='palitra-love')return;
      for(const node of root.querySelectorAll('p,small')) {
        const text=node.textContent.trim();
        const scheduleText='Сообщение уйдёт в чат проекта и в связанную Telegram-группу в указанное время. До отправки его можно изменить или отменить.';
        const staticTemplate=/^Основное и до \d+ дополнительных\. JPEG, PNG или WebP до 8 МБ; файл загружается как есть, без уменьшения\. «Настроить кадр» меняет только то, как фото стоит в рамке\.$/.test(text) || /^До \d+ категорий в этом порядке\. Остальные покупатель видит по кнопке «Показать ещё»\. Товары при этом не меняются\.$/.test(text);
        if(node.closest('.app-help, .app-help__popover, .chat__msg, .pc-messages, .pc-message-text, .pc-msg__text, .pc-scheduled-item, .pc-personas, #pc-contact, #pc-welcome, [role="log"], [role="alert"], [role="status"]') || node.querySelector('button,input,textarea,select,a') || (!appHelpTexts.has(text)&&!staticTemplate&&text!==scheduleText))continue;
        if(text===scheduleText) {
          node.textContent='Сообщение уйдёт в чат проекта и в связанную Telegram-группу в указанное время.';
          node.append(' ',button('До отправки его можно изменить или отменить.','О запланированном сообщении'));continue;
        }
        const label=node.closest('label'),fieldLabel=label?.querySelector('span')?.textContent.trim();
        const help=button(node.textContent.trim(),fieldLabel?'Пояснение к полю «'+fieldLabel+'»':'Пояснение');
        if(node.id==='pc-telegram-state') {
          // This existing paragraph is updated by the chat renderer. Keep its target identity alive.
          help.append(h('span',{class:'app-help__description',text}));node.replaceChildren(help);continue;
        }
        // Design text styles and layout anchor stay on this small help control.
        for(const [key,value]of Object.entries(node.dataset))help.dataset[key]=value;
        if(node.id)help.append(h('span',{id:node.id,class:'app-help__description',text}));
        node.replaceWith(help);
        if(label) {
          // Keep one form-grid item and the original label/control; never nest another button in a label.
          const group=h('div',{class:'app-help__field'});label.replaceWith(group);group.append(label,help);
        }
      }
      if(opened && !opened.button.isConnected)close();
    }
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&opened){event.preventDefault();close(opened.pop.contains(document.activeElement));}});
    document.addEventListener('pointerdown',event=>{if(opened&&!opened.pop.contains(event.target)&&!opened.button.contains(event.target))close();});
    const observer=new MutationObserver(()=>{if(!scanQueued){scanQueued=true;queueMicrotask(()=>{scanQueued=false;scan();});}});
    observer.observe(document.body,{childList:true,subtree:true});
    scan();
    return Object.freeze({button,scan,close,helpPosition});
  })();
  Object.defineProperty(window,'PalitraHelp',{value:appHelp,writable:false});
  // PALITRA_APP_HELP_END

})();
