/* Корзина и заявка менеджеру. Онлайн-оплаты нет: клиент выбирает позиции и количество,
   сервер сверяет состав с live-прайсом и сохраняет заявку, менеджер связывается сам.

   Правила:
   - в localStorage только id и количество; названия и цены берутся из live-прайса при показе;
     контакты клиента нигде не сохраняются (в sessionStorage — только requestId и хеш смысла);
   - requestId стабилен для одинакового повтора (тот же состав и контакты) и меняется при любом
     изменении; успех — только 201/200 с orderId от сервера, иначе корзина и поля остаются;
   - один запрос за раз: флаг ставится до первого await, вся подготовка и отправка — в одном
     try/finally, форма всегда разблокируется;
   - пока прайс не загружен, состав не считается устаревшим и заявка не отправляется;
   - изменения корзины во время отправки не блокируются: после успеха из корзины вычитается
     только отправленный снимок, добавленное за это время остаётся. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.mount(root);
}(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const CART_KEY = 'palitra-cart-v1';
  const REQUEST_KEY = 'palitra-order-request-v1';
  const ENDPOINT = '/api/orders';
  const PRICE_SOURCES = ['/api/price', '/data/price.json'];
  const MAX_QTY = 20, MAX_LINES = 30;
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const ITEM_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
  const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const PRICE_PATTERN = /^\s*(\d[\d\s ]*)(?:[.,](\d{1,2}))?\s*(?:руб\.?|р\.?|₽)?\s*$/i;
  const MESSAGES = {
    pending: 'Отправляем заявку…',
    network: 'Не удалось отправить заявку: сервер не ответил или нет связи. Корзина и данные сохранены — попробуйте ещё раз.',
    rate: 'Слишком много заявок подряд. Подождите несколько минут и попробуйте снова — корзина сохранена.',
    unavailable: 'Приём заявок временно недоступен. Корзина сохранена — попробуйте позже или напишите нам в Telegram.',
    mismatch: 'Состав заявки изменился с прошлой попытки. Проверьте корзину и отправьте ещё раз.',
    stale: 'Часть позиций уже недоступна в прайсе. Удалите их из корзины и отправьте заявку снова.',
    validation: 'Проверьте имя, телефон и согласие — сервер не принял заявку.',
    consent: 'Для отправки заявки нужно согласие на обработку данных.',
    empty: 'Корзина пуста — добавьте позиции из прайса или каталога.',
    priceLoading: 'Загружаем прайс, чтобы сверить состав корзины. Подождите несколько секунд.',
    priceError: 'Не удалось загрузить прайс. Нажмите «Обновить прайс» и отправьте заявку снова — корзина сохранена.',
    generic: 'Не удалось отправить заявку. Данные сохранены — попробуйте ещё раз.'
  };

  /* ---------- корзина: только id и qty ---------- */
  function readCart(storage) {
    try {
      const data = JSON.parse(storage.getItem(CART_KEY) || '{}');
      const items = Array.isArray(data.items) ? data.items : [];
      const clean = [];
      const seen = new Set();
      for (const item of items) {
        if (!item || typeof item.id !== 'string' || !ITEM_ID.test(item.id) || seen.has(item.id)) continue;
        const qty = Math.min(MAX_QTY, Math.max(1, Math.trunc(Number(item.qty) || 1)));
        seen.add(item.id);
        clean.push({ id: item.id, qty });
      }
      return clean.slice(0, MAX_LINES);
    } catch (_) { return []; }
  }
  function writeCart(storage, items) {
    try { storage.setItem(CART_KEY, JSON.stringify({ items })); } catch (_) { /* хранилище может быть недоступно */ }
  }
  function createCart(storage) {
    let items = readCart(storage);
    const save = () => writeCart(storage, items);
    return {
      list: () => items.map((item) => ({ ...item })),
      count: () => items.reduce((sum, item) => sum + item.qty, 0),
      add(id, qty = 1) {
        if (typeof id !== 'string' || !ITEM_ID.test(id)) return false;
        const existing = items.find((item) => item.id === id);
        if (existing) existing.qty = Math.min(MAX_QTY, existing.qty + qty);
        else if (items.length < MAX_LINES) items.push({ id, qty: Math.min(MAX_QTY, Math.max(1, qty)) });
        else return false;
        save();
        return true;
      },
      setQty(id, qty) {
        const existing = items.find((item) => item.id === id);
        if (!existing) return;
        const next = Math.trunc(Number(qty));
        if (!Number.isFinite(next) || next < 1) items = items.filter((item) => item.id !== id);
        else existing.qty = Math.min(MAX_QTY, next);
        save();
      },
      remove(id) { items = items.filter((item) => item.id !== id); save(); },
      /* Вычитает отправленный снимок: добавленное во время отправки остаётся в корзине. */
      consume(snapshot) {
        for (const sent of snapshot) {
          const existing = items.find((item) => item.id === sent.id);
          if (!existing) continue;
          existing.qty -= sent.qty;
          if (existing.qty < 1) items = items.filter((item) => item.id !== sent.id);
        }
        save();
      },
      clear() { items = []; save(); }
    };
  }

  /* ---------- прайс: индекс для показа, клиент не источник цен для сервера ---------- */
  function priceIndex(data) {
    const index = new Map();
    for (const category of (data && data.categories) || []) {
      for (const item of category.items || []) {
        if (item && typeof item.id === 'string' && !index.has(item.id)) index.set(item.id, { title: item.title || item.id, price: parsePrice(item.price) });
      }
    }
    return index;
  }
  function parsePrice(value) {
    const match = PRICE_PATTERN.exec(String(value ?? ''));
    if (!match) return null;
    const rubles = Number(match[1].replace(/[\s ]/g, ''));
    const kopecks = Number((match[2] || '0').padEnd(2, '0'));
    return Number.isSafeInteger(rubles) ? rubles * 100 + kopecks : null;
  }
  const formatRub = (kopecks) => `${Math.floor(kopecks / 100).toLocaleString('ru-RU')}${kopecks % 100 ? `,${String(kopecks % 100).padStart(2, '0')}` : ''} ₽`;
  /* Строки корзины с названиями и ценами прайса. Без загруженного прайса ничего не помечается
     удалённым; после загрузки отсутствующие позиции помечаются, а не выбрасываются молча. */
  function describe(items, index) {
    let known = 0, unknown = 0, missing = 0;
    const lines = items.map((item) => {
      if (!index) return { ...item, title: item.id, price: null, missing: false, pending: true };
      const entry = index.get(item.id);
      if (!entry) { missing += 1; return { ...item, title: item.id, price: null, missing: true, pending: false }; }
      if (entry.price === null) unknown += 1;
      else known += entry.price * item.qty;
      return { ...item, title: entry.title, price: entry.price, missing: false, pending: false };
    });
    return { lines, knownTotal: known, unknownCount: unknown, missingCount: missing, ready: Boolean(index) };
  }

  /* ---------- заявка ---------- */
  function normalizePhone(value) {
    let digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
    return digits;
  }
  function campaign(location) {
    const query = new URL(location.href).searchParams;
    const utm = {};
    for (const key of UTM) { const value = query.get(key); if (value) utm[key] = value.slice(0, 200); }
    return utm;
  }
  /* Полезная нагрузка сервера: requestId ставится снаружи (см. requestIdFor). */
  function buildPayload(kind, fields, items, location) {
    const name = String(fields.name || '').trim();
    const phone = String(fields.phone || '').trim();
    const comment = String(fields.comment || '').trim();
    const invalid = (field, message) => { throw Object.assign(new Error(message), { field }); };
    if (kind !== 'cart' && kind !== 'request') invalid('kind', 'Неизвестный тип заявки');
    if (!name || name.length > 80) invalid('name', 'Укажите имя: не больше 80 символов.');
    const digits = normalizePhone(phone);
    if (phone.length > 32 || digits.length < 10 || digits.length > 15) invalid('phone', 'Укажите номер телефона с кодом.');
    if (comment.length > 1000) invalid('comment', 'Сократите комментарий до 1000 символов.');
    if (fields.consent !== true) invalid('consent', MESSAGES.consent);
    if (kind === 'cart' && (!items.length || items.length > MAX_LINES)) invalid('items', MESSAGES.empty);
    const payload = { kind, name, phone, comment, consent: true,
      items: kind === 'cart' ? items.map((item) => ({ id: item.id, qty: item.qty })) : [],
      page: location.origin + location.pathname, utm: campaign(location), website: String(fields.website || '') };
    if (kind === 'request') {
      const occasion = String(fields.occasion || '').trim(), date = String(fields.date || '').trim();
      if (occasion) payload.occasion = occasion.slice(0, 80);
      if (date) payload.date = date.slice(0, 40);
    }
    return payload;
  }
  /* Отпечаток смысла заявки: состав + контакты + комментарий. Хранится только его хеш (не контакты). */
  async function fingerprint(payload, subtle) {
    const items = [...payload.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const material = JSON.stringify({ kind: payload.kind, name: payload.name, phone: normalizePhone(payload.phone), comment: payload.comment, items, occasion: payload.occasion || '', date: payload.date || '' });
    if (subtle && subtle.digest) {
      const buffer = await subtle.digest('SHA-256', new TextEncoder().encode(material));
      return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    let hash = 0;
    for (const char of material) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return `weak-${hash.toString(16)}`;
  }
  function uuid(cryptoApi) {
    if (cryptoApi && cryptoApi.randomUUID) return cryptoApi.randomUUID();
    const bytes = new Uint8Array(16);
    if (cryptoApi && cryptoApi.getRandomValues) cryptoApi.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  /* requestId живёт в sessionStorage вместе с отпечатком: тот же смысл → тот же id (повтор после сбоя
     не создаёт вторую заявку), другой смысл → новый id. Если хранилище недоступно или бросает,
     на время страницы работает память процесса — повтор всё равно получит тот же id. */
  const memoryRequests = new Map();
  function requestIdFor(kind, fp, session, cryptoApi) {
    const key = `${REQUEST_KEY}:${kind}`;
    let saved = memoryRequests.get(key) || null;
    if (!saved && session) {
      try { saved = JSON.parse(session.getItem(key) || 'null'); } catch (_) { saved = null; }
    }
    if (saved && saved.fingerprint === fp && UUID_V4.test(saved.requestId)) { memoryRequests.set(key, saved); return saved.requestId; }
    const record = { requestId: uuid(cryptoApi), fingerprint: fp };
    memoryRequests.set(key, record);
    if (session) { try { session.setItem(key, JSON.stringify(record)); } catch (_) { /* недоступно — остаётся память */ } }
    return record.requestId;
  }
  function forgetRequest(kind, session) {
    const key = `${REQUEST_KEY}:${kind}`;
    memoryRequests.delete(key);
    if (session) { try { session.removeItem(key); } catch (_) { /* недоступно */ } }
  }
  /* Отправка: успех только при 201/200 с целым orderId. Таймаут охватывает и чтение тела ответа:
     зависшее тело не оставляет форму заблокированной. */
  async function send(win, payload, options = {}) {
    const controller = new win.AbortController();
    const abortError = Object.assign(new Error('network'), { code: 'NETWORK' });
    let abortReject = () => {};
    const aborted = new Promise((_, reject) => { abortReject = reject; });
    aborted.catch(() => {});
    const timeout = win.setTimeout(() => { controller.abort(); abortReject(abortError); }, options.timeoutMs || 15000);
    try {
      let response;
      try {
        response = await Promise.race([win.fetch(ENDPOINT, { method: 'POST', credentials: 'omit', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal }), aborted]);
      } catch (_) { throw abortError; }
      let body = null;
      try { body = await Promise.race([response.json(), aborted]); } catch (error) { if (error === abortError) throw error; body = null; }
      if ((response.status === 201 || response.status === 200) && body && body.ok === true && Number.isSafeInteger(body.orderId) && body.orderId > 0) {
        return { orderId: body.orderId, duplicate: body.duplicate === true, message: typeof body.message === 'string' ? body.message : '' };
      }
      const code = body && typeof body.code === 'string' ? body.code : response.status === 429 ? 'RATE_LIMITED' : response.status === 409 ? 'REQUEST_MISMATCH' : response.status === 503 ? 'ORDERS_UNAVAILABLE' : 'HTTP';
      throw Object.assign(new Error(code), { code, status: response.status, itemId: body && body.itemId });
    } finally { win.clearTimeout(timeout); }
  }
  function errorMessage(error) {
    switch (error.code) {
      case 'NETWORK': return MESSAGES.network;
      case 'RATE_LIMITED': return MESSAGES.rate;
      case 'ORDERS_UNAVAILABLE': return MESSAGES.unavailable;
      case 'REQUEST_MISMATCH': return MESSAGES.mismatch;
      case 'ITEM_UNKNOWN': return MESSAGES.stale;
      case 'VALIDATION': return MESSAGES.validation;
      default: return MESSAGES.generic;
    }
  }

  /* ---------- черновик из квиза ---------- */
  const DRAFT_KEY = 'palitra-request-draft-v1';
  /* Квиз (assets/quiz.js) кладёт ответы и выбранную позицию в sessionStorage — без контактов.
     Форма заявки подхватывает их один раз: повод — в список (иначе «Другое»), строки — в комментарий. */
  function readRequestDraft(session) {
    if (!session) return null;
    let draft = null;
    try { draft = JSON.parse(session.getItem(DRAFT_KEY) || 'null'); } catch (_) { draft = null; }
    if (!draft || typeof draft !== 'object' || !Array.isArray(draft.lines)) return null;
    const lines = draft.lines.filter((line) => typeof line === 'string' && line.trim()).map((line) => line.trim().slice(0, 200)).slice(0, 12);
    const occasion = typeof draft.occasion === 'string' ? draft.occasion.trim().slice(0, 80) : '';
    if (!lines.length && !occasion) return null;
    return { occasion, lines };
  }
  function applyRequestDraft(form, session) {
    const draft = readRequestDraft(session);
    if (!draft) return false;
    const select = form.querySelector('[name=occasion]');
    if (select && select.options) {
      const options = [...select.options].map((option) => option.value || option.textContent);
      const match = options.find((value) => value === draft.occasion || (draft.occasion && value.toLowerCase().startsWith(draft.occasion.toLowerCase())));
      select.value = match || (options.includes('Другое') ? 'Другое' : select.value);
    }
    const comment = form.querySelector('[name=comment]');
    if (comment) {
      const text = [draft.occasion ? `Повод: ${draft.occasion}` : '', ...draft.lines].filter(Boolean).join('\n');
      comment.value = comment.value ? `${comment.value}\n${text}` : text;
      comment.value = comment.value.slice(0, 1000);
    }
    try { session.removeItem(DRAFT_KEY); } catch (_) { /* недоступно */ }
    return true;
  }

  /* ---------- DOM ---------- */
  function mount(win) {
    if (!win || !win.document) return null;
    const doc = win.document;
    let storage = null, session = null;
    try { storage = win.localStorage; } catch (_) { storage = null; }
    try { session = win.sessionStorage; } catch (_) { session = null; }
    const memory = () => { const map = new Map(); return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) }; };
    storage = storage || memory();
    const cart = createCart(storage);
    const panel = doc.querySelector('[data-cart]');
    const counters = [...doc.querySelectorAll('[data-cart-count]')];
    /* Прайс: idle → loading → ready | error. Пока не ready, состав не считается устаревшим. */
    let index = null, indexPromise = null, priceState = 'idle';
    const loadIndex = () => {
      if (index) return Promise.resolve(index);
      if (indexPromise) return indexPromise;
      if (!win.PalitraPrice || !win.PalitraPrice.load) { priceState = 'error'; return Promise.resolve(null); }
      priceState = 'loading';
      indexPromise = Promise.resolve().then(() => win.PalitraPrice.load(PRICE_SOURCES)).then((data) => {
        index = data ? priceIndex(data) : null;
        priceState = index ? 'ready' : 'error';
        return index;
      }, () => { priceState = 'error'; return null; }).finally(() => { indexPromise = null; });
      return indexPromise;
    };
    const updateCount = () => { const count = cart.count(); for (const node of counters) node.textContent = String(count); };
    updateCount();

    const renderItems = () => {
      if (!panel) return;
      const list = panel.querySelector('[data-cart-items]');
      const total = panel.querySelector('[data-total]');
      const summary = panel.querySelector('[data-cart-summary]');
      const items = cart.list();
      const view = describe(items, index);
      if (!items.length) {
        list.innerHTML = `<p class="cart-empty">${MESSAGES.empty}</p>`;
        if (total) total.textContent = '—';
        if (summary) summary.textContent = '';
      } else {
        list.innerHTML = view.lines.map((line) => `<div class="cart-line${line.missing ? ' cart-line--missing' : ''}${line.pending ? ' cart-line--pending' : ''}" data-cart-line="${esc(line.id)}">
          <div class="cart-line__info"><b>${line.pending ? 'Позиция прайса' : esc(line.title)}</b><span>${line.pending ? (priceState === 'error' ? 'Прайс не загружен' : 'Загружаем прайс…') : line.missing ? 'Позиции больше нет в прайсе — удалите её' : line.price === null ? 'Цена уточняется' : `${formatRub(line.price)} × ${line.qty} = ${formatRub(line.price * line.qty)}`}</span></div>
          <div class="cart-line__qty"><button type="button" data-qty-dec aria-label="Меньше">−</button><span aria-live="polite">${line.qty}</span><button type="button" data-qty-inc aria-label="Больше">+</button><button type="button" class="cart-line__remove" data-remove aria-label="Удалить">Удалить</button></div>
        </div>`).join('');
        if (total) total.textContent = view.ready && view.knownTotal ? formatRub(view.knownTotal) : '—';
        if (summary) {
          summary.innerHTML = !view.ready
            ? (priceState === 'error'
              ? `<span>${MESSAGES.priceError}</span> <button type="button" class="cart-retry" data-price-retry>Обновить прайс</button>`
              : esc(MESSAGES.priceLoading))
            : esc([view.unknownCount ? `${view.unknownCount} поз. — цена уточняется менеджером.` : '',
              view.missingCount ? `${view.missingCount} поз. недоступны — удалите их перед отправкой.` : '',
              view.knownTotal ? 'Итог предварительный, по известным ценам.' : ''].filter(Boolean).join(' '));
        }
      }
      updateCount();
    };
    const refreshPrice = () => loadIndex().then(() => renderItems());
    const openCart = () => {
      if (!panel) return;
      panel.classList.remove('hidden'); panel.hidden = false; panel.setAttribute('aria-hidden', 'false');
      doc.body.classList.add('cart-open');
      renderItems();
      refreshPrice();
      panel.querySelector('[data-cart-close]')?.focus();
    };
    const closeCart = () => {
      if (!panel) return;
      panel.classList.add('hidden'); panel.hidden = true; panel.setAttribute('aria-hidden', 'true');
      doc.body.classList.remove('cart-open');
    };
    if (panel) closeCart();
    doc.addEventListener('click', (event) => {
      const add = event.target.closest('[data-add]');
      if (add) {
        if (cart.add(add.dataset.id, 1)) {
          updateCount();
          // Подпись кнопки задаёт карточка («Купить»); после подтверждения возвращаем исходную.
          const label = add.dataset.label || (add.dataset.label = add.textContent);
          add.classList.add('is-added'); add.textContent = 'В корзине';
          win.setTimeout(() => { add.classList.remove('is-added'); add.textContent = label; }, 1500);
          if (panel && !panel.hidden) renderItems();
        }
        return;
      }
      if (event.target.closest('[data-cart-open]')) { event.preventDefault(); openCart(); return; }
      if (event.target.closest('[data-cart-close]')) { closeCart(); return; }
      if (event.target.closest('[data-price-retry]')) { renderItems(); refreshPrice(); return; }
      const line = event.target.closest('[data-cart-line]');
      if (!line) return;
      const id = line.dataset.cartLine, current = cart.list().find((item) => item.id === id);
      if (event.target.closest('[data-remove]')) cart.remove(id);
      else if (event.target.closest('[data-qty-inc]') && current) cart.setQty(id, current.qty + 1);
      else if (event.target.closest('[data-qty-dec]') && current) cart.setQty(id, current.qty - 1);
      else return;
      renderItems();
    });
    doc.addEventListener('keydown', (event) => { if (event.key === 'Escape' && panel && !panel.hidden) closeCart(); });

    /* Формы: корзина (kind=cart) и заявка под повод (kind=request). */
    const bindForm = (form, kind) => {
      if (!form || form.dataset.orderReady) return;
      form.dataset.orderReady = kind;
      let status = form.querySelector('[data-order-status]');
      if (!status) { status = doc.createElement('p'); status.className = 'order-status'; status.setAttribute('role', 'status'); status.setAttribute('data-order-status', ''); form.append(status); }
      if (!form.querySelector('[name=website]')) {
        const trap = doc.createElement('input'); trap.type = 'text'; trap.name = 'website'; trap.tabIndex = -1; trap.autocomplete = 'off';
        trap.setAttribute('aria-hidden', 'true'); trap.className = 'order-trap'; form.append(trap);
      }
      let pending = false;
      const setBusy = (busy) => {
        pending = busy;
        form.setAttribute('aria-busy', String(busy));
        for (const control of form.querySelectorAll('input, select, textarea, button')) control.disabled = busy;
      };
      const message = (text, state) => { status.textContent = text; status.dataset.state = state; };
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (pending) return;
        // Флаг ставится до первого await: второй клик во время подготовки не создаёт второй запрос.
        pending = true;
        const values = Object.fromEntries(new win.FormData(form));
        values.consent = form.querySelector('[name=consent]')?.checked === true;
        const snapshot = kind === 'cart' ? cart.list() : [];
        let payload;
        try {
          payload = buildPayload(kind, values, snapshot, win.location);
        } catch (error) {
          pending = false;
          const control = error.field ? form.querySelector(`[name=${error.field}]`) : null;
          if (control && control.setCustomValidity) { control.setCustomValidity(error.message); form.reportValidity && form.reportValidity(); control.addEventListener('input', () => control.setCustomValidity(''), { once: true }); }
          message(error.message, 'error');
          return;
        }
        setBusy(true);
        try {
          // Подготовка (прайс, хеш, id) и отправка — в одном try: любая ошибка снимает блокировку в finally.
          if (kind === 'cart') {
            // Без актуального прайса состав не сверен: дожидаемся загрузки, при неудаче не отправляем
            // и не объявляем позиции удалёнными.
            if (!index) { message(MESSAGES.priceLoading, 'pending'); await loadIndex(); renderItems(); }
            if (!index) { message(MESSAGES.priceError, 'error'); return; }
            if (describe(snapshot, index).missingCount) { message(MESSAGES.stale, 'error'); return; }
          }
          message(MESSAGES.pending, 'pending');
          payload.requestId = requestIdFor(kind, await fingerprint(payload, win.crypto && win.crypto.subtle), session, win.crypto);
          const result = await send(win, payload);
          forgetRequest(kind, session);
          if (kind === 'cart') { cart.consume(snapshot); renderItems(); }
          form.reset();
          message(result.message || `Заявка №${result.orderId} принята. Менеджер свяжется с вами, подтвердит состав и стоимость, согласует оплату и доставку.`, 'success');
        } catch (error) {
          if (error.code === 'REQUEST_MISMATCH') forgetRequest(kind, session);
          if (error.code === 'ITEM_UNKNOWN') { index = null; refreshPrice(); }
          message(error.code ? errorMessage(error) : MESSAGES.generic, 'error');
        } finally {
          setBusy(false);
          status.setAttribute('tabindex', '-1');
        }
      });
    };
    if (panel) bindForm(panel.querySelector('form'), 'cart');
    const requestForm = doc.querySelector('#zayavka form');
    bindForm(requestForm, 'request');
    if (requestForm) applyRequestDraft(requestForm, session);
    for (const form of doc.querySelectorAll('form[data-order-form="cart"]')) bindForm(form, 'cart');
    return { cart, openCart, closeCart, renderItems, loadIndex, priceState: () => priceState };
  }

  return { CART_KEY, REQUEST_KEY, DRAFT_KEY, ENDPOINT, MESSAGES, createCart, readCart, priceIndex, parsePrice, describe, formatRub, buildPayload, fingerprint, requestIdFor, forgetRequest, readRequestDraft, applyRequestDraft, send, errorMessage, mount };
}));
